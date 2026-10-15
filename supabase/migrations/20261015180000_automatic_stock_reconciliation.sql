-- Migration: 20261015180000_automatic_stock_reconciliation.sql
-- Description: Unifica la promoción de reservas en private.reconcile_product_stock,
-- audita los movimientos en stock_movements, fusiona reservas físicas existentes para
-- evitar fragmentación en pedidos mixtos, subsana el ordenamiento de compras entrantes
-- frente a fechas nulas (NULLS LAST), y conecta la reconciliación a recepciones, cancelaciones
-- y ajustes positivos de inventario.

begin;

-- ==============================================================================
-- 1. MOTOR DE RECONCILIACIÓN ATÓMICA DE STOCK LIBRE
-- ==============================================================================
create or replace function private.reconcile_product_stock(p_product_id uuid)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_on_hand integer;
  v_reserved integer;
  v_avail integer;
  v_promoted_total integer := 0;
  v_take integer;
  v_res record;
  v_existing_physical_id uuid;
  v_product_name text;
  v_current_cost bigint;
  v_effective_cost bigint;
  v_affected_order_ids uuid[] := array[]::uuid[];
begin
  -- 1. Bloqueo canónico Nivel 1 (products + stock_balances)
  select p.name, coalesce(f.current_cost_cents, 0), sb.on_hand, sb.reserved
  into v_product_name, v_current_cost, v_on_hand, v_reserved
  from public.products p
  join public.stock_balances sb on sb.product_id = p.id
  left join public.product_financials f on f.product_id = p.id
  where p.id = p_product_id
  for update of p, sb;

  if not found then return array[]::uuid[]; end if;

  v_avail := greatest(0, v_on_hand - v_reserved);
  if v_avail <= 0 then return array[]::uuid[]; end if;

  -- 2. Recorrer reservas 'incoming' o 'uncovered' por antigüedad estricta (FIFO)
  for v_res in
    select sr.id, sr.order_id, sr.order_item_id, sr.quantity, sr.cost_snapshot_cents,
           sr.is_opening, o.order_number, o.created_by as order_created_by
    from public.stock_reservations sr
    join public.orders o on o.id = sr.order_id
    where sr.product_id = p_product_id
      and sr.state = 'active'
      and sr.source_type in ('incoming', 'uncovered')
      and o.order_state <> 'cancelled'
    order by coalesce(o.confirmed_at, o.created_at) asc, o.order_number asc, sr.id asc
    for update of sr
  loop
    if v_avail <= 0 then exit; end if;

    v_take := least(v_res.quantity, v_avail);
    v_effective_cost := coalesce(nullif(v_res.cost_snapshot_cents, 0), v_current_cost, 0);

    -- 3. FUSIÓN O CONVERSIÓN FÍSICA (Evita duplicación en pedidos mixtos como #2605)
    select id into v_existing_physical_id
    from public.stock_reservations
    where order_item_id = v_res.order_item_id
      and source_type = 'physical'
      and state = 'active'
      and is_opening = v_res.is_opening
    limit 1;

    if v_existing_physical_id is not null then
      -- Fusionar en la reserva física preexistente
      update public.stock_reservations
      set quantity = quantity + v_take
      where id = v_existing_physical_id;

      if v_res.quantity = v_take then
        delete from public.stock_reservations where id = v_res.id;
      else
        update public.stock_reservations
        set quantity = quantity - v_take
        where id = v_res.id;
      end if;
    elsif v_res.quantity = v_take then
      -- Conversión in-place
      update public.stock_reservations
      set source_type = 'physical',
          purchase_item_id = null,
          cost_snapshot_cents = v_effective_cost
      where id = v_res.id;
    else
      -- Split parcial
      update public.stock_reservations
      set quantity = v_res.quantity - v_take
      where id = v_res.id;

      insert into public.stock_reservations (
        order_id, order_item_id, product_id, quantity, state, source_type,
        purchase_item_id, cost_snapshot_cents, is_opening
      ) values (
        v_res.order_id, v_res.order_item_id, p_product_id, v_take, 'active', 'physical',
        null, v_effective_cost, v_res.is_opening
      );
    end if;

    -- 4. Actualizar libro mayor de stock_movements (Garantiza integridad contable)
    insert into public.stock_movements (
      product_id, product_name_snapshot, kind, physical_delta, reserved_delta,
      reason, order_id, created_by
    ) values (
      p_product_id,
      v_product_name,
      'reservation',
      0,
      v_take,
      'Asignación física por reconciliación de stock libre (Pedido #' || v_res.order_number || ')',
      v_res.order_id,
      coalesce(auth.uid(), v_res.order_created_by)
    );

    -- 5. Actualizar saldo reservado
    update public.stock_balances
    set reserved = reserved + v_take
    where product_id = p_product_id;

    v_avail := v_avail - v_take;
    v_promoted_total := v_promoted_total + v_take;
    if not (v_res.order_id = any(v_affected_order_ids)) then
      v_affected_order_ids := array_append(v_affected_order_ids, v_res.order_id);
    end if;
  end loop;

  if v_promoted_total > 0 then
    perform private.bump_revision();
  end if;

  return v_affected_order_ids;
end;
$$;

revoke all on function private.reconcile_product_stock(uuid) from public, anon, authenticated;


-- ==============================================================================
-- 2. ACTUALIZAR adjust_product_stock PARA ABSORBER PEDIDOS AL AUMENTAR STOCK
-- ==============================================================================
create or replace function public.adjust_product_stock(
  p_product_id uuid,
  p_delta integer,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_name text;
begin
  perform private.require_owner();
  if p_delta = 0 or char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception using errcode = 'P0001', message = 'INVALID_ADJUSTMENT';
  end if;
  select p.name into v_product_name
  from public.products p
  join public.stock_balances sb on sb.product_id = p.id
  where p.id = p_product_id
  for update of p, sb;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;
  update public.stock_balances
  set on_hand = on_hand + p_delta
  where product_id = p_product_id;
  insert into public.stock_movements(
    product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, created_by
  ) values (
    p_product_id, v_product_name, 'adjustment', p_delta, 0, btrim(p_reason), auth.uid()
  );
  if p_delta > 0 then
    perform private.reconcile_product_stock(p_product_id);
  end if;
  perform private.bump_revision();
end;
$$;

revoke all on function public.adjust_product_stock(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.adjust_product_stock(uuid, integer, text) to authenticated;


-- ==============================================================================
-- 3. ACTUALIZAR receive_purchase PARA RECONCILIAR EXCEDENTES FÍSICOS
-- ==============================================================================
create or replace function public.receive_purchase(
  p_purchase_id uuid,
  p_items jsonb,
  p_operation_id uuid default null,
  p_shipping_cost_cents bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing_receipt record;
  v_canonical_items jsonb;
  v_purchase record;
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
  v_res_obj jsonb;
  v_shipping_expense public.misc_expenses%rowtype;
  v_reconciled_orders uuid[];
begin
  perform private.require_owner();
  if p_shipping_cost_cents is null or p_shipping_cost_cents not between 0 and 99999999900 or p_shipping_cost_cents % 100 <> 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_SHIPPING_FEE';
  end if;
  p_operation_id := coalesce(p_operation_id, gen_random_uuid());
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 2));

  if coalesce(jsonb_typeof(p_items), 'null') <> 'array' or (jsonb_array_length(p_items) = 0 and p_shipping_cost_cents = 0) then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  if (select count(*) <> count(distinct elem ->> 'purchaseItemId') from jsonb_array_elements(p_items) elem) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_PURCHASE_ITEM';
  end if;

  -- Canonicalización estricta del payload de ítems para comparación determinista
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'purchaseItemId', (elem ->> 'purchaseItemId')::uuid,
        'receivedQuantity', (elem ->> 'receivedQuantity')::integer
      )
      order by (elem ->> 'purchaseItemId')::uuid asc
    ),
    '[]'::jsonb
  )
  into v_canonical_items
  from jsonb_array_elements(p_items) elem;

  -- 1. FAST-PATH DE IDEMPOTENCIA PREVIO A LOCKS
  if p_operation_id is not null then
    select purchase_id, items_payload, result_payload, shipping_cost_cents
    into v_existing_receipt
    from public.purchase_receipts
    where operation_id = p_operation_id;

    if found then
      if v_existing_receipt.purchase_id <> p_purchase_id or v_existing_receipt.items_payload <> v_canonical_items or v_existing_receipt.shipping_cost_cents <> p_shipping_cost_cents then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;
      return v_existing_receipt.result_payload;
    end if;
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

  -- 2. DOUBLE-CHECKED LOCKING POSTERIOR A LOCKS (Protección contra carreras concurrentes con mismo operation_id)
  if p_operation_id is not null then
    select purchase_id, items_payload, result_payload, shipping_cost_cents
    into v_existing_receipt
    from public.purchase_receipts
    where operation_id = p_operation_id;

    if found then
      if v_existing_receipt.purchase_id <> p_purchase_id or v_existing_receipt.items_payload <> v_canonical_items or v_existing_receipt.shipping_cost_cents <> p_shipping_cost_cents then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;
      return v_existing_receipt.result_payload;
    end if;
  end if;

  -- ANTI-DEADLOCK NIVEL 2: Bloqueo de purchases
  select * into v_purchase
  from public.purchases
  where id = p_purchase_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'PURCHASE_NOT_FOUND';
  end if;

  if v_purchase.state not in ('ordered', 'received') then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE_STATE';
  end if;

  -- Procesar cada ítem recibido
  for v_input_item in
    select
      (elem ->> 'purchaseItemId')::uuid as purchase_item_id,
      (elem ->> 'receivedQuantity')::integer as received_quantity
    from jsonb_array_elements(v_canonical_items) elem
    order by (elem ->> 'purchaseItemId')::uuid asc
  loop
    if v_input_item.received_quantity < 0 or v_input_item.received_quantity > 100000 then
      raise exception using errcode = 'P0001', message = 'INVALID_QUANTITY';
    end if;

    if v_input_item.received_quantity = 0 then
      continue;
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

    -- Conversión FIFO directa de reservas atadas a este purchase_item_id
    for v_res in
      select sr.*
      from public.stock_reservations sr
      left join public.orders o on o.id = sr.order_id
      where sr.purchase_item_id = v_pi.id and sr.state = 'active' and sr.source_type = 'incoming'
      order by sr.is_opening desc, coalesce(o.confirmed_at, sr.created_at) asc, o.order_number asc, sr.id asc
      for update of sr
    loop
      if v_to_convert <= 0 then exit; end if;

      v_take := least(v_res.quantity, v_to_convert);

      select id into v_physical_res_id
      from public.stock_reservations
      where order_id is not distinct from v_res.order_id
        and is_opening = v_res.is_opening
        and product_id = v_res.product_id
        and source_type = 'physical'
        and state = 'active'
        and purchase_item_id is not distinct from v_res.purchase_item_id
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
        update public.stock_reservations
        set source_type = 'physical'
        where id = v_res.id;
      else
        insert into public.stock_reservations (
          order_id, order_item_id, product_id, quantity, state, source_type,
          purchase_item_id, cost_snapshot_cents, created_at, is_opening
        ) values (
          v_res.order_id, v_res.order_item_id, v_res.product_id, v_take, 'active', 'physical',
          v_res.purchase_item_id, v_res.cost_snapshot_cents, now(), v_res.is_opening
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
      if not (v_res.order_id = any(v_affected_order_ids)) then
        v_affected_order_ids := array_append(v_affected_order_ids, v_res.order_id);
      end if;
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

    -- 4. RECONCILIAR SOBRANTE FÍSICO HACIA COMPRAS FUTURAS / RESERVAS EN ESPERA
    v_reconciled_orders := private.reconcile_product_stock(v_pi.product_id);
    if cardinality(v_reconciled_orders) > 0 then
      v_affected_order_ids := array_cat(v_affected_order_ids, v_reconciled_orders);
    end if;
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
  v_res_obj := jsonb_build_object(
    'purchase', private.purchase_payload(p_purchase_id),
    'unblockedOrders', v_unblocked_orders
  );

  -- ASENTAR RECIBO IDEMPOTENTE
  if p_operation_id is not null then
    insert into public.purchase_receipts (
      operation_id, purchase_id, items_payload, result_payload, created_by
    ) values (
      p_operation_id, p_purchase_id, v_canonical_items, v_res_obj, auth.uid()
    )
    on conflict (operation_id) do nothing;
  end if;

  if p_shipping_cost_cents > 0 then
    insert into public.misc_expenses(operation_id, title, amount_cents, frequency, starts_on, created_by, updated_by, purchase_receipt_operation_id)
    values(gen_random_uuid(), 'Envío de proveedor · Compra #' || v_purchase.purchase_number,
      p_shipping_cost_cents, 'once', (now() at time zone 'America/Argentina/Buenos_Aires')::date,
      auth.uid(), auth.uid(), p_operation_id) returning * into v_shipping_expense;
    insert into public.misc_expense_audit(expense_id, action, before_snapshot, after_snapshot, changed_at, changed_by)
    values(v_shipping_expense.id, 'created', null, to_jsonb(v_shipping_expense), v_shipping_expense.updated_at, auth.uid());
    v_res_obj := v_res_obj || jsonb_build_object('shippingExpense', private.misc_expense_payload(v_shipping_expense.id));
  else
    v_res_obj := v_res_obj || jsonb_build_object('shippingExpense', null);
  end if;
  update public.purchase_receipts set shipping_cost_cents = p_shipping_cost_cents,
    shipping_expense_id = v_shipping_expense.id, result_payload = v_res_obj where operation_id = p_operation_id;
  return v_res_obj;
end;
$$;

revoke all on function public.receive_purchase(uuid,jsonb,uuid,bigint) from public,anon,authenticated;
grant execute on function public.receive_purchase(uuid,jsonb,uuid,bigint) to authenticated;


-- ==============================================================================
-- 4. ACTUALIZAR transition_order PARA RECONCILIAR STOCK AL CANCELAR PEDIDOS
-- ==============================================================================
create or replace function public.transition_order(
  p_order_id uuid,
  p_action text
)
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
    if p_action = 'cancel' then return private.order_payload(p_order_id, private.is_owner()); end if;
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
  end if;

  if p_action = 'mark_paid' then
    if v_order.payment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders set payment_state = 'paid', paid_at = now() where id = p_order_id;

  elsif p_action = 'mark_at_cost' then
    perform private.require_owner();

    if v_order.sale_type = 'cost' and v_order.payment_state = 'paid' then
      return private.order_payload(p_order_id, private.is_owner());
    end if;

    if v_order.order_state = 'cancelled' or v_order.payment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;

    update public.order_items
    set unit_price_cents = coalesce(unit_cost_cents, 0)
    where order_id = p_order_id;

    select coalesce(sum(line_subtotal_cents), 0) into v_cost_total
    from public.order_items where order_id = p_order_id;

    update public.orders
    set sale_type = 'cost',
        payment_state = 'paid',
        paid_at = now(),
        subtotal_cents = v_cost_total,
        total_cents = v_cost_total + shipping_fee_cents,
        tax_amount_cents = 0,
        cost_total_cents = v_cost_total
    where id = p_order_id;

  elsif p_action = 'mark_ready' then
    if v_order.order_state = 'cancelled' or v_order.fulfillment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;

    if v_order.preparation_state = 'ready' then
      return private.order_payload(p_order_id, private.is_owner());
    end if;

    if exists (
      select 1 from public.stock_reservations
      where order_id = p_order_id and state = 'active' and source_type <> 'physical'
    ) then
      raise exception using errcode = 'P0001', message = 'CANNOT_READY_ORDER_WAITING_FOR_STOCK';
    end if;

    update public.orders
    set preparation_state = 'ready'
    where id = p_order_id;

  elsif p_action = 'start_preparing' then
    if v_order.order_state = 'cancelled' or v_order.fulfillment_state in ('delivered', 'cancelled') then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders
    set preparation_state = 'preparing'
    where id = p_order_id and preparation_state = 'pending';

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
        shipping_fee_method = 'manual',
        shipping_fee_basis_points = null,
        shipping_fee_cost_base_cents = null,
        shipping_fee_revision = shipping_fee_revision + 1,
        total_cents = 0,
        tax_amount_cents = 0,
        paid_at = now()
    where id = p_order_id;
    if v_order.shipping_fee_cents > 0 or v_order.shipping_fee_method <> 'catalog' then
      insert into public.order_shipping_fee_events(operation_id,order_id,input_payload,previous_payload,current_payload,created_by)
      select gen_random_uuid(), p_order_id, jsonb_build_object('action','mark_gifted'),
        private.shipping_fee_snapshot(v_order), private.shipping_fee_snapshot(o), auth.uid()
      from public.orders o where o.id = p_order_id;
    end if;

  elsif p_action = 'cancel' then
    if v_order.payment_state = 'paid' then
      raise exception using errcode = 'P0001', message = 'CANNOT_CANCEL_PAID_ORDER';
    end if;
    if v_order.fulfillment_state in ('shipped','delivered') then
      raise exception using errcode = 'P0001', message = 'CANNOT_CANCEL_FULFILLED_ORDER';
    end if;
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

          insert into public.stock_movements(
            product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
          ) values (
            v_res.product_id,
            coalesce(
              (select name from public.products where id = v_res.product_id),
              (select product_name_snapshot from public.order_items where order_id = p_order_id and product_id = v_res.product_id limit 1),
              'Producto'
            ),
            'reservation_release',
            0,
            -v_res.quantity,
            'Cancelación de reserva física por pedido cancelado',
            p_order_id,
            auth.uid()
          );
        end if;

        update public.stock_reservations
        set state = 'released', resolved_at = now()
        where id = v_res.id;
      end loop;

    update public.orders
    set order_state = 'cancelled',
        fulfillment_state = 'cancelled',
        preparation_state = 'ready',
        payment_state = case when payment_state in ('paid','gifted') then 'refunded'::public.payment_state else payment_state end,
        cancelled_at = now()
    where id = p_order_id;

    -- RECONCILIAR STOCK LIBERADO POR CANCELACIÓN HACIA RESERVAS EN ESPERA POR FIFO
    for v_item in
      select distinct product_id from public.order_items where order_id = p_order_id order by product_id asc
    loop
      perform private.reconcile_product_stock(v_item.product_id);
    end loop;

  else
    raise exception using errcode = 'P0001', message = 'INVALID_ACTION';
  end if;

  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;

revoke all on function public.transition_order(uuid, text) from public, anon, authenticated;
grant execute on function public.transition_order(uuid, text) to authenticated;


-- ==============================================================================
-- 5. ACTUALIZAR confirm_imported_order CON ORDENAMIENTO TEMPORAL CORREGIDO
-- ==============================================================================
create or replace function public.confirm_imported_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lines jsonb;
  v_line record;
  v_settings public.store_settings%rowtype;
  v_customer_id uuid;
  v_customer_name text;
  v_customer_first_name text;
  v_customer_last_name text;
  v_phone text;
  v_phone_digits text;
  v_phone_canonical text;
  v_address text;
  v_payment_method public.payment_method;
  v_delivery_method public.delivery_method;
  v_protocol_order_id uuid;
  v_checksum text;
  v_source text;
  v_shipping_fee bigint;
  v_subtotal bigint := 0;
  v_total bigint := 0;
  v_cost_total bigint := 0;
  v_order_id uuid;
  v_order_item_id uuid;
  v_item_cost_total bigint;
  v_phys_avail integer;
  v_phys_alloc integer;
  v_remaining integer;
  v_locked record;
  v_purchase record;
  v_take integer;
  v_existing_order record;
  v_shipping_type public.shipping_type;
  v_is_gift boolean := false;
  v_is_cost boolean := false;
  v_sale_type text := 'retail';
  v_stock_source text := coalesce(p_order ->> 'stockSource', 'normal');
begin
  perform private.require_active_user();
  if v_stock_source not in ('normal', 'incoming_only') then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;
  v_lines := p_order -> 'lines';

  if coalesce(jsonb_typeof(v_lines), 'null') <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  if (select count(*) <> count(distinct line ->> 'productId') from jsonb_array_elements(v_lines) line) then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_lines) line
    where coalesce((line ->> 'quantity')::integer, 0) <= 0
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  v_protocol_order_id := nullif(p_order ->> 'protocolOrderId', '')::uuid;
  v_checksum := upper(btrim(coalesce(p_order ->> 'protocolChecksum', '')));
  v_customer_first_name := btrim(coalesce(p_order ->> 'customerFirstName', ''));
  v_customer_last_name := btrim(coalesce(p_order ->> 'customerLastName', ''));
  v_customer_name := btrim(coalesce(p_order ->> 'customerName', ''));

  if char_length(v_customer_first_name) >= 1 or char_length(v_customer_last_name) >= 1 then
    if char_length(v_customer_first_name) < 2 or char_length(v_customer_last_name) < 2 then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;
    v_customer_name := btrim(concat_ws(' ', v_customer_first_name, v_customer_last_name));
  else
    if char_length(v_customer_name) not between 2 and 100 then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;
    v_customer_first_name := coalesce(nullif(split_part(v_customer_name, ' ', 1), ''), v_customer_name);
    v_customer_last_name := coalesce(nullif(btrim(substring(v_customer_name from length(v_customer_first_name) + 1)), ''), '-');
  end if;

  v_phone := nullif(btrim(coalesce(p_order ->> 'phone', '')), '');
  v_phone_digits := case when v_phone is not null then regexp_replace(v_phone, '[^0-9]', '', 'g') else '' end;
  v_phone_canonical := public.canonical_phone(v_phone);
  v_payment_method := (p_order ->> 'paymentMethod')::public.payment_method;
  v_delivery_method := (p_order ->> 'deliveryMethod')::public.delivery_method;
  v_shipping_type := nullif(p_order ->> 'shippingType', '')::public.shipping_type;
  v_shipping_fee := coalesce((p_order ->> 'shippingFeeCents')::bigint, 0);
  v_sale_type := coalesce(nullif(p_order ->> 'saleType', ''), 'retail');

  if v_payment_method = 'gift' or v_sale_type = 'gift' then
    v_is_gift := true;
    v_sale_type := 'gift';
    v_shipping_fee := 0;
  elsif v_sale_type = 'cost' then
    v_is_cost := true;
  end if;

  if v_delivery_method = 'pickup' then
    v_address := null;
  else
    v_address := nullif(btrim(concat_ws(' ', nullif(p_order ->> 'address', ''), nullif(p_order ->> 'addressNumber', ''))), '');
  end if;

  if v_is_gift or v_is_cost then perform private.require_owner(); end if;

  -- Idempotencia
  if v_protocol_order_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_protocol_order_id::text));

    select id, protocol_checksum, customer_name_snapshot, customer_phone_snapshot,
           payment_method, delivery_method, shipping_type, shipping_address,
           shipping_fee_cents, subtotal_cents, total_cents, sale_type, stock_source
    into v_existing_order
    from public.orders
    where protocol_order_id = v_protocol_order_id
    limit 1;

    if v_existing_order.id is not null then
      if v_existing_order.customer_name_snapshot is distinct from v_customer_name
         or v_existing_order.customer_phone_snapshot is distinct from v_phone
         or v_existing_order.payment_method is distinct from v_payment_method
         or v_existing_order.delivery_method is distinct from v_delivery_method
         or v_existing_order.shipping_type is distinct from v_shipping_type
         or v_existing_order.shipping_address is distinct from v_address
         or v_existing_order.shipping_fee_cents is distinct from v_shipping_fee
         or v_existing_order.stock_source <> v_stock_source
         or coalesce(v_existing_order.sale_type, 'retail') <> v_sale_type
         or v_existing_order.protocol_checksum is distinct from nullif(v_checksum, '')
      then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      if not v_is_gift and not v_is_cost and (
        v_existing_order.subtotal_cents is distinct from (p_order ->> 'quotedSubtotalCents')::bigint
        or v_existing_order.total_cents is distinct from (p_order ->> 'quotedTotalCents')::bigint
      ) then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      if (select count(*) from public.order_items where order_id = v_existing_order.id) <> jsonb_array_length(v_lines)
         or exists (
           select 1 from jsonb_array_elements(v_lines) line
           where not exists (
             select 1 from public.order_items oi
             where oi.order_id = v_existing_order.id
               and oi.product_id = (line ->> 'productId')::uuid
               and oi.quantity = (line ->> 'quantity')::integer
               and (v_is_gift or v_is_cost or oi.unit_price_cents = (line ->> 'unitPriceCents')::bigint)
           )
         )
      then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      return jsonb_set(private.order_payload(v_existing_order.id, private.is_owner()), '{alreadyImported}', 'true'::jsonb);
    end if;
  end if;

  select * into v_settings from public.store_settings where singleton_id = 1 for share;

  v_source := case when v_protocol_order_id is not null then 'whatsapp_import' else 'manual' end;
  if v_source = 'whatsapp_import' then
    if v_checksum !~ '^[0-9A-F]{8}$' then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;
  else
    v_checksum := null;
  end if;

  if not v_is_gift then
    if v_delivery_method = 'pickup' then
      if v_shipping_type is not null or v_shipping_fee <> 0 then
        raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
      end if;
    else
      if v_shipping_type is null then
        raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
      end if;
      if coalesce(char_length(v_address), 0) < 3 or coalesce(char_length(v_phone_digits), 0) < 8 then
        raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
      end if;
      if v_shipping_fee <> (case
        when v_shipping_type = 'express' then v_settings.express_shipping_cents
        else v_settings.standard_shipping_cents
      end) then
        raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
      end if;
    end if;
  end if;

  if v_phone_canonical <> '' then
    select id into v_customer_id
    from public.customers
    where public.canonical_phone(phone) = v_phone_canonical
    order by last_order_at desc
    limit 1;

    if v_customer_id is not null then
      update public.customers
      set first_name = v_customer_first_name,
          last_name = v_customer_last_name,
          name = v_customer_name,
          phone = coalesce(phone, v_phone),
          last_order_at = now()
      where id = v_customer_id;
    else
      insert into public.customers(first_name, last_name, name, phone, first_order_at, last_order_at)
      values (v_customer_first_name, v_customer_last_name, v_customer_name, v_phone, now(), now())
      returning id into v_customer_id;
    end if;
  else
    select id into v_customer_id
    from public.customers
    where lower(name) = lower(v_customer_name)
    order by last_order_at desc
    limit 1;

    if v_customer_id is not null then
      update public.customers
      set first_name = v_customer_first_name,
          last_name = v_customer_last_name,
          last_order_at = now()
      where id = v_customer_id;
    else
      insert into public.customers(first_name, last_name, name, phone, first_order_at, last_order_at)
      values (v_customer_first_name, v_customer_last_name, v_customer_name, null, now(), now())
      returning id into v_customer_id;
    end if;
  end if;

  if v_is_gift then
    v_subtotal := 0;
    v_total := 0;
  elsif v_is_cost then
    v_subtotal := 0;
    v_total := 0;
  else
    select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unitPriceCents')::bigint), 0)
    into v_subtotal
    from jsonb_array_elements(v_lines) line;
    v_total := v_subtotal + v_shipping_fee;
  end if;

  insert into public.orders (
    customer_id, customer_name_snapshot, customer_first_name_snapshot, customer_last_name_snapshot,
    customer_phone_snapshot, payment_method, delivery_method,
    shipping_type, shipping_address, source, protocol_order_id, protocol_checksum, subtotal_cents,
    shipping_fee_cents, total_cents, tax_rate_basis_points, tax_amount_cents, cost_total_cents, created_by,
    payment_state, paid_at, sale_type, stock_source
  ) values (
    v_customer_id, v_customer_name, v_customer_first_name, v_customer_last_name,
    v_phone, v_payment_method, v_delivery_method,
    v_shipping_type, v_address, v_source, v_protocol_order_id, v_checksum, v_subtotal,
    v_shipping_fee, v_total, v_settings.tax_rate_basis_points,
    case when v_is_gift or v_is_cost then 0 else round(v_total * v_settings.tax_rate_basis_points / 10000.0)::bigint end,
    0, auth.uid(),
    case when v_is_gift then 'gifted'::public.payment_state else 'pending'::public.payment_state end,
    case when v_is_gift then now() else null end,
    v_sale_type, v_stock_source
  ) returning id into v_order_id;

  for v_line in
    select
      (line ->> 'productId')::uuid as product_id,
      (line ->> 'quantity')::integer as quantity,
      (line ->> 'unitPriceCents')::bigint as unit_price
    from jsonb_array_elements(v_lines) line
    order by (line ->> 'productId')::uuid
  loop
    select p.sku, p.name, p.presentation, p.sale_price_cents, p.active, p.published,
           s.on_hand, s.reserved, f.current_cost_cents
    into v_locked
    from public.products p
    join public.stock_balances s on s.product_id = p.id
    join public.product_financials f on f.product_id = p.id
    where p.id = v_line.product_id
    for update of p, s;

    if not found or not v_locked.active then
      raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
    end if;

    if not v_is_gift and not v_is_cost and v_locked.sale_price_cents <> v_line.unit_price then
      raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
    end if;

    insert into public.order_items (
      order_id, product_id, sku_snapshot, product_name_snapshot,
      presentation_snapshot, quantity, unit_price_cents, unit_cost_cents, cost_total_cents
    ) values (
      v_order_id, v_line.product_id, v_locked.sku, v_locked.name,
      v_locked.presentation, v_line.quantity,
      case
        when v_is_gift then 0
        when v_is_cost then v_locked.current_cost_cents
        else v_line.unit_price
      end,
      v_locked.current_cost_cents, 0
    ) returning id into v_order_item_id;

    v_phys_avail := greatest(0, v_locked.on_hand - v_locked.reserved);
    v_phys_alloc := case when v_stock_source = 'incoming_only' then 0 else least(v_line.quantity, v_phys_avail) end;
    v_remaining := v_line.quantity - v_phys_alloc;
    v_item_cost_total := 0;

    if v_phys_alloc > 0 then
      update public.stock_balances
      set reserved = reserved + v_phys_alloc
      where product_id = v_line.product_id;

      insert into public.stock_reservations (
        order_id, order_item_id, product_id, quantity, state, source_type,
        purchase_item_id, cost_snapshot_cents
      ) values (
        v_order_id, v_order_item_id, v_line.product_id, v_phys_alloc, 'active', 'physical',
        null, v_locked.current_cost_cents
      );

      insert into public.stock_movements(
        product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
      ) values (
        v_line.product_id, v_locked.name, 'reservation', 0, v_phys_alloc,
        case
          when v_is_gift then 'Reserva de stock al registrar regalo'
          when v_is_cost then 'Reserva de stock al registrar venta al costo'
          else 'Reserva de stock al confirmar pedido'
        end,
        v_order_id, auth.uid()
      );

      v_item_cost_total := v_item_cost_total + v_locked.current_cost_cents * v_phys_alloc;
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
        -- ORDENAMIENTO TEMPORAL EQUITATIVO:
        -- Si expected_at no está cargado, estima ordered_at + 7 días para no quedar detrás de compras posteriores
        order by coalesce(pu.expected_at, pu.ordered_at + interval '7 days') asc, pu.ordered_at asc, pu.id asc, pi.id asc
        for update of pu, pi
      loop
        if v_purchase.incoming_avail > 0 then
          v_take := least(v_remaining, v_purchase.incoming_avail);

          insert into public.stock_reservations (
            order_id, order_item_id, product_id, quantity, state, source_type,
            purchase_item_id, cost_snapshot_cents
          ) values (
            v_order_id, v_order_item_id, v_line.product_id, v_take, 'active', 'incoming',
            v_purchase.purchase_item_id, v_purchase.unit_cost_cents
          );

          v_item_cost_total := v_item_cost_total + v_purchase.unit_cost_cents * v_take;
          v_remaining := v_remaining - v_take;
          if v_remaining = 0 then exit; end if;
        end if;
      end loop;
    end if;

    if v_remaining > 0 then
      raise exception using errcode = 'P0001', message = case when v_stock_source = 'incoming_only' then 'INSUFFICIENT_INCOMING_STOCK' else 'INSUFFICIENT_STOCK' end;
    end if;

    update public.order_items set cost_total_cents = v_item_cost_total where id = v_order_item_id;
    v_cost_total := v_cost_total + v_item_cost_total;
  end loop;

  if v_is_cost then
    v_subtotal := v_cost_total;
    v_total := v_cost_total + v_shipping_fee;
    update public.orders
    set subtotal_cents = v_subtotal,
        total_cents = v_total
    where id = v_order_id;
  end if;

  update public.orders
  set cost_total_cents = v_cost_total
  where id = v_order_id;

  perform private.bump_revision();
  return private.order_payload(v_order_id, private.is_owner());
end;
$$;

revoke all on function public.confirm_imported_order(jsonb) from public, anon, authenticated;
grant execute on function public.confirm_imported_order(jsonb) to authenticated;


-- ==============================================================================
-- 6. EJECUCIÓN INMEDIATA: RECONCILIAR PRODUCTOS CON STOCK LIBRE Y RESERVAS ACTIVAS
-- ==============================================================================
do $$
declare
  v_prod record;
  v_res uuid[];
begin
  for v_prod in
    select distinct product_id
    from public.stock_reservations
    where state = 'active' and source_type in ('incoming', 'uncovered')
    order by product_id asc
  loop
    v_res := private.reconcile_product_stock(v_prod.product_id);
    if cardinality(v_res) > 0 then
      raise notice 'Producto % reconciliado exitosamente para pedidos: %', v_prod.product_id, v_res;
    end if;
  end loop;
end;
$$;

commit;
