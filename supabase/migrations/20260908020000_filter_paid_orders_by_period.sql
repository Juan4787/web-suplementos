create or replace function public.search_paid_orders(
  p_page integer default 1, p_page_size integer default 20,
  p_from date default null, p_to date default null
)
returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp
as $$
declare
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,20),1),100);
  v_result jsonb;
begin
  perform private.require_owner();
  if p_from>p_to then raise exception using errcode='P0001',message='INVALID_PERIOD'; end if;
  with matched as materialized (
    select id,paid_at from public.orders
    where payment_state='paid'
      and (p_from is null or paid_at >= (p_from::timestamp at time zone 'America/Argentina/Buenos_Aires'))
      and (p_to is null or paid_at < ((p_to+1)::timestamp at time zone 'America/Argentina/Buenos_Aires'))
  ), page_rows as (
    select * from matched order by paid_at desc,id desc limit v_size offset (v_page::bigint-1)*v_size
  )
  select jsonb_build_object('items',(select coalesce(jsonb_agg(private.order_payload(id,true) order by paid_at desc,id desc),'[]'::jsonb) from page_rows),
    'page',v_page,'pageSize',v_size,'total',(select count(*) from matched)) into v_result;
  return v_result;
end;
$$;
revoke all on function public.search_paid_orders(integer,integer,date,date) from public,anon,authenticated;
grant execute on function public.search_paid_orders(integer,integer,date,date) to authenticated;
