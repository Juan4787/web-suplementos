begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions,pg_temp;
select plan(34);
insert into auth.users(id,email,raw_user_meta_data) values
('00000000-0000-4000-8000-000000009911','opening-owner@example.test','{"display_name":"Opening Owner"}'),
('00000000-0000-4000-8000-000000009912','opening-staff@example.test','{"display_name":"Opening Staff"}');
update store_users set active=true,role='owner' where user_id='00000000-0000-4000-8000-000000009911';
update store_users set active=true,role='staff' where user_id='00000000-0000-4000-8000-000000009912';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009911',true);
insert into products(id,sku,slug,name,presentation,sale_price_cents,published)
values('00000000-0000-4000-8000-000000009913','OPENING_TEST','opening-test','Opening test','Unidad',10000,true);
insert into stock_balances(product_id) values('00000000-0000-4000-8000-000000009913');
insert into product_financials(product_id,current_cost_cents) values('00000000-0000-4000-8000-000000009913',5000);
select (create_purchase(jsonb_build_object('supplierName','Proveedor local','items',jsonb_build_array(
  jsonb_build_object('productId','00000000-0000-4000-8000-000000009913','quantity',10,'unitCostCents',5000)
)))->>'id') purchase_id \gset
select id purchase_item_id from purchase_items where purchase_id=:'purchase_id' \gset
insert into stock_reservations(product_id,quantity,source_type,purchase_item_id,cost_snapshot_cents,is_opening)
values('00000000-0000-4000-8000-000000009913',4,'incoming',:'purchase_item_id',5000,true);
select is((get_storefront_product('opening-test')->>'maxOrderQuantity')::int,6,'Las reservas previas no se ofrecen a nuevos clientes');
select is((select count(*)::int from orders where created_by='00000000-0000-4000-8000-000000009911'),0,'La reserva previa no inventa pedidos ni cobros');
select is((list_opening_reservations()->0->>'incomingQuantity')::int,4,'Las cuatro unidades previas se pueden consultar');
select is((select item->>'orderId' from jsonb_array_elements(get_business_export_dataset()->'reservations') item where (item->>'isOpening')::boolean limit 1),null::text,'El respaldo conserva que no hay un pedido de cliente');
select is((select item->>'purchaseItemId' from jsonb_array_elements(get_business_export_dataset()->'reservations') item where (item->>'isOpening')::boolean limit 1),:'purchase_item_id','El respaldo conserva la compra de origen');
select throws_ok(format('select resolve_opening_reservation(%L,1,%L,gen_random_uuid())',:'purchase_item_id','deliver'),'P0001','OPENING_RESERVATION_NOT_RECEIVED','No permite entregar antes de recibir');
select (confirm_imported_order(jsonb_build_object(
  'customerName','Cliente nuevo local','paymentMethod','transfer','deliveryMethod','pickup','shippingFeeCents',0,
  'quotedSubtotalCents',30000,'quotedTotalCents',30000,
  'lines',jsonb_build_array(jsonb_build_object('productId','00000000-0000-4000-8000-000000009913','quantity',3,'unitPriceCents',10000))
))->>'id') order_id \gset
select is((get_storefront_product('opening-test')->>'maxOrderQuantity')::int,3,'El pedido nuevo usa solamente las unidades libres');
select gen_random_uuid() receipt_operation \gset
select receive_purchase(:'purchase_id',jsonb_build_array(jsonb_build_object('purchaseItemId',:'purchase_item_id','receivedQuantity',3)),:'receipt_operation') is not null as received \gset
select receive_purchase(:'purchase_id',jsonb_build_array(jsonb_build_object('purchaseItemId',:'purchase_item_id','receivedQuantity',3)),:'receipt_operation') is not null as retried \gset
select throws_ok(format('select receive_purchase(%L,jsonb_build_array(jsonb_build_object(%L,%L,%L,1)),%L)',:'purchase_id','purchaseItemId',:'purchase_item_id','receivedQuantity',:'receipt_operation'),'P0001','IDEMPOTENCY_KEY_REUSE_MISMATCH','La recepción conserva la protección contra reintentos con otra cantidad');
select is((select on_hand from stock_balances where product_id='00000000-0000-4000-8000-000000009913'),3,'Reintentar la recepción no duplica stock');
select is((list_opening_reservations()->0->>'physicalQuantity')::int,3,'La recepción parcial prioriza las reservas anteriores');
select is((list_opening_reservations()->0->>'incomingQuantity')::int,1,'La cuarta unidad sigue en camino');
select is((select sum(quantity)::int from stock_reservations where order_id=:'order_id' and source_type='incoming' and state='active'),3,'El pedido nuevo conserva sus tres reservas en camino');
select is((get_storefront_product('opening-test')->>'maxOrderQuantity')::int,3,'La recepción parcial no libera las unidades apartadas');

select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009912',true);
set local role authenticated;
select is((list_opening_reservations()->0->>'totalQuantity')::int,4,'Personal puede ver las reservas previas');
select gen_random_uuid() delivery_operation \gset
select resolve_opening_reservation(:'purchase_item_id',2,'deliver',:'delivery_operation') is not null as delivered \gset
select resolve_opening_reservation(:'purchase_item_id',2,'deliver',:'delivery_operation') is not null as delivery_retried \gset
select is((list_opening_reservations()->0->>'totalQuantity')::int,2,'Personal puede entregar por partes sin duplicar la entrega al reintentar');
select throws_ok(format('select resolve_opening_reservation(%L,1,%L,%L)',:'purchase_item_id','deliver',:'delivery_operation'),'P0001','IDEMPOTENCY_KEY_REUSE_MISMATCH','No reutiliza una confirmación con otra cantidad');
reset role;
select is((select on_hand from stock_balances where product_id='00000000-0000-4000-8000-000000009913'),1,'La entrega descuenta dos físicas una sola vez');
select is((select reserved from stock_balances where product_id='00000000-0000-4000-8000-000000009913'),1,'La entrega descuenta las dos reservas físicas');
select is((select count(*)::int from stock_movements where product_id='00000000-0000-4000-8000-000000009913' and kind='sale'),0,'La entrega anterior al sistema no crea ventas artificiales');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009911',true);
select receive_purchase(:'purchase_id') is not null as received_all \gset
select is((list_opening_reservations()->0->>'physicalQuantity')::int,2,'La recepción completa mantiene juntas las reservas previas restantes');
select is((list_opening_reservations()->0->>'incomingQuantity')::int,0,'La compra completa deja de mostrar reservas en camino');
select is((select sum(quantity)::int from stock_reservations where order_id=:'order_id' and source_type='physical' and state='active'),3,'También se habilita el pedido nuevo');
select resolve_opening_reservation(:'purchase_item_id',1,'release',gen_random_uuid()) is not null as released \gset
select is((get_storefront_product('opening-test')->>'maxOrderQuantity')::int,4,'Liberar una reserva la devuelve al stock disponible');
select resolve_opening_reservation(:'purchase_item_id',1,'deliver',gen_random_uuid()) is not null as delivered_last \gset
select is(jsonb_array_length(list_opening_reservations()),0,'La reserva terminada sale de pendientes');
select is((select reserved from stock_balances where product_id='00000000-0000-4000-8000-000000009913'),3,'Solo permanecen las reservas del pedido nuevo');
select transition_order(:'order_id','mark_paid') is not null as paid \gset
select transition_order(:'order_id','mark_delivered') is not null as new_delivered \gset
select is((select on_hand from stock_balances where product_id='00000000-0000-4000-8000-000000009913'),4,'La entrega de un pedido nuevo conserva las cuatro unidades libres');
select is((select reserved from stock_balances where product_id='00000000-0000-4000-8000-000000009913'),0,'No quedan reservas huérfanas');
select (create_purchase(jsonb_build_object('supplierName','Compra con faltante','items',jsonb_build_array(
  jsonb_build_object('productId','00000000-0000-4000-8000-000000009913','quantity',4,'unitCostCents',5000)
)))->>'id') shortage_purchase_id \gset
select id shortage_item_id from purchase_items where purchase_id=:'shortage_purchase_id' \gset
insert into stock_reservations(product_id,quantity,source_type,purchase_item_id,cost_snapshot_cents,is_opening)
values('00000000-0000-4000-8000-000000009913',2,'incoming',:'shortage_item_id',5000,true);
select lives_ok(format('select close_purchase_with_shortage(%L,%L)',:'shortage_purchase_id','El proveedor no entregará el faltante'),'Puede cerrar con faltante conservando las reservas previas identificadas');
select is((list_opening_reservations()->0->>'uncoveredQuantity')::int,2,'El faltante se informa y no desaparece silenciosamente');
select resolve_opening_reservation(:'shortage_item_id',2,'release',gen_random_uuid()) is not null as shortage_released \gset
select is(jsonb_array_length(list_opening_reservations()),0,'Puede resolver una reserva anterior cuyo proveedor no entregará');
select is((select on_hand from stock_balances where product_id='00000000-0000-4000-8000-000000009913'),4,'Resolver un faltante no crea stock físico');
select throws_ok($$insert into stock_reservations(product_id,quantity,source_type,cost_snapshot_cents) values('00000000-0000-4000-8000-000000009913',1,'physical',5000)$$,'P0001','RESERVATION_ORDER_ITEM_INCOHERENCE','Las reservas normales siguen exigiendo pedido y línea válidos');
select ok(not has_table_privilege('authenticated','private.opening_reservation_operations','select'),'El registro de idempotencia no es accesible directamente');
set local role anon;
select throws_ok($$select list_opening_reservations()$$,'42501',null,'Un visitante no puede consultar las reservas internas');
reset role;
select * from finish();
rollback;
