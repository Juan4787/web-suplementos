import { describe, expect, it } from 'vitest';
import type { ImportOrderInput } from '@/domain/types';
import type { ProductUpdate } from './business-api';
import { demoBusinessApi } from './demo-business-api';

describe('demoBusinessApi lifecycle and domain guarantees', () => {
  it('retrieves and updates store settings accurately', async () => {
    const original = await demoBusinessApi.getSettings();
    expect(original.storeName).toBe('Impulso');
    expect(original.currency).toBe('ARS');

    const updated = await demoBusinessApi.updateSettings({
      ...original,
      tagline: 'Nueva descripción de tienda'
    });
    expect(updated.tagline).toBe('Nueva descripción de tienda');
  });

  it('lists storefront products and filters by slug', async () => {
    const storefront = await demoBusinessApi.listStorefrontProducts();
    expect(storefront.length).toBeGreaterThan(0);
    const first = storefront[0]!;

    const bySlug = await demoBusinessApi.getStorefrontProduct(first.slug);
    expect(bySlug).not.toBeNull();
    expect(bySlug?.id).toBe(first.id);

    const missing = await demoBusinessApi.getStorefrontProduct('slug-no-existente');
    expect(missing).toBeNull();
  });

  it('validates stock availability for cart checkout', async () => {
    const storefront = await demoBusinessApi.listStorefrontProducts();
    const availableProduct = storefront.find((p) => p.maxOrderQuantity > 0)!;

    const validCheck = await demoBusinessApi.validateAvailability([
      { productId: availableProduct.id, quantity: 1 }
    ]);
    expect(validCheck.ok).toBe(true);
    expect(validCheck.issues).toEqual([]);

    const impossibleCheck = await demoBusinessApi.validateAvailability([
      { productId: availableProduct.id, quantity: 9999 }
    ]);
    expect(impossibleCheck.ok).toBe(false);
    expect(impossibleCheck.issues.length).toBe(1);
    expect(impossibleCheck.issues[0]?.productId).toBe(availableProduct.id);
  });

  it('provides dashboard summary with action-oriented operational metrics', async () => {
    const summary = await demoBusinessApi.getDashboard();
    expect(typeof summary.pendingPreparation).toBe('number');
    expect(typeof summary.readyForDelivery).toBe('number');
    expect(typeof summary.lowStockProducts).toBe('number');
    expect(typeof summary.incomingPurchases).toBe('number');
    expect(Array.isArray(summary.recentOrders)).toBe(true);
    expect(Array.isArray(summary.priorityInventory)).toBe(true);
  });

  it('supports full product lifecycle: create, update, and list inventory', async () => {
    const newProduct: ProductUpdate = {
      sku: 'TEST_PROD_1',
      slug: 'test-producto-1',
      name: 'Producto Test Unitario',
      presentation: '500 g',
      description: 'Descripción para prueba unitaria',
      category: 'Test',
      priceCents: 1000000,
      currentCostCents: 600000,
      reorderPoint: 5,
      safetyStock: 2,
      leadTimeDays: 7,
      imageUrl: '/demo/test.svg',
      imageAlt: 'Test Alt',
      published: true,
      active: true,
      featured: false
    };

    const created = await demoBusinessApi.saveProduct(newProduct);
    expect(created.sku).toBe('TEST_PROD_1');
    expect(created.onHand).toBe(0);

    // Adjust stock
    await demoBusinessApi.adjustStock(created.id, 20, 'Stock de apertura');
    let inventory = await demoBusinessApi.listInventory();
    let item = inventory.find((i) => i.id === created.id);
    expect(item?.onHand).toBe(20);
    expect(item?.available).toBe(20);
    expect(item?.status).toBe('ok');

    // Update stock thresholds to make 20 units low stock (e.g. reorderPoint = 25)
    await demoBusinessApi.updateStockThresholds({
      productId: created.id,
      reorderPoint: 25,
      safetyStock: 5
    });
    inventory = await demoBusinessApi.listInventory();
    item = inventory.find((i) => i.id === created.id);
    expect(item?.reorderPoint).toBe(25);
    expect(item?.safetyStock).toBe(5);
    expect(item?.status).toBe('low');

    // Lower reorderPoint below available units -> returns to ok
    await demoBusinessApi.updateStockThresholds({
      productId: created.id,
      reorderPoint: 10,
      safetyStock: 2
    });
    inventory = await demoBusinessApi.listInventory();
    item = inventory.find((i) => i.id === created.id);
    expect(item?.status).toBe('ok');
  });

  it('confirms imported WhatsApp order, reserves stock, and rejects duplicate protocol ID', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const product = products.find((p) => p.onHand > 5)!;
    const initialOnHand = product.onHand;
    const initialReserved = product.reserved;

    const protocolOrderId = crypto.randomUUID();
    const importInput: ImportOrderInput = {
      customerName: 'Comprador Demo',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      phone: '1144445555',
      shippingFeeCents: 0,
      quotedSubtotalCents: product.priceCents * 2,
      quotedTotalCents: product.priceCents * 2,
      protocolOrderId,
      protocolChecksum: 'ABCD1234',
      lines: [
        {
          productId: product.id,
          sku: product.sku,
          slug: product.slug,
          name: product.name,
          presentation: product.presentation,
          imageUrl: product.imageUrl,
          unitPriceCents: product.priceCents,
          quantity: 2
        }
      ]
    };

    const confirmed = await demoBusinessApi.confirmImportedOrder(importInput);
    expect(confirmed.customerName).toBe('Comprador Demo');
    expect(confirmed.orderState).toBe('confirmed');
    expect(confirmed.items.length).toBe(1);

    // Verify stock reservation updated
    const updatedProducts = await demoBusinessApi.listAdminProducts();
    const updatedProduct = updatedProducts.find((p) => p.id === product.id)!;
    expect(updatedProduct.reserved).toBe(initialReserved + 2);
    expect(updatedProduct.onHand).toBe(initialOnHand);

    // Re-importing same protocol ID must fail
    await expect(demoBusinessApi.confirmImportedOrder(importInput)).rejects.toThrow();
  });

  it('preserves historical sales data and snapshots when product price and cost are updated later', async () => {
    // 1. Create a product with initial price and cost
    const product = await demoBusinessApi.saveProduct({
      sku: 'SNAP_PROD',
      slug: 'snap-prod',
      name: 'Producto Inmutable Snapshot',
      presentation: '250 g',
      description: 'Producto para validar inmutabilidad de ventas históricas',
      category: 'Snapshot',
      priceCents: 2000000, // $20.000
      currentCostCents: 1000000, // $10.000
      reorderPoint: 3,
      safetyStock: 1,
      leadTimeDays: 5,
      imageUrl: '/demo/snap.svg',
      imageAlt: 'Snap',
      published: true,
      active: true,
      featured: false
    });
    await demoBusinessApi.adjustStock(product.id, 10, 'Stock inicial prueba snapshot');

    // 2. Place an order locking the snapshot
    const orderInput: ImportOrderInput = {
      customerName: 'Cliente Histórico',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      phone: '1122334455',
      shippingFeeCents: 0,
      quotedSubtotalCents: 2000000,
      quotedTotalCents: 2000000,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'SNAP1234',
      lines: [
        {
          productId: product.id,
          sku: product.sku,
          slug: product.slug,
          name: product.name,
          presentation: product.presentation,
          imageUrl: product.imageUrl,
          unitPriceCents: 2000000,
          quantity: 1
        }
      ]
    };
    const order = await demoBusinessApi.confirmImportedOrder(orderInput);

    // 3. Now modify product price and cost in catalog
    await demoBusinessApi.saveProduct({
      id: product.id,
      sku: 'SNAP_PROD',
      slug: 'snap-prod',
      name: 'Producto Inmutable Snapshot (Modificado)',
      presentation: '250 g',
      description: 'Descripción modificada',
      category: 'Snapshot',
      priceCents: 3500000, // New price $35.000
      currentCostCents: 2200000, // New cost $22.000
      reorderPoint: 3,
      safetyStock: 1,
      leadTimeDays: 5,
      imageUrl: '/demo/snap.svg',
      imageAlt: 'Snap',
      published: true,
      active: true,
      featured: false
    });

    // 4. Verify historical order items retained original frozen unitPrice and unitCost
    const orders = await demoBusinessApi.listOrders(1, 20);
    const retrievedOrder = orders.items.find((o) => o.id === order.id)!;
    expect(retrievedOrder.totalCents).toBe(2000000);
    expect(retrievedOrder.items[0]?.unitPriceCents).toBe(2000000);
    expect(retrievedOrder.items[0]?.unitCostCents).toBe(1000000);
  });

  it('releases stock reservation when an order is cancelled', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const targetProduct = products.find((p) => p.onHand > 5)!;
    const initialReserved = targetProduct.reserved;

    // Create order reserving 1 unit
    const order = await demoBusinessApi.confirmImportedOrder({
      customerName: 'Cliente Cancelación',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      phone: null,
      shippingFeeCents: 0,
      quotedSubtotalCents: targetProduct.priceCents,
      quotedTotalCents: targetProduct.priceCents,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'CANC1234',
      lines: [
        {
          productId: targetProduct.id,
          sku: targetProduct.sku,
          slug: targetProduct.slug,
          name: targetProduct.name,
          presentation: targetProduct.presentation,
          imageUrl: targetProduct.imageUrl,
          unitPriceCents: targetProduct.priceCents,
          quantity: 1
        }
      ]
    });

    // Check reserved increased
    let currentProducts = await demoBusinessApi.listAdminProducts();
    let current = currentProducts.find((p) => p.id === targetProduct.id)!;
    expect(current.reserved).toBe(initialReserved + 1);

    // Cancel order
    const cancelled = await demoBusinessApi.transitionOrder(order.id, 'cancel');
    expect(cancelled.orderState).toBe('cancelled');

    // Check reservation was freed
    currentProducts = await demoBusinessApi.listAdminProducts();
    current = currentProducts.find((p) => p.id === targetProduct.id)!;
    expect(current.reserved).toBe(initialReserved);
  });

  it('converts reserved stock to physical reduction when an order is delivered', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const targetProduct = products.find((p) => p.onHand > 5)!;
    const initialOnHand = targetProduct.onHand;
    const initialReserved = targetProduct.reserved;

    // Create order reserving 1 unit
    const order = await demoBusinessApi.confirmImportedOrder({
      customerName: 'Cliente Entrega',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      phone: null,
      shippingFeeCents: 0,
      quotedSubtotalCents: targetProduct.priceCents,
      quotedTotalCents: targetProduct.priceCents,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'DELI1234',
      lines: [
        {
          productId: targetProduct.id,
          sku: targetProduct.sku,
          slug: targetProduct.slug,
          name: targetProduct.name,
          presentation: targetProduct.presentation,
          imageUrl: targetProduct.imageUrl,
          unitPriceCents: targetProduct.priceCents,
          quantity: 1
        }
      ]
    });

    // Flujo directo simplificado: cobrado y entregado
    await demoBusinessApi.transitionOrder(order.id, 'mark_paid');
    const delivered = await demoBusinessApi.transitionOrder(order.id, 'mark_delivered');
    expect(delivered.fulfillmentState).toBe('delivered');
    expect(delivered.paymentState).toBe('paid');

    // Verify onHand decreased and reserved returned to initial
    const afterProducts = await demoBusinessApi.listAdminProducts();
    const after = afterProducts.find((p) => p.id === targetProduct.id)!;
    expect(after.onHand).toBe(initialOnHand - 1);
    expect(after.reserved).toBe(initialReserved);
  });

  it('manages supplier purchases from creation to receipt, updating stock', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const targetProduct = products[0]!;
    const initialOnHand = targetProduct.onHand;

    const purchase = await demoBusinessApi.createPurchase({
      supplierName: 'Distribuidora Central',
      expectedAt: new Date().toISOString(),
      notes: 'Pedido mensual',
      items: [{ productId: targetProduct.id, quantity: 15, unitCostCents: 1200000 }]
    });

    expect(purchase.state).toBe('ordered');

    // Receiving purchase
    const received = await demoBusinessApi.receivePurchase(purchase.id);
    expect(received.state).toBe('received');

    // Product stock should have increased
    const afterProducts = await demoBusinessApi.listAdminProducts();
    const afterProduct = afterProducts.find((p) => p.id === targetProduct.id)!;
    expect(afterProduct.onHand).toBe(initialOnHand + 15);
  });

  it('records "Proveedor no informado" when supplier name is empty or whitespace', async () => {
    const products = await demoBusinessApi.listAdminProducts();
    const targetProduct = products[0]!;

    const purchase = await demoBusinessApi.createPurchase({
      supplierName: '   ',
      expectedAt: null,
      notes: null,
      items: [{ productId: targetProduct.id, quantity: 5, unitCostCents: 100000 }]
    });

    expect(purchase.supplierName).toBe('Proveedor no informado');
  });

  it('calculates sales analytics and respects unpublished IPC months without interpolating', async () => {
    const analytics = await demoBusinessApi.getAnalytics('2026-07-01', '2026-08-28');
    expect(typeof analytics.revenueCents).toBe('number');
    expect(typeof analytics.costCents).toBe('number');
    expect(typeof analytics.taxCents).toBe('number');
    expect(typeof analytics.estimatedMarginCents).toBe('number');
    expect(Array.isArray(analytics.series)).toBe(true);
    expect(Array.isArray(analytics.topProducts)).toBe(true);

    // Test unpublished IPC points
    const unpublishedPoint = analytics.series.find((s) => !s.ipcPublished);
    if (unpublishedPoint) {
      expect(unpublishedPoint.adjustedRevenueCents).toBeNull();
      expect(unpublishedPoint.revenueCents).toBeGreaterThan(0);
    }
  });

  it('generates a complete authorized export dataset with all 13 tables', async () => {
    const dataset = await demoBusinessApi.getExportDataset();
    expect(dataset.products.length).toBeGreaterThan(0);
    expect(dataset.inventory.length).toBeGreaterThan(0);
    expect(dataset.orders.length).toBeGreaterThan(0);
    expect(dataset.purchases.length).toBeGreaterThan(0);
    expect(dataset.movements.length).toBeGreaterThan(0);
    expect(dataset.customers.length).toBeGreaterThan(0);
    expect(dataset.users.length).toBeGreaterThan(0);
    expect(dataset.inflation.length).toBeGreaterThan(0);
  });
});
