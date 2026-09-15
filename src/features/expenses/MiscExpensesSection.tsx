import {
  AlertTriangle,
  CalendarDays,
  CalendarRange,
  Check,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Info,
  Plus,
  ReceiptText,
  Repeat2,
  Trash2,
  X
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { addMonths, endOfMonth, format, parseISO, subMonths } from 'date-fns';
import { es } from 'date-fns/locale';
import { keepPreviousData, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/app/query-keys';
import { useBusinessQuery } from '@/app/use-business-query';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/DataState';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
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

const formatAmountForInput = (amountCents: number): string => {
  const pesos = amountCents / 100;
  const isInteger = Number.isInteger(pesos);
  const cleanWhole = Math.floor(pesos);
  const formattedWhole = new Intl.NumberFormat('es-AR').format(cleanWhole);
  if (isInteger) return formattedWhole;
  const decimals = String(Math.round((pesos - cleanWhole) * 100)).padStart(2, '0');
  return `${formattedWhole},${decimals}`;
};

const formatPesosInput = (rawValue: string): string => {
  if (!rawValue) return '';

  let wholeDigits = '';
  let decimalDigits = '';
  let hasDecimal = false;

  if (rawValue.includes(',')) {
    const commaIndex = rawValue.indexOf(',');
    wholeDigits = rawValue.slice(0, commaIndex).replace(/\D/g, '').slice(0, 9);
    decimalDigits = rawValue.slice(commaIndex + 1).replace(/\D/g, '').slice(0, 2);
    hasDecimal = true;
  } else if (rawValue.endsWith('.')) {
    wholeDigits = rawValue.replace(/\D/g, '').slice(0, 9);
    hasDecimal = true;
  } else {
    wholeDigits = rawValue.replace(/\D/g, '').slice(0, 9);
  }

  if (!wholeDigits && !decimalDigits && !hasDecimal) return '';

  const cleanNum = wholeDigits ? parseInt(wholeDigits, 10) : 0;
  let formattedWhole = wholeDigits ? new Intl.NumberFormat('es-AR').format(cleanNum) : '';
  if (!formattedWhole && hasDecimal) formattedWhole = '0';

  let display = formattedWhole;
  if (hasDecimal) {
    display += `,${decimalDigits}`;
  }
  return display;
};

const getAmountCursorPosition = (rawInput: string, rawCursor: number, newDisplay: string): number => {
  let digitsBefore = 0;
  let hasCommaBefore = false;
  let decimalsBefore = 0;

  const rawBefore = rawInput.slice(0, rawCursor);
  const commaIdx = rawBefore.indexOf(',');

  if (commaIdx !== -1) {
    hasCommaBefore = true;
    digitsBefore = rawBefore.slice(0, commaIdx).replace(/\D/g, '').length;
    decimalsBefore = rawBefore.slice(commaIdx + 1).replace(/\D/g, '').length;
  } else {
    digitsBefore = rawBefore.replace(/\D/g, '').length;
  }

  if (!hasCommaBefore) {
    if (digitsBefore === 0) return 0;
    let count = 0;
    for (let i = 0; i < newDisplay.length; i++) {
      const char = newDisplay[i];
      if (char === ',') return i;
      if (char && /\d/.test(char)) count++;
      if (count === digitsBefore) return i + 1;
    }
    return newDisplay.length;
  }

  const displayCommaIdx = newDisplay.indexOf(',');
  if (displayCommaIdx === -1) return newDisplay.length;
  if (decimalsBefore === 0) return displayCommaIdx + 1;

  let count = 0;
  for (let i = displayCommaIdx + 1; i < newDisplay.length; i++) {
    const char = newDisplay[i];
    if (char && /\d/.test(char)) count++;
    if (count === decimalsBefore) return i + 1;
  }
  return newDisplay.length;
};

const amountToCents = (value: string): number | null => {
  if (!value || !value.trim()) return null;
  const clean = value.replace(/\./g, '').replace(',', '.').trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(clean)) return null;
  const cents = Math.round(Number(clean) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_MISC_EXPENSE_CENTS
    ? cents
    : null;
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
  amountPesos: formatAmountForInput(expense.amountCents),
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
  if (expense.frequency === 'once') return longDate(expense.startsOn);
  const end = expense.endsOn ? ` · hasta ${longDate(expense.endsOn)}` : '';
  if (expense.frequency === 'weekly') {
    const weekday = format(parseISO(expense.startsOn), 'EEEE', { locale: es });
    return `Cada ${weekday} desde ${longDate(expense.startsOn)}${end}`;
  }
  const day = Number(expense.startsOn.slice(8, 10));
  const shortMonth = day >= 29 ? ' (o último día del mes)' : '';
  return `El día ${day}${shortMonth} de cada mes desde ${longDate(expense.startsOn)}${end}`;
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
    ? draft.amountPesos && Number(draft.amountPesos.replace(/\./g, '').replace(',', '.')) * 100 > MAX_MISC_EXPENSE_CENTS
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

  const handleAmountKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const { selectionStart, selectionEnd, value: currentVal } = input;
    const isCollapsed = selectionStart !== null && selectionStart === selectionEnd;

    if (e.key === 'Backspace' && isCollapsed && selectionStart > 0) {
      if (currentVal[selectionStart - 1] === '.') {
        e.preventDefault();
        const before = currentVal.slice(0, selectionStart - 2);
        const after = currentVal.slice(selectionStart);
        const formatted = formatPesosInput(before + after);
        setDraft((current) => ({ ...current, amountPesos: formatted }));
        const newPos = Math.max(0, selectionStart - 2);
        requestAnimationFrame(() => {
          input.setSelectionRange(newPos, newPos);
        });
        return;
      }
    }

    if (e.key === 'Delete' && isCollapsed && selectionStart < currentVal.length) {
      if (currentVal[selectionStart] === '.') {
        e.preventDefault();
        const before = currentVal.slice(0, selectionStart);
        const after = currentVal.slice(selectionStart + 2);
        const formatted = formatPesosInput(before + after);
        setDraft((current) => ({ ...current, amountPesos: formatted }));
        const newPos = selectionStart;
        requestAnimationFrame(() => {
          input.setSelectionRange(newPos, newPos);
        });
        return;
      }
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const rawValue = input.value;
    const rawCursor = input.selectionStart ?? rawValue.length;
    const formatted = formatPesosInput(rawValue);
    const newCursor = getAmountCursorPosition(rawValue, rawCursor, formatted);

    setDraft((current) => ({ ...current, amountPesos: formatted }));
    requestAnimationFrame(() => {
      input.setSelectionRange(newCursor, newCursor);
    });
  };

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
          hint="Podés usar coma para centavos. Ejemplo: 25.000 o 25.000,50."
        >
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center font-black text-ink-500">$</span>
            <Input
              className="pl-9 tabular-nums"
              inputMode="decimal"
              placeholder="0"
              value={draft.amountPesos}
              onKeyDown={handleAmountKeyDown}
              onChange={handleAmountChange}
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
          <div className="space-y-3">
            <fieldset>
              <legend className="mb-2 block text-[15px] font-extrabold text-ink-950">
                ¿Este gasto termina en una fecha?
              </legend>
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="¿Este gasto termina en una fecha?">
                <button
                  type="button"
                  aria-pressed={!draft.hasEnd}
                  onClick={() => setDraft((current) => ({ ...current, hasEnd: false, endsOn: '' }))}
                  className={cn(
                    'flex min-h-12 items-center justify-center rounded-2xl border px-3 py-2 text-sm font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30',
                    !draft.hasEnd
                      ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                      : 'border-ink-950/12 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50/50'
                  )}
                >
                  No
                </button>
                <button
                  type="button"
                  aria-pressed={draft.hasEnd}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      hasEnd: true,
                      endsOn: current.endsOn || current.startsOn || today
                    }))
                  }
                  className={cn(
                    'flex min-h-12 items-center justify-center rounded-2xl border px-3 py-2 text-sm font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30',
                    draft.hasEnd
                      ? 'border-brand-600 bg-brand-600 text-white shadow-sm'
                      : 'border-ink-950/12 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50/50'
                  )}
                >
                  Sí
                </button>
              </div>
            </fieldset>

            {draft.hasEnd ? (
              <div className="rounded-2xl border border-ink-950/10 bg-cream-50/60 p-4 transition">
                <Field
                  label="Fecha de finalización"
                  error={attempted ? endsOnError : undefined}
                  hint="La fecha elegida también se incluye si coincide con una ocurrencia."
                >
                  <Input
                    type="date"
                    min={draft.startsOn || today}
                    max="2100-12-31"
                    value={draft.endsOn}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, endsOn: event.target.value }))
                    }
                  />
                </Field>
              </div>
            ) : null}
          </div>
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
  const isPuntual = expense.frequency === 'once';

  return (
    <article className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:p-5 transition hover:bg-cream-50/40">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="break-words text-base font-black text-ink-950">{expense.title}</h4>
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wide',
              isPuntual
                ? 'bg-cream-100 text-ink-700'
                : expense.frequency === 'weekly'
                  ? 'bg-blue-50 text-blue-700'
                  : 'bg-purple-50 text-purple-700'
            )}
          >
            {isPuntual ? 'Puntual' : expense.frequency === 'weekly' ? 'Semanal' : 'Mensual'}
          </span>
        </div>
        <p className="mt-1 text-sm font-medium leading-5 text-ink-600">{recurrenceDescription(expense)}</p>
      </div>

      <div className="sm:min-w-44 sm:text-right">
        <p className="font-display text-xl font-black tabular-nums text-ink-950">
          {formatMoney(expense.periodAmountCents)}
        </p>
        {!isPuntual && expense.occurrenceCount > 1 ? (
          <p className="mt-0.5 text-xs font-semibold text-ink-500">
            {formatMoney(expense.amountCents)} × {expense.occurrenceCount} veces
          </p>
        ) : null}
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
    queryFn: (api) => api.listMiscExpenses(from, to),
    placeholderData: keepPreviousData
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

        <div className="mt-5 flex flex-col gap-4 rounded-2xl border border-ink-950/8 bg-cream-50/70 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center rounded-xl border border-ink-950/10 bg-white p-0.5 shadow-xs">
              <button
                type="button"
                onClick={() => moveMonth(-1)}
                disabled={selectedMonth === '2000-01'}
                className="grid size-9 place-items-center rounded-lg text-ink-600 transition hover:bg-cream-100 hover:text-ink-950 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Ver mes anterior"
              >
                <ChevronLeft className="size-4" />
              </button>
              <div className="relative flex w-36 items-center justify-center gap-2 px-2 py-1.5 sm:w-44">
                <CalendarRange className="size-4 shrink-0 text-ink-500" aria-hidden="true" />
                <span className="truncate text-sm font-black capitalize text-ink-950">
                  {monthName}
                </span>
                <input
                  id="misc-expenses-month"
                  type="month"
                  min="2000-01"
                  max="2100-12"
                  value={selectedMonth}
                  onChange={(event) => { if (event.target.value) setSelectedMonth(event.target.value); }}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  title="Cambiar mes"
                  aria-label="Mes a revisar"
                />
              </div>
              <button
                type="button"
                onClick={() => moveMonth(1)}
                disabled={selectedMonth === '2100-12'}
                className="grid size-9 place-items-center rounded-lg text-ink-600 transition hover:bg-cream-100 hover:text-ink-950 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Ver mes siguiente"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>

            {selectedMonth !== today.slice(0, 7) ? (
              <button
                type="button"
                onClick={() => setSelectedMonth(today.slice(0, 7))}
                className="rounded-lg px-2.5 py-1 text-xs font-bold text-brand-700 transition hover:bg-brand-50 hover:text-brand-900"
              >
                Mes actual
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2 sm:text-right">
            <span className="text-xs font-bold text-ink-500">Total del mes:</span>
            <span className={cn(
              "font-display text-xl font-black tabular-nums text-ink-950 transition-opacity",
              expenses.isPlaceholderData && "opacity-50"
            )}>
              {formatMoney(expenses.data?.totalCents ?? 0)}
            </span>
          </div>
        </div>
      </div>

      <div className="min-h-[16rem]">
        {expenses.isPending && !expenses.data ? (
          <LoadingState label="Calculando gastos del período…" />
        ) : null}
        {expenses.isError && !expenses.data ? (
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
          <div className={cn("divide-y divide-ink-950/8 transition-opacity duration-150", expenses.isPlaceholderData && "opacity-50")}>
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
      </div>

      <div className="flex items-center gap-2 border-t border-ink-950/6 bg-cream-50/40 px-5 py-3 text-xs font-medium text-ink-600">
        <Info className="size-4 shrink-0 text-ink-400" aria-hidden="true" />
        <span>Los gastos de este mes se descuentan automáticamente de la ganancia neta en la sección de Ventas.</span>
      </div>

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
