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
          openCircuitMs: 60_000
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
