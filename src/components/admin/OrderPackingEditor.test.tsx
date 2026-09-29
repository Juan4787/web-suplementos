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
  Link: ({ children, to, ...props }: PropsWithChildren<{ to: string } & Record<string, unknown>>) => (
    <a href={to} {...props}>{children}</a>
  )
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
  const bComplex = screen.getByRole('textbox', { name: 'Unidades en bolsita de B Complex' });
  expect(bComplex).toHaveAttribute('inputmode', 'numeric');
  expect(bComplex).toHaveAttribute('placeholder', '—');
  expect(bComplex).toHaveAttribute('aria-describedby', 'packing-limit-line-one');
  fireEvent.focus(bComplex);
  fireEvent.blur(bComplex);
  expect(bComplex).toHaveValue('');
  expect(saveButton).toBeDisabled();

  // Fill empty available fields
  fireEvent.click(screen.getByRole('button', { name: 'Completar vacíos con 0' }));
  expect(bComplex).toHaveValue('0');

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

  const first = screen.getByRole('textbox', { name: 'Unidades en bolsita de B Complex' });
  const second = screen.getByRole('textbox', { name: 'Unidades en bolsita de Omapure' });
  expect(screen.getByText('/ 2 máximo')).toBeInTheDocument();
  fireEvent.change(first, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Completar vacíos con 0' }));
  expect(first).toHaveValue('2');
  expect(second).toHaveValue('0');
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
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.getByText('0 en bolsita')).toBeInTheDocument();
  expect(screen.getByText('En camino')).toBeInTheDocument();

  // La fecha del pedido puede pertenecer a otra compra: no se atribuye a esta línea.
  expect(screen.getByText(/En camino: 1/i)).toBeInTheDocument();
  expect(screen.queryByText(/Llega 29 de septiembre/i)).not.toBeInTheDocument();

  // No useless "Guardar armado" button trying to save zeroes
  expect(screen.queryByRole('button', { name: 'Guardar armado' })).not.toBeInTheDocument();

  // Prominent action link to receive purchase in Inventory
  const link = screen.getByRole('link', { name: /Ver compra en Inventario/i });
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
  const fillAllButton = screen.getByRole('button', { name: /Ya guardé todo lo reservado/i });
  expect(fillAllButton).toBeInTheDocument();
  fireEvent.click(fillAllButton);

  const bComplex = screen.getByRole('textbox', { name: 'Unidades en bolsita de B Complex' });
  const omapure = screen.getByRole('textbox', { name: 'Unidades en bolsita de Omapure' });
  expect(bComplex).toHaveValue('1');
  expect(omapure).toHaveValue('1');

  // Test decrement stepper on B Complex
  const minusB = screen.getByRole('button', { name: 'Restar una unidad de B Complex' });
  fireEvent.click(minusB);
  expect(bComplex).toHaveValue('0');

  // Test increment stepper on B Complex
  const plusB = screen.getByRole('button', { name: 'Sumar una unidad de B Complex' });
  fireEvent.click(plusB);
  expect(bComplex).toHaveValue('1');

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

it('distingue una falta sin reposición de mercadería en camino cuando no hay reserva física', () => {
  const order: Order = {
    ...sampleOrder(),
    stockReadiness: 'uncovered',
    items: [{
      ...sampleOrder().items[0]!,
      quantity: 2,
      physicalReservedQuantity: 0,
      incomingQuantity: 1,
      uncoveredQuantity: 1
    }]
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><OrderPackingEditor order={order} /></QueryClientProvider>);

  expect(screen.getByText('En camino y sin reposición')).toBeInTheDocument();
  expect(screen.getByText(/Sin reposición: 1/i)).toBeInTheDocument();
  expect(screen.getByText(/Hay unidades sin reposición asignada/i)).toBeInTheDocument();
  expect(screen.queryByText(/Las unidades de este pedido están en camino/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  client.clear();
});

it('pide contar una línea al recibir mercadería sin borrar cantidades escritas en otras líneas', () => {
  const first = sampleOrder();
  first.items[0]!.physicalReservedQuantity = 0;
  first.items[0]!.incomingQuantity = 2;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { rerender } = render(
    <QueryClientProvider client={client}><OrderPackingEditor order={first} /></QueryClientProvider>
  );
  const omapure = screen.getByRole('textbox', { name: 'Unidades en bolsita de Omapure' });
  fireEvent.change(omapure, { target: { value: '1' } });

  const received: Order = {
    ...first,
    items: first.items.map(item => item.id === 'line-one'
      ? { ...item, physicalReservedQuantity: 1, incomingQuantity: 1 }
      : item)
  };
  rerender(<QueryClientProvider client={client}><OrderPackingEditor order={received} /></QueryClientProvider>);

  expect(screen.getByRole('textbox', { name: 'Unidades en bolsita de B Complex' })).toHaveValue('');
  expect(screen.getByText('Falta ingresar (0 si ninguna)')).toBeInTheDocument();
  expect(omapure).toHaveValue('1');
  expect(screen.getByRole('button', { name: 'Guardar armado' })).toBeDisabled();
  client.clear();
});

it('reemplaza el cero previo al escribir una unidad y guarda el número visible', async () => {
  const order = sampleOrder();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.saveOrderPacking.mockResolvedValue({ ...order, packingRevision: 1 });
  render(<QueryClientProvider client={client}><OrderPackingEditor order={order} /></QueryClientProvider>);

  fireEvent.click(screen.getByRole('button', { name: 'Completar vacíos con 0' }));
  const bComplex = screen.getByRole('textbox', { name: 'Unidades en bolsita de B Complex' });
  expect(bComplex).toHaveValue('0');
  fireEvent.change(bComplex, { target: { value: '01' } });
  expect(bComplex).toHaveValue('1');
  fireEvent.change(bComplex, { target: { value: '001' } });
  expect(bComplex).toHaveValue('1');

  fireEvent.click(screen.getByRole('button', { name: 'Guardar armado' }));
  await waitFor(() => expect(api.saveOrderPacking).toHaveBeenCalledWith(
    order.id,
    [
      { orderItemId: 'line-one', packedQuantity: 1 },
      { orderItemId: 'line-two', packedQuantity: 0 }
    ],
    0
  ));
  client.clear();
});

it('permite borrar 11 por completo antes de escribir 7 sin restaurar el valor anterior', async () => {
  const order = sampleOrder();
  order.items = [{
    ...order.items[0]!,
    quantity: 11,
    physicalReservedQuantity: 11,
    incomingQuantity: 0,
    packedQuantity: 11
  }];
  api.saveOrderPacking.mockResolvedValue({ ...order, packingRevision: 1 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><OrderPackingEditor order={order} /></QueryClientProvider>);

  const count = screen.getByRole('textbox', { name: 'Unidades en bolsita de B Complex' });
  expect(count).toHaveValue('11');
  fireEvent.change(count, { target: { value: '' } });
  fireEvent.blur(count);
  expect(count).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Guardar armado' })).toBeDisabled();
  expect(api.saveOrderPacking).not.toHaveBeenCalled();

  fireEvent.change(count, { target: { value: '7' } });
  expect(count).toHaveValue('7');
  fireEvent.click(screen.getByRole('button', { name: 'Guardar armado' }));
  await waitFor(() => expect(api.saveOrderPacking).toHaveBeenCalledWith(
    order.id,
    [{ orderItemId: 'line-one', packedQuantity: 7 }],
    0
  ));
  client.clear();
});

it('opens inventory links in a new tab with target _blank and noopener noreferrer', async () => {
  const order = sampleOrder();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><OrderPackingEditor order={order} /></QueryClientProvider>);

  const incomingLink = screen.getByRole('link', { name: /Hay productos en camino\. Ver compra en Inventario/ });
  expect(incomingLink).toHaveAttribute('target', '_blank');
  expect(incomingLink).toHaveAttribute('rel', 'noopener noreferrer');
  expect(incomingLink).toHaveAttribute('href', '/app/inventario');

  client.clear();
});
