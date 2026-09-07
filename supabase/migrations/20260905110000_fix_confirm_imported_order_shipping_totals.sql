-- ============================================================================
-- MIGRACIÓN: Corrección de constraint orders_check al importar pedidos con flete
-- ============================================================================
-- En la creación preliminar de la cabecera de la orden en confirm_imported_order,
-- se insertaban subtotal_cents = 0 y total_cents = 0 con shipping_fee_cents = v_shipping_fee.
-- Esto violaba la constraint 'orders_check' (total_cents = subtotal_cents + shipping_fee_cents)
-- en cualquier pedido con costo de envío (ej: express o standard > 0), provocando
-- un error 23514 al intentar confirmar pedidos con envío a domicilio.
--
-- Se precalcula v_subtotal y v_total a partir de las líneas cotizadas antes del INSERT inicial,
-- garantizando que 'orders_check' se cumpla estrictamente en todo momento.

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
  v_address text;
  v_payment_method public.payment_method;
  v_delivery_method public.delivery_method;
  v_protocol_order_id uuid;
  v_checksum text;
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
  v_cap integer;
  v_take integer;
  v_existing_order_id uuid;
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

  v_protocol_order_id := (p_order ->> 'protocolOrderId')::uuid;

  -- 1. Idempotencia UX Real: Si ya existe, retornar orden existente de inmediato
  if v_protocol_order_id is not null then
    select id into v_existing_order_id from public.orders where protocol_order_id = v_protocol_order_id limit 1;
    if v_existing_order_id is not null then
      return private.order_payload(v_existing_order_id, true);
    end if;
  end if;

  select * into v_settings from public.store_settings where singleton_id = 1 for share;

  v_customer_name := btrim(coalesce(p_order ->> 'customerName', ''));
  v_phone := nullif(btrim(coalesce(p_order ->> 'phone', '')), '');
  v_phone_digits := case when v_phone is not null then regexp_replace(v_phone, '[^0-9]', '', 'g') else '' end;
  v_payment_method := (p_order ->> 'paymentMethod')::public.payment_method;
  v_delivery_method := (p_order ->> 'deliveryMethod')::public.delivery_method;
  v_shipping_type := nullif(p_order ->> 'shippingType', '')::public.shipping_type;
  v_shipping_fee := (p_order ->> 'shippingFeeCents')::bigint;
  v_checksum := upper(btrim(coalesce(p_order ->> 'protocolChecksum', '')));

  if char_length(v_customer_name) not between 2 and 100 or v_checksum !~ '^[0-9A-F]{8}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;

  -- 2. Autoridad Económica: Revalidar Flete contra store_settings
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

  -- 3. Resolver o Vincular Cliente
  if v_phone_digits <> '' then
    select id into v_customer_id from public.customers where phone_normalized = v_phone_digits limit 1;
    if v_customer_id is not null then
      update public.customers set name = v_customer_name, phone = v_phone, last_order_at = now() where id = v_customer_id;
    else
      insert into public.customers(name, phone, first_order_at, last_order_at)
      values (v_customer_name, v_phone, now(), now()) returning id into v_customer_id;
    end if;
  else
    select id into v_customer_id from public.customers where lower(name) = lower(v_customer_name) limit 1;
    if v_customer_id is not null then
      update public.customers set last_order_at = now() where id = v_customer_id;
    else
      insert into public.customers(name, phone, first_order_at, last_order_at)
      values (v_customer_name, null, now(), now()) returning id into v_customer_id;
    end if;
  end if;

  -- 4. Precalcular subtotal y total para satisfacer la constraint orders_check
  -- (total_cents = subtotal_cents + shipping_fee_cents)
  select coalesce(sum((line ->> 'quantity')::integer * (line ->> 'unitPriceCents')::bigint), 0)
  into v_subtotal
  from jsonb_array_elements(v_lines) line;

  v_total := v_subtotal + v_shipping_fee;

  -- 5. Crear Cabecera del Pedido con importes consistentes
  insert into public.orders (
    customer_id, customer_name_snapshot, customer_phone_snapshot, payment_method, delivery_method,
    shipping_type, shipping_address, source, protocol_order_id, protocol_checksum, subtotal_cents,
    shipping_fee_cents, total_cents, tax_rate_basis_points, tax_amount_cents, cost_total_cents, created_by
  ) values (
    v_customer_id, v_customer_name, v_phone, v_payment_method, v_delivery_method,
    v_shipping_type, v_address, 'whatsapp_import', v_protocol_order_id, v_checksum, v_subtotal,
    v_shipping_fee, v_total, v_settings.tax_rate_basis_points,
    round(v_total * v_settings.tax_rate_basis_points / 10000.0)::bigint, 0, auth.uid()
  ) returning id into v_order_id;

  v_subtotal := 0; -- Reiniciar para acumular con validación estricta de precios de catálogo

  -- 6. PASADA ÚNICA: Lock Nivel 1 (stock_balances), Creación de Items y Asignación Atómica
  for v_line in
    select (line ->> 'productId')::uuid as product_id, (line ->> 'quantity')::integer as quantity,
           (line ->> 'unitPriceCents')::bigint as quoted_unit_price
    from jsonb_array_elements(v_lines) line
    order by (line ->> 'productId')::uuid -- Jerarquía Canónica Nivel 1
  loop
    select p.id, p.sku, p.name, p.presentation, p.sale_price_cents, p.active, p.published,
           sb.on_hand, sb.reserved, f.current_cost_cents
    into v_locked
    from public.products p
    join public.stock_balances sb on sb.product_id = p.id
    join public.product_financials f on f.product_id = p.id
    where p.id = v_line.product_id
    for update of p, sb;

    if not found or not v_locked.active or not v_locked.published then
      raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
    end if;
    if v_locked.sale_price_cents <> v_line.quoted_unit_price then
      raise exception using errcode = 'P0001', message = 'ORDER_PRICE_CHANGED';
    end if;

    v_subtotal := v_subtotal + v_locked.sale_price_cents * v_line.quantity;
    v_item_cost_total := 0;

    -- Insertar order_item preliminar
    insert into public.order_items (
      order_id, product_id, sku_snapshot, product_name_snapshot, presentation_snapshot,
      quantity, unit_price_cents, unit_cost_cents, cost_total_cents
    ) values (
      v_order_id, v_line.product_id, v_locked.sku, v_locked.name, v_locked.presentation,
      v_line.quantity, v_line.quoted_unit_price, v_locked.current_cost_cents, 0
    ) returning id into v_order_item_id;

    v_phys_avail := greatest(0, v_locked.on_hand - v_locked.reserved);
    v_phys_alloc := least(v_line.quantity, v_phys_avail);
    v_remaining := v_line.quantity - v_phys_alloc;

    -- Asignación Física
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

    -- Asignación Entrante (Compras en camino ordenadas canónicamente Nivel 2 y 3)
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

    -- Actualizar costo total de la línea
    update public.order_items set cost_total_cents = v_item_cost_total where id = v_order_item_id;
    v_cost_total := v_cost_total + v_item_cost_total;
  end loop;

  -- 7. Actualizar Totales Finales en la Orden
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
