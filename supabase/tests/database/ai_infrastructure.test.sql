begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;

select plan(34);

select ok(
  has_function_privilege('authenticated', 'public.claim_ai_request(integer)', 'execute'),
  'authenticated puede reclamar una solicitud mediante RPC'
);
select ok(
  not has_function_privilege('anon', 'public.claim_ai_request(integer)', 'execute'),
  'anon no puede reclamar solicitudes de IA'
);
select ok(
  not has_table_privilege('authenticated', 'public.ai_request_audit', 'select'),
  'el cliente no puede leer directamente la auditoría de IA'
);
select ok(
  not has_table_privilege('authenticated', 'public.ai_usage_counters', 'update'),
  'el cliente no puede alterar directamente los contadores'
);
select ok(
  has_function_privilege('authenticated', 'public.ai_get_product_catalog()', 'execute'),
  'authenticated puede consultar el catálogo mediante la RPC cerrada'
);
select ok(
  not has_function_privilege('anon', 'public.ai_get_product_catalog()', 'execute'),
  'anon no puede consultar el catálogo de IA'
);
select ok(
  has_function_privilege('authenticated', 'public.ai_get_top_selling_products(date,date,integer)', 'execute'),
  'authenticated puede consultar el ranking de ventas mediante la RPC cerrada'
);
select ok(
  not has_function_privilege('anon', 'public.ai_get_top_selling_products(date,date,integer)', 'execute'),
  'anon no puede consultar el ranking de ventas'
);

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000051',
    'authenticated', 'authenticated', 'ai-owner@test.local', crypt('test-password', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"display_name":"Dueña IA"}', now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000052',
    'authenticated', 'authenticated', 'ai-staff@test.local', crypt('test-password', gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"display_name":"Personal IA"}', now(), now()
  );

update public.store_users set role = 'owner', active = true
where user_id = '00000000-0000-4000-8000-000000000051';
update public.store_users set role = 'staff', active = true
where user_id = '00000000-0000-4000-8000-000000000052';

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000052', true);
select throws_ok(
  $$select public.claim_ai_request(20)$$,
  'P0001', 'FORBIDDEN',
  'personal no puede usar el asistente'
);
select throws_ok(
  $$select public.ai_get_sales_summary(current_date - 1, current_date)$$,
  'P0001', 'FORBIDDEN',
  'personal no puede invocar tools financieras'
);
select throws_ok(
  $$select public.ai_get_product_catalog()$$,
  'P0001', 'FORBIDDEN',
  'personal no puede invocar la tool de catálogo'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000051', true);

do $setup_ai_product$
begin
  perform public.save_product(jsonb_build_object(
    'sku', 'AITEST',
    'slug', 'producto-ai-test',
    'name', 'Producto IA Test',
    'presentation', '500 g',
    'description', 'Texto que nunca debe salir por una tool de IA.',
    'category', 'Pruebas',
    'priceCents', 100000,
    'currentCostCents', 60000,
    'reorderPoint', 8,
    'safetyStock', 4,
    'leadTimeDays', 7,
    'imageUrl', '/demo/ai-test.svg',
    'imageAlt', 'Producto temporal de IA',
    'published', false,
    'active', true,
    'featured', false
  ));
  perform public.adjust_product_stock(
    (select id from public.products where sku = 'AITEST'),
    3,
    'Stock temporal para pruebas de IA'
  );
end;
$setup_ai_product$;

create temporary table claimed_request(payload jsonb);
insert into claimed_request select public.claim_ai_request(120);

select is((select payload ->> 'allowed' from claimed_request), 'true', 'la dueña obtiene un reclamo permitido');
select is((select count(*)::integer from public.ai_usage_counters), 2, 'el reclamo consume minuto y día de forma conjunta');
select is(
  (select status from public.ai_request_audit where id = (select (payload ->> 'requestId')::uuid from claimed_request)),
  'started',
  'el reclamo crea auditoría sin guardar el prompt'
);

select lives_ok(
  $$select public.complete_ai_request(
    (select (payload ->> 'requestId')::uuid from claimed_request),
    'success', 'gpt_oss_120b_groq_v1', array['get_inventory_status'], 0, 250
  )$$,
  'la dueña puede cerrar su solicitud con metadatos acotados'
);
select is(
  (select status from public.ai_request_audit where id = (select (payload ->> 'requestId')::uuid from claimed_request)),
  'success',
  'el cierre actualiza la auditoría'
);
select is(
  (select provider_transitions from public.ai_request_audit where id = (select (payload ->> 'requestId')::uuid from claimed_request)),
  0,
  'la auditoría registra transiciones sin contenido comercial'
);

select is(
  public.ai_get_sales_summary(current_date - 1, current_date) ->> 'schemaVersion',
  'ai-facts/v1',
  'ventas responde con el contrato de hechos versionado'
);
select ok(
  public.ai_get_sales_summary(current_date - 1, current_date) -> 'facts' ? 'sales.revenue_cents',
  'la facturación sale identificada y calculada por PostgreSQL'
);
select is(
  public.ai_compare_sales_periods(current_date - 3, current_date - 2, current_date - 1, current_date) ->> 'schemaVersion',
  'ai-facts/v1',
  'la comparación usa el mismo contrato versionado'
);

select is(
  jsonb_array_length(public.ai_get_inventory_status(true, 20) -> 'products'),
  1,
  'inventario devuelve solamente el producto que requiere atención'
);
select ok(
  not ((public.ai_get_inventory_status(true, 20) -> 'products' -> 0) ? 'id')
  and not ((public.ai_get_inventory_status(true, 20) -> 'products' -> 0) ? 'imageUrl')
  and not ((public.ai_get_inventory_status(true, 20) -> 'products' -> 0) ? 'description'),
  'la tool de inventario omite IDs internos, imágenes y texto libre'
);
select is(
  public.ai_get_inventory_status(true, 20) -> 'products' -> 0 ->> 'ref',
  'product:AITEST',
  'los productos se referencian por SKU auditable'
);
select is(
  public.ai_get_product_catalog() ->> 'schemaVersion',
  'ai-facts/v1',
  'el catálogo responde con el contrato de hechos versionado'
);
select ok(
  public.ai_get_product_catalog() -> 'products' @> '[{"ref":"product:AITEST","label":"Producto IA Test · 500 g","facts":{}}]'::jsonb,
  'el catálogo conserva nombre y presentación exactos sin exponer IDs internos'
);
select is(
  public.ai_get_product_catalog() -> 'products' -> 0 -> 'facts' ->> 'catalog.price_cents',
  '100000',
  'el catálogo expone el precio exacto calculado por PostgreSQL'
);
select is(
  public.ai_get_product_catalog() -> 'products' -> 0 -> 'facts' ->> 'catalog.price_rank',
  '1',
  'el catálogo ordena precios con una posición calculada por PostgreSQL'
);
select is(
  public.ai_get_product_performance(current_date - 30, current_date, 'AITEST', 10) -> 'products' -> 0 ->> 'ref',
  'product:AITEST',
  'rendimiento busca de forma acotada sin exponer clientes'
);
select ok(
  public.ai_get_top_selling_products(current_date - 30, current_date, 10) -> 'facts'
    @> '{"performance.returned_product_count":0,"performance.returned_units":0}'::jsonb,
  'rendimiento distingue explícitamente un período sin ventas'
);
select is(
  public.ai_get_top_selling_products(current_date - 30, current_date, 10) ->> 'tool',
  'get_top_selling_products',
  'el ranking devuelve su identidad lógica sin duplicar el cálculo financiero'
);
select throws_ok(
  $$select public.ai_get_product_performance(current_date - 500, current_date, null, 10)$$,
  'P0001', 'INVALID_AI_TOOL_ARGUMENTS',
  'las tools rechazan períodos excesivos'
);

do $consume_daily_quota$
declare
  i integer;
begin
  -- El primer reclamo ya fue consumido. Se usan buckets de minuto distintos
  -- para probar el límite diario sin activar antes el límite por minuto.
  for i in 1..99 loop
    delete from public.ai_usage_counters
    where user_id = auth.uid() and bucket_kind = 'minute';
    perform public.claim_ai_request(10);
  end loop;
end;
$consume_daily_quota$;

select is((public.claim_ai_request(10) ->> 'allowed')::boolean, false, 'el reclamo número 101 falla cerrado');
select is(
  (select request_count from public.ai_usage_counters where user_id = auth.uid() and bucket_kind = 'day'),
  100,
  'la cuota diaria nunca supera el límite bajo el RPC atómico'
);
select ok(
  exists(select 1 from public.ai_request_audit where user_id = auth.uid() and status = 'quota'),
  'un rechazo por cuota queda auditado sin prompt'
);

select * from finish();
rollback;
