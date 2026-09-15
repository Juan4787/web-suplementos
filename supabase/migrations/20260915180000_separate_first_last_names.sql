-- Migration: 20260915180000_separate_first_last_names.sql
-- Objetivo: Separar de forma obligatoria Nombre y Apellido tanto en clientes como en snapshots de pedidos,
-- manteniendo retrocompatibilidad absoluta con datos preexistentes y payloads legados.

-- 1. Agregar columnas a public.customers
alter table public.customers
  add column if not exists first_name text,
  add column if not exists last_name text;

-- 2. Backfill de registros existentes en public.customers
update public.customers
set
  first_name = coalesce(nullif(split_part(btrim(name), ' ', 1), ''), name),
  last_name = coalesce(nullif(btrim(substring(btrim(name) from length(split_part(btrim(name), ' ', 1)) + 1)), ''), '-')
where first_name is null or last_name is null;

-- 3. Agregar columnas de snapshot a public.orders
alter table public.orders
  add column if not exists customer_first_name_snapshot text,
  add column if not exists customer_last_name_snapshot text;

-- 4. Backfill de órdenes existentes en public.orders
update public.orders
set
  customer_first_name_snapshot = coalesce(nullif(split_part(btrim(customer_name_snapshot), ' ', 1), ''), customer_name_snapshot),
  customer_last_name_snapshot = coalesce(nullif(btrim(substring(btrim(customer_name_snapshot) from length(split_part(btrim(customer_name_snapshot), ' ', 1)) + 1)), ''), '-')
where customer_first_name_snapshot is null or customer_last_name_snapshot is null;

-- 5. Actualizar private.order_payload para incluir customerFirstName y customerLastName
create or replace function private.order_payload(p_order_id uuid, p_include_financials boolean)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
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

-- 6. Actualizar confirm_imported_order para admitir customerFirstName y customerLastName
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
  v_customer_first_name := btrim(coalesce(p_order ->> 'customerFirstName', ''));
  v_customer_last_name := btrim(coalesce(p_order ->> 'customerLastName', ''));
  v_customer_name := btrim(coalesce(p_order ->> 'customerName', ''));

  -- Si vienen nombre y apellido explícitos, validarlos
  if char_length(v_customer_first_name) >= 1 or char_length(v_customer_last_name) >= 1 then
    if char_length(v_customer_first_name) < 2 or char_length(v_customer_last_name) < 2 then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;
    v_customer_name := btrim(concat_ws(' ', v_customer_first_name, v_customer_last_name));
  else
    -- Fallback retrocompatible para mensajes o integraciones legadas
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

  -- Precalcular subtotal
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

  -- Crear Cabecera del Pedido con Snapshots de Nombre y Apellido
  insert into public.orders (
    customer_id, customer_name_snapshot, customer_first_name_snapshot, customer_last_name_snapshot,
    customer_phone_snapshot, payment_method, delivery_method,
    shipping_type, shipping_address, source, protocol_order_id, protocol_checksum, subtotal_cents,
    shipping_fee_cents, total_cents, tax_rate_basis_points, tax_amount_cents, cost_total_cents, created_by,
    payment_state, paid_at, sale_type
  ) values (
    v_customer_id, v_customer_name, v_customer_first_name, v_customer_last_name,
    v_phone, v_payment_method, v_delivery_method,
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

-- 7. Actualizar list_customers para exponer firstName y lastName
create or replace function public.list_customers(
  p_page integer default 1,
  p_page_size integer default 30,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner boolean;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_total bigint;
  v_items jsonb;
  v_clean_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_search_digits text := case when v_clean_search is not null then regexp_replace(v_clean_search, '[^0-9]', '', 'g') else '' end;
  v_search_canonical text := case when v_clean_search is not null then public.canonical_phone(v_clean_search) else '' end;
begin
  perform private.require_active_user();
  v_owner := private.is_owner();

  -- Conteo total global respetando el filtro de búsqueda
  select count(*) into v_total
  from public.customers c
  where (
    v_clean_search is null
    or c.name ilike '%' || v_clean_search || '%'
    or coalesce(c.first_name, '') ilike '%' || v_clean_search || '%'
    or coalesce(c.last_name, '') ilike '%' || v_clean_search || '%'
    or c.phone ilike '%' || v_clean_search || '%'
    or (v_search_digits <> '' and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_search_digits || '%')
    or (v_search_canonical <> '' and public.canonical_phone(c.phone) like '%' || v_search_canonical || '%')
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', customer.id,
    'name', customer.name,
    'firstName', customer.first_name,
    'lastName', customer.last_name,
    'phone', customer.phone,
    'firstOrderAt', customer.first_order_at,
    'lastOrderAt', customer.last_order_at,
    'orderCount', customer.order_count,
    'totalPaidCents', case when v_owner then customer.total_paid_cents else null end,
    'pendingOrderCount', customer.pending_order_count,
    'pendingTotalCents', case when v_owner then customer.pending_total_cents else null end
  ) order by customer.last_order_at desc, customer.id desc), '[]'::jsonb)
  into v_items
  from (
    select
      c.id,
      c.name,
      c.first_name,
      c.last_name,
      c.phone,
      c.first_order_at,
      c.last_order_at,
      count(o.id) filter (where o.order_state <> 'cancelled')::integer as order_count,
      coalesce(sum(o.total_cents) filter (where o.payment_state = 'paid' and o.order_state <> 'cancelled'), 0)::bigint as total_paid_cents,
      count(o.id) filter (where o.order_state <> 'cancelled' and o.payment_state = 'pending')::integer as pending_order_count,
      coalesce(sum(o.total_cents) filter (where o.order_state <> 'cancelled' and o.payment_state = 'pending'), 0)::bigint as pending_total_cents
    from public.customers c
    left join public.orders o on o.customer_id = c.id
    where (
      v_clean_search is null
      or c.name ilike '%' || v_clean_search || '%'
      or coalesce(c.first_name, '') ilike '%' || v_clean_search || '%'
      or coalesce(c.last_name, '') ilike '%' || v_clean_search || '%'
      or c.phone ilike '%' || v_clean_search || '%'
      or (v_search_digits <> '' and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_search_digits || '%')
      or (v_search_canonical <> '' and public.canonical_phone(c.phone) like '%' || v_search_canonical || '%')
    )
    group by c.id
    order by c.last_order_at desc, c.id desc
    limit v_page_size
    offset (v_page - 1) * v_page_size
  ) customer;

  return jsonb_build_object(
    'items', v_items,
    'page', v_page,
    'pageSize', v_page_size,
    'total', v_total
  );
end;
$$;

revoke all on function public.list_customers(integer, integer, text) from public, anon, authenticated;
grant execute on function public.list_customers(integer, integer, text) to authenticated;
