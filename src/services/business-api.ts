import { appEnv } from '@/app/env';
import type {
  AdminProduct,
  AppUser,
  AnalyticsSummary,
  AvailabilityCheck,
  CartLine,
  Customer,
  DashboardSummary,
  ExportDataset,
  ImportOrderInput,
  InflationIndex,
  InventoryItem,
  OpeningReservation,
  Order,
  OrderAction,
  Purchase,
  QuoteCartEtaResult,
  ReceivePurchaseItemInput,
  ReceivePurchaseResult,
  StockMovement,
  StorefrontProduct,
  StoreSettings
} from '@/domain/types';

export type Page<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type OrdersPage = Page<Order> & { pendingTotal: number; completedTotal: number };

export type PurchasesPage = Page<Purchase> & {
  pendingTotal?: number;
  receivedTotal?: number;
  filteredTotal?: number;
};

export type ProductUpdate = {
  id?: string;
  sku: string;
  slug: string;
  name: string;
  presentation: string;
  description: string;
  category: string;
  priceCents: number;
  currentCostCents: number | null;
  reorderPoint: number;
  safetyStock: number;
  leadTimeDays: number;
  imageUrl: string;
  imageAlt: string;
  published: boolean;
  active: boolean;
  featured?: boolean;
};

export interface UpdateStockThresholdsInput {
  productId: string;
  reorderPoint: number;
  safetyStock: number;
  leadTimeDays?: number | null;
}

export type PurchaseCreateInput = {
  supplierName?: string;
  expectedAt?: string | null;
  notes?: string | null;
  items: Array<{
    productId: string;
    quantity: number;
    unitCostCents: number;
  }>;
};

export type PurchaseUpdateInput = {
  id: string;
  supplierName?: string;
  expectedAt?: string | null;
  notes?: string | null;
  items: Array<{
    productId: string;
    quantity: number;
    unitCostCents: number;
  }>;
};

export type AIAnswerEvidence = {
  label: string;
  value: string | number | boolean | null;
  formatted: string;
};

export type AIAnswer = {
  answer: string;
  model: string;
  provider: string;
  fallback: boolean;
  usedTools: string[];
  evidence: AIAnswerEvidence[];
};

export interface BusinessApi {
  getSettings(): Promise<StoreSettings>;
  updateSettings(settings: StoreSettings): Promise<StoreSettings>;
  listStorefrontProducts(): Promise<StorefrontProduct[]>;
  getStorefrontProduct(slug: string): Promise<StorefrontProduct | null>;
  validateAvailability(lines: Pick<CartLine, 'productId' | 'quantity'>[]): Promise<AvailabilityCheck>;
  quoteCartEta(lines: Pick<CartLine, 'productId' | 'quantity'>[]): Promise<QuoteCartEtaResult>;
  getDashboard(): Promise<DashboardSummary>;
  listAdminProducts(): Promise<AdminProduct[]>;
  saveProduct(input: ProductUpdate): Promise<AdminProduct>;
  deleteProduct(productId: string): Promise<void>;
  archiveProduct(productId: string, archived: boolean): Promise<AdminProduct>;
  listInventory(): Promise<InventoryItem[]>;
  adjustStock(productId: string, delta: number, reason: string, expectedOnHand?: number): Promise<void>;
  updateStockThresholds(input: UpdateStockThresholdsInput): Promise<void>;
  listOrders(page?: number, pageSize?: number, search?: string, state?: 'all' | 'pending' | 'completed'): Promise<OrdersPage>;
  listPaidOrders(page?: number, pageSize?: number, from?: string, to?: string): Promise<Page<Order>>;
  confirmImportedOrder(input: ImportOrderInput): Promise<Order>;
  transitionOrder(orderId: string, action: OrderAction): Promise<Order>;
  listPurchases(page?: number, pageSize?: number, state?: 'ordered' | 'received' | 'all'): Promise<PurchasesPage>;
  listOpeningReservations(): Promise<OpeningReservation[]>;
  resolveOpeningReservation(purchaseItemId: string, quantity: number, action: 'deliver' | 'release', operationId: string): Promise<{ quantity: number; action: 'deliver' | 'release' }>;
  createPurchase(input: PurchaseCreateInput): Promise<Purchase>;
  updatePurchase(input: PurchaseUpdateInput): Promise<Purchase>;
  receivePurchase(purchaseId: string, items?: ReceivePurchaseItemInput[], operationId?: string): Promise<ReceivePurchaseResult>;
  closePurchaseWithShortage(purchaseId: string, notes?: string): Promise<ReceivePurchaseResult>;
  listMovements(page?: number, pageSize?: number, search?: string, filter?: 'all' | 'sales' | 'purchases' | 'adjustments'): Promise<Page<StockMovement>>;
  listCustomers(page?: number, pageSize?: number, search?: string): Promise<Page<Customer>>;
  listCustomerOrders(customerId: string, page?: number, pageSize?: number): Promise<Page<Order>>;
  getAnalytics(from: string, to: string): Promise<AnalyticsSummary>;
  listInflationIndices(): Promise<InflationIndex[]>;
  saveInflationIndex(input: InflationIndex): Promise<InflationIndex>;
  getExportDataset(): Promise<ExportDataset>;
  listUsers(): Promise<AppUser[]>;
  updateUserAccess(userId: string, role: 'owner' | 'staff', active: boolean): Promise<AppUser>;
  askBusinessAi(
    message: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<AIAnswer>;
}

let apiPromise: Promise<BusinessApi> | null = null;

export const getBusinessApi = async (): Promise<BusinessApi> => {
  if (!apiPromise) {
    apiPromise =
      appEnv.mode === 'demo'
        ? import('./demo-business-api').then(({ demoBusinessApi }) => demoBusinessApi)
        : import('./supabase-business-api').then(({ supabaseBusinessApi }) => supabaseBusinessApi);
  }
  return apiPromise;
};

if (typeof window !== 'undefined') {
  (window as any).__getBusinessApi = getBusinessApi;
}
