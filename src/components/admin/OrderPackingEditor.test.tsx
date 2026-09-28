import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { demoOrders } from '@/data/demo-data';
import type { Order } from '@/domain/types';
import { OrderPackingEditor } from './OrderPackingEditor';

const api = vi.hoisted(() => ({ saveOrderPacking: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
afterEach(() => { cleanup(); api.saveOrderPacking.mockReset(); });

const sampleOrder = (): Order => ({
  ...demoOrders[0]!,
  packingRevision: 0,
  packingTracked: false,
  preparationState: 'pending',
  items: [
    {
      ...demoOrders[0]!.items[0]!,
      id: 'line-one',
      productName: 'B Complex',
      quantity: 2,
      packedQuantity: null,
      physicalReservedQuantity: 1,
      incomingQuantity: 1,
      uncoveredQuantity: 0
    },
    {
      ...demoOrders[0]!.items[0]!,
      id: 'line-two',
      productName: 'Omapure',
      quantity: 1,
      packedQuantity: null,
      physicalReservedQuantity: 1,
      incomingQuantity: 0,
      uncoveredQuantity: 0
    }
  ]
});

it('requires an explicit count for every product and saves only physically reserved units', async () => {
  const order = sampleOrder();
  api.saveOrderPacking.mockResolvedValue({ ...order, packingRevision: 1 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><OrderPackingEditor order={order} /></QueryClientProvider>);

  expect(screen.getByText('Armado sin verificar')).toBeInTheDocument();
  const saveButton = screen.getByRole('button', { name: 'Guardar armado' });
  expect(saveButton).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Completar vacíos con 0' }));
  expect(screen.getByRole('spinbutton', { name: 'Unidades guardadas de B Complex' })).toHaveValue(0);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Unidades guardadas de B Complex' }), { target: { value: '2' } });
  expect(saveButton).toBeDisabled();
  expect(api.saveOrderPacking).not.toHaveBeenCalled();

  fireEvent.change(screen.getByRole('spinbutton', { name: 'Unidades guardadas de B Complex' }), { target: { value: '1' } });
  fireEvent.click(saveButton);
  await waitFor(() => expect(api.saveOrderPacking).toHaveBeenCalledWith(order.id, [
    { orderItemId: 'line-one', packedQuantity: 1 },
    { orderItemId: 'line-two', packedQuantity: 0 }
  ], 0));
  expect(await screen.findByText(`Armado guardado para el pedido #${order.number}.`)).toBeInTheDocument();
  client.clear();
});

it('completes only empty counts and does not erase units already recorded or typed', async () => {
  const order = sampleOrder();
  order.items[0]!.packedQuantity = 1;
  order.items[0]!.physicalReservedQuantity = 3;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><OrderPackingEditor order={order} /></QueryClientProvider>);

  const first = screen.getByRole('spinbutton', { name: 'Unidades guardadas de B Complex' });
  const second = screen.getByRole('spinbutton', { name: 'Unidades guardadas de Omapure' });
  expect(first).toHaveAttribute('max', '2');
  fireEvent.change(first, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Completar vacíos con 0' }));
  expect(first).toHaveValue(2);
  expect(second).toHaveValue(0);
  fireEvent.change(first, { target: { value: '3' } });
  expect(screen.getByRole('button', { name: 'Guardar armado' })).toBeDisabled();
  expect(api.saveOrderPacking).not.toHaveBeenCalled();
  client.clear();
});
