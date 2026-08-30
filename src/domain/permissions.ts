import type { AppUser } from './types';

export type Capability =
  | 'operate_orders'
  | 'manage_public_catalog'
  | 'manage_pricing'
  | 'manage_purchases'
  | 'adjust_stock'
  | 'view_financials'
  | 'export_data'
  | 'use_ai'
  | 'manage_users';

const OWNER_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'operate_orders',
  'manage_public_catalog',
  'manage_pricing',
  'manage_purchases',
  'adjust_stock',
  'view_financials',
  'export_data',
  'use_ai',
  'manage_users'
]);

const STAFF_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'operate_orders',
  'manage_public_catalog'
]);

export const can = (user: AppUser | null, capability: Capability): boolean => {
  if (!user || !user.active) return false;
  return (user.role === 'owner' ? OWNER_CAPABILITIES : STAFF_CAPABILITIES).has(capability);
};

