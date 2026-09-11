import { Link, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gift,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  ShoppingBasket,
  X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { OrderStatus } from '@/components/admin/OrderStatus';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Modal } from '@/components/ui/Modal';
import { formatMoney } from '@/domain/money';
import {
  availableOrderActions,
  ORDER_ACTION_LABELS
} from '@/domain/order-actions';
import type { Order, OrderAction } from '@/domain/types';
import { cn } from '@/lib/cn';
import { buildWhatsAppUrl } from '@/lib/whatsapp-url';
import { getBusinessApi } from '@/services/business-api';

import { cleanSearchTerm } from '@/lib/search';

function OrderTimeline({ order }: { order: Order }) {
  const isGift = order.paymentState === 'gifted';
  const steps = [
    {
      label: isGift ? 'Regalo' : 'Cobrado',
      status: isGift ? 'Cortesía' : order.paymentState === 'paid' ? 'Cobrado' : 'Pendiente de cobro',
      done: isGift || order.paymentState === 'paid'
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
  const routeSearchParams = useSearch({ strict: false }) as { search?: string | number } | undefined;
  const initialSearch = useMemo(() => {
    if (routeSearchParams?.search !== undefined && routeSearchParams?.search !== null) {
      return cleanSearchTerm(routeSearchParams.search);
    }
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return cleanSearchTerm(params.get('search'));
    }
    return '';
  }, [routeSearchParams?.search]);

  const [search, setSearch] = useState(initialSearch);
  const [filter, setFilter] = useState<'pending' | 'completed' | 'all'>(() => {
    return initialSearch ? 'all' : 'pending';
  });

  useEffect(() => {
    if (routeSearchParams?.search !== undefined && routeSearchParams?.search !== null) {
      const cleaned = cleanSearchTerm(routeSearchParams.search);
      setSearch(cleaned);
      if (cleaned) {
        setFilter('all');
      }
    }
  }, [routeSearchParams?.search]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const [successNotice, setSuccessNotice] = useState<{ order: Order; completed: boolean; message: string } | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (successNotice?.completed) noticeRef.current?.focus();
  }, [successNotice]);
  const [showSecondaryActions, setShowSecondaryActions] = useState<Record<string, boolean>>({});
  const [confirmAction, setConfirmAction] = useState<{ order: Order; action: OrderAction } | null>(null);

  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => { setPage(1); setDebouncedSearch(cleanSearchTerm(search)); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const settingsQuery = useBusinessQuery({
    queryKey: queryKeys.settings,
    queryFn: (api) => api.getSettings()
  });
  const ordersQuery = useBusinessQuery({
    queryKey: [...queryKeys.orders(page), debouncedSearch, filter],
    queryFn: (api) => api.listOrders(page, 50, debouncedSearch, filter)
  });

  const transition = useMutation({
    mutationFn: async (variables: { orderId: string; action: OrderAction }) =>
      (await getBusinessApi()).transitionOrder(variables.orderId, variables.action),
    onSuccess: async (order, variables) => {
      setMutationError(null);
      const cancelled = order.orderState === 'cancelled';
      const isGift = order.paymentState === 'gifted';
      const completed = cancelled || isGift || (order.paymentState === 'paid' && order.fulfillmentState === 'delivered');
      const state =
        variables.action === 'mark_paid'
          ? 'cobrado'
          : variables.action === 'mark_gifted'
            ? 'registrado como regalo / cortesía'
            : variables.action === 'mark_delivered'
              ? 'entregado'
              : 'actualizado';
      setSuccessNotice({
        order,
        completed,
        message: completed
          ? `Pedido #${order.number} ${cancelled ? 'cancelado' : isGift ? 'registrado como regalo / cortesía' : 'completado'}. Lo encontrás en Completados.`
          : `Pedido #${order.number} ${state}.`
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products }),
        queryClient.invalidateQueries({ queryKey: queryKeys.storefrontProducts }),
        queryClient.invalidateQueries({ queryKey: ['paid-orders'] }),
        queryClient.invalidateQueries({ queryKey: ['analytics'] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['movements'] })
      ]);
    },
    onError: error => { setSuccessNotice(null); setMutationError(error); }
  });

  const items = ordersQuery.data?.items ?? [];

  const pendingCount = ordersQuery.data?.pendingTotal ?? 0;
  const completedCount = ordersQuery.data?.completedTotal ?? 0;
  const filteredOrders = items;

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
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/app/pedidos/nuevo" className={buttonStyles({ size: 'lg' })}>
              <Plus className="size-5" /> Cargar pedido manual
            </Link>
            <Link to="/app/pedidos/importar" className={buttonStyles({ variant: 'secondary', size: 'lg' })}>
              <ShoppingBasket className="size-5" /> Importar WhatsApp
            </Link>
          </div>
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
            onClick={() => { setPage(1); setFilter('pending'); }}
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
            onClick={() => { setPage(1); setFilter('completed'); }}
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
            onClick={() => { setPage(1); setFilter('all'); }}
          >
            Todos ({pendingCount + completedCount})
          </button>
        </div>

        <div className="relative min-w-48 sm:w-72">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-ink-600" />
          <input
            type="search"
            placeholder="Buscar pedido, cliente, tel…"
            value={search}
            onChange={(e) => {
              const val = e.target.value.replace(/^["'“”`\\]+|["'“”`\\]+$/g, '');
              setSearch(val);
            }}
            className="h-11 w-full rounded-full border border-ink-950/15 bg-white pl-10 pr-4 text-[14.5px] font-semibold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
      </div>

      {successNotice ? (
        <div ref={noticeRef} tabIndex={-1} className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
          <p role="status" className="flex-1 font-semibold">{successNotice.message}</p>
          {successNotice.completed ? <Button variant="secondary" size="sm" onClick={() => {
            const order = successNotice.order;
            setPage(1); setFilter('completed'); setSearch(String(order.number));
            setDebouncedSearch(String(order.number)); setExpanded(order.id); setSuccessNotice(null);
          }}>Ver pedido</Button> : null}
          <button type="button" className="grid size-11 place-items-center rounded-full hover:bg-emerald-100" aria-label="Cerrar aviso" onClick={() => setSuccessNotice(null)}><X className="size-5" /></button>
        </div>
      ) : null}

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
                      <span className="text-sm font-bold text-brand-700">{open ? 'Ocultar acciones' : 'Ver pedido y acciones'}</span>
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
                              {(order.items ?? []).map((item) => (
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
                                Estado:{' '}
                                <span
                                  className={
                                    order.paymentState === 'gifted'
                                      ? 'text-purple-800 font-black'
                                      : order.paymentState === 'paid'
                                        ? 'text-emerald-800 font-black'
                                        : order.paymentState === 'refunded'
                                          ? 'text-ink-600 font-black'
                                          : 'text-amber-900 font-black'
                                  }
                                >
                                  {order.paymentState === 'gifted'
                                    ? 'Regalo / Cortesía'
                                    : order.paymentState === 'paid'
                                      ? 'Pagado'
                                      : order.paymentState === 'refunded'
                                        ? 'Reembolsado'
                                        : 'Pendiente de cobro'}
                                </span>
                              </p>
                              <p className="text-ink-700 font-medium">
                                Medio:{' '}
                                {order.paymentMethod === 'gift'
                                  ? 'Regalo / Cortesía'
                                  : order.paymentMethod === 'cash'
                                    ? 'Efectivo'
                                    : 'Transferencia bancaria'}
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
                                  `Hola ${order.customerName}, te escribimos de ${settingsQuery.data?.storeName || 'Tienda de Suplementos'} sobre tu pedido #${order.number}.`
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

                        {/* Botones de acción contextuales simplificados: Cobrado / Regalar y Entregado */}
                        <div className="flex flex-col justify-center gap-3 rounded-2xl bg-white p-6 border border-ink-950/8 shadow-sm h-fit">
                          <p className="text-[13.5px] font-black uppercase tracking-wider text-ink-700 mb-1">
                            Acción operativa
                          </p>

                          {/* 1. Paso Cobrado / Regalo */}
                          {order.paymentState === 'gifted' ? (
                            <div className="flex items-center gap-2 rounded-xl bg-purple-50 border border-purple-200 px-3.5 py-2.5 text-[14px] font-black text-purple-800">
                              <Gift className="size-4 shrink-0 text-purple-600" />
                              <span>Regalo / Cortesía</span>
                            </div>
                          ) : order.paymentState === 'paid' ? (
                            <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-[14px] font-black text-emerald-800">
                              <Check className="size-4 shrink-0 text-emerald-600" />
                              <span>Cobrado</span>
                            </div>
                          ) : actions.includes('mark_paid') ? (
                            <div className="flex items-center gap-2">
                              <Button
                                variant="dark"
                                size="md"
                                className="flex-1"
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
                              {actions.includes('mark_gifted') ? (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="md"
                                  title="Marcar como cortesía / regalo (descuenta stock sin sumar facturación)"
                                  className="shrink-0 text-purple-700 border-purple-200 hover:bg-purple-50 hover:text-purple-800 hover:border-purple-300 font-bold px-3.5"
                                  onClick={() => setConfirmAction({ order, action: 'mark_gifted' })}
                                >
                                  <Gift className="size-4 mr-1 text-purple-600" />
                                  Regalar
                                </Button>
                              ) : null}
                            </div>
                          ) : null}

                          {/* 2. Paso Entregado */}
                          {order.fulfillmentState === 'delivered' ? (
                            <div className="flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-[14px] font-black text-emerald-800">
                              <Check className="size-4 shrink-0 text-emerald-600" />
                              <span>Entregado</span>
                            </div>
                          ) : order.stockReadiness === 'waiting_incoming' ? (
                            <div className="rounded-xl bg-brand-50 border border-brand-200 p-3 text-xs font-semibold text-brand-950 space-y-1">
                              <p className="font-black flex items-center gap-1.5 text-brand-900">
                                <span>📦</span> En camino
                              </p>
                              <p className="text-brand-800">
                                {order.expectedArrivalAt
                                  ? `Llegada estimada: ${new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(order.expectedArrivalAt))}.`
                                  : 'Stock asignado a compras en camino.'}{' '}
                                Recibí la compra en Inventario para habilitar la entrega.
                              </p>
                            </div>
                          ) : order.stockReadiness === 'uncovered' ? (
                            <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs font-semibold text-rose-950 space-y-1">
                              <p className="font-black flex items-center gap-1.5 text-rose-900">
                                <span>🔴</span> Faltante de proveedor
                              </p>
                              <p className="text-rose-800">
                                La compra del proveedor cerró con faltante definitivo. Contactá al cliente para acordar un reemplazo o cancelar el pedido.
                              </p>
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
                          {order.paymentState === 'gifted' ? (
                            <p className="text-[13.5px] font-semibold text-purple-700 py-1 text-center">
                              Pedido regalo / cortesía registrado. Stock descontado.
                            </p>
                          ) : order.paymentState === 'paid' && order.fulfillmentState === 'delivered' ? (
                            <p className="text-[13.5px] font-semibold text-emerald-700 py-1 text-center">
                              Pedido completado y stock actualizado.
                            </p>
                          ) : null}

                          {/* Acciones secundarias (cancelar, envío intermedio, reintegro) */}
                          {actions.filter((a) => a !== 'mark_paid' && a !== 'mark_delivered' && a !== 'mark_gifted').length > 0 ? (
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
                                    .filter((a) => a !== 'mark_paid' && a !== 'mark_delivered' && a !== 'mark_gifted')
                                    .map((secAction) => {
                                      const isDestructive = secAction === 'cancel' || secAction === 'mark_refunded';
                                      return (
                                        <Button
                                          key={secAction}
                                          variant="ghost"
                                          size="sm"
                                          className={cn(
                                            'w-full text-[13.5px] font-bold',
                                            secAction === 'cancel'
                                              ? 'text-rose-700 hover:bg-rose-50 hover:text-rose-800'
                                              : 'text-ink-800 hover:text-ink-950'
                                          )}
                                          loading={
                                            transition.isPending &&
                                            transition.variables?.action === secAction
                                          }
                                          onClick={() => {
                                            if (isDestructive) {
                                              setConfirmAction({ order, action: secAction });
                                            } else {
                                              transition.mutate({
                                                orderId: order.id,
                                                action: secAction
                                              });
                                            }
                                          }}
                                        >
                                          {ORDER_ACTION_LABELS[secAction]}
                                        </Button>
                                      );
                                    })}
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

          {confirmAction ? (
            <Modal
              isOpen={Boolean(confirmAction)}
              onClose={() => setConfirmAction(null)}
              maxWidth="md"
              ariaLabelledBy="confirm-order-action-title"
            >
              <div className="flex items-start gap-4">
                <div
                  className={cn(
                    'grid size-12 shrink-0 place-items-center rounded-2xl',
                    confirmAction.action === 'mark_gifted'
                      ? 'bg-purple-100 text-purple-700'
                      : confirmAction.action === 'cancel'
                        ? 'bg-rose-100 text-rose-700'
                        : 'bg-amber-100 text-amber-800'
                  )}
                >
                  {confirmAction.action === 'mark_gifted' ? (
                    <Gift className="size-6" />
                  ) : (
                    <AlertTriangle className="size-6" />
                  )}
                </div>
                <div className="space-y-1">
                  <h3 id="confirm-order-action-title" className="font-display text-xl font-black text-ink-950">
                    {confirmAction.action === 'mark_gifted'
                      ? `¿Registrar pedido #${confirmAction.order.number} como regalo / cortesía?`
                      : confirmAction.action === 'cancel'
                        ? `¿Cancelar pedido #${confirmAction.order.number}?`
                        : `¿Registrar reintegro para pedido #${confirmAction.order.number}?`}
                  </h3>
                  <p className="text-sm font-semibold text-ink-800">
                    {confirmAction.action === 'mark_gifted' ? 'Beneficiario' : 'Cliente'}: {confirmAction.order.customerName}{' '}
                    {confirmAction.action !== 'mark_gifted' ? `(${formatMoney(confirmAction.order.totalCents)})` : ''}
                  </p>
                </div>
              </div>

              <div className="mt-4 rounded-2xl bg-cream-50 p-4 text-sm text-ink-700 space-y-2">
                {confirmAction.action === 'mark_gifted' ? (
                  <>
                    <p>
                      Este pedido se registrará como <strong>regalo / atención de cortesía</strong>:
                    </p>
                    <ul className="list-disc list-inside space-y-1.5 text-ink-800 text-xs">
                      <li><strong>Descontará el stock físico real</strong> del inventario automáticamente.</li>
                      <li><strong>No sumará facturación</strong> (se registrará cobro $ 0).</li>
                      <li>En la sección de <strong>Ventas</strong> figurará el costo asumido como <strong>pérdida en rojo</strong> y se deducirá del margen neto.</li>
                      <li>El pedido quedará completado sin generar cobros pendientes.</li>
                    </ul>
                    <p className="text-xs font-semibold text-purple-800 pt-1">
                      🎁 Ideal para suplementos regalados a familiares, embajadores o atenciones comerciales.
                    </p>
                  </>
                ) : confirmAction.action === 'cancel' ? (
                  <>
                    <p>
                      Al cancelar el pedido, <strong>se liberarán inmediatamente las unidades reservadas en inventario</strong> para que otros clientes puedan comprarlas.
                    </p>
                    <p className="text-xs font-semibold text-rose-700">
                      ⚠️ Esta acción cambiará el estado del pedido a «Cancelado».
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      Confirmá que se ha realizado la <strong>devolución o reintegro del dinero</strong> al cliente.
                    </p>
                    <p className="text-xs text-ink-600">
                      El pedido quedará registrado con reintegro completado.
                    </p>
                  </>
                )}
              </div>

              {mutationError ? (
                <div className="mt-4">
                  <ErrorState error={mutationError} />
                </div>
              ) : null}

              <div className="mt-6 flex items-center justify-end gap-3">
                <Button
                  variant="ghost"
                  onClick={() => setConfirmAction(null)}
                  disabled={transition.isPending}
                >
                  Volver
                </Button>
                <Button
                  variant="dark"
                  className={
                    confirmAction.action === 'mark_gifted'
                      ? 'bg-purple-700 hover:bg-purple-800 text-white font-bold'
                      : confirmAction.action === 'cancel'
                        ? 'bg-rose-700 hover:bg-rose-800 text-white font-bold'
                        : 'bg-amber-800 hover:bg-amber-900 text-white font-bold'
                  }
                  loading={transition.isPending}
                  onClick={async () => {
                    transition.mutate({
                      orderId: confirmAction.order.id,
                      action: confirmAction.action
                    }, { onSuccess: () => setConfirmAction(null) });
                  }}
                >
                  {confirmAction.action === 'mark_gifted'
                    ? 'Sí, registrar como regalo'
                    : confirmAction.action === 'cancel'
                      ? 'Sí, cancelar pedido'
                      : 'Sí, confirmar reintegro'}
                </Button>
              </div>
            </Modal>
          ) : null}

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
