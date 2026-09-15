begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select plan(43);

select ok(
  has_function_privilege('authenticated', 'public.list_misc_expenses(date,date)', 'execute'),
  'authenticated puede invocar la lectura protegida de gastos'
);
select ok(
  not has_function_privilege('anon', 'public.list_misc_expenses(date,date)', 'execute'),
  'anon no puede consultar gastos'
);
select ok(
  not has_table_privilege('authenticated', 'public.misc_expenses', 'insert'),
  'authenticated no puede saltear el RPC con una escritura directa'
);
select ok(
  not has_sequence_privilege('authenticated', 'public.misc_expense_audit_id_seq', 'usage'),
  'authenticated tampoco puede avanzar directamente la secuencia de auditoría'
);

insert into auth.users(id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000009501', 'expenses-owner@example.test', '{"display_name":"Dueña Gastos"}'),
  ('00000000-0000-4000-8000-000000009502', 'expenses-staff@example.test', '{"display_name":"Personal Gastos"}');
update public.store_users set active = true, role = 'owner'
where user_id = '00000000-0000-4000-8000-000000009501';
update public.store_users set active = true, role = 'staff'
where user_id = '00000000-0000-4000-8000-000000009502';
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009501', true);

select throws_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'operationId', '90000000-0000-4000-8000-000000009501',
    'title', 'Importe fuera de rango',
    'amountCents', 100000000000,
    'frequency', 'once',
    'startsOn', '2026-02-10',
    'endsOn', null
  ))$$,
  'P0001',
  'INVALID_MISC_EXPENSE',
  'la base rechaza montos que el navegador no puede acumular con precisión'
);

select lives_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'operationId', '10000000-0000-4000-8000-000000009501',
    'title', '  Sueldo administrativo  ',
    'amountCents', 10000,
    'frequency', 'monthly',
    'startsOn', '2026-01-31',
    'endsOn', '2026-03-31'
  ))$$,
  'la dueña crea una regla mensual'
);
select is((select count(*)::integer from public.misc_expenses), 1, 'la creación agrega una sola regla');
select is(
  (
    select string_agg(occurrence_on::text, ',' order by occurrence_on)
    from private.misc_expense_occurrences('2026-01-01', '2026-03-31')
  ),
  '2026-01-31,2026-02-28,2026-03-31',
  'el día 31 cae en el último día de un mes corto y vuelve al 31 después'
);
select is(
  (select count(*)::integer from private.misc_expense_occurrences('2026-02-01', '2026-02-28')),
  1,
  'la recurrencia mensual genera una sola ocurrencia por mes'
);

select lives_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'operationId', '20000000-0000-4000-8000-000000009501',
    'title', 'Etiquetas semanales',
    'amountCents', 2500,
    'frequency', 'weekly',
    'startsOn', '2026-02-02',
    'endsOn', '2026-02-28'
  ))$$,
  'la dueña crea una regla semanal con finalización'
);
select is((public.list_misc_expenses('2026-02-01', '2026-02-28') ->> 'expenseCount')::integer, 2, 'la lista mensual agrupa por regla');
select is((public.list_misc_expenses('2026-02-01', '2026-02-28') ->> 'occurrenceCount')::integer, 5, 'la lista cuenta una ocurrencia mensual y cuatro semanales');
select is((public.list_misc_expenses('2026-02-01', '2026-02-28') ->> 'totalCents')::bigint, 20000::bigint, 'el impacto del mes suma monto por cantidad de ocurrencias');
select is((public.get_sales_analytics('2026-02-01', '2026-02-28') ->> 'commercialMarginCents')::bigint, 0::bigint, 'sin ventas el margen comercial es cero');
select is((public.get_sales_analytics('2026-02-01', '2026-02-28') ->> 'miscExpensesCents')::bigint, 20000::bigint, 'analíticas incluyen todos los gastos del período');
select is((public.get_sales_analytics('2026-02-01', '2026-02-28') ->> 'estimatedMarginCents')::bigint, (-20000)::bigint, 'la ganancia neta descuenta gastos incluso sin ventas');
select is((public.ai_get_sales_summary('2026-02-01', '2026-02-28') -> 'facts' ->> 'sales.commercial_margin_cents')::bigint, 0::bigint, 'la IA recibe el margen comercial separado');
select is((public.ai_get_sales_summary('2026-02-01', '2026-02-28') -> 'facts' ->> 'sales.misc_expenses_cents')::bigint, 20000::bigint, 'la IA recibe los gastos del período');
select is((public.ai_get_sales_summary('2026-02-01', '2026-02-28') -> 'facts' ->> 'sales.net_profit_cents')::bigint, (-20000)::bigint, 'la IA recibe la ganancia neta reconciliada');

select is(
  public.save_misc_expense(jsonb_build_object(
    'operationId', '10000000-0000-4000-8000-000000009501',
    'title', 'Sueldo administrativo',
    'amountCents', 10000,
    'frequency', 'monthly',
    'startsOn', '2026-01-31',
    'endsOn', '2026-03-31'
  )) ->> 'id',
  (select id::text from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501'),
  'un reintento idéntico recupera la misma regla'
);
select is((select count(*)::integer from public.misc_expenses), 2, 'el reintento no duplica filas');
select throws_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'operationId', '10000000-0000-4000-8000-000000009501',
    'title', 'Sueldo administrativo',
    'amountCents', 99999,
    'frequency', 'monthly',
    'startsOn', '2026-01-31',
    'endsOn', '2026-03-31'
  ))$$,
  'P0001',
  'MISC_EXPENSE_OPERATION_REUSED',
  'una clave reutilizada con otro monto se rechaza'
);

select lives_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'id', (select id from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501'),
    'title', 'Sueldo administrativo',
    'amountCents', 12000,
    'frequency', 'monthly',
    'startsOn', '2026-01-31',
    'endsOn', '2026-03-31',
    'expectedUpdatedAt', (select updated_at from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501')
  ))$$,
  'la edición con versión vigente se aplica'
);
select is((select amount_cents from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501'), 12000::bigint, 'la edición cambia el monto');
select is((select count(*)::integer from public.misc_expense_audit where expense_id = (select id from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501')), 2, 'crear y editar dejan dos eventos de auditoría');
select lives_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'id', (select id from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501'),
    'title', 'Sueldo administrativo',
    'amountCents', 12000,
    'frequency', 'monthly',
    'startsOn', '2026-01-31',
    'endsOn', '2026-03-31',
    'expectedUpdatedAt', '2000-01-01T00:00:00Z'
  ))$$,
  'un reintento tardío con el mismo resultado es idempotente'
);
select throws_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'id', (select id from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501'),
    'title', 'Sueldo modificado sin refrescar',
    'amountCents', 13000,
    'frequency', 'monthly',
    'startsOn', '2026-01-31',
    'endsOn', '2026-03-31',
    'expectedUpdatedAt', '2000-01-01T00:00:00Z'
  ))$$,
  'P0001',
  'MISC_EXPENSE_CHANGED',
  'una edición desactualizada no pisa datos'
);
select throws_ok(
  $$select public.delete_misc_expense(
    (select id from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501'),
    '2000-01-01T00:00:00Z'
  )$$,
  'P0001',
  'MISC_EXPENSE_CHANGED',
  'una anulación desactualizada tampoco pisa datos'
);
select lives_ok(
  $$select public.delete_misc_expense(
    (select id from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501'),
    (select updated_at from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501')
  )$$,
  'la anulación con versión vigente funciona'
);
select ok((select deleted_at is not null from public.misc_expenses where operation_id = '10000000-0000-4000-8000-000000009501'), 'la baja es lógica y conserva la fila');
select is((public.get_sales_analytics('2026-02-01', '2026-02-28') ->> 'miscExpensesCents')::bigint, 10000::bigint, 'la regla anulada deja de impactar y se conserva la semanal');
select is(jsonb_array_length(public.get_business_export_dataset() -> 'expenses'), 2, 'el respaldo conserva gastos activos y anulados');
select is(jsonb_array_length(public.get_business_export_dataset() -> 'expenseHistory'), 4, 'el respaldo conserva el historial de altas, edición y anulación');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009502', true);
select throws_ok(
  $$select public.list_misc_expenses('2026-02-01', '2026-02-28')$$,
  'P0001',
  'FORBIDDEN',
  'personal no puede consultar gastos'
);
select throws_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'operationId', '30000000-0000-4000-8000-000000009502',
    'title', 'Intento de personal',
    'amountCents', 100,
    'frequency', 'once',
    'startsOn', '2026-02-10',
    'endsOn', null
  ))$$,
  'P0001',
  'FORBIDDEN',
  'personal no puede crear gastos'
);
select throws_ok(
  $$select public.delete_misc_expense(
    (select id from public.misc_expenses where operation_id = '20000000-0000-4000-8000-000000009501'),
    (select updated_at from public.misc_expenses where operation_id = '20000000-0000-4000-8000-000000009501')
  )$$,
  'P0001',
  'FORBIDDEN',
  'personal no puede anular gastos'
);

set local role authenticated;
do $capture_staff_rls$
begin
  perform set_config('test.staff_expense_rows', (select count(*)::text from public.misc_expenses), true);
  perform set_config('test.staff_expense_audit_rows', (select count(*)::text from public.misc_expense_audit), true);
end;
$capture_staff_rls$;
reset role;
select is(current_setting('test.staff_expense_rows'), '0', 'RLS oculta gastos ante una lectura directa de personal');
select is(current_setting('test.staff_expense_audit_rows'), '0', 'RLS también oculta la trazabilidad financiera');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009501', true);
select lives_ok(
  $$select public.save_misc_expense(jsonb_build_object(
    'operationId', '40000000-0000-4000-8000-000000009501',
    'title', 'Gasto de hoy',
    'amountCents', 777,
    'frequency', 'once',
    'startsOn', current_date,
    'endsOn', null
  ))$$,
  'se puede registrar un gasto puntual de hoy'
);
select is((public.get_dashboard_summary() ->> 'miscExpensesMonthCents')::bigint, 777::bigint, 'el dashboard informa gastos del mes hasta hoy');
select is((public.get_dashboard_summary() ->> 'estimatedMarginMonthCents')::bigint, (-777)::bigint, 'el dashboard descuenta el gasto de la ganancia neta mensual');
select is((public.list_misc_expenses(current_date, current_date) ->> 'totalCents')::bigint, 777::bigint, 'un gasto puntual impacta exactamente en la fecha elegida');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000009502', true);
select is(public.get_dashboard_summary() ->> 'miscExpensesMonthCents', null::text, 'el dashboard no filtra gastos al rol Personal');

select * from finish();
rollback;
