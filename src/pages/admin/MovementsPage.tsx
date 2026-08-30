import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, History } from 'lucide-react';
import { useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { cn } from '@/lib/cn';

const kindLabel = {
  sale: 'Venta',
  purchase_received: 'Compra recibida',
  return: 'Devolución',
  adjustment: 'Ajuste',
  reservation: 'Reserva',
  reservation_release: 'Liberación de reserva'
} as const;

export default function MovementsPage() {
  const [page, setPage] = useState(1);
  const movementsQuery = useBusinessQuery({
    queryKey: queryKeys.movements(page),
    queryFn: (api) => api.listMovements(page, 30)
  });
  return (
    <div className="page-enter">
      <PageHeader title="Movimientos" description="Cada cambio de stock conserva producto, causa, persona y relación con el pedido o la compra que lo originó." />
      {movementsQuery.isPending ? <LoadingState label="Cargando movimientos…" /> : null}
      {movementsQuery.isError ? <ErrorState error={movementsQuery.error} onRetry={() => void movementsQuery.refetch()} /> : null}
      {movementsQuery.data ? (
        <>
          <section className="overflow-hidden rounded-[2rem] bg-white shadow-card">
            <div className="divide-y divide-ink-950/8">
              {movementsQuery.data.items.map((movement) => (
                <article key={movement.id} className="grid gap-3 p-5 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:px-6">
                  <span className={cn('grid size-11 place-items-center rounded-2xl', movement.physicalDelta < 0 || movement.reservedDelta < 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700')}>{movement.physicalDelta < 0 || movement.reservedDelta < 0 ? <ArrowDown className="size-4" /> : <ArrowUp className="size-4" />}</span>
                  <div><div className="flex flex-wrap items-center gap-2"><h2 className="font-black">{movement.productName}</h2><span className="rounded-full bg-cream-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-ink-600">{kindLabel[movement.kind]}</span></div><p className="mt-1 text-sm text-ink-600">{movement.reason}</p><p className="mt-2 text-xs font-semibold text-ink-600"><History className="mr-1 inline size-3.5" /> {new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(movement.createdAt))} · {movement.createdByName}</p></div>
                  <div className="rounded-2xl bg-cream-100 px-4 py-3 text-sm font-black sm:text-right"><p>{movement.physicalDelta > 0 ? '+' : ''}{movement.physicalDelta} físico</p><p className="mt-1 text-xs text-ink-600">{movement.reservedDelta > 0 ? '+' : ''}{movement.reservedDelta} reservado</p></div>
                </article>
              ))}
            </div>
          </section>
          {movementsQuery.data.items.length === 0 ? <div className="rounded-2xl bg-white p-8 text-center text-sm font-semibold text-ink-600 shadow-card">Todavía no hay movimientos.</div> : null}
          {movementsQuery.data.total > movementsQuery.data.pageSize ? <nav className="mt-5 flex items-center justify-between rounded-2xl bg-white p-4 shadow-card" aria-label="Páginas de movimientos"><Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft className="size-4" /> Anterior</Button><span className="text-sm font-bold text-ink-600">Página {page} de {Math.ceil(movementsQuery.data.total / movementsQuery.data.pageSize)}</span><Button variant="ghost" size="sm" disabled={page * movementsQuery.data.pageSize >= movementsQuery.data.total} onClick={() => setPage((current) => current + 1)}>Siguiente <ChevronRight className="size-4" /></Button></nav> : null}
        </>
      ) : null}
    </div>
  );
}
