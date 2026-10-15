begin;
do $$ begin
  if current_database() !~ '^rigorous_ux_shipping_.*' then raise exception 'DISPOSABLE_LOCAL_DATABASE_REQUIRED'; end if;
end $$;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions,pg_temp;
select no_plan();
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000151001','cancel-owner@test.local'),
 ('00000000-0000-4000-8000-000000151002','cancel-staff@test.local');
update store_users set role='owner',active=true where user_id='00000000-0000-4000-8000-000000151001';
update store_users set role='staff',active=true where user_id='00000000-0000-4000-8000-000000151002';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000151001',true);
create temp table fx(name text primary key,value jsonb);
create function pg_temp.id(key text) returns uuid language sql as $$ select (value->>'id')::uuid from fx where name=key $$;
create function pg_temp.product(key text,cost integer default 60000) returns jsonb language sql as $$
 select save_product(jsonb_build_object('sku',key,'slug',replace(lower(key),'_','-'),'name',key,'presentation','1 u.','description','Prueba aislada','category','QA','priceCents',150000,'currentCostCents',cost,'reorderPoint',0,'safetyStock',0,'leadTimeDays',1,'imageUrl','/test.svg','imageAlt','Producto QA','published',true,'active',true,'featured',false));
$$;
create function pg_temp.purchase(key text,qty integer,cost integer default 60000) returns jsonb language sql as $$
 select create_purchase(jsonb_build_object('supplierName','Proveedor QA','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id(key),'quantity',qty,'unitCostCents',cost))));
$$;
create function pg_temp.order_input(key text,qty integer) returns jsonb language sql as $$
 select jsonb_build_object('customerName','Cliente QA','paymentMethod','cash','deliveryMethod','pickup','shippingFeeCents',0,'quotedSubtotalCents',150000*qty,'quotedTotalCents',150000*qty,'lines',jsonb_build_array(jsonb_build_object('productId',pg_temp.id(key),'quantity',qty,'unitPriceCents',150000)));
$$;
create function pg_temp.cancel(key text,op uuid,token text,replacement jsonb default null) returns jsonb language sql as $$
 select cancel_purchase(pg_temp.id(key),'Proveedor no envía',op,token,replacement);
$$;
create function pg_temp.receive(key text,qty integer,fee bigint default 0) returns jsonb language sql as $$
 select receive_purchase(pg_temp.id(key),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fx where name=key),'receivedQuantity',qty)),gen_random_uuid(),fee);
$$;

-- The original incident: stock received from a different purchase must serve older orders.
insert into fx values('A',pg_temp.product('CANCEL_A'));
insert into fx values('future',pg_temp.purchase('A',5));
insert into fx values('older',confirm_imported_order(pg_temp.order_input('A',3)));
update orders set confirmed_at=now()-interval '1 day' where id=pg_temp.id('older');
insert into fx values('early',pg_temp.purchase('A',5,70000));
update purchases set expected_at=now()-interval '1 day' where id=pg_temp.id('early');
insert into fx values('younger',confirm_imported_order(pg_temp.order_input('A',2)));
select lives_ok($$select pg_temp.receive('early',2)$$,'Cross-purchase arrival succeeds');
select is((select sum(quantity) from stock_reservations where order_id=pg_temp.id('older') and state='active' and source_type='physical'),2::bigint,'Global FIFO serves older order linked to another purchase');
select is((select coalesce(sum(quantity),0) from stock_reservations where order_id=pg_temp.id('younger') and source_type='physical'),0::bigint,'Newer purchase-specific reservations cannot jump the queue');
select is((select cost_total_cents from orders where id=pg_temp.id('older')),180000::bigint,'Reconciliation preserves historical customer cost');
select is((select sum(quantity*cost_snapshot_cents)::bigint from stock_reservations where order_id=pg_temp.id('older')),180000::bigint,'Reservation snapshots remain exact');

-- Distinct physical cost lots are valid; packing sums their quantities.
insert into fx values('B',pg_temp.product('CANCEL_B'));
select adjust_product_stock(pg_temp.id('B'),1,'Fixture físico');
insert into fx values('mixed_purchase',pg_temp.purchase('B',3,70000));
insert into fx values('mixed',confirm_imported_order(pg_temp.order_input('B',2)));
select pg_temp.receive('mixed_purchase',1) is not null as received;
select is((select count(*) from stock_reservations where order_id=pg_temp.id('mixed') and source_type='physical'),2::bigint,'Different cost snapshots are not merged destructively');
select is((select sum(quantity*cost_snapshot_cents)::bigint from stock_reservations where order_id=pg_temp.id('mixed')),130000::bigint,'Mixed lots keep exact historical cost');
select lives_ok(format('select save_order_packing(%L,%L::jsonb,0)',pg_temp.id('mixed'),jsonb_build_array(jsonb_build_object('orderItemId',(select id from order_items where order_id=pg_temp.id('mixed')),'packedQuantity',2))),'Packing accepts multiple physical cost lots');
select lives_ok(format('select transition_order(%L,%L)',pg_temp.id('mixed'),'mark_at_cost'),'Mixed order can be sold at its frozen total cost');
select is((select total_cents from orders where id=pg_temp.id('mixed')),130000::bigint,'At-cost conversion does not overwrite real mixed cost');
select lives_ok(format('select transition_order(%L,%L)',pg_temp.id('mixed'),'mark_refunded'),'Refund action remains available after reconciliation');
select throws_ok(format('select transition_order(%L,%L)',pg_temp.id('mixed'),'cancel'),'P0001','CANNOT_CANCEL_PACKED_ORDER','Packing safety still blocks cancellation');

-- A partially received purchase can close its uncommitted balance without moving physical stock or money.
insert into fx values('C',pg_temp.product('CANCEL_C'));
insert into fx values('plain',pg_temp.purchase('C',5));
select pg_temp.receive('plain',2,50000) is not null as received;
insert into fx values('plain_preview',get_purchase_cancellation_preview(pg_temp.id('plain')));
insert into fx values('plain_op',to_jsonb(gen_random_uuid()));
insert into fx values('plain_result',pg_temp.cancel('plain',(select (value#>>'{}')::uuid from fx where name='plain_op'),(select value->>'reviewToken' from fx where name='plain_preview')));
select is((select value->'purchase'->>'state' from fx where name='plain_result'),'cancelled','Uncommitted pending balance is cancelled');
select is((select on_hand from stock_balances where product_id=pg_temp.id('C')),2,'Cancellation keeps received stock');
select is((select received_quantity from purchase_items where purchase_id=pg_temp.id('plain')),2,'Cancellation keeps receipt quantity');
select is((select shortage_quantity from purchase_items where purchase_id=pg_temp.id('plain')),0,'Cancellation is not invented supplier shortage');
select is((select amount_cents from misc_expenses where purchase_receipt_operation_id in(select operation_id from purchase_receipts where purchase_id=pg_temp.id('plain'))),50000::bigint,'Cancellation preserves real supplier expense');
select is((select value->'purchase'->'cancellation'->>'pendingUnits' from fx where name='plain_result'),'3','Audit records exact pending units');
select is(pg_temp.cancel('plain',(select (value#>>'{}')::uuid from fx where name='plain_op'),(select value->>'reviewToken' from fx where name='plain_preview')),(select value from fx where name='plain_result'),'Lost response replay returns the identical result');
select throws_ok(format('select cancel_purchase(%L,%L,%L,%L)',pg_temp.id('plain'),'Otro motivo',(select value#>>'{}' from fx where name='plain_op'),(select value->>'reviewToken' from fx where name='plain_preview')),'P0001','IDEMPOTENCY_KEY_REUSE_MISMATCH','Replay cannot change the reason');
select throws_ok($$select pg_temp.receive('plain',1)$$,'P0001','INVALID_PURCHASE_STATE','Old receipt screen cannot receive a cancelled balance');
select is((list_purchases(1,100,'cancelled')->>'cancelledTotal')::integer,1,'Cancelled filter and count include the purchase');
select ok(exists(select 1 from jsonb_array_elements(get_business_export_dataset()->'purchases') p where p->>'id'=pg_temp.id('plain')::text and p->'cancellation'->>'pendingUnits'='3'),'Business backup includes cancellation audit');

-- Changed review and customer commitments are checked in the database.
insert into fx values('D',pg_temp.product('CANCEL_D'));
insert into fx values('replace',pg_temp.purchase('D',8));
insert into fx values('stale',get_purchase_cancellation_preview(pg_temp.id('replace')));
insert into fx values('waiting',confirm_imported_order(pg_temp.order_input('D',5)));
select throws_ok(format('select pg_temp.cancel(%L,gen_random_uuid(),%L)','replace',(select value->>'reviewToken' from fx where name='stale')),'P0001','PURCHASE_CANCELLATION_CHANGED','New reservations invalidate an old review');
select pg_temp.receive('replace',2) is not null as received;
select transition_order(pg_temp.id('waiting'),'mark_paid') is not null as paid;
select save_order_packing(pg_temp.id('waiting'),jsonb_build_array(jsonb_build_object('orderItemId',(select id from order_items where order_id=pg_temp.id('waiting')),'packedQuantity',2)),0) is not null as packed;
insert into stock_reservations(product_id,quantity,source_type,purchase_item_id,cost_snapshot_cents,is_opening)
select pg_temp.id('D'),1,'incoming',id,60000,true from purchase_items where purchase_id=pg_temp.id('replace');
insert into fx values('review',get_purchase_cancellation_preview(pg_temp.id('replace')));
select is((select value->>'canCancel' from fx where name='review'),'false','Cannot silently abandon customer and opening reservations');
select is((select value->'orders'->0->>'quantity' from fx where name='review'),'3','Review reports only customer units still waiting');
select is((select value->>'openingReservedQuantity' from fx where name='review'),'1','Review identifies pre-system reservations');
select throws_ok(format('select pg_temp.cancel(%L,gen_random_uuid(),%L)','replace',(select value->>'reviewToken' from fx where name='review')),'P0001','CANNOT_CANCEL_PURCHASE_WITH_ACTIVE_RESERVATIONS','Direct cancellation is blocked by backend');
create temp table financial_before as select to_jsonb(o) snapshot from orders o where id=pg_temp.id('waiting');
insert into fx values('replacement_op',to_jsonb(gen_random_uuid()));
insert into fx values('replacement_result',pg_temp.cancel('replace',(select (value#>>'{}')::uuid from fx where name='replacement_op'),(select value->>'reviewToken' from fx where name='review'),'{"supplierName":"Proveedor nuevo QA","expectedAt":"2026-11-01T12:00:00-03:00"}'));
select is((select value->>'transferredUnits' from fx where name='replacement_result'),'4','Replacement transfers customer and pre-system units together');
select is((select value->'replacementPurchase'->'items'->0->>'quantity' from fx where name='replacement_result'),'6','Only the unreceived balance is repurchased');
select is((select to_jsonb(o) from orders o where id=pg_temp.id('waiting')),(select snapshot from financial_before),'Payment, dates, snapshots and all order header fields are unchanged');
select is((select packed_quantity from order_items where order_id=pg_temp.id('waiting')),2,'Already packed units are preserved');
select is((select reserved from stock_balances where product_id=pg_temp.id('D')),2,'Replacement does not change physical reservations');
select is((select count(*) from stock_reservations sr join purchase_items pi on pi.id=sr.purchase_item_id where pi.purchase_id=pg_temp.id('replace') and sr.state='active' and sr.source_type in('incoming','uncovered')),0::bigint,'No pending reservation remains on cancelled purchase');
select is((private.order_payload(pg_temp.id('waiting'),true)->>'expectedArrivalAt')::timestamptz,'2026-11-01T12:00:00-03:00'::timestamptz,'Customer ETA follows replacement purchase');
select is(pg_temp.cancel('replace',(select (value#>>'{}')::uuid from fx where name='replacement_op'),(select value->>'reviewToken' from fx where name='review'),'{"supplierName":"Proveedor nuevo QA","expectedAt":"2026-11-01T12:00:00-03:00"}'),(select value from fx where name='replacement_result'),'Atomic replacement retry never duplicates purchase');
select lives_ok(format('select receive_purchase(%L,%L::jsonb,gen_random_uuid())',
  (select value->'replacementPurchase'->>'id' from fx where name='replacement_result'),
  (select jsonb_build_array(jsonb_build_object('purchaseItemId',value->'replacementPurchase'->'items'->0->>'id','receivedQuantity',6)) from fx where name='replacement_result')),'Receiving the replacement resolves customer and opening reservations');
select is(private.order_payload(pg_temp.id('waiting'),true)->>'stockReadiness','ready','Customer becomes ready after actual replacement receipt');
select is((select packed_quantity from order_items where order_id=pg_temp.id('waiting')),2,'Replacement receipt does not invent packed units');
select is((select sum(quantity) from stock_reservations where product_id=pg_temp.id('D') and is_opening and state='active' and source_type='physical'),1::bigint,'Opening reservation remains identifiable and physically received');

-- Inject a real failure after creating the replacement: every write must roll back.
insert into fx values('failure_purchase',pg_temp.purchase('D',2));
insert into fx values('failure_review',get_purchase_cancellation_preview(pg_temp.id('failure_purchase')));
create temp table count_before as select count(*) n from purchases;
create function pg_temp.fail_cancel() returns trigger language plpgsql as $$ begin raise exception 'QA_CANCEL_FAILURE'; end $$;
create trigger qa_cancel_failure before insert on private.purchase_cancellations for each row execute function pg_temp.fail_cancel();
select throws_ok(format('select pg_temp.cancel(%L,gen_random_uuid(),%L,%L::jsonb)','failure_purchase',(select value->>'reviewToken' from fx where name='failure_review'),'{"supplierName":"No debe persistir"}'),'P0001','QA_CANCEL_FAILURE','Failure after replacement creation aborts the entire transaction');
select is((select count(*) from purchases),(select n from count_before),'Failure leaves no orphan replacement');
select is((select state::text from purchases where id=pg_temp.id('failure_purchase')),'ordered','Failure keeps original purchase active');
drop trigger qa_cancel_failure on private.purchase_cancellations;

-- Already-declared shortage still represents customer commitments; replacement
-- explicitly includes them rather than silently dropping or under-ordering them.
insert into fx values('E',pg_temp.product('CANCEL_E',0));
insert into fx values('shortage_purchase',pg_temp.purchase('E',5,0));
insert into fx values('shortage_order',confirm_imported_order(pg_temp.order_input('E',5)));
select declare_item_shortage((select (value->'items'->0->>'id')::uuid from fx where name='shortage_purchase'),2) is not null as shortage;
insert into fx values('shortage_review',get_purchase_cancellation_preview(pg_temp.id('shortage_purchase')));
select is((select value->>'pendingUnits' from fx where name='shortage_review'),'3','Review separates pending balance from historical shortage');
select is((select value->'replacementItems'->0->>'quantity' from fx where name='shortage_review'),'5','Replacement includes all five still-committed customer units');
insert into fx values('shortage_replacement',pg_temp.cancel('shortage_purchase',gen_random_uuid(),(select value->>'reviewToken' from fx where name='shortage_review'),'{"supplierName":"Reposición de faltante"}'));
select is((select value->>'transferredUnits' from fx where name='shortage_replacement'),'5','Uncovered commitments regain full incoming coverage');
update product_financials set current_cost_cents=90000 where product_id=pg_temp.id('E');
select adjust_product_stock(pg_temp.id('E'),5,'Arribo alternativo QA') is null as adjusted;
select is((select sum(quantity*cost_snapshot_cents)::bigint from stock_reservations where order_id=pg_temp.id('shortage_order')),0::bigint,'Zero historical cost is preserved without inventing replacement cost');

-- Several products share one atomic cancellation, one replacement and one review.
insert into fx values('F',pg_temp.product('CANCEL_F'));
insert into fx values('G',pg_temp.product('CANCEL_G'));
insert into fx values('multi',create_purchase(jsonb_build_object('supplierName','Proveedor con dos productos','items',jsonb_build_array(
  jsonb_build_object('productId',pg_temp.id('F'),'quantity',2,'unitCostCents',60000),
  jsonb_build_object('productId',pg_temp.id('G'),'quantity',2,'unitCostCents',60000)))));
insert into fx values('multi_order',confirm_imported_order(pg_temp.order_input('F',2)||jsonb_build_object('quotedSubtotalCents',600000,'quotedTotalCents',600000,'lines',jsonb_build_array(
  jsonb_build_object('productId',pg_temp.id('F'),'quantity',2,'unitPriceCents',150000),
  jsonb_build_object('productId',pg_temp.id('G'),'quantity',2,'unitPriceCents',150000)))));
select receive_purchase(pg_temp.id('multi'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select id from purchase_items where purchase_id=pg_temp.id('multi') and product_id=pg_temp.id('F')),'receivedQuantity',1)),gen_random_uuid()) is not null as received_multi;
insert into fx values('multi_review',get_purchase_cancellation_preview(pg_temp.id('multi')));
select is(jsonb_array_length((select value->'orders'->0->'products' from fx where name='multi_review')),2,'Review identifies the exact pending products for each customer');
insert into fx values('multi_result',pg_temp.cancel('multi',gen_random_uuid(),(select value->>'reviewToken' from fx where name='multi_review'),'{"supplierName":"Reposición de dos productos"}'));
select is(jsonb_array_length((select value->'replacementPurchase'->'items' from fx where name='multi_result')),2,'One replacement contains both pending products');
select is((select value->>'transferredUnits' from fx where name='multi_result'),'3','Multi-product transfer moves only three unreceived units');
select is((select sum(quantity) from stock_reservations where order_id=pg_temp.id('multi_order') and source_type='physical' and state='active'),1::bigint,'Received physical unit stays assigned to the same order');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000151002',true);
select throws_ok($$select get_purchase_cancellation_preview(pg_temp.id('plain'))$$,'P0001','FORBIDDEN','Staff cannot inspect owner financial cancellation review');
select throws_ok(format('select pg_temp.cancel(%L,%L,%L)','plain',(select value#>>'{}' from fx where name='plain_op'),(select value->>'reviewToken' from fx where name='plain_preview')),'P0001','FORBIDDEN','Staff cannot replay owner cancellation');
select ok(not has_function_privilege('anon','public.cancel_purchase(uuid,text,uuid,text,jsonb)','execute'),'Anonymous cannot cancel purchases');
select ok(not has_table_privilege('authenticated','private.purchase_cancellations','select'),'Operation receipts remain private');
select * from finish();
rollback;
