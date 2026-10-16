-- Append missing historical release entries. Never change balances, reservations,
-- customer orders, financial snapshots, or the original stock movements.
begin;

create table private.reservation_history_repairs (
  product_id uuid not null references public.products(id),
  order_id uuid not null references public.orders(id),
  movement_id uuid not null unique references public.stock_movements(id),
  corrected_quantity integer not null check(corrected_quantity > 0),
  before_snapshot jsonb not null,
  repaired_at timestamptz not null default now(),
  primary key(product_id,order_id)
);
revoke all on private.reservation_history_repairs from public,anon,authenticated;

create or replace function private.repair_cancelled_reservation_history()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_product record;
  v_order record;
  v_physical bigint;
  v_reserved bigint;
  v_active bigint;
  v_candidates bigint;
  v_actor uuid;
  v_movement uuid;
  v_before jsonb;
  v_count integer:=0;
begin
  select user_id into v_actor from public.store_users where role='owner' and active order by user_id limit 1;
  for v_product in
    select p.id,p.name,sb.on_hand,sb.reserved from public.products p
    join public.stock_balances sb on sb.product_id=p.id
    where sb.reserved<>(select coalesce(sum(reserved_delta),0) from public.stock_movements where product_id=p.id)
    order by p.id for update of p,sb
  loop
    select coalesce(sum(physical_delta),0),coalesce(sum(reserved_delta),0)
      into v_physical,v_reserved from public.stock_movements where product_id=v_product.id;
    select coalesce(sum(quantity),0) into v_active from public.stock_reservations
      where product_id=v_product.id and state='active' and source_type='physical';
    -- Only an entirely explained surplus from cancelled orders can be repaired.
    select coalesce(sum(net),0) into v_candidates from (
      select sm.order_id,sum(sm.reserved_delta) net from public.stock_movements sm
      join public.orders o on o.id=sm.order_id
      where sm.product_id=v_product.id and o.order_state='cancelled' and o.fulfillment_state='cancelled'
        and not exists(select 1 from public.stock_reservations sr where sr.order_id=o.id and sr.product_id=v_product.id and sr.state='active')
      group by sm.order_id having sum(sm.reserved_delta)>0
    ) candidates;
    if v_physical<>v_product.on_hand or v_active<>v_product.reserved or
      v_reserved-v_product.reserved<>v_candidates or v_candidates<=0 or v_actor is null then
      raise exception 'RESERVATION_HISTORY_REQUIRES_MANUAL_REVIEW';
    end if;
    for v_order in
      select o.id,o.order_number,sum(sm.reserved_delta)::integer net
      from public.orders o join public.stock_movements sm on sm.order_id=o.id
      where sm.product_id=v_product.id and o.order_state='cancelled' and o.fulfillment_state='cancelled'
      group by o.id having sum(sm.reserved_delta)>0 order by o.id
    loop
      perform 1 from public.orders where id=v_order.id for update;
      if exists(select 1 from public.stock_reservations where order_id=v_order.id and product_id=v_product.id and state='active') then
        raise exception 'RESERVATION_HISTORY_REQUIRES_MANUAL_REVIEW';
      end if;
      select jsonb_build_object('onHand',v_product.on_hand,'reserved',v_product.reserved,
        'activePhysical',v_active,'movementReserved',v_reserved,'orderNumber',v_order.order_number,
        'orderState','cancelled','fulfillmentState','cancelled',
        'movements',coalesce(jsonb_agg(to_jsonb(sm) order by sm.created_at,sm.id),'[]'::jsonb))
        into v_before from public.stock_movements sm where sm.order_id=v_order.id and sm.product_id=v_product.id;
      insert into public.stock_movements(product_id,product_name_snapshot,kind,physical_delta,reserved_delta,reason,order_id,created_by)
      values(v_product.id,v_product.name,'reservation_release',0,-v_order.net,
        'Corrección automática de historial · Pedido #'||v_order.order_number||' ya cancelado. Se completa la liberación registrada; stock y reservas actuales sin cambios.',
        v_order.id,v_actor) returning id into v_movement;
      insert into private.reservation_history_repairs(product_id,order_id,movement_id,corrected_quantity,before_snapshot)
      values(v_product.id,v_order.id,v_movement,v_order.net,v_before);
      v_count:=v_count+1;
    end loop;
    if (select coalesce(sum(reserved_delta),0) from public.stock_movements where product_id=v_product.id)<>v_product.reserved then
      raise exception 'RESERVATION_HISTORY_REQUIRES_MANUAL_REVIEW';
    end if;
  end loop;
  if v_count>0 then perform private.bump_revision(); end if;
  return v_count;
end;
$$;
revoke all on function private.repair_cancelled_reservation_history() from public,anon,authenticated;
select private.repair_cancelled_reservation_history();
commit;
