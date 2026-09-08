import { describe, expect, it, vi } from 'vitest';
import { supabaseBusinessApi, translateDatabaseError } from './supabase-business-api';
const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('@/app/env', () => ({ appEnv: { mode: 'supabase' } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseClient: () => ({ rpc: mockRpc }) }));
describe('errores de operación y archivo de productos', () => {
  it.each([
    ['CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK', 'mercadería'],
    ['IDEMPOTENCY_KEY_REUSE_MISMATCH', 'intento anterior'],
    ['OVER_RECEIVING_NOT_ALLOWED', 'cantidad recibida'],
    ['INVALID_ADJUSTMENT', 'corrección'],
    ['INVALID_QUANTITY', 'cantidad'],
    ['STALE_STOCK_COUNT', 'stock cambió']
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
});
