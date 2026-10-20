-- Allow editing confirmed pending orders atomically while preserving stock
-- balances, incoming allocations, movement history, packing guards, and audit logs.
begin;

-- 1. Allow preserving released reservations and historical 0-packed events when
-- an unpacked line is removed during an order edit.
alter table public.stock_reservations
  drop constraint if exists stock_reservations_order_item_id_fkey,
  add constraint stock_reservations_order_item_id_fkey
    foreign key (order_item_id) references public.order_items(id) on delete set null,
  drop constraint if exists reservation_origin_check,
  add constraint reservation_origin_check check (
    (is_opening and order_id is null and order_item_id is null and purchase_item_id is not null)
    or (not is_opening and order_id is not null and (order_item_id is not null or state = 'released'))
  );

create or replace function private.validate_reservation_coherence()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_oi record;
  v_pi_product uuid;
begin
  if not new.is_opening and new.order_item_id is not null then
    select order_id, product_id into v_oi from public.order_items where id = new.order_item_id;
    if not found or v_oi.order_id is distinct from new.order_id or v_oi.product_id is distinct from new.product_id then
      raise exception using errcode = 'P0001', message = 'RESERVATION_ORDER_ITEM_INCOHERENCE';
    end if;
  end if;
  if new.purchase_item_id is not null then
    select product_id into v_pi_product from public.purchase_items where id = new.purchase_item_id;
    if not found or v_pi_product is distinct from new.product_id then
      raise exception using errcode = 'P0001', message = 'RESERVATION_PURCHASE_ITEM_PRODUCT_INCOHERENCE';
    end if;
  end if;
  return new;
end;
$$;

alter table public.order_packing_events
  alter column order_item_id drop not null,
  drop constraint if exists order_packing_events_order_item_id_fkey,
  add constraint order_packing_events_order_item_id_fkey
    foreign key (order_item_id) references public.order_items(id) on delete set null;

-- 2. Extend order_action_reversals so item edits are audited and exported in
-- the same "Correcciones pedidos" trail.
alter table public.order_action_reversals
  add column if not exists request_payload jsonb,
  drop constraint if exists order_action_reversals_action_check,
  add constraint order_action_reversals_action_check
    check (action in ('reverse_payment', 'reverse_delivery', 'reverse_shipment', 'edit_items'));

-- 3. Direct single-order read RPC for the order editor route.
create or replace function public.get_order(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  perform private.require_active_user();
  if p_order_id is null then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;
  v_result := private.order_payload(p_order_id, private.is_owner());
  if v_result is null then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;
  return v_result;
end;
$$;

revoke all on function public.get_order(uuid) from public, anon, authenticated;
grant execute on function public.get_order(uuid) to authenticated;

-- 4. Atomic, idempotent order items update RPC.
create or replace function public.update_order_items(p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_operation_id uuid;
  v_expected_revision bigint;
  v_raw_items jsonb;
  v_canonical_items jsonb;
  v_event public.order_action_reversals%rowtype;
  v_order public.orders%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_has_tracked_packing boolean := false;
  v_any_added_or_increased boolean := false;
  v_packing_changed boolean := false;
  v_old_item public.order_items%rowtype;
  v_req_qty integer;
  v_release_needed integer;
  v_phys_released integer;
  v_res record;
  v_take integer;
  v_item_cost_total bigint;
  v_line record;
  v_old_qty integer;
  v_delta integer;
  v_locked record;
  v_order_item_id uuid;
  v_phys_avail integer;
  v_phys_alloc integer;
  v_remaining integer;
  v_existing_res_id uuid;
  v_purchase record;
  v_all_packed boolean;
  v_any_packed boolean;
  v_has_non_physical boolean;
  v_new_prep_state public.preparation_state;
  v_items_subtotal bigint := 0;
  v_cost_total bigint := 0;
  v_subtotal bigint := 0;
  v_total bigint := 0;
  v_tax bigint := 0;
  v_products_to_reconcile uuid[] := array[]::uuid[];
  v_reconcile_product_id uuid;
begin
  perform private.require_active_user();

  if coalesce(jsonb_typeof(p_input), 'null') <> 'object' then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  v_order_id := nullif(btrim(coalesce(p_input ->> 'orderId', '')), '')::uuid;
  v_operation_id := nullif(btrim(coalesce(p_input ->> 'operationId', '')), '')::uuid;
  if v_order_id is null or v_operation_id is null
     or coalesce(p_input ->> 'expectedActionRevision', '') !~ '^[0-9]+$' then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;
  v_expected_revision := (p_input ->> 'expectedActionRevision')::bigint;

  v_raw_items := p_input -> 'items';
  if coalesce(jsonb_typeof(v_raw_items), 'null') <> 'array'
     or jsonb_array_length(v_raw_items) < 1
     or jsonb_array_length(v_raw_items) > 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_raw_items) elem
    where jsonb_typeof(elem) <> 'object'
       or nullif(btrim(coalesce(elem ->> 'productId', '')), '') is null
       or coalesce(elem ->> 'quantity', '') !~ '^[1-9][0-9]*$'
       or (elem ->> 'quantity')::integer not between 1 and 1000
       or (
         elem ? 'unitPriceCents'
         and jsonb_typeof(elem -> 'unitPriceCents') <> 'null'
         and coalesce(elem ->> 'unitPriceCents', '') !~ '^[0-9]+$'
       )
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  if (
    select count(*) <> count(distinct (elem ->> 'productId')::uuid)
    from jsonb_array_elements(v_raw_items) elem
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'productId', (elem ->> 'productId')::uuid,
        'quantity', (elem ->> 'quantity')::integer,
        'unitPriceCents', case
          when elem ? 'unitPriceCents' and jsonb_typeof(elem -> 'unitPriceCents') = 'number'
            then (elem ->> 'unitPriceCents')::bigint
          else null
        end
      )
      order by (elem ->> 'productId')::uuid asc
    ),
    '[]'::jsonb
  )
  into v_canonical_items
  from jsonb_array_elements(v_raw_items) elem;

  -- Serialize retries of the same operation key before acquiring business row locks.
  perform pg_advisory_xact_lock(hashtextextended(v_operation_id::text, 191019));

  select * into v_event from public.order_action_reversals where operation_id = v_operation_id;
  if found then
    if v_event.order_id <> v_order_id
       or v_event.action <> 'edit_items'
       or v_event.expected_revision <> v_expected_revision
       or v_event.request_payload is distinct from v_canonical_items then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
    end if;
    return private.order_payload(v_order_id, private.is_owner());
  end if;

  -- Canonical Lock Hierarchy Level 1: products + stock_balances ordered by p.id ASC
  perform 1
  from public.products p
  join public.stock_balances sb on sb.product_id = p.id
  where p.id in (
    select oi.product_id from public.order_items oi where oi.order_id = v_order_id
    union
    select (elem ->> 'productId')::uuid from jsonb_array_elements(v_canonical_items) elem
  )
  order by p.id asc
  for update of p, sb;

  -- Canonical Lock Hierarchy Level 2: orders
  select * into v_order from public.orders where id = v_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;

  select * into v_event from public.order_action_reversals where operation_id = v_operation_id;
  if found then
    if v_event.order_id <> v_order_id
       or v_event.action <> 'edit_items'
       or v_event.expected_revision <> v_expected_revision
       or v_event.request_payload is distinct from v_canonical_items then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
    end if;
    return private.order_payload(v_order_id, private.is_owner());
  end if;

  if v_order.order_state = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
  end if;
  if v_order.fulfillment_state in ('shipped', 'delivered') then
    raise exception using errcode = 'P0001', message = 'CANNOT_EDIT_FULFILLED_ORDER';
  end if;
  if v_order.payment_state = 'paid' then
    raise exception using errcode = 'P0001', message = 'CANNOT_EDIT_PAID_ORDER';
  end if;
  if v_order.payment_state = 'refunded' then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
  end if;
  if coalesce(v_order.sale_type, 'retail') in ('cost', 'gift') or v_order.payment_state = 'gifted' then
    perform private.require_owner();
  end if;
  if v_order.action_revision <> v_expected_revision then
    raise exception using errcode = 'P0001', message = 'ORDER_ACTION_CHANGED';
  end if;

  -- Canonical Lock Hierarchy Level 3: order_items
  perform 1 from public.order_items where order_id = v_order_id order by id asc for update;

  v_before := private.order_payload(v_order_id, true);

  select coalesce(bool_or(packed_quantity is not null), false)
  into v_has_tracked_packing
  from public.order_items
  where order_id = v_order_id;

  -- Verify no line is reduced below its packed_quantity in the bag.
  for v_old_item in
    select * from public.order_items where order_id = v_order_id order by product_id asc, id asc
  loop
    select (elem ->> 'quantity')::integer into v_req_qty
    from jsonb_array_elements(v_canonical_items) elem
    where (elem ->> 'productId')::uuid = v_old_item.product_id;
    v_req_qty := coalesce(v_req_qty, 0);

    if coalesce(v_old_item.packed_quantity, 0) > v_req_qty then
      raise exception using errcode = 'P0001', message = 'CANNOT_REDUCE_BELOW_PACKED_QUANTITY';
    end if;
  end loop;

  -- Phase 1: Release reservations for removed or decreased order items.
  for v_old_item in
    select * from public.order_items where order_id = v_order_id order by product_id asc, id asc
  loop
    select (elem ->> 'quantity')::integer into v_req_qty
    from jsonb_array_elements(v_canonical_items) elem
    where (elem ->> 'productId')::uuid = v_old_item.product_id;
    v_req_qty := coalesce(v_req_qty, 0);

    if v_req_qty < v_old_item.quantity then
      v_release_needed := v_old_item.quantity - v_req_qty;
      v_phys_released := 0;

      -- Release uncovered first, then incoming (latest expected purchase first), then physical.
      for v_res in
        select sr.*
        from public.stock_reservations sr
        left join public.purchase_items pi on pi.id = sr.purchase_item_id
        left join public.purchases pu on pu.id = pi.purchase_id
        where sr.order_item_id = v_old_item.id
          and sr.order_id = v_order_id
          and sr.state = 'active'
        order by
          case sr.source_type
            when 'uncovered' then 0
            when 'incoming' then 1
            else 2
          end asc,
          coalesce(pu.expected_at, pu.ordered_at + interval '7 days') desc nulls first,
          pu.ordered_at desc nulls first,
          sr.created_at desc,
          sr.id desc
        for update of sr
      loop
        exit when v_release_needed = 0;
        v_take := least(v_release_needed, v_res.quantity);

        if v_res.source_type = 'physical' then
          v_phys_released := v_phys_released + v_take;
        end if;

        if v_take = v_res.quantity then
          update public.stock_reservations
          set state = 'released', resolved_at = now()
          where id = v_res.id;
        else
          update public.stock_reservations
          set quantity = quantity - v_take
          where id = v_res.id;

          insert into public.stock_reservations (
            order_id, order_item_id, product_id, quantity, state, resolved_at,
            source_type, purchase_item_id, cost_snapshot_cents, is_opening, created_at
          ) values (
            v_order_id, v_old_item.id, v_old_item.product_id, v_take, 'released', now(),
            v_res.source_type, v_res.purchase_item_id, v_res.cost_snapshot_cents, false, v_res.created_at
          );
        end if;

        v_release_needed := v_release_needed - v_take;
      end loop;

      if v_release_needed <> 0 then
        raise exception using errcode = 'P0001', message = 'ORDER_REVERSAL_RESERVATIONS_MISMATCH';
      end if;

      if v_phys_released > 0 then
        update public.stock_balances
        set reserved = reserved - v_phys_released
        where product_id = v_old_item.product_id;

        insert into public.stock_movements (
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
        ) values (
          v_old_item.product_id,
          coalesce((select name from public.products where id = v_old_item.product_id), v_old_item.product_name_snapshot, 'Producto'),
          'reservation_release',
          0,
          -v_phys_released,
          'Liberación de reserva por edición de pedido #' || v_order.order_number,
          v_order_id,
          auth.uid()
        );

        if not (v_old_item.product_id = any(v_products_to_reconcile)) then
          v_products_to_reconcile := array_append(v_products_to_reconcile, v_old_item.product_id);
        end if;
      end if;

      if v_req_qty = 0 then
        if v_has_tracked_packing then
          v_packing_changed := true;
        end if;
        delete from public.order_items where id = v_old_item.id;
      else
        select coalesce(sum(quantity::bigint * cost_snapshot_cents), 0)
        into v_item_cost_total
        from public.stock_reservations
        where order_item_id = v_old_item.id and state = 'active';

        update public.order_items
        set quantity = v_req_qty,
            cost_total_cents = v_item_cost_total,
            unit_cost_cents = round(v_item_cost_total::numeric / v_req_qty)::bigint,
            unit_price_cents = case
              when v_order.sale_type = 'cost' then round(v_item_cost_total::numeric / v_req_qty)::bigint
              when v_order.sale_type = 'gift' or v_order.payment_state = 'gifted' then 0
              else unit_price_cents
            end
        where id = v_old_item.id;
      end if;
    end if;
  end loop;

  -- Phase 2: Allocate stock for newly added or quantity-increased order items.
  for v_line in
    select
      (elem ->> 'productId')::uuid as product_id,
      (elem ->> 'quantity')::integer as quantity,
      case
        when elem ? 'unitPriceCents' and jsonb_typeof(elem -> 'unitPriceCents') = 'number'
          then (elem ->> 'unitPriceCents')::bigint
        else null
      end as unit_price
    from jsonb_array_elements(v_canonical_items) elem
    order by (elem ->> 'productId')::uuid asc
  loop
    select * into v_old_item
    from public.order_items
    where order_id = v_order_id and product_id = v_line.product_id;

    v_old_qty := case when found then v_old_item.quantity else 0 end;
    v_delta := v_line.quantity - v_old_qty;

    if v_delta <= 0 then
      continue;
    end if;

    v_any_added_or_increased := true;

    select p.sku, p.name, p.presentation, p.sale_price_cents, p.active,
           s.on_hand, s.reserved, coalesce(f.current_cost_cents, 0) as current_cost_cents
    into v_locked
    from public.products p
    join public.stock_balances s on s.product_id = p.id
    left join public.product_financials f on f.product_id = p.id
    where p.id = v_line.product_id
    for update of p, s;

    if not found or not v_locked.active then
      raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
    end if;

    if v_old_qty = 0 then
      if coalesce(v_order.sale_type, 'retail') not in ('cost', 'gift')
         and v_order.payment_state <> 'gifted'
         and v_line.unit_price is not null
         and v_locked.sale_price_cents <> v_line.unit_price then
        raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
      end if;

      if v_has_tracked_packing then
        v_packing_changed := true;
      end if;

      insert into public.order_items (
        order_id, product_id, sku_snapshot, product_name_snapshot,
        presentation_snapshot, quantity, packed_quantity,
        unit_price_cents, unit_cost_cents, cost_total_cents
      ) values (
        v_order_id, v_line.product_id, v_locked.sku, v_locked.name,
        v_locked.presentation, v_line.quantity,
        case when v_has_tracked_packing then 0 else null end,
        case
          when v_order.sale_type = 'gift' or v_order.payment_state = 'gifted' then 0
          when v_order.sale_type = 'cost' then v_locked.current_cost_cents
          else v_locked.sale_price_cents
        end,
        v_locked.current_cost_cents,
        0
      ) returning id into v_order_item_id;
    else
      v_order_item_id := v_old_item.id;
    end if;

    v_phys_avail := greatest(0, v_locked.on_hand - v_locked.reserved);
    v_phys_alloc := case when v_order.stock_source = 'incoming_only' then 0 else least(v_delta, v_phys_avail) end;
    v_remaining := v_delta - v_phys_alloc;

    if v_phys_alloc > 0 then
      update public.stock_balances
      set reserved = reserved + v_phys_alloc
      where product_id = v_line.product_id;

      select id into v_existing_res_id
      from public.stock_reservations
      where order_item_id = v_order_item_id
        and state = 'active'
        and source_type = 'physical'
        and not is_opening
        and cost_snapshot_cents = v_locked.current_cost_cents
      limit 1;

      if v_existing_res_id is not null then
        update public.stock_reservations
        set quantity = quantity + v_phys_alloc
        where id = v_existing_res_id;
      else
        insert into public.stock_reservations (
          order_id, order_item_id, product_id, quantity, state, source_type,
          purchase_item_id, cost_snapshot_cents
        ) values (
          v_order_id, v_order_item_id, v_line.product_id, v_phys_alloc, 'active', 'physical',
          null, v_locked.current_cost_cents
        );
      end if;

      insert into public.stock_movements (
        product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
      ) values (
        v_line.product_id, v_locked.name, 'reservation', 0, v_phys_alloc,
        'Reserva de stock por edición de pedido #' || v_order.order_number,
        v_order_id, auth.uid()
      );
    end if;

    if v_remaining > 0 then
      for v_purchase in
        select pu.id as purchase_id, pi.id as purchase_item_id, pi.unit_cost_cents,
               (pi.quantity - pi.received_quantity - pi.shortage_quantity - coalesce((
                 select sum(sr.quantity)
                 from public.stock_reservations sr
                 where sr.purchase_item_id = pi.id and sr.state = 'active' and sr.source_type = 'incoming'
               ), 0)) as incoming_avail
        from public.purchase_items pi
        join public.purchases pu on pu.id = pi.purchase_id
        where pi.product_id = v_line.product_id
          and pu.state = 'ordered'
        order by coalesce(pu.expected_at, pu.ordered_at + interval '7 days') asc, pu.ordered_at asc, pu.id asc, pi.id asc
        for update of pu, pi
      loop
        if v_purchase.incoming_avail > 0 then
          v_take := least(v_remaining, v_purchase.incoming_avail);

          select id into v_existing_res_id
          from public.stock_reservations
          where order_item_id = v_order_item_id
            and state = 'active'
            and source_type = 'incoming'
            and purchase_item_id = v_purchase.purchase_item_id
            and cost_snapshot_cents = v_purchase.unit_cost_cents
          limit 1;

          if v_existing_res_id is not null then
            update public.stock_reservations
            set quantity = quantity + v_take
            where id = v_existing_res_id;
          else
            insert into public.stock_reservations (
              order_id, order_item_id, product_id, quantity, state, source_type,
              purchase_item_id, cost_snapshot_cents
            ) values (
              v_order_id, v_order_item_id, v_line.product_id, v_take, 'active', 'incoming',
              v_purchase.purchase_item_id, v_purchase.unit_cost_cents
            );
          end if;

          v_remaining := v_remaining - v_take;
          exit when v_remaining = 0;
        end if;
      end loop;
    end if;

    if v_remaining > 0 then
      raise exception using errcode = 'P0001', message = case
        when v_order.stock_source = 'incoming_only' then 'INSUFFICIENT_INCOMING_STOCK'
        else 'INSUFFICIENT_STOCK'
      end;
    end if;

    select coalesce(sum(quantity::bigint * cost_snapshot_cents), 0)
    into v_item_cost_total
    from public.stock_reservations
    where order_item_id = v_order_item_id and state = 'active';

    update public.order_items
    set quantity = v_line.quantity,
        cost_total_cents = v_item_cost_total,
        unit_cost_cents = round(v_item_cost_total::numeric / v_line.quantity)::bigint,
        unit_price_cents = case
          when v_order.sale_type = 'cost' then round(v_item_cost_total::numeric / v_line.quantity)::bigint
          when v_order.sale_type = 'gift' or v_order.payment_state = 'gifted' then 0
          else unit_price_cents
        end
    where id = v_order_item_id;
  end loop;

  -- Phase 3: Recalculate order preparation state and financial totals.
  select
    coalesce(bool_and(packed_quantity is not null and packed_quantity = quantity), false),
    coalesce(bool_or(coalesce(packed_quantity, 0) > 0), false),
    coalesce(sum(line_subtotal_cents), 0),
    coalesce(sum(cost_total_cents), 0)
  into v_all_packed, v_any_packed, v_items_subtotal, v_cost_total
  from public.order_items
  where order_id = v_order_id;

  v_has_non_physical := exists (
    select 1 from public.stock_reservations
    where order_id = v_order_id and state = 'active' and source_type <> 'physical'
  );

  if v_order.preparation_state = 'ready' then
    if not v_has_non_physical and (
      (v_has_tracked_packing and v_all_packed)
      or (not v_has_tracked_packing and not v_any_added_or_increased)
    ) then
      v_new_prep_state := 'ready';
    else
      v_new_prep_state := case
        when v_any_packed then 'preparing'::public.preparation_state
        else 'pending'::public.preparation_state
      end;
    end if;
  elsif v_has_tracked_packing then
    v_new_prep_state := case
      when v_any_packed then 'preparing'::public.preparation_state
      else 'pending'::public.preparation_state
    end;
  else
    v_new_prep_state := v_order.preparation_state;
  end if;

  if v_order.sale_type = 'gift' or v_order.payment_state = 'gifted' then
    v_subtotal := 0;
    v_total := 0;
    v_tax := 0;
  elsif v_order.sale_type = 'cost' then
    v_subtotal := v_cost_total;
    v_total := v_cost_total + v_order.shipping_fee_cents;
    v_tax := 0;
  else
    v_subtotal := v_items_subtotal;
    v_total := v_items_subtotal + v_order.shipping_fee_cents;
    v_tax := round(v_total::numeric * coalesce(v_order.tax_rate_basis_points, 0) / 10000.0)::bigint;
  end if;

  update public.orders
  set subtotal_cents = v_subtotal,
      total_cents = v_total,
      cost_total_cents = v_cost_total,
      tax_amount_cents = v_tax,
      preparation_state = v_new_prep_state,
      packing_revision = case when v_packing_changed then packing_revision + 1 else packing_revision end
  where id = v_order_id;

  -- Phase 4: Reconcile freed physical stock to waiting orders in FIFO order.
  for v_reconcile_product_id in
    select distinct p_id from unnest(v_products_to_reconcile) as p_id order by p_id asc
  loop
    perform private.reconcile_product_stock(v_reconcile_product_id);
  end loop;

  v_after := private.order_payload(v_order_id, true);

  insert into public.order_action_reversals (
    operation_id, order_id, action, expected_revision, request_payload, previous_payload, current_payload, created_by
  ) values (
    v_operation_id, v_order_id, 'edit_items', v_expected_revision, v_canonical_items, v_before, v_after, auth.uid()
  );

  perform private.bump_revision();
  return private.order_payload(v_order_id, private.is_owner());
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
end;
$$;

revoke all on function public.update_order_items(jsonb) from public, anon, authenticated;
grant execute on function public.update_order_items(jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

