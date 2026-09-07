-- Migración para permitir archivar y desarchivar productos de forma directa y atómica
create or replace function public.archive_product(p_product_id uuid, p_archived boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prod record;
begin
  perform private.require_active_user();
  if not private.is_owner() then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  select * into v_prod from public.products where id = p_product_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;

  update public.products
  set
    active = not p_archived,
    published = case when p_archived then false else published end,
    featured = case when p_archived then false else featured end,
    archived_at = case when p_archived then coalesce(archived_at, now()) else null end
  where id = p_product_id;

  perform private.bump_revision();

  return jsonb_build_object('success', true, 'id', p_product_id, 'active', not p_archived);
end;
$$;

revoke all on function public.archive_product(uuid, boolean) from public, anon, authenticated;
grant execute on function public.archive_product(uuid, boolean) to authenticated;
