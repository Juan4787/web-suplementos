create or replace function public.update_stock_thresholds(
  p_product_id uuid,
  p_reorder_point integer,
  p_safety_stock integer,
  p_lead_time_days integer default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner boolean;
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  if not v_owner then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  update public.products
  set
    reorder_point = greatest(0, p_reorder_point),
    safety_stock = greatest(0, p_safety_stock),
    lead_time_days = coalesce(greatest(0, p_lead_time_days), lead_time_days),
    updated_at = now()
  where id = p_product_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;
end;
$$;

grant execute on function public.update_stock_thresholds(uuid, integer, integer, integer) to authenticated;
