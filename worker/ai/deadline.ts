import { AgentDeadlineFailure } from './errors';

export class Deadline {
  readonly expiresAt: number;

  constructor(totalMs: number, private readonly now: () => number = Date.now) {
    this.expiresAt = now() + totalMs;
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAt - this.now());
  }

  assertRemaining(minimumMs = 1): void {
    if (this.remainingMs() < minimumMs) throw new AgentDeadlineFailure();
  }

  signal(maximumMs: number): { signal: AbortSignal; cleanup: () => void } {
    const timeoutMs = Math.min(maximumMs, this.remainingMs());
    if (timeoutMs <= 0) throw new AgentDeadlineFailure();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('deadline'), timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer)
    };
  }
}
