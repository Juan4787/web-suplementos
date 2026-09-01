import { describe, expect, it } from 'vitest';
import {
  availabilityFromQuantity,
  availableStock,
  inventoryStatus,
  projectedStock,
  sanitizeIntegerInput,
  suggestedPurchase
} from './inventory';

describe('inventory domain logic', () => {
  it('calculates available stock correctly as onHand minus reserved', () => {
    expect(availableStock(10, 3)).toBe(7);
    expect(availableStock(5, 5)).toBe(0);
    expect(availableStock(4, 6)).toBe(-2);
    expect(availableStock(0, 0)).toBe(0);
  });

  it('calculates projected stock correctly taking into account incoming units', () => {
    expect(projectedStock(10, 3, 5)).toBe(12);
    expect(projectedStock(0, 0, 15)).toBe(15);
    expect(projectedStock(2, 4, 10)).toBe(8);
  });

  it('evaluates storefront availability status accurately', () => {
    // When quantity <= 0
    expect(availabilityFromQuantity(0, 5)).toBe('out_of_stock');
    expect(availabilityFromQuantity(-2, 5)).toBe('out_of_stock');

    // When quantity <= reorderPoint (or <= 1 if reorderPoint is 0)
    expect(availabilityFromQuantity(1, 0)).toBe('low');
    expect(availabilityFromQuantity(3, 5)).toBe('low');
    expect(availabilityFromQuantity(5, 5)).toBe('low');

    // When quantity > reorderPoint
    expect(availabilityFromQuantity(6, 5)).toBe('available');
    expect(availabilityFromQuantity(20, 5)).toBe('available');
  });

  it('determines inventory health status for internal operations', () => {
    // reorderPoint = 5, safetyStock = 2
    expect(inventoryStatus(0, 5, 2)).toBe('out');
    expect(inventoryStatus(-1, 5, 2)).toBe('out');
    expect(inventoryStatus(1, 5, 2)).toBe('critical');
    expect(inventoryStatus(2, 5, 2)).toBe('critical');
    expect(inventoryStatus(3, 5, 2)).toBe('low');
    expect(inventoryStatus(5, 5, 2)).toBe('low');
    expect(inventoryStatus(6, 5, 2)).toBe('ok');
    expect(inventoryStatus(100, 5, 2)).toBe('ok');
  });

  it('calculates suggested purchase quantities based on lead time and daily velocity', () => {
    // averageDailySales = 2, leadTimeDays = 7, safetyStock = 5 => target = 2*7 + 5 = 19
    // available = 4, incoming = 5 => total accounted = 9 => suggestion = 19 - 9 = 10
    expect(suggestedPurchase(4, 5, 2, 7, 5)).toBe(10);

    // If available + incoming exceeds target, return 0 (never negative)
    expect(suggestedPurchase(15, 10, 2, 7, 5)).toBe(0);

    // Decimal average sales ceiling test: 1.5 * 5 + 3 = 10.5 => ceil(10.5) = 11
    // available = 2, incoming = 0 => 11 - 2 = 9
    expect(suggestedPurchase(2, 0, 1.5, 5, 3)).toBe(9);

    // Zero sales with existing stock
    expect(suggestedPurchase(5, 0, 0, 7, 2)).toBe(0);
  });

  it('sanitizes integer input for human-friendly typing without 05 or 50 bugs', () => {
    // Typing over a 0
    expect(sanitizeIntegerInput('05', '0')).toBe('5');
    expect(sanitizeIntegerInput('50', '0')).toBe('5');
    expect(sanitizeIntegerInput('02', '0')).toBe('2');
    expect(sanitizeIntegerInput('20', '0')).toBe('2');

    // Normal typing
    expect(sanitizeIntegerInput('5', '')).toBe('5');
    expect(sanitizeIntegerInput('12', '1')).toBe('12');
    expect(sanitizeIntegerInput('50', '5')).toBe('50'); // typing 0 after 5 gives 50
    expect(sanitizeIntegerInput('100', '10')).toBe('100');

    // Stripping leading zeroes
    expect(sanitizeIntegerInput('00', '0')).toBe('0');
    expect(sanitizeIntegerInput('015', '')).toBe('15');
    expect(sanitizeIntegerInput('007', '')).toBe('7');

    // Backspacing completely
    expect(sanitizeIntegerInput('', '5')).toBe('');

    // Stripping non-numeric characters
    expect(sanitizeIntegerInput('5a', '5')).toBe('5');
    expect(sanitizeIntegerInput('abc', '')).toBe('');
    expect(sanitizeIntegerInput('-4', '')).toBe('4');
  });
});
