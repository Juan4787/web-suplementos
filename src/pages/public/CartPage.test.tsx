import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorefrontProduct } from '@/domain/types';
import { CART_STORAGE_KEY, CartProvider } from '@/features/cart/CartProvider';
import CartPage from './CartPage';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, hash, className }: PropsWithChildren<{ to?: string; hash?: string; className?: string }>) => (
    <a href={`${to || ''}${hash ? `#${hash}` : ''}`} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn()
}));

const mockProducts: StorefrontProduct[] = [
  {
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
  },
  {
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
  }
];

vi.mock('@/services/business-api', () => ({
  getBusinessApi: vi.fn(async () => ({
    listStorefrontProducts: async () => mockProducts,
    quoteCartEta: async () => ({
      ok: true,
      requiresIncoming: false,
      quotedEta: null
    })
  }))
}));

const createTestWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false }
    }
  });

  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>
        <CartProvider>{children}</CartProvider>
      </QueryClientProvider>
    );
  };
};

describe('CartPage Rendering and Flicker Prevention', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it('renders EmptyState when cart is empty', async () => {
    const Wrapper = createTestWrapper();
    render(<CartPage />, { wrapper: Wrapper });

    expect(await screen.findByText('Tu carrito está vacío')).toBeInTheDocument();
    expect(screen.getByText(/Guardamos tu selección en este dispositivo/i)).toBeInTheDocument();
  });

  it('renders cart items, subtotal, and transitions smoothly to empty state when removing products without infinite loops', async () => {
    window.localStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        lastActivityAt: Date.now(),
        lines: [
          {
            productId: 'prod-001',
            sku: 'CREA300',
            slug: 'creatina-300g',
            name: 'Creatina Monohidratada',
            presentation: '300 g',
            imageUrl: '/demo/creatina.svg',
            unitPriceCents: 2500000,
            quantity: 1
          }
        ]
      })
    );

    const Wrapper = createTestWrapper();
    render(<CartPage />, { wrapper: Wrapper });

    // Item should be visible
    expect(await screen.findByText('Creatina Monohidratada')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /Carrito/i })).toHaveTextContent('Carrito (1)');

    // Remove the item
    const removeBtn = screen.getByRole('button', { name: /quitar/i });
    fireEvent.click(removeBtn);

    // Empty state should be visible immediately and stably
    await waitFor(() => {
      expect(screen.getByText('Tu carrito está vacío')).toBeInTheDocument();
    });

    expect(screen.getByRole('heading', { level: 1, name: /Carrito/i })).toHaveTextContent('Carrito (0)');
  });

  it('clears price change banner when cart becomes empty', async () => {
    window.localStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        lastActivityAt: Date.now(),
        lines: [
          {
            productId: 'prod-001',
            sku: 'CREA300',
            slug: 'creatina-300g',
            name: 'Creatina Monohidratada',
            presentation: '300 g',
            imageUrl: '/demo/creatina.svg',
            unitPriceCents: 2000000, // Stale price vs 2500000
            quantity: 1
          }
        ]
      })
    );

    const Wrapper = createTestWrapper();
    render(<CartPage />, { wrapper: Wrapper });

    // Notice banner should appear for price change
    expect(await screen.findByText(/Actualizamos tu pedido con los precios vigentes/i)).toBeInTheDocument();

    // Now remove product
    const removeBtn = screen.getByRole('button', { name: /quitar/i });
    fireEvent.click(removeBtn);

    // Both the product and the price change banner should be removed
    await waitFor(() => {
      expect(screen.getByText('Tu carrito está vacío')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Actualizamos tu pedido con los precios vigentes/i)).toBeNull();
  });
});
