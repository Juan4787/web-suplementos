-- Keep the existing delta API for older clients; protect count forms with an expected balance.
create or replace function public.adjust_product_stock_checked(
  p_product_id uuid, p_delta integer, p_reason text, p_expected_on_hand integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_on_hand integer;
begin
  perform private.require_owner();
  if p_delta is null or p_expected_on_hand is null or p_delta=0
    or char_length(btrim(coalesce(p_reason,'')))<3
    or p_expected_on_hand::bigint+p_delta not between 0 and 2147483647 then
    raise exception using errcode='P0001',message='INVALID_ADJUSTMENT';
  end if;
  -- Match order/receipt lock order: product before its balance.
  perform 1 from public.products where id=p_product_id for update;
  select on_hand into v_on_hand from public.stock_balances where product_id=p_product_id for update;
  if not found then raise exception using errcode='P0001',message='PRODUCT_NOT_FOUND'; end if;
  if v_on_hand<>p_expected_on_hand then
    raise exception using errcode='P0001',message='STALE_STOCK_COUNT';
  end if;
  perform public.adjust_product_stock(p_product_id,p_delta,p_reason);
end;
$$;
revoke all on function public.adjust_product_stock_checked(uuid,integer,text,integer) from public,anon,authenticated;
grant execute on function public.adjust_product_stock_checked(uuid,integer,text,integer) to authenticated;
