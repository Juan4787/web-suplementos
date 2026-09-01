import { ProviderFailure } from './errors';
import type { ProviderKey } from './types';

type CircuitState = {
  consecutiveFailures: number;
  firstFailureAt: number;
  openUntil: number;
};

export class ProviderCircuitBreaker {
  private readonly states = new Map<ProviderKey, CircuitState>();

  constructor(private readonly now: () => number = Date.now) {}

  assertClosed(provider: ProviderKey): void {
    const state = this.states.get(provider);
    if (!state || state.openUntil <= this.now()) return;
    throw new ProviderFailure(provider, 'circuit_open', {
      retrySameProvider: false,
      fallbackEligible: true
    });
  }

  recordSuccess(provider: ProviderKey): void {
    this.states.delete(provider);
  }

  recordFailure(failure: ProviderFailure): void {
    const now = this.now();
    const previous = this.states.get(failure.provider);
    const withinWindow = previous && now - previous.firstFailureAt <= 60_000;
    const consecutiveFailures = withinWindow ? previous.consecutiveFailures + 1 : 1;
    const explicitOpenMs = failure.options.openCircuitMs ?? 0;
    const repeatedFailureOpenMs = consecutiveFailures >= 3 ? 60_000 : 0;

    this.states.set(failure.provider, {
      consecutiveFailures,
      firstFailureAt: withinWindow ? previous.firstFailureAt : now,
      openUntil: Math.max(previous?.openUntil ?? 0, now + Math.max(explicitOpenMs, repeatedFailureOpenMs))
    });
  }
}

export const providerCircuitBreaker = new ProviderCircuitBreaker();
