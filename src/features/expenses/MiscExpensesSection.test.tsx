import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MiscExpense, MiscExpensePeriod } from '@/domain/types';
import { MiscExpensesSection } from './MiscExpensesSection';

const api = vi.hoisted(() => ({
  listMiscExpenses: vi.fn(),
  saveMiscExpense: vi.fn(),
  deleteMiscExpense: vi.fn()
}));

vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));

const clients: QueryClient[] = [];
const emptyPeriod = (from: string, to: string): MiscExpensePeriod => ({
  from,
  to,
  expenseCount: 0,
  occurrenceCount: 0,
  totalCents: 0,
  items: []
});

const savedExpense: MiscExpense = {
  id: '10000000-0000-4000-8000-000000000001',
  operationId: '20000000-0000-4000-8000-000000000001',
  title: 'Impuestos provinciales',
  amountCents: 25_000_050,
  frequency: 'monthly',
  startsOn: '2026-09-15',
  endsOn: null,
  createdAt: '2026-09-15T12:00:00.000Z',
  updatedAt: '2026-09-15T12:00:00.000Z',
  deletedAt: null,
  createdByName: 'Dueña',
  updatedByName: 'Dueña'
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } }
  });
  clients.push(client);
  const onNotify = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <MiscExpensesSection onNotify={onNotify} />
    </QueryClientProvider>
  );
  return { onNotify };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.listMiscExpenses.mockImplementation((from: string, to: string) =>
    Promise.resolve(emptyPeriod(from, to))
  );
  api.saveMiscExpense.mockResolvedValue(savedExpense);
  api.deleteMiscExpense.mockResolvedValue({ ...savedExpense, deletedAt: '2026-09-15T13:00:00.000Z' });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe('Gastos varios en Configuración', () => {
  it('revela las opciones de finalización solo cuando la frecuencia las necesita', async () => {
    setup();
    await screen.findByText(/No hay gastos para/i);
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar gasto' })[0]!);

    const dialog = screen.getByRole('dialog', { name: 'Agregar gasto' });
    expect(within(dialog).queryByLabelText('Repetir hasta')).toBeNull();
    expect(within(dialog).queryByText('¿Este gasto termina en una fecha?')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Semanal' }));
    expect(within(dialog).getByText('¿Este gasto termina en una fecha?')).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: /Definir fecha/ }));
    expect(within(dialog).getByLabelText('Repetir hasta')).toBeVisible();
  });

  it('explica qué falta después de un intento incompleto', async () => {
    setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar gasto' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Agregar gasto' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar gasto' }));
    expect(within(dialog).getByText('Escribí un título de al menos 2 caracteres.')).toBeVisible();
    expect(within(dialog).getByText('Ingresá un monto mayor a cero.')).toBeVisible();
    expect(api.saveMiscExpense).not.toHaveBeenCalled();
  });

  it('guarda un gasto mensual con centavos y sin opciones ocultas residuales', async () => {
    const { onNotify } = setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar gasto' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Agregar gasto' });

    fireEvent.change(within(dialog).getByLabelText('Título del gasto'), {
      target: { value: 'Impuestos provinciales' }
    });
    fireEvent.change(within(dialog).getByLabelText('Monto (ARS)'), {
      target: { value: '250000,50' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mensual' }));
    fireEvent.change(within(dialog).getByLabelText('Primera fecha'), {
      target: { value: '2026-09-15' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agregar gasto' }));

    await waitFor(() => expect(api.saveMiscExpense).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Impuestos provinciales',
      amountCents: 25_000_050,
      frequency: 'monthly',
      startsOn: '2026-09-15',
      endsOn: null,
      operationId: expect.any(String)
    })));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(
      'Gasto agregado',
      expect.stringContaining('recurrencia')
    ));
  });
});
