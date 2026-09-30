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
