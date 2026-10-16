// Disposable local database only. No environment credentials or remote connection.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const database=process.env.SAFE_AUDIT_DATABASE;
assert.match(database??'',/^rigorous_ux_stock_origin_[a-z0-9_]+$/);
const container='supabase_db_app-de-suplementos';
const args=['exec','-i',container,'psql','-X','-At','-U','supabase_admin','-d',database,'-v','ON_ERROR_STOP=1'];
const sql=input=>execFileSync('docker',args,{input,encoding:'utf8',timeout:30000,maxBuffer:1000000});
assert.equal(sql('select task from staging_guard.identity').trim(),'shipping-20261010');
assert.equal(sql('select count(*) from orders').trim(),'0');
assert.equal(sql('select count(*) from products').trim(),'0');
const owner='00000000-0000-4000-8000-000000161001';
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const auth=`select set_config('request.jwt.claim.sub',${q(owner)},false); set statement_timeout='15s';`;
sql(`insert into auth.users(id,email) values(${q(owner)},'origin-races@test.local') on conflict(id) do nothing; update store_users set role='owner',active=true where user_id=${q(owner)};`);
const execute=input=>sql(auth+input);
const json=input=>JSON.parse(execute(input).split('\n').find(line=>line.startsWith('{')));
function connection(command,label){
  const child=spawn('docker',args);let output='',error='',readyResolve,readyReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
  child.stdout.on('data',data=>{output+=data;if(output.includes('FIRST_APPLIED'))readyResolve();});
  child.stderr.on('data',data=>{error+=data;});
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{if(!output.includes('FIRST_APPLIED'))readyReject(Error(error));resolve({code,output,error});});});
  child.stdin.end(auth+`set application_name=${q(label)};`+command);return{ready,done};
}
async function race(firstSql,secondSql,index){
  const first=connection(`begin;${firstSql} select 'FIRST_APPLIED';select pg_sleep(1);commit;`,`origin-${index}-a`);
  await first.ready;
  const second=connection(`begin;${secondSql}commit;`,`origin-${index}-b`);
  let blocked=false;
  for(let attempt=0;attempt<12&&!blocked;attempt++){
    blocked=sql(`select exists(select 1 from pg_stat_activity where application_name=${q(`origin-${index}-b`)} and wait_event_type='Lock');`).trim()==='t';
    if(!blocked)await new Promise(resolve=>setTimeout(resolve,25));
  }
  const results=await Promise.all([first.done,second.done]);
  for(const result of results){assert.equal(result.code,0,result.error);assert.doesNotMatch(result.error,/deadlock|timeout/i);}
  // Actual overlap is also proven by the blocked transaction's wait event.
  assert.equal(blocked,true,'Second transaction must wait on the first transaction lock');
}
function fixture(index){
  const product=json(`select save_product(${q(JSON.stringify({sku:`ORIGIN_RACE_${index}`,slug:`origin-race-${index}`,name:'Comprobación de recepción',presentation:'1 unidad',description:'Base aislada',category:'Pruebas',priceCents:150000,currentCostCents:100000,reorderPoint:0,safetyStock:0,leadTimeDays:1,imageUrl:'/test.svg',imageAlt:'Prueba',active:true,published:true,featured:false}))}::jsonb)`);
  execute(`select adjust_product_stock(${q(product.id)},4,'Conteo inicial');`);
  const purchase=json(`select create_purchase(${q(JSON.stringify({supplierName:'Proveedor asignado',items:[{productId:product.id,quantity:5,unitCostCents:100000}]}))}::jsonb)`);
  const order=json(`select confirm_imported_order(${q(JSON.stringify({stockSource:'incoming_only',customerName:'Cliente aislado',paymentMethod:'cash',deliveryMethod:'pickup',shippingFeeCents:0,quotedSubtotalCents:450000,quotedTotalCents:450000,protocolOrderId:randomUUID(),protocolChecksum:'1234ABCD',lines:[{productId:product.id,quantity:3,unitPriceCents:150000}]}))}::jsonb)`);
  return{product,purchase,order};
}
const receive=(f,op)=>`select receive_purchase(${q(f.purchase.id)},${q(JSON.stringify([{purchaseItemId:f.purchase.items[0].id,receivedQuantity:1}]))}::jsonb,${q(op)});`;
const result=f=>json(`select jsonb_build_object('onHand',sb.on_hand,'reserved',sb.reserved,'free',sb.on_hand-sb.reserved,'incoming',(select sum(quantity) from stock_reservations where order_id=${q(f.order.id)} and state='active' and source_type='incoming'),'receipts',(select count(*) from purchase_receipts where purchase_id=${q(f.purchase.id)})) from stock_balances sb where product_id=${q(f.product.id)}`);
const a=fixture(1);await race(receive(a,randomUUID()),`select adjust_product_stock(${q(a.product.id)},1,'Conteo simultaneo');`,1);
assert.deepEqual(result(a),{onHand:6,reserved:1,free:5,incoming:2,receipts:1});
console.log('PASS receipt and stock count overlap without consuming previous free stock');
const b=fixture(2);await race(receive(b,randomUUID()),receive(b,randomUUID()),2);
assert.deepEqual(result(b),{onHand:6,reserved:2,free:4,incoming:1,receipts:2});
console.log('PASS two distinct receipts allocate exactly their two received units');
const c=fixture(3),operation=randomUUID();await race(receive(c,operation),receive(c,operation),3);
assert.deepEqual(result(c),{onHand:5,reserved:1,free:4,incoming:2,receipts:1});
console.log('PASS simultaneous identical retry preserves one receipt and one allocation');
assert.equal(sql('select count(*) from stock_balances sb where reserved<>(select coalesce(sum(quantity),0) from stock_reservations where product_id=sb.product_id and state=\'active\' and source_type=\'physical\')').trim(),'0');
// Receiving B serves an older normal order from A and rebinds B's promise to A.
// A simultaneous receipt must observe that rebinding after the product lock.
const d=fixture(4);
execute(`select transition_order(${q(d.order.id)},'cancel');select adjust_product_stock(${q(d.product.id)},-4,'Stock agotado');`);
const pendingOrder=(source,qty)=>json(`select confirm_imported_order(${q(JSON.stringify({stockSource:source,customerName:'Cliente aislado',paymentMethod:'cash',deliveryMethod:'pickup',shippingFeeCents:0,quotedSubtotalCents:150000*qty,quotedTotalCents:150000*qty,protocolOrderId:randomUUID(),protocolChecksum:'1234ABCD',lines:[{productId:d.product.id,quantity:qty,unitPriceCents:150000}]}))}::jsonb)`);
// Reduce A so its one remaining unit is assigned to the older normal sale.
execute(`select update_purchase(${q(JSON.stringify({id:d.purchase.id,supplierName:'Primero',expectedAt:'2030-01-01T15:00:00Z',items:[{productId:d.product.id,quantity:1,unitCostCents:100000}]}))}::jsonb);`);
const oldest=pendingOrder('normal',1);
const other=json(`select create_purchase(${q(JSON.stringify({supplierName:'Segundo',expectedAt:'2030-01-02T15:00:00Z',items:[{productId:d.product.id,quantity:1,unitCostCents:200000}]}))}::jsonb)`);
const youngest=pendingOrder('incoming_only',1);
await race(receive({...d,purchase:other},randomUUID()),receive(d,randomUUID()),4);
const crossing=json(`select jsonb_build_object('physical',(select reserved from stock_balances where product_id=${q(d.product.id)}),'incoming',(select coalesce(sum(quantity),0) from stock_reservations where product_id=${q(d.product.id)} and state='active' and source_type='incoming'),'older',private.order_payload(${q(oldest.id)},true)->>'stockReadiness','younger',private.order_payload(${q(youngest.id)},true)->>'stockReadiness','youngerCost',private.order_payload(${q(youngest.id)},true)->>'costTotalCents','receipts',(select count(*) from purchase_receipts where purchase_id in(${q(d.purchase.id)},${q(other.id)})))`);
assert.deepEqual(crossing,{physical:2,incoming:0,older:'ready',younger:'ready',youngerCost:'200000',receipts:2});
console.log('PASS simultaneous cross-purchase receipts preserve rebinding, order priority and historical cost');
