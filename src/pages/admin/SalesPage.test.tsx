import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoOrders, demoOwner } from '@/data/demo-data';
import type { AnalyticsSummary } from '@/domain/types';
import SalesPage from './SalesPage';

const api = vi.hoisted(() => ({ getAnalytics: vi.fn(), listPaidOrders: vi.fn() }));
vi.mock('@/services/business-api', () => ({ getBusinessApi: async () => api }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ user: demoOwner }) }));
vi.mock('@tanstack/react-router', () => ({}));
const summary: AnalyticsSummary = { from: '', to: '', comparisonCutoffDay: null, revenueCents: 26440000,
  costCents: 17670000, taxCents: 0, commercialMarginCents: 8770000, miscExpensesCents: 0,
  miscExpenseOccurrences: 0, estimatedMarginCents: 8770000, averageTicketCents: 5288000,
  orders: 5, costSaleOrders: 1, costSaleRevenueCents: 8540000, giftOrders: 0, units: 12, series: [], topProducts: [] };

function mount(options?: { staleTime: number; gcTime: number }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, ...options } } });
  render(<QueryClientProvider client={client}><SalesPage /></QueryClientProvider>);
  return client;
}
async function choose(label: string) {
  fireEvent.click(screen.getByRole('button', { name: /Este mes|Hoy|Esta semana|Mes anterior|Últimos 30 días|Últimos 6 meses|Este año/ }));
  fireEvent.click(await screen.findByRole('option', { name: label }));
}

describe('Sales UI: counts and inclusive presets', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00-03:00'));
    api.getAnalytics.mockReset().mockImplementation(async (from: string, to: string) => ({ ...summary, from, to }));
    api.listPaidOrders.mockReset().mockResolvedValue({ page: 1, pageSize: 20, total: 0, items: [] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('shows the API paid count including cost sales without adding it twice', async () => {
    mount();
    expect(await screen.findByText('5 ventas cobradas en el período')).toBeVisible();
    expect(screen.getByText(/1 venta al costo/)).toBeVisible();
    expect(screen.queryByText('6 ventas cobradas en el período')).not.toBeInTheDocument();
  });

  it.each([
    ['Hoy', '2026-10-01', '2026-10-01'], ['Esta semana', '2026-09-28', '2026-10-01'],
    ['Mes anterior', '2026-09-01', '2026-09-30'], ['Últimos 30 días', '2026-09-02', '2026-10-01'],
    ['Últimos 6 meses', '2026-05-01', '2026-10-01'], ['Este año', '2026-01-01', '2026-10-01']
  ])('sends exact dates for %s to both independent queries', async (label, from, to) => {
    mount(); await screen.findByText('5 ventas cobradas en el período'); await choose(label);
    await waitFor(() => expect(api.getAnalytics).toHaveBeenLastCalledWith(from, to));
    await waitFor(() => expect(api.listPaidOrders).toHaveBeenLastCalledWith(1, 20, from, to));
  });

  it.each(['2024-01-01', '2024-02-01', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-31',
    '2025-02-28', '2025-03-01', '2025-12-31', '2026-01-01', '2026-04-30', '2026-05-31'])
    ('30 days remains exactly 30 at %s', async day => {
      vi.setSystemTime(new Date(`${day}T12:00:00-03:00`)); mount();
      await screen.findByText('5 ventas cobradas en el período'); await choose('Últimos 30 días');
      const expected = new Date(Date.parse(`${day}T12:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
      await waitFor(() => expect(api.getAnalytics).toHaveBeenLastCalledWith(expected, day));
    });

  it('today means Buenos Aires even when the device has a different calendar day', async () => {
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'));
    mount(); await screen.findByText('5 ventas cobradas en el período'); await choose('Hoy');
    await waitFor(() => expect(api.getAnalytics).toHaveBeenLastCalledWith('2026-10-01', '2026-10-01'));
  });

  it('returning the following day refreshes the named period', async () => {
    mount(); await screen.findByText('5 ventas cobradas en el período');
    vi.setSystemTime(new Date('2026-10-02T12:00:00-03:00')); fireEvent(window, new Event('focus'));
    await waitFor(() => expect(api.getAnalytics).toHaveBeenLastCalledWith('2026-10-01', '2026-10-02'));
  });

  it('returning from a hidden mobile tab also updates the named period', async () => {
    mount(); await screen.findByText('5 ventas cobradas en el período');
    vi.setSystemTime(new Date('2026-10-02T12:00:00-03:00'));
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(api.getAnalytics).toHaveBeenLastCalledWith('2026-10-01', '2026-10-02'));
  });

  it('clearing a custom date gives guidance without querying an invalid period or restoring it', async () => {
    mount(); await screen.findByText('5 ventas cobradas en el período'); await choose('Personalizado…');
    api.getAnalytics.mockClear(); api.listPaidOrders.mockClear();
    fireEvent.click(screen.getAllByTestId('datepicker-clear')[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Elegí las fechas');
    expect(screen.queryByText('5 ventas cobradas en el período')).not.toBeInTheDocument();
    expect(api.getAnalytics).not.toHaveBeenCalled(); expect(api.listPaidOrders).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-02T12:00:00-03:00')); fireEvent(window, new Event('focus'));
    expect(screen.getByRole('alert')).toHaveTextContent('Elegí las fechas');
  });

  it('a gift-only period shows its loss and leaves an undefined percentage blank', async () => {
    api.getAnalytics.mockResolvedValue({ ...summary, orders: 0, revenueCents: 0, costCents: 75001,
      commercialMarginCents: -75001, estimatedMarginCents: -75001, averageTicketCents: 0,
      giftOrders: 1, giftCostCents: 75001, costSaleOrders: 0,
      topProducts: [{ productId: 'gift', name: 'Gift fixture', units: 1, revenueCents: 0, costCents: 75001, estimatedMarginCents: -75001 }] });
    mount(); await screen.findByText('0 ventas cobradas en el período');
    fireEvent.click(screen.getByRole('button', { name: 'Ganancia' }));
    expect(screen.getByText('Sin ventas cobradas para calcular el porcentaje')).toBeVisible();
    expect(screen.getByRole('row', { name: /Gift fixture/ }).lastElementChild).toHaveTextContent('—');
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
  });

  it('historical name changes of the same product keep separate rows without duplicate keys', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      api.getAnalytics.mockResolvedValue({ ...summary, topProducts: [
        { productId: 'same', name: 'Previous name', units: 1, revenueCents: 10000, costCents: 7000, estimatedMarginCents: 3000 },
        { productId: 'same', name: 'Current name', units: 1, revenueCents: 20000, costCents: 7000, estimatedMarginCents: 13000 }
      ] });
      mount(); await screen.findByText('5 ventas cobradas en el período');
      fireEvent.click(screen.getByRole('button', { name: 'Productos' }));
      expect(screen.getByRole('row', { name: /Previous name/ })).toBeVisible();
      expect(screen.getByRole('row', { name: /Current name/ })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Ganancia' }));
      expect(screen.getByRole('row', { name: /Previous name/ })).toBeVisible();
      expect(error.mock.calls.flat().join(' ')).not.toMatch(/same key|unique.*key/i);
    } finally { error.mockRestore(); }
  });

  it('order date labels stay on the same Buenos Aires day as the selected period', async () => {
    api.listPaidOrders.mockResolvedValue({ page: 1, pageSize: 20, total: 1,
      items: [{ ...demoOrders[0], id: 'midnight', customerName: 'Midnight fixture', paidAt: '2026-10-01T02:59:59Z' }] });
    mount(); await screen.findByText('5 ventas cobradas en el período'); await choose('Mes anterior');
    const row = await screen.findByRole('row', { name: /Midnight fixture/ });
    expect(row).toHaveTextContent('30/9/26');
    expect(row).not.toHaveTextContent('1/10/26');
  });

  it('revisiting a period under the production 30-second cache still reads a newly registered payment', async () => {
    const client = mount({ staleTime: 30000, gcTime: 300000 });
    try {
      await screen.findByText('5 ventas cobradas en el período');
      api.getAnalytics.mockImplementation(async (from: string, to: string) => ({ ...summary, from, to, orders: from === '2026-09-01' ? 100 : 6 }));
      await choose('Mes anterior'); await screen.findByText('100 ventas cobradas en el período');
      await choose('Este mes');
      expect(await screen.findByText('6 ventas cobradas en el período')).toBeVisible();
    } finally { client.clear(); }
  });

  it('a delayed fresh response is announced and cannot restore a custom date cleared while waiting', async () => {
    const client = mount({ staleTime: 30000, gcTime: 300000 });
    let finish!: (a: AnalyticsSummary) => void;
    try {
      await screen.findByText('5 ventas cobradas en el período');
      api.getAnalytics.mockImplementation((from: string, to: string) => from === '2026-09-01'
        ? Promise.resolve({ ...summary, from, to, orders: 100 })
        : new Promise<AnalyticsSummary>(resolve => { finish = resolve; }));
      await choose('Mes anterior'); await screen.findByText('100 ventas cobradas en el período');
      await choose('Este mes');
      expect(await screen.findByText('Actualizando ventas…')).toBeVisible();
      await choose('Personalizado…'); fireEvent.click(screen.getAllByTestId('datepicker-clear')[0]!);
      const calls = api.getAnalytics.mock.calls.length;
      finish({ ...summary, from: '2026-10-01', to: '2026-10-01', orders: 6 });
      await waitFor(() => expect(client.isFetching()).toBe(0));
      fireEvent(document, new Event('visibilitychange'));
      expect(screen.getByRole('alert')).toHaveTextContent('Elegí las fechas');
      expect(screen.queryByText('6 ventas cobradas en el período')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('datepicker-clear')).toHaveLength(1);
      expect(api.getAnalytics.mock.calls).toHaveLength(calls);
    } finally { client.clear(); }
  });

  it('opening the chart preserves the period selected for the report', async () => {
    mount(); await screen.findByText('5 ventas cobradas en el período');
    fireEvent.click(screen.getByRole('button', { name: 'Evolución' }));
    expect(screen.getByRole('button', { name: 'Este mes' })).toBeVisible();
    expect(api.getAnalytics).toHaveBeenLastCalledWith('2026-10-01', '2026-10-01');
  });
});
