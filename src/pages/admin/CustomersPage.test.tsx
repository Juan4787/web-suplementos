import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoCustomers, demoOrders, demoOwner } from '@/data/demo-data';
import CustomersPage from './CustomersPage';

const api = vi.hoisted(() => ({ listCustomers: vi.fn(), listCustomerOrders: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: demoOwner }) }));

function Wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('Historial del cliente', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.listCustomers.mockResolvedValue({ items: [demoCustomers[0]], total: 1, page: 1, pageSize: 30 });
  });
  afterEach(cleanup);

  it('consulta y pagina al cliente seleccionado sin descargar el historial global', async () => {
    api.listCustomerOrders.mockResolvedValue({ items: [demoOrders[0]], total: 21, page: 1, pageSize: 20 });
    render(<CustomersPage />, { wrapper: Wrapper });
    const customer = await screen.findByRole('button', { name: `Ver cliente ${demoCustomers[0]!.name}` });
    expect(api.listCustomerOrders).not.toHaveBeenCalled();
    fireEvent.keyDown(customer, { key: 'Enter' });
    await screen.findByText(`Pedido #${demoOrders[0]!.number}`);
    expect(api.listCustomerOrders).toHaveBeenCalledWith(demoCustomers[0]!.id, 1, 20);
    fireEvent.click(screen.getByRole('button', { name: /Siguiente/ }));
    await waitFor(() => expect(api.listCustomerOrders).toHaveBeenLastCalledWith(demoCustomers[0]!.id, 2, 20));
  });

  it('muestra el error del historial y permite reintentar conservando el cliente', async () => {
    api.listCustomerOrders.mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue({ items: [demoOrders[0]], total: 1, page: 1, pageSize: 20 });
    render(<CustomersPage />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByRole('button', { name: `Ver cliente ${demoCustomers[0]!.name}` }));
    fireEvent.click(await screen.findByRole('button', { name: /Intentar de nuevo/ }));
    await screen.findByText(`Pedido #${demoOrders[0]!.number}`);
    expect(api.listCustomerOrders).toHaveBeenCalledTimes(2);
  });
});
