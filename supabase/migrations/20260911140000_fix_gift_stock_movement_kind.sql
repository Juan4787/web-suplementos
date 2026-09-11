-- Corrección del tipo de movimiento de stock al marcar pedido como regalo/cortesía
-- El enum stock_movement_kind no posee el valor 'loss'; debe utilizarse 'adjustment' con su motivo comercial correspondiente.

create or replace function public.transition_order(p_order_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_new_fulfillment public.fulfillment_state;
  v_inventory_leaves boolean := false;
  v_res record;
  v_balance record;
  v_loss_reason text;
  v_cost_total bigint := 0;
begin
  perform private.require_active_user();

  -- Lock jerárquico determinista
  perform 1 from public.products p
  join public.order_items oi on oi.product_id = p.id
  join public.stock_balances sb on sb.product_id = p.id
  where oi.order_id = p_order_id
  order by p.id asc
  for update of p, sb;

  -- Nivel Orders
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

  elsif p_action = 'mark_at_cost' then
    perform private.require_owner();

    -- Idempotencia: si ya está registrado al costo y cobrado
    if v_order.sale_type = 'cost' and v_order.payment_state = 'paid' then
      return private.order_payload(p_order_id, private.is_owner());
    end if;

    -- Solo se pueden marcar al costo pedidos pendientes de cobro no cancelados
    if v_order.order_state = 'cancelled' or v_order.payment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;

    -- Recalcular líneas con su costo unitario (line_subtotal_cents se calcula automáticamente)
    update public.order_items
    set unit_price_cents = coalesce(unit_cost_cents, 0)
    where order_id = p_order_id;

    -- Actualizar cabecera al costo real con margen $0
    update public.orders
    set sale_type = 'cost',
        subtotal_cents = coalesce(cost_total_cents, 0),
        total_cents = coalesce(cost_total_cents, 0) + coalesce(shipping_fee_cents, 0),
        tax_amount_cents = 0,
        payment_state = 'paid',
        paid_at = coalesce(paid_at, now())
    where id = p_order_id;

  elsif p_action = 'mark_refunded' then
    if v_order.payment_state <> 'paid' or v_order.fulfillment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders set payment_state = 'refunded', refunded_at = now() where id = p_order_id;

  elsif p_action in ('mark_shipped', 'mark_delivered') then
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
          case
            when v_order.sale_type = 'cost' then 'Salida por venta al costo (Pedido #' || v_order.order_number || ')'
            when p_action = 'mark_shipped' then 'Salida por pedido enviado'
            else 'Salida por pedido entregado'
          end,
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

  elsif p_action = 'mark_gifted' then
    perform private.require_owner();
    if v_order.payment_state = 'gifted' then
      return private.order_payload(p_order_id, private.is_owner());
    end if;

    if v_order.order_state = 'cancelled' or v_order.payment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;

    if v_order.fulfillment_state = 'pending' then
      if exists (
        select 1 from public.stock_reservations
        where order_id = p_order_id and state = 'active' and source_type <> 'physical'
      ) then
        raise exception using errcode = 'P0001', message = 'CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK';
      end if;

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
        where order_id = p_order_id and product_id = v_item.product_id and state = 'active' and source_type = 'physical';

        v_loss_reason := 'Salida por regalo/cortesía comercial (Pedido #' || v_order.order_number || ')';
        insert into public.stock_movements(
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
        ) values (
          v_item.product_id,
          v_item.product_name_snapshot,
          'adjustment',
          -v_item.quantity,
          -v_item.quantity,
          v_loss_reason,
          p_order_id,
          auth.uid()
        );
      end loop;

      update public.orders
      set fulfillment_state = 'delivered',
          preparation_state = 'ready',
          fulfilled_at = now()
      where id = p_order_id;
    elsif v_order.fulfillment_state in ('shipped', 'delivered') then
      update public.stock_movements
      set kind = 'adjustment',
          reason = 'Salida reclasificada a regalo/cortesía comercial (Pedido #' || v_order.order_number || ')'
      where order_id = p_order_id and kind = 'sale';
    end if;

    update public.orders
    set payment_state = 'gifted',
        payment_method = 'gift',
        sale_type = 'gift',
        subtotal_cents = 0,
        shipping_fee_cents = 0,
        total_cents = 0,
        tax_amount_cents = 0,
        paid_at = now()
    where id = p_order_id;

  elsif p_action = 'cancel' then
    if v_order.order_state = 'cancelled' then
      return private.order_payload(p_order_id, private.is_owner());
    end if;

    if v_order.fulfillment_state in ('shipped', 'delivered') then
      raise exception using errcode = 'P0001', message = 'CANNOT_CANCEL_SHIPPED_ORDER';
    end if;

    for v_res in
      select * from public.stock_reservations
      where order_id = p_order_id and state = 'active'
      for update
    loop
      if v_res.source_type = 'physical' then
        select * into v_balance from public.stock_balances where product_id = v_res.product_id for update;
        update public.stock_balances
        set reserved = reserved - v_res.quantity
        where product_id = v_res.product_id;

        insert into public.stock_movements(
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
        ) values (
          v_res.product_id,
          (select name from public.products where id = v_res.product_id),
          'reservation',
          0,
          -v_res.quantity,
          'Cancelación de reserva física por pedido cancelado',
          p_order_id,
          auth.uid()
        );
      end if;

      update public.stock_reservations
      set state = 'cancelled', resolved_at = now()
      where id = v_res.id;
    end loop;

    update public.orders
    set order_state = 'cancelled',
        payment_state = case when payment_state = 'paid' then 'refunded'::public.payment_state else payment_state end,
        cancelled_at = now()
    where id = p_order_id;

  else
    raise exception using errcode = 'P0001', message = 'INVALID_ACTION';
  end if;

  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;
