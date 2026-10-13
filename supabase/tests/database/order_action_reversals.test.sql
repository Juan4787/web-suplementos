begin;
do $$ begin
  if current_database() !~ '^rigorous_ux_shipping_.*reversals_' or not exists(select 1 from staging_guard.identity where task='shipping-20261010') then
    raise exception 'DISPOSABLE_LOCAL_DATABASE_REQUIRED';
  end if;
end $$;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select no_plan();
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000131001','reversal-owner@test.local'),
 ('00000000-0000-4000-8000-000000131002','reversal-staff@test.local');
update public.store_users set active=true,role='owner' where user_id='00000000-0000-4000-8000-000000131001';
update public.store_users set active=true,role='staff' where user_id='00000000-0000-4000-8000-000000131002';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000131001',true);
create temp table fixture(name text primary key, value jsonb);
insert into fixture values('product',public.save_product('{"sku":"REVERSAL_TEST","slug":"reversal-test","name":"Prueba de correcciones","presentation":"1 unidad","description":"Fixture aislado","category":"QA","priceCents":150000,"currentCostCents":100000,"reorderPoint":0,"safetyStock":0,"leadTimeDays":1,"imageUrl":"/test.svg","imageAlt":"Producto de prueba","featured":false,"published":true,"active":true}'));
create function pg_temp.id(name text) returns uuid language sql as $$ select (value->>'id')::uuid from fixture where fixture.name=$1 $$;
select public.adjust_product_stock(pg_temp.id('product'),20,'Fixture aislado');
create function pg_temp.new_order(method text default 'pickup',source text default 'normal',qty integer default 2) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
  v_result := public.confirm_imported_order(jsonb_build_object('stockSource',source,'customerName','Cliente Correcciones','phone','5493411310010','paymentMethod','cash','deliveryMethod',method,'shippingType',case when method='shipping' then 'standard' else null end,'address',case when method='shipping' then 'Calle QA 123' else null end,'shippingFeeCents',0,'quotedSubtotalCents',150000*qty,'quotedTotalCents',150000*qty,'protocolOrderId',gen_random_uuid(),'protocolChecksum','1234ABCD','lines',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',qty,'unitPriceCents',150000))));
  return public.save_order_shipping_fee(jsonb_build_object('orderId',v_result->>'id','operationId',gen_random_uuid(),'expectedRevision',0,'method','manual','amountCents',5000));
end;
$$;
create function pg_temp.rev(name text) returns bigint language sql as $$ select action_revision from public.orders where id=pg_temp.id(name) $$;
create function pg_temp.reverse(name text,action text) returns jsonb language sql as $$ select public.reverse_order_action(pg_temp.id(name),action,gen_random_uuid(),pg_temp.rev(name)) $$;
create function pg_temp.inventory() returns jsonb language sql as $$ select item from jsonb_array_elements(public.list_inventory_status()) item where item->>'id'=pg_temp.id('product')::text $$;
create function pg_temp.analytics() returns jsonb language sql as $$ select public.get_sales_analytics((now() at time zone 'America/Argentina/Buenos_Aires')::date,(now() at time zone 'America/Argentina/Buenos_Aires')::date) $$;

insert into fixture values('pickup',pg_temp.new_order());
select public.transition_order(pg_temp.id('pickup'),'mark_paid');
select is(pg_temp.analytics()->>'revenueCents','305000','Collected order contributes merchandise and shipping revenue');
select throws_ok(format('select public.transition_order(%L,''cancel'')',pg_temp.id('pickup')),'P0001','CANNOT_CANCEL_PAID_ORDER','Direct RPC cannot silently cancel a collected order');
insert into fixture values('paid_snapshot',private.order_payload(pg_temp.id('pickup'),true));
select public.transition_order(pg_temp.id('pickup'),'mark_delivered');
select is(pg_temp.inventory()->>'onHand','18','Delivery removes physical units');
select is(pg_temp.inventory()->>'reserved','0','Delivery consumes reservations');
select is(pg_temp.inventory()->>'averageDailySales','0.07','Delivery contributes two units to demand');
select throws_ok(format('select public.transition_order(%L,''cancel'')',pg_temp.id('pickup')),'P0001','CANNOT_CANCEL_PAID_ORDER','Completed paid order also requires payment correction');
select is(pg_temp.reverse('pickup','reverse_payment')->>'paymentState','pending','Collected delivered order can revert payment independently');
select is(pg_temp.analytics()->>'revenueCents','0','Reverting collection removes sales revenue');
select is(public.get_dashboard_summary()->>'paidRevenueMonthCents','0','Dashboard collection revenue is reconciled');
select is(public.search_orders(1,50,'','pending')->>'pendingTotal','1','Reversed completed collection becomes an operational pending order');
select is(public.search_orders(1,50,'','completed')->>'completedTotal','0','Reversed collection no longer counts as completed');
select is(pg_temp.analytics()->>'shippingRevenueCents','0','Reverting collection removes shipping revenue');
select is(pg_temp.analytics()->>'costCents','0','Reverting collection removes sale costs from paid-sales report');
select is((select paid_at from public.orders where id=pg_temp.id('pickup')),null::timestamptz,'A reversed collection has no current payment date');
select is(pg_temp.inventory()->>'onHand','18','Reverting collection does not return stock');
select is(private.order_payload(pg_temp.id('pickup'),true)->>'fulfillmentState','delivered','Collection correction does not alter delivery');
select is((public.search_paid_orders(1,50,null,null)->>'total')::integer,0,'Reversed collection disappears from paid order list');
select is((public.list_customers(1,50,'Cliente Correcciones')->'items'->0->>'totalPaidCents')::bigint,0::bigint,'Customer paid amount is reconciled');
select is((public.list_customers(1,50,'Cliente Correcciones')->'items'->0->>'pendingTotalCents')::bigint,305000::bigint,'Customer debt becomes pending again');
select throws_ok(format('select public.transition_order(%L,''cancel'')',pg_temp.id('pickup')),'P0001','CANNOT_CANCEL_FULFILLED_ORDER','Unpaid delivered order cannot be cancelled with stock still outside');

insert into fixture values('reverse_input',jsonb_build_object('id',gen_random_uuid(),'revision',pg_temp.rev('pickup')));
select is(public.reverse_order_action(pg_temp.id('pickup'),'reverse_delivery',(select (value->>'id')::uuid from fixture where name='reverse_input'),(select (value->>'revision')::bigint from fixture where name='reverse_input'))->>'fulfillmentState','pending','Pickup delivery correction returns to pending');
select is(pg_temp.inventory()->>'onHand','20','Delivery correction restores physical stock');
select is(pg_temp.inventory()->>'reserved','2','Restored stock belongs to the same order');
select is(public.get_dashboard_summary()->>'readyForDelivery','1','Dashboard shows the restored order as awaiting delivery');
select is(public.search_orders(1,50,'','ready_pickup')->>'readyPickupTotal','1','Pickup preparation counter reconciles restored delivery');
select is(pg_temp.inventory()->>'available','18','Restored units do not become free stock');
select is(pg_temp.inventory()->>'averageDailySales','0.00','Corrected exit is excluded from demand');
select is((select count(*) from public.stock_reservations where order_id=pg_temp.id('pickup') and state='active'),1::bigint,'Original reservation is active again');
select is((select count(*) from public.stock_movements where order_id=pg_temp.id('pickup') and kind='sale'),1::bigint,'Original sale movement remains in history');
select lives_ok(format('select public.reverse_order_action(%L,''reverse_delivery'',%L,%s)',pg_temp.id('pickup'),(select value->>'id' from fixture where name='reverse_input'),(select value->>'revision' from fixture where name='reverse_input')),'Retrying the identical operation is safe');
select is(pg_temp.inventory()->>'onHand','20','Retry does not duplicate physical stock');
select is((select count(*) from public.order_action_reversals where action='reverse_delivery'),1::bigint,'Retry does not duplicate history');
select throws_ok(format('select public.reverse_order_action(%L,''reverse_payment'',%L,%s)',pg_temp.id('pickup'),(select value->>'id' from fixture where name='reverse_input'),(select value->>'revision' from fixture where name='reverse_input')),'P0001','IDEMPOTENCY_KEY_REUSE_MISMATCH','An operation cannot be reused with another action');
select is(private.order_payload(pg_temp.id('pickup'),true)->>'totalCents',(select value->>'totalCents' from fixture where name='paid_snapshot'),'Prices and shipping survive both corrections');
select is(private.order_payload(pg_temp.id('pickup'),true)->>'costTotalCents',(select value->>'costTotalCents' from fixture where name='paid_snapshot'),'Cost snapshot survives both corrections');

select public.transition_order(pg_temp.id('pickup'),'mark_paid');
select public.transition_order(pg_temp.id('pickup'),'mark_delivered');
select is(pg_temp.inventory()->>'averageDailySales','0.07','Re-delivery contributes one effective sale rather than two');
select throws_ok(format('select public.reverse_order_action(%L,''reverse_payment'',gen_random_uuid(),%s)',pg_temp.id('pickup'),(select value->>'revision' from fixture where name='reverse_input')),'P0001','ORDER_ACTION_CHANGED','An old confirmation cannot reverse a later payment cycle');
select pg_temp.reverse('pickup','reverse_delivery');
select pg_temp.reverse('pickup','reverse_payment');
select public.transition_order(pg_temp.id('pickup'),'cancel');
select is(pg_temp.inventory()->>'reserved','0','Cancellation after correction releases restored reservations');
select is(pg_temp.inventory()->>'onHand','20','Cancellation does not restore stock twice');
select lives_ok(format('select public.transition_order(%L,''cancel'')',pg_temp.id('pickup')),'Cancellation itself is safe to retry');

insert into fixture values('shipping',pg_temp.new_order('shipping'));
select public.transition_order(pg_temp.id('shipping'),'mark_paid');
select public.transition_order(pg_temp.id('shipping'),'mark_shipped');
select public.transition_order(pg_temp.id('shipping'),'mark_delivered');
select is(pg_temp.reverse('shipping','reverse_delivery')->>'fulfillmentState','shipped','Delivery correction of a shipment restores sent status');
select is(pg_temp.inventory()->>'onHand','18','Shipment delivery correction does not invent local stock');
select is(pg_temp.inventory()->>'reserved','0','Shipment delivery correction keeps consumed reservations');
select ok((select shipped_at is not null and fulfilled_at is null from public.orders where id=pg_temp.id('shipping')),'Sent date remains and delivered date clears');
select is(pg_temp.reverse('shipping','reverse_shipment')->>'fulfillmentState','pending','Shipment correction returns to pending');
select is(pg_temp.inventory()->>'onHand','20','Returned shipment restores local stock');
select is(pg_temp.inventory()->>'reserved','2','Returned shipment restores reservation');
select is(pg_temp.analytics()->>'revenueCents','305000','Fulfillment correction retains collection in sales');

insert into fixture values('cost',pg_temp.new_order());
select public.transition_order(pg_temp.id('cost'),'mark_at_cost');
select is(pg_temp.reverse('cost','reverse_payment')->>'saleType','cost','Cost sale retains its agreed price type');
select is(private.order_payload(pg_temp.id('cost'),true)->>'totalCents','205000','Cost sale retains cost plus shipping');
select is(private.order_payload(pg_temp.id('cost'),true)->>'taxAmountCents','0','Cost sale retains zero sale tax');
select public.transition_order(pg_temp.id('cost'),'mark_paid');
select is(private.order_payload(pg_temp.id('cost'),true)->>'totalCents','205000','Recollection does not turn cost sale into retail');

-- Packed units remain in the bag after a mistaken delivery. Cancellation must
-- wait until the operator physically unpacks and records it, as before.
select public.save_order_packing(pg_temp.id('shipping'),jsonb_build_array(jsonb_build_object('orderItemId',(select id from public.order_items where order_id=pg_temp.id('shipping')),'packedQuantity',2)),0);
select public.transition_order(pg_temp.id('shipping'),'mark_delivered');
select pg_temp.reverse('shipping','reverse_delivery');
select pg_temp.reverse('shipping','reverse_payment');
select throws_ok(format('select public.transition_order(%L,''cancel'')',pg_temp.id('shipping')),'P0001','CANNOT_CANCEL_PACKED_ORDER','Packed cancellation still requires recorded unpacking');
select public.save_order_packing(pg_temp.id('shipping'),jsonb_build_array(jsonb_build_object('orderItemId',(select id from public.order_items where order_id=pg_temp.id('shipping')),'packedQuantity',0)),1);
select public.transition_order(pg_temp.id('shipping'),'cancel');
select is(pg_temp.inventory()->>'onHand','20','Unpacking and cancelling restores no extra stock');

-- Awaiting incoming stock: payment reversal must preserve source and coverage.
insert into fixture values('purchase',public.create_purchase(jsonb_build_object('supplierName','Proveedor Correcciones','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',3,'unitCostCents',100000)))));
insert into fixture values('incoming',pg_temp.new_order('pickup','incoming_only'));
select public.transition_order(pg_temp.id('incoming'),'mark_paid');
select pg_temp.reverse('incoming','reverse_payment');
select is(private.order_payload(pg_temp.id('incoming'),true)->>'stockReadiness','waiting_incoming','Reversed collection preserves incoming coverage');
select is((select sum(quantity) from public.stock_reservations where order_id=pg_temp.id('incoming') and state='active' and source_type='incoming'),2::bigint,'Incoming reservation quantity stays intact');
select is((private.product_payload(pg_temp.id('product'),true)->>'incomingAvailable')::integer,1,'Incoming capacity remains committed');
select throws_ok(format('select public.reverse_order_action(%L,''reverse_delivery'',gen_random_uuid(),%s)',pg_temp.id('incoming'),pg_temp.rev('incoming')),'P0001','INVALID_TRANSITION','An unfulfilled order cannot invent a stock return');
select public.transition_order(pg_temp.id('incoming'),'cancel');
select is((private.product_payload(pg_temp.id('product'),true)->>'incomingAvailable')::integer,3,'Cancelling reversed incoming order restores supplier capacity');

-- Gifts keep their commercial classification until explicitly cancelled.
insert into fixture values('gift',pg_temp.new_order());
select public.transition_order(pg_temp.id('gift'),'mark_gifted');
select is(pg_temp.reverse('gift','reverse_delivery')->>'paymentState','gifted','Gift delivery correction preserves gift classification');
select throws_ok(format('select public.reverse_order_action(%L,''reverse_payment'',gen_random_uuid(),%s)',pg_temp.id('gift'),pg_temp.rev('gift')),'P0001','INVALID_TRANSITION','A gift cannot become an unpaid retail sale through collection correction');
select public.transition_order(pg_temp.id('gift'),'cancel');
select is(private.order_payload(pg_temp.id('gift'),true)->>'paymentState','refunded','Cancelling corrected gift removes assumed cost from active gifts');
select is(pg_temp.analytics()->>'giftCostCents','0','Cancelled corrected gift no longer contributes loss');

-- A missing consumed reservation on one line rejects the entire correction.
insert into fixture values('product2',public.save_product('{"sku":"REVERSAL_SECOND","slug":"reversal-second","name":"Segunda línea QA","presentation":"1 unidad","description":"Fixture aislado","category":"QA","priceCents":150000,"currentCostCents":100000,"reorderPoint":0,"safetyStock":0,"leadTimeDays":1,"imageUrl":"/test.svg","imageAlt":"Producto QA","featured":false,"published":true,"active":true}'));
select public.adjust_product_stock(pg_temp.id('product2'),5,'Fixture aislado');
insert into fixture values('multi',public.confirm_imported_order(jsonb_build_object('customerName','Cliente Múltiple','paymentMethod','cash','deliveryMethod','pickup','shippingFeeCents',0,'quotedSubtotalCents',300000,'quotedTotalCents',300000,'protocolOrderId',gen_random_uuid(),'protocolChecksum','1234ABCD','lines',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',1,'unitPriceCents',150000),jsonb_build_object('productId',pg_temp.id('product2'),'quantity',1,'unitPriceCents',150000)))));
select public.transition_order(pg_temp.id('multi'),'mark_delivered');
update public.stock_reservations set state='released' where order_id=pg_temp.id('multi') and product_id=pg_temp.id('product2');
insert into fixture values('multi_before',private.order_payload(pg_temp.id('multi'),true));
insert into fixture values('stock_before',pg_temp.inventory());
select throws_ok(format('select public.reverse_order_action(%L,''reverse_delivery'',gen_random_uuid(),%s)',pg_temp.id('multi'),pg_temp.rev('multi')),'P0001','ORDER_REVERSAL_RESERVATIONS_MISMATCH','Ambiguous stock history rejects the whole reversal');
select is(pg_temp.inventory(),(select value from fixture where name='stock_before'),'Rejected multiple-product reversal leaves all stock unchanged');
select is(private.order_payload(pg_temp.id('multi'),true),(select value from fixture where name='multi_before'),'Rejected reversal leaves order and revision unchanged');
select is((select count(*) from public.order_action_reversals where order_id=pg_temp.id('multi')),0::bigint,'Rejected reversal leaves no successful audit event');
update public.stock_reservations set state='consumed' where order_id=pg_temp.id('multi') and product_id=pg_temp.id('product2');
select pg_temp.reverse('multi','reverse_delivery');
select public.transition_order(pg_temp.id('multi'),'cancel');
select is((select on_hand from public.stock_balances where product_id=pg_temp.id('product2')),5,'Successful multi-product correction restores every line exactly once');

select throws_ok(format('select public.reverse_order_action(%L,''reverse_payment'',null,%s)',pg_temp.id('cost'),pg_temp.rev('cost')),'P0001','ORDER_REVERSAL_CONFIRMATION_REQUIRED','Unreviewed correction is rejected');
select throws_ok(format('select public.transition_order_reviewed(%L,''cancel'',%s)',pg_temp.id('cost'),pg_temp.rev('cost')-1),'P0001','ORDER_ACTION_CHANGED','Stale forward confirmation is rejected');
select throws_ok(format('select public.transition_order_reviewed(%L,''mark_paid'',%s)',pg_temp.id('cost'),pg_temp.rev('cost')),'P0001','ORDER_REVERSAL_CONFIRMATION_REQUIRED','Reviewed collection also requires the accepted amount');
select ok(not has_function_privilege('anon','public.transition_order_reviewed(uuid,text,bigint,integer,bigint,bigint)','EXECUTE'),'Anonymous callers cannot use reviewed transitions');

-- Validate exported history and ledger reconciliation, including all cycles.
select is(jsonb_array_length(public.get_business_export_dataset()->'orderActionHistory'),(select count(*)::integer from public.order_action_reversals),'Business backup includes every correction');
select is((select sum(physical_delta) from public.stock_movements where product_id=pg_temp.id('product')),(select on_hand::bigint from public.stock_balances where product_id=pg_temp.id('product')),'All movement deltas reconcile physical balance');
select is((select sum(reserved_delta) from public.stock_movements where product_id=pg_temp.id('product')),(select reserved::bigint from public.stock_balances where product_id=pg_temp.id('product')),'All movement deltas reconcile reserved balance');
select is((select sum(quantity) from public.stock_reservations where product_id=pg_temp.id('product') and state='active' and source_type='physical'),(select reserved::bigint from public.stock_balances where product_id=pg_temp.id('product')),'Active physical reservations reconcile balance');
select ok(not has_function_privilege('anon','public.reverse_order_action(uuid,text,uuid,bigint)','EXECUTE'),'Anonymous callers cannot reverse orders');
select ok(not has_table_privilege('authenticated','public.order_action_reversals','INSERT'),'Authenticated callers cannot forge correction history');

insert into fixture values('staff_params',jsonb_build_object('id',pg_temp.id('cost'),'revision',pg_temp.rev('cost')));
grant select on fixture to authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000131002',true);
set local role authenticated;
select is((select count(*) from public.order_action_reversals),0::bigint,'Staff cannot read financial correction snapshots');
select ok(public.reverse_order_action((select (value->>'id')::uuid from fixture where name='staff_params'),'reverse_payment',gen_random_uuid(),(select (value->>'revision')::bigint from fixture where name='staff_params'))->'costTotalCents'='null'::jsonb,'Staff can correct collection without receiving financial costs');
select ok(public.reverse_order_action((select (value->>'id')::uuid from fixture where name='pickup'), 'reverse_delivery', (select (value->>'id')::uuid from fixture where name='reverse_input'), (select (value->>'revision')::bigint from fixture where name='reverse_input'))->'costTotalCents'='null'::jsonb,'Retry by staff never replays stored owner financial payload');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000131002',true);
update public.store_users set active=false where user_id='00000000-0000-4000-8000-000000131002';
select throws_ok(format('select public.reverse_order_action(%L,''reverse_payment'',gen_random_uuid(),%s)',pg_temp.id('cost'),pg_temp.rev('cost')),'P0001','FORBIDDEN','Inactive users cannot reverse orders');
set constraints all immediate;
select * from finish();
rollback;
