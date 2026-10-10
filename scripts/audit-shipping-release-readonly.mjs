// Read-only production evidence. Never creates fixtures or applies migrations.
import { Client } from 'pg';
import { loadEnv } from 'vite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';
import { PROJECT_ROOT, SUPABASE_PROJECT_REF, SUPABASE_PROJECT_REGION } from './project-targets.mjs';

const mode=process.argv[2];assert.ok(['before','after'].includes(mode));assertSupabaseTarget();
const env=loadEnv('production',PROJECT_ROOT,'');
const password=(process.env.SUPABASE_DB_PASSWORD || env.SUPABASE_DB_PASSWORD)?.trim();
assert.ok(password,'Read-only access unavailable');
const db=new Client({host:`aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`,port:6543,database:'postgres',
  user:`postgres.${SUPABASE_PROJECT_REF}`,password,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,
  options:'-c default_transaction_read_only=on -c statement_timeout=20000'});
const directory=resolve(PROJECT_ROOT,'output/audit');mkdirSync(directory,{recursive:true});
const quoteIdentifier=name=>'"'+name.replaceAll('"','""')+'"';
const addedFields={orders:['stock_source','shipping_fee_method','shipping_fee_basis_points','shipping_fee_cost_base_cents','shipping_fee_revision'],
  purchase_receipts:['shipping_cost_cents','shipping_expense_id'],misc_expenses:['purchase_receipt_operation_id']};
const newFunctionNames=new Set(['shipping_fee_snapshot','guard_shipping_fee_payment','save_order_shipping_fee','transition_order_checked']);
const changedNames=new Set(['confirm_imported_order','receive_purchase','order_payload','misc_expense_payload','transition_order',
  'get_business_export_dataset','get_sales_analytics','ai_get_product_performance','ai_get_sales_summary']);
let connected=false;
try {
  await db.connect();connected=true;
  await db.query('begin isolation level repeatable read read only');
  assert.equal((await db.query('show transaction_read_only')).rows[0].transaction_read_only,'on');
  const snapshot={at:new Date().toISOString(),environment:'production-read-only',tables:{},functions:[],triggers:[],stockIssues:[],failures:[]};
  for(const {tablename} of (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows) {
    snapshot.tables[tablename]=(await db.query(`select count(*)::text as count,md5(coalesce(string_agg(h,'' order by h),'')) as hash
      from (select md5((to_jsonb(t)-$1::text[])::text) as h from public.${quoteIdentifier(tablename)} t) rows`,[addedFields[tablename]??[]])).rows[0];
  }
  snapshot.functions=(await db.query(`select n.nspname as schema,p.proname as name,p.pronargs as args,p.oid::regprocedure::text as signature,
    md5(p.prosrc) as body,p.proowner::regrole::text as owner,p.proacl::text as acl,p.proconfig,p.provolatile,p.prosecdef
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') order by n.nspname,p.oid::regprocedure::text`)).rows;
  snapshot.triggers=(await db.query(`select t.tgname as name,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`)).rows;
  snapshot.stockIssues=(await db.query(`select p.name,p.sku,sb.on_hand,sb.reserved,
    (select coalesce(sum(quantity),0)::int from public.stock_reservations sr where sr.product_id=p.id and sr.state='active' and sr.source_type='physical') physical_reservations,
    (select coalesce(sum(quantity),0)::int from public.stock_reservations sr where sr.product_id=p.id and sr.state='active' and sr.source_type in ('incoming','uncovered')) pending_reservations,
    (select coalesce(sum(pi.quantity-pi.received_quantity-pi.shortage_quantity),0)::int from public.purchase_items pi join public.purchases pu on pu.id=pi.purchase_id where pi.product_id=p.id and pu.state='ordered') incoming
    from public.stock_balances sb join public.products p on p.id=sb.product_id where sb.on_hand<sb.reserved or sb.reserved<>(select coalesce(sum(quantity),0) from public.stock_reservations sr where sr.product_id=p.id and sr.state='active' and sr.source_type='physical')`)).rows;
  if(mode==='after') {
    const before=JSON.parse(readFileSync(resolve(directory,'shipping-release-before.json'),'utf8'));
    const changedTables=Object.keys(before.tables).filter(name=>JSON.stringify(before.tables[name])!==JSON.stringify(snapshot.tables[name]));
    if(changedTables.length) {
      const activityPath=resolve(directory,'shipping-external-activity.json');
      const activity=existsSync(activityPath)?JSON.parse(readFileSync(activityPath,'utf8')):null;
      const reconciled=activity?.verified===true && activity.baselineAt===before.at &&
        Object.keys(before.tables).every(name=>JSON.stringify(activity.fingerprints[name])===JSON.stringify(snapshot.tables[name]));
      if(reconciled)snapshot.externalActivity={verified:true,orders:activity.orders,newRows:activity.newRows};
      else snapshot.failures.push({kind:'existing_rows_changed',tables:changedTables});
    }
    const removed=before.functions.filter(old=>!snapshot.functions.some(now=>now.signature===old.signature));
    if(removed.some(f=>f.name!=='receive_purchase' || f.args!==3))snapshot.failures.push({kind:'unexpected_function_removal',functions:removed.map(f=>f.signature)});
    const unrelated=snapshot.functions.filter(now=>{
      const old=before.functions.find(f=>f.signature===now.signature);
      if(!old)return !newFunctionNames.has(now.name) && !(now.name==='receive_purchase' && now.args===4);
      return !changedNames.has(now.name) && JSON.stringify(old)!==JSON.stringify(now);
    });
    if(unrelated.length)snapshot.failures.push({kind:'unrelated_function_change',functions:unrelated.map(f=>f.signature)});
    if(JSON.stringify(before.triggers)!==JSON.stringify(snapshot.triggers.filter(t=>t.name!=='orders_shipping_fee_payment_guard')))snapshot.failures.push({kind:'unrelated_trigger_change'});
    let checkedDefinitions=0;
    for(const file of ['20261010010000_incoming_orders_and_shipping.sql','20261010020000_shipping_financial_reports.sql']) {
      const source=readFileSync(resolve(PROJECT_ROOT,'supabase/migrations',file),'utf8');
      for(const match of source.matchAll(/create or replace function\s+([\w.]+)\s*\(([\s\S]*?)\)\s*[\s\S]*?as\s+\$\$([\s\S]*?)\$\$;/gi)) {
        const [schema,name]=match[1].split('.');const args=match[2].trim()?match[2].split(',').length:0;
        const rows=(await db.query('select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2 and p.pronargs=$3',[schema,name,args])).rows;
        if(rows.length!==1 || rows[0].prosrc.trim()!==match[3].trim())snapshot.failures.push({kind:'deployed_definition_mismatch',function:match[1]});
        checkedDefinitions++;
      }
    }
    snapshot.checkedDefinitions=checkedDefinitions;assert.equal(checkedDefinitions,13);
    const owner=(await db.query("select user_id from public.store_users where active and role='owner' order by user_id limit 1")).rows[0]?.user_id;
    assert.ok(owner);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
    const orders=(await db.query(`select payment_state,sale_type,total_cents,cost_total_cents,tax_amount_cents,shipping_fee_cents,
      (coalesce(paid_at,created_at) at time zone 'America/Argentina/Buenos_Aires')::date::text as day from public.orders where payment_state in ('paid','gifted')`)).rows;
    const year=Number((await db.query("select extract(year from now() at time zone 'America/Argentina/Buenos_Aires')::int as y")).rows[0].y);
    const from=`${year}-01-01`,to=`${year}-12-31`;
    const expenses=(await db.query(`select o.occurrence_on::text as day,o.amount_cents,e.purchase_receipt_operation_id is not null as supplier
      from private.misc_expense_occurrences($1::date,$2::date) o join public.misc_expenses e on e.id=o.expense_id`,[from,to])).rows;
    const periods=new Map();const add=(f,t)=>periods.set(f+'/'+t,{f,t});
    for(let date=new Date(from+'T12:00:00Z');date.toISOString().slice(0,10)<=to;date.setUTCDate(date.getUTCDate()+1)) {
      const day=date.toISOString().slice(0,10);add(day,day);add(day.slice(0,7)+'-01',day);add(from,day);
    }
    const days=[...new Set([...orders,...expenses].map(r=>r.day).filter(d=>d>=from&&d<=to))].sort();
    for(const f of days)for(const t of days)if(f<=t)add(f,t);
    const sum=(rows,key)=>rows.reduce((v,r)=>v+BigInt(r[key]??0),0n);
    const all=[...periods.values()];snapshot.checkedFinancialPeriods=all.length;
    for(let offset=0;offset<all.length;offset+=20) {
      const rows=(await db.query(`select p.f::text,p.t::text,public.get_sales_analytics(p.f,p.t) a from jsonb_to_recordset($1::jsonb) p(f date,t date)`,[JSON.stringify(all.slice(offset,offset+20))])).rows;
      for(const {f,t,a} of rows) {
        const os=orders.filter(o=>o.day>=f&&o.day<=t),es=expenses.filter(e=>e.day>=f&&e.day<=t),paid=os.filter(o=>o.payment_state==='paid');
        const revenue=sum(os,'total_cents'),cost=sum(os,'cost_total_cents'),tax=sum(os,'tax_amount_cents'),expense=sum(es,'amount_cents');
        const expected={orders:paid.length,giftOrders:os.filter(o=>o.payment_state==='gifted'||o.sale_type==='gift').length,
          revenueCents:revenue,costCents:cost,taxCents:tax,miscExpensesCents:expense,commercialMarginCents:revenue-cost-tax,
          estimatedMarginCents:revenue-cost-tax-expense,shippingRevenueCents:sum(paid,'shipping_fee_cents'),
          supplierShippingExpensesCents:sum(es.filter(e=>e.supplier),'amount_cents'),otherExpensesCents:sum(es.filter(e=>!e.supplier),'amount_cents')};
        for(const [key,value] of Object.entries(expected))if(!Number.isSafeInteger(a[key]) || BigInt(a[key])!==BigInt(value))snapshot.failures.push({kind:'financial_mismatch',period:f+'/'+t,key,expected:String(value),actual:a[key]});
      }
    }
  }
  await db.query('rollback');
  writeFileSync(resolve(directory,`shipping-release-${mode}.json`),JSON.stringify(snapshot,null,2));
  console.log(JSON.stringify({environment:snapshot.environment,mode,tables:Object.keys(snapshot.tables).length,stockIssues:snapshot.stockIssues,
    checkedDefinitions:snapshot.checkedDefinitions,checkedFinancialPeriods:snapshot.checkedFinancialPeriods,externalActivity:snapshot.externalActivity,failures:snapshot.failures}));
  if(snapshot.failures.length)process.exitCode=1;
} catch(error) {
  console.error(JSON.stringify({failed:true,code:error.code??'AUDIT_FAILED',detail:error.code?'Read-only query failed':error.message}));process.exitCode=1;
} finally {
  if(connected){await db.query('rollback').catch(()=>{});await db.end().catch(()=>{});}
}
