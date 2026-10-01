// Live reporting audit: startup and transaction are both READ ONLY.
// This script cannot apply migrations or create business/test data.
import { Client } from 'pg';
import { loadEnv } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';
import { PROJECT_ROOT, SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

assertSupabaseTarget();
const env = loadEnv('production', PROJECT_ROOT, '');
const password = (process.env.SUPABASE_DB_PASSWORD || env.SUPABASE_DB_PASSWORD)?.trim();
if (!password) throw new Error('Missing read access');
const client = new Client({ host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`, port: 6543,
  database: 'postgres', user: `postgres.${SUPABASE_PROJECT_REF}`, password, ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000, query_timeout: 20000,
  options: '-c default_transaction_read_only=on -c statement_timeout=15000' });
const day = date => date.toISOString().slice(0, 10);
const addDays = (iso, count) => day(new Date(Date.parse(`${iso}T12:00:00Z`) + count * 86400000));
const sum = (rows, key) => rows.reduce((total, row) => total + BigInt(row[key]), 0n);
const exact = value => {
  if (!Number.isSafeInteger(value)) throw new Error('Unsafe integer in analytics response');
  return BigInt(value);
};
const roundRatio = (numerator, denominator) => denominator ? (numerator * 2n + denominator) / (2n * denominator) : 0n;
const periods = new Map();
const addPeriod = (from, to, label) => periods.set(`${from}/${to}`, { from, to, label });
const report = { environment: 'production-read-only', at: new Date().toISOString(), periods: 0,
  checked: ['source rows', 'counts', 'revenue', 'cost', 'tax', 'gifts', 'cost sales', 'expenses', 'ticket', 'monthly points', 'stored product costs', 'AI facts'], snapshots: [], failures: [] };
let connected = false;
try {
  await client.connect(); connected = true;
  await client.query('begin isolation level repeatable read read only');
  const settings = (await client.query("select current_setting('transaction_read_only') as read_only, (now() at time zone 'America/Argentina/Buenos_Aires')::date::text as today")).rows[0];
  if (settings.read_only !== 'on') throw new Error('Read-only protection missing');
  const migration = readFileSync(resolve(PROJECT_ROOT, 'supabase/migrations/20261001120000_sales_analytics_full_period.sql'), 'utf8');
  for (const [index, signature] of ['public.get_sales_analytics(date,date)', 'public.ai_get_product_performance(date,date,text,integer)'].entries()) {
    const definition = (await client.query('select prosrc,provolatile,prosecdef from pg_proc where oid=$1::regprocedure', [signature])).rows[0];
    const body = [...migration.matchAll(/as \$\$([\s\S]*?)\$\$;/g)][index]?.[1];
    if (definition.prosrc.trim() !== body?.trim() || definition.provolatile !== 's' || !definition.prosecdef) throw new Error('Deployed reporting definition does not match the audited migration');
  }
  const owner = (await client.query("select user_id from public.store_users where active and role='owner' order by user_id limit 1")).rows[0]?.user_id;
  if (!owner) throw new Error('Owner context unavailable');
  await client.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
  const orders = (await client.query(`select id, payment_state, sale_type, total_cents, cost_total_cents, tax_amount_cents,
    (coalesce(paid_at,created_at) at time zone 'America/Argentina/Buenos_Aires')::date::text as date
    from public.orders where payment_state in ('paid','gifted')`)).rows;
  const items = (await client.query(`select oi.order_id,oi.product_id,p.sku,oi.product_name_snapshot as name,oi.quantity,
    oi.line_subtotal_cents,oi.cost_total_cents,oi.unit_cost_cents from public.order_items oi
    join public.orders o on o.id=oi.order_id join public.products p on p.id=oi.product_id where o.payment_state in ('paid','gifted')`)).rows;
  const year = Number(settings.today.slice(0, 4));
  const fromYear = `${year}-01-01`, toYear = `${year}-12-31`;
  const horizonFrom = `${year - 1}-01-01`;
  const expenses = (await client.query('select occurrence_on::text as date,amount_cents from private.misc_expense_occurrences($1::date,$2::date)', [horizonFrom, toYear])).rows;
  for (let date = fromYear; date <= toYear; date = addDays(date, 1)) {
    const month = `${date.slice(0, 7)}-01`;
    const sixFrom = new Date(`${month}T12:00:00Z`); sixFrom.setUTCMonth(sixFrom.getUTCMonth() - 5);
    addPeriod(date, date, 'daily'); addPeriod(month, date, 'month_to_day');
    addPeriod(fromYear, date, 'year_to_day'); addPeriod(day(sixFrom), date, 'six_months_to_day');
    addPeriod(addDays(date, -29), date, '30_days');
  }
  // Every contiguous inclusion set of currently recorded business dates.
  const boundaries = [...new Set([...orders, ...expenses].filter(row => row.date >= fromYear && row.date <= settings.today)
    .flatMap(row => [row.date, addDays(row.date, -1), addDays(row.date, 1)]))].sort();
  for (const from of boundaries) for (const to of boundaries) if (from <= to) addPeriod(from, to, 'recorded_boundaries');
  addPeriod('2026-05-01', '2026-10-01', 'original_screenshots');
  const check = (name, got, expected, period) => {
    if (exact(got) !== BigInt(expected)) report.failures.push({ name, period, got, expected: String(expected) });
  };
  const all = [...periods.values()];
  for (let offset = 0; offset < all.length; offset += 40) {
    const batch = all.slice(offset, offset + 40);
    const rows = (await client.query(`select p.f::text,p.t::text,public.get_sales_analytics(p.f,p.t) as a
      from jsonb_to_recordset($1::jsonb) as p(f date,t date)`, [JSON.stringify(batch.map(p => ({ f: p.from, t: p.to })))])).rows;
    for (let i = 0; i < rows.length; i++) {
      const { a, f, t } = rows[i], p = batch.find(p => p.from === f && p.to === t), key = `${p.from}/${p.to}`;
      const included = orders.filter(o => o.date >= p.from && o.date <= p.to);
      const paid = included.filter(o => o.payment_state === 'paid'), gifts = included.filter(o => o.payment_state === 'gifted' || o.sale_type === 'gift');
      const costs = included.filter(o => o.sale_type === 'cost'), e = expenses.filter(row => row.date >= p.from && row.date <= p.to);
      const revenue = sum(included, 'total_cents'), cost = sum(included, 'cost_total_cents'), tax = sum(included, 'tax_amount_cents'), expense = sum(e, 'amount_cents');
      for (const [name, expected] of Object.entries({ revenueCents: revenue, costCents: cost, taxCents: tax,
        orders: BigInt(paid.length), giftOrders: BigInt(gifts.length), costSaleOrders: BigInt(costs.length),
        giftCostCents: sum(gifts, 'cost_total_cents'), costSaleRevenueCents: sum(costs, 'total_cents'),
        miscExpensesCents: expense, miscExpenseOccurrences: BigInt(e.length), commercialMarginCents: revenue-cost-tax,
        estimatedMarginCents: revenue-cost-tax-expense, averageTicketCents: roundRatio(revenue, BigInt(paid.length)) })) check(name, a[name], expected, key);
      if (a.from !== p.from || a.to !== p.to || a.comparisonCutoffDay !== null) report.failures.push({ name: 'date_contract', period: key });
      const expectedMonths = [];
      for (let month = new Date(`${p.from.slice(0,7)}-01T12:00:00Z`); day(month).slice(0,7) <= p.to.slice(0,7); month.setUTCMonth(month.getUTCMonth()+1)) expectedMonths.push(day(month).slice(0,7));
      if (JSON.stringify(a.series.map(point=>point.period)) !== JSON.stringify(expectedMonths)) report.failures.push({ name: 'monthly.coverage', period: key });
      for (const point of a.series) {
        const month = included.filter(o => o.date.slice(0, 7) === point.period);
        check('monthly.revenue', point.revenueCents, sum(month, 'total_cents'), `${key}:${point.period}`);
        check('monthly.paid', point.orderCount, month.filter(o => o.payment_state === 'paid').length, `${key}:${point.period}`);
      }
      check('series.total_revenue', a.series.reduce((n,s) => n+s.revenueCents,0), revenue, key);
      check('series.total_count', a.series.reduce((n,s) => n+s.orderCount,0), paid.length, key);
      const ids = new Set(included.map(o => o.id)), lines = items.filter(l => ids.has(l.order_id));
      check('units', a.units, lines.reduce((n,l) => n+l.quantity,0), key);
      for (const product of a.topProducts) {
        const group = lines.filter(l => l.product_id===product.productId && l.name===product.name);
        check('product.cost', product.costCents, sum(group,'cost_total_cents'), key);
        check('product.revenue', product.revenueCents, sum(group,'line_subtotal_cents'), key);
        check('product.units', product.units, group.reduce((n,l)=>n+l.quantity,0), key);
        const margin = group.reduce((n,l)=>{
          const order = included.find(o=>o.id===l.order_id);
          return n+BigInt(l.line_subtotal_cents)-BigInt(l.cost_total_cents)-roundRatio(BigInt(order.tax_amount_cents)*BigInt(l.line_subtotal_cents),BigInt(order.total_cents));
        },0n);
        check('product.margin', product.estimatedMarginCents, margin, key);
      }
      if (p.label === 'original_screenshots') report.snapshots.push({ period: key, revenueCents: a.revenueCents,
        costCents: a.costCents, orders: a.orders, giftOrders: a.giftOrders, costSaleOrders: a.costSaleOrders,
        miscExpensesCents: a.miscExpensesCents, netCents: a.estimatedMarginCents, averageTicketCents: a.averageTicketCents });
      report.periods++;
    }
    if ((offset + 40) % 200 === 0) console.log(`Verified ${report.periods}/${all.length} live date ranges; discrepancies: ${report.failures.length}`);
  }
  for (const p of [all[0], periods.get('2026-05-01/2026-10-01')]) {
    const row = (await client.query(`select public.get_sales_analytics($1::date,$2::date) as a,
      public.ai_get_sales_summary($1::date,$2::date) as ai,public.search_paid_orders(1,1,$1::date,$2::date) as listing,
      public.ai_get_product_performance($1::date,$2::date,null,10) as products`, [p.from, p.to])).rows[0];
    check('AI.count', row.ai.facts['sales.order_count'], row.a.orders, `${p.from}/${p.to}`);
    check('AI.net', row.ai.facts['sales.net_profit_cents'], row.a.estimatedMarginCents, `${p.from}/${p.to}`);
    check('listing', row.listing.total, orders.filter(o=>o.date>=p.from && o.date<=p.to).length, `${p.from}/${p.to}`);
    for (const product of row.products.products) {
      const paid = orders.filter(o=>o.payment_state==='paid' && o.date>=p.from && o.date<=p.to);
      const group = items.filter(l=>`product:${l.sku}`===product.ref && paid.some(o=>o.id===l.order_id));
      const margin = group.reduce((n,l)=>{
        const order=paid.find(o=>o.id===l.order_id);
        return n+BigInt(l.line_subtotal_cents)-BigInt(l.cost_total_cents)-roundRatio(BigInt(order.tax_amount_cents)*BigInt(l.line_subtotal_cents),BigInt(order.total_cents));
      },0n);
      check('AI.product.margin',product.facts['performance.estimated_margin_cents'],margin,`${p.from}/${p.to}`);
    }
  }
  await client.query('rollback');
  mkdirSync(resolve(PROJECT_ROOT, 'output/audit'), { recursive: true });
  writeFileSync(resolve(PROJECT_ROOT, 'output/audit/sales-production-readonly.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ periods: report.periods, failures: report.failures.length, snapshots: report.snapshots, completedWithRollback: true }));
  if (report.failures.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ auditFailed: true, code: error.code ?? 'VERIFICATION_FAILED',
    detail: error.code ? 'Read-only query failed' : error.message })); process.exitCode = 1;
} finally {
  if (connected) { try { await client.query('rollback'); } catch {} await client.end().catch(() => {}); }
}
