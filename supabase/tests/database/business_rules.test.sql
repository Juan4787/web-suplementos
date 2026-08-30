begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;

select plan(36);

select ok(
  has_function_privilege('anon', 'public.get_public_store_settings()', 'execute'),
  'anon puede leer la configuración pública mediante RPC'
);
select ok(
  not has_function_privilege('anon', 'public.list_admin_products()', 'execute'),
  'anon no puede ejecutar RPC privadas'
);
select ok(
  has_function_privilege('authenticated', 'public.list_admin_products()', 'execute'),
  'authenticated tiene acceso al contrato operativo'
);

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'owner@test.local', crypt('test-password', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"display_name":"Dueña Test"}', now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'staff@test.local', crypt('test-password', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"display_name":"Personal Test"}', now(), now()
  );

update public.store_users
set role = 'owner', active = true
where user_id = '00000000-0000-4000-8000-000000000001';
update public.store_users
set role = 'staff', active = true
where user_id = '00000000-0000-4000-8000-000000000002';

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);

do $setup_product$
begin
  perform public.save_product(jsonb_build_object(
    'sku', 'TEST300',
    'slug', 'producto-test-300',
    'name', 'Producto Test',
    'presentation', '300 g',
    'description', 'Producto creado para comprobar invariantes transaccionales.',
    'category', 'Pruebas',
    'priceCents', 100000,
    'currentCostCents', 60000,
    'reorderPoint', 3,
    'safetyStock', 1,
    'leadTimeDays', 7,
    'imageUrl', '/demo/test.svg',
    'imageAlt', 'Pote del producto de prueba',
    'published', true,
    'active', true,
    'featured', false
  ));
  perform public.adjust_product_stock(
    (select id from public.products where sku = 'TEST300'),
    10,
    'Stock inicial de prueba'
  );
end;
$setup_product$;

select ok(exists(select 1 from public.products where sku = 'TEST300'), 'la dueña crea un producto');
select is(
  (select on_hand from public.stock_balances sb join public.products p on p.id = sb.product_id where p.sku = 'TEST300'),
  10,
  'el ajuste explícito modifica el stock físico'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select ok(
  (
    select product -> 'currentCostCents' = 'null'::jsonb
    from jsonb_array_elements(public.list_admin_products()) product
    where product ->> 'sku' = 'TEST300'
  ),
  'el payload de personal redacciona el costo'
);

set local role authenticated;
do $capture_rls$
begin
  perform set_config(
    'test.staff_financial_rows',
    (select count(*)::text from public.product_financials),
    true
  );
end;
$capture_rls$;
reset role;
select is(current_setting('test.staff_financial_rows'), '0', 'RLS impide leer costos de forma directa');

do $confirm_order$
declare
  v_product_id uuid := (select id from public.products where sku = 'TEST300');
begin
  perform public.confirm_imported_order(jsonb_build_object(
    'customerName', 'Cliente Test',
    'paymentMethod', 'cash',
    'deliveryMethod', 'pickup',
    'shippingType', null,
    'address', null,
    'addressNumber', null,
    'phone', null,
    'lines', jsonb_build_array(jsonb_build_object(
      'productId', v_product_id,
      'quantity', 2,
      'unitPriceCents', 100000
    )),
    'shippingFeeCents', 0,
    'quotedSubtotalCents', 200000,
    'quotedTotalCents', 200000,
    'protocolOrderId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'protocolChecksum', 'ABCDEF12'
  ));
end;
$confirm_order$;

select ok((select order_number > 0 from public.orders limit 1), 'confirmar devuelve un pedido numerado');
select is((select count(*)::integer from public.orders), 1, 'confirmar crea un solo pedido');
select is(
  (select reserved from public.stock_balances sb join public.products p on p.id = sb.product_id where p.sku = 'TEST300'),
  2,
  'confirmar reserva stock sin descontar físico'
);

select throws_ok(
  $$
    select public.confirm_imported_order(jsonb_build_object(
      'customerName', 'Cliente Test', 'paymentMethod', 'cash', 'deliveryMethod', 'pickup',
      'shippingType', null, 'address', null, 'addressNumber', null, 'phone', null,
      'lines', jsonb_build_array(jsonb_build_object(
        'productId', (select id from public.products where sku = 'TEST300'),
        'quantity', 2, 'unitPriceCents', 100000
      )),
      'shippingFeeCents', 0, 'quotedSubtotalCents', 200000, 'quotedTotalCents', 200000,
      'protocolOrderId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'protocolChecksum', 'ABCDEF12'
    ))
  $$,
  'P0001',
  'ORDER_ALREADY_IMPORTED',
  'el código idempotente rechaza una reimportación'
);

select is(
  (public.check_cart_availability(jsonb_build_array(jsonb_build_object(
    'productId', (select id from public.products where sku = 'TEST300'),
    'quantity', 9
  ))) ->> 'ok')::boolean,
  false,
  'la disponibilidad pública descuenta reservas'
);

select throws_ok(
  $$
    select public.confirm_imported_order(jsonb_build_object(
      'customerName', 'Otro Cliente', 'paymentMethod', 'cash', 'deliveryMethod', 'pickup',
      'shippingType', null, 'address', null, 'addressNumber', null, 'phone', null,
      'lines', jsonb_build_array(jsonb_build_object(
        'productId', (select id from public.products where sku = 'TEST300'),
        'quantity', 9, 'unitPriceCents', 100000
      )),
      'shippingFeeCents', 0, 'quotedSubtotalCents', 900000, 'quotedTotalCents', 900000,
      'protocolOrderId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'protocolChecksum', '1234ABCD'
    ))
  $$,
  'P0001',
  'INSUFFICIENT_STOCK',
  'una venta normal no puede superar el disponible'
);
select is((select count(*)::integer from public.orders), 1, 'un rechazo no deja medio pedido escrito');

do $advance_order$
declare
  v_order_id uuid := (select id from public.orders limit 1);
begin
  perform public.transition_order(v_order_id, 'mark_paid');
  perform public.transition_order(v_order_id, 'start_preparing');
  perform public.transition_order(v_order_id, 'mark_ready');
  perform public.transition_order(v_order_id, 'mark_delivered');
end;
$advance_order$;

select is((select payment_state::text from public.orders limit 1), 'paid', 'pago avanza separado');
select is((select fulfillment_state::text from public.orders limit 1), 'delivered', 'entrega avanza separado');
select is(
  (select on_hand from public.stock_balances sb join public.products p on p.id = sb.product_id where p.sku = 'TEST300'),
  8,
  'el retiro descuenta físico recién al entregar'
);
select is(
  (select reserved from public.stock_balances sb join public.products p on p.id = sb.product_id where p.sku = 'TEST300'),
  0,
  'entregar consume la reserva'
);

select throws_ok(
  $$select public.get_sales_analytics(current_date - 1, current_date)$$,
  'P0001',
  'FORBIDDEN',
  'personal no puede consultar analíticas financieras'
);
select throws_ok(
  $$select public.list_paid_orders(1, 20)$$,
  'P0001',
  'FORBIDDEN',
  'personal no puede listar ventas cobradas con datos financieros'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select is(
  (public.get_sales_analytics(current_date - 1, current_date) ->> 'revenueCents')::bigint,
  200000::bigint,
  'la facturación se reconoce al cobrar'
);
select is(
  (public.list_paid_orders(1, 20) ->> 'total')::bigint,
  1::bigint,
  'la dueña recibe ventas cobradas paginadas desde PostgreSQL'
);

do $create_purchase$
begin
  perform public.create_purchase(jsonb_build_object(
    'supplierName', 'Proveedor Test',
    'expectedAt', null,
    'notes', 'Reposición de prueba',
    'items', jsonb_build_array(jsonb_build_object(
      'productId', (select id from public.products where sku = 'TEST300'),
      'quantity', 5,
      'unitCostCents', 70000
    ))
  ));
end;
$create_purchase$;

select is((select count(*)::integer from public.purchases), 1, 'crear compra registra una entrada en camino');
select is(
  (
    select (item ->> 'incoming')::integer
    from jsonb_array_elements(public.list_inventory_status()) item
    where item ->> 'sku' = 'TEST300'
  ),
  5,
  'una compra ordered aumenta solo el proyectado'
);

do $receive_purchase$
begin
  perform public.receive_purchase((select id from public.purchases limit 1));
end;
$receive_purchase$;

select is((select state::text from public.purchases limit 1), 'received', 'recibir avanza la compra una sola vez');
select is(
  (select on_hand from public.stock_balances sb join public.products p on p.id = sb.product_id where p.sku = 'TEST300'),
  13,
  'recibir aumenta el stock físico'
);
select is(
  (select current_cost_cents from public.product_financials f join public.products p on p.id = f.product_id where p.sku = 'TEST300'),
  70000::bigint,
  'recibir actualiza el costo actual sin alterar snapshots históricos'
);

select is(
  (public.list_purchases(1, 20) ->> 'total')::bigint,
  1::bigint,
  'las compras exponen un historial paginado sin truncamiento silencioso'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.list_purchases()$$,
  'P0001',
  'FORBIDDEN',
  'personal no puede leer compras con costos'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.update_store_user_access('00000000-0000-4000-8000-000000000001', 'staff', true)$$,
  'P0001',
  'CANNOT_CHANGE_OWN_ACCESS',
  'una dueña no puede quitarse su propio acceso'
);

do $save_ipc$
begin
  perform public.save_inflation_index(jsonb_build_object(
    'period', to_char((date_trunc('month', current_date) - interval '1 month')::date, 'YYYY-MM-DD'),
    'indexValue', 123.456,
    'sourceUrl', 'https://www.indec.gob.ar/',
    'publishedAt', now()
  ));
end;
$save_ipc$;

select is(jsonb_array_length(public.list_inflation_indices()), 1, 'el IPC oficial se conserva con su fuente');
select is(
  jsonb_array_length(public.get_business_export_dataset() -> 'products'),
  1,
  'el respaldo incluye todos los productos'
);
select is(
  jsonb_array_length(public.get_business_export_dataset() -> 'orders'),
  1,
  'el respaldo incluye todos los pedidos'
);
select is(
  jsonb_array_length(public.get_business_export_dataset() -> 'reservations'),
  1,
  'el respaldo conserva la relación entre pedido, producto y reserva'
);
select is(
  jsonb_array_length(public.get_business_export_dataset() -> 'users'),
  2,
  'el respaldo conserva usuarios y permisos sin credenciales'
);
select ok(
  not exists(select 1 from public.stock_movements where btrim(product_name_snapshot) = ''),
  'cada movimiento conserva el nombre histórico del producto'
);

select * from finish();
rollback;
