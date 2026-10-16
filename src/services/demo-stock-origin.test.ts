import { beforeEach, expect, it, vi } from 'vitest';
import type { BusinessApi } from './business-api';
import type { AdminProduct, StockSource } from '@/domain/types';
let api: BusinessApi, product: AdminProduct;
beforeEach(async () => {
  vi.resetModules(); api = (await import('./demo-business-api')).demoBusinessApi;
  product = await api.saveProduct({ sku: 'ORIGIN_TEST', slug: 'origin-test', name: 'Producto de comprobación', presentation: '1 unidad', description: 'Comprobación aislada', category: 'Pruebas', priceCents: 150000, currentCostCents: 100000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/test.svg', imageAlt: 'Producto de comprobación', published: true, active: true });
  await api.adjustStock(product.id, 4, 'Conteo inicial');
});
const order = (quantity: number, stockSource: StockSource) => api.confirmImportedOrder({ stockSource, customerName: 'Cliente de comprobación', paymentMethod: 'cash', deliveryMethod: 'pickup', shippingType: null, shippingFeeCents: 0, quotedSubtotalCents: 150000 * quantity, quotedTotalCents: 150000 * quantity, protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD', lines: [{ ...product, productId: product.id, unitPriceCents: 150000, quantity }] });
const balance = async () => (await api.listInventory()).find(p => p.id === product.id)!;

it('preserva lo elegido en camino y consume sólo la recepción propia sin tocar stock libre anterior', async () => {
  const purchase = await api.createPurchase({ supplierName: 'Proveedor asignado', items: [{ productId: product.id, quantity: 10, unitCostCents: 100000 }] });
  const future = await order(3, 'incoming_only');
  await api.adjustStock(product.id, 1, 'Nuevo conteo');
  const normal = await order(1, 'normal');
  await api.transitionOrder(normal.id, 'cancel');
  const other = await api.createPurchase({ supplierName: 'Otro proveedor', items: [{ productId: product.id, quantity: 1, unitCostCents: 200000 }] });
  await api.receivePurchase(other.id, undefined, crypto.randomUUID());
  expect((await balance()).reserved).toBe(0);
  expect((await balance()).available).toBe(6);
  await api.receivePurchase(purchase.id, [{ purchaseItemId: purchase.items[0]!.id, receivedQuantity: 1 }], crypto.randomUUID());
  const context = await api.getOrderStockContext(future.id);
  expect(context.items[0]).toMatchObject({ physicalQuantity: 1, incomingQuantity: 2, available: 6 });
  expect(context.items[0]!.purchases[0]).toMatchObject({ id: purchase.id, reservedQuantity: 2, incomingQuantity: 2, uncoveredQuantity: 0 });
  const current = (await api.listOrders(1, 100)).items.find(o => o.id === future.id)!;
  expect(current.costTotalCents).toBe(300000);
  expect(current.items[0]!.packedQuantity).toBeNull();
});

it('respeta varias compras, recepción parcial y cambio de proveedor sin alterar el cobro ni la bolsita', async () => {
  const first = await api.createPurchase({ supplierName: 'Primero', expectedAt: '2030-01-01T15:00:00Z', items: [{ productId: product.id, quantity: 2, unitCostCents: 100000 }] });
  const second = await api.createPurchase({ supplierName: 'Segundo', expectedAt: '2030-01-02T15:00:00Z', items: [{ productId: product.id, quantity: 4, unitCostCents: 200000 }] });
  const future = await order(3, 'incoming_only');
  await api.receivePurchase(second.id, [{ purchaseItemId: second.items[0]!.id, receivedQuantity: 1 }], crypto.randomUUID());
  expect((await api.getOrderStockContext(future.id)).items[0]).toMatchObject({ physicalQuantity: 1, incomingQuantity: 2, available: 4 });
  await api.saveOrderPacking(future.id, [{ orderItemId: future.items[0]!.id, packedQuantity: 1 }], 0);
  await api.transitionOrder(future.id, 'mark_paid');
  await api.receivePurchase(first.id, [{ purchaseItemId: first.items[0]!.id, receivedQuantity: 1 }], crypto.randomUUID());
  const preview = await api.getPurchaseCancellationPreview(first.id);
  const replacement = await api.cancelPurchase({ purchaseId: first.id, reason: 'Proveedor no completa', operationId: crypto.randomUUID(), expectedToken: preview.reviewToken, replacement: { supplierName: 'Reposición', expectedAt: '2030-01-03T15:00:00Z' } });
  expect((await api.getOrderStockContext(future.id)).items[0]!.purchases[0]!.id).toBe(replacement.replacementPurchase!.id);
  await api.receivePurchase(replacement.replacementPurchase!.id, undefined, crypto.randomUUID());
  const current = (await api.listOrders(1, 100)).items.find(o => o.id === future.id)!;
  expect(current).toMatchObject({ stockReadiness: 'ready', paymentState: 'paid', costTotalCents: 400000, totalCents: 450000 });
  expect(current.items[0]!.packedQuantity).toBe(1);
  expect((await balance()).available).toBe(4);
});

it('reasigna la promesa pendiente cuando una llegada completa a otro cliente más antiguo', async () => {
  await api.adjustStock(product.id, -4, 'Stock físico agotado', 4);
  const first = await api.createPurchase({ supplierName: 'Primero', expectedAt: '2030-01-01T15:00:00Z', items: [{ productId: product.id, quantity: 1, unitCostCents: 100000 }] });
  const older = await order(1, 'normal');
  const second = await api.createPurchase({ supplierName: 'Segundo', expectedAt: '2030-01-02T15:00:00Z', items: [{ productId: product.id, quantity: 1, unitCostCents: 200000 }] });
  const future = await order(1, 'incoming_only');
  await api.transitionOrder(future.id, 'mark_paid');
  const receipt = await api.receivePurchase(second.id, undefined, crypto.randomUUID());
  expect(receipt.unblockedOrders).toContainEqual({ id: older.id, number: older.number });
  expect(receipt.reassignedOrders).toEqual([{ id: future.id, number: future.number, incomingQuantity: 1, uncoveredQuantity: 0 }]);
  expect((await api.getOrderStockContext(future.id)).items[0]!.purchases).toMatchObject([{ id: first.id, reservedQuantity: 1 }]);
  expect((await api.getPurchaseImpact(second.id))[0]!.reservedOrders).toHaveLength(0);
  await api.receivePurchase(first.id, undefined, crypto.randomUUID());
  const current = (await api.listOrders(1, 100)).items.find(o => o.id === future.id)!;
  expect(current).toMatchObject({ stockReadiness: 'ready', paymentState: 'paid', costTotalCents: 200000 });
  expect((await balance()).reserved).toBe(2);
});
