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
  if (variant === 'regalo') expect(screen.getByText('Entregado')).toBeInTheDocument();
  client.clear();
});

it('permite marcar un pedido como listo para entregar desde las acciones operativas', async () => {
  let order: Order = {
    ...demoOrders[0]!,
    orderState: 'confirmed',
    paymentState: 'pending',
    preparationState: 'pending',
    fulfillmentState: 'pending',
    stockReadiness: 'ready'
  };

  api.listOrders.mockImplementation(async () => ({
    items: [order],
    total: 1,
    page: 1,
    pageSize: 50,
    pendingTotal: 1,
    completedTotal: 0
  }));

  api.transitionOrder.mockImplementation(async (_id, action) => {
    if (action === 'mark_ready') {
      order = { ...order, preparationState: 'ready' };
    }
    return order;
  });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <OrdersPage />
    </QueryClientProvider>
  );

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  const readyButton = screen.getByRole('button', { name: /Marcar listo para entregar/i });
  expect(readyButton).toBeInTheDocument();
  fireEvent.click(readyButton);

  await waitFor(() => expect(api.transitionOrder).toHaveBeenCalledWith(order.id, 'mark_ready'));
  expect(
    await screen.findByText(`Pedido #${order.number} marcado como listo para entrega.`)
  ).toBeInTheDocument();
  client.clear();
});

it('pide revisar físicamente una bolsita histórica lista antes de descontar su stock', async () => {
  const order: Order = {
    ...demoOrders[0]!,
    orderState: 'confirmed',
    paymentState: 'paid',
    preparationState: 'ready',
    fulfillmentState: 'pending',
    packingTracked: false,
    stockReadiness: 'ready',
    items: demoOrders[0]!.items.map(item => ({ ...item, packedQuantity: null }))
  };
  api.listOrders.mockResolvedValue({
    items: [order], total: 1, page: 1, pageSize: 50,
    pendingTotal: 1, completedTotal: 0, preparingTotal: 0, readyPickupTotal: 0
  });
  api.transitionOrder.mockResolvedValue({ ...order, fulfillmentState: 'delivered' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><OrdersPage /></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como entregado' }));
  expect(api.transitionOrder).not.toHaveBeenCalled();
  expect(screen.getByText(/La bolsita figura sin verificar en la app/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sí, ya verifiqué y entregar' }));
  await waitFor(() => expect(api.transitionOrder).toHaveBeenCalledWith(order.id, 'mark_delivered'));
  client.clear();
});

it('pide la misma verificación al enviar un pedido histórico listo', async () => {
  const order: Order = {
    ...demoOrders[0]!,
    orderState: 'confirmed', paymentState: 'paid', preparationState: 'ready',
    fulfillmentState: 'pending', packingTracked: false, stockReadiness: 'ready',
    items: demoOrders[0]!.items.map(item => ({ ...item, packedQuantity: null }))
  };
  api.listOrders.mockResolvedValue({
    items: [order], total: 1, page: 1, pageSize: 50,
    pendingTotal: 1, completedTotal: 0, preparingTotal: 0, readyPickupTotal: 0
  });
  api.transitionOrder.mockResolvedValue({ ...order, fulfillmentState: 'shipped' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><OrdersPage /></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como enviado' }));
  expect(api.transitionOrder).not.toHaveBeenCalled();
  expect(screen.getByText(/La bolsita figura sin verificar en la app/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sí, ya verifiqué y enviar' }));
  await waitFor(() => expect(api.transitionOrder).toHaveBeenCalledWith(order.id, 'mark_shipped'));
  client.clear();
});

it('mantiene visible la tarjeta de bolsita con estado bloqueado e invitación a Inventario cuando toda la mercadería está en camino', async () => {
  const order: Order = {
    ...demoOrders[0]!, orderState: 'confirmed', paymentState: 'gifted', paymentMethod: 'gift',
    preparationState: 'pending', fulfillmentState: 'pending', stockReadiness: 'waiting_incoming',
    expectedArrivalAt: '2026-09-29T12:00:00Z',
    items: [{
      ...demoOrders[0]!.items[0]!, quantity: 1, packedQuantity: null,
      physicalReservedQuantity: 0, incomingQuantity: 1, uncoveredQuantity: 0
    }]
  };
  api.listOrders.mockResolvedValue({
    items: [order], total: 1, page: 1, pageSize: 50,
    pendingTotal: 1, completedTotal: 0, preparingTotal: 0, readyPickupTotal: 0
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><OrdersPage /></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  expect(screen.getByText('Qué sigue')).toBeInTheDocument();
  expect(screen.getAllByText('Regalo / Cortesía')).toHaveLength(1);
  expect(screen.getByText('Esperando mercadería')).toBeInTheDocument();
  expect(screen.queryByText('Falta preparar')).not.toBeInTheDocument();
  expect(screen.getAllByText('Mercadería en camino')).toHaveLength(1);
  expect(screen.getByText(/Recibí la compra en Inventario\. Después completá el armado/)).toBeInTheDocument();
  expect(screen.getByRole('region', { name: `Armado del pedido ${order.number}` })).toBeInTheDocument();
  expect(screen.getByText('0 en bolsita')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Recibir compra en Inventario/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Guardar armado' })).not.toBeInTheDocument();
  expect(screen.queryByText('Medio de pago')).not.toBeInTheDocument();
  expect(screen.queryByText(/Stock descontado/)).not.toBeInTheDocument();
  client.clear();
});

it('mantiene el formulario cuando hay unidades físicas para un armado parcial', async () => {
  const order: Order = {
    ...demoOrders[0]!, orderState: 'confirmed', paymentState: 'paid',
    preparationState: 'preparing', fulfillmentState: 'pending', stockReadiness: 'waiting_incoming',
    items: [{
      ...demoOrders[0]!.items[0]!, quantity: 2, packedQuantity: 1,
      physicalReservedQuantity: 1, incomingQuantity: 1, uncoveredQuantity: 0
    }]
  };
  api.listOrders.mockResolvedValue({
    items: [order], total: 1, page: 1, pageSize: 50,
    pendingTotal: 1, completedTotal: 0, preparingTotal: 1, readyPickupTotal: 0
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><OrdersPage /></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  expect(screen.getByRole('region', { name: `Armado del pedido ${order.number}` })).toBeInTheDocument();
  expect(screen.getAllByText('Mercadería en camino')).toHaveLength(1);
  client.clear();
});
