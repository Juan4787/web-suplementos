import { Link, useSearch } from '@tanstack/react-router';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  MoreHorizontal,
  Search,
  ShoppingBasket
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { OrderStatus } from '@/components/admin/OrderStatus';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { formatMoney } from '@/domain/money';
import {
  availableOrderActions,
  ORDER_ACTION_LABELS
} from '@/domain/order-actions';
import type { Order, OrderAction } from '@/domain/types';
import { cn } from '@/lib/cn';
import { buildWhatsAppUrl } from '@/lib/whatsapp-url';
import { getBusinessApi } from '@/services/business-api';

function cleanSearchTerm(val: string | null | undefined): string {
  if (!val) return '';
  return val.replace(/^["']|["']$/g, '').trim();
}

function OrderTimeline({ order }: { order: Order }) {
  const steps = [
    {
      label: 'Cobrado',
      status: order.paymentState === 'paid' ? 'Cobrado' : 'Pendiente de cobro',
      done: order.paymentState === 'paid'
    },
    {
      label: 'Entregado',
      status:
        order.fulfillmentState === 'delivered'
          ? 'Entregado'
          : order.fulfillmentState === 'shipped'
            ? 'Enviado'
            : 'Pendiente de entrega',
      done: order.fulfillmentState === 'delivered'
    }
  ];

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      {steps.map((step, idx) => (
        <div key={step.label} className="flex items-center gap-2.5 text-[14px] font-bold">
          <span
            className={cn(
              'grid size-7 place-items-center rounded-full text-xs font-black transition-colors',
              step.done ? 'bg-emerald-600 text-white shadow-sm' : 'bg-cream-200 text-ink-600'
            )}
          >
            {step.done ? '✓' : idx + 1}
          </span>
          <div className="flex flex-col sm:flex-row sm:items-center sm:gap-1.5">
            <span className={step.done ? 'text-ink-950 font-black' : 'text-ink-700 font-bold'}>
              {step.label}
            </span>
            <span
              className={cn(
                'text-xs font-semibold',
                step.done ? 'text-emerald-700' : 'text-ink-600'
              )}
            >
              · {step.status}
            </span>
          </div>
          {idx < steps.length - 1 ? (
            <span className="text-ink-300 mx-3 hidden sm:inline">→</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function OrdersPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'pending' | 'completed' | 'all'>('pending');
  const routeSearchParams = useSearch({ strict: false }) as { search?: string } | undefined;
  const [search, setSearch] = useState(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return cleanSearchTerm(params.get('search'));
    }
    return '';
  });

  useEffect(() => {
    if (routeSearchParams?.search) {
      const cleaned = cleanSearchTerm(routeSearchParams.search);
      if (cleaned) setSearch(cleaned);
    }
  }, [routeSearchParams?.search]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const [showSecondaryActions, setShowSecondaryActions] = useState<Record<string, boolean>>({});

  const ordersQuery = useBusinessQuery({
    queryKey: queryKeys.orders(page),
    queryFn: (api) => api.listOrders(page, 50)
  });

  const transition = useMutation({
    mutationFn: async (variables: { orderId: string; action: OrderAction }) =>
      (await getBusinessApi()).transitionOrder(variables.orderId, variables.action),
    onSuccess: async () => {
      setMutationError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory })
      ]);
    },
    onError: setMutationError
  });

  const items = ordersQuery.data?.items ?? [];

  const pendingCount = useMemo(() => {
    return items.filter(
      (o) =>
        !(
          o.orderState === 'cancelled' ||
          (o.fulfillmentState === 'delivered' && o.paymentState === 'paid')
        )
    ).length;
  }, [items]);

  const completedCount = items.length - pendingCount;

  const filteredOrders = useMemo(() => {
    return items.filter((order) => {
      const term = cleanSearchTerm(search).toLowerCase();
      const matchesSearch =
        !term ||
        order.customerName.toLowerCase().includes(term) ||
        (order.customerPhone ?? '').includes(term) ||
        order.number.toString().includes(term);

      if (!matchesSearch) return false;

      const isCompleted =
        order.orderState === 'cancelled' ||
        (order.fulfillmentState === 'delivered' && order.paymentState === 'paid');

      if (filter === 'pending') return !isCompleted;
      if (filter === 'completed') return isCompleted;
      return true;
    });
  }, [items, search, filter]);

  // Si se buscó un pedido específico (ej: desde "Ver pedido #1049"), autoexpandir su tarjeta
  useEffect(() => {
    if (search && filteredOrders.length === 1 && !expanded) {
      setExpanded(filteredOrders[0]?.id ?? null);
    }
  }, [search, filteredOrders, expanded]);

  return (
    <div className="page-enter">
      <PageHeader
        title="Pedidos"
        description="Revisá los pedidos que necesitan atención, confirmá pagos pendientes y gestioná las entregas."
        action={
          <Link to="/app/pedidos/importar" className={buttonStyles({ size: 'lg' })}>
            <ShoppingBasket className="size-5" /> Importar WhatsApp
          </Link>
        }
      />

      {/* Controles de Filtro Rápido con Ergonomía y Legibilidad Alta */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={cn(
              'min-h-11 rounded-full px-4 text-[14.5px] font-bold transition select-none',
              filter === 'pending'
                ? 'bg-brand-600 text-white shadow-sm font-black'
                : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25'
            )}
            onClick={() => setFilter('pending')}
          >
            Pendientes de acción <span className="ml-1 opacity-85">• {pendingCount}</span>
          </button>
          <button
            type="button"
            className={cn(
              'min-h-11 rounded-full px-4 text-[14.5px] font-bold transition select-none',
              filter === 'completed'
                ? 'bg-brand-600 text-white shadow-sm font-black'
                : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25'
            )}
            onClick={() => setFilter('completed')}
          >
            Completados <span className="ml-1 opacity-85">• {completedCount}</span>
          </button>
          <button
            type="button"
            className={cn(
              'min-h-11 rounded-full px-4 text-[14.5px] font-bold transition select-none',
              filter === 'all'
                ? 'bg-brand-600 text-white shadow-sm font-black'
                : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25'
            )}
            onClick={() => setFilter('all')}
          >
            Todos ({items.length})
          </button>
        </div>

        <div className="relative min-w-48 sm:w-72">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-ink-600" />
          <input
            type="search"
            placeholder="Buscar pedido, cliente, tel…"
            value={search}
            onChange={(e) => setSearch(cleanSearchTerm(e.target.value))}
            className="h-11 w-full rounded-full border border-ink-950/15 bg-white pl-10 pr-4 text-[14.5px] font-semibold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
      </div>

      {mutationError ? (
        <div className="mb-5">
          <ErrorState error={mutationError} />
        </div>
      ) : null}

      {ordersQuery.isPending ? <LoadingState label="Buscando pedidos…" /> : null}
      {ordersQuery.isError ? (
        <ErrorState error={ordersQuery.error} onRetry={() => void ordersQuery.refetch()} />
      ) : null}

      {ordersQuery.data ? (
        <div className="space-y-3">
          {filteredOrders.length === 0 ? (
            <div className="rounded-2xl bg-white p-8 text-center text-sm font-semibold text-ink-600 shadow-sm border border-ink-950/8">
              No hay pedidos en esta vista. ¡Todo al día!
            </div>
          ) : (
            filteredOrders.map((order) => {
              const open = expanded === order.id;
              const isCompleted =
                order.orderState === 'cancelled' ||
                (order.fulfillmentState === 'delivered' && order.paymentState === 'paid');
              const actions = availableOrderActions(order);
              const primaryAction = actions[0];
              const secondaryActions = actions.slice(1);
              const showMore = showSecondaryActions[order.id] ?? false;

              return (
                <article
                  key={order.id}
                  className={cn(
                    'overflow-hidden rounded-2xl border transition',
                    isCompleted
                      ? 'border-ink-950/6 bg-cream-50/50 shadow-none'
                      : 'border-ink-950/8 bg-white shadow-sm hover:border-ink-950/20'
                  )}
                >
                  <button
                    type="button"
                    className="grid w-full min-h-[4.25rem] gap-3 p-4 text-left sm:grid-cols-[5.5rem_1.2fr_1.2fr_auto] sm:items-center sm:px-6 sm:py-4"
                    onClick={() => setExpanded(open ? null : order.id)}
                    aria-expanded={open}
                  >
                    <span className="font-display text-xl font-black text-ink-950">
                      #{order.number}
                    </span>
                    <div>
                      <h2 className="text-[16.5px] font-black text-ink-950">{order.customerName}</h2>
                      <p className="text-[14px] text-ink-700 font-semibold">
                        {new Intl.DateTimeFormat('es-AR', {
                          dateStyle: 'short',
                          timeStyle: 'short'
                        }).format(new Date(order.createdAt))}
                      </p>
                    </div>

                    <OrderStatus order={order} />

                    <div className="flex items-center justify-between gap-4 sm:justify-end">
                      <strong className="font-display text-xl font-black text-ink-950">
                        {formatMoney(order.totalCents)}
                      </strong>
                      <ChevronDown
                        className={cn(
                          'size-5 text-ink-600 transition-transform',
                          open && 'rotate-180'
                        )}
                      />
                    </div>
                  </button>

                  {open ? (
                    <div className="border-t border-ink-950/8 bg-cream-50/60 p-5 sm:p-6">
                      {/* Timeline superior */}
                      <div className="mb-6 rounded-xl bg-white p-4 border border-ink-950/6">
                        <OrderTimeline order={order} />
                      </div>

                      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
                        {/* Detalle de productos y entrega */}
                        <div className="space-y-4">
                          <div>
                            <p className="text-[13.5px] font-black uppercase tracking-wider text-ink-700">
                              Productos pedidos
                            </p>
                            <div className="mt-2 space-y-2">
                              {order.items.map((item) => (
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between gap-4 rounded-xl bg-white p-3.5 text-sm border border-ink-950/6"
                                >
                                  <div className="min-w-0">
                                    <p className="text-[15.5px] font-black text-ink-950 truncate">
                                      {item.productName}
                                    </p>
                                    <p className="text-[14px] text-ink-700 font-medium">
                                      {item.presentation} · Cantidad: {item.quantity} u.
                                    </p>
                                  </div>
                                  <strong className="text-[16px] font-black text-ink-950">
                                    {formatMoney(item.subtotalCents)}
                                  </strong>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* Resumen de Pago y Entrega */}
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-xl bg-white p-4 border border-ink-950/6 text-[14px] space-y-1.5">
                              <p className="text-[13px] font-black uppercase tracking-wider text-ink-700">Pago</p>
                              <p className="font-bold text-ink-950">
                                Estado: <span className={order.paymentState === 'paid' ? 'text-emerald-800 font-black' : 'text-amber-900 font-black'}>{order.paymentState === 'paid' ? 'Pagado' : 'Pendiente de cobro'}</span>
                              </p>
                              <p className="text-ink-700 font-medium">
                                Medio: {order.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia bancaria'}
                              </p>
                            </div>

                            <div className="rounded-xl bg-white p-4 border border-ink-950/6 text-[14px] space-y-1.5">
                              <p className="text-[13px] font-black uppercase tracking-wider text-ink-700">Entrega</p>
                              <p className="font-bold text-ink-950">
                                {order.deliveryMethod === 'pickup' ? 'Retiro en local' : 'Envío a domicilio'}
                              </p>
                              {order.shippingAddress ? (
                                <p className="text-ink-700 font-medium truncate">{order.shippingAddress}</p>
                              ) : null}
                              {order.shippingType ? (
                                <p className="text-ink-700 font-medium">Tipo: {order.shippingType === 'express' ? 'Express' : 'Estándar'}</p>
                              ) : null}
                            </div>
                          </div>

                          {/* Datos del Cliente y Botón WhatsApp */}
                          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 border border-ink-950/6 text-[14px]">
                            <div>
                              <p className="text-[15.5px] font-black text-ink-950">{order.customerName}</p>
                              {order.customerPhone ? (
                                <p className="text-ink-700 font-semibold">{order.customerPhone}</p>
                              ) : null}
                            </div>
                            {order.customerPhone ? (
                              <a
                                href={buildWhatsAppUrl(
                                  order.customerPhone,
                                  `Hola ${order.customerName}, te escribimos de Impulso Suplementos sobre tu pedido #${order.number}.`
                                )}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-[14px] font-black text-white shadow-sm hover:bg-emerald-700 transition"
                              >
                                <MessageCircle className="size-4" /> Abrir WhatsApp
                              </a>
                            ) : null}
                          </div>
                        </div>

                        {/* Botones de acción contextuales simplificados: Cobrado y Entregado */}
                        <div className="flex flex-col justify-center gap-3 rounded-2xl bg-white p-6 border border-ink-950/8 shadow-sm h-fit">
                          <p className="text-[13.5px] font-black uppercase tracking-wider text-ink-700 mb-1">
                            Acción operativa
                          </p>

                          {/* 1. Paso Cobrado */}
                          {order.paymentState === 'paid' ? (
                            <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-[14px] font-black text-emerald-800">
                              <Check className="size-4 shrink-0 text-emerald-600" />
                              <span>Cobrado</span>
                            </div>
                          ) : actions.includes('mark_paid') ? (
                            <Button
                              variant="dark"
                              size="md"
                              className="w-full"
                              loading={
                                transition.isPending &&
                                transition.variables?.action === 'mark_paid'
                              }
                              onClick={() =>
                                transition.mutate({ orderId: order.id, action: 'mark_paid' })
                              }
                            >
                              Marcar como cobrado
                            </Button>
                          ) : null}

                          {/* 2. Paso Entregado */}
                          {order.fulfillmentState === 'delivered' ? (
                            <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-[14px] font-black text-emerald-800">
                              <Check className="size-4 shrink-0 text-emerald-600" />
                              <span>Entregado</span>
                            </div>
                          ) : actions.includes('mark_delivered') ? (
                            <Button
                              variant={order.paymentState === 'paid' ? 'dark' : 'secondary'}
                              size="md"
                              className="w-full"
                              loading={
                                transition.isPending &&
                                transition.variables?.action === 'mark_delivered'
                              }
                              onClick={() =>
                                transition.mutate({ orderId: order.id, action: 'mark_delivered' })
                              }
                            >
                              Marcar como entregado
                            </Button>
                          ) : null}

                          {/* Estado si ya fue completado */}
                          {order.paymentState === 'paid' && order.fulfillmentState === 'delivered' ? (
                            <p className="text-[13.5px] font-semibold text-emerald-700 py-1 text-center">
                              Pedido completado y stock actualizado.
                            </p>
                          ) : null}

                          {/* Acciones secundarias (cancelar, envío intermedio, reintegro) */}
                          {actions.filter((a) => a !== 'mark_paid' && a !== 'mark_delivered').length > 0 ? (
                            <div>
                              <button
                                type="button"
                                onClick={() =>
                                  setShowSecondaryActions((prev) => ({
                                    ...prev,
                                    [order.id]: !prev[order.id]
                                  }))
                                }
                                className="mt-1 flex min-h-10 items-center justify-center gap-1 text-[13.5px] font-bold text-ink-700 hover:text-ink-950 w-full py-1"
                              >
                                <MoreHorizontal className="size-4" />
                                {showMore ? 'Menos opciones' : 'Más opciones'}
                              </button>

                              {showMore ? (
                                <div className="mt-2 space-y-2 border-t border-ink-950/8 pt-2">
                                  {actions
                                    .filter((a) => a !== 'mark_paid' && a !== 'mark_delivered')
                                    .map((secAction) => (
                                      <Button
                                        key={secAction}
                                        variant="ghost"
                                        size="sm"
                                        className="w-full text-[13.5px] font-bold text-ink-800 hover:text-red-700"
                                        loading={
                                          transition.isPending &&
                                          transition.variables?.action === secAction
                                        }
                                        onClick={() =>
                                          transition.mutate({
                                            orderId: order.id,
                                            action: secAction
                                          })
                                        }
                                      >
                                        {ORDER_ACTION_LABELS[secAction]}
                                      </Button>
                                    ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })
          )}

          {ordersQuery.data.total > ordersQuery.data.pageSize ? (
            <nav
              className="mt-5 flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm border border-ink-950/8"
              aria-label="Páginas de pedidos"
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={page === 1}
                onClick={() => {
                  setExpanded(null);
                  setPage((current) => Math.max(1, current - 1));
                }}
              >
                <ChevronLeft className="size-4" /> Anterior
              </Button>
              <span className="text-sm font-bold text-ink-700">
                Página {page} de {Math.ceil(ordersQuery.data.total / ordersQuery.data.pageSize)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={page * ordersQuery.data.pageSize >= ordersQuery.data.total}
                onClick={() => {
                  setExpanded(null);
                  setPage((current) => current + 1);
                }}
              >
                Siguiente <ChevronRight className="size-4" />
              </Button>
            </nav>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
