-- Read-only reporting correction. No business rows, triggers or permissions change.
-- Full inclusive Buenos Aires date range for every aggregate and series.
-- Paid order counts and average ticket include cost sales; gifts stay separate.
-- Preserve the JSON contract (comparisonCutoffDay is now always null) and use
-- the stored exact line cost, which may combine physical and incoming batches.

create or replace function public.get_sales_analytics(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  perform private.require_owner();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception using errcode = 'P0001', message = 'INVALID_PERIOD';
  end if;

  with active_orders as materialized (
    select
      orders.*,
      (coalesce(orders.paid_at, orders.created_at) at time zone 'America/Argentina/Buenos_Aires')::date as local_effective_date
    from public.orders
    where orders.payment_state in ('paid', 'gifted')
      and (coalesce(orders.paid_at, orders.created_at) at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
  ), summary as (
    select
      coalesce(sum(total_cents), 0)::bigint as revenue_cents,
      coalesce(sum(cost_total_cents), 0)::bigint as cost_cents,
      coalesce(sum(tax_amount_cents), 0)::bigint as tax_cents,
      count(*) filter (where payment_state = 'paid')::integer as paid_order_count,
      count(*) filter (where payment_state = 'gifted' or coalesce(sale_type, 'retail') = 'gift')::integer as gift_order_count,
      coalesce(sum(cost_total_cents) filter (where payment_state = 'gifted' or coalesce(sale_type, 'retail') = 'gift'), 0)::bigint as gift_cost_cents,
      count(*) filter (where coalesce(sale_type, 'retail') = 'cost')::integer as cost_sale_order_count,
      coalesce(sum(total_cents) filter (where coalesce(sale_type, 'retail') = 'cost'), 0)::bigint as cost_sale_revenue_cents
    from active_orders
  ), expense_summary as (
    select
      coalesce(sum(occurrence.amount_cents), 0)::bigint as expense_cents,
      count(*)::integer as occurrence_count
    from private.misc_expense_occurrences(p_from, p_to) occurrence
  ), unit_summary as (
    select coalesce(sum(order_item.quantity), 0)::integer as units
    from active_orders active_order
    join public.order_items order_item on order_item.order_id = active_order.id
  ), ranked_products as (
    select
      order_item.product_id,
      order_item.product_name_snapshot as name,
      sum(order_item.quantity)::integer as units,
      sum(order_item.line_subtotal_cents)::bigint as revenue_cents,
      sum(order_item.cost_total_cents)::bigint as cost_cents,
      sum(
        order_item.line_subtotal_cents
        - order_item.cost_total_cents
        - case
            when active_order.total_cents > 0
              then round(active_order.tax_amount_cents * order_item.line_subtotal_cents::numeric / active_order.total_cents)::bigint
            else 0
          end
      )::bigint as estimated_margin_cents
    from active_orders active_order
    join public.order_items order_item on order_item.order_id = active_order.id
    group by order_item.product_id, order_item.product_name_snapshot
    order by units desc, revenue_cents desc, name
    limit 10
  ), top_products as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', product_id,
      'name', name,
      'units', units,
      'revenueCents', revenue_cents,
      'costCents', cost_cents,
      'estimatedMarginCents', estimated_margin_cents
    ) order by units desc, revenue_cents desc, name), '[]'::jsonb) as payload
    from ranked_products
  ), months as (
    select generate_series(
      date_trunc('month', p_from::timestamp),
      date_trunc('month', p_to::timestamp),
      interval '1 month'
    )::date as month_start
  ), series as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'period', to_char(month.month_start, 'YYYY-MM'),
      'revenueCents', coalesce(month_orders.revenue_cents, 0),
      'adjustedRevenueCents', null,
      'orderCount', coalesce(month_orders.order_count, 0),
      'units', coalesce(month_orders.units, 0),
      'ipcPublished', false
    ) order by month.month_start), '[]'::jsonb) as payload
    from months month
    left join lateral (
      select
        sum(active_order.total_cents)::bigint as revenue_cents,
        count(*) filter (where active_order.payment_state = 'paid')::integer as order_count,
        sum(coalesce(item_units.units, 0))::integer as units
      from active_orders active_order
      left join lateral (
        select sum(order_item.quantity)::integer as units
        from public.order_items order_item where order_item.order_id = active_order.id
      ) item_units on true
      where date_trunc('month', active_order.local_effective_date) = month.month_start
    ) month_orders on true
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'comparisonCutoffDay', null,
    'revenueCents', summary.revenue_cents,
    'costCents', summary.cost_cents,
    'taxCents', summary.tax_cents,
    'commercialMarginCents', summary.revenue_cents - summary.cost_cents - summary.tax_cents,
    'miscExpensesCents', expenses.expense_cents,
    'miscExpenseOccurrences', expenses.occurrence_count,
    'estimatedMarginCents', summary.revenue_cents - summary.cost_cents - summary.tax_cents - expenses.expense_cents,
    'averageTicketCents', case
      when summary.paid_order_count > 0
        then round(summary.revenue_cents::numeric / summary.paid_order_count)::bigint
      else 0
    end,
    'orders', summary.paid_order_count,
    'giftOrders', summary.gift_order_count,
    'giftCostCents', summary.gift_cost_cents,
    'costSaleOrders', summary.cost_sale_order_count,
    'costSaleRevenueCents', summary.cost_sale_revenue_cents,
    'units', coalesce(units.units, 0),
    'series', series.payload,
    'topProducts', top_products.payload
  ) into v_result
  from summary
  cross join expense_summary expenses
  cross join unit_summary units
  cross join top_products
  cross join series;

  return v_result;
end;
$$;

-- Keep the assistant product margin on the same stored line-cost snapshot.
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
        - oi.cost_total_cents
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
