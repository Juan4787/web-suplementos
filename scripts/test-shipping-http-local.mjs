// Real PostgREST transport and JWT roles, exclusively against an empty,
// explicitly marked local clone. No linked project or production credentials.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { guard, sql, database, container } from './test-shipping-local.mjs';

guard();
assert.equal(sql('select count(*) from public.orders;').trim(), '0');
assert.equal(sql('select count(*) from public.products;').trim(), '0');
const owner = '00000000-0000-4000-8000-000000103001';
const staff = '00000000-0000-4000-8000-000000103002';
const inactive = '00000000-0000-4000-8000-000000103003';
sql(`insert into auth.users(id,email) values
('${owner}','http-owner@test.local'),('${staff}','http-staff@test.local'),('${inactive}','http-inactive@test.local') on conflict(id) do nothing;
update public.store_users set role='owner',active=true where user_id='${owner}';
update public.store_users set role='staff',active=true where user_id='${staff}';
update public.store_users set role='staff',active=false where user_id='${inactive}';`);
const metadata = JSON.parse(execFileSync('docker',['inspect','supabase_rest_app-de-suplementos'],{encoding:'utf8'}))[0];
const originalEnv = Object.fromEntries(metadata.Config.Env.map(entry => {
  const split=entry.indexOf('=');return [entry.slice(0,split),entry.slice(split+1)];
}));
const uri = new URL(originalEnv.PGRST_DB_URI);
uri.hostname=container;uri.pathname='/'+database;
const secret = randomBytes(48).toString('hex');
const name = 'shipping-rest-audit-20261010';
const config={PGRST_DB_URI:String(uri),PGRST_DB_SCHEMAS:'public',PGRST_DB_EXTRA_SEARCH_PATH:'public,extensions',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_DB_POOL:'2'};
const base='http://127.0.0.1:55324';
const token=(sub,role='authenticated')=>{
  const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const data=b64({alg:'HS256',typ:'JWT'})+'.'+b64({role,sub,exp:Math.floor(Date.now()/1000)+900});
  return data+'.'+createHmac('sha256',secret).update(data).digest('base64url');
};
let running=false;
const checks=[];
const check=(description,fn)=>{fn();checks.push(description);console.log('PASS '+description);};
async function request(path,body,user=owner) {
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+token(user)}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});
  const content=await response.text();
  return {status:response.status,data:content?JSON.parse(content):null};
}
async function rpc(name,args,user=owner) {
  const result=await request('/rpc/'+name,args,user);
  assert.ok([200,204].includes(result.status),'Local RPC '+name+' failed: '+result.data?.message);
  return result.data;
}
try {
  execFileSync('docker',['run','--detach','--rm','--name',name,'--label','task=shipping-20261010',
    '--network','supabase_network_app-de-suplementos','--publish','127.0.0.1:55324:3000',
    ...Object.keys(config).flatMap(key=>['--env',key]),metadata.Config.Image],{encoding:'utf8',env:{...process.env,...config}});
  running=true;
  for(let i=0;i<40;i++) {
    try { if((await fetch(base,{signal:AbortSignal.timeout(1000)})).ok)break; } catch {}
    if(i===39)throw Error('Disposable PostgREST did not start');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const product=await rpc('save_product',{p_product:{sku:'HTTP_SHIPPING_QA',slug:'http-shipping-qa',name:'HTTP QA',
    presentation:'1 unidad',description:'Fixture aislado',category:'QA',priceCents:150000,currentCostCents:100000,
    reorderPoint:0,safetyStock:0,leadTimeDays:1,imageUrl:'/test.svg',imageAlt:'Prueba',featured:false,published:true,active:true}});
  await rpc('adjust_product_stock',{p_product_id:product.id,p_delta:2,p_reason:'Fixture HTTP aislado'});
  const purchase=await rpc('create_purchase',{p_purchase:{supplierName:'HTTP QA',items:[{productId:product.id,quantity:2,unitCostCents:107000}]}});
  const input={stockSource:'incoming_only',customerName:'HTTP QA',paymentMethod:'cash',deliveryMethod:'pickup',
    shippingType:null,shippingFeeCents:0,quotedSubtotalCents:150000,quotedTotalCents:150000,
    protocolOrderId:randomUUID(),protocolChecksum:'1234ABCD',lines:[{productId:product.id,quantity:1,unitPriceCents:150000}]};
  const order=await rpc('confirm_imported_order',{p_order:input});
  check('HTTP inbound-only leaves physical stock untouched',()=>{
    assert.equal(sql(`select on_hand||':'||reserved from public.stock_balances where product_id='${product.id}';`).trim(),'2:0');
    assert.equal(order.stockSource,'incoming_only');assert.equal(order.costTotalCents,107000);
  });
  const fee={orderId:order.id,operationId:randomUUID(),expectedRevision:0,method:'percentage',basisPoints:500,expectedCostCents:107000};
  const updated=await rpc('save_order_shipping_fee',{p_fee:fee});
  check('PostgREST preserves exact percentage, whole-peso nominal and total',()=>{
    assert.equal(updated.shippingFeeCents,5400);assert.equal(updated.totalCents,155400);assert.equal(updated.shippingFeeRevision,1);
  });
  const retried=await rpc('save_order_shipping_fee',{p_fee:fee});
  check('HTTP retry does not duplicate fee history',()=>{
    assert.equal(retried.shippingFeeRevision,1);
    assert.equal(sql(`select count(*) from public.order_shipping_fee_events where order_id='${order.id}';`).trim(),'1');
  });
  const deniedStaff=await request('/rpc/save_order_shipping_fee',{p_fee:{...fee,operationId:randomUUID()}},staff);
  const deniedInactive=await request('/rpc/save_order_shipping_fee',{p_fee:{...fee,operationId:randomUUID()}},inactive);
  const deniedAnon=await request('/rpc/save_order_shipping_fee',{p_fee:fee},null);
  check('Actual JWT roles deny staff, inactive users and anonymous mutation',()=>{
    assert.notEqual(deniedStaff.status,200);assert.equal(deniedStaff.data.message,'FORBIDDEN');
    assert.notEqual(deniedInactive.status,200);assert.notEqual(deniedAnon.status,200);
  });
  const staffOrders=await rpc('search_orders',{p_page:1,p_page_size:20,p_search:'',p_state:'all'},staff);
  const staffOrder=staffOrders.items.find(o=>o.id===order.id);
  check('Staff payload keeps nominal while redacting cost and percentage basis',()=>{
    assert.equal(staffOrder.shippingFeeCents,5400);assert.equal(staffOrder.shippingFeeBasisPoints,null);
    assert.equal(staffOrder.shippingFeeCostBaseCents,null);assert.equal(staffOrder.costTotalCents,null);
  });
  const history=await request('/order_shipping_fee_events?select=operation_id',undefined,staff);
  check('PostgREST RLS hides audit events from staff',()=>{assert.equal(history.status,200);assert.deepEqual(history.data,[]);});
  sql(`update public.orders set cost_total_cents=107100 where id='${order.id}';`);
  const staleStaff=await rpc('search_orders',{p_page:1,p_page_size:20,p_search:'',p_state:'all'},staff);
  check('Staff receives an actionable review flag without confidential amounts',()=>{
    const pending=staleStaff.items.find(o=>o.id===order.id);assert.equal(pending.shippingFeeNeedsReview,true);
    assert.equal(pending.costTotalCents,null);assert.equal(pending.shippingFeeBasisPoints,null);
  });
  sql(`update public.orders set cost_total_cents=107000 where id='${order.id}';`);
  const paid=await rpc('transition_order_checked',{p_order_id:order.id,p_action:'mark_paid',p_expected_fee_revision:1,
    p_expected_total_cents:155400,p_expected_cost_cents:107000});
  const locked=await request('/rpc/save_order_shipping_fee',{p_fee:{...fee,operationId:randomUUID(),expectedRevision:1}});
  check('Checked payment freezes the reviewed shipping fee through HTTP',()=>{
    assert.equal(paid.paymentState,'paid');assert.equal(locked.data.message,'SHIPPING_FEE_LOCKED');assert.notEqual(locked.status,200);
  });
  const operation=randomUUID(), receiptArgs={p_purchase_id:purchase.id,p_items:[{purchaseItemId:purchase.items[0].id,receivedQuantity:1}],p_operation_id:operation,p_shipping_cost_cents:1500000};
  const receipt=await rpc('receive_purchase',receiptArgs);
  await rpc('receive_purchase',receiptArgs);
  check('HTTP receipt replay produces one linked expense and one stock increment',()=>{
    assert.equal(receipt.shippingExpense.amountCents,1500000);
    assert.equal(sql(`select count(*) from public.misc_expenses where purchase_receipt_operation_id='${operation}';`).trim(),'1');
    assert.equal(sql(`select on_hand from public.stock_balances where product_id='${product.id}';`).trim(),'3');
  });
  const legacy=await rpc('receive_purchase',{p_purchase_id:purchase.id,p_items:[{purchaseItemId:purchase.items[0].id,receivedQuantity:1}],p_operation_id:randomUUID()});
  check('Existing three-argument receipt clients remain compatible without extra expense',()=>{
    assert.equal(legacy.shippingExpense,null);assert.equal(sql('select count(*) from public.misc_expenses;').trim(),'1');
  });
  const day=sql("select (now() at time zone 'America/Argentina/Buenos_Aires')::date;").trim();
  const analytics=await rpc('get_sales_analytics',{p_from:day,p_to:day});
  const dashboard=await rpc('get_dashboard_summary',{});
  check('Real HTTP payloads reconcile collected sales, exact cost, supplier freight and net',()=>{
    assert.equal(analytics.revenueCents,155400);assert.equal(analytics.costCents,107000);
    assert.equal(analytics.supplierShippingExpensesCents,1500000);
    assert.equal(analytics.estimatedMarginCents,155400-107000-analytics.taxCents-1500000);
    assert.equal(dashboard.estimatedMarginMonthCents,analytics.estimatedMarginCents);
  });
  const gifted=await rpc('confirm_imported_order',{p_order:{...input,stockSource:'normal',saleType:'gift',paymentMethod:'gift',protocolOrderId:randomUUID()}});
  const beforeGiftCancel=await rpc('get_dashboard_summary',{});
  const cancelled=await rpc('transition_order',{p_order_id:gifted.id,p_action:'cancel'});
  const afterGiftCancel=await rpc('get_dashboard_summary',{});
  const restored=await rpc('get_sales_analytics',{p_from:day,p_to:day});
  check('Manual gift cancellation restores the same merchandise cost in real HTTP reports',()=>{
    assert.equal(cancelled.paymentState,'refunded');assert.equal(restored.costCents,107000);
    assert.equal(afterGiftCancel.estimatedMarginMonthCents,beforeGiftCancel.estimatedMarginMonthCents+gifted.costTotalCents);
  });
  mkdirSync('output/audit',{recursive:true});
  writeFileSync('output/audit/shipping-http-local.json',JSON.stringify({environment:'isolated-local-http',database,checks},null,2));
  console.log('ALL '+checks.length+' LOCAL HTTP CHECKS PASSED');
} finally {
  if(running)execFileSync('docker',['stop',name],{stdio:'ignore'});
}
