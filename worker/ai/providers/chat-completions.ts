import { ProviderFailure } from '../errors';
import type {
  CanonicalAIRequest,
  CanonicalAIResponse,
  CanonicalMessage,
  ModelDefinition,
  ProviderKey
} from '../types';

export type ChatCompletionPayload = {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  tool_choice: 'auto';
  parallel_tool_calls: false;
  reasoning_effort: 'low' | 'medium';
  temperature: number;
  max_completion_tokens: number;
  store: false;
};

const toProviderMessage = (message: CanonicalMessage): Record<string, unknown> => {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.argumentsJson }
            }))
          }
        : {})
    };
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name
    };
  }

  return { role: message.role, content: message.content };
};

export const toChatCompletionPayload = (
  model: ModelDefinition,
  request: CanonicalAIRequest
): ChatCompletionPayload => ({
  model: model.providerModel,
  messages: request.messages.map(toProviderMessage),
  tools: request.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  })),
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning_effort: request.reasoning,
  temperature: 0,
  max_completion_tokens: request.maxCompletionTokens,
  store: false
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readFiniteInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

export const normalizeChatCompletion = (
  provider: ProviderKey,
  model: ModelDefinition,
  payload: unknown
): CanonicalAIResponse => {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length < 1) {
    throw new ProviderFailure(provider, 'invalid_model_output', {
      retrySameProvider: false,
      fallbackEligible: true
    });
  }

  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new ProviderFailure(provider, 'invalid_model_output', {
      retrySameProvider: false,
      fallbackEligible: true
    });
  }

  const content = choice.message.content;
  if (content !== null && content !== undefined && typeof content !== 'string') {
    throw new ProviderFailure(provider, 'invalid_model_output', {
      retrySameProvider: false,
      fallbackEligible: true
    });
  }
  if (typeof content === 'string' && content.length > 12_000) {
    throw new ProviderFailure(provider, 'invalid_model_output', {
      retrySameProvider: false,
      fallbackEligible: true
    });
  }

  const rawToolCalls = choice.message.tool_calls ?? [];
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length > 1) {
    throw new ProviderFailure(provider, 'invalid_model_output', {
      retrySameProvider: false,
      fallbackEligible: true
    });
  }

  const toolCalls = rawToolCalls.map((rawCall) => {
    if (
      !isRecord(rawCall) ||
      typeof rawCall.id !== 'string' ||
      rawCall.id.length < 1 ||
      rawCall.id.length > 200 ||
      !isRecord(rawCall.function) ||
      typeof rawCall.function.name !== 'string' ||
      typeof rawCall.function.arguments !== 'string' ||
      rawCall.function.arguments.length > 4000
    ) {
      throw new ProviderFailure(provider, 'invalid_model_output', {
        retrySameProvider: false,
        fallbackEligible: true
      });
    }
    return {
      id: rawCall.id,
      name: rawCall.function.name,
      argumentsJson: rawCall.function.arguments
    };
  });

  const rawFinishReason = choice.finish_reason;
  const finishReason =
    toolCalls.length > 0 || rawFinishReason === 'tool_calls'
      ? 'tool_call'
      : rawFinishReason === 'length'
        ? 'max_tokens'
        : 'complete';

  const usage = isRecord(payload.usage)
    ? {
        promptTokens: readFiniteInteger(payload.usage.prompt_tokens) ?? 0,
        completionTokens: readFiniteInteger(payload.usage.completion_tokens) ?? 0,
        totalTokens: readFiniteInteger(payload.usage.total_tokens) ?? 0
      }
    : undefined;

  return {
    text: typeof content === 'string' ? content : null,
    toolCalls,
    finishReason,
    modelKey: model.key,
    provider,
    usage
  };
};
