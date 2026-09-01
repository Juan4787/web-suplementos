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
  Order,
  OrderAction,
  Purchase,
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
  featured: boolean;
};

export type PurchaseCreateInput = {
  supplierName: string;
  expectedAt: string | null;
  notes: string | null;
  items: Array<{ productId: string; quantity: number; unitCostCents: number }>;
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

export type UpdateStockThresholdsInput = {
  productId: string;
  reorderPoint: number;
  safetyStock: number;
  leadTimeDays?: number;
};

export interface BusinessApi {
  getSettings(): Promise<StoreSettings>;
  updateSettings(settings: StoreSettings): Promise<StoreSettings>;
  listStorefrontProducts(): Promise<StorefrontProduct[]>;
  getStorefrontProduct(slug: string): Promise<StorefrontProduct | null>;
  validateAvailability(lines: Pick<CartLine, 'productId' | 'quantity'>[]): Promise<AvailabilityCheck>;
  getDashboard(): Promise<DashboardSummary>;
  listAdminProducts(): Promise<AdminProduct[]>;
  saveProduct(input: ProductUpdate): Promise<AdminProduct>;
  listInventory(): Promise<InventoryItem[]>;
  adjustStock(productId: string, delta: number, reason: string): Promise<void>;
  updateStockThresholds(input: UpdateStockThresholdsInput): Promise<void>;
  listOrders(page?: number, pageSize?: number): Promise<Page<Order>>;
  listPaidOrders(page?: number, pageSize?: number): Promise<Page<Order>>;
  confirmImportedOrder(input: ImportOrderInput): Promise<Order>;
  transitionOrder(orderId: string, action: OrderAction): Promise<Order>;
  listPurchases(page?: number, pageSize?: number): Promise<Page<Purchase>>;
  createPurchase(input: PurchaseCreateInput): Promise<Purchase>;
  receivePurchase(purchaseId: string): Promise<Purchase>;
  listMovements(page?: number, pageSize?: number): Promise<Page<StockMovement>>;
  listCustomers(page?: number, pageSize?: number): Promise<Page<Customer>>;
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
