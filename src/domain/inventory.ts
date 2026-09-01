import type { AvailabilityStatus, InventoryItem } from './types';

export const availableStock = (onHand: number, reserved: number): number => onHand - reserved;

export const projectedStock = (onHand: number, reserved: number, incoming: number): number =>
  availableStock(onHand, reserved) + incoming;

export const availabilityFromQuantity = (
  quantity: number,
  reorderPoint: number
): AvailabilityStatus => {
  if (quantity <= 0) return 'out_of_stock';
  if (quantity <= Math.max(1, reorderPoint)) return 'low';
  return 'available';
};

export const inventoryStatus = (
  available: number,
  reorderPoint: number,
  safetyStock: number
): InventoryItem['status'] => {
  if (available <= 0) return 'out';
  if (available <= safetyStock) return 'critical';
  if (available <= reorderPoint) return 'low';
  return 'ok';
};

export const suggestedPurchase = (
  available: number,
  incoming: number,
  averageDailySales: number,
  leadTimeDays: number,
  safetyStock: number
): number => {
  const target = Math.ceil(averageDailySales * leadTimeDays + safetyStock);
  return Math.max(0, target - available - incoming);
};

/**
 * Sanitizes numeric user input to prevent typing glitches (e.g. typing 5 over 0 becoming "50" or "05").
 * - Filters non-digit characters.
 * - If previous was "0" and user enters a new digit, it replaces "0" (e.g. "05" -> "5", "50" -> "5").
 * - Strips leading zeroes for multi-digit numbers (e.g. "012" -> "12").
 * - Allows empty string while typing so the user can backspace completely.
 */
export const sanitizeIntegerInput = (newValue: string, prevValue = ''): string => {
  let digits = newValue.replace(/\D/g, '');

  if (digits === '') {
    return '';
  }

  // If previous was '0' and user typed a single digit (producing '05' or '50')
  if (prevValue === '0' && digits.length === 2) {
    if (digits.startsWith('0')) {
      return digits.slice(1); // '05' -> '5'
    }
    if (digits.endsWith('0')) {
      return digits.slice(0, 1); // '50' -> '5'
    }
  }

  // Strip leading zeroes for numbers like "00", "012" -> "12"
  if (digits.length > 1 && digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '') || '0';
  }

  return digits;
};

