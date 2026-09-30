-- Preserve legacy shortage behavior while matching the stock lock hierarchy.
create or replace function public.declare_item_shortage(
  p_purchase_item_id uuid,
  p_quantity integer,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pi public.purchase_items%rowtype;
  v_purchase public.purchases%rowtype;
  v_all_completed boolean := true;
begin
  perform private.require_owner();

  if p_quantity <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_QUANTITY';
  end if;

  -- Same lock hierarchy as receive_purchase and the atomic shortage operations.
  perform 1 from public.products p join public.stock_balances sb on sb.product_id=p.id
    where p.id=(select product_id from public.purchase_items where id=p_purchase_item_id) for update of p,sb;
  perform 1 from public.purchases where id=(select purchase_id from public.purchase_items where id=p_purchase_item_id) for update;

  select * into v_pi from public.purchase_items where id = p_purchase_item_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PURCHASE_ITEM_NOT_FOUND';
  end if;

  select * into v_purchase from public.purchases where id = v_pi.purchase_id for update;
  if not found or v_purchase.state <> 'ordered' then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE_STATE';
  end if;

  if (v_pi.received_quantity + v_pi.shortage_quantity + p_quantity) > v_pi.quantity then
    raise exception using errcode = 'P0001', message = 'SHORTAGE_EXCEEDS_PENDING';
  end if;

  -- 1. Marcar reservas sin cobertura que queden sin capacidad como 'uncovered'
  update public.stock_reservations
  set source_type = 'uncovered'
  where purchase_item_id = v_pi.id and state = 'active' and source_type = 'incoming';

  -- 2. Asentar shortage_quantity
  update public.purchase_items
  set shortage_quantity = shortage_quantity + p_quantity
  where id = v_pi.id;

  -- 3. Aclaraciones en la compra si se proveyeron
  if p_notes is not null and btrim(p_notes) <> '' then
    update public.purchases
    set notes = concat_ws(' | ', notes, p_notes)
    where id = v_purchase.id;
  end if;

  -- 4. Comprobar si toda la compra quedó completada
  if exists (
    select 1 from public.purchase_items
    where purchase_id = v_purchase.id
      and (received_quantity + shortage_quantity) < quantity
  ) then
    v_all_completed := false;
  end if;

  if v_all_completed then
    update public.purchases set state = 'received', received_at = coalesce(received_at, now()) where id = v_purchase.id;
  end if;

  perform private.bump_revision();
  return private.purchase_payload(v_purchase.id);
end;
$$;

-- Guard legacy callers against closing a purchase before its physical arrival is recorded.
create or replace function public.reassign_purchase_reservations(
  p_old_purchase_item_id uuid,
  p_new_purchase_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_pi public.purchase_items%rowtype;
  v_new_pi public.purchase_items%rowtype;
  v_old_purchase public.purchases%rowtype;
  v_new_purchase public.purchases%rowtype;
  v_transfer_count integer := 0;
  v_all_completed boolean := true;
begin
  perform private.require_owner();

  if p_new_purchase_id = (select purchase_id from public.purchase_items where id=p_old_purchase_item_id) then
    raise exception using errcode='P0001', message='INVALID_TARGET_PURCHASE';
  end if;
  perform 1 from public.products p join public.stock_balances sb on sb.product_id=p.id
    where p.id in (select product_id from public.purchase_items where id=p_old_purchase_item_id or purchase_id=p_new_purchase_id)
    order by p.id for update of p,sb;
  perform 1 from public.purchases where id in (p_new_purchase_id,(select purchase_id from public.purchase_items where id=p_old_purchase_item_id))
    order by id for update;
  select * into v_old_pi from public.purchase_items where id = p_old_purchase_item_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PURCHASE_ITEM_NOT_FOUND';
  end if;

  select * into v_old_purchase from public.purchases where id = v_old_pi.purchase_id for update;
  select * into v_new_purchase from public.purchases where id = p_new_purchase_id for update;
  if not found or v_new_purchase.state <> 'ordered' then
    raise exception using errcode = 'P0001', message = 'INVALID_TARGET_PURCHASE';
  end if;

  -- Buscar el ítem en la nueva compra que coincida con el mismo producto
  select * into v_new_pi
  from public.purchase_items
  where purchase_id = p_new_purchase_id and product_id = v_old_pi.product_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'TARGET_PURCHASE_MISSING_PRODUCT';
  end if;

  if v_old_pi.received_quantity + v_old_pi.shortage_quantity < v_old_pi.quantity then
    raise exception using errcode='P0001',message='PURCHASE_RECEIPT_REQUIRED';
  end if;
  if v_new_pi.quantity - v_new_pi.received_quantity - v_new_pi.shortage_quantity < (
    select coalesce(sum(quantity),0) from public.stock_reservations
    where purchase_item_id in (v_old_pi.id,v_new_pi.id) and state='active' and source_type in ('incoming','uncovered')
  ) then
    raise exception using errcode='P0001',message='INSUFFICIENT_TARGET_CAPACITY';
  end if;

  -- Reasignar las reservas activas (incoming o uncovered) al nuevo ítem de compra
  update public.stock_reservations
  set purchase_item_id = v_new_pi.id,
      source_type = 'incoming'
  where purchase_item_id = v_old_pi.id
    and state = 'active'
    and source_type in ('incoming', 'uncovered');

  get diagnostics v_transfer_count = row_count;

  -- Asentar faltante definitivo en el ítem viejo por las unidades que no se recibieron
  if (v_old_pi.received_quantity + v_old_pi.shortage_quantity) < v_old_pi.quantity then
    update public.purchase_items
    set shortage_quantity = quantity - received_quantity
    where id = v_old_pi.id;
  end if;

  -- Verificar si la compra vieja quedó completada
  if exists (
    select 1 from public.purchase_items
    where purchase_id = v_old_purchase.id
      and (received_quantity + shortage_quantity) < quantity
  ) then
    v_all_completed := false;
  end if;

  if v_all_completed then
    update public.purchases set state = 'received', received_at = coalesce(received_at, now()) where id = v_old_purchase.id;
  end if;

  perform private.bump_revision();
  return jsonb_build_object(
    'oldPurchase', private.purchase_payload(v_old_purchase.id),
    'newPurchase', private.purchase_payload(v_new_purchase.id),
    'transferredReservations', v_transfer_count
  );
end;
$$;

revoke all on function public.reassign_purchase_reservations(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reassign_purchase_reservations(uuid, uuid) to authenticated;
-- Idempotency is private. No client can write or remove operation receipts directly.
create table if not exists private.purchase_shortage_operations (
  operation_id uuid primary key,
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
revoke all on private.purchase_shortage_operations from public, anon, authenticated;

create or replace function public.replace_purchase_shortage(
  p_purchase_item_id uuid, p_expected_pending integer, p_supplier_name text,
  p_expected_at timestamptz, p_operation_id uuid
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_pi public.purchase_items%rowtype;
  v_request jsonb;
  v_previous private.purchase_shortage_operations%rowtype;
  v_new jsonb;
  v_result jsonb;
begin
  perform private.require_owner();
  if p_operation_id is null or p_expected_pending is null or p_expected_pending <= 0
    or coalesce(char_length(btrim(p_supplier_name)),0) not between 2 and 120 then
    raise exception using errcode='P0001',message='INVALID_INPUT';
  end if;
  v_request:=jsonb_build_object('kind','replacement','item',p_purchase_item_id,'pending',p_expected_pending,
    'supplier',btrim(p_supplier_name),'expectedAt',p_expected_at);
  perform pg_advisory_xact_lock(hashtextextended('purchase-shortage:'||p_operation_id::text,0));
  select * into v_previous from private.purchase_shortage_operations where operation_id=p_operation_id;
  if found then
    if v_previous.request<>v_request then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSE_MISMATCH'; end if;
    return v_previous.result;
  end if;
  perform 1 from public.products p join public.stock_balances sb on sb.product_id=p.id
    where p.id=(select product_id from public.purchase_items where id=p_purchase_item_id) for update of p,sb;
  perform 1 from public.purchases where id=(select purchase_id from public.purchase_items where id=p_purchase_item_id) for update;
  select * into v_pi from public.purchase_items where id=p_purchase_item_id for update;
  if not found then raise exception using errcode='P0001',message='PURCHASE_ITEM_NOT_FOUND'; end if;
  if v_pi.quantity-v_pi.received_quantity-v_pi.shortage_quantity<>p_expected_pending then
    raise exception using errcode='P0001',message='PURCHASE_SHORTAGE_CHANGED';
  end if;
  v_new:=public.create_purchase(jsonb_build_object('supplierName',btrim(p_supplier_name),'expectedAt',p_expected_at,
    'notes','Reposición de compra #'||(select purchase_number::text from public.purchases where id=v_pi.purchase_id),
    'items',jsonb_build_array(jsonb_build_object('productId',v_pi.product_id,'quantity',p_expected_pending,'unitCostCents',v_pi.unit_cost_cents))));
  perform public.declare_item_shortage(v_pi.id,p_expected_pending,'Faltante definitivo con reposición');
  v_result:=public.reassign_purchase_reservations(v_pi.id,(v_new->>'id')::uuid);
  insert into private.purchase_shortage_operations(operation_id,request,result,created_by)
    values(p_operation_id,v_request,v_result,auth.uid());
  return v_result;
end;
$$;
revoke all on function public.replace_purchase_shortage(uuid,integer,text,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.replace_purchase_shortage(uuid,integer,text,timestamptz,uuid) to authenticated;

create or replace function public.declare_purchase_shortages(p_purchase_id uuid,p_items jsonb,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_request jsonb; v_previous private.purchase_shortage_operations%rowtype; v_item record; v_pi public.purchase_items%rowtype; v_result jsonb;
begin
  perform private.require_owner();
  if p_operation_id is null or coalesce(jsonb_typeof(p_items),'')<>'array' then
    raise exception using errcode='P0001',message='INVALID_INPUT';
  end if;
  if jsonb_array_length(p_items)=0 or exists(select 1 from jsonb_array_elements(p_items) e
    where (e->>'quantity' ~ '^[1-9][0-9]*$') is not true or (e->>'purchaseItemId') is null)
    or (select count(*)<>count(distinct e->>'purchaseItemId') from jsonb_array_elements(p_items) e) then
    raise exception using errcode='P0001',message='INVALID_INPUT';
  end if;
  select jsonb_build_object('kind','shortages','purchase',p_purchase_id,'items',jsonb_agg(e order by e->>'purchaseItemId'))
    into v_request from jsonb_array_elements(p_items) e;
  perform pg_advisory_xact_lock(hashtextextended('purchase-shortage:'||p_operation_id::text,0));
  select * into v_previous from private.purchase_shortage_operations where operation_id=p_operation_id;
  if found then
    if v_previous.request<>v_request then raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSE_MISMATCH'; end if;
    return v_previous.result;
  end if;
  perform 1 from public.products p join public.stock_balances sb on sb.product_id=p.id
    where p.id in(select product_id from public.purchase_items where purchase_id=p_purchase_id)
    order by p.id for update of p,sb;
  perform 1 from public.purchases where id=p_purchase_id for update;
  for v_item in select (e->>'purchaseItemId')::uuid as id,(e->>'quantity')::integer as quantity
    from jsonb_array_elements(p_items) e order by e->>'purchaseItemId'
  loop
    select * into v_pi from public.purchase_items where id=v_item.id and purchase_id=p_purchase_id for update;
    if not found then raise exception using errcode='P0001',message='PURCHASE_ITEM_NOT_FOUND'; end if;
    if v_pi.quantity-v_pi.received_quantity-v_pi.shortage_quantity<>v_item.quantity then
      raise exception using errcode='P0001',message='PURCHASE_SHORTAGE_CHANGED';
    end if;
    if exists(select 1 from public.stock_reservations where purchase_item_id=v_pi.id and state='active'
      and source_type in ('incoming','uncovered')) then
      raise exception using errcode='P0001',message='PURCHASE_SHORTAGE_UNRESOLVED';
    end if;
    perform public.declare_item_shortage(v_pi.id,v_item.quantity,'Faltante definitivo informado por el distribuidor');
  end loop;
  v_result:=private.purchase_payload(p_purchase_id);
  insert into private.purchase_shortage_operations(operation_id,request,result,created_by)
    values(p_operation_id,v_request,v_result,auth.uid());
  return v_result;
end;
$$;
revoke all on function public.declare_purchase_shortages(uuid,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.declare_purchase_shortages(uuid,jsonb,uuid) to authenticated;

-- Impact after recording arrival excludes opening units that are already physical.
create or replace function public.get_purchase_impact(p_purchase_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_res jsonb;
begin
  perform private.require_owner();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'purchaseItemId', pi.id,
        'productId', pi.product_id,
        'productName', pi.product_name_snapshot,
        'totalQuantity', pi.quantity,
        'receivedQuantity', pi.received_quantity,
        'shortageQuantity', pi.shortage_quantity,
        'pendingQuantity', greatest(0, pi.quantity - pi.received_quantity - pi.shortage_quantity),
        'reservedOrders', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'orderId', o.id,
              'orderNumber', o.order_number,
              'customerName', o.customer_name_snapshot,
              'customerPhone', o.customer_phone_snapshot,
              'reservedQuantity', sr.quantity,
              'paymentState', o.payment_state,
              'fulfillmentState', o.fulfillment_state,
              'totalCents', o.total_cents
            ) order by o.created_at, o.order_number
          )
          from public.stock_reservations sr
          join public.orders o on o.id = sr.order_id
          where sr.purchase_item_id = pi.id
            and sr.state = 'active'
            and sr.source_type in ('incoming', 'uncovered')
            and o.order_state <> 'cancelled'
        ), '[]'::jsonb),
        'openingReservationsQuantity', coalesce((
          select sum(sr.quantity)::integer
          from public.stock_reservations sr
          where sr.purchase_item_id = pi.id
            and sr.state = 'active'
            and sr.is_opening = true
            and sr.source_type in ('incoming','uncovered')
        ), 0)
      ) order by pi.created_at, pi.id
    ),
    '[]'::jsonb
  )
  into v_res
  from public.purchase_items pi
  where pi.purchase_id = p_purchase_id;

  return v_res;
end;
$$;

revoke all on function public.get_purchase_impact(uuid) from public, anon, authenticated;
grant execute on function public.get_purchase_impact(uuid) to authenticated;
