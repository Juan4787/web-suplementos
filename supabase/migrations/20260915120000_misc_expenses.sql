begin;

-- Gastos operativos que no pertenecen al costo de un producto. Las reglas
-- recurrentes se expanden al consultar un período; no se crean filas ocultas.
create table public.misc_expenses (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  title text not null check (char_length(btrim(title)) between 2 and 100),
  amount_cents bigint not null check (amount_cents between 1 and 99999999999),
  frequency text not null check (frequency in ('once', 'weekly', 'monthly')),
  starts_on date not null,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid not null references auth.users(id) on delete restrict,
  deleted_by uuid references auth.users(id) on delete restrict,
  check (starts_on between date '2000-01-01' and date '2100-12-31'),
  check (ends_on is null or ends_on between starts_on and date '2100-12-31'),
  check (frequency <> 'once' or ends_on is null),
  check ((deleted_at is null) = (deleted_by is null))
);

create table public.misc_expense_audit (
  id bigint generated always as identity primary key,
  expense_id uuid not null references public.misc_expenses(id) on delete restrict,
  action text not null check (action in ('created', 'updated', 'deleted')),
  before_snapshot jsonb,
  after_snapshot jsonb,
  changed_at timestamptz not null default now(),
  changed_by uuid not null references auth.users(id) on delete restrict,
  check (before_snapshot is not null or after_snapshot is not null)
);

create index misc_expenses_active_period_idx
on public.misc_expenses(starts_on, ends_on)
where deleted_at is null;

create index misc_expense_audit_expense_idx
on public.misc_expense_audit(expense_id, changed_at, id);

create trigger misc_expenses_updated_at
before update on public.misc_expenses
for each row execute function private.set_updated_at();

alter table public.misc_expenses enable row level security;
alter table public.misc_expense_audit enable row level security;

create policy misc_expenses_owner_read on public.misc_expenses
for select to authenticated using (private.is_owner());

create policy misc_expense_audit_owner_read on public.misc_expense_audit
for select to authenticated using (private.is_owner());

revoke all on table public.misc_expenses, public.misc_expense_audit from anon, authenticated;
revoke all on sequence public.misc_expense_audit_id_seq from anon, authenticated;
grant select on public.misc_expenses, public.misc_expense_audit to authenticated;

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
    'updatedByName', coalesce(editor.display_name, 'Usuario')
  )
  from public.misc_expenses expense
  left join public.store_users creator on creator.user_id = expense.created_by
  left join public.store_users editor on editor.user_id = expense.updated_by
  where expense.id = p_expense_id;
$$;

create or replace function private.misc_expense_snapshot_payload(p_snapshot jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_snapshot is null then null
    else jsonb_build_object(
      'title', p_snapshot ->> 'title',
      'amountCents', (p_snapshot ->> 'amount_cents')::bigint,
      'frequency', p_snapshot ->> 'frequency',
      'startsOn', p_snapshot ->> 'starts_on',
      'endsOn', p_snapshot ->> 'ends_on',
      'deletedAt', p_snapshot ->> 'deleted_at'
    )
  end;
$$;

-- Devuelve una fila por ocurrencia. En recurrencias mensuales, los días 29-31
-- caen en el último día de los meses más cortos (31/01, 28/02, 31/03, etc.).
create or replace function private.misc_expense_occurrences(p_from date, p_to date)
returns table(expense_id uuid, occurrence_on date, amount_cents bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with eligible as materialized (
    select
      expense.*,
      greatest(p_from, expense.starts_on) as range_start,
      least(p_to, coalesce(expense.ends_on, p_to)) as range_end
    from public.misc_expenses expense
    where expense.deleted_at is null
      and expense.starts_on <= p_to
      and coalesce(expense.ends_on, p_to) >= p_from
  )
  select expense.id, expense.starts_on, expense.amount_cents
  from eligible expense
  where expense.frequency = 'once'
    and expense.starts_on between expense.range_start and expense.range_end

  union all

  select
    expense.id,
    expense.starts_on + (occurrence_index * 7),
    expense.amount_cents
  from eligible expense
  cross join lateral generate_series(
    greatest(0, ceil((expense.range_start - expense.starts_on)::numeric / 7)::integer),
    floor((expense.range_end - expense.starts_on)::numeric / 7)::integer
  ) occurrence_index
  where expense.frequency = 'weekly'

  union all

  select expense.id, occurrence.occurrence_on, expense.amount_cents
  from eligible expense
  cross join lateral generate_series(
    date_trunc('month', expense.range_start::timestamp),
    date_trunc('month', expense.range_end::timestamp),
    interval '1 month'
  ) month_series(month_start)
  cross join lateral (
    select (
      month_series.month_start::date
      + least(
          extract(day from expense.starts_on)::integer,
          extract(day from (date_trunc('month', month_series.month_start) + interval '1 month - 1 day'))::integer
        )
      - 1
    )::date as occurrence_on
  ) occurrence
  where expense.frequency = 'monthly'
    and occurrence.occurrence_on between expense.range_start and expense.range_end;
$$;

create or replace function public.list_misc_expenses(p_from date, p_to date)
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
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 3660 then
    raise exception using errcode = 'P0001', message = 'INVALID_PERIOD';
  end if;

  with impacts as materialized (
    select
      occurrence.expense_id,
      count(*)::integer as occurrence_count,
      sum(occurrence.amount_cents)::bigint as period_amount_cents
    from private.misc_expense_occurrences(p_from, p_to) occurrence
    group by occurrence.expense_id
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'expenseCount', count(*)::integer,
    'occurrenceCount', coalesce(sum(impact.occurrence_count), 0)::integer,
    'totalCents', coalesce(sum(impact.period_amount_cents), 0)::bigint,
    'items', coalesce(jsonb_agg(
      private.misc_expense_payload(expense.id) || jsonb_build_object(
        'occurrenceCount', impact.occurrence_count,
        'periodAmountCents', impact.period_amount_cents
      ) order by expense.starts_on desc, expense.title, expense.id
    ), '[]'::jsonb)
  ) into v_result
  from public.misc_expenses expense
  join impacts impact on impact.expense_id = expense.id;

  return v_result;
end;
$$;

create or replace function public.save_misc_expense(p_expense jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_operation_id uuid;
  v_title text;
  v_amount_cents bigint;
  v_frequency text;
  v_starts_on date;
  v_ends_on date;
  v_expected_updated_at timestamptz;
  v_existing public.misc_expenses%rowtype;
  v_before public.misc_expenses%rowtype;
  v_after public.misc_expenses%rowtype;
begin
  perform private.require_owner();

  v_id := nullif(p_expense ->> 'id', '')::uuid;
  v_operation_id := nullif(p_expense ->> 'operationId', '')::uuid;
  v_title := btrim(coalesce(p_expense ->> 'title', ''));
  v_amount_cents := (p_expense ->> 'amountCents')::bigint;
  v_frequency := p_expense ->> 'frequency';
  v_starts_on := (p_expense ->> 'startsOn')::date;
  v_ends_on := nullif(p_expense ->> 'endsOn', '')::date;
  v_expected_updated_at := nullif(p_expense ->> 'expectedUpdatedAt', '')::timestamptz;

  if char_length(v_title) not between 2 and 100
    or v_amount_cents not between 1 and 99999999999
    or v_frequency not in ('once', 'weekly', 'monthly')
    or v_starts_on not between date '2000-01-01' and date '2100-12-31'
    or (v_frequency = 'once' and v_ends_on is not null)
    or (v_ends_on is not null and (v_ends_on < v_starts_on or v_ends_on > date '2100-12-31'))
  then
    raise exception using errcode = 'P0001', message = 'INVALID_MISC_EXPENSE';
  end if;

  if v_id is null then
    if v_operation_id is null then
      raise exception using errcode = 'P0001', message = 'INVALID_MISC_EXPENSE';
    end if;

    -- Dos reintentos simultáneos con la misma operación se serializan antes de
    -- consultar/insertar, evitando una fila duplicada o un error técnico de unique.
    perform pg_advisory_xact_lock(hashtextextended(v_operation_id::text, 0));

    select * into v_existing
    from public.misc_expenses
    where operation_id = v_operation_id;

    if found then
      if v_existing.deleted_at is null
        and v_existing.title = v_title
        and v_existing.amount_cents = v_amount_cents
        and v_existing.frequency = v_frequency
        and v_existing.starts_on = v_starts_on
        and v_existing.ends_on is not distinct from v_ends_on
      then
        return private.misc_expense_payload(v_existing.id);
      end if;
      raise exception using errcode = 'P0001', message = 'MISC_EXPENSE_OPERATION_REUSED';
    end if;

    insert into public.misc_expenses(
      operation_id, title, amount_cents, frequency, starts_on, ends_on,
      created_by, updated_by
    ) values (
      v_operation_id, v_title, v_amount_cents, v_frequency, v_starts_on, v_ends_on,
      auth.uid(), auth.uid()
    ) returning * into v_after;

    insert into public.misc_expense_audit(
      expense_id, action, before_snapshot, after_snapshot, changed_at, changed_by
    ) values (
      v_after.id, 'created', null, to_jsonb(v_after), v_after.updated_at, auth.uid()
    );
  else
    if v_expected_updated_at is null then
      raise exception using errcode = 'P0001', message = 'INVALID_MISC_EXPENSE';
    end if;

    select * into v_existing
    from public.misc_expenses
    where id = v_id
    for update;

    if not found or v_existing.deleted_at is not null then
      raise exception using errcode = 'P0001', message = 'MISC_EXPENSE_NOT_FOUND';
    end if;

    if v_existing.updated_at <> v_expected_updated_at then
      if v_existing.title = v_title
        and v_existing.amount_cents = v_amount_cents
        and v_existing.frequency = v_frequency
        and v_existing.starts_on = v_starts_on
        and v_existing.ends_on is not distinct from v_ends_on
      then
        return private.misc_expense_payload(v_existing.id);
      end if;
      raise exception using errcode = 'P0001', message = 'MISC_EXPENSE_CHANGED';
    end if;

    if v_existing.title = v_title
      and v_existing.amount_cents = v_amount_cents
      and v_existing.frequency = v_frequency
      and v_existing.starts_on = v_starts_on
      and v_existing.ends_on is not distinct from v_ends_on
    then
      return private.misc_expense_payload(v_existing.id);
    end if;

    v_before := v_existing;
    update public.misc_expenses
    set
      title = v_title,
      amount_cents = v_amount_cents,
      frequency = v_frequency,
      starts_on = v_starts_on,
      ends_on = v_ends_on,
      updated_by = auth.uid()
    where id = v_id
    returning * into v_after;

    insert into public.misc_expense_audit(
      expense_id, action, before_snapshot, after_snapshot, changed_at, changed_by
    ) values (
      v_after.id, 'updated', to_jsonb(v_before), to_jsonb(v_after), v_after.updated_at, auth.uid()
    );
  end if;

  perform private.bump_revision();
  return private.misc_expense_payload(v_after.id);
exception
  when check_violation or invalid_text_representation or not_null_violation or datetime_field_overflow or numeric_value_out_of_range then
    raise exception using errcode = 'P0001', message = 'INVALID_MISC_EXPENSE';
end;
$$;

create or replace function public.delete_misc_expense(
  p_expense_id uuid,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.misc_expenses%rowtype;
  v_after public.misc_expenses%rowtype;
begin
  perform private.require_owner();
  if p_expense_id is null or p_expected_updated_at is null then
    raise exception using errcode = 'P0001', message = 'INVALID_MISC_EXPENSE';
  end if;

  select * into v_existing
  from public.misc_expenses
  where id = p_expense_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'MISC_EXPENSE_NOT_FOUND';
  end if;
  if v_existing.deleted_at is not null then
    return private.misc_expense_payload(v_existing.id);
  end if;
  if v_existing.updated_at <> p_expected_updated_at then
    raise exception using errcode = 'P0001', message = 'MISC_EXPENSE_CHANGED';
  end if;

  update public.misc_expenses
  set deleted_at = now(), deleted_by = auth.uid(), updated_by = auth.uid()
  where id = p_expense_id
  returning * into v_after;

  insert into public.misc_expense_audit(
    expense_id, action, before_snapshot, after_snapshot, changed_at, changed_by
  ) values (
    v_after.id, 'deleted', to_jsonb(v_existing), to_jsonb(v_after), v_after.updated_at, auth.uid()
  );

  perform private.bump_revision();
  return private.misc_expense_payload(v_after.id);
end;
$$;

-- El contrato histórico estimatedMarginCents se conserva, pero desde esta
-- migración representa la ganancia neta: margen comercial menos gastos varios.
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

  with active_orders as materialized (
    select
      orders.*,
      (coalesce(orders.paid_at, orders.created_at) at time zone 'America/Argentina/Buenos_Aires')::date as local_effective_date
    from public.orders
    where orders.payment_state in ('paid', 'gifted')
      and (coalesce(orders.paid_at, orders.created_at) at time zone 'America/Argentina/Buenos_Aires')::date between p_from and p_to
      and (
        v_cutoff_day is null
        or extract(day from (coalesce(orders.paid_at, orders.created_at) at time zone 'America/Argentina/Buenos_Aires')::date) <= v_cutoff_day
      )
  ), summary as (
    select
      coalesce(sum(total_cents), 0)::bigint as revenue_cents,
      coalesce(sum(cost_total_cents), 0)::bigint as cost_cents,
      coalesce(sum(tax_amount_cents), 0)::bigint as tax_cents,
      count(*) filter (where payment_state = 'paid' and coalesce(sale_type, 'retail') <> 'cost')::integer as paid_order_count,
      count(*) filter (where payment_state = 'gifted' or coalesce(sale_type, 'retail') = 'gift')::integer as gift_order_count,
      coalesce(sum(cost_total_cents) filter (where payment_state = 'gifted' or coalesce(sale_type, 'retail') = 'gift'), 0)::bigint as gift_cost_cents,
      count(*) filter (where coalesce(sale_type, 'retail') = 'cost')::integer as cost_sale_order_count,
      coalesce(sum(total_cents) filter (where coalesce(sale_type, 'retail') = 'cost'), 0)::bigint as cost_sale_revenue_cents
    from active_orders
  ), expense_summary as (
    select
      coalesce(sum(occurrence.amount_cents), 0)::bigint as expense_cents,
      count(*)::integer as occurrence_count
    from private.misc_expense_occurrences(p_from, p_to) occurrence
    where v_cutoff_day is null or extract(day from occurrence.occurrence_on) <= v_cutoff_day
  ), unit_summary as (
    select coalesce(sum(order_item.quantity), 0)::integer as units
    from active_orders active_order
    join public.order_items order_item on order_item.order_id = active_order.id
  ), ranked_products as (
    select
      order_item.product_id,
      order_item.product_name_snapshot as name,
      sum(order_item.quantity)::integer as units,
      sum(order_item.line_subtotal_cents)::bigint as revenue_cents,
      sum(order_item.unit_cost_cents * order_item.quantity)::bigint as cost_cents,
      sum(
        order_item.line_subtotal_cents
        - order_item.unit_cost_cents * order_item.quantity
        - case
            when active_order.total_cents > 0
              then round(active_order.tax_amount_cents * order_item.line_subtotal_cents::numeric / active_order.total_cents)::bigint
            else 0
          end
      )::bigint as estimated_margin_cents
    from active_orders active_order
    join public.order_items order_item on order_item.order_id = active_order.id
    group by order_item.product_id, order_item.product_name_snapshot
    order by units desc, revenue_cents desc, name
    limit 10
  ), top_products as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', product_id,
      'name', name,
      'units', units,
      'revenueCents', revenue_cents,
      'costCents', cost_cents,
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
      'period', to_char(month.month_start, 'YYYY-MM'),
      'revenueCents', coalesce(month_orders.revenue_cents, 0),
      'adjustedRevenueCents', null,
      'orderCount', coalesce(month_orders.order_count, 0),
      'units', coalesce(month_orders.units, 0),
      'ipcPublished', false
    ) order by month.month_start), '[]'::jsonb) as payload
    from months month
    left join lateral (
      select
        sum(active_order.total_cents)::bigint as revenue_cents,
        count(*) filter (where active_order.payment_state = 'paid' and coalesce(active_order.sale_type, 'retail') <> 'cost')::integer as order_count,
        sum(coalesce(item_units.units, 0))::integer as units
      from active_orders active_order
      left join lateral (
        select sum(order_item.quantity)::integer as units
        from public.order_items order_item where order_item.order_id = active_order.id
      ) item_units on true
      where date_trunc('month', active_order.local_effective_date) = month.month_start
    ) month_orders on true
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'comparisonCutoffDay', v_cutoff_day,
    'revenueCents', summary.revenue_cents,
    'costCents', summary.cost_cents,
    'taxCents', summary.tax_cents,
    'commercialMarginCents', summary.revenue_cents - summary.cost_cents - summary.tax_cents,
    'miscExpensesCents', expenses.expense_cents,
    'miscExpenseOccurrences', expenses.occurrence_count,
    'estimatedMarginCents', summary.revenue_cents - summary.cost_cents - summary.tax_cents - expenses.expense_cents,
    'averageTicketCents', case
      when summary.paid_order_count > 0
        then round((summary.revenue_cents - summary.cost_sale_revenue_cents)::numeric / summary.paid_order_count)::bigint
      else 0
    end,
    'orders', summary.paid_order_count,
    'giftOrders', summary.gift_order_count,
    'giftCostCents', summary.gift_cost_cents,
    'costSaleOrders', summary.cost_sale_order_count,
    'costSaleRevenueCents', summary.cost_sale_revenue_cents,
    'units', coalesce(units.units, 0),
    'series', series.payload,
    'topProducts', top_products.payload
  ) into v_result
  from summary
  cross join expense_summary expenses
  cross join unit_summary units
  cross join top_products
  cross join series;

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
  v_misc_expenses bigint;
  v_month_start date := date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
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
      count(*) filter (where payment_state = 'paid')::integer,
      coalesce(sum(total_cents - cost_total_cents - tax_amount_cents), 0)::bigint
    into v_revenue, v_paid_orders, v_margin
    from public.orders
    where payment_state in ('paid', 'gifted')
      and date_trunc('month', coalesce(paid_at, created_at) at time zone 'America/Argentina/Buenos_Aires')
        = date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires');

    select coalesce(sum(amount_cents), 0)::bigint
    into v_misc_expenses
    from private.misc_expense_occurrences(v_month_start, v_today);
    v_margin := v_margin - v_misc_expenses;
  else
    v_revenue := null;
    v_paid_orders := null;
    v_margin := null;
    v_misc_expenses := null;
  end if;

  return jsonb_build_object(
    'pendingPreparation', v_pending_preparation,
    'readyForDelivery', v_ready_for_delivery,
    'lowStockProducts', v_low_stock,
    'incomingPurchases', v_incoming_purchases,
    'paidRevenueMonthCents', v_revenue,
    'paidOrdersMonth', v_paid_orders,
    'estimatedMarginMonthCents', v_margin,
    'miscExpensesMonthCents', v_misc_expenses,
    'recentOrders', v_recent_orders,
    'priorityInventory', v_priority,
    'priorities', v_priority
  );
end;
$$;

create or replace function public.ai_get_sales_summary(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_analytics jsonb;
begin
  perform private.require_owner();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = 'P0001', message = 'INVALID_PERIOD';
  end if;

  v_analytics := public.get_sales_analytics(p_from, p_to);
  return jsonb_build_object(
    'schemaVersion', 'ai-facts/v1',
    'tool', 'get_sales_summary',
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', 'America/Argentina/Buenos_Aires'),
    'facts', jsonb_build_object(
      'sales.revenue_cents', v_analytics -> 'revenueCents',
      'sales.cost_cents', v_analytics -> 'costCents',
      'sales.tax_cents', v_analytics -> 'taxCents',
      'sales.commercial_margin_cents', v_analytics -> 'commercialMarginCents',
      'sales.misc_expenses_cents', v_analytics -> 'miscExpensesCents',
      'sales.misc_expense_occurrence_count', v_analytics -> 'miscExpenseOccurrences',
      'sales.net_profit_cents', v_analytics -> 'estimatedMarginCents',
      'sales.estimated_margin_cents', v_analytics -> 'estimatedMarginCents',
      'sales.average_ticket_cents', v_analytics -> 'averageTicketCents',
      'sales.order_count', v_analytics -> 'orders',
      'sales.units', v_analytics -> 'units'
    )
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
    'users', users.payload
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

revoke all on function private.misc_expense_payload(uuid) from public, anon, authenticated;
revoke all on function private.misc_expense_snapshot_payload(jsonb) from public, anon, authenticated;
revoke all on function private.misc_expense_occurrences(date, date) from public, anon, authenticated;

revoke all on function public.list_misc_expenses(date, date) from public, anon, authenticated;
revoke all on function public.save_misc_expense(jsonb) from public, anon, authenticated;
revoke all on function public.delete_misc_expense(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.list_misc_expenses(date, date) to authenticated;
grant execute on function public.save_misc_expense(jsonb) to authenticated;
grant execute on function public.delete_misc_expense(uuid, timestamptz) to authenticated;

commit;
