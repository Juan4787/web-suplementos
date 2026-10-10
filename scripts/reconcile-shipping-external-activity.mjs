// Reconcile legitimate pending-order activity predating the migration command.
// Both production and the restored backup are read-only. Never repairs data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { loadEnv } from 'vite';
import { Client } from 'pg';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';
import { PROJECT_ROOT, SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

assertSupabaseTarget();
const before = JSON.parse(readFileSync('output/audit/shipping-release-before.json', 'utf8'));
const backup = JSON.parse(readFileSync('output/audit/shipping-backup-restoration.json', 'utf8'));
assert.equal(backup.dataMatches, true);
assert.equal(backup.database, 'backup_restore_shipping_certified_20261010');
const migrationStartedAt = statSync('/tmp/supplements-shipping-migrations-published-20261010.log').birthtime.toISOString();
const env = loadEnv('production', PROJECT_ROOT, '');
const db = new Client({ host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`, port: 6543,
  database: 'postgres', user: `postgres.${SUPABASE_PROJECT_REF}`, password: env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000,
  options: '-c default_transaction_read_only=on -c statement_timeout=20000' });
const identifier = name => '"' + name.replaceAll('"', '""') + '"';
const addedFields = { orders: ['stock_source', 'shipping_fee_method', 'shipping_fee_basis_points', 'shipping_fee_cost_base_cents', 'shipping_fee_revision'],
  purchase_receipts: ['shipping_cost_cents', 'shipping_expense_id'], misc_expenses: ['purchase_receipt_operation_id'] };
const deltas = {}, fingerprints = {}, historicalChanges = [];
await db.connect();
try {
  await db.query('begin isolation level repeatable read read only');
  for (const name of Object.keys(before.tables)) {
    const remote = (await db.query(`select to_jsonb(t)-$1::text[] as row from public.${identifier(name)} t`, [addedFields[name] ?? []])).rows.map(r => r.row);
    const oldRows = JSON.parse(execFileSync('docker', ['exec', 'supabase_db_app-de-suplementos', 'psql', '-X', '-U', 'supabase_admin',
      '-d', backup.database, '-At', '-c', `begin read only;select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.${identifier(name)} t;rollback;`],
      { encoding: 'utf8', timeout: 30000 }).split('\n').find(line => line.startsWith('[')));
    const key = name === 'stock_balances' ? 'product_id' : name === 'business_state' ? 'singleton_id' : name === 'store_users' ? 'user_id' : 'id';
    // Tables lacking a unique id must remain byte-for-byte equal as multisets.
    if (oldRows.some(row => row[key] === undefined)) {
      assert.deepEqual(remote.map(JSON.stringify).sort(), oldRows.map(JSON.stringify).sort(), name + ' must remain unchanged');
      deltas[name] = { added: [], changed: [] };
    } else {
      const old = new Map(oldRows.map(row => [row[key], row]));
      const current = new Map(remote.map(row => [row[key], row]));
      assert.equal(old.size, oldRows.length); assert.equal(current.size, remote.length);
      assert.ok(oldRows.every(row => current.has(row[key])), 'No existing row may disappear: ' + name);
      const changed = remote.filter(row => old.has(row[key]) && JSON.stringify(row) !== JSON.stringify(old.get(row[key])))
        .map(row => ({ old: old.get(row[key]), current: row }));
      deltas[name] = { added: remote.filter(row => !old.has(row[key])), changed };
      if (changed.length && !['stock_balances', 'business_state'].includes(name)) historicalChanges.push(name);
    }
    fingerprints[name] = (await db.query(`select count(*)::text as count,md5(coalesce(string_agg(h,'' order by h),'')) as hash
      from (select md5((to_jsonb(t)-$1::text[])::text) as h from public.${identifier(name)} t) rows`, [addedFields[name] ?? []])).rows[0];
  }
  assert.deepEqual(historicalChanges, [], 'Existing business rows must remain unchanged');
  const allowedAdded = new Set(['orders', 'customers', 'order_items', 'stock_reservations', 'stock_movements']);
  for (const [name, delta] of Object.entries(deltas)) if (!allowedAdded.has(name)) assert.equal(delta.added.length, 0, 'Unexpected new row: ' + name);
  const orders = deltas.orders.added; assert.ok(orders.length > 0);
  const orderIds = new Set(orders.map(order => order.id));
  for (const order of orders) {
    assert.equal(order.payment_state, 'pending'); assert.equal(order.order_state, 'confirmed');
    assert.equal(order.sale_type, 'retail'); assert.equal(order.source, 'whatsapp_import');
    assert.ok(Date.parse(order.created_at) > Date.parse(before.at) && Date.parse(order.created_at) < Date.parse(migrationStartedAt));
  }
  assert.ok(deltas.customers.added.every(customer => orders.some(order => order.customer_id === customer.id)));
  for (const name of ['order_items', 'stock_reservations', 'stock_movements']) assert.ok(deltas[name].added.every(row => orderIds.has(row.order_id)));
  const reservations = deltas.stock_reservations.added, movements = deltas.stock_movements.added;
  assert.ok(reservations.every(row => row.state === 'active' && row.source_type === 'physical'));
  assert.ok(movements.every(row => row.kind === 'reservation' && row.physical_delta === 0));
  for (const item of deltas.order_items.added) assert.equal(reservations.filter(row => row.order_item_id === item.id && row.product_id === item.product_id).reduce((n, row) => n + row.quantity, 0), item.quantity);
  for (const { old, current } of deltas.stock_balances.changed) {
    assert.deepEqual(Object.keys(current).filter(key => JSON.stringify(current[key]) !== JSON.stringify(old[key])).sort(), ['reserved', 'updated_at']);
    assert.equal(current.reserved - old.reserved, movements.filter(row => row.product_id === current.product_id).reduce((n, row) => n + row.reserved_delta, 0));
    assert.equal(current.reserved - old.reserved, reservations.filter(row => row.product_id === current.product_id).reduce((n, row) => n + row.quantity, 0));
  }
  assert.ok(reservations.every(row => deltas.stock_balances.changed.some(change => change.current.product_id === row.product_id)));
  for (const { old, current } of deltas.business_state.changed) {
    assert.deepEqual(Object.keys(current).filter(key => JSON.stringify(current[key]) !== JSON.stringify(old[key])).sort(), ['revision', 'updated_at']);
    assert.ok(BigInt(current.revision) > BigInt(old.revision));
  }
  const evidence = { environment: 'production-read-only-reconciliation', baselineAt: before.at, migrationStartedAt,
    verified: true, orders: orders.map(order => ({ number: order.order_number, createdAt: order.created_at, source: order.source })),
    newRows: Object.fromEntries(Object.entries(deltas).filter(([, delta]) => delta.added.length).map(([name, delta]) => [name, delta.added.length])),
    preservedHistoricalTables: Object.keys(before.tables).length, fingerprints };
  writeFileSync('output/audit/shipping-external-activity.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ environment: evidence.environment, verified: true, orders: evidence.orders,
    newRows: evidence.newRows, historicalRowsModified: 0, physicalUnitsChanged: 0 }));
} finally { await db.query('rollback').catch(() => {}); await db.end(); }
