import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowRight, Lock, Minus, Package, Plus, Sparkles } from 'lucide-react';
import { queryKeys } from '@/app/query-keys';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/DataState';
import { sanitizeIntegerInput } from '@/domain/inventory';
import type { Order } from '@/domain/types';
import { cn } from '@/lib/cn';
import { getBusinessApi } from '@/services/business-api';

const startingValues = (order: Order): Record<string, string> =>
  Object.fromEntries(
    order.items.map(item => {
      const physical = item.physicalReservedQuantity ?? item.quantity;
      const maxPacked = Math.min(item.quantity, physical);
      if (item.packedQuantity != null) {
        return [item.id, String(Math.min(item.packedQuantity, maxPacked))];
      }
      if (maxPacked === 0) {
        return [item.id, '0'];
      }
      return [item.id, ''];
    })
  );

export function OrderPackingEditor({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(() => startingValues(order));
  const [saved, setSaved] = useState(false);
  const physicalByItem = Object.fromEntries(order.items.map(item => [item.id, item.physicalReservedQuantity ?? item.quantity]));
  const physicalSignature = order.items.map(item => `${item.id}:${physicalByItem[item.id]}`).join('|');
  const previousSnapshot = useRef({ id: order.id, revision: order.packingRevision, physicalByItem });

  useEffect(() => {
    const previous = previousSnapshot.current;
    if (previous.id !== order.id || previous.revision !== order.packingRevision) {
      setValues(startingValues(order));
    } else if (order.items.some(item => previous.physicalByItem[item.id] !== physicalByItem[item.id])) {
      setSaved(false);
      setValues(current => Object.fromEntries(order.items.map(item => {
        const before = previous.physicalByItem[item.id] ?? 0;
        const now = physicalByItem[item.id] ?? 0;
        const value = current[item.id] ?? '';
        // Un 0 impuesto por el candado no equivale a un conteo físico hecho por la operadora.
        return [item.id, before === 0 && now > 0 && item.packedQuantity == null && value === '0' ? '' : value];
      })));
    }
    previousSnapshot.current = { id: order.id, revision: order.packingRevision, physicalByItem };
  }, [order.id, order.packingRevision, physicalSignature]);

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
    return !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > maxPacked;
  });

  const changed = order.items.some(item =>
    (values[item.id] ?? '') !== (item.packedQuantity == null ? '' : String(item.packedQuantity))
  );

  const canFillAllAvailable = hasAnyPhysicalStock && order.items.some(item => {
    const physical = item.physicalReservedQuantity ?? item.quantity;
    const maxPacked = Math.min(item.quantity, physical);
    return maxPacked > 0 && (values[item.id] ?? '') !== String(maxPacked);
  });

  const save = useMutation({
    mutationFn: async () => (await getBusinessApi()).saveOrderPacking(
      order.id,
      order.items.map(item => ({ orderItemId: item.id, packedQuantity: Number(values[item.id] || 0) })),
      order.packingRevision ?? 0
    ),
    onSuccess: async () => {
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.ordersRoot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.productReservationsRoot })
      ]);
    }
  });

  const fillAllAvailable = () => {
    setSaved(false);
    save.reset();
    setValues(previous =>
      Object.fromEntries(
        order.items.map(item => {
          const physical = item.physicalReservedQuantity ?? item.quantity;
          const maxPacked = Math.min(item.quantity, physical);
          return [item.id, maxPacked > 0 ? String(maxPacked) : (previous[item.id] ?? '0')];
        })
      )
    );
  };

  const fillZeros = () => {
    setSaved(false);
    save.reset();
    setValues(previous =>
      Object.fromEntries(
        order.items.map(item => [
          item.id,
          previous[item.id] !== '' ? previous[item.id]! : '0'
        ])
      )
    );
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

      <div className="mt-4 space-y-3">
        {order.items.map(item => {
          const physical = item.physicalReservedQuantity ?? item.quantity;
          const incoming = item.incomingQuantity ?? 0;
          const uncovered = item.uncoveredQuantity ?? 0;
          const maxPacked = Math.min(item.quantity, physical);
          const isLocked = maxPacked === 0;
          const isPartial = physical > 0 && physical < item.quantity;
          const value = values[item.id] ?? (isLocked ? '0' : '');
          const isEmpty = !isLocked && value === '';
          const invalid = !isLocked && value !== '' && (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > maxPacked);

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
                        disabled={Number(value || 0) <= 0 || save.isPending}
                        className="inline-flex size-8 items-center justify-center rounded-lg border border-ink-950/15 bg-white text-ink-800 transition hover:bg-cream-100 disabled:opacity-30 disabled:pointer-events-none"
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
                        onChange={event => {
                          setSaved(false);
                          save.reset();
                          setValues(previous => ({
                            ...previous,
                            [item.id]: sanitizeIntegerInput(event.target.value)
                          }));
                        }}
                        disabled={save.isPending}
                        aria-label={`Unidades en bolsita de ${item.productName}`}
                        aria-describedby={`packing-limit-${item.id}`}
                        aria-invalid={invalid || isEmpty}
                        className={cn(
                          'h-9 w-14 rounded-lg border bg-white px-1 text-center text-sm font-black text-ink-950 focus:outline-none focus:ring-2',
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
                        disabled={Number(value || 0) >= maxPacked || save.isPending}
                        className="inline-flex size-8 items-center justify-center rounded-lg border border-ink-950/15 bg-white text-ink-800 transition hover:bg-cream-100 disabled:opacity-30 disabled:pointer-events-none"
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
                  Ingresá entre 0 y {maxPacked} unidades de este pedido reservadas físicamente.
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

      {save.error ? (
        <div className="mt-3">
          <ErrorState
            error={save.error}
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
        {!hasAnyPhysicalStock ? (
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
              search={{ tab: hasIncomingItems ? 'compras' : 'stock' }}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 py-1.5 text-xs font-black text-white shadow-xs hover:bg-brand-700 transition"
            >
              <span>{hasIncomingItems ? 'Ver compra en Inventario' : 'Revisar Inventario'}</span>
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        ) : (
          <>
            <div>
              {hasIncomingItems ? (
                <Link
                  to="/app/inventario"
                  search={{ tab: 'compras' }}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-800 hover:text-brand-950 hover:underline"
                >
                  <Package className="size-3.5 text-brand-600" />
                  <span>Hay productos en camino. Ver compra en Inventario →</span>
                </Link>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {canFillAllAvailable ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={fillAllAvailable}
                  disabled={save.isPending}
                  className="inline-flex items-center gap-1.5"
                >
                  <Sparkles className="size-3.5 text-brand-600" />
                  <span>Ya guardé todo lo reservado</span>
                </Button>
              ) : null}
              {hasEmpty ? (
                <Button type="button" variant="secondary" size="sm" onClick={fillZeros} disabled={save.isPending}>
                  Completar vacíos con 0
                </Button>
              ) : null}
              <Button
                type="button"
                variant="dark"
                size="sm"
                onClick={() => save.mutate()}
                disabled={hasInvalid || hasEmpty || !changed || save.isPending}
                loading={save.isPending}
              >
                {save.isPending ? 'Guardando...' : !changed && !hasUnknown ? 'Sin cambios' : 'Guardar armado'}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
