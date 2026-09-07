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
  throw new Error('[idempotency-test] Contraseña no configurada o inválida.');
}

const dbConfig = {
  host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`,
  port: 5432,
  database: 'postgres',
  user: `postgres.${SUPABASE_PROJECT_REF}`,
  password,
  ssl: { rejectUnauthorized: false }
};

const OWNER_USER_ID = '00000000-0000-4000-8000-000000000109';

async function setupOwnerUser(client) {
  const existing = await client.query('select id from auth.users where email = $1', ['race-owner@test.local']);
  let userId = OWNER_USER_ID;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
  }
  await client.query(`
    update public.store_users
    set role = 'owner', active = true
    where user_id = $1
  `, [userId]);
  return userId;
}

async function main() {
  console.log(`======================================================================`);
  console.log(`  TEST 3: RETRY E IDEMPOTENCIA TRAS TIMEOUT DE CLIENTE`);
  console.log(`======================================================================\n`);

  const client = new Client(dbConfig);
  await client.connect();

  const createdOrderIds = [];
  const createdPurchaseIds = [];
  const createdProductIds = [];

  try {
    const ownerId = await setupOwnerUser(client);
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
    await client.query("select set_config('request.jwt.claim.role', 'authenticated', false)");

    const runId = Date.now();

    // =========================================================================
    // CASO 1: Idempotencia en confirm_imported_order
    // =========================================================================
    console.log(`[Caso 1] Retry en confirm_imported_order tras timeout...`);
    const sku1 = `IDEM-1-${runId}`;
    const p1Res = await client.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku1, slug: `idem-1-${runId}`, name: `Prod Idem 1 ${sku1}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 1000000, currentCostCents: 500000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod1Id = p1Res.rows[0].p.id;
    createdProductIds.push(prod1Id);

    // Stock inicial 5
    await client.query(`update public.stock_balances set on_hand = 5, reserved = 0 where product_id = $1`, [prod1Id]);

    const protocolOrderId1 = crypto.randomUUID();
    const orderPayload1 = {
      customerName: 'Cliente Retry 1',
      customerPhone: '+5491100000000',
      phone: '+5491100000000',
      paymentMethod: 'transfer',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      protocolOrderId: protocolOrderId1,
      protocolChecksum: 'CAFE0001',
      quotedSubtotalCents: 2000000,
      quotedTotalCents: 2000000,
      lines: [{ productId: prod1Id, quantity: 2, unitPriceCents: 1000000 }]
    };

    // Envío 1: Éxito
    const conf1 = await client.query(`select public.confirm_imported_order($1::jsonb) as res`, [JSON.stringify(orderPayload1)]);
    const order1Id = conf1.rows[0].res.id;
    createdOrderIds.push(order1Id);

    // Envío 2 (Simulación Retry de cliente por timeout):
    const conf1Retry = await client.query(`select public.confirm_imported_order($1::jsonb) as res`, [JSON.stringify(orderPayload1)]);
    const order1RetryId = conf1Retry.rows[0].res.id;

    if (order1Id !== order1RetryId) throw new Error(`Retry devolvió orden distinta: ${order1Id} vs ${order1RetryId}`);

    const stateOrder1 = await client.query(`
      select
        (select count(*) from public.orders where protocol_order_id = $1) as order_count,
        (select reserved from public.stock_balances where product_id = $2) as reserved,
        (select count(*) from public.stock_reservations where order_id = $3) as res_count
    `, [protocolOrderId1, prod1Id, order1Id]);

    const so1 = stateOrder1.rows[0];
    if (parseInt(so1.order_count, 10) !== 1) throw new Error(`Se duplicó la orden en retry: count = ${so1.order_count}`);
    if (parseInt(so1.reserved, 10) !== 2) throw new Error(`Se duplicó el reservado en retry: reserved = ${so1.reserved}`);
    if (parseInt(so1.res_count, 10) !== 1) throw new Error(`Se duplicaron las reservas: count = ${so1.res_count}`);

    console.log(`  ✓ confirm_imported_order es 100% idempotente: no duplicó pedido, reservas ni stock.`);

    // =========================================================================
    // CASO 2: Retry en receive_purchase
    // =========================================================================
    console.log(`\n[Caso 2] Retry en receive_purchase sobre compra ya recibida...`);
    const sku2 = `IDEM-2-${runId}`;
    const p2Res = await client.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku2, slug: `idem-2-${runId}`, name: `Prod Idem 2 ${sku2}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 2000000, currentCostCents: 1000000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod2Id = p2Res.rows[0].p.id;
    createdProductIds.push(prod2Id);

    const purch2Res = await client.query(`select public.create_purchase($1::jsonb) as purch`, [JSON.stringify({
      supplierName: `Proveedor Idem 2 ${runId}`, orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Idem 2',
      items: [{ productId: prod2Id, quantity: 3, unitCostCents: 1000000 }]
    })]);
    const purch2Id = purch2Res.rows[0].purch.id;
    createdPurchaseIds.push(purch2Id);
    const purch2ItemId = purch2Res.rows[0].purch.items[0].id;

    // Envío 1: Éxito (Recibir 3 unidades)
    await client.query(`
      select public.receive_purchase($1::uuid, $2::jsonb)
    `, [purch2Id, JSON.stringify([{ purchaseItemId: purch2ItemId, receivedQuantity: 3 }])]);

    // Envío 2 (Simulación Retry de cliente por timeout):
    let receiveRetryRejected = false;
    try {
      await client.query(`
        select public.receive_purchase($1::uuid, $2::jsonb)
      `, [purch2Id, JSON.stringify([{ purchaseItemId: purch2ItemId, receivedQuantity: 3 }])]);
    } catch (e) {
      if (e.message.includes('INVALID_PURCHASE_STATE') || e.message.includes('OVER_RECEIVING_NOT_ALLOWED')) {
        receiveRetryRejected = true;
      } else {
        throw new Error(`Excepción inesperada en retry de recepción: ${e.message}`);
      }
    }

    if (!receiveRetryRejected) throw new Error('El retry de recepción debió ser rechazado limpiamente');

    const statePurch2 = await client.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select received_quantity from public.purchase_items where id = $2) as received_qty,
        (select count(*) from public.stock_movements where purchase_id = $3 and kind = 'purchase_received') as move_count
    `, [prod2Id, purch2ItemId, purch2Id]);

    const sp2 = statePurch2.rows[0];
    if (parseInt(sp2.on_hand, 10) !== 3) throw new Error(`on_hand duplicado por retry de recepción: on_hand = ${sp2.on_hand}`);
    if (parseInt(sp2.received_qty, 10) !== 3) throw new Error(`received_quantity duplicado: ${sp2.received_qty}`);
    if (parseInt(sp2.move_count, 10) !== 1) throw new Error(`Movimientos de recepción duplicados: ${sp2.move_count}`);

    console.log(`  ✓ receive_purchase rechazó limpiamente el retry: no duplicó stock ni movimientos.`);

    // =========================================================================
    // CASO 3: Retry en transition_order('mark_delivered')
    // =========================================================================
    console.log(`\n[Caso 3] Retry en transition_order('mark_delivered') sobre pedido ya entregado...`);
    const sku3 = `IDEM-3-${runId}`;
    const p3Res = await client.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku3, slug: `idem-3-${runId}`, name: `Prod Idem 3 ${sku3}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 3000000, currentCostCents: 1500000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod3Id = p3Res.rows[0].p.id;
    createdProductIds.push(prod3Id);

    // Stock inicial 2
    await client.query(`update public.stock_balances set on_hand = 2, reserved = 0 where product_id = $1`, [prod3Id]);

    const protocolOrderId3 = crypto.randomUUID();
    const ord3Res = await client.query(`select public.confirm_imported_order($1::jsonb) as res`, [JSON.stringify({
      customerName: 'Cliente Retry 3', customerPhone: '+5491100000000', phone: '+5491100000000',
      paymentMethod: 'transfer', deliveryMethod: 'pickup', shippingType: null, shippingFeeCents: 0,
      protocolOrderId: protocolOrderId3, protocolChecksum: 'CAFE0003',
      quotedSubtotalCents: 3000000, quotedTotalCents: 3000000,
      lines: [{ productId: prod3Id, quantity: 1, unitPriceCents: 3000000 }]
    })]);
    const order3Id = ord3Res.rows[0].res.id;
    createdOrderIds.push(order3Id);

    // Envío 1: Entregar pedido
    await client.query(`select public.transition_order($1::uuid, 'mark_delivered')`, [order3Id]);

    // Envío 2 (Simulación Retry de cliente):
    let deliveryRetryRejected = false;
    try {
      await client.query(`select public.transition_order($1::uuid, 'mark_delivered')`, [order3Id]);
    } catch (e) {
      if (e.message.includes('INVALID_TRANSITION')) {
        deliveryRetryRejected = true;
      } else {
        throw new Error(`Excepción inesperada en retry de entrega: ${e.message}`);
      }
    }

    if (!deliveryRetryRejected) throw new Error('El retry de entrega debió ser rechazado con INVALID_TRANSITION');

    const stateOrder3 = await client.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select reserved from public.stock_balances where product_id = $1) as reserved,
        (select count(*) from public.stock_movements where order_id = $2 and kind = 'sale') as sale_moves
    `, [prod3Id, order3Id]);

    const so3 = stateOrder3.rows[0];
    if (parseInt(so3.on_hand, 10) !== 1) throw new Error(`on_hand descontado dos veces: ${so3.on_hand}`);
    if (parseInt(so3.reserved, 10) !== 0) throw new Error(`reserved corrupto: ${so3.reserved}`);
    if (parseInt(so3.sale_moves, 10) !== 1) throw new Error(`Movimiento de venta duplicado: ${so3.sale_moves}`);

    console.log(`  ✓ transition_order('mark_delivered') rechazó limpiamente el retry: no descontó stock de más.`);

    // =========================================================================
    // CASO 4: Retry en close_purchase_with_shortage
    // =========================================================================
    console.log(`\n[Caso 4] Retry en close_purchase_with_shortage sobre compra ya cerrada...`);
    const sku4 = `IDEM-4-${runId}`;
    const p4Res = await client.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku4, slug: `idem-4-${runId}`, name: `Prod Idem 4 ${sku4}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 2000000, currentCostCents: 1000000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod4Id = p4Res.rows[0].p.id;
    createdProductIds.push(prod4Id);

    const purch4Res = await client.query(`select public.create_purchase($1::jsonb) as purch`, [JSON.stringify({
      supplierName: `Proveedor Idem 4 ${runId}`, orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Idem 4',
      items: [{ productId: prod4Id, quantity: 2, unitCostCents: 1000000 }]
    })]);
    const purch4Id = purch4Res.rows[0].purch.id;
    createdPurchaseIds.push(purch4Id);
    const purch4ItemId = purch4Res.rows[0].purch.items[0].id;

    // Envío 1: Cerrar con faltante
    await client.query(`select public.close_purchase_with_shortage($1::uuid, 'Faltante original')`, [purch4Id]);

    // Envío 2 (Simulación Retry de cliente):
    let shortageRetryRejected = false;
    try {
      await client.query(`select public.close_purchase_with_shortage($1::uuid, 'Faltante retry')`, [purch4Id]);
    } catch (e) {
      if (e.message.includes('INVALID_PURCHASE_STATE')) {
        shortageRetryRejected = true;
      } else {
        throw new Error(`Excepción inesperada en retry de shortage: ${e.message}`);
      }
    }

    if (!shortageRetryRejected) throw new Error('El retry de shortage debió ser rechazado con INVALID_PURCHASE_STATE');

    const statePurch4 = await client.query(`
      select shortage_quantity from public.purchase_items where id = $1
    `, [purch4ItemId]);

    if (parseInt(statePurch4.rows[0].shortage_quantity, 10) !== 2) {
      throw new Error(`shortage_quantity alterado en retry: ${statePurch4.rows[0].shortage_quantity}`);
    }

    console.log(`  ✓ close_purchase_with_shortage rechazó limpiamente el retry: no alteró datos.`);

    console.log(`\n======================================================================`);
    console.log(`  RESULTADO: TEST 3 (RETRY E IDEMPOTENCIA) 100% EXITOSO`);
    console.log(`  Las 4 operaciones críticas son inmunes a reintentos tras timeout.`);
    console.log(`======================================================================\n`);

  } finally {
    console.log(`[Cleanup] Limpiando entidades de test de idempotencia...`);
    if (createdOrderIds.length > 0) {
      await client.query('delete from public.stock_movements where order_id = any($1::uuid[])', [createdOrderIds]);
      await client.query('delete from public.stock_reservations where order_id = any($1::uuid[])', [createdOrderIds]);
      await client.query('delete from public.order_items where order_id = any($1::uuid[])', [createdOrderIds]);
      await client.query('delete from public.orders where id = any($1::uuid[])', [createdOrderIds]);
    }
    if (createdPurchaseIds.length > 0) {
      await client.query('delete from public.stock_movements where purchase_id = any($1::uuid[])', [createdPurchaseIds]);
      await client.query('delete from public.purchase_items where purchase_id = any($1::uuid[])', [createdPurchaseIds]);
      await client.query('delete from public.purchases where id = any($1::uuid[])', [createdPurchaseIds]);
    }
    if (createdProductIds.length > 0) {
      await client.query('delete from public.stock_balances where product_id = any($1::uuid[])', [createdProductIds]);
      await client.query('delete from public.product_financials where product_id = any($1::uuid[])', [createdProductIds]);
      await client.query('delete from public.products where id = any($1::uuid[])', [createdProductIds]);
    }
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n[FATAL IDEMPOTENCY FAILURE]', err.message);
  process.exit(1);
});
