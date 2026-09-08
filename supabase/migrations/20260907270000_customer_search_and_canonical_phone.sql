-- ============================================================================
-- MIGRACIÓN: Búsqueda Global de Clientes, Normalización Telefónica Canónica
--            y Métricas Completas de Deuda/Historial
-- ============================================================================

-- 1. Función inmutable para normalizar teléfonos a su formato nacional canónico
create or replace function public.canonical_phone(p_phone text)
returns text
language sql
immutable
as $$
  select case
    when p_phone is null or btrim(p_phone) = '' then ''
    else
      (
        with d as (
          select regexp_replace(p_phone, '[^0-9]', '', 'g') as digits
        )
        select case
          -- WhatsApp / Móvil Argentina con código país + 9: 549XXXXXXXXXX (13 dígitos) -> 10 dígitos nacionales
          when length(digits) = 13 and digits like '549%' then right(digits, 10)
          -- Con código país: 54XXXXXXXXXX (12 dígitos) -> 10 dígitos nacionales
          when length(digits) = 12 and digits like '54%' then right(digits, 10)
          -- Con prefijo interurbano nacional: 0XXXXXXXXXX (11 dígitos) -> 10 dígitos nacionales
          when length(digits) = 11 and digits like '0%' then right(digits, 10)
          else digits
        end
        from d
      )
  end;
$$;

revoke all on function public.canonical_phone(text) from public, anon, authenticated;
grant execute on function public.canonical_phone(text) to authenticated, anon, service_role;

-- 2. Índice para acelerar búsquedas y vinculación de clientes por teléfono canónico
create index if not exists customers_canonical_phone_idx
  on public.customers(public.canonical_phone(phone))
  where phone is not null and phone <> '';

-- 3. Actualizar confirm_imported_order para unificar clientes por teléfono canónico
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

  v_protocol_order_id := (p_order ->> 'protocolOrderId')::uuid;
  v_checksum := upper(btrim(coalesce(p_order ->> 'protocolChecksum', '')));
  v_customer_name := btrim(coalesce(p_order ->> 'customerName', ''));
  v_phone := nullif(btrim(coalesce(p_order ->> 'phone', '')), '');
  v_phone_digits := case when v_phone is not null then regexp_replace(v_phone, '[^0-9]', '', 'g') else '' end;
  v_phone_canonical := public.canonical_phone(v_phone);
  v_payment_method := (p_order ->> 'paymentMethod')::public.payment_method;
  v_delivery_method := (p_order ->> 'deliveryMethod')::public.delivery_method;
  v_shipping_type := nullif(p_order ->> 'shippingType', '')::public.shipping_type;
  v_shipping_fee := (p_order ->> 'shippingFeeCents')::bigint;

  if v_delivery_method = 'pickup' then
    v_address := null;
  else
    v_address := nullif(btrim(concat_ws(' ', nullif(p_order ->> 'address', ''), nullif(p_order ->> 'addressNumber', ''))), '');
  end if;

  -- 1. Idempotencia Concurrente Segura
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
      if v_existing_order.customer_name_snapshot <> v_customer_name
         or coalesce(v_existing_order.customer_phone_snapshot, '') <> coalesce(v_phone, '')
         or v_existing_order.payment_method <> v_payment_method
         or v_existing_order.delivery_method <> v_delivery_method
         or v_existing_order.shipping_type is distinct from v_shipping_type
         or v_existing_order.shipping_address is distinct from v_address
         or v_existing_order.shipping_fee_cents <> v_shipping_fee
         or (v_checksum <> '' and v_existing_order.protocol_checksum is not null and v_existing_order.protocol_checksum <> v_checksum)
      then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      if (select count(*) from public.order_items where order_id = v_existing_order.id) <> jsonb_array_length(v_lines) then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      if exists (
        select 1
        from jsonb_array_elements(v_lines) line
        where not exists (
          select 1 from public.order_items oi
          where oi.order_id = v_existing_order.id
            and oi.product_id = (line ->> 'productId')::uuid
            and oi.quantity = (line ->> 'quantity')::integer
        )
      ) then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      return private.order_payload(v_existing_order.id, true);
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

  -- 2. Autoridad Económica: Revalidar Flete
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

  -- 3. Resolver o Vincular Cliente usando normalización canónica
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

  -- 4. Precalcular subtotal
  select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unitPriceCents')::bigint), 0)
  into v_subtotal
  from jsonb_array_elements(v_lines) line;

  v_total := v_subtotal + v_shipping_fee;

  -- 5. Crear Cabecera del Pedido
  insert into public.orders (
    customer_id, customer_name_snapshot, customer_phone_snapshot, payment_method, delivery_method,
    shipping_type, shipping_address, source, protocol_order_id, protocol_checksum, subtotal_cents,
    shipping_fee_cents, total_cents, tax_rate_basis_points, tax_amount_cents, cost_total_cents, created_by
  ) values (
    v_customer_id, v_customer_name, v_phone, v_payment_method, v_delivery_method,
    v_shipping_type, v_address, v_source, v_protocol_order_id, v_checksum, v_subtotal,
    v_shipping_fee, v_total, v_settings.tax_rate_basis_points,
    round(v_total * v_settings.tax_rate_basis_points / 10000.0)::bigint,
    0, auth.uid()
  ) returning id into v_order_id;

  -- 6. Procesar Líneas
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
    if v_locked.sale_price_cents <> v_line.unit_price then
      raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
    end if;

    insert into public.order_items (
      order_id, product_id, sku_snapshot, product_name_snapshot,
      presentation_snapshot, quantity, unit_price_cents, unit_cost_cents, cost_total_cents
    ) values (
      v_order_id, v_line.product_id, v_locked.sku, v_locked.name,
      v_locked.presentation, v_line.quantity, v_line.unit_price, v_locked.current_cost_cents, 0
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

  -- 7. Totales Finales
  v_total := v_subtotal + v_shipping_fee;
  update public.orders
  set subtotal_cents = v_subtotal,
      total_cents = v_total,
      tax_amount_cents = round(v_total * v_settings.tax_rate_basis_points / 10000.0)::bigint,
      cost_total_cents = v_cost_total
  where id = v_order_id;

  perform private.bump_revision();
  return private.order_payload(v_order_id, true);
end;
$$;

revoke all on function public.confirm_imported_order(jsonb) from public, anon, authenticated;
grant execute on function public.confirm_imported_order(jsonb) to authenticated;

-- 4. Actualizar list_customers con soporte de búsqueda global en toda la base,
--    normalización telefónica y cálculo completo de pedidos pendientes e históricos.
drop function if exists public.list_customers(integer, integer);

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
    or c.phone ilike '%' || v_clean_search || '%'
    or (v_search_digits <> '' and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_search_digits || '%')
    or (v_search_canonical <> '' and public.canonical_phone(c.phone) like '%' || v_search_canonical || '%')
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', customer.id,
    'name', customer.name,
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
      c.phone,
      c.first_order_at,
      c.last_order_at,
      count(o.id) filter (where o.order_state <> 'cancelled')::integer as order_count,
      coalesce(sum(o.total_cents) filter (where o.payment_state = 'paid' and o.order_state <> 'cancelled'), 0)::bigint as total_paid_cents,
      count(o.id) filter (where o.payment_state = 'pending' and o.order_state <> 'cancelled')::integer as pending_order_count,
      coalesce(sum(o.total_cents) filter (where o.payment_state = 'pending' and o.order_state <> 'cancelled'), 0)::bigint as pending_total_cents
    from public.customers c
    left join public.orders o on o.customer_id = c.id
    where (
      v_clean_search is null
      or c.name ilike '%' || v_clean_search || '%'
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
