import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowRight, Lock, Minus, Package, Plus } from 'lucide-react';
import { queryKeys } from '@/app/query-keys';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/DataState';
import { sanitizeIntegerInput, isWholeUnitInput } from '@/domain/inventory';
import { packingValues, packingVersion, packingDraftDirty, type PackingDraft, type PackingDraftStore } from '@/domain/packing-draft';
import type { Order } from '@/domain/types';
import { cn } from '@/lib/cn';
import { getBusinessApi } from '@/services/business-api';

export function OrderPackingEditor({ order: receivedOrder, draftStore, draftEpoch, onDraftChange, canReceivePurchases = true }: {
  order: Order;
  draftStore?: PackingDraftStore;
  draftEpoch?: number;
  onDraftChange?: () => void;
  canReceivePurchases?: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraftState] = useState<PackingDraft>(() => draftStore?.get(receivedOrder.id)
    ?? { baseline: receivedOrder, values: packingValues(receivedOrder) });
  const draftRef = useRef(draft);
  const persist = (next: PackingDraft) => {
    draftRef.current = next;
    draftStore?.set(next.baseline.id, next);
    setDraftState(next);
    onDraftChange?.();
  };
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const cached = draftStore?.get(receivedOrder.id);
    if (cached && cached !== draftRef.current) {
      draftRef.current = cached;
      setDraftState(cached);
    }
  }, [draftEpoch, receivedOrder.id]);
  // A successful save is authoritative even while a stale list response is still on screen.
  const order = (receivedOrder.packingRevision ?? 0) < (draft.baseline.packingRevision ?? 0)
    ? draft.baseline : receivedOrder;
  const values = draft.values;
  const conflict = packingVersion(order) !== packingVersion(draft.baseline);
  const physicalSignature = order.items.map(item => `${item.id}:${item.physicalReservedQuantity ?? item.quantity}`).join('|');

  useEffect(() => {
    const current = draftRef.current;
    if (current.baseline.id !== order.id) {
      persist(draftStore?.get(order.id) ?? { baseline: order, values: packingValues(order) });
      setSaved(false);
      return;
    }
    if (current.saving) return;
    if (packingVersion(current.baseline) !== packingVersion(order)) {
      if (!packingDraftDirty(current)) {
        persist({ baseline: order, values: packingValues(order) });
        setSaved(false);
      }
      return;
    }
    const before = current.baseline;
    if (before.items.some(item => (item.physicalReservedQuantity ?? item.quantity) !==
      (order.items.find(next => next.id === item.id)?.physicalReservedQuantity ?? item.quantity))) {
      const nextValues = { ...current.values };
      for (const item of order.items) {
        const old = before.items.find(previous => previous.id === item.id);
        if ((old?.physicalReservedQuantity ?? old?.quantity) === 0 &&
          (item.physicalReservedQuantity ?? item.quantity) > 0 && item.packedQuantity == null && nextValues[item.id] === '0') {
          nextValues[item.id] = '';
        }
      }
      persist({ baseline: order, values: nextValues });
      setSaved(false);
    }
  }, [order.id, order.packingRevision, packingVersion(order), physicalSignature]);

  const hasUnknown = order.items.some(item => item.packedQuantity == null);

  const hasAnyPhysicalStock = order.items.some(item => {
    const physical = item.physicalReservedQuantity ?? item.quantity;
    return Math.min(item.quantity, physical) > 0;
  });

  const hasEmpty = order.items.some(item => {
    const physical = item.physicalReservedQuantity ?? item.quantity;
    const maxPacked = Math.min(item.quantity, physical);
    return maxPacked > 0 && (values[item.id] ?? '') === '';
  });

  const hasInvalid = order.items.some(item => {
    const physical = item.physicalReservedQuantity ?? item.quantity;
    const maxPacked = Math.min(item.quantity, physical);
    const value = values[item.id] ?? '';
    return !isWholeUnitInput(value) || Number(value) > maxPacked;
  });

  const changed = order.items.some(item =>
    (values[item.id] ?? '') !== (item.packedQuantity == null ? '' : String(item.packedQuantity))
  );

  const save = useMutation({
    mutationFn: async (request: PackingDraft) => (await getBusinessApi()).saveOrderPacking(
      request.baseline.id,
      request.baseline.items.map(item => ({ orderItemId: item.id, packedQuantity: Number(request.values[item.id]) })),
      request.baseline.packingRevision ?? 0
    ),
    onSuccess: async (updated, request) => {
      const next = { baseline: updated, values: packingValues(updated) };
      // Also update the page cache if the card was collapsed while the request was in flight.
      draftStore?.set(request.baseline.id, next);
      if (draftRef.current.baseline.id === request.baseline.id) {
        persist(next);
        setSaved(true);
      } else onDraftChange?.();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.ordersRoot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.productReservationsRoot })
      ]);
    },
    onError: (error, request) => {
      const next = { ...request, saving: false, error };
      draftStore?.set(request.baseline.id, next);
      if (draftRef.current.baseline.id === request.baseline.id) persist(next);
      else onDraftChange?.();
    }
  });
  const busy = save.isPending || Boolean(draft.saving);
  const setValues = (update: (current: Record<string, string>) => Record<string, string>) => {
    if (draftRef.current.saving) return;
    setSaved(false);
    save.reset();
    persist({ ...draftRef.current, error: undefined, values: update(draftRef.current.values) });
  };

  const hasIncomingItems = order.items.some(item => (item.incomingQuantity ?? 0) > 0);
  const hasUncoveredItems = order.items.some(item => (item.uncoveredQuantity ?? 0) > 0);
  const allPackedFull = order.items.every(item => Number(values[item.id]) === item.quantity);

  return (
    <section className="rounded-2xl border border-brand-200 bg-brand-50/45 p-4 sm:p-5" aria-label={`Armado del pedido ${order.number}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-black text-ink-950">Armado de la bolsita · Pedido #{order.number}</h3>
          <p className="mt-1 text-[13px] text-ink-700">
            Escribí #{order.number} en la bolsita y registrá solo las unidades que ya apartaste físicamente en el local.
          </p>
        </div>
        {hasUnknown && hasAnyPhysicalStock ? (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-900">
            Armado sin verificar
          </span>
        ) : null}
      </div>

      {conflict ? (
        <div role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p>El pedido cambió mientras lo editabas. Conservamos tu conteo sin guardarlo. Revisá el armado actualizado antes de continuar.</p>
          <Button variant="secondary" size="sm" className="mt-2" disabled={busy}
            onClick={() => { if (window.confirm('¿Descartar tu conteo sin guardar y cargar el armado actualizado?')) {
              persist({ baseline: order, values: packingValues(order) }); setSaved(false); save.reset();
            } }}>Cargar armado actualizado</Button>
        </div>
      ) : null}
      <div className="mt-4 space-y-3">
        {order.items.map(item => {
          const physical = item.physicalReservedQuantity ?? item.quantity;
          const incoming = item.incomingQuantity ?? 0;
          const uncovered = item.uncoveredQuantity ?? 0;
          const maxPacked = Math.min(item.quantity, physical);
          const isLocked = maxPacked === 0 && (values[item.id] ?? '0') === '0';
          const isPartial = physical > 0 && physical < item.quantity;
          const value = values[item.id] ?? (isLocked ? '0' : '');
          const isEmpty = !isLocked && value === '';
          const invalid = !isLocked && value !== '' && (!isWholeUnitInput(value) || Number(value) > maxPacked);

          return (
            <div
              key={item.id}
              className={cn(
                'rounded-xl border p-3.5 transition',
                isLocked ? 'border-ink-950/8 bg-cream-100/50' : 'border-ink-950/8 bg-white'
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 pr-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[14.5px] font-black text-ink-950">{item.productName}</p>
                    {isLocked && incoming > 0 && uncovered > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-900">
                        <AlertTriangle className="size-3 text-rose-600 shrink-0" /> En camino y sin reposición
                      </span>
                    ) : isLocked && incoming > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-900">
                        <Lock className="size-3 text-brand-600 shrink-0" /> En camino
                      </span>
                    ) : isLocked && uncovered > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-bold text-rose-900">
                        <AlertTriangle className="size-3 text-rose-600 shrink-0" /> Faltante de proveedor
                      </span>
                    ) : isPartial ? (
                      <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-900">
                        Disponibilidad parcial
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-0.5 text-[12.5px] font-semibold text-ink-600">
                    Pedido: {item.quantity} u.
                    {physical > 0 ? ` · Reservado físico: ${physical}` : ''}
                    {incoming > 0 ? ` · En camino: ${incoming}` : ''}
                    {uncovered > 0 ? ` · Sin reposición: ${uncovered}` : ''}
                  </p>

                  {isPartial ? (
                    <p className="mt-1 text-[11.5px] font-semibold text-amber-800">
                      Registrá solo lo que ya pusiste en la bolsita, hasta {physical} {physical === 1 ? 'unidad' : 'unidades'}.
                    </p>
                  ) : null}
                </div>

                {isLocked ? (
                  <div className="inline-flex items-center gap-1.5 rounded-xl border border-ink-950/10 bg-cream-200/60 px-3 py-2 text-xs font-bold text-ink-700">
                    <Lock className="size-3.5 text-ink-500" />
                    <span>0 en bolsita</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setSaved(false);
                          save.reset();
                          const current = Number(value || 0);
                          setValues(prev => ({ ...prev, [item.id]: String(Math.max(0, current - 1)) }));
                        }}
                        disabled={!isWholeUnitInput(value) || Number(value) <= 0 || busy}
                        className="inline-flex size-11 items-center justify-center rounded-lg border border-ink-950/15 bg-white text-ink-800 transition hover:bg-cream-100 disabled:opacity-30 disabled:pointer-events-none"
                        aria-label={`Restar una unidad de ${item.productName}`}
                      >
                        <Minus className="size-3.5" />
                      </button>

                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="—"
                        value={value}
                        onFocus={event => event.currentTarget.select()}
                        onBeforeInput={event => {
                          const text = (event.nativeEvent as InputEvent).data;
                          if (typeof text === 'string' && !/^\d*$/.test(text)) event.preventDefault();
                        }}
                        onPaste={event => {
                          if (!/^\d*$/.test(event.clipboardData.getData('text'))) event.preventDefault();
                        }}
                        onChange={event => {
                          // Reject the whole edit; never turn "-1" into 1 or "1,5" into 15.
                          // Empty is a valid draft while the operator replaces a count.
                          if (!/^\d*$/.test(event.target.value)) return;
                          setSaved(false);
                          save.reset();
                          setValues(previous => ({
                            ...previous,
                            [item.id]: sanitizeIntegerInput(event.target.value)
                          }));
                        }}
                        disabled={busy}
                        aria-label={`Unidades en bolsita de ${item.productName}`}
                        aria-describedby={`packing-limit-${item.id}`}
                        aria-invalid={invalid || isEmpty}
                        className={cn(
                          'h-11 w-16 rounded-lg border bg-white px-1 text-center text-sm font-black text-ink-950 focus:outline-none focus:ring-2',
                          invalid
                            ? 'border-rose-500 focus:ring-rose-400/30'
                            : isEmpty
                            ? 'border-amber-400 focus:ring-amber-400/30'
                            : 'border-ink-950/20 focus:ring-brand-500/30'
                        )}
                      />

                      <button
                        type="button"
                        onClick={() => {
                          setSaved(false);
                          save.reset();
                          const current = Number(value || 0);
                          setValues(prev => ({ ...prev, [item.id]: String(Math.min(maxPacked, current + 1)) }));
                        }}
                        disabled={(value !== '' && !isWholeUnitInput(value)) || Number(value || 0) >= maxPacked || busy}
                        className="inline-flex size-11 items-center justify-center rounded-lg border border-ink-950/15 bg-white text-ink-800 transition hover:bg-cream-100 disabled:opacity-30 disabled:pointer-events-none"
                        aria-label={`Sumar una unidad de ${item.productName}`}
                      >
                        <Plus className="size-3.5" />
                      </button>

                      <span id={`packing-limit-${item.id}`} className="text-xs font-semibold text-ink-500">/ {maxPacked} máximo</span>
                    </div>

                    {isEmpty ? (
                      <span className="text-[11px] font-semibold text-amber-800">
                        Falta ingresar (0 si ninguna)
                      </span>
                    ) : null}
                  </div>
                )}
              </div>

              {invalid ? (
                <p className="mt-2 text-xs font-semibold text-rose-800">
                  {maxPacked === 0 ? 'Ya no hay unidades físicas reservadas para este producto. Conservamos tu conteo; revisá el pedido antes de guardar.'
                    : !isWholeUnitInput(value) ? `Usá un número entero sin signos, entre 0 y ${maxPacked}.`
                      : `Ingresá entre 0 y ${maxPacked} unidades de este pedido reservadas físicamente.`}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      {order.preparationState === 'ready' ? (
        <p className="mt-3 text-xs font-semibold text-amber-900">
          Si registrás menos unidades que las pedidas, este pedido volverá a «En preparación».
        </p>
      ) : null}

      {save.error || draft.error ? (
        <div className="mt-3">
          <ErrorState
            error={save.error ?? draft.error}
            onRetry={() => void queryClient.invalidateQueries({ queryKey: queryKeys.ordersRoot })}
          />
        </div>
      ) : null}

      {saved ? (
        <p role="status" className="mt-3 text-sm font-bold text-emerald-800">
          {allPackedFull
            ? `✓ Armado completo guardado para el pedido #${order.number}.`
            : `✓ Armado parcial guardado para el pedido #${order.number}. Todavía faltan unidades por guardar en la bolsita.`}
        </p>
      ) : null}

      {/* Pie de acción inteligente */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ink-950/6 pt-3">
        {!hasAnyPhysicalStock && !hasInvalid ? (
          <div className={cn(
            'flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5',
            hasUncoveredItems
              ? 'border-rose-200 bg-rose-50'
              : 'border-brand-200 bg-brand-50/70'
          )}>
            <div className="flex items-center gap-2.5">
              {hasUncoveredItems
                ? <AlertTriangle className="size-4.5 text-rose-700 shrink-0" />
                : <Package className="size-4.5 text-brand-700 shrink-0" />}
              <p className={cn('text-xs font-bold sm:text-sm', hasUncoveredItems ? 'text-rose-950' : 'text-brand-950')}>
                {hasUncoveredItems
                  ? 'Hay unidades sin reposición asignada. Revisá el faltante antes de completar el pedido.'
                  : hasIncomingItems
                    ? 'Las unidades de este pedido están en camino. Podrás registrar la bolsita cuando recibas la compra.'
                    : 'No hay unidades físicas reservadas para este pedido. Revisá sus reservas en Inventario.'}
              </p>
            </div>
            <Link
              to="/app/inventario"
              target="_blank"
              rel="noopener noreferrer"
              search={{ tab: hasIncomingItems && canReceivePurchases ? 'compras' : 'stock' }}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-1.5 text-xs font-black text-white shadow-xs hover:bg-brand-700 transition"
            >
              <span>{hasIncomingItems && canReceivePurchases ? 'Ver compra en Inventario' : 'Revisar Inventario'}</span>
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        ) : (
          <>
            <div>
              {hasIncomingItems ? (
                <Link
                  to="/app/inventario"
                  target="_blank"
                  rel="noopener noreferrer"
                  search={{ tab: canReceivePurchases ? 'compras' : 'stock' }}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-800 hover:text-brand-950 hover:underline"
                >
                  <Package className="size-3.5 text-brand-600" />
                  <span>{canReceivePurchases ? 'Hay productos en camino. Ver compra en Inventario →' : 'Hay productos en camino. La dueña puede recibir la compra en Inventario.'}</span>
                </Link>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {packingDraftDirty(draft) && !conflict ? <Button type="button" variant="ghost" size="sm" disabled={busy}
                onClick={() => { if (window.confirm('¿Descartar las cantidades que escribiste sin guardar?')) {
                  persist({ baseline: order, values: packingValues(order) }); setSaved(false); save.reset();
                } }}>Descartar cambios</Button> : null}
              <Button
                type="button"
                variant="dark"
                size="sm"
                onClick={() => {
                  if (draftRef.current.saving || conflict || hasInvalid || hasEmpty || !changed) return;
                  const request = { ...draftRef.current, error: undefined, baseline: order, saving: true };
                  persist(request);
                  save.mutate(request);
                }}
                disabled={conflict || hasInvalid || hasEmpty || !changed || busy}
                loading={busy}
              >
                {busy ? 'Guardando...' : !changed && !hasUnknown ? 'Sin cambios' : 'Guardar armado'}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
