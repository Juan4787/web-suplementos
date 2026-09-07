import { Client } from 'pg';
import crypto from 'node:crypto';
import { loadEnv } from 'vite';
import {
  PROJECT_ROOT,
  SUPABASE_PROJECT_REF,
  SUPABASE_PROJECT_REGION
} from './project-targets.mjs';
import { assertSupabaseTarget } from './validate-supabase-target.mjs';

assertSupabaseTarget();

const fileEnv = loadEnv('production', PROJECT_ROOT, '');
const password = (process.env.SUPABASE_DB_PASSWORD || fileEnv.SUPABASE_DB_PASSWORD)?.trim();
if (!password || password.length < 12) {
  throw new Error('[concurrency-test] Contraseña no configurada o inválida.');
}

let mode = 'confirm-vs-receive';
let iterations = 50;

const arg1 = process.argv[2];
const arg2 = process.argv[3];

if (arg1 === 'confirm-vs-shortage' || arg1 === 'confirm-vs-receive' || arg1 === 'confirm-vs-cancel' || arg1 === 'receive-vs-cancel' || arg1 === 'receive-vs-shortage') {
  mode = arg1;
  if (arg2) iterations = parseInt(arg2, 10);
} else if (arg1 && !isNaN(parseInt(arg1, 10))) {
  iterations = parseInt(arg1, 10);
}

const OWNER_USER_ID = '00000000-0000-4000-8000-000000000109';

const dbConfig = {
  host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`,
  port: 5432,
  database: 'postgres',
  user: `postgres.${SUPABASE_PROJECT_REF}`,
  password,
  ssl: { rejectUnauthorized: false }
};

function createClient() {
  return new Client(dbConfig);
}

async function setupOwnerUser(client) {
  const existing = await client.query('select id from auth.users where email = $1', ['race-owner@test.local']);
  let userId = OWNER_USER_ID;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
  } else {
    await client.query(`
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) values (
        '00000000-0000-0000-0000-000000000000',
        $1,
        'authenticated',
        'authenticated',
        'race-owner@test.local',
        crypt('test-password', gen_salt('bf')),
        now(),
        '{"provider":"email","providers":["email"]}',
        '{"display_name":"Race Owner"}',
        now(),
        now()
      )
    `, [userId]);
  }

  await client.query(`
    update public.store_users
    set role = 'owner', active = true
    where user_id = $1
  `, [userId]);

  return userId;
}

// -----------------------------------------------------------------------------
// TEST 1: confirm_imported_order vs receive_purchase
// -----------------------------------------------------------------------------
async function runIterationReceive(iter, setupClient, clientA, clientB, ownerId) {
  const iterSuffix = `${iter}-${Date.now()}`;
  const sku = `RACE-${iterSuffix}`;
  const protocolOrderId = crypto.randomUUID();
  const protocolChecksum = 'C001CAFE';

  // 1. Setup Fixture via setupClient
  await setupClient.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);

  const prodRes = await setupClient.query(`
    select public.save_product($1::jsonb) as prod
  `, [JSON.stringify({
    sku,
    slug: `whey-race-${iterSuffix.toLowerCase()}`,
    name: `Whey Race ${sku}`,
    presentation: '1kg',
    description: 'Producto para prueba de concurrencia extrema.',
    category: 'Proteínas',
    priceCents: 2500000,
    currentCostCents: 1500000,
    reorderPoint: 2,
    safetyStock: 1,
    leadTimeDays: 5,
    imageUrl: '/demo/whey.svg',
    imageAlt: 'Whey Race',
    published: true,
    active: true,
    featured: false
  })]);

  const productId = prodRes.rows[0].prod.id;

  const purchRes = await setupClient.query(`
    select public.create_purchase($1::jsonb) as purch
  `, [JSON.stringify({
    supplierName: `Proveedor Race ${sku}`,
    orderedAt: new Date().toISOString(),
    expectedAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    notes: `Compra de prueba concurrente ${sku}`,
    items: [
      { productId, quantity: 2, unitCostCents: 1500000 }
    ]
  })]);

  const purchaseId = purchRes.rows[0].purch.id;
  const purchaseItemId = purchRes.rows[0].purch.items[0].id;

  // 2. Iniciar transacciones A y B
  await clientA.query('BEGIN');
  await clientA.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientA.query("set local lock_timeout = '3s'");
  await clientA.query("set local statement_timeout = '8s'");

  await clientB.query('BEGIN');
  await clientB.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientB.query("set local lock_timeout = '3s'");
  await clientB.query("set local statement_timeout = '8s'");

  const orderPayload = {
    customerName: `Cliente Race ${sku}`,
    paymentMethod: 'transfer',
    deliveryMethod: 'pickup',
    shippingType: null,
    shippingFeeCents: 0,
    protocolOrderId,
    protocolChecksum,
    quotedSubtotalCents: 2500000,
    quotedTotalCents: 2500000,
    lines: [
      { productId, quantity: 1, unitPriceCents: 2500000 }
    ]
  };

  const receivePayload = [
    { purchaseItemId, receivedQuantity: 1 }
  ];

  let resA = null;
  let resB = null;
  let errA = null;
  let errB = null;
  const tStart = Date.now();
  const delayA = iter % 3 === 0 ? 15 : 0;
  const delayB = iter % 3 === 1 ? 15 : 0;

  const runTaskA = async () => {
    if (delayA > 0) await new Promise(r => setTimeout(r, delayA));
    return clientA.query(
      'select public.confirm_imported_order($1::jsonb) as res',
      [JSON.stringify(orderPayload)]
    ).then(async (r) => {
      await clientA.query('COMMIT');
      resA = r.rows[0]?.res;
    }).catch(async (e) => {
      try { await clientA.query('ROLLBACK'); } catch {}
      errA = e;
    });
  };

  const runTaskB = async () => {
    if (delayB > 0) await new Promise(r => setTimeout(r, delayB));
    return clientB.query(
      'select public.receive_purchase($1::uuid, $2::jsonb) as res',
      [purchaseId, JSON.stringify(receivePayload)]
    ).then(async (r) => {
      await clientB.query('COMMIT');
      resB = r.rows[0]?.res;
    }).catch(async (e) => {
      try { await clientB.query('ROLLBACK'); } catch {}
      errB = e;
    });
  };

  await Promise.all([runTaskA(), runTaskB()]);
  const elapsed = Date.now() - tStart;

  if (errA || errB) {
    const detailA = errA ? `${errA.message} | detail: ${errA.detail} | where: ${errA.where}` : 'none';
    const detailB = errB ? `${errB.message} | detail: ${errB.detail} | where: ${errB.where}` : 'none';
    throw new Error(`[RACE ERROR iter ${iter}]\nA: ${detailA}\nB: ${detailB}`);
  }

  // 4. Verificación de invariantes
  const verifyRes = await setupClient.query(`
    select
      (select count(*) from public.orders where protocol_order_id = $1) as orders_count,
      (select count(*) from public.order_items oi join public.orders o on o.id = oi.order_id where o.protocol_order_id = $1) as items_count,
      (select received_quantity from public.purchase_items where id = $2) as purch_received_qty,
      (select on_hand from public.stock_balances where product_id = $3) as on_hand,
      (select reserved from public.stock_balances where product_id = $3) as reserved,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active' and source_type = 'incoming') as incoming_reserved,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active' and source_type = 'physical') as physical_reserved,
      (select count(*) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active') as active_res_count,
      (select private.order_payload(id, false) ->> 'stockReadiness' from public.orders where protocol_order_id = $1) as stock_readiness
  `, [protocolOrderId, purchaseItemId, productId]);

  const v = verifyRes.rows[0];
  const invariantErrors = [];
  if (parseInt(v.orders_count, 10) !== 1) invariantErrors.push(`orders_count: expected 1, got ${v.orders_count}`);
  if (parseInt(v.items_count, 10) !== 1) invariantErrors.push(`items_count: expected 1, got ${v.items_count}`);
  if (parseInt(v.purch_received_qty, 10) !== 1) invariantErrors.push(`purch_received_qty: expected 1, got ${v.purch_received_qty}`);
  if (parseInt(v.on_hand, 10) !== 1) invariantErrors.push(`on_hand: expected 1, got ${v.on_hand}`);
  if (parseInt(v.reserved, 10) !== 1) invariantErrors.push(`reserved: expected 1, got ${v.reserved}`);
  if (parseInt(v.incoming_reserved, 10) !== 0) invariantErrors.push(`incoming_reserved: expected 0, got ${v.incoming_reserved}`);
  if (parseInt(v.physical_reserved, 10) !== 1) invariantErrors.push(`physical_reserved: expected 1, got ${v.physical_reserved}`);
  if (parseInt(v.active_res_count, 10) !== 1) invariantErrors.push(`active_res_count: expected 1, got ${v.active_res_count}`);
  if (v.stock_readiness !== 'ready') invariantErrors.push(`stock_readiness: expected 'ready', got '${v.stock_readiness}'`);

  if (invariantErrors.length > 0) {
    console.error(`[DEBUG iter ${iter}] resA:`, JSON.stringify(resA));
    console.error(`[DEBUG iter ${iter}] resB:`, JSON.stringify(resB));
    console.error(`[DEBUG iter ${iter}] Verification state:`, v);
    throw new Error(`[INVARIANT FAILURE iter ${iter}]: ${invariantErrors.join(', ')}`);
  }

  const unblockedOrders = resB?.unblockedOrders || [];
  const winner = unblockedOrders.some(o => o.number === resA?.number)
    ? 'CONFIRM_FIRST'
    : 'RECEIVE_FIRST';

  // 5. Cleanup
  await setupClient.query('delete from public.stock_movements where order_id in (select id from public.orders where protocol_order_id = $1) or purchase_id = $2 or product_id = $3', [protocolOrderId, purchaseId, productId]);
  await setupClient.query('delete from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) or purchase_item_id = $2', [protocolOrderId, purchaseItemId]);
  await setupClient.query('delete from public.order_items where order_id in (select id from public.orders where protocol_order_id = $1)', [protocolOrderId]);
  await setupClient.query('delete from public.orders where protocol_order_id = $1', [protocolOrderId]);
  await setupClient.query('delete from public.purchase_items where purchase_id = $1', [purchaseId]);
  await setupClient.query('delete from public.purchases where id = $1', [purchaseId]);
  await setupClient.query('delete from public.stock_balances where product_id = $1', [productId]);
  await setupClient.query('delete from public.product_financials where product_id = $1', [productId]);
  await setupClient.query('delete from public.products where id = $1', [productId]);

  return { elapsed, winner };
}

// -----------------------------------------------------------------------------
// TEST 2: confirm_imported_order vs close_purchase_with_shortage
// -----------------------------------------------------------------------------
async function runIterationShortage(iter, setupClient, clientA, clientB, ownerId) {
  const iterSuffix = `${iter}-${Date.now()}`;
  const sku = `RACE-SH-${iterSuffix}`;
  const protocolOrderId = crypto.randomUUID();
  const protocolChecksum = 'C001CAFE';

  // 1. Setup Fixture via setupClient
  await setupClient.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);

  const prodRes = await setupClient.query(`
    select public.save_product($1::jsonb) as prod
  `, [JSON.stringify({
    sku,
    slug: `whey-short-${iterSuffix.toLowerCase()}`,
    name: `Whey Shortage ${sku}`,
    presentation: '1kg',
    description: 'Producto para prueba de confirm vs close_shortage.',
    category: 'Proteínas',
    priceCents: 2500000,
    currentCostCents: 1500000,
    reorderPoint: 2,
    safetyStock: 1,
    leadTimeDays: 5,
    imageUrl: '/demo/whey.svg',
    imageAlt: 'Whey Shortage',
    published: true,
    active: true,
    featured: false
  })]);

  const productId = prodRes.rows[0].prod.id;

  // Crear orden de compra con exactamente 1 unidad en camino
  const purchRes = await setupClient.query(`
    select public.create_purchase($1::jsonb) as purch
  `, [JSON.stringify({
    supplierName: `Proveedor Shortage ${sku}`,
    orderedAt: new Date().toISOString(),
    expectedAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    notes: `Compra de prueba shortage ${sku}`,
    items: [
      { productId, quantity: 1, unitCostCents: 1500000 }
    ]
  })]);

  const purchaseId = purchRes.rows[0].purch.id;
  const purchaseItemId = purchRes.rows[0].purch.items[0].id;

  // 2. Iniciar transacciones A y B
  await clientA.query('BEGIN');
  await clientA.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientA.query("set local lock_timeout = '3s'");
  await clientA.query("set local statement_timeout = '8s'");

  await clientB.query('BEGIN');
  await clientB.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientB.query("set local lock_timeout = '3s'");
  await clientB.query("set local statement_timeout = '8s'");

  const orderPayload = {
    customerName: `Cliente Shortage ${sku}`,
    paymentMethod: 'transfer',
    deliveryMethod: 'pickup',
    shippingType: null,
    shippingFeeCents: 0,
    protocolOrderId,
    protocolChecksum,
    quotedSubtotalCents: 2500000,
    quotedTotalCents: 2500000,
    lines: [
      { productId, quantity: 1, unitPriceCents: 2500000 }
    ]
  };

  const tStart = Date.now();
  const delayA = iter % 3 === 0 ? 15 : 0;
  const delayB = iter % 3 === 1 ? 15 : 0;

  const runTaskA = async () => {
    if (delayA > 0) await new Promise(r => setTimeout(r, delayA));
    try {
      const res = await clientA.query(
        'select public.confirm_imported_order($1::jsonb) as res',
        [JSON.stringify(orderPayload)]
      );
      await clientA.query('COMMIT');
      return res.rows[0]?.res;
    } catch (err) {
      try { await clientA.query('ROLLBACK'); } catch {}
      throw err;
    }
  };

  const runTaskB = async () => {
    if (delayB > 0) await new Promise(r => setTimeout(r, delayB));
    try {
      const res = await clientB.query(
        'select public.close_purchase_with_shortage($1::uuid, $2::text) as res',
        [purchaseId, 'Cierre concurrente con faltante']
      );
      await clientB.query('COMMIT');
      return res.rows[0]?.res;
    } catch (err) {
      try { await clientB.query('ROLLBACK'); } catch {}
      throw err;
    }
  };

  const [resultA, resultB] = await Promise.allSettled([runTaskA(), runTaskB()]);
  const elapsed = Date.now() - tStart;

  // Task B (close_purchase_with_shortage) SIEMPRE debe tener éxito
  if (resultB.status !== 'fulfilled') {
    throw new Error(`[SHORTAGE FAILED iter ${iter}]: ${resultB.reason?.message || resultB.reason}`);
  }

  // Task A (confirm_imported_order) puede ser fulfilled o rechazada con INSUFFICIENT_STOCK
  if (resultA.status === 'rejected') {
    const msg = resultA.reason?.message || '';
    if (!msg.includes('INSUFFICIENT_STOCK')) {
      throw new Error(`[CONFIRM UNEXPECTED ERROR iter ${iter}]: ${msg} (code: ${resultA.reason?.code})`);
    }
  }

  // 4. Verificación de invariantes en base de datos
  const verifyRes = await setupClient.query(`
    select
      (select count(*) from public.orders where protocol_order_id = $1) as orders_count,
      (select count(*) from public.order_items oi join public.orders o on o.id = oi.order_id where o.protocol_order_id = $1) as items_count,
      (select state from public.purchases where id = $2) as purchase_state,
      (select received_quantity from public.purchase_items where id = $3) as received_quantity,
      (select shortage_quantity from public.purchase_items where id = $3) as shortage_quantity,
      (select on_hand from public.stock_balances where product_id = $4) as on_hand,
      (select reserved from public.stock_balances where product_id = $4) as reserved,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active' and source_type = 'incoming') as incoming_reserved,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active' and source_type = 'uncovered') as uncovered_reserved,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active' and source_type = 'physical') as physical_reserved,
      (select count(*) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active') as active_res_count,
      (select private.order_payload(id, false) ->> 'stockReadiness' from public.orders where protocol_order_id = $1) as stock_readiness
  `, [protocolOrderId, purchaseId, purchaseItemId, productId]);

  const v = verifyRes.rows[0];
  const invariantErrors = [];

  // Invariantes universales para ambos resultados
  if (v.purchase_state !== 'received') invariantErrors.push(`purchase_state: expected 'received', got '${v.purchase_state}'`);
  if (parseInt(v.received_quantity, 10) !== 0) invariantErrors.push(`received_quantity: expected 0, got ${v.received_quantity}`);
  if (parseInt(v.shortage_quantity, 10) !== 1) invariantErrors.push(`shortage_quantity: expected 1, got ${v.shortage_quantity}`);
  if (parseInt(v.on_hand, 10) !== 0) invariantErrors.push(`on_hand: expected 0, got ${v.on_hand}`);
  if (parseInt(v.reserved, 10) !== 0) invariantErrors.push(`reserved: expected 0, got ${v.reserved}`);
  if (parseInt(v.incoming_reserved, 10) !== 0) invariantErrors.push(`incoming_reserved: expected 0, got ${v.incoming_reserved}`);
  if (parseInt(v.physical_reserved, 10) !== 0) invariantErrors.push(`physical_reserved: expected 0, got ${v.physical_reserved}`);

  let winner = '';
  const ordersCount = parseInt(v.orders_count, 10);

  if (ordersCount === 1) {
    // Resultado A: CONFIRM ganó primero
    winner = 'CONFIRM_FIRST';
    if (resultA.status !== 'fulfilled') invariantErrors.push('resultA should be fulfilled when order exists');
    if (parseInt(v.items_count, 10) !== 1) invariantErrors.push(`items_count: expected 1, got ${v.items_count}`);
    if (parseInt(v.uncovered_reserved, 10) !== 1) invariantErrors.push(`uncovered_reserved: expected 1, got ${v.uncovered_reserved}`);
    if (parseInt(v.active_res_count, 10) !== 1) invariantErrors.push(`active_res_count: expected 1, got ${v.active_res_count}`);
    if (v.stock_readiness !== 'uncovered') invariantErrors.push(`stock_readiness: expected 'uncovered', got '${v.stock_readiness}'`);
  } else if (ordersCount === 0) {
    // Resultado B: CLOSE SHORTAGE ganó primero
    winner = 'SHORTAGE_FIRST';
    if (resultA.status !== 'rejected') invariantErrors.push('resultA should be rejected when order does not exist');
    if (parseInt(v.items_count, 10) !== 0) invariantErrors.push(`items_count: expected 0, got ${v.items_count}`);
    if (parseInt(v.uncovered_reserved, 10) !== 0) invariantErrors.push(`uncovered_reserved: expected 0, got ${v.uncovered_reserved}`);
    if (parseInt(v.active_res_count, 10) !== 0) invariantErrors.push(`active_res_count: expected 0, got ${v.active_res_count}`);
    if (v.stock_readiness !== null) invariantErrors.push(`stock_readiness: expected null, got '${v.stock_readiness}'`);
  } else {
    invariantErrors.push(`unexpected orders_count: ${ordersCount}`);
  }

  if (invariantErrors.length > 0) {
    console.error(`[DEBUG SHORTAGE iter ${iter}] Verification state:`, v);
    throw new Error(`[INVARIANT FAILURE iter ${iter}]: ${invariantErrors.join(', ')}`);
  }

  // 5. Cleanup
  await setupClient.query('delete from public.stock_movements where order_id in (select id from public.orders where protocol_order_id = $1) or purchase_id = $2 or product_id = $3', [protocolOrderId, purchaseId, productId]);
  await setupClient.query('delete from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) or purchase_item_id = $2', [protocolOrderId, purchaseItemId]);
  await setupClient.query('delete from public.order_items where order_id in (select id from public.orders where protocol_order_id = $1)', [protocolOrderId]);
  await setupClient.query('delete from public.orders where protocol_order_id = $1', [protocolOrderId]);
  await setupClient.query('delete from public.purchase_items where purchase_id = $1', [purchaseId]);
  await setupClient.query('delete from public.purchases where id = $1', [purchaseId]);
  await setupClient.query('delete from public.stock_balances where product_id = $1', [productId]);
  await setupClient.query('delete from public.product_financials where product_id = $1', [productId]);
  await setupClient.query('delete from public.products where id = $1', [productId]);

  return { elapsed, winner };
}

// -----------------------------------------------------------------------------
// TEST 3: confirm_imported_order vs cancel purchase
// -----------------------------------------------------------------------------
async function runIterationCancel(iter, setupClient, clientA, clientB, ownerId) {
  const iterSuffix = `${iter}-${Date.now()}`;
  const sku = `RACE-CN-${iterSuffix}`;
  const protocolOrderId = crypto.randomUUID();
  const protocolChecksum = 'C001CAFE';

  // 1. Setup Fixture via setupClient
  await setupClient.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);

  const prodRes = await setupClient.query(`
    select public.save_product($1::jsonb) as prod
  `, [JSON.stringify({
    sku,
    slug: `whey-cancel-${iterSuffix.toLowerCase()}`,
    name: `Whey Cancel ${sku}`,
    presentation: '1kg',
    description: 'Producto para prueba de confirm vs cancel purchase.',
    category: 'Proteínas',
    priceCents: 2500000,
    currentCostCents: 1500000,
    reorderPoint: 2,
    safetyStock: 1,
    leadTimeDays: 5,
    imageUrl: '/demo/whey.svg',
    imageAlt: 'Whey Cancel',
    published: true,
    active: true,
    featured: false
  })]);

  const productId = prodRes.rows[0].prod.id;

  // Crear orden de compra con exactamente 1 unidad en camino
  const purchRes = await setupClient.query(`
    select public.create_purchase($1::jsonb) as purch
  `, [JSON.stringify({
    supplierName: `Proveedor Cancel ${sku}`,
    orderedAt: new Date().toISOString(),
    expectedAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    notes: `Compra de prueba cancel ${sku}`,
    items: [
      { productId, quantity: 1, unitCostCents: 1500000 }
    ]
  })]);

  const purchaseId = purchRes.rows[0].purch.id;
  const purchaseItemId = purchRes.rows[0].purch.items[0].id;

  // 2. Iniciar transacciones A y B
  await clientA.query('BEGIN');
  await clientA.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientA.query("set local lock_timeout = '3s'");
  await clientA.query("set local statement_timeout = '8s'");

  await clientB.query('BEGIN');
  await clientB.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientB.query("set local lock_timeout = '3s'");
  await clientB.query("set local statement_timeout = '8s'");

  const orderPayload = {
    customerName: `Cliente Cancel ${sku}`,
    paymentMethod: 'transfer',
    deliveryMethod: 'pickup',
    shippingType: null,
    shippingFeeCents: 0,
    protocolOrderId,
    protocolChecksum,
    quotedSubtotalCents: 2500000,
    quotedTotalCents: 2500000,
    lines: [
      { productId, quantity: 1, unitPriceCents: 2500000 }
    ]
  };

  const tStart = Date.now();
  const delayA = iter % 3 === 0 ? 15 : 0;
  const delayB = iter % 3 === 1 ? 15 : 0;

  const runTaskA = async () => {
    if (delayA > 0) await new Promise(r => setTimeout(r, delayA));
    try {
      const res = await clientA.query(
        'select public.confirm_imported_order($1::jsonb) as res',
        [JSON.stringify(orderPayload)]
      );
      await clientA.query('COMMIT');
      return res.rows[0]?.res;
    } catch (err) {
      try { await clientA.query('ROLLBACK'); } catch {}
      throw err;
    }
  };

  const runTaskB = async () => {
    if (delayB > 0) await new Promise(r => setTimeout(r, delayB));
    try {
      const res = await clientB.query(
        "update public.purchases set state = 'cancelled' where id = $1 returning id, state",
        [purchaseId]
      );
      await clientB.query('COMMIT');
      return res.rows[0];
    } catch (err) {
      try { await clientB.query('ROLLBACK'); } catch {}
      throw err;
    }
  };

  const [resultA, resultB] = await Promise.allSettled([runTaskA(), runTaskB()]);
  const elapsed = Date.now() - tStart;

  // Verificación de los resultados de las promesas:
  // En este escenario EXACTAMENTE UNA de las dos debe ser fulfilled y la otra rejected
  if (resultA.status === 'fulfilled' && resultB.status === 'fulfilled') {
    throw new Error(`[RACE CORRUPTION iter ${iter}]: Both confirm and cancel succeeded! Purchase should not be cancelled if reserved.`);
  }
  if (resultA.status === 'rejected' && resultB.status === 'rejected') {
    throw new Error(`[RACE CORRUPTION iter ${iter}]: Both operations failed! A: ${resultA.reason?.message}, B: ${resultB.reason?.message}`);
  }

  if (resultA.status === 'rejected') {
    const msg = resultA.reason?.message || '';
    if (!msg.includes('INSUFFICIENT_STOCK')) {
      throw new Error(`[CONFIRM UNEXPECTED ERROR iter ${iter}]: ${msg} (code: ${resultA.reason?.code})`);
    }
  }

  if (resultB.status === 'rejected') {
    const msg = resultB.reason?.message || '';
    if (!msg.includes('CANNOT_CANCEL_PURCHASE_WITH_ACTIVE_RESERVATIONS')) {
      throw new Error(`[CANCEL UNEXPECTED ERROR iter ${iter}]: ${msg} (code: ${resultB.reason?.code})`);
    }
  }

  // 4. Verificación de invariantes en base de datos
  const verifyRes = await setupClient.query(`
    select
      (select count(*) from public.orders where protocol_order_id = $1) as orders_count,
      (select count(*) from public.order_items oi join public.orders o on o.id = oi.order_id where o.protocol_order_id = $1) as items_count,
      (select state from public.purchases where id = $2) as purchase_state,
      (select on_hand from public.stock_balances where product_id = $3) as on_hand,
      (select reserved from public.stock_balances where product_id = $3) as reserved,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active' and source_type = 'incoming') as incoming_reserved,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active' and source_type = 'uncovered') as uncovered_reserved,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active' and source_type = 'physical') as physical_reserved,
      (select count(*) from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) and state = 'active') as active_res_count,
      (select private.order_payload(id, false) ->> 'stockReadiness' from public.orders where protocol_order_id = $1) as stock_readiness
  `, [protocolOrderId, purchaseId, productId]);

  const v = verifyRes.rows[0];
  const invariantErrors = [];

  // Invariantes universales para ambos resultados
  if (parseInt(v.on_hand, 10) !== 0) invariantErrors.push(`on_hand: expected 0, got ${v.on_hand}`);
  if (parseInt(v.reserved, 10) !== 0) invariantErrors.push(`reserved: expected 0, got ${v.reserved}`);
  if (parseInt(v.uncovered_reserved, 10) !== 0) invariantErrors.push(`uncovered_reserved: expected 0, got ${v.uncovered_reserved}`);
  if (parseInt(v.physical_reserved, 10) !== 0) invariantErrors.push(`physical_reserved: expected 0, got ${v.physical_reserved}`);

  let winner = '';
  const ordersCount = parseInt(v.orders_count, 10);

  if (ordersCount === 1) {
    // Resultado A: CONFIRM ganó primero
    winner = 'CONFIRM_FIRST';
    if (resultA.status !== 'fulfilled') invariantErrors.push('resultA should be fulfilled when order exists');
    if (resultB.status !== 'rejected') invariantErrors.push('resultB should be rejected when confirm won');
    if (v.purchase_state !== 'ordered') invariantErrors.push(`purchase_state: expected 'ordered', got '${v.purchase_state}'`);
    if (parseInt(v.items_count, 10) !== 1) invariantErrors.push(`items_count: expected 1, got ${v.items_count}`);
    if (parseInt(v.incoming_reserved, 10) !== 1) invariantErrors.push(`incoming_reserved: expected 1, got ${v.incoming_reserved}`);
    if (parseInt(v.active_res_count, 10) !== 1) invariantErrors.push(`active_res_count: expected 1, got ${v.active_res_count}`);
    if (v.stock_readiness !== 'waiting_incoming') invariantErrors.push(`stock_readiness: expected 'waiting_incoming', got '${v.stock_readiness}'`);
  } else if (ordersCount === 0) {
    // Resultado B: CANCEL ganó primero
    winner = 'CANCEL_FIRST';
    if (resultA.status !== 'rejected') invariantErrors.push('resultA should be rejected when order does not exist');
    if (resultB.status !== 'fulfilled') invariantErrors.push('resultB should be fulfilled when cancel won');
    if (v.purchase_state !== 'cancelled') invariantErrors.push(`purchase_state: expected 'cancelled', got '${v.purchase_state}'`);
    if (parseInt(v.items_count, 10) !== 0) invariantErrors.push(`items_count: expected 0, got ${v.items_count}`);
    if (parseInt(v.incoming_reserved, 10) !== 0) invariantErrors.push(`incoming_reserved: expected 0, got ${v.incoming_reserved}`);
    if (parseInt(v.active_res_count, 10) !== 0) invariantErrors.push(`active_res_count: expected 0, got ${v.active_res_count}`);
    if (v.stock_readiness !== null) invariantErrors.push(`stock_readiness: expected null, got '${v.stock_readiness}'`);
  } else {
    invariantErrors.push(`unexpected orders_count: ${ordersCount}`);
  }

  if (invariantErrors.length > 0) {
    console.error(`[DEBUG CANCEL iter ${iter}] Verification state:`, v);
    throw new Error(`[INVARIANT FAILURE iter ${iter}]: ${invariantErrors.join(', ')}`);
  }

  // 5. Cleanup
  await setupClient.query('delete from public.stock_movements where order_id in (select id from public.orders where protocol_order_id = $1) or purchase_id = $2 or product_id = $3', [protocolOrderId, purchaseId, productId]);
  await setupClient.query('delete from public.stock_reservations where order_id in (select id from public.orders where protocol_order_id = $1) or purchase_item_id = $2', [protocolOrderId, purchaseItemId]);
  await setupClient.query('delete from public.order_items where order_id in (select id from public.orders where protocol_order_id = $1)', [protocolOrderId]);
  await setupClient.query('delete from public.orders where protocol_order_id = $1', [protocolOrderId]);
  await setupClient.query('delete from public.purchase_items where purchase_id = $1', [purchaseId]);
  await setupClient.query('delete from public.purchases where id = $1', [purchaseId]);
  await setupClient.query('delete from public.stock_balances where product_id = $1', [productId]);
  await setupClient.query('delete from public.product_financials where product_id = $1', [productId]);
  await setupClient.query('delete from public.products where id = $1', [productId]);

  return { elapsed, winner };
}

// -----------------------------------------------------------------------------
// TEST 4: receive_purchase vs cancel order (transition_order)
// -----------------------------------------------------------------------------
async function runIterationReceiveCancel(iter, setupClient, clientA, clientB, ownerId) {
  const iterSuffix = `${iter}-${Date.now()}`;
  const sku = `RACE-RC-${iterSuffix}`;
  const protocolOrderId = crypto.randomUUID();
  const protocolChecksum = 'C001CAFE';

  // 1. Setup Fixture via setupClient
  await setupClient.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);

  const prodRes = await setupClient.query(`
    select public.save_product($1::jsonb) as prod
  `, [JSON.stringify({
    sku,
    slug: `whey-rc-${iterSuffix.toLowerCase()}`,
    name: `Whey RecCancel ${sku}`,
    presentation: '1kg',
    description: 'Producto para prueba de receive vs cancel order.',
    category: 'Proteínas',
    priceCents: 2500000,
    currentCostCents: 1500000,
    reorderPoint: 2,
    safetyStock: 1,
    leadTimeDays: 5,
    imageUrl: '/demo/whey.svg',
    imageAlt: 'Whey RecCancel',
    published: true,
    active: true,
    featured: false
  })]);

  const productId = prodRes.rows[0].prod.id;

  // Crear orden de compra con exactamente 1 unidad en camino
  const purchRes = await setupClient.query(`
    select public.create_purchase($1::jsonb) as purch
  `, [JSON.stringify({
    supplierName: `Proveedor RC ${sku}`,
    orderedAt: new Date().toISOString(),
    expectedAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    notes: `Compra de prueba receive cancel ${sku}`,
    items: [
      { productId, quantity: 1, unitCostCents: 1500000 }
    ]
  })]);

  const purchaseId = purchRes.rows[0].purch.id;
  const purchaseItemId = purchRes.rows[0].purch.items[0].id;

  // Confirmar pedido que reserva exactamente 1 unidad incoming
  const orderRes = await setupClient.query(`
    select public.confirm_imported_order($1::jsonb) as res
  `, [JSON.stringify({
    customerName: `Cliente RC ${sku}`,
    paymentMethod: 'transfer',
    deliveryMethod: 'pickup',
    shippingType: null,
    shippingFeeCents: 0,
    protocolOrderId,
    protocolChecksum,
    quotedSubtotalCents: 2500000,
    quotedTotalCents: 2500000,
    lines: [
      { productId, quantity: 1, unitPriceCents: 2500000 }
    ]
  })]);

  const orderId = orderRes.rows[0].res.id;

  // 2. Iniciar transacciones A y B
  await clientA.query('BEGIN');
  await clientA.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientA.query("set local lock_timeout = '3s'");
  await clientA.query("set local statement_timeout = '8s'");

  await clientB.query('BEGIN');
  await clientB.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientB.query("set local lock_timeout = '3s'");
  await clientB.query("set local statement_timeout = '8s'");

  const tStart = Date.now();
  const delayA = iter % 3 === 0 ? 25 : iter % 3 === 2 ? 0 : 0;
  const delayB = iter % 3 === 1 ? 25 : iter % 3 === 2 ? 0 : 5;

  const runTaskA = async () => {
    if (delayA > 0) await new Promise(r => setTimeout(r, delayA));
    try {
      const res = await clientA.query(
        'select public.receive_purchase($1::uuid, $2::jsonb) as res',
        [purchaseId, JSON.stringify([{ purchaseItemId, receivedQuantity: 1 }])]
      );
      await clientA.query('COMMIT');
      return res.rows[0]?.res;
    } catch (err) {
      try { await clientA.query('ROLLBACK'); } catch {}
      throw err;
    }
  };

  const runTaskB = async () => {
    if (delayB > 0) await new Promise(r => setTimeout(r, delayB));
    try {
      const res = await clientB.query(
        'select public.transition_order($1::uuid, $2::text) as res',
        [orderId, 'cancel']
      );
      await clientB.query('COMMIT');
      return res.rows[0]?.res;
    } catch (err) {
      try { await clientB.query('ROLLBACK'); } catch {}
      throw err;
    }
  };

  const [resultA, resultB] = await Promise.allSettled([runTaskA(), runTaskB()]);
  const elapsed = Date.now() - tStart;

  // Ambas operaciones deben terminar exitosamente (fulfilled)
  if (resultA.status !== 'fulfilled') {
    throw new Error(`[RECEIVE FAILED iter ${iter}]: ${resultA.reason?.message || resultA.reason} (code: ${resultA.reason?.code})`);
  }
  if (resultB.status !== 'fulfilled') {
    throw new Error(`[CANCEL FAILED iter ${iter}]: ${resultB.reason?.message || resultB.reason} (code: ${resultB.reason?.code})`);
  }

  // 4. Verificación de invariantes en base de datos
  const verifyRes = await setupClient.query(`
    select
      (select state from public.purchases where id = $1) as purchase_state,
      (select received_quantity from public.purchase_items where id = $2) as received_quantity,
      (select shortage_quantity from public.purchase_items where id = $2) as shortage_quantity,
      (select on_hand from public.stock_balances where product_id = $3) as on_hand,
      (select reserved from public.stock_balances where product_id = $3) as reserved,
      (select order_state from public.orders where id = $4) as order_state,
      (select fulfillment_state from public.orders where id = $4) as fulfillment_state,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'incoming') as incoming_active,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'physical') as physical_active,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'uncovered') as uncovered_active,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'released') as released_qty,
      (select count(*) from public.stock_reservations where order_id = $4 and state = 'active') as active_res_count
  `, [purchaseId, purchaseItemId, productId, orderId]);

  const v = verifyRes.rows[0];
  const invariantErrors = [];

  if (v.purchase_state !== 'received') invariantErrors.push(`purchase_state: expected 'received', got '${v.purchase_state}'`);
  if (parseInt(v.received_quantity, 10) !== 1) invariantErrors.push(`received_quantity: expected 1, got ${v.received_quantity}`);
  if (parseInt(v.shortage_quantity, 10) !== 0) invariantErrors.push(`shortage_quantity: expected 0, got ${v.shortage_quantity}`);
  if (parseInt(v.on_hand, 10) !== 1) invariantErrors.push(`on_hand: expected 1, got ${v.on_hand}`);
  if (parseInt(v.reserved, 10) !== 0) invariantErrors.push(`reserved: expected 0, got ${v.reserved}`);
  if (v.order_state !== 'cancelled') invariantErrors.push(`order_state: expected 'cancelled', got '${v.order_state}'`);
  if (v.fulfillment_state !== 'cancelled') invariantErrors.push(`fulfillment_state: expected 'cancelled', got '${v.fulfillment_state}'`);
  if (parseInt(v.incoming_active, 10) !== 0) invariantErrors.push(`incoming_active: expected 0, got ${v.incoming_active}`);
  if (parseInt(v.physical_active, 10) !== 0) invariantErrors.push(`physical_active: expected 0, got ${v.physical_active}`);
  if (parseInt(v.uncovered_active, 10) !== 0) invariantErrors.push(`uncovered_active: expected 0, got ${v.uncovered_active}`);
  if (parseInt(v.active_res_count, 10) !== 0) invariantErrors.push(`active_res_count: expected 0, got ${v.active_res_count}`);
  if (parseInt(v.released_qty, 10) !== 1) invariantErrors.push(`released_qty: expected 1, got ${v.released_qty}`);

  if (invariantErrors.length > 0) {
    console.error(`[DEBUG RECEIVE_CANCEL iter ${iter}] Verification state:`, v);
    throw new Error(`[INVARIANT FAILURE iter ${iter}]: ${invariantErrors.join(', ')}`);
  }

  const unblockedOrders = resultA.value?.unblockedOrders || [];
  const winner = unblockedOrders.some(o => o.id === orderId || o.number === orderRes.rows[0].res.number)
    ? 'RECEIVE_FIRST'
    : 'CANCEL_FIRST';

  // 5. Cleanup
  await setupClient.query('delete from public.stock_movements where order_id = $1 or purchase_id = $2 or product_id = $3', [orderId, purchaseId, productId]);
  await setupClient.query('delete from public.stock_reservations where order_id = $1 or purchase_item_id = $2', [orderId, purchaseItemId]);
  await setupClient.query('delete from public.order_items where order_id = $1', [orderId]);
  await setupClient.query('delete from public.orders where id = $1', [orderId]);
  await setupClient.query('delete from public.purchase_items where purchase_id = $1', [purchaseId]);
  await setupClient.query('delete from public.purchases where id = $1', [purchaseId]);
  await setupClient.query('delete from public.stock_balances where product_id = $1', [productId]);
  await setupClient.query('delete from public.product_financials where product_id = $1', [productId]);
  await setupClient.query('delete from public.products where id = $1', [productId]);

  return { elapsed, winner };
}

// -----------------------------------------------------------------------------
// TEST 5: receive_purchase vs close_purchase_with_shortage
// -----------------------------------------------------------------------------
async function runIterationReceiveShortage(iter, setupClient, clientA, clientB, ownerId) {
  const iterSuffix = `${iter}-${Date.now()}`;
  const sku = `RACE-RS-${iterSuffix}`;
  const protocolOrderId = crypto.randomUUID();
  const protocolChecksum = 'C001CAFE';

  // 1. Setup Fixture via setupClient
  await setupClient.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);

  const prodRes = await setupClient.query(`
    select public.save_product($1::jsonb) as prod
  `, [JSON.stringify({
    sku,
    slug: `whey-rs-${iterSuffix.toLowerCase()}`,
    name: `Whey RecShort ${sku}`,
    presentation: '1kg',
    description: 'Producto para prueba de receive vs close_purchase_with_shortage.',
    category: 'Proteínas',
    priceCents: 2500000,
    currentCostCents: 1500000,
    reorderPoint: 2,
    safetyStock: 1,
    leadTimeDays: 5,
    imageUrl: '/demo/whey.svg',
    imageAlt: 'Whey RecShort',
    published: true,
    active: true,
    featured: false
  })]);

  const productId = prodRes.rows[0].prod.id;

  // Crear orden de compra con exactamente 1 unidad en camino
  const purchRes = await setupClient.query(`
    select public.create_purchase($1::jsonb) as purch
  `, [JSON.stringify({
    supplierName: `Proveedor RS ${sku}`,
    orderedAt: new Date().toISOString(),
    expectedAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    notes: `Compra de prueba receive shortage ${sku}`,
    items: [
      { productId, quantity: 1, unitCostCents: 1500000 }
    ]
  })]);

  const purchaseId = purchRes.rows[0].purch.id;
  const purchaseItemId = purchRes.rows[0].purch.items[0].id;

  // Confirmar pedido que reserva exactamente 1 unidad incoming
  const orderRes = await setupClient.query(`
    select public.confirm_imported_order($1::jsonb) as res
  `, [JSON.stringify({
    customerName: `Cliente RS ${sku}`,
    paymentMethod: 'transfer',
    deliveryMethod: 'pickup',
    shippingType: null,
    shippingFeeCents: 0,
    protocolOrderId,
    protocolChecksum,
    quotedSubtotalCents: 2500000,
    quotedTotalCents: 2500000,
    lines: [
      { productId, quantity: 1, unitPriceCents: 2500000 }
    ]
  })]);

  const orderId = orderRes.rows[0].res.id;

  // 2. Iniciar transacciones A y B
  await clientA.query('BEGIN');
  await clientA.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientA.query("set local lock_timeout = '3s'");
  await clientA.query("set local statement_timeout = '8s'");

  await clientB.query('BEGIN');
  await clientB.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
  await clientB.query("set local lock_timeout = '3s'");
  await clientB.query("set local statement_timeout = '8s'");

  const tStart = Date.now();
  const delayA = iter % 3 === 0 ? 25 : iter % 3 === 2 ? 0 : 0;
  const delayB = iter % 3 === 1 ? 25 : iter % 3 === 2 ? 0 : 5;

  const runTaskA = async () => {
    if (delayA > 0) await new Promise(r => setTimeout(r, delayA));
    try {
      const res = await clientA.query(
        'select public.receive_purchase($1::uuid, $2::jsonb) as res',
        [purchaseId, JSON.stringify([{ purchaseItemId, receivedQuantity: 1 }])]
      );
      await clientA.query('COMMIT');
      return res.rows[0]?.res;
    } catch (err) {
      try { await clientA.query('ROLLBACK'); } catch {}
      throw err;
    }
  };

  const runTaskB = async () => {
    if (delayB > 0) await new Promise(r => setTimeout(r, delayB));
    try {
      const res = await clientB.query(
        'select public.close_purchase_with_shortage($1::uuid, $2::text) as res',
        [purchaseId, 'Faltante definitivo del distribuidor']
      );
      await clientB.query('COMMIT');
      return res.rows[0]?.res;
    } catch (err) {
      try { await clientB.query('ROLLBACK'); } catch {}
      throw err;
    }
  };

  const [resultA, resultB] = await Promise.allSettled([runTaskA(), runTaskB()]);
  const elapsed = Date.now() - tStart;

  // En esta contienda EXACTAMENTE UNO debe ganar y el otro debe fallar limpiamente con INVALID_PURCHASE_STATE o OVER_RECEIVING_NOT_ALLOWED
  if (resultA.status === 'fulfilled' && resultB.status === 'fulfilled') {
    throw new Error(`[RACE CORRUPTION iter ${iter}]: Both receive and close_shortage succeeded!`);
  }
  if (resultA.status === 'rejected' && resultB.status === 'rejected') {
    throw new Error(`[RACE CORRUPTION iter ${iter}]: Both operations failed! A: ${resultA.reason?.message}, B: ${resultB.reason?.message}`);
  }

  if (resultA.status === 'rejected') {
    const msg = resultA.reason?.message || '';
    if (!msg.includes('INVALID_PURCHASE_STATE') && !msg.includes('OVER_RECEIVING_NOT_ALLOWED')) {
      throw new Error(`[RECEIVE UNEXPECTED ERROR iter ${iter}]: ${msg} (code: ${resultA.reason?.code})`);
    }
  }

  if (resultB.status === 'rejected') {
    const msg = resultB.reason?.message || '';
    if (!msg.includes('INVALID_PURCHASE_STATE')) {
      throw new Error(`[SHORTAGE UNEXPECTED ERROR iter ${iter}]: ${msg} (code: ${resultB.reason?.code})`);
    }
  }

  // 4. Verificación de invariantes en base de datos
  const verifyRes = await setupClient.query(`
    select
      (select state from public.purchases where id = $1) as purchase_state,
      (select received_quantity from public.purchase_items where id = $2) as received_quantity,
      (select shortage_quantity from public.purchase_items where id = $2) as shortage_quantity,
      (select on_hand from public.stock_balances where product_id = $3) as on_hand,
      (select reserved from public.stock_balances where product_id = $3) as reserved,
      (select order_state from public.orders where id = $4) as order_state,
      (select fulfillment_state from public.orders where id = $4) as fulfillment_state,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'incoming') as incoming_active,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'physical') as physical_active,
      (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'uncovered') as uncovered_active,
      (select count(*) from public.stock_reservations where order_id = $4 and state = 'active') as active_res_count,
      (select private.order_payload(id, false) ->> 'stockReadiness' from public.orders where id = $4) as stock_readiness
  `, [purchaseId, purchaseItemId, productId, orderId]);

  const v = verifyRes.rows[0];
  const invariantErrors = [];

  const recQty = parseInt(v.received_quantity, 10);
  const shoQty = parseInt(v.shortage_quantity, 10);

  if (v.purchase_state !== 'received') invariantErrors.push(`purchase_state: expected 'received', got '${v.purchase_state}'`);
  if (recQty + shoQty !== 1) invariantErrors.push(`capacity sum (received + shortage): expected 1, got ${recQty + shoQty}`);
  if (parseInt(v.incoming_active, 10) !== 0) invariantErrors.push(`incoming_active: expected 0, got ${v.incoming_active}`);
  if (parseInt(v.active_res_count, 10) !== 1) invariantErrors.push(`active_res_count: expected 1, got ${v.active_res_count}`);

  let winner = '';
  if (resultA.status === 'fulfilled') {
    winner = 'RECEIVE_FIRST';
    if (resultB.status !== 'rejected') invariantErrors.push('resultB should be rejected when receive won');
    if (recQty !== 1) invariantErrors.push(`received_quantity: expected 1, got ${recQty}`);
    if (shoQty !== 0) invariantErrors.push(`shortage_quantity: expected 0, got ${shoQty}`);
    if (parseInt(v.on_hand, 10) !== 1) invariantErrors.push(`on_hand: expected 1, got ${v.on_hand}`);
    if (parseInt(v.reserved, 10) !== 1) invariantErrors.push(`reserved: expected 1, got ${v.reserved}`);
    if (parseInt(v.physical_active, 10) !== 1) invariantErrors.push(`physical_active: expected 1, got ${v.physical_active}`);
    if (parseInt(v.uncovered_active, 10) !== 0) invariantErrors.push(`uncovered_active: expected 0, got ${v.uncovered_active}`);
    if (v.stock_readiness !== 'ready') invariantErrors.push(`stock_readiness: expected 'ready', got '${v.stock_readiness}'`);
  } else {
    winner = 'SHORTAGE_FIRST';
    if (resultA.status !== 'rejected') invariantErrors.push('resultA should be rejected when shortage won');
    if (recQty !== 0) invariantErrors.push(`received_quantity: expected 0, got ${recQty}`);
    if (shoQty !== 1) invariantErrors.push(`shortage_quantity: expected 1, got ${shoQty}`);
    if (parseInt(v.on_hand, 10) !== 0) invariantErrors.push(`on_hand: expected 0, got ${v.on_hand}`);
    if (parseInt(v.reserved, 10) !== 0) invariantErrors.push(`reserved: expected 0, got ${v.reserved}`);
    if (parseInt(v.physical_active, 10) !== 0) invariantErrors.push(`physical_active: expected 0, got ${v.physical_active}`);
    if (parseInt(v.uncovered_active, 10) !== 1) invariantErrors.push(`uncovered_active: expected 1, got ${v.uncovered_active}`);
    if (v.stock_readiness !== 'uncovered') invariantErrors.push(`stock_readiness: expected 'uncovered', got '${v.stock_readiness}'`);
  }

  if (invariantErrors.length > 0) {
    console.error(`[DEBUG RECEIVE_SHORTAGE iter ${iter}] Verification state:`, v);
    throw new Error(`[INVARIANT FAILURE iter ${iter}]: ${invariantErrors.join(', ')}`);
  }

  // 5. Cleanup
  await setupClient.query('delete from public.stock_movements where order_id = $1 or purchase_id = $2 or product_id = $3', [orderId, purchaseId, productId]);
  await setupClient.query('delete from public.stock_reservations where order_id = $1 or purchase_item_id = $2', [orderId, purchaseItemId]);
  await setupClient.query('delete from public.order_items where order_id = $1', [orderId]);
  await setupClient.query('delete from public.orders where id = $1', [orderId]);
  await setupClient.query('delete from public.purchase_items where purchase_id = $1', [purchaseId]);
  await setupClient.query('delete from public.purchases where id = $1', [purchaseId]);
  await setupClient.query('delete from public.stock_balances where product_id = $1', [productId]);
  await setupClient.query('delete from public.product_financials where product_id = $1', [productId]);
  await setupClient.query('delete from public.products where id = $1', [productId]);

  return { elapsed, winner };
}

async function main() {
  const runnerFn = mode === 'receive-vs-shortage'
    ? runIterationReceiveShortage
    : mode === 'receive-vs-cancel'
      ? runIterationReceiveCancel
      : mode === 'confirm-vs-cancel'
        ? runIterationCancel
        : mode === 'confirm-vs-shortage'
          ? runIterationShortage
          : runIterationReceive;
  const title = mode === 'receive-vs-shortage'
    ? 'receive_purchase vs close_purchase_with_shortage'
    : mode === 'receive-vs-cancel'
      ? 'receive_purchase vs cancel order (transition_order)'
      : mode === 'confirm-vs-cancel'
        ? 'confirm_imported_order vs cancel purchase'
        : mode === 'confirm-vs-shortage' 
          ? 'confirm_imported_order vs close_purchase_with_shortage'
          : 'confirm_imported_order vs receive_purchase';

  console.log(`======================================================================`);
  console.log(`  STRESS TEST CONCURRENTE: ${title}`);
  console.log(`  Modo: ${mode} | Iteraciones: ${iterations} | Conexiones: 3       `);
  console.log(`======================================================================\n`);

  const setupClient = createClient();
  const clientA = createClient();
  const clientB = createClient();

  await Promise.all([
    setupClient.connect(),
    clientA.connect(),
    clientB.connect()
  ]);

  console.log(`[INFO] 3 conexiones PostgreSQL establecidas exitosamente con Supabase remoto.`);
  const ownerId = await setupOwnerUser(setupClient);

  // Limpieza inicial defensiva de posibles residuos de pruebas
  await setupClient.query(`
    delete from public.stock_movements where product_id in (select id from public.products where sku like 'RACE%');
    delete from public.stock_reservations where product_id in (select id from public.products where sku like 'RACE%');
    delete from public.order_items where product_id in (select id from public.products where sku like 'RACE%');
    delete from public.orders where id not in (select distinct order_id from public.order_items);
    delete from public.purchase_items where product_id in (select id from public.products where sku like 'RACE%');
    delete from public.purchases where id not in (select distinct purchase_id from public.purchase_items);
    delete from public.stock_balances where product_id in (select id from public.products where sku like 'RACE%');
    delete from public.product_financials where product_id in (select id from public.products where sku like 'RACE%');
    delete from public.products where sku like 'RACE%';
  `);

  let winnerACount = 0;
  let winnerBCount = 0;
  const tTotalStart = Date.now();

  const labelA = mode === 'receive-vs-shortage'
    ? 'Gana RECEIVE (physical / ready)'
    : mode === 'receive-vs-cancel'
      ? 'Gana RECEIVE (converted physical)'
      : mode === 'confirm-vs-cancel'
        ? 'Gana CONFIRM (cancel blocked)'
        : mode === 'confirm-vs-shortage'
          ? 'Gana CONFIRM (uncovered)'
          : 'Gana CONFIRM (incoming)';
  const labelB = mode === 'receive-vs-shortage'
    ? 'Gana SHORTAGE (uncovered / reject)'
    : mode === 'receive-vs-cancel'
      ? 'Gana CANCEL (released incoming)'
      : mode === 'confirm-vs-cancel'
        ? 'Gana CANCEL (confirm rollback)'
        : mode === 'confirm-vs-shortage'
          ? 'Gana SHORTAGE (rollback)'
          : 'Gana RECEIVE (physical)';

  try {
    for (let i = 1; i <= iterations; i++) {
      const { elapsed, winner } = await runnerFn(i, setupClient, clientA, clientB, ownerId);
      if (winner.startsWith('CONFIRM') || winner.startsWith('RECEIVE')) winnerACount++;
      else winnerBCount++;

      console.log(`[PASS ${String(i).padStart(3, ' ')}/${iterations}] ${winner.padEnd(16, ' ')} | ${elapsed}ms`);
    }

    const totalElapsed = ((Date.now() - tTotalStart) / 1000).toFixed(2);
    console.log(`\n======================================================================`);
    console.log(`  RESULTADOS FINALES DE CONCURRENCIA`);
    console.log(`======================================================================`);
    console.log(`  Iteraciones completadas : ${iterations}/${iterations} (100% PASS)`);
    console.log(`  ${labelA.padEnd(25, ' ')}: ${winnerACount}`);
    console.log(`  ${labelB.padEnd(25, ' ')}: ${winnerBCount}`);
    console.log(`  Deadlocks detectados    : 0`);
    console.log(`  Lock timeouts           : 0`);
    console.log(`  Statement timeouts      : 0`);
    console.log(`  Invariantes violadas    : 0`);
    console.log(`  Tiempo total            : ${totalElapsed}s`);
    console.log(`======================================================================\n`);
  } finally {
    await Promise.all([
      setupClient.end(),
      clientA.end(),
      clientB.end()
    ]);
  }
}

main().catch((err) => {
  console.error('\n[FATAL CONCURRENCY FAILURE]', err.message);
  process.exit(1);
});
