\set ON_ERROR_STOP on

begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;

select plan(11);

-- ---------------------------------------------------------------------------
-- Usuario owner aislado
-- ---------------------------------------------------------------------------
insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000103',
  'authenticated',
  'authenticated',
  'incoming-repeat@test.local',
  crypt('test-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Dueña Repeated Receive"}',
  now(),
  now()
) on conflict (id) do nothing;

update public.store_users
set role = 'owner', active = true
where user_id = '00000000-0000-4000-8000-000000000103';

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-000000000103',
  false
);

-- ---------------------------------------------------------------------------
-- Producto sin stock físico
-- ---------------------------------------------------------------------------
do $setup_product$
begin
  perform public.save_product(jsonb_build_object(
    'sku', 'PREV03',
    'slug', 'whey-repeated-receive',
    'name', 'Whey Repeated Receive',
    'presentation', '1kg',
    'description', 'Prueba de recepciones parciales sucesivas.',
    'category', 'Proteínas',
    'priceCents', 2800000,
    'currentCostCents', 1800000,
    'reorderPoint', 2,
    'safetyStock', 1,
    'leadTimeDays', 7,
    'imageUrl', '/demo/whey.svg',
    'imageAlt', 'Whey Repeated Receive',
    'published', true,
    'active', true,
    'featured', false
  ));
end;
$setup_product$;

-- ---------------------------------------------------------------------------
-- Compra: vienen exactamente 5
-- ---------------------------------------------------------------------------
do $setup_purchase$
begin
  perform public.create_purchase(jsonb_build_object(
    'supplierName', 'Proveedor Repeated Receive Test',
    'orderedAt', now(),
    'expectedAt', (now() + interval '5 days')::timestamptz,
    'notes', 'TEST repeated partial receive 2-1-2',
    'items', jsonb_build_array(
      jsonb_build_object(
        'productId', (
          select id
          from public.products
          where sku = 'PREV03'
        ),
        'quantity', 5,
        'unitCostCents', 1900000
      )
    )
  ));
end;
$setup_purchase$;

-- ---------------------------------------------------------------------------
-- Pedido: las 5 unidades quedan incoming
-- ---------------------------------------------------------------------------
do $setup_order$
begin
  perform public.confirm_imported_order(jsonb_build_object(
    'customerName', 'Cliente Split Repetido',
    'paymentMethod', 'transfer',
    'deliveryMethod', 'pickup',
    'shippingType', null,
    'shippingFeeCents', 0,
    'protocolOrderId', '00000000-0000-4000-8000-000000000773',
    'protocolChecksum', 'A1B2C3D6',
    'quotedSubtotalCents', 14000000,
    'quotedTotalCents', 14000000,
    'lines', jsonb_build_array(
      jsonb_build_object(
        'productId', (
          select id
          from public.products
          where sku = 'PREV03'
        ),
        'quantity', 5,
        'unitPriceCents', 2800000
      )
    )
  ));
end;
$setup_order$;

-- 1. Estado inicial: 5 incoming
select is(
  (
    select coalesce(sum(sr.quantity), 0)::integer
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where o.protocol_order_id = '00000000-0000-4000-8000-000000000773'
      and sr.state = 'active'
      and sr.source_type = 'incoming'
  ),
  5,
  '1. Estado inicial: 5 unidades incoming'
);

-- ---------------------------------------------------------------------------
-- RECEPCIÓN #1: llegan 2
-- ---------------------------------------------------------------------------
select lives_ok(
  $test$
    select public.receive_purchase(
      (
        select id
        from public.purchases
        where notes = 'TEST repeated partial receive 2-1-2'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'purchaseItemId',
          (
            select pi.id
            from public.purchase_items pi
            join public.purchases pu on pu.id = pi.purchase_id
            where pu.notes = 'TEST repeated partial receive 2-1-2'
          ),
          'receivedQuantity',
          2
        )
      )
    )
  $test$,
  '2. Primera recepción parcial de 2 unidades no falla'
);

select is(
  (
    select coalesce(sum(sr.quantity), 0)::integer
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where o.protocol_order_id = '00000000-0000-4000-8000-000000000773'
      and sr.state = 'active'
      and sr.source_type = 'physical'
  ),
  2,
  '3. Después de recibir 2: physical = 2'
);

select is(
  (
    select coalesce(sum(sr.quantity), 0)::integer
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where o.protocol_order_id = '00000000-0000-4000-8000-000000000773'
      and sr.state = 'active'
      and sr.source_type = 'incoming'
  ),
  3,
  '4. Después de recibir 2: incoming = 3'
);

-- ---------------------------------------------------------------------------
-- RECEPCIÓN #2: llega 1
-- ESTE ES EL PUNTO DONDE PUEDE EXPLOTAR LA UNIQUE ACTUAL
-- ---------------------------------------------------------------------------
select lives_ok(
  $test$
    select public.receive_purchase(
      (
        select id
        from public.purchases
        where notes = 'TEST repeated partial receive 2-1-2'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'purchaseItemId',
          (
            select pi.id
            from public.purchase_items pi
            join public.purchases pu on pu.id = pi.purchase_id
            where pu.notes = 'TEST repeated partial receive 2-1-2'
          ),
          'receivedQuantity',
          1
        )
      )
    )
  $test$,
  '5. Segunda recepción parcial de 1 unidad no falla'
);

select is(
  (
    select coalesce(sum(sr.quantity), 0)::integer
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where o.protocol_order_id = '00000000-0000-4000-8000-000000000773'
      and sr.state = 'active'
      and sr.source_type = 'physical'
  ),
  3,
  '6. Después de 2 + 1: physical = 3'
);

select is(
  (
    select coalesce(sum(sr.quantity), 0)::integer
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where o.protocol_order_id = '00000000-0000-4000-8000-000000000773'
      and sr.state = 'active'
      and sr.source_type = 'incoming'
  ),
  2,
  '7. Después de 2 + 1: incoming = 2'
);

-- ---------------------------------------------------------------------------
-- RECEPCIÓN #3: llegan las últimas 2
-- ---------------------------------------------------------------------------
select lives_ok(
  $test$
    select public.receive_purchase(
      (
        select id
        from public.purchases
        where notes = 'TEST repeated partial receive 2-1-2'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'purchaseItemId',
          (
            select pi.id
            from public.purchase_items pi
            join public.purchases pu on pu.id = pi.purchase_id
            where pu.notes = 'TEST repeated partial receive 2-1-2'
          ),
          'receivedQuantity',
          2
        )
      )
    )
  $test$,
  '8. Tercera recepción parcial de 2 unidades no falla'
);

select is(
  (
    select coalesce(sum(sr.quantity), 0)::integer
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where o.protocol_order_id = '00000000-0000-4000-8000-000000000773'
      and sr.state = 'active'
      and sr.source_type = 'physical'
  ),
  5,
  '9. Estado final: physical = 5'
);

select is(
  (
    select coalesce(sum(sr.quantity), 0)::integer
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where o.protocol_order_id = '00000000-0000-4000-8000-000000000773'
      and sr.state = 'active'
      and sr.source_type = 'incoming'
  ),
  0,
  '10. Estado final: incoming = 0'
);

select is(
  (
    select private.order_payload(o.id, false) ->> 'stockReadiness'
    from public.orders o
    where o.protocol_order_id = '00000000-0000-4000-8000-000000000773'
  ),
  'ready',
  '11. Tras recibir 5/5 el pedido queda ready'
);

select * from finish();

rollback;
