begin;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions,pg_temp;
select plan(20);

insert into auth.users(id,email,raw_user_meta_data) values
('00000000-0000-4000-8000-000000009901','incoming-display@example.test','{"display_name":"Incoming display"}');
update store_users set active=true,role='owner' where user_id='00000000-0000-4000-8000-000000009901';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009901',true);
insert into products(id,sku,slug,name,presentation,sale_price_cents,published)
values('00000000-0000-4000-8000-000000009902','INCOMING_DISPLAY','incoming-display','Incoming display','Unidad',10000,true);
insert into stock_balances(product_id) values('00000000-0000-4000-8000-000000009902');
insert into product_financials(product_id,current_cost_cents) values('00000000-0000-4000-8000-000000009902',5000);

select (create_purchase(jsonb_build_object('supplierName','Proveedor local','items',jsonb_build_array(
  jsonb_build_object('productId','00000000-0000-4000-8000-000000009902','quantity',10,'unitCostCents',5000)
)))->>'id') purchase_id \gset
select id purchase_item_id from purchase_items where purchase_id=:'purchase_id' \gset
select (confirm_imported_order(jsonb_build_object(
  'customerName','Cliente local', 'paymentMethod','transfer','deliveryMethod','pickup','shippingFeeCents',0,
  'quotedSubtotalCents',30000,'quotedTotalCents',30000,
  'lines',jsonb_build_array(jsonb_build_object('productId','00000000-0000-4000-8000-000000009902','quantity',3,'unitPriceCents',10000))
))->>'id') order_id \gset

create function pg_temp.inventory_item() returns jsonb language sql as $$
 select item from jsonb_array_elements(private.inventory_payload()) item where item->>'sku'='INCOMING_DISPLAY';
$$;
create function pg_temp.product_item() returns jsonb language sql as $$
 select private.product_payload('00000000-0000-4000-8000-000000009902',true);
$$;

select is((pg_temp.product_item()->>'incoming')::int,10,'Productos cuenta todas las unidades pendientes, incluidas las reservadas');
select is((pg_temp.product_item()->>'incomingReserved')::int,3,'Productos identifica las reservas en camino');
select is((get_storefront_product('incoming-display')->>'maxOrderQuantity')::int,7,'La tienda solo ofrece las siete unidades libres');
select ok(not (get_storefront_product('incoming-display') ? 'incomingReserved'),'La tienda conserva su contrato público');
select is((pg_temp.inventory_item()->>'incoming')::int,10,'Inventario muestra diez pendientes');
select is((pg_temp.inventory_item()->>'incomingReserved')::int,3,'Inventario muestra tres reservadas de esa compra');
select is((pg_temp.inventory_item()->>'projected')::int,7,'El disponible futuro excluye reservas de la compra');

select receive_purchase(:'purchase_id',jsonb_build_array(jsonb_build_object('purchaseItemId',:'purchase_item_id','receivedQuantity',2)),gen_random_uuid()) is not null as receipt_saved \gset
select is((pg_temp.product_item()->>'incoming')::int,8,'Productos descuenta las dos ya recibidas');
select is((pg_temp.product_item()->>'incomingReserved')::int,1,'Solo queda una reserva pendiente de recibir');
select is((pg_temp.inventory_item()->>'incoming')::int,8,'Inventario descuenta recepciones parciales');
select is((pg_temp.inventory_item()->>'onHand')::int,2,'La recepción suma dos unidades físicas');
select is((pg_temp.inventory_item()->>'reserved')::int,2,'La recepción conserva las reservas, ahora físicas');
select is((pg_temp.inventory_item()->>'available')::int,0,'Las dos recibidas no se ofrecen dos veces');
select is((pg_temp.inventory_item()->>'projected')::int,7,'La recepción parcial no duplica el disponible futuro');

select receive_purchase(:'purchase_id',jsonb_build_array(jsonb_build_object('purchaseItemId',:'purchase_item_id','receivedQuantity',8)),gen_random_uuid()) is not null as receipt_saved \gset
select is((pg_temp.inventory_item()->>'incoming')::int,0,'La recepción total deja cero unidades en camino');
select is((pg_temp.inventory_item()->>'incomingReserved')::int,0,'Ya no quedan reservas en camino');
select is((pg_temp.inventory_item()->>'available')::int,7,'Quedan siete físicas libres después de recibir todo');
select is((get_storefront_product('incoming-display')->>'maxOrderQuantity')::int,7,'La tienda conserva las siete libres');

select (create_purchase(jsonb_build_object('supplierName','Compra adicional','items',jsonb_build_array(
  jsonb_build_object('productId','00000000-0000-4000-8000-000000009902','quantity',4,'unitCostCents',5000)
)))->>'id') second_purchase_id \gset
select close_purchase_with_shortage(:'second_purchase_id','Faltante de proveedor para prueba local') is not null as shortage_closed \gset
select is((pg_temp.inventory_item()->>'incoming')::int,0,'Un faltante definitivo no sigue contando como mercadería en camino');
select is((pg_temp.inventory_item()->>'projected')::int,7,'El faltante conserva el stock disponible real');

select * from finish();
rollback;
