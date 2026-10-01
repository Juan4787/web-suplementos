begin;

-- This fixture must never run against a customer database. The runner also
-- checks the isolated Docker network, container ownership and instance UUID.
do $$ begin
  if to_regclass('staging_guard.identity') is null then
    raise exception 'LOCAL_STAGING_REQUIRED';
  end if;
end $$;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select no_plan();

insert into auth.users(id,email) values
  ('00000000-0000-4000-8000-000000010101','sales-calendar-owner@example.test'),
  ('00000000-0000-4000-8000-000000010102','sales-calendar-staff@example.test');
update public.store_users set active=true,role='owner' where user_id='00000000-0000-4000-8000-000000010101';
update public.store_users set active=true,role='staff' where user_id='00000000-0000-4000-8000-000000010102';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000010101',true);

insert into public.products(id,sku,slug,name,presentation,description,category,sale_price_cents) values
  ('00000000-0000-4000-8000-000000010111','QA-SALES-R','qa-sales-r','QA Sales Retail','Test','Synthetic','Test',123457),
  ('00000000-0000-4000-8000-000000010112','QA-SALES-C','qa-sales-c','QA Sales Cost','Test','Synthetic','Test',33851),
  ('00000000-0000-4000-8000-000000010113','QA-SALES-G','qa-sales-g','QA Sales Gift','Test','Synthetic','Test',0);

create temp table calendar_fixture as
select md5(d::text||kind)::uuid as id,d::date as day,kind,
  (d::date-date '2031-01-01')::int as ordinal,
  case kind when 'retail' then 3 when 'cost' then 2 else 1 end as qty
from generate_series(timestamp '2031-01-01',timestamp '2032-12-31',interval '1 day') d
cross join (values ('retail'),('cost'),('gift'),('pending'),('refunded')) k(kind);

-- Explicit order numbers avoid advancing the local order sequence even when
-- this transaction rolls back. No reservations, purchases or movements.
insert into public.orders(id,order_number,customer_name_snapshot,payment_method,delivery_method,source,
  payment_state,sale_type,subtotal_cents,shipping_fee_cents,total_cents,tax_rate_basis_points,
  tax_amount_cents,cost_total_cents,created_by,created_at,confirmed_at,paid_at)
select id,-100000000-row_number() over(order by day,kind),'QA Calendar',
  case when kind='gift' then 'gift' else 'cash' end::public.payment_method,'pickup','manual',
  case kind when 'gift' then 'gifted' when 'pending' then 'pending' when 'refunded' then 'refunded' else 'paid' end::public.payment_state,
  case when kind in ('gift','cost') then kind else 'retail' end,
  case kind when 'retail' then 3*(123457+ordinal) when 'cost' then 67702 else 0 end,
  case when kind='retail' then 101 else 0 end,
  case kind when 'retail' then 3*(123457+ordinal)+101 when 'cost' then 67702 else 0 end,
  case when kind='retail' then 220 else 0 end,
  case when kind='retail' then 8153+ordinal%3 else 0 end,
  case kind when 'retail' then 130703 when 'cost' then 67702 when 'gift' then 215003 else 0 end,
  '00000000-0000-4000-8000-000000010101',
  (day+time '12:00') at time zone 'America/Argentina/Buenos_Aires',
  (day+time '12:00') at time zone 'America/Argentina/Buenos_Aires',
  case when kind='gift' and ordinal%2=0 then null else (day+time '12:00') at time zone 'America/Argentina/Buenos_Aires' end
from calendar_fixture;

insert into public.order_items(order_id,product_id,sku_snapshot,product_name_snapshot,presentation_snapshot,
  quantity,unit_price_cents,unit_cost_cents,cost_total_cents)
select id,
  case kind when 'retail' then '00000000-0000-4000-8000-000000010111' when 'cost' then '00000000-0000-4000-8000-000000010112' else '00000000-0000-4000-8000-000000010113' end::uuid,
  'QA-CALENDAR',case kind when 'retail' then 'QA Sales Retail' when 'cost' then 'QA Sales Cost' else 'QA Sales Gift' end,'Test',qty,
  case kind when 'retail' then 123457+ordinal when 'cost' then 33851 else 0 end,
  case kind when 'retail' then 43000 when 'cost' then 33851 else 215003 end,
  case kind when 'retail' then 130703 when 'cost' then 67702 else 215003 end
from calendar_fixture where kind in ('retail','cost','gift');

-- Exercise local midnight on leap day. Both timestamps have a March UTC date,
-- while the first belongs to February in the business calendar.
update public.orders set paid_at='2032-03-01T02:59:59.999999Z'
where id=(select id from calendar_fixture where day='2032-02-29' and kind='retail');
update public.orders set paid_at='2032-03-01T03:00:00Z'
where id=(select id from calendar_fixture where day='2032-03-01' and kind='cost');

insert into public.misc_expenses(operation_id,title,amount_cents,frequency,starts_on,ends_on,created_by,updated_by) values
  ('00000000-0000-4000-8000-000000010121','QA calendar monthly',50003,'monthly','2031-01-31','2032-12-31','00000000-0000-4000-8000-000000010101','00000000-0000-4000-8000-000000010101'),
  ('00000000-0000-4000-8000-000000010122','QA calendar weekly',1009,'weekly','2031-01-02','2032-12-31','00000000-0000-4000-8000-000000010101','00000000-0000-4000-8000-000000010101'),
  ('00000000-0000-4000-8000-000000010123','QA calendar once',99901,'once','2032-09-15',null,'00000000-0000-4000-8000-000000010101','00000000-0000-4000-8000-000000010101');

create temp table expense_oracle as
select (m+interval '1 month - 1 day')::date as day,50003::bigint as amount
from generate_series(timestamp '2031-01-01',timestamp '2032-12-01',interval '1 month') m
union all select w::date,1009 from generate_series(timestamp '2031-01-02',timestamp '2032-12-31',interval '7 days') w
union all select date '2032-09-15',99901;

create temp table ranges as
select label,d::date as t,f::date as f
from generate_series(timestamp '2031-01-01',timestamp '2032-12-31',interval '1 day') d
cross join lateral (values
  ('day',d),('month',date_trunc('month',d)),('six_months',date_trunc('month',d)-interval '5 months'),
  ('year',date_trunc('year',d)),('30_days',d-interval '29 days'),
  ('custom',timestamp '2031-01-01'),('custom_day_2',timestamp '2031-01-02')
) p(label,f) where f<=d;
insert into ranges values
  ('month_end','2032-09-30','2032-04-01'),('first_day','2032-10-01','2032-05-01'),
  ('empty','2030-12-31','2030-12-01'),('max_range','2040-01-09','2030-01-01');

create temp table failures(kind text,period text,detail jsonb);
create temp table read_fingerprint as
select md5(string_agg(md5(row_to_json(o)::text),'' order by id)) as orders_hash from public.orders o;
do $matrix$
declare r record; a jsonb; e jsonb; s record; m record; p record; actual_product jsonb; expected_cost bigint;
begin
  for r in select * from ranges loop
    a:=public.get_sales_analytics(r.f,r.t);
    select coalesce(sum(total_cents),0) as revenue,coalesce(sum(cost_total_cents),0) as cost,
      coalesce(sum(tax_amount_cents),0) as tax,count(*) filter(where payment_state='paid') as paid,
      count(*) filter(where payment_state='gifted') as gifts,
      count(*) filter(where sale_type='cost') as cost_orders,
      coalesce(sum(total_cents) filter(where sale_type='cost'),0) as cost_revenue,
      coalesce(sum(cost_total_cents) filter(where payment_state='gifted'),0) as gift_cost
    into s from public.orders
    where payment_state in ('paid','gifted') and coalesce(paid_at,created_at)>=r.f::timestamp at time zone 'America/Argentina/Buenos_Aires'
      and coalesce(paid_at,created_at)<(r.t+1)::timestamp at time zone 'America/Argentina/Buenos_Aires';
    e:=jsonb_build_object('revenueCents',s.revenue,'costCents',s.cost,'taxCents',s.tax,'orders',s.paid,
      'giftOrders',s.gifts,'costSaleOrders',s.cost_orders,'costSaleRevenueCents',s.cost_revenue,'giftCostCents',s.gift_cost,
      'miscExpensesCents',(select coalesce(sum(amount),0) from expense_oracle where day between r.f and r.t),
      'miscExpenseOccurrences',(select count(*) from expense_oracle where day between r.f and r.t),
      'commercialMarginCents',s.revenue-s.cost-s.tax,
      'averageTicketCents',case when s.paid>0 then round(s.revenue::numeric/s.paid)::bigint else 0 end);
    e:=e||jsonb_build_object('estimatedMarginCents',s.revenue-s.cost-s.tax-(e->>'miscExpensesCents')::bigint);
    if not a @> e or a->'comparisonCutoffDay'<>'null'::jsonb then
      insert into failures values('summary',r.label||' '||r.f||'/'||r.t,jsonb_build_object('expected',e,'actual',a-'series'-'topProducts'));
    end if;
    if (select coalesce(sum((v->>'revenueCents')::bigint),0) from jsonb_array_elements(a->'series') v)<>s.revenue
      or (select coalesce(sum((v->>'orderCount')::bigint),0) from jsonb_array_elements(a->'series') v)<>s.paid then
      insert into failures values('series',r.label||' '||r.f||'/'||r.t,a->'series');
    end if;
    if (public.search_paid_orders(1,1,r.f,r.t)->>'total')::bigint<>s.paid+s.gifts then
      insert into failures values('list',r.label||' '||r.f||'/'||r.t,'null');
    end if;
  end loop;
end $matrix$;
select is((select count(*) from ranges),5120::bigint,'731 fechas consecutivas, siete rangos por fecha y cuatro extremos');
select is((select count(*) from failures where kind='summary'),0::bigint,'todos los rangos concilian cobros, costos, impuestos, gastos, conteos y ticket exactos');
select is((select count(*) from failures where kind='series'),0::bigint,'los meses suman exactamente la facturación y el conteo de cobros');
select is((select count(*) from failures where kind='list'),0::bigint,'la tabla incluye cobros y regalos del mismo intervalo');
select diag(kind||' '||period||' '||detail::text) from failures limit 3;
select is((public.get_sales_analytics('2032-02-29','2032-02-29')->>'orders')::bigint,2::bigint,'medianoche UTC no mueve el cobro de febrero a marzo');
select is((public.get_sales_analytics('2032-03-01','2032-03-01')->>'orders')::bigint,2::bigint,'medianoche local incluye el siguiente día sin duplicar el anterior');
select is((public.get_sales_analytics('2032-09-01','2032-10-01')->'topProducts'->0->>'costCents')::bigint,4051793::bigint,'productos conserva costos totales históricos exactos de líneas mixtas');
select is((public.ai_get_sales_summary('2032-09-01','2032-10-01')->'facts'->>'sales.order_count')::bigint,62::bigint,'el asistente incluye las ventas al costo en pedidos cobrados');
select is((public.ai_get_product_performance('2032-09-01','2032-10-01','QA-SALES-R',1)->'products'->0->'facts'->>'performance.estimated_margin_cents')::bigint,
  (select sum(oi.line_subtotal_cents-oi.cost_total_cents-round(o.tax_amount_cents*oi.line_subtotal_cents::numeric/o.total_cents)::bigint)::bigint
   from public.order_items oi join public.orders o on o.id=oi.order_id
   where oi.product_id='00000000-0000-4000-8000-000000010111' and o.payment_state='paid'
     and o.paid_at>='2032-09-01T00:00:00-03:00' and o.paid_at<'2032-10-02T00:00:00-03:00'),
  'el asistente por producto conserva el costo exacto de las mismas líneas');
select is((select md5(string_agg(md5(row_to_json(o)::text),'' order by id)) from public.orders o),(select orders_hash from read_fingerprint),'las lecturas no cambian pedidos');

insert into public.orders(order_number,customer_name_snapshot,payment_method,delivery_method,source,payment_state,sale_type,
  subtotal_cents,total_cents,tax_rate_basis_points,tax_amount_cents,cost_total_cents,created_by,created_at,paid_at) values
  (-100010001,'QA Cost Only','cash','pickup','manual','paid','cost',67703,67703,0,0,67703,'00000000-0000-4000-8000-000000010101','2033-01-01T12:00:00-03:00','2033-01-01T12:00:00-03:00'),
  (-100010002,'QA Gift Only','gift','pickup','manual','gifted','gift',0,0,0,0,75001,'00000000-0000-4000-8000-000000010101','2033-01-02T12:00:00-03:00',null),
  (-100010003,'QA Zero Paid','cash','pickup','manual','paid','retail',0,0,0,0,0,'00000000-0000-4000-8000-000000010101','2033-01-03T12:00:00-03:00','2033-01-03T12:00:00-03:00');
select is((public.get_sales_analytics('2033-01-01','2033-01-01')->>'orders')::bigint,1::bigint,'una venta al costo sola cuenta como un cobro');
select is((public.get_sales_analytics('2033-01-01','2033-01-01')->>'averageTicketCents')::bigint,67703::bigint,'ticket de venta al costo sola tiene numerador y denominador coherentes');
select is((public.get_sales_analytics('2033-01-02','2033-01-02')->>'orders')::bigint,0::bigint,'regalos solos no cuentan como cobros');
select is((public.get_sales_analytics('2033-01-02','2033-01-02')->>'averageTicketCents')::bigint,0::bigint,'regalos solos no dividen por cero');
select is((public.get_sales_analytics('2033-01-02','2033-01-02')->>'estimatedMarginCents')::bigint,(-75001)::bigint,'la pérdida por regalo no se recorta a cero');
select is((public.get_sales_analytics('2033-01-03','2033-01-03')->>'orders')::bigint,1::bigint,'un cobro de importe cero no desaparece del conteo');
select is((public.get_sales_analytics('2033-01-01','2033-01-03')->>'averageTicketCents')::bigint,33852::bigint,'ticket redondea una sola vez el medio centavo');
select throws_ok($$select public.get_sales_analytics('2032-10-02','2032-10-01')$$,'P0001','INVALID_PERIOD','rango invertido rechazado');
select throws_ok($$select public.get_sales_analytics(null,'2032-10-01')$$,'P0001','INVALID_PERIOD','fecha faltante rechazada');
select throws_ok($$select public.get_sales_analytics('2030-01-01','2040-01-10')$$,'P0001','INVALID_PERIOD','límite de 3660 días preservado');
select ok(not has_function_privilege('anon','public.get_sales_analytics(date,date)','execute'),'acceso anónimo sigue bloqueado');
select ok(not has_function_privilege('anon','public.ai_get_product_performance(date,date,text,integer)','execute'),'el asistente por producto sigue bloqueado para anónimos');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000010102',true);
select throws_ok($$select public.get_sales_analytics('2032-09-01','2032-10-01')$$,'P0001','FORBIDDEN','personal sigue sin acceso financiero');
select throws_ok($$select public.ai_get_product_performance('2032-09-01','2032-10-01',null,10)$$,'P0001','FORBIDDEN','personal sigue sin acceso financiero por producto');
select * from finish();
rollback;
