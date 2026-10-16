import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { demoOrders } from '@/data/demo-data';
import type { Order, OrderStockContext } from '@/domain/types';
import { AppError } from '@/domain/errors';
import { AppConfirmationProvider } from '@/components/ui/AppConfirmation';
import { StockAllocationExplanation } from './StockAllocationExplanation';
import { OrderPackingEditor } from './OrderPackingEditor';

const api = vi.hoisted(() => ({ getOrderStockContext: vi.fn(), saveOrderPacking: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, search, ...props }: PropsWithChildren<{ to: string; search?: Record<string, string> }>) =>
  <a href={to + (search ? `?${new URLSearchParams(search)}` : '')} {...props}>{children}</a> }));
let client: QueryClient, order: Order, context: OrderStockContext;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  order = { ...structuredClone(demoOrders[0]!), orderState: 'confirmed', fulfillmentState: 'pending', preparationState: 'pending',
    stockSource: 'normal', actionRevision: 0, packingRevision: 0, packingTracked: false,
    items: [{ ...demoOrders[0]!.items[0]!, id: 'complex', productName: 'Complejo B', quantity: 1, packedQuantity: null,
      physicalReservedQuantity: 0, incomingQuantity: 1, uncoveredQuantity: 0 }] };
  context = { orderId: order.id, orderState: 'confirmed', fulfillmentState: 'pending', stockSource: 'normal', actionRevision: 0, packingRevision: 0,
    checkedAt: '2026-10-16T16:00:00Z', items: [{ orderItemId: 'complex', productId: order.items[0]!.productId, quantity: 1,
      onHand: 10, reserved: 10, available: 0, physicalQuantity: 0, incomingQuantity: 1, uncoveredQuantity: 0,
      otherReservedQuantity: 10, openingReservedQuantity: 0,
      reservations: [{ orderId: 'previous', orderNumber: 2630, physicalQuantity: 2, packedQuantity: null, preparationState: 'pending', paymentState: 'pending' }],
      purchases: [{ id: 'purchase-id', number: 2054, state: 'ordered', expectedAt: '2026-10-20T15:00:00Z', reservedQuantity: 1, incomingQuantity: 1, uncoveredQuantity: 0, orderedQuantity: 15, receivedQuantity: 0, shortageQuantity: 0 }] }] };
  api.getOrderStockContext.mockImplementation(async () => structuredClone(context));
});
afterEach(() => { cleanup(); client.clear(); vi.resetAllMocks(); });
const show = (staff = false) => render(<QueryClientProvider client={client}><StockAllocationExplanation order={order} item={order.items[0]!} canReceivePurchases={!staff} /></QueryClientProvider>);
const addPhysicalLine = (id: string, name: string) => {
  order.items.push({ ...order.items[0]!, id, productId: id, productName: name, incomingQuantity: 0, physicalReservedQuantity: 1 });
  context.items.push({ ...context.items[0]!, orderItemId: id, productId: id, onHand: 1, reserved: 1, available: 0,
    physicalQuantity: 1, incomingQuantity: 0, uncoveredQuantity: 0, otherReservedQuantity: 0, openingReservedQuantity: 0,
    purchases: [], reservations: [] });
};

it('explica el bloqueo y lleva a la compra exacta sin perder el contexto del pedido', async () => {
  show();
  expect(await screen.findByText('1 unidad pendiente de recibir')).toBeInTheDocument();
  expect(screen.queryByLabelText('Stock registrado y reservas del producto')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Pedido #2630/ })).not.toBeInTheDocument();
  expect(screen.getByText(/Llegada estimada/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ver stock y reservas/ }));
  const purchase = screen.getByRole('link', { name: 'Abrir compra #2054' });
  expect(purchase).toHaveAttribute('href', '/app/inventario?tab=compras&purchase=purchase-id');
  expect(purchase).toHaveAttribute('target', '_blank');
  expect(purchase).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByRole('link', { name: /Pedido #2630/ })).toHaveAttribute('href', '/app/pedidos?search=2630');
});

it('explica la elección en camino aunque exista stock libre y respeta los permisos', async () => {
  order.stockSource = context.stockSource = 'incoming_only';
  Object.assign(context.items[0]!, { onHand: 1, reserved: 0, available: 1, otherReservedQuantity: 0, reservations: [] });
  context.items[0]!.purchases[0]!.expectedAt = null;
  show(true);
  expect(await screen.findByText('1 unidad pendiente de recibir')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ver stock y reservas/ }));
  expect(screen.getByText(/Sin fecha estimada/)).toBeInTheDocument();
  expect(screen.getByText(/libre del local para otras ventas/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cómo se confirma la disponibilidad' }));
  expect(screen.queryByRole('link', { name: /Abrir compra/ })).not.toBeInTheDocument();
  expect(screen.getByText(/pedile a la persona responsable que registre la recepción/)).toBeInTheDocument();
  expect(screen.queryByText(/todas están apartadas/)).not.toBeInTheDocument();
});

it('una consulta fallida no inventa ceros ni borra el conteo de un producto disponible', async () => {
  api.getOrderStockContext.mockRejectedValueOnce(new Error('SQL internal failure'));
  addPhysicalLine('physical', 'Magnesio');
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrderPackingEditor order={order} /></AppConfirmationProvider></QueryClientProvider>);
  const count = screen.getByRole('textbox', { name: 'Unidades en bolsita de Magnesio' });
  fireEvent.change(count, { target: { value: '1' } });
  const explanation = within(screen.getByRole('group', { name: 'Disponibilidad de Complejo B' }));
  expect(await explanation.findByText(/No pudimos comprobar el stock/)).toBeInTheDocument();
  expect(count).toHaveValue('1');
  expect(screen.queryByText(/SQL/)).not.toBeInTheDocument();
  expect(screen.queryByText('0 en bolsita')).not.toBeInTheDocument();
  fireEvent.click(explanation.getByRole('button', { name: 'Volver a consultar' }));
  expect(await screen.findByText('1 unidad pendiente de recibir')).toBeInTheDocument();
  expect(count).toHaveValue('1');
  expect(api.saveOrderPacking).not.toHaveBeenCalled();
});

it('detecta una respuesta más nueva que el pedido y permite actualizar sin adoptar cantidades silenciosamente', async () => {
  context.actionRevision = 1;
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('El pedido cambió');
  expect(screen.queryByRole('link', { name: /Abrir compra/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actualizar pedido' }));
  await waitFor(() => expect(api.getOrderStockContext).toHaveBeenCalledTimes(2));
  expect(api.saveOrderPacking).not.toHaveBeenCalled();
});

it('un rechazo de acceso informa cómo resolverlo sin ofrecer repetir una consulta imposible', async () => {
  client.setDefaultOptions({ queries: { retry: 1, retryDelay: 0 } });
  api.getOrderStockContext.mockRejectedValue(new AppError('permission', 'Tu acceso cambió.', { nextAction: 'Solicitá que revisen los permisos de tu cuenta.' }));
  show();
  expect(await screen.findByText(/Solicitá que revisen los permisos/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Volver a consultar' })).not.toBeInTheDocument();
  expect(api.getOrderStockContext).toHaveBeenCalledTimes(1);
});

it('distingue faltantes, reservas previas y varias compras sin inventar una sola fecha', async () => {
  order.items[0]!.uncoveredQuantity = context.items[0]!.uncoveredQuantity = 1;
  order.items[0]!.quantity = context.items[0]!.quantity = 2;
  context.items[0]!.openingReservedQuantity = 3;
  context.items[0]!.purchases.push({ ...context.items[0]!.purchases[0]!, id: 'other-purchase', number: 2055, state: 'received', reservedQuantity: 1, incomingQuantity: 0, uncoveredQuantity: 1, shortageQuantity: 1 });
  show();
  expect(await screen.findByText(/1 unidad sin reposición/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ver stock y reservas/ }));
  expect(screen.getByText(/Reservas previas al sistema: 3 unidades/)).toBeInTheDocument();
  expect(screen.getByText('Origen de 1 unidad sin reposición.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Abrir compra #2054' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Abrir compra #2055' })).toBeInTheDocument();
});


it('resume las reservas sin scroll interno y permite consultar todos los pedidos sin perder el conteo', async () => {
  const stock = context.items[0]!;
  Object.assign(stock, { onHand: 8, reserved: 8, otherReservedQuantity: 8, reservations: Array.from({ length: 8 }, (_, index) => ({
    orderId: `other-${index}`, orderNumber: 2600 + index, physicalQuantity: 1, packedQuantity: null, preparationState: 'pending', paymentState: 'pending'
  })) });
  addPhysicalLine('physical', 'Magnesio');
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrderPackingEditor order={order} /></AppConfirmationProvider></QueryClientProvider>);
  const count = screen.getByRole('textbox', { name: 'Unidades en bolsita de Magnesio' });
  fireEvent.change(count, { target: { value: '1' } });
  expect(await screen.findByText('1 unidad pendiente de recibir')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Pedidos con unidades reservadas' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ver stock y reservas de Complejo B/ }));
  const reservations = screen.getByRole('list', { name: 'Pedidos con unidades reservadas' });
  expect(within(reservations).getAllByRole('link')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Ver otros 5 pedidos · 5 unidades' }));
  expect(within(reservations).getAllByRole('link')).toHaveLength(8);
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar menos pedidos' }));
  expect(within(reservations).getAllByRole('link')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Cómo se confirma la disponibilidad' }));
  expect(screen.getByText(/Este pedido usa stock libre del local y nuevas recepciones/)).toBeInTheDocument();
  expect(count).toHaveValue('1');
  expect(screen.getByRole('button', { name: 'Guardar armado' })).toBeEnabled();
  expect(api.saveOrderPacking).not.toHaveBeenCalled();
});

it('muestra cada compra de una reposición múltiple sin atribuir una fecha única al pedido', async () => {
  order.items[0]!.quantity = context.items[0]!.quantity = 3;
  order.items[0]!.incomingQuantity = context.items[0]!.incomingQuantity = 3;
  context.items[0]!.purchases[0]!.reservedQuantity = 1;
  context.items[0]!.purchases[0]!.incomingQuantity = 1;
  context.items[0]!.purchases.push({ ...context.items[0]!.purchases[0]!, id: 'second', number: 2056, expectedAt: '2026-10-25T15:00:00Z', reservedQuantity: 2, incomingQuantity: 2 });
  show();
  expect(await screen.findByText('3 unidades pendientes de recibir')).toBeInTheDocument();
  expect(screen.getByText('Reposición en 2 compras. Fechas en el detalle.')).toBeInTheDocument();
  expect(screen.queryByText(/Llegada estimada/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ver stock y reservas/ }));
  expect(screen.getByRole('link', { name: 'Abrir compra #2054' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Abrir compra #2056' })).toBeInTheDocument();
  expect(screen.getByText(/Llegada estimada al local: 20 oct/)).toBeInTheDocument();
  expect(screen.getByText(/Llegada estimada al local: 25 oct/)).toBeInTheDocument();
});

it('separa la compra pendiente de recibir de un faltante ligado a otra compra abierta', async () => {
  order.items[0]!.quantity = context.items[0]!.quantity = 2;
  order.items[0]!.uncoveredQuantity = context.items[0]!.uncoveredQuantity = 1;
  context.items[0]!.purchases.push({ ...context.items[0]!.purchases[0]!, id: 'uncovered-purchase', number: 2057, incomingQuantity: 0, uncoveredQuantity: 1, reservedQuantity: 1 });
  show();
  expect(await screen.findByText('1 unidad pendiente de recibir')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Abrir compra #2054' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ver stock y reservas/ }));
  const uncoveredRow = screen.getByRole('link', { name: 'Abrir compra #2057' }).parentElement?.parentElement;
  expect(uncoveredRow).toHaveTextContent('Origen de 1 unidad sin reposición.');
  expect(uncoveredRow).not.toHaveTextContent('Llegada estimada');
});

it('advierte si las reservas registradas superan el stock registrado', async () => {
  Object.assign(context.items[0]!, { onHand: 8, reserved: 10, available: 0 });
  show();
  expect(await screen.findByText('Faltan 2 unidades para cubrir las reservas del producto.')).toBeInTheDocument();
  expect(screen.queryByLabelText('Stock registrado y reservas del producto')).not.toBeInTheDocument();
});

it('consulta también un producto totalmente asignado y expone el faltante general sin alterar su conteo', async () => {
  Object.assign(order.items[0]!, { physicalReservedQuantity: 1, incomingQuantity: 0, packedQuantity: 1 });
  Object.assign(context.items[0]!, { physicalQuantity: 1, incomingQuantity: 0, onHand: 0, reserved: 1, available: 0, purchases: [] });
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrderPackingEditor order={order} /></AppConfirmationProvider></QueryClientProvider>);
  expect(await screen.findByText('Falta 1 unidad para cubrir las reservas del producto.')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Unidades en bolsita de Complejo B' })).toHaveValue('1');
  expect(screen.queryByLabelText('Stock registrado y reservas del producto')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Revisar stock en Inventario/ })).toHaveAttribute('target', '_blank');
  expect(api.saveOrderPacking).not.toHaveBeenCalled();
});

it('separa la cobertura y el faltante de una misma compra abierta sin ocultar su origen', async () => {
  order.items[0]!.quantity = context.items[0]!.quantity = 2;
  order.items[0]!.uncoveredQuantity = context.items[0]!.uncoveredQuantity = 1;
  Object.assign(context.items[0]!.purchases[0]!, { reservedQuantity: 2, incomingQuantity: 1, uncoveredQuantity: 1 });
  show();
  expect(await screen.findByText('1 unidad pendiente de recibir')).toBeVisible();
  expect(screen.getByText('1 unidad sin reposición.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Ver stock y reservas/ }));
  expect(screen.getByText('Origen de 1 unidad sin reposición.')).toBeVisible();
  expect(screen.getByText(/1 unidad pendiente de recibir · Llegada estimada/)).toBeVisible();
  expect(screen.queryByText(/2 unidades pendientes de recibir/)).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Abrir compra #2054' })).toHaveLength(1);
});
