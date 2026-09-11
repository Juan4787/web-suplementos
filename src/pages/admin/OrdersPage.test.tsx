import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Order } from '@/domain/types';
import { demoOrders } from '@/data/demo-data';
import OrdersPage from './OrdersPage';

const api = vi.hoisted(() => ({ listOrders: vi.fn(), transitionOrder: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/components/layout/AdminShell', () => ({ PageHeader: () => <h1>Pedidos</h1> }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}), Link: ({ children, to }: PropsWithChildren<{ to: string }>) => <a href={to}>{children}</a> }));
afterEach(cleanup);

it.each(['entrega', 'cancelación', 'regalo'])('confirma %s fuera de la tarjeta y permite encontrar el pedido nuevamente', async variant => {
  let order: Order = { ...demoOrders[0]!, orderState: 'confirmed', paymentState: variant === 'entrega' ? 'paid' : 'pending', fulfillmentState: 'pending', stockReadiness: 'ready' };
  const completed = () => order.orderState === 'cancelled' || order.fulfillmentState === 'delivered';
  api.listOrders.mockImplementation(async (_page, _size, _query, filter) => ({
    items: filter === 'pending' && completed() ? [] : [order],
    total: 1, page: 1, pageSize: 50, pendingTotal: completed() ? 0 : 1, completedTotal: completed() ? 1 : 0
  }));
  api.transitionOrder.mockImplementation(async () => {
    if (variant === 'entrega') {
      order = { ...order, fulfillmentState: 'delivered' };
    } else if (variant === 'cancelación') {
      order = { ...order, orderState: 'cancelled' };
    } else {
      order = { ...order, paymentState: 'gifted', fulfillmentState: 'delivered', totalCents: 0 };
    }
    return order;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><OrdersPage /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  if (variant === 'entrega') {
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como entregado' }));
  } else if (variant === 'cancelación') {
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar pedido' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sí, cancelar pedido' }));
  } else {
    fireEvent.click(screen.getByRole('button', { name: /Regalar/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Sí, registrar como regalo' }));
  }
  const statusWord =
    variant === 'entrega' ? 'completado' : variant === 'cancelación' ? 'cancelado' : 'registrado como regalo / cortesía';
  expect(await screen.findByText(`Pedido #${order.number} ${statusWord}. Lo encontrás en Completados.`)).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: /Ocultar acciones/ })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Ver pedido' }));
  await waitFor(() => expect(api.listOrders).toHaveBeenLastCalledWith(1, 50, String(order.number), 'completed'));
  expect(await screen.findByText('Productos pedidos')).toBeInTheDocument();
  client.clear();
});
