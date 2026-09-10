import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoProducts, demoOwner, toDemoInventory } from '@/data/demo-data';
import type { Purchase } from '@/domain/types';
import InventoryPage, { PurchaseFormModal } from './InventoryPage';

const api = vi.hoisted(() => ({ listAdminProducts: vi.fn(), createPurchase: vi.fn(), updatePurchase: vi.fn(), listInventory: vi.fn(), listMovements: vi.fn(), listPurchases: vi.fn(), adjustStock: vi.fn(), listOpeningReservations: vi.fn() }));
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
