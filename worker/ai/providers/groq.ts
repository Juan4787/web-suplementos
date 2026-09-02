import type { Deadline } from '../deadline';
import { ProviderFailure } from '../errors';
import { parseJsonSafely, readLimitedResponseText } from '../response-limits';
import type { CanonicalAIRequest, CanonicalAIResponse, ModelDefinition } from '../types';
import { normalizeChatCompletion, toChatCompletionPayload } from './chat-completions';
import type { AIProvider } from './provider';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError';

const hasFailedGeneration = (payload: unknown): boolean => {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return false;
  const error = (payload as { error?: unknown }).error;
  return typeof error === 'object' && error !== null && 'failed_generation' in error;
};

const safeErrorMetadata = (payload: unknown): {
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
} => {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return {};
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return {};
  const record = error as Record<string, unknown>;
  const clean = (value: unknown, maxLength: number): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value
      .replace(/https?:\/\/\S+/giu, '[url]')
      .replace(/(?:bearer|api[_ -]?key|sk-[a-z0-9_-]{8,})\s*[:=]?\s*\S+/giu, '[redacted]')
      .slice(0, maxLength);
  };
  return {
    errorType: clean(record.type, 80),
    errorCode: clean(record.code, 80),
    errorMessage: clean(record.message, 240)
  };
};

const retryAfterMilliseconds = (response: Response): number => {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return 60_000;
  // A provider can return a very long value for a daily limit. Keep the
  // process-local circuit bounded while honoring the provider's cooldown.
  return Math.min(Math.max(Math.ceil(seconds * 1000), 60_000), 15 * 60_000);
};

export class GroqProvider implements AIProvider {
  readonly key = 'groq' as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async generate(
    model: ModelDefinition,
    request: CanonicalAIRequest,
    deadline: Deadline
  ): Promise<CanonicalAIResponse> {
    const timeout = deadline.signal(model.timeoutMs);
    const fetchImpl = this.fetchImpl;
    let response: Response;

    try {
      response = await fetchImpl(GROQ_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(toChatCompletionPayload(model, request)),
        signal: timeout.signal
      });
    } catch (error) {
      if (timeout.signal.aborted || isAbortError(error)) {
        throw new ProviderFailure('groq', 'timeout', {
          retrySameProvider: false,
          fallbackEligible: true,
          cause: error
        });
      }
      throw new ProviderFailure('groq', 'network', {
        retrySameProvider: true,
        fallbackEligible: true,
        cause: error
      });
    } finally {
      timeout.cleanup();
    }

    let text: string;
    try {
      text = await readLimitedResponseText(response, response.ok ? 128_000 : 16_000);
    } catch (error) {
      throw new ProviderFailure('groq', 'invalid_model_output', {
        retrySameProvider: false,
        fallbackEligible: true,
        cause: error
      });
    }
    const payload = parseJsonSafely(text);

    if (!response.ok) {
      // Keep only provider metadata in the tail; response bodies may contain
      // request details and must never be copied to logs.
      const safeHeader = (name: string): string | undefined => {
        const value = response.headers.get(name);
        return value && value.length <= 80 ? value : undefined;
      };
      console.warn(JSON.stringify({
        event: 'ai_groq_http_failure',
        status: response.status,
        retryAfter: safeHeader('retry-after'),
        requestLimit: safeHeader('x-ratelimit-limit-requests'),
        requestRemaining: safeHeader('x-ratelimit-remaining-requests'),
        tokenLimit: safeHeader('x-ratelimit-limit-tokens'),
        tokenRemaining: safeHeader('x-ratelimit-remaining-tokens'),
        ...safeErrorMetadata(payload)
      }));
      if (response.status === 408) {
        throw new ProviderFailure('groq', 'timeout', {
          retrySameProvider: false,
          fallbackEligible: true
        });
      }
      if (response.status === 429) {
        throw new ProviderFailure('groq', 'rate_limit', {
          retrySameProvider: false,
          fallbackEligible: true,
          openCircuitMs: retryAfterMilliseconds(response)
        });
      }
      if (response.status === 404) {
        throw new ProviderFailure('groq', 'model_unavailable', {
          retrySameProvider: false,
          fallbackEligible: true,
          openCircuitMs: 15 * 60_000
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new ProviderFailure('groq', 'authentication', {
          retrySameProvider: false,
          fallbackEligible: true,
          openCircuitMs: 15 * 60_000
        });
      }
      if (response.status === 400 && hasFailedGeneration(payload)) {
        throw new ProviderFailure('groq', 'invalid_model_output', {
          retrySameProvider: false,
          fallbackEligible: true
        });
      }
      if (response.status >= 500) {
        throw new ProviderFailure('groq', 'server', {
          retrySameProvider: true,
          fallbackEligible: true
        });
      }
      throw new ProviderFailure('groq', 'invalid_request', {
        retrySameProvider: false,
        fallbackEligible: false
      });
    }

    if (payload === undefined) {
      throw new ProviderFailure('groq', 'invalid_model_output', {
        retrySameProvider: false,
        fallbackEligible: true
      });
    }

    return normalizeChatCompletion('groq', model, payload);
  }
}
