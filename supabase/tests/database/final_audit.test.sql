begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions,pg_temp;
select plan(19);

insert into auth.users(id,email,raw_user_meta_data) values
('00000000-0000-4000-8000-000000008801','audit-owner@example.test','{"display_name":"Audit Owner"}'),
('00000000-0000-4000-8000-000000008802','audit-staff@example.test','{"display_name":"Audit Staff"}');
update store_users set active=true,role='owner' where user_id='00000000-0000-4000-8000-000000008801';
update store_users set active=true,role='staff' where user_id='00000000-0000-4000-8000-000000008802';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000008801',true);

insert into orders(customer_name_snapshot,customer_phone_snapshot,payment_method,delivery_method,subtotal_cents,shipping_fee_cents,total_cents,tax_rate_basis_points,tax_amount_cents,cost_total_cents,created_at,payment_state,fulfillment_state,created_by,source)
select 'Auditoría historial '||n,'+54 9 11 1234 5678','cash','pickup',100,0,100,350,4,50,now()-n*interval '1 minute',
  (case when n%2=0 then 'paid' else 'pending' end)::payment_state,
  (case when n%2=0 then 'delivered' else 'pending' end)::fulfillment_state,'00000000-0000-4000-8000-000000008801','manual'
from generate_series(1,61) n;

select is((search_orders(1,50,'Auditoría historial','all')->>'total')::integer,61,'Cuenta todo el historial, no solo la primera página');
select is(jsonb_array_length(search_orders(1,50,'Auditoría historial','all')->'items'),50,'La página está acotada');
select is((search_orders(1,50,'Auditoría historial 61','all')->'items'->0->>'customerName'),'Auditoría historial 61','Encuentra un pedido fuera de los primeros 50');
select is((search_orders(1,50,'Auditoría historial','pending')->>'total')::integer,31,'Filtra pendientes antes de paginar');
select is((search_orders(1,50,'Auditoría historial','completed')->>'completedTotal')::integer,30,'Contadores globales de completados');
select is((search_orders(1,50,'11 1234 5678','all')->>'total')::integer,61,'Acepta teléfonos con separadores');
select isnt(get_public_store_settings()->>'taxRateBasisPoints',null::text,'Dueña puede leer su impuesto');

update orders set paid_at='2026-08-15T12:00:00-03:00' where customer_name_snapshot like 'Auditoría historial %' and payment_state='paid';
select is((search_paid_orders(1,20,'2026-09-01','2026-09-30')->>'total')::integer,0,'El período de ventas excluye cobros anteriores');

insert into products(id,sku,slug,name,presentation,sale_price_cents) values ('00000000-0000-4000-8000-000000008899','STOCKAUDIT','stock-audit','Stock audit','Unidad',100);
insert into stock_balances(product_id,on_hand) values('00000000-0000-4000-8000-000000008899',10);
select adjust_product_stock('00000000-0000-4000-8000-000000008899',-1,'Salida posterior a abrir el conteo');
select throws_ok($$select adjust_product_stock_checked('00000000-0000-4000-8000-000000008899',-1,'Conteo físico de nueve unidades',10)$$,'P0001','STALE_STOCK_COUNT','Un conteo antiguo no modifica una entrega posterior');
select is((select on_hand from stock_balances where product_id='00000000-0000-4000-8000-000000008899'),9,'La corrección rechazada conserva las nueve unidades');
select lives_ok($$select adjust_product_stock_checked('00000000-0000-4000-8000-000000008899',1,'Conteo revisado',9)$$,'Una corrección con stock actualizado funciona');
select is((select on_hand from stock_balances where product_id='00000000-0000-4000-8000-000000008899'),10,'El conteo revisado se aplica una sola vez');

insert into customers(id,name,phone) values
('00000000-0000-4000-8000-000000008811','Cliente con igual nombre','1155550011'),
('00000000-0000-4000-8000-000000008812','Cliente con igual nombre','1155550012');
update orders set customer_id='00000000-0000-4000-8000-000000008811'
where customer_name_snapshot like 'Auditoría historial %' and split_part(customer_name_snapshot,' ',3)::int>=41;
insert into orders(customer_id,customer_name_snapshot,payment_method,delivery_method,subtotal_cents,total_cents,tax_rate_basis_points,tax_amount_cents,cost_total_cents,created_by,source)
select '00000000-0000-4000-8000-000000008812','Cliente con igual nombre','cash','pickup',100,100,350,4,50,'00000000-0000-4000-8000-000000008801','manual'
from generate_series(1,101);
select is((list_customer_orders('00000000-0000-4000-8000-000000008811',1,20)->>'total')::int,21,'Cliente conserva todo su historial aunque haya 101 pedidos más nuevos de otra persona');
select is(jsonb_array_length(list_customer_orders('00000000-0000-4000-8000-000000008811',1,20)->'items'),20,'Historial del cliente pagina en el servidor');
select is(list_customer_orders('00000000-0000-4000-8000-000000008811',2,20)->'items'->0->>'customerName','Auditoría historial 61','La segunda página incluye el pedido antiguo');
select is((list_customer_orders('00000000-0000-4000-8000-000000008812',1,20)->>'total')::int,101,'El historial no mezcla clientes con el mismo nombre');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000008802',true);
set local role authenticated;
select is(get_public_store_settings()->>'taxRateBasisPoints',null::text,'Personal no obtiene impuesto desde la RPC pública');
select is(search_orders(1,50,'Auditoría historial 61','all')->'items'->0->>'costTotalCents',null::text,'Personal encuentra pedidos sin costos');
select is(list_customer_orders('00000000-0000-4000-8000-000000008811',2,20)->'items'->0->>'costTotalCents',null::text,'Personal puede consultar el historial antiguo sin costos');
reset role;
select * from finish();
rollback;
