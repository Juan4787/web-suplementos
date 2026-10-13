import { describe, expect, it } from 'vitest';
import type { Order, OrderAction, OrderTransitionExpectation } from '@/domain/types';
import { availableOrderActions } from '@/domain/order-actions';
import { demoBusinessApi as api } from './demo-business-api';

async function fixture(deliveryMethod: 'pickup' | 'shipping' = 'pickup', source: 'normal' | 'incoming_only' = 'normal') {
  const key = crypto.randomUUID();
  const product = await api.saveProduct({ sku: key, slug: key, name: `Correcciones ${key}`, presentation: '1 u.',
    description: 'Fixture aislado', category: 'QA', priceCents: 150000, currentCostCents: 100000,
    reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/test.svg', imageAlt: 'QA', published: true, active: true });
  await api.adjustStock(product.id, 8, 'Fixture');
  if (source === 'incoming_only') await api.createPurchase({ supplierName: 'Proveedor QA', items: [{ productId: product.id, quantity: 3, unitCostCents: 100000 }] });
  const order = await api.confirmImportedOrder({ protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD',
    customerName: `Cliente ${key}`, paymentMethod: 'cash', deliveryMethod, shippingType: deliveryMethod === 'shipping' ? 'standard' : null,
    address: deliveryMethod === 'shipping' ? 'Calle QA' : undefined, addressNumber: deliveryMethod === 'shipping' ? '123' : undefined,
    phone: '5493415551234', shippingFeeCents: 0, quotedSubtotalCents: 300000, quotedTotalCents: 300000,
    stockSource: source, lines: [{ productId: product.id, sku: product.sku, slug: product.slug, name: product.name, presentation: product.presentation, imageUrl: product.imageUrl, quantity: 2, unitPriceCents: 150000 }] });
  Object.assign(order, await api.saveOrderShippingFee({ orderId: order.id, operationId: crypto.randomUUID(), expectedRevision: 0, method: 'manual', amountCents: 5000 }));
  return { order, product, stock: async () => (await api.listInventory()).find(p => p.id === product.id)! };
}
const expectation = (order: Order) => ({ operationId: crypto.randomUUID(), actionRevision: order.actionRevision ?? 0 });
const transition = async (order: Order, action: OrderAction, expected?: OrderTransitionExpectation) => {
  const result = await api.transitionOrder(order.id, action, expected);
  Object.assign(order, result);
  return result;
};
const reverse = (order: Order, action: OrderAction) => transition(order, action, expectation(order));

describe('correcciones de pedidos y sus efectos comerciales', () => {
  it('resta cobros de ventas, margen, envío y cliente; conserva entrega y snapshots; recollects once', async () => {
    const { order, stock } = await fixture();
    await transition(order, 'mark_paid');
    await transition(order, 'mark_delivered');
    const before = structuredClone(order), inventory = await stock();
    const oldRevision = expectation(order);
    await transition(order, 'reverse_payment', oldRevision);
    expect(order).toMatchObject({ paymentState: 'pending', paidAt: null, fulfillmentState: 'delivered',
      totalCents: before.totalCents, costTotalCents: before.costTotalCents, taxAmountCents: before.taxAmountCents, shippingFeeCents: 5000 });
    expect(await stock()).toMatchObject({ onHand: inventory.onHand, reserved: inventory.reserved });
    expect((await api.listPaidOrders(1, 1000)).items.some(o => o.id === order.id)).toBe(false);
    const customer = (await api.listCustomers(1, 1000, order.customerName)).items[0]!;
    expect(customer).toMatchObject({ totalPaidCents: 0, pendingTotalCents: 305000, pendingOrderCount: 1 });
    await transition(order, 'mark_paid');
    const paidAt = order.paidAt;
    await transition(order, 'reverse_payment', oldRevision);
    expect(order).toMatchObject({ paymentState: 'paid', paidAt });
    expect((await api.getExportDataset()).orderActionHistory?.filter(e => e.orderId === order.id)).toHaveLength(1);
  });

  it('restores stock and the same reservation without freeing it, and repeated cycles do not inflate demand', async () => {
    const { order, stock } = await fixture();
    Object.assign(order, await api.saveOrderPacking(order.id, order.items.map(i => ({ orderItemId: i.id, packedQuantity: i.quantity })), 0));
    await transition(order, 'mark_paid');
    await transition(order, 'mark_delivered');
    expect(await stock()).toMatchObject({ onHand: 6, reserved: 0, available: 6, averageDailySales: 0.07 });
    const request = expectation(order);
    await transition(order, 'reverse_delivery', request);
    await transition(order, 'reverse_delivery', request);
    expect(await stock()).toMatchObject({ onHand: 8, reserved: 2, available: 6, averageDailySales: 0 });
    expect(order).toMatchObject({ fulfillmentState: 'pending', paymentState: 'paid', fulfilledAt: null });
    expect(order.items[0]).toMatchObject({ packedQuantity: 2, physicalReservedQuantity: 2 });
    expect((await api.listProductReservations(order.items[0]!.productId))[0]).toMatchObject({ orderId: order.id, physicalQuantity: 2 });
    await transition(order, 'mark_delivered');
    expect(await stock()).toMatchObject({ onHand: 6, reserved: 0, averageDailySales: 0.07 });
    await reverse(order, 'reverse_delivery');
    await reverse(order, 'reverse_payment');
    await expect(transition(order, 'cancel')).rejects.toThrow('bolsita');
    Object.assign(order, await api.saveOrderPacking(order.id, order.items.map(i => ({ orderItemId: i.id, packedQuantity: 0 })), 1));
    await transition(order, 'cancel');
    expect(await stock()).toMatchObject({ onHand: 8, reserved: 0, available: 8, averageDailySales: 0 });
  });

  it('reverts delivery to sent, then restores stock only when the shipment is undone', async () => {
    const { order, stock } = await fixture('shipping');
    await transition(order, 'mark_paid');
    await transition(order, 'mark_shipped');
    const shippedAt = order.shippedAt;
    await transition(order, 'mark_delivered');
    await reverse(order, 'reverse_delivery');
    expect(order).toMatchObject({ fulfillmentState: 'shipped', shippedAt, fulfilledAt: null });
    expect(await stock()).toMatchObject({ onHand: 6, reserved: 0 });
    await expect(transition(order, 'cancel')).rejects.toThrow();
    await reverse(order, 'reverse_shipment');
    expect(order).toMatchObject({ fulfillmentState: 'pending', shippedAt: null, paymentState: 'paid' });
    expect(await stock()).toMatchObject({ onHand: 8, reserved: 2 });
  });

  it('keeps the agreed cost price, taxes and shipping when collection is corrected', async () => {
    const { order } = await fixture();
    await transition(order, 'mark_at_cost');
    await reverse(order, 'reverse_payment');
    expect(order).toMatchObject({ saleType: 'cost', totalCents: 205000, taxAmountCents: 0, paymentState: 'pending' });
    expect(order.items[0]).toMatchObject({ unitPriceCents: 100000, unitCostCents: 100000 });
    await transition(order, 'mark_paid');
    expect(order.totalCents).toBe(205000);
  });

  it('rejects stale confirmations and incompatible reuse, and two simultaneous corrections have one winner', async () => {
    const { order, stock } = await fixture();
    await transition(order, 'mark_paid');
    const stale = expectation(order);
    await transition(order, 'mark_delivered');
    await expect(transition(order, 'reverse_payment', stale)).rejects.toThrow('cambió');
    const left = expectation(order), right = expectation(order);
    const results = await Promise.allSettled([transition(order, 'reverse_delivery', left), transition(order, 'reverse_delivery', right)]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await stock()).toMatchObject({ onHand: 8, reserved: 2 });
    await expect(transition(order, 'reverse_payment', left)).rejects.toThrow('datos cambiaron');
  });

  it('corrects collection while waiting for incoming stock without converting inbound reservations into physical ones', async () => {
    const { order, stock } = await fixture('pickup', 'incoming_only');
    await transition(order, 'mark_paid');
    await reverse(order, 'reverse_payment');
    expect(await stock()).toMatchObject({ onHand: 8, reserved: 0, incoming: 3, incomingReserved: 2 });
    expect(availableOrderActions(order)).toContain('cancel');
    await transition(order, 'cancel');
    expect(await stock()).toMatchObject({ onHand: 8, reserved: 0, incoming: 3, incomingReserved: 0 });
  });
});
