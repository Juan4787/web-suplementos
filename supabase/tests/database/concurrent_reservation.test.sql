\set ON_ERROR_STOP on

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
set search_path = public, extensions, pg_temp;

select plan(16);

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000099',
  'authenticated',
  'authenticated',
  'race-owner@test.local',
  crypt('test-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"display_name":"Dueña Concurrencia"}',
  now(),
  now()
);

update public.store_users
set role = 'owner', active = true
where user_id = '00000000-0000-4000-8000-000000000099';

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false);

do $setup_race_product$
begin
  perform public.save_product(jsonb_build_object(
    'sku', 'RACE10',
    'slug', 'producto-concurrencia',
    'name', 'Producto Concurrencia',
    'presentation', '10 unidades',
    'description', 'Producto temporal para verificar reservas simultáneas.',
    'category', 'Pruebas',
    'priceCents', 10000,
    'currentCostCents', 5000,
    'reorderPoint', 2,
    'safetyStock', 1,
    'leadTimeDays', 7,
    'imageUrl', '/demo/race.svg',
    'imageAlt', 'Producto temporal de concurrencia',
    'published', true,
    'active', true,
    'featured', false
  ));
  perform public.adjust_product_stock(
    (select id from public.products where sku = 'RACE10'),
    10,
    'Stock para prueba concurrente'
  );
end;
$setup_race_product$;

-- =========================================================================
-- PRUEBA 1: Carrera concurrente por las últimas unidades (Sobreventa)
-- =========================================================================

select dblink_connect(
  'race_blocker',
  'host=host.docker.internal port=55322 dbname=postgres user=postgres password=postgres'
);
select dblink_connect(
  'race_contender',
  'host=host.docker.internal port=55322 dbname=postgres user=postgres password=postgres'
);

select * from dblink('race_blocker', $$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false)$$) as c1(v text);
select * from dblink('race_contender', $$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false)$$) as c2(v text);

select dblink_exec('race_blocker', 'begin');
select *
from dblink(
  'race_blocker',
  format(
    'select sb.product_id::text from public.products p join public.stock_balances sb on sb.product_id = p.id where p.id = %L::uuid for update of p, sb',
    (select id from public.products where sku = 'RACE10')
  )
) as locked(product_id text);

select is(
  dblink_send_query(
    'race_contender',
    format(
      'select public.confirm_imported_order(%L::jsonb)',
      jsonb_build_object(
        'customerName', 'Cliente Contendiente',
        'paymentMethod', 'cash',
        'deliveryMethod', 'pickup',
        'shippingType', null,
        'address', null,
        'addressNumber', null,
        'phone', null,
        'lines', jsonb_build_array(jsonb_build_object(
          'productId', (select id from public.products where sku = 'RACE10'),
          'quantity', 6,
          'unitPriceCents', 10000
        )),
        'shippingFeeCents', 0,
        'quotedSubtotalCents', 60000,
        'quotedTotalCents', 60000,
        'protocolOrderId', '99999999-9999-4999-8999-999999999992',
        'protocolChecksum', 'ABCDEF02'
      )::text
    )
  ),
  1,
  'la segunda confirmación comienza en otra conexión'
);
select is(dblink_is_busy('race_contender'), 1, 'la segunda confirmación espera el bloqueo de stock');

select ok(
  (
    select result ->> 'id' is not null
    from dblink(
      'race_blocker',
      format(
        'select public.confirm_imported_order(%L::jsonb)',
        jsonb_build_object(
          'customerName', 'Cliente Ganador',
          'paymentMethod', 'cash',
          'deliveryMethod', 'pickup',
          'shippingType', null,
          'address', null,
          'addressNumber', null,
          'phone', null,
          'lines', jsonb_build_array(jsonb_build_object(
            'productId', (select id from public.products where sku = 'RACE10'),
            'quantity', 6,
            'unitPriceCents', 10000
          )),
          'shippingFeeCents', 0,
          'quotedSubtotalCents', 60000,
          'quotedTotalCents', 60000,
          'protocolOrderId', '99999999-9999-4999-8999-999999999991',
          'protocolChecksum', 'ABCDEF01'
        )::text
      )
    ) as completed(result jsonb)
  ),
  'la primera confirmación reserva seis unidades'
);
select dblink_exec('race_blocker', 'commit');

select is(
  (
    select count(*)::integer
    from dblink_get_result('race_contender', false) as rejected(result jsonb)
  ),
  0,
  'la confirmación que quedó sin stock no crea un pedido'
);
select matches(
  dblink_error_message('race_contender'),
  'INSUFFICIENT_STOCK',
  'la segunda confirmación informa falta de stock'
);
select is(
  (
    select count(*)::integer
    from public.orders
    where protocol_order_id in (
      '99999999-9999-4999-8999-999999999991',
      '99999999-9999-4999-8999-999999999992'
    )
  ),
  1,
  'solo una de las dos confirmaciones queda persistida'
);
select is(
  (
    select reserved
    from public.stock_balances sb
    join public.products p on p.id = sb.product_id
    where p.sku = 'RACE10'
  ),
  6,
  'la reserva final nunca supera el stock físico'
);

select dblink_disconnect('race_blocker');
select dblink_disconnect('race_contender');

-- =========================================================================
-- PRUEBA 2: Carrera concurrente con el MISMO protocol_order_id (Idempotencia)
-- =========================================================================

select dblink_connect(
  'race_blocker',
  'host=host.docker.internal port=55322 dbname=postgres user=postgres password=postgres'
);
select dblink_connect(
  'race_contender',
  'host=host.docker.internal port=55322 dbname=postgres user=postgres password=postgres'
);

select * from dblink('race_blocker', $$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false)$$) as c3(v text);
select * from dblink('race_contender', $$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false)$$) as c4(v text);

select dblink_exec('race_blocker', 'begin');
select *
from dblink(
  'race_blocker',
  format(
    'select sb.product_id::text from public.products p join public.stock_balances sb on sb.product_id = p.id where p.id = %L::uuid for update of p, sb',
    (select id from public.products where sku = 'RACE10')
  )
) as locked_idem(product_id text);

select is(
  dblink_send_query(
    'race_contender',
    format(
      'select public.confirm_imported_order(%L::jsonb)',
      jsonb_build_object(
        'customerName', 'Cliente Idempotente Contendiente',
        'paymentMethod', 'cash',
        'deliveryMethod', 'pickup',
        'shippingType', null,
        'address', null,
        'addressNumber', null,
        'phone', null,
        'lines', jsonb_build_array(jsonb_build_object(
          'productId', (select id from public.products where sku = 'RACE10'),
          'quantity', 2,
          'unitPriceCents', 10000
        )),
        'shippingFeeCents', 0,
        'quotedSubtotalCents', 20000,
        'quotedTotalCents', 20000,
        'protocolOrderId', '99999999-9999-4999-8999-999999999999',
        'protocolChecksum', 'ABCDEF99'
      )::text
    )
  ),
  1,
  'la segunda confirmación idéntica comienza en otra conexión'
);
select is(dblink_is_busy('race_contender'), 1, 'la segunda confirmación espera el lock');

select ok(
  (
    select result ->> 'id' is not null
    from dblink(
      'race_blocker',
      format(
        'select public.confirm_imported_order(%L::jsonb)',
        jsonb_build_object(
          'customerName', 'Cliente Idempotente Ganador',
          'paymentMethod', 'cash',
          'deliveryMethod', 'pickup',
          'shippingType', null,
          'address', null,
          'addressNumber', null,
          'phone', null,
          'lines', jsonb_build_array(jsonb_build_object(
            'productId', (select id from public.products where sku = 'RACE10'),
            'quantity', 2,
            'unitPriceCents', 10000
          )),
          'shippingFeeCents', 0,
          'quotedSubtotalCents', 20000,
          'quotedTotalCents', 20000,
          'protocolOrderId', '99999999-9999-4999-8999-999999999999',
          'protocolChecksum', 'ABCDEF99'
        )::text
      )
    ) as completed_idem(result jsonb)
  ),
  'la primera confirmación registra el pedido con protocol_order_id X'
);
select dblink_exec('race_blocker', 'commit');

select is(
  (
    select count(*)::integer
    from dblink_get_result('race_contender', false) as rejected_idem(result jsonb)
  ),
  0,
  'la confirmación concurrente con el mismo UUID es rechazada sin duplicar pedido'
);

select matches(
  dblink_error_message('race_contender'),
  'ORDER_ALREADY_IMPORTED',
  'la confirmación concurrente con el mismo UUID es interceptada por unique constraint'
);

select is(
  (
    select count(*)::integer
    from public.orders
    where protocol_order_id = '99999999-9999-4999-8999-999999999999'
  ),
  1,
  'solo existe exactamente 1 orden con ese protocol_order_id'
);

select is(
  (
    select count(*)::integer
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where o.protocol_order_id = '99999999-9999-4999-8999-999999999999'
  ),
  1,
  'solo existe exactamente 1 registro de reserva de stock'
);

select is(
  (
    select count(*)::integer
    from public.stock_movements sm
    join public.orders o on o.id = sm.order_id
    where o.protocol_order_id = '99999999-9999-4999-8999-999999999999'
  ),
  1,
  'solo existe exactamente 1 movimiento contable de reserva'
);

select is(
  (
    select reserved
    from public.stock_balances sb
    join public.products p on p.id = sb.product_id
    where p.sku = 'RACE10'
  ),
  8,
  'la reserva total final es exactamente 8 unidades (6 de la primera + 2 de la segunda única)'
);

select dblink_disconnect('race_blocker');
select dblink_disconnect('race_contender');

delete from public.stock_movements
where product_id = (select id from public.products where sku = 'RACE10');
delete from public.stock_reservations
where product_id = (select id from public.products where sku = 'RACE10');
delete from public.order_items
where product_id = (select id from public.products where sku = 'RACE10');
delete from public.orders
where protocol_order_id in (
  '99999999-9999-4999-8999-999999999991',
  '99999999-9999-4999-8999-999999999992',
  '99999999-9999-4999-8999-999999999999'
);
delete from public.customers
where name in ('Cliente Ganador', 'Cliente Contendiente', 'Cliente Idempotente Ganador', 'Cliente Idempotente Contendiente');
delete from public.product_images
where product_id = (select id from public.products where sku = 'RACE10');
delete from public.stock_balances
where product_id = (select id from public.products where sku = 'RACE10');
delete from public.product_financials
where product_id = (select id from public.products where sku = 'RACE10');
delete from public.products where sku = 'RACE10';
delete from auth.users where id = '00000000-0000-4000-8000-000000000099';

select * from finish();
