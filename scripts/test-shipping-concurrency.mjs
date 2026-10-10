// Independent PostgreSQL connections; fixtures stay in a marked disposable DB.
// SHIPPING_AUDIT_DATABASE must be an empty clone of the fully migrated test DB.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { guard, sql, database, container } from './test-shipping-local.mjs';

guard();
assert.equal(sql('select count(*) from public.orders;').trim(), '0');
assert.equal(sql('select count(*) from public.products;').trim(), '0');
const owner = '00000000-0000-4000-8000-000000102001';
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const auth = `select set_config('request.jwt.claim.sub',${q(owner)},false); set statement_timeout='8s';`;
sql(`insert into auth.users(id,email) values(${q(owner)},'race-shipping@test.local') on conflict(id) do nothing;
update public.store_users set role='owner',active=true where user_id=${q(owner)};`);
const execute = command => sql(auth + command);
const json = output => JSON.parse(output.split('\n').find(line => line.startsWith('{')));

function connection(command, label) {
  const child = spawn('docker', ['exec','-i','-e',`PGAPPNAME=${label}`,container,'psql','-X','-At','-U','supabase_admin','-d',database,'-v','ON_ERROR_STOP=1']);
  let output = '', error = '', resolveReady, rejectReady;
  const ready = new Promise((resolve,reject) => {resolveReady=resolve;rejectReady=reject;});
  ready.catch(() => {});
  child.stdout.on('data', chunk => { output+=chunk; if(output.includes('FIRST_APPLIED')) resolveReady(); });
  child.stderr.on('data', chunk => { error+=chunk; });
  const done = new Promise((resolve,reject) => {
    child.on('error',reject);
    child.on('close',code => {if(!output.includes('FIRST_APPLIED')) rejectReady(Error(error || 'First operation failed'));resolve({code,output,error});});
  });
  child.stdin.end(auth + command);
  return {ready,done};
}
let races = 0;
async function race(firstCommand, secondCommand) {
  const label = `shipping-race-${++races}`;
  const first = connection(`begin; ${firstCommand} select 'FIRST_APPLIED'; select pg_sleep(1); commit;`,label+'-a');
  await first.ready;
  const second = connection(`begin; ${secondCommand} commit;`,label+'-b');
  let blocked=false;
  for(let i=0;i<10 && !blocked;i++) {
    blocked=sql(`select exists(select 1 from pg_stat_activity where application_name=${q(label+'-b')} and wait_event_type='Lock');`).trim()==='t';
    if(!blocked) await new Promise(resolve=>setTimeout(resolve,25));
  }
  const [a,b]=await Promise.all([first.done,second.done]);
  assert.equal(a.code,0,a.error);
  assert.equal(blocked,true,'Second connection must overlap and wait on a real PostgreSQL lock');
  assert.doesNotMatch(b.error,/deadlock|timeout/i);
  return [a,b];
}
function fixture(index, quantity=4) {
  const product=json(execute(`select public.save_product(${q(JSON.stringify({sku:`RACE_SHIP_${index}`,slug:`race-ship-${index}`,name:`Carrera ${index}`,presentation:'1 unidad',description:'Fixture aislado',category:'QA',priceCents:150000,currentCostCents:100000,reorderPoint:0,safetyStock:0,leadTimeDays:1,imageUrl:'/test.svg',imageAlt:'Producto QA',featured:false,published:true,active:true}))}::jsonb);`));
  execute(`select public.adjust_product_stock(${q(product.id)},2,'Fixture aislado');`);
  const purchase=json(execute(`select public.create_purchase(${q(JSON.stringify({supplierName:'QA',items:[{productId:product.id,quantity,unitCostCents:107000}]}))}::jsonb);`));
  return {product,purchase};
}
const createCommand = (f,protocol=randomUUID()) => `select public.confirm_imported_order(${q(JSON.stringify({stockSource:'incoming_only',customerName:'Cliente QA',paymentMethod:'cash',deliveryMethod:'pickup',shippingFeeCents:0,quotedSubtotalCents:150000,quotedTotalCents:150000,protocolOrderId:protocol,protocolChecksum:'1234ABCD',lines:[{productId:f.product.id,quantity:1,unitPriceCents:150000}]}))}::jsonb);`;
const feeCommand=(order,op=randomUUID(),amount=1250000,revision=0) => `select public.save_order_shipping_fee(${q(JSON.stringify({orderId:order.id,operationId:op,expectedRevision:revision,method:'manual',amountCents:amount}))}::jsonb);`;
const payCommand=order => `select public.transition_order_checked(${q(order.id)},'mark_paid',0,150000,107000);`;
const receiptCommand=(f,op=randomUUID(),fee=1500000,quantity=1) => `select public.receive_purchase(${q(f.purchase.id)},${q(JSON.stringify([{purchaseItemId:f.purchase.items[0].id,receivedQuantity:quantity}]))}::jsonb,${q(op)},${fee});`;
const fail=(r,message) => {assert.notEqual(r.code,0);assert.ok(r.error.includes(message),r.error);};
const count = query => Number(sql(query).trim());

const f0=fixture(0,1);
let [,r]=await race(createCommand(f0),createCommand(f0));
fail(r,'INSUFFICIENT_INCOMING_STOCK');
assert.equal(count(`select reserved from public.stock_balances where product_id=${q(f0.product.id)};`),0);
assert.equal(count(`select sum(quantity) from public.stock_reservations where product_id=${q(f0.product.id)};`),1);
console.log('PASS last inbound unit: one winner, physical units untouched');

const f1=fixture(1),o1=json(execute(createCommand(f1))),op1=randomUUID();
const [a1,b1]=await race(feeCommand(o1,op1),feeCommand(o1,op1));
assert.equal(b1.code,0,b1.error);assert.deepEqual(json(a1.output),json(b1.output));
assert.equal(count(`select count(*) from public.order_shipping_fee_events where order_id=${q(o1.id)};`),1);
console.log('PASS same customer fee operation: one revision and one audit event');

const f2=fixture(2),o2=json(execute(createCommand(f2)));
[,r]=await race(feeCommand(o2),feeCommand(o2));fail(r,'SHIPPING_FEE_CHANGED');
assert.equal(count(`select shipping_fee_revision from public.orders where id=${q(o2.id)};`),1);
console.log('PASS different customer fee operations: stale edit rejected');

const f3=fixture(3),o3=json(execute(createCommand(f3)));
[,r]=await race(feeCommand(o3),payCommand(o3));fail(r,'ORDER_PAYMENT_AMOUNT_CHANGED');
assert.equal(sql(`select payment_state from public.orders where id=${q(o3.id)};`).trim(),'pending');
console.log('PASS fee wins before cobro: stale reviewed amount cannot be collected');

const f4=fixture(4),o4=json(execute(createCommand(f4)));
[,r]=await race(payCommand(o4),feeCommand(o4));fail(r,'SHIPPING_FEE_LOCKED');
assert.equal(count(`select shipping_fee_cents from public.orders where id=${q(o4.id)};`),0);
console.log('PASS cobro wins before fee: paid amount remains immutable');

const f5=fixture(5),op5=randomUUID();
const [a5,b5]=await race(receiptCommand(f5,op5),receiptCommand(f5,op5));
assert.equal(b5.code,0,b5.error);assert.deepEqual(json(a5.output),json(b5.output));
assert.equal(count(`select count(*) from public.misc_expenses where purchase_receipt_operation_id=${q(op5)};`),1);
assert.equal(count(`select on_hand from public.stock_balances where product_id=${q(f5.product.id)};`),3);
console.log('PASS same supplier receipt: one stock increment and one expense');

const f6=fixture(6),op6=randomUUID();
[,r]=await race(receiptCommand(f6,op6),receiptCommand(f6,op6,100));fail(r,'IDEMPOTENCY_KEY_REUSE_MISMATCH');
assert.equal(count(`select amount_cents from public.misc_expenses where purchase_receipt_operation_id=${q(op6)};`),1500000);
console.log('PASS supplier receipt retry cannot change the shipping charge');

const f7=fixture(7),f8=fixture(8),op7=randomUUID();
[,r]=await race(receiptCommand(f7,op7),receiptCommand(f8,op7));fail(r,'IDEMPOTENCY_KEY_REUSE_MISMATCH');
assert.equal(count(`select on_hand from public.stock_balances where product_id=${q(f8.product.id)};`),2);
console.log('PASS reused receipt operation across purchases: second purchase untouched');

const f9=fixture(9,1);
[,r]=await race(receiptCommand(f9),receiptCommand(f9));fail(r,'INVALID_PURCHASE_STATE');
assert.equal(count(`select on_hand from public.stock_balances where product_id=${q(f9.product.id)};`),3);
assert.equal(count(`select count(*) from public.misc_expenses e join public.purchase_receipts r on r.operation_id=e.purchase_receipt_operation_id where r.purchase_id=${q(f9.purchase.id)};`),1);
assert.equal(count('select count(*) from public.misc_expenses e left join public.purchase_receipts r on r.operation_id=e.purchase_receipt_operation_id where r.operation_id is null;'),0);
console.log('PASS competing full receipts: no extra units or orphan expenses');
console.log(`${races}/${races} scenarios passed in ${database}; all second connections were observed waiting on real locks.`);
