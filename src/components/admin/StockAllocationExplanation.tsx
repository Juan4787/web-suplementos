import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowUpRight, ChevronDown, CircleHelp, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useBusinessQuery } from '@/app/use-business-query';
import { queryKeys } from '@/app/query-keys';
import { Button } from '@/components/ui/Button';
import type { Order } from '@/domain/types';
import { AppError, unknownToAppError } from '@/domain/errors';

const units = (quantity: number) => `${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`;
const awaitingReceipt = (quantity: number) => `${units(quantity)} ${quantity === 1 ? 'pendiente' : 'pendientes'} de recibir`;
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
  const incomingPurchases = stock?.purchases.filter(purchase => purchase.state === 'ordered' && purchase.incomingQuantity > 0) ?? [];
  const singlePurchase = incomingPurchases.length === 1 ? incomingPurchases[0] : undefined;
  const pendingStock = (stock?.incomingQuantity ?? 0) + (stock?.uncoveredQuantity ?? 0) > 0;
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
      {query.isPending ? <p role="status" className="text-ink-700">Consultando stock…</p>
        : query.isError || !stock ? (
          <div role="alert">
            <p>No pudimos comprobar el stock. Tu conteo se conserva.</p>
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
            {stock.reserved > stock.onHand ? <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-rose-950">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-bold">{stock.reserved - stock.onHand === 1 ? 'Falta' : 'Faltan'} {units(stock.reserved - stock.onHand)} para cubrir las reservas del producto.</p>
                {canReceivePurchases ? <Link to="/app/inventario" target="_blank" rel="noopener noreferrer" aria-label="Revisar stock en Inventario" aria-describedby={newTabDescription} className={linkStyle}>Revisar en Inventario<ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" /></Link>
                  : <p className="mt-1">Pedile a quien administra el stock que revise el conteo.</p>}
              </div>
            </div> : null}
            {pendingStock && order.stockSource !== 'incoming_only' && stock.available > 0 ? <div role="alert" className="mb-2 font-semibold text-amber-950">
              <p>Hay {units(stock.available)} libres. Actualizá el pedido para revisar su asignación.</p>
              <Button variant="secondary" size="sm" className="mt-1" onClick={refresh} disabled={query.isFetching}>Actualizar pedido</Button>
            </div> : null}
            {stock.incomingQuantity > 0 ? <>
              <div className="flex flex-wrap items-center gap-x-3">
                <div className="flex w-full items-center justify-between gap-1 sm:w-auto">
                  <p className="min-w-0 font-semibold">{awaitingReceipt(stock.incomingQuantity)}</p>
                  <button type="button" aria-label="Cómo se confirma la disponibilidad" aria-expanded={showArrivalHelp} aria-controls={`arrival-help-${item.id}`}
                    onClick={() => setShowArrivalHelp(value => !value)}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-700 hover:bg-brand-100/60 focus-visible:outline-2 focus-visible:outline-brand-600">
                    <CircleHelp className="size-4" aria-hidden="true" />
                  </button>
                </div>
                {!expanded && singlePurchase ? purchaseLink(singlePurchase) : null}
              </div>
              {!expanded && singlePurchase ? <p className="text-ink-700">{arrival(singlePurchase.expectedAt)}</p> : null}
              {!expanded && incomingPurchases.length > 1 ? <p className="text-ink-700">Reposición en {incomingPurchases.length} compras. Fechas en el detalle.</p> : null}
              {incomingPurchases.length === 0 ? <div role="alert"><p>No pudimos identificar la compra pendiente. Actualizá los datos.</p><Button variant="secondary" size="sm" className="mt-1" onClick={() => void query.refetch()} disabled={query.isFetching}>Actualizar datos</Button></div> : null}
              {showArrivalHelp ? <div id={`arrival-help-${item.id}`} className="my-2 border-l border-ink-950/20 pl-3 text-ink-700">
                <p>{order.stockSource === 'incoming_only'
                  ? 'Este pedido espera sus compras asignadas. El stock libre anterior queda para otras ventas; los pedidos anteriores y las reservas previas pueden tener prioridad al recibir.'
                  : 'Este pedido usa stock libre del local y nuevas recepciones. Los pedidos anteriores y las reservas previas pueden tener prioridad.'} La compra y la fecha estimada pueden cambiar.</p>
                {!canReceivePurchases ? <p className="mt-2">Si ya llegó, pedile a la persona responsable que registre la recepción. Después actualizá el pedido.</p> : null}
              </div> : null}
            </> : null}
            {stock.uncoveredQuantity > 0 ? <div className="mt-1 text-rose-900">
              <p className="font-semibold">{units(stock.uncoveredQuantity)} sin reposición.</p>
              {canReceivePurchases ? <Link to="/app/inventario" search={{ tab: 'compras' }} target="_blank" rel="noopener noreferrer" aria-describedby={newTabDescription} className={linkStyle}>Revisar compras<ArrowUpRight className="size-3.5" aria-hidden="true" /></Link>
                : <p>Solicitá la reposición a quien administra las compras.</p>}
            </div> : null}
            {pendingStock && order.stockSource === 'incoming_only' && stock.available > 0 ? <p className="mt-1 text-ink-700">Hay {units(stock.available)} {stock.available === 1 ? 'libre' : 'libres'} del local para otras ventas.</p> : null}
            <button type="button" className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg text-left font-semibold text-brand-900 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              aria-label={`${expanded ? 'Ocultar' : 'Ver'} stock y reservas de ${item.productName}`} aria-expanded={expanded} aria-controls={`stock-context-${item.id}`} onClick={() => setExpanded(value => !value)}>
              <span className="min-w-0 flex-1">{expanded ? 'Ocultar detalle' : 'Ver stock y reservas'}</span>
              <ChevronDown className={`size-4 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {expanded ? <div id={`stock-context-${item.id}`} className="space-y-3 border-t border-ink-950/10 pt-3">
              <dl className="grid grid-cols-3 gap-x-2" aria-label="Stock registrado y reservas del producto">
                {([['Stock registrado', stock.onHand], ['Reservadas', stock.reserved], ['Libres para nuevas ventas', stock.available]] as const).map(([label, quantity]) => <div key={label} className="flex min-w-0 flex-col">
                  <dt className="break-words text-[11px] leading-4 font-semibold text-ink-700">{label}</dt><dd className={`mt-auto whitespace-nowrap pt-0.5 font-bold leading-7 tabular-nums text-ink-950 ${quantity >= 10000000 ? 'text-[11px]' : quantity >= 100000 ? 'text-sm' : 'text-lg'}`}>{quantity}</dd>
                </div>)}
              </dl>
              <p className="text-ink-700">El stock registrado incluye las bolsitas pendientes de entregar.</p>
              <div>
                <p className="font-semibold">Pedidos con unidades reservadas · {units(stock.reservations.reduce((sum, reservation) => sum + reservation.physicalQuantity, 0))}</p>
                {stock.reservations.length > 0 ? <ul className="divide-y divide-ink-950/8" aria-label="Pedidos con unidades reservadas">
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
              {stock.purchases.length > 0 ? <div className="border-t border-ink-950/10 pt-3">
                <p className="font-semibold">Compras de este pedido</p>
                {stock.purchases.map(purchase => <div key={purchase.id} className="mt-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">{purchaseLink(purchase)}</div>
                  {purchase.incomingQuantity > 0 ? <p>{awaitingReceipt(purchase.incomingQuantity)} · {purchase.state === 'ordered' ? arrival(purchase.expectedAt) : 'Compra cerrada: actualizá los datos.'}</p> : null}
                  {purchase.uncoveredQuantity > 0 ? <p className="text-rose-900">Origen de {units(purchase.uncoveredQuantity)} sin reposición.</p> : null}
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
