import { ProviderCircuitBreaker, providerCircuitBreaker } from './circuit-breaker';
import { Deadline } from './deadline';
import {
  buildDeterministicAnswerTemplate,
  requiresBusinessEvidence
} from './deterministic-answer';
import {
  AgentLoopLimitFailure,
  InvalidToolCallFailure,
  ProviderFailure,
  ToolDependencyFailure,
  UngroundedAnswerFailure
} from './errors';
import {
  addToolFacts,
  prepareToolResultForModel,
  renderGroundedAnswer,
  sanitizeToolResult,
  type FactCatalog
} from './facts';
import { AUTOMATIC_ROUTE, MODEL_REGISTRY } from './model-registry';
import { buildSystemMessage } from './prompt';
import type { AIProvider } from './providers/provider';
import type {
  CanonicalAIRequest,
  CanonicalMessage,
  CanonicalAIResponse,
  ModelDefinition,
  ModelKey,
  OrchestratorResult,
  ProviderKey,
  RequestContext
} from './types';
import { TOOL_DEFINITIONS, validateToolCall, type ValidatedToolCall } from './tools/registry';

const MAX_TOOL_ROUNDS = 2;
const GLOBAL_DEADLINE_MS = 30_000;
const MAX_TRANSCRIPT_BYTES = 48_000;

export type UntrustedHistoryMessage = { role: 'user' | 'assistant'; content: string };

export type OrchestratorInput = {
  message: string;
  history: UntrustedHistoryMessage[];
  context: RequestContext;
};

export type OrchestratorDependencies = {
  providers: Record<ProviderKey, AIProvider>;
  executeTool: (call: ValidatedToolCall, deadline: Deadline) => Promise<unknown>;
  circuitBreaker?: ProviderCircuitBreaker;
  route?: readonly ModelKey[];
  deadline?: Deadline;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const assertTranscriptSize = (messages: CanonicalMessage[]): void => {
  const size = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  if (size > MAX_TRANSCRIPT_BYTES) throw new ToolDependencyFailure('temporary');
};

const createCanonicalRequest = (messages: CanonicalMessage[]): CanonicalAIRequest => ({
  messages,
  tools: TOOL_DEFINITIONS,
  reasoning: 'low',
  maxCompletionTokens: 700
});

const asProviderOutputFailure = (
  provider: ProviderKey,
  cause: InvalidToolCallFailure | UngroundedAnswerFailure | AgentLoopLimitFailure
): ProviderFailure =>
  new ProviderFailure(provider, 'invalid_model_output', {
    retrySameProvider: false,
    fallbackEligible: true,
    cause
  });

export const orchestrate = async (
  input: OrchestratorInput,
  dependencies: OrchestratorDependencies
): Promise<OrchestratorResult> => {
  const now = dependencies.now ?? Date.now;
  const deadline = dependencies.deadline ?? new Deadline(dependencies.deadlineMs ?? GLOBAL_DEADLINE_MS, now);
  const sleep = dependencies.sleep ?? defaultSleep;
  const random = dependencies.random ?? Math.random;
  const breaker = dependencies.circuitBreaker ?? providerCircuitBreaker;
  const route = dependencies.route ?? AUTOMATIC_ROUTE;

  if (route.length < 1 || route.length > 2) throw new Error('INVALID_MODEL_ROUTE');

  const messages: CanonicalMessage[] = [
    buildSystemMessage(input.context),
    ...input.history.map((message): CanonicalMessage =>
      message.role === 'assistant'
        ? { role: 'assistant', content: message.content, toolCalls: [] }
        : { role: 'user', content: message.content }
    ),
    { role: 'user', content: input.message }
  ];
  assertTranscriptSize(messages);

  let routeIndex = 0;
  let providerTransitions: 0 | 1 = 0;
  let toolRounds = 0;
  const usedTools = new Set<string>();
  const factCatalog: FactCatalog = new Map();

  const currentModel = (): ModelDefinition => MODEL_REGISTRY[route[routeIndex]!];

  const transitionToFallback = (failure: ProviderFailure): boolean => {
    if (!failure.options.fallbackEligible || providerTransitions >= 1 || routeIndex >= route.length - 1) {
      return false;
    }
    routeIndex += 1;
    providerTransitions = 1;
    console.warn(JSON.stringify({
      event: 'ai_provider_transition',
      from: failure.provider,
      reason: failure.kind,
      to: currentModel().provider
    }));
    return true;
  };

  const callCurrentProvider = async (): Promise<CanonicalAIResponse> => {
    const model = currentModel();
    const provider = dependencies.providers[model.provider];
    let retryUsed = false;

    while (true) {
      deadline.assertRemaining(250);
      breaker.assertClosed(model.provider);
      try {
        const response = await provider.generate(model, createCanonicalRequest(messages), deadline);
        if (response.modelKey !== model.key || response.provider !== model.provider) {
          throw new ProviderFailure(model.provider, 'invalid_model_output', {
            retrySameProvider: false,
            fallbackEligible: true
          });
        }
        breaker.recordSuccess(model.provider);
        return response;
      } catch (error) {
        if (!(error instanceof ProviderFailure)) throw error;
        breaker.recordFailure(error);
        console.warn(JSON.stringify({
          event: 'ai_provider_failure',
          provider: error.provider,
          kind: error.kind,
          retrySameProvider: error.options.retrySameProvider && !retryUsed
        }));

        if (error.options.retrySameProvider && !retryUsed && deadline.remainingMs() > 1_000) {
          retryUsed = true;
          await sleep(120 + Math.floor(random() * 100));
          continue;
        }
        throw error;
      }
    }
  };

  while (true) {
    let response: CanonicalAIResponse;
    try {
      response = await callCurrentProvider();
    } catch (error) {
      if (error instanceof ProviderFailure && transitionToFallback(error)) continue;
      throw error;
    }

    if (response.finishReason === 'max_tokens') {
      const failure = asProviderOutputFailure(
        response.provider,
        new UngroundedAnswerFailure('empty_answer')
      );
      breaker.recordFailure(failure);
      if (transitionToFallback(failure)) continue;
      throw failure;
    }

    if (response.toolCalls.length > 0) {
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        const loopFailure = new AgentLoopLimitFailure();
        const failure = asProviderOutputFailure(response.provider, loopFailure);
        breaker.recordFailure(failure);
        if (transitionToFallback(failure)) continue;
        throw loopFailure;
      }

      let validated: ValidatedToolCall;
      try {
        validated = validateToolCall(response.toolCalls[0]!);
      } catch (error) {
        if (!(error instanceof InvalidToolCallFailure)) throw error;
        const failure = asProviderOutputFailure(response.provider, error);
        breaker.recordFailure(failure);
        if (transitionToFallback(failure)) continue;
        throw failure;
      }

      let safeResult;
      try {
        const rawResult = await dependencies.executeTool(validated, deadline);
        safeResult = sanitizeToolResult(rawResult, validated.call.name);
      } catch (error) {
        if (error instanceof ToolDependencyFailure) throw error;
        throw new ToolDependencyFailure('temporary', error);
      }

      addToolFacts(factCatalog, safeResult);
      usedTools.add(validated.call.name);
      const deterministicTemplate = buildDeterministicAnswerTemplate(input.message, safeResult);
      if (deterministicTemplate) {
        const grounded = renderGroundedAnswer(deterministicTemplate, factCatalog);
        const model = currentModel();
        return {
          answer: grounded.answer,
          modelKey: model.key,
          modelLabel: model.label,
          provider: model.provider,
          providerLabel: model.providerLabel,
          usedTools: [...usedTools],
          evidence: grounded.evidence,
          providerTransitions,
          fallbackUsed: routeIndex > 0
        };
      }
      const resultJson = JSON.stringify(prepareToolResultForModel(safeResult));
      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
      messages.push({
        role: 'tool',
        content: resultJson,
        toolCallId: validated.call.id,
        name: validated.call.name
      });
      assertTranscriptSize(messages);
      toolRounds += 1;
      continue;
    }

    try {
      if (usedTools.size === 0 && requiresBusinessEvidence(input.message)) {
        throw new UngroundedAnswerFailure('missing_evidence');
      }
      const grounded = renderGroundedAnswer(response.text, factCatalog);
      if (usedTools.size > 0 && grounded.evidence.length === 0) {
        throw new UngroundedAnswerFailure('missing_evidence');
      }
      const model = currentModel();
      return {
        answer: grounded.answer,
        modelKey: model.key,
        modelLabel: model.label,
        provider: model.provider,
        providerLabel: model.providerLabel,
        usedTools: [...usedTools],
        evidence: grounded.evidence,
        providerTransitions,
        fallbackUsed: routeIndex > 0
      };
    } catch (error) {
      if (!(error instanceof UngroundedAnswerFailure)) throw error;
      const failure = asProviderOutputFailure(response.provider, error);
      breaker.recordFailure(failure);
      if (transitionToFallback(failure)) continue;
      throw failure;
    }
  }
};
