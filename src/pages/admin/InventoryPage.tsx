import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  History,
  Info,
  PackagePlus,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Store,
  Truck,
  X
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Drawer, Modal } from '@/components/ui/Modal';
import { StatusChip } from '@/components/ui/StatusChip';
import { inventoryStatus } from '@/domain/inventory';
import { formatMoney, pesosToCents } from '@/domain/money';
import { can } from '@/domain/permissions';
import { formatProducts, formatUnits } from '@/domain/quantity';
import type { InventoryItem } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/cn';
import { getBusinessApi } from '@/services/business-api';

const statusLabels: Record<InventoryItem['status'], string> = {
  ok: 'En orden',
  low: 'Stock bajo',
  critical: 'Crítico',
  out: 'Sin stock'
};

const statusTones: Record<InventoryItem['status'], 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  low: 'warning',
  critical: 'warning',
  out: 'danger'
};

const movementKindLabels = {
  sale: 'Venta',
  purchase_received: 'Compra recibida',
  return: 'Devolución',
  adjustment: 'Ajuste',
  reservation: 'Reserva',
  reservation_release: 'Liberación de reserva'
} as const;

type DraftLine = { productId: string; quantity: number; unitCostPesos: number };

function PurchaseFormModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [supplier, setSupplier] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ productId: '', quantity: 1, unitCostPesos: 0 }]);
  const productsQuery = useBusinessQuery({ queryKey: queryKeys.products, queryFn: (api) => api.listAdminProducts() });
  const create = useMutation({
    mutationFn: async () => (await getBusinessApi()).createPurchase({
      supplierName: supplier.trim(),
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
  const valid = supplier.trim().length >= 2 && lines.length > 0 && lines.every((line) => line.productId && line.quantity > 0 && line.unitCostPesos >= 0);
  return (
    <Modal isOpen={true} onClose={onClose} ariaLabelledBy="purchase-title" maxWidth="2xl">
      <div className="flex items-start justify-between">
        <div>
          <h2 id="purchase-title" className="font-display text-3xl font-black text-ink-950">Nueva compra</h2>
          <p className="mt-1 text-[14.5px] font-medium text-ink-700">Registrá los productos pedidos a un proveedor.</p>
        </div>
        <button className="grid size-10 place-items-center rounded-full hover:bg-cream-100 text-ink-600 transition" onClick={onClose} aria-label="Cerrar modal">
          <X className="size-5" />
        </button>
      </div>
        <div className="mt-7 grid gap-5 sm:grid-cols-2">
          <Field label="Proveedor"><Input value={supplier} onChange={(event) => setSupplier(event.target.value)} placeholder="Nombre del proveedor" /></Field>
          <Field label="Llegada estimada" hint="Opcional"><Input type="date" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} /></Field>
        </div>
        <div className="mt-7">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-xl font-black text-ink-950">Productos</h3>
            <Button variant="ghost" size="sm" onClick={() => setLines((current) => [...current, { productId: '', quantity: 1, unitCostPesos: 0 }])}>
              <Plus className="size-4" /> Agregar línea
            </Button>
          </div>
          <div className="mt-3 space-y-3">
            {lines.map((line, index) => (
              <div key={index} className="grid gap-3 rounded-2xl bg-cream-50 p-4 border border-ink-950/6 sm:grid-cols-[1fr_6rem_9rem_auto] sm:items-end">
                <Field label="Producto">
                  <Select value={line.productId} onChange={(event) => setLines((current) => current.map((entry, position) => position === index ? { ...entry, productId: event.target.value, unitCostPesos: (productsQuery.data?.find((product) => product.id === event.target.value)?.currentCostCents ?? 0) / 100 } : entry))}>
                    <option value="">Elegir…</option>
                    {productsQuery.data?.filter((product) => product.active).map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                  </Select>
                </Field>
                <Field label="Cantidad"><Input type="number" min="1" value={line.quantity} onChange={(event) => setLines((current) => current.map((entry, position) => position === index ? { ...entry, quantity: Number(event.target.value) } : entry))} /></Field>
                <Field label="Costo c/u"><Input type="number" min="0" step="0.01" value={line.unitCostPesos} onChange={(event) => setLines((current) => current.map((entry, position) => position === index ? { ...entry, unitCostPesos: Number(event.target.value) } : entry))} /></Field>
                <button className="grid size-10 place-items-center rounded-full text-red-700 hover:bg-red-50" onClick={() => setLines((current) => current.filter((_, position) => position !== index))} aria-label="Quitar línea"><X className="size-4" /></button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-5"><Field label="Notas" hint="Opcional"><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></Field></div>
        {create.error ? <div className="mt-5"><ErrorState error={create.error} /></div> : null}
        <div className="mt-7 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button variant="dark" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>Registrar pedido al proveedor</Button>
        </div>
    </Modal>
  );
}

function StockDetailDrawer({
  item,
  onClose,
  onOpenAdjust,
  onNavigateToMovements
}: {
  item: InventoryItem;
  onClose: () => void;
  onOpenAdjust: (item: InventoryItem) => void;
  onNavigateToMovements: () => void;
}) {
  const queryClient = useQueryClient();
  const [reorderPoint, setReorderPoint] = useState(item.reorderPoint);
  const [safetyStock, setSafetyStock] = useState(item.safetyStock);
  const [leadTimeDays, setLeadTimeDays] = useState(item.leadTimeDays);
  const [showCalculation, setShowCalculation] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    setReorderPoint(item.reorderPoint);
    setSafetyStock(item.safetyStock);
    setLeadTimeDays(item.leadTimeDays);
    setSaveSuccess(false);
  }, [item.id, item.reorderPoint, item.safetyStock, item.leadTimeDays]);

  const movementsQuery = useBusinessQuery({
    queryKey: queryKeys.movements(1),
    queryFn: (api) => api.listMovements(1, 100)
  });

  const isDirty =
    reorderPoint !== item.reorderPoint ||
    safetyStock !== item.safetyStock ||
    leadTimeDays !== item.leadTimeDays;

  const updateThresholds = useMutation({
    mutationFn: async () => {
      await (await getBusinessApi()).updateStockThresholds({
        productId: item.id,
        reorderPoint: Number(reorderPoint),
        safetyStock: Number(safetyStock),
        leadTimeDays: Number(leadTimeDays)
      });
    },
    onSuccess: async () => {
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3500);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      ]);
    }
  });

  const previewStatus = inventoryStatus(item.available, reorderPoint, safetyStock);

  const recentMovements = (movementsQuery.data?.items ?? [])
    .filter(
      (m) =>
        m.productId === item.id ||
        m.productName.toLowerCase().includes(item.name.toLowerCase())
    )
    .slice(0, 3);

  return (
    <Drawer isOpen={true} onClose={onClose} ariaLabelledBy="drawer-title">
      <div className="flex items-start justify-between">
        <div>
          <h2 id="drawer-title" className="font-display text-2xl font-black text-ink-950">
            {item.name}
          </h2>
          <div className="mt-1.5 flex items-center gap-2.5">
            <p className="text-[14px] font-bold text-ink-700">{item.presentation}</p>
            <StatusChip label={statusLabels[item.status]} tone={statusTones[item.status]} />
          </div>
        </div>
        <button
          className="grid size-10 place-items-center rounded-full hover:bg-cream-100 text-ink-600 transition"
          onClick={onClose}
          aria-label="Cerrar panel"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="mt-6 space-y-5 flex-1">
        {/* Bloque 1 — Diagnóstico claro en lenguaje humano */}
        <div
          className={cn(
            'rounded-2xl p-4 text-[13.5px] border font-medium leading-relaxed shadow-sm',
            item.status === 'ok' && 'bg-emerald-50 text-emerald-950 border-emerald-200',
            item.status === 'low' && 'bg-amber-50 text-amber-950 border-amber-200',
            item.status === 'critical' && 'bg-rose-50 text-rose-950 border-rose-200',
            item.status === 'out' && 'bg-red-50 text-red-950 border-red-200'
          )}
        >
          {item.status === 'out' && (
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="size-5 shrink-0 text-red-700 mt-0.5" />
              <div>
                <p className="font-bold text-red-950">Sin stock disponible</p>
                <p className="text-[12.5px] text-red-800 mt-0.5">No quedan unidades físicas disponibles para la venta.</p>
              </div>
            </div>
          )}
          {item.status === 'critical' && (
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="size-5 shrink-0 text-rose-700 mt-0.5" />
              <div>
                <p className="font-bold text-rose-950">Stock crítico</p>
                <p className="text-[12.5px] text-rose-800 mt-0.5">
                  Quedan solo <strong>{item.available} u.</strong> disponibles (igual o por debajo del stock de seguridad de <strong>{item.safetyStock} u.</strong>).
                </p>
              </div>
            </div>
          )}
          {item.status === 'low' && (
            <div className="flex items-start gap-2.5">
              <Info className="size-5 shrink-0 text-amber-700 mt-0.5" />
              <div>
                <p className="font-bold text-amber-950">Alerta de stock bajo activada</p>
                <p className="text-[12.5px] text-amber-900 mt-0.5">
                  Hay <strong>{item.available} u.</strong> disponibles y el punto de pedido configurado es de <strong>≤ {item.reorderPoint} u.</strong>
                </p>
              </div>
            </div>
          )}
          {item.status === 'ok' && (
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="size-5 shrink-0 text-emerald-700 mt-0.5" />
              <div>
                <p className="font-bold text-emerald-950">Stock en orden</p>
                <p className="text-[12.5px] text-emerald-800 mt-0.5">
                  El stock disponible (<strong>{item.available} u.</strong>) supera el punto de pedido de reposición (<strong>&gt; {item.reorderPoint} u.</strong>).
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Bloque 2 — Existencias */}
        <div>
          <h4 className="text-[13px] font-black uppercase tracking-wider text-ink-700 mb-2">Existencias actuales</h4>
          <div className="grid grid-cols-3 gap-2.5 rounded-2xl bg-cream-50 p-4 border border-ink-950/6">
            <div>
              <span className="block text-[12px] font-black uppercase text-ink-600">Stock real</span>
              <span className="text-2xl font-black text-ink-950">{item.onHand}</span>
            </div>
            <div>
              <span className="block text-[12px] font-black uppercase text-ink-600">Reservado</span>
              <span className="text-2xl font-black text-ink-950">{item.reserved}</span>
            </div>
            <div>
              <span className="block text-[12px] font-black uppercase text-ink-600">Disponible</span>
              <span className={cn('text-2xl font-black', item.available <= 0 ? 'text-red-700' : 'text-emerald-700')}>
                {item.available}
              </span>
            </div>
          </div>
        </div>

        {/* Bloque 3 — Configuración editable de alertas y umbrales */}
        <div className="rounded-2xl border border-ink-950/10 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h4 className="text-[13px] font-black uppercase tracking-wider text-ink-900">
                Umbrales y alertas de reposición
              </h4>
              <p className="text-[12px] font-medium text-ink-600">
                Ajustá cuándo querés que el sistema catalogue el stock como bajo o crítico.
              </p>
            </div>
            <SlidersHorizontal className="size-4 text-ink-500" />
          </div>

          <div className="grid grid-cols-2 gap-3.5 pt-1">
            <div>
              <label className="block text-[12.5px] font-black text-ink-900 mb-1">
                Alerta de stock bajo
              </label>
              <div className="relative">
                <Input
                  type="number"
                  min="0"
                  value={reorderPoint}
                  onChange={(e) => setReorderPoint(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="pr-8 text-[15px] font-black"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-ink-500 pointer-events-none">
                  u.
                </span>
              </div>
              <p className="mt-1 text-[11px] font-medium text-ink-600 leading-tight">
                Avisa cuando el disponible sea ≤ este número
              </p>
            </div>

            <div>
              <label className="block text-[12.5px] font-black text-ink-900 mb-1">
                Stock de seguridad
              </label>
              <div className="relative">
                <Input
                  type="number"
                  min="0"
                  value={safetyStock}
                  onChange={(e) => setSafetyStock(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="pr-8 text-[15px] font-black"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-ink-500 pointer-events-none">
                  u.
                </span>
              </div>
              <p className="mt-1 text-[11px] font-medium text-ink-600 leading-tight">
                Avisa crítico si el disponible cae a ≤ este número
              </p>
            </div>
          </div>

          {/* Vista previa y botón de guardado si hay cambios */}
          {isDirty && (
            <div className="mt-4 rounded-xl bg-amber-50/70 p-3 border border-amber-200/80">
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-ink-800">Pasará a:</span>
                  <StatusChip
                    label={statusLabels[previewStatus]}
                    tone={statusTones[previewStatus]}
                  />
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReorderPoint(item.reorderPoint);
                      setSafetyStock(item.safetyStock);
                    }}
                  >
                    Descartar
                  </Button>
                  <Button
                    type="button"
                    variant="dark"
                    size="sm"
                    loading={updateThresholds.isPending}
                    onClick={() => updateThresholds.mutate()}
                  >
                    Guardar umbrales
                  </Button>
                </div>
              </div>
            </div>
          )}

          {saveSuccess && (
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-50 p-2.5 text-xs font-bold text-emerald-800 border border-emerald-200">
              <Check className="size-4 text-emerald-700" />
              <span>¡Umbrales actualizados con éxito!</span>
            </div>
          )}

          {updateThresholds.error && (
            <div className="mt-3">
              <ErrorState error={updateThresholds.error} />
            </div>
          )}
        </div>

        {/* Bloque 4 — Reposición */}
        <div>
          <h4 className="text-[13px] font-black uppercase tracking-wider text-ink-700 mb-2">Reposición y proyección</h4>
          <div className="grid grid-cols-2 gap-3 rounded-2xl bg-cream-50 p-4 border border-ink-950/6">
            <div>
              <span className="block text-[12px] font-black uppercase text-ink-600">En camino</span>
              <span className="text-2xl font-black text-ink-950">{item.incoming}</span>
            </div>
            <div>
              <span className="block text-[12px] font-black uppercase text-ink-600">Stock proyectado</span>
              <span className="text-2xl font-black text-brand-700">{item.projected}</span>
            </div>
          </div>
        </div>

        {/* Bloque 5 — Cálculo avanzado de reposición */}
        <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white p-4">
          <button
            type="button"
            onClick={() => setShowCalculation(!showCalculation)}
            className="flex w-full items-center justify-between text-[13px] font-black uppercase tracking-wider text-ink-800 hover:text-ink-950"
          >
            <span>{showCalculation ? 'Ocultar detalles de reposición ▴' : 'Ver cálculo avanzado de reposición ▾'}</span>
            <ChevronDown
              className={cn('size-4 text-ink-600 transition-transform', showCalculation && 'rotate-180')}
            />
          </button>

          {showCalculation ? (
            <div className="mt-4 space-y-3 border-t border-ink-950/6 pt-3">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="font-semibold text-ink-700">Venta promedio/día</dt>
                  <dd className="text-[15px] font-black text-ink-950">
                    {item.averageDailySales.toFixed(1)} u./día
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-700">Lead time</dt>
                  <dd className="text-[15px] font-black text-ink-950">{item.leadTimeDays} días</dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-700">Stock de seguridad</dt>
                  <dd className="text-[15px] font-black text-ink-950">{item.safetyStock} u.</dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-700">Punto de pedido</dt>
                  <dd className="text-[15px] font-black text-ink-950">{item.reorderPoint} u.</dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-700">Días de cobertura</dt>
                  <dd className="text-[15px] font-black text-ink-950">
                    {item.coverageDays ?? '—'} días
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-700">Compra sugerida</dt>
                  <dd className="text-[15px] font-black text-brand-700">
                    {item.suggestedPurchase} u.
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}
        </div>

        {/* Bloque 6 — Movimientos recientes */}
        <div className="rounded-2xl border border-ink-950/8 bg-white p-4">
          <div className="flex items-center justify-between mb-2.5">
            <h4 className="text-xs font-black uppercase tracking-wider text-ink-600">Movimientos recientes</h4>
            <button
              type="button"
              onClick={onNavigateToMovements}
              className="text-xs font-bold text-brand-600 hover:text-brand-700"
            >
              Ver historial completo →
            </button>
          </div>

          {recentMovements.length === 0 ? (
            <p className="text-xs text-ink-600 font-medium py-1">Sin movimientos recientes registrados.</p>
          ) : (
            <div className="space-y-2">
              {recentMovements.map((mov) => (
                <div key={mov.id} className="flex items-center justify-between rounded-xl bg-cream-50 p-2.5 text-xs">
                  <div>
                    <p className="font-bold text-ink-950">{movementKindLabels[mov.kind] ?? mov.kind}</p>
                    <p className="text-[11px] text-ink-600">
                      {new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' }).format(
                        new Date(mov.createdAt)
                      )}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'font-black',
                      mov.physicalDelta < 0 || mov.reservedDelta < 0 ? 'text-red-700' : 'text-emerald-700'
                    )}
                  >
                    {mov.physicalDelta !== 0
                      ? `${mov.physicalDelta > 0 ? '+' : ''}${mov.physicalDelta} fís.`
                      : `${mov.reservedDelta > 0 ? '+' : ''}${mov.reservedDelta} res.`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bloque 7 — Más acciones */}
        <div className="rounded-2xl border border-ink-950/8 bg-cream-50/50 p-4">
          <h4 className="text-xs font-black uppercase tracking-wider text-ink-600 mb-2">Más acciones</h4>
          <Button
            variant="secondary"
            size="sm"
            className="w-full justify-start text-xs font-bold"
            onClick={() => onOpenAdjust(item)}
          >
            <SlidersHorizontal className="size-4" /> Registrar ajuste manual
          </Button>
        </div>
      </div>

      <div className="mt-8 flex justify-end border-t border-ink-950/8 pt-4">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cerrar
        </Button>
      </div>
    </Drawer>
  );
}

export default function InventoryPage() {
  const searchParams = useSearch({ strict: false }) as { tab?: string };
  const initialTab = searchParams.tab === 'compras' ? 'compras' : searchParams.tab === 'movimientos' ? 'movimientos' : 'stock';
  const [activeTab, setActiveTab] = useState<'stock' | 'compras' | 'movimientos'>(initialTab);

  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Stock State
  const [stockFilter, setStockFilter] = useState<'all' | 'attention' | 'ok'>('all');
  const [stockSearch, setStockSearch] = useState('');
  const [detailItem, setDetailItem] = useState<InventoryItem | null>(null);
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);

  // Movements State
  const [movementPage, setMovementPage] = useState(1);

  // Purchases State
  const [purchasesPage, setPurchasesPage] = useState(1);
  const [expandedPurchases, setExpandedPurchases] = useState<Record<string, boolean>>({});

  // Movements Filter State
  const [movementFilter, setMovementFilter] = useState<'all' | 'sales' | 'purchases' | 'adjustments'>('all');
  const [movementSearch, setMovementSearch] = useState('');

  // Queries
  const inventoryQuery = useBusinessQuery({
    queryKey: queryKeys.inventory,
    queryFn: (api) => api.listInventory()
  });

  const movementsQuery = useBusinessQuery({
    queryKey: queryKeys.movements(movementPage),
    queryFn: (api) => api.listMovements(movementPage, 25)
  });

  const purchasesQuery = useBusinessQuery({
    queryKey: queryKeys.purchases(purchasesPage),
    queryFn: (api) => api.listPurchases(purchasesPage, 15)
  });

  // Stock Adjustment Mutation
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

  // Receive Purchase Mutation
  const receivePurchase = useMutation({
    mutationFn: async (purchaseId: string) => (await getBusinessApi()).receivePurchase(purchaseId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.purchasesRoot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: ['movements'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      ]);
    }
  });

  // Filtered Stock Items
  const filteredStock = useMemo(() => {
    const raw = inventoryQuery.data ?? [];
    return raw
      .filter((item) => {
        const matchesSearch =
          !stockSearch ||
          item.name.toLowerCase().includes(stockSearch.toLowerCase()) ||
          item.sku.toLowerCase().includes(stockSearch.toLowerCase());
        if (!matchesSearch) return false;
        if (stockFilter === 'attention') return item.status !== 'ok';
        if (stockFilter === 'ok') return item.status === 'ok';
        return true;
      })
      .sort((left, right) => {
        const priority = { out: 0, critical: 1, low: 2, ok: 3 };
        return priority[left.status] - priority[right.status] || left.name.localeCompare(right.name);
      });
  }, [inventoryQuery.data, stockSearch, stockFilter]);

  const [purchaseFilter, setPurchaseFilter] = useState<'pending' | 'received' | 'all'>('pending');

  const filteredPurchases = useMemo(() => {
    const raw = purchasesQuery.data?.items ?? [];
    return raw.filter((purchase) => {
      if (purchaseFilter === 'pending') return purchase.state === 'ordered';
      if (purchaseFilter === 'received') return purchase.state === 'received';
      return true;
    });
  }, [purchasesQuery.data?.items, purchaseFilter]);

  const attentionCount = useMemo(
    () => (inventoryQuery.data ?? []).filter((i) => i.status !== 'ok').length,
    [inventoryQuery.data]
  );

  const filteredMovements = useMemo(() => {
    const raw = movementsQuery.data?.items ?? [];
    return raw
      .filter((mov) => {
        if (movementSearch) {
          const term = movementSearch.toLowerCase();
          const matches =
            mov.productName.toLowerCase().includes(term) ||
            mov.reason.toLowerCase().includes(term) ||
            mov.createdByName.toLowerCase().includes(term);
          if (!matches) return false;
        }
        if (movementFilter === 'sales') {
          return (
            mov.kind === 'sale' || mov.kind === 'reservation' || mov.kind === 'reservation_release'
          );
        }
        if (movementFilter === 'purchases') {
          return mov.kind === 'purchase_received';
        }
        if (movementFilter === 'adjustments') {
          return mov.kind === 'adjustment' || mov.kind === 'return';
        }
        return true;
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [movementsQuery.data?.items, movementFilter, movementSearch]);

  return (
    <div className="page-enter">
      <PageHeader
        title="Inventario"
        description="Controlá el stock, las compras y los movimientos."
      />

      {/* Tabs Bar */}
      <nav className="mb-6 flex gap-2 border-b border-ink-950/8 pb-3" aria-label="Secciones de Inventario">
        <button
          type="button"
          onClick={() => setActiveTab('stock')}
          className={cn(
            'flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-black transition',
            activeTab === 'stock'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-ink-600 hover:bg-white hover:text-ink-950'
          )}
        >
          <Boxes className="size-4" />
          Stock
          {attentionCount > 0 ? (
            <span className={cn('ml-1 rounded-full px-2 py-0.5 text-xs font-black', activeTab === 'stock' ? 'bg-white/20 text-white' : 'bg-red-100 text-red-700')}>
              {attentionCount}
            </span>
          ) : null}
        </button>

        {can(user, 'manage_purchases') ? (
          <button
            type="button"
            onClick={() => setActiveTab('compras')}
            className={cn(
              'flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-black transition',
              activeTab === 'compras'
                ? 'bg-brand-600 text-white shadow-sm'
                : 'text-ink-600 hover:bg-white hover:text-ink-950'
            )}
          >
            <Store className="size-4" />
            Compras
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setActiveTab('movimientos')}
          className={cn(
            'flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-black transition',
            activeTab === 'movimientos'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-ink-600 hover:bg-white hover:text-ink-950'
          )}
        >
          <History className="size-4" />
          Movimientos
        </button>
      </nav>

      {/* TAB 1: STOCK */}
      {activeTab === 'stock' ? (
        <section aria-labelledby="stock-section-title">
          <h2 id="stock-section-title" className="sr-only">Stock disponible</h2>
          
          {/* Controls */}
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-ink-600" />
              <input
                type="search"
                placeholder="Buscar por producto o categoría…"
                value={stockSearch}
                onChange={(e) => setStockSearch(e.target.value)}
                className="h-11 w-full rounded-full border border-ink-950/15 bg-white pl-10 pr-4 text-[14.5px] font-semibold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setStockFilter('all')}
                className={cn('min-h-11 rounded-full px-4 text-[13.5px] font-bold transition select-none', stockFilter === 'all' ? 'bg-ink-950 text-white font-black' : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25')}
              >
                Todos ({inventoryQuery.data?.length ?? 0})
              </button>
              <button
                type="button"
                onClick={() => setStockFilter('attention')}
                className={cn('min-h-11 rounded-full px-4 text-[13.5px] font-bold transition select-none', stockFilter === 'attention' ? 'bg-red-600 text-white font-black' : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25')}
              >
                Requieren atención ({attentionCount})
              </button>
              <button
                type="button"
                onClick={() => setStockFilter('ok')}
                className={cn('min-h-11 rounded-full px-4 text-[13.5px] font-bold transition select-none', stockFilter === 'ok' ? 'bg-ink-950 text-white font-black' : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25')}
              >
                En orden
              </button>
            </div>
          </div>

          {inventoryQuery.isPending ? <LoadingState label="Consultando inventario…" /> : null}
          {inventoryQuery.isError ? <ErrorState error={inventoryQuery.error} onRetry={() => void inventoryQuery.refetch()} /> : null}

          {inventoryQuery.data ? (
            <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
              <div className="divide-y divide-ink-950/6">
                {filteredStock.map((item) => {
                  const isProblem = item.status !== 'ok';
                  const isCovered = item.available <= 0 && item.incoming > 0 && item.suggestedPurchase === 0;

                  return (
                    <article
                      key={item.id}
                      className={cn(
                        'grid min-h-[4.25rem] gap-4 p-4 transition sm:grid-cols-[1fr_8rem_9rem_auto] sm:items-center sm:px-6 sm:py-3.5',
                        isProblem ? 'bg-amber-50/40 hover:bg-amber-50/70' : 'hover:bg-cream-50'
                      )}
                    >
                      {/* Product identity */}
                      <div className="min-w-0">
                        <h3 className="truncate text-[16.5px] font-black text-ink-950">{item.name}</h3>
                        {isCovered ? (
                          <p className="mt-0.5 flex items-center gap-1 text-[14px] font-bold text-ink-800">
                            {item.incoming} unidades en camino · reposición cubierta
                          </p>
                        ) : item.suggestedPurchase > 0 ? (
                          <p className="mt-0.5 flex items-center gap-1 text-[14px] font-black text-amber-900">
                            <AlertTriangle className="size-4 text-amber-600" />
                            Comprar {item.suggestedPurchase} unidades
                          </p>
                        ) : null}
                      </div>

                      {/* Quantity available */}
                      <div>
                        <span className="block text-[13px] font-black uppercase tracking-wider text-ink-700">Disponible</span>
                        <span className={cn('text-[18px] font-black', item.available <= 0 ? 'text-red-700' : 'text-ink-950')}>{item.available} u.</span>
                      </div>

                      {/* Status Exception Chip */}
                      <div>
                        {item.status === 'critical' ? (
                          <StatusChip label="Crítico" tone="danger" />
                        ) : item.status === 'out' ? (
                          <StatusChip label="Sin stock" tone="danger" />
                        ) : item.status === 'low' ? (
                          <StatusChip label="Stock bajo" tone="warning" />
                        ) : (
                          <span className="text-[14px] font-bold text-ink-700">En orden</span>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDetailItem(item)}
                          className="text-ink-800 hover:text-ink-950 font-black text-[14.5px]"
                        >
                          Detalles <ChevronRight className="size-4" />
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* TAB 2: COMPRAS */}
      {activeTab === 'compras' && can(user, 'manage_purchases') ? (
        <section aria-labelledby="purchases-section-title">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 id="purchases-section-title" className="font-display text-xl font-black text-ink-950">Órdenes de compra</h2>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className={cn(
                    'min-h-8 rounded-full px-3 text-xs font-black transition',
                    purchaseFilter === 'pending'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                  onClick={() => setPurchaseFilter('pending')}
                >
                  Pendientes
                </button>
                <button
                  type="button"
                  className={cn(
                    'min-h-8 rounded-full px-3 text-xs font-black transition',
                    purchaseFilter === 'received'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                  onClick={() => setPurchaseFilter('received')}
                >
                  Recibidas
                </button>
                <button
                  type="button"
                  className={cn(
                    'min-h-8 rounded-full px-3 text-xs font-black transition',
                    purchaseFilter === 'all'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                  onClick={() => setPurchaseFilter('all')}
                >
                  Todas
                </button>
              </div>
            </div>

            <Button onClick={() => setShowPurchaseForm(true)} size="sm">
              <Plus className="size-4" /> Nueva compra
            </Button>
          </div>
          {purchasesQuery.isPending ? <LoadingState label="Cargando órdenes de compra…" /> : null}
          {purchasesQuery.isError ? <ErrorState error={purchasesQuery.error} onRetry={() => void purchasesQuery.refetch()} /> : null}

          {purchasesQuery.data ? (
            <>
              <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
                <div className="divide-y divide-ink-950/6">
                  {filteredPurchases.map((purchase) => {
                    const totalUnits = purchase.items.reduce((sum, line) => sum + line.quantity, 0);
                    const isOpen = expandedPurchases[purchase.id] ?? false;

                    return (
                      <article key={purchase.id} className="p-5 transition hover:bg-cream-50/50">
                        <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-center">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="font-black text-ink-950">{purchase.supplierName}</h3>
                              <span className="text-xs font-semibold text-ink-600">#{purchase.number}</span>
                            </div>
                            <p className="mt-1 text-xs text-ink-600">
                              {formatUnits(totalUnits)} · {formatProducts(purchase.items.length)}
                              {purchase.expectedAt ? ` · Llegada: ${new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(purchase.expectedAt))}` : ''}
                            </p>
                          </div>

                          <div>
                            {purchase.state === 'received' ? (
                              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
                                <Check className="size-3.5" /> Recibido
                              </span>
                            ) : (
                              <StatusChip label="En camino" tone="warning" />
                            )}
                          </div>

                          {can(user, 'view_financials') ? (
                            <div className="text-right">
                              <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-600">Total</span>
                              <span className="font-black text-ink-950">{formatMoney(purchase.totalCostCents)}</span>
                            </div>
                          ) : null}

                          <div className="flex items-center gap-2">
                            {purchase.state === 'ordered' ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                loading={receivePurchase.isPending}
                                onClick={() => receivePurchase.mutate(purchase.id)}
                              >
                                <CheckCircle2 className="size-4" /> Marcar recibida
                              </Button>
                            ) : null}
                          </div>
                        </div>

                        {/* Botón desplegable para ver productos */}
                        <div className="mt-3">
                          <button
                            type="button"
                            onClick={() => setExpandedPurchases((prev) => ({ ...prev, [purchase.id]: !isOpen }))}
                            className="inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:text-brand-700"
                          >
                            <span>{isOpen ? 'Ocultar productos ▴' : `Ver ${purchase.items.length} productos ▾`}</span>
                          </button>

                          {isOpen ? (
                            <div className="mt-2.5 rounded-xl bg-cream-50 p-3 space-y-1.5 border border-ink-950/6">
                              {purchase.items.map((item, idx) => (
                                <div key={idx} className="flex items-center justify-between text-xs font-bold text-ink-950">
                                  <span>{item.productName} ×{item.quantity}</span>
                                  {can(user, 'view_financials') ? (
                                    <span className="text-ink-600 font-semibold">{formatMoney(item.unitCostCents * item.quantity)}</span>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>

              {filteredPurchases.length === 0 ? (
                <div className="rounded-2xl border border-ink-950/8 bg-white p-8 text-center text-sm font-semibold text-ink-600">
                  No hay órdenes de compra para este filtro.
                </div>
              ) : null}

              {purchasesQuery.data.total > purchasesQuery.data.pageSize ? (
                <nav className="mt-4 flex items-center justify-between rounded-xl border border-ink-950/8 bg-white p-3">
                  <Button variant="ghost" size="sm" disabled={purchasesPage === 1} onClick={() => setPurchasesPage((p) => Math.max(1, p - 1))}>
                    <ChevronLeft className="size-4" /> Anterior
                  </Button>
                  <span className="text-xs font-bold text-ink-600">Página {purchasesPage} de {Math.ceil(purchasesQuery.data.total / purchasesQuery.data.pageSize)}</span>
                  <Button variant="ghost" size="sm" disabled={purchasesPage * purchasesQuery.data.pageSize >= purchasesQuery.data.total} onClick={() => setPurchasesPage((p) => p + 1)}>
                    Siguiente <ChevronRight className="size-4" />
                  </Button>
                </nav>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {/* TAB 3: MOVIMIENTOS */}
      {activeTab === 'movimientos' ? (
        <section aria-labelledby="movements-section-title">
          <h2 id="movements-section-title" className="sr-only">Historial de movimientos</h2>

          {/* Filtros de Movimientos */}
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={cn(
                  'min-h-8 rounded-full px-3.5 text-xs font-black transition',
                  movementFilter === 'all'
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                )}
                onClick={() => setMovementFilter('all')}
              >
                Todos
              </button>
              <button
                type="button"
                className={cn(
                  'min-h-8 rounded-full px-3.5 text-xs font-black transition',
                  movementFilter === 'sales'
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                )}
                onClick={() => setMovementFilter('sales')}
              >
                Ventas
              </button>
              <button
                type="button"
                className={cn(
                  'min-h-8 rounded-full px-3.5 text-xs font-black transition',
                  movementFilter === 'purchases'
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                )}
                onClick={() => setMovementFilter('purchases')}
              >
                Compras
              </button>
              <button
                type="button"
                className={cn(
                  'min-h-8 rounded-full px-3.5 text-xs font-black transition',
                  movementFilter === 'adjustments'
                    ? 'bg-brand-600 text-white shadow-sm'
                    : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                )}
                onClick={() => setMovementFilter('adjustments')}
              >
                Ajustes
              </button>
            </div>

            <div className="relative min-w-48 sm:w-64">
              <Search className="absolute left-3 top-2.5 size-4 text-ink-600" />
              <input
                type="search"
                placeholder="Buscar por producto, motivo…"
                value={movementSearch}
                onChange={(e) => setMovementSearch(e.target.value)}
                className="h-8 w-full rounded-full border border-ink-950/12 bg-white pl-9 pr-4 text-xs font-bold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
          </div>

          {movementsQuery.isPending ? <LoadingState label="Cargando trazabilidad…" /> : null}
          {movementsQuery.isError ? <ErrorState error={movementsQuery.error} onRetry={() => void movementsQuery.refetch()} /> : null}

          {movementsQuery.data ? (
            <>
              <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
                <div className="divide-y divide-ink-950/6">
                  {filteredMovements.map((movement) => {
                    const isNegative = movement.physicalDelta < 0 || movement.reservedDelta < 0;
                    const deltaParts = [];
                    if (movement.physicalDelta !== 0) {
                      deltaParts.push(`${movement.physicalDelta > 0 ? '+' : ''}${movement.physicalDelta} stock real`);
                    }
                    if (movement.reservedDelta !== 0) {
                      deltaParts.push(`${movement.reservedDelta > 0 ? '+' : ''}${movement.reservedDelta} reservado`);
                    }

                    return (
                      <article key={movement.id} className="grid min-h-[4rem] gap-3 p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:px-6 sm:py-3.5">
                        <span className={cn('grid size-10 place-items-center rounded-xl', isNegative ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700')}>
                          {isNegative ? <ArrowDown className="size-4" /> : <ArrowUp className="size-4" />}
                        </span>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-[16px] font-black text-ink-950">{movement.productName}</h3>
                            <span className="rounded-md bg-cream-100 px-2 py-0.5 text-[12px] font-bold uppercase text-ink-700">
                              {movementKindLabels[movement.kind]}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[14px] text-ink-700 font-medium">{movement.reason}</p>
                          <p className="mt-1 text-[13px] font-semibold text-ink-600">
                            {new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(movement.createdAt))} · {movement.createdByName}
                          </p>
                        </div>
                        <div className="text-right text-[14.5px] font-black text-ink-950">
                          {deltaParts.length > 0 ? (
                            <p className={isNegative ? 'text-red-700' : 'text-emerald-700'}>
                              {deltaParts.join(' · ')}
                            </p>
                          ) : (
                            <p className="text-ink-600">—</p>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>

              {filteredMovements.length === 0 ? (
                <div className="rounded-2xl border border-ink-950/8 bg-white p-8 text-center text-sm font-semibold text-ink-600">
                  Todavía no hay movimientos registrados para este filtro.
                </div>
              ) : null}

              {movementsQuery.data.total > movementsQuery.data.pageSize ? (
                <nav className="mt-4 flex items-center justify-between rounded-xl border border-ink-950/8 bg-white p-3.5">
                  <Button variant="ghost" size="sm" disabled={movementPage === 1} onClick={() => setMovementPage((p) => Math.max(1, p - 1))}>
                    <ChevronLeft className="size-4" /> Anterior
                  </Button>
                  <span className="text-sm font-bold text-ink-700">Página {movementPage} de {Math.ceil(movementsQuery.data.total / movementsQuery.data.pageSize)}</span>
                  <Button variant="ghost" size="sm" disabled={movementPage * movementsQuery.data.pageSize >= movementsQuery.data.total} onClick={() => setMovementPage((p) => p + 1)}>
                    Siguiente <ChevronRight className="size-4" />
                  </Button>
                </nav>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {/* DRAWER: Radiografía y Configuración de Stock */}
      {detailItem ? (
        <StockDetailDrawer
          item={(inventoryQuery.data ?? []).find((i) => i.id === detailItem.id) ?? detailItem}
          onClose={() => setDetailItem(null)}
          onOpenAdjust={(target) => {
            setDetailItem(null);
            setAdjustItem(target);
            setDelta('');
            setReason('');
          }}
          onNavigateToMovements={() => {
            setDetailItem(null);
            setActiveTab('movimientos');
          }}
        />
      ) : null}

      {/* MODAL: Ajuste Manual */}
      {adjustItem ? (
        <Modal isOpen={true} onClose={() => setAdjustItem(null)} ariaLabelledBy="adjust-title" maxWidth="lg">
          <div className="flex items-start justify-between">
            <div>
              <h3 id="adjust-title" className="font-display text-2xl font-black text-ink-950">Registrar ajuste · {adjustItem.name}</h3>
              <p className="mt-1 text-[14px] font-medium text-ink-700">Modificá el stock físico por rotura, vencimiento o auditoría.</p>
            </div>
            <button className="grid size-9 place-items-center rounded-full hover:bg-cream-100 text-ink-600 transition" onClick={() => setAdjustItem(null)} aria-label="Cerrar modal">
              <X className="size-5" />
            </button>
          </div>

          <div className="mt-5 space-y-4">
            <Field label="Variación de unidades" hint="Usa valores negativos (-) para mermas y positivos (+) para ingresos">
              <Input type="number" placeholder="Ej: -2 o 5" value={delta} onChange={(e) => setDelta(e.target.value)} />
            </Field>
            <Field label="Motivo del ajuste">
              <Input placeholder="Ej: Rotura en depósito, auditoría física…" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>

          {adjustment.error ? <div className="mt-4"><ErrorState error={adjustment.error} /></div> : null}

          <div className="mt-6 flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setAdjustItem(null)}>Cancelar</Button>
            <Button
              variant="dark"
              disabled={!delta || Number(delta) === 0 || !reason.trim()}
              loading={adjustment.isPending}
              onClick={() => adjustment.mutate()}
            >
              Guardar ajuste
            </Button>
          </div>
        </Modal>
      ) : null}

      {/* Modal: Nueva Compra */}
      {showPurchaseForm ? <PurchaseFormModal onClose={() => setShowPurchaseForm(false)} /> : null}
    </div>
  );
}
