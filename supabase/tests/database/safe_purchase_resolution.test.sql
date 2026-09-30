begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select * from no_plan();

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-000000009801','authenticated','authenticated',
  'safe-owner@test.local',crypt('isolated-password',gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{}',now(),now());
update public.store_users set role='owner',active=true where user_id='00000000-0000-4000-8000-000000009801';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009801',true);

create temporary table safe_fixture(product_id uuid, purchase_id uuid, item_id uuid, order_id uuid);
do $$
declare v_product uuid; v_purchase jsonb; v_order jsonb;
begin
  perform public.save_product(jsonb_build_object('sku','SAFERECEIPT','slug','safe-receipt','name','Producto aislado',
    'description','Producto sintético de pruebas','imageUrl','/demo/safe.svg','imageAlt','Prueba aislada','featured',false,
    'presentation','1 unidad','category','Pruebas','priceCents',100000,'currentCostCents',60000,
    'reorderPoint',8,'safetyStock',2,'leadTimeDays',7,'published',true,'active',true));
  select id into v_product from public.products where sku='SAFERECEIPT';
  v_purchase:=public.create_purchase(jsonb_build_object('supplierName','Proveedor aislado',
    'items',jsonb_build_array(jsonb_build_object('productId',v_product,'quantity',10,'unitCostCents',60000))));
  v_order:=public.confirm_imported_order(jsonb_build_object('customerName','Cliente aislado', 'paymentMethod','cash', 'deliveryMethod','pickup',
    'lines',jsonb_build_array(jsonb_build_object('productId',v_product,'quantity',7,'unitPriceCents',100000)),
    'shippingFeeCents',0,'quotedSubtotalCents',700000,'quotedTotalCents',700000,
    'protocolOrderId','00000000-0000-4000-8000-000000009811','protocolChecksum','ABCDEF12'));
  insert into safe_fixture select v_product,(v_purchase->>'id')::uuid,(v_purchase->'items'->0->>'id')::uuid,(v_order->>'id')::uuid;
end;
$$;

select lives_ok(format('select public.update_stock_thresholds_checked(%L,11,2,7,%L::jsonb)',product_id,
  '{"reorderPoint":8,"safetyStock":2,"leadTimeDays":7}'),'Guardado de avisos con la configuración original') from safe_fixture;
select throws_ok(format('select public.update_stock_thresholds_checked(%L,7,2,7,%L::jsonb)',product_id,
  '{"reorderPoint":8,"safetyStock":2,"leadTimeDays":7}'),'P0001','STOCK_THRESHOLDS_CHANGED','Un formulario viejo no pisa el aviso actualizado') from safe_fixture;
select is((select reorder_point from public.products where id=(select product_id from safe_fixture)),11,'Se conserva el aviso del primer guardado');
select throws_ok(format('select public.update_stock_thresholds_checked(%L,-1,2,7,%L::jsonb)',product_id,
  '{"reorderPoint":11,"safetyStock":2,"leadTimeDays":7}'),'P0001','INVALID_QUANTITY','Se rechazan cantidades negativas') from safe_fixture;
select ok(not has_function_privilege('anon','public.update_stock_thresholds_checked(uuid,integer,integer,integer,jsonb)','EXECUTE'),'Anónimo no puede guardar avisos');


create temporary table old_target(id uuid);
insert into old_target select (public.create_purchase(jsonb_build_object('supplierName','Destino previo aislado',
  'items',jsonb_build_array(jsonb_build_object('productId',product_id,'quantity',5,'unitCostCents',60000))))->>'id')::uuid from safe_fixture;
select throws_ok(format('select public.reassign_purchase_reservations(%L,%L)',item_id,(select id from old_target)),
 'P0001','PURCHASE_RECEIPT_REQUIRED','Una pestaña antigua no puede cerrar la compra antes de registrar lo recibido') from safe_fixture;
select is((select shortage_quantity from public.purchase_items where id=(select item_id from safe_fixture)),0,'La operación rechazada deja el faltante intacto');
select public.receive_purchase(purchase_id,jsonb_build_array(jsonb_build_object('purchaseItemId',item_id,'receivedQuantity',5)),
 '00000000-0000-4000-8000-000000009821') is not null as received from safe_fixture;
select is((select reserved from public.stock_balances where product_id=(select product_id from safe_fixture)),5,'Se reservan cinco unidades físicas por FIFO');
select is((select sum(quantity)::integer from public.stock_reservations where order_id=(select order_id from safe_fixture) and state='active' and source_type='incoming'),2,'Sólo dos unidades del cliente siguen esperando');
select is((public.get_purchase_impact(purchase_id)->0->'reservedOrders'->0->>'reservedQuantity')::integer,2,'El diagnóstico posterior a la llegada muestra sólo las unidades todavía pendientes') from safe_fixture;
select lives_ok(format('select public.save_order_packing(%L,%L::jsonb,0)',order_id,
 jsonb_build_array(jsonb_build_object('orderItemId',(select id from public.order_items where order_id=f.order_id),'packedQuantity',5))),
 'Las cinco unidades físicas se pueden guardar antes de resolver el faltante') from safe_fixture f;

create function pg_temp.fail_transfer() returns trigger language plpgsql as $$ begin raise exception 'SAFE_TEST_FAILURE'; end; $$;
create trigger safe_test_transfer before update on public.stock_reservations for each row
 when (new.purchase_item_id is distinct from old.purchase_item_id and new.source_type='incoming') execute function pg_temp.fail_transfer();
create temporary table purchase_count as select count(*)::integer as n from public.purchases;
select throws_ok(format('select public.replace_purchase_shortage(%L,5,%L,null,%L)',item_id,'Proveedor de reemplazo',
 '00000000-0000-4000-8000-000000009822'),'P0001','SAFE_TEST_FAILURE','Una falla después de crear la reposición revierte la operación entera') from safe_fixture;
select is((select count(*)::integer from public.purchases),(select n from purchase_count),'La falla no deja una compra huérfana');
select is((select shortage_quantity from public.purchase_items where id=(select item_id from safe_fixture)),0,'La falla no cierra el faltante original');
select is((select count(*)::integer from private.purchase_shortage_operations),0,'La falla no registra un resultado incompleto');
drop trigger safe_test_transfer on public.stock_reservations;

create temporary table replacement_result(payload jsonb);
insert into replacement_result select public.replace_purchase_shortage(item_id,5,'Proveedor de reemplazo',null,
 '00000000-0000-4000-8000-000000009822') from safe_fixture;
select is((select received_quantity from public.purchase_items where id=(select item_id from safe_fixture)),5,'Se conservan las cinco unidades que llegaron');
select is((select shortage_quantity from public.purchase_items where id=(select item_id from safe_fixture)),5,'Sólo las cinco restantes son faltantes');
select is((select count(*)::integer from public.purchases),(select n+1 from purchase_count),'Se crea exactamente una reposición');
select is((select payload->>'transferredReservations' from replacement_result),'1','Se transfiere la reserva pendiente, sin mover unidades físicas');
select is((select sum(quantity)::integer from public.stock_reservations where order_id=(select order_id from safe_fixture) and state='active' and source_type='incoming'),2,'La reposición reserva sólo las dos unidades pendientes del cliente');
select is((select packed_quantity from public.order_items where order_id=(select order_id from safe_fixture)),5,'La reposición conserva las unidades ya guardadas en la bolsita');
select is(public.replace_purchase_shortage(item_id,5,'Proveedor de reemplazo',null,'00000000-0000-4000-8000-000000009822'),
 (select payload from replacement_result),'El reintento devuelve el resultado anterior') from safe_fixture;
select is((select count(*)::integer from public.purchases),(select n+1 from purchase_count),'El reintento no duplica compras');
select throws_ok(format('select public.replace_purchase_shortage(%L,5,%L,null,%L)',item_id,'Otro proveedor',
 '00000000-0000-4000-8000-000000009822'),'P0001','IDEMPOTENCY_KEY_REUSE_MISMATCH','Una respuesta perdida no permite cambiar el proveedor del intento guardado') from safe_fixture;
select throws_ok(format('select public.replace_purchase_shortage(%L,5,%L,null,%L)',item_id,'Proveedor de reemplazo',
 '00000000-0000-4000-8000-000000009823'),'P0001','PURCHASE_SHORTAGE_CHANGED','Reabrir un formulario viejo no genera otra reposición') from safe_fixture;
select ok(not has_function_privilege('anon','public.replace_purchase_shortage(uuid,integer,text,timestamptz,uuid)','EXECUTE'),'Anónimo no puede reponer');
update public.store_users set role='staff' where user_id='00000000-0000-4000-8000-000000009801';
select throws_ok(format('select public.replace_purchase_shortage(%L,5,%L,null,%L)',item_id,'Proveedor de reemplazo',
 '00000000-0000-4000-8000-000000009822'),'P0001','FORBIDDEN','Personal no puede recuperar ni modificar una reposición de la dueña') from safe_fixture;
update public.store_users set role='owner' where user_id='00000000-0000-4000-8000-000000009801';

create temporary table batch_fixture(purchase_id uuid, first_id uuid, second_id uuid, product_a uuid, product_b uuid);
do $$
declare a uuid; b uuid; p jsonb; ids uuid[];
begin
  for a in select product_id from safe_fixture loop
    perform public.save_product(jsonb_build_object('sku','SAFEBATCH','slug','safe-batch','name','Segundo producto aislado',
      'description','Producto sintético de pruebas','imageUrl','/demo/safe.svg','imageAlt','Prueba aislada','featured',false,
      'presentation','1 unidad','category','Pruebas','priceCents',100000,'currentCostCents',60000,
      'reorderPoint',8,'safetyStock',2,'leadTimeDays',7,'published',true,'active',true));
    select id into b from public.products where sku='SAFEBATCH';
    p:=public.create_purchase(jsonb_build_object('supplierName','Proveedor de lote',
      'items',jsonb_build_array(jsonb_build_object('productId',a,'quantity',3,'unitCostCents',60000),
        jsonb_build_object('productId',b,'quantity',4,'unitCostCents',60000))));
    select array_agg(id order by id) into ids from public.purchase_items where purchase_id=(p->>'id')::uuid;
    insert into batch_fixture values((p->>'id')::uuid,ids[1],ids[2],a,b);
  end loop;
end;
$$;
create temporary table batch_request as select b.purchase_id,
  jsonb_agg(jsonb_build_object('purchaseItemId',pi.id,'quantity',pi.quantity) order by pi.id) as items
  from batch_fixture b join public.purchase_items pi on pi.purchase_id=b.purchase_id group by b.purchase_id;
create function pg_temp.fail_second_shortage() returns trigger language plpgsql as $$
begin
  if new.id=(select second_id from batch_fixture) and new.shortage_quantity>old.shortage_quantity then raise exception 'SAFE_SECOND_FAILURE'; end if;
  return new;
end; $$;
create trigger safe_second_shortage before update on public.purchase_items for each row execute function pg_temp.fail_second_shortage();
select throws_ok(format('select public.declare_purchase_shortages(%L,%L::jsonb,%L)',purchase_id,items,
 '00000000-0000-4000-8000-000000009831'),'P0001','SAFE_SECOND_FAILURE','Fallar en el segundo faltante revierte también el primero') from batch_request;
select is((select sum(shortage_quantity)::integer from public.purchase_items where purchase_id=(select purchase_id from batch_fixture)),0,'No queda un cierre parcial del lote');
select is((select count(*)::integer from private.purchase_shortage_operations where operation_id='00000000-0000-4000-8000-000000009831'),0,'Un lote fallido no registra éxito');
drop trigger safe_second_shortage on public.purchase_items;
create temporary table batch_result as select public.declare_purchase_shortages(purchase_id,items,'00000000-0000-4000-8000-000000009831') as payload from batch_request;
select is((select sum(shortage_quantity)::integer from public.purchase_items where purchase_id=(select purchase_id from batch_fixture)),7,'Un lote exitoso registra exactamente los dos faltantes');
select is(public.declare_purchase_shortages(purchase_id,items,'00000000-0000-4000-8000-000000009831'),
 (select payload from batch_result),'Reintentar el lote no suma nuevamente los faltantes') from batch_request;
select throws_ok(format('select public.declare_purchase_shortages(%L,%L::jsonb,%L)',purchase_id,items,
 '00000000-0000-4000-8000-000000009832'),'P0001','PURCHASE_SHORTAGE_CHANGED','Otro formulario obsoleto no vuelve a cerrar el lote') from batch_request;
select throws_ok(format('select public.declare_purchase_shortages(%L,%L::jsonb,%L)',purchase_id,jsonb_build_array(items->0,items->0),
 '00000000-0000-4000-8000-000000009833'),'P0001','INVALID_INPUT','El lote rechaza un producto duplicado') from batch_request;

create temporary table opening_fixture(purchase_id uuid,item_id uuid);
insert into opening_fixture select (p->>'id')::uuid,(p->'items'->0->>'id')::uuid from (
  select public.create_purchase(jsonb_build_object('supplierName','Proveedor de reservas previas',
    'items',jsonb_build_array(jsonb_build_object('productId',product_b,'quantity',4,'unitCostCents',60000)))) p from batch_fixture
) s;
insert into public.stock_reservations(product_id,quantity,source_type,purchase_item_id,cost_snapshot_cents,is_opening)
select product_b,2,'incoming',item_id,60000,true from batch_fixture cross join opening_fixture;
select is((public.get_purchase_impact(purchase_id)->0->>'openingReservationsQuantity')::integer,2,'Se muestran las reservas previas pendientes') from opening_fixture;
select throws_ok(format('select public.declare_purchase_shortages(%L,%L::jsonb,%L)',purchase_id,
 jsonb_build_array(jsonb_build_object('purchaseItemId',item_id,'quantity',4)), '00000000-0000-4000-8000-000000009834'),
 'P0001','PURCHASE_SHORTAGE_UNRESOLVED','No se pueden dejar sin cobertura las reservas previas') from opening_fixture;
select is((select shortage_quantity from public.purchase_items where id=(select item_id from opening_fixture)),0,'El bloqueo no altera las unidades pendientes');
select public.receive_purchase(purchase_id,jsonb_build_array(jsonb_build_object('purchaseItemId',item_id,'receivedQuantity',2)),
 '00000000-0000-4000-8000-000000009835') is not null from opening_fixture;
select is((public.get_purchase_impact(purchase_id)->0->>'openingReservationsQuantity')::integer,0,'Las reservas previas ya físicas no figuran como faltantes') from opening_fixture;
select lives_ok(format('select public.declare_purchase_shortages(%L,%L::jsonb,%L)',purchase_id,
 jsonb_build_array(jsonb_build_object('purchaseItemId',item_id,'quantity',2)), '00000000-0000-4000-8000-000000009836'),
 'Se cierra sólo el faltante libre, conservando las reservas previas físicas') from opening_fixture;
select is((select sum(quantity)::integer from public.stock_reservations where purchase_item_id=(select item_id from opening_fixture) and state='active' and source_type='physical'),2,'El cierre conserva las dos unidades apartadas');

-- Replacing a replacement through a legacy caller must still respect its reserved capacity.
select public.declare_item_shortage((payload->'newPurchase'->'items'->0->>'id')::uuid,5) is not null from replacement_result;
create temporary table small_target as select (public.create_purchase(jsonb_build_object('supplierName','Destino insuficiente',
 'items',jsonb_build_array(jsonb_build_object('productId',product_id,'quantity',1,'unitCostCents',60000))))->>'id')::uuid id from safe_fixture;
select throws_ok(format('select public.reassign_purchase_reservations(%L,%L)',payload->'newPurchase'->'items'->0->>'id',(select id from small_target)),
 'P0001','INSUFFICIENT_TARGET_CAPACITY','La transferencia rechaza una reposición menor que las reservas pendientes') from replacement_result;
select is((select sum(quantity)::integer from public.stock_reservations where purchase_item_id=(select (payload->'newPurchase'->'items'->0->>'id')::uuid from replacement_result) and state='active' and source_type='uncovered'),2,'Una transferencia rechazada mantiene las reservas en su origen');
select ok(not has_function_privilege('anon','public.declare_purchase_shortages(uuid,jsonb,uuid)','EXECUTE'),'Anónimo no puede cerrar faltantes');

select * from finish();
rollback;
