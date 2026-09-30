import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoProducts, demoOwner, toDemoInventory } from '@/data/demo-data';
import type { Purchase } from '@/domain/types';
import InventoryPage, { PurchaseFormModal, ReceivePurchaseModal, getStockPriority } from './InventoryPage';

const api = vi.hoisted(() => ({
  listAdminProducts: vi.fn(),
  createPurchase: vi.fn(),
  updatePurchase: vi.fn(),
  listInventory: vi.fn(),
  listMovements: vi.fn(),
  listPurchases: vi.fn(),
  adjustStock: vi.fn(),
  listOpeningReservations: vi.fn(),
  getPurchaseImpact: vi.fn(),
  receivePurchase: vi.fn(),
  declareItemShortage: vi.fn(),
  declarePurchaseShortages: vi.fn(),
  replacePurchaseShortage: vi.fn(),
  reassignPurchaseReservations: vi.fn(),
  transitionOrder: vi.fn(),
  listProductReservations: vi.fn(),
  updateStockThresholds: vi.fn(),
  getSettings: vi.fn()
}));
const auth = vi.hoisted(() => ({ staff: false, tab: '' }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: { ...demoOwner, role: auth.staff ? 'staff' : 'owner' } }) }));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ tab: auth.tab }), useBlocker: vi.fn(),
  Link: ({ children, to, ...props }: PropsWithChildren<{ to: string } & Record<string, unknown>>) => (
    <a href={to} {...props}>{children}</a>
  )
}));

function Wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('Carga de compras', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.staff = false;
    auth.tab = '';
    api.listAdminProducts.mockResolvedValue(demoProducts);
    api.listOpeningReservations.mockResolvedValue([]);
    api.listProductReservations.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('daily purchase: protects edited data from Escape, close and Cancel without saving implicitly', async () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PurchaseFormModal onClose={onClose} />, { wrapper: Wrapper });
    const supplier = screen.getByLabelText('Proveedor · opcional');
    fireEvent.change(supplier, { target: { value: 'Compra que estoy preparando' } });
    fireEvent.keyDown(supplier, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar modal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(supplier).toHaveValue('Compra que estoy preparando');
    expect(confirm).toHaveBeenCalledTimes(3);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.createPurchase).not.toHaveBeenCalled();
    expect(api.updatePurchase).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('daily purchase: closes an unchanged form without confirmation', () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, 'confirm');
    render(<PurchaseFormModal onClose={onClose} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('permite editar un pedido existente al proveedor precargando los datos', async () => {
    const onClose = vi.fn();
    api.updatePurchase.mockResolvedValue({});
    const existingPurchase: Purchase = {
      id: 'purch-123',
      number: 42,
      supplierName: 'Star Nutrition',
      state: 'ordered',
      orderedAt: '2026-09-10T12:00:00Z',
      expectedAt: '2026-09-15T12:00:00Z',
      receivedAt: null,
      totalCostCents: 500000,
      notes: 'Pago 50% al pedir',
      items: [
        {
          id: 'pi-1',
          productId: demoProducts[0]!.id,
          productName: demoProducts[0]!.name,
          quantity: 5,
          receivedQuantity: 0,
          shortageQuantity: 0,
          unitCostCents: 100000
        }
      ]
    };
    render(<PurchaseFormModal purchase={existingPurchase} onClose={onClose} />, { wrapper: Wrapper });
    await screen.findByDisplayValue('Star Nutrition');
    expect(screen.getByText('Editar pedido #42')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeEnabled());

    const notesInput = screen.getByLabelText('Notas · opcional');
    fireEvent.change(notesInput, { target: { value: 'Pago 100% acordado' } });

    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(api.updatePurchase).toHaveBeenCalledWith(expect.objectContaining({
      id: 'purch-123',
      supplierName: 'Star Nutrition',
      notes: 'Pago 100% acordado',
      items: [{ productId: demoProducts[0]!.id, quantity: 5, unitCostCents: 100000 }]
    })));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('explica qué fila está incompleta y conserva los centavos al escribir', async () => {
    const onClose = vi.fn();
    api.createPurchase.mockResolvedValue({});
    render(<PurchaseFormModal onClose={onClose} />, { wrapper: Wrapper });
    await screen.findByText('Elegí el producto de la fila 1.');
    expect(screen.getByRole('button', { name: 'Guardar pedido' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Producto de la fila 1' }));
    fireEvent.click(screen.getByRole('option', { name: /Creatina Monohidratada/ }));
    const cost = screen.getByLabelText('Costo por unidad');
    for (const value of ['125', '125,', '125,5', '125,50']) fireEvent.change(cost, { target: { value } });
    expect(cost).toHaveValue('125.50');
    fireEvent.click(screen.getByRole('button', { name: '+ Agregar producto' }));
    expect(screen.getByText('Elegí el producto de la fila 2.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Guardar pedido' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Quitar producto' })[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar pedido' }));
    await waitFor(() => expect(api.createPurchase).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ productId: demoProducts[0]!.id, quantity: 1, unitCostCents: 12550 }]
    })));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('ofrece reintentar cuando falla el catálogo sin perder el proveedor escrito', async () => {
    api.listAdminProducts.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(demoProducts);
    render(<PurchaseFormModal onClose={vi.fn()} />, { wrapper: Wrapper });
    const supplier = screen.getByLabelText('Proveedor · opcional');
    fireEvent.change(supplier, { target: { value: 'Proveedor habitual' } });
    fireEvent.click(await screen.findByRole('button', { name: /Intentar de nuevo/ }));
    await screen.findByText('Elegí el producto de la fila 1.');
    expect(supplier).toHaveValue('Proveedor habitual');
  });

  it('conserva el aviso escrito ante cambios externos y exige revisar la configuración actual', async () => {
    const inventory = toDemoInventory([demoProducts[0]!]);
    api.listInventory.mockResolvedValue(inventory);
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    api.listPurchases.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><InventoryPage /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Creatina Monohidratada.*u\./ }));
    const count = screen.getByRole('textbox', { name: 'Aviso Comprar' });
    fireEvent.change(count, { target: { value: '11' } });
    client.setQueryData(['inventory'], [{ ...inventory[0]!, reorderPoint: 10 }]);
    await screen.findByText(/Los avisos cambiaron mientras editabas/);
    expect(count).toHaveValue('11');
    expect(screen.getByRole('button', { name: /^Guardar$/ })).toBeDisabled();
    fireEvent.change(count, { target: { value: '' } });
    fireEvent.blur(count);
    expect(count).toHaveValue('');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cargar avisos actualizados' }));
    expect(count).toHaveValue('10');
    fireEvent.change(count, { target: { value: '1,5' } });
    expect(count).toHaveValue('10');
    expect(screen.queryByRole('button', { name: /^Guardar$/ })).not.toBeInTheDocument();
    expect(api.updateStockThresholds).not.toHaveBeenCalled();
    client.clear();
  });

  it.each(['2147483648', '9999999999999999'])('preserves the out-of-range threshold %s when another operator updates the configuration', async value => {
    const inventory = [{ ...toDemoInventory([demoProducts[0]!])[0]!, reorderPoint: 5 }];
    api.listInventory.mockResolvedValue(inventory);
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    api.listPurchases.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><InventoryPage /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Creatina Monohidratada.*u\./ }));
    const count = screen.getByRole('textbox', { name: 'Aviso Comprar' });
    fireEvent.change(count, { target: { value } });
    expect(count).toHaveValue(value);
    client.setQueryData(['inventory'], [{ ...inventory[0]!, reorderPoint: 10 }]);
    await screen.findByText(/Los avisos cambiaron mientras editabas/);
    expect(count).toHaveValue(value);
    expect(screen.getByRole('button', { name: /^Guardar$/ })).toBeDisabled();
    expect(api.updateStockThresholds).not.toHaveBeenCalled();
    client.clear();
  });

  it('muestra stock y explica el acceso a compras cuando entra personal por un enlace directo', async () => {
    auth.staff = true; auth.tab = 'compras';
    api.listInventory.mockResolvedValue(toDemoInventory(demoProducts));
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    render(<InventoryPage />, { wrapper: Wrapper });
    expect(await screen.findByRole('button', { name: /Creatina Monohidratada.*u\./ })).toBeInTheDocument();
    expect(screen.getByText(/Las compras las registra la dueña/)).toBeInTheDocument();
    expect(api.listPurchases).not.toHaveBeenCalled();
  });

  it('envía el stock que vio la dueña al abrir el conteo para detectar operaciones posteriores', async () => {
    api.listInventory.mockResolvedValue(toDemoInventory(demoProducts));
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    api.listPurchases.mockResolvedValue({ items: [], total: 0, pendingTotal: 0, receivedTotal: 0, filteredTotal: 0, page: 1, pageSize: 15 });
    api.adjustStock.mockResolvedValue(undefined);
    render(<InventoryPage />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByRole('button', { name: /Creatina Monohidratada.*u\./ }));
    fireEvent.click(screen.getByRole('button', { name: 'Corregir stock' }));
    fireEvent.change(screen.getByLabelText('¿Cuántas unidades hay realmente?'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Motivo de la corrección'), { target: { value: 'Conteo físico' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar corrección' }));
    await waitFor(() => expect(api.adjustStock).toHaveBeenCalledWith(demoProducts[0]!.id, -1, 'Conteo físico', 7));
  });

  it('protege los avisos al abrir un conteo y el conteo editado al cerrar con Escape, cruz o Cancelar', async () => {
    api.listInventory.mockResolvedValue(toDemoInventory(demoProducts));
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    api.listPurchases.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<InventoryPage />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByRole('button', { name: /Creatina Monohidratada.*u\./ }));
    const urgent = screen.getByRole('textbox', { name: 'Aviso Urgente' });
    fireEvent.change(urgent, { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Corregir stock' }));
    expect(urgent).toHaveValue('9');
    expect(screen.queryByLabelText('¿Cuántas unidades hay realmente?')).not.toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Corregir stock' }));
    confirm.mockReturnValue(false);
    const count = screen.getByLabelText('¿Cuántas unidades hay realmente?');
    fireEvent.change(count, { target: { value: '' } });
    fireEvent.blur(count);
    fireEvent.change(count, { target: { value: 'abc' } });
    expect(count).toHaveValue('');
    fireEvent.change(count, { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Motivo de la corrección'), { target: { value: 'Conteo físico pendiente de revisión' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar modal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(count).toHaveValue('6');
    expect(screen.getByLabelText('Motivo de la corrección')).toHaveValue('Conteo físico pendiente de revisión');
    expect(api.adjustStock).not.toHaveBeenCalled();
    expect(api.updateStockThresholds).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('bloquea una corrección si cambia el stock y exige un conteo nuevo sin autocompletar el anterior', async () => {
    const inventory = toDemoInventory(demoProducts);
    api.listInventory.mockResolvedValue(inventory);
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    api.listPurchases.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 15 });
    api.adjustStock.mockResolvedValue(undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<QueryClientProvider client={client}><InventoryPage /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Creatina Monohidratada.*u\./ }));
    fireEvent.click(screen.getByRole('button', { name: 'Corregir stock' }));
    const count = screen.getByLabelText('¿Cuántas unidades hay realmente?');
    fireEvent.change(count, { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Motivo de la corrección'), { target: { value: 'Conteo físico' } });
    client.setQueryData(['inventory'], inventory.map(item => item.id === demoProducts[0]!.id ? { ...item, onHand: 8 } : item));
    await screen.findByText(/El stock registrado cambió de 7 a 8/);
    expect(screen.getByText('Registrado al abrir: 7 · Reservadas ahora: 3 · Libres ahora: 5')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Guardar corrección' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a contar' }));
    expect(count).toHaveValue('6');
    expect(api.adjustStock).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a contar' }));
    fireEvent.blur(count);
    expect(count).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Guardar corrección' })).toBeDisabled();
    fireEvent.change(count, { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar corrección' }));
    await waitFor(() => expect(api.adjustStock).toHaveBeenCalledWith(demoProducts[0]!.id, -1, 'Conteo físico', 8));
    client.clear();
  });

  it('distingue stock físico de unidades reservadas cuando no alcanza para los pedidos', async () => {
    api.listInventory.mockResolvedValue([{
      ...toDemoInventory([demoProducts[0]!])[0]!,
      onHand: 7,
      reserved: 10,
      available: 0,
      incoming: 0,
      status: 'out'
    }]);
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    api.listPurchases.mockResolvedValue({ items: [], total: 0, pendingTotal: 0, receivedTotal: 0, filteredTotal: 0, page: 1, pageSize: 15 });
    render(<InventoryPage />, { wrapper: Wrapper });

    const product = await screen.findByRole('button', { name: /Creatina Monohidratada.*Físico: 7.*Reservado: 10.*0 u./ });
    expect(product).toHaveTextContent('RESERVAS SIN CUBRIR');
    fireEvent.click(product);
    expect(screen.getByText('Faltan 3 unidades reservadas')).toBeVisible();
    expect(screen.getByText(/Hay 7 en depósito y 10 comprometidas con clientes/)).toBeVisible();
  });

  it('explica el ajuste de 10 a 7 y el faltante sin alterar las reservas', async () => {
    api.listInventory.mockResolvedValue([{
      ...toDemoInventory([demoProducts[0]!])[0]!,
      onHand: 10,
      reserved: 10,
      available: 0,
      incoming: 0,
      status: 'out'
    }]);
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    api.listPurchases.mockResolvedValue({ items: [], total: 0, pendingTotal: 0, receivedTotal: 0, filteredTotal: 0, page: 1, pageSize: 15 });
    api.adjustStock.mockResolvedValue(undefined);
    render(<InventoryPage />, { wrapper: Wrapper });

    const product = await screen.findByRole('button', { name: /Creatina Monohidratada.*Físico: 10.*Reservado: 10.*0 u./ });
    expect(product).toHaveTextContent('TODO RESERVADO');
    fireEvent.click(product);
    fireEvent.click(screen.getByRole('button', { name: 'Corregir stock' }));
    expect(screen.getByText('Registrado al abrir: 10 · Reservadas ahora: 10 · Libres ahora: 0')).toBeVisible();
    fireEvent.change(screen.getByLabelText('¿Cuántas unidades hay realmente?'), { target: { value: '7' } });
    expect(screen.getByText('Ajuste físico: de 10 a 7 unidades.')).toBeVisible();
    expect(screen.getByText('-3 unidades')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('faltarán 3 unidades para cubrir las reservas');
    fireEvent.change(screen.getByLabelText('Motivo de la corrección'), { target: { value: 'Conteo físico' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar corrección' }));
    await waitFor(() => expect(api.adjustStock).toHaveBeenCalledWith(demoProducts[0]!.id, -3, 'Conteo físico', 10));
  });

  it('el inventario de personal carga sin solicitudes fallidas a compras', async () => {
    auth.staff = true;
    api.listInventory.mockResolvedValue(toDemoInventory(demoProducts));
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    render(<InventoryPage />, { wrapper: Wrapper });
    await screen.findByRole('button', { name: /Creatina Monohidratada.*u\./ });
    expect(api.listPurchases).not.toHaveBeenCalled();
  });

  it('permite cerrar el calendario con Escape sin descartar la compra', async () => {
    const onClose = vi.fn();
    render(<PurchaseFormModal onClose={onClose} />, { wrapper: Wrapper });
    await screen.findByText('Elegí el producto de la fila 1.');
    const purchase = screen.getByRole('dialog', { name: 'Nuevo pedido al proveedor' });
    fireEvent.click(screen.getByLabelText('Cuándo debería llegar'));
    const calendar = screen.getByRole('dialog', { name: 'Elegir fecha' });
    expect(purchase).not.toContainElement(calendar);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Elegir fecha' })).toBeNull();
    expect(purchase).toBeVisible();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Recepción asistida de compras (ReceivePurchaseModal)', () => {
  const samplePurchase: Purchase = {
    id: 'purch-2042',
    number: 2042,
    supplierName: 'Sophos',
    state: 'ordered',
    orderedAt: '2026-09-10T12:00:00Z',
    expectedAt: '2026-09-25T12:00:00Z',
    receivedAt: null,
    totalCostCents: 3500000,
    notes: null,
    items: [
      {
        id: 'pi-1',
        productId: demoProducts[0]!.id,
        productName: demoProducts[0]!.name,
        quantity: 10,
        receivedQuantity: 0,
        shortageQuantity: 0,
        unitCostCents: 150000
      },
      {
        id: 'pi-2',
        productId: demoProducts[1]!.id,
        productName: demoProducts[1]!.name,
        quantity: 4,
        receivedQuantity: 0,
        shortageQuantity: 0,
        unitCostCents: 200000
      }
    ]
  };

  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    auth.staff = false;
    auth.tab = '';
    api.listAdminProducts.mockResolvedValue(demoProducts);
    api.listOpeningReservations.mockResolvedValue([]);
    api.getSettings.mockResolvedValue({ storeName: 'Sophos Suplementos' });
    api.receivePurchase.mockImplementation(async (_id, received) => ({
      purchase: { ...samplePurchase, items: samplePurchase.items.map(item => ({ ...item,
        receivedQuantity: (item.receivedQuantity ?? 0) + (received.find((line: { purchaseItemId: string }) => line.purchaseItemId === item.id)?.receivedQuantity ?? 0) })) },
      unblockedOrders: []
    }));
    api.declarePurchaseShortages.mockResolvedValue({ ...samplePurchase, state: 'received' });

    api.getPurchaseImpact.mockResolvedValue([
      {
        purchaseItemId: 'pi-1',
        productId: demoProducts[0]!.id,
        productName: demoProducts[0]!.name,
        totalQuantity: 10,
        receivedQuantity: 0,
        shortageQuantity: 0,
        pendingQuantity: 10,
        reservedOrders: [],
        openingReservationsQuantity: 0
      },
      {
        purchaseItemId: 'pi-2',
        productId: demoProducts[1]!.id,
        productName: demoProducts[1]!.name,
        totalQuantity: 4,
        receivedQuantity: 0,
        shortageQuantity: 0,
        pendingQuantity: 4,
        reservedOrders: [
          {
            orderId: 'ord-2504',
            orderNumber: 2504,
            customerName: 'María Soledad Tur',
            customerPhone: '+5491112345678',
            reservedQuantity: 1,
            paymentState: 'paid',
            fulfillmentState: 'pending',
            totalCents: 43000
          }
        ],
        openingReservationsQuantity: 0
      }
    ]);
  });

  it('muestra los dos caminos visuales gigantes al abrir la recepción', async () => {
    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    expect(await screen.findByText('¿Cómo llegó el pedido #2042 de Sophos?')).toBeVisible();
    expect(screen.getByText('Llegó TODO completo')).toBeVisible();
    expect(screen.getByText('Llegó con faltante / parte')).toBeVisible();
  });

  it('camino "Llegó TODO completo": ingresa el 100% de las unidades pendientes', async () => {
    const onClose = vi.fn();
    const onUnblocked = vi.fn();
    api.receivePurchase.mockResolvedValue({ purchase: { ...samplePurchase, state: 'received' }, unblockedOrders: [{ id: 'ord-2504', number: 2504 }] });
    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={onClose} onUnblocked={onUnblocked} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó TODO completo'));
    expect(await screen.findByText('Confirmar ingreso completo')).toBeVisible();
    expect(screen.getByText('Ingreso del 100% de la mercadería')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Confirmar ingreso completo/ }));
    await waitFor(() => expect(api.receivePurchase).toHaveBeenCalledWith('purch-2042', [
      { purchaseItemId: 'pi-1', receivedQuantity: 10 },
      { purchaseItemId: 'pi-2', receivedQuantity: 4 }
    ], expect.any(String)));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onUnblocked).toHaveBeenCalledWith([{ id: 'ord-2504', number: 2504 }]);
  });

  it('camino "Llegó con faltante": parte con todos desmarcados e indicación "Marcá los que falten"', async () => {
    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    expect(await screen.findByText('¿Qué productos faltan en esta entrega?')).toBeVisible();
    expect(screen.getByText('👉 Marcá los que falten')).toBeVisible();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);

    const continueBtn = screen.getByRole('button', { name: /Continuar/ });
    expect(continueBtn).toBeDisabled();

    fireEvent.click(checkboxes[1]!);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
    expect(continueBtn).toBeEnabled();
  });

  it('daily receipt: controls only outstanding products after previous arrivals and declared shortages', async () => {
    const remainingItem = {
      id: 'pi-pending', productId: demoProducts[2]!.id, productName: demoProducts[2]!.name,
      quantity: 6, receivedQuantity: 2, shortageQuantity: 1, unitCostCents: 150000
    };
    const repeatedPurchase: Purchase = { ...samplePurchase, state: 'ordered', items: [
      { ...samplePurchase.items[0]!, receivedQuantity: 10 },
      { ...samplePurchase.items[1]!, shortageQuantity: 4 },
      remainingItem
    ] };
    api.receivePurchase.mockResolvedValue({ purchase: { ...repeatedPurchase, state: 'received', items: [
      ...repeatedPurchase.items.slice(0, 2), { ...remainingItem, receivedQuantity: 5 }
    ] }, unblockedOrders: [] });
    const onClose = vi.fn();
    render(<ReceivePurchaseModal purchase={repeatedPurchase} onClose={onClose} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    expect(await screen.findByText('Llegó todo lo pendiente: 3 u. en 1 producto.')).toBeVisible();
    fireEvent.click(screen.getByText('Llegó con faltante / parte'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryByText(samplePurchase.items[0]!.productName)).not.toBeInTheDocument();
    expect(screen.queryByText(samplePurchase.items[1]!.productName)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('textbox', { name: `Unidades recibidas de ${remainingItem.productName}` })).toHaveValue('0');
    expect(screen.queryByText(/entre 0 y -1/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continuar: registrar/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^Volver$/ }));
    fireEvent.click(screen.getByText('Llegó TODO completo'));
    expect(screen.getByText(/Ingresan 3 unidades/)).toBeVisible();
    expect(screen.queryByText(samplePurchase.items[0]!.productName)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Confirmar ingreso completo/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.receivePurchase).toHaveBeenCalledWith(repeatedPurchase.id, [
      { purchaseItemId: remainingItem.id, receivedQuantity: 3 }
    ], expect.any(String));
    expect(repeatedPurchase.items.map(item => [item.receivedQuantity, item.shortageQuantity])).toEqual([[10, 0], [0, 4], [2, 1]]);
  });

  it('permite borrar y reescribir unidades recibidas sin convertir un vacío temporal en cero', async () => {
    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));
    fireEvent.click((await screen.findAllByRole('checkbox'))[0]!);

    const received = screen.getByRole('textbox', { name: `Unidades recibidas de ${samplePurchase.items[0]!.productName}` });
    const continueButton = screen.getByRole('button', { name: /Continuar/ });
    expect(received).toHaveValue('0');

    fireEvent.change(received, { target: { value: '' } });
    fireEvent.blur(received);
    expect(received).toHaveValue('');
    expect(continueButton).toBeDisabled();
    expect(screen.getByText(/Ingresá cuántas unidades llegaron/i)).toBeVisible();

    fireEvent.change(received, { target: { value: '07' } });
    expect(received).toHaveValue('7');
    expect(continueButton).toBeEnabled();

    fireEvent.change(received, { target: { value: '10' } });
    expect(received).toHaveValue('10');
    expect(continueButton).toBeDisabled();
    expect(screen.getByText(/Ingresá entre 0 y 9 unidades/i)).toBeVisible();

    fireEvent.change(received, { target: { value: '7' } });
    expect(continueButton).toBeEnabled();
    expect(api.receivePurchase).not.toHaveBeenCalled();

    // Cambiar de idea y declarar una recepción completa debe ignorar el borrador parcial.
    fireEvent.change(received, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
    fireEvent.click(screen.getByText('Llegó TODO completo'));
    api.receivePurchase.mockResolvedValue({ purchase: { ...samplePurchase, state: 'received' }, unblockedOrders: [] });
    fireEvent.click(screen.getByRole('button', { name: /Confirmar ingreso completo/ }));
    await waitFor(() => expect(api.receivePurchase).toHaveBeenCalledWith('purch-2042', [
      { purchaseItemId: 'pi-1', receivedQuantity: 10 },
      { purchaseItemId: 'pi-2', receivedQuantity: 4 }
    ], expect.any(String)));
  });

  it('diagnóstico con "SÍ, viene después": permite finalizar sin bloqueos', async () => {
    const onClose = vi.fn();
    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={onClose} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));

    expect(await screen.findByText('Diagnóstico de productos con faltante')).toBeVisible();
    expect(screen.getByRole('button', { name: /SÍ, viene después/ })).toBeVisible();

    const finalizeBtn = screen.getByRole('button', { name: /Finalizar revisión de faltantes/ });
    expect(finalizeBtn).toBeEnabled();

    fireEvent.click(finalizeBtn);
    await waitFor(() => expect(api.receivePurchase).toHaveBeenCalledWith('purch-2042', [
      { purchaseItemId: 'pi-1', receivedQuantity: 10 }
    ], expect.any(String)));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('diagnóstico con "NO (Faltante definitivo)" y clientes reservados: guía a resolver en app', async () => {
    const onClose = vi.fn();
    api.transitionOrder.mockResolvedValue({});
    api.declareItemShortage.mockResolvedValue({ ...samplePurchase, state: 'received' });

    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={onClose} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));

    fireEvent.click(await screen.findByRole('button', { name: /NO \(Faltante definitivo\)/ }));

    expect(await screen.findByText('1 clientes esperando este producto')).toBeVisible();
    expect(screen.getByText('· María Soledad Tur')).toBeVisible();

    const finalizeBtn = screen.getByRole('button', { name: /Finalizar revisión de faltantes/ });
    expect(finalizeBtn).toBeDisabled();

    expect(screen.getByRole('link', { name: /Gestionar pedido/ })).toHaveAttribute('href', '/app/pedidos?search=2504');
    expect(api.transitionOrder).not.toHaveBeenCalled();
    // Until the order is resolved and the impact refreshes, closing the shortage stays blocked.
    expect(finalizeBtn).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('permite pedir reposición a otro proveedor y traslada automáticamente las reservas', async () => {
    api.replacePurchaseShortage.mockResolvedValue({ oldPurchase: { ...samplePurchase, state: 'received' },
      newPurchase: { id: 'purch-new-99', number: 2050, items: [{ id: 'new-pi-1', productId: demoProducts[1]!.id }] }, transferredReservations: 1 });

    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole('button', { name: /NO \(Faltante definitivo\)/ }));

    fireEvent.click(await screen.findByRole('button', { name: /Pedir reposición a otro proveedor/ }));
    expect(await screen.findByText('Crear pedido de reposición a otro proveedor')).toBeVisible();

    fireEvent.change(screen.getByLabelText(/Nombre del nuevo proveedor/), { target: { value: 'Distribuidora Natulab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar reposición' }));

    await waitFor(() => expect(api.replacePurchaseShortage).toHaveBeenCalledWith(expect.objectContaining({
      supplierName: 'Distribuidora Natulab', purchaseItemId: 'pi-2', expectedPending: 4, operationId: expect.any(String)
    })));
    expect(api.createPurchase).not.toHaveBeenCalled();
    expect(api.reassignPurchaseReservations).not.toHaveBeenCalled();

    expect(await screen.findByText(/Reposición creada en/)).toBeVisible();
    expect(screen.getByText(/Reposición creada en/)).toHaveTextContent('Compra #2050');
    expect(screen.getByRole('button', { name: /Finalizar revisión de faltantes/ })).toBeEnabled();
  });
});

describe('Ordenamiento estricto de inventario (getStockPriority y lista renderizada)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.staff = false;
    auth.tab = '';
    api.listAdminProducts.mockResolvedValue(demoProducts);
    api.listOpeningReservations.mockResolvedValue([]);
    api.getSettings.mockResolvedValue({ storeName: 'Sophos Suplementos' });
    api.listPurchases.mockResolvedValue({ items: [], total: 0, pendingTotal: 0, receivedTotal: 0, filteredTotal: 0, page: 1, pageSize: 15 });
    api.listMovements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
  });
  afterEach(cleanup);

  it('asigna las prioridades exactas: sin stock (0), todo reservado (1), en camino (2), urgente (3), comprar (4), ok (5)', () => {
    const base = toDemoInventory([demoProducts[0]!])[0]!;

    const sinStock = { ...base, available: 0, onHand: 0, reserved: 0, incoming: 0, status: 'out' as const };
    const reservasSinCubrir = { ...base, available: -2, onHand: 3, reserved: 5, incoming: 0, status: 'out' as const };
    const todoReservado = { ...base, available: 0, onHand: 5, reserved: 5, incoming: 0, status: 'out' as const };
    const todoReservadoConTransito = { ...base, available: 0, onHand: 5, reserved: 5, incoming: 10, status: 'out' as const };
    const enCamino = { ...base, available: 0, onHand: 0, reserved: 0, incoming: 8, status: 'out' as const };
    const urgente = { ...base, available: 2, onHand: 2, reserved: 0, incoming: 0, status: 'critical' as const };
    const comprar = { ...base, available: 6, onHand: 6, reserved: 0, incoming: 0, status: 'low' as const };
    const ok = { ...base, available: 25, onHand: 25, reserved: 0, incoming: 0, status: 'ok' as const };

    expect(getStockPriority(sinStock)).toBe(0);
    expect(getStockPriority(reservasSinCubrir)).toBe(0);
    expect(getStockPriority(todoReservado)).toBe(1);
    expect(getStockPriority(todoReservadoConTransito)).toBe(1);
    expect(getStockPriority(enCamino)).toBe(2);
    expect(getStockPriority(urgente)).toBe(3);
    expect(getStockPriority(comprar)).toBe(4);
    expect(getStockPriority(ok)).toBe(5);
  });

  it('renderiza la lista de inventario en el orden estricto solicitado', async () => {
    const base = toDemoInventory([demoProducts[0]!])[0]!;

    const itemOk = { ...base, id: 'p-ok', name: 'Zeta Vitaminas', available: 20, onHand: 20, reserved: 0, incoming: 0, status: 'ok' as const };
    const itemComprar = { ...base, id: 'p-comprar', name: 'Beta Alanina', available: 5, onHand: 5, reserved: 0, incoming: 0, status: 'low' as const };
    const itemUrgente = { ...base, id: 'p-urgente', name: 'Magnesio Total', available: 2, onHand: 2, reserved: 0, incoming: 0, status: 'critical' as const };
    const itemEnCamino = { ...base, id: 'p-camino', name: 'Omega 3 Fish', available: 0, onHand: 0, reserved: 0, incoming: 10, status: 'out' as const };
    const itemTodoReservado = { ...base, id: 'p-reservado', name: 'Whey Protein', available: 0, onHand: 4, reserved: 4, incoming: 0, status: 'out' as const };
    const itemSinStock = { ...base, id: 'p-sinstock', name: 'Creatina Creapure', available: 0, onHand: 0, reserved: 0, incoming: 0, status: 'out' as const };

    // Pasamos los productos mezclados
    api.listInventory.mockResolvedValue([
      itemOk,
      itemComprar,
      itemUrgente,
      itemEnCamino,
      itemTodoReservado,
      itemSinStock
    ]);

    render(<InventoryPage />, { wrapper: Wrapper });

    // Esperar a que cargue la lista
    const okElement = await screen.findByText('Zeta Vitaminas');
    expect(okElement).toBeVisible();

    const productButtons = screen.getAllByRole('button').filter(btn =>
      btn.textContent?.includes('Creatina Creapure') ||
      btn.textContent?.includes('Whey Protein') ||
      btn.textContent?.includes('Omega 3 Fish') ||
      btn.textContent?.includes('Magnesio Total') ||
      btn.textContent?.includes('Beta Alanina') ||
      btn.textContent?.includes('Zeta Vitaminas')
    );

    expect(productButtons).toHaveLength(6);
    // Verificar orden estricto: sin stock -> todo reservado -> en camino -> urgente -> comprar -> ok
    expect(productButtons[0]).toHaveTextContent('Creatina Creapure');
    expect(productButtons[0]).toHaveTextContent('SIN STOCK');

    expect(productButtons[1]).toHaveTextContent('Whey Protein');
    expect(productButtons[1]).toHaveTextContent('TODO RESERVADO');

    expect(productButtons[2]).toHaveTextContent('Omega 3 Fish');
    expect(productButtons[2]).toHaveTextContent('EN CAMINO');

    expect(productButtons[3]).toHaveTextContent('Magnesio Total');
    expect(productButtons[3]).toHaveTextContent('URGENTE');

    expect(productButtons[4]).toHaveTextContent('Beta Alanina');
    expect(productButtons[4]).toHaveTextContent('COMPRAR');

    expect(productButtons[5]).toHaveTextContent('Zeta Vitaminas');
    expect(productButtons[5]).toHaveTextContent('OK');
  });

  it('abre el enlace al pedido en una nueva pestaña desde el drawer de inventario', async () => {
    const item = {
      ...toDemoInventory([demoProducts[0]!])[0]!,
      onHand: 10,
      reserved: 10,
      available: 0,
      incoming: 0,
      status: 'out' as const
    };
    api.listInventory.mockResolvedValue([item]);
    api.listProductReservations.mockResolvedValue([{
      orderId: 'ord-101',
      orderNumber: 101,
      customerName: 'Juan Pérez',
      physicalQuantity: 10,
      incomingQuantity: 0,
      packedQuantity: null
    }]);

    render(<InventoryPage />, { wrapper: Wrapper });

    const productBtn = await screen.findByRole('button', { name: /Creatina Monohidratada.*TODO RESERVADO/ });
    fireEvent.click(productBtn);

    const orderLink = await screen.findByRole('link', { name: /Pedido #101/ });
    expect(orderLink).toHaveAttribute('target', '_blank');
    expect(orderLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(orderLink).toHaveAttribute('href', '/app/pedidos');
  });
});
