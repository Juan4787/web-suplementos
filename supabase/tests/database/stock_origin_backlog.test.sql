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
create function pg_temp.order_input(source text, qty integer, protocol uuid default gen_random_uuid()) returns jsonb language sql as $$
 select jsonb_build_object('stockSource',source,'customerName','Cliente Pruebas','paymentMethod','cash','deliveryMethod','pickup','shippingType',null,'shippingFeeCents',0,'quotedSubtotalCents',150000*qty,'quotedTotalCents',150000*qty,'protocolOrderId',protocol,'protocolChecksum','1234ABCD','lines',jsonb_build_array(jsonb_build_object('productId',(select value->>'id' from fixture where name='product'),'quantity',qty,'unitPriceCents',150000)));
$$;
create function pg_temp.id(name text) returns uuid language sql as $$ select (value->>'id')::uuid from fixture where fixture.name=$1 $$;


insert into fixture values('first',public.create_purchase(jsonb_build_object('supplierName','Primero','expectedAt','2030-01-01T15:00:00Z','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',1,'unitCostCents',100000)))));
insert into fixture values('older',public.confirm_imported_order(pg_temp.order_input('normal',1)));
insert into fixture values('second',public.create_purchase(jsonb_build_object('supplierName','Segundo','expectedAt','2030-01-02T15:00:00Z','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',1,'unitCostCents',100000)))));
insert into fixture values('future',public.confirm_imported_order(pg_temp.order_input('incoming_only',1)));
create function pg_temp.fail_rebinding() returns trigger language plpgsql as $$ begin
  if new.order_id=pg_temp.id('future') and new.source_type='incoming' and new.purchase_item_id=(select (value->'items'->0->>'id')::uuid from fixture where name='first') then
    raise exception 'TEST_REBINDING_FAILURE';
  end if;
  return new;
end $$;
create trigger test_rebinding_failure before insert on public.stock_reservations for each row execute function pg_temp.fail_rebinding();
select throws_ok(format('select public.receive_purchase(%L,%L::jsonb,%L)',pg_temp.id('second'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='second'),'receivedQuantity',1)),'00000000-0000-4000-8000-000000162001'),'P0001','TEST_REBINDING_FAILURE','A rebinding failure rolls back the whole receipt');
select is((select on_hand from stock_balances where product_id=pg_temp.id('product')),0,'A failed reassignment does not introduce physical stock');
select is((select reserved from stock_balances where product_id=pg_temp.id('product')),0,'A failed reassignment does not leave physical reservations');
select is((select received_quantity from purchase_items where purchase_id=pg_temp.id('second')),0,'A failed reassignment leaves supplier receipt quantities unchanged');
select is((select count(*) from purchase_receipts where operation_id='00000000-0000-4000-8000-000000162001'),0::bigint,'A failed reassignment does not store a successful retry result');
drop trigger test_rebinding_failure on public.stock_reservations;
select public.receive_purchase(pg_temp.id('second'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='second'),'receivedQuantity',1)),gen_random_uuid());

select is(private.order_payload(pg_temp.id('older'),true)->>'stockReadiness','ready','Normal global FIFO still serves the older sale');
select is(private.order_payload(pg_temp.id('future'),true)->>'stockReadiness','waiting_incoming','The younger explicit order keeps its pending quantity');
select is((public.get_order_stock_context(pg_temp.id('future'))->'items'->0->'purchases'->0->>'id'),pg_temp.id('first')::text,'Pending supplier promise follows the genuinely freed capacity');
select is((select count(*) from stock_reservations sr join purchase_items pi on pi.id=sr.purchase_item_id join purchases p on p.id=pi.purchase_id where sr.state='active' and sr.source_type='incoming' and p.state<>'ordered'),0::bigint,'No active incoming reservation points to a closed purchase');
select is(private.order_payload(pg_temp.id('future'),true)->>'costTotalCents','100000','Rebinding preserves the original promised cost');
select public.receive_purchase(pg_temp.id('first'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='first'),'receivedQuantity',1)),gen_random_uuid());
select is(private.order_payload(pg_temp.id('future'),true)->>'stockReadiness','ready','The reallocated explicit future order becomes available when its new source arrives');
-- Partial over-capacity splits preserve the earlier promise and historical costs.
insert into fixture values('third',public.create_purchase(jsonb_build_object('supplierName','Tercero','expectedAt','2030-01-03T15:00:00Z','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',2,'unitCostCents',200000)))));
insert into fixture values('normal_more',public.confirm_imported_order(pg_temp.order_input('normal',2)));
insert into fixture values('fourth',public.create_purchase(jsonb_build_object('supplierName','Cuarto','expectedAt','2030-01-04T15:00:00Z','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',2,'unitCostCents',300000)))));
insert into fixture values('future_more',public.confirm_imported_order(pg_temp.order_input('incoming_only',2)));
insert into fixture values('partial_result',public.receive_purchase(pg_temp.id('fourth'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='fourth'),'receivedQuantity',1)),gen_random_uuid()));
select is((select value->'reassignedOrders'->0->>'number' from fixture where name='partial_result'),private.order_payload(pg_temp.id('future_more'),true)->>'number','Receipt explicitly reports the pending order whose supplier changed');
select is(jsonb_array_length(public.get_order_stock_context(pg_temp.id('future_more'))->'items'->0->'purchases'),2,'Partial receipt splits pending promises across two purchases');
select is((select sum(sr.quantity) from stock_reservations sr join purchase_items pi on pi.id=sr.purchase_item_id where sr.order_id=pg_temp.id('future_more') and sr.state='active' and sr.source_type='incoming' and pi.purchase_id=pg_temp.id('fourth')),1::bigint,'Only the actual excess is rebound');
select is(private.order_payload(pg_temp.id('future_more'),true)->>'costTotalCents','600000','Split pending promises preserve all historical cost');
select ok(not has_function_privilege('authenticated','private.rebind_receipt_pending(uuid)','EXECUTE'),'Application users cannot invoke pending rebinding');
-- A prior supplier failure can leave a normal sale uncovered. Its older priority
-- must not turn a younger reservation into an imaginary incoming promise.
insert into fixture values('gap_product',public.save_product('{"sku":"GAP_TEST","slug":"gap-test","name":"Prueba de faltante","presentation":"1 unidad","description":"Fixture aislado","category":"Pruebas","priceCents":150000,"currentCostCents":100000,"reorderPoint":0,"safetyStock":0,"leadTimeDays":1,"imageUrl":"/test.svg","imageAlt":"Prueba","featured":false,"published":true,"active":true}'));
-- Reuse the order-input helper by swapping only the fixture pointer.
update fixture set value=(select value from fixture where name='gap_product') where name='product';
insert into fixture values('gap_purchase',public.create_purchase(jsonb_build_object('supplierName','Incumplidor','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',1,'unitCostCents',100000)))));
insert into fixture values('gap_order',public.confirm_imported_order(pg_temp.order_input('normal',1)));
-- Historical uncovered fixture; current public shortage actions prohibit discarding active promises.
update public.stock_reservations set source_type='uncovered' where order_id=pg_temp.id('gap_order') and state='active';
update public.purchase_items set shortage_quantity=quantity where purchase_id=pg_temp.id('gap_purchase');
update public.purchases set state='received',received_at=now() where id=pg_temp.id('gap_purchase');
insert into fixture values('gap_new',public.create_purchase(jsonb_build_object('supplierName','Nuevo','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',1,'unitCostCents',200000)))));
insert into fixture values('gap_future',public.confirm_imported_order(pg_temp.order_input('incoming_only',1)));
insert into fixture values('gap_result',public.receive_purchase(pg_temp.id('gap_new'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='gap_new'),'receivedQuantity',1)),gen_random_uuid()));
select is(private.order_payload(pg_temp.id('gap_order'),true)->>'stockReadiness','ready','An older uncovered normal sale keeps its established allocation priority');
select is(private.order_payload(pg_temp.id('gap_future'),true)->>'stockReadiness','uncovered','A missing supplier is reported as uncovered instead of fake incoming');
select is((select value->'reassignedOrders'->0->>'uncoveredQuantity' from fixture where name='gap_result'),'1','Receipt informs exactly how many pending units lost supplier coverage');
select is(private.order_payload(pg_temp.id('gap_future'),true)->>'costTotalCents','200000','Even uncovered fallback retains historical cost');
select is((select count(*) from (select pi.id,pi.quantity-pi.received_quantity-pi.shortage_quantity capacity,coalesce(sum(sr.quantity),0) reserved from purchase_items pi left join stock_reservations sr on sr.purchase_item_id=pi.id and sr.state='active' and sr.source_type='incoming' group by pi.id) p where p.reserved>p.capacity),0::bigint,'All pending promises fit actual supplier capacity');
insert into fixture values('rescue',public.create_purchase(jsonb_build_object('supplierName','Reposición real','items',jsonb_build_array(jsonb_build_object('productId',pg_temp.id('product'),'quantity',1,'unitCostCents',300000)))));
select public.adjust_product_stock(pg_temp.id('product'),2,'Conteo posterior');
select is(private.order_payload(pg_temp.id('gap_future'),true)->>'stockReadiness','uncovered','An uncovered future sale still cannot absorb previous shelf stock');
select public.receive_purchase(pg_temp.id('rescue'),jsonb_build_array(jsonb_build_object('purchaseItemId',(select value->'items'->0->>'id' from fixture where name='rescue'),'receivedQuantity',1)),gen_random_uuid());
select is(private.order_payload(pg_temp.id('gap_future'),true)->>'stockReadiness','ready','A genuine new arrival resolves uncovered future units without an imaginary supplier link');
select is((select on_hand-reserved from stock_balances where product_id=pg_temp.id('product')),2,'Rescuing uncovered future stock preserves the previous free shelf stock');
select * from finish();
rollback;
