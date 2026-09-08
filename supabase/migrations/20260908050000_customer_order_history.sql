-- Fetch only the selected customer's complete history, before pagination.
create or replace function public.list_customer_orders(
  p_customer_id uuid,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner boolean;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  if p_customer_id is null then
    raise exception using errcode='P0001', message='INVALID_INPUT';
  end if;
  return jsonb_build_object(
    'items', (
      select coalesce(jsonb_agg(private.order_payload(o.id, v_owner) order by o.created_at desc, o.id desc), '[]'::jsonb)
      from (
        select id, created_at from public.orders where customer_id=p_customer_id
        order by created_at desc, id desc limit v_size offset (v_page::bigint-1)*v_size
      ) o
    ),
    'page', v_page, 'pageSize', v_size,
    'total', (select count(*) from public.orders where customer_id=p_customer_id)
  );
end;
$$;
revoke all on function public.list_customer_orders(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.list_customer_orders(uuid,integer,integer) to authenticated;
