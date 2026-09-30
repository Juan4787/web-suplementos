import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoProducts, demoOwner } from '@/data/demo-data';
import type { Purchase } from '@/domain/types';
import { AppError } from '@/domain/errors';
import { ReceivePurchaseModal } from './InventoryPage';

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
  getSettings: vi.fn()
}));

vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: demoOwner }) }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => ({}), useBlocker: vi.fn() }));

function Wrapper({ children }: PropsWithChildren) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('Auditoría Adversarial: ReceivePurchaseModal', () => {
  afterEach(cleanup);

  const samplePurchase: Purchase = {
    id: 'purch-adv-1',
    number: 9999,
    supplierName: 'Distribuidora Extrema',
    state: 'ordered',
    orderedAt: '2026-09-10T12:00:00Z',
    expectedAt: '2026-09-25T12:00:00Z',
    receivedAt: null,
    totalCostCents: 5000000,
    notes: null,
    items: [
      {
        id: 'pi-adv-1',
        productId: demoProducts[0]!.id,
        productName: demoProducts[0]!.name,
        quantity: 10,
        receivedQuantity: 0,
        shortageQuantity: 0,
        unitCostCents: 150000
      },
      {
        id: 'pi-adv-2',
        productId: demoProducts[1]!.id,
        productName: demoProducts[1]!.name,
        quantity: 5,
        receivedQuantity: 0,
        shortageQuantity: 0,
        unitCostCents: 200000
      }
    ]
  };

  beforeEach(() => {
    vi.resetAllMocks();
    api.listAdminProducts.mockResolvedValue(demoProducts);
    api.listOpeningReservations.mockResolvedValue([]);
    api.getPurchaseImpact.mockResolvedValue([]);
    api.getSettings.mockResolvedValue({ storeName: 'Sophos Suplementos' });
    api.receivePurchase.mockImplementation(async (_id, received) => ({
      purchase: { ...samplePurchase, items: samplePurchase.items.map(item => ({ ...item,
        receivedQuantity: (item.receivedQuantity ?? 0) + (received.find((line: { purchaseItemId: string }) => line.purchaseItemId === item.id)?.receivedQuantity ?? 0) })) },
      unblockedOrders: []
    }));
    api.declarePurchaseShortages.mockResolvedValue({ ...samplePurchase, state: 'received' });

  });

  it('Adversarial 1: 100% de faltante con 0 unidades recibidas no llama a receivePurchase con array vacío o ceros', async () => {
    const onClose = vi.fn();
    api.getPurchaseImpact.mockResolvedValue([
      {
        purchaseItemId: 'pi-adv-1',
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
        purchaseItemId: 'pi-adv-2',
        productId: demoProducts[1]!.id,
        productName: demoProducts[1]!.name,
        totalQuantity: 5,
        receivedQuantity: 0,
        shortageQuantity: 0,
        pendingQuantity: 5,
        reservedOrders: [],
        openingReservationsQuantity: 0
      }
    ]);
    api.declareItemShortage.mockResolvedValue({ ...samplePurchase, state: 'received' });

    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={onClose} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    // Marcamos ambos productos con faltante
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!); // pi-adv-1: 0 u. recibidas
    fireEvent.click(checkboxes[1]!); // pi-adv-2: 0 u. recibidas
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));

    // Ambos marcados como NO (faltante definitivo)
    const noBtns = await screen.findAllByRole('button', { name: /NO \(Faltante definitivo\)/ });
    fireEvent.click(noBtns[0]!);
    fireEvent.click(noBtns[1]!);

    const finalizeBtn = screen.getByRole('button', { name: /Finalizar revisión de faltantes/ });
    expect(finalizeBtn).toBeEnabled();
    fireEvent.click(finalizeBtn);

    // Verificamos que NO se llamó a receivePurchase porque no hay unidades a ingresar (>0)
    await waitFor(() => expect(api.declarePurchaseShortages).toHaveBeenCalledTimes(1));
    expect(api.receivePurchase).not.toHaveBeenCalled();
    expect(api.declarePurchaseShortages).toHaveBeenCalledWith(samplePurchase.id, [
      { purchaseItemId: 'pi-adv-1', quantity: 10 }, { purchaseItemId: 'pi-adv-2', quantity: 5 }
    ], expect.any(String));
    expect(api.declareItemShortage).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Adversarial 2: Bloqueo anti-evasión cuando múltiples clientes esperan un ítem', async () => {
    api.getPurchaseImpact.mockResolvedValue([
      {
        purchaseItemId: 'pi-adv-1',
        productId: demoProducts[0]!.id,
        productName: demoProducts[0]!.name,
        totalQuantity: 10,
        receivedQuantity: 0,
        shortageQuantity: 0,
        pendingQuantity: 10,
        reservedOrders: [
          { orderId: 'ord-1', orderNumber: 101, customerName: 'Cliente Uno', customerPhone: '+549111', reservedQuantity: 1, paymentState: 'paid', fulfillmentState: 'pending', totalCents: 10000 },
          { orderId: 'ord-2', orderNumber: 102, customerName: 'Cliente Dos', customerPhone: '+549112', reservedQuantity: 2, paymentState: 'unpaid', fulfillmentState: 'pending', totalCents: 20000 },
          { orderId: 'ord-3', orderNumber: 103, customerName: 'Cliente Tres', customerPhone: null, reservedQuantity: 1, paymentState: 'paid', fulfillmentState: 'pending', totalCents: 10000 }
        ],
        openingReservationsQuantity: 0
      }
    ]);
    api.transitionOrder.mockResolvedValue({});

    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));

    const noBtns = await screen.findAllByRole('button', { name: /NO \(Faltante definitivo\)/ });
    fireEvent.click(noBtns[0]!);

    const finalizeBtn = screen.getByRole('button', { name: /Finalizar revisión de faltantes/ });
    expect(finalizeBtn).toBeDisabled();

    expect(screen.getAllByRole('link', { name: /Gestionar pedido/ })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Reembolsar y cancelar/ })).not.toBeInTheDocument();
    expect(api.transitionOrder).not.toHaveBeenCalled();
    expect(finalizeBtn).toBeDisabled();
  });

  it('Adversarial 3: conserva números fuera de rango y rechaza signos sin reinterpretar el conteo', async () => {
    api.getPurchaseImpact.mockResolvedValue([]);
    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!); // pi-adv-1 tiene 10 u. pendientes

    const countInput = screen.getByRole('textbox', { name: 'Unidades recibidas de Creatina Monohidratada' });
    const continueButton = screen.getByRole('button', { name: /Continuar/ });
    // Intento 1: Escribir 9999 (mayor al remanente)
    fireEvent.change(countInput, { target: { value: '9999' } });
    expect(countInput).toHaveValue('9999');
    expect(continueButton).toBeDisabled();
    expect(screen.getByText(/Ingresá entre 0 y 9 unidades/i)).toBeVisible();

    // Intento 2: Escribir -50 (número negativo)
    fireEvent.change(countInput, { target: { value: '-50' } });
    expect(countInput).toHaveValue('9999');
    expect(continueButton).toBeDisabled();
    expect(screen.getByText(/Ingresá entre 0 y 9 unidades/i)).toBeVisible();

    fireEvent.change(countInput, { target: { value: '7' } });
    expect(countInput).toHaveValue('7');
    expect(continueButton).toBeEnabled();
  });

  it('Adversarial 4: Cliente sin teléfono no rompe la UI ni emite enlaces defectuosos', async () => {
    api.getPurchaseImpact.mockResolvedValue([
      {
        purchaseItemId: 'pi-adv-1',
        productId: demoProducts[0]!.id,
        productName: demoProducts[0]!.name,
        totalQuantity: 10,
        receivedQuantity: 0,
        shortageQuantity: 0,
        pendingQuantity: 10,
        reservedOrders: [
          { orderId: 'ord-sin-tel', orderNumber: 555, customerName: 'Sin Teléfono', customerPhone: null, reservedQuantity: 1, paymentState: 'paid', fulfillmentState: 'pending', totalCents: 15000 }
        ],
        openingReservationsQuantity: 0
      }
    ]);

    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole('button', { name: /NO \(Faltante definitivo\)/ }));

    // No debe existir botón o link de WhatsApp para este cliente
    expect(screen.queryByTitle('Enviar mensaje por WhatsApp')).toBeNull();
    // Pero sí debe ser visible el botón para resolver en app
    expect(screen.getByRole('link', { name: /Gestionar pedido/ })).toBeVisible();
    expect(screen.getByText('· Sin Teléfono')).toBeVisible();
  });

  it('Adversarial 5: Compra sin nombre de proveedor especificado se renderiza de forma limpia', async () => {
    const purchaseWithoutSupplier = { ...samplePurchase, supplierName: '' };
    render(<ReceivePurchaseModal purchase={purchaseWithoutSupplier} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });

    expect(await screen.findByText('¿Cómo llegó el pedido #9999?')).toBeVisible();
    expect(screen.queryByText(/null/i)).toBeNull();
    expect(screen.queryByText(/undefined/i)).toBeNull();
  });

  it('Adversarial 6: Modal de reposición a otro proveedor rechaza proveedor en blanco', async () => {
    api.getPurchaseImpact.mockResolvedValue([
      {
        purchaseItemId: 'pi-adv-1',
        productId: demoProducts[0]!.id,
        productName: demoProducts[0]!.name,
        totalQuantity: 10,
        receivedQuantity: 0,
        shortageQuantity: 0,
        pendingQuantity: 10,
        reservedOrders: [
          { orderId: 'ord-rep', orderNumber: 777, customerName: 'Esperando Reposición', customerPhone: '+54911', reservedQuantity: 2, paymentState: 'paid', fulfillmentState: 'pending', totalCents: 20000 }
        ],
        openingReservationsQuantity: 0
      }
    ]);

    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole('button', { name: /NO \(Faltante definitivo\)/ }));

    fireEvent.click(await screen.findByRole('button', { name: /Pedir reposición a otro proveedor/ }));
    const confirmBtn = screen.getByRole('button', { name: 'Confirmar reposición' });

    // Con el campo vacío, el botón está deshabilitado
    expect(confirmBtn).toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(api.createPurchase).not.toHaveBeenCalled();

    // Solo al tipear un proveedor válido se habilita
    fireEvent.change(screen.getByLabelText(/Nombre del nuevo proveedor/), { target: { value: 'Distribuidora Premium' } });
    expect(confirmBtn).toBeEnabled();
  });

  it('explains a replacement failure inside its dialog and retries the same operation without re-recording arrival', async () => {
    api.getPurchaseImpact.mockResolvedValue([{ purchaseItemId: 'pi-adv-1', reservedOrders: [{
      orderId: 'waiting', orderNumber: 77, customerName: 'Cliente pendiente', reservedQuantity: 2, paymentState: 'paid'
    }], openingReservationsQuantity: 0 }]);
    api.replacePurchaseShortage.mockRejectedValueOnce(new AppError('temporary', 'Se cortó la conexión.', { nextAction: 'Reintentá con los mismos datos.' }))
      .mockResolvedValueOnce({ oldPurchase: { ...samplePurchase, items: samplePurchase.items.map(item => item.id === 'pi-adv-1'
        ? { ...item, receivedQuantity: 5, shortageQuantity: 5 } : { ...item, receivedQuantity: 5 }) },
        newPurchase: { number: 10001 }, transferredReservations: 1 });
    render(<ReceivePurchaseModal purchase={samplePurchase} onClose={vi.fn()} onUnblocked={vi.fn()} />, { wrapper: Wrapper });
    fireEvent.click(await screen.findByText('Llegó con faltante / parte'));
    fireEvent.click((await screen.findAllByRole('checkbox'))[0]!);
    fireEvent.change(screen.getByRole('textbox', { name: /Unidades recibidas/ }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Continuar/ }));
    fireEvent.click(await screen.findByRole('button', { name: /NO \(Faltante definitivo\)/ }));
    expect(screen.getByText('Quedan pendientes 5 unidades · Recibidas hasta ahora: 5 de 10')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: 'Pedir reposición a otro proveedor' }));
    const modal = within(screen.getByRole('dialog', { name: 'Crear pedido de reposición a otro proveedor' }));
    const supplier = modal.getByRole('textbox', { name: /Nombre del nuevo proveedor/ });
    fireEvent.change(supplier, { target: { value: 'Nuevo distribuidor' } });
    fireEvent.click(modal.getByRole('button', { name: 'Confirmar reposición' }));
    expect(await modal.findByText('Se cortó la conexión.')).toBeVisible();
    expect(supplier).toHaveValue('Nuevo distribuidor');
    await waitFor(() => expect(modal.getByRole('button', { name: 'Confirmar reposición' })).toBeEnabled());
    fireEvent.click(modal.getByRole('button', { name: 'Confirmar reposición' }));
    expect(await screen.findByText(/Reposición creada en/)).toHaveTextContent('Compra #10001');
    expect(api.replacePurchaseShortage.mock.calls[0]![0]).toEqual(api.replacePurchaseShortage.mock.calls[1]![0]);
    expect(api.replacePurchaseShortage.mock.calls[0]![0].expectedPending).toBe(5);
    expect(api.receivePurchase).toHaveBeenCalledTimes(1);
    expect(api.transitionOrder).not.toHaveBeenCalled();
    expect(api.createPurchase).not.toHaveBeenCalled();
  });
});
