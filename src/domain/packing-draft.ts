import type { Order } from './types';

export type PackingDraft = { baseline: Order; values: Record<string, string>; saving?: boolean; error?: unknown };
export type PackingDraftStore = Map<string, PackingDraft>;

export const packingValues = (order: Order): Record<string, string> => Object.fromEntries(
  order.items.map(item => [item.id, item.packedQuantity != null ? String(item.packedQuantity)
    : Math.min(item.quantity, item.physicalReservedQuantity ?? item.quantity) === 0 ? '0' : ''])
);

export const packingDraftDirty = (draft: PackingDraft): boolean => {
  const initial = packingValues(draft.baseline);
  return Object.keys({ ...initial, ...draft.values }).some(id => initial[id] !== draft.values[id]);
};

// Physical receipts can unlock a line without changing an operator's packing revision.
export const packingVersion = (order: Order): string => JSON.stringify([
  order.packingRevision ?? 0, order.orderState, order.fulfillmentState,
  order.items.map(item => [item.id, item.quantity, item.packedQuantity ?? null])
]);
