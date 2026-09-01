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
    'facts', '{}'::jsonb
  ) order by name, presentation, sku), '[]'::jsonb)
  into v_products
  from (
    select sku, name, presentation
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

revoke all on function public.ai_get_product_catalog() from public, anon;
grant execute on function public.ai_get_product_catalog() to authenticated;

commit;
