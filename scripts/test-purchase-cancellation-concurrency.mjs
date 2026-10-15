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
for (let index=0;index<7;index++) {
  const product=resultJson(await start(auth+`select public.save_product(${quote(JSON.stringify({sku:`CANCEL_RACE_${index}`,slug:`cancel-race-${index}`,name:`Cancelación QA ${index}`,presentation:'1 unidad',description:'Fixture aislado',category:'QA',priceCents:150000,currentCostCents:60000,reorderPoint:0,safetyStock:0,leadTimeDays:1,imageUrl:'/test.svg',imageAlt:'Producto QA',published:true,active:true,featured:false}))}::jsonb);`).done);
  const purchase=resultJson(await start(auth+`select public.create_purchase(${quote(JSON.stringify({supplierName:'Proveedor original QA',items:[{productId:product.id,quantity:5,unitCostCents:60000}]}))}::jsonb);`).done);
  const preview=resultJson(await start(auth+`select public.get_purchase_cancellation_preview(${quote(purchase.id)});`).done);
  fixtures.push({product,purchase,preview});
}
function cancel(f,op,replacement=null,token=f.preview.reviewToken){return `select public.cancel_purchase(${quote(f.purchase.id)},'Cancelación concurrente',${quote(op)},${quote(token)},${replacement?quote(JSON.stringify(replacement))+'::jsonb':'null'});`;}
function receive(f){return `select public.receive_purchase(${quote(f.purchase.id)},${quote(JSON.stringify([{purchaseItemId:f.purchase.items[0].id,receivedQuantity:1}]))}::jsonb,gen_random_uuid());`;}
function order(f){return `select public.confirm_imported_order(${quote(JSON.stringify({customerName:'Cliente concurrente QA',paymentMethod:'cash',deliveryMethod:'pickup',shippingFeeCents:0,quotedSubtotalCents:150000,quotedTotalCents:150000,lines:[{productId:f.product.id,quantity:1,unitPriceCents:150000}]}))}::jsonb);`;}
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

const op='00000000-0000-4000-8000-000000159901';
const [a,b]=await race(cancel(fixtures[0],op,{supplierName:'Reposición QA'}),cancel(fixtures[0],op,{supplierName:'Reposición QA'}),0);
assert.equal(b.code,0,b.error);assert.deepEqual(resultJson(a),resultJson(b));
console.log('PASS 1 same operation: one cancellation and one replacement');
const [,other]=await race(cancel(fixtures[1],crypto.randomUUID()),cancel(fixtures[1],crypto.randomUUID()),1);
assert.notEqual(other.code,0);assert.match(other.error,/PURCHASE_CANCELLATION_CHANGED/);
console.log('PASS 2 different operations: only one winner');
const [,stale]=await race(receive(fixtures[2]),cancel(fixtures[2],crypto.randomUUID()),2);
assert.notEqual(stale.code,0);assert.match(stale.error,/PURCHASE_CANCELLATION_CHANGED/);
assert.equal(await read(`select on_hand from public.stock_balances where product_id=${quote(fixtures[2].product.id)};`),'1');
console.log('PASS 3 receipt first: stale cancellation rejected and stock retained');
const [,late]=await race(cancel(fixtures[3],crypto.randomUUID()),receive(fixtures[3]),3);
assert.notEqual(late.code,0);assert.match(late.error,/INVALID_PURCHASE_STATE/);
console.log('PASS 4 cancellation first: old receipt rejected');
const [,newReservation]=await race(order(fixtures[4]),cancel(fixtures[4],crypto.randomUUID()),4);
assert.notEqual(newReservation.code,0);assert.match(newReservation.error,/PURCHASE_CANCELLATION_CHANGED/);
console.log('PASS 5 reservation first: no uncovered customer order');
const edit=`select public.update_purchase(${quote(JSON.stringify({id:fixtures[5].purchase.id,supplierName:'Proveedor editado QA',items:[{productId:fixtures[5].product.id,quantity:6,unitCostCents:60000}]}))}::jsonb);`;
const [,changed]=await race(edit,cancel(fixtures[5],crypto.randomUUID()),5);
assert.notEqual(changed.code,0);assert.match(changed.error,/PURCHASE_CANCELLATION_CHANGED/);
console.log('PASS 6 edit first: changed quantity invalidates cancellation');
const [,newOrder]=await race(cancel(fixtures[6],crypto.randomUUID(),{supplierName:'Reposición disponible'}),order(fixtures[6]),6);
assert.equal(newOrder.code,0,newOrder.error);
assert.equal(await read(`select count(*) from public.stock_reservations sr join public.purchase_items pi on pi.id=sr.purchase_item_id join public.purchases pu on pu.id=pi.purchase_id where sr.state='active' and sr.source_type='incoming' and pu.state<>'ordered';`),'0');
console.log('PASS 7 cancellation with replacement first: new order uses active capacity');
console.log('7/7 overlapping PostgreSQL races passed; no deadlocks, duplicated operations or closed-purchase reservations.');
