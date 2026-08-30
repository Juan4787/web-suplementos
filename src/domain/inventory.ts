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

