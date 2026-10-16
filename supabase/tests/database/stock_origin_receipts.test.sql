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

select public.update_purchase(jsonb_build_object('id',pg_temp.id('purchase'),'supplierName','Primero','expectedAt','2030-01-01T15:00:00Z','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',2,'unitCostCents',1070000))));
insert into fixture values('second',public.create_purchase(jsonb_build_object('supplierName','Segundo','expectedAt','2030-01-02T15:00:00Z','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',4,'unitCostCents',2000000)))));
insert into fixture values('future',public.confirm_imported_order(pg_temp.order_input('incoming_only',3)));
select is(jsonb_array_length(public.get_order_stock_context(pg_temp.id('future'))->'items'->0->'purchases'),2,'A future order can retain two distinct assigned purchases');
select public.receive_purchase(pg_temp.id('second'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='second'),'receivedQuantity',1)),gen_random_uuid());
select is((private.order_payload(pg_temp.id('future'),true)->'items'->0->>'physicalReservedQuantity')::integer,1,'Receiving the second assigned purchase promotes only its own one unit');
select is((select on_hand-reserved from stock_balances where product_id=pg_temp.id('product')),4,'Unrelated previous shelf stock remains free');
select public.save_order_packing(pg_temp.id('future'),jsonb_build_array(jsonb_build_object('orderItemId',private.order_payload(pg_temp.id('future'),true)->'items'->0->>'id','packedQuantity',1)),0);
select public.transition_order(pg_temp.id('future'),'mark_paid');
select public.receive_purchase(pg_temp.id('purchase'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='purchase'),'receivedQuantity',1)),gen_random_uuid());
select is((private.order_payload(pg_temp.id('future'),true)->'items'->0->>'incomingQuantity')::integer,1,'Receiving the first purchase still preserves its missing one unit');
insert into fixture values('replacement_result',public.cancel_purchase(pg_temp.id('purchase'),'No completa el envio',gen_random_uuid(),public.get_purchase_cancellation_preview(pg_temp.id('purchase'))->>'reviewToken',jsonb_build_object('supplierName','Reposicion','expectedAt','2030-01-03T15:00:00Z')));
insert into fixture values('replacement',(select value->'replacementPurchase' from fixture where name='replacement_result'));
select is((public.get_order_stock_context(pg_temp.id('future'))->'items'->0->'purchases'->0->>'id'),pg_temp.id('replacement')::text,'After cancellation the explanation points to the replacement purchase');
select is(private.order_payload(pg_temp.id('future'),true)->>'stockSource','incoming_only','Replacing a supplier preserves the chosen stock origin');
select public.receive_purchase(pg_temp.id('replacement'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='replacement'),'receivedQuantity',1)),gen_random_uuid());
select is(private.order_payload(pg_temp.id('future'),true)->>'stockReadiness','ready','Receiving replacement unlocks exactly the pending unit');
select is(private.order_payload(pg_temp.id('future'),true)->>'paymentState','paid','Supplier change preserves customer payment');
select is((private.order_payload(pg_temp.id('future'),true)->'items'->0->>'packedQuantity')::integer,1,'Supplier change and receipt preserve previously packed units');
select is((private.order_payload(pg_temp.id('future'),true)->>'costTotalCents')::bigint,4140000::bigint,'Distinct supplier lots preserve exact historical cost');
select is((select on_hand-reserved from stock_balances where product_id=pg_temp.id('product')),4,'Replacement does not consume the previous free physical stock');
-- A normal order can consume old free units without accidentally expanding an arriving budget.
insert into fixture values('normal',public.confirm_imported_order(pg_temp.order_input('normal',4)));
insert into fixture values('future_more',public.confirm_imported_order(pg_temp.order_input('incoming_only',2)));
insert into fixture values('normal_wait',public.confirm_imported_order(pg_temp.order_input('normal',1)));
select public.receive_purchase(pg_temp.id('second'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='second'),'receivedQuantity',1)),gen_random_uuid());
select is((private.order_payload(pg_temp.id('future_more'),true)->'items'->0->>'physicalReservedQuantity')::integer,1,'A one-unit receipt cannot promote two explicit future units');
select is(private.order_payload(pg_temp.id('normal_wait'),true)->>'stockReadiness','waiting_incoming','The same receipt cannot allocate one unit twice');
select is((select sum(quantity) from stock_reservations where product_id=pg_temp.id('product') and state='active' and source_type='physical'),(select reserved::bigint from stock_balances where product_id=pg_temp.id('product')),'Multiple purchases and replacement leave physical reservations balanced');
select is((select sum(reserved_delta) from stock_movements where product_id=pg_temp.id('product')),(select reserved::bigint from stock_balances where product_id=pg_temp.id('product')),'Multiple purchases and replacement leave reservation history balanced');
select * from finish();
rollback;
