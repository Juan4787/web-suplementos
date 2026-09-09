import { afterEach, expect, it, vi } from 'vitest';
import { Deadline } from './deadline';
import { GroqProvider } from './providers/groq';
import { MODEL_REGISTRY } from './model-registry';
import { SupabaseAIClient } from './supabase';

afterEach(() => vi.useRealTimers());
const stalledResponse = () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); }, cancel
  }));
  return { cancel, response };
};

it('corta y clasifica como timeout un cuerpo Groq que nunca termina', async () => {
  vi.useFakeTimers();
  const { response, cancel } = stalledResponse();
  const provider = new GroqProvider('test', vi.fn(async () => response));
  const failure = expect(provider.generate(MODEL_REGISTRY.gpt_oss_120b_groq_v1,
    { messages: [], tools: [], reasoning: 'low', maxCompletionTokens: 50 }, new Deadline(1_000)))
    .rejects.toMatchObject({ kind: 'timeout' });
  await vi.advanceTimersByTimeAsync(1_000);
  await failure;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('corta una respuesta incompleta al comprobar acceso sin dejar el chat esperando', async () => {
  vi.useFakeTimers();
  const { response, cancel } = stalledResponse();
  const client = new SupabaseAIClient({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'a'.repeat(40) }, 't'.repeat(40), vi.fn(async () => response));
  const failure = expect(client.claim(20, new Deadline(1_000))).rejects.toMatchObject({ kind: 'temporary' });
  await vi.advanceTimersByTimeAsync(1_000);
  await failure;
  expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
