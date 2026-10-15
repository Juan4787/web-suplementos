-- Migration: 20261015190000_clean_physical_purchase_links.sql
-- Description: Asegura que toda reserva de stock convertida a física en receive_purchase
-- limpie rigurosamente el purchase_item_id a NULL, fusione con reservas físicas existentes
-- por order_item_id, y sanea las reservas físicas históricas con enlaces residuales a compras.

begin;

-- 1. Actualizar receive_purchase para garantizar purchase_item_id = null en reservas físicas
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

      -- Fusión limpia en fila física preexistente por order_item_id
      select id into v_physical_res_id
      from public.stock_reservations
      where order_item_id = v_res.order_item_id
        and is_opening = v_res.is_opening
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
        update public.stock_reservations
        set source_type = 'physical',
            purchase_item_id = null
        where id = v_res.id;
      else
        insert into public.stock_reservations (
          order_id, order_item_id, product_id, quantity, state, source_type,
          purchase_item_id, cost_snapshot_cents, created_at, is_opening
        ) values (
          v_res.order_id, v_res.order_item_id, v_res.product_id, v_take, 'active', 'physical',
          null, v_res.cost_snapshot_cents, now(), v_res.is_opening
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

revoke all on function public.receive_purchase(uuid,jsonb,uuid,bigint) from public,anon,authenticated;
grant execute on function public.receive_purchase(uuid,jsonb,uuid,bigint) to authenticated;

-- 2. Limpieza de enlaces residuales a compras en reservas físicas existentes de pedidos (is_opening = false)
update public.stock_reservations
set purchase_item_id = null
where is_opening = false
  and source_type = 'physical'
  and purchase_item_id is not null;

select private.bump_revision();

commit;
