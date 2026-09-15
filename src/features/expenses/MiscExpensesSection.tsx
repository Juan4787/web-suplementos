import {
  AlertTriangle,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Plus,
  ReceiptText,
  Repeat2,
  Trash2,
  X
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { addMonths, endOfMonth, format, parseISO, subMonths } from 'date-fns';
import { es } from 'date-fns/locale';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { sanitizeDecimalInput } from '@/domain/inventory';
import {
  MAX_MISC_EXPENSE_CENTS,
  isSupportedMiscExpenseDate,
  validateMiscExpense
} from '@/domain/misc-expenses';
import { formatMoney } from '@/domain/money';
import type { MiscExpense, MiscExpenseFrequency, MiscExpensePeriodItem } from '@/domain/types';
import { cn } from '@/lib/cn';
import { getBusinessApi, type SaveMiscExpenseInput } from '@/services/business-api';

type Notify = (
  title: string,
  description?: string,
  variant?: 'success' | 'error' | 'info'
) => void;

type ExpenseDraft = {
  source: MiscExpense | null;
  operationId: string;
  title: string;
  amountPesos: string;
  frequency: MiscExpenseFrequency;
  startsOn: string;
  hasEnd: boolean;
  endsOn: string;
};

const frequencyOptions: Array<{
  value: MiscExpenseFrequency;
  label: string;
  icon: typeof CalendarDays;
}> = [
  { value: 'once', label: 'Una vez', icon: CalendarDays },
  { value: 'weekly', label: 'Semanal', icon: Repeat2 },
  { value: 'monthly', label: 'Mensual', icon: CalendarRange }
];

const amountForInput = (amountCents: number): string => {
  const pesos = amountCents / 100;
  return Number.isInteger(pesos) ? String(pesos) : pesos.toFixed(2);
};

const amountToCents = (value: string): number | null => {
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_MISC_EXPENSE_CENTS
    ? cents
    : null;
};

const sanitizeAmount = (value: string, previous: string): string => {
  const sanitized = sanitizeDecimalInput(value, previous);
  const [whole = '', decimals] = sanitized.split('.');
  if (decimals === undefined) return whole.slice(0, 9);
  return `${whole.slice(0, 9)}.${decimals.slice(0, 2)}`;
};

const newDraft = (today: string): ExpenseDraft => ({
  source: null,
  operationId: crypto.randomUUID(),
  title: '',
  amountPesos: '',
  frequency: 'once',
  startsOn: today,
  hasEnd: false,
  endsOn: ''
});

const editDraft = (expense: MiscExpense): ExpenseDraft => ({
  source: expense,
  operationId: expense.operationId,
  title: expense.title,
  amountPesos: amountForInput(expense.amountCents),
  frequency: expense.frequency,
  startsOn: expense.startsOn,
  hasEnd: expense.endsOn !== null,
  endsOn: expense.endsOn ?? ''
});

const longDate = (value: string): string =>
  format(parseISO(value), "d 'de' MMMM 'de' yyyy", { locale: es });

const todayInBusinessTimezone = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

const recurrenceDescription = (expense: Pick<MiscExpense, 'frequency' | 'startsOn' | 'endsOn'>): string => {
  if (expense.frequency === 'once') return `Una vez · ${longDate(expense.startsOn)}`;
  const end = expense.endsOn ? ` · hasta ${longDate(expense.endsOn)}` : ' · sin fecha de finalización';
  if (expense.frequency === 'weekly') {
    const weekday = format(parseISO(expense.startsOn), 'EEEE', { locale: es });
    return `Semanal · cada ${weekday} desde ${longDate(expense.startsOn)}${end}`;
  }
  const day = Number(expense.startsOn.slice(8, 10));
  const shortMonth = day >= 29 ? ' (o último día del mes)' : '';
  return `Mensual · el día ${day}${shortMonth} desde ${longDate(expense.startsOn)}${end}`;
};

function ExpenseFormModal({
  initial,
  today,
  onClose,
  onSaved,
  onNotify
}: {
  initial: ExpenseDraft;
  today: string;
  onClose: () => void;
  onSaved: (expense: MiscExpense) => void;
  onNotify: Notify;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const amountCents = amountToCents(draft.amountPesos);
  const normalizedEndsOn = draft.frequency !== 'once' && draft.hasEnd ? draft.endsOn : null;
  const titleError = draft.title.trim().length < 2
    ? 'Escribí un título de al menos 2 caracteres.'
    : draft.title.trim().length > 100
      ? 'Acortá el título a 100 caracteres.'
      : undefined;
  const amountError = amountCents === null
    ? Number(draft.amountPesos) * 100 > MAX_MISC_EXPENSE_CENTS
      ? `El monto máximo por vez es ${formatMoney(MAX_MISC_EXPENSE_CENTS)}.`
      : 'Ingresá un monto mayor a cero.'
    : undefined;
  const startsOnError = !isSupportedMiscExpenseDate(draft.startsOn) ? 'Elegí una fecha válida.' : undefined;
  const endsOnError = normalizedEndsOn !== null && (
    !isSupportedMiscExpenseDate(normalizedEndsOn) || normalizedEndsOn < draft.startsOn
  )
    ? 'La finalización debe ser igual o posterior al inicio.'
    : undefined;
  const valid = !titleError && !amountError && !startsOnError && !endsOnError;

  const save = useMutation({
    mutationFn: async () => {
      if (!valid || amountCents === null) throw new Error('INVALID_MISC_EXPENSE_FORM');
      const values = {
        title: draft.title.trim(),
        amountCents,
        frequency: draft.frequency,
        startsOn: draft.startsOn,
        endsOn: normalizedEndsOn
      };
      validateMiscExpense(values);
      const input: SaveMiscExpenseInput = draft.source
        ? {
            ...values,
            id: draft.source.id,
            expectedUpdatedAt: draft.source.updatedAt
          }
        : { ...values, operationId: draft.operationId };
      return (await getBusinessApi()).saveMiscExpense(input);
    },
    onSuccess: async (expense) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.miscExpensesRoot }),
        queryClient.invalidateQueries({ queryKey: ['analytics'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      ]);
      onSaved(expense);
      onNotify(
        draft.source ? 'Gasto actualizado' : 'Gasto agregado',
        draft.frequency === 'once'
          ? 'El monto ya se incluye en la ganancia neta de la fecha elegida.'
          : 'La recurrencia ya se incluye en la ganancia neta de cada período correspondiente.'
      );
    }
  });

  const summary = useMemo(() => {
    if (!valid || amountCents === null) return null;
    const amount = formatMoney(amountCents);
    if (draft.frequency === 'once') return `${amount} se descontará el ${longDate(draft.startsOn)}.`;
    if (draft.frequency === 'weekly') {
      const weekday = format(parseISO(draft.startsOn), 'EEEE', { locale: es });
      return `${amount} se descontará cada ${weekday}, desde el ${longDate(draft.startsOn)}${normalizedEndsOn ? ` hasta el ${longDate(normalizedEndsOn)}` : ''}.`;
    }
    const day = Number(draft.startsOn.slice(8, 10));
    return `${amount} se descontará cada mes el día ${day}${day >= 29 ? ' (o el último día disponible)' : ''}, desde el ${longDate(draft.startsOn)}${normalizedEndsOn ? ` hasta el ${longDate(normalizedEndsOn)}` : ''}.`;
  }, [amountCents, draft.frequency, draft.startsOn, normalizedEndsOn, valid]);

  return (
    <Modal
      isOpen
      onClose={() => { if (!save.isPending) onClose(); }}
      maxWidth="lg"
      ariaLabelledBy="misc-expense-form-title"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700">
            <ReceiptText className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h3 id="misc-expense-form-title" className="font-display text-2xl font-black text-ink-950">
              {draft.source ? 'Editar gasto' : 'Agregar gasto'}
            </h3>
            <p className="mt-1 text-sm font-medium text-ink-600">
              Completá lo esencial; las fechas se adaptan a la frecuencia.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={save.isPending}
          className="grid size-11 shrink-0 place-items-center rounded-full text-ink-600 transition hover:bg-cream-100 hover:text-ink-950 disabled:opacity-50"
          aria-label="Cerrar formulario de gasto"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="mt-6 space-y-5">
        <Field label="Título del gasto" error={attempted ? titleError : undefined}>
          <Input
            autoFocus
            maxLength={100}
            placeholder="Ej. Etiquetas, envíos, sueldos o impuestos"
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          />
        </Field>

        <Field
          label="Monto (ARS)"
          error={attempted ? amountError : undefined}
          hint="Podés usar coma para centavos. Ejemplo: 25000,50."
        >
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center font-black text-ink-500">$</span>
            <Input
              className="pl-9 tabular-nums"
              inputMode="decimal"
              placeholder="0"
              value={draft.amountPesos}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  amountPesos: sanitizeAmount(event.target.value, current.amountPesos)
                }))
              }
            />
          </div>
        </Field>

        <fieldset>
          <legend className="mb-2 block text-[15px] font-extrabold text-ink-950">¿Cada cuánto se repite?</legend>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Frecuencia del gasto">
            {frequencyOptions.map((option) => {
              const Icon = option.icon;
              const selected = draft.frequency === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      frequency: option.value,
                      hasEnd: option.value === 'once' ? false : current.hasEnd,
                      endsOn: option.value === 'once' ? '' : current.endsOn
                    }))
                  }
                  className={cn(
                    'flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 py-3 text-sm font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30',
                    selected
                      ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                      : 'border-ink-950/12 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50/50'
                  )}
                >
                  <Icon className="size-5" aria-hidden="true" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <Field
          label={draft.frequency === 'once' ? 'Fecha del gasto' : 'Primera fecha'}
          error={attempted ? startsOnError : undefined}
          hint={
            draft.frequency === 'weekly'
              ? 'Ese día de la semana será el que se repita.'
              : draft.frequency === 'monthly'
                ? 'Ese número de día será el que se repita cada mes.'
                : 'El gasto se descontará únicamente en esta fecha.'
          }
        >
          <Input
            type="date"
            min="2000-01-01"
            max="2100-12-31"
            value={draft.startsOn}
            onChange={(event) => setDraft((current) => ({ ...current, startsOn: event.target.value }))}
          />
        </Field>

        {draft.frequency !== 'once' ? (
          draft.hasEnd ? (
            <div className="rounded-2xl border border-ink-950/10 bg-cream-50/60 p-4">
              <Field
                label="Repetir hasta"
                error={attempted ? endsOnError : undefined}
                hint="La fecha elegida también se incluye si coincide con una ocurrencia."
              >
                <Input
                  type="date"
                  min={draft.startsOn || today}
                  max="2100-12-31"
                  value={draft.endsOn}
                  onChange={(event) => setDraft((current) => ({ ...current, endsOn: event.target.value }))}
                />
              </Field>
              <button
                type="button"
                className="mt-3 text-sm font-black text-brand-700 hover:text-brand-900"
                onClick={() => setDraft((current) => ({ ...current, hasEnd: false, endsOn: '' }))}
              >
                Dejar sin fecha de finalización
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl border border-dashed border-ink-950/20 bg-cream-50/40 px-4 py-3 text-left text-sm font-bold text-ink-700 transition hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-800"
              onClick={() => setDraft((current) => ({ ...current, hasEnd: true, endsOn: current.startsOn }))}
            >
              <span>¿Este gasto termina en una fecha?</span>
              <span className="text-xs font-black text-brand-700">Definir fecha</span>
            </button>
          )
        ) : null}

        {draft.source && (draft.source.frequency !== 'once' || draft.frequency !== 'once') ? (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden="true" />
            <p className="leading-6">
              <strong className="font-black">Cuidá el historial:</strong> corregir el monto o la frecuencia recalcula los períodos anteriores. Si el valor cambia desde ahora, finalizá esta regla y creá otra con el monto nuevo.
            </p>
          </div>
        ) : null}

        {summary ? (
          <div className="flex items-start gap-3 rounded-2xl bg-brand-50 p-4 text-sm text-brand-950" aria-live="polite">
            <Check className="mt-0.5 size-5 shrink-0 text-brand-700" aria-hidden="true" />
            <p className="font-semibold leading-6">{summary}</p>
          </div>
        ) : null}

        {save.error && !(save.error instanceof Error && save.error.message === 'INVALID_MISC_EXPENSE_FORM') ? (
          <ErrorState error={save.error} />
        ) : null}
      </div>

      <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancelar</Button>
        <Button
          loading={save.isPending}
          onClick={() => {
            setAttempted(true);
            if (valid) save.mutate();
          }}
        >
          <Check className="size-4" aria-hidden="true" />
          {draft.source ? 'Guardar corrección' : 'Agregar gasto'}
        </Button>
      </div>
    </Modal>
  );
}

function ExpenseRow({
  expense,
  onEdit,
  onDelete
}: {
  expense: MiscExpensePeriodItem;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:p-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="break-words text-base font-black text-ink-950">{expense.title}</h4>
          <span className="rounded-full bg-cream-100 px-2.5 py-1 text-[11px] font-black uppercase tracking-wide text-ink-700">
            {expense.frequency === 'once' ? 'Puntual' : expense.frequency === 'weekly' ? 'Semanal' : 'Mensual'}
          </span>
        </div>
        <p className="mt-1 text-sm font-medium leading-5 text-ink-600">{recurrenceDescription(expense)}</p>
      </div>

      <div className="sm:min-w-44 sm:text-right">
        <p className="font-display text-xl font-black tabular-nums text-ink-950">
          {formatMoney(expense.periodAmountCents)}
        </p>
        <p className="mt-0.5 text-xs font-semibold text-ink-600">
          {expense.occurrenceCount === 1
            ? '1 vez en el período'
            : `${formatMoney(expense.amountCents)} × ${expense.occurrenceCount} veces`}
        </p>
      </div>

      <div className="flex items-center justify-end gap-1 border-t border-ink-950/6 pt-3 sm:border-0 sm:pt-0">
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Editar ${expense.title}`}>
          <Edit3 className="size-4" aria-hidden="true" /> Editar
        </Button>
        <button
          type="button"
          onClick={onDelete}
          className="grid size-11 place-items-center rounded-full text-ink-500 transition hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30"
          aria-label={`Anular ${expense.title}`}
          title="Anular gasto"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

export function MiscExpensesSection({ onNotify }: { onNotify: Notify }) {
  const queryClient = useQueryClient();
  const today = useMemo(todayInBusinessTimezone, []);
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  const [formDraft, setFormDraft] = useState<ExpenseDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MiscExpensePeriodItem | null>(null);
  const monthDate = parseISO(`${selectedMonth}-01`);
  const from = `${selectedMonth}-01`;
  const to = format(endOfMonth(monthDate), 'yyyy-MM-dd');
  const monthName = format(monthDate, 'MMMM yyyy', { locale: es });

  const expenses = useBusinessQuery({
    queryKey: queryKeys.miscExpenses(from, to),
    queryFn: (api) => api.listMiscExpenses(from, to)
  });

  const remove = useMutation({
    mutationFn: async (expense: MiscExpensePeriodItem) =>
      (await getBusinessApi()).deleteMiscExpense(expense.id, expense.updatedAt),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.miscExpensesRoot }),
        queryClient.invalidateQueries({ queryKey: ['analytics'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard })
      ]);
      setDeleteTarget(null);
      onNotify('Gasto anulado', 'Dejó de incluirse en la ganancia neta. La trazabilidad se conserva en el respaldo.');
    }
  });

  const moveMonth = (direction: -1 | 1) => {
    const next = direction === -1 ? subMonths(monthDate, 1) : addMonths(monthDate, 1);
    setSelectedMonth(format(next, 'yyyy-MM'));
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-ink-950/8 bg-white shadow-sm" aria-labelledby="misc-expenses-title">
      <div className="border-b border-ink-950/8 p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
              <ReceiptText className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h3 id="misc-expenses-title" className="font-display text-xl font-black text-ink-950">Gastos varios</h3>
              <p className="mt-1 max-w-2xl text-sm font-medium leading-6 text-ink-600">
                Registrá etiquetas, envíos, personal, impuestos u otros costos. Cada fecha incluida se descuenta de la ganancia neta.
              </p>
            </div>
          </div>
          <Button size="sm" className="w-full sm:w-auto" onClick={() => setFormDraft(newDraft(today))}>
            <Plus className="size-4" aria-hidden="true" /> Agregar gasto
          </Button>
        </div>

        <div className="mt-5 grid gap-3 rounded-2xl bg-cream-50 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:p-4">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => moveMonth(-1)}
              disabled={selectedMonth === '2000-01'}
              className="grid size-11 place-items-center rounded-full text-ink-700 transition hover:bg-white hover:text-brand-700 disabled:pointer-events-none disabled:opacity-35"
              aria-label="Ver mes anterior"
            >
              <ChevronLeft className="size-5" />
            </button>
            <label className="sr-only" htmlFor="misc-expenses-month">Mes a revisar</label>
            <input
              id="misc-expenses-month"
              type="month"
              min="2000-01"
              max="2100-12"
              value={selectedMonth}
              onChange={(event) => { if (event.target.value) setSelectedMonth(event.target.value); }}
              className="min-h-11 min-w-0 rounded-xl border border-ink-950/12 bg-white px-3 text-sm font-black text-ink-950 shadow-xs focus:border-brand-600 focus:ring-2 focus:ring-brand-500/20"
            />
            <button
              type="button"
              onClick={() => moveMonth(1)}
              disabled={selectedMonth === '2100-12'}
              className="grid size-11 place-items-center rounded-full text-ink-700 transition hover:bg-white hover:text-brand-700 disabled:pointer-events-none disabled:opacity-35"
              aria-label="Ver mes siguiente"
            >
              <ChevronRight className="size-5" />
            </button>
          </div>

          <p className="text-center text-sm font-semibold capitalize text-ink-700 sm:text-left">
            Impacto programado para {monthName}
          </p>

          <div className="rounded-xl bg-ink-950 px-4 py-3 text-white sm:min-w-48 sm:text-right">
            <p className="text-[10px] font-black uppercase tracking-wider text-white/60">Total del mes</p>
            <p className="mt-0.5 font-display text-2xl font-black tabular-nums text-brand-300">
              {formatMoney(expenses.data?.totalCents ?? 0)}
            </p>
          </div>
        </div>
        <p className="mt-2 text-xs font-medium text-ink-600">
          En Ventas se descuentan únicamente las fechas incluidas en el período que estés consultando.
          La tasa porcentual configurada arriba ya se descuenta por venta: no vuelvas a cargar aquí ese mismo impuesto.
        </p>
      </div>

      {expenses.isPending ? <LoadingState label="Calculando gastos del período…" /> : null}
      {expenses.isError ? (
        <div className="p-5 sm:p-6"><ErrorState error={expenses.error} onRetry={() => void expenses.refetch()} /></div>
      ) : null}
      {expenses.data && expenses.data.items.length === 0 ? (
        <div className="p-5 sm:p-6">
          <EmptyState
            title={`No hay gastos para ${monthName}`}
            description="Podés agregar uno puntual o programar una recurrencia semanal o mensual. Las opciones de fecha aparecen a medida que las necesitás."
            action={
              <Button variant="secondary" size="sm" onClick={() => setFormDraft(newDraft(today))}>
                <Plus className="size-4" /> Agregar el primero
              </Button>
            }
          />
        </div>
      ) : null}
      {expenses.data && expenses.data.items.length > 0 ? (
        <div className="divide-y divide-ink-950/8">
          {expenses.data.items.map((expense) => (
            <ExpenseRow
              key={expense.id}
              expense={expense}
              onEdit={() => setFormDraft(editDraft(expense))}
              onDelete={() => { remove.reset(); setDeleteTarget(expense); }}
            />
          ))}
        </div>
      ) : null}

      {formDraft ? (
        <ExpenseFormModal
          key={`${formDraft.source?.id ?? 'new'}:${formDraft.operationId}`}
          initial={formDraft}
          today={today}
          onClose={() => setFormDraft(null)}
          onSaved={(expense) => {
            setFormDraft(null);
            setSelectedMonth(expense.startsOn.slice(0, 7));
          }}
          onNotify={onNotify}
        />
      ) : null}

      {deleteTarget ? (
        <Modal
          isOpen
          onClose={() => { if (!remove.isPending) setDeleteTarget(null); }}
          maxWidth="md"
          ariaLabelledBy="delete-misc-expense-title"
        >
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-red-100 text-red-700">
              <Trash2 className="size-5" aria-hidden="true" />
            </span>
            <div>
              <h3 id="delete-misc-expense-title" className="font-display text-xl font-black text-ink-950">
                ¿Anular “{deleteTarget.title}”?
              </h3>
              <p className="mt-1 text-sm font-semibold text-ink-700">{formatMoney(deleteTarget.amountCents)} por vez</p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-950">
            {deleteTarget.frequency === 'once' ? (
              <p>Dejará de descontarse en la ganancia neta de su fecha. El registro de la anulación se conservará en el respaldo.</p>
            ) : (
              <p>
                Se quitará <strong>toda la recurrencia, también de períodos anteriores</strong>. Si el gasto simplemente terminó, cancelá y editá la regla para agregar una fecha de finalización.
              </p>
            )}
          </div>

          {remove.error ? <div className="mt-4"><ErrorState error={remove.error} /></div> : null}

          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="ghost" disabled={remove.isPending} onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(deleteTarget)}>
              Anular gasto
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
