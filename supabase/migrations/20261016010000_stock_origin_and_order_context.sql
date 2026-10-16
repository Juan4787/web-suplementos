-- Keep explicit incoming-only promises, normal FIFO, receipt budgets and historical costs.
begin;

create or replace function private.allocate_product_stock(p_product_id uuid, p_received_item_id uuid, p_received_quantity integer)
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
  v_arrived_remaining integer := greatest(0, p_received_quantity);
  v_previous_free integer;
  v_previous_used integer;
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

  v_arrived_remaining := least(v_arrived_remaining, v_avail);
  v_previous_free := v_avail - v_arrived_remaining;

  -- 2. Recorrer reservas 'incoming' o 'uncovered' por antigüedad estricta (FIFO)
  for v_res in
    select sr.id, sr.order_id, sr.order_item_id, sr.quantity, sr.cost_snapshot_cents,
           sr.is_opening, sr.purchase_item_id, o.order_number, o.created_by as order_created_by,
           coalesce(o.stock_source, 'normal') as stock_source
    from public.stock_reservations sr
    left join public.orders o on o.id = sr.order_id
    where sr.product_id = p_product_id
      and sr.state = 'active'
      and sr.source_type in ('incoming', 'uncovered')
      and (sr.is_opening or (o.order_state = 'confirmed' and o.fulfillment_state = 'pending'
        and (o.stock_source = 'normal' or (o.stock_source = 'incoming_only'
          and ((sr.source_type = 'incoming' and sr.purchase_item_id = p_received_item_id)
            or (sr.source_type='uncovered' and p_received_item_id is not null))))))
    order by sr.is_opening desc, coalesce(o.confirmed_at, o.created_at, sr.created_at) asc, o.order_number asc, sr.id asc
    for update of sr
  loop
    if v_avail <= 0 then exit; end if;

    if not v_res.is_opening and v_res.stock_source = 'incoming_only' then
      v_take := least(v_res.quantity, v_avail, v_arrived_remaining);
      v_arrived_remaining := v_arrived_remaining - v_take;
    else
      v_take := least(v_res.quantity, v_avail);
      -- Normal sales use already-free stock before consuming this receipt budget.
      v_previous_used := least(v_previous_free, v_take);
      v_previous_free := v_previous_free - v_previous_used;
      v_arrived_remaining := v_arrived_remaining - (v_take - v_previous_used);
    end if;
    if v_take <= 0 then continue; end if;
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

revoke all on function private.allocate_product_stock(uuid,uuid,integer) from public,anon,authenticated;

create or replace function private.reconcile_product_stock(p_product_id uuid)
returns uuid[] language sql security definer set search_path=public,pg_temp as $$
  select private.allocate_product_stock(p_product_id,null,0);
$$;
revoke all on function private.reconcile_product_stock(uuid) from public,anon,authenticated;

-- Global normal-order FIFO can consume a receipt for an order linked elsewhere.
-- Move only the excess pending promises, never existing physical reservations.
create or replace function private.rebind_receipt_pending(p_received_item_id uuid)
returns uuid[] language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_product uuid;
  v_capacity integer;
  v_excess integer;
  v_left integer;
  v_take integer;
  v_source record;
  v_target record;
  v_affected uuid[]:=array[]::uuid[];
begin
  select product_id,greatest(0,quantity-received_quantity-shortage_quantity)
    into v_product,v_capacity from public.purchase_items where id=p_received_item_id;
  -- The caller already holds these locks; retain the canonical contract internally.
  perform 1 from public.products p join public.stock_balances sb on sb.product_id=p.id
    where p.id=v_product for update of p,sb;
  select greatest(0,coalesce(sum(quantity),0)-v_capacity)::integer into v_excess
    from public.stock_reservations where purchase_item_id=p_received_item_id
      and state='active' and source_type='incoming';
  if v_excess=0 then return v_affected; end if;
  -- Keep earlier promises on their original purchase. Move younger pending units.
  for v_source in
    select sr.*,o.confirmed_at,o.created_at as order_created_at,o.order_number
    from public.stock_reservations sr left join public.orders o on o.id=sr.order_id
    where sr.purchase_item_id=p_received_item_id and sr.state='active' and sr.source_type='incoming'
    order by sr.is_opening asc,coalesce(o.confirmed_at,o.created_at,sr.created_at) desc,o.order_number desc,sr.id desc
    for update of sr
  loop
    exit when v_excess=0;
    -- Opening reservations have first allocation priority and keep their origin.
    if v_source.is_opening then raise exception 'OPENING_RECEIPT_ALLOCATION_MISMATCH'; end if;
    v_left:=least(v_source.quantity,v_excess);
    update public.stock_reservations set quantity=quantity-v_left where id=v_source.id and quantity>v_left;
    if v_source.quantity=v_left then delete from public.stock_reservations where id=v_source.id; end if;
    v_excess:=v_excess-v_left;
    for v_target in
      select pi.id,greatest(0,pi.quantity-pi.received_quantity-pi.shortage_quantity-
        coalesce((select sum(sr.quantity) from public.stock_reservations sr where sr.purchase_item_id=pi.id
          and sr.state='active' and sr.source_type='incoming'),0))::integer capacity
      from public.purchase_items pi join public.purchases p on p.id=pi.purchase_id
      where pi.product_id=v_product and pi.id<>p_received_item_id and p.state='ordered'
      order by p.expected_at asc nulls last,p.purchase_number,pi.id
    loop
      exit when v_left=0;
      v_take:=least(v_left,v_target.capacity);
      if v_take=0 then continue; end if;
      insert into public.stock_reservations(order_id,order_item_id,product_id,quantity,state,source_type,
        purchase_item_id,cost_snapshot_cents,is_opening,created_at)
      values(v_source.order_id,v_source.order_item_id,v_product,v_take,'active','incoming',
        v_target.id,v_source.cost_snapshot_cents,false,v_source.created_at);
      v_left:=v_left-v_take;
    end loop;
    if v_left>0 then
      -- An older uncovered sale may consume this arrival. Do not invent a supplier.
      insert into public.stock_reservations(order_id,order_item_id,product_id,quantity,state,source_type,
        purchase_item_id,cost_snapshot_cents,is_opening,created_at)
      values(v_source.order_id,v_source.order_item_id,v_product,v_left,'active','uncovered',
        p_received_item_id,v_source.cost_snapshot_cents,false,v_source.created_at);
    end if;
    if not(v_source.order_id=any(v_affected)) then v_affected:=array_append(v_affected,v_source.order_id); end if;
  end loop;
  if v_excess<>0 then raise exception 'RECEIPT_ALLOCATION_MISMATCH'; end if;
  return v_affected;
end;
$$;
revoke all on function private.rebind_receipt_pending(uuid) from public,anon,authenticated;

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
  v_reassigned_ids uuid[]:=array[]::uuid[];
  v_reassigned_orders jsonb:='[]'::jsonb;
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
    v_reconciled_orders := private.allocate_product_stock(v_pi.product_id, v_pi.id, v_qty_received);
    if cardinality(v_reconciled_orders) > 0 then
      v_affected_order_ids := array_cat(v_affected_order_ids, v_reconciled_orders);
    end if;
    v_reassigned_ids:=array_cat(v_reassigned_ids,private.rebind_receipt_pending(v_pi.id));
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

  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'number',o.order_number,
    'incomingQuantity',(select coalesce(sum(quantity),0) from public.stock_reservations where order_id=o.id and state='active' and source_type='incoming'),
    'uncoveredQuantity',(select coalesce(sum(quantity),0) from public.stock_reservations where order_id=o.id and state='active' and source_type='uncovered')) order by o.order_number),'[]'::jsonb)
  into v_reassigned_orders from public.orders o where o.id=any(v_reassigned_ids);
  perform private.bump_revision();
  v_res_obj := jsonb_build_object(
    'purchase', private.purchase_payload(p_purchase_id),
    'unblockedOrders', v_unblocked_orders,
    'reassignedOrders',v_reassigned_orders
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

-- A single stable snapshot explains allocation without exposing costs or changing stock.
create or replace function public.get_order_stock_context(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  perform private.require_active_user();
  if not exists(select 1 from public.orders where id=p_order_id) then
    raise exception using errcode='P0001',message='ORDER_NOT_FOUND';
  end if;
  return (
    select jsonb_build_object('orderId',o.id,'orderState',o.order_state,'fulfillmentState',o.fulfillment_state,
      'stockSource',o.stock_source,'actionRevision',o.action_revision,'packingRevision',o.packing_revision,
      'checkedAt',statement_timestamp(),'items',coalesce((
        select jsonb_agg(jsonb_build_object(
          'orderItemId',oi.id,'productId',oi.product_id,'quantity',oi.quantity,
          'onHand',sb.on_hand,'reserved',sb.reserved,'available',greatest(0,sb.on_hand-sb.reserved),
          'physicalQuantity',coalesce(r.physical,0),'incomingQuantity',coalesce(r.incoming,0),
          'uncoveredQuantity',coalesce(r.uncovered,0),
          'otherReservedQuantity',greatest(0,sb.reserved-coalesce((select sum(sr.quantity) from public.stock_reservations sr
            where sr.product_id=oi.product_id and sr.order_id=o.id and sr.state='active' and sr.source_type='physical'),0)),
          'openingReservedQuantity',coalesce((select sum(sr.quantity) from public.stock_reservations sr
            where sr.product_id=oi.product_id and sr.is_opening and sr.state='active' and sr.source_type='physical'),0),
          'reservations',public.list_product_reservations(oi.product_id),
          'purchases',coalesce((select jsonb_agg(to_jsonb(x) order by x."number") from (
            select p.id,p.purchase_number as "number",p.expected_at as "expectedAt",p.state,
              sum(sr.quantity)::integer as "reservedQuantity",
              pi.quantity as "orderedQuantity",pi.received_quantity as "receivedQuantity",pi.shortage_quantity as "shortageQuantity"
            from public.stock_reservations sr join public.purchase_items pi on pi.id=sr.purchase_item_id
            join public.purchases p on p.id=pi.purchase_id
            where sr.order_item_id=oi.id and sr.state='active' and sr.source_type in ('incoming','uncovered')
            group by p.id,pi.id
          ) x),'[]'::jsonb)
        ) order by oi.created_at,oi.id)
        from public.order_items oi join public.stock_balances sb on sb.product_id=oi.product_id
        left join lateral(select
          sum(sr.quantity) filter(where sr.source_type='physical')::integer physical,
          sum(sr.quantity) filter(where sr.source_type='incoming')::integer incoming,
          sum(sr.quantity) filter(where sr.source_type='uncovered')::integer uncovered
          from public.stock_reservations sr where sr.order_item_id=oi.id and sr.state='active') r on true
        where oi.order_id=o.id
      ),'[]'::jsonb)) from public.orders o where o.id=p_order_id
  );
end;
$$;
revoke all on function public.get_order_stock_context(uuid) from public,anon,authenticated;
grant execute on function public.get_order_stock_context(uuid) to authenticated;

create or replace function public.get_purchase(p_purchase_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  perform private.require_owner();
  v_result:=private.purchase_payload(p_purchase_id);
  if v_result is null then raise exception using errcode='P0001',message='PURCHASE_NOT_FOUND'; end if;
  return v_result;
end;
$$;
revoke all on function public.get_purchase(uuid) from public,anon,authenticated;
grant execute on function public.get_purchase(uuid) to authenticated;
commit;
