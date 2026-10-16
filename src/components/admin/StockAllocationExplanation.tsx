import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useBusinessQuery } from '@/app/use-business-query';
import { queryKeys } from '@/app/query-keys';
import { Button } from '@/components/ui/Button';
import type { Order } from '@/domain/types';
import { AppError, unknownToAppError } from '@/domain/errors';

const arrival = (value: string | null) => value
  ? `Llegada estimada: ${new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(value))}.`
  : 'El proveedor todavía no tiene una fecha estimada registrada.';

export function StockAllocationExplanation({ order, item, canReceivePurchases }: {
  order: Order;
  item: Order['items'][number];
  canReceivePurchases: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const client = useQueryClient();
  const revision = `${order.actionRevision ?? 0}:${order.packingRevision ?? 0}:` + order.items
    .map(line => `${line.id}:${line.physicalReservedQuantity}:${line.incomingQuantity}:${line.uncoveredQuantity}`).join('|');
  const query = useBusinessQuery({
    queryKey: queryKeys.orderStockContext(order.id, revision),
    staleTime: 0,
    retry: (attempt, error) => error instanceof AppError && error.retryable && attempt < 1,
    refetchOnWindowFocus: 'always',
    queryFn: api => api.getOrderStockContext(order.id)
  });
  const context = query.data;
  const failure = query.isError ? unknownToAppError(query.error) : null;
  const stock = context?.items.find(line => line.orderItemId === item.id);
  const changed = Boolean(context && (!stock || context.orderState !== order.orderState ||
    context.fulfillmentState !== order.fulfillmentState || context.stockSource !== (order.stockSource ?? 'normal') ||
    context.actionRevision !== (order.actionRevision ?? 0) || context.packingRevision !== (order.packingRevision ?? 0) ||
    stock.quantity !== item.quantity || stock.physicalQuantity !== (item.physicalReservedQuantity ?? item.quantity) ||
    stock.incomingQuantity !== (item.incomingQuantity ?? 0) || stock.uncoveredQuantity !== (item.uncoveredQuantity ?? 0)));
  const refresh = () => void client.invalidateQueries({ queryKey: queryKeys.ordersRoot });

  return (
    <div className="mt-3 border-t border-ink-950/10 pt-3 text-xs leading-relaxed text-ink-800" role="group" aria-label={`Disponibilidad de ${item.productName}`}>
      {query.isPending ? <p role="status">Consultando el stock y las reservas de este producto…</p>
        : query.isError || !stock ? (
          <div role="alert">
            <p>No pudimos comprobar el detalle de sus reservas. Conservamos el conteo de la bolsita.</p>
            {failure && !failure.retryable ? <p className="mt-1">{failure.message} {failure.nextAction}</p> :
              <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>Volver a consultar</Button>}
          </div>
        ) : changed ? (
          <div role="alert">
            <p>Las reservas del pedido cambiaron. Actualizá el pedido para revisar qué unidades tiene asignadas. Tu conteo se conserva sin guardar.</p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={refresh} disabled={query.isFetching}>Actualizar pedido</Button>
          </div>
        ) : (
          <>
            {order.stockSource === 'incoming_only' ? (
              <p>Este pedido se creó para reservar mercadería en camino. El stock físico libre anterior queda para otras ventas; sólo una nueva llegada habilita las unidades pendientes.</p>
            ) : stock.available === 0 ? (
              <p>{stock.onHand > 0
                ? `Hay ${stock.onHand} ${stock.onHand === 1 ? 'unidad registrada en el local y ya está apartada' : 'unidades registradas en el local y todas están apartadas'}.${stock.otherReservedQuantity > 0 ? ` ${stock.otherReservedQuantity} para otros pedidos o reservas previas.` : ''}`
                : 'No hay unidades físicas registradas en el local para completar este producto.'}</p>
            ) : (
              <p role="alert">Hay {stock.available} unidades físicas libres y este producto sigue pendiente. Actualizá el pedido para revisar su asignación antes de continuar.</p>
            )}
            {stock.uncoveredQuantity > 0 ? <p className="mt-1 font-semibold text-rose-900">{stock.uncoveredQuantity} {stock.uncoveredQuantity === 1 ? 'unidad quedó' : 'unidades quedaron'} sin reposición. Revisá las compras pendientes y acordá cómo completar el pedido.</p> : null}
            {stock.incomingQuantity > 0 ? <p className="mt-1">{stock.incomingQuantity} {stock.incomingQuantity === 1 ? 'unidad en camino' : 'unidades en camino'}. {stock.purchases.filter(p => p.state === 'ordered').map(p => `Compra #${p.number}: ${arrival(p.expectedAt)}`).join(' ')}</p> : null}
            <button type="button" className="mt-1 flex min-h-11 w-full items-center justify-between gap-2 rounded-lg text-left font-bold text-brand-900 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              aria-expanded={expanded} aria-controls={`stock-context-${item.id}`} onClick={() => setExpanded(value => !value)}>
              <span className="min-w-0 flex-1">{expanded ? 'Ocultar' : 'Ver'} stock, reservas y compra de {item.productName}</span>
              <ChevronDown className={`size-4 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {expanded ? (
              <div id={`stock-context-${item.id}`} className="space-y-3">
                <p>En el local: <strong>{stock.onHand}</strong> · Apartadas: <strong>{stock.reserved}</strong> · Libres para vender: <strong>{stock.available}</strong>.</p>
                <p>Para este pedido: <strong>{stock.physicalQuantity}</strong> físicas asignadas de {stock.quantity} pedidas. Guardarlas en la bolsita no cambia el total de stock.</p>
                {stock.reservations.length > 0 ? (
                  <ul className="max-h-52 space-y-1 overflow-y-auto" aria-label="Pedidos con unidades físicas apartadas">
                    {stock.reservations.map(reservation => (
                      <li key={reservation.orderId}>
                        <Link to="/app/pedidos" target="_blank" rel="noopener noreferrer" search={{ search: String(reservation.orderNumber) }}
                          className="flex min-h-11 flex-wrap items-center justify-between gap-x-2 rounded-lg bg-white px-3 py-2 font-semibold text-brand-900 hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600">
                          <span>Pedido #{reservation.orderNumber}{reservation.orderId === order.id ? ' · Este pedido' : ''}</span>
                          <span>{reservation.physicalQuantity} {reservation.physicalQuantity === 1 ? 'unidad apartada' : 'unidades apartadas'}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : <p>No hay pedidos registrados con unidades físicas apartadas.</p>}
                {stock.openingReservedQuantity > 0 ? <p>Además, {stock.openingReservedQuantity} unidades corresponden a reservas anteriores al sistema.</p> : null}
                {stock.purchases.map(purchase => (
                  <div key={purchase.id} className="border-t border-ink-950/10 pt-2">
                    <p className="font-bold">Compra #{purchase.number} · {purchase.reservedQuantity} {purchase.reservedQuantity === 1 ? 'unidad para este producto' : 'unidades para este producto'}</p>
                    <p>{purchase.state === 'ordered' ? arrival(purchase.expectedAt) : 'Esta compra ya cerró. Revisá si quedó un faltante pendiente de reposición.'}</p>
                    {canReceivePurchases ? <Link to="/app/inventario" search={{ tab: 'compras', purchase: purchase.id }} target="_blank" rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center font-bold text-brand-900 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-brand-600">Abrir compra #{purchase.number}</Link> : null}
                  </div>
                ))}
                {!canReceivePurchases && stock.purchases.some(purchase => purchase.state === 'ordered') ? <p className="font-semibold">Si la mercadería ya llegó, pedile a la persona responsable que registre la recepción de esa compra. Después actualizá este pedido.</p> : null}
                <p>Las llegadas completan los pedidos por antigüedad. Si una llegada cubre pedidos anteriores, la compra que repone lo pendiente puede cambiar; consultá la compra y fecha indicadas arriba.</p>
                <p className="text-ink-700">Los pedidos y compras se abren en otra pestaña para conservar tu conteo. Si el conteo real no coincide, revisá todas las unidades del producto, incluidas las bolsitas pendientes, antes de corregir stock.</p>
                <Button variant="ghost" size="sm" onClick={refresh} disabled={query.isFetching}><RefreshCw className="size-3.5" aria-hidden="true" />{query.isFetching ? 'Actualizando…' : 'Actualizar datos'}</Button>
              </div>
            ) : null}
          </>
        )}
    </div>
  );
}
