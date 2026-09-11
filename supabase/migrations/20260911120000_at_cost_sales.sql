-- Migration: 20260911120000_at_cost_sales.sql
-- Description: Soporte para ventas al costo con ganancia neutral ($0), preservando medio de pago real y trazabilidad en analítica comercial.

-- 1. Agregar columna sale_type a orders
alter table public.orders
add column if not exists sale_type text not null default 'retail';

alter table public.orders
drop constraint if exists orders_sale_type_check;

alter table public.orders
add constraint orders_sale_type_check check (sale_type in ('retail', 'cost', 'gift'));

-- Backfill de órdenes existentes
update public.orders
set sale_type = 'gift'
where (payment_state = 'gifted' or payment_method = 'gift') and sale_type <> 'gift';

create index if not exists idx_orders_sale_type on public.orders(sale_type);

-- 2. Actualizar private.order_payload para incluir saleType e isCostSale
create or replace function private.order_payload(p_order_id uuid, p_include_financials boolean)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', o.id,
    'number', o.order_number,
    'customerId', o.customer_id,
    'customerName', o.customer_name_snapshot,
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
        'unitPriceCents', oi.unit_price_cents,
        'unitCostCents', case when p_include_financials then oi.unit_cost_cents else null end,
        'costTotalCents', case when p_include_financials then oi.cost_total_cents else null end,
        'subtotalCents', oi.line_subtotal_cents
      ) order by oi.created_at, oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  where o.id = p_order_id;
$$;

-- 3. Actualizar transition_order para incorporar acción mark_at_cost
create or replace function public.transition_order(p_order_id uuid, p_action text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_inventory_leaves boolean := false;
  v_new_fulfillment public.fulfillment_state;
  v_res record;
begin
  perform private.require_active_user();

  -- ANTI-DEADLOCK NIVEL 1: Bloqueo Canónico Unificado
  perform 1
  from public.products p
  join public.stock_balances sb on sb.product_id = p.id
  where p.id in (
    select oi.product_id from public.order_items oi where oi.order_id = p_order_id
  )
  order by p.id asc
  for update of p, sb;

  -- Nivel Orders
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;
  if v_order.order_state = 'cancelled' then
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

    -- Recalcular líneas con su costo unitario
    update public.order_items
    set unit_price_cents = coalesce(unit_cost_cents, 0),
        line_subtotal_cents = coalesce(unit_cost_cents, 0) * quantity
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

        insert into public.stock_movements(
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
        ) values (
          v_item.product_id,
          v_item.product_name_snapshot,
          'adjustment',
          -v_item.quantity,
          -v_item.quantity,
          'Salida por regalo / cortesía (Pedido #' || v_order.order_number || ')',
          p_order_id,
          auth.uid()
        );
      end loop;
    end if;

    update public.orders
    set payment_state = 'gifted',
        sale_type = 'gift',
        payment_method = case when payment_method in ('cash', 'transfer') and total_cents = 0 then 'gift'::public.payment_method else payment_method end,
        fulfillment_state = 'delivered',
        preparation_state = 'ready',
        total_cents = 0,
        subtotal_cents = 0,
        tax_amount_cents = 0,
        shipping_fee_cents = 0,
        paid_at = coalesce(paid_at, now()),
        fulfilled_at = coalesce(fulfilled_at, now())
    where id = p_order_id;

  elsif p_action = 'cancel' then
    if v_order.fulfillment_state = 'delivered' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;

    if v_order.fulfillment_state = 'shipped' then
      for v_item in
        select oi.product_id, oi.product_name_snapshot, oi.quantity
        from public.order_items oi
        where oi.order_id = p_order_id
        order by oi.product_id
      loop
        update public.stock_balances
        set on_hand = on_hand + v_item.quantity
        where product_id = v_item.product_id;

        insert into public.stock_movements(
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
        ) values (
          v_item.product_id,
          v_item.product_name_snapshot,
          'return',
          v_item.quantity,
          0,
          'Reintegro de stock por pedido cancelado',
          p_order_id,
          auth.uid()
        );
      end loop;
    elsif v_order.fulfillment_state = 'pending' then
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
        end if;

        update public.stock_reservations
        set state = 'released', resolved_at = now()
        where id = v_res.id;
      end loop;
    end if;

    update public.orders
    set order_state = 'cancelled',
        fulfillment_state = 'cancelled',
        preparation_state = 'ready',
        cancelled_at = now()
    where id = p_order_id;
  else
    raise exception using errcode = 'P0001', message = 'UNKNOWN_ORDER_ACTION';
  end if;

  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;

-- 4. Actualizar confirm_imported_order para admitir saleType 'cost'
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
begin
  perform private.require_active_user();
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
  v_customer_name := btrim(coalesce(p_order ->> 'customerName', ''));
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

  -- Idempotencia
  if v_protocol_order_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_protocol_order_id::text));

    select id, protocol_checksum, customer_name_snapshot, customer_phone_snapshot,
           payment_method, delivery_method, shipping_type, shipping_address,
           shipping_fee_cents, subtotal_cents, total_cents
    into v_existing_order
    from public.orders
    where protocol_order_id = v_protocol_order_id
    limit 1;

    if v_existing_order.id is not null then
      return private.order_payload(v_existing_order.id, private.is_owner());
    end if;
  end if;

  select * into v_settings from public.store_settings where singleton_id = 1 for share;

  if char_length(v_customer_name) not between 2 and 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  v_source := case when v_protocol_order_id is not null then 'whatsapp_import' else 'manual' end;
  if v_source = 'whatsapp_import' then
    if v_checksum !~ '^[0-9A-F]{8}$' then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;
  else
    v_checksum := null;
  end if;

  -- Revalidar Flete (si no es regalo)
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

  -- Resolver o Vincular Cliente
  if v_phone_canonical <> '' then
    select id into v_customer_id
    from public.customers
    where public.canonical_phone(phone) = v_phone_canonical
    order by last_order_at desc
    limit 1;

    if v_customer_id is not null then
      update public.customers
      set name = v_customer_name,
          phone = coalesce(phone, v_phone),
          last_order_at = now()
      where id = v_customer_id;
    else
      insert into public.customers(name, phone, first_order_at, last_order_at)
      values (v_customer_name, v_phone, now(), now()) returning id into v_customer_id;
    end if;
  else
    select id into v_customer_id
    from public.customers
    where lower(name) = lower(v_customer_name)
    order by last_order_at desc
    limit 1;

    if v_customer_id is not null then
      update public.customers set last_order_at = now() where id = v_customer_id;
    else
      insert into public.customers(name, phone, first_order_at, last_order_at)
      values (v_customer_name, null, now(), now()) returning id into v_customer_id;
    end if;
  end if;

  -- Precalcular subtotal
  if v_is_gift then
    v_subtotal := 0;
    v_total := 0;
  elsif v_is_cost then
    -- En venta al costo, el subtotal se recalculará exactamente con el costo real de los productos
    v_subtotal := 0;
    v_total := 0;
  else
    select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unitPriceCents')::bigint), 0)
    into v_subtotal
    from jsonb_array_elements(v_lines) line;
    v_total := v_subtotal + v_shipping_fee;
  end if;

  -- Crear Cabecera del Pedido
  insert into public.orders (
    customer_id, customer_name_snapshot, customer_phone_snapshot, payment_method, delivery_method,
    shipping_type, shipping_address, source, protocol_order_id, protocol_checksum, subtotal_cents,
    shipping_fee_cents, total_cents, tax_rate_basis_points, tax_amount_cents, cost_total_cents, created_by,
    payment_state, paid_at, sale_type
  ) values (
    v_customer_id, v_customer_name, v_phone, v_payment_method, v_delivery_method,
    v_shipping_type, v_address, v_source, v_protocol_order_id, v_checksum, v_subtotal,
    v_shipping_fee, v_total, v_settings.tax_rate_basis_points,
    case when v_is_gift or v_is_cost then 0 else round(v_total * v_settings.tax_rate_basis_points / 10000.0)::bigint end,
    0, auth.uid(),
    case when v_is_gift then 'gifted'::public.payment_state else 'pending'::public.payment_state end,
    case when v_is_gift then now() else null end,
    v_sale_type
  ) returning id into v_order_id;

  -- Procesar Líneas
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

    if not found or not v_locked.active or not v_locked.published then
      raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
    end if;

    if not v_is_gift and not v_is_cost and v_locked.sale_price_cents <> v_line.unit_price then
      raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
    end if;

    insert into public.order_items (
      order_id, product_id, sku_snapshot, product_name_snapshot,
      presentation_snapshot, quantity, unit_price_cents, unit_cost_cents, cost_total_cents, line_subtotal_cents
    ) values (
      v_order_id, v_line.product_id, v_locked.sku, v_locked.name,
      v_locked.presentation, v_line.quantity,
      case
        when v_is_gift then 0
        when v_is_cost then v_locked.current_cost_cents
        else v_line.unit_price
      end,
      v_locked.current_cost_cents, 0,
      case
        when v_is_gift then 0
        when v_is_cost then v_locked.current_cost_cents * v_line.quantity
        else v_line.unit_price * v_line.quantity
      end
    ) returning id into v_order_item_id;

    v_phys_avail := greatest(0, v_locked.on_hand - v_locked.reserved);
    v_phys_alloc := least(v_line.quantity, v_phys_avail);
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
        order by pu.expected_at asc nulls last, pu.ordered_at asc, pu.id asc, pi.id asc
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
      raise exception using errcode = 'P0001', message = 'INSUFFICIENT_STOCK';
    end if;

    update public.order_items set cost_total_cents = v_item_cost_total where id = v_order_item_id;
    v_cost_total := v_cost_total + v_item_cost_total;
  end loop;

  -- Si fue venta al costo, sincronizar subtotal y total con el costo exacto calculado
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

-- 5. Actualizar get_sales_analytics para reportar ventas al costo con margen neutral ($0)
create or replace function public.get_sales_analytics(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff_day integer;
  v_result jsonb;
begin
  perform private.require_owner();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception using errcode = 'P0001', message = 'INVALID_PERIOD';
  end if;
  if extract(day from p_from) = 1
    and date_trunc('month', p_from) <> date_trunc('month', p_to)
    and p_to < (date_trunc('month', p_to)::date + interval '1 month - 1 day')::date then
    v_cutoff_day := extract(day from p_to)::integer;
  else
    v_cutoff_day := null;
  end if;

  with active_orders as materialized (
    select
      o.*,
      (coalesce(o.paid_at, o.created_at) at time zone 'America/Argentina/Buenos_Aires')::date as local_effective_date
    from public.orders o
    where o.payment_state in ('paid', 'gifted')
      and (coalesce(o.paid_at, o.created_at) at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
      and (
        v_cutoff_day is null
        or extract(day from (coalesce(o.paid_at, o.created_at) at time zone 'America/Argentina/Buenos_Aires')::date) <= v_cutoff_day
      )
  ), summary as (
    select
      coalesce(sum(total_cents), 0)::bigint as revenue_cents,
      coalesce(sum(cost_total_cents), 0)::bigint as cost_cents,
      coalesce(sum(tax_amount_cents), 0)::bigint as tax_cents,
      count(*) filter (where payment_state = 'paid' and coalesce(sale_type, 'retail') <> 'cost')::integer as paid_order_count,
      count(*) filter (where payment_state = 'gifted' or coalesce(sale_type, 'retail') = 'gift')::integer as gift_order_count,
      coalesce(sum(cost_total_cents) filter (where payment_state = 'gifted' or coalesce(sale_type, 'retail') = 'gift'), 0)::bigint as gift_cost_cents,
      count(*) filter (where coalesce(sale_type, 'retail') = 'cost')::integer as cost_sale_order_count,
      coalesce(sum(total_cents) filter (where coalesce(sale_type, 'retail') = 'cost'), 0)::bigint as cost_sale_revenue_cents,
      count(*)::integer as total_order_count
    from active_orders
  ), unit_summary as (
    select coalesce(sum(oi.quantity), 0)::integer as units
    from active_orders ao
    join public.order_items oi on oi.order_id = ao.id
  ), ranked_products as (
    select
      oi.product_id,
      oi.product_name_snapshot as name,
      sum(oi.quantity)::integer as units,
      sum(oi.line_subtotal_cents)::bigint as revenue_cents,
      sum(oi.unit_cost_cents * oi.quantity)::bigint as cost_cents,
      sum(
        oi.line_subtotal_cents
        - oi.unit_cost_cents * oi.quantity
        - case
            when ao.total_cents > 0
              then round(ao.tax_amount_cents * oi.line_subtotal_cents::numeric / ao.total_cents)::bigint
            else 0
          end
      )::bigint as estimated_margin_cents
    from active_orders ao
    join public.order_items oi on oi.order_id = ao.id
    group by oi.product_id, oi.product_name_snapshot
    order by units desc, revenue_cents desc, name
    limit 10
  ), top_products as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', product_id,
      'name', name,
      'units', units,
      'revenueCents', revenue_cents,
      'costCents', cost_cents,
      'estimatedMarginCents', estimated_margin_cents
    ) order by units desc, revenue_cents desc, name), '[]'::jsonb) as payload
    from ranked_products
  ), months as (
    select generate_series(
      date_trunc('month', p_from::timestamp),
      date_trunc('month', p_to::timestamp),
      interval '1 month'
    )::date as month_start
  ), series as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'period', to_char(m.month_start, 'YYYY-MM'),
      'revenueCents', coalesce(m_orders.revenue_cents, 0),
      'adjustedRevenueCents', null,
      'orderCount', coalesce(m_orders.order_count, 0),
      'units', coalesce(m_orders.units, 0),
      'ipcPublished', false
    ) order by m.month_start), '[]'::jsonb) as payload
    from months m
    left join lateral (
      select
        sum(ao.total_cents)::bigint as revenue_cents,
        count(*) filter (where ao.payment_state = 'paid' and coalesce(ao.sale_type, 'retail') <> 'cost')::integer as order_count,
        sum(coalesce(u.units, 0))::integer as units
      from active_orders ao
      left join lateral (
        select sum(oi.quantity)::integer as units
        from public.order_items oi where oi.order_id = ao.id
      ) u on true
      where date_trunc('month', ao.local_effective_date) = m.month_start
    ) m_orders on true
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'comparisonCutoffDay', v_cutoff_day,
    'revenueCents', s.revenue_cents,
    'costCents', s.cost_cents,
    'taxCents', s.tax_cents,
    'estimatedMarginCents', (s.revenue_cents - s.cost_cents - s.tax_cents),
    'averageTicketCents', case when s.paid_order_count > 0 then round((s.revenue_cents - s.cost_sale_revenue_cents)::numeric / s.paid_order_count)::bigint else 0 end,
    'orders', s.paid_order_count,
    'giftOrders', s.gift_order_count,
    'giftCostCents', s.gift_cost_cents,
    'costSaleOrders', s.cost_sale_order_count,
    'costSaleRevenueCents', s.cost_sale_revenue_cents,
    'units', coalesce(u.units, 0),
    'series', sr.payload,
    'topProducts', tp.payload
  ) into v_result
  from summary s
  cross join unit_summary u
  cross join top_products tp
  cross join series sr;

  return v_result;
end;
$$;
