import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessApi } from './business-api';
import type { AdminProduct, Purchase } from '@/domain/types';
let api: BusinessApi, product: AdminProduct, purchase: Purchase;
beforeEach(async () => {
  vi.resetModules(); api = (await import('./demo-business-api')).demoBusinessApi;
  product = await api.saveProduct({ sku: 'CANCEL_QA', slug: 'cancel-qa', name: 'Producto de prueba', presentation: '1 unidad', description: 'Prueba aislada', category: 'Pruebas', priceCents: 150000, currentCostCents: 100000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/test.svg', imageAlt: 'Producto de prueba', featured: false, published: true, active: true });
  purchase = await api.createPurchase({ supplierName: 'Proveedor original', items: [{ productId: product.id, quantity: 5, unitCostCents: 100000 }] });
});
const order = () => api.confirmImportedOrder({ customerName: 'Cliente que espera', paymentMethod: 'cash', deliveryMethod: 'pickup', shippingType: null, shippingFeeCents: 0, quotedSubtotalCents: 450000, quotedTotalCents: 450000, protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD', lines: [{ productId: product.id, sku: product.sku, slug: product.slug, name: product.name, presentation: product.presentation, imageUrl: product.imageUrl, quantity: 3, unitPriceCents: 150000 }] });
describe('demo purchase cancellation parity', () => {
  it('counts supplier and reason emoji by characters like the database', async () => {
    const preview = await api.getPurchaseCancellationPreview(purchase.id);
    const input = { purchaseId: purchase.id, reason: 'a😀', operationId: crypto.randomUUID(), expectedToken: preview.reviewToken };
    await expect(api.cancelPurchase(input)).rejects.toThrow(/entre 3 y 500/);
    await expect(api.cancelPurchase({ ...input, reason: 'a😀b', replacement: { supplierName: '😀', expectedAt: null } })).rejects.toThrow(/nombre del nuevo proveedor/);
    const result = await api.cancelPurchase({ ...input, reason: '😀'.repeat(500), replacement: { supplierName: '😀'.repeat(120), expectedAt: null } });
    expect(result.purchase.cancellation?.reason).toBe('😀'.repeat(500));
    expect(result.replacementPurchase?.supplierName).toBe('😀'.repeat(120));
  });
  it('cancels only unreceived balance and retries preserve stock, supplier expense and audit', async () => {
    await api.receivePurchase(purchase.id, [{ purchaseItemId: purchase.items[0]!.id, receivedQuantity: 2 }], crypto.randomUUID(), 50000);
    const preview = await api.getPurchaseCancellationPreview(purchase.id);
    const before = (await api.listInventory()).find(p => p.id === product.id)!;
    const input = { purchaseId: purchase.id, reason: 'Proveedor no envía', expectedToken: preview.reviewToken, operationId: crypto.randomUUID() };
    const result = await api.cancelPurchase(input);
    expect(result.purchase.cancellation?.pendingUnits).toBe(3);
    expect(await api.cancelPurchase(input)).toEqual(result);
    const after = (await api.listInventory()).find(p => p.id === product.id)!;
    expect(after.onHand).toBe(before.onHand); expect(after.reserved).toBe(before.reserved); expect(after.incoming).toBe(0);
    expect((await api.getExportDataset()).expenses?.filter(e => e.purchaseId === purchase.id)).toHaveLength(1);
    expect((await api.listPurchases(1,100,'cancelled')).items.some(p => p.id === purchase.id)).toBe(true);
    await expect(api.receivePurchase(purchase.id, [{ purchaseItemId: purchase.items[0]!.id, receivedQuantity: 1 }])).rejects.toThrow();
  });
  it('transfers pending units and later receipt unlocks the same paid and partially packed customer order', async () => {
    const waiting = await order();
    await api.receivePurchase(purchase.id, [{ purchaseItemId: purchase.items[0]!.id, receivedQuantity: 1 }], crypto.randomUUID());
    await api.saveOrderPacking(waiting.id, [{ orderItemId: waiting.items[0]!.id, packedQuantity: 1 }], 0);
    await api.transitionOrder(waiting.id, 'mark_paid');
    const preview = await api.getPurchaseCancellationPreview(purchase.id);
    expect(preview.canCancel).toBe(false); expect(preview.orders[0]!.quantity).toBe(2);
    const result = await api.cancelPurchase({ purchaseId: purchase.id, reason: 'Cambio de proveedor', operationId: crypto.randomUUID(), expectedToken: preview.reviewToken, replacement: { supplierName: 'Nuevo proveedor', expectedAt: '2030-01-01T12:00:00-03:00' } });
    expect(result.transferredUnits).toBe(2);
    expect(result.replacementPurchase!.items[0]!.quantity).toBe(4);
    expect((await api.getPurchaseImpact(purchase.id))[0]!.reservedOrders).toHaveLength(0);
    expect((await api.getPurchaseImpact(result.replacementPurchase!.id))[0]!.reservedOrders[0]!.orderId).toBe(waiting.id);
    await api.receivePurchase(result.replacementPurchase!.id, undefined, crypto.randomUUID());
    const current = (await api.listOrders(1,100,'','all')).items.find(o => o.id === waiting.id)!;
    expect(current.stockReadiness).toBe('ready'); expect(current.paymentState).toBe('paid');
    expect(current.items[0]!.packedQuantity).toBe(1); expect(current.totalCents).toBe(450000); expect(current.costTotalCents).toBe(300000);
  });
  it('rejects stale review and cancellation without replacement when a new order consumes capacity', async () => {
    const preview = await api.getPurchaseCancellationPreview(purchase.id);
    await order();
    await expect(api.cancelPurchase({ purchaseId: purchase.id, reason: 'Proveedor cancela', operationId: crypto.randomUUID(), expectedToken: preview.reviewToken })).rejects.toThrow(/cambiaron/);
    const fresh = await api.getPurchaseCancellationPreview(purchase.id);
    await expect(api.cancelPurchase({ purchaseId: purchase.id, reason: 'Proveedor cancela', operationId: crypto.randomUUID(), expectedToken: fresh.reviewToken })).rejects.toThrow(/no se puede cancelar/);
    expect((await api.listPurchases(1,100)).items.find(p => p.id === purchase.id)!.state).toBe('ordered');
  });
});
