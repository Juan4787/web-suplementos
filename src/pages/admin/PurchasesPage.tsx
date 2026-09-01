import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  PackagePlus,
  Plus,
  Truck,
  X
} from 'lucide-react';
import { format, isBefore, isValid, parseISO, startOfDay } from 'date-fns';
import { es } from 'date-fns/locale';
import { useState, type ReactNode } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { RoleGate } from '@/components/layout/RoleGate';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { DatePicker, Field, Input, Select, Textarea } from '@/components/ui/Field';
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
      supplierName: supplier.trim() || 'Sin proveedor',
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
          <DatePicker
            value={expectedAt}
            onChange={(val) => setExpectedAt(val)}
            placeholder="dd/mm/aaaa"
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
  const [expandedPurchases, setExpandedPurchases] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();
  const purchasesQuery = useBusinessQuery({
    queryKey: queryKeys.purchases(page),
    queryFn: (api) => api.listPurchases(page, 20)
  });
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
        <PageHeader
          title="Pedidos al proveedor"
          description="Anotá lo pedido a proveedores para proyectar el stock. Al recibirlo se suma al stock físico."
          action={
            <Button onClick={() => setFormOpen(true)}>
              <PackagePlus className="size-4" /> Nuevo pedido
            </Button>
          }
        />
        {purchasesQuery.isPending ? <LoadingState label="Cargando pedidos al proveedor…" /> : null}
        {purchasesQuery.isError ? (
          <ErrorState error={purchasesQuery.error} onRetry={() => void purchasesQuery.refetch()} />
        ) : null}
        {receive.error ? (
          <div className="mb-5">
            <ErrorState error={receive.error} />
          </div>
        ) : null}

        <div className="space-y-4">
          {purchasesQuery.data?.items.map((purchase) => {
            const totalUnits = purchase.items.reduce((sum, item) => sum + item.quantity, 0);
            const isOpen = expandedPurchases[purchase.id] ?? false;

            let deliveryLabel: ReactNode = <span className="text-ink-500 font-medium">Sin fecha estimada</span>;
            if (purchase.expectedAt) {
              try {
                const parsedDate = typeof purchase.expectedAt === 'string' ? parseISO(purchase.expectedAt) : new Date(purchase.expectedAt);
                if (isValid(parsedDate)) {
                  const today = startOfDay(new Date());
                  const isLate = purchase.state === 'ordered' && isBefore(startOfDay(parsedDate), today);
                  const dateStr = format(parsedDate, 'd MMM', { locale: es });

                  if (isLate) {
                    deliveryLabel = (
                      <span className="font-bold text-amber-800 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
                        Llegaba el {dateStr} · Atrasado
                      </span>
                    );
                  } else {
                    deliveryLabel = (
                      <span className="font-semibold text-ink-700">
                        Llega {dateStr}
                      </span>
                    );
                  }
                }
              } catch {
                // fallback
              }
            }

            return (
              <article key={purchase.id} className="rounded-[1.75rem] border border-ink-950/7 bg-white p-5 shadow-card sm:p-6 transition hover:bg-cream-50/40">
                {/* Fila 1: Pedido #N + Estado */}
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display text-lg sm:text-xl font-black text-ink-950">
                    Pedido #{purchase.number}
                  </h3>
                  <div>
                    {purchase.state === 'received' ? (
                      <StatusChip label="Recibido" tone="success" />
                    ) : (
                      <StatusChip label="En camino" tone="warning" />
                    )}
                  </div>
                </div>

                {/* Fila 2: Proveedor */}
                <p className="mt-1 text-[14px] font-bold text-ink-600">
                  {purchase.supplierName || 'Sin proveedor'}
                </p>

                {/* Fila 3: Unidades · Costo · Llegada | Acción */}
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-ink-950/6 pb-4">
                  <div className="flex flex-wrap items-center gap-2 text-[14px]">
                    <span className="font-bold text-ink-950">
                      {totalUnits} {totalUnits === 1 ? 'unidad' : 'unidades'}
                    </span>
                    <span className="text-ink-400">·</span>
                    <span className="font-black text-ink-950">
                      {formatMoney(purchase.totalCostCents)}
                    </span>
                    <span className="text-ink-400">·</span>
                    {deliveryLabel}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {purchase.state === 'ordered' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={receive.isPending && receive.variables === purchase.id}
                        onClick={() => receive.mutate(purchase.id)}
                        className="font-bold text-xs rounded-xl min-h-9 px-4"
                      >
                        <CheckCircle2 className="size-4 text-emerald-600" /> Marcar como recibido
                      </Button>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-black text-emerald-700 bg-emerald-50 border border-emerald-200/60 px-3 py-1.5 rounded-xl">
                        <Check className="size-3.5" /> Stock actualizado
                      </span>
                    )}
                  </div>
                </div>

                {/* Fila 4: Productos ({count}) ˄ / ˅ (toda la fila clickeable) */}
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => setExpandedPurchases((prev) => ({ ...prev, [purchase.id]: !isOpen }))}
                    className="w-full flex items-center justify-between py-1.5 text-[13.5px] font-bold text-ink-700 hover:text-brand-600 transition"
                  >
                    <span>Productos ({purchase.items.length})</span>
                    {isOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                  </button>

                  {isOpen && (
                    <div className="mt-2.5 rounded-2xl bg-cream-50/70 p-4 space-y-2.5 border border-ink-950/6">
                      {purchase.items.map((item, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-4 text-[13.5px]">
                          <div>
                            <p className="font-bold text-ink-950">{item.productName}</p>
                            <p className="text-xs font-semibold text-ink-600">
                              {item.quantity} {item.quantity === 1 ? 'unidad' : 'unidades'}
                            </p>
                          </div>
                          <span className="text-sm font-semibold text-ink-700 shrink-0">
                            {formatMoney(item.unitCostCents * item.quantity)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {purchasesQuery.data && purchasesQuery.data.total > purchasesQuery.data.pageSize ? (
          <nav className="mt-5 flex items-center justify-between rounded-2xl bg-white p-4 shadow-card" aria-label="Páginas de pedidos al proveedor">
            <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              <ChevronLeft className="size-4" /> Anterior
            </Button>
            <span className="text-sm font-bold text-ink-600">Página {page} de {Math.ceil(purchasesQuery.data.total / purchasesQuery.data.pageSize)}</span>
            <Button variant="ghost" size="sm" disabled={page * purchasesQuery.data.pageSize >= purchasesQuery.data.total} onClick={() => setPage((current) => current + 1)}>
              Siguiente <ChevronRight className="size-4" />
            </Button>
          </nav>
        ) : null}

        {formOpen ? <PurchaseForm onClose={() => setFormOpen(false)} /> : null}
      </div>
    </RoleGate>
  );
}
