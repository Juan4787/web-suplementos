import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shippingFeeNeedsReview } from '@/domain/order-shipping';
import { orderEditBlock } from '@/domain/order-actions';
import type { BusinessApi } from './business-api';

let api: BusinessApi;

const toCartLine = (p: { id: string; sku: string; slug: string; name: string; presentation: string; imageUrl: string; priceCents: number }, quantity: number) => ({
  productId: p.id,
  sku: p.sku,
  slug: p.slug,
  name: p.name,
  presentation: p.presentation,
  imageUrl: p.imageUrl,
  quantity,
  unitPriceCents: p.priceCents
});

beforeEach(async () => {
  vi.resetModules();
  api = (await import('./demo-business-api')).demoBusinessApi;
});

describe('Order editing (getOrder & updateOrderItems)', () => {
  it('adds a product, increases an existing line, and keeps stock, financials, customers, and export history consistent', async () => {
    const products = await api.listAdminProducts();
    const prodA = products.find((p) => p.active && p.onHand - p.reserved >= 5)!;
    const prodB = products.find((p) => p.active && p.id !== prodA.id && p.onHand - p.reserved >= 5)!;

    const initialAvailA = prodA.onHand - prodA.reserved;
    const initialAvailB = prodB.onHand - prodB.reserved;

    const created = await api.confirmImportedOrder({
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: '1234ABCD',
      customerName: 'Martín Gómez',
      customerFirstName: 'Martín',
      customerLastName: 'Gómez',
      phone: '3425112233',
      paymentMethod: 'transfer',
      deliveryMethod: 'shipping',
      shippingType: 'standard',
      address: 'San Martín',
      addressNumber: '1234',
      shippingFeeCents: 350000,
      quotedSubtotalCents: prodA.priceCents * 2,
      quotedTotalCents: prodA.priceCents * 2 + 350000,
      lines: [toCartLine(prodA, 2)]
    });

    const fetched = await api.getOrder(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.items).toHaveLength(1);

    const opId = crypto.randomUUID();
    const updated = await api.updateOrderItems({
      orderId: created.id,
      expectedActionRevision: created.actionRevision ?? 0,
      operationId: opId,
      items: [
        { productId: prodA.id, quantity: 3 },
        { productId: prodB.id, quantity: 2 }
      ]
    });

    expect(updated.items).toHaveLength(2);
    const expectedSubtotal = prodA.priceCents * 3 + prodB.priceCents * 2;
    expect(updated.subtotalCents).toBe(expectedSubtotal);
    expect(updated.shippingFeeCents).toBe(350000);
    expect(updated.totalCents).toBe(expectedSubtotal + 350000);
    expect(updated.actionRevision).toBe((created.actionRevision ?? 0) + 1);

    // Idempotent retry with same operationId
    const retried = await api.updateOrderItems({
      orderId: created.id,
      expectedActionRevision: created.actionRevision ?? 0,
      operationId: opId,
      items: [
        { productId: prodB.id, quantity: 2 },
        { productId: prodA.id, quantity: 3 }
      ]
    });
    expect(retried.totalCents).toBe(updated.totalCents);
    expect(retried.actionRevision).toBe(updated.actionRevision);

    // Reuse of operationId with different payload must fail
    await expect(
      api.updateOrderItems({
        orderId: created.id,
        expectedActionRevision: created.actionRevision ?? 0,
        operationId: opId,
        items: [{ productId: prodA.id, quantity: 1 }]
      })
    ).rejects.toThrow(/intento anterior/i);

    // Verify stock balances
    const afterProducts = await api.listAdminProducts();
    const afterA = afterProducts.find((p) => p.id === prodA.id)!;
    const afterB = afterProducts.find((p) => p.id === prodB.id)!;
    expect(afterA.onHand - afterA.reserved).toBe(initialAvailA - 3);
    expect(afterB.onHand - afterB.reserved).toBe(initialAvailB - 2);

    // Verify customer pending total reflects edited order
    const customers = await api.listCustomers(1, 50, 'Martín Gómez');
    const customer = customers.items.find((c) => c.id === created.customerId)!;
    expect(customer.pendingTotalCents).toBe(updated.totalCents);

    // Verify export dataset records edit_items action
    const dataset = await api.getExportDataset();
    const auditEntry = dataset.orderActionHistory?.find(
      (entry) => entry.operationId === opId && entry.orderId === created.id
    );
    expect(auditEntry).toBeDefined();
    expect(auditEntry?.action).toBe('edit_items');
    expect(auditEntry?.previous.items).toHaveLength(1);
    expect(auditEntry?.current.items).toHaveLength(2);
  });

  it('releases uncovered and incoming before physical stock on decrease, and reconciles waiting orders when physical stock is freed', async () => {
    const product = await api.saveProduct({
      sku: 'EDIT-RECON-01',
      slug: 'edit-recon-01',
      name: 'Creatina Edit Recon',
      presentation: '300g',
      description: 'Test',
      category: 'Creatinas',
      priceCents: 2000000,
      currentCostCents: 1000000,
      reorderPoint: 2,
      safetyStock: 1,
      leadTimeDays: 3,
      imageUrl: '',
      imageAlt: '',
      published: true,
      active: true
    });

    await api.adjustStock(product.id, 3, 'Stock inicial');
    await api.createPurchase({
      supplierName: 'Proveedor FIFO',
      expectedAt: '2026-11-10',
      notes: null,
      items: [{ productId: product.id, quantity: 4, unitCostCents: 1100000 }]
    });

    // Order 1 takes all 3 physical + 1 incoming = 4 units
    const order1 = await api.confirmImportedOrder({
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: '1234ABC1',
      customerName: 'Cliente Primero',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: undefined,
      shippingFeeCents: 0,
      quotedSubtotalCents: product.priceCents * 4,
      quotedTotalCents: product.priceCents * 4,
      lines: [toCartLine(product, 4)]
    });
    expect(order1.stockReadiness).toBe('waiting_incoming');
    expect(order1.items[0]?.physicalReservedQuantity).toBe(3);
    expect(order1.items[0]?.incomingQuantity).toBe(1);

    // Order 2 takes 2 incoming units
    const order2 = await api.confirmImportedOrder({
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: '1234ABC2',
      customerName: 'Cliente En Espera',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: undefined,
      shippingFeeCents: 0,
      quotedSubtotalCents: product.priceCents * 2,
      quotedTotalCents: product.priceCents * 2,
      lines: [toCartLine(product, 2)]
    });
    expect(order2.stockReadiness).toBe('waiting_incoming');
    expect(order2.items[0]?.physicalReservedQuantity).toBe(0);
    expect(order2.items[0]?.incomingQuantity).toBe(2);

    // Reduce Order 1 from 4 to 1 unit -> releases 1 incoming first, then 2 physical!
    const editedOrder1 = await api.updateOrderItems({
      orderId: order1.id,
      expectedActionRevision: order1.actionRevision ?? 0,
      operationId: crypto.randomUUID(),
      items: [{ productId: product.id, quantity: 1 }]
    });

    expect(editedOrder1.stockReadiness).toBe('ready');
    expect(editedOrder1.items[0]?.physicalReservedQuantity).toBe(1);
    expect(editedOrder1.items[0]?.incomingQuantity).toBe(0);

    // Order 2 should have automatically absorbed the 2 freed physical units via reconciliation!
    const refreshedOrder2 = await api.getOrder(order2.id);
    expect(refreshedOrder2.stockReadiness).toBe('ready');
    expect(refreshedOrder2.items[0]?.physicalReservedQuantity).toBe(2);
    expect(refreshedOrder2.items[0]?.incomingQuantity).toBe(0);
  });

  it('enforces packing bag guards and updates packing state when adding products', async () => {
    const products = await api.listAdminProducts();
    const prodA = products.find((p) => p.active && p.onHand - p.reserved >= 5)!;
    const prodB = products.find((p) => p.active && p.id !== prodA.id && p.onHand - p.reserved >= 5)!;

    const order = await api.confirmImportedOrder({
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: '1234ABC3',
      customerName: 'Lucía Bolsita',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: undefined,
      shippingFeeCents: 0,
      quotedSubtotalCents: prodA.priceCents * 3,
      quotedTotalCents: prodA.priceCents * 3,
      lines: [toCartLine(prodA, 3)]
    });

    // Pack all 3 units and mark ready
    const packed = await api.saveOrderPacking(
      order.id,
      [{ orderItemId: order.items[0]!.id, packedQuantity: 3 }],
      order.packingRevision ?? 0
    );
    const readyOrder = await api.transitionOrder(order.id, 'mark_ready', {
      actionRevision: packed.actionRevision ?? 0
    });
    expect(readyOrder.preparationState).toBe('ready');

    // Cannot reduce prodA below packedQuantity (3)
    await expect(
      api.updateOrderItems({
        orderId: order.id,
        expectedActionRevision: readyOrder.actionRevision ?? 0,
        operationId: crypto.randomUUID(),
        items: [{ productId: prodA.id, quantity: 2 }]
      })
    ).rejects.toThrow(/bolsita/i);

    // Adding prodB while prodA has 3 packed units succeeds, sets prodB.packedQuantity = 0, and moves preparationState to 'preparing'
    const updated = await api.updateOrderItems({
      orderId: order.id,
      expectedActionRevision: readyOrder.actionRevision ?? 0,
      operationId: crypto.randomUUID(),
      items: [
        { productId: prodA.id, quantity: 3 },
        { productId: prodB.id, quantity: 1 }
      ]
    });

    expect(updated.preparationState).toBe('preparing');
    expect(updated.packingTracked).toBe(true);
    expect(updated.packingRevision).toBe((readyOrder.packingRevision ?? 0) + 1);
    const itemA = updated.items.find((i) => i.productId === prodA.id)!;
    const itemB = updated.items.find((i) => i.productId === prodB.id)!;
    expect(itemA.packedQuantity).toBe(3);
    expect(itemB.packedQuantity).toBe(0);
  });

  it('blocks editing paid or delivered orders with clear messages and allows editing after reversal', async () => {
    const products = await api.listAdminProducts();
    const prodA = products.find((p) => p.active && p.onHand - p.reserved >= 4)!;

    const order = await api.confirmImportedOrder({
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: '1234ABC4',
      customerName: 'Carlos Cobrado',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: undefined,
      shippingFeeCents: 0,
      quotedSubtotalCents: prodA.priceCents,
      quotedTotalCents: prodA.priceCents,
      lines: [toCartLine(prodA, 1)]
    });

    const paid = await api.transitionOrder(order.id, 'mark_paid', {
      actionRevision: order.actionRevision ?? 0
    });
    expect(orderEditBlock(paid, true)).toMatch(/Deshacer cobro/i);

    await expect(
      api.updateOrderItems({
        orderId: order.id,
        expectedActionRevision: paid.actionRevision ?? 0,
        operationId: crypto.randomUUID(),
        items: [{ productId: prodA.id, quantity: 2 }]
      })
    ).rejects.toThrow(/figura cobrado/i);

    // Reverse payment -> now editable!
    const unpaid = await api.transitionOrder(order.id, 'reverse_payment', {
      operationId: crypto.randomUUID(),
      actionRevision: paid.actionRevision ?? 0
    });
    expect(orderEditBlock(unpaid, true)).toBeNull();

    const edited = await api.updateOrderItems({
      orderId: order.id,
      expectedActionRevision: unpaid.actionRevision ?? 0,
      operationId: crypto.randomUUID(),
      items: [{ productId: prodA.id, quantity: 2 }]
    });
    expect(edited.items[0]?.quantity).toBe(2);
    expect(edited.totalCents).toBe(prodA.priceCents * 2);
  });

  it('flags percentage shipping fee for review when product costs change after editing', async () => {
    const products = await api.listAdminProducts();
    const prodA = products.find((p) => p.active && (p.currentCostCents ?? 0) > 0 && p.onHand - p.reserved >= 4)!;

    const order = await api.confirmImportedOrder({
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: '1234ABC5',
      customerName: 'Ana Envío Porcentaje',
      paymentMethod: 'transfer',
      deliveryMethod: 'shipping',
      shippingType: 'standard',
      address: 'Bv. Gálvez',
      addressNumber: '1500',
      shippingFeeCents: 200000,
      quotedSubtotalCents: prodA.priceCents,
      quotedTotalCents: prodA.priceCents + 200000,
      lines: [toCartLine(prodA, 1)]
    });

    const withPctShipping = await api.saveOrderShippingFee({
      orderId: order.id,
      operationId: crypto.randomUUID(),
      expectedRevision: order.shippingFeeRevision ?? 0,
      method: 'percentage',
      basisPoints: 1000,
      expectedCostCents: order.costTotalCents ?? 0
    });
    expect(shippingFeeNeedsReview(withPctShipping)).toBe(false);

    const edited = await api.updateOrderItems({
      orderId: order.id,
      expectedActionRevision: withPctShipping.actionRevision ?? 0,
      operationId: crypto.randomUUID(),
      items: [{ productId: prodA.id, quantity: 2 }]
    });

    expect(shippingFeeNeedsReview(edited)).toBe(true);
    await expect(
      api.transitionOrder(order.id, 'mark_paid', { actionRevision: edited.actionRevision ?? 0 })
    ).rejects.toThrow(/costo de los productos cambió/i);
  });
});
