import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/DataState';
import type { Order } from '@/domain/types';
import { getBusinessApi } from '@/services/business-api';

const startingValues = (order: Order): Record<string, string> =>
  Object.fromEntries(order.items.map(item => [item.id, item.packedQuantity == null ? '' : String(item.packedQuantity)]));

export function OrderPackingEditor({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(() => startingValues(order));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValues(startingValues(order));
  }, [order.id, order.packingRevision]);

  const hasUnknown = order.items.some(item => item.packedQuantity == null);
  const hasEmpty = order.items.some(item => (values[item.id] ?? '') === '');
  const hasInvalid = order.items.some(item => {
    const value = values[item.id] ?? '';
    return !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > Math.min(item.quantity, item.physicalReservedQuantity ?? item.quantity);
  });
  const changed = order.items.some(item =>
    (values[item.id] ?? '') !== (item.packedQuantity == null ? '' : String(item.packedQuantity))
  );

  const save = useMutation({
    mutationFn: async () => (await getBusinessApi()).saveOrderPacking(
      order.id,
      order.items.map(item => ({ orderItemId: item.id, packedQuantity: Number(values[item.id]) })),
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

  const fillZeros = () => {
    setSaved(false);
    save.reset();
    setValues(previous => Object.fromEntries(order.items.map(item => [
      item.id, previous[item.id] || '0'
    ])));
  };

  return (
    <section className="rounded-2xl border border-brand-200 bg-brand-50/45 p-4 sm:p-5" aria-label={`Armado del pedido ${order.number}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-black text-ink-950">Armado de la bolsita · Pedido #{order.number}</h3>
          <p className="mt-1 text-[13px] text-ink-700">
            Escribí #{order.number} en la bolsita y cargá solo las unidades que ya guardaste. Si no hay ninguna de un producto, poné 0.
          </p>
        </div>
        {hasUnknown ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-900">Armado sin verificar</span> : null}
      </div>

      <div className="mt-4 space-y-3">
        {order.items.map(item => {
          const physical = item.physicalReservedQuantity ?? item.quantity;
          const incoming = item.incomingQuantity ?? 0;
          const uncovered = item.uncoveredQuantity ?? 0;
          const maxPacked = Math.min(item.quantity, physical);
          const value = values[item.id] ?? '';
          const invalid = value !== '' && (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > maxPacked);
          return (
            <div key={item.id} className="rounded-xl border border-ink-950/8 bg-white p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-black text-ink-950">{item.productName}</p>
                  <p className="text-[13px] font-semibold text-ink-700">
                    Pedido: {item.quantity} · Reservado físico: {physical}
                    {incoming > 0 ? ` · En camino: ${incoming}` : ''}
                    {uncovered > 0 ? ` · Faltante: ${uncovered}` : ''}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-[13px] font-bold text-ink-900">
                  En bolsita
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={maxPacked}
                    step={1}
                    value={value}
                    onChange={event => {
                      setSaved(false);
                      save.reset();
                      setValues(previous => ({ ...previous, [item.id]: event.target.value }));
                    }}
                    aria-label={`Unidades guardadas de ${item.productName}`}
                    aria-invalid={invalid}
                    className="h-11 w-20 rounded-xl border border-ink-950/20 bg-white px-2 text-center text-base font-black text-ink-950 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  />
                </label>
              </div>
              {invalid ? <p className="mt-2 text-xs font-semibold text-rose-800">Ingresá entre 0 y {maxPacked} unidades de este pedido reservadas físicamente.</p> : null}
            </div>
          );
        })}
      </div>

      {order.preparationState === 'ready' ? (
        <p className="mt-3 text-xs font-semibold text-amber-900">Si registrás menos unidades que las pedidas, este pedido volverá a «En preparación».</p>
      ) : null}
      {save.error ? <div className="mt-3"><ErrorState error={save.error} onRetry={() => void queryClient.invalidateQueries({ queryKey: queryKeys.ordersRoot })} /></div> : null}
      {saved ? <p role="status" className="mt-3 text-sm font-bold text-emerald-800">Armado guardado para el pedido #{order.number}.</p> : null}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {hasEmpty ? (
          <Button type="button" variant="secondary" size="sm" onClick={fillZeros} disabled={save.isPending}>
            Completar vacíos con 0
          </Button>
        ) : null}
        <Button type="button" variant="dark" size="sm" onClick={() => save.mutate()} disabled={hasInvalid || !changed || save.isPending} loading={save.isPending}>
          Guardar armado
        </Button>
      </div>
    </section>
  );
}
