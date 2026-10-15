import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/domain/errors';
import type { Purchase, PurchaseCancellationPreview } from '@/domain/types';
import { CancelPurchaseModal } from './CancelPurchaseModal';

const api = vi.hoisted(() => ({ getPurchaseCancellationPreview: vi.fn(), cancelPurchase: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@tanstack/react-router', () => ({ useBlocker: vi.fn(), Link: ({ children, to, search: _search, ...props }: PropsWithChildren<Record<string, unknown>>) => <a href={String(to)} {...props}>{children}</a> }));
const purchase: Purchase = { id: 'purchase', number: 2054, supplierName: 'Proveedor original', state: 'ordered', orderedAt: null, expectedAt: null, receivedAt: null,
  totalCostCents: 500000, notes: null, items: [{ id: 'line', productId: 'product', productName: 'Magnesio', quantity: 5, receivedQuantity: 2, shortageQuantity: 0, unitCostCents: 100000 }] };
const preview: PurchaseCancellationPreview = { purchase, pendingUnits: 3, pendingCostCents: 300000, receivedUnits: 2, openingReservedQuantity: 0,
  canCancel: true, canReplace: true, reviewToken: 'review-1', orders: [], replacementItems: [{ productId: 'product', productName: 'Magnesio', quantity: 3, unitCostCents: 100000 }] };
function mount() {
  const onClose = vi.fn(), onResolve = vi.fn(), onDone = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><CancelPurchaseModal purchase={purchase} onClose={onClose} onResolve={onResolve} onDone={onDone} /></QueryClientProvider>);
  return { onClose, onResolve, onDone };
}
async function authorize() {
  fireEvent.change(await screen.findByLabelText('Motivo de cancelación'), { target: { value: 'El proveedor no envía lo pendiente' } });
  fireEvent.click(screen.getByRole('checkbox'));
}
describe('Purchase cancellation review', () => {
  beforeEach(() => { vi.resetAllMocks(); api.getPurchaseCancellationPreview.mockResolvedValue(structuredClone(preview)); });
  afterEach(cleanup);

  it('shows partial balance, protects physical stock and money, requires reason and explicit consent', async () => {
    mount();
    const confirm = await screen.findByRole('button', { name: 'Confirmar cancelación' });
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/Dejarían de llegar 3 unidades/)).toBeInTheDocument();
    expect(screen.getByText(/Lo recibido \(2 u.\)/)).toBeInTheDocument();
    expect(screen.getByText(/no devuelve dinero ni anula gastos/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Motivo de cancelación'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Motivo de cancelación'), { target: { value: 'No se enviará' } });
    expect(confirm).toBeEnabled();
    expect(api.cancelPurchase).not.toHaveBeenCalled();
  });

  it('defaults to replacement when customers depend on the purchase and blocks unprotected cancellation', async () => {
    api.getPurchaseCancellationPreview.mockResolvedValue({ ...preview, canCancel: false, openingReservedQuantity: 1,
      orders: [{ id: 'order', number: 2620, customerName: 'Cliente afectado', quantity: 2 }] });
    const { onResolve } = mount();
    expect(await screen.findByRole('heading', { name: 'Reservas que se trasladarán' })).toBeInTheDocument();
    expect(screen.getByText('Pedido #2620 · Cliente afectado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelar y crear reposición' })).toBeDisabled();
    expect(screen.getByText(/reservas previas/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Cancelar sin reposición/ }));
    expect(screen.getByRole('button', { name: 'Confirmar cancelación' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Primero resolvé las reservas pendientes' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resolver faltantes de esta compra' }));
    expect(onResolve).toHaveBeenCalledWith(purchase);
    expect(api.cancelPurchase).not.toHaveBeenCalled();
  });

  it('submits a single atomic replacement with exact supplier, review and operation identity', async () => {
    api.cancelPurchase.mockResolvedValue({ purchase: { ...purchase, state: 'cancelled', cancellation: { pendingUnits: 3, reason: 'El proveedor no envía lo pendiente' } }, replacementPurchase: { ...purchase, number: 2055, supplierName: 'Proveedor nuevo' }, transferredUnits: 2 });
    mount();
    await screen.findByRole('button', { name: 'Confirmar cancelación' });
    fireEvent.click(screen.getByRole('radio', { name: /Pedir a otro proveedor/ }));
    await authorize();
    const confirm = screen.getByRole('button', { name: 'Cancelar y crear reposición' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Nuevo proveedor'), { target: { value: 'Proveedor nuevo' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.cancelPurchase).toHaveBeenCalledTimes(1));
    expect(api.cancelPurchase).toHaveBeenCalledWith(expect.objectContaining({ purchaseId: purchase.id, expectedToken: preview.reviewToken,
      replacement: { supplierName: 'Proveedor nuevo', expectedAt: null }, operationId: expect.any(String) }));
    expect(await screen.findByRole('heading', { name: 'Compra #2054 cancelada' })).toHaveFocus();
    expect(screen.getByText(/Se trasladaron 2 unidades reservadas/)).toBeInTheDocument();
  });

  it('prevents double submission and cannot close while saving', async () => {
    let finish!: (v: unknown) => void;
    api.cancelPurchase.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { onClose } = mount();
    await authorize();
    const confirm = screen.getByRole('button', { name: 'Confirmar cancelación' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(api.cancelPurchase).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar cancelación' }));
    expect(onClose).not.toHaveBeenCalled();
    finish({ purchase: { ...purchase, cancellation: { pendingUnits: 3 } }, replacementPurchase: null, transferredUnits: 0 });
    await screen.findByRole('heading', { name: 'Compra #2054 cancelada' });
  });

  it('a lost response retries exactly the same request and a new review clears consent', async () => {
    api.cancelPurchase.mockRejectedValue(new AppError('temporary', 'No pudimos confirmar la conexión.'));
    mount(); await authorize();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar cancelación' }));
    await screen.findByRole('button', { name: 'Reintentar guardado' });
    expect(screen.getByLabelText('Motivo de cancelación')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }));
    await waitFor(() => expect(api.cancelPurchase).toHaveBeenCalledTimes(2));
    expect(api.cancelPurchase.mock.calls[0]).toEqual(api.cancelPurchase.mock.calls[1]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Volver a revisar' })).toBeEnabled());
    api.getPurchaseCancellationPreview.mockResolvedValue({ ...preview, reviewToken: 'review-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver a revisar' }));
    await waitFor(() => expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByRole('button', { name: 'Confirmar cancelación' })).toBeDisabled();
    expect(screen.getByLabelText('Motivo de cancelación')).toBeEnabled();
  });

  it('uses application controls, never native confirmation, prompt or alert', async () => {
    const confirm = vi.spyOn(window, 'confirm'), prompt = vi.spyOn(window, 'prompt'), alert = vi.spyOn(window, 'alert');
    const { onClose } = mount(); await screen.findByRole('button', { name: 'Confirmar cancelación' });
    fireEvent.click(screen.getByRole('button', { name: 'Volver' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled(); expect(alert).not.toHaveBeenCalled();
  });
});
