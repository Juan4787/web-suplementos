-- Migration: 20260905050000_fix_transition_order_canonical_locks.sql
-- Fix: Bloqueo Canónico Nivel 1 en transition_order('cancel') para evitar deadlocks
-- y condiciones de carrera contra recepciones concurrentes de compras.

create or replace function public.transition_order(p_order_id uuid, p_action text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_inventory_leaves boolean := false;
  v_new_fulfillment public.fulfillment_state;
  v_res record;
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
    -- DEFENSA OBLIGATORIA: No se puede entregar si el pedido espera mercadería o tiene faltante
    if exists (
      select 1 from public.stock_reservations
      where order_id = p_order_id and state = 'active' and source_type <> 'physical'
    ) then
      raise exception using errcode = 'P0001', message = 'CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK';
    end if;

    if p_action = 'mark_shipped' then
      if v_order.delivery_method <> 'shipping' or v_order.fulfillment_state <> 'pending' then
        raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
      end if;
      v_inventory_leaves := true;
      v_new_fulfillment := 'shipped';
    else
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

        -- Consumir únicamente reservas físicas
        update public.stock_reservations
        set state = 'consumed', resolved_at = now()
        where order_id = p_order_id and product_id = v_item.product_id and state = 'active' and source_type = 'physical';

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
    if v_order.fulfillment_state = 'delivered' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;

    -- ANTI-DEADLOCK NIVEL 1: Bloqueo Canónico Unificado (products + stock_balances) ordenado por p.id ASC
    perform 1
    from public.products p
    join public.stock_balances sb on sb.product_id = p.id
    where p.id in (
      select oi.product_id from public.order_items oi where oi.order_id = p_order_id
    )
    order by p.id asc
    for update of p, sb;

    if v_order.fulfillment_state = 'shipped' then
      for v_item in
        select oi.product_id, oi.product_name_snapshot, oi.quantity
        from public.order_items oi
        where oi.order_id = p_order_id
        order by oi.product_id
      loop
        update public.stock_balances
        set on_hand = on_hand + v_item.quantity
        where product_id = v_item.product_id;

        insert into public.stock_movements(
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
        ) values (
          v_item.product_id,
          v_item.product_name_snapshot,
          'return',
          v_item.quantity,
          0,
          'Reintegro de stock por pedido cancelado',
          p_order_id,
          auth.uid()
        );
      end loop;
    elsif v_order.fulfillment_state = 'pending' then
      -- Liberación diferenciada de reservas:
      for v_res in
        select id, product_id, quantity, source_type
        from public.stock_reservations
        where order_id = p_order_id and state = 'active'
        for update
      loop
        if v_res.source_type = 'physical' then
          update public.stock_balances
          set reserved = reserved - v_res.quantity
          where product_id = v_res.product_id;
        end if;

        update public.stock_reservations
        set state = 'released', resolved_at = now()
        where id = v_res.id;
      end loop;
    end if;

    update public.orders
    set order_state = 'cancelled',
        fulfillment_state = 'cancelled',
        preparation_state = 'ready',
        cancelled_at = now()
    where id = p_order_id;
  else
    raise exception using errcode = 'P0001', message = 'UNKNOWN_ORDER_ACTION';
  end if;

  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;
