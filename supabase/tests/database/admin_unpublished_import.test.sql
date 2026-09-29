begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;

select plan(15);

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000009944',
  'authenticated', 'authenticated', 'hidden-import-owner@test.local',
  crypt('test-password', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now()
);
update public.store_users set role = 'owner', active = true
where user_id = '00000000-0000-4000-8000-000000009944';
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009944', true);

do $setup$
begin
  perform public.save_product(jsonb_build_object(
    'sku', 'HIDDEN_IMPORT_TEST', 'slug', 'hidden-import-test',
    'name', 'Producto solo administrativo', 'presentation', '30 unidades',
    'description', 'Prueba de importación administrativa.', 'category', 'Pruebas',
    'priceCents', 100000, 'currentCostCents', 60000,
    'reorderPoint', 0, 'safetyStock', 0, 'leadTimeDays', 7,
    'imageUrl', '/demo/test.svg', 'imageAlt', 'Producto de prueba',
    'published', false, 'active', true, 'featured', false
  ));
  perform public.adjust_product_stock(
    (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
    2, 'Stock sintético para prueba de importación'
  );
end;
$setup$;

select ok((select active and not published from public.products where sku = 'HIDDEN_IMPORT_TEST'),
  'El producto de prueba está activo y oculto de la tienda pública');
select ok(exists (
  select 1 from jsonb_array_elements(public.list_admin_products()) item
  where item ->> 'sku' = 'HIDDEN_IMPORT_TEST'
), 'El producto oculto está disponible en el catálogo administrativo');
select ok(not exists (
  select 1 from jsonb_array_elements(public.get_storefront_products()) item
  where item ->> 'sku' = 'HIDDEN_IMPORT_TEST'
), 'El producto oculto no aparece en la tienda pública');

select lives_ok($$
  select public.confirm_imported_order(jsonb_build_object(
    'customerFirstName', 'Cliente', 'customerLastName', 'Prueba',
    'paymentMethod', 'cash', 'deliveryMethod', 'pickup', 'shippingType', null,
    'address', null, 'phone', null,
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
      'quantity', 1, 'unitPriceCents', 100000
    )),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 100000,
    'quotedTotalCents', 100000,
    'protocolOrderId', '00000000-0000-4000-8000-000000009945',
    'protocolChecksum', 'ABCD1234'
  ));
$$, 'La importación autorizada acepta un producto activo aunque esté despublicado');
select is((select reserved from public.stock_balances sb
  join public.products p on p.id = sb.product_id where p.sku = 'HIDDEN_IMPORT_TEST'),
  1, 'La importación reserva una sola unidad sin consumir stock físico');

select is((public.confirm_imported_order(jsonb_build_object(
  'customerFirstName', 'Cliente', 'customerLastName', 'Prueba',
  'paymentMethod', 'cash', 'deliveryMethod', 'pickup', 'shippingType', null,
  'lines', jsonb_build_array(jsonb_build_object(
    'productId', (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
    'quantity', 1, 'unitPriceCents', 100000
  )),
  'shippingFeeCents', 0, 'quotedSubtotalCents', 100000,
  'quotedTotalCents', 100000,
  'protocolOrderId', '00000000-0000-4000-8000-000000009945',
  'protocolChecksum', 'ABCD1234'
)) ->> 'alreadyImported'), 'true',
  'El reintento se identifica sin duplicar reservas ni presentarlo como un pedido nuevo');

select throws_ok($$
  select public.confirm_imported_order(jsonb_build_object(
    'customerFirstName', 'Otra', 'customerLastName', 'Persona',
    'paymentMethod', 'cash', 'deliveryMethod', 'pickup', 'shippingType', null,
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
      'quantity', 1, 'unitPriceCents', 100000
    )),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 100000, 'quotedTotalCents', 100000,
    'protocolOrderId', '00000000-0000-4000-8000-000000009945',
    'protocolChecksum', 'ABCD1234'
  ));
$$, 'P0001', 'IDEMPOTENCY_KEY_REUSE_MISMATCH',
  'La misma clave con otro cliente no devuelve el pedido anterior como si coincidiera');

select throws_ok($$
  select public.confirm_imported_order(jsonb_build_object(
    'customerFirstName', 'Cliente', 'customerLastName', 'Prueba',
    'paymentMethod', 'cash', 'deliveryMethod', 'pickup', 'shippingType', null,
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
      'quantity', 1, 'unitPriceCents', 100000
    )),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 100000, 'quotedTotalCents', 100000,
    'protocolOrderId', '00000000-0000-4000-8000-000000009945'
  ));
$$, 'P0001', 'IDEMPOTENCY_KEY_REUSE_MISMATCH',
  'La misma clave sin código de control no se acepta como reintento idéntico');

select throws_ok($$
  select public.confirm_imported_order(jsonb_build_object(
    'customerFirstName', 'Cliente', 'customerLastName', 'Prueba',
    'deliveryMethod', 'pickup', 'shippingType', null,
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
      'quantity', 1, 'unitPriceCents', 100000
    )),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 100000, 'quotedTotalCents', 100000,
    'protocolOrderId', '00000000-0000-4000-8000-000000009945',
    'protocolChecksum', 'ABCD1234'
  ));
$$, 'P0001', 'IDEMPOTENCY_KEY_REUSE_MISMATCH',
  'La misma clave sin medio de pago no se acepta como reintento idéntico');

select throws_ok($$
  select public.confirm_imported_order(jsonb_build_object(
    'customerFirstName', 'Cliente', 'customerLastName', 'Prueba',
    'paymentMethod', 'cash', 'deliveryMethod', 'pickup', 'shippingType', null,
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
      'quantity', 2, 'unitPriceCents', 100000
    )),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 200000, 'quotedTotalCents', 200000,
    'protocolOrderId', '00000000-0000-4000-8000-000000009945',
    'protocolChecksum', 'ABCD1234'
  ));
$$, 'P0001', 'IDEMPOTENCY_KEY_REUSE_MISMATCH',
  'La misma clave con otra cantidad no devuelve el pedido anterior ni reserva más');

select throws_ok($$
  select public.confirm_imported_order(jsonb_build_object(
    'customerFirstName', 'Cliente', 'customerLastName', 'Prueba',
    'paymentMethod', 'cash', 'deliveryMethod', 'pickup', 'shippingType', null,
    'address', null, 'phone', null,
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
      'quantity', 1, 'unitPriceCents', 1
    )),
    'shippingFeeCents', 0, 'quotedSubtotalCents', 1,
    'quotedTotalCents', 1,
    'protocolOrderId', '00000000-0000-4000-8000-000000009946',
    'protocolChecksum', 'ABCD5678'
  ));
$$, 'P0001', 'ORDER_PRICE_CHANGED',
  'El precio falso sigue rechazado por la base aunque el código de WhatsApp discrepe');

create temporary table test_gift_order as
select public.confirm_imported_order(jsonb_build_object(
  'customerFirstName', 'Regalo', 'customerLastName', 'Prueba',
  'paymentMethod', 'gift', 'deliveryMethod', 'pickup', 'shippingType', null,
  'lines', jsonb_build_array(jsonb_build_object(
    'productId', (select id from public.products where sku = 'HIDDEN_IMPORT_TEST'),
    'quantity', 1, 'unitPriceCents', 100000
  )),
  'shippingFeeCents', 0, 'quotedSubtotalCents', 0, 'quotedTotalCents', 0
)) as payload;
select is((select payload ->> 'paymentState' from test_gift_order), 'gifted',
  'El regalo se registra sin cobro');
select is((select payload ->> 'fulfillmentState' from test_gift_order), 'pending',
  'El regalo sigue en el local hasta que se entregue físicamente');
select is((select on_hand from public.stock_balances sb
  join public.products p on p.id = sb.product_id where p.sku = 'HIDDEN_IMPORT_TEST'),
  2, 'El regalo sin entregar no descuenta stock físico');
select is((select reserved from public.stock_balances sb
  join public.products p on p.id = sb.product_id where p.sku = 'HIDDEN_IMPORT_TEST'),
  2, 'El regalo aparta una unidad física para su pedido');

select * from finish();
rollback;
