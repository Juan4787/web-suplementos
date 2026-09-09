-- Prior reservations have no known customer/order and never create sales or payments.
alter table public.stock_reservations
  add column is_opening boolean not null default false,
  alter column order_id drop not null,
  alter column order_item_id drop not null,
  add constraint reservation_origin_check check (
    (is_opening and order_id is null and order_item_id is null and purchase_item_id is not null)
    or (not is_opening and order_id is not null and order_item_id is not null)
  );

create or replace function private.validate_reservation_coherence()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_oi record; v_pi_product uuid;
begin
  if not new.is_opening then
    select order_id,product_id into v_oi from public.order_items where id=new.order_item_id;
    if not found or v_oi.order_id is distinct from new.order_id or v_oi.product_id is distinct from new.product_id then
      raise exception using errcode='P0001',message='RESERVATION_ORDER_ITEM_INCOHERENCE';
    end if;
  end if;
  if new.purchase_item_id is not null then
    select product_id into v_pi_product from public.purchase_items where id=new.purchase_item_id;
    if not found or v_pi_product is distinct from new.product_id then
      raise exception using errcode='P0001',message='RESERVATION_PURCHASE_ITEM_PRODUCT_INCOHERENCE';
    end if;
  end if;
  return new;
end;
$$;

create table private.opening_reservation_operations (
  operation_id uuid primary key,
  payload jsonb not null,
  result jsonb not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
revoke all on private.opening_reservation_operations from public,anon,authenticated;

create or replace function public.list_opening_reservations()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  perform private.require_active_user();
  select coalesce(jsonb_agg(item order by item->>'productName',item->>'purchaseNumber'),'[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'purchaseItemId',pi.id,'purchaseId',pu.id,'purchaseNumber',pu.purchase_number,
      'productId',p.id,'productName',p.name,
      'physicalQuantity',coalesce(sum(sr.quantity) filter(where sr.source_type='physical'),0),
      'incomingQuantity',coalesce(sum(sr.quantity) filter(where sr.source_type='incoming'),0),
      'uncoveredQuantity',coalesce(sum(sr.quantity) filter(where sr.source_type='uncovered'),0),
      'totalQuantity',sum(sr.quantity)
    ) item
    from public.stock_reservations sr
    join public.purchase_items pi on pi.id=sr.purchase_item_id
    join public.purchases pu on pu.id=pi.purchase_id
    join public.products p on p.id=sr.product_id
    where sr.is_opening and sr.state='active'
    group by pi.id,pu.id,p.id
  ) items;
  return v_result;
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
  perform private.bump_revision();
  v_result:=jsonb_build_object('quantity',p_quantity,'action',p_action);
  insert into private.opening_reservation_operations(operation_id,payload,result,created_by) values(p_operation_id,v_payload,v_result,auth.uid());
  return v_result;
end;
$$;
revoke all on function public.list_opening_reservations() from public,anon,authenticated;
revoke all on function public.resolve_opening_reservation(uuid,integer,text,uuid) from public,anon,authenticated;
grant execute on function public.list_opening_reservations() to authenticated;
grant execute on function public.resolve_opening_reservation(uuid,integer,text,uuid) to authenticated;

-- Use the same FIFO reception and idempotency flow for prior and new reservations.

-- Keep the legacy full-receipt entrypoint on the same reservation-aware path.
create or replace function public.receive_purchase(p_purchase_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_items jsonb;
begin
  perform private.require_owner();
  select coalesce(jsonb_agg(jsonb_build_object('purchaseItemId',id,
    'receivedQuantity',quantity-received_quantity-shortage_quantity)),'[]'::jsonb)
  into v_items from public.purchase_items where purchase_id=p_purchase_id
    and quantity>received_quantity+shortage_quantity;
  return public.receive_purchase(p_purchase_id,v_items,gen_random_uuid());
end;
$$;

create or replace function public.get_business_export_dataset()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  perform private.require_owner();
  with products_payload as (
    select coalesce(jsonb_agg(
      private.product_payload(p.id, true) || jsonb_build_object('createdAt', p.created_at)
      order by p.created_at, p.id
    ), '[]'::jsonb) as payload
    from public.products p
  ), orders_payload as (
    select coalesce(jsonb_agg(
      private.order_payload(o.id, true) || jsonb_build_object(
        'source', o.source,
        'protocolOrderId', o.protocol_order_id,
        'protocolChecksum', o.protocol_checksum,
        'refundedAt', o.refunded_at,
        'shippedAt', o.shipped_at,
        'cancelledAt', o.cancelled_at
      ) order by o.created_at, o.id
    ), '[]'::jsonb) as payload
    from public.orders o
  ), purchases_payload as (
    select coalesce(jsonb_agg(
      private.purchase_payload(p.id) || jsonb_build_object('createdAt', p.created_at)
      order by p.created_at, p.id
    ), '[]'::jsonb) as payload
    from public.purchases p
  ), movements_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'productId', m.product_id,
      'productName', m.product_name_snapshot,
      'kind', m.kind,
      'physicalDelta', m.physical_delta,
      'reservedDelta', m.reserved_delta,
      'reason', m.reason,
      'orderId', m.order_id,
      'purchaseId', m.purchase_id,
      'createdAt', m.created_at,
      'createdByName', coalesce(su.display_name, 'Usuario')
    ) order by m.created_at, m.id), '[]'::jsonb) as payload
    from public.stock_movements m
    left join public.store_users su on su.user_id = m.created_by
  ), customers_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', customer.id,
      'name', customer.name,
      'phone', customer.phone,
      'firstOrderAt', customer.first_order_at,
      'lastOrderAt', customer.last_order_at,
      'createdAt', customer.created_at,
      'orderCount', customer.order_count,
      'totalPaidCents', customer.total_paid_cents
    ) order by customer.created_at, customer.id), '[]'::jsonb) as payload
    from (
      select
        c.id,
        c.name,
        c.phone,
        c.first_order_at,
        c.last_order_at,
        c.created_at,
        count(o.id) filter (where o.order_state <> 'cancelled')::integer as order_count,
        coalesce(sum(o.total_cents) filter (where o.payment_state = 'paid'), 0)::bigint as total_paid_cents
      from public.customers c
      left join public.orders o on o.customer_id = c.id
      group by c.id
    ) customer
  ), inflation_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'period', period,
      'indexValue', index_value,
      'sourceUrl', source_url,
      'publishedAt', published_at
    ) order by period), '[]'::jsonb) as payload
    from public.inflation_indices
  ), reservations_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', reservation.id,
      'orderId', reservation.order_id,
      'orderItemId', reservation.order_item_id,
      'purchaseItemId', reservation.purchase_item_id,
      'sourceType', reservation.source_type,
      'costSnapshotCents', reservation.cost_snapshot_cents,
      'isOpening', reservation.is_opening,
      'productId', reservation.product_id,
      'quantity', reservation.quantity,
      'state', reservation.state,
      'createdAt', reservation.created_at,
      'resolvedAt', reservation.resolved_at
    ) order by reservation.created_at, reservation.id), '[]'::jsonb) as payload
    from public.stock_reservations reservation
  ), users_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', store_user.user_id,
      'displayName', store_user.display_name,
      'email', store_user.email_snapshot,
      'role', store_user.role,
      'active', store_user.active,
      'createdAt', store_user.created_at,
      'updatedAt', store_user.updated_at
    ) order by store_user.created_at, store_user.user_id), '[]'::jsonb) as payload
    from public.store_users store_user
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'revision', bs.revision,
    'settings', private.store_settings_payload(),
    'products', pp.payload,
    'inventory', private.inventory_payload(),
    'orders', op.payload,
    'purchases', pup.payload,
    'movements', mp.payload,
    'customers', cp.payload,
    'inflation', ip.payload,
    'reservations', rp.payload,
    'users', up.payload
  ) into v_result
  from public.business_state bs
  cross join products_payload pp
  cross join orders_payload op
  cross join purchases_payload pup
  cross join movements_payload mp
  cross join customers_payload cp
  cross join inflation_payload ip
  cross join reservations_payload rp
  cross join users_payload up
  where bs.singleton_id = 1;
  return v_result;
end;
$$;


CREATE OR REPLACE FUNCTION public.receive_purchase(p_purchase_id uuid, p_items jsonb, p_operation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
begin
  perform private.require_owner();

  if coalesce(jsonb_typeof(p_items), 'null') <> 'array' or jsonb_array_length(p_items) = 0 then
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
    select purchase_id, items_payload, result_payload
    into v_existing_receipt
    from public.purchase_receipts
    where operation_id = p_operation_id;

    if found then
      if v_existing_receipt.purchase_id <> p_purchase_id or v_existing_receipt.items_payload <> v_canonical_items then
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
    select purchase_id, items_payload, result_payload
    into v_existing_receipt
    from public.purchase_receipts
    where operation_id = p_operation_id;

    if found then
      if v_existing_receipt.purchase_id <> p_purchase_id or v_existing_receipt.items_payload <> v_canonical_items then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;
      return v_existing_receipt.result_payload;
    end if;
  end if;

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
    from jsonb_array_elements(v_canonical_items) elem
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
      left join public.orders o on o.id = sr.order_id
      where sr.purchase_item_id = v_pi.id and sr.state = 'active' and sr.source_type = 'incoming'
      order by sr.is_opening desc, coalesce(o.confirmed_at, sr.created_at) asc, o.order_number asc, sr.id asc
      for update of sr
    loop
      if v_to_convert <= 0 then exit; end if;

      v_take := least(v_res.quantity, v_to_convert);

      -- Fusión / creación / conversión atómica in-place
      -- Solo fusionar con reservas físicas del MISMO origen de compra para preservar trazabilidad
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
        -- CONVERSIÓN IN-PLACE ATÓMICA:
        -- Preservamos purchase_item_id intacto para trazabilidad de procedencia histórica
        update public.stock_reservations
        set source_type = 'physical'
        where id = v_res.id;
      else
        -- Split cuando la reserva es mayor que la entrega parcial recibida:
        -- Preservamos purchase_item_id del ítem de compra que abasteció la porción física
        insert into public.stock_reservations (
          order_id, order_item_id, product_id, quantity, state, source_type,
          purchase_item_id, cost_snapshot_cents, created_at, is_opening
        ) values (
          v_res.order_id, v_res.order_item_id, v_res.product_id,
          v_take, 'active', 'physical',
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
  v_res_obj := jsonb_build_object(
    'purchase', private.purchase_payload(p_purchase_id),
    'unblockedOrders', v_unblocked_orders
  );

  -- 3. ASENTAR RECIBO IDEMPOTENTE (Con payload canónico)
  if p_operation_id is not null then
    insert into public.purchase_receipts (
      operation_id, purchase_id, items_payload, result_payload, created_by
    ) values (
      p_operation_id, p_purchase_id, v_canonical_items, v_res_obj, auth.uid()
    )
    on conflict (operation_id) do nothing;
  end if;

  return v_res_obj;
end;
$function$
