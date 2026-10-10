import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { CurrencyInput, Field, Input } from '@/components/ui/Field';
import { ErrorState } from '@/components/ui/DataState';
import { formatMoney } from '@/domain/money';
import { parsePercentageBasisPoints, percentageShippingCents, shippingFeeNeedsReview } from '@/domain/order-shipping';
import type { Order, OrderShippingFeeInput } from '@/domain/types';
import { getBusinessApi } from '@/services/business-api';

export function OrderShippingFeeEditor({ order, canEdit, disabled, onEditingChange }: {
  order: Order;
  canEdit: boolean;
  disabled: boolean;
  onEditingChange: (orderId: string, editing: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const editorId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState<'manual' | 'percentage'>('manual');
  const [amount, setAmount] = useState<number | undefined>();
  const [percentage, setPercentage] = useState('');
  const [percentageNotice, setPercentageNotice] = useState(false);
  const [costBase, setCostBase] = useState<number | null>(order.costTotalCents);
  const [revision, setRevision] = useState(0);
  const request = useRef<{ signature: string; input: OrderShippingFeeInput } | null>(null);
  const editable = canEdit && order.paymentState === 'pending' && order.orderState !== 'cancelled' && order.saleType !== 'gift' && order.paymentMethod !== 'gift';
  const active = editing && editable;
  useEffect(() => {
    if (wasEditing.current && !active) toggleRef.current?.focus();
    wasEditing.current = active;
  }, [active]);
  useEffect(() => {
    onEditingChange(order.id, active);
    return () => onEditingChange(order.id, false);
  }, [order.id, active, onEditingChange]);
  const basisPoints = parsePercentageBasisPoints(percentage);
  let calculated: number | null = method === 'manual' ? (amount ?? 0) * 100 : null;
  if (method === 'percentage' && basisPoints !== null && costBase !== null) {
    try { calculated = percentageShippingCents(costBase, basisPoints); } catch { calculated = null; }
  }
  const changedElsewhere = revision !== (order.shippingFeeRevision ?? 0);
  const costChanged = method === 'percentage' && (basisPoints ?? 0) > 0 && costBase !== order.costTotalCents;
  const save = useMutation({
    mutationFn: async () => {
      const data = { orderId: order.id, expectedRevision: revision, method,
        ...(method === 'manual' ? { amountCents: calculated ?? 0 } : { basisPoints: basisPoints!, expectedCostCents: costBase! }) };
      const signature = JSON.stringify(data);
      if (request.current?.signature !== signature) request.current = { signature, input: { ...data, operationId: crypto.randomUUID() } };
      return (await getBusinessApi()).saveOrderShippingFee(request.current!.input);
    },
    onSuccess: async (updated) => {
      queryClient.setQueriesData<{items: Order[]}>({queryKey:['orders']}, cached =>
        cached?.items ? {...cached,items:cached.items.map(item => item.id === updated.id ? updated : item)} : cached);
      await Promise.all(['orders', 'paid-orders', 'dashboard', 'analytics', 'customers'].map(key =>
        queryClient.invalidateQueries({ queryKey: [key] })));
      setEditing(false);
    }
  });
  const begin = () => {
    setMethod(order.shippingFeeMethod === 'percentage' ? 'percentage' : 'manual');
    setAmount(order.shippingFeeCents > 0 ? order.shippingFeeCents / 100 : undefined);
    setPercentage(order.shippingFeeBasisPoints !== undefined && order.shippingFeeBasisPoints !== null ? String(order.shippingFeeBasisPoints / 100).replace('.', ',') : '');
    setRevision(order.shippingFeeRevision ?? 0);
    setCostBase(order.costTotalCents);
    setPercentageNotice(false);
    save.reset();
    setEditing(true);
  };
  if (!editable && order.shippingFeeCents === 0 && !shippingFeeNeedsReview(order)) return null;
  return <div className="space-y-3 border-b border-ink-950/8 pb-3">
    <div className="flex min-h-11 items-center justify-between gap-2 text-sm">
      <span className="font-semibold text-ink-700">Costo de envío</span>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {order.shippingFeeCents > 0 ? <span className="font-bold text-ink-950">{formatMoney(order.shippingFeeCents)}</span> : null}
        {editable && !active ? <button type="button" disabled={disabled} ref={toggleRef} onClick={begin} aria-expanded={false} aria-controls={editorId}
          className="min-h-11 px-1 text-sm font-bold text-brand-800 hover:underline disabled:opacity-50">{order.shippingFeeCents > 0 ? 'Editar' : 'Agregar'}</button> : null}
      </div>
    </div>
    {shippingFeeNeedsReview(order) && !active ? <p role="alert" className="text-xs font-semibold text-rose-800">{canEdit ? 'Cambió el costo de los productos. Revisá el porcentaje antes de cobrar.' : 'La dueña debe revisar el envío antes de cobrar este pedido.'}</p> : null}
    {active ? <fieldset id={editorId} disabled={disabled || save.isPending} className="space-y-3">
      <legend className="sr-only">Editar costo de envío del pedido {order.number}</legend>
      <p className="text-xs text-ink-700">Este cargo se suma a lo que paga el cliente, también si retira el pedido.</p>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Cómo calcular el envío">
        <Button type="button" size="sm" variant={method === 'manual' ? 'dark' : 'secondary'} className="min-w-0 px-2 text-xs" aria-pressed={method === 'manual'} onClick={() => setMethod('manual')}>Monto manual</Button>
        <Button type="button" size="sm" variant={method === 'percentage' ? 'dark' : 'secondary'} className="min-w-0 px-2 text-xs" aria-pressed={method === 'percentage'} onClick={() => setMethod('percentage')}>Porcentaje</Button>
      </div>
      {method === 'manual' ? <Field label="Envío en pesos" hint="En blanco o 0 quita el cargo.">
        <CurrencyInput wholePesosOnly value={amount} onChange={setAmount} placeholder="12.500" autoFocus />
      </Field> : <Field label="Porcentaje del costo" hint="Entre 0 y 100 %. Hasta dos decimales.">
        <Input type="text" inputMode="decimal" value={percentage} placeholder="5" autoFocus onChange={event => {
          const raw = event.target.value;
          setPercentageNotice(!/^\d{0,3}(?:[,.]\d{0,2})?$/.test(raw));
          if (/^\d{0,3}(?:[,.]\d{0,2})?$/.test(raw)) setPercentage(raw);
        }} />
      </Field>}
      {method === 'percentage' ? <p className="text-xs text-ink-700">Costo de los productos: <strong>{formatMoney(costBase ?? 0)}</strong>. Se redondea el cargo al peso más cercano.</p> : null}
      {method === 'percentage' && percentageNotice ? <p role="alert" className="text-xs font-semibold text-rose-800">Ingresá solo el número del porcentaje, sin signos ni letras. Por ejemplo: 5.</p> : null}
      {costChanged ? <p role="alert" className="text-xs font-semibold text-rose-800">Cambió el costo de los productos mientras editabas. Cancelá y abrí la edición otra vez para revisar el nuevo monto.</p> : null}
      <dl aria-live="polite" className="space-y-1 text-sm">
        <div className="flex justify-between gap-2"><dt>Envío</dt><dd className="font-bold">{calculated === null ? 'Revisá el porcentaje' : formatMoney(calculated)}</dd></div>
        <div className="flex justify-between gap-2"><dt>Total a cobrar</dt><dd className="font-bold">{calculated === null ? '—' : formatMoney(order.subtotalCents + calculated)}</dd></div>
      </dl>
      {changedElsewhere && !save.isPending ? <p role="alert" className="text-xs font-semibold text-rose-800">El envío fue modificado en otra pantalla. Cancelá la edición y abrila otra vez para revisar el importe actualizado.</p> : null}
      {save.error ? <ErrorState error={save.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancelar</Button>
        <Button type="button" size="sm" variant="dark" loading={save.isPending} disabled={calculated === null || changedElsewhere || costChanged || (method === 'percentage' && percentageNotice)} onClick={() => save.mutate()}>Guardar envío</Button>
      </div>
      <p className="text-xs text-ink-700">Guardá o cancelá esta edición antes de cobrar.</p>
    </fieldset> : null}
  </div>;
}
