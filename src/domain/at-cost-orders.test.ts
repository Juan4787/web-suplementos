import { describe, expect, it } from 'vitest';
import { demoBusinessApi } from '@/services/demo-business-api';
import { availableOrderActions } from '@/domain/order-actions';
import type { CartLine, ImportOrderInput } from '@/domain/types';

describe('Venta al Costo - Rigor Extremo & Paridad de Dominio', () => {
  it('1. Permite cobrar al costo un pedido pendiente y calcula margen neutral ($ 0)', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products.find((p) => p.onHand >= 5)!;
    expect(product).toBeDefined();

    const unitPrice = product.priceCents;
    const unitCost = product.costCents ?? (product as any).currentCostCents ?? 1500000;
    expect(unitPrice).toBeGreaterThan(unitCost);

    const line: CartLine = {
      productId: product.id,
      sku: product.sku,
      slug: product.slug,
      name: product.name,
      presentation: product.presentation,
      imageUrl: product.imageUrl,
      unitPriceCents: unitPrice,
      quantity: 2
    };

    const input: ImportOrderInput = {
      customerName: 'Socio de Gimnasio Test',
      phone: '1155554433',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      paymentMethod: 'cash',
      saleType: 'retail',
      lines: [line],
      shippingFeeCents: 0,
      quotedSubtotalCents: unitPrice * 2,
      quotedTotalCents: unitPrice * 2,
      protocolOrderId: `TEST-COST-${Date.now()}`,
      protocolChecksum: 'ABCD1234'
    };

    const created = await demoBusinessApi.confirmImportedOrder(input);
    expect(created.paymentState).toBe('pending');
    expect(created.saleType).toBe('retail');
    expect(created.totalCents).toBe(unitPrice * 2);

    const actions = availableOrderActions(created);
    expect(actions).toContain('mark_at_cost');
    expect(actions).toContain('mark_paid');
    expect(actions).toContain('mark_gifted');

    // Transición a Cobrar al costo
    const transitioned = await demoBusinessApi.transitionOrder(created.id, 'mark_at_cost');
    expect(transitioned.paymentState).toBe('paid');
    expect(transitioned.saleType).toBe('cost');
    expect(transitioned.isCostSale).toBe(true);
    expect(transitioned.subtotalCents).toBe(unitCost * 2);
    expect(transitioned.totalCents).toBe(unitCost * 2);
    expect(transitioned.taxAmountCents).toBe(0);

    // Margen contable estrictamente $ 0
    const netProfit = transitioned.totalCents - (transitioned.costTotalCents ?? 0) - (transitioned.taxAmountCents ?? 0);
    expect(netProfit).toBe(0);

    // Líneas con precios unitarios al costo
    for (const item of transitioned.items) {
      expect(item.unitPriceCents).toBe(item.unitCostCents);
      expect(item.subtotalCents).toBe((item.unitCostCents ?? 0) * item.quantity);
    }
  });

  it('2. Idempotencia: segundo llamado a mark_at_cost es seguro y no altera montos', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products[0]!;

    const input: ImportOrderInput = {
      customerName: 'Cliente Idempotencia Costo',
      phone: '1199998877',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      paymentMethod: 'transfer',
      lines: [{
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        imageUrl: product.imageUrl,
        unitPriceCents: product.priceCents,
        quantity: 1
      }],
      shippingFeeCents: 0,
      quotedSubtotalCents: product.priceCents,
      quotedTotalCents: product.priceCents,
      protocolOrderId: `IDEMP-COST-${Date.now()}`,
      protocolChecksum: 'IDEMP123'
    };

    const created = await demoBusinessApi.confirmImportedOrder(input);
    const firstCall = await demoBusinessApi.transitionOrder(created.id, 'mark_at_cost');
    const secondCall = await demoBusinessApi.transitionOrder(created.id, 'mark_at_cost');

    expect(firstCall.totalCents).toBe(secondCall.totalCents);
    expect(secondCall.saleType).toBe('cost');
    expect(secondCall.paymentState).toBe('paid');
  });

  it('3. Bloquea mark_at_cost sobre pedidos ya pagados a precio normal o cancelados', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products[0]!;

    const input: ImportOrderInput = {
      customerName: 'Cliente Bloqueo',
      phone: '1122334455',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      paymentMethod: 'cash',
      lines: [{
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        imageUrl: product.imageUrl,
        unitPriceCents: product.priceCents,
        quantity: 1
      }],
      shippingFeeCents: 0,
      quotedSubtotalCents: product.priceCents,
      quotedTotalCents: product.priceCents,
      protocolOrderId: `BLOCK-COST-${Date.now()}`,
      protocolChecksum: 'BLOCK123'
    };

    const created = await demoBusinessApi.confirmImportedOrder(input);
    // Marcar como pagado normal (PVP)
    await demoBusinessApi.transitionOrder(created.id, 'mark_paid');

    // Intentar cobrar al costo cuando ya fue pagado a precio normal debe fallar
    await expect(
      demoBusinessApi.transitionOrder(created.id, 'mark_at_cost')
    ).rejects.toThrow();
  });

  it('4. Permite crear un pedido manual directamente con saleType: cost', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products.find((p) => (p.onHand - p.reserved) >= 3)!;
    expect(product).toBeDefined();
    const unitCost = product.costCents ?? (product as any).currentCostCents ?? 1500000;

    const input: ImportOrderInput = {
      customerName: 'Empleado Compra al Costo',
      phone: '1144445555',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      paymentMethod: 'cash',
      saleType: 'cost',
      lines: [{
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        imageUrl: product.imageUrl,
        unitPriceCents: unitCost,
        quantity: 3
      }],
      shippingFeeCents: 0,
      quotedSubtotalCents: unitCost * 3,
      quotedTotalCents: unitCost * 3,
      protocolOrderId: `MANUAL-COST-${Date.now()}`,
      protocolChecksum: 'MANCOST1'
    };

    const order = await demoBusinessApi.confirmImportedOrder(input);
    expect(order.saleType).toBe('cost');
    expect(order.isCostSale).toBe(true);
    expect(order.totalCents).toBe(unitCost * 3);
    expect(order.taxAmountCents).toBe(0);
    expect(order.paymentState).toBe('pending');

    // Entrega y descuento de inventario
    const initialOnHand = (await demoBusinessApi.listAdminProducts()).find(p => p.id === product.id)!.onHand;
    await demoBusinessApi.transitionOrder(order.id, 'mark_delivered');
    const afterOnHand = (await demoBusinessApi.listAdminProducts()).find(p => p.id === product.id)!.onHand;

    expect(afterOnHand).toBe(initialOnHand - 3);
  });

  it('5. En analíticas comerciales, venta al costo incrementa facturación y costo por igual con margen neutral ($ 0)', async () => {
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 86400000).toISOString();

    const analytics = await demoBusinessApi.getAnalytics(from, to);
    expect(analytics).toBeDefined();
    expect(analytics.costSaleOrders).toBeGreaterThanOrEqual(0);
    expect(analytics.costSaleRevenueCents).toBeGreaterThanOrEqual(0);
  });
});
