// Read-only release fingerprint: no row contents or credentials are printed.
import { Client } from 'pg';
import { loadEnv } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';
import { PROJECT_ROOT, SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

const mode = process.argv[2];
if (!['before', 'after'].includes(mode)) throw new Error('Expected before or after');
assertSupabaseTarget();
const env = loadEnv('production', PROJECT_ROOT, '');
const password = (process.env.SUPABASE_DB_PASSWORD || env.SUPABASE_DB_PASSWORD)?.trim();
if (!password) throw new Error('Missing read access');
const client = new Client({ host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`, port: 6543,
  database: 'postgres', user: `postgres.${SUPABASE_PROJECT_REF}`, password, ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000, options: '-c default_transaction_read_only=on -c statement_timeout=15000' });
const changedNames = new Set(['get_sales_analytics', 'ai_get_product_performance']);
const path = resolve(PROJECT_ROOT, 'output/audit/sales-release-before.json');
let connected = false;
try {
  await client.connect(); connected = true;
  await client.query('begin isolation level repeatable read read only');
  if ((await client.query("show transaction_read_only")).rows[0].transaction_read_only !== 'on') throw new Error('Read-only protection missing');
  const snapshot = { at: new Date().toISOString(), tables: {}, functions: [], triggers: [] };
  const tables = (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
  for (const { tablename } of tables) {
    const identifier = '"' + tablename.replaceAll('"', '""') + '"';
    snapshot.tables[tablename] = (await client.query(`select count(*)::text as count,
      md5(coalesce(string_agg(h,'' order by h),'')) as hash from (select md5(row_to_json(t)::text) as h from public.${identifier} t) rows`)).rows[0];
  }
  snapshot.functions = (await client.query(`select p.proname as name,p.oid::regprocedure::text as signature,
    md5(p.prosrc) as body,p.proowner::regrole::text as owner,p.proacl::text as acl,
    p.proconfig,p.provolatile,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') order by n.nspname,p.oid::regprocedure::text`)).rows;
  snapshot.triggers = (await client.query(`select pg_get_triggerdef(t.oid) as definition
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`)).rows;
  await client.query('rollback');
  mkdirSync(resolve(PROJECT_ROOT, 'output/audit'), { recursive: true });
  if (mode === 'before') {
    if (snapshot.functions.filter(f=>changedNames.has(f.name)).length !== 2) throw new Error('Unexpected reporting signatures');
    writeFileSync(path, JSON.stringify(snapshot,null,2));
    console.log(JSON.stringify({ readOnly: true, baselineSaved: true, tables: tables.length, functions: snapshot.functions.length }));
  } else {
    const before = JSON.parse(readFileSync(path,'utf8'));
    const changedTables = [...new Set([...Object.keys(before.tables),...Object.keys(snapshot.tables)])]
      .filter(name=>JSON.stringify(before.tables[name])!==JSON.stringify(snapshot.tables[name]));
    const strip = functions => functions.map(f=>changedNames.has(f.name)?{...f,body:'AUDITED_REPORTING_CHANGE'}:f);
    const otherFunctionsUnchanged = JSON.stringify(strip(before.functions)) === JSON.stringify(strip(snapshot.functions));
    const triggersUnchanged = JSON.stringify(before.triggers) === JSON.stringify(snapshot.triggers);
    const changedBodies = snapshot.functions.filter(f=>changedNames.has(f.name) && before.functions.find(b=>b.signature===f.signature)?.body!==f.body).map(f=>f.name);
    const report = { readOnly: true, at: snapshot.at, tables: tables.length, changedTables,
      otherFunctionsUnchanged, triggersUnchanged, changedBodies };
    writeFileSync(resolve(PROJECT_ROOT,'output/audit/sales-release-after.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    if (changedTables.length || !otherFunctionsUnchanged || !triggersUnchanged || changedBodies.length !== 2) process.exitCode=1;
  }
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: error.code ?? 'VERIFICATION_FAILED', detail: error.code ? 'Read-only query failed' : error.message }));
  process.exitCode=1;
} finally {
  if (connected) { try { await client.query('rollback'); } catch {} await client.end().catch(()=>{}); }
}
