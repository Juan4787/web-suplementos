-- Migration: 20260910180000_update_purchase.sql
-- Description: Permite editar compras a proveedores mientras se encuentren en estado 'ordered' sin recepciones previas.

create or replace function public.update_purchase(p_purchase jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purchase_id uuid;
  v_purchase public.purchases%rowtype;
  v_items jsonb;
  v_consolidated_items jsonb;
  v_line record;
  v_product record;
  v_supplier_name text;
  v_expected_at timestamptz;
  v_notes text;
  v_total bigint := 0;
begin
  perform private.require_owner();

  v_purchase_id := nullif(p_purchase ->> 'id', '')::uuid;
  if v_purchase_id is null then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

  select * into v_purchase
  from public.purchases
  where id = v_purchase_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'PURCHASE_NOT_FOUND';
  end if;

  if v_purchase.state <> 'ordered' then
    raise exception using errcode = 'P0001', message = 'CANNOT_EDIT_COMPLETED_PURCHASE';
  end if;

  if exists (
    select 1 from public.purchase_items
    where purchase_id = v_purchase_id
      and (received_quantity > 0 or shortage_quantity > 0)
  ) then
    raise exception using errcode = 'P0001', message = 'PURCHASE_ALREADY_PARTIALLY_RECEIVED';
  end if;

  v_items := p_purchase -> 'items';
  if coalesce(jsonb_typeof(v_items), 'null') <> 'array' then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;
  if jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 100 then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

  -- Consolidar automáticamente líneas duplicadas del mismo producto
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

  -- 1. Eliminar ítems que ya no están en la lista (si tienen reservas activas, FK on delete restrict impide eliminar)
  delete from public.purchase_items pi
  where pi.purchase_id = v_purchase_id
    and pi.product_id not in (
      select (item ->> 'productId')::uuid
      from jsonb_array_elements(v_consolidated_items) item
    );

  -- 2. Actualizar o insertar los ítems
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

    if exists (
      select 1 from public.purchase_items
      where purchase_id = v_purchase_id and product_id = v_line.product_id
    ) then
      update public.purchase_items
      set
        quantity = v_line.quantity,
        unit_cost_cents = v_line.unit_cost_cents,
        product_name_snapshot = v_product.name
      where purchase_id = v_purchase_id and product_id = v_line.product_id;
    else
      insert into public.purchase_items (
        purchase_id, product_id, product_name_snapshot, quantity, unit_cost_cents
      ) values (
        v_purchase_id, v_line.product_id, v_product.name, v_line.quantity, v_line.unit_cost_cents
      );
    end if;
  end loop;

  -- Recalcular costo total
  select coalesce(sum(quantity::bigint * unit_cost_cents), 0)
  into v_total
  from public.purchase_items
  where purchase_id = v_purchase_id;

  update public.purchases
  set
    supplier_name = v_supplier_name,
    expected_at = v_expected_at,
    notes = v_notes,
    total_cost_cents = v_total,
    updated_at = now()
  where id = v_purchase_id;

  perform private.bump_revision();
  return private.purchase_payload(v_purchase_id);
exception
  when invalid_text_representation or numeric_value_out_of_range or not_null_violation or check_violation then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
end;
$$;

revoke all on function public.update_purchase(jsonb) from public, anon, authenticated;
grant execute on function public.update_purchase(jsonb) to authenticated;
