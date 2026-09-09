import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/domain/errors';
import { OpeningReservations } from './OpeningReservations';

const api = vi.hoisted(() => ({ listOpeningReservations: vi.fn(), resolveOpeningReservation: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
const reservation = { purchaseItemId: 'item', purchaseId: 'purchase', purchaseNumber: 2034, productId: 'product', productName: 'THYROID SUPPORT', physicalQuantity: 0, incomingQuantity: 3, uncoveredQuantity: 0, totalQuantity: 3 };
const clients: QueryClient[] = [];
function setup(canReceive = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retryDelay: 0 } } });
  clients.push(client);
  const onOpenPurchases = vi.fn();
  render(<QueryClientProvider client={client}><OpeningReservations canReceive={canReceive} onOpenPurchases={onOpenPurchases} /></QueryClientProvider>);
  return { onOpenPurchases };
}
beforeEach(() => { vi.resetAllMocks(); api.listOpeningReservations.mockResolvedValue([reservation]); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

describe('Reservas previas a la entrega de la aplicación', () => {
  it('explica por qué no puede entregar y lleva a la recepción sin alterar la reserva', async () => {
    const { onOpenPurchases } = setup();
    expect(await screen.findByRole('button', { name: 'Registrar entrega' })).toBeDisabled();
    expect(screen.getByText('Primero registrá la recepción de la compra.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Ir a Compras para recibir' }));
    expect(onOpenPurchases).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Liberar reserva' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(api.resolveOpeningReservation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('valida unidades enteras y confirma una entrega parcial actualizando lo que queda', async () => {
    api.listOpeningReservations.mockResolvedValueOnce([{ ...reservation, physicalQuantity: 3, incomingQuantity: 1, totalQuantity: 4 }])
      .mockResolvedValue([{ ...reservation, physicalQuantity: 1, incomingQuantity: 1, totalQuantity: 2 }]);
    api.resolveOpeningReservation.mockResolvedValue({ quantity: 2, action: 'deliver' });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar entrega' }));
    fireEvent.change(screen.getByLabelText('Unidades'), { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: 'Confirmar entrega' })).toBeDisabled();
    expect(screen.getByText('Ingresá una cantidad entera entre 1 y 3.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Unidades'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar entrega' }));
    expect(await screen.findByText('THYROID SUPPORT: 2 unidades entregadas. Stock actualizado.')).toBeVisible();
    expect(api.resolveOpeningReservation).toHaveBeenCalledWith('item', 2, 'deliver', expect.any(String));
    await screen.findByText('Para entregar: 1 · En camino: 1');
  });

  it('reutiliza la misma confirmación al recuperar una respuesta perdida', async () => {
    api.listOpeningReservations.mockResolvedValueOnce([{ ...reservation, physicalQuantity: 1, incomingQuantity: 0, totalQuantity: 1 }]).mockResolvedValue([]);
    api.resolveOpeningReservation.mockRejectedValueOnce(new AppError('temporary', 'No pudimos confirmar el resultado.', { retryable: true })).mockResolvedValue({ quantity: 1, action: 'deliver' });
    setup(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar entrega' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar entrega' }));
    await screen.findByText('THYROID SUPPORT: 1 unidad entregada. Stock actualizado.');
    await waitFor(() => expect(api.resolveOpeningReservation).toHaveBeenCalledTimes(2));
    expect(api.resolveOpeningReservation.mock.calls[0]).toEqual(api.resolveOpeningReservation.mock.calls[1]);
    expect(screen.queryByRole('button', { name: 'Registrar entrega' })).toBeNull();
  });
});
