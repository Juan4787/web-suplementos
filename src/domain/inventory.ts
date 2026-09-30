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
 * Sanitizes whole-unit fields while preserving the number the operator typed.
 * - Keeps malformed input visible so it can be corrected, never turning "1,5" into 15.
 * - Preserves meaningful trailing zeroes ("10" must stay 10).
 * - Allows empty string while typing so the user can backspace completely.
 */
export const sanitizeIntegerInput = (newValue: string): string => {
  if (!/^\d*$/.test(newValue)) return newValue;
  let digits = newValue;

  if (digits === '') {
    return '';
  }

  // Strip leading zeroes for numbers like "00", "012", "07000" -> "7000"
  if (digits.length > 1 && digits.startsWith('0')) {
    digits = digits.replace(/^0+/, '') || '0';
  }

  return digits;
};

export const isWholeUnitInput = (value: string): boolean =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647;

export const sanitizeDecimalInput = (newValue: string): string => {
  let clean = newValue.replace(/,/g, '.');
  clean = clean.replace(/[^\d.]/g, '');

  const parts = clean.split('.');
  if (parts.length > 2) {
    clean = parts[0] + '.' + parts.slice(1).join('');
  }

  if (clean === '') {
    return '';
  }

  // El cero a la derecha es significativo: "10" debe seguir siendo diez.
  const dot = clean.indexOf('.');
  if (dot < 0) return clean.replace(/^0+(?=\d)/, '');
  const integer = clean.slice(0, dot).replace(/^0+(?=\d)/, '');
  return `${integer}.${clean.slice(dot + 1)}`;
};
