-- ============================================================================
-- Jerarquía Canónica Anti-Deadlock: receive_purchase vs confirm_imported_order
-- ============================================================================

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
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE_TRANSITION';
  end if;

  select coalesce(array_agg(distinct sr.order_id), array[]::uuid[]) into v_affected_order_ids
  from public.stock_reservations sr
  join public.purchase_items pi on pi.id = sr.purchase_item_id
  where pi.purchase_id = p_purchase_id and sr.state = 'active' and sr.source_type = 'incoming';

  for v_input_item in
    select (elem ->> 'purchaseItemId')::uuid as purchase_item_id, (elem ->> 'receivedQuantity')::integer as qty_received
    from jsonb_array_elements(p_items) elem
  loop
    v_qty_received := v_input_item.qty_received;
    if v_qty_received is null or v_qty_received <= 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_RECEIVED_QUANTITY';
    end if;

    -- Bloqueo estricto únicamente sobre purchase_items (sin re-bloquear products)
    select pi.*, p.name as product_name into v_pi
    from public.purchase_items pi
    join public.products p on p.id = pi.product_id
    where pi.id = v_input_item.purchase_item_id and pi.purchase_id = p_purchase_id
    for update of pi;

    if not found then
      raise exception using errcode = 'P0001', message = 'PURCHASE_ITEM_NOT_FOUND';
    end if;

    if (v_pi.received_quantity + v_pi.shortage_quantity + v_qty_received) > v_pi.quantity then
      raise exception using errcode = 'P0001', message = 'RECEIVED_EXCEEDS_ORDERED_QUANTITY';
    end if;

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

      -- Fusión / creación de reserva física para evitar duplicaciones y respetar constraints
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
      else
        insert into public.stock_reservations (
          order_id, order_item_id, product_id, quantity, state, source_type,
          purchase_item_id, cost_snapshot_cents, created_at
        ) values (
          v_res.order_id, v_res.order_item_id, v_res.product_id,
          v_take, 'active', 'physical',
          null, v_res.cost_snapshot_cents, now()
        );
      end if;

      -- Actualizar o eliminar la reserva incoming cubierta
      if v_res.quantity = v_take then
        delete from public.stock_reservations where id = v_res.id;
      else
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

  if exists (
    select 1 from public.purchase_items
    where purchase_id = p_purchase_id and (received_quantity + shortage_quantity) < quantity
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
