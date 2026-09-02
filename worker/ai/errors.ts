import type { ProviderKey } from './types';

export type ProviderFailureKind =
  | 'timeout'
  | 'network'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'capacity'
  | 'model_unavailable'
  | 'authentication'
  | 'invalid_model_output'
  | 'invalid_request'
  | 'circuit_open';

export class ProviderFailure extends Error {
  constructor(
    readonly provider: ProviderKey,
    readonly kind: ProviderFailureKind,
    readonly options: {
      retrySameProvider: boolean;
      fallbackEligible: boolean;
      openCircuitMs?: number;
      cause?: unknown;
    }
  ) {
    super(`Provider ${provider} failed with ${kind}`);
    this.name = 'ProviderFailure';
  }
}

export class InvalidToolCallFailure extends Error {
  constructor(readonly cause?: unknown) {
    super('The model returned an invalid tool call');
    this.name = 'InvalidToolCallFailure';
  }
}

export class ToolDependencyFailure extends Error {
  constructor(readonly kind: 'auth' | 'permission' | 'temporary', readonly cause?: unknown) {
    super(`Tool dependency failed with ${kind}`);
    this.name = 'ToolDependencyFailure';
  }
}

export class AgentDeadlineFailure extends Error {
  constructor() {
    super('The global AI request deadline was reached');
    this.name = 'AgentDeadlineFailure';
  }
}

export class AgentLoopLimitFailure extends Error {
  constructor() {
    super('The maximum tool rounds were reached');
    this.name = 'AgentLoopLimitFailure';
  }
}

export class UngroundedAnswerFailure extends Error {
  constructor(
    readonly reason: 'unknown_fact' | 'literal_number' | 'empty_answer' | 'missing_evidence',
    readonly detail?: string
  ) {
    super(`The model answer is not grounded: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'UngroundedAnswerFailure';
  }
}
