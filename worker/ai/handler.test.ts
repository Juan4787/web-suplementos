import { describe, expect, it } from 'vitest';
import { handleAIRequest } from './handler';

const env = (enabled: boolean) =>
  ({
    AI_ENABLED: String(enabled),
    GROQ_ZDR_CONFIRMED: 'false',
    GROQ_API_KEY: 'g'.repeat(40),
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'a'.repeat(40),
    AI: {}
  }) as unknown as Env;

const request = (authorization?: string) =>
  new Request('https://impulso.suplementos.workers.dev/api/ai', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {})
    },
    body: JSON.stringify({ message: 'consulta', history: [], modelPreference: 'auto' })
  });

describe('AI HTTP handler gates', () => {
  it('permanece apagado mientras no se habilite el control de privacidad', async () => {
    const response = await handleAIRequest(request(), env(false));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('todavía no está habilitado');
  });

  it('exige sesión antes de revelar el estado de preparación', async () => {
    const response = await handleAIRequest(request(), env(true));
    expect(response.status).toBe(401);
  });

  it('falla cerrado si los modelos o privacidad no están certificados', async () => {
    const response = await handleAIRequest(request(`Bearer ${'a'.repeat(40)}`), env(true));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('controles de privacidad');
  });
});
