import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoProducts, demoOwner, toDemoInventory } from '@/data/demo-data';
import type { Purchase } from '@/domain/types';
import InventoryPage, { PurchaseFormModal, ReceivePurchaseModal } from './InventoryPage';

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
  reassignPurchaseReservations: vi.fn(),
  transitionOrder: vi.fn(),
  getSettings: vi.fn()
}));
const auth = vi.hoisted(() => ({ staff: false }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: { ...demoOwner, role: auth.staff ? 'staff' : 'owner' } }) }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}) }));

function Wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('Carga de compras', () => {
  beforeEach(() => { vi.resetAllMocks(); auth.staff = false; api.listAdminProducts.mockResolvedValue(demoProducts); api.listOpeningReservations.mockResolvedValue([]); });
  afterEach(cleanup);

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
    api.listAdminProducts.mockResolvedValue(demoProducts);
    api.listOpeningReservations.mockResolvedValue([]);
    api.getSettings.mockResolvedValue({ storeName: 'Sophos Suplementos' });
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

  it('diagnóstico con "SÍ, viene después": permite finalizar sin bloqueos', async () => {
    const onClose = vi.fn();
    api.receivePurchase.mockResolvedValue({ purchase: samplePurchase, unblockedOrders: [] });
    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={onClose} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));

    expect(await screen.findByText('Diagnóstico de productos con faltante')).toBeVisible();
    expect(screen.getByRole('button', { name: /SÍ, viene después/ })).toBeVisible();

    const finalizeBtn = screen.getByRole('button', { name: /Finalizar recepción/ });
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
    api.receivePurchase.mockResolvedValue({ purchase: samplePurchase, unblockedOrders: [] });
    api.declareItemShortage.mockResolvedValue({ ...samplePurchase, state: 'received' });

    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={onClose} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));

    fireEvent.click(await screen.findByRole('button', { name: /NO \(Faltante definitivo\)/ }));

    expect(await screen.findByText('1 clientes esperando este producto')).toBeVisible();
    expect(screen.getByText('· María Soledad Tur')).toBeVisible();

    const finalizeBtn = screen.getByRole('button', { name: /Finalizar recepción/ });
    expect(finalizeBtn).toBeDisabled();

    const resolveBtn = screen.getByRole('button', { name: 'Reembolsar y cancelar en app' });
    fireEvent.click(resolveBtn);

    await waitFor(() => expect(api.transitionOrder).toHaveBeenCalledWith('ord-2504', 'mark_refunded'));
    await waitFor(() => expect(api.transitionOrder).toHaveBeenCalledWith('ord-2504', 'cancel'));
    expect(await screen.findByText(/Registrado en sistema \(reembolsado y cancelado\)/)).toBeVisible();

    expect(finalizeBtn).toBeEnabled();
    fireEvent.click(finalizeBtn);

    await waitFor(() => expect(api.receivePurchase).toHaveBeenCalled());
    await waitFor(() => expect(api.declareItemShortage).toHaveBeenCalledWith('pi-2', 4, expect.any(String)));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('permite pedir reposición a otro proveedor y traslada automáticamente las reservas', async () => {
    api.createPurchase.mockResolvedValue({ id: 'purch-new-99', number: 2050, items: [{ id: 'new-pi-1', productId: demoProducts[1]!.id }] });
    api.reassignPurchaseReservations.mockResolvedValue({ transferredReservations: 1 });

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

    await waitFor(() => expect(api.createPurchase).toHaveBeenCalledWith(expect.objectContaining({
      supplierName: 'Distribuidora Natulab',
      items: [{ productId: demoProducts[1]!.id, quantity: 4, unitCostCents: 200000 }]
    })));
    await waitFor(() => expect(api.reassignPurchaseReservations).toHaveBeenCalledWith('pi-2', 'purch-new-99'));

    expect(await screen.findByText(/Reposición creada en/)).toBeVisible();
    expect(screen.getByText(/2050/)).toBeVisible();
    expect(screen.getByRole('button', { name: /Finalizar recepción/ })).toBeEnabled();
  });
});
