-- Expose incoming and uncovered quantities separately so the order UI never
-- describes an uncovered shortage as part of an open purchase's ETA.
begin;
create or replace function public.get_order_stock_context(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  perform private.require_active_user();
  if not exists(select 1 from public.orders where id=p_order_id) then
    raise exception using errcode='P0001',message='ORDER_NOT_FOUND';
  end if;
  return (
    select jsonb_build_object('orderId',o.id,'orderState',o.order_state,'fulfillmentState',o.fulfillment_state,
      'stockSource',o.stock_source,'actionRevision',o.action_revision,'packingRevision',o.packing_revision,
      'checkedAt',statement_timestamp(),'items',coalesce((
        select jsonb_agg(jsonb_build_object(
          'orderItemId',oi.id,'productId',oi.product_id,'quantity',oi.quantity,
          'onHand',sb.on_hand,'reserved',sb.reserved,'available',greatest(0,sb.on_hand-sb.reserved),
          'physicalQuantity',coalesce(r.physical,0),'incomingQuantity',coalesce(r.incoming,0),
          'uncoveredQuantity',coalesce(r.uncovered,0),
          'otherReservedQuantity',greatest(0,sb.reserved-coalesce((select sum(sr.quantity) from public.stock_reservations sr
            where sr.product_id=oi.product_id and sr.order_id=o.id and sr.state='active' and sr.source_type='physical'),0)),
          'openingReservedQuantity',coalesce((select sum(sr.quantity) from public.stock_reservations sr
            where sr.product_id=oi.product_id and sr.is_opening and sr.state='active' and sr.source_type='physical'),0),
          'reservations',public.list_product_reservations(oi.product_id),
          'purchases',coalesce((select jsonb_agg(to_jsonb(x) order by x."number") from (
            select p.id,p.purchase_number as "number",p.expected_at as "expectedAt",p.state,
              sum(sr.quantity)::integer as "reservedQuantity",
              coalesce(sum(sr.quantity) filter(where sr.source_type='incoming'),0)::integer as "incomingQuantity",
              coalesce(sum(sr.quantity) filter(where sr.source_type='uncovered'),0)::integer as "uncoveredQuantity",
              pi.quantity as "orderedQuantity",pi.received_quantity as "receivedQuantity",pi.shortage_quantity as "shortageQuantity"
            from public.stock_reservations sr join public.purchase_items pi on pi.id=sr.purchase_item_id
            join public.purchases p on p.id=pi.purchase_id
            where sr.order_item_id=oi.id and sr.state='active' and sr.source_type in ('incoming','uncovered')
            group by p.id,pi.id
          ) x),'[]'::jsonb)
        ) order by oi.created_at,oi.id)
        from public.order_items oi join public.stock_balances sb on sb.product_id=oi.product_id
        left join lateral(select
          sum(sr.quantity) filter(where sr.source_type='physical')::integer physical,
          sum(sr.quantity) filter(where sr.source_type='incoming')::integer incoming,
          sum(sr.quantity) filter(where sr.source_type='uncovered')::integer uncovered
          from public.stock_reservations sr where sr.order_item_id=oi.id and sr.state='active') r on true
        where oi.order_id=o.id
      ),'[]'::jsonb)) from public.orders o where o.id=p_order_id
  );
end;
$$;
revoke all on function public.get_order_stock_context(uuid) from public,anon,authenticated;
grant execute on function public.get_order_stock_context(uuid) to authenticated;
commit;
