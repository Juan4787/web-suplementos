import type { MiscExpenseFrequency } from './types';

// Mantiene cada importe exacto como Number y deja amplio margen para sumar
// recurrencias de varios años sin salir del rango entero seguro del navegador.
export const MAX_MISC_EXPENSE_CENTS = 99_999_999_999;
export const MIN_MISC_EXPENSE_DATE = '2000-01-01';
export const MAX_MISC_EXPENSE_DATE = '2100-12-31';

export type MiscExpenseValues = {
  title: string;
  amountCents: number;
  frequency: MiscExpenseFrequency;
  startsOn: string;
  endsOn: string | null;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

const dateToEpochDay = (value: string): number | null => {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 86_400_000);
};

const epochDayToDate = (epochDay: number): string =>
  new Date(epochDay * 86_400_000).toISOString().slice(0, 10);

export const isIsoCalendarDate = (value: string): boolean => dateToEpochDay(value) !== null;

export const isSupportedMiscExpenseDate = (value: string): boolean =>
  isIsoCalendarDate(value) && value >= MIN_MISC_EXPENSE_DATE && value <= MAX_MISC_EXPENSE_DATE;

export const miscExpenseValidationIssues = (values: MiscExpenseValues): string[] => {
  const issues: string[] = [];
  const titleLength = values.title.trim().length;
  const startDay = dateToEpochDay(values.startsOn);
  const endDay = values.endsOn === null ? null : dateToEpochDay(values.endsOn);

  if (titleLength < 2 || titleLength > 100) {
    issues.push('Escribí un título de entre 2 y 100 caracteres.');
  }
  if (
    !Number.isSafeInteger(values.amountCents) ||
    values.amountCents <= 0 ||
    values.amountCents > MAX_MISC_EXPENSE_CENTS
  ) {
    issues.push('Ingresá un monto mayor a cero y dentro del límite permitido.');
  }
  if (!['once', 'weekly', 'monthly'].includes(values.frequency)) {
    issues.push('Elegí si el gasto ocurre una vez, semanalmente o mensualmente.');
  }
  if (startDay === null || !isSupportedMiscExpenseDate(values.startsOn)) {
    issues.push('Elegí una fecha válida entre los años 2000 y 2100.');
  }
  if (values.frequency === 'once' && values.endsOn !== null) {
    issues.push('Un gasto puntual no puede tener fecha de finalización.');
  }
  if (
    values.endsOn !== null &&
    (
      endDay === null ||
      !isSupportedMiscExpenseDate(values.endsOn) ||
      (startDay !== null && endDay < startDay)
    )
  ) {
    issues.push('La fecha de finalización debe ser igual o posterior a la fecha de inicio.');
  }
  return issues;
};

export const validateMiscExpense = (values: MiscExpenseValues): void => {
  const issues = miscExpenseValidationIssues(values);
  if (issues.length > 0) throw new Error(issues.join(' '));
};

export const countMiscExpenseOccurrences = (
  expense: Pick<MiscExpenseValues, 'frequency' | 'startsOn' | 'endsOn'>,
  from: string,
  to: string
): number => {
  const startsOn = dateToEpochDay(expense.startsOn);
  const fromDay = dateToEpochDay(from);
  const toDay = dateToEpochDay(to);
  const configuredEnd = expense.endsOn === null ? null : dateToEpochDay(expense.endsOn);
  if (
    startsOn === null ||
    fromDay === null ||
    toDay === null ||
    fromDay > toDay ||
    (expense.endsOn !== null && configuredEnd === null)
  ) {
    return 0;
  }

  const effectiveStart = Math.max(startsOn, fromDay);
  const effectiveEnd = Math.min(toDay, configuredEnd ?? toDay);
  if (effectiveEnd < effectiveStart) return 0;

  if (expense.frequency === 'once') {
    return startsOn >= effectiveStart && startsOn <= effectiveEnd ? 1 : 0;
  }

  if (expense.frequency === 'weekly') {
    const firstIndex = Math.max(0, Math.ceil((effectiveStart - startsOn) / 7));
    const lastIndex = Math.floor((effectiveEnd - startsOn) / 7);
    return Math.max(0, lastIndex - firstIndex + 1);
  }

  if (expense.frequency !== 'monthly') return 0;

  const startDate = new Date(startsOn * 86_400_000);
  const anchorDay = startDate.getUTCDate();
  const rangeStart = new Date(effectiveStart * 86_400_000);
  const rangeEnd = new Date(effectiveEnd * 86_400_000);
  let year = rangeStart.getUTCFullYear();
  let month = rangeStart.getUTCMonth();
  const endYear = rangeEnd.getUTCFullYear();
  const endMonth = rangeEnd.getUTCMonth();
  let count = 0;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const occurrence = dateToEpochDay(
      `${year.toString().padStart(4, '0')}-${(month + 1).toString().padStart(2, '0')}-${Math.min(anchorDay, lastDay).toString().padStart(2, '0')}`
    );
    if (occurrence !== null && occurrence >= effectiveStart && occurrence <= effectiveEnd) count += 1;
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return count;
};

export const listMiscExpenseOccurrenceDates = (
  expense: Pick<MiscExpenseValues, 'frequency' | 'startsOn' | 'endsOn'>,
  from: string,
  to: string
): string[] => {
  const count = countMiscExpenseOccurrences(expense, from, to);
  if (count === 0) return [];
  const startsOn = dateToEpochDay(expense.startsOn)!;
  const fromDay = dateToEpochDay(from)!;
  const toDay = Math.min(dateToEpochDay(to)!, expense.endsOn ? dateToEpochDay(expense.endsOn)! : Number.MAX_SAFE_INTEGER);

  if (expense.frequency === 'once') return [expense.startsOn];
  if (expense.frequency === 'weekly') {
    const firstIndex = Math.max(0, Math.ceil((Math.max(startsOn, fromDay) - startsOn) / 7));
    return Array.from({ length: count }, (_, index) => epochDayToDate(startsOn + (firstIndex + index) * 7));
  }

  const dates: string[] = [];
  const startDate = new Date(startsOn * 86_400_000);
  const rangeStart = new Date(Math.max(startsOn, fromDay) * 86_400_000);
  let year = rangeStart.getUTCFullYear();
  let month = rangeStart.getUTCMonth();
  while (dates.length < count) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const candidate = dateToEpochDay(
      `${year.toString().padStart(4, '0')}-${(month + 1).toString().padStart(2, '0')}-${Math.min(startDate.getUTCDate(), lastDay).toString().padStart(2, '0')}`
    )!;
    if (candidate >= startsOn && candidate >= fromDay && candidate <= toDay) dates.push(epochDayToDate(candidate));
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return dates;
};
