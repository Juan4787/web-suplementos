begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.store_user_role as enum ('owner', 'staff');
create type public.payment_method as enum ('cash', 'transfer');
create type public.delivery_method as enum ('pickup', 'shipping');
create type public.shipping_type as enum ('standard', 'express');
create type public.order_state as enum ('confirmed', 'cancelled');
create type public.payment_state as enum ('pending', 'paid', 'refunded');
create type public.preparation_state as enum ('pending', 'preparing', 'ready');
create type public.fulfillment_state as enum ('pending', 'shipped', 'delivered', 'cancelled');
create type public.purchase_state as enum ('draft', 'ordered', 'received', 'cancelled');
create type public.stock_movement_kind as enum (
  'sale',
  'purchase_received',
  'return',
  'adjustment',
  'reservation',
  'reservation_release'
);
create type public.reservation_state as enum ('active', 'consumed', 'released');

create table public.store_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_snapshot text not null,
  display_name text not null check (char_length(btrim(display_name)) between 2 and 100),
  role public.store_user_role not null default 'staff',
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.store_settings (
  singleton_id smallint primary key default 1 check (singleton_id = 1),
  store_name text not null check (char_length(btrim(store_name)) between 2 and 100),
  tagline text not null default '',
  whatsapp_phone text not null check (whatsapp_phone ~ '^[0-9]{8,20}$'),
  transfer_alias text not null default '',
  transfer_account text not null default '',
  standard_shipping_cents bigint not null default 0 check (standard_shipping_cents >= 0),
  express_shipping_cents bigint not null default 0 check (express_shipping_cents >= 0),
  tax_rate_basis_points integer not null default 0 check (tax_rate_basis_points between 0 and 10000),
  currency text not null default 'ARS' check (currency = 'ARS'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.store_settings (
  store_name,
  tagline,
  whatsapp_phone,
  transfer_alias,
  transfer_account,
  standard_shipping_cents,
  express_shipping_cents,
  tax_rate_basis_points
) values (
  'Impulso',
  'Suplementos para sostener tu ritmo',
  '5491112345678',
  'CONFIGURAR.ALIAS',
  'Configurar CBU o CVU antes de publicar',
  0,
  0,
  0
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check (sku ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null check (char_length(btrim(name)) between 2 and 100),
  presentation text not null check (char_length(btrim(presentation)) between 2 and 100),
  description text not null default '' check (char_length(description) <= 2000),
  category text not null default 'General' check (char_length(btrim(category)) between 2 and 60),
  sale_price_cents bigint not null check (sale_price_cents >= 0),
  reorder_point integer not null default 0 check (reorder_point >= 0),
  safety_stock integer not null default 0 check (safety_stock >= 0),
  lead_time_days integer not null default 0 check (lead_time_days between 0 and 365),
  active boolean not null default true,
  published boolean not null default false,
  featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (active or not published)
);

create table public.product_financials (
  product_id uuid primary key references public.products(id) on delete restrict,
  current_cost_cents bigint not null default 0 check (current_cost_cents >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null check (char_length(storage_path) between 1 and 500),
  public_url text not null check (
    char_length(public_url) between 1 and 1000
    and (public_url like 'https://%' or public_url like '/%')
  ),
  alt_text text not null check (char_length(btrim(alt_text)) between 3 and 200),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  unique (product_id, position)
);

create table public.stock_balances (
  product_id uuid primary key references public.products(id) on delete restrict,
  on_hand integer not null default 0,
  reserved integer not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 100),
  phone text,
  phone_normalized text generated always as (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) stored,
  first_order_at timestamptz not null default now(),
  last_order_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index customers_phone_normalized_uidx
  on public.customers(phone_normalized)
  where phone_normalized <> '';

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated by default as identity unique,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name_snapshot text not null check (char_length(btrim(customer_name_snapshot)) between 2 and 100),
  customer_phone_snapshot text,
  payment_method public.payment_method not null,
  delivery_method public.delivery_method not null,
  shipping_type public.shipping_type,
  shipping_address text,
  source text not null default 'whatsapp_import' check (source in ('whatsapp_import', 'manual')),
  protocol_order_id uuid,
  protocol_checksum text,
  order_state public.order_state not null default 'confirmed',
  payment_state public.payment_state not null default 'pending',
  preparation_state public.preparation_state not null default 'pending',
  fulfillment_state public.fulfillment_state not null default 'pending',
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  shipping_fee_cents bigint not null default 0 check (shipping_fee_cents >= 0),
  total_cents bigint not null check (total_cents >= 0 and total_cents = subtotal_cents + shipping_fee_cents),
  tax_rate_basis_points integer not null check (tax_rate_basis_points between 0 and 10000),
  tax_amount_cents bigint not null check (tax_amount_cents >= 0),
  cost_total_cents bigint not null check (cost_total_cents >= 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  shipped_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  check (
    (delivery_method = 'pickup' and shipping_type is null and shipping_address is null)
    or
    (delivery_method = 'shipping' and shipping_type is not null and char_length(btrim(shipping_address)) >= 3)
  ),
  check (
    (source = 'whatsapp_import' and protocol_order_id is not null and protocol_checksum ~ '^[0-9A-F]{8}$')
    or (source = 'manual' and protocol_order_id is null)
  )
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  sku_snapshot text not null,
  product_name_snapshot text not null,
  presentation_snapshot text not null,
  quantity integer not null check (quantity > 0 and quantity <= 1000),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  unit_cost_cents bigint not null check (unit_cost_cents >= 0),
  line_subtotal_cents bigint generated always as (quantity::bigint * unit_price_cents) stored,
  created_at timestamptz not null default now(),
  unique (order_id, product_id)
);

create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  state public.reservation_state not null default 'active',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (order_id, product_id)
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  purchase_number bigint generated by default as identity unique,
  supplier_name text not null check (char_length(btrim(supplier_name)) between 2 and 120),
  state public.purchase_state not null default 'draft',
  ordered_at timestamptz,
  expected_at timestamptz,
  received_at timestamptz,
  total_cost_cents bigint not null default 0 check (total_cost_cents >= 0),
  notes text check (char_length(notes) <= 2000),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  product_name_snapshot text not null,
  quantity integer not null check (quantity > 0 and quantity <= 100000),
  unit_cost_cents bigint not null check (unit_cost_cents >= 0),
  created_at timestamptz not null default now(),
  unique (purchase_id, product_id)
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  product_name_snapshot text not null check (char_length(btrim(product_name_snapshot)) between 2 and 100),
  kind public.stock_movement_kind not null,
  physical_delta integer not null default 0,
  reserved_delta integer not null default 0,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  order_id uuid references public.orders(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete restrict,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (physical_delta <> 0 or reserved_delta <> 0)
);

create table public.inflation_indices (
  period date primary key check (extract(day from period) = 1),
  index_value numeric(18, 6) not null check (index_value > 0),
  source_url text not null check (source_url ~ '^https://'),
  published_at timestamptz not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

create table public.business_state (
  singleton_id smallint primary key default 1 check (singleton_id = 1),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
insert into public.business_state default values;

create table public.ai_usage_counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket_kind text not null check (bucket_kind in ('minute', 'day')),
  bucket_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, bucket_kind, bucket_start)
);

create table public.ai_request_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('success', 'quota', 'dependency_error', 'invalid_request')),
  model_used text,
  tool_names text[] not null default '{}',
  input_chars integer not null default 0 check (input_chars >= 0),
  created_at timestamptz not null default now()
);

create index products_public_idx on public.products (featured desc, name) where active and published;
create index products_active_name_idx on public.products (active, lower(name));
create index product_images_product_position_idx on public.product_images(product_id, position);
create index orders_created_at_idx on public.orders(created_at desc);
create index orders_work_queue_idx on public.orders(preparation_state, fulfillment_state, created_at)
  where order_state = 'confirmed';
create index orders_paid_at_idx on public.orders(paid_at desc) where payment_state = 'paid';
create unique index orders_protocol_order_uidx on public.orders(protocol_order_id)
  where protocol_order_id is not null;
create index order_items_order_idx on public.order_items(order_id);
create index order_items_product_idx on public.order_items(product_id, created_at desc);
create index reservations_active_product_idx on public.stock_reservations(product_id)
  where state = 'active';
create index purchases_state_expected_idx on public.purchases(state, expected_at)
  where state = 'ordered';
create index purchase_items_purchase_idx on public.purchase_items(purchase_id);
create index stock_movements_product_created_idx on public.stock_movements(product_id, created_at desc);
create index stock_movements_created_idx on public.stock_movements(created_at desc);
create index ai_usage_cleanup_idx on public.ai_usage_counters(bucket_start);

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.list_purchases(p_page integer default 1, p_page_size integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_total bigint;
  v_items jsonb;
begin
  perform private.require_owner();
  select count(*) into v_total from public.purchases;
  select coalesce(jsonb_agg(private.purchase_payload(id) order by created_at desc, id desc), '[]'::jsonb)
  into v_items
  from (
    select id, created_at
    from public.purchases
    order by created_at desc, id desc
    limit v_page_size
    offset (v_page - 1) * v_page_size
  ) purchase_page;
  return jsonb_build_object(
    'items', v_items,
    'page', v_page,
    'pageSize', v_page_size,
    'total', v_total
  );
end;
$$;

create or replace function public.create_purchase(p_purchase jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_items jsonb;
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
  if (
    select count(*) <> count(distinct item ->> 'productId')
    from jsonb_array_elements(v_items) item
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

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
    from jsonb_array_elements(v_items) item
  ) requested on requested.product_id = p.id
  where p.active
  order by p.id
  for update of p;
  if not found or (
    select count(*)
    from public.products p
    join (
      select (item ->> 'productId')::uuid as product_id
      from jsonb_array_elements(v_items) item
    ) requested on requested.product_id = p.id
    where p.active
  ) <> jsonb_array_length(v_items) then
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
    from jsonb_array_elements(v_items) item
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

create or replace function public.receive_purchase(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purchase public.purchases%rowtype;
  v_item record;
begin
  perform private.require_owner();
  select * into v_purchase
  from public.purchases
  where id = p_purchase_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'PURCHASE_NOT_FOUND';
  end if;
  if v_purchase.state <> 'ordered' then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE_TRANSITION';
  end if;

  for v_item in
    select pi.product_id, pi.product_name_snapshot, pi.quantity, pi.unit_cost_cents
    from public.purchase_items pi
    join public.stock_balances sb on sb.product_id = pi.product_id
    where pi.purchase_id = p_purchase_id
    order by pi.product_id
    for update of sb
  loop
    update public.stock_balances
    set on_hand = on_hand + v_item.quantity
    where product_id = v_item.product_id;
    update public.product_financials
    set current_cost_cents = v_item.unit_cost_cents, updated_by = auth.uid()
    where product_id = v_item.product_id;
    insert into public.stock_movements(
      product_id, product_name_snapshot, kind, physical_delta, reserved_delta,
      reason, purchase_id, created_by
    ) values (
      v_item.product_id,
      v_item.product_name_snapshot,
      'purchase_received',
      v_item.quantity,
      0,
      'Recepción de compra',
      p_purchase_id,
      auth.uid()
    );
  end loop;
  if not found then
    raise exception using errcode = 'P0001', message = 'INVALID_PURCHASE';
  end if;

  update public.purchases
  set state = 'received', received_at = now()
  where id = p_purchase_id;
  perform private.bump_revision();
  return private.purchase_payload(p_purchase_id);
end;
$$;

create trigger store_users_updated_at before update on public.store_users
for each row execute function private.set_updated_at();
create trigger settings_updated_at before update on public.store_settings
for each row execute function private.set_updated_at();
create trigger products_updated_at before update on public.products
for each row execute function private.set_updated_at();
create trigger product_financials_updated_at before update on public.product_financials
for each row execute function private.set_updated_at();
create trigger stock_balances_updated_at before update on public.stock_balances
for each row execute function private.set_updated_at();
create trigger customers_updated_at before update on public.customers
for each row execute function private.set_updated_at();
create trigger purchases_updated_at before update on public.purchases
for each row execute function private.set_updated_at();
create trigger inflation_indices_updated_at before update on public.inflation_indices
for each row execute function private.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  insert into public.store_users (user_id, email_snapshot, display_name, role, active)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, 'Usuario'), '@', 1)),
    'staff',
    false
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function private.is_active_user(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.store_users
    where user_id = p_user_id and active
  );
$$;

create or replace function private.is_owner(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.store_users
    where user_id = p_user_id and active and role = 'owner'
  );
$$;

create or replace function private.require_active_user()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_active_user(auth.uid()) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
end;
$$;

create or replace function private.require_owner()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not private.is_owner(auth.uid()) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
end;
$$;

create or replace function private.bump_revision()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revision bigint;
begin
  update public.business_state
  set revision = revision + 1, updated_at = now()
  where singleton_id = 1
  returning revision into v_revision;
  return v_revision;
end;
$$;

alter table public.store_users enable row level security;
alter table public.store_settings enable row level security;
alter table public.products enable row level security;
alter table public.product_financials enable row level security;
alter table public.product_images enable row level security;
alter table public.stock_balances enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.stock_reservations enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.stock_movements enable row level security;
alter table public.inflation_indices enable row level security;
alter table public.business_state enable row level security;
alter table public.ai_usage_counters enable row level security;
alter table public.ai_request_audit enable row level security;

create policy store_users_read_self_or_owner on public.store_users
for select to authenticated
using (user_id = auth.uid() or private.is_owner());
create policy store_users_owner_update on public.store_users
for update to authenticated
using (private.is_owner()) with check (private.is_owner());

create policy settings_owner_all on public.store_settings
for all to authenticated using (private.is_owner()) with check (private.is_owner());

create policy products_public_read on public.products
for select to anon using (active and published);
create policy products_active_user_read on public.products
for select to authenticated using (private.is_active_user());

create policy product_financials_owner_read on public.product_financials
for select to authenticated using (private.is_owner());
create policy product_financials_owner_write on public.product_financials
for all to authenticated using (private.is_owner()) with check (private.is_owner());

create policy product_images_public_read on public.product_images
for select to anon using (
  exists (select 1 from public.products p where p.id = product_id and p.active and p.published)
);
create policy product_images_active_user_read on public.product_images
for select to authenticated using (private.is_active_user());

create policy stock_balances_active_read on public.stock_balances
for select to authenticated using (private.is_active_user());
create policy customers_active_read on public.customers
for select to authenticated using (private.is_active_user());

create policy orders_owner_direct_read on public.orders
for select to authenticated using (private.is_owner());
create policy order_items_owner_direct_read on public.order_items
for select to authenticated using (private.is_owner());
create policy reservations_active_user_read on public.stock_reservations
for select to authenticated using (private.is_active_user());

create policy purchases_owner_all on public.purchases
for all to authenticated using (private.is_owner()) with check (private.is_owner());
create policy purchase_items_owner_all on public.purchase_items
for all to authenticated using (private.is_owner()) with check (private.is_owner());

create policy movements_active_read on public.stock_movements
for select to authenticated using (private.is_active_user());
create policy inflation_owner_all on public.inflation_indices
for all to authenticated using (private.is_owner()) with check (private.is_owner());
create policy business_state_owner_read on public.business_state
for select to authenticated using (private.is_owner());

revoke all on table
  public.store_users,
  public.store_settings,
  public.products,
  public.product_financials,
  public.product_images,
  public.stock_balances,
  public.customers,
  public.orders,
  public.order_items,
  public.stock_reservations,
  public.purchases,
  public.purchase_items,
  public.stock_movements,
  public.inflation_indices,
  public.business_state,
  public.ai_usage_counters,
  public.ai_request_audit
from anon, authenticated;
grant select on public.products, public.product_images to anon;
grant select on public.store_users, public.products, public.product_images, public.product_financials,
  public.stock_balances, public.customers, public.orders, public.order_items,
  public.stock_reservations, public.purchases, public.purchase_items,
  public.stock_movements, public.inflation_indices, public.business_state to authenticated;

create or replace function private.store_settings_payload()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'storeName', store_name,
    'tagline', tagline,
    'whatsappPhone', whatsapp_phone,
    'transferAlias', transfer_alias,
    'transferAccount', transfer_account,
    'standardShippingCents', standard_shipping_cents,
    'expressShippingCents', express_shipping_cents,
    'taxRateBasisPoints', tax_rate_basis_points,
    'currency', currency
  )
  from public.store_settings
  where singleton_id = 1;
$$;

create or replace function private.product_payload(p_product_id uuid, p_include_financials boolean)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
      when greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) = 0 then 'out_of_stock'
      when greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) <= p.reorder_point then 'low'
      else 'available'
    end,
    'maxOrderQuantity', least(20, greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0)),
    'category', p.category,
    'featured', p.featured,
    'active', p.active,
    'published', p.published,
    'reorderPoint', p.reorder_point,
    'safetyStock', p.safety_stock,
    'leadTimeDays', p.lead_time_days,
    'onHand', coalesce(s.on_hand, 0),
    'reserved', coalesce(s.reserved, 0),
    'incoming', coalesce(incoming.quantity, 0),
    'currentCostCents', case when p_include_financials then f.current_cost_cents else null end,
    'updatedAt', p.updated_at
  )
  from public.products p
  left join public.stock_balances s on s.product_id = p.id
  left join public.product_financials f on f.product_id = p.id
  left join lateral (
    select public_url, alt_text
    from public.product_images
    where product_id = p.id
    order by position, created_at
    limit 1
  ) i on true
  left join lateral (
    select coalesce(sum(pi.quantity), 0)::integer as quantity
    from public.purchase_items pi
    join public.purchases pu on pu.id = pi.purchase_id
    where pi.product_id = p.id and pu.state = 'ordered'
  ) incoming on true
  where p.id = p_product_id;
$$;

create or replace function private.order_payload(p_order_id uuid, p_include_financials boolean)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
        'subtotalCents', oi.line_subtotal_cents
      ) order by oi.created_at, oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  where o.id = p_order_id;
$$;

create or replace function private.purchase_payload(p_purchase_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
        'unitCostCents', pi.unit_cost_cents
      ) order by pi.created_at, pi.id)
      from public.purchase_items pi
      where pi.purchase_id = p.id
    ), '[]'::jsonb)
  )
  from public.purchases p
  where p.id = p_purchase_id;
$$;

create or replace function private.inventory_payload()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with movement_sales as (
    select
      product_id,
      coalesce(sum(-physical_delta) filter (
        where kind = 'sale' and created_at >= now() - interval '30 days'
      ), 0)::numeric / 30 as average_daily_sales
    from public.stock_movements
    group by product_id
  ), incoming as (
    select pi.product_id, coalesce(sum(pi.quantity), 0)::integer as quantity
    from public.purchase_items pi
    join public.purchases p on p.id = pi.purchase_id and p.state = 'ordered'
    group by pi.product_id
  ), inventory as (
    select
      p.*,
      coalesce(s.on_hand, 0) as on_hand,
      coalesce(s.reserved, 0) as reserved,
      coalesce(i.quantity, 0) as incoming,
      greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) as available,
      coalesce(ms.average_daily_sales, 0) as average_daily_sales,
      coalesce(img.public_url, '/product-placeholder.svg') as image_url
    from public.products p
    left join public.stock_balances s on s.product_id = p.id
    left join movement_sales ms on ms.product_id = p.id
    left join incoming i on i.product_id = p.id
    left join lateral (
      select public_url from public.product_images
      where product_id = p.id order by position, created_at limit 1
    ) img on true
    where p.active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'sku', sku,
    'name', name,
    'presentation', presentation,
    'imageUrl', image_url,
    'onHand', on_hand,
    'reserved', reserved,
    'available', available,
    'incoming', incoming,
    'projected', available + incoming,
    'reorderPoint', reorder_point,
    'safetyStock', safety_stock,
    'leadTimeDays', lead_time_days,
    'averageDailySales', round(average_daily_sales, 2),
    'coverageDays', case when average_daily_sales > 0 then round(available / average_daily_sales, 1) else null end,
    'suggestedPurchase', greatest(ceil(average_daily_sales * lead_time_days + safety_stock)::integer - available - incoming, 0),
    'status', case
      when available <= 0 then 'out'
      when available <= safety_stock then 'critical'
      when available <= reorder_point then 'low'
      else 'ok'
    end
  ) order by
    case when available <= 0 then 0 when available <= safety_stock then 1 when available <= reorder_point then 2 else 3 end,
    name), '[]'::jsonb)
  from inventory;
$$;

create or replace function public.get_current_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb;
begin
  perform private.require_active_user();
  select jsonb_build_object(
    'id', user_id,
    'displayName', display_name,
    'email', email_snapshot,
    'role', role
  ) into v_payload
  from public.store_users
  where user_id = auth.uid() and active;
  return v_payload;
end;
$$;

create or replace function public.get_public_store_settings()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.store_settings_payload();
$$;

create or replace function public.update_store_settings(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_owner();
  update public.store_settings
  set
    store_name = btrim(p_settings ->> 'storeName'),
    tagline = btrim(coalesce(p_settings ->> 'tagline', '')),
    whatsapp_phone = regexp_replace(coalesce(p_settings ->> 'whatsappPhone', ''), '[^0-9]', '', 'g'),
    transfer_alias = upper(btrim(coalesce(p_settings ->> 'transferAlias', ''))),
    transfer_account = btrim(coalesce(p_settings ->> 'transferAccount', '')),
    standard_shipping_cents = (p_settings ->> 'standardShippingCents')::bigint,
    express_shipping_cents = (p_settings ->> 'expressShippingCents')::bigint,
    tax_rate_basis_points = (p_settings ->> 'taxRateBasisPoints')::integer,
    updated_by = auth.uid()
  where singleton_id = 1;
  perform private.bump_revision();
  return private.store_settings_payload();
exception
  when check_violation or invalid_text_representation or not_null_violation then
    raise exception using errcode = 'P0001', message = 'INVALID_SETTINGS';
end;
$$;

create or replace function public.get_storefront_products()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(
    (private.product_payload(p.id, false) - array[
      'active', 'published', 'reorderPoint', 'safetyStock', 'leadTimeDays',
      'onHand', 'reserved', 'incoming', 'currentCostCents', 'updatedAt'
    ])
    order by p.featured desc, p.name
  ), '[]'::jsonb)
  from public.products p
  where p.active and p.published;
$$;

create or replace function public.get_storefront_product(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select private.product_payload(p.id, false) - array[
    'active', 'published', 'reorderPoint', 'safetyStock', 'leadTimeDays',
    'onHand', 'reserved', 'incoming', 'currentCostCents', 'updatedAt'
  ]
  from public.products p
  where p.slug = p_slug and p.active and p.published;
$$;

create or replace function public.check_cart_availability(p_lines jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_issues jsonb;
begin
  if coalesce(jsonb_typeof(p_lines), 'null') <> 'array' then
    raise exception using errcode = 'P0001', message = 'INVALID_CART';
  end if;
  if jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 50 then
    raise exception using errcode = 'P0001', message = 'INVALID_CART';
  end if;
  if (
    select count(*) <> count(distinct line ->> 'productId')
    from jsonb_array_elements(p_lines) line
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_CART';
  end if;

  with requested as (
    select
      (line ->> 'productId')::uuid as product_id,
      (line ->> 'quantity')::integer as quantity
    from jsonb_array_elements(p_lines) line
  ), checked as (
    select
      r.product_id,
      coalesce(p.name, 'Producto no disponible') as product_name,
      r.quantity as requested,
      greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) as available,
      p.id is null or not p.active or not p.published or r.quantity <= 0
        or r.quantity > greatest(coalesce(s.on_hand, 0) - coalesce(s.reserved, 0), 0) as invalid
    from requested r
    left join public.products p on p.id = r.product_id
    left join public.stock_balances s on s.product_id = r.product_id
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
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = 'P0001', message = 'INVALID_CART';
end;
$$;

create or replace function public.list_admin_products()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner boolean;
  v_payload jsonb;
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  select coalesce(jsonb_agg(private.product_payload(id, v_owner) order by active desc, name), '[]'::jsonb)
  into v_payload
  from public.products;
  return v_payload;
end;
$$;

create or replace function public.save_product(p_product jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner boolean;
  v_product_id uuid;
  v_existing public.products%rowtype;
  v_image_url text;
  v_image_alt text;
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  v_product_id := nullif(p_product ->> 'id', '')::uuid;
  v_image_url := btrim(coalesce(p_product ->> 'imageUrl', ''));
  v_image_alt := btrim(coalesce(p_product ->> 'imageAlt', ''));

  if v_product_id is null then
    if not v_owner then
      raise exception using errcode = 'P0001', message = 'FORBIDDEN';
    end if;
    insert into public.products (
      sku, slug, name, presentation, description, category, sale_price_cents,
      reorder_point, safety_stock, lead_time_days, active, published, featured
    ) values (
      upper(btrim(p_product ->> 'sku')),
      btrim(p_product ->> 'slug'),
      btrim(p_product ->> 'name'),
      btrim(p_product ->> 'presentation'),
      btrim(coalesce(p_product ->> 'description', '')),
      btrim(p_product ->> 'category'),
      (p_product ->> 'priceCents')::bigint,
      (p_product ->> 'reorderPoint')::integer,
      (p_product ->> 'safetyStock')::integer,
      (p_product ->> 'leadTimeDays')::integer,
      (p_product ->> 'active')::boolean,
      (p_product ->> 'active')::boolean and (p_product ->> 'published')::boolean,
      (p_product ->> 'featured')::boolean
    ) returning id into v_product_id;

    insert into public.product_financials(product_id, current_cost_cents, updated_by)
    values (v_product_id, coalesce((p_product ->> 'currentCostCents')::bigint, 0), auth.uid());
    insert into public.stock_balances(product_id) values (v_product_id);
  else
    select * into v_existing from public.products where id = v_product_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
    end if;

    update public.products
    set
      sku = case when v_owner then upper(btrim(p_product ->> 'sku')) else v_existing.sku end,
      slug = case when v_owner then btrim(p_product ->> 'slug') else v_existing.slug end,
      name = btrim(p_product ->> 'name'),
      presentation = btrim(p_product ->> 'presentation'),
      description = btrim(coalesce(p_product ->> 'description', '')),
      category = btrim(p_product ->> 'category'),
      sale_price_cents = case when v_owner then (p_product ->> 'priceCents')::bigint else v_existing.sale_price_cents end,
      reorder_point = case when v_owner then (p_product ->> 'reorderPoint')::integer else v_existing.reorder_point end,
      safety_stock = case when v_owner then (p_product ->> 'safetyStock')::integer else v_existing.safety_stock end,
      lead_time_days = case when v_owner then (p_product ->> 'leadTimeDays')::integer else v_existing.lead_time_days end,
      active = (p_product ->> 'active')::boolean,
      published = (p_product ->> 'active')::boolean and (p_product ->> 'published')::boolean,
      featured = (p_product ->> 'featured')::boolean,
      archived_at = case when (p_product ->> 'active')::boolean then null else coalesce(v_existing.archived_at, now()) end
    where id = v_product_id;

    if v_owner then
      insert into public.product_financials(product_id, current_cost_cents, updated_by)
      values (v_product_id, coalesce((p_product ->> 'currentCostCents')::bigint, 0), auth.uid())
      on conflict (product_id) do update
      set current_cost_cents = excluded.current_cost_cents, updated_by = excluded.updated_by;
    end if;
  end if;

  if v_image_url = '' or v_image_alt = '' then
    raise exception using errcode = 'P0001', message = 'INVALID_PRODUCT_IMAGE';
  end if;

  insert into public.product_images(product_id, storage_path, public_url, alt_text, position)
  values (v_product_id, v_image_url, v_image_url, v_image_alt, 0)
  on conflict (product_id, position) do update
  set storage_path = excluded.storage_path, public_url = excluded.public_url, alt_text = excluded.alt_text;

  perform private.bump_revision();
  return private.product_payload(v_product_id, v_owner);
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'PRODUCT_DUPLICATE';
  when check_violation or invalid_text_representation or not_null_violation then
    raise exception using errcode = 'P0001', message = 'INVALID_PRODUCT';
end;
$$;

create or replace function public.list_inventory_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform private.require_active_user();
  return private.inventory_payload();
end;
$$;

create or replace function public.adjust_product_stock(p_product_id uuid, p_delta integer, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_name text;
begin
  perform private.require_owner();
  if p_delta = 0 or char_length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception using errcode = 'P0001', message = 'INVALID_ADJUSTMENT';
  end if;
  select p.name into v_product_name
  from public.products p
  join public.stock_balances sb on sb.product_id = p.id
  where p.id = p_product_id
  for update of sb;
  if not found then
    raise exception using errcode = 'P0001', message = 'PRODUCT_NOT_FOUND';
  end if;
  update public.stock_balances
  set on_hand = on_hand + p_delta
  where product_id = p_product_id;
  insert into public.stock_movements(
    product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, created_by
  ) values (
    p_product_id, v_product_name, 'adjustment', p_delta, 0, btrim(p_reason), auth.uid()
  );
  perform private.bump_revision();
end;
$$;

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
    if char_length(v_address) < 3 or coalesce(char_length(regexp_replace(v_phone, '[^0-9]', '', 'g')), 0) < 8 then
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

  if v_phone is not null and regexp_replace(v_phone, '[^0-9]', '', 'g') <> '' then
    insert into public.customers(name, phone, first_order_at, last_order_at)
    values (v_customer_name, v_phone, now(), now())
    on conflict (phone_normalized) where phone_normalized <> ''
    do update set name = excluded.name, phone = excluded.phone, last_order_at = now()
    returning id into v_customer_id;
  else
    insert into public.customers(name, phone, first_order_at, last_order_at)
    values (v_customer_name, null, now(), now())
    returning id into v_customer_id;
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
exception
  when unique_violation then
    raise exception using errcode = 'P0001', message = 'ORDER_ALREADY_IMPORTED';
  when invalid_text_representation or numeric_value_out_of_range or not_null_violation or check_violation then
    raise exception using errcode = 'P0001', message = 'INVALID_ORDER';
end;
$$;

create or replace function public.list_orders(p_page integer default 1, p_page_size integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner boolean;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_total bigint;
  v_items jsonb;
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  select count(*) into v_total from public.orders;
  select coalesce(jsonb_agg(private.order_payload(id, v_owner) order by created_at desc, id desc), '[]'::jsonb)
  into v_items
  from (
    select id, created_at
    from public.orders
    order by created_at desc, id desc
    limit v_page_size
    offset (v_page - 1) * v_page_size
  ) page_rows;
  return jsonb_build_object(
    'items', v_items,
    'page', v_page,
    'pageSize', v_page_size,
    'total', v_total
  );
end;
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
  v_inventory_leaves boolean := false;
  v_new_fulfillment public.fulfillment_state;
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

  elsif p_action = 'start_preparing' then
    if v_order.preparation_state <> 'pending' or v_order.payment_state = 'refunded' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders set preparation_state = 'preparing' where id = p_order_id;

  elsif p_action = 'mark_ready' then
    if v_order.preparation_state <> 'preparing' or v_order.payment_state = 'refunded' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    update public.orders set preparation_state = 'ready' where id = p_order_id;

  elsif p_action in ('mark_shipped', 'mark_delivered') then
    if v_order.payment_state <> 'paid' or v_order.preparation_state <> 'ready' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    if p_action = 'mark_shipped' then
      if v_order.delivery_method <> 'shipping' or v_order.fulfillment_state <> 'pending' then
        raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
      end if;
      v_inventory_leaves := true;
      v_new_fulfillment := 'shipped';
    else
      if v_order.delivery_method = 'pickup' and v_order.fulfillment_state = 'pending' then
        v_inventory_leaves := true;
      elsif v_order.delivery_method = 'shipping' and v_order.fulfillment_state = 'shipped' then
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
        where order_id = p_order_id and product_id = v_item.product_id and state = 'active';
        if not found then
          raise exception using errcode = 'P0001', message = 'RESERVATION_MISSING';
        end if;
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
        shipped_at = case when v_new_fulfillment = 'shipped' then now() else shipped_at end,
        fulfilled_at = case when v_new_fulfillment = 'delivered' then now() else fulfilled_at end
    where id = p_order_id;

  elsif p_action = 'cancel' then
    if v_order.fulfillment_state <> 'pending' or v_order.payment_state = 'paid' then
      raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
    end if;
    for v_item in
      select sr.product_id, oi.product_name_snapshot, sr.quantity, sb.reserved
      from public.stock_reservations sr
      join public.stock_balances sb on sb.product_id = sr.product_id
      join public.order_items oi on oi.order_id = sr.order_id and oi.product_id = sr.product_id
      where sr.order_id = p_order_id and sr.state = 'active'
      order by sr.product_id
      for update of sr, sb
    loop
      if v_item.reserved < v_item.quantity then
        raise exception using errcode = 'P0001', message = 'RESERVATION_MISSING';
      end if;
      update public.stock_balances
      set reserved = reserved - v_item.quantity
      where product_id = v_item.product_id;
      update public.stock_reservations
      set state = 'released', resolved_at = now()
      where order_id = p_order_id and product_id = v_item.product_id and state = 'active';
      insert into public.stock_movements(
        product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, order_id, created_by
      ) values (
        v_item.product_id,
        v_item.product_name_snapshot,
        'reservation_release',
        0,
        -v_item.quantity,
        'Reserva liberada por cancelación',
        p_order_id,
        auth.uid()
      );
    end loop;
    update public.orders
    set order_state = 'cancelled', fulfillment_state = 'cancelled', cancelled_at = now()
    where id = p_order_id;
  else
    raise exception using errcode = 'P0001', message = 'INVALID_TRANSITION';
  end if;

  perform private.bump_revision();
  return private.order_payload(p_order_id, private.is_owner());
end;
$$;

create or replace function public.list_stock_movements(
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
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_total bigint;
  v_items jsonb;
begin
  perform private.require_active_user();
  select count(*) into v_total from public.stock_movements;
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
    select *
    from public.stock_movements
    order by created_at desc, id desc
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
      coalesce(sum(o.total_cents) filter (where o.payment_state = 'paid'), 0)::bigint as total_paid_cents
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
        - oi.unit_cost_cents * oi.quantity
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
    )::date as period
  ), monthly_orders as (
    select
      date_trunc('month', local_paid_date)::date as period,
      sum(total_cents)::bigint as revenue_cents,
      count(*)::integer as order_count
    from paid_orders
    group by 1
  ), monthly_units as (
    select
      date_trunc('month', po.local_paid_date)::date as period,
      sum(oi.quantity)::integer as units
    from paid_orders po
    join public.order_items oi on oi.order_id = po.id
    group by 1
  ), reference_index as (
    select index_value
    from public.inflation_indices
    where period <= date_trunc('month', p_to)::date
    order by period desc
    limit 1
  ), series as (
    select
      m.period,
      coalesce(mo.revenue_cents, 0)::bigint as revenue_cents,
      case
        when ii.index_value is null or ri.index_value is null then null
        else round(coalesce(mo.revenue_cents, 0) * ri.index_value / ii.index_value)::bigint
      end as adjusted_revenue_cents,
      coalesce(mo.order_count, 0)::integer as order_count,
      coalesce(mu.units, 0)::integer as units,
      ii.index_value is not null as ipc_published
    from months m
    left join monthly_orders mo on mo.period = m.period
    left join monthly_units mu on mu.period = m.period
    left join public.inflation_indices ii on ii.period = m.period
    left join reference_index ri on true
  ), series_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'period', to_char(period, 'YYYY-MM'),
      'revenueCents', revenue_cents,
      'adjustedRevenueCents', adjusted_revenue_cents,
      'orderCount', order_count,
      'units', units,
      'ipcPublished', ipc_published
    ) order by period), '[]'::jsonb) as payload
    from series
  )
  select jsonb_build_object(
    'from', to_char(p_from, 'YYYY-MM-DD'),
    'to', to_char(p_to, 'YYYY-MM-DD'),
    'comparisonCutoffDay', v_cutoff_day,
    'revenueCents', s.revenue_cents,
    'costCents', s.cost_cents,
    'taxCents', s.tax_cents,
    'estimatedMarginCents', s.revenue_cents - s.cost_cents - s.tax_cents,
    'averageTicketCents', case when s.order_count > 0 then round(s.revenue_cents::numeric / s.order_count)::bigint else 0 end,
    'orders', s.order_count,
    'units', u.units,
    'series', sp.payload,
    'topProducts', tp.payload
  ) into v_result
  from summary s
  cross join unit_summary u
  cross join series_payload sp
  cross join top_products tp;
  return v_result;
end;
$$;

create or replace function public.get_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner boolean;
  v_inventory jsonb;
  v_priority jsonb;
  v_recent_orders jsonb;
  v_pending_preparation integer;
  v_ready_for_delivery integer;
  v_low_stock integer;
  v_incoming_purchases integer;
  v_revenue bigint;
  v_paid_orders integer;
  v_margin bigint;
begin
  perform private.require_active_user();
  v_owner := private.is_owner();
  v_inventory := private.inventory_payload();

  select count(*)::integer into v_pending_preparation
  from public.orders
  where order_state = 'confirmed'
    and preparation_state <> 'ready'
    and fulfillment_state = 'pending'
    and payment_state <> 'refunded';

  select count(*)::integer into v_ready_for_delivery
  from public.orders
  where order_state = 'confirmed'
    and preparation_state = 'ready'
    and fulfillment_state = 'pending'
    and payment_state <> 'refunded';

  select count(*)::integer into v_low_stock
  from jsonb_array_elements(v_inventory) item
  where item ->> 'status' <> 'ok';

  select count(*)::integer into v_incoming_purchases
  from public.purchases
  where state = 'ordered';

  select coalesce(jsonb_agg(private.order_payload(id, v_owner) order by created_at desc, id desc), '[]'::jsonb)
  into v_recent_orders
  from (
    select id, created_at
    from public.orders
    order by created_at desc, id desc
    limit 5
  ) recent;

  select coalesce(jsonb_agg(item), '[]'::jsonb)
  into v_priority
  from (
    select value as item
    from jsonb_array_elements(v_inventory)
    where value ->> 'status' <> 'ok'
    limit 4
  ) priorities;

  if v_owner then
    select
      coalesce(sum(total_cents), 0)::bigint,
      count(*)::integer,
      coalesce(sum(total_cents - cost_total_cents - tax_amount_cents), 0)::bigint
    into v_revenue, v_paid_orders, v_margin
    from public.orders
    where payment_state = 'paid'
      and date_trunc('month', paid_at at time zone 'America/Argentina/Buenos_Aires')
        = date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires');
  else
    v_revenue := null;
    v_paid_orders := null;
    v_margin := null;
  end if;

  return jsonb_build_object(
    'pendingPreparation', v_pending_preparation,
    'readyForDelivery', v_ready_for_delivery,
    'lowStockProducts', v_low_stock,
    'incomingPurchases', v_incoming_purchases,
    'paidRevenueMonthCents', v_revenue,
    'paidOrdersMonth', v_paid_orders,
    'estimatedMarginMonthCents', v_margin,
    'recentOrders', v_recent_orders,
    'priorityInventory', v_priority
  );
end;
$$;

create or replace function public.list_store_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb;
begin
  perform private.require_owner();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', user_id,
    'displayName', display_name,
    'email', email_snapshot,
    'role', role,
    'active', active
  ) order by active desc, role, display_name), '[]'::jsonb)
  into v_payload
  from public.store_users;
  return v_payload;
end;
$$;

create or replace function public.update_store_user_access(
  p_user_id uuid,
  p_role public.store_user_role,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user public.store_users%rowtype;
  v_other_owners integer;
begin
  perform private.require_owner();
  if p_user_id is null or p_role is null or p_active is null then
    raise exception using errcode = 'P0001', message = 'INVALID_USER_ACCESS';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = 'P0001', message = 'CANNOT_CHANGE_OWN_ACCESS';
  end if;

  select * into v_user
  from public.store_users
  where user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'USER_NOT_FOUND';
  end if;

  if v_user.active and v_user.role = 'owner' and (not p_active or p_role <> 'owner') then
    select count(*)::integer into v_other_owners
    from public.store_users
    where active and role = 'owner' and user_id <> p_user_id;
    if v_other_owners = 0 then
      raise exception using errcode = 'P0001', message = 'LAST_OWNER_REQUIRED';
    end if;
  end if;

  update public.store_users
  set role = p_role, active = p_active
  where user_id = p_user_id
  returning * into v_user;
  perform private.bump_revision();
  return jsonb_build_object(
    'id', v_user.user_id,
    'displayName', v_user.display_name,
    'email', v_user.email_snapshot,
    'role', v_user.role,
    'active', v_user.active
  );
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
      private.product_payload(p.id, true) || jsonb_build_object('createdAt', p.created_at)
      order by p.created_at, p.id
    ), '[]'::jsonb) as payload
    from public.products p
  ), orders_payload as (
    select coalesce(jsonb_agg(
      private.order_payload(o.id, true) || jsonb_build_object(
        'source', o.source,
        'protocolOrderId', o.protocol_order_id,
        'protocolChecksum', o.protocol_checksum,
        'refundedAt', o.refunded_at,
        'shippedAt', o.shipped_at,
        'cancelledAt', o.cancelled_at
      ) order by o.created_at, o.id
    ), '[]'::jsonb) as payload
    from public.orders o
  ), purchases_payload as (
    select coalesce(jsonb_agg(
      private.purchase_payload(p.id) || jsonb_build_object('createdAt', p.created_at)
      order by p.created_at, p.id
    ), '[]'::jsonb) as payload
    from public.purchases p
  ), movements_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'productId', m.product_id,
      'productName', m.product_name_snapshot,
      'kind', m.kind,
      'physicalDelta', m.physical_delta,
      'reservedDelta', m.reserved_delta,
      'reason', m.reason,
      'orderId', m.order_id,
      'purchaseId', m.purchase_id,
      'createdAt', m.created_at,
      'createdByName', coalesce(su.display_name, 'Usuario')
    ) order by m.created_at, m.id), '[]'::jsonb) as payload
    from public.stock_movements m
    left join public.store_users su on su.user_id = m.created_by
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
        c.id,
        c.name,
        c.phone,
        c.first_order_at,
        c.last_order_at,
        c.created_at,
        count(o.id) filter (where o.order_state <> 'cancelled')::integer as order_count,
        coalesce(sum(o.total_cents) filter (where o.payment_state = 'paid'), 0)::bigint as total_paid_cents
      from public.customers c
      left join public.orders o on o.customer_id = c.id
      group by c.id
    ) customer
  ), inflation_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'period', period,
      'indexValue', index_value,
      'sourceUrl', source_url,
      'publishedAt', published_at
    ) order by period), '[]'::jsonb) as payload
    from public.inflation_indices
  ), reservations_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', reservation.id,
      'orderId', reservation.order_id,
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
    'revision', bs.revision,
    'settings', private.store_settings_payload(),
    'products', pp.payload,
    'inventory', private.inventory_payload(),
    'orders', op.payload,
    'purchases', pup.payload,
    'movements', mp.payload,
    'customers', cp.payload,
    'inflation', ip.payload,
    'reservations', rp.payload,
    'users', up.payload
  ) into v_result
  from public.business_state bs
  cross join products_payload pp
  cross join orders_payload op
  cross join purchases_payload pup
  cross join movements_payload mp
  cross join customers_payload cp
  cross join inflation_payload ip
  cross join reservations_payload rp
  cross join users_payload up
  where bs.singleton_id = 1;
  return v_result;
end;
$$;

create or replace function public.list_inflation_indices()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb;
begin
  perform private.require_owner();
  select coalesce(jsonb_agg(jsonb_build_object(
    'period', period,
    'indexValue', index_value,
    'sourceUrl', source_url,
    'publishedAt', published_at
  ) order by period desc), '[]'::jsonb)
  into v_payload
  from public.inflation_indices;
  return v_payload;
end;
$$;

create or replace function public.save_inflation_index(p_index jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period date;
  v_index_value numeric(18, 6);
  v_source_url text;
  v_published_at timestamptz;
begin
  perform private.require_owner();
  v_period := (p_index ->> 'period')::date;
  v_index_value := (p_index ->> 'indexValue')::numeric;
  v_source_url := btrim(coalesce(p_index ->> 'sourceUrl', ''));
  v_published_at := (p_index ->> 'publishedAt')::timestamptz;
  if extract(day from v_period) <> 1
    or v_index_value <= 0
    or v_source_url !~ '^https://'
    or char_length(v_source_url) > 1000 then
    raise exception using errcode = 'P0001', message = 'INVALID_INFLATION_INDEX';
  end if;
  insert into public.inflation_indices(
    period, index_value, source_url, published_at, created_by, updated_by
  ) values (
    v_period, v_index_value, v_source_url, v_published_at, auth.uid(), auth.uid()
  )
  on conflict (period) do update
  set
    index_value = excluded.index_value,
    source_url = excluded.source_url,
    published_at = excluded.published_at,
    updated_by = auth.uid();
  perform private.bump_revision();
  return jsonb_build_object(
    'period', v_period,
    'indexValue', v_index_value,
    'sourceUrl', v_source_url,
    'publishedAt', v_published_at
  );
exception
  when invalid_text_representation or numeric_value_out_of_range or not_null_violation or check_violation then
    raise exception using errcode = 'P0001', message = 'INVALID_INFLATION_INDEX';
end;
$$;

create or replace function public.list_paid_orders(
  p_page integer default 1,
  p_page_size integer default 20
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
  v_total bigint;
  v_items jsonb;
begin
  perform private.require_owner();
  select count(*) into v_total from public.orders where payment_state = 'paid';
  select coalesce(jsonb_agg(private.order_payload(id, true) order by paid_at desc, id desc), '[]'::jsonb)
  into v_items
  from (
    select id, paid_at
    from public.orders
    where payment_state = 'paid'
    order by paid_at desc, id desc
    limit v_page_size
    offset (v_page - 1) * v_page_size
  ) paid_page;
  return jsonb_build_object(
    'items', v_items,
    'page', v_page,
    'pageSize', v_page_size,
    'total', v_total
  );
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_active_user(uuid) to authenticated;
grant execute on function private.is_owner(uuid) to authenticated;

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
revoke all on function public.get_current_profile() from public, anon, authenticated;
revoke all on function public.get_public_store_settings() from public, anon, authenticated;
revoke all on function public.update_store_settings(jsonb) from public, anon, authenticated;
revoke all on function public.get_storefront_products() from public, anon, authenticated;
revoke all on function public.get_storefront_product(text) from public, anon, authenticated;
revoke all on function public.check_cart_availability(jsonb) from public, anon, authenticated;
revoke all on function public.list_admin_products() from public, anon, authenticated;
revoke all on function public.save_product(jsonb) from public, anon, authenticated;
revoke all on function public.list_inventory_status() from public, anon, authenticated;
revoke all on function public.adjust_product_stock(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.confirm_imported_order(jsonb) from public, anon, authenticated;
revoke all on function public.list_orders(integer, integer) from public, anon, authenticated;
revoke all on function public.list_paid_orders(integer, integer) from public, anon, authenticated;
revoke all on function public.transition_order(uuid, text) from public, anon, authenticated;
revoke all on function public.list_purchases(integer, integer) from public, anon, authenticated;
revoke all on function public.create_purchase(jsonb) from public, anon, authenticated;
revoke all on function public.receive_purchase(uuid) from public, anon, authenticated;
revoke all on function public.list_stock_movements(integer, integer) from public, anon, authenticated;
revoke all on function public.list_customers(integer, integer) from public, anon, authenticated;
revoke all on function public.get_sales_analytics(date, date) from public, anon, authenticated;
revoke all on function public.get_dashboard_summary() from public, anon, authenticated;
revoke all on function public.list_store_users() from public, anon, authenticated;
revoke all on function public.update_store_user_access(uuid, public.store_user_role, boolean) from public, anon, authenticated;
revoke all on function public.get_business_export_dataset() from public, anon, authenticated;
revoke all on function public.list_inflation_indices() from public, anon, authenticated;
revoke all on function public.save_inflation_index(jsonb) from public, anon, authenticated;

grant execute on function public.get_public_store_settings() to anon, authenticated;
grant execute on function public.get_storefront_products() to anon, authenticated;
grant execute on function public.get_storefront_product(text) to anon, authenticated;
grant execute on function public.check_cart_availability(jsonb) to anon, authenticated;

grant execute on function public.get_current_profile() to authenticated;
grant execute on function public.update_store_settings(jsonb) to authenticated;
grant execute on function public.list_admin_products() to authenticated;
grant execute on function public.save_product(jsonb) to authenticated;
grant execute on function public.list_inventory_status() to authenticated;
grant execute on function public.adjust_product_stock(uuid, integer, text) to authenticated;
grant execute on function public.confirm_imported_order(jsonb) to authenticated;
grant execute on function public.list_orders(integer, integer) to authenticated;
grant execute on function public.list_paid_orders(integer, integer) to authenticated;
grant execute on function public.transition_order(uuid, text) to authenticated;
grant execute on function public.list_purchases(integer, integer) to authenticated;
grant execute on function public.create_purchase(jsonb) to authenticated;
grant execute on function public.receive_purchase(uuid) to authenticated;
grant execute on function public.list_stock_movements(integer, integer) to authenticated;
grant execute on function public.list_customers(integer, integer) to authenticated;
grant execute on function public.get_sales_analytics(date, date) to authenticated;
grant execute on function public.get_dashboard_summary() to authenticated;
grant execute on function public.list_store_users() to authenticated;
grant execute on function public.update_store_user_access(uuid, public.store_user_role, boolean) to authenticated;
grant execute on function public.get_business_export_dataset() to authenticated;
grant execute on function public.list_inflation_indices() to authenticated;
grant execute on function public.save_inflation_index(jsonb) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  5242880,
  array['image/webp']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy product_images_storage_public_read on storage.objects
for select to anon, authenticated
using (bucket_id = 'product-images');

create policy product_images_storage_active_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'product-images'
  and private.is_active_user()
  and name ~ '^catalog/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
);

create policy product_images_storage_active_update on storage.objects
for update to authenticated
using (bucket_id = 'product-images' and private.is_active_user())
with check (
  bucket_id = 'product-images'
  and private.is_active_user()
  and name ~ '^catalog/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
);

create policy product_images_storage_active_delete on storage.objects
for delete to authenticated
using (bucket_id = 'product-images' and private.is_active_user());

commit;
