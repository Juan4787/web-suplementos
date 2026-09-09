import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import { demoProducts } from '@/data/demo-data';
import ProductPage from './ProductPage';
import { ProductCard } from '@/components/store/ProductCard';

const mocks = vi.hoisted(() => ({ query: vi.fn(), add: vi.fn(), lines: [] as Array<{ productId: string; quantity: number }> }));
vi.mock('@/app/use-business-query', () => ({ useBusinessQuery: mocks.query }));
vi.mock('@/features/cart/CartProvider', () => ({ useCart: () => ({ add: mocks.add, lines: mocks.lines }) }));
vi.mock('@/components/layout/PublicShell', () => ({ PublicShell: ({ children }: PropsWithChildren) => <>{children}</> }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'creatina' }),
  Link: ({ children, to }: PropsWithChildren<{ to: string }>) => <a href={to}>{children}</a>
}));

describe('Precio y disponibilidad de productos', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.lines = []; });
  afterEach(cleanup);

  it('conserva el precio de un agotado y explica por qué no se puede agregar', () => {
    mocks.query.mockReturnValue({ data: { ...demoProducts[0], priceCents: 3300000, availability: 'out_of_stock', maxOrderQuantity: 0, incomingAvailable: 0 }, isSuccess: true });
    render(<ProductPage />);
    expect(screen.getByText(/33\.000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agotado' })).toBeDisabled();
    expect(screen.getByText(/Por ahora este producto no está disponible/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sumar una unidad' })).not.toBeInTheDocument();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('separa el subtotal del precio unitario y permite pedir unidades en camino', () => {
    mocks.query.mockReturnValue({ data: { ...demoProducts[0], priceCents: 3300000, availability: 'incoming', maxOrderQuantity: 2, incomingAvailable: 2 }, isSuccess: true });
    render(<ProductPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Sumar una unidad' }));
    expect(screen.getByText(/Subtotal por 2 unidades:.*66\.000/)).toBeInTheDocument();
    expect(screen.getByText(/Precio por unidad/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar al carrito' }));
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({ availability: 'incoming' }), 2);
  });

  it('el botón del catálogo comunica agotado también a tecnologías de asistencia', () => {
    const product = { ...demoProducts[0]!, availability: 'out_of_stock' as const, maxOrderQuantity: 0, incomingAvailable: 0 };
    render(<ProductCard product={product} />);
    expect(screen.getByRole('button', { name: `${product.name}: agotado` })).toBeDisabled();
    expect(screen.getByText('Agotado')).toBeInTheDocument();
  });

  it('no simula agregar unidades cuando el carrito ya contiene el máximo disponible', () => {
    mocks.lines = [{ productId: demoProducts[0]!.id, quantity: 2 }];
    mocks.query.mockReturnValue({ data: { ...demoProducts[0], availability: 'available', maxOrderQuantity: 2, incomingAvailable: 0 }, isSuccess: true });
    render(<ProductPage />);
    expect(screen.getByRole('button', { name: 'Máximo en carrito' })).toBeDisabled();
    expect(screen.getByText(/Ya tenés en el carrito todas las unidades/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ver carrito y finalizar/ })).toBeInTheDocument();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
