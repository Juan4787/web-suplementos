-- Administrative incoming stock is the pending physical quantity. Free incoming
-- capacity remains the canonical amount available for new customer orders.
create or replace function private.product_payload(p_product_id uuid, p_include_financials boolean)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with capacity as (
    select * from private.product_incoming_capacity(p_product_id)
  ), pending as (
    select coalesce(sum(pi.quantity - pi.received_quantity - pi.shortage_quantity), 0)::integer as quantity
    from public.purchase_items pi
    join public.purchases pu on pu.id = pi.purchase_id and pu.state = 'ordered'
    where pi.product_id = p_product_id
  )
  select jsonb_build_object(
    'id', p.id, 'sku', p.sku, 'slug', p.slug, 'name', p.name,
    'presentation', p.presentation, 'description', p.description,
    'priceCents', p.sale_price_cents,
    'imageUrl', coalesce(i.public_url, '/product-placeholder.svg'),
    'imageAlt', coalesce(i.alt_text, p.name),
    'availability', case
      when greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) > 0 then
        case when greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) <= p.reorder_point then 'low' else 'available' end
      when c.available_incoming > 0 then 'incoming'
      else 'out_of_stock'
    end,
    'maxOrderQuantity', least(20, greatest(0, coalesce(s.on_hand, 0) - coalesce(s.reserved, 0)) + c.available_incoming),
    'incomingAvailable', c.available_incoming, 'incomingExpectedAt', c.first_expected_at,
    'category', p.category, 'featured', p.featured, 'active', p.active, 'published', p.published,
    'reorderPoint', p.reorder_point, 'safetyStock', p.safety_stock, 'leadTimeDays', p.lead_time_days,
    'onHand', coalesce(s.on_hand, 0), 'reserved', coalesce(s.reserved, 0),
    'incoming', pending.quantity, 'incomingReserved', pending.quantity - c.available_incoming,
    'currentCostCents', case when p_include_financials then f.current_cost_cents else null end,
    'updatedAt', p.updated_at
  )
  from public.products p
  left join public.stock_balances s on s.product_id = p.id
  left join public.product_financials f on f.product_id = p.id
  cross join capacity c
  cross join pending
  left join lateral (
    select public_url, alt_text from public.product_images
    where product_id = p.id order by position, created_at limit 1
  ) i on true
  where p.id = p_product_id;
$$;

create or replace function private.inventory_payload()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with movement_sales as (
    select product_id, coalesce(sum(-physical_delta) filter (
      where kind = 'sale' and created_at >= now() - interval '30 days'
    ), 0)::numeric / 30 as average_daily_sales
    from public.stock_movements group by product_id
  ), incoming as (
    select pi.product_id, coalesce(sum(pi.quantity - pi.received_quantity - pi.shortage_quantity), 0)::integer as quantity
    from public.purchase_items pi
    join public.purchases p on p.id = pi.purchase_id and p.state = 'ordered'
    group by pi.product_id
  ), inventory as (
    select p.*, coalesce(s.on_hand, 0) as on_hand, coalesce(s.reserved, 0) as reserved,
      coalesce(i.quantity, 0) as incoming,
      c.available_incoming as incoming_available,
      greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) as available,
      coalesce(ms.average_daily_sales, 0) as average_daily_sales,
      coalesce(img.public_url, '/product-placeholder.svg') as image_url
    from public.products p
    left join public.stock_balances s on s.product_id = p.id
    left join movement_sales ms on ms.product_id = p.id
    left join incoming i on i.product_id = p.id
    cross join lateral private.product_incoming_capacity(p.id) c
    left join lateral (
      select public_url from public.product_images
      where product_id = p.id order by position, created_at limit 1
    ) img on true
    where p.active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'sku', sku, 'name', name, 'presentation', presentation, 'imageUrl', image_url,
    'onHand', on_hand, 'reserved', reserved, 'available', available,
    'incoming', incoming, 'incomingReserved', incoming - incoming_available,
    'projected', available + incoming_available,
    'reorderPoint', reorder_point, 'safetyStock', safety_stock, 'leadTimeDays', lead_time_days,
    'averageDailySales', round(average_daily_sales, 2),
    'coverageDays', case when average_daily_sales > 0 then round(available / average_daily_sales, 1) else null end,
    'suggestedPurchase', greatest(ceil(average_daily_sales * lead_time_days + safety_stock)::integer - available - incoming_available, 0),
    'status', case when available <= 0 then 'out' when available <= safety_stock then 'critical' when available <= reorder_point then 'low' else 'ok' end
  ) order by case when available <= 0 then 0 when available <= safety_stock then 1 when available <= reorder_point then 2 else 3 end, name), '[]'::jsonb)
  from inventory;
$$;

create or replace function public.get_storefront_products()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg((private.product_payload(p.id, false) - array[
    'active', 'published', 'reorderPoint', 'safetyStock', 'leadTimeDays',
    'onHand', 'reserved', 'incoming', 'incomingReserved', 'currentCostCents', 'updatedAt'
  ]) order by p.featured desc, p.name), '[]'::jsonb)
  from public.products p where p.active and p.published;
$$;

create or replace function public.get_storefront_product(p_slug text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select private.product_payload(p.id, false) - array[
    'active', 'published', 'reorderPoint', 'safetyStock', 'leadTimeDays',
    'onHand', 'reserved', 'incoming', 'incomingReserved', 'currentCostCents', 'updatedAt'
  ] from public.products p where p.slug = p_slug and p.active and p.published;
$$;
