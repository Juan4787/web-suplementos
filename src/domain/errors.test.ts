import { describe, expect, it } from 'vitest';
import { AppError, unknownToAppError } from './errors';

describe('error domain contract', () => {
  it('instantiates AppError with kind, message, nextAction and retryable flag', () => {
    const error = new AppError('business', 'El stock no alcanza para este pedido.', {
      retryable: false,
      nextAction: 'Revisá las cantidades disponibles en inventario.'
    });

    expect(error.name).toBe('AppError');
    expect(error.kind).toBe('business');
    expect(error.message).toBe('El stock no alcanza para este pedido.');
    expect(error.retryable).toBe(false);
    expect(error.nextAction).toBe('Revisá las cantidades disponibles en inventario.');
  });

  it('converts an unknown thrown value into an AppError with safe retryable message', () => {
    const rawError = new Error('Database connection reset');
    const converted = unknownToAppError(rawError);

    expect(converted).toBeInstanceOf(AppError);
    expect(converted.kind).toBe('unexpected');
    expect(converted.retryable).toBe(true);
    expect(converted.cause).toBe(rawError);
    expect(converted.nextAction).toContain('Volvé a intentarlo');
  });

  it('preserves an existing AppError without re-wrapping', () => {
    const original = new AppError('validation', 'El nombre es obligatorio.');
    const result = unknownToAppError(original);
    expect(result).toBe(original);
  });
});
