import { formatISO, startOfMonth } from 'date-fns';
import {
  demoCustomers,
  demoInflation,
  demoMovements,
  demoOrders,
  demoProducts,
  demoPurchases,
  demoSettings,
  demoOwner,
  demoStaff,
  toDemoInventory
} from '@/data/demo-data';
import { AppError } from '@/domain/errors';
import { availabilityFromQuantity } from '@/domain/inventory';
import { calculateBasisPoints } from '@/domain/money';
import { availableOrderActions } from '@/domain/order-actions';
import type {
  AdminProduct,
  AnalyticsSummary,
  Customer,
  ExportDataset,
  InflationIndex,
  Order,
  ProductPerformance,
  Purchase,
  StockMovement,
  StoreSettings
} from '@/domain/types';
import type {
  BusinessApi,
  Page,
  ProductUpdate,
  PurchaseCreateInput
} from './business-api';

const state: {
  settings: StoreSettings;
  products: AdminProduct[];
  orders: Order[];
  purchases: Purchase[];
  movements: StockMovement[];
  customers: Customer[];
  users: Array<import('@/domain/types').AppUser>;
  inflation: InflationIndex[];
  importedProtocolIds: Set<string>;
  revision: number;
} = {
  settings: structuredClone(demoSettings),
  products: structuredClone(demoProducts),
  orders: structuredClone(demoOrders),
  purchases: structuredClone(demoPurchases),
  movements: structuredClone(demoMovements),
  customers: structuredClone(demoCustomers),
  users: structuredClone([demoOwner, demoStaff]),
  inflation: structuredClone(demoInflation),
  importedProtocolIds: new Set(),
  revision: 1
};

const latency = async <T>(value: T, milliseconds = 120): Promise<T> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return structuredClone(value);
};

const paginate = <T>(items: T[], page: number, pageSize: number): Page<T> => ({
  items: structuredClone(items.slice((page - 1) * pageSize, page * pageSize)),
  page,
  pageSize,
  total: items.length
});

const refreshProductAvailability = (product: AdminProduct): void => {
  const available = product.onHand - product.reserved;
  product.availability = availabilityFromQuantity(available, product.reorderPoint);
  product.maxOrderQuantity = Math.max(0, Math.min(20, available));
  product.updatedAt = new Date().toISOString();
};

const nextUuid = (): string => crypto.randomUUID();

const paidOrdersInRange = (from: string, to: string): Order[] => {
  const fromTime = new Date(`${from}T00:00:00-03:00`).getTime();
  const toTime = new Date(`${to}T23:59:59.999-03:00`).getTime();
  return state.orders.filter((order) => {
    const paidTime = order.paidAt ? new Date(order.paidAt).getTime() : Number.NaN;
    return order.paymentState === 'paid' && paidTime >= fromTime && paidTime <= toTime;
  });
};

const comparisonCutoffDay = (from: string, to: string): number | null => {
  const fromDate = new Date(`${from}T12:00:00-03:00`);
  const toDate = new Date(`${to}T12:00:00-03:00`);
  const monthChanged = fromDate.getFullYear() !== toDate.getFullYear() || fromDate.getMonth() !== toDate.getMonth();
  const toIsMonthEnd = toDate.getDate() === new Date(toDate.getFullYear(), toDate.getMonth() + 1, 0).getDate();
  return monthChanged && fromDate.getDate() === 1 && !toIsMonthEnd ? toDate.getDate() : null;
};

const buildProductPerformance = (orders: Order[]): ProductPerformance[] => {
  const products = new Map<string, ProductPerformance>();
  for (const order of orders) {
    for (const item of order.items) {
      const current = products.get(item.productId) ?? {
        productId: item.productId,
        name: item.productName,
        units: 0,
        revenueCents: 0,
        estimatedMarginCents: 0
      };
      current.units += item.quantity;
      current.revenueCents += item.subtotalCents;
      current.estimatedMarginCents +=
        item.subtotalCents - (item.unitCostCents ?? 0) * item.quantity;
      products.set(item.productId, current);
    }
  }
  return [...products.values()].sort((left, right) => right.units - left.units);
};

export const demoBusinessApi: BusinessApi = {
  async getSettings() {
    return latency(state.settings);
  },

  async updateSettings(settings) {
    state.settings = structuredClone(settings);
    state.revision += 1;
    return latency(state.settings);
  },

  async listStorefrontProducts() {
    return latency(
      state.products
        .filter((product) => product.active && product.published)
        .map(({ active: _active, published: _published, ...product }) => product)
    );
  },

  async getStorefrontProduct(slug) {
    const found = state.products.find(
      (product) => product.slug === slug && product.active && product.published
    );
    if (!found) return latency(null);
    const { active: _active, published: _published, ...product } = found;
    return latency(product);
  },

  async validateAvailability(lines) {
    const issues = lines.flatMap((line) => {
      const product = state.products.find((candidate) => candidate.id === line.productId);
      const available = product ? Math.max(0, product.onHand - product.reserved) : 0;
      return !product || !product.active || line.quantity > available
        ? [
            {
              productId: line.productId,
              productName: product?.name ?? 'Producto no disponible',
              requested: line.quantity,
              available
            }
          ]
        : [];
    });
    return latency({ ok: issues.length === 0, issues });
  },

  async getDashboard() {
    const inventory = toDemoInventory(state.products);
    const currentMonth = startOfMonth(new Date('2026-08-28T15:30:00-03:00'));
    const paidThisMonth = state.orders.filter(
      (order) => order.paidAt && new Date(order.paidAt) >= currentMonth
    );
    const revenue = paidThisMonth.reduce((sum, order) => sum + order.totalCents, 0);
    const costs = paidThisMonth.reduce((sum, order) => sum + (order.costTotalCents ?? 0), 0);
    const taxes = paidThisMonth.reduce((sum, order) => sum + (order.taxAmountCents ?? 0), 0);
    return latency({
      pendingPreparation: state.orders.filter(
        (order) => order.orderState === 'confirmed' && order.preparationState !== 'ready'
      ).length,
      readyForDelivery: state.orders.filter(
        (order) => order.preparationState === 'ready' && order.fulfillmentState === 'pending'
      ).length,
      lowStockProducts: inventory.filter((item) => item.status !== 'ok').length,
      incomingPurchases: state.purchases.filter((purchase) => purchase.state === 'ordered').length,
      paidRevenueMonthCents: revenue,
      paidOrdersMonth: paidThisMonth.length,
      estimatedMarginMonthCents: revenue - costs - taxes,
      recentOrders: state.orders
        .filter((order) => {
          if (order.orderState === 'cancelled') return false;
          const isCompleted =
            order.fulfillmentState === 'delivered' && order.paymentState === 'paid';
          const isNormalShipped =
            order.fulfillmentState === 'shipped' && order.paymentState === 'paid';
          if (isCompleted || isNormalShipped) return false;
          return (
            order.preparationState !== 'ready' ||
            order.paymentState === 'pending' ||
            order.fulfillmentState === 'pending'
          );
        })
        .slice(0, 6),
      priorityInventory: inventory
        .filter((item) => item.status !== 'ok' && item.suggestedPurchase > 0)
        .sort((left, right) => left.available - right.available)
        .slice(0, 4)
    });
  },

  async listAdminProducts() {
    return latency(state.products);
  },

  async saveProduct(input: ProductUpdate) {
    const existing = input.id
      ? state.products.find((candidate) => candidate.id === input.id)
      : undefined;
    const duplicate = state.products.find(
      (candidate) =>
        candidate.id !== input.id && (candidate.sku === input.sku || candidate.slug === input.slug)
    );
    if (duplicate) {
      throw new AppError('business', 'Ya existe un producto con ese SKU o enlace.', {
        nextAction: 'Usá un SKU y un enlace diferentes.'
      });
    }
    if (existing) {
      Object.assign(existing, input, { updatedAt: new Date().toISOString() });
      refreshProductAvailability(existing);
      state.revision += 1;
      return latency(existing);
    }
    const created: AdminProduct = {
      ...input,
      id: nextUuid(),
      onHand: 0,
      reserved: 0,
      incoming: 0,
      availability: 'out_of_stock',
      maxOrderQuantity: 0,
      updatedAt: new Date().toISOString()
    };
    state.products.unshift(created);
    state.revision += 1;
    return latency(created);
  },

  async listInventory() {
    return latency(toDemoInventory(state.products));
  },

  async adjustStock(productId, delta, reason) {
    const product = state.products.find((candidate) => candidate.id === productId);
    if (!product) throw new AppError('business', 'No encontramos el producto que querías ajustar.');
    if (!Number.isSafeInteger(delta) || delta === 0 || !reason.trim()) {
      throw new AppError('validation', 'Ingresá una cantidad y un motivo para el ajuste.');
    }
    product.onHand += delta;
    refreshProductAvailability(product);
    state.movements.unshift({
      id: nextUuid(),
      productId: product.id,
      productName: product.name,
      kind: 'adjustment',
      physicalDelta: delta,
      reservedDelta: 0,
      reason: reason.trim(),
      orderId: null,
      purchaseId: null,
      createdAt: new Date().toISOString(),
      createdByName: 'Sofía'
    });
    state.revision += 1;
    await latency(undefined);
  },

  async listOrders(page = 1, pageSize = 20) {
    return latency(paginate(state.orders, page, pageSize));
  },

  async listPaidOrders(page = 1, pageSize = 20) {
    return latency(paginate(state.orders.filter((order) => order.paymentState === 'paid'), page, pageSize));
  },

  async confirmImportedOrder(input) {
    if (state.importedProtocolIds.has(input.protocolOrderId)) {
      throw new AppError('business', 'Este pedido ya fue importado.', {
        nextAction: 'Buscalo en Pedidos antes de volver a cargarlo.'
      });
    }
    const availability = await this.validateAvailability(input.lines);
    if (!availability.ok) {
      throw new AppError('business', 'El stock cambió y el pedido necesita una revisión.', {
        nextAction: 'Ajustá las cantidades disponibles antes de confirmarlo.'
      });
    }
    const items = input.lines.map((line) => {
      const product = state.products.find((candidate) => candidate.id === line.productId)!;
      return {
        id: nextUuid(),
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        presentation: product.presentation,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        unitCostCents: product.currentCostCents,
        subtotalCents: line.unitPriceCents * line.quantity
      };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.subtotalCents, 0);
    if (subtotalCents !== input.quotedSubtotalCents) {
      throw new AppError('business', 'Los precios revisados ya no coinciden con el mensaje.', {
        nextAction: 'Volvé a revisar los productos y confirmá el total correcto.'
      });
    }
    const now = new Date().toISOString();
    const number = Math.max(...state.orders.map((order) => order.number), 1000) + 1;
    const costTotalCents = items.reduce(
      (sum, item) => sum + (item.unitCostCents ?? 0) * item.quantity,
      0
    );
    const order: Order = {
      id: nextUuid(),
      number,
      customerId: nextUuid(),
      customerName: input.customerName,
      customerPhone: input.phone,
      paymentMethod: input.paymentMethod,
      deliveryMethod: input.deliveryMethod,
      shippingType: input.shippingType,
      shippingAddress:
        input.deliveryMethod === 'shipping'
          ? `${input.address ?? ''}${input.addressNumber ? ` ${input.addressNumber}` : ''}`.trim()
          : null,
      orderState: 'confirmed',
      paymentState: 'pending',
      preparationState: 'pending',
      fulfillmentState: 'pending',
      subtotalCents,
      shippingFeeCents: input.shippingFeeCents,
      totalCents: subtotalCents + input.shippingFeeCents,
      taxRateBasisPoints: state.settings.taxRateBasisPoints,
      taxAmountCents: calculateBasisPoints(
        subtotalCents + input.shippingFeeCents,
        state.settings.taxRateBasisPoints
      ),
      costTotalCents,
      createdAt: now,
      confirmedAt: now,
      paidAt: null,
      fulfilledAt: null,
      items
    };
    for (const item of items) {
      const product = state.products.find((candidate) => candidate.id === item.productId)!;
      product.reserved += item.quantity;
      refreshProductAvailability(product);
      state.movements.unshift({
        id: nextUuid(),
        productId: product.id,
        productName: product.name,
        kind: 'reservation',
        physicalDelta: 0,
        reservedDelta: item.quantity,
        reason: `Pedido #${number} confirmado`,
        orderId: order.id,
        purchaseId: null,
        createdAt: now,
        createdByName: demoStaff.displayName
      });
    }
    state.orders.unshift(order);
    state.importedProtocolIds.add(input.protocolOrderId);
    state.customers.unshift({
      id: order.customerId!,
      name: order.customerName,
      phone: order.customerPhone,
      firstOrderAt: now,
      lastOrderAt: now,
      orderCount: 1,
      totalPaidCents: 0
    });
    state.revision += 1;
    return latency(order);
  },

  async transitionOrder(orderId, action) {
    const order = state.orders.find((candidate) => candidate.id === orderId);
    if (!order) throw new AppError('business', 'No encontramos el pedido.');
    if (!availableOrderActions(order).includes(action)) {
      throw new AppError('business', 'Ese paso ya no está disponible para el pedido.', {
        nextAction: 'Actualizá la lista para ver su estado actual.'
      });
    }
    const now = new Date().toISOString();
    if (action === 'mark_paid') {
      order.paymentState = 'paid';
      order.paidAt = now;
      const customer = state.customers.find((candidate) => candidate.id === order.customerId);
      if (customer) customer.totalPaidCents = (customer.totalPaidCents ?? 0) + order.totalCents;
    }
    if (action === 'mark_refunded') {
      order.paymentState = 'refunded';
      const customer = state.customers.find((candidate) => candidate.id === order.customerId);
      if (customer && customer.totalPaidCents !== null) {
        customer.totalPaidCents = Math.max(0, customer.totalPaidCents - order.totalCents);
      }
    }
    if (action === 'start_preparing') order.preparationState = 'preparing';
    if (action === 'mark_ready') order.preparationState = 'ready';
    if (action === 'mark_shipped' || action === 'mark_delivered') {
      const inventoryLeaves =
        action === 'mark_shipped' ||
        (action === 'mark_delivered' && order.fulfillmentState !== 'shipped');
      if (inventoryLeaves) {
        for (const item of order.items) {
          const product = state.products.find((candidate) => candidate.id === item.productId)!;
          product.onHand -= item.quantity;
          product.reserved -= item.quantity;
          refreshProductAvailability(product);
          state.movements.unshift({
            id: nextUuid(),
            productId: product.id,
            productName: product.name,
            kind: 'sale',
            physicalDelta: -item.quantity,
            reservedDelta: -item.quantity,
            reason: `Pedido #${order.number} ${action === 'mark_shipped' ? 'enviado' : 'entregado'}`,
            orderId: order.id,
            purchaseId: null,
            createdAt: now,
            createdByName: demoStaff.displayName
          });
        }
      }
      order.fulfillmentState = action === 'mark_shipped' ? 'shipped' : 'delivered';
      if (action === 'mark_delivered') order.fulfilledAt = now;
    }
    if (action === 'cancel') {
      order.orderState = 'cancelled';
      order.fulfillmentState = 'cancelled';
      for (const item of order.items) {
        const product = state.products.find((candidate) => candidate.id === item.productId)!;
        product.reserved -= item.quantity;
        refreshProductAvailability(product);
        state.movements.unshift({
          id: nextUuid(),
          productId: product.id,
          productName: product.name,
          kind: 'reservation_release',
          physicalDelta: 0,
          reservedDelta: -item.quantity,
          reason: `Pedido #${order.number} cancelado`,
          orderId: order.id,
          purchaseId: null,
          createdAt: now,
          createdByName: demoStaff.displayName
        });
      }
    }
    state.revision += 1;
    return latency(order);
  },

  async listPurchases(page = 1, pageSize = 20) {
    return latency(paginate(state.purchases, page, pageSize));
  },

  async createPurchase(input: PurchaseCreateInput) {
    const items = input.items.map((item) => {
      const product = state.products.find((candidate) => candidate.id === item.productId);
      if (!product) throw new AppError('business', 'Uno de los productos ya no está disponible.');
      return {
        id: nextUuid(),
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        unitCostCents: item.unitCostCents
      };
    });
    const now = new Date().toISOString();
    const purchase: Purchase = {
      id: nextUuid(),
      number: Math.max(...state.purchases.map((entry) => entry.number), 0) + 1,
      supplierName: input.supplierName,
      state: 'ordered',
      orderedAt: now,
      expectedAt: input.expectedAt,
      receivedAt: null,
      totalCostCents: items.reduce(
        (sum, item) => sum + item.quantity * item.unitCostCents,
        0
      ),
      notes: input.notes,
      items
    };
    for (const item of items) {
      const product = state.products.find((candidate) => candidate.id === item.productId)!;
      product.incoming += item.quantity;
      refreshProductAvailability(product);
    }
    state.purchases.unshift(purchase);
    state.revision += 1;
    return latency(purchase);
  },

  async receivePurchase(purchaseId) {
    const purchase = state.purchases.find((candidate) => candidate.id === purchaseId);
    if (!purchase) throw new AppError('business', 'No encontramos la compra.');
    if (purchase.state !== 'ordered') {
      throw new AppError('business', 'Esta compra ya no está esperando recepción.');
    }
    const now = new Date().toISOString();
    purchase.state = 'received';
    purchase.receivedAt = now;
    for (const item of purchase.items) {
      const product = state.products.find((candidate) => candidate.id === item.productId)!;
      product.incoming -= item.quantity;
      product.onHand += item.quantity;
      product.currentCostCents = item.unitCostCents;
      refreshProductAvailability(product);
      state.movements.unshift({
        id: nextUuid(),
        productId: product.id,
        productName: product.name,
        kind: 'purchase_received',
        physicalDelta: item.quantity,
        reservedDelta: 0,
        reason: `Compra #${purchase.number} recibida`,
        orderId: null,
        purchaseId: purchase.id,
        createdAt: now,
        createdByName: 'Sofía'
      });
    }
    state.revision += 1;
    return latency(purchase);
  },

  async listMovements(page = 1, pageSize = 30) {
    return latency(paginate(state.movements, page, pageSize));
  },

  async listCustomers(page = 1, pageSize = 30) {
    return latency(paginate(state.customers, page, pageSize));
  },

  async getAnalytics(from, to) {
    const cutoffDay = comparisonCutoffDay(from, to);
    const orders = paidOrdersInRange(from, to).filter(
      (order) => cutoffDay === null || new Date(order.paidAt ?? order.createdAt).getDate() <= cutoffDay
    );
    const revenueCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
    const costCents = orders.reduce((sum, order) => sum + (order.costTotalCents ?? 0), 0);
    const taxCents = orders.reduce((sum, order) => sum + (order.taxAmountCents ?? 0), 0);
    const units = orders.flatMap((order) => order.items).reduce((sum, item) => sum + item.quantity, 0);
    const byMonth = new Map<string, Order[]>();
    for (const order of orders) {
      const key = order.paidAt?.slice(0, 7) ?? order.createdAt.slice(0, 7);
      byMonth.set(key, [...(byMonth.get(key) ?? []), order]);
    }
    const series = [...byMonth.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([period, periodOrders]) => {
        const periodRevenue = periodOrders.reduce((sum, order) => sum + order.totalCents, 0);
        const isCurrentPending = period === '2026-08';
        return {
          period,
          revenueCents: periodRevenue,
          adjustedRevenueCents: isCurrentPending ? null : Math.round(periodRevenue * 0.981),
          orderCount: periodOrders.length,
          units: periodOrders
            .flatMap((order) => order.items)
            .reduce((sum, item) => sum + item.quantity, 0),
          ipcPublished: !isCurrentPending
        };
      });
    const result: AnalyticsSummary = {
      from,
      to,
      comparisonCutoffDay: cutoffDay,
      revenueCents,
      costCents,
      taxCents,
      estimatedMarginCents: revenueCents - costCents - taxCents,
      averageTicketCents: orders.length ? Math.round(revenueCents / orders.length) : 0,
      orders: orders.length,
      units,
      series,
      topProducts: buildProductPerformance(orders)
    };
    return latency(result, 180);
  },

  async getExportDataset() {
    const revision = state.revision;
    const generatedAt = new Date().toISOString();
    const dataset: ExportDataset = {
      generatedAt,
      revision,
      settings: state.settings,
      products: state.products.map((product) => ({ ...product, createdAt: product.updatedAt })),
      inventory: toDemoInventory(state.products),
      orders: state.orders.map((order, index) => ({
        ...order,
        source: 'whatsapp_import',
        protocolOrderId: order.id,
        protocolChecksum: index.toString(16).toUpperCase().padStart(8, '0'),
        refundedAt: order.paymentState === 'refunded' ? order.createdAt : null,
        shippedAt: order.fulfillmentState === 'shipped' ? order.fulfilledAt ?? order.createdAt : null,
        cancelledAt: order.orderState === 'cancelled' ? order.fulfilledAt ?? order.createdAt : null
      })),
      purchases: state.purchases.map((purchase) => ({
        ...purchase,
        createdAt: purchase.orderedAt ?? generatedAt
      })),
      movements: state.movements,
      customers: state.customers.map((customer) => ({
        ...customer,
        createdAt: customer.firstOrderAt
      })),
      inflation: state.inflation,
      reservations: state.orders.flatMap((order) => order.items.map((item) => ({
        id: item.id.replace(/^21/u, '60'),
        orderId: order.id,
        productId: item.productId,
        quantity: item.quantity,
        state: order.fulfillmentState === 'pending'
          ? 'active' as const
          : order.fulfillmentState === 'cancelled'
            ? 'released' as const
            : 'consumed' as const,
        createdAt: order.confirmedAt,
        resolvedAt: order.fulfillmentState === 'pending' ? null : order.fulfilledAt ?? order.createdAt
      }))),
      users: state.users.map((user) => ({ ...user, createdAt: generatedAt, updatedAt: generatedAt }))
    };
    const result = await latency(dataset, 250);
    if (revision !== state.revision) {
      throw new AppError('temporary', 'Los datos cambiaron mientras preparábamos el respaldo.', {
        retryable: true,
        nextAction: 'Volvé a preparar la exportación para incluir todo en un mismo corte.'
      });
    }
    return result;
  },

  async listInflationIndices() {
    return latency([...state.inflation].sort((left, right) => right.period.localeCompare(left.period)));
  },

  async saveInflationIndex(input) {
    const existing = state.inflation.find((entry) => entry.period === input.period);
    if (existing) Object.assign(existing, input);
    else state.inflation.push(structuredClone(input));
    state.revision += 1;
    return latency(existing ?? input);
  },

  async listUsers() {
    return latency(state.users);
  },

  async updateUserAccess(userId, role, active) {
    const user = state.users.find((candidate) => candidate.id === userId);
    if (!user) throw new AppError('business', 'No encontramos a esa persona.');
    if (user.id === demoOwner.id && (role !== 'owner' || !active)) {
      throw new AppError('business', 'No podés cambiar tu propio acceso.', {
        nextAction: 'Pedile a otra dueña activa que realice ese cambio.'
      });
    }
    user.role = role;
    user.active = active;
    state.revision += 1;
    return latency(user);
  },

  async askBusinessAi(message) {
    const inventory = toDemoInventory(state.products);
    const urgent = inventory
      .filter((item) => item.status !== 'ok')
      .sort((left, right) => left.available - right.available)[0];
    const answer = urgent
      ? `En la demo priorizaría ${urgent.name}. Tiene ${urgent.available} unidades disponibles, ${urgent.incoming} en camino y una cobertura estimada de ${urgent.coverageDays ?? '—'} días. La cantidad sugerida de compra es ${urgent.suggestedPurchase}. Esta respuesta usa datos agregados de inventario; no modificó ningún registro.`
      : `No veo productos por debajo del punto de pedido en los datos de demostración. Para la pregunta “${message.slice(0, 80)}”, revisé el estado agregado del inventario sin modificar datos.`;
    return latency(
      {
        answer,
        model: 'demo-local (sin proveedor externo)',
        usedTools: ['get_low_stock_products']
      },
      650
    );
  }
};
