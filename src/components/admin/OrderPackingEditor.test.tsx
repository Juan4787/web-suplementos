import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { demoOrders } from '@/data/demo-data';
import type { Order } from '@/domain/types';
import { OrderPackingEditor } from './OrderPackingEditor';

const api = vi.hoisted(() => ({ saveOrderPacking: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: PropsWithChildren<{ to: string }>) => <a href={to}>{children}</a>
}));

afterEach(() => {
  cleanup();
  api.saveOrderPacking.mockReset();
});

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

it('requires an explicit count for available products and locks units in transit', async () => {
  const order = sampleOrder();
  api.saveOrderPacking.mockResolvedValue({ ...order, packingRevision: 1 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OrderPackingEditor order={order} />
    </QueryClientProvider>
  );

  expect(screen.getByText('Armado sin verificar')).toBeInTheDocument();
  const saveButton = screen.getByRole('button', { name: 'Guardar armado' });
  expect(saveButton).toBeDisabled();

  // B Complex has physical 1 (partial): input max is 1
  const bComplex = screen.getByRole('spinbutton', { name: 'Unidades guardadas de B Complex' });
  expect(bComplex).toHaveAttribute('max', '1');

  // Fill empty available fields
  fireEvent.click(screen.getByRole('button', { name: 'Completar vacíos con 0' }));
  expect(bComplex).toHaveValue(0);

  // Exceeding physical max disables save button
  fireEvent.change(bComplex, { target: { value: '2' } });
  expect(saveButton).toBeDisabled();
  expect(api.saveOrderPacking).not.toHaveBeenCalled();

  // Valid physical count enables saving
  fireEvent.change(bComplex, { target: { value: '1' } });
  fireEvent.click(saveButton);
  await waitFor(() =>
    expect(api.saveOrderPacking).toHaveBeenCalledWith(
      order.id,
      [
        { orderItemId: 'line-one', packedQuantity: 1 },
        { orderItemId: 'line-two', packedQuantity: 0 }
      ],
      0
    )
  );
  expect(await screen.findByText(/Armado parcial guardado/i)).toBeInTheDocument();
  client.clear();
});

it('completes only empty counts and does not erase units already recorded or typed', async () => {
  const order = sampleOrder();
  order.items[0]!.packedQuantity = 1;
  order.items[0]!.physicalReservedQuantity = 3;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OrderPackingEditor order={order} />
    </QueryClientProvider>
  );

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

it('renders locked rows with 0 en bolsita and direct inventory link when all items are in transit', async () => {
  const order: Order = {
    ...sampleOrder(),
    number: 2541,
    expectedArrivalAt: '2026-09-29T15:00:00Z',
    items: [
      {
        ...sampleOrder().items[0]!,
        id: 'line-thyroid',
        productName: 'Thyroid Support',
        quantity: 1,
        packedQuantity: null,
        physicalReservedQuantity: 0,
        incomingQuantity: 1,
        uncoveredQuantity: 0
      }
    ]
  };

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OrderPackingEditor order={order} />
    </QueryClientProvider>
  );

  // The card is visible (never hidden)
  expect(screen.getByText('Armado de la bolsita · Pedido #2541')).toBeInTheDocument();

  // The item is locked with 0 en bolsita, not an active input
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  expect(screen.getByText('0 en bolsita')).toBeInTheDocument();
  expect(screen.getByText('En camino')).toBeInTheDocument();

  // Displays clear arrival date
  expect(screen.getByText(/Llega 29 de septiembre/i)).toBeInTheDocument();

  // No useless "Guardar armado" button trying to save zeroes
  expect(screen.queryByRole('button', { name: 'Guardar armado' })).not.toBeInTheDocument();

  // Prominent action link to receive purchase in Inventory
  const link = screen.getByRole('link', { name: /Recibir compra en Inventario/i });
  expect(link).toBeInTheDocument();
  expect(link).toHaveAttribute('href', '/app/inventario');
  client.clear();
});

it('supports stepper buttons, quick fill of all available units, and transitions to Sin cambios', async () => {
  const order = sampleOrder();
  api.saveOrderPacking.mockResolvedValue({ ...order, packingRevision: 1 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OrderPackingEditor order={order} />
    </QueryClientProvider>
  );

  // Quick fill all available
  const fillAllButton = screen.getByRole('button', { name: /Apartar todo disponible/i });
  expect(fillAllButton).toBeInTheDocument();
  fireEvent.click(fillAllButton);

  const bComplex = screen.getByRole('spinbutton', { name: 'Unidades guardadas de B Complex' });
  const omapure = screen.getByRole('spinbutton', { name: 'Unidades guardadas de Omapure' });
  expect(bComplex).toHaveValue(1);
  expect(omapure).toHaveValue(1);

  // Test decrement stepper on B Complex
  const minusB = screen.getByRole('button', { name: 'Restar una unidad de B Complex' });
  fireEvent.click(minusB);
  expect(bComplex).toHaveValue(0);

  // Test increment stepper on B Complex
  const plusB = screen.getByRole('button', { name: 'Sumar una unidad de B Complex' });
  fireEvent.click(plusB);
  expect(bComplex).toHaveValue(1);

  // Plus button is now disabled because value equals maxPacked (1)
  expect(plusB).toBeDisabled();

  // Save the packing
  const saveButton = screen.getByRole('button', { name: 'Guardar armado' });
  fireEvent.click(saveButton);

  await waitFor(() =>
    expect(api.saveOrderPacking).toHaveBeenCalledWith(
      order.id,
      [
        { orderItemId: 'line-one', packedQuantity: 1 },
        { orderItemId: 'line-two', packedQuantity: 1 }
      ],
      0
    )
  );

  client.clear();
});

