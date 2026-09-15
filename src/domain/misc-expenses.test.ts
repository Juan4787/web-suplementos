import { describe, expect, it } from 'vitest';
import {
  MAX_MISC_EXPENSE_CENTS,
  countMiscExpenseOccurrences,
  listMiscExpenseOccurrenceDates,
  miscExpenseValidationIssues,
  validateMiscExpense
} from './misc-expenses';

describe('gastos varios y recurrencias', () => {
  it('cuenta un gasto puntual solo dentro de su fecha', () => {
    const expense = { frequency: 'once' as const, startsOn: '2026-09-15', endsOn: null };
    expect(countMiscExpenseOccurrences(expense, '2026-09-01', '2026-09-30')).toBe(1);
    expect(countMiscExpenseOccurrences(expense, '2026-08-01', '2026-08-31')).toBe(0);
  });

  it('alinea la recurrencia semanal con la fecha elegida y respeta el cierre inclusivo', () => {
    const expense = {
      frequency: 'weekly' as const,
      startsOn: '2026-09-02',
      endsOn: '2026-09-23'
    };
    expect(listMiscExpenseOccurrenceDates(expense, '2026-09-01', '2026-09-30')).toEqual([
      '2026-09-02',
      '2026-09-09',
      '2026-09-16',
      '2026-09-23'
    ]);
  });

  it('usa el último día en meses cortos sin desplazar el ancla mensual', () => {
    const expense = {
      frequency: 'monthly' as const,
      startsOn: '2026-01-31',
      endsOn: '2026-04-30'
    };
    expect(listMiscExpenseOccurrenceDates(expense, '2026-01-01', '2026-04-30')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30'
    ]);
  });

  it('rechaza títulos, montos y rangos que podrían corromper el cálculo', () => {
    const invalid = {
      title: ' ',
      amountCents: 0,
      frequency: 'monthly' as const,
      startsOn: '2026-02-30',
      endsOn: '2026-02-31'
    };
    expect(miscExpenseValidationIssues(invalid)).toHaveLength(4);
    expect(() => validateMiscExpense(invalid)).toThrow(/título.*monto.*fecha válida.*finalización/u);
  });

  it('no permite una finalización oculta en un gasto puntual', () => {
    expect(() =>
      validateMiscExpense({
        title: 'Etiquetas',
        amountCents: 5000,
        frequency: 'once',
        startsOn: '2026-09-15',
        endsOn: '2026-09-16'
      })
    ).toThrow(/puntual/u);
  });

  it('mantiene fechas e importes dentro del rango compartido con la base', () => {
    expect(miscExpenseValidationIssues({
      title: 'Costo fuera de rango',
      amountCents: MAX_MISC_EXPENSE_CENTS + 1,
      frequency: 'weekly',
      startsOn: '1999-12-31',
      endsOn: '2101-01-01'
    })).toHaveLength(3);
  });
});
