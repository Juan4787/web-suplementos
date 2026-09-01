import { describe, expect, it, vi } from 'vitest';
import { Deadline } from '../deadline';
import { ProviderFailure } from '../errors';
import { MODEL_REGISTRY } from '../model-registry';
import type { CanonicalAIRequest } from '../types';
import { normalizeChatCompletion, toChatCompletionPayload } from './chat-completions';
import { GroqProvider } from './groq';
import { WorkersAIProvider } from './workers-ai';

const canonicalRequest: CanonicalAIRequest = {
  messages: [{ role: 'user', content: 'consulta' }],
  tools: [
    {
      name: 'get_inventory_status',
      description: 'Inventario',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  ],
  reasoning: 'low',
  maxCompletionTokens: 500
};

describe('chat completion adapters', () => {
  it('genera el contrato común con paralelismo y almacenamiento desactivados', () => {
    const payload = toChatCompletionPayload(MODEL_REGISTRY.gpt_oss_120b_groq_v1, canonicalRequest);
    expect(payload.parallel_tool_calls).toBe(false);
    expect(payload.store).toBe(false);
    expect(payload.tool_choice).toBe('auto');
    expect(payload.tools[0]).toMatchObject({ type: 'function' });
  });

  it('normaliza un tool call OpenAI-compatible', () => {
    const result = normalizeChatCompletion('groq', MODEL_REGISTRY.gpt_oss_120b_groq_v1, {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_inventory_status', arguments: '{}' }
              }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    });

    expect(result.finishReason).toBe('tool_call');
    expect(result.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'get_inventory_status',
      argumentsJson: '{}'
    });
    expect(result.usage?.totalTokens).toBe(15);
  });

  it('clasifica un límite Groq sin exponer el cuerpo remoto', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'detalle remoto' } }), { status: 429 })
    );
    const provider = new GroqProvider('g'.repeat(40), fetchMock as typeof fetch);
    const failure = await provider
      .generate(MODEL_REGISTRY.gpt_oss_120b_groq_v1, canonicalRequest, new Deadline(1000))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.kind).toBe('rate_limit');
    expect(failure.message).not.toContain('detalle remoto');
  });

  it.each([
    { status: 408, body: {}, kind: 'timeout', retry: false, fallback: true },
    { status: 404, body: {}, kind: 'model_unavailable', retry: false, fallback: true },
    { status: 401, body: {}, kind: 'authentication', retry: false, fallback: true },
    { status: 500, body: {}, kind: 'server', retry: true, fallback: true },
    {
      status: 400,
      body: { error: { failed_generation: 'malformed tool call' } },
      kind: 'invalid_model_output',
      retry: false,
      fallback: true
    },
    { status: 400, body: { error: { message: 'bad request' } }, kind: 'invalid_request', retry: false, fallback: false }
  ])(
    'clasifica Groq status $status como $kind',
    async ({ status, body, kind, retry, fallback }) => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify(body), { status })
      );
      const provider = new GroqProvider('g'.repeat(40), fetchMock as typeof fetch);
      const failure = await provider
        .generate(MODEL_REGISTRY.gpt_oss_120b_groq_v1, canonicalRequest, new Deadline(1000))
        .catch((error) => error);
      expect(failure).toBeInstanceOf(ProviderFailure);
      expect(failure.kind).toBe(kind);
      expect(failure.options.retrySameProvider).toBe(retry);
      expect(failure.options.fallbackEligible).toBe(fallback);
    }
  );

  it.each([
    { message: 'Workers AI error 3036', kind: 'quota', retry: false },
    { message: 'Workers AI error 3040 out of capacity', kind: 'capacity', retry: false },
    { message: 'Workers AI error 5007 model not found', kind: 'model_unavailable', retry: false },
    { message: 'Workers AI error 3007 timeout', kind: 'timeout', retry: false },
    { message: 'Workers AI error 429 rate limit', kind: 'rate_limit', retry: false },
    { message: 'Workers AI error 503', kind: 'server', retry: true }
  ])('clasifica Workers AI $message como $kind', async ({ message, kind, retry }) => {
    const ai = { run: vi.fn(async () => Promise.reject(new Error(message))) } as unknown as Ai;
    const provider = new WorkersAIProvider(ai);
    const failure = await provider
      .generate(MODEL_REGISTRY.glm_4_7_flash_cf_v1, canonicalRequest, new Deadline(1000))
      .catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure.kind).toBe(kind);
    expect(failure.options.retrySameProvider).toBe(retry);
    expect(failure.options.fallbackEligible).toBe(true);
  });
});
