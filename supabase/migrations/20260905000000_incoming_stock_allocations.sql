-- ============================================================================
-- Migración: Asignaciones de Stock en Camino (Pre-venta / Backorders)
-- Fecha: 2026-09-05
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLA purchase_items: received_quantity y shortage_quantity
-- ----------------------------------------------------------------------------
alter table public.purchase_items
  add column if not exists received_quantity integer not null default 0,
  add column if not exists shortage_quantity integer not null default 0,
  add constraint purchase_items_quantities_check 
    check (received_quantity >= 0 and shortage_quantity >= 0),
  add constraint purchase_items_fulfillment_check 
    check (received_quantity + shortage_quantity <= quantity);

-- ----------------------------------------------------------------------------
-- 2. TABLA order_items: cost_total_cents (Líneas Mixtas y Analytics)
-- ----------------------------------------------------------------------------
alter table public.order_items
  add column if not exists cost_total_cents bigint;

update public.order_items
set cost_total_cents = unit_cost_cents * quantity
where cost_total_cents is null;

alter table public.order_items
  alter column cost_total_cents set not null,
  add constraint order_items_cost_total_check check (cost_total_cents >= 0);

-- ----------------------------------------------------------------------------
-- 3. TABLA stock_reservations: Evolución a Asignaciones Granulares
-- ----------------------------------------------------------------------------
alter table public.stock_reservations
  drop constraint if exists stock_reservations_order_id_product_id_key;

alter table public.stock_reservations
  add column if not exists order_item_id uuid references public.order_items(id) on delete restrict,
  add column if not exists source_type text not null default 'physical' 
    check (source_type in ('physical', 'incoming', 'uncovered')),
  add column if not exists purchase_item_id uuid references public.purchase_items(id) on delete restrict,
  add column if not exists cost_snapshot_cents bigint;

-- Aserción de unicidad histórica previa al backfill
do $$
begin
  if exists (
    select 1 from public.order_items
    group by order_id, product_id having count(*) > 1
  ) then
    raise exception 'MIGRATION_HALTED: Duplicados detectados en order_items';
  end if;
end $$;

-- Backfill determinista
update public.stock_reservations sr
set order_item_id = oi.id,
    cost_snapshot_cents = oi.unit_cost_cents
from public.order_items oi
where oi.order_id = sr.order_id and oi.product_id = sr.product_id
  and sr.order_item_id is null;

-- Aserción post-backfill: Cero NULLs permitidos
do $$
begin
  if exists (select 1 from public.stock_reservations where order_item_id is null or cost_snapshot_cents is null) then
    raise exception 'MIGRATION_HALTED: Hay reservas sin order_item_id o costo tras backfill';
  end if;
end $$;

-- NOT NULL permanente y sin default para forzar asignación explícita de costo
alter table public.stock_reservations
  alter column order_item_id set not null,
  alter column cost_snapshot_cents set not null;

alter table public.stock_reservations
  add constraint check_incoming_requires_purchase
  check (
    (source_type = 'incoming' and purchase_item_id is not null) or
    (source_type <> 'incoming')
  );

create index if not exists idx_stock_reservations_incoming_active 
  on public.stock_reservations(purchase_item_id) 
  where state = 'active' and source_type = 'incoming';

create index if not exists idx_stock_reservations_order_lookup
  on public.stock_reservations(order_id, state, source_type);

-- ----------------------------------------------------------------------------
-- 4. TRIGGERS DEFENSIVOS DE COMPRAS Y RESERVAS
-- ----------------------------------------------------------------------------
-- A. Proteger purchases cabecera contra cancelaciones si hay reservas incoming
create or replace function private.prevent_cancelling_reserved_purchase()
returns trigger language plpgsql as $$
begin
  if new.state = 'cancelled' and old.state <> 'cancelled' then
    if exists (
      select 1 from public.stock_reservations sr
      join public.purchase_items pi on pi.id = sr.purchase_item_id
      where pi.purchase_id = old.id and sr.state = 'active' and sr.source_type = 'incoming'
    ) then
      raise exception using errcode = 'P0001', message = 'CANNOT_CANCEL_PURCHASE_WITH_ACTIVE_RESERVATIONS';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_purchases_header on public.purchases;
create trigger trg_protect_purchases_header
before update on public.purchases for each row execute function private.prevent_cancelling_reserved_purchase();

-- B. Proteger purchase_items contra cambios de producto o baja de cantidad indebida
create or replace function private.prevent_tampering_reserved_purchases()
returns trigger language plpgsql as $$
declare
  v_active_incoming integer;
begin
  if new.product_id <> old.product_id then
    if exists (
      select 1 from public.stock_reservations 
      where purchase_item_id = old.id and state = 'active' and source_type = 'incoming'
    ) then
      raise exception using errcode = 'P0001', message = 'CANNOT_CHANGE_PRODUCT_WITH_ACTIVE_RESERVATIONS';
    end if;
  end if;

  select coalesce(sum(quantity), 0) into v_active_incoming
  from public.stock_reservations
  where purchase_item_id = old.id and state = 'active' and source_type = 'incoming';

  if new.quantity < (new.received_quantity + new.shortage_quantity + v_active_incoming) then
    raise exception using errcode = 'P0001', message = 'QUANTITY_BELOW_RESERVED_AND_FULFILLED_CAPACITY';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_purchase_items on public.purchase_items;
create trigger trg_protect_purchase_items
before update on public.purchase_items for each row execute function private.prevent_tampering_reserved_purchases();

-- C. Coherencia cruzada relacional en stock_reservations
create or replace function private.validate_reservation_coherence()
returns trigger language plpgsql as $$
declare
  v_oi_order uuid;
  v_oi_product uuid;
  v_pi_product uuid;
begin
  select order_id, product_id into v_oi_order, v_oi_product
  from public.order_items where id = new.order_item_id;

  if v_oi_order <> new.order_id or v_oi_product <> new.product_id then
    raise exception using errcode = 'P0001', message = 'RESERVATION_ORDER_ITEM_INCOHERENCE';
  end if;

  if new.purchase_item_id is not null then
    select product_id into v_pi_product
    from public.purchase_items where id = new.purchase_item_id;

    if v_pi_product <> new.product_id then
      raise exception using errcode = 'P0001', message = 'RESERVATION_PURCHASE_ITEM_PRODUCT_INCOHERENCE';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_reservation_coherence on public.stock_reservations;
create trigger trg_validate_reservation_coherence
before insert or update on public.stock_reservations for each row execute function private.validate_reservation_coherence();

-- ----------------------------------------------------------------------------
-- 5. FUNCIÓN CANÓNICA CENTRALIZADA: Capacidad Entrante Libre
-- ----------------------------------------------------------------------------
create or replace function private.product_incoming_capacity(p_product_id uuid)
returns table (
  available_incoming integer,
  first_expected_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp as $$
  with item_capacities as (
    select 
      pi.id,
      pu.expected_at,
      greatest(0, 
        pi.quantity 
        - pi.received_quantity 
        - coalesce(pi.shortage_quantity, 0)
        - coalesce((
            select sum(sr.quantity) 
            from public.stock_reservations sr 
            where sr.purchase_item_id = pi.id and sr.state = 'active' and sr.source_type = 'incoming'
          ), 0)
      ) as free_cap
    from public.purchase_items pi
    join public.purchases pu on pu.id = pi.purchase_id
    where pi.product_id = p_product_id and pu.state = 'ordered'
  )
  select 
    coalesce(sum(free_cap), 0)::integer as available_incoming,
    min(expected_at) filter (where free_cap > 0) as first_expected_at
  from item_capacities;
$$;

-- ----------------------------------------------------------------------------
-- 6. COTIZACIÓN DE PROMESA EN CHECKOUT (Simulación Read-Only por Cantidad Q)
-- ----------------------------------------------------------------------------
create or replace function public.quote_cart_eta(p_lines jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_line record;
  v_p record;
  v_phys_avail integer;
  v_remaining integer;
  v_purchase record;
  v_take integer;
  v_line_max_eta timestamptz;
  v_cart_max_eta timestamptz := null;
  v_requires_incoming boolean := false;
  v_has_unspecified_eta boolean := false;
begin
  if coalesce(jsonb_typeof(p_lines), 'null') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_CART';
  end if;

  for v_line in
    select (elem ->> 'productId')::uuid as product_id, sum((elem ->> 'quantity')::integer) as quantity
    from jsonb_array_elements(p_lines) elem
    group by (elem ->> 'productId')::uuid
  loop
    if v_line.quantity <= 0 or v_line.quantity > 1000 then
      raise exception using errcode = 'P0001', message = 'INVALID_QUANTITY';
    end if;

    select id, active, published into v_p from public.products where id = v_line.product_id;
    if not found or not v_p.active or not v_p.published then
      return jsonb_build_object('ok', false, 'error', 'PRODUCT_UNAVAILABLE');
    end if;

    select greatest(0, coalesce(sb.on_hand, 0) - coalesce(sb.reserved, 0)) into v_phys_avail
    from public.stock_balances sb where sb.product_id = v_line.product_id;

    v_remaining := greatest(0, v_line.quantity - coalesce(v_phys_avail, 0));
    v_line_max_eta := null;

    if v_remaining > 0 then
      v_requires_incoming := true;
      for v_purchase in
        select pi.id, pu.expected_at,
               greatest(0, pi.quantity - pi.received_quantity - pi.shortage_quantity - coalesce((
                 select sum(quantity) from public.stock_reservations 
                 where purchase_item_id = pi.id and state = 'active' and source_type = 'incoming'
               ), 0)) as free_cap
        from public.purchase_items pi
        join public.purchases pu on pu.id = pi.purchase_id
        where pi.product_id = v_line.product_id and pu.state = 'ordered'
        order by pu.expected_at asc nulls last, pu.ordered_at asc, pi.id asc
      loop
        if v_purchase.free_cap > 0 then
          v_take := least(v_remaining, v_purchase.free_cap);
          v_remaining := v_remaining - v_take;
          if v_purchase.expected_at is null then
            v_has_unspecified_eta := true;
          elsif v_line_max_eta is null or v_purchase.expected_at > v_line_max_eta then
            v_line_max_eta := v_purchase.expected_at;
          end if;
          if v_remaining = 0 then exit; end if;
        end if;
      end loop;

      if v_remaining > 0 then
        return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_STOCK');
      end if;

      if v_line_max_eta is not null and (v_cart_max_eta is null or v_line_max_eta > v_cart_max_eta) then
        v_cart_max_eta := v_line_max_eta;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'requiresIncoming', v_requires_incoming,
    'quotedEta', v_cart_max_eta,
    'hasUnspecifiedEta', v_has_unspecified_eta
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. CONFIRMACIÓN ATÓMICA EN PASADA ÚNICA (Anti-Deadlock + Flete + Idempotencia)
-- ----------------------------------------------------------------------------
create or replace function public.confirm_imported_order(p_order jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lines jsonb;
  v_line record;
  v_locked record;
  v_settings public.store_settings%rowtype;
  v_order_id uuid;
  v_existing_order_id uuid;
  v_order_item_id uuid;
  v_customer_id uuid;
  v_subtotal bigint := 0;
  v_cost_total bigint := 0;
  v_item_cost_total bigint := 0;
  v_shipping_fee bigint;
  v_total bigint;
  v_phys_avail integer;
  v_phys_alloc integer;
  v_remaining integer;
  v_take integer;
  v_purchase record;
  v_cap integer;
  v_customer_name text;
  v_phone text;
  v_phone_digits text;
  v_address text;
  v_checksum text;
  v_protocol_order_id uuid;
  v_payment_method public.payment_method;
  v_delivery_method public.delivery_method;
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

  -- 4. Crear Cabecera del Pedido
  insert into public.orders (
    customer_id, customer_name_snapshot, customer_phone_snapshot, payment_method, delivery_method,
    shipping_type, shipping_address, source, protocol_order_id, protocol_checksum, subtotal_cents,
    shipping_fee_cents, total_cents, tax_rate_basis_points, tax_amount_cents, cost_total_cents, created_by
  ) values (
    v_customer_id, v_customer_name, v_phone, v_payment_method, v_delivery_method,
    v_shipping_type, v_address, 'whatsapp_import', v_protocol_order_id, v_checksum, 0,
    v_shipping_fee, 0, v_settings.tax_rate_basis_points, 0, 0, auth.uid()
  ) returning id into v_order_id;

  -- 5. PASADA ÚNICA: Lock Nivel 1 (stock_balances), Creación de Items y Asignación Atómica
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
      insert into public.stock_reservations (
        order_id, order_item_id, product_id, quantity, state, source_type,
        purchase_item_id, cost_snapshot_cents
      ) values (
        v_order_id, v_order_item_id, v_line.product_id, v_phys_alloc, 'active', 'physical',
        null, v_locked.current_cost_cents
      );

      update public.stock_balances set reserved = reserved + v_phys_alloc where product_id = v_line.product_id;
      v_item_cost_total := v_item_cost_total + v_locked.current_cost_cents * v_phys_alloc;
    end if;

    -- Asignación Incoming (Compras Nivel 3)
    if v_remaining > 0 then
      for v_purchase in
        select pi.id as purchase_item_id, pi.quantity, pi.received_quantity, pi.shortage_quantity, pi.unit_cost_cents
        from public.purchase_items pi
        join public.purchases pu on pu.id = pi.purchase_id
        where pi.product_id = v_line.product_id and pu.state = 'ordered'
        order by pu.expected_at asc nulls last, pu.ordered_at asc, pi.id asc
        for update of pi
      loop
        v_cap := greatest(0, v_purchase.quantity - v_purchase.received_quantity - v_purchase.shortage_quantity - coalesce((
          select sum(quantity) from public.stock_reservations
          where purchase_item_id = v_purchase.purchase_item_id and state = 'active' and source_type = 'incoming'
        ), 0));

        if v_cap > 0 then
          v_take := least(v_remaining, v_cap);
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

  -- 6. Actualizar Totales Finales en la Orden
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

-- ----------------------------------------------------------------------------
-- 8. RECEPCIÓN DE COMPRAS: Lock Nivel 1 Previo + FIFO + Reporte Desbloqueados
-- ----------------------------------------------------------------------------
create or replace function public.receive_purchase(
  p_purchase_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_purchase public.purchases%rowtype;
  v_input_item record;
  v_pi record;
  v_qty_received integer;
  v_to_convert integer;
  v_res record;
  v_total_converted_physical integer;
  v_all_completed boolean := true;
  v_affected_order_ids uuid[] := array[]::uuid[];
  v_unblocked_orders jsonb := '[]'::jsonb;
begin
  perform private.require_owner();

  if coalesce(jsonb_typeof(p_items), 'null') <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;

  if (select count(*) <> count(distinct elem ->> 'purchaseItemId') from jsonb_array_elements(p_items) elem) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_PURCHASE_ITEM';
  end if;

  -- ANTI-DEADLOCK: Adquirir Lock Nivel 1 (stock_balances) antes de bloquear la compra
  perform 1
  from public.stock_balances sb
  where sb.product_id in (
    select pi.product_id from public.purchase_items pi where pi.purchase_id = p_purchase_id
  )
  order by sb.product_id asc
  for update;

  -- Lock Nivel 2: Purchases Cabecera
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found or v_purchase.state <> 'ordered' then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE_TRANSITION';
  end if;

  select coalesce(array_agg(distinct sr.order_id), array[]::uuid[]) into v_affected_order_ids
  from public.stock_reservations sr
  join public.purchase_items pi on pi.id = sr.purchase_item_id
  where pi.purchase_id = p_purchase_id and sr.state = 'active' and sr.source_type = 'incoming';

  for v_input_item in
    select (elem ->> 'purchaseItemId')::uuid as purchase_item_id, (elem ->> 'receivedQuantity')::integer as qty_received
    from jsonb_array_elements(p_items) elem
  loop
    v_qty_received := v_input_item.qty_received;
    if v_qty_received is null or v_qty_received <= 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_RECEIVED_QUANTITY';
    end if;

    select pi.*, p.name as product_name into v_pi
    from public.purchase_items pi
    join public.products p on p.id = pi.product_id
    where pi.id = v_input_item.purchase_item_id and pi.purchase_id = p_purchase_id
    for update;

    if not found then
      raise exception using errcode = 'P0001', message = 'PURCHASE_ITEM_NOT_FOUND';
    end if;

    if (v_pi.received_quantity + v_pi.shortage_quantity + v_qty_received) > v_pi.quantity then
      raise exception using errcode = 'P0001', message = 'RECEIVED_EXCEEDS_ORDERED_QUANTITY';
    end if;

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

    v_to_convert := v_qty_received;
    v_total_converted_physical := 0;

    -- Conversión FIFO por confirmed_at ASC, number ASC, id ASC
    for v_res in
      select sr.*
      from public.stock_reservations sr
      join public.orders o on o.id = sr.order_id
      where sr.purchase_item_id = v_pi.id and sr.state = 'active' and sr.source_type = 'incoming'
      order by o.confirmed_at asc, o.order_number asc, sr.id asc
      for update of sr
    loop
      if v_to_convert <= 0 then exit; end if;

      if v_res.quantity <= v_to_convert then
        update public.stock_reservations set source_type = 'physical' where id = v_res.id;

        insert into public.stock_movements (
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta,
          reason, order_id, created_by
        ) values (
          v_pi.product_id, v_pi.product_name, 'reservation',
          0, v_res.quantity, 'Asignación física por arribo de compra',
          v_res.order_id, auth.uid()
        );

        v_total_converted_physical := v_total_converted_physical + v_res.quantity;
        v_to_convert := v_to_convert - v_res.quantity;
      else
        -- Split atómico
        update public.stock_reservations set quantity = v_to_convert, source_type = 'physical' where id = v_res.id;

        insert into public.stock_reservations (
          order_id, order_item_id, product_id, quantity, state, source_type,
          purchase_item_id, cost_snapshot_cents, created_at
        ) values (
          v_res.order_id, v_res.order_item_id, v_res.product_id, 
          v_res.quantity - v_to_convert, 'active', 'incoming',
          v_res.purchase_item_id, v_res.cost_snapshot_cents, v_res.created_at
        );

        insert into public.stock_movements (
          product_id, product_name_snapshot, kind, physical_delta, reserved_delta,
          reason, order_id, created_by
        ) values (
          v_pi.product_id, v_pi.product_name, 'reservation',
          0, v_to_convert, 'Asignación física parcial por arribo de compra',
          v_res.order_id, auth.uid()
        );

        v_total_converted_physical := v_total_converted_physical + v_to_convert;
        v_to_convert := 0;
      end if;
    end loop;

    update public.stock_balances
    set on_hand = on_hand + v_qty_received,
        reserved = reserved + v_total_converted_physical
    where product_id = v_pi.product_id;
  end loop;

  if exists (
    select 1 from public.purchase_items
    where purchase_id = p_purchase_id and (received_quantity + shortage_quantity) < quantity
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
      and not exists (
        select 1 from public.stock_reservations sr
        where sr.order_id = o.id and sr.state = 'active' and sr.source_type <> 'physical'
      );
  end if;

  perform private.bump_revision();
  return jsonb_build_object(
    'purchase', private.purchase_payload(p_purchase_id),
    'unblockedOrders', v_unblocked_orders
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. CIERRE CON FALTANTE DEFINITIVO (Preserva Historial)
-- ----------------------------------------------------------------------------
create or replace function public.close_purchase_with_shortage(
  p_purchase_id uuid,
  p_notes text default 'Cerrado con faltante definitivo de distribuidor'
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_purchase public.purchases%rowtype;
  v_pi record;
begin
  perform private.require_owner();
  select * into v_purchase from public.purchases where id = p_purchase_id for update;
  if not found or v_purchase.state <> 'ordered' then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE_STATE';
  end if;

  for v_pi in select * from public.purchase_items where purchase_id = p_purchase_id for update loop
    -- 1. Marcar reservas sin cobertura como 'uncovered'
    update public.stock_reservations
    set source_type = 'uncovered'
    where purchase_item_id = v_pi.id and state = 'active' and source_type = 'incoming';

    -- 2. Asentar shortage_quantity sin alterar 'quantity'
    if (v_pi.received_quantity + v_pi.shortage_quantity) < v_pi.quantity then
      update public.purchase_items
      set shortage_quantity = quantity - received_quantity
      where id = v_pi.id;
    end if;
  end loop;

  update public.purchases
  set state = 'received',
      received_at = coalesce(received_at, now()),
      notes = concat_ws(' | ', notes, p_notes)
  where id = p_purchase_id;

  perform private.bump_revision();
  return jsonb_build_object(
    'purchase', private.purchase_payload(p_purchase_id),
    'unblockedOrders', '[]'::jsonb
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 10. PAYLOADS Y VISTAS ACTUALIZADAS
-- ----------------------------------------------------------------------------
-- A. private.purchase_payload: con receivedQuantity y shortageQuantity
create or replace function private.purchase_payload(p_purchase_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', p.id,
    'number', p.purchase_number,
    'supplierName', p.supplier_name,
    'state', p.state,
    'orderedAt', p.ordered_at,
    'expectedAt', p.expected_at,
    'receivedAt', p.received_at,
    'totalCostCents', p.total_cost_cents,
    'notes', p.notes,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pi.id,
        'productId', pi.product_id,
        'productName', pi.product_name_snapshot,
        'quantity', pi.quantity,
        'receivedQuantity', pi.received_quantity,
        'shortageQuantity', pi.shortage_quantity,
        'unitCostCents', pi.unit_cost_cents
      ) order by pi.created_at, pi.id)
      from public.purchase_items pi
      where pi.purchase_id = p.id
    ), '[]'::jsonb)
  )
  from public.purchases p
  where p.id = p_purchase_id;
$$;

-- B. private.order_payload: con estado derivado stockReadiness y ETA
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

-- C. private.product_payload: capacidad neta vendible
create or replace function private.product_payload(p_product_id uuid, p_include_financials boolean)
returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with capacity as (
    select 
      available_incoming,
      first_expected_at
    from private.product_incoming_capacity(p_product_id)
  )
  select jsonb_build_object(
    'id', p.id,
    'sku', p.sku,
    'slug', p.slug,
    'name', p.name,
    'presentation', p.presentation,
    'description', p.description,
    'priceCents', p.sale_price_cents,
    'imageUrl', coalesce(i.public_url, '/product-placeholder.svg'),
    'imageAlt', coalesce(i.alt_text, p.name),
    'availability', case
      when greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) > 0 then (
        case when greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) <= p.reorder_point then 'low' else 'available' end
      )
      when coalesce(c.available_incoming, 0) > 0 then 'incoming'
      else 'out_of_stock'
    end,
    'maxOrderQuantity', least(20, greatest(0, coalesce(s.on_hand, 0) - coalesce(s.reserved, 0)) + coalesce(c.available_incoming, 0)),
    'incomingAvailable', coalesce(c.available_incoming, 0),
    'incomingExpectedAt', c.first_expected_at,
    'category', p.category,
    'featured', p.featured,
    'active', p.active,
    'published', p.published,
    'reorderPoint', p.reorder_point,
    'safetyStock', p.safety_stock,
    'leadTimeDays', p.lead_time_days,
    'onHand', coalesce(s.on_hand, 0),
    'reserved', coalesce(s.reserved, 0),
    'incoming', coalesce(c.available_incoming, 0),
    'currentCostCents', case when p_include_financials then f.current_cost_cents else null end,
    'updatedAt', p.updated_at
  )
  from public.products p
  left join public.stock_balances s on s.product_id = p.id
  left join public.product_financials f on f.product_id = p.id
  left join capacity c on true
  left join lateral (
    select public_url, alt_text from public.product_images
    where product_id = p.id order by position, created_at limit 1
  ) i on true
  where p.id = p_product_id;
$$;

-- D. public.check_cart_availability: agrupación defensiva y verificación neta
create or replace function public.check_cart_availability(p_lines jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_issues jsonb;
begin
  if coalesce(jsonb_typeof(p_lines), 'null') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_CART';
  end if;

  with requested as (
    select
      (line ->> 'productId')::uuid as product_id,
      sum((line ->> 'quantity')::integer) as quantity
    from jsonb_array_elements(p_lines) line
    group by (line ->> 'productId')::uuid
  ), checked as (
    select
      r.product_id,
      coalesce(p.name, 'Producto no disponible') as product_name,
      r.quantity as requested,
      (greatest(0, coalesce(s.on_hand, 0) - coalesce(s.reserved, 0)) + coalesce(c.available_incoming, 0)) as available,
      p.id is null or not p.active or not p.published or r.quantity <= 0
      or r.quantity > (greatest(0, coalesce(s.on_hand, 0) - coalesce(s.reserved, 0)) + coalesce(c.available_incoming, 0)) as invalid
    from requested r
    left join public.products p on p.id = r.product_id
    left join public.stock_balances s on s.product_id = r.product_id
    left join lateral private.product_incoming_capacity(r.product_id) c on true
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'productId', product_id,
    'productName', product_name,
    'requested', requested,
    'available', available
  )), '[]'::jsonb)
  into v_issues
  from checked
  where invalid;

  return jsonb_build_object('ok', jsonb_array_length(v_issues) = 0, 'issues', v_issues);
end;
$$;

-- ----------------------------------------------------------------------------
-- 11. BLINDAJE EN TRANSITION_ORDER (Entrega y Cancelación)
-- ----------------------------------------------------------------------------
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

  elsif p_action = 'mark_refunded' then
    if v_order.payment_state <> 'paid' or v_order.fulfillment_state <> 'pending' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders set payment_state = 'refunded', refunded_at = now() where id = p_order_id;

  elsif p_action in ('mark_shipped', 'mark_delivered') then
    -- DEFENSA OBLIGATORIA: No se puede entregar si el pedido espera mercadería o tiene faltante
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

        -- Consumir únicamente reservas físicas
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
          case when p_action = 'mark_shipped' then 'Salida por pedido enviado' else 'Salida por pedido entregado' end,
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
          v_item.product_id, v_item.product_name_snapshot, 'return', v_item.quantity, 0,
          'Reintegro de stock por pedido cancelado', p_order_id, auth.uid()
        );
      end loop;
    elsif v_order.fulfillment_state = 'pending' then
      -- Liberación diferenciada de reservas:
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

-- ----------------------------------------------------------------------------
-- 12. ACTUALIZACIÓN DE ANALYTICS (Margen exacto por línea con cost_total_cents)
-- ----------------------------------------------------------------------------
create or replace function public.get_analytics_summary(
  p_from date,
  p_to date,
  p_include_current_month_cutoff boolean default false
)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cutoff_day integer;
  v_summary record;
  v_units integer;
  v_top_products jsonb;
  v_series jsonb;
begin
  perform private.require_owner();

  if p_from > p_to then
    raise exception using errcode = 'P0001', message = 'INVALID_DATE_RANGE';
  end if;

  if p_include_current_month_cutoff
    and date_trunc('month', p_from) <> date_trunc('month', p_to)
    and p_to < (date_trunc('month', p_to)::date + interval '1 month - 1 day')::date then
    v_cutoff_day := extract(day from p_to)::integer;
  else
    v_cutoff_day := null;
  end if;

  with paid_orders as materialized (
    select
      o.*,
      (o.paid_at at time zone 'America/Argentina/Buenos_Aires')::date as local_paid_date
    from public.orders o
    where o.payment_state = 'paid'
      and (o.paid_at at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
      and (
        v_cutoff_day is null
        or extract(day from (o.paid_at at time zone 'America/Argentina/Buenos_Aires')::date) <= v_cutoff_day
      )
  ), summary as (
    select
      coalesce(sum(total_cents), 0)::bigint as revenue_cents,
      coalesce(sum(cost_total_cents), 0)::bigint as cost_cents,
      coalesce(sum(tax_amount_cents), 0)::bigint as tax_cents,
      count(*)::integer as order_count
    from paid_orders
  ), unit_summary as (
    select coalesce(sum(oi.quantity), 0)::integer as units
    from paid_orders po
    join public.order_items oi on oi.order_id = po.id
  ), ranked_products as (
    select
      oi.product_id,
      oi.product_name_snapshot as name,
      sum(oi.quantity)::integer as units,
      sum(oi.line_subtotal_cents)::bigint as revenue_cents,
      sum(
        oi.line_subtotal_cents
        - oi.cost_total_cents -- Consumo de costo exacto de línea
        - case
            when po.total_cents > 0
              then round(po.tax_amount_cents * oi.line_subtotal_cents::numeric / po.total_cents)::bigint
            else 0
          end
      )::bigint as estimated_margin_cents
    from paid_orders po
    join public.order_items oi on oi.order_id = po.id
    group by oi.product_id, oi.product_name_snapshot
    order by units desc, revenue_cents desc, name
    limit 10
  ), top_products as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', product_id,
      'name', name,
      'units', units,
      'revenueCents', revenue_cents,
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
        sum(po.total_cents)::bigint as revenue_cents,
        count(*)::integer as order_count,
        sum(coalesce(u.units, 0))::integer as units
      from paid_orders po
      left join lateral (
        select sum(oi.quantity)::integer as units
        from public.order_items oi where oi.order_id = po.id
      ) u on true
      where date_trunc('month', po.local_paid_date) = m.month_start
    ) m_orders on true
  )
  select s.* into v_summary from summary s;
  select us.units into v_units from unit_summary us;
  select tp.payload into v_top_products from top_products tp;
  select sr.payload into v_series from series sr;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'comparisonCutoffDay', v_cutoff_day,
    'revenueCents', v_summary.revenue_cents,
    'costCents', v_summary.cost_cents,
    'taxCents', v_summary.tax_cents,
    'estimatedMarginCents', greatest(0, v_summary.revenue_cents - v_summary.cost_cents - v_summary.tax_cents),
    'averageTicketCents', case when v_summary.order_count > 0 then round(v_summary.revenue_cents::numeric / v_summary.order_count)::bigint else 0 end,
    'orders', v_summary.order_count,
    'units', coalesce(v_units, 0),
    'series', v_series,
    'topProducts', v_top_products
  );
end;
$$;
