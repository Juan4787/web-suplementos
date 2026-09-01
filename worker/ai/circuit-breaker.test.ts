import { describe, expect, it } from 'vitest';
import { ProviderCircuitBreaker } from './circuit-breaker';
import { ProviderFailure } from './errors';

const transientFailure = () =>
  new ProviderFailure('groq', 'server', {
    retrySameProvider: true,
    fallbackEligible: true
  });

describe('provider circuit breaker', () => {
  it('abre después de tres fallos consecutivos y vuelve a probar al vencer la ventana', () => {
    let now = 1_000;
    const breaker = new ProviderCircuitBreaker(() => now);

    breaker.recordFailure(transientFailure());
    breaker.recordFailure(transientFailure());
    expect(() => breaker.assertClosed('groq')).not.toThrow();

    breaker.recordFailure(transientFailure());
    expect(() => breaker.assertClosed('groq')).toThrowError(
      expect.objectContaining({ kind: 'circuit_open' })
    );

    now += 60_001;
    expect(() => breaker.assertClosed('groq')).not.toThrow();
  });

  it('respeta aperturas explícitas y un éxito limpia el estado', () => {
    const breaker = new ProviderCircuitBreaker(() => 5_000);
    breaker.recordFailure(
      new ProviderFailure('groq', 'rate_limit', {
        retrySameProvider: false,
        fallbackEligible: true,
        openCircuitMs: 60_000
      })
    );
    expect(() => breaker.assertClosed('groq')).toThrow();

    breaker.recordSuccess('groq');
    expect(() => breaker.assertClosed('groq')).not.toThrow();
  });

  it('mantiene aislado el estado de cada proveedor', () => {
    const breaker = new ProviderCircuitBreaker(() => 10_000);
    breaker.recordFailure(
      new ProviderFailure('groq', 'rate_limit', {
        retrySameProvider: false,
        fallbackEligible: true,
        openCircuitMs: 60_000
      })
    );

    expect(() => breaker.assertClosed('cloudflare')).not.toThrow();
    expect(() => breaker.assertClosed('groq')).toThrow();
  });
});
