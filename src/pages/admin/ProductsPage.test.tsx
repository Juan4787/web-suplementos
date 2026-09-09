import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoOwner, demoProducts } from '@/data/demo-data';
import { demoBusinessApi } from '@/services/demo-business-api';
import ProductsPage from './ProductsPage';
import InventoryPage from './InventoryPage';

vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => demoBusinessApi }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: demoOwner }) }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}) }));

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
});

function Navigation() {
  const [page, setPage] = useState('products');
  return <>
    <button onClick={() => setPage('products')}>Ir a Productos</button>
    <button onClick={() => setPage('inventory')}>Ir a Inventario</button>
    {page === 'products' ? <ProductsPage /> : <InventoryPage />}
  </>;
}

describe('Compras reflejadas en Productos', () => {
  it('separa las unidades disponibles de las pendientes y actualiza ambas al recibir o cerrar la compra', async () => {
    // A new product starts without physical stock or purchases; all mutations use the local API.
    const { id: _id, ...template } = demoProducts[0]!;
    const product = await demoBusinessApi.saveProduct({
      ...template,
      sku: 'STOCK-CRUCE', slug: 'stock-cruce', name: 'Producto para cruce de compras'
    });
    // Fresh cached data must still be invalidated by purchase/receipt mutations.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><Navigation /></QueryClientProvider>);

    const stock = async (available: number, incoming: number) => {
      fireEvent.click(screen.getByRole('button', { name: 'Ir a Productos' }));
      await waitFor(() => {
        const card = screen.getByRole('heading', { name: product.name }).closest('article')!;
        const details = within(card);
        expect(details.getByText('Disponible ahora').nextElementSibling).toHaveTextContent(
          new RegExp(`^${available} ${available === 1 ? 'unidad' : 'unidades'}$`)
        );
        if (incoming > 0) {
          expect(details.getByText('En camino').nextElementSibling).toHaveTextContent(
            new RegExp(`^${incoming} ${incoming === 1 ? 'unidad' : 'unidades'}$`)
          );
          expect(details.getByText('Se suman al stock al recibir la mercadería.')).toBeVisible();
        } else {
          expect(details.queryByText('En camino')).toBeNull();
        }
        expect(card).not.toHaveTextContent('0 · En camino');
      });
    };
    const purchases = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ir a Inventario' }));
      fireEvent.click(screen.getByRole('button', { name: 'Compras' }));
      await screen.findByRole('heading', { name: 'Pedidos al proveedor' });
    };
    const create = async (quantity: number) => {
      await purchases();
      fireEvent.click(screen.getByRole('button', { name: 'Nuevo pedido' }));
      fireEvent.change(screen.getByLabelText('Proveedor · opcional'), { target: { value: 'Proveedor de cruce' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Producto de la fila 1' }));
      fireEvent.click(await screen.findByRole('option', { name: new RegExp(product.name) }));
      fireEvent.change(screen.getByLabelText('Cantidad'), { target: { value: String(quantity) } });
      fireEvent.click(screen.getByRole('button', { name: 'Guardar pedido' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    const openReceipt = async () => {
      await purchases();
      const supplier = await screen.findByText('Proveedor de cruce');
      fireEvent.click(within(supplier.closest('article')!).getByRole('button', { name: 'Recibir mercadería' }));
      return screen.getByLabelText('Unidades a ingresar en esta entrega:');
    };
    const receive = async (quantity: number) => {
      const input = await openReceipt();
      fireEvent.change(input, { target: { value: String(quantity) } });
      fireEvent.click(screen.getByRole('button', { name: `Ingresar ${quantity} unidades` }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };

    await stock(0, 0);
    await create(30);
    await stock(0, 30);
    await receive(5);
    await stock(5, 25);
    await receive(25);
    await stock(30, 0);

    // An additional purchase is visible even with physical stock already available.
    await create(1);
    await stock(30, 1);
    const input = await openReceipt();
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Declarar faltante' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar cierre definitivo' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await stock(30, 0);

    await act(async () => {
      const saved = (await demoBusinessApi.listAdminProducts()).find(item => item.id === product.id)!;
      expect(saved.onHand).toBe(30);
      expect(saved.incoming).toBe(0);
    });
  }, 20000);
});
