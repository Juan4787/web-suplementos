import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoBusinessApi } from './demo-business-api';

vi.mock('@/data/demo-data', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/data/demo-data')>();
  const base = original.demoOrders[0]!;
  const item = base.items[0]!;
  const dates = ['2032-02-28T23:59:59-03:00', '2032-02-29T23:59:59-03:00',
    '2032-03-01T00:00:00-03:00', '2032-09-15T12:00:00-03:00', '2032-10-01T12:00:00-03:00',
    '2008-01-15T00:00:00-02:00', '2008-01-15T23:59:59-02:00'];
  return {
    ...original,
    demoOrders: [...dates.flatMap((date, index) => (['retail', 'cost', 'gift', 'pending', 'refunded'] as const).map(kind => ({
      ...base, id: `${index}-${kind}`, number: index * 5 + ['retail', 'cost', 'gift', 'pending', 'refunded'].indexOf(kind),
      createdAt: date, confirmedAt: date, paidAt: kind === 'gift' ? null : date,
      paymentState: kind === 'gift' ? 'gifted' as const : kind === 'pending' ? 'pending' as const : kind === 'refunded' ? 'refunded' as const : 'paid' as const,
      paymentMethod: kind === 'gift' ? 'gift' as const : 'cash' as const,
      saleType: kind === 'gift' ? 'gift' as const : kind === 'cost' ? 'cost' as const : 'retail' as const,
      isCostSale: kind === 'cost', totalCents: kind === 'retail' ? 100001 : kind === 'cost' ? 50003 : 0,
      subtotalCents: kind === 'retail' ? 100001 : kind === 'cost' ? 50003 : 0,
      costTotalCents: kind === 'gift' ? 75001 : 50003, taxAmountCents: kind === 'retail' ? 1001 : 0,
      items: [{ ...item, id: `${index}-${kind}-line`, quantity: 1,
        unitPriceCents: kind === 'retail' ? 100001 : kind === 'cost' ? 50003 : 0,
        unitCostCents: 50000, costTotalCents: kind === 'gift' ? 75001 : 50003,
        subtotalCents: kind === 'retail' ? 100001 : kind === 'cost' ? 50003 : 0 }]
    }))), ...Array.from({ length: 20 }, (_, index) => ({
      ...base, id: `ranking-${index}`, paymentState: 'paid' as const, saleType: 'retail' as const,
      paidAt: '2035-01-01T12:00:00-03:00', createdAt: '2035-01-01T12:00:00-03:00',
      totalCents: 10000, costTotalCents: 7000, taxAmountCents: index === 19 ? null : 0,
      items: [{ ...item, productId: index < 2 ? 'renamed' : `rank-${index}`,
        productName: `Product ${index}`, quantity: 1, subtotalCents: 10000,
        costTotalCents: 7000, unitCostCents: 7000 }]
    }))]
  };
});

const read = async (from: string, to: string) => {
  const promise = demoBusinessApi.getAnalytics(from, to);
  await vi.advanceTimersByTimeAsync(200);
  return promise;
};

describe('demo sales: independent period and payment accounting', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps every earlier day, cost sale and gift inside a multi-month range', async () => {
    const a = await read('2032-02-01', '2032-10-01');
    expect(a).toMatchObject({ comparisonCutoffDay: null, revenueCents: 750020,
      costCents: 875035, taxCents: 5005, orders: 10, giftOrders: 5, costSaleOrders: 5,
      averageTicketCents: 75002, commercialMarginCents: -130020, estimatedMarginCents: -130020 });
    expect(a.series.reduce((sum, p) => sum + p.orderCount, 0)).toBe(10);
    expect(a.series.reduce((sum, p) => sum + p.revenueCents, 0)).toBe(750020);
    expect(a.topProducts[0]?.costCents).toBe(875035);
    expect(a.topProducts[0]?.estimatedMarginCents).toBe(-130020);
  });

  it.each([
    ['2032-02-28', 2, 1, 150004], ['2032-02-29', 2, 1, 150004],
    ['2032-03-01', 2, 1, 150004], ['2032-09-15', 2, 1, 150004],
    ['2032-10-01', 2, 1, 150004], ['2032-10-02', 0, 0, 0]
  ])('uses the business date %s for exact daily counts', async (date, orders, gifts, cents) => {
    const a = await read(date, date);
    expect(a.orders).toBe(orders);
    expect(a.giftOrders).toBe(gifts);
    expect(a.revenueCents).toBe(cents);
    const listing = demoBusinessApi.listPaidOrders(1, 100, date, date);
    await vi.advanceTimersByTimeAsync(200);
    expect((await listing).total).toBe(orders + gifts);
    for (const point of a.series) expect(point.period).toBe(date.slice(0, 7));
  });

  it('all 366 leap-year end dates agree with an independent timestamp sum', async () => {
    const ledger = [
      Date.parse('2032-02-28T23:59:59-03:00'), Date.parse('2032-02-29T23:59:59-03:00'),
      Date.parse('2032-03-01T00:00:00-03:00'), Date.parse('2032-09-15T12:00:00-03:00'),
      Date.parse('2032-10-01T12:00:00-03:00')
    ];
    for (let day = 0; day < 366; day++) {
      const to = new Date(Date.UTC(2032, 0, 1 + day)).toISOString().slice(0, 10);
      const included = ledger.filter(time => time < Date.parse(`${to}T00:00:00-03:00`) + 86400000).length;
      const a = await read('2032-01-01', to);
      expect(a.orders, to).toBe(included * 2);
      expect(a.revenueCents, to).toBe(included * 150004);
      expect(a.averageTicketCents, to).toBe(included ? 75002 : 0);
      expect(a.giftOrders, to).toBe(included);
      expect(a.series.reduce((sum, p) => sum + p.orderCount, 0), to).toBe(a.orders);
    }
  }, 15000);

  it('historical daylight saving uses the same inclusive business day in report and listing', async () => {
    const a = await read('2008-01-15', '2008-01-15');
    expect(a.orders).toBe(4);
    expect(a.giftOrders).toBe(2);
    expect(a.revenueCents).toBe(300008);
    const listing = demoBusinessApi.listPaidOrders(1, 100, '2008-01-15', '2008-01-15');
    await vi.advanceTimersByTimeAsync(200);
    expect((await listing).total).toBe(6);
  });

  it('ranking preserves historical names and the ten-row perimeter without cutting period totals', async () => {
    const a = await read('2035-01-01', '2035-01-01');
    expect(a.orders).toBe(20);
    expect(a.revenueCents).toBe(200000);
    expect(a.costCents).toBe(140000);
    expect(a.topProducts).toHaveLength(10);
    expect(a.topProducts.find(p => p.name === 'Product 0')?.units).toBe(1);
    expect(a.topProducts.find(p => p.name === 'Product 1')?.units).toBe(1);
  });
});
