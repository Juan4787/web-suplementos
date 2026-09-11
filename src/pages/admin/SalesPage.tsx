import {
  ArrowUpDown,
  CalendarRange,
  ChevronDown,
  CircleDollarSign,
  Filter,
  Gift,
  Info,
  PackageCheck,
  Tag,
  TrendingUp
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
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
import { DatePicker, Input, Select } from '@/components/ui/Field';
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
  const [showGiftDetails, setShowGiftDetails] = useState(false);

  // Selector de período con presets
  const [preset, setPreset] = useState<DatePreset>('this_month');
  const [from, setFrom] = useState(() => format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [to, setTo] = useState(() => format(new Date(), 'yyyy-MM-dd'));

  // Ordenamiento de tabla de productos
  const [productSortField, setProductSortField] = useState<'name' | 'units' | 'revenue' | 'share'>('revenue');
  const [productSortAsc, setProductSortAsc] = useState(false);

  const handlePresetChange = (nextPreset: DatePreset) => {
    setPreset(nextPreset);
    const refDate = new Date();

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

  useEffect(() => { setPage(1); setExpandedOrderId(null); }, [from, to]);

  const analyticsQuery = useBusinessQuery({
    queryKey: queryKeys.analytics(from, to),
    queryFn: (api) => api.getAnalytics(from, to)
  });

  const ordersQuery = useBusinessQuery({
    queryKey: [...queryKeys.paidOrders(page), from, to],
    queryFn: (api) => api.listPaidOrders(page, 20, from, to)
  });

  const chartData = useMemo(() => {
    return (
      (analyticsQuery.data?.series ?? []).map((point) => ({
        period: monthLabel(point.period),
        rawPeriod: point.period,
        nominal: point.revenueCents / 100,
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

  // Ganancia real por producto: consume el margen snapshot real de cada producto calculado por la analítica
  const gainByProduct = useMemo(() => {
    const raw = analyticsQuery.data?.topProducts ?? [];
    if (raw.length === 0) return [];

    return raw.map((p) => {
      const gainCents = p.estimatedMarginCents;
      const costCents = p.costCents ?? Math.max(0, p.revenueCents - p.estimatedMarginCents);
      const gainPct = p.revenueCents > 0 ? (gainCents / p.revenueCents) * 100 : 0;
      return {
        ...p,
        salesCents: p.revenueCents,
        costCents,
        gainCents,
        gainPct
      };
    }).sort((a, b) => b.gainCents - a.gainCents);
  }, [analyticsQuery.data?.topProducts]);

  return (
    <RoleGate capability="view_financials">
      <div className="page-enter">
        <PageHeader
          title="Ventas"
          description="Revisá cuánto vendiste, cómo evolucionaron las ventas y cuánto te dejó cada producto."
          action={
            <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3 w-full sm:w-auto">
              <div className="w-full sm:w-56">
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
                <div className="grid grid-cols-2 sm:flex sm:flex-row items-center gap-2 rounded-2xl border border-ink-950/15 bg-white p-2.5 shadow-sm w-full sm:w-auto">
                  <div className="w-full sm:w-44">
                    <span className="text-[11px] font-black uppercase tracking-wider text-ink-600 block px-1">Desde</span>
                    <DatePicker
                      className="mt-0.5"
                      value={from}
                      onChange={(val) => setFrom(val)}
                      placeholder="Desde…"
                      showShortcuts={false}
                      align="left"
                    />
                  </div>
                  <div className="w-full sm:w-44">
                    <span className="text-[11px] font-black uppercase tracking-wider text-ink-600 block px-1">Hasta</span>
                    <DatePicker
                      className="mt-0.5"
                      value={to}
                      onChange={(val) => setTo(val)}
                      placeholder="Hasta…"
                      showShortcuts={false}
                      align="right"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          }
        />

        {/* Global Summary Metric Cards (3 KPIs directos con lenguaje de negocio) */}
        {analyticsQuery.data ? (
          <>
            <section className="mb-4 grid gap-4 sm:grid-cols-3">
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
                detail={
                  analyticsQuery.data.giftOrders && analyticsQuery.data.giftOrders > 0
                    ? `Incluye -${formatMoney(analyticsQuery.data.giftCostCents ?? 0)} por ${analyticsQuery.data.giftOrders} ${analyticsQuery.data.giftOrders === 1 ? 'regalo' : 'regalos'}`
                    : analyticsQuery.data.costSaleOrders && analyticsQuery.data.costSaleOrders > 0
                      ? `Incluye ${analyticsQuery.data.costSaleOrders} ${analyticsQuery.data.costSaleOrders === 1 ? 'venta al costo' : 'ventas al costo'} (margen neutral $0)`
                      : 'Ventas menos mercadería e impuestos'
                }
                icon={TrendingUp}
                accent="blue"
              />
            </section>

            {analyticsQuery.data.giftOrders && analyticsQuery.data.giftOrders > 0 ? (
              <div className="mb-6 rounded-2xl bg-purple-50/80 border border-purple-200/90 p-4 text-sm text-purple-950 shadow-sm transition-all">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-bold text-[14px]">
                    <Gift className="size-4 text-purple-600 shrink-0" />
                    <span>
                      Aclaración comercial: Este período incluye <strong>{analyticsQuery.data.giftOrders} {analyticsQuery.data.giftOrders === 1 ? 'pedido regalado' : 'pedidos regalados'}</strong> (costo asumido: <span className="font-black text-rose-700">-{formatMoney(analyticsQuery.data.giftCostCents ?? 0)}</span>).
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowGiftDetails((prev) => !prev)}
                    className="inline-flex items-center gap-1 text-xs font-black text-purple-800 underline hover:text-purple-950 cursor-pointer select-none"
                  >
                    {showGiftDetails ? 'Ocultar desglose' : 'Ver detalle contable'}
                    <ChevronDown className={cn('size-3.5 transition-transform', showGiftDetails && 'rotate-180')} />
                  </button>
                </div>
                {showGiftDetails ? (
                  <div className="mt-3 pt-3 border-t border-purple-200 text-xs space-y-1.5 text-purple-900">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 py-1">
                      <div className="rounded-xl bg-white/90 p-2.5 border border-purple-100">
                        <span className="block text-[11px] font-bold text-ink-600 uppercase">Margen bruto ventas</span>
                        <span className="font-black text-sm text-ink-950">
                          {formatMoney(
                            analyticsQuery.data.revenueCents -
                            (analyticsQuery.data.costCents - (analyticsQuery.data.giftCostCents ?? 0)) -
                            analyticsQuery.data.taxCents
                          )}
                        </span>
                      </div>
                      <div className="rounded-xl bg-rose-50/90 p-2.5 border border-rose-200">
                        <span className="block text-[11px] font-bold text-rose-700 uppercase">Costo mercadería regalada</span>
                        <span className="font-black text-sm text-rose-700">
                          -{formatMoney(analyticsQuery.data.giftCostCents ?? 0)}
                        </span>
                      </div>
                      <div className="rounded-xl bg-purple-100/80 p-2.5 border border-purple-200">
                        <span className="block text-[11px] font-bold text-purple-800 uppercase">Ganancia neta real</span>
                        <span className="font-black text-sm text-purple-950">
                          {formatMoney(analyticsQuery.data.estimatedMarginCents)}
                        </span>
                      </div>
                    </div>
                    <p className="text-[12px] text-purple-800/90 pt-1">
                      💡 La mercadería regalada no suma facturación ($0 cobrado) y se descuenta su costo de reposición para reflejar la ganancia neta real del negocio con exactitud matemática.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {/* Tabs Bar */}
        <nav className="mb-6 flex flex-wrap gap-2 border-b border-ink-950/8 pb-3" aria-label="Secciones de Ventas">
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
              <p className="mt-1 text-[14.5px] font-semibold text-ink-700">Pedidos cobrados dentro del período seleccionado.</p>
            </div>
            {(ordersQuery.data.items?.length ?? 0) === 0 ? <p className="p-6 text-sm text-ink-700">No hay ventas cobradas en este período. Elegí otro rango de fechas para consultar ventas anteriores.</p> : null}
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
                  {(ordersQuery.data.items ?? []).map((order) => {
                    const isGift = order.paymentState === 'gifted' || order.paymentMethod === 'gift';
                    const isCost = order.isCostSale || order.saleType === 'cost';
                    const margin = isCost ? 0 : order.totalCents - (order.costTotalCents ?? 0) - (order.taxAmountCents ?? 0);
                    const isExpanded = expandedOrderId === order.id;

                    return (
                      <Fragment key={order.id}>
                        <tr
                          key={order.id}
                          onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                          className="hover:bg-cream-50/70 cursor-pointer transition min-h-[3.75rem]"
                        >
                          <td className="px-6 py-4 text-[16px] font-black text-ink-950 whitespace-nowrap">
                            #{order.number}
                            {isGift ? (
                              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-purple-50 border border-purple-200 px-2 py-0.5 text-[11px] font-black text-purple-700 select-none">
                                <Gift className="size-3 text-purple-600" /> Regalo
                              </span>
                            ) : isCost ? (
                              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[11px] font-black text-amber-800 select-none">
                                <Tag className="size-3 text-amber-600" /> Al costo
                              </span>
                            ) : null}
                          </td>
                          <td className="px-6 py-4 text-[15.5px] font-bold text-ink-950">{order.customerName}</td>
                          <td className="px-6 py-4 text-[14.5px] text-ink-700 font-semibold">
                            {order.paidAt ? new Intl.DateTimeFormat('es-AR', { dateStyle: 'short' }).format(new Date(order.paidAt)) : '—'}
                          </td>
                          <td className="px-6 py-4 text-right text-[16px] font-black text-ink-950">
                            {isGift ? (
                              <span className="text-ink-400 font-bold">$ 0</span>
                            ) : (
                              formatMoney(order.totalCents)
                            )}
                          </td>
                          <td
                            className={cn(
                              'px-6 py-4 text-right text-[16px] font-black',
                              margin < 0 ? 'text-rose-600 font-black' : isCost ? 'text-ink-600 font-bold' : 'text-brand-700'
                            )}
                          >
                            {isCost ? '$ 0' : formatMoney(margin)}
                          </td>
                          <td className="px-4 py-4 text-center text-ink-600">
                            <ChevronDown className={cn('size-5 transition-transform inline-block', isExpanded && 'rotate-180')} />
                          </td>
                        </tr>

                        {isExpanded ? (
                          <tr key={`${order.id}-detail`} className="bg-cream-50/60">
                            <td colSpan={6} className="px-6 py-5">
                              <div className="rounded-2xl bg-white p-5 border border-ink-950/8 space-y-4">
                                <div className="flex items-center justify-between">
                                  <p className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">
                                    Detalle del pedido {isGift ? '(Cortesía / Regalo)' : isCost ? '(Venta al costo)' : ''}
                                  </p>
                                  {isGift ? (
                                    <span className="text-xs font-bold text-purple-700 bg-purple-50 border border-purple-200 rounded-full px-2.5 py-0.5">
                                      🎁 Pedido regalado · Cobrado $ 0
                                    </span>
                                  ) : isCost ? (
                                    <span className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2.5 py-0.5">
                                      🏷️ Venta al costo · Margen comercial neutral ($ 0)
                                    </span>
                                  ) : null}
                                </div>
                                <div className="space-y-2">
                                  {(order.items ?? []).map((item) => (
                                    <div key={item.id} className="flex justify-between items-center text-[14.5px] font-semibold">
                                      <span className="text-ink-950 font-bold">{item.productName} · {item.presentation} × {item.quantity}</span>
                                      <div className="flex gap-4">
                                        <span className="text-ink-700">Costo: {formatMoney(item.costTotalCents ?? ((item.unitCostCents ?? 0) * item.quantity))}</span>
                                        <span className="text-ink-950 font-black">
                                          {isGift ? '$ 0 (Regalo)' : isCost ? `Costo: ${formatMoney(item.subtotalCents)}` : `Venta: ${formatMoney(item.subtotalCents)}`}
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                                <div className="mt-3 flex flex-wrap gap-4 border-t border-ink-950/8 pt-3 text-[14px]">
                                  <span className="font-bold text-ink-800">
                                    Medio: {isGift ? '🎁 Regalo / Cortesía ($ 0 cobrado)' : isCost ? `🏷️ Venta al costo (${order.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia'})` : order.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia'}
                                  </span>
                                  <span className="font-bold text-ink-800">Costo mercadería: {formatMoney(order.costTotalCents ?? 0)}</span>
                                  {!isGift && !isCost ? (
                                    <span className="font-bold text-ink-800">Impuestos: {formatMoney(order.taxAmountCents ?? 0)}</span>
                                  ) : null}
                                  <span
                                    className={cn(
                                      'font-black',
                                      margin < 0 ? 'text-rose-600' : isCost ? 'text-ink-700' : 'text-brand-700'
                                    )}
                                  >
                                    {isGift
                                      ? `Pérdida neta por regalo / cortesía: ${formatMoney(margin)}`
                                      : isCost
                                        ? `Margen comercial: $ 0 (Venta al costo · Ganancia neutral)`
                                        : `Margen después de mercadería e impuestos: ${formatMoney(margin)}`}
                                  </span>
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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
              <div className="mb-6">
                <h3 className="font-display text-2xl font-black text-ink-950">Evolución mensual</h3>
                <p className="mt-1 text-[14.5px] font-semibold text-ink-700">
                  Compará la evolución de las ventas mes a mes.
                </p>
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
                      formatter={(value) => [`$${Number(value ?? 0).toLocaleString('es-AR')}`, 'Ventas']}
                      contentStyle={{ backgroundColor: '#061226', borderRadius: '1rem', border: 'none', color: '#fff', fontWeight: 'bold', fontSize: 14 }}
                    />
                    <Legend />
                    <Bar dataKey="nominal" name="Ventas" fill="#2563eb" radius={[6, 6, 0, 0]} />
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
                <p className="mt-1.5 text-[14px] font-medium text-ink-700">
                  {analyticsQuery.data.giftOrders && analyticsQuery.data.giftOrders > 0
                    ? `Ventas menos costos. Incluye -${formatMoney(analyticsQuery.data.giftCostCents ?? 0)} por ${analyticsQuery.data.giftOrders} ${analyticsQuery.data.giftOrders === 1 ? 'regalo' : 'regalos'}`
                    : 'Ventas menos costos e impuestos'}
                </p>
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

            {analyticsQuery.data.giftOrders && analyticsQuery.data.giftOrders > 0 ? (
              <div className="rounded-2xl border border-purple-200 bg-purple-50/75 p-5 text-purple-950 shadow-sm">
                <div className="flex items-center gap-2 mb-2 font-display text-base font-black text-purple-900">
                  <Gift className="size-5 text-purple-700 shrink-0" />
                  <span>Desglose contable de pedidos de regalo / cortesía</span>
                </div>
                <p className="text-sm font-semibold text-purple-900 mb-3">
                  Se entregaron <strong>{analyticsQuery.data.giftOrders} {analyticsQuery.data.giftOrders === 1 ? 'pedido de cortesía' : 'pedidos de cortesía'}</strong> con un costo asumido de <span className="text-rose-700 font-black">-{formatMoney(analyticsQuery.data.giftCostCents ?? 0)}</span>.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div className="rounded-xl bg-white/90 p-3 border border-purple-100 shadow-xs">
                    <span className="text-xs font-bold text-ink-600 block uppercase">Margen comercial de ventas</span>
                    <span className="font-black text-ink-950 text-base">
                      {formatMoney(
                        analyticsQuery.data.revenueCents -
                        (analyticsQuery.data.costCents - (analyticsQuery.data.giftCostCents ?? 0)) -
                        analyticsQuery.data.taxCents
                      )}
                    </span>
                  </div>
                  <div className="rounded-xl bg-rose-50/90 p-3 border border-rose-200 shadow-xs">
                    <span className="text-xs font-bold text-rose-700 block uppercase">Costo absorbido (Regalos)</span>
                    <span className="font-black text-rose-700 text-base">
                      -{formatMoney(analyticsQuery.data.giftCostCents ?? 0)}
                    </span>
                  </div>
                  <div className="rounded-xl bg-purple-100/80 p-3 border border-purple-200 shadow-xs">
                    <span className="text-xs font-bold text-purple-800 block uppercase">Ganancia neta real final</span>
                    <span className="font-black text-purple-950 text-base">
                      {formatMoney(analyticsQuery.data.estimatedMarginCents)}
                    </span>
                  </div>
                </div>
                <p className="text-[12px] text-purple-800/90 pt-3">
                  ℹ️ Este desglose asegura que la ganancia neta no esté sobreestimada ni se mezclen ventas comerciales cobradas con atenciones o regalos familiares.
                </p>
              </div>
            ) : null}

            {analyticsQuery.data.costSaleOrders && analyticsQuery.data.costSaleOrders > 0 ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50/75 p-4 text-amber-950 shadow-sm flex items-center gap-3">
                <Tag className="size-5 text-amber-700 shrink-0" />
                <div className="text-sm font-semibold text-amber-900">
                  <span>Se registraron <strong>{analyticsQuery.data.costSaleOrders} {analyticsQuery.data.costSaleOrders === 1 ? 'venta al costo' : 'ventas al costo'}</strong> ({formatMoney(analyticsQuery.data.costSaleRevenueCents ?? 0)} facturados al costo de reposición).</span>
                  <span className="block text-xs text-amber-800 mt-0.5">Su aporte a la ganancia es neutral ($ 0), ya que el cobro iguala exactamente el costo de compra sin generar ganancia ni pérdida.</span>
                </div>
              </div>
            ) : null}

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
