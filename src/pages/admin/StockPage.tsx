import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Boxes,
  ChevronDown,
  ChevronRight,
  Info,
  PackagePlus,
  Search,
  SlidersHorizontal,
  Sparkles,
  X
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { StatusChip } from '@/components/ui/StatusChip';
import { can } from '@/domain/permissions';
import { formatUnits } from '@/domain/quantity';
import type { InventoryItem } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/cn';
import { getBusinessApi } from '@/services/business-api';

const labels: Record<InventoryItem['status'], string> = {
  ok: 'OK',
  low: 'COMPRAR',
  critical: 'URGENTE',
  out: 'SIN STOCK'
};

export default function StockPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'attention' | 'ok'>('all');
  const [search, setSearch] = useState('');
  const [detailItem, setDetailItem] = useState<InventoryItem | null>(null);
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');

  const inventoryQuery = useBusinessQuery({
    queryKey: queryKeys.inventory,
    queryFn: (api) => api.listInventory()
  });

  const movementsQuery = useBusinessQuery({
    queryKey: queryKeys.movements(1),
    queryFn: (api) => api.listMovements(1, 8)
  });

  const adjustment = useMutation({
    mutationFn: async () => {
      if (!adjustItem) return;
      await (await getBusinessApi()).adjustStock(adjustItem.id, Number(delta), reason);
    },
    onSuccess: async () => {
      setAdjustItem(null);
      setDelta('');
      setReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: ['movements'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products })
      ]);
    }
  });

  const filteredItems = useMemo(() => {
    const raw = inventoryQuery.data ?? [];
    return raw
      .filter((item) => {
        const matchesSearch =
          !search ||
          item.name.toLowerCase().includes(search.toLowerCase()) ||
          item.sku.toLowerCase().includes(search.toLowerCase());
        if (!matchesSearch) return false;
        if (filter === 'attention') return item.status !== 'ok';
        if (filter === 'ok') return item.status === 'ok';
        return true;
      })
      .sort((left, right) => {
        const priority = { out: 0, critical: 1, low: 2, ok: 3 };
        return priority[left.status] - priority[right.status] || left.name.localeCompare(right.name);
      });
  }, [inventoryQuery.data, search, filter]);

  const attentionCount = useMemo(
    () => (inventoryQuery.data ?? []).filter((i) => i.status !== 'ok').length,
    [inventoryQuery.data]
  );

  return (
    <div className="page-enter">
      <PageHeader
        title="Stock y disponibilidad"
        description="Vista simple y adaptativa: lo que está en orden se comprime; lo que requiere atención destaca la acción recomendada."
      />

      {/* Controles superiores limpios */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={cn(
              'min-h-9 rounded-full px-3.5 text-xs font-black transition',
              filter === 'all'
                ? 'bg-ink-950 text-white'
                : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
            )}
            onClick={() => setFilter('all')}
          >
            Todos ({inventoryQuery.data?.length ?? 0})
          </button>
          <button
            type="button"
            className={cn(
              'min-h-9 rounded-full px-3.5 text-xs font-black transition',
              filter === 'attention'
                ? 'bg-coral-400 text-ink-950'
                : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
            )}
            onClick={() => setFilter('attention')}
          >
            Requieren atención ({attentionCount})
          </button>
          <button
            type="button"
            className={cn(
              'min-h-9 rounded-full px-3.5 text-xs font-black transition',
              filter === 'ok'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
            )}
            onClick={() => setFilter('ok')}
          >
            En orden ({(inventoryQuery.data?.length ?? 0) - attentionCount})
          </button>
        </div>

        <div className="relative min-w-48 sm:w-64">
          <Search className="absolute left-3 top-2.5 size-4 text-ink-600" />
          <input
            type="search"
            placeholder="Buscar por nombre o SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-full border border-ink-950/12 bg-white pl-9 pr-4 text-xs font-bold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
      </div>

      {inventoryQuery.isPending ? <LoadingState label="Calculando stock disponible…" /> : null}
      {inventoryQuery.isError ? (
        <ErrorState error={inventoryQuery.error} onRetry={() => void inventoryQuery.refetch()} />
      ) : null}

      {inventoryQuery.data ? (
        <>
          {/* Lista Adaptativa Guiada por Excepciones */}
          <section className="space-y-3" aria-label="Catálogo de inventario">
            {filteredItems.map((item) => {
              const isException = item.status !== 'ok';
              return (
                <article
                  key={item.id}
                  className={cn(
                    'group flex flex-col justify-between rounded-[1.5rem] border bg-white p-4 shadow-card transition sm:flex-row sm:items-center sm:p-5',
                    isException
                      ? item.status === 'out' || item.status === 'critical'
                        ? 'border-red-300 bg-red-50/20 ring-1 ring-red-200'
                        : 'border-amber-300 bg-amber-50/20 ring-1 ring-amber-200'
                      : 'border-ink-950/7 hover:border-ink-950/15'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-3.5">
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="size-12 shrink-0 rounded-2xl bg-cream-100 object-cover"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate font-display text-base font-black text-ink-950 sm:text-lg">
                          {item.name}
                        </h2>
                        <span className="text-xs font-semibold text-ink-600">{item.presentation}</span>
                      </div>

                      {/* Línea Adaptativa contextual solo cuando hay anomalía */}
                      {isException ? (
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-bold text-coral-400">
                          <Sparkles className="size-3.5 shrink-0" />
                          <span>
                            {item.incoming > 0
                              ? `${item.incoming} en camino · `
                              : 'Sin compras en camino · '}
                            Sugerencia: comprar {formatUnits(item.suggestedPurchase)}
                          </span>
                        </p>
                      ) : (
                        <p className="mt-0.5 text-xs text-ink-600">{item.sku}</p>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-4 border-t border-ink-950/6 pt-3 sm:mt-0 sm:border-0 sm:pt-0">
                    <div className="text-right">
                      <div className="flex items-center gap-2 sm:justify-end">
                        <span className="text-[11px] font-black uppercase tracking-wider text-ink-600">
                          Disponible
                        </span>
                        <strong
                          className={cn(
                            'font-display text-2xl font-black',
                            isException ? 'text-coral-400' : 'text-ink-950'
                          )}
                        >
                          {item.available}
                        </strong>
                      </div>
                    </div>

                    <StatusChip
                      label={labels[item.status]}
                      tone={
                        item.status === 'ok'
                          ? 'success'
                          : item.status === 'low'
                          ? 'warning'
                          : 'danger'
                      }
                    />

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDetailItem(item)}
                      aria-label={`Ver detalle completo de ${item.name}`}
                      className="ml-1"
                    >
                      <Info className="size-4" />
                      <span className="hidden md:inline">Detalles</span>
                    </Button>
                  </div>
                </article>
              );
            })}
          </section>

          {/* Últimos movimientos colapsables al fondo */}
          <section className="mt-9 rounded-[2rem] bg-white p-5 shadow-card sm:p-6">
            <div className="flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-2xl bg-cream-100">
                <Boxes className="size-5" />
              </span>
              <div>
                <h2 className="font-display text-2xl font-black">Historial de movimientos</h2>
                <p className="text-xs font-semibold text-ink-600">
                  Cada variación de stock conserva producto, causa y autor.
                </p>
              </div>
            </div>
            {movementsQuery.isError ? (
              <div className="mt-5">
                <ErrorState error={movementsQuery.error} />
              </div>
            ) : null}
            <div className="mt-5 divide-y divide-ink-950/8">
              {movementsQuery.data?.items.map((movement) => (
                <article
                  key={movement.id}
                  className="grid gap-2 py-3.5 sm:grid-cols-[auto_1fr_auto] sm:items-center"
                >
                  <span
                    className={cn(
                      'grid size-9 place-items-center rounded-full',
                      movement.physicalDelta >= 0
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-red-100 text-red-700'
                    )}
                  >
                    {movement.physicalDelta >= 0 ? (
                      <ArrowUp className="size-3.5" />
                    ) : (
                      <ArrowDown className="size-3.5" />
                    )}
                  </span>
                  <div>
                    <h3 className="text-sm font-black">{movement.productName}</h3>
                    <p className="mt-0.5 text-xs text-ink-600">
                      {movement.reason} · {movement.createdByName}
                    </p>
                  </div>
                  <div className="text-xs font-black sm:text-right">
                    <p>
                      {movement.physicalDelta > 0 ? '+' : ''}
                      {movement.physicalDelta} físico
                    </p>
                    {movement.reservedDelta !== 0 ? (
                      <p className="text-ink-600">
                        {movement.reservedDelta > 0 ? '+' : ''}
                        {movement.reservedDelta} reservado
                      </p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {/* Modal / Drawer de Detalle Bajo Demanda (Progressive Disclosure) */}
      {detailItem ? (
        <Modal isOpen={true} onClose={() => setDetailItem(null)} ariaLabelledBy="detail-title" maxWidth="xl">
          <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <img
                  src={detailItem.imageUrl}
                  alt=""
                  className="size-14 rounded-2xl bg-cream-100 object-cover"
                />
                <div>
                  <p className="text-xs font-black uppercase tracking-wider text-brand-600">
                    {detailItem.sku}
                  </p>
                  <h2 id="detail-title" className="font-display text-2xl font-black">
                    {detailItem.name}
                  </h2>
                </div>
              </div>
              <button
                type="button"
                className="grid size-9 place-items-center rounded-full hover:bg-cream-100"
                onClick={() => setDetailItem(null)}
                aria-label="Cerrar detalles"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Desglose Transaccional de Stock */}
            <div className="mt-6">
              <h3 className="text-xs font-black uppercase tracking-wider text-ink-600">
                Radiografía de Unidades
              </h3>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-2xl bg-cream-100 p-3">
                  <p className="text-[10px] font-black uppercase tracking-wider text-ink-600">
                    Físico en Local
                  </p>
                  <p className="mt-1 font-display text-2xl font-black">{detailItem.onHand}</p>
                </div>
                <div className="rounded-2xl bg-cream-100 p-3">
                  <p className="text-[10px] font-black uppercase tracking-wider text-ink-600">
                    Reservado
                  </p>
                  <p className="mt-1 font-display text-2xl font-black">{detailItem.reserved}</p>
                </div>
                <div className="rounded-2xl border border-brand-200/60 bg-brand-50/80 p-3">
                  <p className="text-[10px] font-black uppercase tracking-wider text-brand-600">
                    Disponible
                  </p>
                  <p className="mt-1 font-display text-2xl font-black text-brand-600">
                    {detailItem.available}
                  </p>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-center text-xs font-bold text-ink-700">
                <div className="rounded-xl border border-ink-950/8 p-2">
                  <span>En camino por compras: </span>
                  <strong className="text-ink-950">{detailItem.incoming}</strong>
                </div>
                <div className="rounded-xl border border-ink-950/8 p-2">
                  <span>Stock proyectado: </span>
                  <strong className="text-ink-950">{detailItem.projected}</strong>
                </div>
              </div>
            </div>

            {/* Métricas de Reposición y Cobertura */}
            <div className="mt-5 rounded-2xl bg-cream-50 p-4 text-xs font-semibold text-ink-700 space-y-2">
              <h3 className="text-[11px] font-black uppercase tracking-wider text-ink-600">
                Cálculos de reposición
              </h3>
              <div className="flex justify-between">
                <span>Venta media diaria:</span>
                <strong>{detailItem.averageDailySales} unidades/día</strong>
              </div>
              <div className="flex justify-between">
                <span>Días de cobertura estimados:</span>
                <strong>
                  {detailItem.coverageDays === null ? 'Sin ventas' : `${detailItem.coverageDays} días`}
                </strong>
              </div>
              <div className="flex justify-between">
                <span>Punto de pedido / Stock seguridad:</span>
                <strong>
                  {detailItem.reorderPoint} u / {detailItem.safetyStock} u
                </strong>
              </div>
              <div className="flex justify-between border-t border-ink-950/8 pt-2">
                <span>Sugerencia a comprar al proveedor:</span>
                <strong className="font-black text-brand-600">
                  {formatUnits(detailItem.suggestedPurchase)}
                </strong>
              </div>
            </div>

            {/* Acción de Ajuste Protegida */}
            <div className="mt-6 flex flex-wrap justify-between gap-3">
              {can(user, 'adjust_stock') ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAdjustItem(detailItem);
                    setDetailItem(null);
                  }}
                >
                  <SlidersHorizontal className="size-4" /> Registrar ajuste de stock
                </Button>
              ) : (
                <span />
              )}
              <Button variant="dark" size="sm" onClick={() => setDetailItem(null)}>
                Entendido
              </Button>
            </div>
        </Modal>
      ) : null}

      {/* Modal de Ajuste Manual (Solo Dueña) */}
      {adjustItem ? (
        <Modal isOpen={true} onClose={() => setAdjustItem(null)} ariaLabelledBy="adjust-title" maxWidth="lg">
          <span className="grid size-12 place-items-center rounded-2xl bg-sun-400">
            <AlertTriangle className="size-5" />
          </span>
            <h2 id="adjust-title" className="mt-5 font-display text-3xl font-black">
              Ajustar {adjustItem.name}
            </h2>
            <p className="mt-2 text-sm leading-6 text-ink-600">
              Usalo para corregir diferencias físicas comprobadas (rotura, faltante, conteo).
              Ventas y compras tienen sus propios flujos transaccionales.
            </p>
            <div className="mt-6 space-y-5">
              <Field
                label="Diferencia"
                htmlFor="stock-delta"
                hint="Ejemplo: -2 si faltan dos unidades; 3 si aparecen tres."
              >
                <Input
                  id="stock-delta"
                  type="number"
                  step="1"
                  value={delta}
                  onChange={(event) => setDelta(event.target.value)}
                />
              </Field>
              <Field label="Motivo del ajuste" htmlFor="stock-reason">
                <Input
                  id="stock-reason"
                  placeholder="Ej. Conteo físico de inventario"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              {adjustment.error ? <ErrorState error={adjustment.error} /> : null}
            </div>
            <div className="mt-8 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setAdjustItem(null)}>
                Cancelar
              </Button>
              <Button
                variant="dark"
                loading={adjustment.isPending}
                disabled={
                  !Number.isInteger(Number(delta)) ||
                  Number(delta) === 0 ||
                  reason.trim().length < 3
                }
                onClick={() => adjustment.mutate()}
              >
                Guardar ajuste
              </Button>
            </div>
        </Modal>
      ) : null}
    </div>
  );
}
