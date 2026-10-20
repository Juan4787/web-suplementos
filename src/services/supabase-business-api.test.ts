import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabaseBusinessApi, translateDatabaseError } from './supabase-business-api';
const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('@/app/env', () => ({ appEnv: { mode: 'supabase' } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseClient: () => ({ rpc: mockRpc }) }));
describe('errores de operación y archivo de productos', () => {
  beforeEach(() => mockRpc.mockReset());
  it.each([
    ['CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK', 'mercadería'],
    ['IDEMPOTENCY_KEY_REUSE_MISMATCH', 'intento anterior'],
    ['OVER_RECEIVING_NOT_ALLOWED', 'cantidad recibida'],
    ['INVALID_ADJUSTMENT', 'corrección'],
    ['INVALID_QUANTITY', 'cantidad'],
    ['STALE_STOCK_COUNT', 'stock cambió'],
    ['STOCK_THRESHOLDS_CHANGED', 'avisos'],
    ['PURCHASE_RECEIPT_REQUIRED', 'llegada real'],
    ['PURCHASE_SHORTAGE_CHANGED', 'pendientes'],
    ['PURCHASE_SHORTAGE_UNRESOLVED', 'reservas'],
    ['INSUFFICIENT_TARGET_CAPACITY', 'reposici']
  ])('traduce %s a un problema y una acción', (code, message) => {
    const result = translateDatabaseError({ message: code, code: 'P0001' });
    expect(result.message.toLowerCase()).toContain(message);
    expect(result.nextAction).toBeTruthy();
    expect(result.message).not.toContain(code);
  });
  it('no reemplaza un error de archivo por una segunda escritura con datos antiguos', async () => {
    mockRpc.mockResolvedValue({ error: { message: 'FORBIDDEN', code: 'P0001' }, data: null });
    await expect(supabaseBusinessApi.archiveProduct('product-id', true)).rejects.toThrow('permiso');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('archive_product', { p_product_id: 'product-id', p_archived: true });
  });
  it('envía configuración original y números nuevos a la comparación protegida', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const expected = { reorderPoint: 11, safetyStock: 2, leadTimeDays: 7 };
    await supabaseBusinessApi.updateStockThresholds({ productId: 'product-id', reorderPoint: 7, safetyStock: 2, leadTimeDays: 7, expected });
    expect(mockRpc).toHaveBeenCalledWith('update_stock_thresholds_checked', {
      p_product_id: 'product-id', p_reorder_point: 7, p_safety_stock: 2, p_lead_time_days: 7, p_expected: expected
    });
  });
  it('envía cada operación de faltante en una sola llamada con su identificador de reintento', async () => {
    const result = { oldPurchase: { id: 'old' }, newPurchase: { id: 'new' }, transferredReservations: 2 };
    mockRpc.mockResolvedValue({ data: result, error: null });
    expect(await supabaseBusinessApi.replacePurchaseShortage({ purchaseItemId: 'item', expectedPending: 5,
      supplierName: 'Proveedor', expectedAt: null, operationId: 'attempt' })).toEqual(result);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('replace_purchase_shortage', { p_purchase_item_id: 'item', p_expected_pending: 5,
      p_supplier_name: 'Proveedor', p_expected_at: null, p_operation_id: 'attempt' });
    mockRpc.mockClear();
    await supabaseBusinessApi.declarePurchaseShortages('old', [{ purchaseItemId: 'item', quantity: 5 }], 'batch-attempt');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('declare_purchase_shortages', { p_purchase_id: 'old',
      p_items: [{ purchaseItemId: 'item', quantity: 5 }], p_operation_id: 'batch-attempt' });
  });
});


it('sends a reviewed reversal through the atomic RPC with its stable operation and revision', async () => {
  mockRpc.mockResolvedValue({ data: { id: 'order', items: [], paymentState: 'pending' }, error: null });
  await supabaseBusinessApi.transitionOrder('order', 'reverse_payment', { operationId: 'operation', actionRevision: 9 });
  expect(mockRpc).toHaveBeenLastCalledWith('reverse_order_action', {
    p_order_id: 'order', p_action: 'reverse_payment', p_operation_id: 'operation', p_expected_revision: 9
  });
  await supabaseBusinessApi.transitionOrder('order', 'cancel', { actionRevision: 10 });
  expect(mockRpc).toHaveBeenLastCalledWith('transition_order_reviewed', { p_order_id: 'order', p_action: 'cancel', p_expected_revision: 10 });
});

it.each(['ORDER_ACTION_CHANGED', 'ORDER_REVERSAL_RESERVATIONS_MISMATCH', 'CANNOT_CANCEL_PAID_ORDER', 'CANNOT_CANCEL_FULFILLED_ORDER'])(
  'translates %s into a problem and human next action', code => {
    const error = translateDatabaseError({ message: code });
    expect(error.kind).toBe('business');
    expect(error.message).not.toContain(code);
    expect(error.nextAction).toBeTruthy();
  }
);

it('sends cancellation and replacement as one reviewed operation, never as separate writes', async () => {
  mockRpc.mockResolvedValue({ data: { purchase: { id: 'original' }, replacementPurchase: { id: 'replacement' }, transferredUnits: 2 }, error: null });
  const replacement = { supplierName: 'Nuevo proveedor', expectedAt: null };
  await supabaseBusinessApi.cancelPurchase({ purchaseId: 'original', reason: 'No enviará', expectedToken: 'review', operationId: 'operation', replacement });
  expect(mockRpc).toHaveBeenLastCalledWith('cancel_purchase', { p_purchase_id: 'original', p_reason: 'No enviará', p_expected_token: 'review', p_operation_id: 'operation', p_replacement: replacement });
  await supabaseBusinessApi.getPurchaseCancellationPreview('original');
  expect(mockRpc).toHaveBeenLastCalledWith('get_purchase_cancellation_preview', { p_purchase_id: 'original' });
});

it.each(['PURCHASE_CANCELLATION_CHANGED', 'INVALID_PURCHASE_CANCELLATION', 'INVALID_PURCHASE_STATE', 'CANNOT_CANCEL_PURCHASE_WITH_ACTIVE_RESERVATIONS', 'CANNOT_EDIT_PAID_ORDER', 'CANNOT_EDIT_FULFILLED_ORDER', 'CANNOT_REDUCE_BELOW_PACKED_QUANTITY'])(
  'explains %s with a recovery action and no database identifiers', code => {
    const error = translateDatabaseError({ message: code, code: 'P0001' });
    expect(error.message).not.toContain(code); expect(error.nextAction).toBeTruthy();
  }
);

it('sends getOrder and updateOrderItems RPC payloads cleanly', async () => {
  mockRpc.mockResolvedValue({ data: { id: 'order-1', items: [] }, error: null });
  await supabaseBusinessApi.getOrder('order-1');
  expect(mockRpc).toHaveBeenLastCalledWith('get_order', { p_order_id: 'order-1' });

  const input = {
    orderId: 'order-1',
    operationId: 'op-1',
    expectedActionRevision: 2,
    items: [{ productId: 'prod-1', quantity: 3 }]
  };
  await supabaseBusinessApi.updateOrderItems(input);
  expect(mockRpc).toHaveBeenLastCalledWith('update_order_items', { p_input: input });
});

