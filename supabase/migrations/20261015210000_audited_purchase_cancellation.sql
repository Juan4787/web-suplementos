-- Cancellation closes only the unreceived balance. Existing receipts, stock,
-- customer orders, cost snapshots and supplier expenses remain historical facts.
begin;

create index stock_reservations_purchase_pending_idx on public.stock_reservations(purchase_item_id)
  where state='active' and source_type in ('incoming','uncovered');

create table private.purchase_cancellations (
  purchase_id uuid primary key references public.purchases(id) on delete restrict,
  operation_id uuid not null unique,
  request jsonb not null,
  before_snapshot jsonb not null,
  result jsonb not null,
  replacement_purchase_id uuid references public.purchases(id) on delete restrict,
  reason text not null check (char_length(reason) between 3 and 500),
  cancelled_at timestamptz not null default now(),
  cancelled_by uuid not null references auth.users(id)
);
revoke all on private.purchase_cancellations from public,anon,authenticated;

create or replace function private.purchase_payload(p_purchase_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'id',p.id,'number',p.purchase_number,'supplierName',p.supplier_name,'state',p.state,
    'orderedAt',p.ordered_at,'expectedAt',p.expected_at,'receivedAt',p.received_at,
    'totalCostCents',p.total_cost_cents,'notes',p.notes,
    'cancellation',case when c.purchase_id is null then null else jsonb_build_object(
      'reason',c.reason,'cancelledAt',c.cancelled_at,'cancelledByName',u.display_name,
      'pendingUnits',(c.before_snapshot->>'pendingUnits')::integer,
      'pendingCostCents',(c.before_snapshot->>'pendingCostCents')::bigint,
      'replacementPurchaseId',c.replacement_purchase_id,
      'replacementPurchaseNumber',(select purchase_number from public.purchases where id=c.replacement_purchase_id)
    ) end,
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'id',pi.id,'productId',pi.product_id,'productName',pi.product_name_snapshot,
      'quantity',pi.quantity,'receivedQuantity',pi.received_quantity,
      'shortageQuantity',pi.shortage_quantity,'unitCostCents',pi.unit_cost_cents
    ) order by pi.created_at,pi.id) from public.purchase_items pi where pi.purchase_id=p.id),'[]'::jsonb)
  ) from public.purchases p
  left join private.purchase_cancellations c on c.purchase_id=p.id
  left join public.store_users u on u.user_id=c.cancelled_by
  where p.id=p_purchase_id;
$$;
revoke all on function private.purchase_payload(uuid) from public,anon,authenticated;

-- One statement gives the review and fingerprint the same database snapshot.
create or replace function private.purchase_cancellation_preview(p_purchase_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with items as (
    select pi.*,greatest(0,pi.quantity-pi.received_quantity-pi.shortage_quantity) pending
    from public.purchase_items pi where pi.purchase_id=p_purchase_id
  ), reservations as (
    select sr.id,sr.order_id,sr.order_item_id,sr.quantity,sr.source_type,sr.is_opening,sr.purchase_item_id
    from public.stock_reservations sr join items pi on pi.id=sr.purchase_item_id
    where sr.state='active' and sr.source_type in ('incoming','uncovered')
  ), facts as (
    select coalesce((select sum(pending) from items),0)::integer pending_units,
      coalesce((select sum(pending::bigint*unit_cost_cents) from items),0)::bigint pending_cost,
      coalesce((select sum(received_quantity) from items),0)::integer received_units,
      coalesce((select sum(quantity) from reservations where is_opening),0)::integer opening_units,
      coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from reservations r),'[]'::jsonb) reservations,
      coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from items i),'[]'::jsonb) items
  )
  select jsonb_build_object(
    'purchase',private.purchase_payload(p.id),'pendingUnits',f.pending_units,
    'pendingCostCents',f.pending_cost,'receivedUnits',f.received_units,
    'openingReservedQuantity',f.opening_units,
    'replacementItems',coalesce((select jsonb_agg(jsonb_build_object(
      'productId',pi.product_id,'productName',pi.product_name_snapshot,
      'quantity',greatest(pi.pending,coalesce((select sum(r.quantity)::integer from reservations r where r.purchase_item_id=pi.id),0)),
      'unitCostCents',pi.unit_cost_cents
    ) order by pi.id) from items pi where pi.pending>0 or exists(select 1 from reservations r where r.purchase_item_id=pi.id)),'[]'::jsonb),
    'canReplace',p.state='ordered' and f.pending_units>0,
    'canCancel',p.state='ordered' and f.pending_units>0 and jsonb_array_length(f.reservations)=0,
    'reviewToken',md5(jsonb_build_object('purchase',to_jsonb(p),'items',f.items,'reservations',f.reservations)::text),
    'orders',coalesce((select jsonb_agg(jsonb_build_object(
      'id',o.id,'number',o.order_number,'customerName',o.customer_name_snapshot,
      'quantity',(select sum(r.quantity)::integer from reservations r where r.order_id=o.id),
      'products',(select jsonb_agg(jsonb_build_object('name',x.name,'quantity',x.quantity) order by x.name) from (
        select pi.product_name_snapshot name,sum(r.quantity)::integer quantity from reservations r join items pi on pi.id=r.purchase_item_id where r.order_id=o.id group by pi.product_id,pi.product_name_snapshot
      ) x)
    ) order by o.order_number) from public.orders o where o.id in(select order_id from reservations)),'[]'::jsonb)
  ) from public.purchases p cross join facts f where p.id=p_purchase_id;
$$;
revoke all on function private.purchase_cancellation_preview(uuid) from public,anon,authenticated;

create or replace function public.get_purchase_cancellation_preview(p_purchase_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  perform private.require_owner();
  v_result:=private.purchase_cancellation_preview(p_purchase_id);
  if v_result is null then raise exception using errcode='P0001',message='PURCHASE_NOT_FOUND'; end if;
  return v_result;
end;
$$;

create or replace function public.cancel_purchase(
  p_purchase_id uuid,p_reason text,p_operation_id uuid,p_expected_token text,p_replacement jsonb default null
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_request jsonb; v_existing private.purchase_cancellations%rowtype;
  v_preview jsonb; v_result jsonb; v_replacement jsonb;
  v_supplier text; v_expected_at timestamptz; v_count integer:=0; v_units integer:=0;
begin
  perform private.require_owner();
  p_reason:=btrim(p_reason);
  if p_operation_id is null or p_expected_token is null or p_expected_token !~ '^[0-9a-f]{32}$'
    or p_reason is null or char_length(p_reason) not between 3 and 500 then
    raise exception using errcode='P0001',message='INVALID_PURCHASE_CANCELLATION';
  end if;
  if p_replacement is not null then
    if jsonb_typeof(p_replacement)<>'object' then raise exception using errcode='P0001',message='INVALID_PURCHASE'; end if;
    v_supplier:=btrim(coalesce(p_replacement->>'supplierName',''));
    if char_length(v_supplier) not between 2 and 120 then raise exception using errcode='P0001',message='INVALID_PURCHASE'; end if;
    begin
      v_expected_at:=nullif(p_replacement->>'expectedAt','')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode='P0001',message='INVALID_PURCHASE';
    end;
    p_replacement:=jsonb_build_object('supplierName',v_supplier,'expectedAt',v_expected_at);
  end if;
  v_request:=jsonb_build_object('purchaseId',p_purchase_id,'reason',p_reason,'reviewToken',p_expected_token,'replacement',p_replacement);
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text,916));
  select * into v_existing from private.purchase_cancellations where operation_id=p_operation_id;
  if found then
    if v_existing.request<>v_request or v_existing.cancelled_by<>auth.uid() then
      raise exception using errcode='P0001',message='IDEMPOTENCY_KEY_REUSE_MISMATCH';
    end if;
    return v_existing.result;
  end if;

  -- All allocators and receipts acquire these same product locks first.
  perform 1 from public.products p join public.stock_balances sb on sb.product_id=p.id
    where p.id in(select product_id from public.purchase_items where purchase_id=p_purchase_id)
    order by p.id for update of p,sb;
  perform 1 from public.purchases where id=p_purchase_id for update;
  if not found then raise exception using errcode='P0001',message='PURCHASE_NOT_FOUND'; end if;
  perform 1 from public.purchase_items where purchase_id=p_purchase_id order by id for update;

  v_preview:=private.purchase_cancellation_preview(p_purchase_id);
  if v_preview->>'reviewToken'<>p_expected_token then
    raise exception using errcode='P0001',message='PURCHASE_CANCELLATION_CHANGED';
  end if;
  if v_preview->'purchase'->>'state'<>'ordered' or (v_preview->>'pendingUnits')::integer=0 then
    raise exception using errcode='P0001',message='INVALID_PURCHASE_STATE';
  end if;
  if p_replacement is null and not (v_preview->>'canCancel')::boolean then
    raise exception using errcode='P0001',message='CANNOT_CANCEL_PURCHASE_WITH_ACTIVE_RESERVATIONS';
  end if;

  if p_replacement is not null then
    -- create_purchase and reservation transfer are inside this same transaction.
    -- Physical reservations and all customer financial snapshots are untouched.
    v_replacement:=public.create_purchase(jsonb_build_object(
      'supplierName',v_supplier,'expectedAt',v_expected_at,
      'notes','Reposición del saldo de compra #'||(v_preview->'purchase'->>'number')||' · '||p_reason,
      'items',v_preview->'replacementItems'
    ));
    select count(*)::integer,coalesce(sum(sr.quantity),0)::integer into v_count,v_units
      from public.stock_reservations sr join public.purchase_items pi on pi.id=sr.purchase_item_id
      where pi.purchase_id=p_purchase_id and sr.state='active' and sr.source_type in ('incoming','uncovered');
    update public.stock_reservations sr set purchase_item_id=new_pi.id,source_type='incoming'
      from public.purchase_items old_pi join public.purchase_items new_pi
        on new_pi.product_id=old_pi.product_id and new_pi.purchase_id=(v_replacement->>'id')::uuid
      where sr.purchase_item_id=old_pi.id and old_pi.purchase_id=p_purchase_id
        and sr.state='active' and sr.source_type in ('incoming','uncovered');
  end if;

  update public.purchases set state='cancelled' ,updated_at=now() where id=p_purchase_id;
  insert into private.purchase_cancellations(purchase_id,operation_id,request,before_snapshot,result,reason,cancelled_by,replacement_purchase_id)
    values(p_purchase_id,p_operation_id,v_request,v_preview,'{}',p_reason,auth.uid(),(v_replacement->>'id')::uuid);
  v_result:=jsonb_build_object('purchase',private.purchase_payload(p_purchase_id),'replacementPurchase',v_replacement,'transferredReservations',v_count,'transferredUnits',v_units);
  update private.purchase_cancellations set result=v_result where purchase_id=p_purchase_id;
  perform private.bump_revision();
  return v_result;
end;
$$;

revoke all on function public.get_purchase_cancellation_preview(uuid) from public,anon,authenticated;
grant execute on function public.get_purchase_cancellation_preview(uuid) to authenticated;
revoke all on function public.cancel_purchase(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.cancel_purchase(uuid,text,uuid,text,jsonb) to authenticated;
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
    'cancelledTotal', (select count(*) from public.purchases where state='cancelled'),
    'filteredTotal', v_filtered_total
  );
end;
$$;
revoke all on function public.list_purchases(integer,integer,text) from public,anon,authenticated;
grant execute on function public.list_purchases(integer,integer,text) to authenticated;
notify pgrst,'reload schema';
commit;
