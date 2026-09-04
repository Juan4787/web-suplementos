-- Migración: Consolidación de clientes, re-vinculación de pedidos y cálculo fiel del total cobrado
-- 1. Unifica clientes existentes duplicados por nombre o teléfono
-- 2. Re-vincula las órdenes históricas al ID del cliente consolidado
-- 3. Actualiza confirm_imported_order para reutilizar clientes existentes sin crear duplicados huérfanos
-- 4. Actualiza list_customers para que order_count y total_paid_cents excluyan órdenes canceladas y sumen con fidelidad

do $$
declare
  r record;
  v_canonical_id uuid;
begin
  -- Consolidar clientes duplicados que compartan el mismo nombre normalizado
  for r in (
    select
      lower(trim(name)) as norm_name,
      count(*) as cnt
    from public.customers
    group by lower(trim(name))
    having count(*) > 1
  ) loop
    -- Seleccionar el cliente canónico prioritario (con teléfono si tiene, y fecha más antigua de primer pedido)
    select id into v_canonical_id
    from public.customers
    where lower(trim(name)) = r.norm_name
    order by (phone is not null and btrim(phone) <> '') desc, first_order_at asc, id asc
    limit 1;

    -- Re-vincular todas las órdenes asociadas a los duplicados al ID canónico
    update public.orders
    set customer_id = v_canonical_id
    where customer_id in (
      select id from public.customers
      where lower(trim(name)) = r.norm_name and id <> v_canonical_id
    );

    -- Actualizar fechas de primer y último pedido, y teléfono en el cliente canónico
    update public.customers
    set first_order_at = (
          select min(first_order_at) from public.customers where lower(trim(name)) = r.norm_name
        ),
        last_order_at = (
          select max(last_order_at) from public.customers where lower(trim(name)) = r.norm_name
        ),
        phone = coalesce(
          nullif(btrim(public.customers.phone), ''),
          (select nullif(btrim(phone), '') from public.customers where lower(trim(name)) = r.norm_name and phone is not null and btrim(phone) <> '' limit 1)
        )
    where id = v_canonical_id;

    -- Eliminar los registros de clientes duplicados redundantes
    delete from public.customers
    where lower(trim(name)) = r.norm_name and id <> v_canonical_id;
  end loop;

  -- Re-vincular cualquier orden cuyo customer_id esté nulo o desfasado pero cuyo customer_name_snapshot coincida exactamente con un cliente existente
  for r in (
    select distinct o.id as order_id, c.id as matched_customer_id
    from public.orders o
    join public.customers c on lower(trim(c.name)) = lower(trim(o.customer_name_snapshot))
    where o.customer_id is null or o.customer_id <> c.id
  ) loop
    update public.orders
    set customer_id = r.matched_customer_id
    where id = r.order_id;
  end loop;
end;
$$;

-- Actualizar confirm_imported_order con resolución inteligente de clientes
create or replace function public.confirm_imported_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lines jsonb;
  v_line record;
  v_locked record;
  v_settings public.store_settings%rowtype;
  v_order_id uuid;
  v_customer_id uuid;
  v_subtotal bigint := 0;
  v_cost_total bigint := 0;
  v_shipping_fee bigint;
  v_total bigint;
  v_payment_method public.payment_method;
  v_delivery_method public.delivery_method;
  v_shipping_type public.shipping_type;
  v_customer_name text;
  v_phone text;
  v_phone_digits text;
  v_address text;
  v_checksum text;
  v_protocol_order_id uuid;
begin
  perform private.require_active_user();
  v_lines := p_order -> 'lines';
  if coalesce(jsonb_typeof(v_lines), 'null') <> 'array' then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;
  if jsonb_array_length(v_lines) = 0
    or jsonb_array_length(v_lines) > 50 then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  if (
    select count(*) <> count(distinct line ->> 'productId')
    from jsonb_array_elements(v_lines) line
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  select * into v_settings
  from public.store_settings
  where singleton_id = 1
  for share;

  v_customer_name := btrim(coalesce(p_order ->> 'customerName', ''));
  v_phone := nullif(btrim(coalesce(p_order ->> 'phone', '')), '');
  v_phone_digits := case when v_phone is not null then regexp_replace(v_phone, '[^0-9]', '', 'g') else '' end;
  v_payment_method := (p_order ->> 'paymentMethod')::public.payment_method;
  v_delivery_method := (p_order ->> 'deliveryMethod')::public.delivery_method;
  v_shipping_type := nullif(p_order ->> 'shippingType', '')::public.shipping_type;
  v_shipping_fee := (p_order ->> 'shippingFeeCents')::bigint;
  v_checksum := upper(btrim(coalesce(p_order ->> 'protocolChecksum', '')));
  v_protocol_order_id := (p_order ->> 'protocolOrderId')::uuid;

  if char_length(v_customer_name) not between 2 and 100 or v_checksum !~ '^[0-9A-F]{8}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  if v_delivery_method = 'pickup' then
    if v_shipping_type is not null or v_shipping_fee <> 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;
    v_address := null;
  else
    if v_shipping_type is null then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;
    v_address := btrim(concat_ws(' ', nullif(p_order ->> 'address', ''), nullif(p_order ->> 'addressNumber', '')));
    if char_length(v_address) < 3 or coalesce(char_length(v_phone_digits), 0) < 8 then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;
    if v_shipping_fee <> (case
      when v_shipping_type = 'express' then v_settings.express_shipping_cents
      else v_settings.standard_shipping_cents
    end) then
      raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
    end if;
  end if;

  for v_line in
    select
      (line ->> 'productId')::uuid as product_id,
      (line ->> 'quantity')::integer as quantity,
      (line ->> 'unitPriceCents')::bigint as quoted_unit_price
    from jsonb_array_elements(v_lines) line
    order by (line ->> 'productId')::uuid
  loop
    if v_line.quantity <= 0 or v_line.quantity > 1000 or v_line.quoted_unit_price < 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
    end if;

    select
      p.id,
      p.sku,
      p.name,
      p.presentation,
      p.sale_price_cents,
      p.active,
      p.published,
      s.on_hand,
      s.reserved,
      f.current_cost_cents
    into v_locked
    from public.products p
    join public.stock_balances s on s.product_id = p.id
    join public.product_financials f on f.product_id = p.id
    where p.id = v_line.product_id
    for update of p, s;

    if not found or not v_locked.active or not v_locked.published then
      raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
    end if;
    if v_locked.sale_price_cents <> v_line.quoted_unit_price then
      raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
    end if;
    if v_locked.on_hand - v_locked.reserved < v_line.quantity then
      raise exception using errcode = 'P0001', message = 'INSUFFICIENT_STOCK';
    end if;
    v_subtotal := v_subtotal + v_locked.sale_price_cents * v_line.quantity;
    v_cost_total := v_cost_total + v_locked.current_cost_cents * v_line.quantity;
  end loop;

  v_total := v_subtotal + v_shipping_fee;
  if v_subtotal <> (p_order ->> 'quotedSubtotalCents')::bigint
    or v_total <> (p_order ->> 'quotedTotalCents')::bigint then
    raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
  end if;

  -- Búsqueda y vinculación o creación inteligente del cliente
  if v_phone_digits <> '' then
    -- Primero buscar si ya existe un cliente con este teléfono
    select id into v_customer_id
    from public.customers
    where phone_normalized = v_phone_digits
    limit 1;

    if v_customer_id is not null then
      update public.customers
      set name = coalesce(nullif(v_customer_name, ''), name),
          phone = v_phone,
          last_order_at = now()
      where id = v_customer_id;
    else
      -- Si no hay por teléfono, verificar si existe por nombre sin teléfono registrado para asignárselo
      select id into v_customer_id
      from public.customers
      where lower(trim(name)) = lower(trim(v_customer_name))
        and (phone is null or btrim(phone) = '')
      order by last_order_at desc
      limit 1;

      if v_customer_id is not null then
        update public.customers
        set phone = v_phone,
            last_order_at = now()
        where id = v_customer_id;
      else
        insert into public.customers(name, phone, first_order_at, last_order_at)
        values (v_customer_name, v_phone, now(), now())
        returning id into v_customer_id;
      end if;
    end if;
  else
    -- Pedido sin teléfono: buscar cliente preexistente por nombre exacto normalizado
    select id into v_customer_id
    from public.customers
    where lower(trim(name)) = lower(trim(v_customer_name))
    order by (phone is not null and btrim(phone) <> '') desc, last_order_at desc
    limit 1;

    if v_customer_id is not null then
      update public.customers
      set last_order_at = now()
      where id = v_customer_id;
    else
      insert into public.customers(name, phone, first_order_at, last_order_at)
      values (v_customer_name, null, now(), now())
      returning id into v_customer_id;
    end if;
  end if;

  insert into public.orders (
    customer_id,
    customer_name_snapshot,
    customer_phone_snapshot,
    payment_method,
    delivery_method,
    shipping_type,
    shipping_address,
    source,
    protocol_order_id,
    protocol_checksum,
    subtotal_cents,
    shipping_fee_cents,
    total_cents,
    tax_rate_basis_points,
    tax_amount_cents,
    cost_total_cents,
    created_by
  ) values (
    v_customer_id,
    v_customer_name,
    v_phone,
    v_payment_method,
    v_delivery_method,
    v_shipping_type,
    v_address,
    'whatsapp_import',
    v_protocol_order_id,
    v_checksum,
    v_subtotal,
    v_shipping_fee,
    v_total,
    v_settings.tax_rate_basis_points,
    round(v_total * v_settings.tax_rate_basis_points / 10000.0)::bigint,
    v_cost_total,
    auth.uid()
  ) returning id into v_order_id;

  for v_line in
    select
      (line ->> 'productId')::uuid as product_id,
      (line ->> 'quantity')::integer as quantity,
      (line ->> 'unitPriceCents')::bigint as unit_price
    from jsonb_array_elements(v_lines) line
    order by (line ->> 'productId')::uuid
  loop
    select
      p.sku,
      p.name,
      p.presentation,
      f.current_cost_cents
    into v_locked
    from public.products p
    join public.product_financials f on f.product_id = p.id
    where p.id = v_line.product_id;

    insert into public.order_items (
      order_id, product_id, sku_snapshot, product_name_snapshot,
      presentation_snapshot, quantity, unit_price_cents, unit_cost_cents
    ) values (
      v_order_id, v_line.product_id, v_locked.sku, v_locked.name,
      v_locked.presentation, v_line.quantity, v_line.unit_price, v_locked.current_cost_cents
    );

    update public.stock_balances
    set reserved = reserved + v_line.quantity
    where product_id = v_line.product_id;

    insert into public.stock_reservations(order_id, product_id, quantity)
    values (v_order_id, v_line.product_id, v_line.quantity);

    insert into public.stock_movements(
      product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
    ) values (
      v_line.product_id,
      v_locked.name,
      'reservation',
      0,
      v_line.quantity,
      'Reserva al confirmar pedido',
      v_order_id,
      auth.uid()
    );
  end loop;

  perform private.bump_revision();
  return private.order_payload(v_order_id, private.is_owner());
end;
$$;

-- Actualizar list_customers para que sume todas las compras pagadas y no canceladas
create or replace function public.list_customers(
  p_page integer default 1,
  p_page_size integer default 30
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
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  select count(*) into v_total from public.customers;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', customer.id,
    'name', customer.name,
    'phone', customer.phone,
    'firstOrderAt', customer.first_order_at,
    'lastOrderAt', customer.last_order_at,
    'orderCount', customer.order_count,
    'totalPaidCents', case when v_owner then customer.total_paid_cents else null end
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
      coalesce(sum(o.total_cents) filter (where o.payment_state = 'paid' and o.order_state <> 'cancelled'), 0)::bigint as total_paid_cents
    from public.customers c
    left join public.orders o on o.customer_id = c.id
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

revoke all on function public.confirm_imported_order(jsonb) from public, anon, authenticated;
grant execute on function public.confirm_imported_order(jsonb) to authenticated;

revoke all on function public.list_customers(integer, integer) from public, anon, authenticated;
grant execute on function public.list_customers(integer, integer) to authenticated;
