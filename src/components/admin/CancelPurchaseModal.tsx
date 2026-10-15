import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker } from '@tanstack/react-router';
import { AlertTriangle, Check, CheckCircle2, RefreshCw, X } from 'lucide-react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { Button, buttonStyles } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { DatePicker, Field, Input, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import type { Purchase, PurchaseCancellationInput, PurchaseCancellationResult } from '@/domain/types';
import { formatMoney } from '@/domain/money';
import { getBusinessApi } from '@/services/business-api';

export function CancelPurchaseModal({ purchase, onClose, onResolve, onDone }: {
  purchase: Purchase;
  onClose: () => void;
  onResolve: (purchase: Purchase) => void;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [result, setResult] = useState<PurchaseCancellationResult | null>(null);
  const [mode, setMode] = useState<'cancel' | 'replace' | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const submitted = useRef<PurchaseCancellationInput | null>(null);
  const busy = useRef(false);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const preview = useBusinessQuery({
    queryKey: ['purchase-cancellation', purchase.id, operationId],
    queryFn: api => api.getPurchaseCancellationPreview(purchase.id),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!submitted.current) throw new Error('Review required');
      return (await getBusinessApi()).cancelPurchase(submitted.current);
    },
    onSuccess: async data => {
      setResult(data);
      await Promise.allSettled([
        queryKeys.purchasesRoot, queryKeys.inventory, queryKeys.products, queryKeys.dashboard,
        queryKeys.storefrontProducts, ['storefront-product'], queryKeys.ordersRoot,
        queryKeys.productReservationsRoot, queryKeys.openingReservations
      ].map(queryKey => client.invalidateQueries({ queryKey })));
    },
    onSettled: () => { busy.current = false; }
  });
  useBlocker({ shouldBlockFn: () => busy.current, enableBeforeUnload: false });
  useEffect(() => { if (result) successHeading.current?.focus(); }, [result]);

  const review = preview.data;
  const selectedMode = mode ?? (review && !review.canCancel && review.canReplace ? 'replace' : 'cancel');
  const replacing = selectedMode === 'replace';
  const allowed = Boolean(review && (replacing ? review.canReplace : review.canCancel));
  const supplierValid = !replacing || (supplierName.trim().length >= 2 && supplierName.trim().length <= 120);
  const replacementUnits = review?.replacementItems.reduce((sum, i) => sum + i.quantity, 0) ?? 0;
  const replacementCost = review?.replacementItems.reduce((sum, i) => sum + i.quantity * i.unitCostCents, 0) ?? 0;
  const frozen = mutation.isPending || submitted.current !== null;
  const reasonValid = reason.trim().length >= 3 && reason.trim().length <= 500;
  const close = () => { if (!busy.current) onClose(); };
  const refresh = () => {
    if (busy.current) return;
    submitted.current = null;
    mutation.reset();
    setAcknowledged(false);
    setOperationId(crypto.randomUUID());
  };
  const confirm = () => {
    if (busy.current || !review || !allowed || !supplierValid || !reasonValid || !acknowledged || preview.isFetching) return;
    submitted.current ??= { purchaseId: purchase.id, reason: reason.trim(), operationId, expectedToken: review.reviewToken,
      replacement: replacing ? { supplierName: supplierName.trim(), expectedAt: expectedAt ? `${expectedAt}T12:00:00-03:00` : null } : null };
    busy.current = true;
    mutation.mutate();
  };

  return <Modal onClose={close} maxWidth="2xl" ariaLabelledBy="cancel-purchase-title" ariaDescribedBy="cancel-purchase-description">
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 id="cancel-purchase-title" ref={successHeading} tabIndex={result ? -1 : undefined} className="font-display text-2xl font-black text-ink-950 sm:text-3xl">
          {result ? `Compra #${result.purchase.number} cancelada` : `Cancelar compra #${purchase.number}`}
        </h2>
        <p id="cancel-purchase-description" className="mt-2 break-words text-sm leading-6 text-ink-700">
          {result ? 'El saldo pendiente ya no se espera de este proveedor.' : 'Revisá qué dejaría de llegar y si hay clientes esperando esos productos.'}
        </p>
      </div>
      <Button variant="ghost" size="sm" className="shrink-0 px-3" aria-label="Cerrar cancelación" disabled={mutation.isPending} onClick={close}><X className="size-5" aria-hidden="true" /></Button>
    </div>

    {result ? <div className="mt-6 space-y-5">
      <div role="status" className="flex gap-3 rounded-2xl bg-emerald-50 p-4 text-emerald-950">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <p className="text-sm leading-6"><strong>{result.purchase.cancellation?.pendingUnits} unidades canceladas con el proveedor anterior.</strong> {result.replacementPurchase ? `Se creó la compra #${result.replacementPurchase.number} con ${result.replacementPurchase.supplierName}. Se trasladaron ${result.transferredUnits} unidades reservadas. Los clientes siguen esperando esa mercadería de la nueva compra.` : 'Salieron de la mercadería en camino. Los pedidos de clientes conservaron sus reservas.'}</p>
      </div>
      <p className="text-sm leading-6 text-ink-700">Lo recibido y los gastos registrados se conservan. Si pagaste un adelanto al proveedor, coordiná su devolución por separado: esta acción no registra una devolución de dinero.</p>
      {result.replacementPurchase ? <p className="break-words text-sm leading-6 text-ink-700">Reposición: {result.replacementPurchase.items.reduce((sum, i) => sum + i.quantity, 0)} unidades · {formatMoney(result.replacementPurchase.totalCostCents)}. {result.replacementPurchase.expectedAt ? 'La nueva fecha estimada quedó guardada en los pedidos vinculados.' : 'Sin fecha estimada: acordala con el proveedor y actualizá la compra.'} Avisales a los clientes si cambia la fecha acordada.</p> : null}
      <div className="rounded-2xl bg-cream-100 p-4 text-sm leading-6 text-ink-800"><strong>Motivo registrado</strong><p className="mt-1 whitespace-pre-wrap break-words">{result.purchase.cancellation?.reason}</p></div>
      <Button className="w-full sm:w-auto" disabled={mutation.isPending} onClick={onDone}>Ver compras canceladas</Button>
    </div> : <>
      {preview.isPending ? <LoadingState label="Revisando compra y reservas de clientes…" /> : null}
      {preview.isError ? <div className="mt-5"><ErrorState error={preview.error} /><Button variant="secondary" className="mt-3" onClick={refresh}><RefreshCw className="size-4" aria-hidden="true" />Volver a revisar</Button></div> : null}
      {review ? <div className="mt-6 space-y-5">
        <p className="break-words text-sm text-ink-700">Proveedor: <strong className="text-ink-950">{review.purchase.supplierName}</strong></p>
        {review.canReplace ? <div className="space-y-3">
          <h3 className="font-extrabold text-ink-950">¿Cómo resolvés lo pendiente?</h3>
          <div role="radiogroup" aria-label="Resolución de la compra" className="grid gap-3 sm:grid-cols-2" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || frozen) return;
            event.preventDefault();
            const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
            const current = choices.indexOf(document.activeElement as HTMLButtonElement);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (current + (['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1) + choices.length) % choices.length;
            choices[index]?.focus(); choices[index]?.click();
          }}>
            {([{ value: 'replace', label: 'Pedir a otro proveedor', text: 'Crear una reposición y trasladar las reservas pendientes.' }, { value: 'cancel', label: 'Cancelar sin reposición', text: 'Disponible cuando no quedan reservas pendientes.' }] as const).map(option => <button key={option.value} type="button" role="radio" aria-checked={selectedMode === option.value} tabIndex={selectedMode === option.value ? 0 : -1} disabled={frozen} onClick={() => { setMode(option.value); setAcknowledged(false); }} className={`rounded-2xl border p-4 text-left transition disabled:opacity-60 ${selectedMode === option.value ? 'border-brand-600 bg-brand-50 text-brand-950' : 'border-ink-950/15 bg-white text-ink-800 hover:bg-cream-50'}`}>
              <span className="block font-extrabold">{option.label}</span><span className="mt-1 block text-sm leading-6">{option.text}</span>
            </button>)}
          </div>
        </div> : null}
        <div className="rounded-2xl bg-cream-100 p-4">
          <h3 className="font-extrabold text-ink-950">Dejarían de llegar {review.pendingUnits} unidades</h3>
          <p className="mt-1 text-sm leading-6 text-ink-700">Valor pendiente: {formatMoney(review.pendingCostCents)}. Es el valor de la mercadería, no un reembolso.</p>
          {!replacing ? <ul className="mt-3 divide-y divide-ink-950/10">
            {review.purchase.items.filter(i => i.quantity > i.receivedQuantity + i.shortageQuantity).map(i => <li key={i.id} className="flex items-start justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 break-words font-semibold text-ink-800">{i.productName}</span><span className="shrink-0 font-extrabold tabular-nums text-ink-950">{i.quantity - i.receivedQuantity - i.shortageQuantity} u.</span>
            </li>)}
          </ul> : null}
        </div>
        {review.orders.length > 0 || review.openingReservedQuantity > 0 || !review.canReplace ? <div className="space-y-4">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
            <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" /><h3 className="font-extrabold">{!review.canReplace ? 'Esta compra ya está cerrada' : replacing ? 'Reservas que se trasladarán' : 'Primero resolvé las reservas pendientes'}</h3></div>
            <p className="mt-2 text-sm leading-6">{!review.canReplace ? 'Actualizá la lista para consultar su estado actual.' : replacing ? 'Estos pedidos conservarán sus cantidades, cobros y armado. Sólo las reservas pendientes pasarán a la nueva compra; seguirán en espera hasta recibir la mercadería.' : 'Cancelar sin reposición dejaría clientes sin cobertura. Elegí otro proveedor o resolvé sus pedidos antes de continuar.'}</p>
            {review.orders.length ? <ul className="mt-3 divide-y divide-amber-200">
              {review.orders.map(o => <li key={o.id} className="py-3 text-sm">
                <p className="break-words font-bold">Pedido #{o.number} · {o.customerName}</p><p className="mt-1">{o.quantity} {o.quantity === 1 ? 'unidad comprometida' : 'unidades comprometidas'}</p>
                {o.products?.map((item, index) => <p key={index} className="mt-1 break-words">{item.name} · {item.quantity} u.</p>)}
                {!mutation.isPending ? <Link to="/app/pedidos" search={{ search: String(o.number) }} className={buttonStyles({ variant: 'secondary', size: 'sm', className: 'mt-2' })}>Revisar pedido #{o.number}</Link> : null}
              </li>)}
            </ul> : null}
            {review.openingReservedQuantity > 0 ? <p className="mt-3 text-sm font-bold">También hay {review.openingReservedQuantity} unidades de reservas previas. {replacing ? 'Se trasladarán junto con las reservas pendientes.' : 'Revisalas en Inventario → Stock → Reservas previas.'}</p> : null}
          </div>
          {!replacing && review.purchase.state === 'ordered' ? <>
            <p className="text-sm leading-6 text-ink-700">Si esos productos llegarán de otro proveedor, usá «Resolver faltantes» para registrar la reposición y trasladar las reservas. Si el cliente desiste, revisá su pedido: devolvé el cobro si corresponde y resolvé la bolsita antes de cancelarlo.</p>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={() => onResolve(review.purchase)}>Resolver faltantes de esta compra</Button>
          </> : null}
        </div> : null}
        {replacing && review.canReplace ? <div className="space-y-4">
          <h3 className="font-extrabold text-ink-950">Nueva compra de reposición</h3>
          <Field label="Nuevo proveedor" hint="Las cantidades y los costos unitarios se copian del pedido original. Podés revisar el costo de la compra nueva antes de recibirla."><Input value={supplierName} maxLength={120} disabled={frozen} onChange={e => setSupplierName(e.target.value)} placeholder="Nombre del proveedor que enviará lo pendiente" /></Field>
          <Field label="Nueva fecha estimada · opcional" hint="Si no la conocés, los pedidos quedarán sin fecha confirmada."><DatePicker value={expectedAt} onChange={setExpectedAt} disabled={frozen} /></Field>
          <ul className="divide-y divide-ink-950/10">{review.replacementItems.map(i => <li key={i.productId} className="flex justify-between gap-3 py-2 text-sm"><span className="min-w-0 break-words text-ink-800">{i.productName}</span><span className="shrink-0 font-bold tabular-nums">{i.quantity} u.</span></li>)}</ul>
          <p className="text-sm font-bold text-ink-950">Se pedirán {replacementUnits} unidades · {formatMoney(replacementCost)}</p>
          {replacementUnits > review.pendingUnits ? <p className="text-sm leading-6 text-amber-950">La reposición también incluye {replacementUnits - review.pendingUnits} unidades comprometidas que ya figuraban como faltante definitivo. Así todos los pedidos pendientes mantienen cobertura.</p> : null}
          <p className="text-sm leading-6 text-ink-700">Se creará un pedido nuevo al proveedor; los pedidos de los clientes conservan sus precios y los importes ya registrados. El sistema guarda el registro: coordiná el pedido con el proveedor y avisales a los clientes si cambia la fecha acordada.</p>
        </div> : null}
        {allowed ? <>
          <p className="rounded-2xl bg-brand-50 p-4 text-sm leading-6 text-brand-950">{replacing ? 'La cancelación y el traslado se guardan juntos. Si algo falla, se conserva la compra original con sus reservas.' : 'No hay reservas pendientes de clientes ni reservas previas que dependan de este saldo.'} {review.receivedUnits > 0 ? `Lo recibido (${review.receivedUnits} u.) conserva su stock y sus reservas.` : 'No se descontará stock físico.'} Los gastos registrados se conservan. La cancelación queda en el historial y no se puede deshacer.</p>
          <Field label="Motivo de cancelación" hint={`${reason.length}/500 caracteres. Quedará guardado en el historial.`}>
            <Textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={500} disabled={mutation.isPending || submitted.current !== null} placeholder="Por ejemplo: el proveedor confirmó que no enviará lo pendiente." />
          </Field>
          <button type="button" role="checkbox" aria-checked={acknowledged} disabled={mutation.isPending} onClick={() => setAcknowledged(v => !v)} className="flex w-full items-start gap-3 rounded-2xl border border-ink-950/15 p-4 text-left text-sm leading-6 text-ink-800 transition hover:bg-cream-50 disabled:opacity-60">
            <span aria-hidden="true" className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border ${acknowledged ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-400 bg-white'}`}>{acknowledged ? <Check className="size-4" /> : null}</span>
            {replacing ? `Confirmo el traslado de lo pendiente a ${supplierName.trim() || 'otro proveedor'}.` : 'Confirmo que no se espera este saldo del proveedor.'} La cancelación no devuelve dinero ni anula gastos.
          </button>
          <p className="text-sm leading-6 text-ink-700">Si ya pagaste al proveedor, coordiná la devolución del adelanto por separado.</p>
        </> : null}
        {mutation.isError ? <div className="space-y-3"><ErrorState error={mutation.error} /><p className="text-sm leading-6 text-ink-700">Si se cortó la conexión, volvé a intentar el guardado. Antes de cambiar los datos, usá «Volver a revisar».</p></div> : null}
        <div className="flex flex-col-reverse gap-3 border-t border-ink-950/10 pt-5 sm:flex-row sm:justify-end">
          <Button variant="ghost" disabled={mutation.isPending} onClick={close}>Volver</Button>
          <Button variant="secondary" disabled={mutation.isPending} onClick={refresh}><RefreshCw className="size-4" aria-hidden="true" />Volver a revisar</Button>
          <Button variant="danger" loading={mutation.isPending} disabled={!allowed || !supplierValid || !acknowledged || !reasonValid || preview.isFetching} onClick={confirm}>{mutation.isPending ? 'Guardando…' : mutation.isError ? 'Reintentar guardado' : replacing ? 'Cancelar y crear reposición' : 'Confirmar cancelación'}</Button>
        </div>
        {mutation.isPending ? <p role="status" className="text-sm font-semibold text-ink-700">Guardando la cancelación. Esperá a que termine antes de salir.</p> : null}
      </div> : null}
    </>}
  </Modal>;
}
