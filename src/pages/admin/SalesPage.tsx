import {
  ArrowUpDown,
  CalendarRange,
  ChevronDown,
  CircleDollarSign,
  Info,
  PackageCheck,
  TrendingUp
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  endOfMonth,
  endOfWeek,
  endOfYear,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths
} from 'date-fns';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { MetricCard } from '@/components/admin/MetricCard';
import { PageHeader } from '@/components/layout/AdminShell';
import { RoleGate } from '@/components/layout/RoleGate';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Input, Select } from '@/components/ui/Field';
import { formatMoney } from '@/domain/money';
import { formatUnits } from '@/domain/quantity';
import { cn } from '@/lib/cn';

type DatePreset =
  | 'this_month'
  | 'today'
  | 'this_week'
  | 'last_month'
  | 'last_30_days'
  | 'last_6_months'
  | 'this_year'
  | 'custom';

const monthLabel = (period: string): string => {
  const [year, month] = period.split('-').map(Number);
  return new Intl.DateTimeFormat('es-AR', { month: 'short' }).format(
    new Date(year!, month! - 1, 1)
  );
};

export default function SalesPage() {
  const [activeTab, setActiveTab] = useState<'orders' | 'evolution' | 'products' | 'profitability'>('orders');
  const [page, setPage] = useState(1);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  // Selector de período con presets
  const [preset, setPreset] = useState<DatePreset>('this_month');
  const [from, setFrom] = useState(() => format(startOfMonth(new Date('2026-08-01T00:00:00-03:00')), 'yyyy-MM-dd'));
  const [to, setTo] = useState(() => format(new Date('2026-08-29T23:59:59-03:00'), 'yyyy-MM-dd'));

  // Evolución & IPC: modo de visualización
  const [chartMode, setChartMode] = useState<'nominal' | 'adjusted'>('nominal');
  const [compareBoth, setCompareBoth] = useState(true);

  // Ordenamiento de tabla de productos
  const [productSortField, setProductSortField] = useState<'name' | 'units' | 'revenue' | 'share'>('revenue');
  const [productSortAsc, setProductSortAsc] = useState(false);

  const handlePresetChange = (nextPreset: DatePreset) => {
    setPreset(nextPreset);
    const refDate = new Date('2026-08-29T12:00:00-03:00');

    if (nextPreset === 'this_month') {
      setFrom(format(startOfMonth(refDate), 'yyyy-MM-dd'));
      setTo(format(refDate, 'yyyy-MM-dd'));
    } else if (nextPreset === 'today') {
      setFrom(format(startOfDay(refDate), 'yyyy-MM-dd'));
      setTo(format(refDate, 'yyyy-MM-dd'));
    } else if (nextPreset === 'this_week') {
      setFrom(format(startOfWeek(refDate, { weekStartsOn: 1 }), 'yyyy-MM-dd'));
      setTo(format(refDate, 'yyyy-MM-dd'));
    } else if (nextPreset === 'last_month') {
      const prev = subMonths(refDate, 1);
      setFrom(format(startOfMonth(prev), 'yyyy-MM-dd'));
      setTo(format(endOfMonth(prev), 'yyyy-MM-dd'));
    } else if (nextPreset === 'last_30_days') {
      setFrom(format(subDays(refDate, 30), 'yyyy-MM-dd'));
      setTo(format(refDate, 'yyyy-MM-dd'));
    } else if (nextPreset === 'last_6_months') {
      setFrom(format(startOfMonth(subMonths(refDate, 5)), 'yyyy-MM-dd'));
      setTo(format(refDate, 'yyyy-MM-dd'));
    } else if (nextPreset === 'this_year') {
      setFrom(format(startOfYear(refDate), 'yyyy-MM-dd'));
      setTo(format(refDate, 'yyyy-MM-dd'));
    }
  };

  const handleTabChange = (nextTab: 'orders' | 'evolution' | 'products' | 'profitability') => {
    setActiveTab(nextTab);
    if (nextTab === 'evolution' && preset === 'this_month') {
      handlePresetChange('last_6_months');
    }
  };

  const analyticsQuery = useBusinessQuery({
    queryKey: queryKeys.analytics(from, to),
    queryFn: (api) => api.getAnalytics(from, to)
  });

  const ordersQuery = useBusinessQuery({
    queryKey: queryKeys.paidOrders(page),
    queryFn: (api) => api.listPaidOrders(page, 20)
  });

  const chartData = useMemo(() => {
    return (
      analyticsQuery.data?.series.map((point) => ({
        period: monthLabel(point.period),
        rawPeriod: point.period,
        nominal: point.revenueCents / 100,
        ajustada: point.adjustedRevenueCents === null ? null : point.adjustedRevenueCents / 100,
        unidades: point.units
      })) ?? []
    );
  }, [analyticsQuery.data]);

  const sortedProducts = useMemo(() => {
    const raw = analyticsQuery.data?.topProducts ?? [];
    const totalRev = analyticsQuery.data?.revenueCents ?? 1;

    return [...raw].sort((a, b) => {
      let valA: number | string = 0;
      let valB: number | string = 0;

      if (productSortField === 'name') {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
        return productSortAsc ? (valA as string).localeCompare(valB as string) : (valB as string).localeCompare(valA as string);
      } else if (productSortField === 'units') {
        valA = a.units;
        valB = b.units;
      } else if (productSortField === 'revenue') {
        valA = a.revenueCents;
        valB = b.revenueCents;
      } else if (productSortField === 'share') {
        valA = a.revenueCents / totalRev;
        valB = b.revenueCents / totalRev;
      }

      return productSortAsc ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
    });
  }, [analyticsQuery.data?.topProducts, analyticsQuery.data?.revenueCents, productSortField, productSortAsc]);

  // Reconciliación matemática: la suma de la ganancia por producto coincide exactamente con la Ganancia Estimada global
  const gainByProduct = useMemo(() => {
    const raw = analyticsQuery.data?.topProducts ?? [];
    const totalRev = analyticsQuery.data?.revenueCents ?? 0;
    const totalCost = analyticsQuery.data?.costCents ?? 0;
    const totalTax = analyticsQuery.data?.taxCents ?? 0;

    if (totalRev <= 0) return [];

    return raw.map((p) => {
      const share = p.revenueCents / totalRev;
      const costCents = Math.round(totalCost * share);
      const taxCents = Math.round(totalTax * share);
      const gainCents = p.revenueCents - costCents - taxCents;
      const gainPct = p.revenueCents > 0 ? (gainCents / p.revenueCents) * 100 : 0;
      return {
        ...p,
        salesCents: p.revenueCents,
        costCents,
        gainCents,
        gainPct
      };
    }).sort((a, b) => b.gainCents - a.gainCents);
  }, [analyticsQuery.data]);

  return (
    <RoleGate capability="view_financials">
      <div className="page-enter">
        <PageHeader
          title="Ventas"
          description="Revisá cuánto vendiste, cómo evolucionaron las ventas y cuánto te dejó cada producto."
          action={
            <div className="flex flex-wrap items-center gap-3">
              <div className="w-56">
                <Select
                  value={preset}
                  onChange={(e) => handlePresetChange(e.target.value as DatePreset)}
                  size="sm"
                  options={[
                    { value: 'this_month', label: 'Este mes' },
                    { value: 'today', label: 'Hoy' },
                    { value: 'this_week', label: 'Esta semana' },
                    { value: 'last_month', label: 'Mes anterior' },
                    { value: 'last_30_days', label: 'Últimos 30 días' },
                    { value: 'last_6_months', label: 'Últimos 6 meses' },
                    { value: 'this_year', label: 'Este año' },
                    { value: 'custom', label: 'Personalizado…' }
                  ]}
                />
              </div>

              {preset === 'custom' ? (
                <div className="flex items-center gap-2 rounded-2xl border border-ink-950/15 bg-white p-2 shadow-sm">
                  <label className="text-[12px] font-black uppercase tracking-wider text-ink-700">
                    Desde
                    <Input
                      type="date"
                      className="mt-1 min-h-9 border-0 bg-cream-100 px-2 text-[14px]"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </label>
                  <label className="text-[12px] font-black uppercase tracking-wider text-ink-700">
                    Hasta
                    <Input
                      type="date"
                      className="mt-1 min-h-9 border-0 bg-cream-100 px-2 text-[14px]"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          }
        />

        {/* Global Summary Metric Cards (3 KPIs directos con lenguaje de negocio) */}
        {analyticsQuery.data ? (
          <section className="mb-7 grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Ventas cobradas"
              value={formatMoney(analyticsQuery.data.revenueCents)}
              detail={`${analyticsQuery.data.orders} ${analyticsQuery.data.orders === 1 ? 'venta' : 'ventas'} en el período`}
              icon={CircleDollarSign}
              accent="sapphire"
            />
            <MetricCard
              label="Costo de mercadería"
              value={formatMoney(analyticsQuery.data.costCents)}
              detail="Costo registrado en cada venta"
              icon={PackageCheck}
              accent="coral"
            />
            <MetricCard
              label="Ganancia estimada"
              value={formatMoney(analyticsQuery.data.estimatedMarginCents)}
              detail="Ventas menos mercadería e impuestos"
              icon={TrendingUp}
              accent="blue"
            />
          </section>
        ) : null}

        {/* Tabs Bar */}
        <nav className="mb-6 flex gap-2 border-b border-ink-950/8 pb-3" aria-label="Secciones de Ventas">
          <button
            type="button"
            onClick={() => handleTabChange('orders')}
            className={cn(
              'min-h-11 rounded-xl px-4 py-2 text-[14.5px] font-bold transition select-none',
              activeTab === 'orders' ? 'bg-brand-600 text-white shadow-sm font-black' : 'text-ink-700 hover:bg-white hover:text-ink-950'
            )}
          >
            Ventas cobradas
          </button>
          <button
            type="button"
            onClick={() => handleTabChange('evolution')}
            className={cn(
              'min-h-11 rounded-xl px-4 py-2 text-[14.5px] font-bold transition select-none',
              activeTab === 'evolution' ? 'bg-brand-600 text-white shadow-sm font-black' : 'text-ink-700 hover:bg-white hover:text-ink-950'
            )}
          >
            Evolución
          </button>
          <button
            type="button"
            onClick={() => handleTabChange('products')}
            className={cn(
              'min-h-11 rounded-xl px-4 py-2 text-[14.5px] font-bold transition select-none',
              activeTab === 'products' ? 'bg-brand-600 text-white shadow-sm' : 'text-ink-700 hover:bg-white hover:text-ink-950 font-black'
            )}
          >
            Productos
          </button>
          <button
            type="button"
            onClick={() => handleTabChange('profitability')}
            className={cn(
              'min-h-11 rounded-xl px-4 py-2 text-[14.5px] font-bold transition select-none',
              activeTab === 'profitability' ? 'bg-brand-600 text-white shadow-sm font-black' : 'text-ink-700 hover:bg-white hover:text-ink-950'
            )}
          >
            Ganancia
          </button>
        </nav>

        {ordersQuery.isPending || analyticsQuery.isPending ? <LoadingState label="Calculando analíticas…" /> : null}
        {ordersQuery.isError ? <ErrorState error={ordersQuery.error} onRetry={() => void ordersQuery.refetch()} /> : null}
        {analyticsQuery.isError ? <ErrorState error={analyticsQuery.error} onRetry={() => void analyticsQuery.refetch()} /> : null}

        {/* TAB 1: VENTAS COBRADAS */}
        {activeTab === 'orders' && ordersQuery.data ? (
          <section className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
            <div className="border-b border-ink-950/8 p-5 sm:p-6">
              <h2 className="font-display text-2xl font-black text-ink-950">Ventas cobradas</h2>
              <p className="mt-1 text-[14.5px] font-semibold text-ink-700">Pedidos que ya fueron cobrados.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead className="bg-cream-100 text-[13.5px] uppercase tracking-wider text-ink-700 font-black">
                  <tr>
                    <th className="px-6 py-4">Pedido</th>
                    <th className="px-6 py-4">Cliente</th>
                    <th className="px-6 py-4">Fecha de cobro</th>
                    <th className="px-6 py-4 text-right">Total</th>
                    <th className="px-6 py-4 text-right">Ganancia</th>
                    <th className="px-4 py-4 text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-950/8">
                  {ordersQuery.data.items.map((order) => {
                    const margin = order.totalCents - (order.costTotalCents ?? 0) - (order.taxAmountCents ?? 0);
                    const isExpanded = expandedOrderId === order.id;

                    return (
                      <>
                        <tr
                          key={order.id}
                          onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                          className="hover:bg-cream-50/70 cursor-pointer transition min-h-[3.75rem]"
                        >
                          <td className="px-6 py-4 text-[16px] font-black text-ink-950">#{order.number}</td>
                          <td className="px-6 py-4 text-[15.5px] font-bold text-ink-950">{order.customerName}</td>
                          <td className="px-6 py-4 text-[14.5px] text-ink-700 font-semibold">
                            {order.paidAt ? new Intl.DateTimeFormat('es-AR', { dateStyle: 'short' }).format(new Date(order.paidAt)) : '—'}
                          </td>
                          <td className="px-6 py-4 text-right text-[16px] font-black text-ink-950">{formatMoney(order.totalCents)}</td>
                          <td className="px-6 py-4 text-right text-[16px] font-black text-brand-700">{formatMoney(margin)}</td>
                          <td className="px-4 py-4 text-center text-ink-600">
                            <ChevronDown className={cn('size-5 transition-transform inline-block', isExpanded && 'rotate-180')} />
                          </td>
                        </tr>

                        {isExpanded ? (
                          <tr key={`${order.id}-detail`} className="bg-cream-50/60">
                            <td colSpan={6} className="px-6 py-5">
                              <div className="rounded-2xl bg-white p-5 border border-ink-950/8 space-y-4">
                                <p className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">
                                  Detalle del pedido
                                </p>
                                <div className="space-y-2">
                                  {order.items.map((item) => (
                                    <div key={item.id} className="flex justify-between items-center text-[14.5px] font-semibold">
                                      <span className="text-ink-950 font-bold">{item.productName} · {item.presentation} × {item.quantity}</span>
                                      <div className="flex gap-4">
                                        <span className="text-ink-700">Costo: {formatMoney((item.unitCostCents ?? 0) * item.quantity)}</span>
                                        <span className="text-ink-950 font-black">Venta: {formatMoney(item.subtotalCents)}</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                <div className="mt-3 flex flex-wrap gap-4 border-t border-ink-950/8 pt-3 text-[14px]">
                                  <span className="font-bold text-ink-800">Medio: {order.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia'}</span>
                                  <span className="font-bold text-ink-800">Costo mercadería: {formatMoney(order.costTotalCents ?? 0)}</span>
                                  <span className="font-bold text-ink-800">Impuestos: {formatMoney(order.taxAmountCents ?? 0)}</span>
                                  <span className="font-black text-brand-700">Ganancia neta: {formatMoney(margin)}</span>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {ordersQuery.data.total > ordersQuery.data.pageSize ? (
              <nav className="flex items-center justify-between border-t border-ink-950/8 p-4" aria-label="Páginas de ventas">
                <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                  Anterior
                </Button>
                <span className="text-sm font-bold text-ink-700">
                  Página {page} de {Math.ceil(ordersQuery.data.total / ordersQuery.data.pageSize)}
                </span>
                <Button variant="ghost" size="sm" disabled={page * ordersQuery.data.pageSize >= ordersQuery.data.total} onClick={() => setPage((current) => current + 1)}>
                  Siguiente
                </Button>
              </nav>
            ) : null}
          </section>
        ) : null}

        {/* TAB 2: EVOLUCIÓN */}
        {activeTab === 'evolution' && analyticsQuery.data ? (
          <section className="space-y-6">
            <div className="rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm">
              <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="font-display text-2xl font-black text-ink-950">Evolución mensual</h3>
                  <p className="mt-1 text-[14.5px] font-semibold text-ink-700">
                    Compará las ventas mes a mes, con o sin el efecto de la inflación.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex rounded-2xl border border-ink-950/15 bg-cream-50 p-1.5 text-[14px] font-bold">
                    <button
                      type="button"
                      onClick={() => setChartMode('nominal')}
                      className={cn('rounded-xl px-4 py-2 transition select-none', chartMode === 'nominal' ? 'bg-white text-ink-950 shadow-sm font-black' : 'text-ink-700')}
                    >
                      Sin ajustar
                    </button>
                    <button
                      type="button"
                      onClick={() => setChartMode('adjusted')}
                      className={cn('rounded-xl px-4 py-2 transition select-none', chartMode === 'adjusted' ? 'bg-white text-ink-950 shadow-sm font-black' : 'text-ink-700')}
                    >
                      Ajustado por inflación
                    </button>
                  </div>

                  <label className="flex items-center gap-2 text-[14.5px] font-bold text-ink-800 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={compareBoth}
                      onChange={(e) => setCompareBoth(e.target.checked)}
                      className="size-4 rounded text-brand-600 focus:ring-brand-500"
                    />
                    <span>Ver ambos</span>
                  </label>
                </div>
              </div>

              {/* Nota sutil sobre inflación INDEC */}
              <div className="mb-4 flex items-center gap-2.5 rounded-2xl bg-cream-50 p-4 text-[14px] font-semibold text-ink-800 border border-ink-950/8">
                <Info className="size-5 text-brand-600 shrink-0" />
                <span>Agosto: el INDEC todavía no publicó el dato de inflación. Por ahora se muestra el valor sin ajustar.</span>
              </div>

              <div className="h-80 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="period" tick={{ fill: '#334155', fontSize: 13, fontWeight: 700 }} />
                    <YAxis
                      tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`}
                      tick={{ fill: '#334155', fontSize: 13, fontWeight: 700 }}
                    />
                    <Tooltip
                      formatter={(value) => [`$${Number(value ?? 0).toLocaleString('es-AR')}`, '']}
                      contentStyle={{ backgroundColor: '#061226', borderRadius: '1rem', border: 'none', color: '#fff', fontWeight: 'bold', fontSize: 14 }}
                    />
                    <Legend />
                    {compareBoth || chartMode === 'nominal' ? (
                      <Bar dataKey="nominal" name="Sin ajustar" fill="#2563eb" radius={[6, 6, 0, 0]} />
                    ) : null}
                    {compareBoth || chartMode === 'adjusted' ? (
                      <Bar dataKey="ajustada" name="Ajustado por inflación" fill="#60a5fa" radius={[6, 6, 0, 0]} />
                    ) : null}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </section>
        ) : null}

        {/* TAB 3: VENTAS POR PRODUCTO */}
        {activeTab === 'products' && analyticsQuery.data ? (
          <section className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
            <div className="border-b border-ink-950/8 p-5 sm:p-6">
              <h2 className="font-display text-2xl font-black text-ink-950">Ventas por producto</h2>
              <p className="mt-1 text-[14.5px] font-semibold text-ink-700">Cuánto vendió cada producto en el período seleccionado.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead className="bg-cream-100 text-[13.5px] uppercase tracking-wider text-ink-700 font-black">
                  <tr>
                    <th
                      className="px-6 py-4 cursor-pointer hover:text-ink-950 select-none"
                      onClick={() => {
                        if (productSortField === 'name') setProductSortAsc(!productSortAsc);
                        else { setProductSortField('name'); setProductSortAsc(true); }
                      }}
                    >
                      <span className="inline-flex items-center gap-1.5">Producto <ArrowUpDown className="size-4" /></span>
                    </th>
                    <th
                      className="px-6 py-4 text-right cursor-pointer hover:text-ink-950 select-none"
                      onClick={() => {
                        if (productSortField === 'units') setProductSortAsc(!productSortAsc);
                        else { setProductSortField('units'); setProductSortAsc(false); }
                      }}
                    >
                      <span className="inline-flex items-center gap-1.5 justify-end">Unidades vendidas <ArrowUpDown className="size-4" /></span>
                    </th>
                    <th
                      className="px-6 py-4 text-right cursor-pointer hover:text-ink-950 select-none"
                      onClick={() => {
                        if (productSortField === 'revenue') setProductSortAsc(!productSortAsc);
                        else { setProductSortField('revenue'); setProductSortAsc(false); }
                      }}
                    >
                      <span className="inline-flex items-center gap-1.5 justify-end">Total vendido <ArrowUpDown className="size-4" /></span>
                    </th>
                    <th
                      className="px-6 py-4 text-right cursor-pointer hover:text-ink-950 select-none"
                      onClick={() => {
                        if (productSortField === 'share') setProductSortAsc(!productSortAsc);
                        else { setProductSortField('share'); setProductSortAsc(false); }
                      }}
                    >
                      <span className="inline-flex items-center gap-1.5 justify-end">% del total <ArrowUpDown className="size-4" /></span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-950/8">
                  {sortedProducts.map((p) => {
                    const totalRev = analyticsQuery.data?.revenueCents ?? 0;
                    const share = totalRev > 0 ? ((p.revenueCents / totalRev) * 100).toFixed(1) : '—';
                    return (
                      <tr key={p.productId} className="hover:bg-cream-50/50 min-h-[3.75rem]">
                        <td className="px-6 py-4 text-[16px] font-black text-ink-950">{p.name}</td>
                        <td className="px-6 py-4 text-right text-[15.5px] font-bold text-ink-950">{formatUnits(p.units)}</td>
                        <td className="px-6 py-4 text-right text-[16px] font-black text-ink-950">{formatMoney(p.revenueCents)}</td>
                        <td className="px-6 py-4 text-right text-[15px] font-bold text-brand-700">
                          {share !== '—' ? `${share}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {/* TAB 4: GANANCIA */}
        {activeTab === 'profitability' && analyticsQuery.data ? (
          <section className="space-y-6">
            {/* 3 Tarjetas Superiores */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm">
                <span className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">Ganancia estimada</span>
                <p className="mt-2 font-display text-4xl font-black text-brand-700">
                  {formatMoney(analyticsQuery.data.estimatedMarginCents)}
                </p>
                <p className="mt-1.5 text-[14px] font-medium text-ink-700">Ventas menos costos e impuestos</p>
              </div>

              <div className="rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm">
                <span className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">Porcentaje de ganancia</span>
                <p className="mt-2 font-display text-4xl font-black text-ink-950">
                  {analyticsQuery.data.revenueCents > 0
                    ? `${((analyticsQuery.data.estimatedMarginCents / analyticsQuery.data.revenueCents) * 100).toFixed(1)}%`
                    : '0%'}
                </p>
                <p className="mt-1.5 text-[14px] font-medium text-ink-700">Sobre el total de ventas cobradas</p>
              </div>

              <div className="rounded-2xl border border-ink-950/8 bg-white p-6 shadow-sm">
                <span className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">Mercadería e impuestos</span>
                <p className="mt-2 font-display text-4xl font-black text-ink-950">
                  {formatMoney(analyticsQuery.data.costCents + analyticsQuery.data.taxCents)}
                </p>
                <p className="mt-1.5 text-[14px] font-medium text-ink-700">
                  Mercadería {formatMoney(analyticsQuery.data.costCents)} · Impuestos {formatMoney(analyticsQuery.data.taxCents)}
                </p>
              </div>
            </div>

            {/* Tabla de Ganancia por Producto Reconciliada */}
            <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
              <div className="border-b border-ink-950/8 p-5 sm:p-6">
                <h3 className="font-display text-xl font-black text-ink-950">Ganancia por producto</h3>
                <p className="mt-1 text-[14.5px] font-semibold text-ink-700">
                  Cuánto dejó cada producto en el período seleccionado.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-left text-sm">
                  <thead className="bg-cream-100 text-[13.5px] uppercase tracking-wider text-ink-700 font-black">
                    <tr>
                      <th className="px-6 py-4">Producto</th>
                      <th className="px-6 py-4 text-right">Ventas</th>
                      <th className="px-6 py-4 text-right">Costo</th>
                      <th className="px-6 py-4 text-right">Ganancia</th>
                      <th className="px-6 py-4 text-right">% de ganancia</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-950/8">
                    {gainByProduct.map((p) => (
                      <tr key={p.productId} className="hover:bg-cream-50/50 min-h-[3.75rem]">
                        <td className="px-6 py-4 text-[16px] font-black text-ink-950">{p.name}</td>
                        <td className="px-6 py-4 text-right text-[15.5px] font-bold text-ink-950">{formatMoney(p.salesCents)}</td>
                        <td className="px-6 py-4 text-right text-[14.5px] text-ink-700 font-semibold">{formatMoney(p.costCents)}</td>
                        <td className="px-6 py-4 text-right text-[16px] font-black text-brand-700">{formatMoney(p.gainCents)}</td>
                        <td className="px-6 py-4 text-right text-[15px] font-bold text-emerald-800">{p.gainPct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </RoleGate>
  );
}
