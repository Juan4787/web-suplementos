import { describe, expect, it } from 'vitest';
import {
  calculateBasisPoints,
  formatMoney,
  formatPlainMoney,
  pesosToCents,
  sumCents
} from './money';

describe('money domain logic', () => {
  it('converts pesos to integer cents reliably avoiding float issues', () => {
    expect(pesosToCents(100)).toBe(10_000);
    expect(pesosToCents(25.5)).toBe(2550);
    expect(pesosToCents(25000)).toBe(2_500_000);
    expect(pesosToCents(0)).toBe(0);
    expect(pesosToCents(19.99)).toBe(1999);
  });

  it('formats currency in ARS standard locale without fractional cents in main formatter', () => {
    const formatted = formatMoney(2500000);
    // Standard Argentine format: includes $ and thousands separator
    expect(formatted).toMatch(/\$|ARS/);
    expect(formatted.replace(/\s/g, ' ')).toContain('25.000');
  });

  it('formats plain decimal numbers in ARS format with decimals if present', () => {
    const formatted = formatPlainMoney(2550); // 25.50
    expect(formatted).toContain('25,5');
  });

  it('sums cents safely', () => {
    expect(sumCents([1000, 2500, 3500])).toBe(7000);
    expect(sumCents([])).toBe(0);
    expect(sumCents([500])).toBe(500);
  });

  it('calculates basis points percentages correctly (e.g. 350 basis points = 3.5%)', () => {
    // 100,000 cents ($1,000) * 350 bp (3.5%) = 3,500 cents ($35)
    expect(calculateBasisPoints(100_000, 350)).toBe(3500);
    // 0 cents
    expect(calculateBasisPoints(0, 350)).toBe(0);
    // 0 bp
    expect(calculateBasisPoints(50_000, 0)).toBe(0);
    // 10,000 bp (100%)
    expect(calculateBasisPoints(50_000, 10_000)).toBe(50_000);
    // rounding test: 105 cents * 350 bp = 367.5 / 10000 -> 0.03675 -> 0
    expect(calculateBasisPoints(105, 350)).toBe(4);
  });
});
