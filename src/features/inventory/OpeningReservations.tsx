import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { AppError } from '@/domain/errors';
import type { OpeningReservation } from '@/domain/types';
import { getBusinessApi } from '@/services/business-api';

type Selection = { reservation: OpeningReservation; action: 'deliver' | 'release' };

export function OpeningReservations({ canReceive, onOpenPurchases }: { canReceive: boolean; onOpenPurchases: () => void }) {
  const client = useQueryClient();
  const query = useBusinessQuery({ queryKey: queryKeys.openingReservations, queryFn: api => api.listOpeningReservations() });
  const [selection, setSelection] = useState<Selection | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [notice, setNotice] = useState('');
  const refresh = () => Promise.all([
    queryKeys.openingReservations, queryKeys.inventory, queryKeys.products, queryKeys.dashboard,
    queryKeys.purchasesRoot, ['movements'], queryKeys.storefrontProducts, ['storefront-product']
  ].map(queryKey => client.invalidateQueries({ queryKey })));
  const mutation = useMutation({
    mutationFn: async () => {
      if (!selection) throw new AppError('validation', 'Elegí la reserva que querés actualizar.');
      return (await getBusinessApi()).resolveOpeningReservation(selection.reservation.purchaseItemId, Number(quantity), selection.action, operationId);
    },
    retry: (count, error) => count < 1 && error instanceof AppError && error.retryable,
    onSuccess: async result => {
      const verb = result.action === 'deliver' ? (result.quantity === 1 ? 'entregada' : 'entregadas') : (result.quantity === 1 ? 'liberada' : 'liberadas');
      setNotice(`${selection?.reservation.productName}: ${result.quantity} ${result.quantity === 1 ? 'unidad' : 'unidades'} ${verb}. Stock actualizado.`);
      setSelection(null);
      await refresh();
    },
    onError: async () => { await refresh(); }
  });
  const select = (reservation: OpeningReservation, action: Selection['action']) => {
    mutation.reset(); setQuantity('1'); setOperationId(crypto.randomUUID()); setSelection({ reservation, action });
  };
  const current = query.data?.find(row => row.purchaseItemId === selection?.reservation.purchaseItemId) ?? selection?.reservation;
  const max = selection?.action === 'deliver' ? current?.physicalQuantity ?? 0 : current?.totalQuantity ?? 0;
  const retrying = mutation.isError && mutation.error instanceof AppError && mutation.error.retryable;
  const invalid = !Number.isInteger(Number(quantity)) || Number(quantity) < 1 || (!retrying && Number(quantity) > max);

  if (query.isPending) return <LoadingState label="Consultando reservas previas…" />;
  if (!query.isError && !query.data?.length && !notice && !selection) return null;
  return <section className="mb-6 rounded-2xl border border-brand-200 bg-white p-4 sm:p-5" aria-labelledby="opening-reservations-title">
    <h2 id="opening-reservations-title" className="text-lg font-black text-ink-950">Reservas previas</h2>
    <p className="mt-1 text-sm text-ink-700">Unidades apartadas antes de empezar a usar la tienda. Se gestionan acá y no registran nuevos cobros ni ventas.</p>
    {notice ? <p role="status" className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm font-bold text-emerald-900">{notice}</p> : null}
    {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
    <div className="mt-4 grid gap-3 lg:grid-cols-3">
      {query.data?.map(row => <article key={row.purchaseItemId} className="rounded-xl border border-ink-950/10 p-4">
        <h3 className="font-bold text-ink-950">{row.productName}</h3>
        <p className="mt-1 text-sm text-ink-700">Compra #{row.purchaseNumber} · {row.totalQuantity} {row.totalQuantity === 1 ? 'unidad apartada' : 'unidades apartadas'}</p>
        <p className="mt-2 text-sm font-semibold">Para entregar: {row.physicalQuantity} · En camino: {row.incomingQuantity}</p>
        {row.uncoveredQuantity > 0 ? <p className="mt-2 text-sm font-bold text-amber-900">Faltan {row.uncoveredQuantity} unidades que el proveedor no entregará. Acordá una alternativa; liberá la reserva si se cancela.</p> : null}
        {row.physicalQuantity === 0 && row.incomingQuantity > 0 ? <p className="mt-2 text-sm text-ink-700">{canReceive ? 'Primero registrá la recepción de la compra.' : 'Pedí que registren la recepción de la compra para poder anotar la entrega.'}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={row.physicalQuantity === 0} onClick={() => select(row, 'deliver')}>Registrar entrega</Button>
          <Button size="sm" variant="ghost" onClick={() => select(row, 'release')}>Liberar reserva</Button>
        </div>
      </article>)}
    </div>
    {canReceive && query.data?.some(row => row.incomingQuantity > 0) ? <Button className="mt-3" size="sm" variant="secondary" onClick={onOpenPurchases}>Ir a Compras para recibir</Button> : null}
    {selection ? <Modal ariaLabelledBy="resolve-opening-title" maxWidth="sm" onClose={() => { if (!mutation.isPending) setSelection(null); }}>
      <h2 id="resolve-opening-title" className="text-xl font-black">{selection.action === 'deliver' ? 'Registrar entrega previa' : 'Liberar reserva previa'}</h2>
      <p className="mt-2 font-bold">{selection.reservation.productName}</p>
      <p className="mt-2 text-sm text-ink-700">{selection.action === 'deliver' ? 'Confirmá únicamente las unidades que ya entregaste. Se descuentan del stock físico; no se registra un nuevo cobro.' : 'Usá esta opción si ya no necesitás apartar estas unidades. Volverán a estar disponibles para otros pedidos.'}</p>
      <div className="mt-4"><Field label="Unidades" hint={`Podés registrar hasta ${max} unidades.`}>
        <Input type="number" min={1} max={max} step={1} value={quantity} disabled={mutation.isPending} onChange={event => { setQuantity(event.target.value); setOperationId(crypto.randomUUID()); mutation.reset(); }} />
      </Field></div>
      {invalid ? <p role="status" className="mt-2 text-sm font-bold text-amber-900">Ingresá una cantidad entera entre 1 y {max}.</p> : null}
      {mutation.isError ? <ErrorState error={mutation.error} /> : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={mutation.isPending} onClick={() => setSelection(null)}>Cancelar</Button>
        <Button loading={mutation.isPending} disabled={invalid} onClick={() => mutation.mutate()}>{selection.action === 'deliver' ? 'Confirmar entrega' : 'Confirmar liberación'}</Button>
      </div>
    </Modal> : null}
  </section>;
}
