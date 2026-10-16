import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, ChevronDown, CircleHelp, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useBusinessQuery } from '@/app/use-business-query';
import { queryKeys } from '@/app/query-keys';
import { Button } from '@/components/ui/Button';
import type { Order } from '@/domain/types';
import { AppError, unknownToAppError } from '@/domain/errors';

const units = (quantity: number) => `${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`;
const arrival = (value: string | null) => value
  ? `Llegada estimada al local: ${new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(value))}`
  : 'Sin fecha estimada';
const linkStyle = 'inline-flex min-h-11 items-center gap-1 font-semibold text-brand-900 underline underline-offset-4 hover:text-brand-700 focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600';

export function StockAllocationExplanation({ order, item, canReceivePurchases }: {
  order: Order;
  item: Order['items'][number];
  canReceivePurchases: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [allReservations, setAllReservations] = useState(false);
  const [showArrivalHelp, setShowArrivalHelp] = useState(false);
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
  const incomingPurchases = stock?.purchases.filter(purchase => purchase.state === 'ordered') ?? [];
  const singlePurchase = incomingPurchases.length === 1 ? incomingPurchases[0] : undefined;
  const remainingReservations = stock?.reservations.slice(3) ?? [];
  const remainingUnits = remainingReservations.reduce((sum, reservation) => sum + reservation.physicalQuantity, 0);
  const newTabDescription = `stock-new-tab-${item.id}`;
  const purchaseLink = (purchase: NonNullable<typeof stock>['purchases'][number]) => canReceivePurchases
    ? <Link to="/app/inventario" search={{ tab: 'compras', purchase: purchase.id }} target="_blank" rel="noopener noreferrer"
        aria-label={`Abrir compra #${purchase.number}`} aria-describedby={newTabDescription} className={linkStyle}>
        Compra #{purchase.number}<ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
      </Link>
    : <span className="font-semibold">Compra #{purchase.number}</span>;

  return (
    <div className="mt-2 text-xs leading-relaxed text-ink-800" role="group" aria-label={`Disponibilidad de ${item.productName}`}>
      {query.isPending ? <p role="status">Consultando la reposición…</p>
        : query.isError || !stock ? (
          <div role="alert">
            <p>No pudimos comprobar la reposición. Tu conteo se conserva.</p>
            {failure && !failure.retryable ? <p className="mt-1">{failure.message} {failure.nextAction}</p> :
              <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>Volver a consultar</Button>}
          </div>
        ) : changed ? (
          <div role="alert">
            <p>El pedido cambió. Actualizá sus datos para revisarlo. Tu conteo se conserva sin guardar.</p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={refresh} disabled={query.isFetching}>Actualizar pedido</Button>
          </div>
        ) : (
          <>
            {order.stockSource !== 'incoming_only' && stock.available > 0 ? <div role="alert" className="mb-2 font-semibold text-amber-950">
              <p>Hay {units(stock.available)} libres. Actualizá el pedido para revisar su asignación.</p>
              <Button variant="secondary" size="sm" className="mt-1" onClick={refresh} disabled={query.isFetching}>Actualizar pedido</Button>
            </div> : null}
            {stock.incomingQuantity > 0 ? <>
              <div className="flex flex-wrap items-center gap-x-3">
                <p className="font-semibold">{units(stock.incomingQuantity)} en camino</p>
                {singlePurchase ? purchaseLink(singlePurchase) : null}
                <div className="inline-flex max-w-full items-center gap-1">
                  {singlePurchase ? <span className="min-w-0">{arrival(singlePurchase.expectedAt)}</span> : null}
                  <button type="button" aria-label="Cómo se confirma la disponibilidad" aria-expanded={showArrivalHelp} aria-controls={`arrival-help-${item.id}`}
                    onClick={() => setShowArrivalHelp(value => !value)}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-700 hover:bg-brand-100/60 focus-visible:outline-2 focus-visible:outline-brand-600">
                    <CircleHelp className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
              {incomingPurchases.length > 1 ? <p>Reposición prevista en {incomingPurchases.length} compras. Fechas en el detalle.</p> : !singlePurchase ? <p>Actualizá los datos para comprobar qué compra repone estas unidades.</p> : null}
              {showArrivalHelp ? <div id={`arrival-help-${item.id}`} className="my-2 border-l border-ink-950/20 pl-3 text-ink-700">
                <p>La fecha estima la llegada al local. La disponibilidad de este pedido se confirma al registrar la recepción y asignar las unidades según las reservas y su antigüedad. La compra y la fecha pueden cambiar.</p>
                {!canReceivePurchases ? <p className="mt-2">Si ya llegó, pedile a la persona responsable que registre la recepción. Después actualizá el pedido.</p> : null}
              </div> : null}
            </> : null}
            {stock.uncoveredQuantity > 0 ? <p className="mt-1 font-semibold text-rose-900">{units(stock.uncoveredQuantity)} sin reposición. Acordá cómo completar el pedido.</p> : null}
            <button type="button" className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg text-left font-semibold text-brand-900 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              aria-label={`${expanded ? 'Ocultar' : 'Ver'} stock y reservas de ${item.productName}`} aria-expanded={expanded} aria-controls={`stock-context-${item.id}`} onClick={() => setExpanded(value => !value)}>
              <span className="min-w-0 flex-1">{expanded ? 'Ocultar detalle' : 'Ver stock y reservas'}</span>
              <ChevronDown className={`size-4 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {expanded ? <div id={`stock-context-${item.id}`} className="space-y-3 border-t border-ink-950/10 pt-3">
              <dl className="grid grid-cols-3 gap-x-2" aria-label="Stock general del producto">
                {([['En local', stock.onHand], ['Apartadas', stock.reserved], ['Libres', stock.available]] as const).map(([label, quantity]) => <div key={label} className="min-w-0">
                  <dt className="whitespace-nowrap text-[11px] font-semibold text-ink-700">{label}</dt><dd className={`mt-0.5 whitespace-nowrap font-bold leading-7 tabular-nums text-ink-950 ${quantity >= 10000000 ? 'text-[11px]' : quantity >= 100000 ? 'text-sm' : 'text-lg'}`}>{quantity}</dd>
                </div>)}
              </dl>
              {order.stockSource === 'incoming_only' && stock.available > 0 ? <p>Este pedido reserva sólo mercadería en camino. El stock libre anterior queda para otras ventas.</p> : null}
              <div>
                <p className="font-semibold">Reservas físicas · {units(stock.reserved)}</p>
                {stock.reservations.length > 0 ? <ul className="divide-y divide-ink-950/8" aria-label="Pedidos con unidades físicas apartadas">
                  {(allReservations ? stock.reservations : stock.reservations.slice(0, 3)).map(reservation => <li key={reservation.orderId}>
                    {reservation.orderId === order.id ? <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2 font-semibold">
                      <span>Este pedido</span><span>{units(reservation.physicalQuantity)}</span>
                    </div> : <Link to="/app/pedidos" target="_blank" rel="noopener noreferrer" search={{ search: String(reservation.orderNumber) }} aria-describedby={newTabDescription}
                      className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg py-2 font-semibold text-brand-900 hover:bg-brand-100/50 focus-visible:outline-2 focus-visible:outline-brand-600">
                      <span className="inline-flex items-center gap-1">Pedido #{reservation.orderNumber}<ArrowUpRight className="size-3.5" aria-hidden="true" /></span><span>{units(reservation.physicalQuantity)}</span>
                    </Link>}
                  </li>)}
                </ul> : <p className="mt-1 text-ink-700">Sin reservas físicas de pedidos.</p>}
                {remainingReservations.length > 0 ? <button type="button" className={linkStyle} aria-expanded={allReservations} onClick={() => setAllReservations(value => !value)}>
                  {allReservations ? 'Mostrar menos pedidos' : `Ver otros ${remainingReservations.length} pedidos · ${units(remainingUnits)}`}
                </button> : null}
                {stock.openingReservedQuantity > 0 ? <p className="mt-1">Reservas previas al sistema: {units(stock.openingReservedQuantity)}.</p> : null}
              </div>
              {stock.purchases.some(purchase => purchase.id !== singlePurchase?.id) ? <div className="border-t border-ink-950/10 pt-3">
                <p className="font-semibold">Compras vinculadas</p>
                {stock.purchases.filter(purchase => purchase.id !== singlePurchase?.id).map(purchase => <div key={purchase.id} className="mt-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">{purchaseLink(purchase)}<span>{units(purchase.reservedQuantity)}</span></div>
                  <p>{purchase.state === 'ordered' ? arrival(purchase.expectedAt) : 'Compra cerrada. Estas unidades necesitan reposición.'}</p>
                </div>)}
              </div> : null}
              <Button variant="ghost" size="sm" className="px-0" onClick={refresh} disabled={query.isFetching}><RefreshCw className="size-3.5" aria-hidden="true" />{query.isFetching ? 'Actualizando…' : 'Actualizar datos'}</Button>
            </div> : null}
            <span id={newTabDescription} className="sr-only">Se abre en otra pestaña y conserva tu conteo.</span>
          </>
        )}
    </div>
  );
}
