export type UserRole = 'owner' | 'staff';

export type AppUser = {
  id: string;
  displayName: string;
  email: string;
  role: UserRole;
  active: boolean;
};

export type AvailabilityStatus = 'available' | 'low' | 'out_of_stock';

export type StorefrontProduct = {
  id: string;
  sku: string;
  slug: string;
  name: string;
  presentation: string;
  description: string;
  priceCents: number;
  imageUrl: string;
  imageAlt: string;
  availability: AvailabilityStatus;
  maxOrderQuantity: number;
  category: string;
  featured: boolean;
};

export type AdminProduct = StorefrontProduct & {
  active: boolean;
  published: boolean;
  reorderPoint: number;
  safetyStock: number;
  leadTimeDays: number;
  onHand: number;
  reserved: number;
  incoming: number;
  currentCostCents: number | null;
  updatedAt: string;
};

export type InventoryItem = Pick<
  AdminProduct,
  | 'id'
  | 'sku'
  | 'name'
  | 'presentation'
  | 'imageUrl'
  | 'onHand'
  | 'reserved'
  | 'incoming'
  | 'reorderPoint'
  | 'safetyStock'
  | 'leadTimeDays'
> & {
  available: number;
  projected: number;
  averageDailySales: number;
  coverageDays: number | null;
  suggestedPurchase: number;
  status: 'ok' | 'low' | 'critical' | 'out';
};

export type PaymentMethod = 'cash' | 'transfer';
export type DeliveryMethod = 'pickup' | 'shipping';
export type ShippingType = 'standard' | 'express';
export type OrderState = 'confirmed' | 'cancelled';
export type PaymentState = 'pending' | 'paid' | 'refunded';
export type PreparationState = 'pending' | 'preparing' | 'ready';
export type FulfillmentState = 'pending' | 'shipped' | 'delivered' | 'cancelled';

export type CartLine = {
  productId: string;
  sku: string;
  slug: string;
  name: string;
  presentation: string;
  imageUrl: string;
  unitPriceCents: number;
  quantity: number;
};

export type CheckoutData = {
  customerName: string;
  paymentMethod: PaymentMethod;
  deliveryMethod: DeliveryMethod;
  shippingType: ShippingType | null;
  address: string | null;
  addressNumber: string | null;
  phone: string | null;
};

export type OrderItem = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  presentation: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number | null;
  subtotalCents: number;
};

export type Order = {
  id: string;
  number: number;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  paymentMethod: PaymentMethod;
  deliveryMethod: DeliveryMethod;
  shippingType: ShippingType | null;
  shippingAddress: string | null;
  orderState: OrderState;
  paymentState: PaymentState;
  preparationState: PreparationState;
  fulfillmentState: FulfillmentState;
  subtotalCents: number;
  shippingFeeCents: number;
  totalCents: number;
  taxRateBasisPoints: number | null;
  taxAmountCents: number | null;
  costTotalCents: number | null;
  createdAt: string;
  confirmedAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  items: OrderItem[];
};

export type OrderAction =
  | 'mark_paid'
  | 'mark_refunded'
  | 'start_preparing'
  | 'mark_ready'
  | 'mark_shipped'
  | 'mark_delivered'
  | 'cancel';

export type PurchaseState = 'draft' | 'ordered' | 'received' | 'cancelled';

export type PurchaseItem = {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitCostCents: number;
};

export type Purchase = {
  id: string;
  number: number;
  supplierName: string;
  state: PurchaseState;
  orderedAt: string | null;
  expectedAt: string | null;
  receivedAt: string | null;
  totalCostCents: number;
  notes: string | null;
  items: PurchaseItem[];
};

export type Customer = {
  id: string;
  name: string;
  phone: string | null;
  firstOrderAt: string;
  lastOrderAt: string;
  orderCount: number;
  totalPaidCents: number | null;
};

export type StockMovement = {
  id: string;
  productId: string;
  productName: string;
  kind:
    | 'sale'
    | 'purchase_received'
    | 'return'
    | 'adjustment'
    | 'reservation'
    | 'reservation_release';
  physicalDelta: number;
  reservedDelta: number;
  reason: string;
  orderId: string | null;
  purchaseId: string | null;
  createdAt: string;
  createdByName: string;
};

export type StoreSettings = {
  storeName: string;
  tagline: string;
  whatsappPhone: string;
  transferAlias: string;
  transferAccount: string;
  standardShippingCents: number;
  expressShippingCents: number;
  taxRateBasisPoints: number;
  currency: 'ARS';
};

export type DashboardSummary = {
  pendingPreparation: number;
  readyForDelivery: number;
  lowStockProducts: number;
  incomingPurchases: number;
  paidRevenueMonthCents: number | null;
  paidOrdersMonth: number | null;
  estimatedMarginMonthCents: number | null;
  recentOrders: Order[];
  priorityInventory: InventoryItem[];
};

export type PeriodPoint = {
  period: string;
  revenueCents: number;
  adjustedRevenueCents: number | null;
  orderCount: number;
  units: number;
  ipcPublished: boolean;
};

export type ProductPerformance = {
  productId: string;
  name: string;
  units: number;
  revenueCents: number;
  estimatedMarginCents: number;
};

export type AnalyticsSummary = {
  from: string;
  to: string;
  comparisonCutoffDay: number | null;
  revenueCents: number;
  costCents: number;
  taxCents: number;
  estimatedMarginCents: number;
  averageTicketCents: number;
  orders: number;
  units: number;
  series: PeriodPoint[];
  topProducts: ProductPerformance[];
};

export type InflationIndex = {
  period: string;
  indexValue: number;
  sourceUrl: string;
  publishedAt: string;
};

export type ImportOrderInput = CheckoutData & {
  lines: CartLine[];
  shippingFeeCents: number;
  quotedSubtotalCents: number;
  quotedTotalCents: number;
  protocolOrderId: string;
  protocolChecksum: string;
};

export type AvailabilityCheck = {
  ok: boolean;
  issues: Array<{
    productId: string;
    productName: string;
    requested: number;
    available: number;
  }>;
};

export type ExportDataset = {
  generatedAt: string;
  revision: number;
  settings: StoreSettings;
  products: Array<AdminProduct & { createdAt: string }>;
  inventory: InventoryItem[];
  orders: Array<Order & {
    source: 'whatsapp_import' | 'manual';
    protocolOrderId: string | null;
    protocolChecksum: string | null;
    refundedAt: string | null;
    shippedAt: string | null;
    cancelledAt: string | null;
  }>;
  purchases: Array<Purchase & { createdAt: string }>;
  movements: StockMovement[];
  customers: Array<Customer & { createdAt: string }>;
  inflation: InflationIndex[];
  reservations: Array<{
    id: string;
    orderId: string;
    productId: string;
    quantity: number;
    state: 'active' | 'consumed' | 'released';
    createdAt: string;
    resolvedAt: string | null;
  }>;
  users: Array<AppUser & { createdAt: string; updatedAt: string }>;
};
