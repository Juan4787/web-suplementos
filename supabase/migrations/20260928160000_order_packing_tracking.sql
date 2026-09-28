-- El armado es una ubicación operativa de unidades ya reservadas. No genera movimientos de stock.
-- Las líneas anteriores a esta migración quedan NULL: su contenido físico no puede inferirse.
alter table public.order_items add column packed_quantity integer;
alter table public.order_items add constraint order_items_packed_quantity_check
  check (packed_quantity is null or packed_quantity between 0 and quantity);

alter table public.orders add column packing_revision integer not null default 0
  check (packing_revision >= 0);

create index order_packing_active_reservations_idx
  on public.stock_reservations(order_item_id, source_type)
  where state = 'active';

create table public.order_packing_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  previous_quantity integer,
  new_quantity integer not null check (new_quantity >= 0),
  changed_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create index order_packing_events_order_idx on public.order_packing_events(order_id, id);
alter table public.order_packing_events enable row level security;
create policy order_packing_events_owner_read on public.order_packing_events
  for select to authenticated using (private.is_owner());
revoke all on public.order_packing_events from public, anon, authenticated;
grant select on public.order_packing_events to authenticated;

-- Refuerza todas las vías de salida: listo, enviado, entregado y regalo.
-- Sin un registro explícito, el contenido de cualquier bolsita es desconocido.
-- Esto permite desplegar la base antes que la interfaz sin bloquear sesiones ya abiertas.
create or replace function private.guard_order_packing_transition()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.order_state <> 'cancelled' and new.order_state = 'cancelled'
     and exists (
       select 1 from public.order_items oi
       where oi.order_id = old.id and oi.packed_quantity > 0
     ) then
    raise exception using errcode = 'P0001', message = 'CANNOT_CANCEL_PACKED_ORDER';
  end if;

  if old.fulfillment_state = 'pending' and new.order_state = 'confirmed' and (
    (old.preparation_state <> 'ready' and new.preparation_state = 'ready')
    or new.fulfillment_state in ('shipped', 'delivered')
  ) and exists (
    select 1 from public.order_items oi
    where oi.order_id = old.id and oi.packed_quantity is not null
  ) and exists (
    select 1 from public.order_items oi
    where oi.order_id = old.id and oi.packed_quantity is distinct from oi.quantity
  ) then
    raise exception using errcode = 'P0001', message = 'ORDER_PACKING_INCOMPLETE';
  end if;
  return new;
end;
$$;

create trigger guard_order_packing_transition
before update on public.orders
for each row execute function private.guard_order_packing_transition();
revoke all on function private.guard_order_packing_transition() from public, anon, authenticated;

-- Una reserva física comprometida en una bolsita no puede desaparecer mientras
-- el pedido siga pendiente. El chequeo diferido observa el estado final de la
-- transacción: entregar o cancelar una orden sí resuelve sus reservas.
create or replace function private.guard_packed_reservation_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids uuid[];
  v_item_id uuid;
  v_packed integer;
  v_physical integer;
begin
  if tg_op = 'INSERT' then
    v_ids := array[new.order_item_id];
  elsif tg_op = 'DELETE' then
    v_ids := array[old.order_item_id];
  else
    v_ids := array[old.order_item_id, new.order_item_id];
  end if;
  for v_item_id in select distinct id from unnest(v_ids) as id where id is not null loop
    select oi.packed_quantity into v_packed
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.id = v_item_id and o.order_state = 'confirmed' and o.fulfillment_state = 'pending';
    if coalesce(v_packed, 0) > 0 then
      select coalesce(sum(sr.quantity), 0)::integer into v_physical
      from public.stock_reservations sr
      where sr.order_item_id = v_item_id and sr.state = 'active' and sr.source_type = 'physical';
      if v_packed > v_physical then
        raise exception using errcode = 'P0001', message = 'PACKED_RESERVATION_CHANGED';
      end if;
    end if;
  end loop;
  return null;
end;
$$;

create constraint trigger guard_packed_reservation_change
after insert or update or delete on public.stock_reservations
deferrable initially deferred
for each row execute function private.guard_packed_reservation_change();
revoke all on function private.guard_packed_reservation_change() from public, anon, authenticated;

-- Una escritura atómica del pedido completo evita que un pedido histórico quede
-- parcialmente conciliado y permite detectar dos operadores editando a la vez.
create or replace function public.save_order_packing(
  p_order_id uuid,
  p_items jsonb,
  p_expected_revision integer
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order public.orders%rowtype;
  v_entry jsonb;
  v_item public.order_items%rowtype;
  v_item_id uuid;
  v_seen uuid[] := '{}'::uuid[];
  v_quantity integer;
  v_physical integer;
  v_changed boolean := false;
  v_all_full boolean;
  v_any_packed boolean;
begin
  perform private.require_active_user();
  if p_order_id is null or p_expected_revision is null
     or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER_PACKING';
  end if;

  -- Mismo orden de bloqueos que confirmación, recepción y transición de pedidos.
  perform 1 from public.products p
  join public.order_items oi on oi.product_id = p.id
  join public.stock_balances sb on sb.product_id = p.id
  where oi.order_id = p_order_id
  order by p.id for update of p, sb;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ORDER_NOT_FOUND';
  end if;
  if v_order.order_state <> 'confirmed' or v_order.fulfillment_state <> 'pending' then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER_PACKING_STATE';
  end if;
  if v_order.packing_revision <> p_expected_revision then
    raise exception using errcode = 'P0001', message = 'ORDER_PACKING_CHANGED';
  end if;

  perform 1 from public.order_items where order_id = p_order_id order by id for update;
  if jsonb_array_length(p_items) <> (select count(*) from public.order_items where order_id = p_order_id) then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER_PACKING';
  end if;

  for v_entry in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_entry) <> 'object'
       or jsonb_typeof(v_entry -> 'orderItemId') <> 'string'
       or jsonb_typeof(v_entry -> 'packedQuantity') <> 'number'
       or coalesce(v_entry ->> 'packedQuantity', '') !~ '^(0|[1-9][0-9]*)$' then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER_PACKING';
    end if;
    v_item_id := (v_entry ->> 'orderItemId')::uuid;
    if v_item_id = any(v_seen) then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER_PACKING';
    end if;
    v_seen := array_append(v_seen, v_item_id);
    v_quantity := (v_entry ->> 'packedQuantity')::integer;
    select * into v_item from public.order_items
    where id = v_item_id and order_id = p_order_id;
    if not found then
      raise exception using errcode = 'P0001', message = 'INVALID_ORDER_PACKING';
    end if;
    select coalesce(sum(sr.quantity), 0)::integer into v_physical
    from public.stock_reservations sr
    where sr.order_item_id = v_item_id and sr.state = 'active' and sr.source_type = 'physical';
    if v_quantity > v_item.quantity or v_quantity > v_physical then
      raise exception using errcode = 'P0001', message = 'PACKING_EXCEEDS_PHYSICAL_RESERVATION';
    end if;
    if v_item.packed_quantity is distinct from v_quantity then
      update public.order_items set packed_quantity = v_quantity where id = v_item_id;
      insert into public.order_packing_events(
        order_id, order_item_id, previous_quantity, new_quantity, changed_by
      ) values (p_order_id, v_item_id, v_item.packed_quantity, v_quantity, auth.uid());
      v_changed := true;
    end if;
  end loop;

  if not v_changed then
    return private.order_payload(p_order_id, private.is_owner());
  end if;
  select bool_and(packed_quantity = quantity), bool_or(packed_quantity > 0)
  into v_all_full, v_any_packed from public.order_items where order_id = p_order_id;
  update public.orders set
    packing_revision = packing_revision + 1,
    preparation_state = case
      when preparation_state = 'ready' and v_all_full then 'ready'::public.preparation_state
      when v_any_packed then 'preparing'::public.preparation_state
      else 'pending'::public.preparation_state
    end
  where id = p_order_id;
  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER_PACKING';
end;
$$;
revoke all on function public.save_order_packing(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.save_order_packing(uuid, jsonb, integer) to authenticated;

create or replace function public.list_product_reservations(p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform private.require_active_user();
  if p_product_id is null or not exists (select 1 from public.products where id = p_product_id) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'orderId', o.id,
      'orderNumber', o.order_number,
      'physicalQuantity', r.physical_quantity,
      'packedQuantity', oi.packed_quantity,
      'preparationState', o.preparation_state,
      'paymentState', o.payment_state
    ) order by o.created_at, o.id), '[]'::jsonb)
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join lateral (
      select sum(sr.quantity)::integer as physical_quantity
      from public.stock_reservations sr
      where sr.order_item_id = oi.id and sr.state = 'active' and sr.source_type = 'physical'
    ) r on r.physical_quantity > 0
    where oi.product_id = p_product_id
      and o.order_state = 'confirmed' and o.fulfillment_state = 'pending'
  );
end;
$$;
revoke all on function public.list_product_reservations(uuid) from public, anon, authenticated;
grant execute on function public.list_product_reservations(uuid) to authenticated;

-- Mismo contrato de pedido para Pedidos, clientes, panel, exportación y respuesta de mutaciones.
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
        'subtotalCents', oi.line_subtotal_cents
      ) order by oi.created_at, oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  ) from public.orders o where o.id = p_order_id;
$$;

create or replace function public.search_orders(
  p_page integer default 1,
  p_page_size integer default 20,
  p_search text default '',
  p_state text default 'all'
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_owner boolean;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_phone text := regexp_replace(v_search, '[^0-9]', '', 'g');
  v_result jsonb;
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  if p_state is null or p_state not in ('all', 'pending', 'completed', 'preparing', 'ready_pickup')
     or char_length(v_search) > 200 then
    raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
  end if;
  with matched as materialized (
    select o.id, o.created_at, o.order_state, o.fulfillment_state,
      o.preparation_state, o.delivery_method,
      (o.order_state = 'cancelled' or
       (o.fulfillment_state = 'delivered' and o.payment_state in ('paid', 'gifted'))) completed
    from public.orders o
    where v_search = ''
      or position(v_search in lower(o.customer_name_snapshot)) > 0
      or position(v_search in o.order_number::text) > 0
      or (char_length(v_phone) >= 3 and position(v_phone in regexp_replace(coalesce(o.customer_phone_snapshot, ''), '[^0-9]', '', 'g')) > 0)
  ), selected as (
    select * from matched m where
      p_state = 'all'
      or (p_state = 'pending' and not m.completed)
      or (p_state = 'completed' and m.completed)
      or (p_state = 'preparing' and m.order_state = 'confirmed' and m.fulfillment_state = 'pending' and m.preparation_state = 'preparing')
      or (p_state = 'ready_pickup' and m.order_state = 'confirmed' and m.fulfillment_state = 'pending'
          and m.preparation_state = 'ready' and m.delivery_method = 'pickup')
  ), page_rows as (
    select * from selected order by created_at desc, id desc
    limit v_size offset (v_page::bigint - 1) * v_size
  )
  select jsonb_build_object(
    'items', (select coalesce(jsonb_agg(private.order_payload(id, v_owner) order by created_at desc, id desc), '[]'::jsonb) from page_rows),
    'page', v_page,
    'pageSize', v_size,
    'total', (select count(*) from selected),
    'pendingTotal', (select count(*) from matched where not completed),
    'completedTotal', (select count(*) from matched where completed),
    'preparingTotal', (select count(*) from matched where order_state = 'confirmed' and fulfillment_state = 'pending' and preparation_state = 'preparing'),
    'readyPickupTotal', (select count(*) from matched where order_state = 'confirmed' and fulfillment_state = 'pending' and preparation_state = 'ready' and delivery_method = 'pickup')
  ) into v_result;
  return v_result;
end;
$$;
