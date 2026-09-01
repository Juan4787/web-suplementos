import {
  CERTIFICATION_CASES,
  runCertificationCase,
  type CertificationCaseKey
} from './ai/certification';
import {
  AgentDeadlineFailure,
  AgentLoopLimitFailure,
  InvalidToolCallFailure,
  ProviderFailure,
  ToolDependencyFailure,
  UngroundedAnswerFailure
} from './ai/errors';
import { MODEL_REGISTRY } from './ai/model-registry';
import type { Deadline } from './ai/deadline';
import { GroqProvider } from './ai/providers/groq';
import type { AIProvider } from './ai/providers/provider';
import { WorkersAIProvider } from './ai/providers/workers-ai';
import type {
  CanonicalAIRequest,
  CanonicalAIResponse,
  ModelDefinition,
  ModelKey,
  ProviderKey
} from './ai/types';

type CertificationEnv = {
  AI: Ai;
  GROQ_API_KEY: string;
};

type CertificationTrace = {
  provider: ProviderKey;
  text: string | null;
  toolCalls: Array<{ name: string; argumentsJson: string }>;
};

class TracedCertificationProvider implements AIProvider {
  readonly key: ProviderKey;

  constructor(
    private readonly inner: AIProvider,
    private readonly traces: CertificationTrace[]
  ) {
    this.key = inner.key;
  }

  async generate(
    model: ModelDefinition,
    request: CanonicalAIRequest,
    deadline: Deadline
  ): Promise<CanonicalAIResponse> {
    const response = await this.inner.generate(model, request, deadline);
    this.traces.push({
      provider: response.provider,
      text: response.text?.slice(0, 2_000) ?? null,
      toolCalls: response.toolCalls.map((call) => ({
        name: call.name,
        argumentsJson: call.argumentsJson.slice(0, 1_000)
      }))
    });
    return response;
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });

const classifyCertificationFailure = (error: unknown): string => {
  if (error instanceof ProviderFailure) {
    const cause = error.options.cause;
    if (cause instanceof UngroundedAnswerFailure) {
      return `provider:${error.provider}:${error.kind}:grounding:${cause.reason}`;
    }
    if (cause instanceof AgentLoopLimitFailure) {
      return `provider:${error.provider}:${error.kind}:agent:loop_limit`;
    }
    if (cause instanceof InvalidToolCallFailure) {
      return `provider:${error.provider}:${error.kind}:model:invalid_tool_call`;
    }
    return `provider:${error.provider}:${error.kind}`;
  }
  if (error instanceof ToolDependencyFailure) return `tool_dependency:${error.kind}`;
  if (error instanceof UngroundedAnswerFailure) return `grounding:${error.reason}`;
  if (error instanceof AgentDeadlineFailure) return 'agent:deadline';
  if (error instanceof AgentLoopLimitFailure) return 'agent:loop_limit';
  if (error instanceof InvalidToolCallFailure) return 'model:invalid_tool_call';
  if (error instanceof Error) return `contract:${error.message}`;
  return 'unknown';
};

const certificationDiagnostic = (error: unknown): string | undefined => {
  const cause = error instanceof ProviderFailure ? error.options.cause : undefined;
  const message = cause instanceof Error ? cause.message : undefined;
  if (!message) return undefined;
  return message
    .replace(/gsk_[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 500);
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/cases') {
      return json({
        models: Object.keys(MODEL_REGISTRY),
        cases: Object.keys(CERTIFICATION_CASES)
      });
    }
    if (request.method !== 'POST' || url.pathname !== '/certify') {
      return json({ error: 'NOT_FOUND' }, 404);
    }

    const modelKey = url.searchParams.get('model') as ModelKey | null;
    const caseKey = url.searchParams.get('case') as CertificationCaseKey | null;
    if (!modelKey || !(modelKey in MODEL_REGISTRY) || !caseKey || !(caseKey in CERTIFICATION_CASES)) {
      return json({ error: 'INVALID_CERTIFICATION_CASE' }, 400);
    }

    const traces: CertificationTrace[] = [];
    try {
      const result = await runCertificationCase({
        modelKey,
        caseKey,
        providers: {
          groq: new TracedCertificationProvider(new GroqProvider(env.GROQ_API_KEY), traces),
          cloudflare: new TracedCertificationProvider(new WorkersAIProvider(env.AI), traces)
        }
      });
      return json(result);
    } catch (error) {
      return json(
        {
          passed: false,
          modelKey,
          caseKey,
          failure: classifyCertificationFailure(error),
          diagnostic: certificationDiagnostic(error),
          traces
        },
        422
      );
    }
  }
} satisfies ExportedHandler<CertificationEnv>;
