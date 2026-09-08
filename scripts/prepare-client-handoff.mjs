// One-time, explicitly authorized cleanup for the 2026-09-08 handoff.
// Defaults to a read-only preview. Never use against a store with real operations.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from 'vite';
import { SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

const apply = process.argv.includes('--apply-authorized-handoff');
const env = loadEnv('production', process.cwd(), '');
const expected = { owner: 'natisfrutos@gmail.com', staff: 'florgarciataverna@gmail.com' };
const removeEmails = ['juanpabloaltamira@protonmail.com', 'race-owner@test.local'];
const backupLog = 'output/audit/pre-handoff-backup.log';
if (apply) {
  const backup = JSON.parse(readFileSync(backupLog, 'utf8'));
  const file = `${backup.directory}/${backup.file}`;
  if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== backup.sha256) throw new Error('Verified backup required');
}
if (new URL(env.VITE_SUPABASE_URL).hostname !== `${SUPABASE_PROJECT_REF}.supabase.co`) throw new Error('Unexpected target');
const db = new Client({ host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`, port: 5432,
  user: `postgres.${SUPABASE_PROJECT_REF}`, database: 'postgres', password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 15000 });
const fingerprint = async () => (await db.query(`select
  md5(coalesce((select string_agg(to_jsonb(p)::text, '' order by id) from products p),'')) catalog,
  md5(coalesce((select string_agg((to_jsonb(f)-'updated_by'-'updated_at')::text, '' order by product_id) from product_financials f),'')) costs,
  md5(coalesce((select string_agg(to_jsonb(i)::text, '' order by id) from product_images i),'')) images,
  md5(coalesce((select string_agg((to_jsonb(s)-'updated_by'-'updated_at')::text, '' order by singleton_id) from store_settings s),'')) settings`)).rows[0];
let removedIds = [];
try {
  await db.connect();
  await db.query(apply ? 'begin' : 'begin read only');
  const users = (await db.query('select u.id,lower(u.email) email,s.role,s.active from auth.users u join store_users s on s.user_id=u.id order by email')).rows;
  const owner = users.find(u => u.email === expected.owner);
  const staff = users.find(u => u.email === expected.staff);
  if (!owner?.active || owner.role !== 'owner' || !staff?.active || staff.role !== 'staff' || users.some(u => ![...Object.values(expected), ...removeEmails].includes(u.email))) throw new Error('Unexpected account state');
  removedIds = users.filter(u => removeEmails.includes(u.email)).map(u => u.id);
  const counts = (await db.query('select (select count(*) from products)::int products,(select count(*) from orders)::int orders,(select count(*) from purchases)::int purchases')).rows[0];
  if (counts.products !== 28 || counts.orders !== 27 || counts.purchases !== 40) throw new Error('Commercial data changed since audit; review before cleanup');
  const before = await fingerprint();
  console.log(JSON.stringify({ preview: !apply, accountsToKeep: expected, accountsToRemove: users.filter(u => removedIds.includes(u.id)).map(u => u.email), counts, before,
    action: 'Remove fictitious orders, purchases, customers, movements and reservations; zero stock; preserve catalog, costs, images and settings' }));
  if (!apply) { await db.query('rollback'); }
  else {
    await db.query('lock table products,product_financials,product_images,store_settings,stock_balances,orders,purchases in share row exclusive mode');
    const lockedFingerprint = await fingerprint();
    if (JSON.stringify(before)!==JSON.stringify(lockedFingerprint)) throw new Error('Catalog changed before lock');
    for (const table of ['purchase_receipts','stock_movements','stock_reservations','order_items','orders','purchase_items','purchases','customers']) await db.query(`delete from public.${table}`);
    await db.query('update stock_balances set on_hand=0,reserved=0,updated_at=now()');
    await db.query('update product_financials set updated_by=null where updated_by=any($1::uuid[])',[removedIds]);
    await db.query('update store_settings set updated_by=null where updated_by=any($1::uuid[])',[removedIds]);
    // Preserve official IPC values; transfer stewardship if these rows have old account references.
    await db.query('update inflation_indices set created_by=$2 where created_by=any($1::uuid[])',[removedIds,owner.id]);
    await db.query('update inflation_indices set updated_by=$2 where updated_by=any($1::uuid[])',[removedIds,owner.id]);
    await db.query('update store_users set active=false where user_id=any($1::uuid[])',[removedIds]);
    await db.query('select private.bump_revision()');
    const after = await fingerprint();
    if (JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Protected commercial data changed; rolling back');
    await db.query('commit');
    console.log(JSON.stringify({ cleanupCommitted: true, protectedDataIdentical: true, after }));
  }
} catch(error) { await db.query('rollback').catch(()=>{}); throw error; }
finally { await db.end(); }
if (apply) {
  const keys = JSON.parse(execFileSync('pnpm',['exec','supabase','projects','api-keys','--project-ref',SUPABASE_PROJECT_REF,'--output','json'], { encoding:'utf8',stdio:['ignore','pipe','pipe'] }));
  const admin = createClient(`https://${SUPABASE_PROJECT_REF}.supabase.co`,keys.find(k=>k.name==='service_role').api_key,{auth:{persistSession:false,autoRefreshToken:false}});
  for (const id of removedIds) {
    const {error} = await admin.auth.admin.deleteUser(id);
    if (error) throw new Error(`Account removal failed (${error.status}); account remains disabled`);
  }
  console.log(JSON.stringify({ obsoleteAccountsDeleted: removedIds.length }));
}
