-- Preserve historical financial snapshots, one allocation engine, and legacy reservation origins.
-- No business rows are rewritten or reconciled by this corrective migration.
begin;

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
           sr.is_opening, sr.purchase_item_id, o.order_number, o.created_by as order_created_by
    from public.stock_reservations sr
    left join public.orders o on o.id = sr.order_id
    where sr.product_id = p_product_id
      and sr.state = 'active'
      and sr.source_type in ('incoming', 'uncovered')
      and (sr.is_opening or (o.order_state = 'confirmed' and o.fulfillment_state = 'pending'))
    order by sr.is_opening desc, coalesce(o.confirmed_at, o.created_at, sr.created_at) asc, o.order_number asc, sr.id asc
    for update of sr
  loop
    if v_avail <= 0 then exit; end if;

    v_take := least(v_res.quantity, v_avail);
    v_effective_cost := coalesce(v_res.cost_snapshot_cents, v_current_cost, 0);

    -- Merge only equal historical costs; packing correctly sums distinct physical lots.
    select id into v_existing_physical_id
    from public.stock_reservations
    where ((not v_res.is_opening and order_item_id = v_res.order_item_id)
        or (v_res.is_opening and purchase_item_id = v_res.purchase_item_id))
      and cost_snapshot_cents = v_effective_cost
      and source_type = 'physical'
      and state = 'active'
      and is_opening = v_res.is_opening
    limit 1;

    if v_existing_physical_id is not null then
      -- Merge an equivalent physical reservation without changing its unit cost.
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
          purchase_item_id = case when v_res.is_opening then v_res.purchase_item_id else null end,
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
        case when v_res.is_opening then v_res.purchase_item_id else null end, v_effective_cost, v_res.is_opening
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
      case when v_res.is_opening then 'Asignación física de reserva previa al sistema' else 'Asignación física por reconciliación de stock libre (Pedido #' || v_res.order_number || ')' end,
      v_res.order_id,
      coalesce(auth.uid(), v_res.order_created_by)
    );

    -- 5. Actualizar saldo reservado
    update public.stock_balances
    set reserved = reserved + v_take
    where product_id = p_product_id;

    v_avail := v_avail - v_take;
    v_promoted_total := v_promoted_total + v_take;
    if v_res.order_id is not null and not (v_res.order_id = any(v_affected_order_ids)) then
      v_affected_order_ids := array_append(v_affected_order_ids, v_res.order_id);
    end if;
  end loop;

  if v_promoted_total > 0 then
    perform private.bump_revision();
  end if;

  return v_affected_order_ids;
end;
$$;

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

  -- 2. DOUBLE-CHECKED LOCKING POSTERIOR A LOCKS
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
    if v_input_item.received_quantity is null or v_input_item.received_quantity < 0 or v_input_item.received_quantity > 100000 then
      raise exception using errcode = 'P0001', message = 'INVALID_QUANTITY';
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

    if v_input_item.received_quantity = 0 then continue; end if;

    if (v_pi.received_quantity + v_pi.shortage_quantity + v_input_item.received_quantity) > v_pi.quantity then
      raise exception using errcode = 'P0001', message = 'OVER_RECEIVING_NOT_ALLOWED';
    end if;

    v_qty_received := v_input_item.received_quantity;
    v_to_convert := v_qty_received;
    v_total_converted_physical := 0;

    -- Physical arrivals are allocated globally below, including older reservations
    -- linked to other purchases and pre-system reservations. Never clear their origin.
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

    -- Reconciliar sobrante físico hacia compras futuras / reservas en espera
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

  -- Calcular pedidos desbloqueados
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

  -- Recibo idempotente
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

  elsif p_action = 'mark_ready' then
    if v_order.order_state = 'cancelled' or v_order.fulfillment_state in ('delivered', 'cancelled') then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;

    -- Idempotencia: si ya está listo, no arroja error
    if v_order.preparation_state = 'ready' then
      return private.order_payload(p_order_id, private.is_owner());
    end if;

    -- No se puede marcar como listo si hay reservas de compras en camino pendientes de recepción
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

    for v_item in select distinct product_id from public.order_items where order_id = p_order_id order by product_id loop
      perform private.reconcile_product_stock(v_item.product_id);
    end loop;

  else
    raise exception using errcode = 'P0001', message = 'INVALID_ACTION';
  end if;

  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;

create or replace function public.resolve_opening_reservation(
  p_purchase_item_id uuid,p_quantity integer,p_action text,p_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_pi record; v_res record; v_existing record; v_payload jsonb; v_result jsonb;
  v_available integer; v_remaining integer; v_take integer; v_physical integer:=0;
begin
  perform private.require_active_user();
  if p_operation_id is null or p_quantity is null or p_quantity<1 or p_action is null or p_action not in ('deliver','release') then
    raise exception using errcode='P0001',message='INVALID_OPENING_RESERVATION_ACTION';
  end if;
  v_payload:=jsonb_build_object('purchaseItemId',p_purchase_item_id,'quantity',p_quantity,'action',p_action);
  -- Serialize retries of the same action before acquiring business row locks.
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 901));
  select * into v_existing from private.opening_reservation_operations where operation_id=p_operation_id;
  if found then
    if v_existing.payload<>v_payload or v_existing.created_by<>auth.uid() then
      raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSE_MISMATCH';
    end if;
    return v_existing.result;
  end if;
  select pi.*,p.name into v_pi from public.purchase_items pi join public.products p on p.id=pi.product_id where pi.id=p_purchase_item_id;
  if not found then raise exception using errcode='P0001',message='OPENING_RESERVATION_CHANGED'; end if;
  perform 1 from public.products p join public.stock_balances sb on sb.product_id=p.id where p.id=v_pi.product_id for update of p,sb;
  perform 1 from public.purchases where id=v_pi.purchase_id for update;
  perform 1 from public.purchase_items where id=p_purchase_item_id for update;
  perform 1 from public.stock_reservations where purchase_item_id=p_purchase_item_id and is_opening and state='active' for update;
  select coalesce(sum(quantity),0)::integer into v_available from public.stock_reservations
    where purchase_item_id=p_purchase_item_id and is_opening and state='active'
      and (p_action='release' or source_type='physical');
  if p_quantity>v_available then
    raise exception using errcode='P0001',message=case when p_action='deliver' then 'OPENING_RESERVATION_NOT_RECEIVED' else 'OPENING_RESERVATION_CHANGED' end;
  end if;
  v_remaining:=p_quantity;
  for v_res in select * from public.stock_reservations
    where purchase_item_id=p_purchase_item_id and is_opening and state='active'
      and (p_action='release' or source_type='physical')
    order by case source_type when 'physical' then 0 when 'incoming' then 1 else 2 end,created_at,id
  loop
    exit when v_remaining=0;
    v_take:=least(v_remaining,v_res.quantity);
    if v_take=v_res.quantity then
      update public.stock_reservations set state=(case when p_action='deliver' then 'consumed' else 'released' end)::public.reservation_state,resolved_at=now() where id=v_res.id;
    else
      update public.stock_reservations set quantity=quantity-v_take where id=v_res.id;
      insert into public.stock_reservations(product_id,quantity,state,resolved_at,source_type,purchase_item_id,cost_snapshot_cents,is_opening,created_at)
      values(v_res.product_id,v_take,(case when p_action='deliver' then 'consumed' else 'released' end)::public.reservation_state,now(),v_res.source_type,v_res.purchase_item_id,v_res.cost_snapshot_cents,true,v_res.created_at);
    end if;
    if v_res.source_type='physical' then v_physical:=v_physical+v_take; end if;
    v_remaining:=v_remaining-v_take;
  end loop;
  if v_physical>0 then
    update public.stock_balances set reserved=reserved-v_physical,
      on_hand=on_hand-case when p_action='deliver' then v_physical else 0 end where product_id=v_pi.product_id;
    insert into public.stock_movements(product_id,product_name_snapshot,kind,physical_delta,reserved_delta,reason,purchase_id,created_by)
    values(v_pi.product_id,v_pi.name,
      (case when p_action='deliver' then 'adjustment' else 'reservation_release' end)::public.stock_movement_kind,
      case when p_action='deliver' then -v_physical else 0 end,-v_physical,
      case when p_action='deliver' then 'Entrega de reserva previa al sistema; sin registrar un cobro' else 'Liberación de reserva previa al sistema' end,
      v_pi.purchase_id,auth.uid());
  end if;
  if p_action = 'release' then perform private.reconcile_product_stock(v_pi.product_id); end if;
  perform private.bump_revision();
  v_result:=jsonb_build_object('quantity',p_quantity,'action',p_action);
  insert into private.opening_reservation_operations(operation_id,payload,result,created_by) values(p_operation_id,v_payload,v_result,auth.uid());
  return v_result;
end;
$$;

create or replace function public.update_purchase(p_purchase jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purchase_id uuid;
  v_purchase public.purchases%rowtype;
  v_items jsonb;
  v_consolidated_items jsonb;
  v_line record;
  v_product record;
  v_supplier_name text;
  v_expected_at timestamptz;
  v_notes text;
  v_total bigint := 0;
begin
  perform private.require_owner();

  v_purchase_id := nullif(p_purchase ->> 'id', '')::uuid;
  if v_purchase_id is null then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

  -- Serialize editors, then lock the union of old and requested products in order.
  perform pg_advisory_xact_lock(hashtextextended(v_purchase_id::text, 915));
  perform 1 from public.products p join public.stock_balances sb on sb.product_id=p.id
  where p.id in (
    select product_id from public.purchase_items where purchase_id=v_purchase_id
    union select (item->>'productId')::uuid from jsonb_array_elements(p_purchase->'items') item
  ) order by p.id for update of p,sb;

  select * into v_purchase
  from public.purchases
  where id = v_purchase_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'PURCHASE_NOT_FOUND';
  end if;

  if v_purchase.state <> 'ordered' then
    raise exception using errcode = 'P0001', message = 'CANNOT_EDIT_COMPLETED_PURCHASE';
  end if;

  if exists (
    select 1 from public.purchase_items
    where purchase_id = v_purchase_id
      and (received_quantity > 0 or shortage_quantity > 0)
  ) then
    raise exception using errcode = 'P0001', message = 'PURCHASE_ALREADY_PARTIALLY_RECEIVED';
  end if;

  v_items := p_purchase -> 'items';
  if coalesce(jsonb_typeof(v_items), 'null') <> 'array' then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;
  if jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

  -- Consolidar automáticamente líneas duplicadas del mismo producto
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'productId', sub.product_id,
        'quantity', sub.total_qty,
        'unitCostCents', sub.avg_cost
      )
    ),
    '[]'::jsonb
  )
  into v_consolidated_items
  from (
    select
      (item ->> 'productId')::uuid as product_id,
      sum((item ->> 'quantity')::integer) as total_qty,
      round(
        sum((item ->> 'quantity')::bigint * (item ->> 'unitCostCents')::bigint) /
        nullif(sum((item ->> 'quantity')::bigint), 0)
      )::bigint as avg_cost
    from jsonb_array_elements(v_items) item
    group by (item ->> 'productId')::uuid
  ) sub;

  v_supplier_name := btrim(coalesce(p_purchase ->> 'supplierName', ''));
  v_expected_at := nullif(p_purchase ->> 'expectedAt', '')::timestamptz;
  v_notes := nullif(btrim(coalesce(p_purchase ->> 'notes', '')), '');
  if char_length(v_supplier_name) not between 2 and 120
    or coalesce(char_length(v_notes), 0) > 2000 then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

  perform 1
  from public.products p
  join (
    select (item ->> 'productId')::uuid as product_id
    from jsonb_array_elements(v_consolidated_items) item
  ) requested on requested.product_id = p.id
  where p.active
  order by p.id
  for update of p;
  if not found or (
    select count(*)
    from public.products p
    join (
      select (item ->> 'productId')::uuid as product_id
      from jsonb_array_elements(v_consolidated_items) item
    ) requested on requested.product_id = p.id
    where p.active
  ) <> jsonb_array_length(v_consolidated_items) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;

  -- 1. Eliminar ítems que ya no están en la lista (si tienen reservas activas, FK on delete restrict impide eliminar)
  delete from public.purchase_items pi
  where pi.purchase_id = v_purchase_id
    and pi.product_id not in (
      select (item ->> 'productId')::uuid
      from jsonb_array_elements(v_consolidated_items) item
    );

  -- 2. Actualizar o insertar los ítems
  for v_line in
    select
      (item ->> 'productId')::uuid as product_id,
      (item ->> 'quantity')::integer as quantity,
      (item ->> 'unitCostCents')::bigint as unit_cost_cents
    from jsonb_array_elements(v_consolidated_items) item
    order by (item ->> 'productId')::uuid
  loop
    if v_line.quantity <= 0 or v_line.quantity > 100000 or v_line.unit_cost_cents < 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
    end if;

    select p.name into v_product from public.products p where p.id = v_line.product_id;

    if exists (
      select 1 from public.purchase_items
      where purchase_id = v_purchase_id and product_id = v_line.product_id
    ) then
      update public.purchase_items
      set
        quantity = v_line.quantity,
        unit_cost_cents = v_line.unit_cost_cents,
        product_name_snapshot = v_product.name
      where purchase_id = v_purchase_id and product_id = v_line.product_id;
    else
      insert into public.purchase_items (
        purchase_id, product_id, product_name_snapshot, quantity, unit_cost_cents
      ) values (
        v_purchase_id, v_line.product_id, v_product.name, v_line.quantity, v_line.unit_cost_cents
      );
    end if;
  end loop;

  -- Recalcular costo total
  select coalesce(sum(quantity::bigint * unit_cost_cents), 0)
  into v_total
  from public.purchase_items
  where purchase_id = v_purchase_id;

  update public.purchases
  set
    supplier_name = v_supplier_name,
    expected_at = v_expected_at,
    notes = v_notes,
    total_cost_cents = v_total,
    updated_at = now()
  where id = v_purchase_id;

  perform private.bump_revision();
  return private.purchase_payload(v_purchase_id);
exception
  when invalid_text_representation or numeric_value_out_of_range or not_null_violation or check_violation then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
end;
$$;

revoke all on function private.reconcile_product_stock(uuid) from public,anon,authenticated;
revoke all on function public.receive_purchase(uuid,jsonb,uuid,bigint) from public,anon,authenticated;
grant execute on function public.receive_purchase(uuid,jsonb,uuid,bigint) to authenticated;
revoke all on function public.transition_order(uuid,text) from public,anon,authenticated;
grant execute on function public.transition_order(uuid,text) to authenticated;
revoke all on function public.resolve_opening_reservation(uuid,integer,text,uuid) from public,anon,authenticated;
grant execute on function public.resolve_opening_reservation(uuid,integer,text,uuid) to authenticated;
revoke all on function public.update_purchase(jsonb) from public,anon,authenticated;
grant execute on function public.update_purchase(jsonb) to authenticated;
commit;
