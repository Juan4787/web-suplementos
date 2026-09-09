import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoProducts, demoSettings } from '@/data/demo-data';
import { CART_STORAGE_KEY, CartProvider } from '@/features/cart/CartProvider';
import CheckoutPage from './CheckoutPage';

const api = vi.hoisted(() => ({ listStorefrontProducts: vi.fn(), getSettings: vi.fn(), quoteCartEta: vi.fn(), validateAvailability: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/components/layout/PublicShell', () => ({ PublicShell: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: PropsWithChildren<{ to: string }>) => <a href={to}>{children}</a>,
  Navigate: () => null
}));

function Wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}><CartProvider>{children}</CartProvider></QueryClientProvider>;
}

describe('Checkout con cambios o fallos de conexión', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    const product = demoProducts[0]!;
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify({
      version: 2, lastActivityAt: Date.now(),
      lines: [{ productId: product.id, sku: product.sku, slug: product.slug, name: product.name,
        presentation: product.presentation, imageUrl: product.imageUrl, unitPriceCents: product.priceCents, quantity: 1 }]
    }));
    api.listStorefrontProducts.mockResolvedValue(demoProducts);
    api.getSettings.mockResolvedValue(demoSettings);
    api.quoteCartEta.mockResolvedValue({ ok: true, requiresIncoming: false, quotedEta: null });
    api.validateAvailability.mockResolvedValue({ ok: true, issues: [] });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('explica cómo continuar al entrar con el carrito vacío', () => {
    localStorage.clear();
    render(<CheckoutPage />, { wrapper: Wrapper });
    expect(screen.getByText('Tu carrito está vacío')).toBeInTheDocument();
    expect(screen.getByText('Sumá productos para continuar con tu pedido.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver productos' })).toHaveAttribute('href', '/');
  });

  it('permite recuperar la configuración sin borrar los datos del cliente', async () => {
    api.getSettings.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(demoSettings);
    render(<CheckoutPage />, { wrapper: Wrapper });
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Cliente de prueba' } });
    fireEvent.click(await screen.findByRole('button', { name: /Intentar de nuevo/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Continuar por WhatsApp/ })).toBeEnabled());
    expect(screen.getByLabelText('Nombre')).toHaveValue('Cliente de prueba');
  });

  it('pide revisar el nuevo precio antes de enviar y usa ese precio al continuar', async () => {
    const popup = { location: { href: 'about:blank' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    render(<CheckoutPage />, { wrapper: Wrapper });
    const button = screen.getByRole('button', { name: /Continuar por WhatsApp/ });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Cliente de prueba' } });
    api.listStorefrontProducts.mockResolvedValue(demoProducts.map(p => ({ ...p, priceCents: p.priceCents + 10000 })));
    fireEvent.click(button);
    await screen.findByText(/Revisá el nuevo importe y volvé a continuar/);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe('about:blank');
    await waitFor(() => expect(button).toBeEnabled(), { timeout: 2000 });
    fireEvent.click(button);
    await waitFor(() => expect(popup.location.href).toMatch(/wa\.me|whatsapp/));
    expect(api.validateAvailability).toHaveBeenCalledTimes(2);
  });
});
