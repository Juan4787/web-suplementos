import { Link, useSearch, useBlocker } from '@tanstack/react-router';
import {
  AlertTriangle,
  Banknote,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gift,
  Mail,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Package,
  PackageCheck,
  Plus,
  Search,
  ShoppingBasket,
  Store,
  Tag,
  Truck,
  Undo2,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { OrderStatus } from '@/components/admin/OrderStatus';
import { OrderShippingFeeEditor, type ShippingEditorState } from '@/components/admin/OrderShippingFeeEditor';
import { shippingFeeNeedsReview } from '@/domain/order-shipping';
import { OrderPackingEditor } from '@/components/admin/OrderPackingEditor';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Modal } from '@/components/ui/Modal';
import { parseShippingAddress } from '@/domain/checkout';
import { formatMoney } from '@/domain/money';
import {
  availableOrderActions,
  isOrderReversal,
  orderCancellationBlock,
  ORDER_ACTION_LABELS
} from '@/domain/order-actions';
import type { Order, OrderAction, OrderTransitionExpectation } from '@/domain/types';
import type { OrderListFilter } from '@/services/business-api';
import { cn } from '@/lib/cn';
import { buildWhatsAppUrl } from '@/lib/whatsapp-url';
import { getBusinessApi } from '@/services/business-api';

import { packingDraftDirty, packingValues, type PackingDraftStore } from '@/domain/packing-draft';
import { can } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthProvider';
import { cleanSearchTerm } from '@/lib/search';
import { AppError } from '@/domain/errors';
import { useAppConfirmation } from '@/components/ui/AppConfirmation';
import { ClearSearchButton } from '@/components/ui/ClearSearchButton';

const normalizeOrderSearch = (value: unknown): string =>
  cleanSearchTerm(value).replace(/^(?:pedido\s*)?#\s*(\d+)$/i, '$1');

const needsUnverifiedBagConfirmation = (order: Order, action: OrderAction): boolean =>
  order.packingTracked === false && order.fulfillmentState === 'pending' &&
  (action === 'mark_delivered' || action === 'mark_shipped');

export default function OrdersPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const askConfirmation = useAppConfirmation();
  const [shippingEditing, setShippingEditing] = useState<Record<string, ShippingEditorState>>({});
  const notifyShippingEditing = useCallback((id: string, state: ShippingEditorState) => setShippingEditing(current =>
    current[id]?.editing === state.editing && current[id]?.saving === state.saving && current[id]?.dirty === state.dirty ? current : { ...current, [id]: state }), []);
  const hasShippingEdits = Object.values(shippingEditing).some(value => value.editing);
  const hasShippingChanges = Object.values(shippingEditing).some(value => value.dirty);
  const hasShippingSaves = Object.values(shippingEditing).some(value => value.saving);
  const [draftStore] = useState<PackingDraftStore>(() => new Map());
  const [draftEpoch, setDraftEpoch] = useState(0);
  const notifyDraft = useCallback(() => setDraftEpoch(epoch => epoch + 1), []);
  const unsaved = [...draftStore.values()].filter(draft => draft.saving || packingDraftDirty(draft));
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      const samePage = current.pathname === next.pathname;
      const sameSearch = normalizeOrderSearch((current.search as {search?: unknown} | undefined)?.search) ===
        normalizeOrderSearch((next.search as {search?: unknown} | undefined)?.search);
      if ((samePage && sameSearch) || (!unsaved.length && !hasShippingChanges && !hasShippingSaves)) return false;
      const saving = hasShippingSaves || unsaved.some(draft => draft.saving);
      const destination = samePage ? 'cambiar de vista en Pedidos' : 'salir de Pedidos';
      const accepted = await askConfirmation({
        title: saving ? 'El guardado ya comenzó' : '¿Descartar los cambios?',
        description: saving
          ? 'Salir no cancela el guardado. Revisá el pedido al volver antes de guardar o cobrar otra vez. Los demás cambios sin guardar se descartarán.'
          : hasShippingChanges ? (unsaved.length
            ? `Hay una edición de envío y conteos de bolsitas sin guardar. Podés seguir editando o descartar estos cambios para ${destination}.`
            : `Hay una edición de envío sin guardar. Podés seguir editando o descartar los cambios para ${destination}.`)
            : `Hay conteos de bolsitas sin guardar. Podés seguir editando o descartarlos para ${destination}.`,
        ...(saving ? { confirmLabel: 'Salir', cancelLabel: 'Seguir esperando' } : {})
      });
      if (accepted && samePage) {
        setExpanded(null);
        for (const draft of unsaved) if (!draft.saving) {
          draftStore.set(draft.baseline.id, { baseline: draft.baseline, values: packingValues(draft.baseline) });
        }
        if (unsaved.some(draft => !draft.saving)) notifyDraft();
      }
      return !accepted;
    },
    enableBeforeUnload: unsaved.length > 0 || hasShippingChanges || hasShippingSaves
  });
  const [page, setPage] = useState(1);
  const routeSearchParams = useSearch({ strict: false }) as { search?: string | number } | undefined;
  const initialSearch = useMemo(() => {
    if (routeSearchParams?.search !== undefined && routeSearchParams?.search !== null) {
      return normalizeOrderSearch(routeSearchParams.search);
    }
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return normalizeOrderSearch(params.get('search'));
    }
    return '';
  }, [routeSearchParams?.search]);

  const [search, setSearch] = useState(initialSearch);
  const [filter, setFilter] = useState<OrderListFilter>(() => {
    return initialSearch ? 'all' : 'pending';
  });

  const previousRouteSearch = useRef(routeSearchParams?.search);
  useEffect(() => {
    if (routeSearchParams?.search != null || previousRouteSearch.current != null) {
      const cleaned = normalizeOrderSearch(routeSearchParams?.search);
      setSearch(cleaned);
      setFilter(cleaned ? 'all' : 'pending');
    }
    previousRouteSearch.current = routeSearchParams?.search;
  }, [routeSearchParams?.search]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const [successNotice, setSuccessNotice] = useState<{ order: Order; completed: boolean; message: string } | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const focusedNotice = useRef<typeof successNotice>(null);
  const [showSecondaryActions, setShowSecondaryActions] = useState<Record<string, boolean>>({});
  const [confirmAction, setConfirmAction] = useState<{ order: Order; action: OrderAction; operationId: string } | null>(null);

  const openConfirmation = (order: Order, action: OrderAction) => {
    setMutationError(null);
    setConfirmAction({ order: structuredClone(order), action, operationId: crypto.randomUUID() });
  };

  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => { setPage(1); setDebouncedSearch(normalizeOrderSearch(search)); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const settingsQuery = useBusinessQuery({
    queryKey: queryKeys.settings,
    queryFn: (api) => api.getSettings()
  });
  const ordersQuery = useBusinessQuery({
    queryKey: [...queryKeys.orders(page), debouncedSearch, filter],
    refetchOnWindowFocus: 'always',
    queryFn: (api) => api.listOrders(page, 50, debouncedSearch, filter)
  });
  const searchUnsettled = normalizeOrderSearch(search) !== debouncedSearch;
  const orderLookupPending = searchUnsettled || ordersQuery.isPending;

  const transition = useMutation({
    mutationFn: async (variables: { orderId: string; action: OrderAction; expected?: OrderTransitionExpectation }) =>
      {
        if (shippingEditing[variables.orderId]?.editing) throw new AppError('business', 'Hay una edición de envío sin guardar.', { nextAction: 'Guardá o cancelá la edición antes de cambiar el estado del pedido.' });
        const draft = draftStore.get(variables.orderId);
        if (draft && (draft.saving || packingDraftDirty(draft))) throw new AppError('business', 'Hay un conteo de bolsita sin guardar.', { nextAction: 'Guardá o descartá ese conteo antes de cambiar el estado del pedido.' });
        const api = await getBusinessApi();
        return variables.expected
          ? api.transitionOrder(variables.orderId, variables.action, variables.expected)
          : api.transitionOrder(variables.orderId, variables.action);
      },
    onSuccess: async (order, variables) => {
      setMutationError(null);
      const cancelled = order.orderState === 'cancelled';
      const isGift = order.paymentState === 'gifted';
      const completed = cancelled || ((isGift || order.paymentState === 'paid') && order.fulfillmentState === 'delivered');
      const state =
        variables.action === 'mark_ready'
          ? 'marcado como listo para entrega'
          : variables.action === 'mark_paid'
            ? 'cobrado'
            : variables.action === 'mark_at_cost'
              ? 'cobrado a precio de costo'
              : variables.action === 'mark_gifted'
                ? 'registrado como regalo / cortesía'
                : variables.action === 'mark_delivered'
                  ? 'entregado'
                  : 'actualizado';
      const reversed = isOrderReversal(variables.action);
      if (reversed && filter === 'completed') {
        setPage(1); setFilter('all'); setSearch(String(order.number));
        setDebouncedSearch(String(order.number)); setExpanded(order.id);
      }
      const reversalMessage = variables.action === 'reverse_payment'
        ? `Pedido #${order.number}: cobro deshecho. Quedó pendiente de cobro.`
        : variables.action === 'reverse_delivery' && order.fulfillmentState === 'shipped'
          ? `Pedido #${order.number}: entrega deshecha. Sigue enviado; el stock no cambió.`
          : `Pedido #${order.number}: ${variables.action === 'reverse_shipment' ? 'envío deshecho' : 'entrega deshecha'}. La mercadería volvió a quedar reservada.`;
      setSuccessNotice({
        order,
        completed,
        message: reversed ? reversalMessage : completed
          ? `Pedido #${order.number} ${cancelled ? 'cancelado' : isGift ? 'registrado como regalo / cortesía' : 'completado'}. Lo encontrás en Completados.`
          : `Pedido #${order.number} ${state}.`
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.productReservationsRoot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products }),
        queryClient.invalidateQueries({ queryKey: queryKeys.storefrontProducts }),
        queryClient.invalidateQueries({ queryKey: ['storefront-product'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.purchasesRoot }),
        queryClient.invalidateQueries({ queryKey: ['paid-orders'] }),
        queryClient.invalidateQueries({ queryKey: ['analytics'] }),
        queryClient.invalidateQueries({ queryKey: ['customers'] }),
        queryClient.invalidateQueries({ queryKey: ['movements'] })
      ]);
    },
    onError: async error => {
      setSuccessNotice(null); setMutationError(error);
      await queryClient.invalidateQueries({ queryKey: queryKeys.ordersRoot });
    }
  });

  useEffect(() => {
    if (successNotice && successNotice !== focusedNotice.current && !confirmAction && !transition.isPending) {
      focusedNotice.current = successNotice;
      noticeRef.current?.focus();
    }
  }, [successNotice, confirmAction, transition.isPending]);

  const items = ordersQuery.data?.items ?? [];

  const pendingCount = ordersQuery.data?.pendingTotal ?? 0;
  const completedCount = ordersQuery.data?.completedTotal ?? 0;
  const preparingCount = ordersQuery.data?.preparingTotal ?? 0;
  const readyPickupCount = ordersQuery.data?.readyPickupTotal ?? 0;
  const filteredOrders = items;

  const autoExpandedSearch = useRef<string | null>(null);
  // Open a new single-result search once; respect subsequent manual collapse and refreshes.
  useEffect(() => {
    const result = filteredOrders.length === 1 ? filteredOrders[0] : undefined;
    const signature = debouncedSearch && result ? JSON.stringify([debouncedSearch, result.id]) : null;
    if (signature && signature !== autoExpandedSearch.current) setExpanded(result!.id);
    autoExpandedSearch.current = signature;
  }, [debouncedSearch, filteredOrders]);

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
            disabled={hasShippingEdits}
            onClick={() => { setPage(1); setSearch(''); setFilter('pending'); }}
          >
            Pendientes de acción <span className="ml-1 opacity-85">• {pendingCount}</span>
          </button>
          <button
            type="button"
            className={cn(
              'min-h-11 rounded-full px-4 text-[14.5px] font-bold transition',
              filter === 'preparing' ? 'bg-brand-600 text-white shadow-sm font-black' : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25'
            )}
            disabled={hasShippingEdits}
            onClick={() => { setPage(1); setSearch(''); setFilter('preparing'); }}
          >
            En preparación • {preparingCount}
          </button>
          <button
            type="button"
            className={cn(
              'min-h-11 rounded-full px-4 text-[14.5px] font-bold transition',
              filter === 'ready_pickup' ? 'bg-brand-600 text-white shadow-sm font-black' : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25'
            )}
            disabled={hasShippingEdits}
            onClick={() => { setPage(1); setSearch(''); setFilter('ready_pickup'); }}
          >
            Listos para retirar • {readyPickupCount}
          </button>
          <button
            type="button"
            className={cn(
              'min-h-11 rounded-full px-4 text-[14.5px] font-bold transition select-none',
              filter === 'completed'
                ? 'bg-brand-600 text-white shadow-sm font-black'
                : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25'
            )}
            disabled={hasShippingEdits}
            onClick={() => { setPage(1); setSearch(''); setFilter('completed'); }}
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
            disabled={hasShippingEdits}
            onClick={() => { setPage(1); setSearch(''); setFilter('all'); }}
          >
            Todos ({pendingCount + completedCount})
          </button>
        </div>

        <div className="relative min-w-48 sm:w-72">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-ink-600" />
          <input
            type="search"
            placeholder="Buscar #pedido, cliente o teléfono…"
            value={search}
            disabled={hasShippingEdits}
            onChange={(e) => {
              const val = e.target.value.replace(/^["'“”`\\]+|["'“”`\\]+$/g, '');
              if (hasShippingEdits) return;
              setSearch(val);
              if (val.trim()) setFilter('all');
            }}
            className="h-11 w-full rounded-full border border-ink-950/15 bg-white pl-10 pr-10 text-[14.5px] font-semibold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <ClearSearchButton value={search} disabled={hasShippingEdits} hidden={searchUnsettled} onClear={()=>setSearch('')} />
          {searchUnsettled ? <span role="status" className="absolute right-3.5 top-1/2 -translate-y-1/2">
            <span className="block size-4 animate-spin rounded-full border-2 border-ink-950/15 border-t-ink-700" aria-hidden="true" />
            <span className="sr-only">Buscando pedidos…</span>
          </span> : null}
        </div>
      </div>

      {unsaved.length ? <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
        <p className="font-bold">Tenés armados sin guardar. Se conservan al cerrar las acciones o cambiar los filtros de Pedidos.</p>
        <div className="mt-2 flex flex-wrap gap-2">{unsaved.map(draft => {
          const latest = ordersQuery.data?.items.find(order => order.id === draft.baseline.id);
          const editorUnavailable = !latest || latest.orderState !== 'confirmed' || latest.fulfillmentState !== 'pending';
          return <div key={draft.baseline.id} className="flex flex-wrap gap-2"><Button variant="secondary" size="sm"
            onClick={() => { setPage(1); setFilter('all'); setSearch(String(draft.baseline.number)); setExpanded(draft.baseline.id); }}>
            Ver pedido #{draft.baseline.number}{draft.saving ? ' · Guardando…' : ''}
          </Button>{editorUnavailable && !draft.saving ? <Button variant="ghost" size="sm" onClick={async () => {
            if (await askConfirmation({ title: '¿Descartar el conteo?', description: `Se descartarán las cantidades sin guardar del pedido #${draft.baseline.number}.` })) {
              const baseline = latest ?? draft.baseline;
              draftStore.set(baseline.id, { baseline, values: packingValues(baseline) }); notifyDraft();
            }
          }}>Descartar conteo #{draft.baseline.number}</Button> : null}</div>;
        })}</div>
      </div> : null}
      {successNotice ? (
        <div ref={noticeRef} tabIndex={-1} className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
          <p role="status" className="flex-1 font-semibold">{successNotice.message}</p>
          <Button variant="secondary" size="sm" onClick={() => {
            const order = successNotice.order;
            setPage(1); setFilter('all'); setSearch(String(order.number));
            setDebouncedSearch(String(order.number)); setExpanded(order.id); setSuccessNotice(null);
          }}>Ver pedido</Button>
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
              {debouncedSearch ? 'No encontramos pedidos con esa búsqueda. Probá otro número o nombre.' : 'No hay pedidos en esta vista.'}
            </div>
          ) : (
            filteredOrders.map((order) => {
              const open = expanded === order.id;
              const isSelected = open;
              const isCompleted =
                order.orderState === 'cancelled' ||
                (order.fulfillmentState === 'delivered' && (order.paymentState === 'paid' || order.paymentState === 'gifted'));
              const actions = availableOrderActions(order);
              const cancellationBlock = orderCancellationBlock(order);
              const packingDraft = draftStore.get(order.id);
              const actionEditsPending = shippingEditing[order.id]?.editing || Boolean(packingDraft && (packingDraft.saving || packingDraftDirty(packingDraft)));
              const hasPhysicalUnitsToPack = order.items.some(item =>
                (item.physicalReservedQuantity ?? item.quantity) > 0 || (item.packedQuantity ?? 0) > 0
              );
              const showMore = showSecondaryActions[order.id] ?? false;

              return (
                <article
                  key={order.id}
                  className={cn(
                    'overflow-hidden rounded-2xl transition-all duration-150',
                    isSelected
                      ? 'border border-ink-950/20 bg-white shadow-md shadow-ink-950/4 border-l-[3.5px] border-l-ink-900'
                      : isCompleted
                        ? 'border border-ink-950/6 bg-cream-50/50 shadow-none hover:border-ink-950/15'
                        : 'border border-ink-950/8 bg-white shadow-xs hover:border-ink-950/15 hover:shadow-2xs'
                  )}
                >
                  {/* Prevent actions on the previous results while the next search resolves. */}
                  <fieldset disabled={orderLookupPending || transition.isPending} className="contents">
                  <button
                    type="button"
                    className={cn(
                      'grid w-full min-h-[4.25rem] gap-3 p-4 text-left sm:grid-cols-[5.5rem_1.2fr_1.2fr_auto] sm:items-center sm:px-6 sm:py-4 transition-colors disabled:cursor-wait disabled:opacity-60',
                      isSelected
                        ? 'bg-white border-b border-ink-950/6'
                        : 'hover:bg-cream-50/60'
                    )}
                    disabled={hasShippingSaves}
                    onClick={async () => {
                      if (hasShippingSaves) return;
                      if (hasShippingChanges && !await askConfirmation({ title: '¿Descartar la edición de envío?',
                        description: open ? 'Tenés cambios de envío sin guardar. Descartarlos cierra las acciones de este pedido.'
                          : `Tenés cambios de envío sin guardar. Descartarlos cierra esa edición y abre el pedido #${order.number}.` })) return;
                      setExpanded(open ? null : order.id);
                    }}
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
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition select-none',
                          isSelected
                            ? 'bg-cream-200/90 text-ink-950 border border-ink-950/10 shadow-2xs'
                            : 'bg-cream-100/80 text-ink-700 border border-ink-950/6 hover:bg-cream-200 hover:text-ink-950'
                        )}
                      >
                        {isSelected ? 'Ocultar acciones' : 'Ver pedido y acciones'}
                        <ChevronDown
                          className={cn(
                            'size-3.5 transition-transform duration-200',
                            isSelected ? 'rotate-180 text-ink-800' : 'text-ink-500'
                          )}
                        />
                      </span>
                    </div>
                  </button>

                  {open ? (
                    <div className="border-t border-ink-950/6 bg-cream-50/25 p-5 sm:p-6">
                      {order.orderState === 'cancelled' ? (
                        <div className="mb-5 rounded-2xl bg-rose-50 border border-rose-200 p-4 text-rose-950 flex flex-wrap items-center justify-between gap-3 shadow-xs">
                          <div className="flex items-center gap-3">
                            <div className="grid size-9 place-items-center rounded-xl bg-rose-100 text-rose-700 shrink-0">
                              <AlertTriangle className="size-5" />
                            </div>
                            <div>
                              <p className="font-black text-[15px] text-rose-950">Pedido cancelado</p>
                              <p className="text-xs text-rose-800 font-medium">Este pedido está cancelado. El stock reservado fue liberado y no requiere preparación ni cobro.</p>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
                        {/* Detalle de productos y entrega */}
                        <div className="min-w-0 space-y-4">
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

                          {order.orderState === 'confirmed' && order.fulfillmentState === 'pending' ? (
                            <OrderPackingEditor order={order} draftStore={draftStore} draftEpoch={draftEpoch} onDraftChange={notifyDraft} canReceivePurchases={can(user, 'manage_purchases')} />
                          ) : null}

                          {/* Resumen de Pago y Entrega */}
                          <div className={cn('grid gap-3', order.paymentState !== 'gifted' && 'sm:grid-cols-2')}>
                            {/* Card Pago */}
                            {order.paymentState !== 'gifted' ? <div className="rounded-2xl bg-white p-4 sm:p-5 border border-ink-950/8 text-[14px] space-y-3 shadow-xs">
                              <div className="flex items-center justify-between border-b border-ink-950/6 pb-2.5">
                                <div className="flex items-center gap-2">
                                  <span className="grid size-7 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
                                    <Banknote className="size-4" />
                                  </span>
                                  <p className="text-[12px] font-black uppercase tracking-wider text-ink-600">Pago</p>
                                </div>
                              </div>
                              <div className="space-y-1">
                                <span className="text-[11px] font-black uppercase tracking-wider text-ink-500 block">
                                  Medio de pago
                                </span>
                                <p className="font-black text-ink-950 text-[15px]">
                                  {order.paymentMethod === 'gift'
                                    ? 'Regalo / Cortesía'
                                    : order.paymentMethod === 'cash'
                                      ? 'Efectivo'
                                      : 'Transferencia bancaria'}
                                </p>
                              </div>
                            </div> : null}

                            {/* Card Entrega */}
                            {(() => {
                              const shippingInfo = parseShippingAddress(order.shippingAddress);
                              return (
                                <div className="rounded-2xl bg-white p-4 sm:p-5 border border-ink-950/8 text-[14px] space-y-3 shadow-xs">
                                  <div className="flex items-center justify-between border-b border-ink-950/6 pb-2.5">
                                    <div className="flex items-center gap-2">
                                      <span className="grid size-7 place-items-center rounded-lg bg-brand-50 text-brand-700">
                                        {order.deliveryMethod === 'pickup' ? (
                                          <Store className="size-4" />
                                        ) : (
                                          <Truck className="size-4" />
                                        )}
                                      </span>
                                      <p className="text-[12px] font-black uppercase tracking-wider text-ink-600">Entrega</p>
                                    </div>
                                    <span
                                      className={cn(
                                        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-black border',
                                        order.deliveryMethod === 'pickup'
                                          ? 'bg-cream-100 text-ink-800 border-ink-950/8'
                                          : 'bg-brand-50 text-brand-900 border-brand-200'
                                      )}
                                    >
                                      {order.deliveryMethod === 'pickup' ? 'Retiro en local' : 'Envío a domicilio'}
                                    </span>
                                  </div>

                                  {order.deliveryMethod === 'shipping' ? (
                                    <div className="space-y-2.5">
                                      {shippingInfo.streetAddress ? (
                                        <div>
                                          <span className="text-[11px] font-black uppercase tracking-wider text-ink-500 block">
                                            Dirección de entrega
                                          </span>
                                          <p className="font-black text-ink-950 text-[15px] mt-0.5 leading-snug">
                                            {shippingInfo.streetAddress}
                                          </p>
                                        </div>
                                      ) : null}

                                      {shippingInfo.trackingEmail ? (
                                        <div className="rounded-xl bg-sky-50/90 border border-sky-200/80 p-2.5 flex items-start gap-2.5">
                                          <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-sky-200/70 text-sky-800 mt-0.5">
                                            <Mail className="size-3.5" />
                                          </span>
                                          <div className="min-w-0 flex-1">
                                            <span className="text-[10.5px] font-black uppercase tracking-wider text-sky-800 block">
                                              Email de seguimiento (Nacional)
                                            </span>
                                            <p className="text-xs font-bold text-sky-950 select-all break-all mt-0.5">
                                              {shippingInfo.trackingEmail}
                                            </p>
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800">
                                          <span className="size-1.5 rounded-full bg-emerald-600" />
                                          <span>Zona local (Santa Fe y cercanías)</span>
                                        </div>
                                      )}

                                      {order.shippingType ? (
                                        <div className="flex items-center justify-between text-xs pt-1.5 border-t border-ink-950/6">
                                          <span className="text-ink-500 font-semibold">Tipo de servicio:</span>
                                          <span className="inline-flex items-center rounded-md bg-cream-100 px-2 py-0.5 font-bold text-ink-800 text-[11.5px]">
                                            {order.shippingType === 'express' ? 'Express prioritario' : 'Estándar'}
                                          </span>
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })()}
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

                        {/* Una sola guía operativa: los estados permanecen en la cabecera. */}
                        <div role="region" aria-label={`${order.orderState === 'cancelled' ? 'Estado' : 'Qué sigue'} del pedido #${order.number}`} className="flex h-fit flex-col gap-3 rounded-2xl border border-ink-950/8 bg-white p-5 shadow-sm sm:p-6">
                          <div className="border-b border-ink-950/6 pb-2">
                            <p className="text-[12.5px] font-black uppercase tracking-wider text-ink-700">
                              {order.orderState === 'cancelled' ? 'Estado del pedido' : 'Qué sigue'}
                            </p>
                          </div>

                          {order.orderState === 'cancelled' ? (
                            <div className="rounded-xl bg-rose-50 border border-rose-200/80 p-4 text-center space-y-1">
                              <p className="text-xs text-rose-700 font-medium">No requiere acciones pendientes.</p>
                            </div>
                          ) : (
                            <>
                              {/* Una sola indicación para el bloqueo o la próxima preparación. */}
                          {order.fulfillmentState === 'pending' && order.stockReadiness === 'waiting_incoming' ? (
                            <div className="rounded-xl bg-brand-50 border border-brand-200 p-3 text-xs font-semibold text-brand-950 space-y-1">
                              <p className="font-black flex items-center gap-1.5 text-brand-900">
                                <Package className="size-4 shrink-0 text-brand-600" /> Mercadería en camino
                              </p>
                              <p className="text-brand-800">
                                {order.expectedArrivalAt
                                  ? `Llegada estimada: ${new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(order.expectedArrivalAt))}.`
                                  : 'Stock asignado a compras en camino.'}
                              </p>
                            </div>
                          ) : order.fulfillmentState === 'pending' && order.stockReadiness === 'uncovered' ? (
                            <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs font-semibold text-rose-950 space-y-1">
                              <p className="font-black flex items-center gap-1.5 text-rose-900">
                                <span>🔴</span> Sin reposición confirmada
                              </p>
                              <p className="text-rose-800">
                                Hay unidades pendientes sin una compra que las reponga. Revisá el detalle de stock del pedido y acordá una reposición, un reemplazo o la cancelación con el cliente.
                              </p>
                            </div>
                          ) : order.fulfillmentState === 'pending' && order.preparationState !== 'ready' && actions.includes('mark_ready') ? (
                            <Button
                              variant="dark"
                              size="md"
                              className="w-full justify-center text-[14px] font-black shadow-sm"
                              loading={
                                transition.isPending &&
                                transition.variables?.action === 'mark_ready'
                              }
                              onClick={() =>
                                transition.mutate({ orderId: order.id, action: 'mark_ready', expected: { actionRevision: order.actionRevision ?? 0 } })
                              }
                            >
                              <PackageCheck className="size-4 mr-1.5 shrink-0" />
                              Marcar listo para entregar
                            </Button>
                          ) : order.fulfillmentState === 'pending' && order.preparationState !== 'ready' ? (
                            <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-950">
                              {hasPhysicalUnitsToPack
                                ? 'Revisá la bolsita y registrá todas las unidades antes de marcar el pedido como listo.'
                                : 'No hay unidades físicas reservadas para armar este pedido. Revisá sus reservas en Inventario.'}
                            </p>
                          ) : null}

                          <OrderShippingFeeEditor order={order} canEdit={can(user, 'manage_pricing')} disabled={transition.isPending} onEditingChange={notifyShippingEditing} />
                          {order.stockSource === 'incoming_only' && order.stockReadiness === 'waiting_incoming' ? <p className="text-xs text-ink-700">Este pedido reserva exclusivamente mercadería en camino.</p> : null}
                          {/* El cobro es independiente de la preparación. */}
                          {actions.includes('mark_paid') ? (
                            <div className="space-y-2">
                              <Button
                                variant={order.preparationState === 'ready' ? 'dark' : 'secondary'}
                                size="md"
                                className="w-full justify-center text-[14px] font-black shadow-sm"
                                loading={
                                  transition.isPending &&
                                  transition.variables?.action === 'mark_paid'
                                }
                                disabled={shippingEditing[order.id]?.editing || shippingFeeNeedsReview(order)}
                                onClick={() => openConfirmation(order, 'mark_paid')}
                              >
                                Marcar como cobrado
                              </Button>

                              {actions.includes('mark_at_cost') || actions.includes('mark_gifted') ? (
                                <div
                                  className={`grid gap-2 pt-0.5 ${
                                    actions.includes('mark_at_cost') && actions.includes('mark_gifted')
                                      ? 'grid-cols-2'
                                      : 'grid-cols-1'
                                  }`}
                                >
                                  {actions.includes('mark_at_cost') ? (
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      size="sm"
                                      disabled={shippingEditing[order.id]?.editing || shippingFeeNeedsReview(order)}
                                      className="w-full justify-center text-amber-900 border-amber-200 bg-amber-50/70 hover:bg-amber-100 hover:text-amber-950 hover:border-amber-300 font-bold text-xs py-2 h-auto"
                                      onClick={() => openConfirmation(order, 'mark_at_cost')}
                                    >
                                      <Tag className="size-3.5 mr-1 text-amber-600 shrink-0" />
                                      <span>Al costo</span>
                                    </Button>
                                  ) : null}
                                  {actions.includes('mark_gifted') ? (
                                    <Button
                                      type="button"
                                      variant="secondary"
                                      size="sm"
                                      disabled={shippingEditing[order.id]?.editing}
                                      className="w-full justify-center text-purple-900 border-purple-200 bg-purple-50/70 hover:bg-purple-100 hover:text-purple-950 hover:border-purple-300 font-bold text-xs py-2 h-auto"
                                      onClick={() => openConfirmation(order, 'mark_gifted')}
                                    >
                                      <Gift className="size-3.5 mr-1 text-purple-600 shrink-0" />
                                      <span>Regalar</span>
                                    </Button>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {/* Se conserva la entrega directa que ya permitía la app. */}
                          {actions.includes('mark_delivered') ? (
                            <Button
                              variant={order.paymentState === 'paid' && order.preparationState === 'ready' ? 'dark' : 'secondary'}
                              size="md"
                              className="w-full"
                              loading={
                                transition.isPending &&
                                transition.variables?.action === 'mark_delivered'
                              }
                              onClick={() => {
                                if (needsUnverifiedBagConfirmation(order, 'mark_delivered')) {
                                  openConfirmation(order, 'mark_delivered');
                                } else {
                                  transition.mutate({ orderId: order.id, action: 'mark_delivered', expected: { actionRevision: order.actionRevision ?? 0 } });
                                }
                              }}
                            >
                              Marcar como entregado
                            </Button>
                          ) : order.fulfillmentState === 'delivered' ? (
                            <p className="text-[13px] font-semibold text-ink-700">{order.paymentState === 'pending' ? 'Entregado. Falta registrar el cobro.' : 'Pedido entregado. Podés corregir sus registros en Más opciones.'}</p>
                          ) : null}
                        </>
                      )}

                          {/* Acciones secundarias (cancelar, envío intermedio, reintegro) */}
                          {order.orderState !== 'cancelled' && (cancellationBlock || actions.filter((a) => a !== 'mark_ready' && a !== 'mark_paid' && a !== 'mark_delivered' && a !== 'mark_gifted' && a !== 'mark_at_cost').length > 0) ? (
                            <div>
                              <button
                                type="button"
                                onClick={() =>
                                  setShowSecondaryActions((prev) => ({
                                    ...prev,
                                    [order.id]: !prev[order.id]
                                  }))
                                }
                                aria-expanded={showMore}
                                aria-controls={`order-options-${order.id}`}
                                className="mt-1 flex min-h-11 items-center justify-center gap-1 text-[13.5px] font-bold text-ink-700 hover:text-ink-950 w-full py-1"
                              >
                                <MoreHorizontal className="size-4" />
                                {showMore ? 'Menos opciones' : 'Más opciones'}
                              </button>

                              {showMore ? (
                                <div id={`order-options-${order.id}`} className="mt-2 space-y-2 border-t border-ink-950/8 pt-2">
                                  {actionEditsPending ? <p className="text-sm text-ink-700">Guardá o descartá la edición del envío o el conteo de la bolsita antes de cambiar el pedido.</p> : null}
                                  {actions
                                    .filter((a) => a !== 'mark_ready' && a !== 'mark_paid' && a !== 'mark_delivered' && a !== 'mark_gifted' && a !== 'mark_at_cost')
                                    .map((secAction) => {
                                      const isDestructive = secAction === 'cancel' || secAction === 'mark_refunded' || isOrderReversal(secAction);
                                      return (
                                        <Button
                                          key={secAction}
                                          disabled={actionEditsPending}
                                          variant="ghost"
                                          size="sm"
                                          className={cn(
                                            'min-h-11 w-full justify-start whitespace-normal text-left text-sm font-bold',
                                            secAction === 'cancel'
                                              ? 'text-rose-700 hover:bg-rose-50 hover:text-rose-800'
                                              : 'text-ink-800 hover:text-ink-950'
                                          )}
                                          loading={
                                            transition.isPending &&
                                            transition.variables?.action === secAction
                                          }
                                          onClick={() => {
                                            if (isDestructive || needsUnverifiedBagConfirmation(order, secAction)) {
                                              openConfirmation(order, secAction);
                                            } else {
                                              transition.mutate({
                                                orderId: order.id,
                                                action: secAction,
                                                expected: { actionRevision: order.actionRevision ?? 0 }
                                              });
                                            }
                                          }}
                                        >
                                          {isOrderReversal(secAction) ? <Undo2 className="size-4 shrink-0" aria-hidden="true" /> : null}
                                          {ORDER_ACTION_LABELS[secAction]}
                                        </Button>
                                      );
                                    })}
                                  {cancellationBlock ? <div className="border-t border-ink-950/8 pt-3">
                                    <Button variant="ghost" size="sm" disabled aria-describedby={`cancel-help-${order.id}`} className="min-h-11 w-full justify-start text-sm">Cancelar pedido</Button>
                                    <p id={`cancel-help-${order.id}`} className="mt-1 text-sm leading-relaxed text-ink-700">{cancellationBlock}</p>
                                  </div> : null}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                  </fieldset>
                </article>
              );
            })
          )}

          {confirmAction ? (
            <Modal
              isOpen={Boolean(confirmAction)}
              onClose={() => { if (!transition.isPending) setConfirmAction(null); }}
              maxWidth="md"
              ariaLabelledBy="confirm-order-action-title"
              ariaDescribedBy="confirm-order-action-description"
            >
              <div className="flex items-start gap-4">
                <div
                  className={cn(
                    'grid size-12 shrink-0 place-items-center rounded-2xl',
                    confirmAction.action === 'mark_gifted'
                      ? 'bg-purple-100 text-purple-700'
                      : confirmAction.action === 'mark_at_cost'
                        ? 'bg-amber-100 text-amber-800'
                        : confirmAction.action === 'cancel'
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-amber-100 text-amber-800'
                  )}
                >
                  {isOrderReversal(confirmAction.action) ? <Undo2 className="size-6" aria-hidden="true" /> : confirmAction.action === 'mark_gifted' ? (
                    <Gift className="size-6" />
                  ) : confirmAction.action === 'mark_at_cost' ? (
                    <Tag className="size-6 text-amber-700" />
                  ) : (
                    <AlertTriangle className="size-6" />
                  )}
                </div>
                <div className="min-w-0 space-y-1 break-words">
                  <h3 id="confirm-order-action-title" className="font-display text-xl font-black text-ink-950">
                    {isOrderReversal(confirmAction.action)
                      ? `¿${ORDER_ACTION_LABELS[confirmAction.action]} del pedido #${confirmAction.order.number}?`
                      : confirmAction.action === 'mark_gifted'
                      ? `¿Registrar pedido #${confirmAction.order.number} como regalo / cortesía?`
                      : confirmAction.action === 'mark_at_cost'
                        ? `¿Cobrar pedido #${confirmAction.order.number} a precio de costo?`
                        : confirmAction.action === 'mark_paid'
                          ? `¿Registrar el cobro del pedido #${confirmAction.order.number}?`
                        : confirmAction.action === 'cancel'
                          ? `¿Cancelar pedido #${confirmAction.order.number}?`
                          : confirmAction.action === 'mark_delivered'
                            ? `¿Entregar pedido #${confirmAction.order.number}?`
                            : confirmAction.action === 'mark_shipped'
                              ? `¿Enviar pedido #${confirmAction.order.number}?`
                          : `¿Registrar reintegro para pedido #${confirmAction.order.number}?`}
                  </h3>
                  <p className="text-sm font-semibold text-ink-800">
                    {confirmAction.action === 'mark_gifted' ? 'Beneficiario' : 'Cliente'}: {confirmAction.order.customerName}{' '}
                    {confirmAction.action === 'mark_at_cost'
                      ? `(Total al costo: ${formatMoney((confirmAction.order.costTotalCents ?? 0) + (confirmAction.order.shippingFeeCents ?? 0))})`
                      : confirmAction.action !== 'mark_gifted'
                        ? `(${formatMoney(confirmAction.order.totalCents)})`
                        : ''}
                  </p>
                </div>
              </div>

              <div id="confirm-order-action-description" className="mt-4 rounded-2xl bg-cream-50 p-4 text-sm text-ink-700 space-y-2">
                {needsUnverifiedBagConfirmation(confirmAction.order, confirmAction.action) ? (
                  <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 font-semibold text-amber-950">
                    La bolsita figura sin verificar en la app. Comprobá físicamente que contiene todas las unidades de este pedido. Si falta algo, volvé y registrá el armado antes de continuar.
                  </p>
                ) : null}
                {confirmAction.action === 'reverse_payment' ? (
                  <>
                    <p>El pedido volverá a <strong>pendiente de cobro</strong>. Se quitarán {formatMoney(confirmAction.order.totalCents)} de las ventas y se actualizarán el margen y el saldo del cliente.</p>
                    <p>Se conservarán los precios acordados, el envío y los costos registrados{confirmAction.order.saleType === 'cost' ? ', incluido el precio al costo' : ''}. La entrega y el stock conservarán su estado.</p>
                    <p className="font-semibold text-ink-950">Esta acción corrige el registro. Si ya recibiste el dinero, acordá y realizá la devolución antes de cancelar el pedido.</p>
                  </>
                ) : confirmAction.action === 'reverse_delivery' && confirmAction.order.shippedAt ? (
                  <>
                    <p>El pedido volverá a <strong>enviado</strong>. La mercadería seguirá fuera del local y el stock no cambiará.</p>
                    <p>Para cancelarlo, después deshacé el envío cuando los productos estén de regreso en el local.</p>
                  </>
                ) : confirmAction.action === 'reverse_delivery' || confirmAction.action === 'reverse_shipment' ? (
                  <>
                    <p>El pedido volverá a <strong>pendiente de entrega</strong>. Sus unidades volverán al stock físico y quedarán <strong>reservadas para este mismo pedido</strong>.</p>
                    <p>Se conservarán el cobro, los costos y el armado guardado. La corrección quedará registrada en los movimientos de inventario.</p>
                    <p className="font-semibold text-ink-950">Confirmá solo si la mercadería está en el local: porque la salida se marcó por error o porque los productos ya volvieron.</p>
                  </>
                ) : confirmAction.action === 'mark_gifted' ? (
                  <>
                    <p>
                      Este pedido se registrará como <strong>regalo / atención de cortesía</strong>:
                    </p>
                    <ul className="list-disc list-inside space-y-1.5 text-ink-800 text-xs">
                      <li><strong>Descontará el stock físico real</strong> del inventario automáticamente.</li>
                      <li><strong>No sumará facturación</strong> (se registrará cobro $ 0).</li>
                      {confirmAction.order.shippingFeeCents > 0 ? <li><strong>Se quitará el envío de {formatMoney(confirmAction.order.shippingFeeCents)}.</strong> El pedido completo será un regalo.</li> : null}
                      <li>En la sección de <strong>Ventas</strong> figurará el costo asumido como <strong>pérdida en rojo</strong> y se deducirá del margen neto.</li>
                      <li>El pedido quedará completado sin generar cobros pendientes.</li>
                    </ul>
                    <p className="text-xs font-semibold text-purple-800 pt-1">
                      🎁 Ideal para suplementos regalados a familiares, embajadores o atenciones comerciales.
                    </p>
                  </>
                ) : confirmAction.action === 'mark_at_cost' ? (
                  <>
                    <p>
                      Este pedido se registrará como <strong>venta al costo</strong>:
                    </p>
                    <ul className="list-disc list-inside space-y-1.5 text-ink-800 text-xs">
                      <li><strong>Cobrará los productos a su costo registrado</strong>, según los lotes asignados al pedido.</li>
                      <li><strong>Total a cobrar al cliente</strong>: <span className="font-bold text-ink-950">{formatMoney((confirmAction.order.costTotalCents ?? 0) + (confirmAction.order.shippingFeeCents ?? 0))}</span> (recupero exacto del costo + envío).</li>
                      <li>Los productos se cobran a su costo registrado. El envío de <strong>{formatMoney(confirmAction.order.shippingFeeCents)}</strong> es ingreso adicional; los gastos del proveedor se descuentan por separado en el balance.</li>
                      <li>El pedido quedará marcado como pagado, y el stock se descontará normalmente al confirmar la entrega.</li>
                    </ul>
                    <p className="text-xs font-semibold text-amber-900 pt-1">
                      🏷️ Ideal para ventas directas a costo de reposición para familiares, socios o personal.
                    </p>
                  </>
                ) : confirmAction.action === 'mark_paid' ? (
                  <p>Confirmá que recibiste <strong>{formatMoney(confirmAction.order.totalCents)}</strong>: productos {formatMoney(confirmAction.order.subtotalCents)} y envío {formatMoney(confirmAction.order.shippingFeeCents)}. Después del cobro no se podrá editar el envío.</p>
                ) : confirmAction.action === 'cancel' ? (
                  <>
                    <p>
                      Al cancelar el pedido, <strong>se liberarán inmediatamente las unidades reservadas en inventario</strong> para que otros clientes puedan comprarlas.
                    </p>
                    <p className="text-xs font-semibold text-rose-900">
                      Si hay productos en una bolsita, devolvelos al estante y registrá cero unidades guardadas antes de cancelar.
                    </p>
                    <p className="text-xs font-semibold text-rose-700">
                      ⚠️ Esta acción cambiará el estado del pedido a «Cancelado».
                    </p>
                  </>
                ) : confirmAction.action === 'mark_delivered' || confirmAction.action === 'mark_shipped' ? (
                  <p>Al confirmar se descontarán las unidades físicas reservadas del inventario.</p>
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

              <div className="mt-6 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5">
                <Button
                  variant="ghost"
                  className="w-full sm:w-auto font-bold"
                  onClick={() => setConfirmAction(null)}
                  disabled={transition.isPending}
                >
                  Volver
                </Button>
                <Button
                  variant="dark"
                  className={cn(
                    'w-full sm:w-auto font-black shadow-sm',
                    confirmAction.action === 'mark_gifted'
                      ? 'bg-purple-700 hover:bg-purple-800 text-white'
                      : confirmAction.action === 'mark_at_cost'
                        ? 'bg-amber-700 hover:bg-amber-800 text-white'
                        : confirmAction.action === 'cancel'
                          ? 'bg-rose-700 hover:bg-rose-800 text-white'
                          : 'bg-amber-800 hover:bg-amber-900 text-white'
                  )}
                  loading={transition.isPending}
                  onClick={async () => {
                    if (transition.isPending) return;
                    transition.mutate({
                      orderId: confirmAction.order.id,
                      action: confirmAction.action,
                      expected: { actionRevision: confirmAction.order.actionRevision ?? 0 },
                      ...(isOrderReversal(confirmAction.action) ? { expected: { operationId: confirmAction.operationId, actionRevision: confirmAction.order.actionRevision ?? 0 } } : {}),
                      ...(['mark_paid','mark_at_cost','mark_gifted'].includes(confirmAction.action) ? {expected: {actionRevision:confirmAction.order.actionRevision ?? 0,shippingFeeRevision:confirmAction.order.shippingFeeRevision ?? 0,totalCents:confirmAction.order.totalCents,costTotalCents:confirmAction.order.costTotalCents}} : {})
                    }, { onSuccess: () => setConfirmAction(null) });
                  }}
                >
                  {isOrderReversal(confirmAction.action)
                    ? `Sí, ${ORDER_ACTION_LABELS[confirmAction.action].toLowerCase()}`
                    : confirmAction.action === 'mark_gifted'
                    ? 'Sí, registrar como regalo'
                    : confirmAction.action === 'mark_at_cost'
                      ? 'Sí, cobrar al costo'
                      : confirmAction.action === 'mark_paid'
                        ? 'Sí, registrar cobro'
                      : confirmAction.action === 'cancel'
                        ? 'Sí, cancelar pedido'
                        : confirmAction.action === 'mark_delivered'
                          ? 'Sí, ya verifiqué y entregar'
                          : confirmAction.action === 'mark_shipped'
                            ? 'Sí, ya verifiqué y enviar'
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
                disabled={page === 1 || hasShippingEdits}
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
                disabled={page * ordersQuery.data.pageSize >= ordersQuery.data.total || hasShippingEdits}
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
