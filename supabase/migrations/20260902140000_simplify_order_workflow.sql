-- Migración: Simplificación del flujo de pedidos a Cobrado y Entregado directos
-- Elimina restricciones artificiales de preparación previa y permite registrar cobro y entrega en cualquier orden.

create or replace function public.transition_order(p_order_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_inventory_leaves boolean := false;
  v_new_fulfillment public.fulfillment_state;
begin
  perform private.require_active_user();
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;
  if v_order.order_state = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
  end if;

  if p_action = 'mark_paid' then
    if v_order.payment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders set payment_state = 'paid', paid_at = now() where id = p_order_id;

  elsif p_action = 'mark_refunded' then
    if v_order.payment_state <> 'paid' or v_order.fulfillment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders set payment_state = 'refunded', refunded_at = now() where id = p_order_id;

  elsif p_action in ('mark_shipped', 'mark_delivered') then
    -- En el flujo simplificado, la entrega o envío no exige preparación previa ni cobro anticipado obligatorio.
    if p_action = 'mark_shipped' then
      if v_order.delivery_method <> 'shipping' or v_order.fulfillment_state <> 'pending' then
        raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
      end if;
      v_inventory_leaves := true;
      v_new_fulfillment := 'shipped';
    else
      -- mark_delivered directo desde pending (para retiro o envío) o posterior a shipped
      if v_order.fulfillment_state = 'pending' then
        v_inventory_leaves := true;
      elsif v_order.fulfillment_state = 'shipped' then
        v_inventory_leaves := false;
      else
        raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
      end if;
      v_new_fulfillment := 'delivered';
    end if;

    if v_inventory_leaves then
      for v_item in
        select oi.product_id, oi.product_name_snapshot, oi.quantity, sb.on_hand, sb.reserved
        from public.order_items oi
        join public.stock_balances sb on sb.product_id = oi.product_id
        where oi.order_id = p_order_id
        order by oi.product_id
        for update of sb
      loop
        if v_item.on_hand < v_item.quantity or v_item.reserved < v_item.quantity then
          raise exception using errcode = 'P0001', message = 'INSUFFICIENT_STOCK';
        end if;
        update public.stock_balances
        set on_hand = on_hand - v_item.quantity,
            reserved = reserved - v_item.quantity
        where product_id = v_item.product_id;
        update public.stock_reservations
        set state = 'consumed', resolved_at = now()
        where order_id = p_order_id and product_id = v_item.product_id and state = 'active';
        if not found then
          raise exception using errcode = 'P0001', message = 'RESERVATION_MISSING';
        end if;
        insert into public.stock_movements(
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
        ) values (
          v_item.product_id,
          v_item.product_name_snapshot,
          'sale',
          -v_item.quantity,
          -v_item.quantity,
          case when p_action = 'mark_shipped' then 'Salida por pedido enviado' else 'Salida por pedido entregado' end,
          p_order_id,
          auth.uid()
        );
      end loop;
    end if;

    update public.orders
    set fulfillment_state = v_new_fulfillment,
        preparation_state = 'ready',
        shipped_at = case when v_new_fulfillment = 'shipped' then now() else shipped_at end,
        fulfilled_at = case when v_new_fulfillment = 'delivered' then now() else fulfilled_at end
    where id = p_order_id;

  elsif p_action = 'cancel' then
    if v_order.fulfillment_state <> 'pending' or v_order.payment_state = 'paid' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    for v_item in
      select sr.product_id, oi.product_name_snapshot, sr.quantity, sb.reserved
      from public.stock_reservations sr
      join public.stock_balances sb on sb.product_id = sr.product_id
      join public.order_items oi on oi.order_id = sr.order_id and oi.product_id = sr.product_id
      where sr.order_id = p_order_id and sr.state = 'active'
      order by sr.product_id
      for update of sr, sb
    loop
      if v_item.reserved < v_item.quantity then
        raise exception using errcode = 'P0001', message = 'RESERVATION_MISSING';
      end if;
      update public.stock_balances
      set reserved = reserved - v_item.quantity
      where product_id = v_item.product_id;
      update public.stock_reservations
      set state = 'released', resolved_at = now()
      where order_id = p_order_id and product_id = v_item.product_id and state = 'active';
      insert into public.stock_movements(
        product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
      ) values (
        v_item.product_id,
        v_item.product_name_snapshot,
        'reservation_release',
        0,
        -v_item.quantity,
        'Cancelación de pedido',
        p_order_id,
        auth.uid()
      );
    end loop;
    update public.orders
    set order_state = 'cancelled',
        fulfillment_state = 'cancelled',
        cancelled_at = now()
    where id = p_order_id;

  -- Compatibilidad histórica
  elsif p_action = 'start_preparing' then
    update public.orders set preparation_state = 'preparing' where id = p_order_id and preparation_state = 'pending';
  elsif p_action = 'mark_ready' then
    update public.orders set preparation_state = 'ready' where id = p_order_id and preparation_state in ('pending', 'preparing');
  else
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
  end if;

  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;

revoke all on function public.transition_order(uuid, text) from public, anon, authenticated;
grant execute on function public.transition_order(uuid, text) to authenticated;
