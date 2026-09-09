import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/domain/errors';
import { requestBusinessAI } from './business-ai-client';

const input = {
  message: '¿Cuánto vendí?',
  history: [] as Array<{ role: 'user' | 'assistant'; content: string }>,
  accessToken: 'a'.repeat(40)
};

describe('business AI HTTP client', () => {
  it('termina la espera aunque lleguen encabezados y el cuerpo quede incompleto', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        return { ok: true, json: () => new Promise(() => undefined) } as Response;
      });
      const failure = expect(requestBusinessAI(input, fetchMock)).rejects.toMatchObject({ kind: 'temporary', message: 'El asistente tardó demasiado en responder.' });
      await vi.advanceTimersByTimeAsync(40_000);
      await failure;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('envía solo el contrato permitido y valida la respuesta', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        message: input.message,
        history: [],
        modelPreference: 'auto'
      });
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${input.accessToken}`);
      return new Response(
        JSON.stringify({
          answer: 'Facturación cobrada: $ 10.000.',
          model: 'GPT-OSS 120B',
          provider: 'Groq',
          fallback: false,
          usedTools: ['get_sales_summary'],
          evidence: [{ label: 'Facturación cobrada', value: 1000000, formatted: '$ 10.000' }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const result = await requestBusinessAI(input, fetchMock as typeof fetch);
    expect(result.model).toBe('GPT-OSS 120B');
    expect(result.evidence).toHaveLength(1);
  });

  it('acepta respuestas analíticas extensas de más de 4000 caracteres', async () => {
    const longAnswer = 'Respuesta analítica extensa. '.repeat(200); // ~5800 chars
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          answer: longAnswer,
          model: 'GPT-OSS 120B',
          provider: 'Groq',
          fallback: false,
          usedTools: ['get_sales_summary'],
          evidence: []
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await requestBusinessAI(input, fetchMock as typeof fetch);
    expect(result.answer).toBe(longAnswer);
    expect(result.answer.length).toBeGreaterThan(4000);
  });

  it('usa únicamente el mensaje público seguro ante un error', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            kind: 'permission',
            message: 'Tu cuenta no tiene acceso al asistente.',
            nextAction: 'Ingresá con una cuenta de dueña habilitada.',
            retryable: false,
            internal: 'FORBIDDEN RPC secret'
          }
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const failure = await requestBusinessAI(input, fetchMock as typeof fetch).catch((error) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure.kind).toBe('permission');
    expect(failure.message).not.toContain('RPC');
  });

  it('rechaza una respuesta exitosa con forma no certificada', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ answer: 'texto', providerModel: '@cf/internal' }), { status: 200 })
    );
    await expect(requestBusinessAI(input, fetchMock as typeof fetch)).rejects.toMatchObject({
      kind: 'unexpected'
    });
  });
});
