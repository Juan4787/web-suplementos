-- Additive, backward compatible: existing orders and their amounts are preserved.
-- All amounts are stored in integer cents. New shipping inputs use whole pesos.
alter table public.orders
  add column stock_source text not null default 'normal' check (stock_source in ('normal', 'incoming_only')),
  add column shipping_fee_method text not null default 'catalog' check (shipping_fee_method in ('catalog', 'manual', 'percentage')),
  add column shipping_fee_basis_points integer check (shipping_fee_basis_points between 0 and 10000),
  add column shipping_fee_cost_base_cents bigint check (shipping_fee_cost_base_cents >= 0),
  add column shipping_fee_revision integer not null default 0 check (shipping_fee_revision >= 0),
  add constraint shipping_fee_method_consistent check (
    (shipping_fee_method = 'percentage' and shipping_fee_basis_points is not null and shipping_fee_cost_base_cents is not null)
    or (shipping_fee_method <> 'percentage' and shipping_fee_basis_points is null and shipping_fee_cost_base_cents is null)
  );

alter table public.purchase_receipts
  add column shipping_cost_cents bigint not null default 0 check (shipping_cost_cents between 0 and 99999999900 and shipping_cost_cents % 100 = 0),
  add column shipping_expense_id uuid references public.misc_expenses(id) on delete restrict;
alter table public.misc_expenses
  add column purchase_receipt_operation_id uuid unique references public.purchase_receipts(operation_id) on delete restrict,
  add constraint receipt_expense_is_once check (purchase_receipt_operation_id is null or (frequency = 'once' and ends_on is null and amount_cents % 100 = 0));

create table public.order_shipping_fee_events (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  order_id uuid not null references public.orders(id) on delete restrict,
  input_payload jsonb not null,
  previous_payload jsonb not null,
  current_payload jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index order_shipping_fee_events_order_idx on public.order_shipping_fee_events(order_id, created_at);
alter table public.order_shipping_fee_events enable row level security;
create policy order_shipping_fee_events_owner_read on public.order_shipping_fee_events
  for select to authenticated using (private.is_owner());
revoke all on public.order_shipping_fee_events from public, anon, authenticated;
grant select on public.order_shipping_fee_events to authenticated;

create or replace function private.shipping_fee_snapshot(p_order public.orders)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('amountCents', p_order.shipping_fee_cents,
    'method', p_order.shipping_fee_method, 'basisPoints', p_order.shipping_fee_basis_points,
    'costBaseCents', p_order.shipping_fee_cost_base_cents, 'revision', p_order.shipping_fee_revision);
$$;

create or replace function private.guard_shipping_fee_payment()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.payment_state <> 'pending' and (
    new.shipping_fee_cents is distinct from old.shipping_fee_cents
    or new.shipping_fee_method is distinct from old.shipping_fee_method
    or new.shipping_fee_basis_points is distinct from old.shipping_fee_basis_points
    or new.shipping_fee_cost_base_cents is distinct from old.shipping_fee_cost_base_cents
  ) then
    raise exception using errcode = 'P0001', message = 'SHIPPING_FEE_LOCKED';
  end if;
  if new.payment_state = 'paid' and old.payment_state = 'pending'
    and new.shipping_fee_method = 'percentage' and new.shipping_fee_basis_points > 0
    and new.shipping_fee_cost_base_cents is distinct from new.cost_total_cents
  then
    raise exception using errcode = 'P0001', message = 'SHIPPING_FEE_COST_CHANGED';
  end if;
  return new;
end;
$$;
create trigger orders_shipping_fee_payment_guard before update on public.orders
for each row execute function private.guard_shipping_fee_payment();

create or replace function public.save_order_shipping_fee(p_fee jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order_id uuid := nullif(p_fee ->> 'orderId', '')::uuid;
  v_operation_id uuid := nullif(p_fee ->> 'operationId', '')::uuid;
  v_method text := p_fee ->> 'method';
  v_revision integer;
  v_amount bigint;
  v_basis_points integer;
  v_expected_cost bigint;
  v_before public.orders%rowtype;
  v_after public.orders%rowtype;
  v_event public.order_shipping_fee_events%rowtype;
begin
  perform private.require_owner();
  if v_order_id is null or v_operation_id is null or v_method is null
    or v_method not in ('manual', 'percentage')
    or coalesce(p_fee ->> 'expectedRevision', '') !~ '^[0-9]+$'
  then raise exception using errcode = 'P0001', message = 'INVALID_SHIPPING_FEE'; end if;
  v_revision := (p_fee ->> 'expectedRevision')::integer;
  -- Exact request matching also covers changed costs and optimistic revisions.
  perform pg_advisory_xact_lock(hashtextextended(v_operation_id::text, 1));
  select * into v_event from public.order_shipping_fee_events where operation_id = v_operation_id;
  if found then
    if v_event.order_id <> v_order_id or v_event.input_payload <> p_fee then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
    end if;
    return private.order_payload(v_order_id, true);
  end if;
  select * into v_before from public.orders where id = v_order_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  if v_before.order_state = 'cancelled' or v_before.payment_state <> 'pending' or v_before.sale_type = 'gift' then
    raise exception using errcode = 'P0001', message = 'SHIPPING_FEE_LOCKED';
  end if;
  if v_before.shipping_fee_revision <> v_revision then
    raise exception using errcode = 'P0001', message = 'SHIPPING_FEE_CHANGED';
  end if;
  if v_method = 'manual' then
    if coalesce(p_fee ->> 'amountCents', '') !~ '^[0-9]+$' then
      raise exception using errcode = 'P0001', message = 'INVALID_SHIPPING_FEE';
    end if;
    v_amount := (p_fee ->> 'amountCents')::bigint;
  else
    if coalesce(p_fee ->> 'basisPoints', '') !~ '^[0-9]+$'
      or coalesce(p_fee ->> 'expectedCostCents', '') !~ '^[0-9]+$'
    then raise exception using errcode = 'P0001', message = 'INVALID_SHIPPING_FEE'; end if;
    v_basis_points := (p_fee ->> 'basisPoints')::integer;
    v_expected_cost := (p_fee ->> 'expectedCostCents')::bigint;
    if v_basis_points not between 0 and 10000 then
      raise exception using errcode = 'P0001', message = 'INVALID_SHIPPING_FEE';
    end if;
    if v_expected_cost is distinct from v_before.cost_total_cents then
      raise exception using errcode = 'P0001', message = 'SHIPPING_FEE_COST_CHANGED';
    end if;
    v_amount := round(v_before.cost_total_cents::numeric * v_basis_points / 1000000)::bigint * 100;
  end if;
  if v_amount not between 0 and 99999999900 or v_amount % 100 <> 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_SHIPPING_FEE';
  end if;
  update public.orders set
    shipping_fee_cents = v_amount,
    shipping_fee_method = v_method,
    shipping_fee_basis_points = v_basis_points,
    shipping_fee_cost_base_cents = v_expected_cost,
    shipping_fee_revision = shipping_fee_revision + 1,
    total_cents = subtotal_cents + v_amount,
    tax_amount_cents = case when sale_type = 'cost' then 0 else
      round((subtotal_cents + v_amount)::numeric * tax_rate_basis_points / 10000)::bigint end
  where id = v_order_id returning * into v_after;
  insert into public.order_shipping_fee_events(operation_id, order_id, input_payload, previous_payload, current_payload, created_by)
  values(v_operation_id, v_order_id, p_fee, private.shipping_fee_snapshot(v_before), private.shipping_fee_snapshot(v_after), auth.uid());
  perform private.bump_revision();
  return private.order_payload(v_order_id, true);
exception when invalid_text_representation or numeric_value_out_of_range or not_null_violation then
  raise exception using errcode = 'P0001', message = 'INVALID_SHIPPING_FEE';
end;
$$;
revoke all on function public.save_order_shipping_fee(jsonb) from public, anon, authenticated;
grant execute on function public.save_order_shipping_fee(jsonb) to authenticated;


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
  v_stock_source text := coalesce(p_order ->> 'stockSource', 'normal');
begin
  perform private.require_active_user();
  if v_stock_source not in ('normal', 'incoming_only') then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;
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

  if v_is_gift or v_is_cost then perform private.require_owner(); end if;

  -- Idempotencia
  if v_protocol_order_id is not null then
    perform pg_advisory_xact_lock(hashtext(v_protocol_order_id::text));

    select id, protocol_checksum, customer_name_snapshot, customer_phone_snapshot,
           payment_method, delivery_method, shipping_type, shipping_address,
           shipping_fee_cents, subtotal_cents, total_cents, sale_type, stock_source
    into v_existing_order
    from public.orders
    where protocol_order_id = v_protocol_order_id
    limit 1;

    if v_existing_order.id is not null then
      -- La misma clave solo puede recuperar exactamente el pedido original.
      -- Comparar también cuando el cliente editó WhatsApp: el checksum no es
      -- una firma y puede seguir igual aunque el contenido cambie.
      if v_existing_order.customer_name_snapshot is distinct from v_customer_name
         or v_existing_order.customer_phone_snapshot is distinct from v_phone
         or v_existing_order.payment_method is distinct from v_payment_method
         or v_existing_order.delivery_method is distinct from v_delivery_method
         or v_existing_order.shipping_type is distinct from v_shipping_type
         or v_existing_order.shipping_address is distinct from v_address
         or v_existing_order.shipping_fee_cents is distinct from v_shipping_fee
         or v_existing_order.stock_source <> v_stock_source
         or coalesce(v_existing_order.sale_type, 'retail') <> v_sale_type
         or v_existing_order.protocol_checksum is distinct from nullif(v_checksum, '')
      then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      if not v_is_gift and not v_is_cost and (
        v_existing_order.subtotal_cents is distinct from (p_order ->> 'quotedSubtotalCents')::bigint
        or v_existing_order.total_cents is distinct from (p_order ->> 'quotedTotalCents')::bigint
      ) then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      if (select count(*) from public.order_items where order_id = v_existing_order.id) <> jsonb_array_length(v_lines)
         or exists (
           select 1 from jsonb_array_elements(v_lines) line
           where not exists (
             select 1 from public.order_items oi
             where oi.order_id = v_existing_order.id
               and oi.product_id = (line ->> 'productId')::uuid
               and oi.quantity = (line ->> 'quantity')::integer
               and (v_is_gift or v_is_cost or oi.unit_price_cents = (line ->> 'unitPriceCents')::bigint)
           )
         )
      then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSE_MISMATCH';
      end if;

      -- El reintento conserva la idempotencia, pero la interfaz debe poder
      -- distinguirlo de una reserva nueva para no mostrar un éxito engañoso.
      return jsonb_set(private.order_payload(v_existing_order.id, private.is_owner()), '{alreadyImported}', 'true'::jsonb);
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
    payment_state, paid_at, sale_type, stock_source
  ) values (
    v_customer_id, v_customer_name, v_customer_first_name, v_customer_last_name,
    v_phone, v_payment_method, v_delivery_method,
    v_shipping_type, v_address, v_source, v_protocol_order_id, v_checksum, v_subtotal,
    v_shipping_fee, v_total, v_settings.tax_rate_basis_points,
    case when v_is_gift or v_is_cost then 0 else round(v_total * v_settings.tax_rate_basis_points / 10000.0)::bigint end,
    0, auth.uid(),
    case when v_is_gift then 'gifted'::public.payment_state else 'pending'::public.payment_state end,
    case when v_is_gift then now() else null end,
    v_sale_type, v_stock_source
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

    if not found or not v_locked.active then
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
    v_phys_alloc := case when v_stock_source = 'incoming_only' then 0 else least(v_line.quantity, v_phys_avail) end;
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
      raise exception using errcode = 'P0001', message = case when v_stock_source = 'incoming_only' then 'INSUFFICIENT_INCOMING_STOCK' else 'INSUFFICIENT_STOCK' end;
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

drop function public.receive_purchase(uuid, jsonb, uuid);
create or replace function public.receive_purchase(
  p_purchase_id uuid,
  p_items jsonb,
  p_operation_id uuid default null,
  p_shipping_cost_cents bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  v_shipping_expense public.misc_expenses%rowtype;
begin
  perform private.require_owner();
  if p_shipping_cost_cents is null or p_shipping_cost_cents not between 0 and 99999999900 or p_shipping_cost_cents % 100 <> 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_SHIPPING_FEE';
  end if;
  p_operation_id := coalesce(p_operation_id, gen_random_uuid());
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 2));

  if coalesce(jsonb_typeof(p_items), 'null') <> 'array' or (jsonb_array_length(p_items) = 0 and p_shipping_cost_cents = 0) then
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
    select purchase_id, items_payload, result_payload, shipping_cost_cents
    into v_existing_receipt
    from public.purchase_receipts
    where operation_id = p_operation_id;

    if found then
      if v_existing_receipt.purchase_id <> p_purchase_id or v_existing_receipt.items_payload <> v_canonical_items or v_existing_receipt.shipping_cost_cents <> p_shipping_cost_cents then
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
    select purchase_id, items_payload, result_payload, shipping_cost_cents
    into v_existing_receipt
    from public.purchase_receipts
    where operation_id = p_operation_id;

    if found then
      if v_existing_receipt.purchase_id <> p_purchase_id or v_existing_receipt.items_payload <> v_canonical_items or v_existing_receipt.shipping_cost_cents <> p_shipping_cost_cents then
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

  if p_shipping_cost_cents > 0 then
    insert into public.misc_expenses(operation_id, title, amount_cents, frequency, starts_on, created_by, updated_by, purchase_receipt_operation_id)
    values(gen_random_uuid(), 'Envío de proveedor · Compra #' || v_purchase.purchase_number,
      p_shipping_cost_cents, 'once', (now() at time zone 'America/Argentina/Buenos_Aires')::date,
      auth.uid(), auth.uid(), p_operation_id) returning * into v_shipping_expense;
    insert into public.misc_expense_audit(expense_id, action, before_snapshot, after_snapshot, changed_at, changed_by)
    values(v_shipping_expense.id, 'created', null, to_jsonb(v_shipping_expense), v_shipping_expense.updated_at, auth.uid());
    v_res_obj := v_res_obj || jsonb_build_object('shippingExpense', private.misc_expense_payload(v_shipping_expense.id));
  else
    v_res_obj := v_res_obj || jsonb_build_object('shippingExpense', null);
  end if;
  update public.purchase_receipts set shipping_cost_cents = p_shipping_cost_cents,
    shipping_expense_id = v_shipping_expense.id, result_payload = v_res_obj where operation_id = p_operation_id;
  return v_res_obj;
end;
$$;
revoke all on function public.receive_purchase(uuid,jsonb,uuid,bigint) from public,anon,authenticated;
grant execute on function public.receive_purchase(uuid,jsonb,uuid,bigint) to authenticated;

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

create or replace function private.misc_expense_payload(p_expense_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', expense.id,
    'operationId', expense.operation_id,
    'title', expense.title,
    'amountCents', expense.amount_cents,
    'frequency', expense.frequency,
    'startsOn', expense.starts_on,
    'endsOn', expense.ends_on,
    'createdAt', expense.created_at,
    'updatedAt', expense.updated_at,
    'deletedAt', expense.deleted_at,
    'createdByName', coalesce(creator.display_name, 'Usuario'),
    'updatedByName', coalesce(editor.display_name, 'Usuario'),
    'purchaseReceiptOperationId', expense.purchase_receipt_operation_id,
    'purchaseId', receipt.purchase_id,
    'purchaseNumber', purchase.purchase_number
  )
  from public.misc_expenses expense
  left join public.purchase_receipts receipt on receipt.operation_id = expense.purchase_receipt_operation_id
  left join public.purchases purchase on purchase.id = receipt.purchase_id
  left join public.store_users creator on creator.user_id = expense.created_by
  left join public.store_users editor on editor.user_id = expense.updated_by
  where expense.id = p_expense_id;
$$;

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
    if v_order.order_state = 'cancelled' then
      return private.order_payload(p_order_id, private.is_owner());
    end if;

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
    end if;

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

revoke all on function private.shipping_fee_snapshot(public.orders) from public,anon,authenticated;
revoke all on function private.guard_shipping_fee_payment() from public,anon,authenticated;
-- Validate the reviewed payment snapshot under the same canonical stock locks
-- as transition_order; a second screen cannot change the amount being accepted.
create or replace function public.transition_order_checked(
  p_order_id uuid, p_action text, p_expected_fee_revision integer,
  p_expected_total_cents bigint, p_expected_cost_cents bigint
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order public.orders%rowtype;
begin
  perform private.require_active_user();
  if p_action is null or p_action not in ('mark_paid','mark_at_cost','mark_gifted') or p_expected_fee_revision is null
    or p_expected_total_cents is null or p_expected_total_cents < 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
  end if;
  if p_action in ('mark_at_cost','mark_gifted') then perform private.require_owner(); end if;
  perform 1 from public.products p join public.stock_balances sb on sb.product_id = p.id
  where p.id in (select product_id from public.order_items where order_id = p_order_id)
  order by p.id for update of p, sb;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND'; end if;
  -- Replaying a completed gift is a read, even though clearing its shipping
  -- charge advanced the fee revision during the first successful operation.
  if p_action = 'mark_gifted' and v_order.payment_state = 'gifted' and v_order.order_state <> 'cancelled' then
    return private.order_payload(p_order_id, private.is_owner());
  end if;
  if v_order.shipping_fee_revision <> p_expected_fee_revision
    or (v_order.payment_state = 'pending' and v_order.total_cents <> p_expected_total_cents)
    or (p_action in ('mark_at_cost','mark_gifted') and v_order.cost_total_cents is distinct from p_expected_cost_cents)
  then raise exception using errcode = 'P0001', message = 'ORDER_PAYMENT_AMOUNT_CHANGED'; end if;
  return public.transition_order(p_order_id, p_action);
end;
$$;
revoke all on function public.transition_order_checked(uuid,text,integer,bigint,bigint) from public,anon,authenticated;
grant execute on function public.transition_order_checked(uuid,text,integer,bigint,bigint) to authenticated;
notify pgrst, 'reload schema';
