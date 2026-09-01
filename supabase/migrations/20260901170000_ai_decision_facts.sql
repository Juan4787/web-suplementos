begin;

create or replace function public.ai_get_product_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_total integer;
  v_products jsonb;
begin
  perform private.require_owner();

  select count(*)::integer
  into v_total
  from public.products
  where active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'ref', 'product:' || sku,
    'label', concat_ws(' · ', name, presentation),
    'facts', jsonb_build_object(
      'catalog.price_cents', price_cents,
      'catalog.price_rank', price_rank
    )
  ) order by name, presentation, sku), '[]'::jsonb)
  into v_products
  from (
    select
      sku,
      name,
      presentation,
      sale_price_cents as price_cents,
      dense_rank() over (order by sale_price_cents desc)::integer as price_rank
    from public.products
    where active
    order by name, presentation, sku
    limit 50
  ) selected;

  return jsonb_build_object(
    'schemaVersion', 'ai-facts/v1',
    'tool', 'get_product_catalog',
    'facts', jsonb_build_object(
      'catalog.active_product_count', v_total,
      'catalog.returned_product_count', jsonb_array_length(v_products)
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
  v_returned integer;
  v_returned_units integer;
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

  v_returned := jsonb_array_length(v_products);
  select coalesce(sum((product -> 'facts' ->> 'performance.units')::integer), 0)::integer
  into v_returned_units
  from jsonb_array_elements(v_products) product;

  return jsonb_build_object(
    'schemaVersion', 'ai-facts/v1',
    'tool', 'get_product_performance',
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'America/Argentina/Buenos_Aires'),
    'query', v_query,
    'facts', jsonb_build_object(
      'performance.returned_product_count', v_returned,
      'performance.returned_units', v_returned_units
    ),
    'products', v_products
  );
end;
$$;

create or replace function public.ai_get_top_selling_products(
  p_from date,
  p_to date,
  p_limit integer default 10
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_set(
    public.ai_get_product_performance(p_from, p_to, null, p_limit),
    '{tool}',
    to_jsonb('get_top_selling_products'::text),
    false
  );
$$;

revoke all on function public.ai_get_product_catalog() from public, anon;
revoke all on function public.ai_get_product_performance(date, date, text, integer) from public, anon;
revoke all on function public.ai_get_top_selling_products(date, date, integer) from public, anon;
grant execute on function public.ai_get_product_catalog() to authenticated;
grant execute on function public.ai_get_product_performance(date, date, text, integer) to authenticated;
grant execute on function public.ai_get_top_selling_products(date, date, integer) to authenticated;

commit;
