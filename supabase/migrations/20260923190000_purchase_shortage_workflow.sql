-- Migration: 20260923190000_purchase_shortage_workflow.sql
-- Description: RPCs para soporte de recepción asistida de compras, diagnóstico de faltantes e impacto en reservas de clientes.

-- 1. get_purchase_impact: Consulta el impacto detallado de faltantes por ítem y lista pedidos de clientes comprometidos
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


-- 2. declare_item_shortage: Asienta faltante a nivel de ítem individual
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

revoke all on function public.declare_item_shortage(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.declare_item_shortage(uuid, integer, text) to authenticated;


-- 3. reassign_purchase_reservations: Transfiere reservas de un ítem con faltante a una nueva compra de reposición
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
