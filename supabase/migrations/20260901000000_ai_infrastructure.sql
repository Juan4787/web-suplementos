begin;

alter table public.ai_request_audit
  drop constraint if exists ai_request_audit_status_check;

alter table public.ai_request_audit
  add constraint ai_request_audit_status_check
  check (status in ('started', 'success', 'quota', 'dependency_error', 'invalid_request')),
  add column if not exists completed_at timestamptz,
  add column if not exists provider_transitions integer not null default 0
    check (provider_transitions between 0 and 1),
  add column if not exists duration_ms integer
    check (duration_ms is null or duration_ms between 0 and 120000);

create index if not exists ai_request_audit_user_created_idx
  on public.ai_request_audit(user_id, created_at desc);

create or replace function public.claim_ai_request(p_input_chars integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_minute_bucket timestamptz;
  v_day_bucket timestamptz;
  v_minute_count integer;
  v_day_count integer;
  v_audit_id uuid;
  v_minute_limit constant integer := 4;
  v_day_limit constant integer := 30;
begin
  perform private.require_owner();

  if p_input_chars is null or p_input_chars < 1 or p_input_chars > 10000 then
    raise exception using errcode = 'P0001', message = 'INVALID_AI_REQUEST';
  end if;

  -- Serializa solamente los reclamos del mismo usuario. Evita superar los
  -- límites si dos pestañas envían una consulta al mismo tiempo.
  perform pg_advisory_xact_lock(73481, hashtext(auth.uid()::text));

  v_minute_bucket := date_trunc('minute', v_now);
  v_day_bucket := date_trunc('day', v_now);

  select coalesce(max(request_count), 0)
  into v_minute_count
  from public.ai_usage_counters
  where user_id = auth.uid()
    and bucket_kind = 'minute'
    and bucket_start = v_minute_bucket;

  select coalesce(max(request_count), 0)
  into v_day_count
  from public.ai_usage_counters
  where user_id = auth.uid()
    and bucket_kind = 'day'
    and bucket_start = v_day_bucket;

  if v_minute_count >= v_minute_limit or v_day_count >= v_day_limit then
    insert into public.ai_request_audit(user_id, status, input_chars, completed_at)
    values (auth.uid(), 'quota', p_input_chars, v_now)
    returning id into v_audit_id;

    return jsonb_build_object(
      'allowed', false,
      'requestId', v_audit_id,
      'retryAfter', case
        when v_day_count >= v_day_limit then 'next_utc_day'
        else 'next_minute'
      end
    );
  end if;

  insert into public.ai_usage_counters(user_id, bucket_kind, bucket_start, request_count)
  values (auth.uid(), 'minute', v_minute_bucket, 1)
  on conflict (user_id, bucket_kind, bucket_start)
  do update set request_count = public.ai_usage_counters.request_count + 1;

  insert into public.ai_usage_counters(user_id, bucket_kind, bucket_start, request_count)
  values (auth.uid(), 'day', v_day_bucket, 1)
  on conflict (user_id, bucket_kind, bucket_start)
  do update set request_count = public.ai_usage_counters.request_count + 1;

  insert into public.ai_request_audit(user_id, status, input_chars)
  values (auth.uid(), 'started', p_input_chars)
  returning id into v_audit_id;

  delete from public.ai_usage_counters
  where bucket_start < v_day_bucket - interval '2 days';

  return jsonb_build_object(
    'allowed', true,
    'requestId', v_audit_id,
    'context', jsonb_build_object(
      'currentDate', to_char(v_now at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD'),
      'timezone', 'America/Argentina/Buenos_Aires',
      'currency', 'ARS'
    )
  );
end;
$$;

create or replace function public.complete_ai_request(
  p_request_id uuid,
  p_status text,
  p_model_used text default null,
  p_tool_names text[] default '{}',
  p_provider_transitions integer default 0,
  p_duration_ms integer default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tool_names text[];
begin
  perform private.require_owner();

  if p_request_id is null
    or p_status not in ('success', 'dependency_error', 'invalid_request')
    or p_provider_transitions not between 0 and 1
    or (p_duration_ms is not null and p_duration_ms not between 0 and 120000)
    or char_length(coalesce(p_model_used, '')) > 100
    or coalesce(array_length(p_tool_names, 1), 0) > 8
  then
    raise exception using errcode = 'P0001', message = 'INVALID_AI_AUDIT';
  end if;

  select coalesce(array_agg(tool_name order by tool_name), '{}')
  into v_tool_names
  from (
    select distinct btrim(value) as tool_name
    from unnest(coalesce(p_tool_names, '{}')) as tool_values(value)
    where btrim(value) ~ '^[a-z][a-z0-9_]{1,63}$'
  ) normalized;

  if coalesce(array_length(v_tool_names, 1), 0) <> coalesce(array_length(p_tool_names, 1), 0) then
    raise exception using errcode = 'P0001', message = 'INVALID_AI_AUDIT';
  end if;

  update public.ai_request_audit
  set
    status = p_status,
    model_used = nullif(btrim(coalesce(p_model_used, '')), ''),
    tool_names = v_tool_names,
    provider_transitions = p_provider_transitions,
    duration_ms = p_duration_ms,
    completed_at = clock_timestamp()
  where id = p_request_id
    and user_id = auth.uid()
    and status = 'started';

  if not found then
    raise exception using errcode = 'P0001', message = 'AI_AUDIT_NOT_FOUND';
  end if;
end;
$$;

create or replace function private.ai_change_basis_points(p_current bigint, p_previous bigint)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_previous = 0 then null
    else round((p_current - p_previous)::numeric * 10000 / abs(p_previous))::integer
  end;
$$;

create or replace function public.ai_get_sales_summary(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_analytics jsonb;
begin
  perform private.require_owner();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = 'P0001', message = 'INVALID_PERIOD';
  end if;

  v_analytics := public.get_sales_analytics(p_from, p_to);
  return jsonb_build_object(
    'schemaVersion', 'ai-facts/v1',
    'tool', 'get_sales_summary',
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'America/Argentina/Buenos_Aires'),
    'facts', jsonb_build_object(
      'sales.revenue_cents', v_analytics -> 'revenueCents',
      'sales.cost_cents', v_analytics -> 'costCents',
      'sales.tax_cents', v_analytics -> 'taxCents',
      'sales.estimated_margin_cents', v_analytics -> 'estimatedMarginCents',
      'sales.average_ticket_cents', v_analytics -> 'averageTicketCents',
      'sales.order_count', v_analytics -> 'orders',
      'sales.units', v_analytics -> 'units'
    )
  );
end;
$$;

create or replace function public.ai_compare_sales_periods(
  p_first_from date,
  p_first_to date,
  p_second_from date,
  p_second_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_first jsonb;
  v_second jsonb;
  v_first_revenue bigint;
  v_second_revenue bigint;
  v_first_margin bigint;
  v_second_margin bigint;
  v_first_orders bigint;
  v_second_orders bigint;
  v_first_units bigint;
  v_second_units bigint;
begin
  perform private.require_owner();
  if p_first_from is null or p_first_to is null or p_second_from is null or p_second_to is null
    or p_first_to < p_first_from or p_second_to < p_second_from
    or p_first_to - p_first_from > 366 or p_second_to - p_second_from > 366
  then
    raise exception using errcode = 'P0001', message = 'INVALID_PERIOD';
  end if;

  v_first := public.get_sales_analytics(p_first_from, p_first_to);
  v_second := public.get_sales_analytics(p_second_from, p_second_to);
  v_first_revenue := (v_first ->> 'revenueCents')::bigint;
  v_second_revenue := (v_second ->> 'revenueCents')::bigint;
  v_first_margin := (v_first ->> 'estimatedMarginCents')::bigint;
  v_second_margin := (v_second ->> 'estimatedMarginCents')::bigint;
  v_first_orders := (v_first ->> 'orders')::bigint;
  v_second_orders := (v_second ->> 'orders')::bigint;
  v_first_units := (v_first ->> 'units')::bigint;
  v_second_units := (v_second ->> 'units')::bigint;

  return jsonb_build_object(
    'schemaVersion', 'ai-facts/v1',
    'tool', 'compare_sales_periods',
    'periods', jsonb_build_object(
      'first', jsonb_build_object('from', p_first_from, 'to', p_first_to),
      'second', jsonb_build_object('from', p_second_from, 'to', p_second_to),
      'timezone', 'America/Argentina/Buenos_Aires'
    ),
    'facts', jsonb_build_object(
      'first.revenue_cents', v_first_revenue,
      'first.estimated_margin_cents', v_first_margin,
      'first.order_count', v_first_orders,
      'first.units', v_first_units,
      'second.revenue_cents', v_second_revenue,
      'second.estimated_margin_cents', v_second_margin,
      'second.order_count', v_second_orders,
      'second.units', v_second_units,
      'change.revenue_cents', v_second_revenue - v_first_revenue,
      'change.revenue_basis_points', private.ai_change_basis_points(v_second_revenue, v_first_revenue),
      'change.margin_cents', v_second_margin - v_first_margin,
      'change.margin_basis_points', private.ai_change_basis_points(v_second_margin, v_first_margin),
      'change.order_count', v_second_orders - v_first_orders,
      'change.units', v_second_units - v_first_units
    )
  );
end;
$$;

create or replace function public.ai_get_inventory_status(
  p_only_attention boolean default true,
  p_limit integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_inventory jsonb;
  v_products jsonb;
  v_total integer;
  v_attention integer;
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 20);
begin
  perform private.require_owner();
  if p_only_attention is null or p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception using errcode = 'P0001', message = 'INVALID_AI_TOOL_ARGUMENTS';
  end if;

  v_inventory := private.inventory_payload();
  select count(*)::integer,
    count(*) filter (where item ->> 'status' <> 'ok')::integer
  into v_total, v_attention
  from jsonb_array_elements(v_inventory) item;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ref', 'product:' || (item ->> 'sku'),
    'label', concat_ws(' · ', item ->> 'name', item ->> 'presentation'),
    'status', item ->> 'status',
    'facts', jsonb_build_object(
      'stock.on_hand_units', (item ->> 'onHand')::integer,
      'stock.reserved_units', (item ->> 'reserved')::integer,
      'stock.available_units', (item ->> 'available')::integer,
      'stock.incoming_units', (item ->> 'incoming')::integer,
      'stock.projected_units', (item ->> 'projected')::integer,
      'stock.reorder_point_units', (item ->> 'reorderPoint')::integer,
      'stock.safety_units', (item ->> 'safetyStock')::integer,
      'stock.lead_time_days', (item ->> 'leadTimeDays')::integer,
      'stock.average_daily_sales_units', (item ->> 'averageDailySales')::numeric,
      'stock.coverage_days', case when item ->> 'coverageDays' is null then null else (item ->> 'coverageDays')::numeric end,
      'stock.suggested_purchase_units', (item ->> 'suggestedPurchase')::integer
    )
  ) order by position), '[]'::jsonb)
  into v_products
  from (
    select item, position
    from jsonb_array_elements(v_inventory) with ordinality inventory(item, position)
    where not p_only_attention or item ->> 'status' <> 'ok'
    order by position
    limit v_limit
  ) selected;

  return jsonb_build_object(
    'schemaVersion', 'ai-facts/v1',
    'tool', 'get_inventory_status',
    'generatedAt', now(),
    'timezone', 'America/Argentina/Buenos_Aires',
    'facts', jsonb_build_object(
      'inventory.active_product_count', v_total,
      'inventory.attention_product_count', v_attention,
      'inventory.returned_product_count', jsonb_array_length(v_products)
    ),
    'products', v_products
  );
end;
$$;

create or replace function public.ai_get_product_performance(
  p_from date,
  p_to date,
  p_query text default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 10);
  v_products jsonb;
begin
  perform private.require_owner();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366
    or p_limit is null or p_limit < 1 or p_limit > 10
    or char_length(coalesce(p_query, '')) > 80
  then
    raise exception using errcode = 'P0001', message = 'INVALID_AI_TOOL_ARGUMENTS';
  end if;

  with product_stats as (
    select
      p.sku,
      p.name,
      p.presentation,
      coalesce(sum(oi.quantity) filter (where o.id is not null), 0)::integer as units,
      coalesce(sum(oi.line_subtotal_cents) filter (where o.id is not null), 0)::bigint as revenue_cents,
      coalesce(sum(
        oi.line_subtotal_cents
        - oi.unit_cost_cents * oi.quantity
        - case
            when o.total_cents > 0
              then round(o.tax_amount_cents * oi.line_subtotal_cents::numeric / o.total_cents)::bigint
            else 0
          end
      ) filter (where o.id is not null), 0)::bigint as estimated_margin_cents,
      count(distinct o.id)::integer as order_count
    from public.products p
    left join public.order_items oi on oi.product_id = p.id
    left join public.orders o on o.id = oi.order_id
      and o.payment_state = 'paid'
      and (o.paid_at at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
    where v_query is null
      or position(lower(v_query) in lower(concat_ws(' ', p.sku, p.name, p.presentation))) > 0
    group by p.id, p.sku, p.name, p.presentation
  ), selected as (
    select *
    from product_stats
    where v_query is not null or units > 0
    order by units desc, revenue_cents desc, name
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'ref', 'product:' || sku,
    'label', concat_ws(' · ', name, presentation),
    'facts', jsonb_build_object(
      'performance.units', units,
      'performance.revenue_cents', revenue_cents,
      'performance.estimated_margin_cents', estimated_margin_cents,
      'performance.order_count', order_count
    )
  ) order by units desc, revenue_cents desc, name), '[]'::jsonb)
  into v_products
  from selected;

  return jsonb_build_object(
    'schemaVersion', 'ai-facts/v1',
    'tool', 'get_product_performance',
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'America/Argentina/Buenos_Aires'),
    'query', v_query,
    'products', v_products
  );
end;
$$;

revoke all on function public.claim_ai_request(integer) from public, anon;
revoke all on function public.complete_ai_request(uuid, text, text, text[], integer, integer) from public, anon;
revoke all on function public.ai_get_sales_summary(date, date) from public, anon;
revoke all on function public.ai_compare_sales_periods(date, date, date, date) from public, anon;
revoke all on function public.ai_get_inventory_status(boolean, integer) from public, anon;
revoke all on function public.ai_get_product_performance(date, date, text, integer) from public, anon;

grant execute on function public.claim_ai_request(integer) to authenticated;
grant execute on function public.complete_ai_request(uuid, text, text, text[], integer, integer) to authenticated;
grant execute on function public.ai_get_sales_summary(date, date) to authenticated;
grant execute on function public.ai_compare_sales_periods(date, date, date, date) to authenticated;
grant execute on function public.ai_get_inventory_status(boolean, integer) to authenticated;
grant execute on function public.ai_get_product_performance(date, date, text, integer) to authenticated;

commit;
