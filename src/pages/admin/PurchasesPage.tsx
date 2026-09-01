import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, ChevronRight, PackagePlus, Plus, Truck, X } from 'lucide-react';
import { useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { RoleGate } from '@/components/layout/RoleGate';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { StatusChip } from '@/components/ui/StatusChip';
import { sanitizeDecimalInput, sanitizeIntegerInput } from '@/domain/inventory';
import { formatMoney, pesosToCents } from '@/domain/money';
import { formatProducts, formatUnits } from '@/domain/quantity';
import { getBusinessApi } from '@/services/business-api';

type DraftLine = { productId: string; quantity: number; unitCostPesos: number };

function PurchaseForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [supplier, setSupplier] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ productId: '', quantity: 1, unitCostPesos: 0 }]);
  const productsQuery = useBusinessQuery({ queryKey: queryKeys.products, queryFn: (api) => api.listAdminProducts() });
  const create = useMutation({
    mutationFn: async () => (await getBusinessApi()).createPurchase({
      supplierName: supplier.trim() || 'Proveedor no informado',
      expectedAt: expectedAt ? new Date(`${expectedAt}T12:00:00-03:00`).toISOString() : null,
      notes: notes.trim() || null,
      items: lines.map((line) => ({ productId: line.productId, quantity: line.quantity, unitCostCents: pesosToCents(line.unitCostPesos) }))
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.purchasesRoot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      ]);
      onClose();
    }
  });
  const valid = lines.length > 0 && lines.every((line) => line.productId && line.quantity > 0 && line.unitCostPesos >= 0);
  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      ariaLabelledBy="purchase-title"
      maxWidth="lg"
      className="p-0 flex flex-col max-h-[90vh] overflow-hidden"
    >
      {/* Header fijo */}
      <div className="flex items-start justify-between border-b border-ink-950/6 bg-white px-6 pt-6 pb-4 sm:px-8 sm:pt-8 shrink-0">
        <div>
          <h2 id="purchase-title" className="font-display text-2xl sm:text-3xl font-black text-ink-950">
            Nuevo pedido al proveedor
          </h2>
          <p className="mt-1 text-[14.5px] font-medium text-ink-700">
            Anotá qué pediste y cuándo debería llegar.
          </p>
        </div>
        <button
          className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-cream-100 text-ink-600 transition"
          onClick={onClose}
          aria-label="Cerrar modal"
        >
          <X className="size-5" />
        </button>
      </div>

      {/* Contenido scrolleable: 1 decisión importante por fila */}
      <div className="flex-1 overflow-y-auto px-6 py-5 sm:px-8 space-y-5 custom-scrollbar">
        {/* Proveedor */}
        <Field label="Proveedor · opcional">
          <Input
            placeholder="Ej. Star Nutrition"
            value={supplier}
            onChange={(event) => setSupplier(event.target.value)}
          />
        </Field>

        {/* Cuándo debería llegar */}
        <Field label="Cuándo debería llegar">
          <Input
            type="date"
            value={expectedAt}
            onChange={(event) => setExpectedAt(event.target.value)}
            onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
            className="cursor-pointer w-full"
          />
        </Field>

        {/* Sección de productos */}
        <div className="space-y-3 pt-2">
          <h3 className="text-[13px] font-black uppercase tracking-wider text-ink-700">
            PRODUCTOS ({lines.length})
          </h3>

          <Button
            type="button"
            variant="secondary"
            className="w-full min-h-12 rounded-2xl text-[14.5px] font-bold"
            onClick={() => setLines((current) => [...current, { productId: '', quantity: 1, unitCostPesos: 0 }])}
          >
            + Agregar producto
          </Button>

          <div className="space-y-4 pt-1">
            {lines.map((line, index) => (
              <div
                key={index}
                className="space-y-4 rounded-2xl border border-ink-950/8 bg-cream-50/40 p-4 sm:p-5 transition"
              >
                {/* Selector de producto con botón de eliminar táctil 44x44 */}
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Select
                      placeholder="Seleccionar producto…"
                      value={line.productId}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((entry, position) =>
                            position === index
                              ? {
                                  ...entry,
                                  productId: event.target.value,
                                  unitCostPesos:
                                    (productsQuery.data?.find((product) => product.id === event.target.value)
                                      ?.currentCostCents ?? 0) / 100
                                }
                              : entry
                          )
                        )
                      }
                    >
                      <option value="">Seleccionar producto…</option>
                      {productsQuery.data
                        ?.filter((product) => product.active)
                        .map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.name} {product.presentation ? `(${product.presentation})` : ''}
                          </option>
                        ))}
                    </Select>
                  </div>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-400 hover:bg-red-50 hover:text-red-600 transition"
                      onClick={() => setLines((current) => current.filter((_, position) => position !== index))}
                      aria-label="Quitar producto"
                    >
                      <X className="size-5" />
                    </button>
                  )}
                </div>

                {/* Cantidad (fila completa) */}
                <Field label="Cantidad">
                  <div className="relative">
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="1"
                      value={line.quantity || ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(event) => {
                        const clean = sanitizeIntegerInput(event.target.value, String(line.quantity || ''));
                        setLines((current) =>
                          current.map((entry, position) =>
                            position === index
                              ? { ...entry, quantity: clean === '' ? 0 : parseInt(clean, 10) }
                              : entry
                          )
                        );
                      }}
                      className="pr-8"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-ink-500 pointer-events-none">
                      u.
                    </span>
                  </div>
                </Field>

                {/* Costo por unidad (fila completa) */}
                <Field label="Costo por unidad">
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] font-bold text-ink-500 pointer-events-none">
                      $
                    </span>
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      value={line.unitCostPesos ? line.unitCostPesos.toLocaleString('es-AR') : ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(event) => {
                        const clean = sanitizeDecimalInput(event.target.value.replace(/\./g, ''), String(line.unitCostPesos || ''));
                        setLines((current) =>
                          current.map((entry, position) =>
                            position === index
                              ? { ...entry, unitCostPesos: clean === '' ? 0 : parseFloat(clean) || 0 }
                              : entry
                          )
                        );
                      }}
                      className="pl-8"
                    />
                  </div>
                </Field>
              </div>
            ))}
          </div>
        </div>

        <Field label="Notas · opcional">
          <Input
            placeholder="Ej. 50% pagado. Resto contra entrega."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>

        {create.error ? <ErrorState error={create.error} /> : null}
      </div>

      {/* Footer fijo sticky */}
      <div className="flex items-center justify-end gap-3 border-t border-ink-950/8 bg-cream-50/70 px-6 py-4 sm:px-8 shrink-0 rounded-b-[2rem]">
        <Button variant="ghost" onClick={onClose} className="min-h-12 px-5 text-[15px] font-bold">
          Cancelar
        </Button>
        <Button
          variant="dark"
          disabled={!valid}
          loading={create.isPending}
          onClick={() => create.mutate()}
          className="min-h-12 px-6 text-[15px] font-black"
        >
          Guardar pedido
        </Button>
      </div>
    </Modal>
  );
}

export default function PurchasesPage() {
  const [formOpen, setFormOpen] = useState(false);
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();
  const purchasesQuery = useBusinessQuery({ queryKey: queryKeys.purchases(page), queryFn: (api) => api.listPurchases(page, 20) });
  const receive = useMutation({
    mutationFn: async (id: string) => (await getBusinessApi()).receivePurchase(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.purchasesRoot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: ['movements'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      ]);
    }
  });
  return (
    <RoleGate capability="manage_purchases">
      <div className="page-enter">
        <PageHeader title="Compras" description="Lo pedido suma al stock proyectado. Recién al recibirlo aumenta el stock físico." action={<Button onClick={() => setFormOpen(true)}><PackagePlus className="size-4" /> Nueva compra</Button>} />
        {purchasesQuery.isPending ? <LoadingState label="Cargando compras…" /> : null}
        {purchasesQuery.isError ? <ErrorState error={purchasesQuery.error} onRetry={() => void purchasesQuery.refetch()} /> : null}
        {receive.error ? <div className="mb-5"><ErrorState error={receive.error} /></div> : null}
        <div className="space-y-4">{purchasesQuery.data?.items.map((purchase) => (
          <article key={purchase.id} className="rounded-[1.75rem] border border-ink-950/7 bg-white p-5 shadow-card sm:p-6">
            <div className="grid gap-4 sm:grid-cols-[5rem_1fr_auto] sm:items-center"><span className="font-display text-xl font-black">#{purchase.number}</span><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-black">{purchase.supplierName}</h2><StatusChip label={purchase.state === 'ordered' ? 'En camino' : purchase.state === 'received' ? 'Recibida' : purchase.state === 'draft' ? 'Borrador' : 'Cancelada'} tone={purchase.state === 'ordered' ? 'info' : purchase.state === 'received' ? 'success' : 'neutral'} /></div><p className="mt-1 text-xs font-semibold text-ink-600">{formatUnits(purchase.items.reduce((sum, item) => sum + item.quantity, 0))} · {formatProducts(purchase.items.length)}</p></div><strong className="font-display text-xl">{formatMoney(purchase.totalCostCents)}</strong></div>
            <div className="mt-5 grid gap-3 border-t border-ink-950/8 pt-5 sm:grid-cols-[1fr_auto] sm:items-end"><div className="space-y-2">{purchase.items.map((item) => <div key={item.id} className="flex justify-between gap-4 text-sm"><span>{item.productName} × {item.quantity}</span><span className="font-bold text-ink-600">{formatMoney(item.unitCostCents)} c/u</span></div>)}</div>{purchase.state === 'ordered' ? <Button variant="dark" loading={receive.isPending && receive.variables === purchase.id} onClick={() => receive.mutate(purchase.id)}><CheckCircle2 className="size-4" /> Marcar recibida</Button> : <span className="inline-flex items-center gap-2 text-sm font-bold text-emerald-700"><CheckCircle2 className="size-4" /> Stock actualizado</span>}</div>
          </article>
        ))}</div>
        {purchasesQuery.data && purchasesQuery.data.total > purchasesQuery.data.pageSize ? <nav className="mt-5 flex items-center justify-between rounded-2xl bg-white p-4 shadow-card" aria-label="Páginas de compras"><Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft className="size-4" /> Anterior</Button><span className="text-sm font-bold text-ink-600">Página {page} de {Math.ceil(purchasesQuery.data.total / purchasesQuery.data.pageSize)}</span><Button variant="ghost" size="sm" disabled={page * purchasesQuery.data.pageSize >= purchasesQuery.data.total} onClick={() => setPage((current) => current + 1)}>Siguiente <ChevronRight className="size-4" /></Button></nav> : null}
        {formOpen ? <PurchaseForm onClose={() => setFormOpen(false)} /> : null}
      </div>
    </RoleGate>
  );
}
