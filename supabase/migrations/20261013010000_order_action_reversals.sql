-- Corrections are explicit, atomic, audited and safe to retry. Sales snapshots
-- stay attached to the order; compensating stock movements preserve history.
alter table public.orders add column action_revision bigint not null default 0 check (action_revision >= 0);

create or replace function private.bump_order_action_revision()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.action_revision := old.action_revision + 1;
  return new;
end;
$$;
create trigger bump_order_action_revision before update on public.orders
for each row execute function private.bump_order_action_revision();
revoke all on function private.bump_order_action_revision() from public, anon, authenticated;

create table public.order_action_reversals (
  operation_id uuid primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  action text not null check (action in ('reverse_payment','reverse_delivery','reverse_shipment')),
  expected_revision bigint not null,
  previous_payload jsonb not null,
  current_payload jsonb not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index order_action_reversals_order_idx on public.order_action_reversals(order_id, created_at);
alter table public.order_action_reversals enable row level security;
create policy order_action_reversals_owner_read on public.order_action_reversals
for select to authenticated using (private.is_owner());
revoke all on public.order_action_reversals from public, anon, authenticated;
grant select on public.order_action_reversals to authenticated;

create or replace function public.reverse_order_action(
  p_order_id uuid, p_action text, p_operation_id uuid, p_expected_revision bigint
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order public.orders%rowtype;
  v_event public.order_action_reversals%rowtype;
  v_item record;
  v_before jsonb;
  v_after jsonb;
  v_returns_stock boolean;
begin
  perform private.require_active_user();
  if p_operation_id is null or p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = 'P0001', message = 'ORDER_REVERSAL_CONFIRMATION_REQUIRED';
  end if;
  if p_action is null or p_action not in ('reverse_payment','reverse_delivery','reverse_shipment') then
    raise exception using errcode = 'P0001', message = 'INVALID_ACTION';
  end if;
  -- Serialize identical operation keys even if mistakenly used across orders.
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 131013));
  -- Same hierarchy as confirmation, receipt and transition_order: products /
  -- balances, order, then reservations. Never lock an order before its stock.
  perform 1 from public.products p
    join public.order_items oi on oi.product_id = p.id
    join public.stock_balances sb on sb.product_id = p.id
    where oi.order_id = p_order_id order by p.id for update of p, sb;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;

  -- Replays return current role-filtered state, never an old financial payload.
  select * into v_event from public.order_action_reversals where operation_id = p_operation_id;
  if found then
    if v_event.order_id <> p_order_id or v_event.action <> p_action or v_event.expected_revision <> p_expected_revision then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
    end if;
    return private.order_payload(p_order_id, private.is_owner());
  end if;
  if v_order.action_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'ORDER_ACTION_CHANGED';
  end if;
  if v_order.order_state <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
  end if;
  v_before := private.order_payload(p_order_id, true);
  if p_action = 'reverse_payment' then
    if v_order.payment_state <> 'paid' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders set payment_state = 'pending', paid_at = null, refunded_at = null where id = p_order_id;
  else
    if (p_action = 'reverse_delivery' and v_order.fulfillment_state <> 'delivered')
      or (p_action = 'reverse_shipment' and v_order.fulfillment_state <> 'shipped') then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    v_returns_stock := p_action = 'reverse_shipment' or v_order.shipped_at is null;
    if v_returns_stock then
      -- Refuse ambiguous legacy/inconsistent reservations rather than invent
      -- quantities or accidentally return the same physical units twice.
      if not exists(select 1 from public.order_items where order_id = p_order_id)
        or exists(select 1 from public.stock_reservations where order_id = p_order_id and state = 'active')
        or exists(
          select 1 from public.order_items oi left join public.stock_balances sb on sb.product_id = oi.product_id
          where oi.order_id = p_order_id and (sb.product_id is null or oi.quantity <> (
            select coalesce(sum(sr.quantity), 0) from public.stock_reservations sr
            where sr.order_item_id = oi.id and sr.order_id = p_order_id
              and sr.product_id = oi.product_id and sr.state = 'consumed' and sr.source_type = 'physical'
          ))
        ) then
        raise exception using errcode = 'P0001', message = 'ORDER_REVERSAL_RESERVATIONS_MISMATCH';
      end if;
      for v_item in select * from public.order_items where order_id = p_order_id order by product_id loop
        update public.stock_balances set on_hand = on_hand + v_item.quantity, reserved = reserved + v_item.quantity
        where product_id = v_item.product_id;
        update public.stock_reservations set state = 'active', resolved_at = null
        where order_item_id = v_item.id and order_id = p_order_id and state = 'consumed' and source_type = 'physical';
        insert into public.stock_movements(product_id,product_name_snapshot,kind,physical_delta,reserved_delta,reason,order_id,created_by)
        values(v_item.product_id,v_item.product_name_snapshot,'return',v_item.quantity,v_item.quantity,
          case when p_action = 'reverse_shipment' then 'Envío deshecho; mercadería de regreso y reservada'
            else 'Entrega deshecha; mercadería de regreso y reservada' end, p_order_id, auth.uid());
      end loop;
    end if;
    update public.orders set
      fulfillment_state = case when v_returns_stock then 'pending'::public.fulfillment_state else 'shipped'::public.fulfillment_state end,
      fulfilled_at = null,
      shipped_at = case when v_returns_stock then null else shipped_at end
    where id = p_order_id;
  end if;
  v_after := private.order_payload(p_order_id, true);
  insert into public.order_action_reversals(operation_id,order_id,action,expected_revision,previous_payload,current_payload,created_by)
  values(p_operation_id,p_order_id,p_action,p_expected_revision,v_before,v_after,auth.uid());
  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;
revoke all on function public.reverse_order_action(uuid,text,uuid,bigint) from public, anon, authenticated;
grant execute on function public.reverse_order_action(uuid,text,uuid,bigint) to authenticated;

create or replace function private.order_payload(p_order_id uuid, p_include_financials boolean)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', o.id,
    'number', o.order_number,
    'customerId', o.customer_id,
    'customerName', o.customer_name_snapshot,
    'customerFirstName', o.customer_first_name_snapshot,
    'customerLastName', o.customer_last_name_snapshot,
    'customerPhone', o.customer_phone_snapshot,
    'paymentMethod', o.payment_method,
    'deliveryMethod', o.delivery_method,
    'shippingType', o.shipping_type,
    'shippingAddress', o.shipping_address,
    'orderState', o.order_state,
    'paymentState', o.payment_state,
    'preparationState', o.preparation_state,
    'fulfillmentState', o.fulfillment_state,
    'saleType', coalesce(o.sale_type, 'retail'),
    'isCostSale', (coalesce(o.sale_type, 'retail') = 'cost'),
    'actionRevision', o.action_revision,
    'shippedAt', o.shipped_at,
    'packingRevision', o.packing_revision,
    'packingTracked', coalesce((
      select bool_and(oi.packed_quantity is not null)
      from public.order_items oi where oi.order_id = o.id
    ), false),
    'stockReadiness', case
      when exists (
        select 1 from public.stock_reservations sr
        where sr.order_id = o.id and sr.state = 'active' and sr.source_type = 'uncovered'
      ) then 'uncovered'
      when exists (
        select 1 from public.stock_reservations sr
        where sr.order_id = o.id and sr.state = 'active' and sr.source_type = 'incoming'
      ) then 'waiting_incoming'
      else 'ready'
    end,
    'expectedArrivalAt', (
      select max(pu.expected_at)
      from public.stock_reservations sr
      join public.purchase_items pi on pi.id = sr.purchase_item_id
      join public.purchases pu on pu.id = pi.purchase_id
      where sr.order_id = o.id and sr.state = 'active' and sr.source_type = 'incoming'
    ),
    'subtotalCents', o.subtotal_cents,
    'shippingFeeCents', o.shipping_fee_cents,
    'stockSource', o.stock_source,
    'shippingFeeMethod', case when p_include_financials then o.shipping_fee_method else null end,
    'shippingFeeBasisPoints', case when p_include_financials then o.shipping_fee_basis_points else null end,
    'shippingFeeCostBaseCents', case when p_include_financials then o.shipping_fee_cost_base_cents else null end,
    'shippingFeeRevision', o.shipping_fee_revision,
    'shippingFeeNeedsReview', o.payment_state = 'pending' and o.shipping_fee_method = 'percentage'
      and coalesce(o.shipping_fee_basis_points,0) > 0 and o.shipping_fee_cost_base_cents is distinct from o.cost_total_cents,
    'totalCents', o.total_cents,
    'taxRateBasisPoints', case when p_include_financials then o.tax_rate_basis_points else null end,
    'taxAmountCents', case when p_include_financials then o.tax_amount_cents else null end,
    'costTotalCents', case when p_include_financials then o.cost_total_cents else null end,
    'createdAt', o.created_at,
    'confirmedAt', o.confirmed_at,
    'paidAt', o.paid_at,
    'fulfilledAt', o.fulfilled_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', oi.id,
        'productId', oi.product_id,
        'sku', oi.sku_snapshot,
        'productName', oi.product_name_snapshot,
        'presentation', oi.presentation_snapshot,
        'quantity', oi.quantity,
        'packedQuantity', oi.packed_quantity,
        'physicalReservedQuantity', coalesce((select sum(sr.quantity) from public.stock_reservations sr where sr.order_item_id = oi.id and sr.state = 'active' and sr.source_type = 'physical'), 0),
        'incomingQuantity', coalesce((select sum(sr.quantity) from public.stock_reservations sr where sr.order_item_id = oi.id and sr.state = 'active' and sr.source_type = 'incoming'), 0),
        'uncoveredQuantity', coalesce((select sum(sr.quantity) from public.stock_reservations sr where sr.order_item_id = oi.id and sr.state = 'active' and sr.source_type = 'uncovered'), 0),
        'unitPriceCents', oi.unit_price_cents,
        'unitCostCents', case when p_include_financials then oi.unit_cost_cents else null end,
        'costTotalCents', case when p_include_financials then oi.cost_total_cents else null end,
        'subtotalCents', case when o.sale_type = 'cost' then oi.cost_total_cents when o.sale_type = 'gift' then 0 else oi.line_subtotal_cents end
      ) order by oi.created_at, oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  ) from public.orders o where o.id = p_order_id;
$$;


-- Existing forward transitions retain their pricing, packing and stock rules.
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

  else
    raise exception using errcode = 'P0001', message = 'INVALID_ACTION';
  end if;

  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;


-- Forecasting uses effective exits, while the stock ledger remains intact.
create or replace function private.inventory_payload()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with effective_sales as (
    -- A corrected/re-delivered order is one current sale, not several exits.
    -- Unlinked legacy movements keep their independent identity.
    select distinct on (m.product_id, coalesce(m.order_id, m.id))
      m.product_id, m.physical_delta, m.created_at
    from public.stock_movements m left join public.orders o on o.id = m.order_id
    where m.kind = 'sale' and (m.order_id is null or (
      o.order_state = 'confirmed' and o.fulfillment_state in ('shipped','delivered')
      and o.payment_state <> 'gifted' and o.sale_type <> 'gift'
    ))
    order by m.product_id, coalesce(m.order_id, m.id), m.created_at desc, m.id desc
  ), movement_sales as (
    select product_id, coalesce(sum(-physical_delta) filter (
      where created_at >= now() - interval '30 days'
    ), 0)::numeric / 30 as average_daily_sales
    from effective_sales group by product_id
  ), incoming as (
    select pi.product_id, coalesce(sum(pi.quantity - pi.received_quantity - pi.shortage_quantity), 0)::integer as quantity
    from public.purchase_items pi
    join public.purchases p on p.id = pi.purchase_id and p.state = 'ordered'
    group by pi.product_id
  ), inventory as (
    select p.*, coalesce(s.on_hand, 0) as on_hand, coalesce(s.reserved, 0) as reserved,
      coalesce(i.quantity, 0) as incoming,
      c.available_incoming as incoming_available,
      greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) as available,
      coalesce(ms.average_daily_sales, 0) as average_daily_sales,
      coalesce(img.public_url, '/product-placeholder.svg') as image_url
    from public.products p
    left join public.stock_balances s on s.product_id = p.id
    left join movement_sales ms on ms.product_id = p.id
    left join incoming i on i.product_id = p.id
    cross join lateral private.product_incoming_capacity(p.id) c
    left join lateral (
      select public_url from public.product_images
      where product_id = p.id order by position, created_at limit 1
    ) img on true
    where p.active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'sku', sku, 'name', name, 'presentation', presentation, 'imageUrl', image_url,
    'onHand', on_hand, 'reserved', reserved, 'available', available,
    'incoming', incoming, 'incomingReserved', incoming - incoming_available,
    'projected', available + incoming_available,
    'reorderPoint', reorder_point, 'safetyStock', safety_stock, 'leadTimeDays', lead_time_days,
    'averageDailySales', round(average_daily_sales, 2),
    'coverageDays', case when average_daily_sales > 0 then round(available / average_daily_sales, 1) else null end,
    'suggestedPurchase', greatest(ceil(average_daily_sales * lead_time_days + safety_stock)::integer - available - incoming_available, 0),
    'status', case when available <= 0 then 'out' when available <= safety_stock then 'critical' when available <= reorder_point then 'low' else 'ok' end
  ) order by case when available <= 0 then 0 when available <= safety_stock then 1 when available <= reorder_point then 2 else 3 end, name), '[]'::jsonb)
  from inventory;
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
      private.product_payload(product.id, true) || jsonb_build_object('createdAt', product.created_at)
      order by product.created_at, product.id
    ), '[]'::jsonb) as payload
    from public.products product
  ), orders_payload as (
    select coalesce(jsonb_agg(
      private.order_payload(orders.id, true) || jsonb_build_object(
        'source', orders.source,
        'protocolOrderId', orders.protocol_order_id,
        'protocolChecksum', orders.protocol_checksum,
        'refundedAt', orders.refunded_at,
        'shippedAt', orders.shipped_at,
        'cancelledAt', orders.cancelled_at
      ) order by orders.created_at, orders.id
    ), '[]'::jsonb) as payload
    from public.orders
  ), purchases_payload as (
    select coalesce(jsonb_agg(
      private.purchase_payload(purchase.id) || jsonb_build_object('createdAt', purchase.created_at)
      order by purchase.created_at, purchase.id
    ), '[]'::jsonb) as payload
    from public.purchases purchase
  ), movements_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', movement.id,
      'productId', movement.product_id,
      'productName', movement.product_name_snapshot,
      'kind', movement.kind,
      'physicalDelta', movement.physical_delta,
      'reservedDelta', movement.reserved_delta,
      'reason', movement.reason,
      'orderId', movement.order_id,
      'purchaseId', movement.purchase_id,
      'createdAt', movement.created_at,
      'createdByName', coalesce(store_user.display_name, 'Usuario')
    ) order by movement.created_at, movement.id), '[]'::jsonb) as payload
    from public.stock_movements movement
    left join public.store_users store_user on store_user.user_id = movement.created_by
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
        customers.id,
        customers.name,
        customers.phone,
        customers.first_order_at,
        customers.last_order_at,
        customers.created_at,
        count(orders.id) filter (where orders.order_state <> 'cancelled')::integer as order_count,
        coalesce(sum(orders.total_cents) filter (where orders.payment_state = 'paid'), 0)::bigint as total_paid_cents
      from public.customers
      left join public.orders on orders.customer_id = customers.id
      group by customers.id
    ) customer
  ), inflation_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'period', inflation.period,
      'indexValue', inflation.index_value,
      'sourceUrl', inflation.source_url,
      'publishedAt', inflation.published_at
    ) order by inflation.period), '[]'::jsonb) as payload
    from public.inflation_indices inflation
  ), expenses_payload as (
    select coalesce(jsonb_agg(
      private.misc_expense_payload(expense.id)
      order by expense.starts_on, expense.created_at, expense.id
    ), '[]'::jsonb) as payload
    from public.misc_expenses expense
  ), expense_history_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', audit.id::text,
      'expenseId', audit.expense_id,
      'action', audit.action,
      'previous', private.misc_expense_snapshot_payload(audit.before_snapshot),
      'current', private.misc_expense_snapshot_payload(audit.after_snapshot),
      'changedAt', audit.changed_at,
      'changedByName', coalesce(store_user.display_name, 'Usuario')
    ) order by audit.changed_at, audit.id), '[]'::jsonb) as payload
    from public.misc_expense_audit audit
    left join public.store_users store_user on store_user.user_id = audit.changed_by
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
    'revision', business_state.revision,
    'settings', private.store_settings_payload(),
    'products', products.payload,
    'inventory', private.inventory_payload(),
    'orders', orders.payload,
    'purchases', purchases.payload,
    'movements', movements.payload,
    'customers', customers.payload,
    'inflation', inflation.payload,
    'expenses', expenses.payload,
    'expenseHistory', expense_history.payload,
    'reservations', reservations.payload,
    'users', users.payload,
    'purchaseReceipts', (select coalesce(jsonb_agg(jsonb_build_object(
      'operationId', r.operation_id, 'purchaseId', r.purchase_id, 'items', r.items_payload,
      'shippingCostCents', r.shipping_cost_cents, 'shippingExpenseId', r.shipping_expense_id,
      'createdAt', r.created_at) order by r.created_at, r.id), '[]'::jsonb) from public.purchase_receipts r),
    'orderActionHistory', (select coalesce(jsonb_agg(jsonb_build_object(
      'operationId', e.operation_id, 'orderId', e.order_id, 'action', e.action,
      'previous', e.previous_payload, 'current', e.current_payload,
      'createdAt', e.created_at, 'createdByName', coalesce(u.display_name, 'Usuario'))
      order by e.created_at, e.operation_id), '[]'::jsonb)
      from public.order_action_reversals e left join public.store_users u on u.user_id = e.created_by),
    'orderShippingFeeHistory', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'operationId', e.operation_id, 'orderId', e.order_id,
      'input', e.input_payload,
      'previous', e.previous_payload, 'current', e.current_payload, 'createdAt', e.created_at,
      'createdByName', coalesce(u.display_name, 'Usuario')) order by e.created_at, e.id), '[]'::jsonb)
      from public.order_shipping_fee_events e left join public.store_users u on u.user_id = e.created_by)
  ) into v_result
  from public.business_state business_state
  cross join products_payload products
  cross join orders_payload orders
  cross join purchases_payload purchases
  cross join movements_payload movements
  cross join customers_payload customers
  cross join inflation_payload inflation
  cross join expenses_payload expenses
  cross join expense_history_payload expense_history
  cross join reservations_payload reservations
  cross join users_payload users
  where business_state.singleton_id = 1;

  return v_result;
end;
$$;

-- Reviewed forward actions also reject confirmations from a previous lifecycle
-- (paid -> pending -> paid, delivered -> pending -> delivered), even at $0.
create or replace function public.transition_order_reviewed(
  p_order_id uuid, p_action text, p_expected_revision bigint,
  p_expected_fee_revision integer default null, p_expected_total_cents bigint default null,
  p_expected_cost_cents bigint default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_revision bigint;
begin
  perform private.require_active_user();
  if p_expected_revision is null then
    raise exception using errcode = 'P0001', message = 'ORDER_REVERSAL_CONFIRMATION_REQUIRED';
  end if;
  perform 1 from public.products p join public.order_items oi on oi.product_id = p.id
    join public.stock_balances sb on sb.product_id = p.id
    where oi.order_id = p_order_id order by p.id for update of p, sb;
  select action_revision into v_revision from public.orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'ORDER_ACTION_CHANGED';
  end if;
  if p_action in ('mark_paid','mark_at_cost','mark_gifted') then
    if p_expected_fee_revision is null or p_expected_total_cents is null then
      raise exception using errcode = 'P0001', message = 'ORDER_REVERSAL_CONFIRMATION_REQUIRED';
    end if;
    return public.transition_order_checked(p_order_id,p_action,p_expected_fee_revision,p_expected_total_cents,p_expected_cost_cents);
  end if;
  return public.transition_order(p_order_id,p_action);
end;
$$;
revoke all on function public.transition_order_reviewed(uuid,text,bigint,integer,bigint,bigint) from public, anon, authenticated;
grant execute on function public.transition_order_reviewed(uuid,text,bigint,integer,bigint,bigint) to authenticated;
