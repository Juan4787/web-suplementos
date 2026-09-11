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
  QuoteCartEtaResult,
  ReceivePurchaseItemInput,
  ReceivePurchaseResult,
  StockMovement,
  StoreSettings
} from '@/domain/types';
import type {
  BusinessApi,
  Page,
  ProductUpdate,
  PurchaseCreateInput,
  PurchaseUpdateInput
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
  purchaseReceipts: Map<string, {
    purchaseId: string;
    canonicalPayload: string;
    result: { purchase: Purchase; unblockedOrders: Array<{ id: string; number: number }> };
  }>;
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
  purchaseReceipts: new Map(),
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
    return (
      (order.paymentState === 'paid' || order.paymentState === 'gifted') &&
      paidTime >= fromTime &&
      paidTime <= toTime
    );
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
        costCents: 0,
        estimatedMarginCents: 0
      };
      const itemCost = (item.unitCostCents ?? 0) * item.quantity;
      current.units += item.quantity;
      current.revenueCents += item.subtotalCents;
      current.costCents = (current.costCents ?? 0) + itemCost;
      current.estimatedMarginCents += item.subtotalCents - itemCost;
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
      const physAvail = product ? Math.max(0, product.onHand - product.reserved) : 0;
      const incomingAvail = product ? Math.max(0, product.incoming) : 0;
      const available = physAvail + incomingAvail;
      return !product || !product.active || !product.published || line.quantity > available
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

  async quoteCartEta(lines) {
    let requiresIncoming = false;
    let maxEta: string | null = null;
    let hasUnspecifiedEta = false;

    for (const line of lines) {
      const product = state.products.find((candidate) => candidate.id === line.productId);
      if (!product || !product.active || !product.published) {
        return latency({
          ok: false,
          requiresIncoming: false,
          quotedEta: null,
          hasUnspecifiedEta: false,
          error: 'PRODUCT_UNAVAILABLE'
        });
      }

      const physAvail = Math.max(0, product.onHand - product.reserved);
      const remainingNeeded = Math.max(0, line.quantity - physAvail);
      if (remainingNeeded > 0) {
        requiresIncoming = true;
        let openCapacity = 0;
        const relevantPurchases = state.purchases
          .filter((p) => p.state === 'ordered')
          .sort((a, b) => {
            if (!a.expectedAt && !b.expectedAt) return 0;
            if (!a.expectedAt) return 1;
            if (!b.expectedAt) return -1;
            return a.expectedAt.localeCompare(b.expectedAt);
          });

        for (const pu of relevantPurchases) {
          for (const item of pu.items.filter((i) => i.productId === line.productId)) {
            const free = Math.max(0, item.quantity - (item.receivedQuantity ?? 0) - (item.shortageQuantity ?? 0));
            if (free > 0) {
              openCapacity += free;
              if (pu.expectedAt) {
                if (!maxEta || pu.expectedAt > maxEta) {
                  maxEta = pu.expectedAt;
                }
              } else {
                hasUnspecifiedEta = true;
              }
            }
          }
        }

        if (openCapacity < remainingNeeded) {
          return latency({
            ok: false,
            requiresIncoming: true,
            quotedEta: null,
            hasUnspecifiedEta: false,
            error: 'INSUFFICIENT_STOCK'
          });
        }
      }
    }

    return latency({
      ok: true,
      requiresIncoming,
      quotedEta: maxEta,
      hasUnspecifiedEta
    });
  },

  async getDashboard() {
    const inventory = toDemoInventory(state.products);
    const currentMonth = startOfMonth(new Date('2026-08-28T15:30:00-03:00'));
    const activeThisMonth = state.orders.filter(
      (order) =>
        order.paidAt &&
        new Date(order.paidAt) >= currentMonth &&
        (order.paymentState === 'paid' || order.paymentState === 'gifted')
    );
    const revenue = activeThisMonth.reduce((sum, order) => sum + order.totalCents, 0);
    const costs = activeThisMonth.reduce((sum, order) => sum + (order.costTotalCents ?? 0), 0);
    const taxes = activeThisMonth.reduce((sum, order) => sum + (order.taxAmountCents ?? 0), 0);
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
      paidOrdersMonth: activeThisMonth.filter((o) => o.paymentState === 'paid').length,
      estimatedMarginMonthCents: revenue - costs - taxes,
      recentOrders: state.orders
        .filter((order) => {
          if (order.orderState === 'cancelled') return false;
          const isCompleted =
            order.fulfillmentState === 'delivered' &&
            (order.paymentState === 'paid' || order.paymentState === 'gifted');
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
      throw new AppError('business', 'Ya existe un producto con ese código o enlace.', {
        nextAction: 'Usá un código y un enlace diferentes.'
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
      featured: input.featured ?? false,
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

  async deleteProduct(productId: string) {
    const index = state.products.findIndex((candidate) => candidate.id === productId);
    if (index === -1) {
      throw new AppError('business', 'No encontramos el producto que querías eliminar.');
    }
    const hasOrders = (state.orders ?? []).some((order) =>
      (order.items ?? []).some((item) => item.productId === productId)
    );
    if (hasOrders) {
      throw new AppError(
        'business',
        'No se puede eliminar un producto que tiene pedidos asociados.',
        {
          nextAction: 'Podés archivarlo o desactivarlo desde la edición para que no aparezca en la tienda.'
        }
      );
    }
    state.products.splice(index, 1);
    state.revision += 1;
  },

  async archiveProduct(productId: string, archived: boolean) {
    const product = state.products.find((candidate) => candidate.id === productId);
    if (!product) {
      throw new AppError('business', 'No encontramos el producto que querías actualizar.');
    }
    product.active = !archived;
    if (archived) {
      product.published = false;
      product.featured = false;
    }
    state.revision += 1;
    return latency(product);
  },

  async listInventory() {
    return latency(toDemoInventory(state.products));
  },

  async adjustStock(productId, delta, reason, expectedOnHand) {
    const product = state.products.find((candidate) => candidate.id === productId);
    if (!product) throw new AppError('business', 'No encontramos el producto que querías ajustar.');
    if (expectedOnHand !== undefined && product.onHand !== expectedOnHand) {
      throw new AppError('business', 'El stock cambió mientras hacías el conteo.', {
        nextAction: 'Cerrá esta corrección y volvé a abrirla para revisar el stock actualizado antes de guardar.'
      });
    }
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

  async updateStockThresholds({ productId, reorderPoint, safetyStock, leadTimeDays }) {
    const product = state.products.find((candidate) => candidate.id === productId);
    if (!product) throw new AppError('business', 'No encontramos el producto que querías actualizar.');
    if (!Number.isFinite(reorderPoint) || reorderPoint < 0) {
      throw new AppError('validation', 'El punto de pedido debe ser un número igual o mayor a 0.');
    }
    if (!Number.isFinite(safetyStock) || safetyStock < 0) {
      throw new AppError('validation', 'El stock de seguridad debe ser un número igual o mayor a 0.');
    }
    product.reorderPoint = Math.max(0, Math.round(reorderPoint));
    product.safetyStock = Math.max(0, Math.round(safetyStock));
    if (typeof leadTimeDays === 'number' && Number.isFinite(leadTimeDays)) {
      product.leadTimeDays = Math.max(0, Math.round(leadTimeDays));
    }
    refreshProductAvailability(product);
    product.updatedAt = new Date().toISOString();
    state.revision += 1;
    await latency(undefined);
  },

  async listOrders(page = 1, pageSize = 20, search = '', filter = 'all') {
    const term = search.trim().toLowerCase();
    const digits = term.replace(/\D/g, '');
    const completed = (o: Order) =>
      o.orderState === 'cancelled' ||
      (o.fulfillmentState === 'delivered' && (o.paymentState === 'paid' || o.paymentState === 'gifted'));
    const matched = state.orders.filter(o => !term || o.customerName.toLowerCase().includes(term) || String(o.number).includes(term) || (digits.length >= 3 && (o.customerPhone ?? '').replace(/\D/g, '').includes(digits)));
    const selected = matched.filter(o => filter === 'all' || (filter === 'completed') === completed(o));
    return latency({ ...paginate(selected, page, pageSize), pendingTotal: matched.filter(o => !completed(o)).length, completedTotal: matched.filter(completed).length });
  },

  async listPaidOrders(page = 1, pageSize = 20, from, to) {
    const filtered = state.orders.filter(order => {
      const date = order.paidAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(order.paidAt)) : '';
      return (order.paymentState === 'paid' || order.paymentState === 'gifted') && (!from || date >= from) && (!to || date <= to);
    }).sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''));
    return latency(paginate(filtered, page, pageSize));
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
    if (input.paymentMethod !== 'gift' && subtotalCents !== input.quotedSubtotalCents) {
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
    const existingCustomer = state.customers.find(
      (c) =>
        (input.phone && c.phone && c.phone.trim() === input.phone.trim()) ||
        c.name.trim().toLowerCase() === input.customerName.trim().toLowerCase()
    );
    const customerId = existingCustomer ? existingCustomer.id : nextUuid();

    let requiresIncoming = false;
    let expectedArrivalAt: string | null = null;
    for (const item of items) {
      const product = state.products.find((candidate) => candidate.id === item.productId)!;
      const physAvail = Math.max(0, product.onHand - product.reserved);
      if (item.quantity > physAvail) {
        requiresIncoming = true;
        const pu = state.purchases.find(
          (p) => p.state === 'ordered' && p.items.some((i) => i.productId === item.productId)
        );
        if (pu?.expectedAt && (!expectedArrivalAt || pu.expectedAt > expectedArrivalAt)) {
          expectedArrivalAt = pu.expectedAt;
        }
      }
    }

    const isGift = input.paymentMethod === 'gift';
    const order: Order = {
      id: nextUuid(),
      number,
      customerId,
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
      paymentState: isGift ? 'gifted' : 'pending',
      preparationState: 'ready',
      fulfillmentState: isGift ? 'delivered' : 'pending',
      stockReadiness: requiresIncoming ? 'waiting_incoming' : 'ready',
      expectedArrivalAt,
      subtotalCents: isGift ? 0 : subtotalCents,
      shippingFeeCents: isGift ? 0 : input.shippingFeeCents,
      totalCents: isGift ? 0 : subtotalCents + input.shippingFeeCents,
      taxRateBasisPoints: state.settings.taxRateBasisPoints,
      taxAmountCents: isGift ? 0 : calculateBasisPoints(
        subtotalCents + input.shippingFeeCents,
        state.settings.taxRateBasisPoints ?? 0
      ),
      costTotalCents,
      createdAt: now,
      confirmedAt: now,
      paidAt: isGift ? now : null,
      fulfilledAt: isGift ? now : null,
      items
    };
    if (isGift) {
      for (const item of items) {
        const product = state.products.find((candidate) => candidate.id === item.productId)!;
        product.onHand -= item.quantity;
        refreshProductAvailability(product);
        state.movements.unshift({
          id: nextUuid(),
          productId: product.id,
          productName: product.name,
          kind: 'adjustment',
          physicalDelta: -item.quantity,
          reservedDelta: 0,
          reason: `Pedido #${number} regalado / cortesía`,
          orderId: order.id,
          purchaseId: null,
          createdAt: now,
          createdByName: demoStaff.displayName
        });
      }
    } else {
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
    }
    state.orders.unshift(order);
    state.importedProtocolIds.add(input.protocolOrderId);
    if (existingCustomer) {
      existingCustomer.orderCount += 1;
      existingCustomer.lastOrderAt = now;
      if (!existingCustomer.phone && input.phone) {
        existingCustomer.phone = input.phone;
      }
    } else {
      state.customers.unshift({
        id: customerId,
        name: order.customerName,
        phone: order.customerPhone,
        firstOrderAt: now,
        lastOrderAt: now,
        orderCount: 1,
        totalPaidCents: 0
      });
    }
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
      const customer = state.customers.find(
        (candidate) =>
          candidate.id === order.customerId ||
          (candidate.phone && order.customerPhone && candidate.phone === order.customerPhone) ||
          candidate.name.trim().toLowerCase() === order.customerName.trim().toLowerCase()
      );
      if (customer) customer.totalPaidCents = (customer.totalPaidCents ?? 0) + order.totalCents;
    }
    if (action === 'mark_refunded') {
      order.paymentState = 'refunded';
      const customer = state.customers.find(
        (candidate) =>
          candidate.id === order.customerId ||
          (candidate.phone && order.customerPhone && candidate.phone === order.customerPhone) ||
          candidate.name.trim().toLowerCase() === order.customerName.trim().toLowerCase()
      );
      if (customer && customer.totalPaidCents !== null) {
        customer.totalPaidCents = Math.max(0, customer.totalPaidCents - order.totalCents);
      }
    }
    if (action === 'mark_gifted') {
      order.paymentState = 'gifted';
      order.paymentMethod = 'gift';
      order.fulfillmentState = 'delivered';
      order.preparationState = 'ready';
      order.orderState = 'confirmed';
      order.totalCents = 0;
      order.subtotalCents = 0;
      order.taxAmountCents = 0;
      order.shippingFeeCents = 0;
      order.paidAt = now;
      order.fulfilledAt = now;

      for (const item of order.items) {
        const product = state.products.find((candidate) => candidate.id === item.productId)!;
        if (product) {
          product.onHand -= item.quantity;
          product.reserved = Math.max(0, product.reserved - item.quantity);
          refreshProductAvailability(product);
          state.movements.unshift({
            id: nextUuid(),
            productId: product.id,
            productName: product.name,
            kind: 'adjustment',
            physicalDelta: -item.quantity,
            reservedDelta: -item.quantity,
            reason: `Pedido #${order.number} regalado / cortesía`,
            orderId: order.id,
            purchaseId: null,
            createdAt: now,
            createdByName: demoStaff.displayName
          });
        }
      }
    }
    if (action === 'start_preparing') order.preparationState = 'preparing';
    if (action === 'mark_ready') order.preparationState = 'ready';
    if (action === 'mark_shipped' || action === 'mark_delivered') {
      if (order.stockReadiness === 'waiting_incoming') {
        throw new AppError('business', 'No se puede entregar un pedido en espera de mercadería.');
      }
      order.preparationState = 'ready';
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

  async listPurchases(page = 1, pageSize = 20, stateFilter = 'all') {
    const all = state.purchases;
    const filtered = stateFilter === 'all'
      ? all
      : all.filter((p) => p.state === stateFilter);
    const paginated = paginate(filtered, page, pageSize);
    return latency({
      ...paginated,
      total: all.length,
      pendingTotal: all.filter((p) => p.state === 'ordered').length,
      receivedTotal: all.filter((p) => p.state === 'received').length,
      filteredTotal: filtered.length
    });
  },

  async createPurchase(input: PurchaseCreateInput) {
    const consolidatedMap = new Map<string, { quantity: number; totalCost: number }>();
    for (const item of input.items) {
      const existing = consolidatedMap.get(item.productId);
      if (existing) {
        existing.quantity += item.quantity;
        existing.totalCost += item.quantity * item.unitCostCents;
      } else {
        consolidatedMap.set(item.productId, {
          quantity: item.quantity,
          totalCost: item.quantity * item.unitCostCents
        });
      }
    }
    const consolidatedItems = Array.from(consolidatedMap.entries()).map(([productId, data]) => ({
      productId,
      quantity: data.quantity,
      unitCostCents: Math.round(data.totalCost / (data.quantity || 1))
    }));

    const items = consolidatedItems.map((item) => {
      const product = state.products.find((candidate) => candidate.id === item.productId);
      if (!product) throw new AppError('business', 'Uno de los productos ya no está disponible.');
      return {
        id: nextUuid(),
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        receivedQuantity: 0,
        shortageQuantity: 0,
        unitCostCents: item.unitCostCents
      };
    });
    const now = new Date().toISOString();
    const purchase: Purchase = {
      id: nextUuid(),
      number: Math.max(...state.purchases.map((entry) => entry.number), 0) + 1,
      supplierName: input.supplierName?.trim() || 'Proveedor no informado',
      state: 'ordered',
      orderedAt: now,
      expectedAt: input.expectedAt ?? null,
      receivedAt: null,
      totalCostCents: items.reduce(
        (sum, item) => sum + item.quantity * item.unitCostCents,
        0
      ),
      notes: input.notes ?? null,
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

  async updatePurchase(input: PurchaseUpdateInput) {
    const purchase = state.purchases.find((entry) => entry.id === input.id);
    if (!purchase) throw new AppError('business', 'Pedido no encontrado.');
    if (purchase.state !== 'ordered') {
      throw new AppError('business', 'Solo se pueden editar pedidos pendientes de recepción.');
    }
    if (purchase.items.some((it) => (it.receivedQuantity ?? 0) > 0 || (it.shortageQuantity ?? 0) > 0)) {
      throw new AppError('business', 'No se puede editar una compra que ya fue recibida parcialmente.');
    }

    // Revertir incoming previo
    for (const item of purchase.items) {
      const product = state.products.find((candidate) => candidate.id === item.productId);
      if (product) {
        product.incoming = Math.max(0, product.incoming - item.quantity);
        refreshProductAvailability(product);
      }
    }

    const consolidatedMap = new Map<string, { quantity: number; totalCost: number }>();
    for (const item of input.items) {
      const existing = consolidatedMap.get(item.productId);
      if (existing) {
        existing.quantity += item.quantity;
        existing.totalCost += item.quantity * item.unitCostCents;
      } else {
        consolidatedMap.set(item.productId, {
          quantity: item.quantity,
          totalCost: item.quantity * item.unitCostCents
        });
      }
    }
    const consolidatedItems = Array.from(consolidatedMap.entries()).map(([productId, data]) => ({
      productId,
      quantity: data.quantity,
      unitCostCents: Math.round(data.totalCost / (data.quantity || 1))
    }));

    const updatedItems = consolidatedItems.map((item) => {
      const product = state.products.find((candidate) => candidate.id === item.productId);
      if (!product) throw new AppError('business', 'Uno de los productos ya no está disponible.');
      const existingItem = purchase.items.find((it) => it.productId === item.productId);
      return {
        id: existingItem ? existingItem.id : nextUuid(),
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        receivedQuantity: 0,
        shortageQuantity: 0,
        unitCostCents: item.unitCostCents
      };
    });

    for (const item of updatedItems) {
      const product = state.products.find((candidate) => candidate.id === item.productId);
      if (product) {
        product.incoming += item.quantity;
        refreshProductAvailability(product);
      }
    }

    purchase.supplierName = input.supplierName?.trim() || 'Proveedor no informado';
    purchase.expectedAt = input.expectedAt ?? null;
    purchase.notes = input.notes ?? null;
    purchase.items = updatedItems;
    purchase.totalCostCents = updatedItems.reduce(
      (sum, item) => sum + item.quantity * item.unitCostCents,
      0
    );
    state.revision += 1;
    return latency(purchase);
  },

  async listOpeningReservations() { return latency([]); },
  async resolveOpeningReservation() {
    throw new AppError('business', 'Esta reserva ya no está pendiente.', { nextAction: 'Actualizá Inventario para ver las reservas actuales.' });
  },

  async receivePurchase(purchaseId, itemsInput, operationId) {
    const canonicalPayload = JSON.stringify(
      (itemsInput ?? [])
        .map((i) => ({ purchaseItemId: i.purchaseItemId, receivedQuantity: i.receivedQuantity }))
        .sort((a, b) => a.purchaseItemId.localeCompare(b.purchaseItemId))
    );

    if (operationId) {
      const existing = state.purchaseReceipts.get(operationId);
      if (existing) {
        if (existing.purchaseId !== purchaseId || existing.canonicalPayload !== canonicalPayload) {
          throw new AppError('business', 'IDEMPOTENCY_KEY_REUSE_MISMATCH');
        }
        return latency(existing.result);
      }
    }

    const purchase = state.purchases.find((candidate) => candidate.id === purchaseId);
    if (!purchase) throw new AppError('business', 'No encontramos la compra.');
    if (purchase.state !== 'ordered') {
      throw new AppError('business', 'Esta compra ya no está esperando recepción.');
    }
    const now = new Date().toISOString();
    const unblockedOrders: Array<{ id: string; number: number }> = [];

    for (const item of purchase.items) {
      let qtyToReceive = 0;
      if (itemsInput && itemsInput.length > 0) {
        const inputItem = itemsInput.find((i) => i.purchaseItemId === item.id);
        qtyToReceive = inputItem ? inputItem.receivedQuantity : 0;
      } else {
        qtyToReceive = Math.max(0, item.quantity - (item.receivedQuantity ?? 0) - (item.shortageQuantity ?? 0));
      }

      if (qtyToReceive > 0) {
        item.receivedQuantity = (item.receivedQuantity ?? 0) + qtyToReceive;
        const product = state.products.find((candidate) => candidate.id === item.productId)!;
        product.incoming = Math.max(0, product.incoming - qtyToReceive);
        product.onHand += qtyToReceive;
        product.currentCostCents = item.unitCostCents;
        refreshProductAvailability(product);
        state.movements.unshift({
          id: nextUuid(),
          productId: product.id,
          productName: product.name,
          kind: 'purchase_received',
          physicalDelta: qtyToReceive,
          reservedDelta: 0,
          reason: `Compra #${purchase.number} recibida (${qtyToReceive} un.)`,
          orderId: null,
          purchaseId: purchase.id,
          createdAt: now,
          createdByName: 'Sofía'
        });
      }
    }

    const allCompleted = purchase.items.every(
      (item) => (item.receivedQuantity ?? 0) + (item.shortageQuantity ?? 0) >= item.quantity
    );
    if (allCompleted) {
      purchase.state = 'received';
      purchase.receivedAt = now;
    }

    if (allCompleted) {
      for (const order of state.orders) {
        if (order.stockReadiness === 'waiting_incoming') {
          order.stockReadiness = 'ready';
          order.expectedArrivalAt = null;
          unblockedOrders.push({ id: order.id, number: order.number });
        }
      }
    }

    const result = { purchase, unblockedOrders };
    if (operationId) {
      state.purchaseReceipts.set(operationId, {
        purchaseId,
        canonicalPayload,
        result: structuredClone(result)
      });
    }

    state.revision += 1;
    return latency(result);
  },

  async closePurchaseWithShortage(purchaseId, notes) {
    const purchase = state.purchases.find((candidate) => candidate.id === purchaseId);
    if (!purchase) throw new AppError('business', 'No encontramos la compra.');
    if (purchase.state !== 'ordered') {
      throw new AppError('business', 'Esta compra ya no está esperando recepción.');
    }
    const now = new Date().toISOString();
    for (const item of purchase.items) {
      const remaining = Math.max(0, item.quantity - (item.receivedQuantity ?? 0) - (item.shortageQuantity ?? 0));
      if (remaining > 0) {
        const product = state.products.find((candidate) => candidate.id === item.productId);
        if (product) {
          product.incoming = Math.max(0, product.incoming - remaining);
          refreshProductAvailability(product);
        }
        item.shortageQuantity = (item.shortageQuantity ?? 0) + remaining;
      }
    }
    purchase.state = 'received';
    purchase.receivedAt = now;
    if (notes) {
      purchase.notes = purchase.notes ? `${purchase.notes} | ${notes}` : notes;
    }
    state.revision += 1;
    return latency({ purchase, unblockedOrders: [] });
  },

  async listMovements(page = 1, pageSize = 30, search = '', filter = 'all') {
    let list = state.movements;
    if (search) {
      const term = search.toLowerCase();
      list = list.filter(
        (m) =>
          m.productName.toLowerCase().includes(term) ||
          m.reason.toLowerCase().includes(term) ||
          m.createdByName.toLowerCase().includes(term)
      );
    }
    if (filter === 'sales') {
      list = list.filter((m) => m.kind === 'sale' || m.kind === 'reservation' || m.kind === 'reservation_release');
    } else if (filter === 'purchases') {
      list = list.filter((m) => m.kind === 'purchase_received');
    } else if (filter === 'adjustments') {
      list = list.filter((m) => m.kind === 'adjustment' || m.kind === 'return');
    }
    return latency(paginate(list, page, pageSize));
  },

  async listCustomerOrders(customerId, page = 1, pageSize = 20) {
    const orders = state.orders.filter(o => o.customerId === customerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return latency(paginate(orders, page, pageSize));
  },

  async listCustomers(page = 1, pageSize = 30, search?: string) {
    // Sincronizar estadísticas de clientes con pedidos reales
    for (const customer of state.customers) {
      const orders = state.orders.filter(
        (o) =>
          o.customerId === customer.id
      );
      if (orders.length > 0) {
        customer.orderCount = orders.filter((o) => o.orderState !== 'cancelled').length;
        customer.totalPaidCents = orders
          .filter((o) => o.paymentState === 'paid' && o.orderState !== 'cancelled')
          .reduce((sum, o) => sum + o.totalCents, 0);
        customer.pendingOrderCount = orders.filter((o) => o.paymentState === 'pending' && o.orderState !== 'cancelled').length;
        customer.pendingTotalCents = orders
          .filter((o) => o.paymentState === 'pending' && o.orderState !== 'cancelled')
          .reduce((sum, o) => sum + o.totalCents, 0);
      } else {
        customer.pendingOrderCount = 0;
        customer.pendingTotalCents = 0;
      }
    }

    let items = state.customers;
    if (search && search.trim()) {
      const term = search.toLowerCase();
      const digits = search.replace(/[^0-9]/g, '');
      items = items.filter((c) => {
        const nameMatch = c.name.toLowerCase().includes(term);
        const phoneMatch = (c.phone ?? '').includes(term);
        const digitMatch = digits.length > 0 && (c.phone ?? '').replace(/[^0-9]/g, '').includes(digits);
        return nameMatch || phoneMatch || digitMatch;
      });
    }

    return latency(paginate(items, page, pageSize));
  },

  async getAnalytics(from, to) {
    const cutoffDay = comparisonCutoffDay(from, to);
    const orders = paidOrdersInRange(from, to).filter(
      (order) => cutoffDay === null || new Date(order.paidAt ?? order.createdAt).getDate() <= cutoffDay
    );
    const paidOrders = orders.filter((order) => order.paymentState === 'paid');
    const giftOrdersList = orders.filter((order) => order.paymentState === 'gifted');
    const giftOrders = giftOrdersList.length;
    const giftCostCents = giftOrdersList.reduce((sum, order) => sum + (order.costTotalCents ?? 0), 0);
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
      averageTicketCents: paidOrders.length ? Math.round(revenueCents / paidOrders.length) : 0,
      orders: orders.length,
      units,
      giftOrders,
      giftCostCents,
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
        provider: 'Local',
        fallback: false,
        usedTools: ['get_inventory_status'],
        evidence: []
      },
      650
    );
  }
};
