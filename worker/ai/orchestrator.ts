import { ProviderCircuitBreaker, providerCircuitBreaker } from './circuit-breaker';
import { Deadline } from './deadline';
import {
  buildDeterministicAnswerTemplate,
  requiresBusinessEvidence
} from './deterministic-answer';
import {
  AgentDeadlineFailure,
  AgentLoopLimitFailure,
  InvalidToolCallFailure,
  ProviderFailure,
  ToolDependencyFailure,
  UngroundedAnswerFailure
} from './errors';
import { FactLedger } from './fact-ledger';
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
  ExactEvidence,
  ModelDefinition,
  ModelKey,
  OrchestratorResult,
  ProviderKey,
  RequestContext
} from './types';
import {
  toCanonicalToolResult,
  TOOL_DEFINITIONS,
  validateToolCall,
  type ValidatedToolCall
} from './tools/registry';

const MAX_TOOL_ROUNDS = 2;
const MAX_MODEL_CALLS = 4;
const GLOBAL_DEADLINE_MS = 30_000;
const MAX_TRANSCRIPT_BYTES = 48_000;
const MAX_CONTEXT_HISTORY_MESSAGES = 4;

const normalizeIntentText = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-AR');

/**
 * Keep the model's tool choice open for unfamiliar wording, but avoid sending
 * every schema for the common, unambiguous cases. This is a transport-size
 * optimization only: the model still writes the answer and the server still
 * validates the selected call against the authoritative registry.
 */
const toolsForMessage = (message: string): typeof TOOL_DEFINITIONS => {
  const text = normalizeIntentText(message);
  const selected = new Set<string>();
  const add = (...names: string[]) => names.forEach((name) => selected.add(name));

  if (
    /\b(?:precio|precios|caro|barato|catalogo|sale|cuesta|vale|valor|presentacion)\b/u.test(text) ||
    /\bproductos?\s+(?:tengo|hay|existen|ofrezco|vendo)\b/u.test(text)
  ) {
    add('get_product_catalog');
  }
  if (
    /\b(?:stock|inventario|reponer|reposicion|comprar|compra|priorizar|rotacion|cobertura|disponible|faltante|faltan)\b/u.test(
      text
    )
  ) {
    add('get_inventory_status');
  }
  if (/\b(?:compara|comparar|comparame|versus|contra|periodo|mes anterior|semana anterior)\b/u.test(text)) {
    add('compare_sales_periods');
  }
  if (/\b(?:vendio mas|mas vendido|ranking|top)\b/u.test(text)) {
    add('get_top_selling_products');
  }
  if (/\b(?:rindio|rendimiento|desempeno|performance|unidades?)\b/u.test(text)) {
    add('get_product_performance');
  }
  if (/\b(?:ventas?|facturacion|margen|costos?|impuestos?|pedidos?|ticket|ganancia)\b/u.test(text)) {
    add('get_sales_summary');
  }

  // An unfamiliar business formulation keeps the full registry available;
  // recognized topics get only the relevant schemas and descriptions.
  if (selected.size === 0) return TOOL_DEFINITIONS;
  return TOOL_DEFINITIONS.filter((tool) => selected.has(tool.name));
};

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

const createCanonicalRequest = (
  model: ModelDefinition,
  messages: CanonicalMessage[],
  toolDefinitions: typeof TOOL_DEFINITIONS | undefined
): CanonicalAIRequest => ({
  messages,
  // General conversation does not need the business tool catalog. Omitting it
  // saves a large input-token budget and prevents a simple greeting from
  // consuming the same quota as a data analysis. Once a tool is used, the
  // definitions remain available for a possible second read in the loop.
  tools: toolDefinitions ?? [],
  reasoning: 'low',
  maxCompletionTokens: model.maxCompletionTokens
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
    ...input.history.slice(-MAX_CONTEXT_HISTORY_MESSAGES).map((message): CanonicalMessage =>
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
  let modelCalls = 0;
  const usedTools = new Set<string>();
  const factCatalog: FactCatalog = new Map();
  const factLedger = new FactLedger();
  let deterministicFallbackTemplate: string | null = null;

  const currentModel = (): ModelDefinition => MODEL_REGISTRY[route[routeIndex]!];

  const shouldExposeTools = (): boolean =>
    toolRounds > 0 || requiresBusinessEvidence(input.message);
  const selectedTools = toolsForMessage(input.message);

  const deterministicFallbackResult = (): OrchestratorResult | null => {
    if (!deterministicFallbackTemplate) return null;
    const grounded = renderGroundedAnswer(deterministicFallbackTemplate, factCatalog);
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
  };

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
      try {
        deadline.assertRemaining(250);
        breaker.assertClosed(model.provider);
        const response = await provider.generate(
          model,
          createCanonicalRequest(model, messages, shouldExposeTools() ? selectedTools : undefined),
          deadline
        );
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
    if (modelCalls >= MAX_MODEL_CALLS) {
      const failure = asProviderOutputFailure(currentModel().provider, new AgentLoopLimitFailure());
      breaker.recordFailure(failure);
      if (transitionToFallback(failure)) continue;
      const rescued = deterministicFallbackResult();
      if (rescued) return rescued;
      throw failure;
    }
    modelCalls += 1;

    let response: CanonicalAIResponse;
    try {
      response = await callCurrentProvider();
    } catch (error) {
      if (error instanceof ProviderFailure && transitionToFallback(error)) continue;
      if (error instanceof ProviderFailure || error instanceof AgentDeadlineFailure) {
        const rescued = deterministicFallbackResult();
        if (rescued) return rescued;
      }
      throw error;
    }

    if (response.finishReason === 'max_tokens') {
      console.warn(JSON.stringify({
        event: 'ai_provider_output_rejected',
        provider: response.provider,
        reason: 'max_tokens'
      }));
      const failure = asProviderOutputFailure(
        response.provider,
        new UngroundedAnswerFailure('empty_answer')
      );
      breaker.recordFailure(failure);
      if (transitionToFallback(failure)) continue;
      const rescued = deterministicFallbackResult();
      if (rescued) return rescued;
      throw failure;
    }

    if (response.toolCalls.length > 0) {
      if (toolRounds >= MAX_TOOL_ROUNDS) {
        console.warn(JSON.stringify({
          event: 'ai_provider_output_rejected',
          provider: response.provider,
          reason: 'tool_loop_limit'
        }));
        const loopFailure = new AgentLoopLimitFailure();
        const failure = asProviderOutputFailure(response.provider, loopFailure);
        breaker.recordFailure(failure);
        if (transitionToFallback(failure)) continue;
        const rescued = deterministicFallbackResult();
        if (rescued) return rescued;
        throw loopFailure;
      }

      let validated: ValidatedToolCall;
      try {
        validated = validateToolCall(response.toolCalls[0]!);
      } catch (error) {
        if (!(error instanceof InvalidToolCallFailure)) throw error;
        console.warn(JSON.stringify({
          event: 'ai_tool_call_rejected',
          provider: response.provider
        }));
        const failure = asProviderOutputFailure(response.provider, error);
        breaker.recordFailure(failure);
        if (transitionToFallback(failure)) continue;
        throw failure;
      }

      let safeResult;
      try {
        const rawResult = await dependencies.executeTool(validated, deadline);
        safeResult = sanitizeToolResult(rawResult, validated.call.name);
        const canonicalResult = toCanonicalToolResult(
          validated.call.name,
          rawResult,
          safeResult,
          validated.spec.interpretationRules
        );
        factLedger.addAll(canonicalResult.facts);
      } catch (error) {
        if (error instanceof ToolDependencyFailure) throw error;
        throw new ToolDependencyFailure('temporary', error);
      }

      addToolFacts(factCatalog, safeResult);
      usedTools.add(validated.call.name);
      deterministicFallbackTemplate = buildDeterministicAnswerTemplate(safeResult);
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
      const grounded = renderGroundedAnswer(response.text, factCatalog, {
        allowLiteralNumbers: usedTools.size === 0 && !requiresBusinessEvidence(input.message)
      });
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
      console.warn(JSON.stringify({
        event: 'ai_provider_output_rejected',
        provider: response.provider,
        reason: error.reason
      }));
      const failure = asProviderOutputFailure(response.provider, error);
      breaker.recordFailure(failure);
      if (transitionToFallback(failure)) continue;
      const rescued = deterministicFallbackResult();
      if (rescued) return rescued;
      throw failure;
    }
  }
};
