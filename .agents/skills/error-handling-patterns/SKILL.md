---
name: error-handling-patterns
description: >-
  Strengthen backend and frontend error handling flows. Use when designing error boundaries, domain exceptions, Result types, structured logging, safe client error responses, and database/API error resilience.
---

# Error Handling Patterns

Architectural patterns and actionable practices to build resilient, fault-tolerant frontend and backend error workflows.

## 1. Core Principles

1. **Fail Fast & Explicitly**: Never swallow exceptions silently with empty `catch` blocks.
2. **Predictable Domain Exceptions**: Separate expected business errors (e.g. `InsufficientStockError`, `InvalidCredentialsError`) from catastrophic system failures (e.g. `DatabaseConnectionError`).
3. **Safe Client Responses**: Never leak database schemas, internal paths, or stack traces in HTTP responses to clients.
4. **Structured Logging**: Always attach contextual metadata (Request ID, User ID, timestamp, parameters) when logging errors.

## 2. Result Type Pattern (TypeScript)

Avoid throwing exceptions for anticipated domain logic failures:

```typescript
export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E };

export function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function err<E>(error: E): Result<never, E> {
  return { success: false, error };
}

// Example usage:
export async function processOrder(orderId: string): Promise<Result<Order, OrderError>> {
  const order = await findOrder(orderId);
  if (!order) {
    return err(new OrderNotFoundError(orderId));
  }
  if (order.status !== 'PENDING') {
    return err(new InvalidOrderStateError(order.status));
  }
  return ok(await completeOrder(order));
}
```

## 3. React Error Boundary & Graceful Degradation

```tsx
import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Uncaught error in component tree:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-6 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400">
          <h3 className="text-lg font-semibold">Something went wrong</h3>
          <p className="text-sm mt-1">Please refresh the page or try again later.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
```

## 4. Async Resilience & Retry with Exponential Backoff

```typescript
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 200
): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) throw error;
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}
```
