import { formatISO } from 'date-fns';
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
import { countCharacters } from '@/domain/text';
import { suggestedPurchase, availabilityFromQuantity } from '@/domain/inventory';
import { orderLineRevenue, percentageShippingCents, shippingFeeNeedsReview, validateShippingCents } from '@/domain/order-shipping';
import { calculateBasisPoints } from '@/domain/money';
import { salesDateAt } from '@/domain/sales-date';
import {
  countMiscExpenseOccurrences,
  listMiscExpenseOccurrenceDates,
  validateMiscExpense
} from '@/domain/misc-expenses';
import { isOrderReversal, availableOrderActions } from '@/domain/order-actions';
import type {
  AdminProduct,
  AnalyticsSummary,
  Customer,
  ExportDataset,
  InflationIndex,
  MiscExpense,
  MiscExpenseAuditEntry,
  MiscExpenseSnapshot,
  Order,
  OrderItem,
  OrderShippingFeeEvent,
  PurchaseReceipt,
  ProductPerformance,
  Purchase,
  PurchaseCancellationPreview,
  PurchaseCancellationResult,
  PurchaseImpactItem,
  QuoteCartEtaResult,
  ReceivePurchaseItemInput,
  ReceivePurchaseResult,
  ImportOrderInput,
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
  expenses: MiscExpense[];
  expenseHistory: MiscExpenseAuditEntry[];
  importedProtocols: Map<string, { orderId: string; fingerprint: string }>;
  purchaseReceipts: Map<string, {
    purchaseId: string;
    canonicalPayload: string;
    shippingCostCents: number;
    result: { purchase: Purchase; unblockedOrders: Array<{ id: string; number: number }> };
  }>;
  reversalHistory: NonNullable<ExportDataset['orderActionHistory']>;
  reversalOperations: Map<string, { orderId: string; action: string; revision: number }>;
  orderEditOperations: Map<string, { orderId: string; revision: number; fingerprint: string; result: Order }>;
  shippingFeeOperations: Map<string, { input: string; orderId: string }>;
  shippingFeeHistory: OrderShippingFeeEvent[];
  receiptHistory: PurchaseReceipt[];
  incomingAllocations: Map<string, Array<{ purchaseItemId: string; quantity: number; unitCostCents: number }>>;
  shortageOperations: Map<string, { request: string; result: unknown }>;
  revision: number;
} = {
  settings: structuredClone(demoSettings),
  products: structuredClone(demoProducts),
  orders: structuredClone(demoOrders).map(order => ({
    ...order,
    packingRevision: 0,
    packingTracked: false,
    stockReadiness: order.stockReadiness ?? 'ready',
    items: order.items.map(item => ({
      ...item,
      packedQuantity: null,
      physicalReservedQuantity: order.fulfillmentState === 'pending' ? item.quantity : 0,
      incomingQuantity: 0,
      uncoveredQuantity: 0
    }))
  })),
  purchases: structuredClone(demoPurchases),
  movements: structuredClone(demoMovements),
  customers: structuredClone(demoCustomers),
  users: structuredClone([demoOwner, demoStaff]),
  inflation: structuredClone(demoInflation),
  expenses: [],
  expenseHistory: [],
  importedProtocols: new Map(),
  purchaseReceipts: new Map(),
  reversalHistory: [],
  reversalOperations: new Map(),
  orderEditOperations: new Map(),
  shippingFeeOperations: new Map(),
  shippingFeeHistory: [],
  receiptHistory: [],
  incomingAllocations: new Map(),
  shortageOperations: new Map(),
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
  const available = Math.max(0, product.onHand - product.reserved);
  const incomingAvailable = Math.max(0, product.incoming - (product.incomingReserved ?? 0));
  product.incomingAvailable = incomingAvailable;
  product.availability = available > 0 ? availabilityFromQuantity(available, product.reorderPoint) : incomingAvailable > 0 ? 'incoming' : 'out_of_stock';
  product.maxOrderQuantity = Math.max(0, Math.min(20, available + incomingAvailable));
  product.updatedAt = new Date().toISOString();
};

const currentDemoInventory = () => {
  const units = new Map<string, number>();
  const counted = new Set<string>();
  const ordersById = new Map(state.orders.map(order => [order.id, order]));
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const movement of [...state.movements].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (movement.kind !== 'sale') continue;
    const order = movement.orderId ? ordersById.get(movement.orderId) : undefined;
    if (movement.orderId && (!order || order.orderState === 'cancelled' ||
      !['shipped','delivered'].includes(order.fulfillmentState) || order.paymentState === 'gifted' || order.saleType === 'gift')) continue;
    const key = `${movement.productId}:${movement.orderId ?? movement.id}`;
    if (counted.has(key)) continue;
    counted.add(key);
    if (new Date(movement.createdAt).getTime() >= cutoff) units.set(movement.productId, (units.get(movement.productId) ?? 0) - movement.physicalDelta);
  }
  return toDemoInventory(state.products).map(item => {
    const average = (units.get(item.id) ?? 0) / 30;
    return { ...item, averageDailySales: Math.round(average * 100) / 100,
      coverageDays: average > 0 ? Math.round(item.available / average * 10) / 10 : null,
      suggestedPurchase: suggestedPurchase(item.available, item.incoming - (item.incomingReserved ?? 0), average, item.leadTimeDays, item.safetyStock) };
  });
};

const nextUuid = (): string => crypto.randomUUID();

const importFingerprint = (input: ImportOrderInput): string => {
  const isGift = input.paymentMethod === 'gift' || input.saleType === 'gift';
  const isCost = !isGift && input.saleType === 'cost';
  const name = input.customerFirstName?.trim() && input.customerLastName?.trim()
    ? `${input.customerFirstName.trim()} ${input.customerLastName.trim()}`
    : input.customerName.trim();
  return JSON.stringify({
    name,
    phone: input.phone?.trim() || null,
    paymentMethod: input.paymentMethod,
    deliveryMethod: input.deliveryMethod,
    shippingType: input.shippingType,
    address: input.deliveryMethod === 'shipping'
      ? [input.address?.trim(), input.addressNumber?.trim()].filter(Boolean).join(' ') || null
      : null,
    stockSource: input.stockSource ?? 'normal',
    shippingFeeCents: isGift ? 0 : input.shippingFeeCents,
    saleType: isGift ? 'gift' : isCost ? 'cost' : 'retail',
    checksum: input.protocolChecksum?.trim().toUpperCase(),
    quotedSubtotalCents: isGift || isCost ? null : input.quotedSubtotalCents,
    quotedTotalCents: isGift || isCost ? null : input.quotedTotalCents,
    lines: input.lines.map(line => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: isGift || isCost ? null : line.unitPriceCents
    })).sort((a, b) => a.productId.localeCompare(b.productId))
  });
};

const expenseSnapshot = (expense: MiscExpense): MiscExpenseSnapshot => ({
  title: expense.title,
  amountCents: expense.amountCents,
  frequency: expense.frequency,
  startsOn: expense.startsOn,
  endsOn: expense.endsOn,
  deletedAt: expense.deletedAt
});

// Record synchronously so a receipt retry sees both stock and expense together.
const recordDemoExpense = (
  values: Pick<MiscExpense, 'title' | 'amountCents' | 'frequency' | 'startsOn' | 'endsOn'>,
  operationId: string,
  receipt?: Pick<MiscExpense, 'purchaseReceiptOperationId' | 'purchaseId' | 'purchaseNumber'>
): MiscExpense => {
  const now = new Date().toISOString();
  const created: MiscExpense = {id: nextUuid(), operationId, ...values, ...receipt,
    createdAt: now, updatedAt: now, deletedAt: null,
    createdByName: demoOwner.displayName, updatedByName: demoOwner.displayName};
  state.expenses.push(created);
  state.expenseHistory.push({id: String(state.expenseHistory.length + 1), expenseId: created.id,
    action: 'created', previous: null, current: expenseSnapshot(created), changedAt: now, changedByName: demoOwner.displayName});
  state.revision += 1;
  return created;
};

const sameExpenseValues = (
  expense: MiscExpense,
  values: Pick<MiscExpense, 'title' | 'amountCents' | 'frequency' | 'startsOn' | 'endsOn'>
): boolean =>
  expense.title === values.title &&
  expense.amountCents === values.amountCents &&
  expense.frequency === values.frequency &&
  expense.startsOn === values.startsOn &&
  expense.endsOn === values.endsOn;

const salesDate = (order: Order): string => salesDateAt(order.paidAt ?? order.createdAt);

const paidOrdersInRange = (from: string, to: string): Order[] => state.orders.filter((order) => {
  if (order.paymentState !== 'paid' && order.paymentState !== 'gifted') return false;
  const date = salesDate(order);
  return date >= from && date <= to;
});

const buildProductPerformance = (orders: Order[]): ProductPerformance[] => {
  const products = new Map<string, ProductPerformance>();
  for (const order of orders) {
    for (const item of order.items) {
      const key = JSON.stringify([item.productId, item.productName]);
      const current = products.get(key) ?? {
        productId: item.productId,
        name: item.productName,
        units: 0,
        revenueCents: 0,
        costCents: 0,
        estimatedMarginCents: 0
      };
      const itemCost = item.costTotalCents ?? (item.unitCostCents ?? 0) * item.quantity;
      const total = BigInt(order.totalCents);
      // Same positive half-up cent rounding as PostgreSQL numeric, without
      // a floating point intermediate changing a half-cent allocation.
      const taxShare = total > 0n ? Number((2n * BigInt(order.taxAmountCents ?? 0) * BigInt(orderLineRevenue(order, item)) + total) / (2n * total)) : 0;
      current.units += item.quantity;
      current.revenueCents += orderLineRevenue(order, item);
      current.costCents = (current.costCents ?? 0) + itemCost;
      current.estimatedMarginCents += orderLineRevenue(order, item) - itemCost - taxShare;
      products.set(key, current);
    }
  }
  return [...products.values()].sort((left, right) => right.units - left.units ||
    right.revenueCents - left.revenueCents || left.name.localeCompare(right.name)).slice(0, 10);
};

const createPurchaseRecord = (input: PurchaseCreateInput): Purchase => {
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
    return purchase;
};

const recordShortage = (purchase: Purchase, item: Purchase['items'][number], quantity: number) => {
  const product = state.products.find(p => p.id === item.productId)!;
  item.shortageQuantity = (item.shortageQuantity ?? 0) + quantity;
  product.incoming -= quantity;
  let toUncover = quantity;
  for (const order of [...state.orders].reverse()) {
    if (order.orderState !== 'confirmed' || order.fulfillmentState !== 'pending') continue;
    for (const line of order.items) {
      if (line.productId !== product.id) continue;
      const allocations = state.incomingAllocations.get(line.id);
      const linked = allocations?.find(a => a.purchaseItemId === item.id && a.quantity > 0);
      if (allocations && !linked) continue;
      const take = Math.min(toUncover, linked?.quantity ?? line.incomingQuantity ?? 0);
      line.incomingQuantity = (line.incomingQuantity ?? 0) - take;
      line.uncoveredQuantity = (line.uncoveredQuantity ?? 0) + take;
      product.incomingReserved = Math.max(0, (product.incomingReserved ?? 0) - take);
      toUncover -= take;
      if (take > 0) { order.stockReadiness = 'uncovered'; order.actionRevision = (order.actionRevision ?? 0) + 1; }
    }
  }
  if (purchase.items.every(line => (line.receivedQuantity ?? 0) + (line.shortageQuantity ?? 0) === line.quantity)) {
    purchase.state = 'received'; purchase.receivedAt = new Date().toISOString();
  }
  refreshProductAvailability(product);
};

function demoProductReservations(productId: string) {
  return state.orders.flatMap(order => {
      if (order.orderState !== 'confirmed' || order.fulfillmentState !== 'pending') return [];
      const item = order.items.find(line => line.productId === productId);
      if (!item) return [];
      const physicalQuantity = item.physicalReservedQuantity ?? (order.stockReadiness === 'ready' ? item.quantity : 0);
      return physicalQuantity > 0 ? [{
        orderId: order.id,
        orderNumber: order.number,
        physicalQuantity,
        packedQuantity: item.packedQuantity ?? null,
        preparationState: order.preparationState,
        paymentState: order.paymentState
      }] : [];
    }).sort((a, b) => a.orderNumber - b.orderNumber);
}

function reconcileDemoProduct(product: AdminProduct, receivedItemId?: string, receivedQuantity = 0): Array<{ id: string; number: number }> {
  let available = Math.max(0, product.onHand - product.reserved);
  let arrivedRemaining = Math.min(available, receivedQuantity);
  let previousFree = available - arrivedRemaining;
  const unblocked: Array<{ id: string; number: number }> = [];
  const waiting = state.orders.filter(o => o.orderState === 'confirmed' && o.fulfillmentState === 'pending')
    .sort((a, b) => (a.confirmedAt || a.createdAt).localeCompare(b.confirmedAt || b.createdAt) || a.number - b.number);
  for (const order of waiting) {
    for (const line of order.items) {
      if (available <= 0 || line.productId !== product.id) continue;
      const incomingOnly = order.stockSource === 'incoming_only';
      const matchingIncoming = (state.incomingAllocations.get(line.id) ?? [])
        .filter(a => a.purchaseItemId === receivedItemId).reduce((sum, a) => sum + a.quantity, 0);
      const take = incomingOnly
        ? Math.min(available, arrivedRemaining, matchingIncoming + (line.uncoveredQuantity ?? 0))
        : Math.min(available, (line.incomingQuantity ?? 0) + (line.uncoveredQuantity ?? 0));
      if (take === 0) continue;
      if (incomingOnly) arrivedRemaining -= take;
      else {
        const previousUsed = Math.min(previousFree, take);
        previousFree -= previousUsed;
        arrivedRemaining -= take - previousUsed;
      }
      const incoming = incomingOnly ? Math.min(take, matchingIncoming) : Math.min(take, line.incomingQuantity ?? 0);
      let toRemove = incoming;
      for (const allocation of state.incomingAllocations.get(line.id) ?? []) {
        if (incomingOnly && allocation.purchaseItemId !== receivedItemId) continue;
        const amount = Math.min(toRemove, allocation.quantity);
        allocation.quantity -= amount; toRemove -= amount;
      }
      line.incomingQuantity = (line.incomingQuantity ?? 0) - incoming;
      line.uncoveredQuantity = (line.uncoveredQuantity ?? 0) - (take - incoming);
      line.physicalReservedQuantity = (line.physicalReservedQuantity ?? 0) + take;
      product.incomingReserved = Math.max(0, (product.incomingReserved ?? 0) - incoming);
      product.reserved += take; available -= take;
      state.movements.unshift({ id: nextUuid(), productId: product.id, productName: product.name, kind: 'reservation',
        physicalDelta: 0, reservedDelta: take, reason: `Asignación física por reconciliación (Pedido #${order.number})`,
        orderId: order.id, purchaseId: null, createdAt: new Date().toISOString(), createdByName: demoOwner.displayName });
      if (order.items.every(i => (i.incomingQuantity ?? 0) + (i.uncoveredQuantity ?? 0) === 0)) {
        order.stockReadiness = 'ready'; order.expectedArrivalAt = null;
        if (!unblocked.some(o => o.id === order.id)) unblocked.push({ id: order.id, number: order.number });
      }
    }
  }
  refreshProductAvailability(product);
  return unblocked;
}

function rebindDemoReceiptPending(item: Purchase['items'][number]): NonNullable<ReceivePurchaseResult['reassignedOrders']> {
  const active = state.orders.filter(o => o.orderState === 'confirmed' && o.fulfillmentState === 'pending');
  const used = (id: string) => active.reduce((sum, o) => sum + o.items.reduce((n, line) => n + (state.incomingAllocations.get(line.id) ?? []).filter(a => a.purchaseItemId === id).reduce((q, a) => q + a.quantity, 0), 0), 0);
  let excess = Math.max(0, used(item.id) - Math.max(0, item.quantity - item.receivedQuantity - item.shortageQuantity));
  const changed = new Set<string>();
  const targets = state.purchases.filter(p => p.state === 'ordered').sort((a, b) => (a.expectedAt ?? '9999').localeCompare(b.expectedAt ?? '9999') || a.number - b.number)
    .flatMap(p => p.items.filter(i => i.id !== item.id && i.productId === item.productId));
  for (const order of [...active].sort((a, b) => (b.confirmedAt || b.createdAt).localeCompare(a.confirmedAt || a.createdAt) || b.number - a.number)) {
    for (const line of order.items.filter(i => i.productId === item.productId)) {
      const allocations = state.incomingAllocations.get(line.id) ?? [];
      for (const source of [...allocations].filter(a => a.purchaseItemId === item.id && a.quantity > 0)) {
        if (excess === 0) break;
        let left = Math.min(source.quantity, excess);
        source.quantity -= left; excess -= left; changed.add(order.id);
        for (const target of targets) {
          const take = Math.min(left, Math.max(0, target.quantity - target.receivedQuantity - target.shortageQuantity - used(target.id)));
          if (take <= 0) continue;
          allocations.push({ purchaseItemId: target.id, quantity: take, unitCostCents: source.unitCostCents }); left -= take;
        }
        if (left > 0) { line.incomingQuantity = (line.incomingQuantity ?? 0) - left; line.uncoveredQuantity = (line.uncoveredQuantity ?? 0) + left;
          const product = state.products.find(p => p.id === item.productId)!; product.incomingReserved = Math.max(0, (product.incomingReserved ?? 0) - left); }
      }
    }
    if (changed.has(order.id)) {
      const dates = order.items.flatMap(line => (state.incomingAllocations.get(line.id) ?? []).filter(a => a.quantity > 0).flatMap(a => state.purchases.filter(p => p.items.some(i => i.id === a.purchaseItemId)).map(p => p.expectedAt).filter((date): date is string => Boolean(date))));
      order.expectedArrivalAt = dates.sort().at(-1) ?? null;
      if (order.items.some(i => (i.uncoveredQuantity ?? 0) > 0)) order.stockReadiness = 'uncovered';
    }
  }
  return active.filter(o => changed.has(o.id)).map(o => ({ id: o.id, number: o.number,
    incomingQuantity: o.items.reduce((n, i) => n + (i.incomingQuantity ?? 0), 0), uncoveredQuantity: o.items.reduce((n, i) => n + (i.uncoveredQuantity ?? 0), 0) }));
}

function purchaseCancellationPreview(purchaseId: string): PurchaseCancellationPreview {
  const purchase = state.purchases.find(p => p.id === purchaseId);
  if (!purchase) throw new AppError('business', 'No encontramos la compra.');
  const orders = state.orders.filter(o => o.orderState !== 'cancelled' && o.fulfillmentState === 'pending').flatMap(o => {
    const quantity = o.items.reduce((sum, line) => {
      const allocations = state.incomingAllocations.get(line.id);
      if (allocations) return sum + allocations.filter(a => purchase.items.some(i => i.id === a.purchaseItemId)).reduce((n, a) => n + a.quantity, 0);
      return sum + (purchase.items.some(i => i.productId === line.productId) ? (line.incomingQuantity ?? 0) + (line.uncoveredQuantity ?? 0) : 0);
    }, 0);
    return quantity > 0 ? [{ id: o.id, number: o.number, customerName: o.customerName, quantity, products: o.items.flatMap(line => {
      const allocations = state.incomingAllocations.get(line.id);
      const amount = allocations ? allocations.filter(a => purchase.items.some(i => i.id === a.purchaseItemId)).reduce((n, a) => n + a.quantity, 0) : purchase.items.some(i => i.productId === line.productId) ? (line.incomingQuantity ?? 0) + (line.uncoveredQuantity ?? 0) : 0;
      return amount > 0 ? [{ name: line.productName, quantity: amount }] : [];
    }) }] : [];
  });
  const pendingUnits = purchase.items.reduce((sum, i) => sum + Math.max(0, i.quantity - i.receivedQuantity - i.shortageQuantity), 0);
  const replacementItems = purchase.items.map(i => ({ productId: i.productId, productName: i.productName, unitCostCents: i.unitCostCents,
    quantity: Math.max(i.quantity - i.receivedQuantity - i.shortageQuantity, state.orders.filter(o => o.orderState !== 'cancelled' && o.fulfillmentState === 'pending').reduce((sum, o) => sum + o.items.reduce((n, line) => n + (state.incomingAllocations.get(line.id) ?? []).filter(a => a.purchaseItemId === i.id).reduce((q, a) => q + a.quantity, 0), 0), 0))
  })).filter(i => i.quantity > 0);
  return structuredClone({ purchase, pendingUnits, replacementItems,
    pendingCostCents: purchase.items.reduce((sum, i) => sum + Math.max(0, i.quantity - i.receivedQuantity - i.shortageQuantity) * i.unitCostCents, 0),
    receivedUnits: purchase.items.reduce((sum, i) => sum + i.receivedQuantity, 0), openingReservedQuantity: 0,
    canCancel: purchase.state === 'ordered' && pendingUnits > 0 && orders.length === 0,
    canReplace: purchase.state === 'ordered' && pendingUnits > 0,
    reviewToken: JSON.stringify({ purchase, orders }), orders });
}

export const demoBusinessApi: BusinessApi = {
  async getSettings() {
    return latency(state.settings);
  },

  async updateSettings(settings) {
    state.settings = structuredClone(settings);
    state.revision += 1;
    return latency(state.settings);
  },

  async listMiscExpenses(from, to) {
    const items = state.expenses
      .filter((expense) => expense.deletedAt === null)
      .map((expense) => {
        const occurrenceCount = countMiscExpenseOccurrences(expense, from, to);
        return {
          ...expense,
          occurrenceCount,
          periodAmountCents: occurrenceCount * expense.amountCents
        };
      })
      .filter((expense) => expense.occurrenceCount > 0)
      .sort((left, right) => right.startsOn.localeCompare(left.startsOn) || left.title.localeCompare(right.title));
    return latency({
      from,
      to,
      expenseCount: items.length,
      occurrenceCount: items.reduce((sum, expense) => sum + expense.occurrenceCount, 0),
      totalCents: items.reduce((sum, expense) => sum + expense.periodAmountCents, 0),
      items
    });
  },

  async saveMiscExpense(input) {
    const linkedExpense = input.id ? state.expenses.find(e => e.id === input.id && e.purchaseReceiptOperationId) : null;
    if (linkedExpense) {
      validateShippingCents(input.amountCents);
      if (input.frequency !== 'once' || input.endsOn !== null) throw new AppError('validation', 'El envío de proveedor se registra una sola vez.');
    }
    const title = input.title.trim();
    const values = {
      title,
      amountCents: input.amountCents,
      frequency: input.frequency,
      startsOn: input.startsOn,
      endsOn: input.frequency === 'once' ? null : input.endsOn
    };
    try {
      validateMiscExpense(values);
    } catch (cause) {
      throw new AppError('validation', 'Hay datos del gasto que necesitan una revisión.', {
        cause,
        nextAction: 'Revisá el título, el monto, la frecuencia y las fechas.'
      });
    }

    if (!input.id) {
      if (!input.operationId) {
        throw new AppError('validation', 'No pudimos preparar este gasto.', {
          nextAction: 'Cerrá el formulario y volvé a abrirlo antes de guardar.'
        });
      }
      const existing = state.expenses.find((expense) => expense.operationId === input.operationId);
      if (existing) {
        if (existing.deletedAt === null && sameExpenseValues(existing, values)) return latency(existing);
        throw new AppError('business', 'Este intento ya se usó con otros datos.', {
          nextAction: 'Cerrá el formulario, volvé a abrirlo y revisá el gasto antes de guardar.'
        });
      }
      return latency(recordDemoExpense(values, input.operationId));
    }

    const existing = state.expenses.find((expense) => expense.id === input.id && expense.deletedAt === null);
    if (!existing) {
      throw new AppError('business', 'No encontramos ese gasto activo.', {
        nextAction: 'Actualizá la lista para revisar si otra persona lo anuló.'
      });
    }
    if (!input.expectedUpdatedAt) {
      throw new AppError('validation', 'No pudimos comprobar la versión de este gasto.', {
        nextAction: 'Cerrá la edición y volvé a abrirla desde la lista actualizada.'
      });
    }
    if (existing.updatedAt !== input.expectedUpdatedAt) {
      if (sameExpenseValues(existing, values)) return latency(existing);
      throw new AppError('business', 'Este gasto cambió mientras lo estabas editando.', {
        nextAction: 'Cerrá la edición, actualizá la lista y revisá los cambios antes de volver a guardar.'
      });
    }
    if (sameExpenseValues(existing, values)) return latency(existing);

    const previous = expenseSnapshot(existing);
    Object.assign(existing, values, {
      updatedAt: new Date().toISOString(),
      updatedByName: demoOwner.displayName
    });
    state.expenseHistory.push({
      id: String(state.expenseHistory.length + 1),
      expenseId: existing.id,
      action: 'updated',
      previous,
      current: expenseSnapshot(existing),
      changedAt: existing.updatedAt,
      changedByName: demoOwner.displayName
    });
    state.revision += 1;
    return latency(existing);
  },

  async deleteMiscExpense(expenseId, expectedUpdatedAt) {
    const existing = state.expenses.find((expense) => expense.id === expenseId);
    if (!existing) {
      throw new AppError('business', 'No encontramos ese gasto.', {
        nextAction: 'Actualizá la lista y volvé a intentarlo.'
      });
    }
    if (existing.deletedAt !== null) return latency(existing);
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new AppError('business', 'Este gasto cambió antes de que pudieras anularlo.', {
        nextAction: 'Cerrá la confirmación, actualizá la lista y revisalo otra vez.'
      });
    }
    const previous = expenseSnapshot(existing);
    existing.deletedAt = new Date().toISOString();
    existing.updatedAt = existing.deletedAt;
    existing.updatedByName = demoOwner.displayName;
    state.expenseHistory.push({
      id: String(state.expenseHistory.length + 1),
      expenseId: existing.id,
      action: 'deleted',
      previous,
      current: expenseSnapshot(existing),
      changedAt: existing.updatedAt,
      changedByName: demoOwner.displayName
    });
    state.revision += 1;
    return latency(existing);
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
      const incomingAvail = product ? Math.max(0, product.incoming - (product.incomingReserved ?? 0)) : 0;
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
        let alreadyReserved = product.incomingReserved ?? 0;
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
            const pending = Math.max(0, item.quantity - (item.receivedQuantity ?? 0) - (item.shortageQuantity ?? 0));
            const taken = Math.min(pending, alreadyReserved);
            alreadyReserved -= taken;
            const free = pending - taken;
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
    const inventory = currentDemoInventory();
    const expenseTo = salesDateAt(new Date().toISOString());
    const expenseFrom = `${expenseTo.slice(0, 7)}-01`;
    const activeThisMonth = state.orders.filter(
      (order) =>
        order.paidAt &&
        salesDateAt(order.paidAt) >= expenseFrom && salesDateAt(order.paidAt) <= expenseTo &&
        (order.paymentState === 'paid' || order.paymentState === 'gifted')
    );
    const revenue = activeThisMonth.reduce((sum, order) => sum + order.totalCents, 0);
    const costs = activeThisMonth.reduce((sum, order) => sum + (order.costTotalCents ?? 0), 0);
    const taxes = activeThisMonth.reduce((sum, order) => sum + (order.taxAmountCents ?? 0), 0);
    const miscExpenses = state.expenses
      .filter((expense) => expense.deletedAt === null)
      .reduce(
        (sum, expense) =>
          sum + countMiscExpenseOccurrences(expense, expenseFrom, expenseTo) * expense.amountCents,
        0
      );
    return latency({
      pendingPreparation: state.orders.filter(
        (order) =>
          order.orderState === 'confirmed' &&
          order.preparationState !== 'ready' &&
          order.fulfillmentState === 'pending' &&
          order.paymentState !== 'refunded'
      ).length,
      readyForDelivery: state.orders.filter(
        (order) =>
          order.orderState === 'confirmed' &&
          order.preparationState === 'ready' &&
          order.fulfillmentState === 'pending' &&
          order.paymentState !== 'refunded'
      ).length,
      lowStockProducts: inventory.filter((item) => item.status !== 'ok').length,
      incomingPurchases: state.purchases.filter((purchase) => purchase.state === 'ordered').length,
      paidRevenueMonthCents: revenue,
      paidOrdersMonth: activeThisMonth.filter((o) => o.paymentState === 'paid').length,
      estimatedMarginMonthCents: revenue - costs - taxes - miscExpenses,
      miscExpensesMonthCents: miscExpenses,
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
    return latency(currentDemoInventory());
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
    if (delta > 0) reconcileDemoProduct(product);
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

  async updateStockThresholds({ productId, reorderPoint, safetyStock, leadTimeDays, expected }) {
    const product = state.products.find((candidate) => candidate.id === productId);
    if (!product) throw new AppError('business', 'No encontramos el producto que querías actualizar.');
    if (expected && (expected.reorderPoint !== product.reorderPoint || expected.safetyStock !== product.safetyStock || expected.leadTimeDays !== product.leadTimeDays)) throw new AppError('business', 'Los avisos cambiaron mientras editabas.', { nextAction: 'Cargá los avisos actualizados antes de guardar.' });
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
    const preparing = (o: Order) => o.orderState === 'confirmed' && o.fulfillmentState === 'pending' && o.preparationState === 'preparing';
    const readyPickup = (o: Order) => o.orderState === 'confirmed' && o.fulfillmentState === 'pending' && o.preparationState === 'ready' && o.deliveryMethod === 'pickup';
    const selected = matched.filter(o => filter === 'all' ||
      (filter === 'pending' && !completed(o)) ||
      (filter === 'completed' && completed(o)) ||
      (filter === 'preparing' && preparing(o)) ||
      (filter === 'ready_pickup' && readyPickup(o)));
    return latency({ ...paginate(selected, page, pageSize),
      pendingTotal: matched.filter(o => !completed(o)).length,
      completedTotal: matched.filter(completed).length,
      preparingTotal: matched.filter(preparing).length,
      readyPickupTotal: matched.filter(readyPickup).length
    });
  },

  async getOrder(orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if (!order) throw new AppError('business', 'No encontramos ese pedido.', { nextAction: 'Actualizá la lista de Pedidos y volvé a buscarlo.' });
    return latency(order);
  },

  async getOrderStockContext(orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if (!order) throw new AppError('business', 'No encontramos ese pedido.');
    return latency({
      orderId: order.id, orderState: order.orderState, fulfillmentState: order.fulfillmentState,
      stockSource: order.stockSource ?? 'normal', actionRevision: order.actionRevision ?? 0,
      packingRevision: order.packingRevision ?? 0, checkedAt: new Date().toISOString(),
      items: order.items.map(line => {
        const product = state.products.find(p => p.id === line.productId)!;
        const ownPhysical = order.items.filter(i => i.productId === product.id)
          .reduce((sum, i) => sum + (i.physicalReservedQuantity ?? i.quantity), 0);
        const allocations = state.incomingAllocations.get(line.id) ?? [];
        return {
          orderItemId: line.id, productId: line.productId, quantity: line.quantity,
          onHand: product.onHand, reserved: product.reserved, available: Math.max(0, product.onHand - product.reserved),
          physicalQuantity: line.physicalReservedQuantity ?? line.quantity,
          incomingQuantity: line.incomingQuantity ?? 0, uncoveredQuantity: line.uncoveredQuantity ?? 0,
          otherReservedQuantity: Math.max(0, product.reserved - ownPhysical), openingReservedQuantity: 0,
          reservations: demoProductReservations(product.id),
          purchases: state.purchases.flatMap(p => p.items.flatMap(item => {
            const quantity = allocations.filter(a => a.purchaseItemId === item.id).reduce((sum, a) => sum + a.quantity, 0);
            return quantity > 0 ? [{ id: p.id, number: p.number, expectedAt: p.expectedAt, state: p.state,
              reservedQuantity: quantity, incomingQuantity: quantity, uncoveredQuantity: 0,
              orderedQuantity: item.quantity, receivedQuantity: item.receivedQuantity,
              shortageQuantity: item.shortageQuantity }] : [];
          }))
        };
      })
    });
  },

  async getPurchase(purchaseId) {
    const purchase = state.purchases.find(p => p.id === purchaseId);
    if (!purchase) throw new AppError('business', 'No encontramos la compra.');
    return latency(purchase);
  },

  async listProductReservations(productId) {
    return latency(demoProductReservations(productId));
  },

  async listPaidOrders(page = 1, pageSize = 20, from, to) {
    const filtered = state.orders.filter(order => {
      const date = salesDate(order);
      return (order.paymentState === 'paid' || order.paymentState === 'gifted') && (!from || date >= from) && (!to || date <= to);
    }).sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''));
    return latency(paginate(filtered, page, pageSize));
  },

  async confirmImportedOrder(input) {
    if (!input.lines.length || new Set(input.lines.map(line => line.productId)).size !== input.lines.length ||
        input.lines.some(line => !Number.isInteger(line.quantity) || line.quantity <= 0)) {
      throw new AppError('validation', 'Revisá los productos y cantidades del pedido.');
    }
    const fingerprint = importFingerprint(input);
    const previous = input.protocolOrderId ? state.importedProtocols.get(input.protocolOrderId) : null;
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new AppError('business', 'Los datos cambiaron respecto del intento anterior.', {
          nextAction: 'Buscá el pedido anterior y revisá los datos antes de iniciar otro.'
        });
      }
      const existing = state.orders.find(order => order.id === previous.orderId);
      if (existing) return latency({ ...existing, alreadyImported: true });
    }
    const stockSource = input.stockSource ?? 'normal';
    if (!['normal', 'incoming_only'].includes(stockSource)) throw new AppError('validation', 'Elegí de dónde reservar los productos.');
    const isCost = input.saleType === 'cost';
    const isGift = input.paymentMethod === 'gift' || input.saleType === 'gift';
    // El catálogo público excluye productos despublicados; una importación
    // administrativa sí puede usar un producto activo que está oculto.
    const lacksStock = input.lines.some((line) => {
      const product = state.products.find((candidate) => candidate.id === line.productId);
      if (!product?.active) return true;
      const physical = Math.max(0, product.onHand - product.reserved);
      const incoming = Math.max(0, product.incomingAvailable ?? (product.incoming - (product.incomingReserved ?? 0)));
      return line.quantity > (stockSource === 'incoming_only' ? 0 : physical) + incoming;
    });
    if (lacksStock) {
      throw new AppError('business', 'El stock cambió y el pedido necesita una revisión.', {
        nextAction: 'Ajustá las cantidades disponibles antes de confirmarlo.'
      });
    }
    if (!isCost && !isGift && input.lines.some((line) =>
      state.products.find((candidate) => candidate.id === line.productId)?.priceCents !== line.unitPriceCents
    )) {
      throw new AppError('business', 'El precio del mensaje no coincide con el catálogo actual.', {
        nextAction: 'Volvé a generar el pedido con el precio vigente antes de confirmarlo.'
      });
    }
    const items: OrderItem[] = input.lines.map((line) => {
      const product = state.products.find((candidate) => candidate.id === line.productId)!;
      const unitPriceCents = isGift ? 0 : isCost ? (product.currentCostCents ?? line.unitPriceCents) : line.unitPriceCents;
      return {
        id: nextUuid(),
        productId: product.id,
        sku: product.sku,
        productName: product.name,
        presentation: product.presentation,
        quantity: line.quantity,
        unitPriceCents,
        unitCostCents: product.currentCostCents,
        subtotalCents: unitPriceCents * line.quantity
      };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.subtotalCents, 0);
    if (!isGift && !isCost && subtotalCents !== input.quotedSubtotalCents) {
      throw new AppError('business', 'Los precios revisados ya no coinciden con el mensaje.', {
        nextAction: 'Volvé a revisar los productos y confirmá el total correcto.'
      });
    }
    const now = new Date().toISOString();
    const number = Math.max(...state.orders.map((order) => order.number), 1000) + 1;
    let costTotalCents = items.reduce(
      (sum, item) => sum + (item.unitCostCents ?? 0) * item.quantity,
      0
    );
    const rawFirst = input.customerFirstName?.trim();
    const rawLast = input.customerLastName?.trim();
    let firstName = rawFirst;
    let lastName = rawLast;
    let fullName = input.customerName?.trim() ?? '';
    if (firstName && lastName) {
      fullName = `${firstName} ${lastName}`.trim();
    } else if (fullName) {
      const spaceIndex = fullName.indexOf(' ');
      if (spaceIndex > 0) {
        firstName = firstName || fullName.slice(0, spaceIndex).trim();
        lastName = lastName || fullName.slice(spaceIndex + 1).trim();
      } else {
        firstName = firstName || fullName;
        lastName = lastName || '-';
      }
    }

    const existingCustomer = state.customers.find(
      (c) =>
        (input.phone && c.phone && c.phone.trim() === input.phone.trim()) ||
        c.name.trim().toLowerCase() === fullName.toLowerCase()
    );
    const customerId = existingCustomer ? existingCustomer.id : nextUuid();

    let requiresIncoming = false;
    let expectedArrivalAt: string | null = null;
    for (const item of items) {
      const product = state.products.find((candidate) => candidate.id === item.productId)!;
      const physAvail = Math.max(0, product.onHand - product.reserved);
      item.packedQuantity = null;
      item.physicalReservedQuantity = stockSource === 'incoming_only' ? 0 : Math.min(item.quantity, physAvail);
      item.incomingQuantity = item.quantity - item.physicalReservedQuantity;
      item.uncoveredQuantity = 0;
      if (item.incomingQuantity > 0) {
        requiresIncoming = true;
        const pu = state.purchases.find(
          (p) => p.state === 'ordered' && p.items.some((i) => i.productId === item.productId)
        );
        if (pu?.expectedAt && (!expectedArrivalAt || pu.expectedAt > expectedArrivalAt)) {
          expectedArrivalAt = pu.expectedAt;
        }
      }
    }

    const newAllocations = new Map<string, Array<{ purchaseItemId: string; quantity: number; unitCostCents: number }>>();
    for (const item of items) {
      const product = state.products.find(p => p.id === item.productId)!;
      let remaining = item.incomingQuantity ?? 0;
      let itemCost = (item.physicalReservedQuantity ?? 0) * (product.currentCostCents ?? 0);
      const allocations: Array<{ purchaseItemId: string; quantity: number; unitCostCents: number }> = [];
      const purchases = state.purchases.filter(p => p.state === 'ordered').sort((a,b) =>
        (a.expectedAt ?? '9999').localeCompare(b.expectedAt ?? '9999') || (a.orderedAt ?? '').localeCompare(b.orderedAt ?? '') || a.id.localeCompare(b.id));
      for (const purchase of purchases) {
        for (const pi of purchase.items.filter(pi => pi.productId === item.productId)) {
          const reserved = [...state.incomingAllocations.values()].flat().filter(a => a.purchaseItemId === pi.id).reduce((sum,a) => sum+a.quantity, 0);
          const take = Math.min(remaining, Math.max(0, pi.quantity - pi.receivedQuantity - pi.shortageQuantity - reserved));
          if (take > 0) { allocations.push({purchaseItemId: pi.id, quantity: take, unitCostCents: pi.unitCostCents}); itemCost += take*pi.unitCostCents; remaining -= take; }
        }
      }
      if (remaining > 0) throw new AppError('business', 'No alcanzan las unidades libres de compras al proveedor.', {nextAction: 'Actualizá los productos y ajustá las cantidades.'});
      newAllocations.set(item.id, allocations);
      item.costTotalCents = itemCost;
      if (isCost && !isGift) { item.unitPriceCents = Math.round(itemCost / item.quantity); item.subtotalCents = itemCost; }
    }
    costTotalCents = items.reduce((sum,item) => sum + (item.costTotalCents ?? 0), 0);

    const order: Order = {
      id: nextUuid(),
      number,
      customerId,
      customerName: fullName,
      customerFirstName: firstName,
      customerLastName: lastName,
      customerPhone: input.phone ?? null,
      paymentMethod: input.paymentMethod,
      deliveryMethod: input.deliveryMethod,
      shippingType: input.shippingType,
      shippingAddress:
        input.deliveryMethod === 'shipping'
          ? `${input.address ?? ''}${input.addressNumber ? ` ${input.addressNumber}` : ''}`.trim()
          : null,
      orderState: 'confirmed',
      saleType: isCost ? 'cost' : isGift ? 'gift' : 'retail',
      isCostSale: isCost,
      paymentState: isGift ? 'gifted' : 'pending',
      preparationState: 'pending',
      fulfillmentState: 'pending',
      packingRevision: 0,
      packingTracked: false,
      stockSource,
      shippingFeeRevision: 0,
      shippingFeeMethod: 'catalog',
      shippingFeeBasisPoints: null,
      shippingFeeCostBaseCents: null,
      stockReadiness: requiresIncoming ? 'waiting_incoming' : 'ready',
      expectedArrivalAt,
      subtotalCents: isGift ? 0 : isCost ? costTotalCents : subtotalCents,
      shippingFeeCents: isGift ? 0 : input.shippingFeeCents,
      totalCents: isGift ? 0 : isCost ? costTotalCents + input.shippingFeeCents : subtotalCents + input.shippingFeeCents,
      taxRateBasisPoints: (isGift || isCost) ? 0 : state.settings.taxRateBasisPoints,
      taxAmountCents: (isGift || isCost) ? 0 : calculateBasisPoints(
        subtotalCents + input.shippingFeeCents,
        state.settings.taxRateBasisPoints ?? 0
      ),
      costTotalCents,
      createdAt: now,
      confirmedAt: now,
      paidAt: isGift ? now : null,
      fulfilledAt: null,
      items
    };
    for (const [id, allocations] of newAllocations) state.incomingAllocations.set(id, allocations);
    for (const item of items) {
      const product = state.products.find((candidate) => candidate.id === item.productId)!;
      const physical = item.physicalReservedQuantity ?? 0;
      const incoming = item.incomingQuantity ?? 0;
      product.reserved += physical;
      product.incomingReserved = (product.incomingReserved ?? 0) + incoming;
      refreshProductAvailability(product);
      if (physical > 0) state.movements.unshift({
        id: nextUuid(),
        productId: product.id,
        productName: product.name,
        kind: 'reservation',
        physicalDelta: 0,
        reservedDelta: physical,
        reason: `Pedido #${number} ${isGift ? 'registrado como cortesía' : 'confirmado'}`,
        orderId: order.id,
        purchaseId: null,
        createdAt: now,
        createdByName: demoStaff.displayName
      });
    }
    state.orders.unshift(order);
    if (input.protocolOrderId) state.importedProtocols.set(input.protocolOrderId, { orderId: order.id, fingerprint });
    if (existingCustomer) {
      existingCustomer.orderCount += 1;
      existingCustomer.lastOrderAt = now;
      existingCustomer.name = fullName;
      existingCustomer.firstName = firstName;
      existingCustomer.lastName = lastName;
      if (!existingCustomer.phone && input.phone) {
        existingCustomer.phone = input.phone;
      }
    } else {
      state.customers.unshift({
        id: customerId,
        name: order.customerName,
        firstName,
        lastName,
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

  async updateOrderItems(input) {
    if (
      !input ||
      !input.orderId ||
      !input.operationId ||
      !Number.isInteger(input.expectedActionRevision) ||
      input.expectedActionRevision < 0 ||
      !Array.isArray(input.items) ||
      input.items.length === 0
    ) {
      throw new AppError('validation', 'El pedido tiene datos incompletos.', {
        nextAction: 'Revisá los productos y cantidades del pedido.'
      });
    }
    if (
      new Set(input.items.map(i => i.productId)).size !== input.items.length ||
      input.items.some(i => !i.productId || !Number.isInteger(i.quantity) || i.quantity <= 0)
    ) {
      throw new AppError('validation', 'La cantidad del producto no es válida.', {
        nextAction: 'Ingresá una cantidad entera mayor que cero.'
      });
    }

    const editFingerprint = JSON.stringify({
      orderId: input.orderId,
      expectedActionRevision: input.expectedActionRevision,
      items: [...input.items]
        .map(item => ({ productId: item.productId, quantity: item.quantity }))
        .sort((a, b) => a.productId.localeCompare(b.productId))
    });

    const previousOp = state.orderEditOperations.get(input.operationId);
    if (previousOp) {
      if (
        previousOp.orderId !== input.orderId ||
        previousOp.revision !== input.expectedActionRevision ||
        previousOp.fingerprint !== editFingerprint
      ) {
        throw new AppError('business', 'Los datos cambiaron respecto del intento anterior.', {
          nextAction: 'Revisá si la operación ya aparece en Pedidos o Compras antes de iniciar otra.'
        });
      }
      const existingOrder = state.orders.find(o => o.id === input.orderId);
      return latency(existingOrder ?? previousOp.result);
    }

    const order = state.orders.find(o => o.id === input.orderId);
    if (!order) {
      throw new AppError('business', 'No encontramos ese pedido.', {
        nextAction: 'Actualizá la lista de Pedidos y volvé a buscarlo.'
      });
    }
    if (order.orderState !== 'confirmed') {
      throw new AppError('business', 'Ese paso ya no está disponible.', {
        nextAction: 'Actualizá la vista para ver el estado actual.'
      });
    }
    if (order.fulfillmentState !== 'pending') {
      throw new AppError('business', 'La mercadería ya salió del local.', {
        nextAction: 'En Pedidos, deshacé la entrega o el envío antes de modificar los productos.'
      });
    }
    if (order.paymentState !== 'pending') {
      throw new AppError('business', 'El pedido figura cobrado y no se pueden modificar sus productos.', {
        nextAction: 'En Pedidos, usá Deshacer cobro primero si necesitás editarlo.'
      });
    }

    const isNoop =
      order.items.length === input.items.length &&
      input.items.every(req =>
        order.items.some(existing => existing.productId === req.productId && existing.quantity === req.quantity)
      );

    if ((order.actionRevision ?? 0) !== input.expectedActionRevision) {
      if (isNoop) return latency(order);
      throw new AppError('business', 'El pedido cambió desde que abriste la confirmación.', {
        nextAction: 'Cerrá la confirmación y revisá el estado actualizado antes de continuar.'
      });
    }
    if (isNoop) return latency(order);

    // 1. Validate all products exist, packing constraints, and stock availability before mutating
    for (const existingItem of order.items) {
      const reqQty = input.items.find(i => i.productId === existingItem.productId)?.quantity ?? 0;
      if (reqQty < (existingItem.packedQuantity ?? 0)) {
        throw new AppError('business', 'Hay más unidades guardadas en la bolsita que la cantidad elegida.', {
          nextAction: 'Desarmá primero esas unidades en la bolsita del pedido o mantené al menos esa cantidad.'
        });
      }
    }

    const freePurchaseCapacity = (productId: string) => {
      let totalFree = 0;
      for (const purchase of state.purchases.filter(p => p.state === 'ordered')) {
        for (const pi of purchase.items.filter(i => i.productId === productId)) {
          const reserved = [...state.incomingAllocations.values()]
            .flat()
            .filter(a => a.purchaseItemId === pi.id)
            .reduce((sum, a) => sum + a.quantity, 0);
          totalFree += Math.max(0, pi.quantity - (pi.receivedQuantity ?? 0) - (pi.shortageQuantity ?? 0) - reserved);
        }
      }
      return totalFree;
    };

    for (const reqItem of input.items) {
      const product = state.products.find(p => p.id === reqItem.productId);
      if (!product) {
        throw new AppError('business', 'Uno de los productos ya no está disponible.', {
          nextAction: 'Actualizá la pantalla y revisá la selección.'
        });
      }
      const oldQty = order.items.find(i => i.productId === reqItem.productId)?.quantity ?? 0;
      if (reqItem.quantity > oldQty) {
        if (!product.active) {
          throw new AppError('business', 'Uno de los productos ya no está disponible.', {
            nextAction: 'Actualizá la pantalla y revisá la selección.'
          });
        }
        const deltaAdd = reqItem.quantity - oldQty;
        const physAvail = order.stockSource === 'incoming_only' ? 0 : Math.max(0, product.onHand - product.reserved);
        const takePhys = Math.min(deltaAdd, physAvail);
        const needIncoming = deltaAdd - takePhys;
        if (needIncoming > 0) {
          const explicitFree = freePurchaseCapacity(product.id);
          const fallbackFree = Math.max(0, product.incoming - (product.incomingReserved ?? 0));
          const availableIncoming = state.purchases.some(p => p.state === 'ordered' && p.items.some(i => i.productId === product.id))
            ? explicitFree
            : fallbackFree;
          if (availableIncoming < needIncoming) {
            if (order.stockSource === 'incoming_only') {
              throw new AppError('business', 'No alcanzan las unidades libres de compras al proveedor.', {
                nextAction: 'Actualizá los productos y ajustá las cantidades; esta modalidad no usa el stock libre del local.'
              });
            }
            throw new AppError('business', 'El stock cambió y ya no alcanza para ese pedido.', {
              nextAction: 'Revisá las cantidades disponibles antes de confirmarlo.'
            });
          }
        }
      }
    }

    const beforeSnapshot = structuredClone(order);
    const now = new Date().toISOString();
    const wasPackingTracked = Boolean(
      order.packingTracked || order.items.some(i => i.packedQuantity !== null && i.packedQuantity !== undefined)
    );
    const productsToReconcile = new Set<string>();

    // Phase 1: Process decreases and removals
    for (const existingItem of [...order.items]) {
      const reqQty = input.items.find(i => i.productId === existingItem.productId)?.quantity ?? 0;
      if (reqQty < existingItem.quantity) {
        let toRelease = existingItem.quantity - reqQty;
        const product = state.products.find(p => p.id === existingItem.productId)!;

        // 1a) Release uncovered first
        const relUncovered = Math.min(toRelease, existingItem.uncoveredQuantity ?? 0);
        existingItem.uncoveredQuantity = (existingItem.uncoveredQuantity ?? 0) - relUncovered;
        toRelease -= relUncovered;

        // 1b) Release incoming next (LIFO: latest expected purchase first)
        const relIncoming = Math.min(toRelease, existingItem.incomingQuantity ?? 0);
        if (relIncoming > 0) {
          let remInc = relIncoming;
          const allocations = state.incomingAllocations.get(existingItem.id) ?? [];
          const sortedAllocations = [...allocations].sort((a, b) => {
            const pA = state.purchases.find(p => p.items.some(i => i.id === a.purchaseItemId));
            const pB = state.purchases.find(p => p.items.some(i => i.id === b.purchaseItemId));
            const expA = pA?.expectedAt ?? '9999-99-99';
            const expB = pB?.expectedAt ?? '9999-99-99';
            return expB.localeCompare(expA) || (pB?.orderedAt ?? '').localeCompare(pA?.orderedAt ?? '');
          });
          for (const alloc of sortedAllocations) {
            if (remInc <= 0) break;
            const take = Math.min(remInc, alloc.quantity);
            alloc.quantity -= take;
            remInc -= take;
          }
          existingItem.incomingQuantity = (existingItem.incomingQuantity ?? 0) - relIncoming;
          product.incomingReserved = Math.max(0, (product.incomingReserved ?? 0) - relIncoming);
          toRelease -= relIncoming;
        }

        // 1c) Release physical last
        const relPhysical = toRelease;
        if (relPhysical > 0) {
          existingItem.physicalReservedQuantity = Math.max(
            0,
            (existingItem.physicalReservedQuantity ?? existingItem.quantity) - relPhysical
          );
          product.reserved = Math.max(0, product.reserved - relPhysical);
          productsToReconcile.add(product.id);
          state.movements.unshift({
            id: nextUuid(),
            productId: product.id,
            productName: product.name,
            kind: 'reservation_release',
            physicalDelta: 0,
            reservedDelta: -relPhysical,
            reason: `Edición de pedido #${order.number}: reducción de cantidad`,
            orderId: order.id,
            purchaseId: null,
            createdAt: now,
            createdByName: demoOwner.displayName
          });
        }

        refreshProductAvailability(product);

        if (reqQty === 0) {
          state.incomingAllocations.delete(existingItem.id);
          order.items = order.items.filter(i => i.id !== existingItem.id);
        } else {
          existingItem.quantity = reqQty;
          const remAllocs = (state.incomingAllocations.get(existingItem.id) ?? []).filter(a => a.quantity > 0);
          const allocCost = remAllocs.reduce((sum, a) => sum + a.quantity * a.unitCostCents, 0);
          const allocUnits = remAllocs.reduce((sum, a) => sum + a.quantity, 0);
          const unlinkedInc = Math.max(0, (existingItem.incomingQuantity ?? 0) - allocUnits);
          const unitCostFallback = existingItem.unitCostCents ?? product.currentCostCents ?? 0;
          const newCostTotal =
            allocCost +
            unlinkedInc * unitCostFallback +
            (existingItem.physicalReservedQuantity ?? 0) * unitCostFallback +
            (existingItem.uncoveredQuantity ?? 0) * unitCostFallback;
          existingItem.costTotalCents = newCostTotal;
          existingItem.unitCostCents =
            newCostTotal > 0 ? Math.round(newCostTotal / reqQty) : existingItem.unitCostCents ?? product.currentCostCents;
          if (order.saleType === 'cost') {
            existingItem.unitPriceCents = existingItem.unitCostCents ?? 0;
            existingItem.subtotalCents = existingItem.unitPriceCents * reqQty;
          } else if (order.saleType === 'gift') {
            existingItem.unitPriceCents = 0;
            existingItem.subtotalCents = 0;
          } else {
            existingItem.subtotalCents = existingItem.unitPriceCents * reqQty;
          }
        }
      }
    }

    // Phase 2: Process additions and increases
    let anyAddedOrIncreased = false;
    let addedItemWithPackingTracked = false;

    for (const reqItem of input.items) {
      const product = state.products.find(p => p.id === reqItem.productId)!;
      const existingLine = order.items.find(i => i.productId === reqItem.productId);
      const oldQty = existingLine ? existingLine.quantity : 0;

      if (reqItem.quantity > oldQty) {
        anyAddedOrIncreased = true;
        const deltaAdd = reqItem.quantity - oldQty;
        const physAvail = order.stockSource === 'incoming_only' ? 0 : Math.max(0, product.onHand - product.reserved);
        const takePhys = Math.min(deltaAdd, physAvail);
        const needIncoming = deltaAdd - takePhys;

        let remInc = needIncoming;
        let addedIncomingCost = 0;
        const addedAllocations: Array<{ purchaseItemId: string; quantity: number; unitCostCents: number }> = [];

        if (needIncoming > 0) {
          const orderedPurchases = state.purchases
            .filter(p => p.state === 'ordered')
            .sort(
              (a, b) =>
                (a.expectedAt ?? '9999').localeCompare(b.expectedAt ?? '9999') ||
                (a.orderedAt ?? '').localeCompare(b.orderedAt ?? '') ||
                a.id.localeCompare(b.id)
            );
          for (const purchase of orderedPurchases) {
            for (const pi of purchase.items.filter(i => i.productId === product.id)) {
              if (remInc <= 0) break;
              const reserved = [...state.incomingAllocations.values()]
                .flat()
                .filter(a => a.purchaseItemId === pi.id)
                .reduce((sum, a) => sum + a.quantity, 0);
              const free = Math.max(0, pi.quantity - (pi.receivedQuantity ?? 0) - (pi.shortageQuantity ?? 0) - reserved);
              const take = Math.min(remInc, free);
              if (take > 0) {
                addedAllocations.push({ purchaseItemId: pi.id, quantity: take, unitCostCents: pi.unitCostCents });
                addedIncomingCost += take * pi.unitCostCents;
                remInc -= take;
              }
            }
          }
          if (remInc > 0) {
            addedIncomingCost += remInc * (product.currentCostCents ?? 0);
          }
        }

        const addedPhysCost = takePhys * (product.currentCostCents ?? 0);

        if (!existingLine) {
          const initPacked = wasPackingTracked ? 0 : null;
          if (wasPackingTracked) addedItemWithPackingTracked = true;
          const newCostTotal = addedPhysCost + addedIncomingCost;
          const newUnitCost =
            product.currentCostCents !== null || addedIncomingCost > 0
              ? Math.round(newCostTotal / reqItem.quantity)
              : null;
          const newUnitPrice =
            order.saleType === 'gift'
              ? 0
              : order.saleType === 'cost'
                ? (newUnitCost ?? 0)
                : product.priceCents;
          const newLine: OrderItem = {
            id: nextUuid(),
            productId: product.id,
            sku: product.sku,
            productName: product.name,
            presentation: product.presentation,
            quantity: reqItem.quantity,
            packedQuantity: initPacked,
            physicalReservedQuantity: takePhys,
            incomingQuantity: needIncoming,
            uncoveredQuantity: 0,
            unitPriceCents: newUnitPrice,
            unitCostCents: newUnitCost,
            costTotalCents: newCostTotal,
            subtotalCents: newUnitPrice * reqItem.quantity
          };
          order.items.push(newLine);
          state.incomingAllocations.set(newLine.id, addedAllocations);
        } else {
          existingLine.quantity = reqItem.quantity;
          existingLine.physicalReservedQuantity = (existingLine.physicalReservedQuantity ?? 0) + takePhys;
          existingLine.incomingQuantity = (existingLine.incomingQuantity ?? 0) + needIncoming;
          const currentAllocs = state.incomingAllocations.get(existingLine.id) ?? [];
          for (const addAlloc of addedAllocations) {
            const match = currentAllocs.find(a => a.purchaseItemId === addAlloc.purchaseItemId && a.unitCostCents === addAlloc.unitCostCents);
            if (match) match.quantity += addAlloc.quantity;
            else currentAllocs.push(addAlloc);
          }
          state.incomingAllocations.set(existingLine.id, currentAllocs);

          const prevCostTotal = existingLine.costTotalCents ?? (existingLine.unitCostCents ?? 0) * oldQty;
          const newCostTotal = prevCostTotal + addedPhysCost + addedIncomingCost;
          existingLine.costTotalCents = newCostTotal;
          existingLine.unitCostCents =
            existingLine.unitCostCents !== null || product.currentCostCents !== null || addedIncomingCost > 0
              ? Math.round(newCostTotal / reqItem.quantity)
              : null;
          if (order.saleType === 'cost') {
            existingLine.unitPriceCents = existingLine.unitCostCents ?? 0;
            existingLine.subtotalCents = existingLine.unitPriceCents * reqItem.quantity;
          } else if (order.saleType === 'gift') {
            existingLine.unitPriceCents = 0;
            existingLine.subtotalCents = 0;
          } else {
            existingLine.subtotalCents = existingLine.unitPriceCents * reqItem.quantity;
          }
        }

        product.reserved += takePhys;
        product.incomingReserved = (product.incomingReserved ?? 0) + needIncoming;
        refreshProductAvailability(product);

        if (takePhys > 0) {
          state.movements.unshift({
            id: nextUuid(),
            productId: product.id,
            productName: product.name,
            kind: 'reservation',
            physicalDelta: 0,
            reservedDelta: takePhys,
            reason: `Edición de pedido #${order.number}: reserva física`,
            orderId: order.id,
            purchaseId: null,
            createdAt: now,
            createdByName: demoOwner.displayName
          });
        }
      }
    }

    // Phase 3: Recalculate order header totals, readiness, preparation state, and revisions
    const costTotalCents = order.items.reduce(
      (sum, item) => sum + (item.costTotalCents ?? (item.unitCostCents ?? 0) * item.quantity),
      0
    );
    order.costTotalCents = costTotalCents;
    order.shippingFeeNeedsReview = shippingFeeNeedsReview({ ...order, shippingFeeNeedsReview: false });

    if (order.saleType === 'gift') {
      order.subtotalCents = 0;
      order.shippingFeeCents = 0;
      order.totalCents = 0;
      order.taxAmountCents = 0;
    } else if (order.saleType === 'cost') {
      order.subtotalCents = costTotalCents;
      order.totalCents = costTotalCents + order.shippingFeeCents;
      order.taxAmountCents = 0;
    } else {
      const subtotalCents = order.items.reduce((sum, item) => sum + item.subtotalCents, 0);
      order.subtotalCents = subtotalCents;
      order.totalCents = subtotalCents + order.shippingFeeCents;
      order.taxAmountCents = calculateBasisPoints(order.totalCents, order.taxRateBasisPoints ?? 0);
    }

    const hasUncovered = order.items.some(i => (i.uncoveredQuantity ?? 0) > 0);
    const hasIncoming = order.items.some(i => (i.incomingQuantity ?? 0) > 0);
    order.stockReadiness = hasUncovered ? 'uncovered' : hasIncoming ? 'waiting_incoming' : 'ready';

    if (hasIncoming) {
      const arrivalDates = order.items.flatMap(line =>
        (state.incomingAllocations.get(line.id) ?? [])
          .filter(a => a.quantity > 0)
          .flatMap(a =>
            state.purchases
              .filter(p => p.state === 'ordered' && p.items.some(i => i.id === a.purchaseItemId))
              .map(p => p.expectedAt)
              .filter((d): d is string => Boolean(d))
          )
      );
      order.expectedArrivalAt = arrivalDates.sort().at(-1) ?? null;
    } else {
      order.expectedArrivalAt = null;
    }

    const hasNonPhysical = hasUncovered || hasIncoming;
    const allPacked = wasPackingTracked && order.items.every(i => (i.packedQuantity ?? 0) === i.quantity);
    const anyPacked = order.items.some(i => (i.packedQuantity ?? 0) > 0);

    if (hasNonPhysical) {
      order.preparationState = anyPacked ? 'preparing' : 'pending';
    } else if (wasPackingTracked) {
      order.preparationState =
        order.preparationState === 'ready' && allPacked
          ? 'ready'
          : anyPacked
            ? 'preparing'
            : 'pending';
    } else if (order.preparationState === 'ready' && anyAddedOrIncreased) {
      order.preparationState = 'pending';
    }

    order.packingTracked = wasPackingTracked;
    if (addedItemWithPackingTracked) {
      order.packingRevision = (order.packingRevision ?? 0) + 1;
    }
    order.actionRevision = (order.actionRevision ?? 0) + 1;

    for (const prodId of productsToReconcile) {
      const prod = state.products.find(p => p.id === prodId);
      if (prod) reconcileDemoProduct(prod);
    }

    const updatedSnapshot = structuredClone(order);
    state.reversalHistory.push({
      operationId: input.operationId,
      orderId: order.id,
      action: 'edit_items',
      previous: beforeSnapshot,
      current: updatedSnapshot,
      createdAt: now,
      createdByName: demoOwner.displayName
    });
    state.orderEditOperations.set(input.operationId, {
      orderId: order.id,
      revision: input.expectedActionRevision,
      fingerprint: editFingerprint,
      result: updatedSnapshot
    });
    state.revision += 1;
    return latency(order);
  },

  async saveOrderShippingFee(input) {
    const payload = JSON.stringify(input);
    const previous = state.shippingFeeOperations.get(input.operationId);
    if (previous) {
      if (previous.input !== payload) throw new AppError('business', 'Este intento ya se usó con otros datos.');
      return latency(state.orders.find(o => o.id === previous.orderId)!);
    }
    const order = state.orders.find(o => o.id === input.orderId);
    if (!order) throw new AppError('business', 'No encontramos ese pedido.');
    if (order.paymentState !== 'pending' || order.orderState === 'cancelled' || order.saleType === 'gift') throw new AppError('business', 'El envío solo puede cambiarse antes del cobro.');
    if ((order.shippingFeeRevision ?? 0) !== input.expectedRevision) throw new AppError('business', 'El envío cambió mientras lo estabas editando.');
    let amount: number;
    if (input.method === 'percentage') {
      if (input.expectedCostCents !== order.costTotalCents) throw new AppError('business', 'El costo de los productos cambió. Revisá el porcentaje antes de cobrar.');
      amount = percentageShippingCents(order.costTotalCents ?? 0, input.basisPoints!);
    } else if (input.method === 'manual') { amount = input.amountCents!; validateShippingCents(amount); }
    else throw new AppError('validation', 'Elegí cómo calcular el envío.');
    const snapshot = () => ({amountCents: order.shippingFeeCents, method: order.shippingFeeMethod ?? 'catalog',
      basisPoints: order.shippingFeeBasisPoints ?? null, costBaseCents: order.shippingFeeCostBaseCents ?? null, revision: order.shippingFeeRevision ?? 0});
    const before = snapshot();
    order.shippingFeeCents = amount;
    order.shippingFeeMethod = input.method;
    order.shippingFeeBasisPoints = input.method === 'percentage' ? input.basisPoints! : null;
    order.shippingFeeCostBaseCents = input.method === 'percentage' ? input.expectedCostCents! : null;
    order.shippingFeeRevision = (order.shippingFeeRevision ?? 0) + 1;
    order.actionRevision = (order.actionRevision ?? 0) + 1;
    order.totalCents = order.subtotalCents + amount;
    order.taxAmountCents = order.saleType === 'cost' ? 0 : calculateBasisPoints(order.totalCents, order.taxRateBasisPoints ?? 0);
    state.shippingFeeHistory.push({id: nextUuid(), operationId: input.operationId, orderId: order.id, input: {...input}, previous: before, current: snapshot(), createdAt: new Date().toISOString(), createdByName: 'Dueña demo'});
    state.shippingFeeOperations.set(input.operationId, { input: payload, orderId: order.id });
    state.revision += 1;
    return latency(order);
  },

  async transitionOrder(orderId, action, expected) {
    const order = state.orders.find((candidate) => candidate.id === orderId);
    if (!order) throw new AppError('business', 'No encontramos el pedido.');
    if (isOrderReversal(action)) {
      if (!expected || !('operationId' in expected)) throw new AppError('business', 'Volvé a abrir la acción desde Pedidos para confirmar sus efectos.');
      const previous = state.reversalOperations.get(expected.operationId);
      if (previous) {
        if (previous.orderId !== orderId || previous.action !== action || previous.revision !== expected.actionRevision) {
          throw new AppError('business', 'Los datos cambiaron respecto del intento anterior.');
        }
        return latency(order);
      }
      if ((order.actionRevision ?? 0) !== expected.actionRevision) throw new AppError('business', 'El pedido cambió desde que abriste la confirmación.', { nextAction: 'Cerrá la confirmación y revisá el estado actualizado antes de continuar.' });
      if (!availableOrderActions(order).includes(action)) throw new AppError('business', 'Ese paso ya no está disponible para el pedido.');
      const before = structuredClone(order);
      const returnsStock = action === 'reverse_shipment' || (action === 'reverse_delivery' && !order.shippedAt);
      const products = returnsStock ? order.items.map(item => {
        const product = state.products.find(candidate => candidate.id === item.productId);
        if (!product) throw new AppError('business', 'Las reservas de este pedido necesitan una revisión.');
        return { item, product };
      }) : [];
      const now = new Date().toISOString();
      if (action === 'reverse_payment') {
        order.paymentState = 'pending';
        order.paidAt = null;
        const customer = state.customers.find(candidate => candidate.id === order.customerId);
        if (customer && customer.totalPaidCents !== null) customer.totalPaidCents = Math.max(0, customer.totalPaidCents - order.totalCents);
      } else {
        for (const { item, product } of products) {
          product.onHand += item.quantity;
          product.reserved += item.quantity;
          item.physicalReservedQuantity = item.quantity;
          item.incomingQuantity = 0;
          item.uncoveredQuantity = 0;
          refreshProductAvailability(product);
          state.movements.unshift({ id: nextUuid(), productId: product.id, productName: product.name,
            kind: 'return', physicalDelta: item.quantity, reservedDelta: item.quantity,
            reason: `Pedido #${order.number}: ${action === 'reverse_shipment' ? 'envío' : 'entrega'} deshecho; mercadería de regreso y reservada`,
            orderId: order.id, purchaseId: null, createdAt: now, createdByName: demoStaff.displayName });
        }
        order.fulfillmentState = returnsStock ? 'pending' : 'shipped';
        order.fulfilledAt = null;
        if (returnsStock) { order.shippedAt = null; order.stockReadiness = 'ready'; }
      }
      order.actionRevision = (order.actionRevision ?? 0) + 1;
      state.reversalHistory.push({ operationId: expected.operationId, orderId, action, previous: before,
        current: structuredClone(order), createdAt: now, createdByName: demoStaff.displayName });
      state.reversalOperations.set(expected.operationId, { orderId, action, revision: expected.actionRevision });
      state.revision += 1;
      return latency(order);
    }
    if (expected && 'actionRevision' in expected && expected.actionRevision !== undefined &&
      expected.actionRevision !== (order.actionRevision ?? 0)) {
      throw new AppError('business', 'El pedido cambió desde que abriste la confirmación.', {
        nextAction: 'Cerrá la confirmación y revisá el estado actualizado antes de continuar.'
      });
    }

    if (action === 'mark_gifted' && order.paymentState === 'gifted') return latency(order);
    if (action === 'cancel' && order.orderState === 'cancelled') return latency(order);

    const lacksPhysicalReservation = order.items.some(item =>
      (item.incomingQuantity ?? 0) > 0 || (item.uncoveredQuantity ?? 0) > 0
    );
    const leavesLocalStock = action === 'mark_shipped' ||
      (action === 'mark_delivered' && order.fulfillmentState === 'pending') ||
      (action === 'mark_gifted' && order.fulfillmentState === 'pending');
    if ((action === 'mark_ready' || leavesLocalStock) && lacksPhysicalReservation) {
      throw new AppError('business', 'A este pedido todavía le faltan unidades físicas.', {
        nextAction: 'Recibí la compra o resolvé el faltante antes de prepararlo o entregarlo.'
      });
    }

    const hasKnownPacking = order.items.some(item => item.packedQuantity !== null && item.packedQuantity !== undefined);
    const packingComplete = order.items.every(item => item.packedQuantity === item.quantity);
    const compatibilityOrder = { ...order };
    if (!hasKnownPacking) delete compatibilityOrder.packingTracked;
    const exitsNow = action === 'mark_ready' || action === 'mark_shipped' ||
      (action === 'mark_delivered' && order.fulfillmentState === 'pending') ||
      (action === 'mark_gifted' && order.fulfillmentState === 'pending');
    if (exitsNow && hasKnownPacking && !packingComplete) {
      throw new AppError('business', 'Todavía faltan productos por preparar en este pedido.', {
        nextAction: 'Revisá la bolsita y registrá todas las unidades antes de continuar.'
      });
    }
    if (action === 'cancel' && order.items.some(item => (item.packedQuantity ?? 0) > 0)) {
      throw new AppError('business', 'El pedido tiene productos guardados en una bolsita.', {
        nextAction: 'Devolvelos al estante y registrá cero unidades guardadas antes de cancelarlo.'
      });
    }

    if (action === 'mark_gifted') {
      if (order.orderState === 'cancelled' || order.paymentState !== 'pending') {
        throw new AppError('business', 'Este pedido ya no se puede regalar.', {
          nextAction: 'Solo se pueden regalar pedidos con cobro pendiente que no hayan sido pagados ni cancelados.'
        });
      }
    } else if (action === 'mark_at_cost') {
      if (order.saleType === 'cost' && order.paymentState === 'paid') {
        return latency(order);
      }
      if (order.orderState === 'cancelled' || order.paymentState !== 'pending') {
        throw new AppError('business', 'Este pedido ya no se puede cobrar al costo.', {
          nextAction: 'Solo se pueden cobrar al costo pedidos con cobro pendiente que no hayan sido pagados ni cancelados.'
        });
      }
    } else if (!availableOrderActions(compatibilityOrder).includes(action)) {
      throw new AppError('business', 'Ese paso ya no está disponible para el pedido.', {
        nextAction: 'Actualizá la lista para ver su estado actual.'
      });
    }

    if (expected && 'shippingFeeRevision' in expected && ['mark_paid','mark_at_cost','mark_gifted'].includes(action) && ((order.shippingFeeRevision ?? 0) !== expected.shippingFeeRevision || (order.paymentState === 'pending' && order.totalCents !== expected.totalCents) || (['mark_at_cost','mark_gifted'].includes(action) && order.costTotalCents !== expected.costTotalCents))) throw new AppError('business', 'El importe del pedido cambió desde que abriste la confirmación.', {nextAction:'Cerrá la confirmación y revisá el total actualizado antes de cobrar o regalar.'});
    const now = new Date().toISOString();
    if (['mark_paid', 'mark_at_cost'].includes(action) && shippingFeeNeedsReview(order)) throw new AppError('business', 'El costo de los productos cambió. Revisá el porcentaje antes de cobrar.');
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
    if (action === 'mark_at_cost') {
      for (const item of order.items) {
        const cost = item.unitCostCents ?? 0;
        item.unitPriceCents = cost;
        item.subtotalCents = item.costTotalCents ?? cost * item.quantity;
      }
      order.saleType = 'cost';
      order.isCostSale = true;
      order.subtotalCents = order.costTotalCents ?? 0;
      order.totalCents = (order.costTotalCents ?? 0) + (order.shippingFeeCents ?? 0);
      order.taxAmountCents = 0;
      order.paymentState = 'paid';
      order.paidAt = order.paidAt ?? now;

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

      const wasPendingFulfillment = order.fulfillmentState === 'pending';
      order.paymentState = 'gifted';
      order.paymentMethod = 'gift';
      order.fulfillmentState = 'delivered';
      order.preparationState = 'ready';
      order.orderState = 'confirmed';
      order.totalCents = 0;
      order.subtotalCents = 0;
      order.taxAmountCents = 0;
      const giftFeeBefore = {amountCents: order.shippingFeeCents, method: order.shippingFeeMethod ?? 'catalog', basisPoints: order.shippingFeeBasisPoints ?? null, costBaseCents: order.shippingFeeCostBaseCents ?? null, revision: order.shippingFeeRevision ?? 0};
      order.shippingFeeCents = 0;
      order.shippingFeeMethod = 'manual';
      order.shippingFeeBasisPoints = null;
      order.shippingFeeCostBaseCents = null;
      order.shippingFeeRevision = (order.shippingFeeRevision ?? 0) + 1;
      if (giftFeeBefore.amountCents > 0 || giftFeeBefore.method !== 'catalog') state.shippingFeeHistory.push({id: nextUuid(), operationId: nextUuid(), orderId: order.id, input:{action:'mark_gifted'}, previous: giftFeeBefore, current: {amountCents:0,method:'manual',basisPoints:null,costBaseCents:null,revision:order.shippingFeeRevision}, createdAt:now, createdByName:'Dueña demo'});
      order.paidAt = now;
      order.fulfilledAt = now;

      if (wasPendingFulfillment) {
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
    }
    if (action === 'start_preparing') {
      if (order.orderState === 'cancelled' || order.fulfillmentState !== 'pending') {
        throw new AppError('business', 'Transición inválida para este pedido.');
      }
      order.preparationState = 'preparing';
    }
    if (action === 'mark_ready') {
      if (order.orderState === 'cancelled' || order.fulfillmentState !== 'pending') {
        throw new AppError('business', 'Transición inválida para este pedido.');
      }
      if (lacksPhysicalReservation) {
        throw new AppError('business', 'No se puede marcar como listo un pedido en espera de mercadería.');
      }
      order.preparationState = 'ready';
    }
    if (action === 'mark_shipped' || action === 'mark_delivered') {
      if (lacksPhysicalReservation) {
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
      if (action === 'mark_shipped') order.shippedAt = now;
    }
    if (action === 'cancel') {
      for (const item of order.items) for (const allocation of state.incomingAllocations.get(item.id) ?? []) allocation.quantity = 0;
      order.orderState = 'cancelled';
      if (order.paymentState === 'paid' || order.paymentState === 'gifted') order.paymentState = 'refunded';
      order.fulfillmentState = 'cancelled';
      for (const item of order.items) {
        const product = state.products.find((candidate) => candidate.id === item.productId)!;
        const physical = item.physicalReservedQuantity ?? item.quantity;
        product.reserved = Math.max(0, product.reserved - physical);
        product.incomingReserved = Math.max(0, (product.incomingReserved ?? 0) - (item.incomingQuantity ?? 0));
        refreshProductAvailability(product);
        if (physical > 0) state.movements.unshift({
          id: nextUuid(),
          productId: product.id,
          productName: product.name,
          kind: 'reservation_release',
          physicalDelta: 0,
          reservedDelta: -physical,
          reason: `Pedido #${order.number} cancelado`,
          orderId: order.id,
          purchaseId: null,
          createdAt: now,
          createdByName: demoStaff.displayName
        });
      }
    }
    order.actionRevision = (order.actionRevision ?? 0) + 1;
    if (action === 'cancel') for (const item of order.items) reconcileDemoProduct(state.products.find(p => p.id === item.productId)!);
    state.revision += 1;
    return latency(order);
  },

  async saveOrderPacking(orderId, items, expectedRevision) {
    const order = state.orders.find(candidate => candidate.id === orderId);
    if (!order) throw new AppError('business', 'No encontramos ese pedido.');
    if (order.orderState !== 'confirmed' || order.fulfillmentState !== 'pending') {
      throw new AppError('business', 'El armado de este pedido ya no se puede modificar.');
    }
    if ((order.packingRevision ?? 0) !== expectedRevision) {
      throw new AppError('business', 'Otra persona actualizó el armado de este pedido.');
    }
    const unique = new Set(items.map(item => item.orderItemId));
    if (items.length !== order.items.length || unique.size !== items.length ||
      items.some(item => !Number.isInteger(item.packedQuantity) || item.packedQuantity < 0 ||
        !order.items.some(line => line.id === item.orderItemId &&
          item.packedQuantity <= line.quantity &&
          item.packedQuantity <= (line.physicalReservedQuantity ?? line.quantity)))) {
      throw new AppError('business', 'Revisá las cantidades guardadas de cada producto.');
    }
    const changed = items.some(item => order.items.find(line => line.id === item.orderItemId)?.packedQuantity !== item.packedQuantity);
    if (!changed) return latency(order);
    for (const item of items) {
      const line = order.items.find(candidate => candidate.id === item.orderItemId)!;
      line.packedQuantity = item.packedQuantity;
    }
    order.packingTracked = true;
    order.packingRevision = (order.packingRevision ?? 0) + 1;
    order.actionRevision = (order.actionRevision ?? 0) + 1;
    const allFull = order.items.every(item => item.packedQuantity === item.quantity);
    const anyPacked = order.items.some(item => (item.packedQuantity ?? 0) > 0);
    order.preparationState = order.preparationState === 'ready' && allFull
      ? 'ready' : anyPacked ? 'preparing' : 'pending';
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
      cancelledTotal: all.filter((p) => p.state === 'cancelled').length,
      filteredTotal: filtered.length
    });
  },

  async getPurchaseCancellationPreview(purchaseId) {
    return latency(purchaseCancellationPreview(purchaseId));
  },

  async cancelPurchase(input) {
    const request = JSON.stringify({ ...input, reason: input.reason.trim() });
    const existing = state.shortageOperations.get(input.operationId);
    if (existing) {
      if (existing.request !== request) throw new AppError('business', 'Esta confirmación ya se usó con otros datos.');
      return latency(structuredClone(existing.result as PurchaseCancellationResult));
    }
    if (!input.operationId || countCharacters(input.reason.trim()) < 3 || countCharacters(input.reason.trim()) > 500) {
      throw new AppError('validation', 'Escribí un motivo de entre 3 y 500 caracteres.');
    }
    const preview = purchaseCancellationPreview(input.purchaseId);
    if (preview.reviewToken !== input.expectedToken) {
      throw new AppError('business', 'La compra o sus reservas cambiaron desde que las revisaste.', {
        nextAction: 'Actualizá la revisión antes de confirmar otra vez.'
      });
    }
    if (input.replacement && (countCharacters(input.replacement.supplierName.trim()) < 2 || countCharacters(input.replacement.supplierName.trim()) > 120)) {
      throw new AppError('validation', 'Escribí el nombre del nuevo proveedor.');
    }
    if (!(input.replacement ? preview.canReplace : preview.canCancel)) throw new AppError('business', 'Esta compra todavía no se puede cancelar.', {
      nextAction: 'Resolvé las reservas pendientes de los clientes y volvé a revisar.'
    });
    const purchase = state.purchases.find(p => p.id === input.purchaseId)!;
    const replacementPurchase = input.replacement ? createPurchaseRecord({ ...input.replacement, notes: `Reposición del saldo de compra #${purchase.number} · ${input.reason.trim()}`, items: preview.replacementItems }) : null;
    let transferredReservations = 0;
    let transferredUnits = 0;
    if (replacementPurchase) for (const order of state.orders.filter(o => o.orderState !== 'cancelled' && o.fulfillmentState === 'pending')) {
      for (const line of order.items) {
        for (const allocation of state.incomingAllocations.get(line.id) ?? []) {
          if (allocation.quantity <= 0 || !purchase.items.some(i => i.id === allocation.purchaseItemId)) continue;
          allocation.purchaseItemId = replacementPurchase.items.find(i => i.productId === line.productId)!.id;
          transferredReservations += 1;
          transferredUnits += allocation.quantity;
          const recovered = Math.min(line.uncoveredQuantity ?? 0, allocation.quantity);
          line.uncoveredQuantity = (line.uncoveredQuantity ?? 0) - recovered;
          line.incomingQuantity = (line.incomingQuantity ?? 0) + recovered;
          const product = state.products.find(p => p.id === line.productId)!;
          product.incomingReserved = (product.incomingReserved ?? 0) + recovered;
        }
      }
      if (order.items.some(i => (i.uncoveredQuantity ?? 0) > 0)) order.stockReadiness = 'uncovered';
      else if (order.items.some(i => (i.incomingQuantity ?? 0) > 0)) { order.stockReadiness = 'waiting_incoming'; order.expectedArrivalAt = input.replacement?.expectedAt ?? null; }
    }
    for (const item of purchase.items) {
      const product = state.products.find(p => p.id === item.productId)!;
      product.incoming -= Math.max(0, item.quantity - item.receivedQuantity - item.shortageQuantity);
      refreshProductAvailability(product);
    }
    purchase.state = 'cancelled';
    purchase.cancellation = { reason: input.reason.trim(), cancelledAt: new Date().toISOString(),
      cancelledByName: demoOwner.displayName, pendingUnits: preview.pendingUnits, pendingCostCents: preview.pendingCostCents,
      replacementPurchaseId: replacementPurchase?.id ?? null, replacementPurchaseNumber: replacementPurchase?.number ?? null };
    const result = structuredClone({ purchase, replacementPurchase, transferredReservations, transferredUnits });
    state.shortageOperations.set(input.operationId, { request, result });
    state.revision += 1;
    return latency(result);
  },

  async createPurchase(input: PurchaseCreateInput) {
    return latency(createPurchaseRecord(input));
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

    const updatedQuantityByProduct = new Map<string, number>();
    for (const item of input.items) {
      if (!state.products.some(product => product.id === item.productId) ||
          !Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new AppError('validation', 'Revisá los productos y cantidades de la compra.');
      }
      updatedQuantityByProduct.set(item.productId, (updatedQuantityByProduct.get(item.productId) ?? 0) + item.quantity);
    }
    for (const item of purchase.items) {
      const product = state.products.find(candidate => candidate.id === item.productId)!;
      const incomingAfterEdit = product.incoming - item.quantity + (updatedQuantityByProduct.get(item.productId) ?? 0);
      if (incomingAfterEdit < (product.incomingReserved ?? 0)) {
        throw new AppError('business', `La compra ya tiene unidades de ${item.productName} reservadas para pedidos.`, {
          nextAction: 'Conservá esas unidades o resolvé primero los pedidos afectados.'
        });
      }
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

  async receivePurchase(purchaseId, itemsInput, operationId, shippingCostCents = 0) {
    validateShippingCents(shippingCostCents);
    operationId ??= nextUuid();
    const canonicalPayload = JSON.stringify(
      (itemsInput ?? [])
        .map((i) => ({ purchaseItemId: i.purchaseItemId, receivedQuantity: i.receivedQuantity }))
        .sort((a, b) => a.purchaseItemId.localeCompare(b.purchaseItemId))
    );

    if (operationId) {
      const existing = state.purchaseReceipts.get(operationId);
      if (existing) {
        if (existing.purchaseId !== purchaseId || existing.canonicalPayload !== canonicalPayload || existing.shippingCostCents !== shippingCostCents) {
          throw new AppError('business', 'Esta recepción ya se intentó con cantidades diferentes.', {
            nextAction: 'Actualizá la compra y verificá lo que quedó registrado antes de reintentar.'
          });
        }
        return latency(existing.result);
      }
    }

    const purchase = state.purchases.find((candidate) => candidate.id === purchaseId);
    if (!purchase) throw new AppError('business', 'No encontramos la compra.');
    if (purchase.state !== 'ordered') {
      throw new AppError('business', 'Esta compra ya no está esperando recepción.');
    }
    const receivedByItem = new Map((itemsInput ?? []).map(item => [item.purchaseItemId, item.receivedQuantity]));
    if (itemsInput && (
      receivedByItem.size !== itemsInput.length ||
      itemsInput.some(item => !purchase.items.some(line => line.id === item.purchaseItemId))
    )) {
      throw new AppError('validation', 'Revisá los productos de la recepción.');
    }
    for (const item of purchase.items) {
      const pending = Math.max(0, item.quantity - (item.receivedQuantity ?? 0) - (item.shortageQuantity ?? 0));
      const requested = itemsInput !== undefined ? (receivedByItem.get(item.id) ?? 0) : pending;
      if (!Number.isInteger(requested) || requested < 0 || requested > pending) {
        throw new AppError('validation', `Revisá la cantidad recibida de ${item.productName}.`);
      }
    }
    if (itemsInput?.length === 0 && shippingCostCents === 0) throw new AppError('validation', 'Registrá unidades recibidas o un gasto de envío.');
    const now = new Date().toISOString();
    const unblockedOrders: Array<{ id: string; number: number }> = [];
    const reassignedOrders: NonNullable<ReceivePurchaseResult['reassignedOrders']> = [];

    for (const item of purchase.items) {
      const qtyToReceive = itemsInput !== undefined
        ? (receivedByItem.get(item.id) ?? 0)
        : Math.max(0, item.quantity - (item.receivedQuantity ?? 0) - (item.shortageQuantity ?? 0));

      if (qtyToReceive > 0) {
        item.receivedQuantity = (item.receivedQuantity ?? 0) + qtyToReceive;
        const product = state.products.find((candidate) => candidate.id === item.productId)!;
        product.incoming = Math.max(0, product.incoming - qtyToReceive);
        product.onHand += qtyToReceive;
        for (const unblocked of reconcileDemoProduct(product, item.id, qtyToReceive)) {
          if (!unblockedOrders.some(o => o.id === unblocked.id)) unblockedOrders.push(unblocked);
        }
        for (const affected of rebindDemoReceiptPending(item)) {
          const index = reassignedOrders.findIndex(o => o.id === affected.id);
          if (index < 0) reassignedOrders.push(affected); else reassignedOrders[index] = affected;
        }
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

    let shippingExpense: MiscExpense | null = null;
    if (shippingCostCents > 0) shippingExpense = recordDemoExpense({title: `Envío de proveedor · Compra #${purchase.number}`,
      amountCents: shippingCostCents, frequency: 'once', startsOn: salesDateAt(now), endsOn: null}, nextUuid(),
      {purchaseReceiptOperationId: operationId, purchaseId, purchaseNumber: purchase.number});
    const result = { purchase, unblockedOrders, shippingExpense, reassignedOrders: reassignedOrders.map(affected => {
      const order = state.orders.find(o => o.id === affected.id)!;
      return { ...affected, incomingQuantity: order.items.reduce((n, i) => n + (i.incomingQuantity ?? 0), 0),
        uncoveredQuantity: order.items.reduce((n, i) => n + (i.uncoveredQuantity ?? 0), 0) };
    }) };
    state.receiptHistory.push({operationId, purchaseId, items: itemsInput ?? purchase.items.map(item => ({purchaseItemId: item.id, receivedQuantity: item.receivedQuantity})), shippingCostCents, shippingExpenseId: shippingExpense?.id ?? null, createdAt: now});
    if (operationId) {
      state.purchaseReceipts.set(operationId, {
        purchaseId,
        canonicalPayload,
        shippingCostCents,
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
          let uncovered = Math.max(0, (product.incomingReserved ?? 0) - product.incoming);
          // Conservar las reservas de pedidos anteriores; el faltante afecta
          // primero a los pedidos más recientes que aún esperaban mercadería.
          for (const order of state.orders) {
            if (uncovered === 0) break;
            if (order.orderState !== 'confirmed' || order.fulfillmentState !== 'pending') continue;
            for (const line of order.items) {
              if (line.productId !== product.id || (line.incomingQuantity ?? 0) <= 0) continue;
              const lost = Math.min(uncovered, line.incomingQuantity ?? 0);
              line.incomingQuantity = (line.incomingQuantity ?? 0) - lost;
              line.uncoveredQuantity = (line.uncoveredQuantity ?? 0) + lost;
              product.incomingReserved = Math.max(0, (product.incomingReserved ?? 0) - lost);
              order.stockReadiness = 'uncovered';
              uncovered -= lost;
              if (uncovered === 0) break;
            }
          }
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

  async getPurchaseImpact(purchaseId: string) {
    const purchase = state.purchases.find((p) => p.id === purchaseId);
    if (!purchase) return latency([]);
    const result: PurchaseImpactItem[] = purchase.items.map((pi) => {
      const pendingQuantity = Math.max(0, pi.quantity - (pi.receivedQuantity ?? 0) - (pi.shortageQuantity ?? 0));
      const reservedOrders = state.orders
        .filter((o) => (o.stockReadiness === 'waiting_incoming' || o.stockReadiness === 'uncovered') && o.orderState !== 'cancelled')
        .flatMap((o) => {
          const matchLine = o.items.find((line) => line.productId === pi.productId);
          if (!matchLine || (matchLine.incomingQuantity ?? 0) + (matchLine.uncoveredQuantity ?? 0) === 0) return [];
          const allocations = state.incomingAllocations.get(matchLine.id);
          const linkedQuantity = allocations?.filter(a => a.purchaseItemId === pi.id).reduce((sum,a) => sum+a.quantity,0);
          if (linkedQuantity === 0) return [];
          return [{
            orderId: o.id,
            orderNumber: o.number,
            customerName: o.customerName,
            customerPhone: o.customerPhone,
            reservedQuantity: linkedQuantity ?? (matchLine.incomingQuantity ?? 0) + (matchLine.uncoveredQuantity ?? 0),
            paymentState: o.paymentState,
            fulfillmentState: o.fulfillmentState,
            totalCents: o.totalCents
          }];
        });
      return {
        purchaseItemId: pi.id,
        productId: pi.productId,
        productName: pi.productName,
        totalQuantity: pi.quantity,
        receivedQuantity: pi.receivedQuantity ?? 0,
        shortageQuantity: pi.shortageQuantity ?? 0,
        pendingQuantity,
        reservedOrders,
        openingReservationsQuantity: 0
      };
    });
    return latency(result);
  },

  async declarePurchaseShortages(purchaseId, items, operationId) {
    const request = JSON.stringify({ kind: 'shortages', purchaseId, items: [...items].sort((a,b) => a.purchaseItemId.localeCompare(b.purchaseItemId)) });
    const previous = state.shortageOperations.get(operationId);
    if (previous) {
      if (previous.request !== request) throw new AppError('business', 'Los datos cambiaron respecto del intento anterior.');
      return latency(previous.result as Purchase);
    }
    const purchase = state.purchases.find(p => p.id === purchaseId);
    if (!purchase || !items.length || new Set(items.map(i => i.purchaseItemId)).size !== items.length) throw new AppError('validation', 'Revisá los faltantes de la compra.');
    for (const input of items) {
      const item = purchase.items.find(i => i.id === input.purchaseItemId);
      if (!item || !Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity !== item.quantity-(item.receivedQuantity??0)-(item.shortageQuantity??0)) {
        throw new AppError('business', 'Las unidades pendientes cambiaron.', { nextAction: 'Cerrá y volvé a abrir la recepción.' });
      }
      if (state.orders.some(order => order.orderState === 'confirmed' && order.fulfillmentState === 'pending' &&
        order.items.some(line => line.productId === item.productId && (line.incomingQuantity ?? 0) + (line.uncoveredQuantity ?? 0) > 0 &&
          (!state.incomingAllocations.has(line.id) || state.incomingAllocations.get(line.id)!.some(a => a.purchaseItemId === item.id && a.quantity > 0))))) {
        throw new AppError('business', 'Todavía hay reservas esperando este producto.', { nextAction: 'Pedí una reposición o resolvé los pedidos vinculados antes de cerrar el faltante.' });
      }
    }
    for (const input of items) recordShortage(purchase, purchase.items.find(i => i.id === input.purchaseItemId)!, input.quantity);
    state.revision++;
    const result = structuredClone(purchase);
    state.shortageOperations.set(operationId, { request, result });
    return latency(result);
  },

  async replacePurchaseShortage(input) {
    const request = JSON.stringify({ kind:'replacement', ...input, supplierName:input.supplierName.trim() });
    const previous = state.shortageOperations.get(input.operationId);
    if (previous) {
      if (previous.request !== request) throw new AppError('business', 'Los datos cambiaron respecto del intento anterior.');
      return latency(previous.result as Awaited<ReturnType<BusinessApi['replacePurchaseShortage']>>);
    }
    const purchase = state.purchases.find(p => p.items.some(i => i.id === input.purchaseItemId));
    const item = purchase?.items.find(i => i.id === input.purchaseItemId);
    if (!purchase || !item || !Number.isSafeInteger(input.expectedPending) || input.expectedPending !== item.quantity-(item.receivedQuantity??0)-(item.shortageQuantity??0) || input.expectedPending <= 0) {
      throw new AppError('business', 'Las unidades pendientes cambiaron.', { nextAction: 'Cerrá y volvé a abrir la recepción.' });
    }
    if (countCharacters(input.supplierName.trim()) < 2 || countCharacters(input.supplierName.trim()) > 120) throw new AppError('validation', 'Ingresá el nombre del proveedor (entre 2 y 120 caracteres).');
    const replacement = createPurchaseRecord({ supplierName:input.supplierName, expectedAt:input.expectedAt,
      notes:`Reposición de compra #${purchase.number}`, items:[{productId:item.productId,quantity:input.expectedPending,unitCostCents:item.unitCostCents}] });
    recordShortage(purchase, item, input.expectedPending);
    let transferred = 0;
    const product = state.products.find(p=>p.id===item.productId)!;
    let capacity = input.expectedPending;
    for (const order of [...state.orders].reverse()) {
      if (order.orderState !== 'confirmed' || order.fulfillmentState !== 'pending') continue;
      const line = order.items.find(i => i.productId === item.productId);
      if (!line || !(line.uncoveredQuantity ?? 0)) continue;
      const allocations = state.incomingAllocations.get(line.id);
      const linked = allocations?.find(a => a.purchaseItemId === item.id && a.quantity > 0);
      if (allocations && !linked) continue;
      const take = Math.min(capacity, linked?.quantity ?? line.uncoveredQuantity ?? 0);
      if (!take) continue;
      line.uncoveredQuantity = (line.uncoveredQuantity ?? 0) - take;
      line.incomingQuantity = (line.incomingQuantity ?? 0) + take;
      if (linked) linked.purchaseItemId = replacement.items[0]!.id;
      product.incomingReserved = (product.incomingReserved ?? 0) + take;
      order.stockReadiness = order.items.some(i => (i.uncoveredQuantity ?? 0)>0) ? 'uncovered' : 'waiting_incoming';
      order.expectedArrivalAt = replacement.expectedAt;
      order.actionRevision = (order.actionRevision ?? 0) + 1;
      capacity -= take; transferred++;
    }
    refreshProductAvailability(product);
    const result = structuredClone({ oldPurchase:purchase, newPurchase:replacement, transferredReservations:transferred });
    state.shortageOperations.set(input.operationId,{request,result});
    return latency(result);
  },

  async declareItemShortage(purchaseItemId: string, quantity: number, notes?: string) {
    let targetPurchase: Purchase | undefined;
    for (const p of state.purchases) {
      const item = p.items.find((i) => i.id === purchaseItemId);
      if (item) {
        targetPurchase = p;
        item.shortageQuantity = (item.shortageQuantity ?? 0) + quantity;
        const prod = state.products.find((pr) => pr.id === item.productId);
        if (prod) {
          prod.incoming = Math.max(0, prod.incoming - quantity);
          refreshProductAvailability(prod);
        }
        break;
      }
    }
    if (!targetPurchase) throw new AppError('business', 'No se encontró el ítem de compra.');
    if (notes) {
      targetPurchase.notes = targetPurchase.notes ? `${targetPurchase.notes} | ${notes}` : notes;
    }
    const allCompleted = targetPurchase.items.every(
      (i) => (i.receivedQuantity ?? 0) + (i.shortageQuantity ?? 0) >= i.quantity
    );
    if (allCompleted) {
      targetPurchase.state = 'received';
      targetPurchase.receivedAt = new Date().toISOString();
    }
    state.revision += 1;
    return latency(targetPurchase);
  },

  async reassignPurchaseReservations(oldPurchaseItemId: string, newPurchaseId: string) {
    let oldPurchase: Purchase | undefined;
    let oldItem: any;
    for (const p of state.purchases) {
      const it = p.items.find((i) => i.id === oldPurchaseItemId);
      if (it) {
        oldPurchase = p;
        oldItem = it;
        break;
      }
    }
    const newPurchase = state.purchases.find((p) => p.id === newPurchaseId);
    if (!oldPurchase || !oldItem || !newPurchase) {
      throw new AppError('business', 'Compra o ítem no encontrado.');
    }
    const remaining = Math.max(0, oldItem.quantity - (oldItem.receivedQuantity ?? 0) - (oldItem.shortageQuantity ?? 0));
    oldItem.shortageQuantity = (oldItem.shortageQuantity ?? 0) + remaining;
    const allCompleted = oldPurchase.items.every(
      (i) => (i.receivedQuantity ?? 0) + (i.shortageQuantity ?? 0) >= i.quantity
    );
    if (allCompleted) {
      oldPurchase.state = 'received';
      oldPurchase.receivedAt = new Date().toISOString();
    }
    state.revision += 1;
    return latency({
      oldPurchase,
      newPurchase,
      transferredReservations: 1
    });
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
    const orders = paidOrdersInRange(from, to);
    const paidOrders = orders.filter((order) => order.paymentState === 'paid');
    const giftOrdersList = orders.filter((order) => order.paymentState === 'gifted');
    const giftOrders = giftOrdersList.length;
    const giftCostCents = giftOrdersList.reduce((sum, order) => sum + (order.costTotalCents ?? 0), 0);
    const costOrdersList = orders.filter((order) => order.saleType === 'cost' || order.isCostSale);
    const costSaleOrders = costOrdersList.length;
    const costSaleRevenueCents = costOrdersList.reduce((sum, order) => sum + order.totalCents, 0);
    const revenueCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
    const costCents = orders.reduce((sum, order) => sum + (order.costTotalCents ?? 0), 0);
    const taxCents = orders.reduce((sum, order) => sum + (order.taxAmountCents ?? 0), 0);
    const expenseOccurrences = state.expenses
      .filter((expense) => expense.deletedAt === null)
      .flatMap((expense) =>
        listMiscExpenseOccurrenceDates(expense, from, to)
          .map(() => expense.amountCents)
      );
    const miscExpensesCents = expenseOccurrences.reduce((sum, amount) => sum + amount, 0);
    const commercialMarginCents = revenueCents - costCents - taxCents;
    const units = orders.flatMap((order) => order.items).reduce((sum, item) => sum + item.quantity, 0);
    const byMonth = new Map<string, Order[]>();
    for (const order of orders) {
      const key = salesDate(order).slice(0, 7);
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
          orderCount: periodOrders.filter(order => order.paymentState === 'paid').length,
          units: periodOrders
            .flatMap((order) => order.items)
            .reduce((sum, item) => sum + item.quantity, 0),
          ipcPublished: !isCurrentPending
        };
      });
    const result: AnalyticsSummary = {
      from,
      to,
      comparisonCutoffDay: null,
      revenueCents,
      shippingRevenueCents: paidOrders.reduce((sum,order) => sum + order.shippingFeeCents, 0),
      supplierShippingExpensesCents: state.expenses.filter(e => e.deletedAt === null && e.purchaseReceiptOperationId).reduce((sum,e) => sum + countMiscExpenseOccurrences(e, from, to)*e.amountCents, 0),
      otherExpensesCents: miscExpensesCents - state.expenses.filter(e => e.deletedAt === null && e.purchaseReceiptOperationId).reduce((sum,e) => sum + countMiscExpenseOccurrences(e, from, to)*e.amountCents, 0),
      costCents,
      taxCents,
      commercialMarginCents,
      miscExpensesCents,
      miscExpenseOccurrences: expenseOccurrences.length,
      estimatedMarginCents: commercialMarginCents - miscExpensesCents,
      averageTicketCents: paidOrders.length ? Math.round(revenueCents / paidOrders.length) : 0,
      orders: paidOrders.length,
      units,
      giftOrders,
      giftCostCents,
      costSaleOrders,
      costSaleRevenueCents,
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
      inventory: currentDemoInventory(),
      orders: state.orders.map((order, index) => ({
        ...order,
        source: 'whatsapp_import',
        protocolOrderId: order.id,
        protocolChecksum: index.toString(16).toUpperCase().padStart(8, '0'),
        refundedAt: order.paymentState === 'refunded' ? order.createdAt : null,
        shippedAt: order.shippedAt ?? null,
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
      expenses: state.expenses,
      expenseHistory: state.expenseHistory,
      orderActionHistory: structuredClone(state.reversalHistory),
      orderShippingFeeHistory: state.shippingFeeHistory,
      purchaseReceipts: state.receiptHistory,
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
    const inventory = currentDemoInventory();
    const urgent = inventory
      .filter((item) => item.status !== 'ok')
      .sort((left, right) => left.available - right.available)[0];
    const answer = urgent
      ? `En la demo priorizaría ${urgent.name}. Tiene ${urgent.available} unidades libres para nuevas ventas, ${urgent.incoming} pendientes de recibir y una cobertura estimada de ${urgent.coverageDays ?? '—'} días. La cantidad sugerida de compra es ${urgent.suggestedPurchase}. Esta respuesta usa datos agregados de inventario; no modificó ningún registro.`
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
