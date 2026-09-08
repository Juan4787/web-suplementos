-- Migration: 20260907280000_purchases_and_movements_search.sql
-- Serie 7: Búsqueda y filtros autoritativos de compras y movimientos, y consolidación de líneas de compra.

-- Eliminar firmas viejas para evitar colisión de sobrecargas con valores por defecto
drop function if exists public.list_purchases(integer, integer);
drop function if exists public.list_stock_movements(integer, integer);

-- 1. Actualizar list_purchases con soporte de filtro de estado y contadores globales
create or replace function public.list_purchases(
  p_page integer default 1,
  p_page_size integer default 20,
  p_state text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_state_filter public.purchase_state;
  v_total bigint;
  v_pending_total bigint;
  v_received_total bigint;
  v_filtered_total bigint;
  v_items jsonb;
begin
  perform private.require_owner();

  if p_state is not null and p_state <> '' and p_state <> 'all' then
    begin
      v_state_filter := p_state::public.purchase_state;
    exception when others then
      v_state_filter := null;
    end;
  end if;

  select count(*) into v_total from public.purchases;
  select count(*) into v_pending_total from public.purchases where state = 'ordered';
  select count(*) into v_received_total from public.purchases where state = 'received';

  select count(*) into v_filtered_total
  from public.purchases p
  where (v_state_filter is null or p.state = v_state_filter);

  select coalesce(jsonb_agg(private.purchase_payload(id) order by created_at desc, id desc), '[]'::jsonb)
  into v_items
  from (
    select id, created_at
    from public.purchases p
    where (v_state_filter is null or p.state = v_state_filter)
    order by created_at desc, id desc
    limit v_page_size
    offset (v_page - 1) * v_page_size
  ) purchase_page;

  return jsonb_build_object(
    'items', v_items,
    'page', v_page,
    'pageSize', v_page_size,
    'total', v_total,
    'pendingTotal', v_pending_total,
    'receivedTotal', v_received_total,
    'filteredTotal', v_filtered_total
  );
end;
$$;

revoke all on function public.list_purchases(integer, integer, text) from public, anon, authenticated;
grant execute on function public.list_purchases(integer, integer, text) to authenticated;


-- 2. Actualizar list_stock_movements con búsqueda global y filtro de categoría
create or replace function public.list_stock_movements(
  p_page integer default 1,
  p_page_size integer default 30,
  p_search text default null,
  p_filter text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_filter text := nullif(btrim(coalesce(p_filter, '')), '');
  v_total bigint;
  v_items jsonb;
begin
  perform private.require_active_user();

  select count(*) into v_total
  from public.stock_movements sm
  left join public.store_users su on su.user_id = sm.created_by
  where
    (
      v_search is null
      or sm.product_name_snapshot ilike ('%' || v_search || '%')
      or sm.reason ilike ('%' || v_search || '%')
      or coalesce(su.display_name, '') ilike ('%' || v_search || '%')
    )
    and (
      v_filter is null
      or v_filter = 'all'
      or (v_filter = 'sales' and sm.kind in ('sale', 'reservation', 'reservation_release'))
      or (v_filter = 'purchases' and sm.kind = 'purchase_received')
      or (v_filter = 'adjustments' and sm.kind in ('adjustment', 'return'))
    );

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
    'createdByName', coalesce(su.display_name, 'Usuario')
  ) order by movement.created_at desc, movement.id desc), '[]'::jsonb)
  into v_items
  from (
    select sm.*
    from public.stock_movements sm
    left join public.store_users su on su.user_id = sm.created_by
    where
      (
        v_search is null
        or sm.product_name_snapshot ilike ('%' || v_search || '%')
        or sm.reason ilike ('%' || v_search || '%')
        or coalesce(su.display_name, '') ilike ('%' || v_search || '%')
      )
      and (
        v_filter is null
        or v_filter = 'all'
        or (v_filter = 'sales' and sm.kind in ('sale', 'reservation', 'reservation_release'))
        or (v_filter = 'purchases' and sm.kind = 'purchase_received')
        or (v_filter = 'adjustments' and sm.kind in ('adjustment', 'return'))
      )
    order by sm.created_at desc, sm.id desc
    limit v_page_size
    offset (v_page - 1) * v_page_size
  ) movement
  left join public.store_users su on su.user_id = movement.created_by;

  return jsonb_build_object(
    'items', v_items,
    'page', v_page,
    'pageSize', v_page_size,
    'total', v_total
  );
end;
$$;

revoke all on function public.list_stock_movements(integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.list_stock_movements(integer, integer, text, text) to authenticated;


-- 3. Actualizar create_purchase para consolidar líneas duplicadas automáticamente
create or replace function public.create_purchase(p_purchase jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_items jsonb;
  v_consolidated_items jsonb;
  v_line record;
  v_product record;
  v_purchase_id uuid;
  v_supplier_name text;
  v_expected_at timestamptz;
  v_notes text;
  v_total bigint := 0;
begin
  perform private.require_owner();
  v_items := p_purchase -> 'items';
  if coalesce(jsonb_typeof(v_items), 'null') <> 'array' then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;
  if jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

  -- Consolidar automáticamente líneas duplicadas del mismo producto:
  -- Agrupa por productId, suma cantidades y calcula el costo ponderado
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'productId', sub.product_id,
        'quantity', sub.total_qty,
        'unitCostCents', sub.avg_cost
      )
    ),
    '[]'::jsonb
  )
  into v_consolidated_items
  from (
    select
      (item ->> 'productId')::uuid as product_id,
      sum((item ->> 'quantity')::integer) as total_qty,
      round(
        sum((item ->> 'quantity')::bigint * (item ->> 'unitCostCents')::bigint) / 
        nullif(sum((item ->> 'quantity')::bigint), 0)
      )::bigint as avg_cost
    from jsonb_array_elements(v_items) item
    group by (item ->> 'productId')::uuid
  ) sub;

  v_supplier_name := btrim(coalesce(p_purchase ->> 'supplierName', ''));
  v_expected_at := nullif(p_purchase ->> 'expectedAt', '')::timestamptz;
  v_notes := nullif(btrim(coalesce(p_purchase ->> 'notes', '')), '');
  if char_length(v_supplier_name) not between 2 and 120
    or coalesce(char_length(v_notes), 0) > 2000 then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

  perform 1
  from public.products p
  join (
    select (item ->> 'productId')::uuid as product_id
    from jsonb_array_elements(v_consolidated_items) item
  ) requested on requested.product_id = p.id
  where p.active
  order by p.id
  for update of p;
  if not found or (
    select count(*)
    from public.products p
    join (
      select (item ->> 'productId')::uuid as product_id
      from jsonb_array_elements(v_consolidated_items) item
    ) requested on requested.product_id = p.id
    where p.active
  ) <> jsonb_array_length(v_consolidated_items) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;

  insert into public.purchases(
    supplier_name, state, ordered_at, expected_at, total_cost_cents, notes, created_by
  ) values (
    v_supplier_name, 'ordered', now(), v_expected_at, 0, v_notes, auth.uid()
  ) returning id into v_purchase_id;

  for v_line in
    select
      (item ->> 'productId')::uuid as product_id,
      (item ->> 'quantity')::integer as quantity,
      (item ->> 'unitCostCents')::bigint as unit_cost_cents
    from jsonb_array_elements(v_consolidated_items) item
    order by (item ->> 'productId')::uuid
  loop
    if v_line.quantity <= 0 or v_line.quantity > 100000 or v_line.unit_cost_cents < 0 then
      raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
    end if;
    select p.name into v_product from public.products p where p.id = v_line.product_id;
    insert into public.purchase_items(
      purchase_id, product_id, product_name_snapshot, quantity, unit_cost_cents
    ) values (
      v_purchase_id, v_line.product_id, v_product.name, v_line.quantity, v_line.unit_cost_cents
    );
    v_total := v_total + v_line.quantity::bigint * v_line.unit_cost_cents;
  end loop;

  update public.purchases set total_cost_cents = v_total where id = v_purchase_id;
  perform private.bump_revision();
  return private.purchase_payload(v_purchase_id);
exception
  when invalid_text_representation or numeric_value_out_of_range or not_null_violation or check_violation then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
end;
$$;

revoke all on function public.create_purchase(jsonb) from public, anon, authenticated;
grant execute on function public.create_purchase(jsonb) to authenticated;
