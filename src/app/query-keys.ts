export const queryKeys = {
  settings: ['settings'] as const,
  storefrontProducts: ['storefront-products'] as const,
  storefrontProduct: (slug: string) => ['storefront-product', slug] as const,
  dashboard: ['dashboard'] as const,
  products: ['admin-products'] as const,
  inventory: ['inventory'] as const,
  orders: (page = 1) => ['orders', page] as const,
  paidOrders: (page = 1) => ['paid-orders', page] as const,
  purchasesRoot: ['purchases'] as const,
  purchases: (page = 1) => ['purchases', page] as const,
  movements: (page = 1) => ['movements', page] as const,
  customers: (page = 1) => ['customers', page] as const,
  analytics: (from: string, to: string) => ['analytics', from, to] as const,
  inflation: ['inflation-indices'] as const
};
