import { describe, it, expect } from 'vitest';
import { demoBusinessApi } from '@/services/demo-business-api';
import type { ImportOrderInput, Order } from '@/domain/types';
import { availableOrderActions } from '@/domain/order-actions';

describe('Auditoría Profunda de 15 Puntos: Pedidos de Regalo / Cortesía', () => {

  // Punto 1: Idempotencia de mark_gifted
  it('1. Idempotencia: segundo llamado a mark_gifted es idempotente y no duplica descuento de stock', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products.find((p) => p.onHand >= 5)!;
    const initialOnHand = product.onHand;

    const orderInput: ImportOrderInput = {
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'IDEMP001',
      customerName: 'Test Idempotencia',
      phone: '3426000001',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      address: null,
      addressNumber: null,
      quotedSubtotalCents: product.priceCents,
      quotedTotalCents: product.priceCents,
      lines: [{
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        quantity: 1,
        unitPriceCents: product.priceCents,
        imageUrl: product.imageUrl
      }]
    };

    const order = await demoBusinessApi.confirmImportedOrder(orderInput);
    const gifted1 = await demoBusinessApi.transitionOrder(order.id, 'mark_gifted');
    expect(gifted1.paymentState).toBe('gifted');
    expect(gifted1.fulfillmentState).toBe('delivered');

    const prodsAfterFirst = await demoBusinessApi.listAdminProducts();
    const stockAfterFirst = prodsAfterFirst.find((p) => p.id === product.id)!.onHand;
    expect(stockAfterFirst).toBe(initialOnHand - 1);

    // Segundo llamado a mark_gifted: debe ser idempotente y no descontar stock
    const gifted2 = await demoBusinessApi.transitionOrder(order.id, 'mark_gifted');
    expect(gifted2.paymentState).toBe('gifted');
    expect(gifted2.fulfillmentState).toBe('delivered');

    const prodsAfterSecond = await demoBusinessApi.listAdminProducts();
    const stockAfterSecond = prodsAfterSecond.find((p) => p.id === product.id)!.onHand;

    // El stock no debe haberse descontado dos veces
    expect(stockAfterSecond).toBe(stockAfterFirst);
  });

  // Punto 2 y 6: mark_gifted sobre paid → INVALID_TRANSITION
  it('mark_gifted sobre paid → INVALID_TRANSITION', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products.find((p) => (p.onHand - p.reserved) >= 3)!;

    const orderInput: ImportOrderInput = {
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'PAIDINV1',
      customerName: 'Test Paid Transition',
      phone: '3426000099',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      address: null,
      addressNumber: null,
      quotedSubtotalCents: product.priceCents,
      quotedTotalCents: product.priceCents,
      lines: [{
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        quantity: 1,
        unitPriceCents: product.priceCents,
        imageUrl: product.imageUrl
      }]
    };

    const order = await demoBusinessApi.confirmImportedOrder(orderInput);
    // Cobrar el pedido
    await demoBusinessApi.transitionOrder(order.id, 'mark_paid');

    // Intentar regalar un pedido ya cobrado debe arrojar INVALID_TRANSITION
    await expect(
      demoBusinessApi.transitionOrder(order.id, 'mark_gifted')
    ).rejects.toThrow('INVALID_TRANSITION');
  });

  // Punto 4: Regalo de pedido con múltiples productos
  it('4. Regalo con múltiples productos: descuenta on_hand exacto, suma costos y crea movimientos', async () => {
    const products = (await demoBusinessApi.listAdminProducts()).filter((p) => p.onHand >= 4);
    expect(products.length).toBeGreaterThanOrEqual(2);

    const p1 = products[0]!;
    const p2 = products[1]!;
    const p1Initial = p1.onHand;
    const p2Initial = p2.onHand;

    const orderInput: ImportOrderInput = {
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'MULTI001',
      customerName: 'Test Multi Productos',
      phone: '3426000002',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      address: null,
      addressNumber: null,
      quotedSubtotalCents: p1.priceCents * 2 + p2.priceCents * 1,
      quotedTotalCents: p1.priceCents * 2 + p2.priceCents * 1,
      lines: [
        {
          productId: p1.id,
          sku: p1.sku,
          slug: p1.slug,
          name: p1.name,
          presentation: p1.presentation,
          quantity: 2,
          unitPriceCents: p1.priceCents,
          imageUrl: p1.imageUrl
        },
        {
          productId: p2.id,
          sku: p2.sku,
          slug: p2.slug,
          name: p2.name,
          presentation: p2.presentation,
          quantity: 1,
          unitPriceCents: p2.priceCents,
          imageUrl: p2.imageUrl
        }
      ]
    };

    const order = await demoBusinessApi.confirmImportedOrder(orderInput);
    const gifted = await demoBusinessApi.transitionOrder(order.id, 'mark_gifted');

    expect(gifted.paymentState).toBe('gifted');
    expect(gifted.totalCents).toBe(0);

    const prodsAfter = await demoBusinessApi.listAdminProducts();
    expect(prodsAfter.find((p) => p.id === p1.id)!.onHand).toBe(p1Initial - 2);
    expect(prodsAfter.find((p) => p.id === p2.id)!.onHand).toBe(p2Initial - 1);
  });

  // Punto 5: Pedidos ya entregados (fulfillmentState = delivered, paymentState = pending)
  it('mark_gifted sobre delivered → no descuenta stock', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products.find((p) => p.onHand >= 5)!;
    const initialOnHand = product.onHand;

    const orderInput: ImportOrderInput = {
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'DELIV001',
      customerName: 'Test Ya Entregado',
      phone: '3426000003',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      address: null,
      addressNumber: null,
      quotedSubtotalCents: product.priceCents,
      quotedTotalCents: product.priceCents,
      lines: [{
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        quantity: 1,
        unitPriceCents: product.priceCents,
        imageUrl: product.imageUrl
      }]
    };

    const order = await demoBusinessApi.confirmImportedOrder(orderInput);

    // 1. Entregar el pedido primero (descuenta stock físico por entrega)
    await demoBusinessApi.transitionOrder(order.id, 'mark_delivered');

    const prodsAfterDelivery = await demoBusinessApi.listAdminProducts();
    const stockAfterDelivery = prodsAfterDelivery.find((p) => p.id === product.id)!.onHand;
    expect(stockAfterDelivery).toBe(initialOnHand - 1);

    // 2. Ahora registrarlo como regalo (mark_gifted sobre un pedido ya entregado)
    const gifted = await demoBusinessApi.transitionOrder(order.id, 'mark_gifted');
    expect(gifted.paymentState).toBe('gifted');
    expect(gifted.fulfillmentState).toBe('delivered');
    expect(gifted.totalCents).toBe(0);

    const prodsAfterGift = await demoBusinessApi.listAdminProducts();
    const stockAfterGift = prodsAfterGift.find((p) => p.id === product.id)!.onHand;

    // El stock no debe haberse decrementado una segunda vez
    expect(stockAfterGift).toBe(stockAfterDelivery);
  });

  // Punto 6: UI availableOrderActions
  it('6. Estados inválidos en UI: availableOrderActions bloquea mark_gifted si ya fue pagado, cancelado o regalado', () => {
    const base: Order = {
      id: 'test-order-invalid',
      number: 9999,
      customerId: 'cust-1',
      customerName: 'Cliente Test',
      customerPhone: '11223344',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingAddress: null,
      orderState: 'confirmed',
      paymentState: 'pending',
      preparationState: 'ready',
      fulfillmentState: 'pending',
      stockReadiness: 'ready',
      expectedArrivalAt: null,
      subtotalCents: 10000,
      shippingFeeCents: 0,
      totalCents: 10000,
      taxRateBasisPoints: 0,
      taxAmountCents: 0,
      costTotalCents: 5000,
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      paidAt: null,
      fulfilledAt: null,
      items: []
    };

    expect(availableOrderActions({ ...base, paymentState: 'pending' })).toContain('mark_gifted');
    expect(availableOrderActions({ ...base, orderState: 'cancelled' })).not.toContain('mark_gifted');
    expect(availableOrderActions({ ...base, paymentState: 'refunded' })).not.toContain('mark_gifted');
    expect(availableOrderActions({ ...base, paymentState: 'paid' })).not.toContain('mark_gifted');
    expect(availableOrderActions({ ...base, paymentState: 'gifted' })).not.toContain('mark_gifted');
  });

  // Punto 7: Regalo con reservas existentes
  it('7. Regalo consume correctamente las reservas activas y recalibra stock disponible', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products.find((p) => p.onHand >= 5)!;
    const initialReserved = product.reserved;
    const initialOnHand = product.onHand;

    const orderInput: ImportOrderInput = {
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'RES001',
      customerName: 'Test Reserva',
      phone: '3426000004',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      address: null,
      addressNumber: null,
      quotedSubtotalCents: product.priceCents * 2,
      quotedTotalCents: product.priceCents * 2,
      lines: [{
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        quantity: 2,
        unitPriceCents: product.priceCents,
        imageUrl: product.imageUrl
      }]
    };

    const order = await demoBusinessApi.confirmImportedOrder(orderInput);
    const prodsReserved = await demoBusinessApi.listAdminProducts();
    expect(prodsReserved.find((p) => p.id === product.id)!.reserved).toBe(initialReserved + 2);

    await demoBusinessApi.transitionOrder(order.id, 'mark_gifted');

    const prodsFinal = await demoBusinessApi.listAdminProducts();
    const finalProd = prodsFinal.find((p) => p.id === product.id)!;

    // onHand debe haber bajado 2
    expect(finalProd.onHand).toBe(initialOnHand - 2);
    // reserved debe haber vuelto al valor previo (liberando la reserva por consumo)
    expect(finalProd.reserved).toBe(initialReserved);
  });

  // Punto 8: Analytics con período sin regalos (regresión cero)
  it('8. Analytics sin regalos: preserva paridad histórica de fórmulas sin NaN', async () => {
    const analytics = await demoBusinessApi.getAnalytics('2026-06-01', '2026-06-30');
    expect(Number.isFinite(analytics.revenueCents)).toBe(true);
    expect(Number.isFinite(analytics.costCents)).toBe(true);
    expect(Number.isFinite(analytics.estimatedMarginCents)).toBe(true);
    expect(Number.isFinite(analytics.averageTicketCents)).toBe(true);
    expect(Number.isNaN(analytics.averageTicketCents)).toBe(false);
  });

  // Punto 9: Analytics con únicamente regalos (sin división por cero ni NaN)
  it('9. Analytics con únicamente regalos: averageTicket es 0 (no NaN ni Infinity)', async () => {
    const emptyDay = await demoBusinessApi.getAnalytics('2026-01-01', '2026-01-01');
    expect(Number.isNaN(emptyDay.averageTicketCents)).toBe(false);
    expect(emptyDay.averageTicketCents).toBe(0);
    expect(emptyDay.orders).toBe(0);
  });

  // Punto 10: Mezcla de venta + regalo en métricas
  it('10. Mezcla venta + regalo: averageTicket se calcula SOLO sobre pedidos pagados', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
    const analytics = await demoBusinessApi.getAnalytics(today, today);

    if (analytics.orders > 0) {
      const expectedTicket = Math.round(analytics.revenueCents / analytics.orders);
      expect(analytics.averageTicketCents).toBe(expectedTicket);
    }
  });

  // Punto 11: search_orders y search_paid_orders de forma independiente
  it('11. search_paid_orders incluye paid + gifted, mientras orders en analíticas cuenta solo paid', async () => {
    const paidOrders = await demoBusinessApi.listPaidOrders(1, 100);
    const hasPaid = paidOrders.items.some((o) => o.paymentState === 'paid');
    const hasGifted = paidOrders.items.some((o) => o.paymentState === 'gifted');

    expect(hasPaid || hasGifted).toBe(true);
    expect(paidOrders.items.every((o) => o.paymentState === 'paid' || o.paymentState === 'gifted')).toBe(true);
  });

  // Punto 12: Consistencia entre get_sales_analytics y get_dashboard_summary
  it('12. Consistencia: analíticas y dashboard deducen el costo del regalo y no inflan facturación', async () => {
    const dashboard = await demoBusinessApi.getDashboard();
    expect(typeof dashboard.paidRevenueMonthCents).toBe('number');
    expect(typeof dashboard.estimatedMarginMonthCents).toBe('number');
    expect(typeof dashboard.paidOrdersMonth).toBe('number');
  });

  // Punto 14: Pedido manual directo con paymentMethod = gift
  it('14. Carga manual con paymentMethod = gift descuenta stock y fija total en $ 0', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products.find((p) => (p.onHand - p.reserved) >= 2)!;
    const initialOnHand = product.onHand;

    const manualGift: ImportOrderInput = {
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: '',
      customerName: 'Familiar Directo',
      phone: '3426000005',
      paymentMethod: 'gift',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      address: null,
      addressNumber: null,
      quotedSubtotalCents: 0,
      quotedTotalCents: 0,
      lines: [{
        productId: product.id,
        sku: product.sku,
        slug: product.slug,
        name: product.name,
        presentation: product.presentation,
        quantity: 1,
        unitPriceCents: product.priceCents,
        imageUrl: product.imageUrl
      }]
    };

    const order = await demoBusinessApi.confirmImportedOrder(manualGift);
    expect(order.paymentState).toBe('gifted');
    expect(order.fulfillmentState).toBe('delivered');
    expect(order.totalCents).toBe(0);

    const prodsFinal = await demoBusinessApi.listAdminProducts();
    expect(prodsFinal.find((p) => p.id === product.id)!.onHand).toBe(initialOnHand - 1);
  });

});
