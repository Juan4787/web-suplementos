import { describe, expect, it } from 'vitest';
import { salesDateAt } from './sales-date';

describe('canonical sales date', () => {
  it.each([
    ['2026-10-01T02:59:59.999Z', '2026-09-30'], ['2026-10-01T03:00:00Z', '2026-10-01'],
    ['2032-03-01T02:59:59.999Z', '2032-02-29'], ['2032-03-01T03:00:00Z', '2032-03-01'],
    ['2100-03-01T02:59:59.999Z', '2100-02-28'], ['2000-03-01T02:59:59.999Z', '2000-02-29'],
    ['2027-01-01T02:59:59.999Z', '2026-12-31'], ['2027-01-01T03:00:00Z', '2027-01-01'],
    ['2008-01-15T01:59:59.999Z', '2008-01-14'], ['2008-01-15T02:00:00Z', '2008-01-15'],
    ['2007-12-30T02:59:59.999Z', '2007-12-29'], ['2007-12-30T03:00:00Z', '2007-12-30'],
    ['2008-03-16T02:59:59.999Z', '2008-03-15'], ['2008-03-16T03:00:00Z', '2008-03-16']
  ])('%s belongs to %s', (instant, expected) => expect(salesDateAt(instant)).toBe(expected));

  it('every calendar date from 2000 through 2100 is stable in both standard and daylight saving time', () => {
    const first = Date.UTC(2000, 0, 1), last = Date.UTC(2100, 11, 31);
    for (let date = first; date <= last; date += 86400000) {
      const expected = new Date(date).toISOString().slice(0, 10);
      // These two instants belong to this date in both historical offsets.
      // Explicit midnight transitions are tested separately above.
      expect(salesDateAt(new Date(date + 12 * 3600000)), expected).toBe(expected);
      expect(salesDateAt(new Date(date + 25 * 3600000)), expected).toBe(expected);
    }
  });
});
