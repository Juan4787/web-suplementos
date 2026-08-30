import { describe, expect, it } from 'vitest';
import { can, type Capability } from './permissions';
import type { AppUser } from './types';

const ownerUser: AppUser = {
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'Dueña',
  email: 'duena@tienda.com',
  role: 'owner',
  active: true
};

const staffUser: AppUser = {
  id: '00000000-0000-4000-8000-000000000002',
  displayName: 'Recepcionista',
  email: 'staff@tienda.com',
  role: 'staff',
  active: true
};

const inactiveOwner: AppUser = {
  ...ownerUser,
  active: false
};

const allCapabilities: Capability[] = [
  'operate_orders',
  'manage_public_catalog',
  'manage_pricing',
  'manage_purchases',
  'adjust_stock',
  'view_financials',
  'export_data',
  'use_ai',
  'manage_users'
];

describe('permissions matrix', () => {
  it('returns false for any capability if user is null or undefined', () => {
    for (const cap of allCapabilities) {
      expect(can(null, cap)).toBe(false);
    }
  });

  it('returns false for any capability if user is inactive', () => {
    for (const cap of allCapabilities) {
      expect(can(inactiveOwner, cap)).toBe(false);
    }
  });

  it('grants all capabilities to an active owner', () => {
    for (const cap of allCapabilities) {
      expect(can(ownerUser, cap)).toBe(true);
    }
  });

  it('restricts staff strictly to operational tools and denies financial/admin capabilities', () => {
    // Staff can operate orders and manage public catalog
    expect(can(staffUser, 'operate_orders')).toBe(true);
    expect(can(staffUser, 'manage_public_catalog')).toBe(true);

    // Staff CANNOT manage pricing, view financials, adjust stock, export data, manage purchases, or manage users
    expect(can(staffUser, 'manage_pricing')).toBe(false);
    expect(can(staffUser, 'manage_purchases')).toBe(false);
    expect(can(staffUser, 'adjust_stock')).toBe(false);
    expect(can(staffUser, 'view_financials')).toBe(false);
    expect(can(staffUser, 'export_data')).toBe(false);
    expect(can(staffUser, 'use_ai')).toBe(false);
    expect(can(staffUser, 'manage_users')).toBe(false);
  });
});
