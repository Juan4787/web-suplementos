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
  ChevronUp,
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
import { format, isBefore, isValid, parseISO, startOfDay } from 'date-fns';
import { es } from 'date-fns/locale';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { PageHeader } from '@/components/layout/AdminShell';
import { Button } from '@/components/ui/Button';
import { ErrorState, LoadingState } from '@/components/ui/DataState';
import { DatePicker, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Drawer, Modal } from '@/components/ui/Modal';
import { StatusChip } from '@/components/ui/StatusChip';
import { inventoryStatus, sanitizeDecimalInput, sanitizeIntegerInput } from '@/domain/inventory';
import { formatMoney, pesosToCents } from '@/domain/money';
import { can } from '@/domain/permissions';
import { formatProducts, formatUnits } from '@/domain/quantity';
import type { InventoryItem } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthProvider';
import { cn } from '@/lib/cn';
import { getBusinessApi } from '@/services/business-api';

const statusLabels = {
  ok: 'OK',
  low: 'COMPRAR',
  critical: 'URGENTE',
  out: 'SIN STOCK'
} as const;

const statusTones = {
  ok: 'success',
  low: 'warning',
  critical: 'danger',
  out: 'danger'
} as const;

const movementKindLabels = {
  sale: 'Venta',
  purchase_received: 'Compra recibida',
  return: 'Devolución',
  adjustment: 'Stock corregido',
  reservation: 'Reserva de venta',
  reservation_release: 'Reserva cancelada'
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
      supplierName: supplier.trim() || 'Sin proveedor',
      expectedAt: expectedAt ? new Date(`${expectedAt}T12:00:00-03:00`).toISOString() : null,
      notes: notes.trim() || null,
      items: lines.map((line) => ({ productId: line.productId, quantity: line.quantity, unitCostCents: pesosToCents(line.unitCostPesos) }))
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.purchases(1) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      ]);
      onClose();
    }
  });
  const valid = lines.length > 0 && lines.every((line) => line.productId && line.quantity > 0);
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

        {/* Notas */}
        <Field label="Notas · opcional">
          <Input
            placeholder="Ej. 50% pagado. Resto contra entrega."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </Field>

        {/* Sección de productos */}
        <div className="space-y-3 pt-2">
          <h3 className="text-[13px] font-black uppercase tracking-wider text-ink-700">
            PRODUCTOS ({lines.length})
          </h3>

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
                      onChange={(event) => {
                        const updated = [...lines];
                        const item = updated[index];
                        if (item) {
                          item.productId = event.target.value;
                          const prod = productsQuery.data?.find((p) => p.id === event.target.value);
                          if (prod) item.unitCostPesos = (prod.currentCostCents ?? 0) / 100;
                        }
                        setLines(updated);
                      }}
                    >
                      <option value="">Seleccionar producto…</option>
                      {productsQuery.data?.filter((p) => p.active !== false).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} {p.presentation ? `(${p.presentation})` : ''}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-400 hover:bg-red-50 hover:text-red-600 transition"
                      onClick={() => setLines(lines.filter((_, i) => i !== index))}
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
                        const updated = [...lines];
                        const item = updated[index];
                        if (item) {
                          const clean = sanitizeIntegerInput(event.target.value, String(item.quantity || ''));
                          item.quantity = clean === '' ? 0 : parseInt(clean, 10);
                        }
                        setLines(updated);
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
                        const updated = [...lines];
                        const item = updated[index];
                        if (item) {
                          const clean = sanitizeDecimalInput(event.target.value.replace(/\./g, ''), String(item.unitCostPesos || ''));
                          item.unitCostPesos = clean === '' ? 0 : parseFloat(clean) || 0;
                        }
                        setLines(updated);
                      }}
                      className="pl-8"
                    />
                  </div>
                </Field>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="secondary"
            className="w-full min-h-12 rounded-2xl text-[14.5px] font-bold"
            onClick={() => setLines([...lines, { productId: '', quantity: 1, unitCostPesos: 0 }])}
          >
            + Agregar producto
          </Button>
        </div>

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

function getExclusiveRanges(reorderPoint: number, safetyStock: number) {
  const okMin = Math.max(reorderPoint, safetyStock) + 1;
  const okText = `${okMin}+`;

  let buyText = '';
  if (reorderPoint > safetyStock) {
    const buyMin = safetyStock + 1;
    buyText = buyMin === reorderPoint ? `${reorderPoint}` : `${buyMin}–${reorderPoint}`;
  }

  let urgentText = '';
  if (safetyStock > 0) {
    urgentText = safetyStock === 1 ? '1' : `1–${safetyStock}`;
  }

  return {
    ok: okText,
    buy: buyText,
    urgent: urgentText,
    out: '0'
  };
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
  const [reorderPointStr, setReorderPointStr] = useState(
    item.reorderPoint > 0 ? String(item.reorderPoint) : ''
  );
  const [safetyStockStr, setSafetyStockStr] = useState(
    item.safetyStock > 0 ? String(item.safetyStock) : ''
  );
  const [leadTimeDaysStr, setLeadTimeDaysStr] = useState(String(item.leadTimeDays));
  const [showCalculation, setShowCalculation] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    setReorderPointStr(item.reorderPoint > 0 ? String(item.reorderPoint) : '');
    setSafetyStockStr(item.safetyStock > 0 ? String(item.safetyStock) : '');
    setLeadTimeDaysStr(String(item.leadTimeDays));
    setSaveSuccess(false);
  }, [item.id, item.reorderPoint, item.safetyStock, item.leadTimeDays]);

  const movementsQuery = useBusinessQuery({
    queryKey: queryKeys.movements(1),
    queryFn: (api) => api.listMovements(1, 100)
  });

  const reorderPoint = reorderPointStr === '' ? 0 : parseInt(reorderPointStr, 10);
  const safetyStock = safetyStockStr === '' ? 0 : parseInt(safetyStockStr, 10);
  const leadTimeDays = leadTimeDaysStr === '' ? item.leadTimeDays : parseInt(leadTimeDaysStr, 10);

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
  const ranges = getExclusiveRanges(reorderPoint, safetyStock);

  const scaleSegments: { label: string; tone: string }[] = [
    { label: `OK: ${ranges.ok}`, tone: 'text-emerald-700' }
  ];
  if (ranges.buy) {
    scaleSegments.push({ label: `Comprar: ${ranges.buy}`, tone: 'text-amber-700' });
  }
  if (ranges.urgent) {
    scaleSegments.push({ label: `Urgente: ${ranges.urgent}`, tone: 'text-rose-700' });
  }
  scaleSegments.push({ label: `Sin stock: ${ranges.out}`, tone: 'text-red-700' });

  const recentMovements = (movementsQuery.data?.items ?? [])
    .filter(
      (m) =>
        m.productId === item.id ||
        m.productName.toLowerCase().includes(item.name.toLowerCase())
    )
    .slice(0, 3);

  const formattedDailySales = Number.isInteger(item.averageDailySales)
    ? String(item.averageDailySales)
    : item.averageDailySales.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

  return (
    <Drawer isOpen={true} onClose={onClose} ariaLabelledBy="drawer-title">
      {/* 1. CABECERA DEL PRODUCTO (Con botón cerrar de 44x44px target) */}
      <div className="flex items-start justify-between">
        <div className="min-w-0 pr-2">
          <h2 id="drawer-title" className="font-display text-2xl font-black text-ink-950 truncate">
            {item.name}
          </h2>
          <div className="mt-1.5 flex items-center gap-2.5">
            <p className="text-[14px] font-bold text-ink-700">{item.presentation}</p>
            <StatusChip label={statusLabels[item.status]} tone={statusTones[item.status]} />
          </div>
        </div>
        <button
          className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-cream-100 text-ink-600 transition -mr-2"
          onClick={onClose}
          aria-label="Cerrar panel"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="mt-6 space-y-5 flex-1">
        {/* 2. ALERTA SUPERIOR (Solo para estados que requieren atención: out, critical, low) */}
        {item.status !== 'ok' && (
          <div
            className={cn(
              'rounded-2xl p-4 text-[13.5px] border font-medium leading-relaxed shadow-sm',
              item.status === 'low' && 'bg-amber-50 text-amber-950 border-amber-200',
              item.status === 'critical' && 'bg-rose-50 text-rose-950 border-rose-200',
              item.status === 'out' && 'bg-red-50 text-red-950 border-red-200'
            )}
          >
            {item.status === 'out' && (
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="size-5 shrink-0 text-red-700 mt-0.5" />
                <div>
                  <p className="font-bold text-red-950">Sin stock</p>
                  <p className="text-[12.5px] text-red-800 mt-0.5">No quedan unidades para vender.</p>
                </div>
              </div>
            )}
            {item.status === 'critical' && (
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="size-5 shrink-0 text-rose-700 mt-0.5" />
                <div>
                  <p className="font-bold text-rose-950">Queda muy poco stock</p>
                  <p className="text-[12.5px] text-rose-800 mt-0.5">
                    Quedan <strong>{item.available} {item.available === 1 ? 'unidad' : 'unidades'}</strong>. Tu aviso urgente está en <strong>{item.safetyStock}</strong>.
                  </p>
                </div>
              </div>
            )}
            {item.status === 'low' && (
              <div className="flex items-start gap-2.5">
                <Info className="size-5 shrink-0 text-amber-700 mt-0.5" />
                <div>
                  <p className="font-bold text-amber-950">Conviene comprar</p>
                  <p className="text-[12.5px] text-amber-900 mt-0.5">
                    Quedan <strong>{item.available} {item.available === 1 ? 'unidad' : 'unidades'}</strong>. Tu aviso está en <strong>{item.reorderPoint}</strong>.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 3. STOCK HOY (Tarjetas con alineación vertical geométrica perfecta de 3 filas) */}
        <div>
          <h4 className="text-[12px] font-black uppercase tracking-wider text-ink-600 mb-2">Stock hoy</h4>
          <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
            {/* DISPONIBLE */}
            <div className="rounded-2xl bg-cream-50 p-2.5 sm:p-3.5 border border-ink-950/6 flex flex-col justify-between items-center text-center">
              <div className="w-full flex flex-col items-center">
                <span className="block text-[11px] sm:text-[12px] font-black uppercase tracking-wider text-ink-700 text-center w-full">Disponible</span>
                <div className="my-1.5 flex items-baseline justify-center gap-1">
                  <span
                    className={cn(
                      'text-2xl sm:text-3xl font-black tracking-tight leading-none',
                      item.available <= 0
                        ? 'text-red-700'
                        : item.status === 'critical'
                          ? 'text-rose-700'
                          : item.status === 'low'
                            ? 'text-amber-800'
                            : 'text-ink-950'
                    )}
                  >
                    {item.available}
                  </span>
                  <span className="text-xs font-bold text-ink-500">u.</span>
                </div>
              </div>
              <span className="text-[11px] font-semibold text-ink-500 min-h-[2rem] leading-tight flex items-start justify-center text-center">Para vender</span>
            </div>

            {/* RESERVADO */}
            <div className="rounded-2xl bg-cream-50 p-2.5 sm:p-3.5 border border-ink-950/6 flex flex-col justify-between items-center text-center">
              <div className="w-full flex flex-col items-center">
                <span className="block text-[11px] sm:text-[12px] font-black uppercase tracking-wider text-ink-700 text-center w-full">Reservado</span>
                <div className="my-1.5 flex items-baseline justify-center gap-1">
                  <span className="text-2xl sm:text-3xl font-black text-ink-950 tracking-tight leading-none">{item.reserved}</span>
                  <span className="text-xs font-bold text-ink-500">u.</span>
                </div>
              </div>
              <span className="text-[11px] font-semibold text-ink-500 min-h-[2rem] leading-tight flex items-start justify-center text-center">Reservado por clientes</span>
            </div>

            {/* TOTAL */}
            <div className="rounded-2xl bg-cream-50 p-2.5 sm:p-3.5 border border-ink-950/6 flex flex-col justify-between items-center text-center">
              <div className="w-full flex flex-col items-center">
                <span className="block text-[11px] sm:text-[12px] font-black uppercase tracking-wider text-ink-700 text-center w-full">Total</span>
                <div className="my-1.5 flex items-baseline justify-center gap-1">
                  <span className="text-2xl sm:text-3xl font-black text-ink-950 tracking-tight leading-none">{item.onHand}</span>
                  <span className="text-xs font-bold text-ink-500">u.</span>
                </div>
              </div>
              <span className="text-[11px] font-semibold text-ink-500 min-h-[2rem] leading-tight flex items-start justify-center text-center">En depósito</span>
            </div>
          </div>
        </div>

        {/* 4. CUÁNDO AVISARME (Filas verticales con inputs limpios y placeholder 0) */}
        <div className="rounded-2xl border border-ink-950/10 bg-white p-4 shadow-sm">
          <h4 className="text-[13px] font-black uppercase tracking-wider text-ink-900 mb-3">
            Cuándo avisarme
          </h4>

          <div className="divide-y divide-ink-950/6">
            {/* Fila 1: Comprar */}
            <div className="flex min-h-[64px] items-center justify-between py-2">
              <div className="flex items-center gap-2.5">
                <span className="size-2.5 rounded-full bg-amber-500 shrink-0" />
                <span className="text-[15px] font-black text-ink-950">Comprar</span>
              </div>

              <div className="relative flex items-center">
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={reorderPointStr}
                  placeholder="0"
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    const clean = sanitizeIntegerInput(e.target.value, reorderPointStr);
                    setReorderPointStr(clean);
                  }}
                  className="h-12 w-28 pr-7 text-right text-[16px] font-black bg-cream-50 border-ink-950/12 focus:bg-white focus:ring-1 focus:ring-amber-500/50"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-ink-500 pointer-events-none">
                  u.
                </span>
              </div>
            </div>

            {/* Fila 2: Urgente */}
            <div className="flex min-h-[64px] items-center justify-between py-2">
              <div className="flex items-center gap-2.5">
                <span className="size-2.5 rounded-full bg-rose-500 shrink-0" />
                <span className="text-[15px] font-black text-ink-950">Urgente</span>
              </div>

              <div className="relative flex items-center">
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={safetyStockStr}
                  placeholder="0"
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    const clean = sanitizeIntegerInput(e.target.value, safetyStockStr);
                    setSafetyStockStr(clean);
                  }}
                  className="h-12 w-28 pr-7 text-right text-[16px] font-black bg-cream-50 border-ink-950/12 focus:bg-white focus:ring-1 focus:ring-rose-500/50"
                />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-bold text-ink-500 pointer-events-none">
                  u.
                </span>
              </div>
            </div>
          </div>

          {/* Escala limpia segmentada con puntos separadores garantizados */}
          <div className="mt-3 rounded-xl bg-cream-50/80 p-2.5 border border-ink-950/6">
            <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] font-extrabold text-ink-700">
              {scaleSegments.map((seg, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  {idx > 0 && <span className="text-ink-400">·</span>}
                  <span className={seg.tone}>{seg.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Vista previa y botón de guardado */}
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
                    className="min-h-10 px-3"
                    onClick={() => {
                      setReorderPointStr(item.reorderPoint > 0 ? String(item.reorderPoint) : '');
                      setSafetyStockStr(item.safetyStock > 0 ? String(item.safetyStock) : '');
                      setLeadTimeDaysStr(String(item.leadTimeDays));
                    }}
                  >
                    Descartar
                  </Button>
                  <Button
                    type="button"
                    variant="dark"
                    size="sm"
                    className="min-h-10 px-4"
                    loading={updateThresholds.isPending}
                    onClick={() => updateThresholds.mutate()}
                  >
                    Guardar
                  </Button>
                </div>
              </div>
            </div>
          )}

          {saveSuccess && (
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-50 p-2.5 text-xs font-bold text-emerald-800 border border-emerald-200">
              <Check className="size-4 text-emerald-700" />
              <span>¡Avisos actualizados con éxito!</span>
            </div>
          )}

          {updateThresholds.error && (
            <div className="mt-3">
              <ErrorState error={updateThresholds.error} />
            </div>
          )}
        </div>

        {/* 5. LO QUE VIENE (Solo si hay compras en camino) */}
        {item.incoming > 0 ? (
          <div>
            <h4 className="text-[12px] font-black uppercase tracking-wider text-ink-600 mb-2">Lo que viene</h4>
            <div className="rounded-2xl bg-brand-50/70 p-4 border border-brand-200/70 space-y-1">
              <p className="text-[15px] font-black text-brand-950">
                {item.incoming} {item.incoming === 1 ? 'unidad en camino' : 'unidades en camino'}
              </p>
              <p className="text-xs font-medium text-brand-800">
                Cuando lleguen vas a tener <strong className="font-black text-brand-950">{item.projected} {item.projected === 1 ? 'unidad' : 'unidades'}</strong>.
              </p>
            </div>
          </div>
        ) : null}

        {/* 6. CÓMO SE CALCULA (Fila completa con área táctil cómoda de 48px) */}
        <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white">
          <button
            type="button"
            onClick={() => setShowCalculation(!showCalculation)}
            className="flex min-h-12 w-full items-center justify-between px-4 py-3 text-[13px] font-black uppercase tracking-wider text-ink-800 hover:text-ink-950 active:bg-cream-100 transition"
          >
            <span>{showCalculation ? 'Ocultar cálculo ▴' : 'Ver cómo se calcula ▾'}</span>
            <ChevronDown
              className={cn('size-4 text-ink-600 transition-transform', showCalculation && 'rotate-180')}
            />
          </button>

          {showCalculation ? (
            <div className="space-y-3 border-t border-ink-950/6 p-4 pt-3">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="font-semibold text-ink-700">Venta promedio</dt>
                  <dd className="text-[15px] font-black text-ink-950">
                    {formattedDailySales} por día
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-700">El proveedor tarda</dt>
                  <dd className="text-[15px] font-black text-ink-950">
                    {item.leadTimeDays} {item.leadTimeDays === 1 ? 'día' : 'días'}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-700">Aviso de compra</dt>
                  <dd className="text-[15px] font-black text-ink-950">
                    {item.reorderPoint} {item.reorderPoint === 1 ? 'unidad' : 'unidades'}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-700">Aviso urgente</dt>
                  <dd className="text-[15px] font-black text-ink-950">
                    {item.safetyStock} {item.safetyStock === 1 ? 'unidad' : 'unidades'}
                  </dd>
                </div>

                {item.averageDailySales === 0 || item.coverageDays === null ? (
                  <div className="col-span-2 rounded-xl bg-cream-50 p-3 text-xs font-semibold text-ink-600 border border-ink-950/6">
                    Todavía no hay ventas suficientes para calcular cuánto dura el stock y cuánto conviene comprar.
                  </div>
                ) : (
                  <>
                    <div>
                      <dt className="font-semibold text-ink-700">El stock alcanza para</dt>
                      <dd className="text-[15px] font-black text-ink-950">
                        {item.coverageDays} {item.coverageDays === 1 ? 'día' : 'días'}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-ink-700">Cuánto comprar</dt>
                      <dd className="text-[15px] font-black text-brand-700">
                        {item.suggestedPurchase > 0
                          ? `${item.suggestedPurchase} ${item.suggestedPurchase === 1 ? 'unidad' : 'unidades'}`
                          : '0 unidades (cubierto)'}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </div>
          ) : null}
        </div>

        {/* 7. ÚLTIMOS MOVIMIENTOS (Con header tappable de 44px) */}
        <div className="rounded-2xl border border-ink-950/8 bg-white p-4">
          <div className="flex items-center justify-between mb-2.5">
            <h4 className="text-xs font-black uppercase tracking-wider text-ink-600">Últimos movimientos</h4>
            {recentMovements.length > 0 ? (
              <button
                type="button"
                onClick={onNavigateToMovements}
                className="flex items-center min-h-11 px-2 -mr-2 text-xs font-bold text-brand-600 hover:text-brand-700 active:opacity-75 transition"
              >
                Ver todos →
              </button>
            ) : null}
          </div>

          {recentMovements.length === 0 ? (
            <p className="text-xs text-ink-600 font-medium py-1">Todavía no hay movimientos.</p>
          ) : (
            <div className="space-y-2">
              {recentMovements.map((mov) => {
                const totalUnits = mov.physicalDelta !== 0 ? mov.physicalDelta : mov.reservedDelta;
                const sign = totalUnits > 0 ? '+' : '';
                return (
                  <div key={mov.id} className="flex items-center justify-between rounded-xl bg-cream-50 p-2.5 text-xs">
                    <div>
                      <p className="font-bold text-ink-950">{movementKindLabels[mov.kind] ?? mov.kind}</p>
                      <p className="text-[11px] text-ink-600">
                        {new Intl.DateTimeFormat('es-AR', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit'
                        }).format(new Date(mov.createdAt))}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'font-black',
                        totalUnits < 0 ? 'text-red-700' : 'text-emerald-700'
                      )}
                    >
                      {`${sign}${totalUnits} ${Math.abs(totalUnits) === 1 ? 'unidad' : 'unidades'}`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 8. ACCIÓN DIRECTA (Botón con área táctil cómoda de 44px de alto) */}
        <Button
          variant="secondary"
          size="sm"
          className="w-full justify-center text-xs font-bold min-h-11"
          onClick={() => onOpenAdjust(item)}
        >
          <SlidersHorizontal className="size-4" /> Corregir stock
        </Button>
      </div>

      <div className="mt-8 flex justify-end border-t border-ink-950/8 pt-4">
        <Button variant="ghost" size="sm" className="min-h-10 px-4" onClick={onClose}>
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
  const [targetStock, setTargetStock] = useState('');
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
      const targetNum = parseInt(targetStock, 10);
      const calculatedDelta = targetNum - adjustItem.onHand;
      await (await getBusinessApi()).adjustStock(
        adjustItem.id,
        calculatedDelta,
        reason.trim() || 'Corrección manual de stock'
      );
    },
    onSuccess: async () => {
      setAdjustItem(null);
      setTargetStock('');
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

  const allPurchases = useMemo(() => purchasesQuery.data?.items ?? [], [purchasesQuery.data?.items]);

  const pendingPurchasesCount = useMemo(
    () => allPurchases.filter((purchase) => purchase.state === 'ordered').length,
    [allPurchases]
  );

  const receivedPurchasesCount = useMemo(
    () => allPurchases.filter((purchase) => purchase.state === 'received').length,
    [allPurchases]
  );

  const totalPurchasesCount = allPurchases.length;

  const filteredPurchases = useMemo(() => {
    return allPurchases.filter((purchase) => {
      if (purchaseFilter === 'pending') return purchase.state === 'ordered';
      if (purchaseFilter === 'received') return purchase.state === 'received';
      return true;
    });
  }, [allPurchases, purchaseFilter]);

  const attentionCount = useMemo(
    () => (inventoryQuery.data ?? []).filter((i) => i.status !== 'ok').length,
    [inventoryQuery.data]
  );

  const okCount = useMemo(
    () => (inventoryQuery.data ?? []).filter((i) => i.status === 'ok').length,
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
                Necesitan atención ({attentionCount})
              </button>
              <button
                type="button"
                onClick={() => setStockFilter('ok')}
                className={cn('min-h-11 rounded-full px-4 text-[13.5px] font-bold transition select-none', stockFilter === 'ok' ? 'bg-ink-950 text-white font-black' : 'border border-ink-950/15 bg-white text-ink-800 hover:border-ink-950/25')}
              >
                OK ({okCount})
              </button>
            </div>
          </div>

          {inventoryQuery.isPending ? <LoadingState label="Consultando inventario…" /> : null}
          {inventoryQuery.isError ? <ErrorState error={inventoryQuery.error} onRetry={() => void inventoryQuery.refetch()} /> : null}

          {inventoryQuery.data ? (
            <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
              {/* Discrete Table Header */}
              <div className="hidden sm:grid sm:grid-cols-[1fr_7.5rem_8rem_2.5rem] items-center px-6 py-2.5 bg-cream-100/70 border-b border-ink-950/6 text-[11px] font-black uppercase tracking-wider text-ink-600">
                <span>Producto</span>
                <span>Disponible</span>
                <span>Estado</span>
                <span className="sr-only">Ver</span>
              </div>

              <div className="divide-y divide-ink-950/6">
                {filteredStock.map((item) => {
                  const isProblem = item.status !== 'ok';

                  return (
                    <article
                      key={item.id}
                      onClick={() => setDetailItem(item)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setDetailItem(item);
                        }
                      }}
                      className={cn(
                        'group grid min-h-[3.75rem] gap-2 p-3.5 sm:p-4 transition cursor-pointer sm:grid-cols-[1fr_7.5rem_8rem_2.5rem] sm:items-center sm:px-6 select-none focus:outline-none focus:bg-cream-100/80',
                        isProblem ? 'bg-amber-50/40 hover:bg-amber-50/70' : 'hover:bg-cream-50'
                      )}
                    >
                      {/* Product identity */}
                      <div className="min-w-0 pr-2">
                        <h3 className="truncate text-[15.5px] font-black text-ink-950">{item.name}</h3>
                        <p className="text-[12.5px] font-medium text-ink-600 truncate">{item.presentation}</p>
                      </div>

                      {/* Quantity available */}
                      <div>
                        <span className={cn('text-[16px] font-black', item.available <= 0 ? 'text-red-700' : 'text-ink-950')}>
                          {item.available} u.
                        </span>
                      </div>

                      {/* Status Chip */}
                      <div>
                        <StatusChip label={statusLabels[item.status]} tone={statusTones[item.status]} />
                      </div>

                      {/* Chevron affordance */}
                      <div className="flex items-center justify-end text-ink-400 group-hover:text-ink-700 transition">
                        <ChevronRight className="size-5 transition-transform group-hover:translate-x-0.5" />
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
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="purchases-section-title" className="font-display text-xl font-black text-ink-950">
                Pedidos al proveedor
              </h2>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={cn(
                    'min-h-9 rounded-full px-3.5 text-xs font-black transition select-none',
                    purchaseFilter === 'pending'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                  onClick={() => setPurchaseFilter('pending')}
                >
                  Pendientes ({pendingPurchasesCount})
                </button>
                <button
                  type="button"
                  className={cn(
                    'min-h-9 rounded-full px-3.5 text-xs font-black transition select-none',
                    purchaseFilter === 'received'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                  onClick={() => setPurchaseFilter('received')}
                >
                  Recibidos ({receivedPurchasesCount})
                </button>
                <button
                  type="button"
                  className={cn(
                    'min-h-9 rounded-full px-3.5 text-xs font-black transition select-none',
                    purchaseFilter === 'all'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'border border-ink-950/12 bg-white text-ink-700 hover:border-ink-950/25'
                  )}
                  onClick={() => setPurchaseFilter('all')}
                >
                  Todos ({totalPurchasesCount})
                </button>
              </div>
            </div>

            <Button onClick={() => setShowPurchaseForm(true)} size="sm">
              <Plus className="size-4" /> Nuevo pedido
            </Button>
          </div>
          {purchasesQuery.isPending ? <LoadingState label="Cargando pedidos al proveedor…" /> : null}
          {purchasesQuery.isError ? <ErrorState error={purchasesQuery.error} onRetry={() => void purchasesQuery.refetch()} /> : null}

          {purchasesQuery.data ? (
            <>
              <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
                <div className="divide-y divide-ink-950/6">
                  {filteredPurchases.map((purchase) => {
                    const totalUnits = purchase.items.reduce((sum, line) => sum + line.quantity, 0);
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
                        // fallback to default
                      }
                    }

                    return (
                      <article key={purchase.id} className="p-5 sm:p-6 transition hover:bg-cream-50/40">
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

                        {/* Fila 3: 15 unidades · $1.125.000 · Llega 8 sep | Marcar como recibido */}
                        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-ink-950/6 pb-4">
                          <div className="flex flex-wrap items-center gap-2 text-[14px]">
                            <span className="font-bold text-ink-950">
                              {totalUnits} {totalUnits === 1 ? 'unidad' : 'unidades'}
                            </span>
                            {can(user, 'view_financials') && (
                              <>
                                <span className="text-ink-400">·</span>
                                <span className="font-black text-ink-950">
                                  {formatMoney(purchase.totalCostCents)}
                                </span>
                              </>
                            )}
                            <span className="text-ink-400">·</span>
                            {deliveryLabel}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            {purchase.state === 'ordered' ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                loading={receivePurchase.isPending && receivePurchase.variables === purchase.id}
                                onClick={() => receivePurchase.mutate(purchase.id)}
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
                                  {can(user, 'view_financials') && (
                                    <span className="text-sm font-semibold text-ink-700 shrink-0">
                                      {formatMoney(item.unitCostCents * item.quantity)}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>

              {filteredPurchases.length === 0 ? (
                <div className="rounded-2xl border border-ink-950/8 bg-white p-8 text-center text-sm font-semibold text-ink-600">
                  No hay pedidos al proveedor para este filtro.
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
                placeholder="Buscar movimientos…"
                value={movementSearch}
                onChange={(e) => setMovementSearch(e.target.value)}
                className="h-8 w-full rounded-full border border-ink-950/12 bg-white pl-9 pr-4 text-xs font-bold text-ink-950 placeholder:text-ink-600/70 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
          </div>

          {movementsQuery.isPending ? <LoadingState label="Cargando historial de movimientos…" /> : null}
          {movementsQuery.isError ? <ErrorState error={movementsQuery.error} onRetry={() => void movementsQuery.refetch()} /> : null}

          {movementsQuery.data ? (
            <>
              <div className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm">
                <div className="divide-y divide-ink-950/6">
                  {filteredMovements.map((movement) => {
                    const isNegative = movement.physicalDelta < 0 || (movement.physicalDelta === 0 && movement.reservedDelta < 0);
                    const deltaCount = movement.physicalDelta !== 0 ? movement.physicalDelta : movement.reservedDelta;
                    const absCount = Math.abs(deltaCount);
                    const sign = deltaCount > 0 ? '+' : deltaCount < 0 ? '-' : '';
                    const unitText = absCount === 1 ? 'unidad' : 'unidades';
                    const formattedDelta = deltaCount !== 0 ? `${sign}${absCount} ${unitText}` : '0 unidades';

                    let formattedDate = '';
                    try {
                      formattedDate = format(new Date(movement.createdAt), 'd MMM, HH:mm', { locale: es });
                    } catch {
                      formattedDate = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(movement.createdAt));
                    }

                    const kindLabel = movementKindLabels[movement.kind] ?? 'Movimiento de stock';
                    const isGenericReason =
                      !movement.reason ||
                      movement.reason.toLowerCase() === movement.kind.toLowerCase() ||
                      movement.reason.toLowerCase().includes('recepción de compra') ||
                      movement.reason.toLowerCase().includes('compra recibida') ||
                      movement.reason.toLowerCase().includes('venta entregada');

                    const subtitle = isGenericReason ? kindLabel : movement.reason;

                    return (
                      <article
                        key={movement.id}
                        className="grid min-h-[4.25rem] gap-3 p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:px-6 sm:py-3.5 transition hover:bg-cream-50/40"
                      >
                        <span
                          className={cn(
                            'grid size-10 place-items-center rounded-2xl shrink-0',
                            isNegative ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
                          )}
                        >
                          {isNegative ? <ArrowDown className="size-4.5" /> : <ArrowUp className="size-4.5" />}
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-[15.5px] font-black text-ink-950 truncate">
                            {movement.productName}
                          </h3>
                          <p className="mt-0.5 text-[13.5px] font-bold text-ink-700">
                            {subtitle}
                          </p>
                          <p className="mt-0.5 text-[12.5px] font-semibold text-ink-500">
                            {formattedDate} · {movement.createdByName || 'Sistema'}
                          </p>
                        </div>
                        <div className="text-right text-[15px] font-black shrink-0">
                          <p className={isNegative ? 'text-red-700' : 'text-emerald-700'}>
                            {formattedDelta}
                          </p>
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

      {/* DRAWER: Detalle y Configuración de Stock */}
      {detailItem ? (
        <StockDetailDrawer
          item={(inventoryQuery.data ?? []).find((i) => i.id === detailItem.id) ?? detailItem}
          onClose={() => setDetailItem(null)}
          onOpenAdjust={(target) => {
            setDetailItem(null);
            setAdjustItem(target);
            setTargetStock(String(target.onHand));
            setReason('');
          }}
          onNavigateToMovements={() => {
            setDetailItem(null);
            setActiveTab('movimientos');
          }}
        />
      ) : null}

      {/* MODAL: Corregir Stock */}
      {adjustItem ? (
        <Modal isOpen={true} onClose={() => setAdjustItem(null)} ariaLabelledBy="adjust-title" maxWidth="lg">
          <div className="flex items-start justify-between">
            <div>
              <h3 id="adjust-title" className="font-display text-2xl font-black text-ink-950">Corregir stock · {adjustItem.name}</h3>
              <p className="mt-1 text-[14px] font-medium text-ink-700">Ajustá la cantidad de unidades que hay realmente en la tienda.</p>
            </div>
            <button className="grid size-9 place-items-center rounded-full hover:bg-cream-100 text-ink-600 transition" onClick={() => setAdjustItem(null)} aria-label="Cerrar modal">
              <X className="size-5" />
            </button>
          </div>

          <div className="mt-5 space-y-4">
            <Field label="¿Cuántas unidades hay realmente?" hint={`Actualmente figuran ${adjustItem.onHand} unidades en stock.`}>
              <div className="relative">
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder={`Ej. ${adjustItem.onHand}`}
                  value={targetStock}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setTargetStock(sanitizeIntegerInput(e.target.value, targetStock))}
                  className="text-lg font-black pr-10"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-ink-500 pointer-events-none">
                  u.
                </span>
              </div>
            </Field>

            {targetStock !== '' && !isNaN(Number(targetStock)) && Number(targetStock) !== adjustItem.onHand && (
              <div className="rounded-xl bg-cream-100 p-3 text-xs font-bold text-ink-800 flex items-center justify-between">
                <span>Variación a registrar:</span>
                <span className={cn('font-black text-sm', Number(targetStock) - adjustItem.onHand > 0 ? 'text-emerald-700' : 'text-red-700')}>
                  {Number(targetStock) - adjustItem.onHand > 0 ? `+${Number(targetStock) - adjustItem.onHand}` : `${Number(targetStock) - adjustItem.onHand}`} unidades
                </span>
              </div>
            )}

            <Field label="Motivo (opcional)" hint="Ej: Conteo físico, mercadería dañada, vencimiento…">
              <Input
                placeholder="Ej. Conteo físico en local"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>

          {adjustment.error ? <div className="mt-4"><ErrorState error={adjustment.error} /></div> : null}

          <div className="mt-6 flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setAdjustItem(null)}>Cancelar</Button>
            <Button
              variant="dark"
              disabled={targetStock === '' || isNaN(Number(targetStock)) || Number(targetStock) === adjustItem.onHand || Number(targetStock) < 0}
              loading={adjustment.isPending}
              onClick={() => adjustment.mutate()}
            >
              Guardar corrección
            </Button>
          </div>
        </Modal>
      ) : null}

      {/* Modal: Nueva Compra */}
      {showPurchaseForm ? <PurchaseFormModal onClose={() => setShowPurchaseForm(false)} /> : null}
    </div>
  );
}
