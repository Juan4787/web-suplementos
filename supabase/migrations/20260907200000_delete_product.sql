-- Migración para permitir la eliminación segura de productos
create or replace function public.delete_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prod record;
  v_has_orders boolean;
begin
  perform private.require_active_user();
  if not private.is_owner() then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  select * into v_prod from public.products where id = p_product_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;

  select exists(select 1 from public.order_items where product_id = p_product_id) into v_has_orders;
  if v_has_orders then
    raise exception using errcode = 'P0001', message = 'PRODUCT_HAS_ORDERS';
  end if;

  -- Actualizar costos de compras asociadas si existieran y eliminar sus items
  update public.purchases p
  set total_cost_cents = total_cost_cents - coalesce((
    select sum(quantity * unit_cost_cents)
    from public.purchase_items pi
    where pi.purchase_id = p.id and pi.product_id = p_product_id
  ), 0)
  where id in (select purchase_id from public.purchase_items where product_id = p_product_id);

  delete from public.purchase_items where product_id = p_product_id;
  delete from public.stock_reservations where product_id = p_product_id;
  delete from public.stock_movements where product_id = p_product_id;
  delete from public.stock_balances where product_id = p_product_id;
  delete from public.product_financials where product_id = p_product_id;
  delete from public.product_images where product_id = p_product_id;
  delete from public.products where id = p_product_id;

  perform private.bump_revision();

  return jsonb_build_object('success', true, 'deleted_id', p_product_id);
end;
$$;

revoke all on function public.delete_product(uuid) from public, anon, authenticated;
grant execute on function public.delete_product(uuid) to authenticated;
