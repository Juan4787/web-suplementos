begin;
do $$ begin
  if current_database() !~ '^rigorous_ux_shipping_' or not exists(select 1 from staging_guard.identity where task='shipping-20261010') then
    raise exception 'DISPOSABLE_LOCAL_DATABASE_REQUIRED';
  end if;
end $$;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select no_plan();
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000101001','shipping-owner@test.local'),
 ('00000000-0000-4000-8000-000000101002','shipping-staff@test.local');
update public.store_users set active=true,role='owner' where user_id='00000000-0000-4000-8000-000000101001';
update public.store_users set active=true,role='staff' where user_id='00000000-0000-4000-8000-000000101002';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000101001',true);
create temp table fixture(name text primary key, value jsonb);
insert into fixture values('product',public.save_product('{"sku":"SHIPPING_TEST","slug":"shipping-test","name":"Prueba de envío","presentation":"1 unidad","description":"Fixture aislado","category":"Pruebas","priceCents":150000,"currentCostCents":100000,"reorderPoint":0,"safetyStock":0,"leadTimeDays":1,"imageUrl":"/test.svg","imageAlt":"Producto de prueba","featured":false,"published":true,"active":true}'));
select public.adjust_product_stock((select (value->>'id')::uuid from fixture where name='product'),4,'Fixture aislado');
insert into fixture values('purchase',public.create_purchase(jsonb_build_object('supplierName','Pruebas','items',jsonb_build_array(jsonb_build_object('productId',(select value->>'id' from fixture where name='product'),'quantity',10,'unitCostCents',1070000)))));
create function pg_temp.order_input(source text, qty integer, protocol uuid default gen_random_uuid()) returns jsonb language sql as $$
 select jsonb_build_object('stockSource',source,'customerName','Cliente Pruebas','paymentMethod','cash','deliveryMethod','pickup','shippingType',null,'shippingFeeCents',0,'quotedSubtotalCents',150000*qty,'quotedTotalCents',150000*qty,'protocolOrderId',protocol,'protocolChecksum','1234ABCD','lines',jsonb_build_array(jsonb_build_object('productId',(select value->>'id' from fixture where name='product'),'quantity',qty,'unitPriceCents',150000)));
$$;
create function pg_temp.id(name text) returns uuid language sql as $$ select (value->>'id')::uuid from fixture where fixture.name=$1 $$;

insert into fixture values('future',public.confirm_imported_order(pg_temp.order_input('incoming_only',3)));
select public.adjust_product_stock(pg_temp.id('product'),1,'Conteo de comprobacion');
select is((select reserved from stock_balances where product_id=pg_temp.id('product')),0,'Positive adjustment preserves explicit future stock');
insert into fixture values('normal',public.confirm_imported_order(pg_temp.order_input('normal',1)));
select public.transition_order(pg_temp.id('normal'),'cancel');
select is((select reserved from stock_balances where product_id=pg_temp.id('product')),0,'Cancellation cannot silently consume explicit future stock');
insert into fixture values('other',public.create_purchase(jsonb_build_object('supplierName','Otro proveedor','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',1,'unitCostCents',500000)))));
select public.receive_purchase(pg_temp.id('other'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='other'),'receivedQuantity',1)),gen_random_uuid());
select is((select reserved from stock_balances where product_id=pg_temp.id('product')),0,'An unrelated receipt does not consume explicit future reservations');
select is(private.order_payload(pg_temp.id('future'),true)->>'stockReadiness','waiting_incoming','Explicit future order still waits for its purchase');
select public.receive_purchase(pg_temp.id('purchase'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='purchase'),'receivedQuantity',2)),gen_random_uuid());
select is((select reserved from stock_balances where product_id=pg_temp.id('product')),2,'Only two actually received units become physically reserved');
select is((select on_hand-reserved from stock_balances where product_id=pg_temp.id('product')),6,'Previous free physical stock remains free');
select is((select sum(quantity) from stock_reservations where order_id=pg_temp.id('future') and state='active' and source_type='incoming'),1::bigint,'Partial receipt preserves the unreceived future unit');
select is((private.order_payload(pg_temp.id('future'),true)->>'costTotalCents')::bigint,3210000::bigint,'Other supplier cost does not rewrite historical order cost');
select is(private.order_payload(pg_temp.id('future'),true)->>'packingTracked','false','Physical assignment does not invent a packing count');
select public.save_order_packing(pg_temp.id('future'),jsonb_build_array(jsonb_build_object('orderItemId',private.order_payload(pg_temp.id('future'),true)->'items'->0->>'id','packedQuantity',2)),0);
insert into fixture values('context',public.get_order_stock_context(pg_temp.id('future')));
select is((select value->'items'->0->>'onHand' from fixture where name='context'),'8','Context gives the physical total');
select is((select value->'items'->0->>'physicalQuantity' from fixture where name='context'),'2','Context gives this order allocation');
select is((select value->'items'->0->>'available' from fixture where name='context'),'6','Context distinguishes free physical stock');
select is((select value->'items'->0->'purchases'->0->>'reservedQuantity' from fixture where name='context'),'1','Context identifies only the remaining purchase commitment');
select is((select value->'items'->0->'purchases'->0->>'incomingQuantity' from fixture where name='context'),'1','Context separates units attached to an open purchase');
select is((select value->'items'->0->'purchases'->0->>'uncoveredQuantity' from fixture where name='context'),'0','Context does not count covered units as uncovered');
select is((select value->'items'->0->'purchases'->0->>'id' from fixture where name='context'),pg_temp.id('purchase')::text,'Context identifies the exact assigned purchase');
select ok((select value::text !~ '(Cost|Cents|customer|Phone)' from fixture where name='context'),'Context does not expose financial or customer identity data');
select is(public.get_purchase(pg_temp.id('purchase'))->>'id',pg_temp.id('purchase')::text,'Direct purchase lookup does not depend on list pagination');
select public.receive_purchase(pg_temp.id('purchase'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='purchase'),'receivedQuantity',1)),gen_random_uuid());
select is((private.order_payload(pg_temp.id('future'),true)->'items'->0->>'packedQuantity')::integer,2,'Later receipt preserves the saved bag count');
select is(private.order_payload(pg_temp.id('future'),true)->>'stockReadiness','ready','Receiving all assigned units unblocks the future order');
select is((select on_hand-reserved from stock_balances where product_id=pg_temp.id('product')),6,'Final receipt still preserves unrelated free stock');
-- Normal FIFO remains global across purchases, without stealing existing physical reservations.
insert into fixture values('shelf',public.confirm_imported_order(pg_temp.order_input('normal',6)));
insert into fixture values('older',public.confirm_imported_order(pg_temp.order_input('normal',1)));
insert into fixture values('newer',public.confirm_imported_order(pg_temp.order_input('normal',1)));
insert into fixture values('different',public.create_purchase(jsonb_build_object('supplierName','Tercer proveedor','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',1,'unitCostCents',800000)))));
select public.receive_purchase(pg_temp.id('different'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='different'),'receivedQuantity',1)),gen_random_uuid());
select is(private.order_payload(pg_temp.id('older'),true)->>'stockReadiness','ready','An unrelated receipt still serves the oldest normal order');
select is(private.order_payload(pg_temp.id('newer'),true)->>'stockReadiness','waiting_incoming','Younger normal order cannot jump the queue');
select is((private.order_payload(pg_temp.id('shelf'),true)->'items'->0->>'physicalReservedQuantity')::integer,6,'Existing physical reservations are preserved');
select public.transition_order(pg_temp.id('older'),'cancel');
select is(private.order_payload(pg_temp.id('newer'),true)->>'stockReadiness','ready','Cancelling a physical order still promotes the next normal order');
select is((public.get_order_stock_context(pg_temp.id('newer'))->'items'->0->>'otherReservedQuantity')::integer,9,'Context separates units committed to other orders');
select is((select sum(reserved_delta) from stock_movements where product_id=pg_temp.id('product')),(select reserved::bigint from stock_balances where product_id=pg_temp.id('product')),'Reservation movement history matches the balance');
select is((select sum(physical_delta) from stock_movements where product_id=pg_temp.id('product')),(select on_hand::bigint from stock_balances where product_id=pg_temp.id('product')),'Physical movement history matches the balance');
select is((select sum(quantity) from stock_reservations where product_id=pg_temp.id('product') and state='active' and source_type='physical'),(select reserved::bigint from stock_balances where product_id=pg_temp.id('product')),'Active physical reservations match balance');
-- Compatibility fixture: an uncovered historical commitment and a genuinely
-- pending unit can share the same purchase while that purchase is still open.
insert into fixture values('mixed',public.confirm_imported_order(pg_temp.order_input('incoming_only',2)));
insert into public.stock_reservations(order_id,order_item_id,product_id,quantity,state,source_type,purchase_item_id,cost_snapshot_cents,is_opening)
  select order_id,order_item_id,product_id,1,state,'uncovered',purchase_item_id,cost_snapshot_cents,is_opening
  from public.stock_reservations where order_id=pg_temp.id('mixed') and state='active' and source_type='incoming';
update public.stock_reservations set quantity=1 where order_id=pg_temp.id('mixed') and state='active' and source_type='incoming';
create temp table before_context as select jsonb_build_object(
  'balances',(select jsonb_agg(to_jsonb(b) order by product_id) from stock_balances b),
  'reservations',(select jsonb_agg(to_jsonb(r) order by id) from stock_reservations r),
  'order',(select to_jsonb(o) from orders o where id=pg_temp.id('mixed')),
  'items',(select jsonb_agg(to_jsonb(i) order by id) from order_items i where order_id=pg_temp.id('mixed'))
) snapshot;
insert into fixture values('mixed_context',public.get_order_stock_context(pg_temp.id('mixed')));
select is((select value->'items'->0->>'incomingQuantity' from fixture where name='mixed_context'),'1','Mixed context preserves the actually covered unit');
select is((select value->'items'->0->>'uncoveredQuantity' from fixture where name='mixed_context'),'1','Mixed context preserves the unit without a supplier');
select is((select value->'items'->0->'purchases'->0->>'state' from fixture where name='mixed_context'),'ordered','A historical shortage can remain linked to an open purchase');
select is((select value->'items'->0->'purchases'->0->>'incomingQuantity' from fixture where name='mixed_context'),'1','Purchase detail does not call an uncovered unit incoming');
select is((select value->'items'->0->'purchases'->0->>'uncoveredQuantity' from fixture where name='mixed_context'),'1','Purchase detail identifies the historical shortage separately');
select is((select value->'items'->0->'purchases'->0->>'reservedQuantity' from fixture where name='mixed_context'),'2','The additive response preserves the old aggregate for existing clients');
select is(jsonb_build_object(
  'balances',(select jsonb_agg(to_jsonb(b) order by product_id) from stock_balances b),
  'reservations',(select jsonb_agg(to_jsonb(r) order by id) from stock_reservations r),
  'order',(select to_jsonb(o) from orders o where id=pg_temp.id('mixed')),
  'items',(select jsonb_agg(to_jsonb(i) order by id) from order_items i where order_id=pg_temp.id('mixed'))
),(select snapshot from before_context),'Reading the detail leaves stock, reservations, packing, payments and order revisions unchanged');
select throws_ok($$select public.get_order_stock_context(gen_random_uuid())$$,'P0001','ORDER_NOT_FOUND','Unknown order returns a defined error');
select throws_ok($$select public.get_purchase(gen_random_uuid())$$,'P0001','PURCHASE_NOT_FOUND','Unknown purchase returns a defined error');
select ok(not has_function_privilege('anon','public.get_order_stock_context(uuid)','EXECUTE'),'Anonymous context access denied');
select ok(not has_function_privilege('authenticated','private.allocate_product_stock(uuid,uuid,integer)','EXECUTE'),'Internal allocator cannot be called by application users');
select ok(not has_function_privilege('authenticated','private.repair_cancelled_reservation_history()','EXECUTE'),'Historical repair cannot be called by application users');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000101002',true);
select is(public.get_order_stock_context(pg_temp.id('newer'))->>'orderId',pg_temp.id('newer')::text,'Active staff can understand a blocked order without financial access');
select throws_ok($$select public.get_purchase(pg_temp.id('purchase'))$$,'P0001','FORBIDDEN','Staff cannot open private purchase details');
update store_users set active=false where user_id='00000000-0000-4000-8000-000000101002';
select throws_ok($$select public.get_order_stock_context(pg_temp.id('newer'))$$,'P0001','FORBIDDEN','Disabled staff cannot inspect allocations');
select * from finish();
rollback;
