// One-time handoff authorized on 2026-09-09. No inferred incoming purchases.
// Preview first, back up that state, then use --apply-authorized-opening-stock.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { loadEnv } from 'vite';
import { SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

const physical = {
  B_COMPLEX_ACTIVE: 2, MAGNESIO_DUAL_ACTION: 3, ANDRO_SUPPORT: 2,
  FEMME_BALANCE: 3, PROBIOVANCE_I5: 2, OMEGA_3: 5,
  OMEGA_PURE_NUTRITION_ULTRA: 4, MSM: 4, VITAMINA_C: 1,
  CREATINA: 3, GLUTAMINA: 2, INOSITOL_CARE: 3, METABOGLYC: 2,
  HEPATO_SUPPORT: 3, GASTRO_SUPPORT: 6, ACID_SUPPORT: 4
};
const planFile = 'output/audit/real-opening-stock-plan.json';
const backupFile = 'output/audit/real-opening-stock-backup.json';
const resultFile = 'output/audit/real-opening-stock-result.json';
const apply = process.argv.includes('--apply-authorized-opening-stock');
const env = loadEnv('production', process.cwd(), '');
if (new URL(env.VITE_SUPABASE_URL).hostname !== `${SUPABASE_PROJECT_REF}.supabase.co`) throw new Error('Unexpected database target');
const hash = data => createHash('sha256').update(data).digest('hex');
const tables = ['purchase_receipts', 'stock_movements', 'stock_reservations', 'order_items', 'orders', 'purchase_items', 'purchases', 'customers'];
const protectedTables = ['products', 'product_financials', 'product_images', 'store_settings', 'store_users'];
const db = new Client({ host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`, port: 5432,
  user: `postgres.${SUPABASE_PROJECT_REF}`, database: 'postgres', password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 30000 });
const fingerprints = async () => {
  const result = {};
  for (const table of [...protectedTables, ...tables, 'stock_balances']) {
    const rows = (await db.query(`select count(*)::int count, md5(coalesce(string_agg(row_data::text, '' order by row_data::text),'')) hash from (select to_jsonb(t) row_data from public.${table} t) rows`)).rows[0];
    result[table] = rows;
  }
  return result;
};
try {
  await db.connect();
  await db.query(apply ? 'begin' : 'begin isolation level repeatable read read only');
  await db.query("set local lock_timeout = '5s'");
  if (apply) await db.query(`lock table ${[...protectedTables, ...tables, 'stock_balances'].map(t => `public.${t}`).join(',')} in share row exclusive mode`);
  const before = await fingerprints();
  const owner = (await db.query("select s.user_id from store_users s join auth.users u on u.id=s.user_id where lower(u.email)='natisfrutos@gmail.com' and s.role='owner' and s.active")).rows[0];
  if (!owner || before.store_users.count !== 2) throw new Error('Unexpected account state');
  const products = (await db.query('select id,sku,name,active from products order by sku')).rows;
  for (const sku of Object.keys(physical)) {
    if (!products.some(p => p.sku === sku && p.active)) throw new Error(`Missing active product: ${sku}`);
  }
  const plan = { project: SUPABASE_PROJECT_REF, createdAt: new Date().toISOString(), before,
    physical: products.map(p => ({ ...p, quantity: physical[p.sku] ?? 0 })),
    totalPhysical: Object.values(physical).reduce((sum, quantity) => sum + quantity, 0),
    incoming: 'Pending clarification of conflicting source lists; no inferred purchases',
    knownIncomingReservations: { THYROID_SUPPORT: 3, SLEEP_SUPPORT: 4, VITALITY_SUPPORT: 1 }
  };
  if (!apply) {
    if (before.orders.count !== 7 || before.purchases.count !== 1 || before.customers.count !== 6) throw new Error('Test operations changed; review the current state before replacing the handoff plan');
    writeFileSync(planFile, JSON.stringify(plan, null, 2), { mode: 0o600 });
    await db.query('rollback');
    console.log(JSON.stringify({ preview: true, planFile, totalPhysical: plan.totalPhysical, productsWithStock: Object.keys(physical).length, trialsToRemove: Object.fromEntries(tables.map(t => [t, before[t].count])) }));
  } else {
    const preview = JSON.parse(readFileSync(planFile, 'utf8'));
    const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
    if (preview.project !== SUPABASE_PROJECT_REF || JSON.stringify(preview.before) !== JSON.stringify(before)
      || JSON.stringify(preview.physical) !== JSON.stringify(plan.physical)) throw new Error('State changed since preview; nothing removed');
    if (backup.project !== SUPABASE_PROJECT_REF || new Date(backup.createdAt) < new Date(preview.createdAt)
      || Date.now() - new Date(backup.createdAt).getTime() > 30 * 60 * 1000
      || hash(readFileSync(`${backup.directory}/${backup.file}`)) !== backup.sha256) throw new Error('Fresh verified backup required');
    // The explicit user instruction replaces ALL current test operations with real opening data.
    for (const table of tables) await db.query(`delete from public.${table}`);
    await db.query('update stock_balances set on_hand=0,reserved=0,updated_at=now()');
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner.user_id]);
    for (const product of plan.physical.filter(p => p.quantity > 0)) {
      await db.query('select adjust_product_stock_checked($1,$2,$3,0)', [product.id, product.quantity, 'Stock inicial real para empezar a usar la tienda']);
    }
    await db.query('select private.bump_revision()');
    const after = await fingerprints();
    for (const table of protectedTables) if (JSON.stringify(after[table]) !== JSON.stringify(before[table])) throw new Error(`Protected data changed: ${table}`);
    for (const table of tables.filter(t => t !== 'stock_movements')) if (after[table].count !== 0) throw new Error(`Unexpected remaining trial records: ${table}`);
    const balances = (await db.query('select p.sku,b.on_hand,b.reserved from products p join stock_balances b on b.product_id=p.id order by p.sku')).rows;
    if (balances.length !== products.length || balances.some(b => b.on_hand !== (physical[b.sku] ?? 0) || b.reserved !== 0)) throw new Error('Opening stock does not match the supplied physical count');
    if (after.stock_movements.count !== Object.keys(physical).length) throw new Error('Missing opening stock movements');
    await db.query('commit');
    const result = { committedAt: new Date().toISOString(), backup, protectedDataIdentical: true, before, after, totalPhysical: plan.totalPhysical, balances, incomingPendingClarification: true };
    writeFileSync(resultFile, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ committed: true, totalPhysical: plan.totalPhysical, productsWithStock: Object.keys(physical).length, protectedDataIdentical: true, resultFile, incomingPendingClarification: true }));
  }
} catch (error) { await db.query('rollback').catch(() => {}); throw error; }
finally { await db.end(); }
