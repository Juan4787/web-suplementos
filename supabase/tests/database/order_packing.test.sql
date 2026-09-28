begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select * from no_plan();

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000009901',
   'authenticated', 'authenticated', 'packing-owner@test.local', crypt('test-password', gen_salt('bf')),
   now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Packing Owner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000009902',
   'authenticated', 'authenticated', 'packing-staff@test.local', crypt('test-password', gen_salt('bf')),
   now(), '{"provider":"email","providers":["email"]}', '{"display_name":"Packing Staff"}', now(), now());
update public.store_users set role = 'owner', active = true where user_id = '00000000-0000-4000-8000-000000009901';
update public.store_users set role = 'staff', active = true where user_id = '00000000-0000-4000-8000-000000009902';
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009901', true);

do $setup$
declare
  v_product uuid;
begin
  perform public.save_product(jsonb_build_object(
    'sku', 'PACKSPLIT', 'slug', 'packing-split-test', 'name', 'Producto armado mixto',
    'presentation', '1 unidad', 'description', 'Producto aislado para prueba de armado.',
    'category', 'Pruebas', 'priceCents', 100000, 'currentCostCents', 60000,
    'reorderPoint', 1, 'safetyStock', 0, 'leadTimeDays', 7,
    'imageUrl', '/demo/packing.svg', 'imageAlt', 'Producto prueba',
    'published', true, 'active', true, 'featured', false
  ));
  perform public.save_product(jsonb_build_object(
    'sku', 'PACKCANCEL', 'slug', 'packing-cancel-test', 'name', 'Producto cancelación armado',
    'presentation', '1 unidad', 'description', 'Producto aislado para prueba de cancelación.',
    'category', 'Pruebas', 'priceCents', 100000, 'currentCostCents', 60000,
    'reorderPoint', 1, 'safetyStock', 0, 'leadTimeDays', 7,
    'imageUrl', '/demo/packing.svg', 'imageAlt', 'Producto prueba',
    'published', true, 'active', true, 'featured', false
  ));
  perform public.save_product(jsonb_build_object(
    'sku', 'PACKLEGACY', 'slug', 'packing-legacy-test', 'name', 'Producto armado sin verificar',
    'presentation', '1 unidad', 'description', 'Producto aislado para prueba de compatibilidad.',
    'category', 'Pruebas', 'priceCents', 100000, 'currentCostCents', 60000,
    'reorderPoint', 1, 'safetyStock', 0, 'leadTimeDays', 7,
    'imageUrl', '/demo/packing.svg', 'imageAlt', 'Producto prueba',
    'published', true, 'active', true, 'featured', false
  ));
  v_product := (select id from public.products where sku = 'PACKSPLIT');
  perform public.adjust_product_stock(v_product, 1, 'Stock sintético de armado');
  perform public.adjust_product_stock((select id from public.products where sku = 'PACKCANCEL'), 1, 'Stock sintético de cancelación');
  perform public.adjust_product_stock((select id from public.products where sku = 'PACKLEGACY'), 1, 'Stock sintético de compatibilidad');
  perform public.create_purchase(jsonb_build_object(
    'supplierName', 'Proveedor de armado test', 'expectedAt', now() + interval '2 days',
    'items', jsonb_build_array(jsonb_build_object('productId', v_product, 'quantity', 1, 'unitCostCents', 60000))
  ));
  perform public.confirm_imported_order(jsonb_build_object(
    'customerName', 'Cliente Armado', 'paymentMethod', 'cash', 'deliveryMethod', 'pickup',
    'lines', jsonb_build_array(jsonb_build_object('productId', v_product, 'quantity', 2, 'unitPriceCents', 100000)),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 200000, 'quotedTotalCents', 200000,
    'protocolOrderId', '00000000-0000-4000-8000-000000009911', 'protocolChecksum', 'ABCDEF12'
  ));
  perform public.confirm_imported_order(jsonb_build_object(
    'customerName', 'Cliente Cancelación', 'paymentMethod', 'cash', 'deliveryMethod', 'pickup',
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'PACKCANCEL'), 'quantity', 1, 'unitPriceCents', 100000
    )),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 100000, 'quotedTotalCents', 100000,
    'protocolOrderId', '00000000-0000-4000-8000-000000009912', 'protocolChecksum', 'ABCDEF13'
  ));
  perform public.confirm_imported_order(jsonb_build_object(
    'customerName', 'Cliente Compatibilidad', 'paymentMethod', 'cash', 'deliveryMethod', 'pickup',
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'PACKLEGACY'), 'quantity', 1, 'unitPriceCents', 100000
    )),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 100000, 'quotedTotalCents', 100000,
    'protocolOrderId', '00000000-0000-4000-8000-000000009913', 'protocolChecksum', 'ABCDEF14'
  ));
end;
$setup$;

select is((select packed_quantity from public.order_items oi join public.orders o on o.id = oi.order_id
  where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), null::integer,
  'Un pedido nuevo queda sin verificar hasta que se registre explícitamente su bolsita');
select is((select packing_revision from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 0,
  'La revisión de armado empieza en cero');
select is((select private.order_payload(o.id, true) ->> 'packingTracked'
  from public.orders o where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'false',
  'La interfaz recibe el estado sin verificar antes de la primera conciliación');
select is((select jsonb_array_length(public.list_product_reservations(id)) from public.products where sku = 'PACKSPLIT'), 1,
  'El desglose del producto localiza el pedido que tiene una unidad física reservada');
select is((select (public.list_product_reservations(id) -> 0 ->> 'physicalQuantity')::integer
  from public.products where sku = 'PACKSPLIT'), 1,
  'El desglose indica solo la unidad física, sin sumar la que está en camino');
select is((select public.list_product_reservations(id) -> 0 ->> 'packedQuantity'
  from public.products where sku = 'PACKSPLIT'), null::text,
  'El desglose no inventa contenido de bolsitas antes de revisarlas');
select is((select (private.order_payload(o.id, true) -> 'items' -> 0 ->> 'physicalReservedQuantity')::integer
  from public.orders o where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 1,
  'Una línea de dos unidades muestra una física');
select is((select (private.order_payload(o.id, true) -> 'items' -> 0 ->> 'incomingQuantity')::integer
  from public.orders o where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 1,
  'La misma línea muestra otra unidad en camino');

select throws_ok($$
  select public.save_order_packing(
    (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'),
    jsonb_build_array(jsonb_build_object('orderItemId', (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'packedQuantity', 2)), 0)
$$, 'P0001', 'PACKING_EXCEEDS_PHYSICAL_RESERVATION', 'No permite embalar dos si solo una unidad está físicamente reservada');
select is((select count(*)::integer from public.order_packing_events), 0, 'El rechazo no deja eventos parciales');

select lives_ok($$
  select public.save_order_packing(
    (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'),
    jsonb_build_array(jsonb_build_object('orderItemId', (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'packedQuantity', 1)), 0)
$$, 'Registra una unidad física de una línea parcialmente cubierta');
select is((select preparation_state::text from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'),
  'preparing', 'Un pedido con productos guardados queda En preparación');
select is((select on_hand from public.stock_balances where product_id = (select id from public.products where sku = 'PACKSPLIT')),
  1, 'Guardar una unidad no descuenta stock físico');
select is((select reserved from public.stock_balances where product_id = (select id from public.products where sku = 'PACKSPLIT')),
  1, 'Guardar una unidad no altera la reserva');
select is((select count(*)::integer from public.order_packing_events), 1, 'El cambio deja un evento auditado');
select is((select previous_quantity from public.order_packing_events limit 1), null::integer,
  'El historial distingue una cantidad previamente desconocida de cero');
select is((select new_quantity from public.order_packing_events limit 1), 1,
  'El historial guarda la cantidad efectivamente verificada');
select is((select private.order_payload(o.id, true) ->> 'packingTracked'
  from public.orders o where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'true',
  'Después de guardar el vector completo el pedido queda bajo seguimiento');
select is((select (public.search_orders(1, 20, 'Cliente Armado', 'preparing') ->> 'total')::integer), 1,
  'El filtro de preparación encuentra el pedido parcialmente armado');
set constraints guard_packed_reservation_change immediate;
select throws_ok($$
  update public.stock_reservations set state = 'released', resolved_at = now()
  where order_item_id = (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
    where o.protocol_order_id = '00000000-0000-4000-8000-000000009911')
    and state = 'active' and source_type = 'physical'
$$, 'P0001', 'PACKED_RESERVATION_CHANGED', 'Ninguna operación puede liberar la reserva de una unidad guardada en bolsita');
set constraints guard_packed_reservation_change deferred;
select is((select reserved from public.stock_balances where product_id = (select id from public.products where sku = 'PACKSPLIT')),
  1, 'El rechazo no modifica la reserva física');

select throws_ok($$
  select public.save_order_packing(
    (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'),
    jsonb_build_array(jsonb_build_object('orderItemId', (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'packedQuantity', 0)), 0)
$$, 'P0001', 'ORDER_PACKING_CHANGED', 'Rechaza la edición de un operador con revisión obsoleta');
select lives_ok($$
  select public.save_order_packing(
    (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'),
    jsonb_build_array(jsonb_build_object('orderItemId', (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'packedQuantity', 1)), 1)
$$, 'Repetir exactamente la misma cantidad es idempotente');
select is((select packing_revision from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 1,
  'La repetición no cambia la revisión ni provoca conflictos adicionales');

select throws_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'mark_ready')
$$, 'P0001', 'CANNOT_READY_ORDER_WAITING_FOR_STOCK', 'No marca listo mientras la segunda unidad está en camino');
select throws_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'mark_delivered')
$$, 'P0001', 'CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK', 'No entrega una línea mixta antes de la recepción');

do $receive$
declare
  v_purchase uuid;
  v_item uuid;
begin
  select id into v_purchase from public.purchases where supplier_name = 'Proveedor de armado test';
  select id into v_item from public.purchase_items where purchase_id = v_purchase;
  perform public.receive_purchase(v_purchase,
    jsonb_build_array(jsonb_build_object('purchaseItemId', v_item, 'receivedQuantity', 1)),
    '00000000-0000-4000-8000-000000009920');
end;
$receive$;
select is((select (private.order_payload(o.id, true) -> 'items' -> 0 ->> 'physicalReservedQuantity')::integer
  from public.orders o where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 2,
  'La recepción convierte la segunda reserva en física');
select is((select packed_quantity from public.order_items oi join public.orders o on o.id = oi.order_id
  where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), 1,
  'La recepción no inventa una segunda unidad en bolsita');
select throws_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'mark_ready')
$$, 'P0001', 'ORDER_PACKING_INCOMPLETE', 'El servidor impide marcar listo con armado parcial aunque el stock haya llegado');
select throws_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'mark_delivered')
$$, 'P0001', 'ORDER_PACKING_INCOMPLETE', 'La entrega directa tampoco puede saltarse el armado registrado');

select lives_ok($$
  select public.save_order_packing(
    (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'),
    jsonb_build_array(jsonb_build_object('orderItemId', (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'packedQuantity', 2)), 1)
$$, 'Permite completar la segunda unidad después de recibirla');
select lives_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'mark_ready')
$$, 'El pedido completo puede marcarse listo aunque todavía no esté cobrado');
select is((select (public.search_orders(1, 20, 'Cliente Armado', 'ready_pickup') ->> 'total')::integer), 1,
  'El filtro de retiro encuentra el pedido listo sin exigir cobro previo');
select is((select payment_state::text from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'),
  'pending', 'Preparar no modifica el estado de pago');
select lives_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009911'), 'mark_delivered')
$$, 'La entrega completa descuenta stock una sola vez');
select is((select on_hand from public.stock_balances where product_id = (select id from public.products where sku = 'PACKSPLIT')),
  0, 'La salida completa descuenta exactamente las dos unidades físicas');
select is((select reserved from public.stock_balances where product_id = (select id from public.products where sku = 'PACKSPLIT')),
  0, 'La salida completa consume la reserva');

select lives_ok($$
  select public.save_order_packing(
    (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009912'),
    jsonb_build_array(jsonb_build_object('orderItemId', (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.protocol_order_id = '00000000-0000-4000-8000-000000009912'), 'packedQuantity', 1)), 0)
$$, 'El segundo pedido queda guardado en una bolsita');
select throws_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009912'), 'cancel')
$$, 'P0001', 'CANNOT_CANCEL_PACKED_ORDER', 'No libera al catálogo una unidad que todavía está en bolsita');
select is((select reserved from public.stock_balances where product_id = (select id from public.products where sku = 'PACKCANCEL')),
  1, 'El intento de cancelación revierte la liberación de reserva');
select lives_ok($$
  select public.save_order_packing(
    (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009912'),
    jsonb_build_array(jsonb_build_object('orderItemId', (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.protocol_order_id = '00000000-0000-4000-8000-000000009912'), 'packedQuantity', 0)), 1)
$$, 'Registra la devolución física de la bolsita al estante');
select lives_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009912'), 'cancel')
$$, 'La cancelación se permite después de desarmar la bolsita');
select is((select reserved from public.stock_balances where product_id = (select id from public.products where sku = 'PACKCANCEL')),
  0, 'La cancelación final libera exactamente una reserva');

select lives_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009913'), 'mark_ready')
$$, 'Una sesión anterior puede marcar listo un pedido cuyo armado nunca se registró');
select lives_ok($$
  select public.save_order_packing(
    (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009913'),
    jsonb_build_array(jsonb_build_object('orderItemId', (select oi.id from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.protocol_order_id = '00000000-0000-4000-8000-000000009913'), 'packedQuantity', 0)), 0)
$$, 'Una revisión posterior permite registrar que la bolsita histórica estaba vacía');
select is((select preparation_state::text from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009913'),
  'pending', 'La verificación corrige automáticamente el estado listo cuando falta el producto');
select throws_ok($$
  select public.transition_order((select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000009913'), 'mark_ready')
$$, 'P0001', 'ORDER_PACKING_INCOMPLETE', 'Una vez verificado, el pedido ya no puede salir incompleto');

select ok(not has_function_privilege('anon', 'public.save_order_packing(uuid,jsonb,integer)', 'execute'), 'El público no puede cambiar bolsitas');
select ok(has_function_privilege('authenticated', 'public.save_order_packing(uuid,jsonb,integer)', 'execute'), 'El personal autorizado puede registrar bolsitas');
select ok(not has_table_privilege('authenticated', 'public.order_items', 'update'), 'No hay actualización directa de cantidades desde el navegador');
select ok(not has_table_privilege('authenticated', 'public.order_packing_events', 'insert'), 'El historial solo lo escribe la operación controlada');

select * from finish();
rollback;
