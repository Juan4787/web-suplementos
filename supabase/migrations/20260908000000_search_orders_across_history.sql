-- Additive RPC: keep list_orders available to older deployed clients.
create or replace function public.search_orders(
  p_page integer default 1,
  p_page_size integer default 20,
  p_search text default '',
  p_state text default 'all'
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
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_phone text := regexp_replace(v_search, '[^0-9]', '', 'g');
  v_result jsonb;
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  if p_state is null or p_state not in ('all', 'pending', 'completed') or char_length(v_search)>200 then
    raise exception using errcode='P0001', message='INVALID_INPUT';
  end if;
  with matched as materialized (
    select o.id, o.created_at,
      (o.order_state='cancelled' or (o.fulfillment_state='delivered' and o.payment_state='paid')) completed
    from public.orders o
    where v_search=''
      or position(v_search in lower(o.customer_name_snapshot))>0
      or position(v_search in o.order_number::text)>0
      or (char_length(v_phone)>=3 and position(v_phone in regexp_replace(coalesce(o.customer_phone_snapshot,''),'[^0-9]','','g'))>0)
  ), selected as (
    select * from matched where p_state='all' or (p_state='completed')=completed
  ), page_rows as (
    select * from selected order by created_at desc, id desc
    limit v_size offset (v_page::bigint-1)*v_size
  )
  select jsonb_build_object(
    'items', (select coalesce(jsonb_agg(private.order_payload(id,v_owner) order by created_at desc,id desc),'[]'::jsonb) from page_rows),
    'page',v_page,'pageSize',v_size,'total',(select count(*) from selected),
    'pendingTotal',(select count(*) from matched where not completed),
    'completedTotal',(select count(*) from matched where completed)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.search_orders(integer,integer,text,text) from public,anon,authenticated;
grant execute on function public.search_orders(integer,integer,text,text) to authenticated;
