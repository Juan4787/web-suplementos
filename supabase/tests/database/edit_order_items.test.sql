begin;
do $$ begin
  if current_database() !~ '^rigorous_ux_shipping_' or not exists(select 1 from staging_guard.identity where task='shipping-20261010') then
    raise exception 'DISPOSABLE_LOCAL_DATABASE_REQUIRED';
  end if;
end $$;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select no_plan();

insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000191001','edit-owner@test.local'),
 ('00000000-0000-4000-8000-000000191002','edit-staff@test.local');
update public.store_users set active=true,role='owner' where user_id='00000000-0000-4000-8000-000000191001';
update public.store_users set active=true,role='staff' where user_id='00000000-0000-4000-8000-000000191002';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000191001',true);

create temp table fixture(name text primary key, value jsonb);
insert into fixture values
  ('prod_a', public.save_product('{"sku":"EDIT_PROD_A","slug":"edit-prod-a","name":"Creatina Edit A","presentation":"300g","description":"Fixture A","category":"Creatinas","priceCents":200000,"currentCostCents":120000,"reorderPoint":0,"safetyStock":0,"leadTimeDays":1,"imageUrl":"/test.svg","imageAlt":"Prod A","featured":false,"published":true,"active":true}')),
  ('prod_b', public.save_product('{"sku":"EDIT_PROD_B","slug":"edit-prod-b","name":"Proteina Edit B","presentation":"1kg","description":"Fixture B","category":"Proteinas","priceCents":300000,"currentCostCents":180000,"reorderPoint":0,"safetyStock":0,"leadTimeDays":1,"imageUrl":"/test.svg","imageAlt":"Prod B","featured":false,"published":true,"active":true}')),
  ('prod_c', public.save_product('{"sku":"EDIT_PROD_C","slug":"edit-prod-c","name":"Magnesio Edit C","presentation":"60 caps","description":"Fixture C","category":"Vitaminas","priceCents":100000,"currentCostCents":60000,"reorderPoint":0,"safetyStock":0,"leadTimeDays":1,"imageUrl":"/test.svg","imageAlt":"Prod C","featured":false,"published":true,"active":true}'));

create function pg_temp.id(name text) returns uuid language sql as $$ select (value->>'id')::uuid from fixture where fixture.name=$1 $$;
create function pg_temp.rev(name text) returns bigint language sql as $$ select action_revision from public.orders where id=pg_temp.id(name) $$;

select public.adjust_product_stock(pg_temp.id('prod_a'), 5, 'Stock inicial A');
select public.adjust_product_stock(pg_temp.id('prod_b'), 4, 'Stock inicial B');
select public.adjust_product_stock(pg_temp.id('prod_c'), 3, 'Stock inicial C');

-- 1. Create an initial shipping order with 2x Prod A and 1x Prod B, plus a manual shipping fee
insert into fixture values('order_main', public.confirm_imported_order(jsonb_build_object(
  'stockSource', 'normal',
  'customerName', 'Cliente WhatsApp Edit',
  'phone', '5493415550199',
  'paymentMethod', 'transfer',
  'deliveryMethod', 'shipping',
  'shippingType', 'standard',
  'address', 'Bv Oroño 1234',
  'shippingFeeCents', 0,
  'quotedSubtotalCents', 700000,
  'quotedTotalCents', 700000,
  'protocolOrderId', gen_random_uuid(),
  'protocolChecksum', '1234ABC1',
  'lines', jsonb_build_array(
    jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 2, 'unitPriceCents', 200000),
    jsonb_build_object('productId', pg_temp.id('prod_b'), 'quantity', 1, 'unitPriceCents', 300000)
  )
)));

select public.save_order_shipping_fee(jsonb_build_object(
  'orderId', pg_temp.id('order_main'),
  'operationId', gen_random_uuid(),
  'expectedRevision', 0,
  'method', 'percentage',
  'basisPoints', 1000,
  'expectedCostCents', 420000
));

-- Verify get_order RPC works
select is(public.get_order(pg_temp.id('order_main'))->>'id', pg_temp.id('order_main')::text, 'get_order returns the requested order');
select throws_ok(
  format('select public.get_order(%L)', gen_random_uuid()),
  'P0001',
  'ORDER_NOT_FOUND',
  'get_order throws ORDER_NOT_FOUND for unknown uuid'
);

-- Record packing on prod_a (1 unit packed) and prod_b (1 unit packed then unpacked back to 0 to create packing event history)
select public.save_order_packing(
  pg_temp.id('order_main'),
  jsonb_build_array(
    jsonb_build_object('orderItemId', (select id from public.order_items where order_id=pg_temp.id('order_main') and product_id=pg_temp.id('prod_a')), 'packedQuantity', 1),
    jsonb_build_object('orderItemId', (select id from public.order_items where order_id=pg_temp.id('order_main') and product_id=pg_temp.id('prod_b')), 'packedQuantity', 1)
  ),
  0
);
select public.save_order_packing(
  pg_temp.id('order_main'),
  jsonb_build_array(
    jsonb_build_object('orderItemId', (select id from public.order_items where order_id=pg_temp.id('order_main') and product_id=pg_temp.id('prod_a')), 'packedQuantity', 1),
    jsonb_build_object('orderItemId', (select id from public.order_items where order_id=pg_temp.id('order_main') and product_id=pg_temp.id('prod_b')), 'packedQuantity', 0)
  ),
  1
);

-- 2. Packing guard: cannot reduce prod_a below packedQuantity (1) or remove it
select throws_ok(
  format(
    'select public.update_order_items(%L::jsonb)',
    jsonb_build_object(
      'orderId', pg_temp.id('order_main'),
      'operationId', gen_random_uuid(),
      'expectedActionRevision', pg_temp.rev('order_main'),
      'items', jsonb_build_array(
        jsonb_build_object('productId', pg_temp.id('prod_b'), 'quantity', 1)
      )
    )
  ),
  'P0001',
  'CANNOT_REDUCE_BELOW_PACKED_QUANTITY',
  'Cannot remove a product line that already has units packed in the bag'
);

-- 3. Create a second order waiting on Prod B stock (3 available, order asks for 4 with incoming purchase)
insert into fixture values('purchase_b', public.create_purchase(jsonb_build_object(
  'supplierName', 'Proveedor B',
  'items', jsonb_build_array(jsonb_build_object('productId', pg_temp.id('prod_b'), 'quantity', 2, 'unitCostCents', 180000))
)));
insert into fixture values('order_waiting_b', public.confirm_imported_order(jsonb_build_object(
  'stockSource', 'normal',
  'customerName', 'Cliente Esperando B',
  'phone', '5493415550200',
  'paymentMethod', 'cash',
  'deliveryMethod', 'pickup',
  'shippingType', null,
  'shippingFeeCents', 0,
  'quotedSubtotalCents', 1200000,
  'quotedTotalCents', 1200000,
  'protocolOrderId', gen_random_uuid(),
  'protocolChecksum', '1234ABC2',
  'lines', jsonb_build_array(
    jsonb_build_object('productId', pg_temp.id('prod_b'), 'quantity', 4, 'unitPriceCents', 300000)
  )
)));
select is(public.get_order(pg_temp.id('order_waiting_b'))->>'stockReadiness', 'waiting_incoming', 'Second order is waiting for 1 incoming unit of Prod B');

-- 4. Edit order_main:
--    - Keep Prod A at 1 unit (reduced from 2 -> 1, matching packedQuantity = 1, so packing becomes complete if all other lines are packed or removed)
--    - Remove Prod B completely (it had 0 packed, but has packing event history and active reservation)
--    - Add Prod C (2 units)
insert into fixture values('edit_op_1', jsonb_build_object(
  'orderId', pg_temp.id('order_main'),
  'operationId', gen_random_uuid(),
  'expectedActionRevision', pg_temp.rev('order_main'),
  'items', jsonb_build_array(
    jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 1),
    jsonb_build_object('productId', pg_temp.id('prod_c'), 'quantity', 2)
  )
));

insert into fixture values('edited_order_1', public.update_order_items((select value from fixture where name='edit_op_1')));

select is((select value->>'subtotalCents' from fixture where name='edited_order_1')::bigint, 400000::bigint, 'Edited subtotal reflects 1x Prod A (200k) + 2x Prod C (200k)');
select is((select value->>'totalCents' from fixture where name='edited_order_1')::bigint, 442000::bigint, 'Edited total preserves shipping fee (42000) + new subtotal (400000)');
select is((select value->>'costTotalCents' from fixture where name='edited_order_1')::bigint, 240000::bigint, 'Edited cost total reflects 1x 120k + 2x 60k');
select is((select value->>'shippingFeeNeedsReview' from fixture where name='edited_order_1')::boolean, true, 'Percentage shipping fee is flagged for review when merchandise cost changes on a shipping order');
select is((select value->>'packingTracked' from fixture where name='edited_order_1')::boolean, true, 'Packing remains tracked when adding a new line to a tracked order');
select is((select value->>'preparationState' from fixture where name='edited_order_1'), 'preparing', 'Preparation state is preparing because Prod A has 1/1 packed and Prod C has 0/2 packed');
select is((select (item->>'packedQuantity')::integer from fixture, jsonb_array_elements(value->'items') item where name='edited_order_1' and item->>'productId'=pg_temp.id('prod_a')::text), 1, 'Existing Prod A line retains packedQuantity = 1');
select is((select (item->>'packedQuantity')::integer from fixture, jsonb_array_elements(value->'items') item where name='edited_order_1' and item->>'productId'=pg_temp.id('prod_c')::text), 0, 'Newly added Prod C line starts with packedQuantity = 0');

-- Verify stock balances & automatic FIFO reconciliation to order_waiting_b
select is((select reserved from public.stock_balances where product_id=pg_temp.id('prod_a')), 1, 'Prod A reserved stock reduced from 2 to 1');
select is((select reserved from public.stock_balances where product_id=pg_temp.id('prod_b')), 4, 'Freed unit of Prod B was automatically reconciled to order_waiting_b');
select is(public.get_order(pg_temp.id('order_waiting_b'))->>'stockReadiness', 'ready', 'order_waiting_b became ready automatically after Prod B was removed from order_main');
select is((select reserved from public.stock_balances where product_id=pg_temp.id('prod_c')), 2, 'Prod C reserved stock increased to 2');

-- Verify audit history & preserved released reservations / packing events for removed Prod B line
select is((select count(*) from public.stock_reservations where order_id=pg_temp.id('order_main') and product_id=pg_temp.id('prod_b') and state='released' and order_item_id is null), 1::bigint, 'Removed line reservation remains in history as released with order_item_id set null');
select is((select count(*) from public.order_packing_events where order_id=pg_temp.id('order_main') and order_item_id is null), 2::bigint, 'Removed line packing events remain in history with order_item_id set null');

-- 5. Idempotency and conflict checks
select is(
  (public.update_order_items((select value from fixture where name='edit_op_1'))->>'actionRevision')::bigint,
  pg_temp.rev('order_main'),
  'Retrying the exact same update_order_items operation is idempotent'
);

select throws_ok(
  format(
    'select public.update_order_items(%L::jsonb)',
    jsonb_build_object(
      'orderId', pg_temp.id('order_main'),
      'operationId', (select value->>'operationId' from fixture where name='edit_op_1'),
      'expectedActionRevision', pg_temp.rev('order_main'),
      'items', jsonb_build_array(jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 2))
    )
  ),
  'P0001',
  'IDEMPOTENCY_KEY_REUSE_MISMATCH',
  'Reusing operationId with different items payload fails with IDEMPOTENCY_KEY_REUSE_MISMATCH'
);

select throws_ok(
  format(
    'select public.update_order_items(%L::jsonb)',
    jsonb_build_object(
      'orderId', pg_temp.id('order_main'),
      'operationId', gen_random_uuid(),
      'expectedActionRevision', 0,
      'items', jsonb_build_array(jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 2))
    )
  ),
  'P0001',
  'ORDER_ACTION_CHANGED',
  'Stale expectedActionRevision fails with ORDER_ACTION_CHANGED'
);

-- 6. Refresh percentage shipping fee, then test paid/fulfilled state guards + edit after reversal
select public.save_order_shipping_fee(jsonb_build_object(
  'orderId', pg_temp.id('order_main'),
  'operationId', gen_random_uuid(),
  'expectedRevision', (select shipping_fee_revision from public.orders where id=pg_temp.id('order_main')),
  'method', 'percentage',
  'basisPoints', 1000,
  'expectedCostCents', 240000
));
select public.transition_order(pg_temp.id('order_main'), 'mark_paid');
select throws_ok(
  format(
    'select public.update_order_items(%L::jsonb)',
    jsonb_build_object(
      'orderId', pg_temp.id('order_main'),
      'operationId', gen_random_uuid(),
      'expectedActionRevision', pg_temp.rev('order_main'),
      'items', jsonb_build_array(jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 1))
    )
  ),
  'P0001',
  'CANNOT_EDIT_PAID_ORDER',
  'Paid orders cannot be edited without reversing payment first'
);

select public.reverse_order_action(pg_temp.id('order_main'), 'reverse_payment', gen_random_uuid(), pg_temp.rev('order_main'));
select is(
  (public.update_order_items(jsonb_build_object(
    'orderId', pg_temp.id('order_main'),
    'operationId', gen_random_uuid(),
    'expectedActionRevision', pg_temp.rev('order_main'),
    'items', jsonb_build_array(
      jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 1)
    )
  ))->>'packingTracked')::boolean,
  true,
  'After reversing payment and removing unpacked Prod C, remaining 1/1 packed Prod A keeps packingTracked true'
);

-- 7. Cost sale editing & permissions
insert into fixture values('order_cost', public.confirm_imported_order(jsonb_build_object(
  'stockSource', 'normal',
  'customerName', 'Cliente Costo Edit',
  'phone', '5493415550201',
  'paymentMethod', 'cash',
  'deliveryMethod', 'pickup',
  'shippingType', null,
  'shippingFeeCents', 0,
  'quotedSubtotalCents', 200000,
  'quotedTotalCents', 200000,
  'protocolOrderId', gen_random_uuid(),
  'protocolChecksum', '1234ABC3',
  'lines', jsonb_build_array(
    jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 1, 'unitPriceCents', 200000)
  )
)));
select public.transition_order(pg_temp.id('order_cost'), 'mark_at_cost');
select public.reverse_order_action(pg_temp.id('order_cost'), 'reverse_payment', gen_random_uuid(), pg_temp.rev('order_cost'));

-- Switch to staff user: staff cannot edit cost orders
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000191002',true);
select throws_ok(
  format(
    'select public.update_order_items(%L::jsonb)',
    jsonb_build_object(
      'orderId', pg_temp.id('order_cost'),
      'operationId', gen_random_uuid(),
      'expectedActionRevision', pg_temp.rev('order_cost'),
      'items', jsonb_build_array(
        jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 1),
        jsonb_build_object('productId', pg_temp.id('prod_c'), 'quantity', 1)
      )
    )
  ),
  'P0001',
  'FORBIDDEN',
  'Staff without manage_pricing cannot edit a cost sale order'
);

-- Switch back to owner: owner can edit cost orders and new items use cost price with 0 tax
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000191001',true);
insert into fixture values('edited_cost', public.update_order_items(jsonb_build_object(
  'orderId', pg_temp.id('order_cost'),
  'operationId', gen_random_uuid(),
  'expectedActionRevision', pg_temp.rev('order_cost'),
  'items', jsonb_build_array(
    jsonb_build_object('productId', pg_temp.id('prod_a'), 'quantity', 1),
    jsonb_build_object('productId', pg_temp.id('prod_c'), 'quantity', 1)
  )
)));
select is((select value->>'subtotalCents' from fixture where name='edited_cost')::bigint, 180000::bigint, 'Cost order edit prices new item at unit cost (120k + 60k)');
select is((select value->>'taxAmountCents' from fixture where name='edited_cost')::bigint, 0::bigint, 'Cost order edit keeps taxAmountCents at 0');

-- 8. Export dataset includes edit_items in orderActionHistory
select ok(
  exists(
    select 1
    from jsonb_array_elements(public.get_business_export_dataset()->'orderActionHistory') entry
    where entry->>'orderId' = pg_temp.id('order_main')::text
      and entry->>'action' = 'edit_items'
  ),
  'get_business_export_dataset includes edit_items entries in orderActionHistory'
);

select * from finish();
rollback;
