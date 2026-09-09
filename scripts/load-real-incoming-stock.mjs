// Add the two purchases clarified by the owner on 2026-09-09; never reset opening stock.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { loadEnv } from 'vite';
import { SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

const shipments = [
  { notes: 'Compra previa 1: ya está en el correo de Santa Fe, pendiente de retiro. Incluye reservas previas: Thyroid 3, Sleep 4 y Vitality 1. Costos según catálogo; verificar contra el comprobante.',
    items: { B_COMPLEX_ACTIVE: 20, THYROID_SUPPORT: 10, MAGNESIO_DUAL_ACTION: 10, VITALITY_SUPPORT: 8, SLEEP_SUPPORT: 8, VITAMINA_C: 4, COLAGENO_HIDROLIZADO: 2 } },
  { notes: 'Compra previa 2: pagada al proveedor. Despacho previsto para el viernes. Fecha de llegada por confirmar. Costos según catálogo; verificar contra el comprobante.',
    items: { B_COMPLEX_ACTIVE: 10, THYROID_SUPPORT: 15, MAGNESIO_DUAL_ACTION: 10, INOSITOL_CARE: 6, HEPATO_SUPPORT: 6, ANDRO_SUPPORT: 8, D_40_SUPPORT: 4, VITALITY_SUPPORT: 4, SLEEP_SUPPORT: 4, FEMME_BALANCE: 2, VITAMINA_C: 2, GLUTAMINA: 8, CREATINA: 2, COLAGENO_HIDROLIZADO: 2 } }
];
const reserved = { THYROID_SUPPORT: 3, SLEEP_SUPPORT: 4, VITALITY_SUPPORT: 1 };
const planFile = 'output/audit/real-incoming-plan.json';
const backupFile = 'output/audit/real-incoming-backup.json';
const apply = process.argv.includes('--apply-authorized-incoming-stock');
const env = loadEnv('production', process.cwd(), '');
if (new URL(env.VITE_SUPABASE_URL).hostname !== `${SUPABASE_PROJECT_REF}.supabase.co`) throw new Error('Unexpected target');
const db = new Client({ host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`, port: 5432,
  user: `postgres.${SUPABASE_PROJECT_REF}`, database: 'postgres', password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 30000 });
const preserved = ['products', 'product_financials', 'product_images', 'store_settings', 'store_users', 'stock_balances', 'stock_movements', 'orders', 'order_items', 'customers'];
const written = ['purchases', 'purchase_items', 'stock_reservations', 'purchase_receipts'];
async function fingerprint() {
  const result = {};
  for (const table of [...preserved, ...written]) result[table] = (await db.query(`select count(*)::int count,md5(coalesce(string_agg(row_data::text,'' order by row_data::text),'')) hash from (select to_jsonb(t) row_data from public.${table} t) rows`)).rows[0];
  return result;
}
try {
  await db.connect();
  await db.query(apply ? 'begin' : 'begin isolation level repeatable read read only');
  await db.query("set local lock_timeout='5s'");
  if (apply) await db.query(`lock table ${[...preserved, ...written].map(t => `public.${t}`).join(',')} in share row exclusive mode`);
  const before = await fingerprint();
  if (written.some(t => before[t].count !== 0) || before.orders.count !== 0 || before.customers.count !== 0) throw new Error('New operations exist; review them instead of duplicating the opening purchases');
  const owner = (await db.query("select s.user_id from store_users s join auth.users u on u.id=s.user_id where lower(u.email)='natisfrutos@gmail.com' and s.active and s.role='owner'")).rows[0];
  if (!owner || before.store_users.count !== 2) throw new Error('Unexpected accounts');
  const products = (await db.query('select p.id,p.sku,p.name,p.active,f.current_cost_cents from products p join product_financials f on f.product_id=p.id')).rows;
  const purchases = shipments.map(shipment => ({ supplierName: 'Proveedor no informado', expectedAt: null, notes: shipment.notes,
    items: Object.entries(shipment.items).map(([sku, quantity]) => {
      const product = products.find(p => p.sku === sku && p.active);
      if (!product) throw new Error(`Missing product ${sku}`);
      return { productId: product.id, quantity, unitCostCents: Number(product.current_cost_cents) };
    })
  }));
  const physical = (await db.query('select sum(on_hand)::int total,sum(reserved)::int reserved from stock_balances')).rows[0];
  if (physical.total !== 49 || physical.reserved !== 0) throw new Error('Physical opening stock changed; review before loading');
  const plan = { project: SUPABASE_PROJECT_REF, createdAt: new Date().toISOString(), before, purchases, reserved, physical };
  if (!apply) {
    writeFileSync(planFile, JSON.stringify(plan, null, 2), { mode: 0o600 });
    await db.query('rollback');
    console.log(JSON.stringify({ preview: true, shipmentUnits: purchases.map(p => p.items.reduce((n,i) => n+i.quantity,0)), reservedUnits: 8, physicalUnitsUnchanged: 49, planFile }));
  } else {
    const preview = JSON.parse(readFileSync(planFile, 'utf8'));
    const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
    if (preview.project !== plan.project || JSON.stringify(preview.before) !== JSON.stringify(before) || JSON.stringify(preview.purchases) !== JSON.stringify(purchases)) throw new Error('State changed since preview');
    if (backup.project !== plan.project || new Date(backup.createdAt) < new Date(preview.createdAt)
      || Date.now()-new Date(backup.createdAt).getTime()>30*60*1000
      || createHash('sha256').update(readFileSync(`${backup.directory}/${backup.file}`)).digest('hex') !== backup.sha256) throw new Error('Fresh verified backup required');
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner.user_id]);
    const saved = [];
    for (const purchase of purchases) saved.push((await db.query('select create_purchase($1::jsonb) data', [JSON.stringify(purchase)])).rows[0].data);
    for (const [sku, quantity] of Object.entries(reserved)) {
      const product = products.find(p => p.sku === sku);
      const item = saved[0].items.find(i => i.productId === product.id);
      if (!item || quantity > item.quantity) throw new Error('Reservation does not fit the first shipment');
      await db.query(`insert into stock_reservations(product_id,quantity,source_type,purchase_item_id,cost_snapshot_cents,is_opening)
        values($1,$2,'incoming',$3,$4,true)`, [product.id,quantity,item.id,item.unitCostCents]);
    }
    await db.query('select private.bump_revision()');
    const after = await fingerprint();
    for (const table of preserved) if (JSON.stringify(before[table]) !== JSON.stringify(after[table])) throw new Error(`Protected data changed: ${table}`);
    if (after.purchases.count !== 2 || after.purchase_items.count !== 21 || after.stock_reservations.count !== 3) throw new Error('Unexpected loaded record counts');
    const inventory = (await db.query('select list_inventory_status() data')).rows[0].data;
    for (const product of products.filter(p => p.active)) {
      const row = inventory.find(i => i.id === product.id);
      const incoming = shipments.reduce((n,s) => n+(s.items[product.sku] ?? 0),0);
      if (row.incoming !== incoming || row.incomingReserved !== (reserved[product.sku] ?? 0)
        || row.projected !== row.available + incoming - (reserved[product.sku] ?? 0)) throw new Error(`Inventory mismatch: ${product.sku}`);
    }
    const openings = (await db.query('select list_opening_reservations() data')).rows[0].data;
    if (openings.reduce((sum,r) => sum+r.incomingQuantity,0) !== 8 || openings.some(r => r.physicalQuantity !== 0 || r.uncoveredQuantity !== 0)) throw new Error('Incorrect opening reserves');
    await db.query('commit');
    const result = { committedAt: new Date().toISOString(), protectedDataIdentical: true, before, after, backup,
      purchases: saved.map(p => ({ id:p.id,number:p.number,units:p.items.reduce((sum,i) => sum+i.quantity,0) })), openings,
      physical:49,incoming:145,incomingReserved:8,incomingFree:137,projectedFree:186 };
    writeFileSync('output/audit/real-incoming-result.json',JSON.stringify(result,null,2),{mode:0o600});
    console.log(JSON.stringify({ committed:true,purchases:result.purchases,physical:49,incoming:145,incomingReserved:8,projectedFree:186,protectedDataIdentical:true }));
  }
} catch(error) { await db.query('rollback').catch(() => {}); throw error; }
finally { await db.end(); }
