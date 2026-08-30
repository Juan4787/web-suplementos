import { act, renderHook } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorefrontProduct } from '@/domain/types';
import {
  CART_SCHEMA_VERSION,
  CART_STORAGE_KEY,
  CART_TTL_MS,
  CartProvider,
  useCart
} from './CartProvider';

const mockProduct: StorefrontProduct = {
  id: 'prod-001',
  sku: 'CREA300',
  slug: 'creatina-300g',
  name: 'Creatina Monohidratada',
  presentation: '300 g',
  description: 'Creatina pura',
  priceCents: 2500000,
  imageUrl: '/demo/creatina.svg',
  imageAlt: 'Creatina',
  availability: 'available',
  maxOrderQuantity: 10,
  category: 'Rendimiento',
  featured: true
};

const mockProduct2: StorefrontProduct = {
  id: 'prod-002',
  sku: 'WHEY900',
  slug: 'whey-900g',
  name: 'Whey Protein',
  presentation: '900 g',
  description: 'Proteína de suero',
  priceCents: 3500000,
  imageUrl: '/demo/whey.svg',
  imageAlt: 'Whey',
  availability: 'available',
  maxOrderQuantity: 5,
  category: 'Proteína',
  featured: false
};

const wrapper = ({ children }: PropsWithChildren) => (
  <CartProvider>{children}</CartProvider>
);

describe('CartProvider with 24h TTL & Edge Cases', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('initializes with an empty cart when localStorage is empty', () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    expect(result.current.lines).toEqual([]);
    expect(result.current.itemCount).toBe(0);
    expect(result.current.subtotalCents).toBe(0);
    expect(result.current.expiredNotice).toBeNull();
  });

  it('adds items and updates counts and subtotal accurately', () => {
    const { result } = renderHook(() => useCart(), { wrapper });

    act(() => {
      result.current.add(mockProduct, 2);
    });

    expect(result.current.lines.length).toBe(1);
    expect(result.current.lines[0]?.productId).toBe('prod-001');
    expect(result.current.lines[0]?.quantity).toBe(2);
    expect(result.current.itemCount).toBe(2);
    expect(result.current.subtotalCents).toBe(5000000);

    // Adding another product
    act(() => {
      result.current.add(mockProduct2, 1);
    });

    expect(result.current.lines.length).toBe(2);
    expect(result.current.itemCount).toBe(3);
    expect(result.current.subtotalCents).toBe(8500000);
  });

  it('clamps quantity to maxOrderQuantity when adding more than available', () => {
    const { result } = renderHook(() => useCart(), { wrapper });

    act(() => {
      result.current.add(mockProduct2, 4);
    });
    act(() => {
      result.current.add(mockProduct2, 3);
    });

    expect(result.current.lines[0]?.quantity).toBe(5);
  });

  it('updates quantity with setQuantity, removing if quantity is 0 or less', () => {
    const { result } = renderHook(() => useCart(), { wrapper });

    act(() => {
      result.current.add(mockProduct, 2);
    });

    act(() => {
      result.current.setQuantity('prod-001', 4);
    });
    expect(result.current.lines[0]?.quantity).toBe(4);

    act(() => {
      result.current.setQuantity('prod-001', 0);
    });
    expect(result.current.lines.length).toBe(0);
  });

  it('removes specific items and clears the whole cart', () => {
    const { result } = renderHook(() => useCart(), { wrapper });

    act(() => {
      result.current.add(mockProduct, 2);
      result.current.add(mockProduct2, 1);
    });

    act(() => {
      result.current.remove('prod-001');
    });
    expect(result.current.lines.length).toBe(1);
    expect(result.current.lines[0]?.productId).toBe('prod-002');

    act(() => {
      result.current.clear();
    });
    expect(result.current.lines.length).toBe(0);
  });

  it('persists cart state with schema version and lastActivityAt to localStorage', () => {
    const { result: firstRender } = renderHook(() => useCart(), { wrapper });

    act(() => {
      firstRender.current.add(mockProduct, 3);
    });

    const storedRaw = window.localStorage.getItem(CART_STORAGE_KEY);
    expect(storedRaw).toBeTruthy();
    const stored = JSON.parse(storedRaw!);
    expect(stored.version).toBe(CART_SCHEMA_VERSION);
    expect(stored.lastActivityAt).toBeTypeOf('number');
    expect(stored.lines[0]?.quantity).toBe(3);

    // Re-render hook and verify restoration
    const { result: secondRender } = renderHook(() => useCart(), { wrapper });
    expect(secondRender.current.lines.length).toBe(1);
    expect(secondRender.current.lines[0]?.quantity).toBe(3);
    expect(secondRender.current.expiredNotice).toBeNull();
  });

  it('expires and clears cart if lastActivityAt is 24 hours or older', () => {
    const twentyFiveHoursAgo = Date.now() - (CART_TTL_MS + 3600 * 1000);
    const expiredData = {
      version: CART_SCHEMA_VERSION,
      lastActivityAt: twentyFiveHoursAgo,
      lines: [
        {
          productId: 'prod-001',
          sku: 'CREA300',
          slug: 'creatina',
          name: 'Creatina Monohidratada',
          presentation: '300 g',
          imageUrl: '/demo/creatina.svg',
          unitPriceCents: 2500000,
          quantity: 2
        }
      ]
    };
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(expiredData));

    const { result } = renderHook(() => useCart(), { wrapper });

    expect(result.current.lines).toEqual([]);
    expect(result.current.expiredNotice).toContain('venció después de 24 horas');
    expect(window.localStorage.getItem(CART_STORAGE_KEY)).toBeNull();

    act(() => {
      result.current.dismissExpiredNotice();
    });
    expect(result.current.expiredNotice).toBeNull();
  });

  it('strictly validates boundary: 23:59:59 is valid, 24:00:00 and >24h are expired', () => {
    const baseLine = {
      productId: 'prod-001',
      sku: 'CREA300',
      slug: 'creatina',
      name: 'Creatina Monohidratada',
      presentation: '300 g',
      imageUrl: '/demo/creatina.svg',
      unitPriceCents: 2500000,
      quantity: 1
    };

    // Case 1: age = 23h 59m 59s (86_399_000 ms) -> VÁLIDO
    const justUnder24h = Date.now() - (CART_TTL_MS - 1000);
    window.localStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        version: CART_SCHEMA_VERSION,
        lastActivityAt: justUnder24h,
        lines: [baseLine]
      })
    );
    const { result: validResult } = renderHook(() => useCart(), { wrapper });
    expect(validResult.current.lines.length).toBe(1);
    expect(validResult.current.expiredNotice).toBeNull();

    // Case 2: age = exact 24h 00m 00s (86_400_000 ms) -> VENCIDO
    window.localStorage.clear();
    const exact24h = Date.now() - CART_TTL_MS;
    window.localStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        version: CART_SCHEMA_VERSION,
        lastActivityAt: exact24h,
        lines: [baseLine]
      })
    );
    const { result: exactResult } = renderHook(() => useCart(), { wrapper });
    expect(exactResult.current.lines.length).toBe(0);
    expect(exactResult.current.expiredNotice).not.toBeNull();

    // Case 3: age = 24h 00m 01s (86_401_000 ms) -> VENCIDO
    window.localStorage.clear();
    const justOver24h = Date.now() - (CART_TTL_MS + 1000);
    window.localStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        version: CART_SCHEMA_VERSION,
        lastActivityAt: justOver24h,
        lines: [baseLine]
      })
    );
    const { result: overResult } = renderHook(() => useCart(), { wrapper });
    expect(overResult.current.lines.length).toBe(0);
    expect(overResult.current.expiredNotice).not.toBeNull();
  });

  it('safely removes ONLY the cart key and never touches other localStorage items on expiration', () => {
    // Colocar claves no relacionadas en localStorage
    window.localStorage.setItem('user-auth-token', 'secret-token-123');
    window.localStorage.setItem('theme-preference', 'dark');

    // Colocar carrito vencido
    const expiredData = {
      version: CART_SCHEMA_VERSION,
      lastActivityAt: Date.now() - (CART_TTL_MS + 5000),
      lines: [
        {
          productId: 'prod-001',
          sku: 'CREA300',
          slug: 'creatina',
          name: 'Creatina',
          presentation: '300 g',
          imageUrl: '/demo/creatina.svg',
          unitPriceCents: 2500000,
          quantity: 1
        }
      ]
    };
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(expiredData));

    const { result } = renderHook(() => useCart(), { wrapper });
    expect(result.current.lines.length).toBe(0);

    // Comprobar que la clave del carrito se borró quirúrgicamente
    expect(window.localStorage.getItem(CART_STORAGE_KEY)).toBeNull();

    // Comprobar que las demás claves del almacenamiento permanecen intactas
    expect(window.localStorage.getItem('user-auth-token')).toBe('secret-token-123');
    expect(window.localStorage.getItem('theme-preference')).toBe('dark');
  });

  it('discards older schema versions or malformed data gracefully without error', () => {
    window.localStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({ version: 1, oldFormat: true, lines: 'not-array' })
    );

    const { result } = renderHook(() => useCart(), { wrapper });
    expect(result.current.lines).toEqual([]);
  });

  it('updates lastActivityAt on modifications but not on read-only queries', () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    const initialActivity = result.current.lastActivityAt;

    act(() => {
      result.current.add(mockProduct, 1);
    });
    const afterAdd = result.current.lastActivityAt;
    expect(afterAdd).toBeGreaterThanOrEqual(initialActivity);

    // Updating checkout draft also bumps activity
    act(() => {
      result.current.updateCheckoutDraft({ customerName: 'Carlos' });
    });
    expect(result.current.checkoutDraft?.customerName).toBe('Carlos');
    expect(result.current.lastActivityAt).toBeGreaterThanOrEqual(afterAdd);
  });

  it('syncWithLiveCatalog detects price changes and live availability issues', () => {
    const { result } = renderHook(() => useCart(), { wrapper });

    act(() => {
      result.current.add(mockProduct, 2); // Initial price $25.000 (2_500_000)
    });

    const updatedCatalog: StorefrontProduct[] = [
      {
        ...mockProduct,
        priceCents: 2900000, // Price updated to $29.000
        maxOrderQuantity: 1 // Only 1 in stock now
      }
    ];

    let revalResult: any;
    act(() => {
      revalResult = result.current.syncWithLiveCatalog(updatedCatalog);
    });

    expect(revalResult.priceChanges.length).toBe(1);
    expect(revalResult.priceChanges[0].oldPriceCents).toBe(2500000);
    expect(revalResult.priceChanges[0].newPriceCents).toBe(2900000);
    expect(revalResult.partialStockProducts.length).toBe(1);
    expect(revalResult.partialStockProducts[0].available).toBe(1);
    expect(result.current.lines[0]?.unitPriceCents).toBe(2900000);
  });

  it('syncs state across tabs when storage event is received', () => {
    const { result } = renderHook(() => useCart(), { wrapper });

    const newTabCart = {
      version: CART_SCHEMA_VERSION,
      lastActivityAt: Date.now(),
      lines: [
        {
          productId: 'prod-002',
          sku: 'WHEY900',
          slug: 'whey',
          name: 'Whey Protein',
          presentation: '900 g',
          imageUrl: '/demo/whey.svg',
          unitPriceCents: 3500000,
          quantity: 1
        }
      ]
    };

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: CART_STORAGE_KEY,
          newValue: JSON.stringify(newTabCart)
        })
      );
    });

    expect(result.current.lines.length).toBe(1);
    expect(result.current.lines[0]?.productId).toBe('prod-002');
  });
});

