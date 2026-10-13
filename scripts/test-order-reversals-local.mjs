// Only the marked, disposable reversal DB. Never reads local credentials or
// connects to a linked project. Real overlapping PostgreSQL transactions.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { guard, sql, database, container } from './test-shipping-local.mjs';

assert.match(database, /^rigorous_ux_shipping_.*reversals_/);
guard();
assert.equal(sql('select count(*) from public.orders;').trim(), '0');
assert.equal(sql('select count(*) from public.products;').trim(), '0');
const tap = sql(readFileSync('supabase/tests/database/order_action_reversals.test.sql', 'utf8'));
assert.doesNotMatch(tap, /^not ok/m);
const plan = tap.match(/^1\.\.(\d+)$/m);
assert.ok(plan);
assert.equal([...tap.matchAll(/^ok \d+ /gm)].length, Number(plan[1]));
console.log(`PASS ${plan[1]} database assertions (fixtures rolled back)`);

const owner = '00000000-0000-4000-8000-000000132001';
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const auth = `select set_config('request.jwt.claim.sub',${q(owner)},false); set statement_timeout='10s';`;
sql(`insert into auth.users(id,email) values(${q(owner)},'race-reversals@test.local') on conflict(id) do nothing; update public.store_users set role='owner',active=true where user_id=${q(owner)};`);
const execute = command => sql(auth + command);
const json = output => JSON.parse(output.split('\n').find(line => line.startsWith('{')));
const count = query => Number(sql(query).trim());
function connection(command, label) {
  const child = spawn('docker', ['exec','-i','-e',`PGAPPNAME=${label}`,container,'psql','-X','-At','-U','supabase_admin','-d',database,'-v','ON_ERROR_STOP=1']);
  let output = '', error = '', readyResolve, readyReject;
  const ready = new Promise((resolve,reject) => {readyResolve=resolve;readyReject=reject;});
  ready.catch(() => {});
  child.stdout.on('data', chunk => {output+=chunk; if(output.includes('FIRST_APPLIED')) readyResolve();});
  child.stderr.on('data', chunk => {error+=chunk;});
  const done = new Promise((resolve,reject) => {
    child.on('error',reject);
    child.on('close',code => {if(!output.includes('FIRST_APPLIED')) readyReject(Error(error || 'First operation failed'));resolve({code,output,error});});
  });
  child.stdin.end(auth + command);
  return {ready,done};
}
let races = 0;
async function race(firstCommand, secondCommand) {
  const label = `reversal-race-${++races}`;
  const first = connection(`begin; ${firstCommand} select 'FIRST_APPLIED'; select pg_sleep(1); commit;`,label+'-a');
  await first.ready;
  const second = connection(`begin; ${secondCommand} commit;`,label+'-b');
  let blocked = false;
  for (let i=0; i<12 && !blocked; i++) {
    blocked = sql(`select exists(select 1 from pg_stat_activity where application_name=${q(label+'-b')} and wait_event_type='Lock');`).trim()==='t';
    if (!blocked) await new Promise(resolve=>setTimeout(resolve,25));
  }
  const [a,b] = await Promise.all([first.done,second.done]);
  assert.equal(a.code,0,a.error);
  assert.equal(blocked,true,'Second connection must overlap and wait on a real database lock');
  assert.doesNotMatch(b.error,/deadlock|timeout/i);
  return {a,b};
}
function fixture(index, product) {
  product ??= json(execute(`select public.save_product(${q(JSON.stringify({sku:`RACE_REV_${index}`,slug:`race-rev-${index}`,name:`Carrera ${index}`,presentation:'1 unidad',description:'Fixture aislado',category:'QA',priceCents:150000,currentCostCents:100000,reorderPoint:0,safetyStock:0,leadTimeDays:1,imageUrl:'/test.svg',imageAlt:'Producto QA',featured:false,published:true,active:true}))}::jsonb);`));
  execute(`select public.adjust_product_stock(${q(product.id)},4,'Fixture aislado');`);
  const order = json(execute(`select public.confirm_imported_order(${q(JSON.stringify({customerName:'Cliente Carreras',paymentMethod:'cash',deliveryMethod:'pickup',shippingFeeCents:0,quotedSubtotalCents:150000,quotedTotalCents:150000,protocolOrderId:randomUUID(),protocolChecksum:'1234ABCD',lines:[{productId:product.id,quantity:1,unitPriceCents:150000}]}))}::jsonb);`));
  execute(`select public.transition_order(${q(order.id)},'mark_paid'); select public.transition_order(${q(order.id)},'mark_delivered');`);
  return {product,order:json(execute(`select private.order_payload(${q(order.id)},true);`))};
}
const reverse = (f,action='reverse_delivery',operation=randomUUID(),revision=f.order.actionRevision) =>
  `select public.reverse_order_action(${q(f.order.id)},${q(action)},${q(operation)},${revision});`;
const balance = f => json(sql(`select jsonb_build_object('physical',on_hand,'reserved',reserved) from public.stock_balances where product_id=${q(f.product.id)};`));
const fails = (result,message) => {assert.notEqual(result.code,0);assert.ok(result.error.includes(message),result.error);};

const f0=fixture(0),op=randomUUID();
const r0=await race(reverse(f0,'reverse_delivery',op),reverse(f0,'reverse_delivery',op));
assert.equal(r0.b.code,0,r0.b.error);
assert.deepEqual(balance(f0),{physical:4,reserved:1});
assert.equal(count(`select count(*) from public.order_action_reversals where order_id=${q(f0.order.id)};`),1);
console.log('PASS identical simultaneous reversal: one stock return, one reservation, one history event');

const f1=fixture(1);
const r1=await race(reverse(f1),reverse(f1));
fails(r1.b,'ORDER_ACTION_CHANGED');
assert.deepEqual(balance(f1),{physical:4,reserved:1});
console.log('PASS competing delivery reversals: stale second action rejected without duplicate stock');

const f2=fixture(2);
const r2=await race(reverse(f2),`select public.transition_order_reviewed(${q(f2.order.id)},'mark_delivered',${f2.order.actionRevision});`);
fails(r2.b,'ORDER_ACTION_CHANGED');
assert.deepEqual(balance(f2),{physical:4,reserved:1});
console.log('PASS stale delivery screen cannot repeat a corrected exit');

const f3=fixture(3);
const r3=await race(reverse(f3,'reverse_payment'),reverse(f3,'reverse_delivery'));
fails(r3.b,'ORDER_ACTION_CHANGED');
assert.deepEqual(balance(f3),{physical:3,reserved:0});
console.log('PASS simultaneous payment and delivery corrections require review of the new state');

const f4=fixture(4);
execute(reverse(f4));
const pending=json(execute(`select private.order_payload(${q(f4.order.id)},true);`));
const r4=await race(reverse({...f4,order:pending},'reverse_payment'),`select public.transition_order_reviewed(${q(f4.order.id)},'cancel',${pending.actionRevision});`);
fails(r4.b,'ORDER_ACTION_CHANGED');
assert.deepEqual(balance(f4),{physical:4,reserved:1});
console.log('PASS stale cancellation screen cannot cancel after an intervening correction');

const f5=fixture(5),f6=fixture(6),sameKey=randomUUID();
const r5=await race(reverse(f5,'reverse_delivery',sameKey),reverse(f6,'reverse_delivery',sameKey));
fails(r5.b,'IDEMPOTENCY_KEY_REUSE_MISMATCH');
assert.deepEqual(balance(f6),{physical:3,reserved:0});
console.log('PASS operation key reused across orders: second order untouched');

const f7=fixture(7),f8=fixture(8,f7.product);
const r6=await race(reverse(f7),reverse(f8));
assert.equal(r6.b.code,0,r6.b.error);
assert.deepEqual(balance(f7),{physical:8,reserved:2});
assert.equal(count(`select count(*) from public.stock_balances sb where sb.on_hand < sb.reserved or sb.reserved <> (select coalesce(sum(sr.quantity),0) from public.stock_reservations sr where sr.product_id=sb.product_id and sr.state='active' and sr.source_type='physical');`),0);
console.log(`PASS ${races}/${races} real overlapping transaction scenarios; ledger and active reservations reconcile`);
