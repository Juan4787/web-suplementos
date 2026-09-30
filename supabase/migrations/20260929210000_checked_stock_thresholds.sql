-- New callers compare the configuration they edited under the product row lock.
-- The original RPC remains available for existing callers.
create or replace function public.update_stock_thresholds_checked(
  p_product_id uuid, p_reorder_point integer, p_safety_stock integer,
  p_lead_time_days integer, p_expected jsonb
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_product public.products%rowtype;
begin
  perform private.require_owner();
  if p_expected is null or jsonb_typeof(p_expected) <> 'object'
    or not (p_expected ?& array['reorderPoint', 'safetyStock', 'leadTimeDays'])
    or p_reorder_point is null or p_safety_stock is null or p_lead_time_days is null
    or least(p_reorder_point, p_safety_stock, p_lead_time_days) < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_QUANTITY';
  end if;
  select * into v_product from public.products where id = p_product_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND'; end if;
  if (p_expected ->> 'reorderPoint')::integer is distinct from v_product.reorder_point
    or (p_expected ->> 'safetyStock')::integer is distinct from v_product.safety_stock
    or (p_expected ->> 'leadTimeDays')::integer is distinct from v_product.lead_time_days then
    raise exception using errcode = 'P0001', message = 'STOCK_THRESHOLDS_CHANGED';
  end if;
  perform public.update_stock_thresholds(p_product_id, p_reorder_point, p_safety_stock, p_lead_time_days);
end;
$$;
revoke all on function public.update_stock_thresholds_checked(uuid,integer,integer,integer,jsonb) from public, anon, authenticated;
grant execute on function public.update_stock_thresholds_checked(uuid,integer,integer,integer,jsonb) to authenticated;
