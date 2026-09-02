import type { Deadline } from '../deadline';
import { ProviderFailure } from '../errors';
import type { CanonicalAIRequest, CanonicalAIResponse, ModelDefinition } from '../types';
import { normalizeChatCompletion, toChatCompletionPayload } from './chat-completions';
import type { AIProvider } from './provider';

const classifyWorkersError = (error: unknown): ProviderFailure => {
  const message = error instanceof Error ? error.message : String(error);

  if (
    /3036|4006|quota|daily\s+(?:free\s+)?(?:limit|allocation)|used up.*(?:daily|allocation)|free allocation/i.test(
      message
    )
  ) {
    return new ProviderFailure('cloudflare', 'quota', {
      retrySameProvider: false,
      fallbackEligible: true,
      openCircuitMs: 60 * 60_000,
      cause: error
    });
  }
  if (/3040|capacity/i.test(message)) {
    return new ProviderFailure('cloudflare', 'capacity', {
      retrySameProvider: false,
      fallbackEligible: true,
      openCircuitMs: 60_000,
      cause: error
    });
  }
  if (/5007|model.+(?:not found|unavailable)/i.test(message)) {
    return new ProviderFailure('cloudflare', 'model_unavailable', {
      retrySameProvider: false,
      fallbackEligible: true,
      openCircuitMs: 15 * 60_000,
      cause: error
    });
  }
  if (/3007|timeout|aborted/i.test(message)) {
    return new ProviderFailure('cloudflare', 'timeout', {
      retrySameProvider: false,
      fallbackEligible: true,
      cause: error
    });
  }
  if (/429|rate.?limit/i.test(message)) {
    return new ProviderFailure('cloudflare', 'rate_limit', {
      retrySameProvider: false,
      fallbackEligible: true,
      openCircuitMs: 60_000,
      cause: error
    });
  }
  if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) {
    return new ProviderFailure('cloudflare', 'authentication', {
      retrySameProvider: false,
      fallbackEligible: true,
      openCircuitMs: 15 * 60_000,
      cause: error
    });
  }

  return new ProviderFailure('cloudflare', 'server', {
    retrySameProvider: true,
    fallbackEligible: true,
    cause: error
  });
};

export class WorkersAIProvider implements AIProvider {
  readonly key = 'cloudflare' as const;

  constructor(private readonly ai: Ai) {}

  async generate(
    model: ModelDefinition,
    request: CanonicalAIRequest,
    deadline: Deadline
  ): Promise<CanonicalAIResponse> {
    const timeout = deadline.signal(model.timeoutMs);
    const payload = toChatCompletionPayload(model, request);
    const { model: _providerModel, ...inputs } = payload;

    try {
      const response = await this.ai.run(model.providerModel, inputs, {
        signal: timeout.signal,
        tags: ['impulso', 'assistant', model.key]
      });
      return normalizeChatCompletion('cloudflare', model, response);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw classifyWorkersError(error);
    } finally {
      timeout.cleanup();
    }
  }
}
