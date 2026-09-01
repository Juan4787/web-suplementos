import {
  BarChart3,
  CalendarRange,
  CircleDollarSign,
  Info,
  PackageCheck,
  ReceiptText,
  Ticket,
  TrendingUp
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { format, startOfMonth, subMonths } from 'date-fns';
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
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { DatePicker, Input } from '@/components/ui/Field';
import { StatusChip } from '@/components/ui/StatusChip';
import { formatMoney } from '@/domain/money';
import { formatUnits } from '@/domain/quantity';
import { cn } from '@/lib/cn';

const monthLabel = (period: string): string => {
  const [year, month] = period.split('-').map(Number);
  return new Intl.DateTimeFormat('es-AR', { month: 'short' }).format(
    new Date(year!, month! - 1, 1)
  );
};

export default function AnalyticsPage() {
  const [activeTab, setActiveTab] = useState<'evolution' | 'products' | 'profitability'>('evolution');
  const [chartMode, setChartMode] = useState<'both' | 'nominal' | 'adjusted'>('both');
  const [from, setFrom] = useState(() =>
    format(startOfMonth(subMonths(new Date(), 2)), 'yyyy-MM-dd')
  );
  const [to, setTo] = useState(() => format(new Date(), 'yyyy-MM-dd'));

  const analyticsQuery = useBusinessQuery({
    queryKey: queryKeys.analytics(from, to),
    queryFn: (api) => api.getAnalytics(from, to)
  });

  const chartData = useMemo(() => {
    return (
      analyticsQuery.data?.series.map((point) => ({
        period: monthLabel(point.period),
        nominal: point.revenueCents / 100,
        ajustada:
          point.adjustedRevenueCents === null ? null : point.adjustedRevenueCents / 100,
        unidades: point.units
      })) ?? []
    );
  }, [analyticsQuery.data]);

  return (
    <RoleGate capability="view_financials">
      <div className="page-enter">
        <PageHeader
          title="Analíticas comerciales"
          description="Evolución en pesos, compras ajustadas por inflación y volumen de unidades para analizar el crecimiento real de tu negocio."
          action={
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 rounded-2xl bg-white p-2 shadow-card">
              <div className="w-36">
                <span className="text-[10px] font-black uppercase tracking-wider text-ink-600 block px-1">Desde</span>
                <DatePicker
                  className="mt-0.5"
                  value={from}
                  onChange={(val) => setFrom(val)}
                  placeholder="Desde…"
                />
              </div>
              <div className="w-36">
                <span className="text-[10px] font-black uppercase tracking-wider text-ink-600 block px-1">Hasta</span>
                <DatePicker
                  className="mt-0.5"
                  value={to}
                  onChange={(val) => setTo(val)}
                  placeholder="Hasta…"
                />
              </div>
            </div>
          }
        />

        {analyticsQuery.isPending ? <LoadingState label="Calculando analíticas del período…" /> : null}
        {analyticsQuery.isError ? (
          <ErrorState error={analyticsQuery.error} onRetry={() => void analyticsQuery.refetch()} />
        ) : null}

        {analyticsQuery.data ? (
          <>
            {/* Cifras Clave Superiores */}
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Facturación cobrada"
                value={formatMoney(analyticsQuery.data.revenueCents)}
                detail={`${analyticsQuery.data.orders} operaciones pagadas`}
                icon={CircleDollarSign}
                accent="sapphire"
              />
              <MetricCard
                label="Unidades vendidas"
                value={String(analyticsQuery.data.units)}
                detail="Total de unidades vendidas"
                icon={PackageCheck}
                accent="coral"
              />
              <MetricCard
                label="Ticket promedio"
                value={formatMoney(analyticsQuery.data.averageTicketCents)}
                detail="Por venta cobrada"
                icon={Ticket}
                accent="sun"
              />
              <MetricCard
                label="Margen estimado"
                value={formatMoney(analyticsQuery.data.estimatedMarginCents)}
                detail="Tras mercadería e impuestos"
                icon={ReceiptText}
                accent="blue"
              />
            </section>

            {/* Pestañas de Navegación Comercial */}
            <div className="mt-7 flex gap-2 border-b border-ink-950/8 pb-3">
              <button
                type="button"
                className={cn(
                  'rounded-full px-4 py-2 text-xs font-black transition',
                  activeTab === 'evolution'
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'bg-white text-ink-700 hover:bg-cream-100'
                )}
                onClick={() => setActiveTab('evolution')}
              >
                Evolución mensual
              </button>
              <button
                type="button"
                className={cn(
                  'rounded-full px-4 py-2 text-xs font-black transition',
                  activeTab === 'products'
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'bg-white text-ink-700 hover:bg-cream-100'
                )}
                onClick={() => setActiveTab('products')}
              >
                Ranking de productos
              </button>
              <button
                type="button"
                className={cn(
                  'rounded-full px-4 py-2 text-xs font-black transition',
                  activeTab === 'profitability'
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'bg-white text-ink-700 hover:bg-cream-100'
                )}
                onClick={() => setActiveTab('profitability')}
              >
                Rentabilidad y costos
              </button>
            </div>

            {/* PESTAÑA 1: EVOLUCIÓN MENSUAL */}
            {activeTab === 'evolution' ? (
              <section className="mt-5 rounded-[2rem] bg-white p-5 shadow-card sm:p-7">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="font-display text-2xl font-black">Facturación en el tiempo</h2>
                    <p className="mt-1 text-xs text-ink-600">
                      {analyticsQuery.data.comparisonCutoffDay === null
                        ? 'Comparación directa de meses seleccionados.'
                        : `Comparación al mismo día (${analyticsQuery.data.comparisonCutoffDay}) de cada mes para un análisis parejo.`}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-full bg-cream-100 p-1 text-xs font-black">
                      <button
                        type="button"
                        className={cn(
                          'rounded-full px-3 py-1.5 transition',
                          chartMode === 'both' ? 'bg-white text-ink-950 shadow-sm' : 'text-ink-600'
                        )}
                        onClick={() => setChartMode('both')}
                      >
                        Ambas
                      </button>
                      <button
                        type="button"
                        className={cn(
                          'rounded-full px-3 py-1.5 transition',
                          chartMode === 'nominal' ? 'bg-white text-ink-950 shadow-sm' : 'text-ink-600'
                        )}
                        onClick={() => setChartMode('nominal')}
                      >
                        En pesos
                      </button>
                      <button
                        type="button"
                        className={cn(
                          'rounded-full px-3 py-1.5 transition',
                          chartMode === 'adjusted' ? 'bg-white text-ink-950 shadow-sm' : 'text-ink-600'
                        )}
                        onClick={() => setChartMode('adjusted')}
                      >
                        Ajustada por inflación
                      </button>
                    </div>

                    {analyticsQuery.data.series.some((p) => !p.ipcPublished) ? (
                      <StatusChip label="Inflación oficial pendiente" tone="warning" />
                    ) : null}
                  </div>
                </div>

                <div className="mt-7 h-80 w-full" aria-label="Gráfico de facturación mensual">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis
                        dataKey="period"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: '#64748b', fontSize: 12, fontWeight: 700 }}
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tick={{ fill: '#64748b', fontSize: 11 }}
                        tickFormatter={(value: number) => `$${Math.round(value / 1000)}k`}
                      />
                      <Tooltip
                        formatter={(value) =>
                          typeof value === 'number'
                            ? new Intl.NumberFormat('es-AR', {
                                style: 'currency',
                                currency: 'ARS',
                                maximumFractionDigits: 0
                              }).format(value)
                            : 'Inflación pendiente'
                        }
                        contentStyle={{
                          borderRadius: 16,
                          border: '1px solid #e2e8f0',
                          boxShadow: '0 12px 30px rgba(11,19,36,.08)'
                        }}
                      />
                      <Legend />
                      {chartMode !== 'adjusted' ? (
                        <Bar
                          dataKey="nominal"
                          name="Facturación en pesos"
                          fill="#1e40af"
                          radius={[8, 8, 0, 0]}
                        />
                      ) : null}
                      {chartMode !== 'nominal' ? (
                        <Bar
                          dataKey="ajustada"
                          name="Ajustada por inflación"
                          fill="#3b82f6"
                          radius={[8, 8, 0, 0]}
                        />
                      ) : null}
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="mt-4 flex items-center gap-2 text-[11px] text-ink-600 font-semibold border-t border-ink-950/8 pt-3">
                  <Info className="size-3.5 text-brand-600" />
                  <span>
                    El ajuste utiliza exclusivamente índices oficiales del INDEC sin estimar meses faltantes. Podés actualizar nuevos índices en Configuración.
                  </span>
                </div>
              </section>
            ) : null}

            {/* PESTAÑA 2: RANKING DE PRODUCTOS */}
            {activeTab === 'products' ? (
              <section className="mt-5 rounded-[2rem] bg-white p-5 shadow-card sm:p-6">
                <div className="flex items-center gap-3">
                  <BarChart3 className="size-5 text-brand-600" />
                  <div>
                    <h2 className="font-display text-2xl font-black">Productos con mayor rendimiento</h2>
                    <p className="text-xs text-ink-600">
                      Ordenados por facturación y margen generado en el período.
                    </p>
                  </div>
                </div>

                <div className="mt-5 divide-y divide-ink-950/8">
                  {analyticsQuery.data.topProducts.map((product, index) => (
                    <article
                      key={product.productId}
                      className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 py-3.5 first:pt-0"
                    >
                      <span className="font-display text-lg font-black text-ink-950/30">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div>
                        <h3 className="font-black text-sm text-ink-950">{product.name}</h3>
                        <p className="text-xs text-ink-600 font-semibold">
                          {formatUnits(product.units)} vendidas · {formatMoney(product.revenueCents)} facturados
                        </p>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] font-black uppercase tracking-wider text-ink-600 block">
                          Margen
                        </span>
                        <strong className="font-display text-sm font-black text-brand-600">
                          {formatMoney(product.estimatedMarginCents)}
                        </strong>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {/* PESTAÑA 3: RENTABILIDAD Y DESGLOSE DE COSTOS */}
            {activeTab === 'profitability' ? (
              <div className="mt-5 grid gap-6 xl:grid-cols-[1fr_20rem]">
                <section className="rounded-[2rem] bg-white p-6 shadow-card space-y-4">
                  <h2 className="font-display text-2xl font-black">Desglose económico del período</h2>
                  <div className="space-y-3">
                    <div className="flex justify-between rounded-xl bg-cream-50 p-3.5 text-sm">
                      <span className="font-bold text-ink-700">Facturación bruta cobrada</span>
                      <strong className="font-display text-base font-black">
                        {formatMoney(analyticsQuery.data.revenueCents)}
                      </strong>
                    </div>
                    <div className="flex justify-between rounded-xl bg-cream-50 p-3.5 text-sm">
                      <span className="font-bold text-red-700">− Costo de mercadería vendido</span>
                      <strong className="font-display text-base font-black text-red-700">
                        {formatMoney(analyticsQuery.data.costCents)}
                      </strong>
                    </div>
                    <div className="flex justify-between rounded-xl bg-cream-50 p-3.5 text-sm">
                      <span className="font-bold text-amber-700">− Impuestos calculados</span>
                      <strong className="font-display text-base font-black text-amber-700">
                        {formatMoney(analyticsQuery.data.taxCents)}
                      </strong>
                    </div>
                    <div className="flex justify-between rounded-xl border border-brand-200/60 bg-brand-50 p-4 text-base">
                      <span className="font-black text-brand-700">Margen estimado comercial</span>
                      <strong className="font-display text-xl font-black text-brand-700">
                        {formatMoney(analyticsQuery.data.estimatedMarginCents)}
                      </strong>
                    </div>
                  </div>
                </section>

                <aside className="rounded-[2rem] bg-ink-950 p-6 text-white shadow-card">
                  <h2 className="font-display text-2xl font-black">
                    No es ganancia neta.
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-white/70">
                    El margen estimado resta el costo de mercadería y la tasa impositiva congelada en cada venta. Gastos fijos (alquiler, luz, sueldos) no están deducidos.
                  </p>
                </aside>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </RoleGate>
  );
}
