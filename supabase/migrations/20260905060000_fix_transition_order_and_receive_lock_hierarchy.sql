-- Migration: 20260905060000_fix_transition_order_and_receive_lock_hierarchy.sql
-- Fix: Unificación canónica de locks para eliminar el deadlock entre transition_order y receive_purchase.
-- 1. transition_order adquiere Nivel 1 (products + stock_balances) ANTES de bloquear orders para evitar esperas circulares con FK checks.
-- 2. receive_purchase realiza conversión in-place de reservas cuando quantity = v_take y no hay física previa.

-- ----------------------------------------------------------------------------
-- 1. TRANSITION ORDER: Nivel 1 Previo a Cabecera de Orders
-- ----------------------------------------------------------------------------
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

  -- ANTI-DEADLOCK NIVEL 1: Bloqueo Canónico Unificado (products + stock_balances) ordenado por p.id ASC
  -- Obligatorio antes de bloquear orders para que ninguna FK check de reservations compita en orden inverso.
  perform 1
  from public.products p
  join public.stock_balances sb on sb.product_id = p.id
  where p.id in (
    select oi.product_id from public.order_items oi where oi.order_id = p_order_id
  )
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

-- ----------------------------------------------------------------------------
-- 2. RECEIVE PURCHASE: Conversión In-Place Atómica sin Borrado/Inserción Innecesaria
-- ----------------------------------------------------------------------------
create or replace function public.receive_purchase(
  p_purchase_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_purchase public.purchases%rowtype;
  v_input_item record;
  v_pi record;
  v_qty_received integer;
  v_to_convert integer;
  v_res record;
  v_total_converted_physical integer;
  v_all_completed boolean := true;
  v_affected_order_ids uuid[] := array[]::uuid[];
  v_unblocked_orders jsonb := '[]'::jsonb;
  v_physical_res_id uuid;
  v_take integer;
begin
  perform private.require_owner();

  if coalesce(jsonb_typeof(p_items), 'null') <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  if (select count(*) <> count(distinct elem ->> 'purchaseItemId') from jsonb_array_elements(p_items) elem) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_PURCHASE_ITEM';
  end if;

  -- ANTI-DEADLOCK NIVEL 1: Bloqueo Canónico Unificado (products + stock_balances) ordenado por p.id ASC
  perform 1
  from public.products p
  join public.stock_balances sb on sb.product_id = p.id
  where p.id in (
    select pi.product_id from public.purchase_items pi where pi.purchase_id = p_purchase_id
  )
  order by p.id asc
  for update of p, sb;

  -- ANTI-DEADLOCK NIVEL 2: Purchases Cabecera
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found or v_purchase.state <> 'ordered' then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE_STATE';
  end if;

  -- Validar que ninguna orden que tenga reservas incoming en esta compra esté bloqueando
  perform 1
  from public.stock_reservations sr
  join public.purchase_items pi on pi.id = sr.purchase_item_id
  where pi.purchase_id = p_purchase_id and sr.state = 'active' and sr.source_type = 'incoming';

  -- Procesar cada ítem recibido
  for v_input_item in
    select (elem ->> 'purchaseItemId')::uuid as purchase_item_id,
           (elem ->> 'receivedQuantity')::integer as received_quantity
    from jsonb_array_elements(p_items) elem
  loop
    if v_input_item.received_quantity <= 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_RECEIVED_QUANTITY';
    end if;

    -- ANTI-DEADLOCK NIVEL 3: Bloqueo estricto únicamente sobre purchase_items
    select pi.*, p.sku, p.name as product_name
    into v_pi
    from public.purchase_items pi
    join public.products p on p.id = pi.product_id
    where pi.id = v_input_item.purchase_item_id and pi.purchase_id = p_purchase_id
    for update of pi;

    if not found then
      raise exception using errcode = 'P0001', message = 'PURCHASE_ITEM_NOT_FOUND';
    end if;

    if (v_pi.received_quantity + v_pi.shortage_quantity + v_input_item.received_quantity) > v_pi.quantity then
      raise exception using errcode = 'P0001', message = 'OVER_RECEIVING_NOT_ALLOWED';
    end if;

    v_qty_received := v_input_item.received_quantity;
    v_to_convert := v_qty_received;
    v_total_converted_physical := 0;

    -- Conversión FIFO por confirmed_at ASC, order_number ASC, id ASC
    for v_res in
      select sr.*
      from public.stock_reservations sr
      join public.orders o on o.id = sr.order_id
      where sr.purchase_item_id = v_pi.id and sr.state = 'active' and sr.source_type = 'incoming'
      order by o.confirmed_at asc, o.order_number asc, sr.id asc
      for update of sr
    loop
      if v_to_convert <= 0 then exit; end if;

      v_take := least(v_res.quantity, v_to_convert);

      -- Fusión / creación / conversión atómica in-place
      select id into v_physical_res_id
      from public.stock_reservations
      where order_id = v_res.order_id
        and product_id = v_res.product_id
        and source_type = 'physical'
        and state = 'active'
      limit 1;

      if v_physical_res_id is not null then
        update public.stock_reservations
        set quantity = quantity + v_take
        where id = v_physical_res_id;

        if v_res.quantity = v_take then
          delete from public.stock_reservations where id = v_res.id;
        else
          update public.stock_reservations
          set quantity = quantity - v_take
          where id = v_res.id;
        end if;
      elsif v_res.quantity = v_take then
        -- CONVERSIÓN IN-PLACE ATÓMICA: No genera filas huérfanas ni dispara re-validación de FK en orders
        update public.stock_reservations
        set source_type = 'physical',
            purchase_item_id = null
        where id = v_res.id;
      else
        -- Split cuando la reserva es mayor que la entrega parcial recibida
        insert into public.stock_reservations (
          order_id, order_item_id, product_id, quantity, state, source_type,
          purchase_item_id, cost_snapshot_cents, created_at
        ) values (
          v_res.order_id, v_res.order_item_id, v_res.product_id,
          v_take, 'active', 'physical',
          null, v_res.cost_snapshot_cents, now()
        );

        update public.stock_reservations
        set quantity = quantity - v_take
        where id = v_res.id;
      end if;

      insert into public.stock_movements (
        product_id, product_name_snapshot, kind, physical_delta, reserved_delta,
        reason, order_id, created_by
      ) values (
        v_pi.product_id, v_pi.product_name, 'reservation',
        0, v_take, 'Asignación física por arribo de compra',
        v_res.order_id, auth.uid()
      );

      v_total_converted_physical := v_total_converted_physical + v_take;
      v_to_convert := v_to_convert - v_take;
      v_affected_order_ids := array_append(v_affected_order_ids, v_res.order_id);
    end loop;

    -- Asentar incremento de recibido en purchase_items
    update public.purchase_items set received_quantity = received_quantity + v_qty_received where id = v_pi.id;
    update public.product_financials set current_cost_cents = v_pi.unit_cost_cents, updated_by = auth.uid()
    where product_id = v_pi.product_id;

    -- Movimiento contable físico puro
    insert into public.stock_movements (
      product_id, product_name_snapshot, kind, physical_delta, reserved_delta,
      reason, purchase_id, created_by
    ) values (
      v_pi.product_id, v_pi.product_name, 'purchase_received',
      v_qty_received, 0, 'Recepción de mercadería de compra',
      p_purchase_id, auth.uid()
    );

    update public.stock_balances
    set on_hand = on_hand + v_qty_received,
        reserved = reserved + v_total_converted_physical
    where product_id = v_pi.product_id;
  end loop;

  -- Comprobar si toda la orden de compra quedó completada
  if exists (
    select 1 from public.purchase_items
    where purchase_id = p_purchase_id
      and (received_quantity + shortage_quantity) < quantity
  ) then
    v_all_completed := false;
  end if;

  if v_all_completed then
    update public.purchases set state = 'received', received_at = now() where id = p_purchase_id;
  end if;

  -- Calcular qué pedidos quedaron 100% listos (desbloqueados)
  if cardinality(v_affected_order_ids) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'number', o.order_number)), '[]'::jsonb)
    into v_unblocked_orders
    from public.orders o
    where o.id = any(v_affected_order_ids)
      and o.order_state <> 'cancelled'
      and not exists (
        select 1 from public.stock_reservations sr
        where sr.order_id = o.id and sr.state = 'active' and sr.source_type <> 'physical'
      );
  end if;

  perform private.bump_revision();
  return jsonb_build_object(
    'purchase', private.purchase_payload(p_purchase_id),
    'unblockedOrders', v_unblocked_orders
  );
end;
$$;
