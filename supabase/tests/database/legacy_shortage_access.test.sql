begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions, pg_temp;
select * from no_plan();

insert into auth.users(id,email,raw_user_meta_data)
values('00000000-0000-4000-8000-000000009701','shortage-access@test.local','{}');
update public.store_users set role='owner',active=true where user_id='00000000-0000-4000-8000-000000009701';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000009701',true);

select ok(not has_function_privilege('anon','public.declare_item_shortage(uuid,integer,text)','EXECUTE'),'Anonymous callers cannot invoke the unsafe single-item helper');
select ok(not has_function_privilege('authenticated','public.declare_item_shortage(uuid,integer,text)','EXECUTE'),'Application callers cannot bypass the complete shortage operations');
select ok(has_function_privilege('authenticated','public.declare_purchase_shortages(uuid,jsonb,uuid)','EXECUTE'),'The guarded shortage operation remains available');
select ok(has_function_privilege('authenticated','public.replace_purchase_shortage(uuid,integer,text,timestamptz,uuid)','EXECUTE'),'The atomic replacement operation remains available');

-- Exercise the actual application role, not a superuser with only a JWT claim.
set local role authenticated;
create temporary table shortage_access_fixture(name text primary key,value jsonb not null);
insert into shortage_access_fixture select 'product',public.save_product(jsonb_build_object(
  'sku','SHORTAGEACCESS','slug','shortage-access','name','Producto de prueba',
  'presentation','1 unidad','description','Prueba aislada','category','Pruebas',
  'imageUrl','/demo/test.svg','imageAlt','Prueba','priceCents',100000,'currentCostCents',60000,
  'reorderPoint',0,'safetyStock',0,'leadTimeDays',1,'active',true,'published',true,'featured',false));
insert into shortage_access_fixture select 'purchase',public.create_purchase(jsonb_build_object(
  'supplierName','Proveedor original','items',jsonb_build_array(jsonb_build_object(
  'productId',value->>'id','quantity',5,'unitCostCents',60000)))) from shortage_access_fixture where name='product';
insert into shortage_access_fixture select 'order',public.confirm_imported_order(jsonb_build_object(
  'customerName','Cliente de prueba','paymentMethod','cash','deliveryMethod','pickup','shippingFeeCents',0,
  'quotedSubtotalCents',300000,'quotedTotalCents',300000,'protocolOrderId','00000000-0000-4000-8000-000000009702','protocolChecksum','1234ABCD',
  'lines',jsonb_build_array(jsonb_build_object('productId',value->>'id','quantity',3,'unitPriceCents',100000))))
  from shortage_access_fixture where name='product';
select public.receive_purchase((value->>'id')::uuid,jsonb_build_array(jsonb_build_object(
  'purchaseItemId',value->'items'->0->>'id','receivedQuantity',1)),gen_random_uuid()) is not null
  from shortage_access_fixture where name='purchase';
insert into shortage_access_fixture select 'before',public.get_purchase_cancellation_preview((value->>'id')::uuid)
  from shortage_access_fixture where name='purchase';

select throws_ok(format('select public.declare_item_shortage(%L,4,null)',value->'items'->0->>'id'),
  '42501','permission denied for function declare_item_shortage','An old tab cannot close the item with active customer reservations')
  from shortage_access_fixture where name='purchase';
select is(public.get_purchase_cancellation_preview((value->>'id')::uuid),(select value from shortage_access_fixture where name='before'),
  'Denied legacy access preserves purchase, units and reservations') from shortage_access_fixture where name='purchase';
select throws_ok(format('select public.declare_purchase_shortages(%L,%L::jsonb,gen_random_uuid())',value->>'id',
  jsonb_build_array(jsonb_build_object('purchaseItemId',value->'items'->0->>'id','quantity',4))),
  'P0001','PURCHASE_SHORTAGE_UNRESOLVED','The supported batch refuses to abandon pending reservations')
  from shortage_access_fixture where name='purchase';
select is(public.get_purchase_cancellation_preview((value->>'id')::uuid),(select value from shortage_access_fixture where name='before'),
  'Rejected batch also preserves all purchase and reservation data') from shortage_access_fixture where name='purchase';

select lives_ok(format('insert into shortage_access_fixture select %L,public.replace_purchase_shortage(%L,4,%L,null,gen_random_uuid())',
  'replacement',value->'items'->0->>'id','Proveedor nuevo'),
  'An authenticated owner can still replace the shortage through the complete transaction') from shortage_access_fixture where name='purchase';
select is((value->'oldPurchase'->'items'->0->>'receivedQuantity')::integer,1,'The replacement preserves the unit actually received') from shortage_access_fixture where name='replacement';
select is((value->'oldPurchase'->'items'->0->>'shortageQuantity')::integer,4,'The internal helper still records the exact missing balance') from shortage_access_fixture where name='replacement';
select is((value->'newPurchase'->'items'->0->>'quantity')::integer,4,'The replacement requests exactly the missing balance') from shortage_access_fixture where name='replacement';
select is((public.get_purchase_impact((value->'newPurchase'->>'id')::uuid)->0->'reservedOrders'->0->>'reservedQuantity')::integer,2,
  'Only the two pending customer units move to the replacement') from shortage_access_fixture where name='replacement';

insert into shortage_access_fixture select 'free',public.create_purchase(jsonb_build_object(
  'supplierName','Compra sin reservas','items',jsonb_build_array(jsonb_build_object(
  'productId',value->>'id','quantity',2,'unitCostCents',60000)))) from shortage_access_fixture where name='product';
select lives_ok(format('select public.declare_purchase_shortages(%L,%L::jsonb,%L)',value->>'id',
  jsonb_build_array(jsonb_build_object('purchaseItemId',value->'items'->0->>'id','quantity',2)),
  '00000000-0000-4000-8000-000000009703'),'An authenticated owner can close a free shortage with zero received units')
  from shortage_access_fixture where name='free';
select is(public.declare_purchase_shortages((value->>'id')::uuid,
  jsonb_build_array(jsonb_build_object('purchaseItemId',value->'items'->0->>'id','quantity',2)),
  '00000000-0000-4000-8000-000000009703')->>'state','received','Retrying a supported shortage remains idempotent')
  from shortage_access_fixture where name='free';

set local role anon;
select throws_ok('select public.declare_item_shortage(null::uuid,1,null::text)',
  '42501','permission denied for function declare_item_shortage','An actual anonymous session cannot invoke the helper either');
reset role;
select * from finish();
rollback;
