\set ON_ERROR_STOP on

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;

select plan(16);

-- Setup test user
insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000101',
  'authenticated',
  'authenticated',
  'incoming-owner@test.local',
  crypt('test-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Dueña Preventas"}',
  now(),
  now()
) on conflict (id) do nothing;

update public.store_users
set role = 'owner', active = true
where user_id = '00000000-0000-4000-8000-000000000101';

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', false);

-- Cleanup previous test data if any
delete from public.stock_movements where order_id in (select id from public.orders where protocol_order_id in ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000772')) or purchase_id in (select id from public.purchases where notes like '%Compra de prueba para preventas%') or product_id in (select id from public.products where sku in ('PREV01', 'PREV02'));
delete from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id in ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000772')) or purchase_item_id in (select id from public.purchase_items where purchase_id in (select id from public.purchases where notes like '%Compra de prueba para preventas%'));
delete from public.order_items where order_id in (select id from public.orders where protocol_order_id in ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000772'));
delete from public.orders where protocol_order_id in ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000772');
delete from public.purchase_items where purchase_id in (select id from public.purchases where notes like '%Compra de prueba para preventas%');
delete from public.purchases where notes like '%Compra de prueba para preventas%';
delete from public.stock_balances where product_id in (select id from public.products where sku in ('PREV01', 'PREV02'));
delete from public.product_financials where product_id in (select id from public.products where sku in ('PREV01', 'PREV02'));
delete from public.products where sku in ('PREV01', 'PREV02');

-- Setup test products
do $setup_incoming_products$
begin
  perform public.save_product(jsonb_build_object(
    'sku', 'PREV01',
    'slug', 'whey-preventa',
    'name', 'Whey Preventa',
    'presentation', '1kg',
    'description', 'Producto para prueba de stock en camino.',
    'category', 'Proteínas',
    'priceCents', 2800000,
    'currentCostCents', 1800000,
    'reorderPoint', 5,
    'safetyStock', 2,
    'leadTimeDays', 7,
    'imageUrl', '/demo/whey.svg',
    'imageAlt', 'Whey Preventa',
    'published', true,
    'active', true,
    'featured', false
  ));

  perform public.save_product(jsonb_build_object(
    'sku', 'PREV02',
    'slug', 'creatina-preventa',
    'name', 'Creatina Preventa',
    'presentation', '300g',
    'description', 'Producto para prueba de stock mixto.',
    'category', 'Creatinas',
    'priceCents', 2000000,
    'currentCostCents', 1200000,
    'reorderPoint', 5,
    'safetyStock', 2,
    'leadTimeDays', 7,
    'imageUrl', '/demo/creatina.svg',
    'imageAlt', 'Creatina Preventa',
    'published', true,
    'active', true,
    'featured', false
  ));

  -- Ajustar 1 unidad física a Creatina (para pruebas de líneas mixtas)
  perform public.adjust_product_stock(
    (select id from public.products where sku = 'PREV02'),
    1,
    'Stock inicial físico para prueba mixta'
  );
end;
$setup_incoming_products$;

-- Test 1: Comprobar que quote_cart_eta cotiza fecha esperada y detecta requiresIncoming
select ok(
  (
    select (public.quote_cart_eta(jsonb_build_array(
      jsonb_build_object('productId', (select id from public.products where sku = 'PREV01'), 'quantity', 1)
    )) ->> 'ok')::boolean = false
    and (public.quote_cart_eta(jsonb_build_array(
      jsonb_build_object('productId', (select id from public.products where sku = 'PREV01'), 'quantity', 1)
    )) ->> 'error') = 'INSUFFICIENT_STOCK'
  ),
  'Test 1: quote_cart_eta reporta INSUFFICIENT_STOCK cuando no hay fisico ni compras en camino'
);

-- Crear una orden de compra para PREV01 (Whey: 10 unidades) y PREV02 (Creatina: 5 unidades)
do $setup_test_purchase$
declare
  v_purch jsonb;
begin
  v_purch := public.create_purchase(jsonb_build_object(
    'supplierName', 'Distribuidora Mayorista Test',
    'orderedAt', now(),
    'expectedAt', (now() + interval '5 days')::timestamptz,
    'notes', 'Compra de prueba para preventas',
    'items', jsonb_build_array(
      jsonb_build_object(
        'productId', (select id from public.products where sku = 'PREV01'),
        'quantity', 10,
        'unitCostCents', 1900000
      ),
      jsonb_build_object(
        'productId', (select id from public.products where sku = 'PREV02'),
        'quantity', 5,
        'unitCostCents', 1300000
      )
    )
  ));
end;
$setup_test_purchase$;

-- Test 2: Comprobar que ahora quote_cart_eta responde requiresIncoming = true y quotedEta not null
select ok(
  (
    select (public.quote_cart_eta(jsonb_build_array(
      jsonb_build_object('productId', (select id from public.products where sku = 'PREV01'), 'quantity', 2)
    )) ->> 'requiresIncoming')::boolean = true
    and (public.quote_cart_eta(jsonb_build_array(
      jsonb_build_object('productId', (select id from public.products where sku = 'PREV01'), 'quantity', 2)
    )) ->> 'quotedEta') is not null
  ),
  'Test 2: quote_cart_eta cotiza exitosamente sobre compras en camino'
);

-- Test 3: Comprobar que private.product_incoming_capacity devuelve 10 unidades para PREV01
select is(
  (select available_incoming from private.product_incoming_capacity((select id from public.products where sku = 'PREV01'))),
  10,
  'Test 3: product_incoming_capacity reporta 10 unidades entrantes libres'
);

-- Test 4: Comprobar que product_payload tiene maxOrderQuantity = 10 por compras en camino
select is(
  (select (private.product_payload((select id from public.products where sku = 'PREV01'), false) ->> 'maxOrderQuantity')::integer),
  10,
  'Test 4: product_payload habilita maxOrderQuantity = 10 por compras en camino'
);

-- Test 5: Confirmar un pedido en preventa pura (2 Whey PREV01)
do $confirm_preorder$
declare
  v_order jsonb;
begin
  v_order := public.confirm_imported_order(jsonb_build_object(
    'customerName', 'Cliente Preventa Uno',
    'paymentMethod', 'transfer',
    'deliveryMethod', 'pickup',
    'shippingType', null,
    'shippingFeeCents', 0,
    'protocolOrderId', '00000000-0000-4000-8000-000000000771',
    'protocolChecksum', 'A1B2C3D4',
    'quotedSubtotalCents', 5600000,
    'quotedTotalCents', 5600000,
    'lines', jsonb_build_array(
      jsonb_build_object(
        'productId', (select id from public.products where sku = 'PREV01'),
        'quantity', 2,
        'unitPriceCents', 2800000
      )
    )
  ));
end;
$confirm_preorder$;

select is(
  (select stock_balances.reserved from public.stock_balances where product_id = (select id from public.products where sku = 'PREV01')),
  0,
  'Test 5: El stock fisico reservado permanece en 0 para asignaciones puramente en camino'
);

-- Test 6: Comprobar que la reserva se creó con source_type = incoming
select is(
  (select source_type from public.stock_reservations where order_id = (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000000771')),
  'incoming',
  'Test 6: La reserva de preventa tiene source_type = incoming'
);

-- Test 7: Comprobar que la capacidad entrante libre disminuyó a 8
select is(
  (select available_incoming from private.product_incoming_capacity((select id from public.products where sku = 'PREV01'))),
  8,
  'Test 7: La capacidad entrante libre disminuyó exactamente a 8 unidades'
);

-- Test 8: Comprobar que el pedido tiene estado derivado stockReadiness = waiting_incoming
select is(
  (select (private.order_payload(id, false) ->> 'stockReadiness') from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000000771'),
  'waiting_incoming',
  'Test 8: El pedido tiene estado derivado waiting_incoming'
);

-- Test 9: Bloqueo de entrega mientras esté en waiting_incoming
select throws_ok(
  'select public.transition_order((select id from public.orders where protocol_order_id = ''00000000-0000-4000-8000-000000000771''), ''mark_delivered'')',
  'P0001',
  'CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK',
  'Test 9: transition_order mark_delivered es bloqueado con excepción si el pedido espera mercadería'
);

-- Test 10: Línea Mixta (Creatina PREV02: 1 física + 2 en camino = 3 total)
do $confirm_mixed_order$
declare
  v_order jsonb;
begin
  v_order := public.confirm_imported_order(jsonb_build_object(
    'customerName', 'Cliente Mixto',
    'paymentMethod', 'transfer',
    'deliveryMethod', 'pickup',
    'shippingType', null,
    'shippingFeeCents', 0,
    'protocolOrderId', '00000000-0000-4000-8000-000000000772',
    'protocolChecksum', 'A1B2C3D5',
    'quotedSubtotalCents', 6000000,
    'quotedTotalCents', 6000000,
    'lines', jsonb_build_array(
      jsonb_build_object(
        'productId', (select id from public.products where sku = 'PREV02'),
        'quantity', 3,
        'unitPriceCents', 2000000
      )
    )
  ));
end;
$confirm_mixed_order$;

-- 1 fisica @ 1.200.000 + 2 incoming @ 1.300.000 = 3.800.000
select is(
  (select cost_total_cents from public.order_items where order_id = (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000000772')),
  3800000::bigint,
  'Test 10: El costo total de la línea mixta es exactamente $3.800.000 (suma ponderada de asignaciones)'
);

-- Test 11: Idempotencia UX (re-importar devuelve el mismo pedido sin duplicar reservas)
select is(
  (select (public.confirm_imported_order(jsonb_build_object(
    'customerName', 'Cliente Preventa Uno',
    'paymentMethod', 'transfer',
    'deliveryMethod', 'pickup',
    'shippingType', null,
    'shippingFeeCents', 0,
    'protocolOrderId', '00000000-0000-4000-8000-000000000771',
    'protocolChecksum', 'A1B2C3D4',
    'quotedSubtotalCents', 5600000,
    'quotedTotalCents', 5600000,
    'lines', jsonb_build_array(
      jsonb_build_object('productId', (select id from public.products where sku = 'PREV01'), 'quantity', 2, 'unitPriceCents', 2800000)
    )
  )) ->> 'id')),
  (select id::text from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000000771'),
  'Test 11: Idempotencia devuelve la orden existente sin re-reservar'
);

-- Test 12: Trigger cabecera impide cancelar compra con preventas activas
select throws_ok(
  'update public.purchases set state = ''cancelled'' where notes = ''Compra de prueba para preventas''',
  'P0001',
  'CANNOT_CANCEL_PURCHASE_WITH_ACTIVE_RESERVATIONS',
  'Test 12: Trigger impide cancelar orden de compra que tiene preventas activas'
);

-- Test 13: Recepción parcial de la compra (Recibir 2 Whey PREV01 de las 10 pedidas)
do $receive_partial$
declare
  v_pi_id uuid;
  v_res jsonb;
begin
  select pi.id into v_pi_id
  from public.purchase_items pi
  join public.purchases pu on pu.id = pi.purchase_id
  where pu.notes = 'Compra de prueba para preventas'
    and pi.product_id = (select id from public.products where sku = 'PREV01');

  v_res := public.receive_purchase(
    (select id from public.purchases where notes = 'Compra de prueba para preventas'),
    jsonb_build_array(
      jsonb_build_object('purchaseItemId', v_pi_id, 'receivedQuantity', 2)
    )
  );
end;
$receive_partial$;

select is(
  (select source_type from public.stock_reservations where order_id = (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000000771')),
  'physical',
  'Test 13: Tras la recepción parcial, la reserva del Pedido 1 se convirtió a physical'
);

-- Test 14: Comprobar que el pedido ahora tiene stockReadiness = ready
select is(
  (select (private.order_payload(id, false) ->> 'stockReadiness') from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000000771'),
  'ready',
  'Test 14: El pedido desbloqueado tiene estado derivado ready'
);

-- Test 15: Ahora la entrega sí procede
select ok(
  (
    select (public.transition_order(
      (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000000771'),
      'mark_delivered'
    ) ->> 'fulfillmentState') = 'delivered'
  ),
  'Test 15: transition_order mark_delivered se ejecuta con éxito al estar listo'
);

-- Test 16: Cierre con faltante definitivo de la compra
do $close_shortage$
begin
  perform public.close_purchase_with_shortage(
    (select id from public.purchases where notes = 'Compra de prueba para preventas'),
    'Cierre de prueba con faltante'
  );
end;
$close_shortage$;

select ok(
  (
    select pu.state = 'received' 
       and (select count(*) from public.stock_reservations sr where sr.order_id = (select id from public.orders where protocol_order_id = '00000000-0000-4000-8000-000000000772') and sr.source_type = 'uncovered') > 0
    from public.purchases pu
    where pu.notes like '%Compra de prueba para preventas%'
  ),
  'Test 16: close_purchase_with_shortage cierra la compra y transiciona reservas no cubiertas a uncovered'
);

-- Limpieza final para dejar la base de datos 100% limpia
delete from public.stock_movements where order_id in (select id from public.orders where protocol_order_id in ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000772')) or purchase_id in (select id from public.purchases where notes like '%Compra de prueba para preventas%') or product_id in (select id from public.products where sku in ('PREV01', 'PREV02'));
delete from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id in ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000772')) or purchase_item_id in (select id from public.purchase_items where purchase_id in (select id from public.purchases where notes like '%Compra de prueba para preventas%'));
delete from public.order_items where order_id in (select id from public.orders where protocol_order_id in ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000772'));
delete from public.orders where protocol_order_id in ('00000000-0000-4000-8000-000000000771', '00000000-0000-4000-8000-000000000772');
delete from public.purchase_items where purchase_id in (select id from public.purchases where notes like '%Compra de prueba para preventas%');
delete from public.purchases where notes like '%Compra de prueba para preventas%';
delete from public.stock_balances where product_id in (select id from public.products where sku in ('PREV01', 'PREV02'));
delete from public.product_financials where product_id in (select id from public.products where sku in ('PREV01', 'PREV02'));
delete from public.products where sku in ('PREV01', 'PREV02');
delete from public.store_users where user_id = '00000000-0000-4000-8000-000000000101';
delete from auth.users where id = '00000000-0000-4000-8000-000000000101';

select * from finish();
