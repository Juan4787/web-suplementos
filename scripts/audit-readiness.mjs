// Read-only release evidence. Never print credentials, customer rows or payment details.
import { Client } from 'pg';
import { loadEnv } from 'vite';
import { readdirSync } from 'node:fs';
import { SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION, WORKER_ORIGIN } from './project-targets.mjs';

const env = loadEnv('production', process.cwd(), '');
if (new URL(env.VITE_SUPABASE_URL).hostname !== `${SUPABASE_PROJECT_REF}.supabase.co`) {
  throw new Error('Unexpected supplements database target');
}
const db = new Client({
  host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`, port: 5432,
  database: 'postgres', user: `postgres.${SUPABASE_PROJECT_REF}`,
  password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000, statement_timeout: 15000,
  options: '-c default_transaction_read_only=on'
});
try {
  await db.connect();
  await db.query('begin read only');
  const applied = (await db.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(r => r.version);
  const local = readdirSync('supabase/migrations').filter(f => f.endsWith('.sql')).map(f => f.split('_')[0]);
  console.log(JSON.stringify({ migrations: { applied: applied.length, local: local.length, pending: local.filter(v => !applied.includes(v)) } }));
  for (const [label, sql] of Object.entries({
    counts: `select (select count(*) from products) products, (select count(*) from products where active and published) published_products,
      (select count(*) from orders) orders, (select count(*) from purchases) purchases,
      (select count(*) from customers) customers, (select count(*) from stock_movements) stock_movements,
      (select count(*) from stock_reservations) stock_reservations,
      (select count(*) from store_users) store_users,
      (select count(*) from store_users where active and role='owner') active_owners,
      (select count(*) from store_users where active and role='staff') active_staff`,
    configuration: `select char_length(store_name)>=2 store_name_present, whatsapp_phone ~ '^[0-9]{10,15}$' whatsapp_format_valid,
      char_length(transfer_alias)>0 transfer_alias_present, transfer_account ~ '^[0-9]{22}$' bank_account_format_valid,
      transfer_alias ~* 'ejemplo|demo|test|reemplazar' alias_looks_like_example,
      standard_shipping_cents>0 standard_shipping_nonzero, express_shipping_cents>0 express_shipping_nonzero,
      tax_rate_basis_points>=0 and tax_rate_basis_points<=10000 tax_in_range from store_settings`,
    stock: `select count(*) filter(where sb.on_hand<>0 or sb.reserved<>0) nonzero_balances,
      count(*) filter(where sb.reserved < 0 or sb.on_hand < sb.reserved) invalid_balances,
      count(*) filter(where sb.reserved <> coalesce((select sum(sr.quantity) from stock_reservations sr where sr.product_id=sb.product_id and sr.state='active' and sr.source_type='physical'),0)) reservation_mismatches
      from stock_balances sb`,
    security: `select count(*) filter(where not c.relrowsecurity) tables_without_rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`,
    auth: `select count(*) auth_users from auth.users`,
    protected_hashes: `select
      md5(coalesce((select string_agg(to_jsonb(p)::text, '' order by id) from products p),'')) catalog,
      md5(coalesce((select string_agg((to_jsonb(f)-'updated_by'-'updated_at')::text, '' order by product_id) from product_financials f),'')) costs,
      md5(coalesce((select string_agg(to_jsonb(i)::text, '' order by id) from product_images i),'')) images,
      md5(coalesce((select string_agg((to_jsonb(s)-'updated_by'-'updated_at')::text, '' order by singleton_id) from store_settings s),'')) settings`
  })) {
    await db.query('savepoint evidence');
    try { console.log(JSON.stringify({ [label]: (await db.query(sql)).rows })); }
    catch (error) { await db.query('rollback to savepoint evidence'); console.log(JSON.stringify({ [label]: { checkFailed: true, code: error.code } })); }
  }
  await db.query('rollback');
} finally { await db.end(); }
for (const path of ['/', '/app/pedidos', '/api/health']) {
  const response = await fetch(`${WORKER_ORIGIN}${path}`, { signal: AbortSignal.timeout(15000) });
  console.log(JSON.stringify({ http: { path, status: response.status, contentType: response.headers.get('content-type') } }));
}
