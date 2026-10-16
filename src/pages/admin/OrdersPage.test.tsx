import { AppConfirmationProvider } from '@/components/ui/AppConfirmation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Order } from '@/domain/types';
import { demoOrders } from '@/data/demo-data';
import OrdersPage from './OrdersPage';

const api = vi.hoisted(() => ({ listOrders: vi.fn(), transitionOrder: vi.fn(), saveOrderPacking: vi.fn(), saveOrderShippingFee: vi.fn(), getOrderStockContext: vi.fn() }));
const navigation = vi.hoisted(() => vi.fn<(options: { enableBeforeUnload: boolean;
  shouldBlockFn: (input: { current: { pathname: string; search?: {search?:string} }; next: { pathname: string; search?: {search?:string} } }) => boolean | Promise<boolean> }) => void>());
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/components/layout/AdminShell', () => ({ PageHeader: () => <h1>Pedidos</h1> }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}), useBlocker: navigation, Link: ({ children, to }: PropsWithChildren<{ to: string }>) => <a href={to}>{children}</a> }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: { active: true, role: 'owner' } }) }));
afterEach(cleanup);
beforeEach(() => {
  api.getOrderStockContext.mockImplementation(async id => {
    const result = await api.listOrders.getMockImplementation()?.(1, 50, '', 'all');
    const order = result?.items.find((item: Order) => item.id === id) as Order | undefined;
    if (!order) throw new Error('Order fixture not found');
    return { orderId: id, orderState: order.orderState, fulfillmentState: order.fulfillmentState,
      stockSource: order.stockSource ?? 'normal', actionRevision: order.actionRevision ?? 0,
      packingRevision: order.packingRevision ?? 0, checkedAt: '2026-10-16T18:00:00Z',
      items: order.items.map(item => ({ orderItemId: item.id, productId: item.productId, quantity: item.quantity,
        onHand: item.physicalReservedQuantity ?? item.quantity, reserved: item.physicalReservedQuantity ?? item.quantity,
        available: 0, physicalQuantity: item.physicalReservedQuantity ?? item.quantity,
        incomingQuantity: item.incomingQuantity ?? 0, uncoveredQuantity: item.uncoveredQuantity ?? 0,
        otherReservedQuantity: 0, openingReservedQuantity: 0, reservations: [], purchases: [] })) };
  });
});

it('protects same-route search changes and explicitly discards both shipping and packing even if the row stays visible', async () => {
  const order:Order={...demoOrders[0]!,orderState:'confirmed',paymentState:'pending',fulfillmentState:'pending',
    shippingFeeCents:0,shippingFeeRevision:0,stockReadiness:'ready',packingRevision:0,
    items:[{...demoOrders[0]!.items[0]!,quantity:1,packedQuantity:0,physicalReservedQuantity:1,incomingQuantity:0,uncoveredQuantity:0}]};
  api.listOrders.mockResolvedValue({items:[order],total:1,page:1,pageSize:50,pendingTotal:1,completedTotal:0});
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
  const header=await screen.findByRole('button',{name:/Ver pedido y acciones/});
  fireEvent.click(header);
  fireEvent.change(screen.getByRole('textbox',{name:/Unidades en bolsita/}),{target:{value:'1'}});
  fireEvent.click(screen.getByRole('button',{name:'Agregar'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Envío en pesos'}),{target:{value:'12500'}});
  let decision!: boolean | Promise<boolean>;
  const locations={current:{pathname:'/app/pedidos',search:{search:'actual'}},next:{pathname:'/app/pedidos',search:{search:'otro'}}};
  act(()=>{decision=navigation.mock.lastCall![0].shouldBlockFn(locations);});
  expect(screen.getByRole('dialog')).toHaveTextContent('edición de envío y conteos de bolsitas');
  expect(screen.getByRole('dialog')).toHaveTextContent('cambiar de vista');
  fireEvent.click(screen.getByRole('button',{name:'Seguir editando'}));
  expect(await decision).toBe(true);
  expect(screen.getByRole('textbox',{name:'Envío en pesos'})).toHaveValue('12.500');
  act(()=>{decision=navigation.mock.lastCall![0].shouldBlockFn(locations);});
  fireEvent.click(screen.getByRole('button',{name:'Descartar'}));
  expect(await decision).toBe(false);
  await waitFor(()=>expect(screen.queryByText(/Tenés armados sin guardar/)).not.toBeInTheDocument());
  fireEvent.click(header);
  expect(screen.getByRole('textbox',{name:/Unidades en bolsita/})).toHaveValue('0');
  fireEvent.click(screen.getByRole('button',{name:'Agregar'}));
  expect(screen.getByRole('textbox',{name:'Envío en pesos'})).toHaveValue('');
  client.clear();
});

it('blocks stale-row actions immediately while a search is debouncing and until its response arrives', async () => {
  const order:Order={...demoOrders[0]!,orderState:'confirmed',paymentState:'pending',fulfillmentState:'pending',shippingFeeCents:0};
  const result={items:[order],total:1,page:1,pageSize:50,pendingTotal:1,completedTotal:0};
  let finish!: (value:typeof result)=>void;
  const pending=new Promise<typeof result>(resolve=>{finish=resolve;});
  api.listOrders.mockImplementation((_page,_size,search)=>search==='other'?pending:Promise.resolve(result));
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Todos (1)'}));
  await waitFor(()=>expect(client.isFetching()).toBe(0));
  const header=await screen.findByRole('button',{name:/Ver pedido y acciones/});
  fireEvent.click(header);
  const shipping=screen.getByRole('button',{name:'Agregar'}),pay=screen.getByRole('button',{name:'Marcar como cobrado'});
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'other'}});
  expect(header).toBeDisabled();expect(shipping).toBeDisabled();expect(pay).toBeDisabled();
  expect(screen.getByText('Buscando pedidos…')).toBeInTheDocument();
  await waitFor(()=>expect(api.listOrders).toHaveBeenCalledWith(1,50,'other','all'));
  expect(screen.queryByRole('button',{name:'Agregar'})).not.toBeInTheDocument();
  await act(async()=>finish(result));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Agregar'})).toBeEnabled());
  client.clear();
});

it('does not discard or switch an order while its shipping save is pending and preserves failed input', async () => {
  const order: Order = {...demoOrders[0]!,orderState:'confirmed',paymentState:'pending',fulfillmentState:'pending',
    shippingFeeCents:0,shippingFeeRevision:0};
  api.listOrders.mockResolvedValue({items:[order,{...order,id:'second-order',number:5000}],total:2,page:1,pageSize:50,pendingTotal:2,completedTotal:0});
  let reject!: (error:Error)=>void;
  api.saveOrderShippingFee.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
  const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
  const headers=await screen.findAllByRole('button',{name:/Ver pedido y acciones/});
  fireEvent.click(headers[0]!);
  fireEvent.click(screen.getByRole('button',{name:'Agregar'}));
  expect(navigation.mock.lastCall![0].enableBeforeUnload).toBe(false);
  fireEvent.change(screen.getByRole('textbox',{name:'Envío en pesos'}),{target:{value:'12500'}});
  expect(navigation.mock.lastCall![0].enableBeforeUnload).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Guardar envío'}));
  await waitFor(()=>expect(api.saveOrderShippingFee).toHaveBeenCalled());
  expect(headers[1]).toBeDisabled();
  expect(screen.getByRole('button',{name:'Marcar como cobrado'})).toBeDisabled();
  let decision!: boolean | Promise<boolean>;
  act(()=>{decision=navigation.mock.lastCall![0].shouldBlockFn({current:{pathname:'/app/pedidos'},next:{pathname:'/app/inventario'}});});
  expect(screen.getByRole('dialog',{name:'El guardado ya comenzó'})).toHaveTextContent('Salir no cancela el guardado');
  expect(screen.queryByRole('button',{name:'Descartar'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Seguir esperando'}));
  expect(await decision).toBe(true);
  await act(async()=>reject(new Error('Sin conexión')));
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'Envío en pesos'})).toBeEnabled());
  expect(screen.getByRole('textbox',{name:'Envío en pesos'})).toHaveValue('12.500');
  expect(headers[1]).toBeEnabled();
  expect(navigation.mock.lastCall![0].enableBeforeUnload).toBe(true);
  client.clear();
});

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
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
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
  await waitFor(() => expect(api.listOrders).toHaveBeenLastCalledWith(1, 50, String(order.number), 'all'));
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
    <QueryClientProvider client={client}><AppConfirmationProvider>
      <OrdersPage />
    </AppConfirmationProvider></QueryClientProvider>
  );

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  const readyButton = screen.getByRole('button', { name: /Marcar listo para entregar/i });
  expect(readyButton).toBeInTheDocument();
  fireEvent.click(readyButton);

  await waitFor(() => expect(api.transitionOrder).toHaveBeenCalledWith(order.id, 'mark_ready', { actionRevision: order.actionRevision ?? 0 }));
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
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como entregado' }));
  expect(api.transitionOrder).not.toHaveBeenCalled();
  expect(screen.getByText(/La bolsita figura sin verificar en la app/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sí, ya verifiqué y entregar' }));
  await waitFor(() => expect(api.transitionOrder).toHaveBeenCalledWith(order.id, 'mark_delivered', { actionRevision: order.actionRevision ?? 0 }));
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
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
  fireEvent.click(screen.getByRole('button', { name: 'Marcar como enviado' }));
  expect(api.transitionOrder).not.toHaveBeenCalled();
  expect(screen.getByText(/La bolsita figura sin verificar en la app/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sí, ya verifiqué y enviar' }));
  await waitFor(() => expect(api.transitionOrder).toHaveBeenCalledWith(order.id, 'mark_shipped', { actionRevision: order.actionRevision ?? 0 }));
  client.clear();
});

it('mantiene visible la bolsita bloqueada y permite entender sus reservas cuando toda la mercadería está en camino', async () => {
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
  api.getOrderStockContext.mockResolvedValue({ orderId: order.id, orderState: order.orderState,
    fulfillmentState: order.fulfillmentState, stockSource: order.stockSource ?? 'normal', actionRevision: order.actionRevision ?? 0,
    packingRevision: order.packingRevision ?? 0, checkedAt: '2026-10-16T16:00:00Z',
    items: [{ orderItemId: order.items[0]!.id, productId: order.items[0]!.productId, quantity: 1, onHand: 0,
      reserved: 0, available: 0, physicalQuantity: 0, incomingQuantity: 1, uncoveredQuantity: 0,
      otherReservedQuantity: 0, openingReservedQuantity: 0, reservations: [], purchases: [{
        id: 'purchase-waiting', number: 2054, state: 'ordered', expectedAt: order.expectedArrivalAt,
        reservedQuantity: 1, incomingQuantity: 1, uncoveredQuantity: 0, orderedQuantity: 1, receivedQuantity: 0, shortageQuantity: 0
      }] }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  expect(screen.getByText('Qué sigue')).toBeInTheDocument();
  expect(screen.getAllByText('Regalo / Cortesía')).toHaveLength(1);
  expect(screen.getByText('Pendiente de recibir')).toBeInTheDocument();
  expect(screen.queryByText('Falta preparar')).not.toBeInTheDocument();
  expect(screen.getAllByText('Pendiente de recibir')).toHaveLength(1);
  expect(await screen.findByText(/Llegada estimada al local:/)).toBeInTheDocument();
  expect(screen.queryByText(/Recibí la compra en Inventario\. Después completá el armado/)).not.toBeInTheDocument();
  expect(screen.getByRole('region', { name: `Armado del pedido ${order.number}` })).toBeInTheDocument();
  expect(await screen.findByText('1 unidad pendiente de recibir')).toBeInTheDocument();
  expect(screen.queryByText('0 en bolsita')).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: /Ver stock y reservas/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Guardar armado' })).toBeDisabled();
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
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);

  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  expect(screen.getByRole('region', { name: `Armado del pedido ${order.number}` })).toBeInTheDocument();
  expect(screen.getAllByText('Pendiente de recibir')).toHaveLength(1);
  client.clear();
});

it('allows collapsing a single search result and preserves that choice after a refresh', async () => {
  const order: Order = { ...demoOrders[0]!, orderState: 'confirmed', fulfillmentState: 'pending', paymentState: 'pending',
    preparationState: 'pending', stockReadiness: 'ready', packingRevision: 0,
    items: [{ ...demoOrders[0]!.items[0]!, quantity: 1, packedQuantity: 0, physicalReservedQuantity: 1, incomingQuantity: 0, uncoveredQuantity: 0 }] };
  const otherOrder = { ...order, id: 'search-other-order', number: 5001, items: [{ ...order.items[0]!, id: 'search-other-item' }] };
  api.listOrders.mockImplementation(async (_page, _size, query) => ({
    items: query === String(order.number) ? [order] : query === String(otherOrder.number) ? [otherOrder] : [order, otherOrder],
    total: query ? 1 : 2, page: 1, pageSize: 50, pendingTotal: 2, completedTotal: 0
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: String(order.number) } });
  const count = await screen.findByRole('textbox', { name: /Unidades en bolsita de/ });
  fireEvent.change(count, { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: /Ocultar acciones/ }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: /Unidades en bolsita de/ })).not.toBeInTheDocument());
  await act(async () => { await client.invalidateQueries({ queryKey: ['orders'] }); });
  expect(screen.queryByRole('textbox', { name: /Unidades en bolsita de/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ver pedido y acciones/ }));
  expect(screen.getByRole('textbox', { name: /Unidades en bolsita de/ })).toHaveValue('1');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: String(otherOrder.number) } });
  expect(await screen.findByRole('region', { name: `Armado del pedido ${otherOrder.number}` })).toBeInTheDocument();
  client.clear();
});

it('explains that a submitted packing save can still complete when leaving the page', async () => {
  const order: Order = { ...demoOrders[0]!, orderState: 'confirmed', fulfillmentState: 'pending', paymentState: 'pending',
    preparationState: 'pending', stockReadiness: 'ready', packingRevision: 0,
    items: [{ ...demoOrders[0]!.items[0]!, quantity: 1, packedQuantity: 0, physicalReservedQuantity: 1, incomingQuantity: 0, uncoveredQuantity: 0 }] };
  const otherOrder = { ...order, id: 'other-order', number: 5000, items: [{ ...order.items[0]!, id: 'other-item' }] };
  api.listOrders.mockResolvedValue({ items: [order, otherOrder], total: 2, page: 1, pageSize: 50, pendingTotal: 2, completedTotal: 0 });
  let reject!: (error: Error) => void;
  api.saveOrderPacking.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
  fireEvent.click((await screen.findAllByRole('button', { name: /Ver pedido y acciones/ }))[0]!);
  fireEvent.change(screen.getByRole('textbox', { name: /Unidades en bolsita de/ }), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Guardar armado' }));
  await waitFor(() => expect(api.saveOrderPacking).toHaveBeenCalled());
  const blocker = navigation.mock.lastCall![0];
  let decision!: boolean | Promise<boolean>;
  act(() => { decision = blocker.shouldBlockFn({ current: { pathname: '/app/pedidos' }, next: { pathname: '/app/inventario' } }); });
  expect(screen.getByRole('dialog', { name: 'El guardado ya comenzó' })).toHaveTextContent('Salir no cancela');
  expect(screen.queryByRole('button', { name: 'Descartar' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Seguir esperando' }));
  expect(await decision).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /Ver pedido y acciones/ }));
  fireEvent.change(screen.getByRole('textbox', { name: /Unidades en bolsita de/ }), { target: { value: '1' } });
  const mixed = navigation.mock.lastCall![0];
  act(() => { decision = mixed.shouldBlockFn({ current: { pathname: '/app/pedidos' }, next: { pathname: '/app/inventario' } }); });
  expect(screen.getByRole('dialog')).toHaveTextContent('Los demás cambios sin guardar se descartarán');
  fireEvent.click(screen.getByRole('button', { name: 'Seguir esperando' }));
  expect(await decision).toBe(true);
  await act(async () => reject(new Error('Sin conexión')));
  client.clear();
});

it('allows explicitly discarding a draft when another operator cancelled the order and the editor disappeared', async () => {
  const order: Order = { ...demoOrders[0]!, orderState: 'confirmed', fulfillmentState: 'pending', paymentState: 'pending',
    preparationState: 'pending', stockReadiness: 'ready', packingRevision: 0,
    items: [{ ...demoOrders[0]!.items[0]!, quantity: 1, packedQuantity: 0, physicalReservedQuantity: 1, incomingQuantity: 0, uncoveredQuantity: 0 }] };
  const page = { items: [order], total: 1, page: 1, pageSize: 50, pendingTotal: 1, completedTotal: 0 };
  api.listOrders.mockResolvedValue(page);
  api.transitionOrder.mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  fireEvent.change(screen.getByRole('textbox', { name: /Unidades en bolsita de/ }), { target: { value: '1' } });
  expect(screen.getByText(/Tenés armados sin guardar/)).toBeVisible();
  await act(async () => { client.setQueriesData({ queryKey: ['orders'] }, { ...page,
    items: [{ ...order, orderState: 'cancelled' }], pendingTotal: 0, completedTotal: 1 }); });
  await waitFor(() => expect(screen.queryByRole('textbox', { name: /Unidades en bolsita de/ })).not.toBeInTheDocument());
  const discard = screen.getByRole('button', { name: `Descartar conteo #${order.number}` });
  fireEvent.click(discard);
  fireEvent.click(screen.getByRole('button', { name: 'Seguir editando' }));
  expect(screen.getByText(/Tenés armados sin guardar/)).toBeVisible();
  fireEvent.click(discard);
  fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
  await waitFor(() => expect(screen.queryByText(/Tenés armados sin guardar/)).not.toBeInTheDocument());
  expect(api.transitionOrder).not.toHaveBeenCalled();
  client.clear();
});


it('keeps completed orders reachable while undoing delivery, payment and finally cancelling', async () => {
  let order: Order = { ...demoOrders[0]!, orderState: 'confirmed', paymentState: 'paid', fulfillmentState: 'delivered',
    actionRevision: 7, shippedAt: null, stockReadiness: 'ready', packingTracked: false,
    items: demoOrders[0]!.items.map(i => ({ ...i, packedQuantity: null })) };
  api.listOrders.mockImplementation(async (_page, _size, _search, filter) => ({
    items: filter === 'completed' && order.fulfillmentState !== 'delivered' && order.orderState !== 'cancelled' ? [] : [order],
    total: 1, page: 1, pageSize: 50, pendingTotal: 0, completedTotal: 1
  }));
  api.transitionOrder.mockImplementation(async (_id, action) => {
    order = { ...order, actionRevision: (order.actionRevision ?? 0) + 1,
      ...(action === 'reverse_delivery' ? { fulfillmentState: 'pending', fulfilledAt: null } : {}),
      ...(action === 'reverse_payment' ? { paymentState: 'pending', paidAt: null } : {}),
      ...(action === 'cancel' ? { orderState: 'cancelled', fulfillmentState: 'cancelled' } : {}) };
    return order;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidations = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Completados/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  const more = screen.getByRole('button', { name: 'Más opciones' });
  expect(more).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(more);
  expect(screen.getByRole('button', { name: 'Cancelar pedido' })).toBeDisabled();
  expect(screen.getByText(/Primero resolvé el cobro/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Deshacer entrega' }));
  let dialog = screen.getByRole('dialog');
  expect(dialog.querySelector('#confirm-order-action-description')).toHaveTextContent('reservadas para este mismo pedido');
  expect(dialog).toHaveTextContent('mercadería está en el local');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, deshacer entrega' }));
  await waitFor(() => expect(api.transitionOrder).toHaveBeenLastCalledWith(order.id, 'reverse_delivery', { operationId: expect.any(String), actionRevision: 7 }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(await screen.findByText(/entrega deshecha/)).toBeInTheDocument();
  expect(screen.getByText('Productos pedidos')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Deshacer cobro' }));
  dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('pendiente de cobro');
  expect(dialog).toHaveTextContent('Esta acción corrige el registro');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, deshacer cobro' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Cancelar pedido' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar pedido' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sí, cancelar pedido' }));
  await waitFor(() => expect(order.orderState).toBe('cancelled'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  for (const key of [['orders'], ['dashboard'], ['inventory'], ['product-reservations'], ['admin-products'],
    ['storefront-products'], ['storefront-product'], ['purchases'], ['paid-orders'], ['analytics'], ['customers'], ['movements']]) {
    expect(invalidations).toHaveBeenCalledWith({ queryKey: key });
  }
  client.clear();
});

it('shipment delivery correction explains sent status and preserves the operation key after a failed request', async () => {
  const order: Order = { ...demoOrders[0]!, orderState: 'confirmed', paymentState: 'paid', fulfillmentState: 'delivered',
    actionRevision: 3, shippedAt: '2026-10-12T12:00:00Z' };
  api.listOrders.mockResolvedValue({ items: [order], total: 1, page: 1, pageSize: 50, pendingTotal: 0, completedTotal: 1 });
  api.transitionOrder.mockRejectedValueOnce(new Error('Sin conexión')).mockResolvedValueOnce({ ...order, fulfillmentState: 'shipped', fulfilledAt: null, actionRevision: 4 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AppConfirmationProvider><OrdersPage /></AppConfirmationProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Ver pedido y acciones/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
  fireEvent.click(screen.getByRole('button', { name: 'Deshacer entrega' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.querySelector('#confirm-order-action-description')).toHaveTextContent('volverá a enviado');
  expect(dialog).toHaveTextContent('stock no cambiará');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, deshacer entrega' }));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Sí, deshacer entrega' })).toBeEnabled());
  const first = api.transitionOrder.mock.lastCall;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, deshacer entrega' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(api.transitionOrder.mock.lastCall).toEqual(first);
  client.clear();
});
