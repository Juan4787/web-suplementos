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

insert into fixture values('cancel_a',public.confirm_imported_order(pg_temp.order_input('normal',1)));
insert into fixture values('cancel_b',public.confirm_imported_order(pg_temp.order_input('normal',2)));
select public.transition_order(pg_temp.id('cancel_a'),'cancel');
select public.transition_order(pg_temp.id('cancel_b'),'cancel');
-- Simulate old incomplete movement history without changing valid current stock.
insert into stock_movements(product_id,product_name_snapshot,kind,physical_delta,reserved_delta,reason,order_id,created_by)
select pg_temp.id('product'),'Prueba de historia','reservation',0,1,'Registro historico incompleto',pg_temp.id(key),'00000000-0000-4000-8000-000000101001'::uuid from (values('cancel_a'),('cancel_b')) keys(key);
create temp table before_history as select id,md5(to_jsonb(sm)::text) hash from stock_movements sm;
create temp table before_balances as select md5(to_jsonb(sb)::text) hash from stock_balances sb;
create temp table before_orders as select id,md5(to_jsonb(o)::text) hash from orders o;
create temp table before_reservations as select id,md5(to_jsonb(sr)::text) hash from stock_reservations sr;
select is(private.repair_cancelled_reservation_history(),2,'Repair accounts for each cancelled order exactly once');
select is((select count(*) from private.reservation_history_repairs),2::bigint,'Each correction has private evidence');
select is((select sum(physical_delta) from stock_movements where id in(select movement_id from private.reservation_history_repairs)),0::bigint,'History corrections never add physical stock');
select is((select sum(reserved_delta) from stock_movements where id in(select movement_id from private.reservation_history_repairs)),-2::bigint,'History corrections release only unexplained cancelled reservations');
select is((select count(*) from before_history b join stock_movements sm on sm.id=b.id where b.hash<>md5(to_jsonb(sm)::text)),0::bigint,'Original movement evidence is immutable');
select is((select count(*) from stock_balances sb where md5(to_jsonb(sb)::text) not in(select hash from before_balances)),0::bigint,'Stock balances remain identical');
select is((select count(*) from before_orders b join orders o on o.id=b.id where b.hash<>md5(to_jsonb(o)::text)),0::bigint,'Customer orders remain identical');
select is((select count(*) from before_reservations b join stock_reservations sr on sr.id=b.id where b.hash<>md5(to_jsonb(sr)::text)),0::bigint,'Actual reservation rows remain identical');
select is(private.repair_cancelled_reservation_history(),0,'Repeating repair produces no duplicate entries');
select is((select sum(reserved_delta) from stock_movements where product_id=pg_temp.id('product')),(select reserved::bigint from stock_balances where product_id=pg_temp.id('product')),'Repaired history agrees with current reserved balance');
select ok((select bool_and(before_snapshot->'movements' is not null and corrected_quantity=1) from private.reservation_history_repairs),'Before evidence includes original movements and exact quantity');
select ok(not has_table_privilege('authenticated','private.reservation_history_repairs','SELECT'),'Application accounts cannot read private repair evidence');
insert into fixture values('active',public.confirm_imported_order(pg_temp.order_input('normal',1)));
insert into stock_movements(product_id,product_name_snapshot,kind,physical_delta,reserved_delta,reason,order_id,created_by)
values(pg_temp.id('product'),'Prueba de historia','reservation',0,1,'Diferencia no explicada',pg_temp.id('active'),'00000000-0000-4000-8000-000000101001');
select throws_ok($$select private.repair_cancelled_reservation_history()$$,'P0001','RESERVATION_HISTORY_REQUIRES_MANUAL_REVIEW','Unexplained active-order difference cannot be papered over');
select is((select count(*) from private.reservation_history_repairs),2::bigint,'Rejected repair adds no partial evidence');
select is((select reserved from stock_balances where product_id=pg_temp.id('product')),1,'Rejected repair cannot alter valid active reservations');
select * from finish();
rollback;
