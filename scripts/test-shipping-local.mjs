// No credentials or linked Supabase project. Only a marked disposable local DB.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export const database = process.env.SHIPPING_AUDIT_DATABASE ?? 'rigorous_ux_shipping_20261010';
export const container = 'supabase_db_app-de-suplementos';
assert.match(database, /^rigorous_ux_shipping_[a-z0-9_]+$/);
export const sql = (input) => { try { return execFileSync('docker', ['exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=840000 -c jit=off', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', database, '-At'],
  { input, encoding: 'utf8', timeout: 900000, maxBuffer: 16000000 }); } catch (error) { throw new Error(error.stderr?.toString().slice(-1600) || 'Isolated SQL execution failed'); } };
export function guard() {
  const metadata = JSON.parse(execFileSync('docker', ['inspect', container], {encoding: 'utf8'}))[0];
  assert.equal(metadata.Name, '/' + container);
  assert.equal(sql("begin read only; select current_database() || ':' || task from staging_guard.identity; rollback;").trim().split('\n').find(s => s.startsWith(database)), database + ':shipping-20261010');
}

export function runFile(file) {
  const output = sql(readFileSync(resolve(file), 'utf8'));
  mkdirSync('output/audit', {recursive: true});
  writeFileSync(resolve('output/audit', file.split('/').at(-1) + '.log'), output);
  if (/^not ok /m.test(output)) { console.error(output.split('\n').filter(line => /^(not ok |#)/.test(line)).join('\n')); throw new Error(file + ' has failing assertions'); }
  const plans = [...output.matchAll(/^1\.\.(\d+)$/gm)];
  assert.equal(plans.length, 1, file + ' must complete exactly one TAP plan');
  assert.equal([...output.matchAll(/^ok \d+ /gm)].length, Number(plans[0][1]), file + ' must complete every planned assertion');
  console.log(output.split('\n').filter(line => /^(ok |not ok |1\.\.|# Looks)/.test(line)).join('\n'));
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/test-shipping-local.mjs')) {
  guard();
  const mode = process.argv[2] ?? 'test';
  if (mode === 'migrate') {
    assert.equal(sql('select count(*) from public.orders;').trim(), '0', 'Migrate only a fresh disposable database');
    for (const file of ['20260929210000_checked_stock_thresholds.sql','20260929220000_safe_purchase_resolution.sql','20261001120000_sales_analytics_full_period.sql','20261010010000_incoming_orders_and_shipping.sql','20261010020000_shipping_financial_reports.sql']) {
      sql('begin;\n' + readFileSync('supabase/migrations/' + file, 'utf8') + '\ncommit;');
      console.log('Applied locally: ' + file);
    }
  } else if (mode === 'refresh') {
    const source = readFileSync('supabase/migrations/20261010010000_incoming_orders_and_shipping.sql','utf8');
    const functions = source.match(/create or replace function[\s\S]*?\$\$;/gi) ?? [];
    const grants = source.split('\n').filter(line => /^(revoke all on function|grant execute on function)/.test(line));
    sql('begin;\n' + functions.join('\n') + '\n' + grants.join('\n') + '\ncommit;');
    console.log('Refreshed functions only in marked disposable database.');
  } else if (mode === 'test') {
    runFile('supabase/tests/database/incoming_orders_shipping.test.sql');
  } else throw Error('Unknown test mode');
}
