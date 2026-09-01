import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  PackageCheck,
  ShoppingBasket,
  Sparkles
} from 'lucide-react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { MetricCard } from '@/components/admin/MetricCard';
import { OrderStatus } from '@/components/admin/OrderStatus';
import { PageHeader } from '@/components/layout/AdminShell';
import { buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { StatusChip } from '@/components/ui/StatusChip';
import { formatMoney } from '@/domain/money';
import { can } from '@/domain/permissions';
import { formatUnits } from '@/domain/quantity';
import { useAuth } from '@/features/auth/AuthProvider';

const stockLabel = {
  ok: 'OK',
  low: 'COMPRAR',
  critical: 'URGENTE',
  out: 'SIN STOCK'
} as const;

export default function DashboardPage() {
  const { user } = useAuth();
  const summaryQuery = useBusinessQuery({
    queryKey: queryKeys.dashboard,
    queryFn: (api) => api.getDashboard()
  });
  const financial = can(user, 'view_financials');

  return (
    <div className="page-enter">
      <PageHeader
        title="Prioridades de hoy"
        description="Atendé las tareas prioritarias del día y revisá las alertas de reposición inmediata."
        action={
          <Link to="/app/pedidos/importar" className={buttonStyles({ size: 'lg' })}>
            <ShoppingBasket className="size-5" /> Importar WhatsApp
          </Link>
        }
      />

      {summaryQuery.isPending ? <LoadingState label="Ordenando las prioridades…" /> : null}
      {summaryQuery.isError ? (
        <ErrorState error={summaryQuery.error} onRetry={() => void summaryQuery.refetch()} />
      ) : null}

      {summaryQuery.data ? (
        <>
          {/* Indicadores Operativos Calmos */}
          <section
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Resumen operativo del día"
          >
            <MetricCard
              label="Para preparar"
              value={String(summaryQuery.data.pendingPreparation)}
              detail="Pedidos confirmados"
              icon={ClipboardList}
              accent="sun"
            />
            <MetricCard
              label="Listos para entrega"
              value={String(summaryQuery.data.readyForDelivery)}
              detail="Esperan retiro o envío"
              icon={PackageCheck}
              accent="sapphire"
            />
            <MetricCard
              label="Stock a reponer"
              value={String(summaryQuery.data.lowStockProducts)}
              detail="Bajo, crítico o agotado"
              icon={Boxes}
              accent="sun"
            />
            <MetricCard
              label="Compras en camino"
              value={String(summaryQuery.data.incomingPurchases)}
              detail="Esperando recepción"
              icon={ShoppingBasket}
              accent="sapphire"
            />
          </section>

          {/* Línea Financiera Compacta (Solo Dueña) */}
          {financial ? (
            <section className="mt-5 flex flex-col justify-between gap-4 rounded-2xl border border-brand-900/20 bg-brand-950 px-6 py-4 text-white sm:flex-row sm:items-center">
              <div className="flex flex-wrap items-center gap-6">
                <div>
                  <span className="text-[10px] font-black uppercase tracking-wider text-brand-300">
                    Facturación cobrada mes
                  </span>
                  <p className="font-display text-2xl font-black">
                    {formatMoney(summaryQuery.data.paidRevenueMonthCents ?? 0)}
                  </p>
                </div>
                <div className="border-white/15 sm:border-l sm:pl-6">
                  <span className="text-[10px] font-black uppercase tracking-wider text-white/60">
                    Ventas cobradas
                  </span>
                  <p className="font-display text-2xl font-black">
                    {summaryQuery.data.paidOrdersMonth ?? 0}
                  </p>
                </div>
                <div className="border-white/15 sm:border-l sm:pl-6">
                  <span className="text-[10px] font-black uppercase tracking-wider text-white/60">
                    Margen estimado
                  </span>
                  <p className="font-display text-2xl font-black text-brand-300">
                    {formatMoney(summaryQuery.data.estimatedMarginMonthCents ?? 0)}
                  </p>
                </div>
              </div>
              <Link
                to="/app/ventas"
                className="inline-flex items-center gap-1.5 text-xs font-black text-brand-300 hover:text-white"
              >
                Ver ventas <ArrowRight className="size-3.5" />
              </Link>
            </section>
          ) : null}

          {/* Listas Principales de Atención Inmediata */}
          <div className="mt-7 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            {/* Pedidos que requieren acción */}
            <section className="rounded-[2rem] bg-white p-5 shadow-card sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-display text-2xl font-black text-ink-950">Pedidos a resolver</h2>
                  <p className="mt-0.5 text-[14px] font-medium text-ink-700">Trabajo operativo pendiente</p>
                </div>
                <Link
                  to="/app/pedidos"
                  className="inline-flex items-center gap-1 text-xs font-black text-brand-600 hover:text-brand-700"
                >
                  Ver todos <ArrowRight className="size-3.5" />
                </Link>
              </div>

              <div className="mt-5 divide-y divide-ink-950/8">
                {summaryQuery.data.recentOrders.length === 0 ? (
                  <p className="py-6 text-center text-sm font-semibold text-ink-600">
                    No hay pedidos pendientes de acción. ¡Todo al día!
                  </p>
                ) : (
                  summaryQuery.data.recentOrders.map((order) => (
                    <article
                      key={order.id}
                      className="grid gap-3 py-3.5 first:pt-0 sm:grid-cols-[auto_1fr_auto] sm:items-center"
                    >
                      <span className="grid size-10 place-items-center rounded-2xl bg-cream-100 font-display text-xs font-black">
                        #{order.number}
                      </span>
                      <div>
                        <h3 className="text-sm font-black text-ink-950">{order.customerName}</h3>
                        <p className="text-xs font-semibold text-ink-600">
                          {formatUnits(
                            order.items.reduce((sum, item) => sum + item.quantity, 0)
                          )}{' '}
                          · {formatMoney(order.totalCents)}
                        </p>
                      </div>
                      <OrderStatus order={order} compact />
                    </article>
                  ))
                )}
              </div>
            </section>

            {/* Reposición Prioritaria */}
            <section className="rounded-[2rem] bg-white p-5 shadow-card sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-display text-2xl font-black text-ink-950">Qué comprar</h2>
                  <p className="mt-0.5 text-[14px] font-medium text-ink-700">Productos con compra recomendada</p>
                </div>
                <Link
                  to="/app/inventario"
                  className="inline-flex items-center gap-1 text-xs font-black text-brand-600 hover:text-brand-700"
                >
                  Ir a inventario <ArrowRight className="size-3.5" />
                </Link>
              </div>

              <div className="mt-5 space-y-3">
                {summaryQuery.data.priorityInventory.length === 0 ? (
                  <p className="py-6 text-center text-sm font-semibold text-ink-600">
                    Todos los productos cuentan con reposición cubierta o stock en orden.
                  </p>
                ) : (
                  summaryQuery.data.priorityInventory.map((item) => (
                    <article
                      key={item.id}
                      className="rounded-2xl border border-amber-200/70 bg-amber-50/30 p-3.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-black text-ink-950">{item.name}</h3>
                          <p className="mt-0.5 text-xs font-semibold text-ink-600">
                            {formatUnits(item.available)}{' '}
                            {item.available === 1 ? 'disponible' : 'disponibles'}
                            {item.incoming > 0 ? ` · ${item.incoming} en camino` : ''}
                          </p>
                        </div>
                        <StatusChip
                          label={stockLabel[item.status]}
                          tone={
                            item.status === 'out' || item.status === 'critical'
                              ? 'danger'
                              : 'warning'
                          }
                        />
                      </div>
                      <p className="mt-2 flex items-center gap-1.5 text-xs font-black text-amber-800">
                        <Sparkles className="size-3.5 shrink-0 text-amber-600" /> Comprar{' '}
                        {item.suggestedPurchase} unidades
                      </p>
                    </article>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
