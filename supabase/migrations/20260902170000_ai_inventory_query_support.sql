begin;

drop function if exists public.ai_get_inventory_status(boolean, integer);
drop function if exists public.ai_get_inventory_status(boolean, integer, text);

create or replace function public.ai_get_inventory_status(
  p_only_attention boolean default false,
  p_limit integer default 50,
  p_query text default null
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
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_clean_query text := nullif(trim(p_query), '');
begin
  perform private.require_owner();
  if p_only_attention is null or p_limit is null or p_limit < 1 or p_limit > 50 then
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
  ) order by
    case when v_clean_query is null and (item ->> 'status' <> 'ok') then 0 else 1 end,
    item ->> 'name',
    item ->> 'presentation'
  ), '[]'::jsonb)
  into v_products
  from (
    select item, position
    from jsonb_array_elements(v_inventory) with ordinality inventory(item, position)
    where (
      v_clean_query is null
      or item ->> 'name' ilike '%' || v_clean_query || '%'
      or item ->> 'presentation' ilike '%' || v_clean_query || '%'
      or item ->> 'sku' ilike '%' || v_clean_query || '%'
    )
    and (
      v_clean_query is not null
      or not p_only_attention
      or item ->> 'status' <> 'ok'
    )
    order by
      case when v_clean_query is null and (item ->> 'status' <> 'ok') then 0 else 1 end,
      item ->> 'name',
      item ->> 'presentation'
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

revoke all on function public.ai_get_inventory_status(boolean, integer, text) from public, anon;
grant execute on function public.ai_get_inventory_status(boolean, integer, text) to authenticated;

commit;
