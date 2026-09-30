// This runner accepts only an empty, explicitly disposable local audit database.
// Fixtures are committed to allow independent PostgreSQL connections to see them.
// Drop that audit database after collecting the results; never use a linked project.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const database = process.env.SAFE_AUDIT_DATABASE;
assert.match(database ?? '', /^rigorous_ux_[a-z0-9_]+$/, 'Set SAFE_AUDIT_DATABASE to a disposable rigorous_ux_ database');
const owner = '00000000-0000-4000-8000-000000009941';
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const auth = `select set_config('request.jwt.claim.sub',${quote(owner)},false); set statement_timeout='8s';`;

function start(sql, label = 'safe-audit-reader') {
  const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${label}`, 'supabase_db_app-de-suplementos',
    'psql', '-X', '-tA', '-U', 'supabase_admin', '-d', database, '-v', 'ON_ERROR_STOP=1']);
  let output = '', error = '';
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Readers do not consume ready; avoid unhandled rejections if they fail.
  ready.catch(() => {});
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('FIRST_APPLIED')) resolveReady(); });
  child.stderr.on('data', chunk => { error += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { if (!output.includes('FIRST_APPLIED')) rejectReady(Error(error || 'First connection did not finish its operation'));
      resolve({ code, output, error }); });
  });
  child.stdin.end(sql);
  return { ready, done };
}
async function read(sql) {
  const result = await start(sql).done;
  assert.equal(result.code, 0, result.error);
  return result.output.trim();
}
const resultJson = result => JSON.parse(result.output.split('\n').find(line => line.startsWith('{')));

assert.equal(await read('select count(*) from public.products;'), '0', 'Audit database must start with no business data');
assert.equal(await read('select count(*) from public.orders;'), '0', 'Audit database must start with no orders');
await read(`insert into auth.users(id,email,raw_user_meta_data) values(${quote(owner)},'race-safe@test.local','{}');
update public.store_users set role='owner',active=true where user_id=${quote(owner)};`);

const fixtures = [];
for (let index = 0; index < 4; index++) {
  const product = {
    sku: `SAFE_RACE_${index}`, slug: `safe-race-${index}`, name: `Prueba concurrente ${index}`,
    presentation: '1 unidad', description: 'Datos descartables', category: 'Pruebas', priceCents: 100000,
    currentCostCents: 60000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1,
    imageUrl: '/test.svg', imageAlt: 'Prueba', published: true, active: true, featured: false
  };
  const p = resultJson(await start(auth + `select public.save_product(${quote(JSON.stringify(product))}::jsonb);`).done);
  const purchaseInput = { supplierName: 'Proveedor de prueba concurrente', items: [{ productId: p.id, quantity: 10, unitCostCents: 60000 }] };
  const purchase = resultJson(await start(auth + `select public.create_purchase(${quote(JSON.stringify(purchaseInput))}::jsonb);`).done);
  const item = purchase.items[0].id;
  await read(auth + `select public.receive_purchase(${quote(purchase.id)},${quote(JSON.stringify([{ purchaseItemId: item, receivedQuantity: 5 }]))}::jsonb,gen_random_uuid());`);
  fixtures.push({ product: p.id, purchase: purchase.id, item });
}

function replacement(fixture, operation) {
  return `select public.replace_purchase_shortage(${quote(fixture.item)},5,'Reposición concurrente',null,${quote(operation)});`;
}
function receipt(fixture) {
  return `select public.receive_purchase(${quote(fixture.purchase)},${quote(JSON.stringify([{purchaseItemId:fixture.item,receivedQuantity:5}]))}::jsonb,gen_random_uuid());`;
}
async function race(firstSql, secondSql, index) {
  const first = start(auth + `begin; ${firstSql} select 'FIRST_APPLIED'; select pg_sleep(1); commit;`, `safe-first-${index}`);
  await first.ready;
  const second = start(auth + `begin; ${secondSql} commit;`, `safe-second-${index}`);
  let blocked = false;
  for (let attempt = 0; attempt < 8 && !blocked; attempt++) {
    blocked = await read(`select exists(select 1 from pg_stat_activity where application_name='safe-second-${index}' and wait_event_type='Lock');`) === 't';
    if (!blocked) await new Promise(resolve => setTimeout(resolve, 30));
  }
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.equal(a.code, 0, a.error);
  assert.equal(blocked, true, 'The second connection must actually overlap and wait on a PostgreSQL lock');
  assert.doesNotMatch(b.error, /deadlock|timeout/i);
  return [a, b];
}
const op = '00000000-0000-4000-8000-000000009942';
const [a, b] = await race(replacement(fixtures[0], op), replacement(fixtures[0], op), 0);
assert.equal(b.code, 0, b.error);
assert.deepEqual(resultJson(a), resultJson(b));
assert.equal(await read(`select count(*) from private.purchase_shortage_operations where operation_id=${quote(op)};`), '1');
console.log('PASS: same operation, two overlapping connections, one replacement');

const [, other] = await race(replacement(fixtures[1], '00000000-0000-4000-8000-000000009943'), replacement(fixtures[1], '00000000-0000-4000-8000-000000009944'), 1);
assert.notEqual(other.code, 0);
assert.match(other.error, /PURCHASE_SHORTAGE_CHANGED/);
console.log('PASS: different operations, only one winner, no orphan purchase');

const [, stale] = await race(receipt(fixtures[2]), replacement(fixtures[2], '00000000-0000-4000-8000-000000009945'), 2);
assert.notEqual(stale.code, 0);
assert.match(stale.error, /PURCHASE_SHORTAGE_CHANGED/);
assert.equal(await read(`select on_hand from public.stock_balances where product_id=${quote(fixtures[2].product)};`), '10');
console.log('PASS: arrival wins, stale replacement refused, ten physical units');

const [, lateReceipt] = await race(replacement(fixtures[3], '00000000-0000-4000-8000-000000009946'), receipt(fixtures[3]), 3);
assert.notEqual(lateReceipt.code, 0);
assert.match(lateReceipt.error, /INVALID_PURCHASE_STATE/);
assert.equal(await read(`select on_hand from public.stock_balances where product_id=${quote(fixtures[3].product)};`), '5');
assert.equal(await read('select count(*) from public.purchases;'), '7');
assert.equal(await read('select count(*) from private.purchase_shortage_operations;'), '3');
console.log('PASS: replacement wins, stale arrival refused, stock conserved');
console.log(`4/4 concurrency scenarios passed in ${database}. Fixtures remain only in this disposable database.`);
