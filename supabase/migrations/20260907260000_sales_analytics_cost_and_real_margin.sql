-- Migración para incluir costCents en topProducts de get_sales_analytics
-- y asegurar la preservación del costo snapshot real por producto

create or replace function public.get_sales_analytics(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff_day integer;
  v_result jsonb;
begin
  perform private.require_owner();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception using errcode = 'P0001', message = 'INVALID_PERIOD';
  end if;
  if extract(day from p_from) = 1
    and date_trunc('month', p_from) <> date_trunc('month', p_to)
    and p_to < (date_trunc('month', p_to)::date + interval '1 month - 1 day')::date then
    v_cutoff_day := extract(day from p_to)::integer;
  else
    v_cutoff_day := null;
  end if;

  with paid_orders as materialized (
    select
      o.*,
      (o.paid_at at time zone 'America/Argentina/Buenos_Aires')::date as local_paid_date
    from public.orders o
    where o.payment_state = 'paid'
      and (o.paid_at at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
      and (
        v_cutoff_day is null
        or extract(day from (o.paid_at at time zone 'America/Argentina/Buenos_Aires')::date) <= v_cutoff_day
      )
  ), summary as (
    select
      coalesce(sum(total_cents), 0)::bigint as revenue_cents,
      coalesce(sum(cost_total_cents), 0)::bigint as cost_cents,
      coalesce(sum(tax_amount_cents), 0)::bigint as tax_cents,
      count(*)::integer as order_count
    from paid_orders
  ), unit_summary as (
    select coalesce(sum(oi.quantity), 0)::integer as units
    from paid_orders po
    join public.order_items oi on oi.order_id = po.id
  ), ranked_products as (
    select
      oi.product_id,
      oi.product_name_snapshot as name,
      sum(oi.quantity)::integer as units,
      sum(oi.line_subtotal_cents)::bigint as revenue_cents,
      sum(oi.unit_cost_cents * oi.quantity)::bigint as cost_cents,
      sum(
        oi.line_subtotal_cents
        - oi.unit_cost_cents * oi.quantity
        - case
            when po.total_cents > 0
              then round(po.tax_amount_cents * oi.line_subtotal_cents::numeric / po.total_cents)::bigint
            else 0
          end
      )::bigint as estimated_margin_cents
    from paid_orders po
    join public.order_items oi on oi.order_id = po.id
    group by oi.product_id, oi.product_name_snapshot
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
      'period', to_char(m.month_start, 'YYYY-MM'),
      'revenueCents', coalesce(m_orders.revenue_cents, 0),
      'adjustedRevenueCents', null,
      'orderCount', coalesce(m_orders.order_count, 0),
      'units', coalesce(m_orders.units, 0),
      'ipcPublished', false
    ) order by m.month_start), '[]'::jsonb) as payload
    from months m
    left join lateral (
      select
        sum(po.total_cents)::bigint as revenue_cents,
        count(*)::integer as order_count,
        sum(coalesce(u.units, 0))::integer as units
      from paid_orders po
      left join lateral (
        select sum(oi.quantity)::integer as units
        from public.order_items oi where oi.order_id = po.id
      ) u on true
      where date_trunc('month', po.local_paid_date) = m.month_start
    ) m_orders on true
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'comparisonCutoffDay', v_cutoff_day,
    'revenueCents', s.revenue_cents,
    'costCents', s.cost_cents,
    'taxCents', s.tax_cents,
    'estimatedMarginCents', greatest(0, s.revenue_cents - s.cost_cents - s.tax_cents),
    'averageTicketCents', case when s.order_count > 0 then round(s.revenue_cents::numeric / s.order_count)::bigint else 0 end,
    'orders', s.order_count,
    'units', coalesce(u.units, 0),
    'series', sr.payload,
    'topProducts', tp.payload
  ) into v_result
  from summary s
  cross join unit_summary u
  cross join top_products tp
  cross join series sr;

  return v_result;
end;
$$;

revoke all on function public.get_sales_analytics(date, date) from public, anon, authenticated;
grant execute on function public.get_sales_analytics(date, date) to authenticated;
