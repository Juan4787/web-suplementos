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
  throw new Error('[partial-receive-idempotency] Contraseña no configurada o inválida.');
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

function createClient() {
  return new Client(dbConfig);
}

async function main() {
  console.log(`======================================================================`);
  console.log(`  TEST: IDEMPOTENCIA EN RECEPCIONES PARCIALES CON OPERATION_ID`);
  console.log(`======================================================================\n`);

  const setupClient = createClient();
  const clientA = createClient();
  const clientB = createClient();

  await Promise.all([
    setupClient.connect(),
    clientA.connect(),
    clientB.connect()
  ]);

  const createdOrderIds = [];
  const createdPurchaseIds = [];
  const createdProductIds = [];

  try {
    const ownerId = await setupOwnerUser(setupClient);
    await setupClient.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
    await setupClient.query("select set_config('request.jwt.claim.role', 'authenticated', false)");

    const runId = Date.now();

    // =========================================================================
    // PRUEBA 1: RETRY SECUENCIAL TRAS RESPUESTA PERDIDA
    // =========================================================================
    console.log(`[Prueba 1] Retry secuencial de recepción parcial de 3 sobre compra de 10...`);
    const sku1 = `PART-1-${runId}`;
    const p1Res = await setupClient.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku1, slug: `part-1-${runId}`, name: `Prod Partial 1 ${sku1}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 1000000, currentCostCents: 500000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod1Id = p1Res.rows[0].p.id;
    createdProductIds.push(prod1Id);

    // Compra de 10 unidades
    const purch1Res = await setupClient.query(`select public.create_purchase($1::jsonb) as purch`, [JSON.stringify({
      supplierName: `Proveedor Parcial 1 ${runId}`, orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Partial 1',
      items: [{ productId: prod1Id, quantity: 10, unitCostCents: 500000 }]
    })]);
    const purch1Id = purch1Res.rows[0].purch.id;
    createdPurchaseIds.push(purch1Id);
    const purch1ItemId = purch1Res.rows[0].purch.items[0].id;

    // Pedido que reserva 4 unidades incoming
    const ord1Res = await setupClient.query(`select public.confirm_imported_order($1::jsonb) as res`, [JSON.stringify({
      customerName: 'Cliente Parcial 1', customerPhone: '+5491100000000', phone: '+5491100000000',
      paymentMethod: 'transfer', deliveryMethod: 'pickup', shippingType: null, shippingFeeCents: 0,
      protocolOrderId: crypto.randomUUID(), protocolChecksum: 'CAFE0010',
      quotedSubtotalCents: 4000000, quotedTotalCents: 4000000,
      lines: [{ productId: prod1Id, quantity: 4, unitPriceCents: 1000000 }]
    })]);
    const order1Id = ord1Res.rows[0].res.id;
    createdOrderIds.push(order1Id);

    const operationIdA = crypto.randomUUID();

    // Primera recepción: Llegan 3 unidades
    console.log(`  → Envío 1: Recibiendo 3 unidades con operationId = ${operationIdA}...`);
    const res1 = await setupClient.query(`
      select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res
    `, [purch1Id, JSON.stringify([{ purchaseItemId: purch1ItemId, receivedQuantity: 3 }]), operationIdA]);

    const stateAfter1 = await setupClient.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select reserved from public.stock_balances where product_id = $1) as reserved,
        (select received_quantity from public.purchase_items where id = $2) as received_qty,
        (select count(*) from public.stock_movements where purchase_id = $3 and kind = 'purchase_received') as moves_count,
        (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'physical') as physical_res,
        (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'incoming') as incoming_res
    `, [prod1Id, purch1ItemId, purch1Id, order1Id]);

    const s1 = stateAfter1.rows[0];
    if (parseInt(s1.received_qty, 10) !== 3) throw new Error(`received_qty esperado 3, obtenido ${s1.received_qty}`);
    if (parseInt(s1.on_hand, 10) !== 3) throw new Error(`on_hand esperado 3, obtenido ${s1.on_hand}`);
    if (parseInt(s1.reserved, 10) !== 3) throw new Error(`reserved esperado 3, obtenido ${s1.reserved}`);
    if (parseInt(s1.moves_count, 10) !== 1) throw new Error(`moves_count esperado 1, obtenido ${s1.moves_count}`);
    if (parseInt(s1.physical_res, 10) !== 3) throw new Error(`physical_res esperado 3, obtenido ${s1.physical_res}`);
    if (parseInt(s1.incoming_res, 10) !== 1) throw new Error(`incoming_res esperado 1, obtenido ${s1.incoming_res}`);
    console.log(`  ✓ Envío 1 asentado: received = 3, on_hand = 3, reserved = 3, movimientos = 1`);

    // Segunda recepción (Simulando que el cliente perdió la respuesta de red y reintentó):
    console.log(`  → Envío 2: Reintentando exactamente la misma llamada con mismo operationId...`);
    const res1Retry = await setupClient.query(`
      select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res
    `, [purch1Id, JSON.stringify([{ purchaseItemId: purch1ItemId, receivedQuantity: 3 }]), operationIdA]);

    const stateAfterRetry = await setupClient.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select reserved from public.stock_balances where product_id = $1) as reserved,
        (select received_quantity from public.purchase_items where id = $2) as received_qty,
        (select count(*) from public.stock_movements where purchase_id = $3 and kind = 'purchase_received') as moves_count,
        (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'physical') as physical_res,
        (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $4 and state = 'active' and source_type = 'incoming') as incoming_res
    `, [prod1Id, purch1ItemId, purch1Id, order1Id]);

    const sRetry = stateAfterRetry.rows[0];
    if (parseInt(sRetry.received_qty, 10) !== 3) {
      throw new Error(`[CORRUPCIÓN DETECTADA] received_qty duplicó a ${sRetry.received_qty} en vez de mantenerse en 3`);
    }
    if (parseInt(sRetry.on_hand, 10) !== 3) {
      throw new Error(`[CORRUPCIÓN DETECTADA] on_hand duplicó a ${sRetry.on_hand} en vez de mantenerse en 3`);
    }
    if (parseInt(sRetry.reserved, 10) !== 3) {
      throw new Error(`[CORRUPCIÓN DETECTADA] reserved duplicó a ${sRetry.reserved}`);
    }
    if (parseInt(sRetry.moves_count, 10) !== 1) {
      throw new Error(`[CORRUPCIÓN DETECTADA] Movimientos de stock duplicados: ${sRetry.moves_count}`);
    }
    if (parseInt(sRetry.physical_res, 10) !== 3) {
      throw new Error(`[CORRUPCIÓN DETECTADA] Reservas físicas duplicadas: ${sRetry.physical_res}`);
    }
    if (parseInt(sRetry.incoming_res, 10) !== 1) {
      throw new Error(`[CORRUPCIÓN DETECTADA] Reservas incoming alteradas: ${sRetry.incoming_res}`);
    }

    console.log(`  ✓ Retry secuencial 100% IDEMPOTENTE: received se mantuvo en 3 (NO 6), on_hand en 3 (NO 6), 1 solo movimiento.`);

    // =========================================================================
    // PRUEBA 2: CARRERA CONCURRENTE CON MISMO OPERATION_ID
    // =========================================================================
    console.log(`\n[Prueba 2] Carrera concurrente: 2 transacciones simultáneas con el mismo operationId...`);
    const sku2 = `PART-2-${runId}`;
    const p2Res = await setupClient.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku2, slug: `part-2-${runId}`, name: `Prod Partial 2 ${sku2}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 1000000, currentCostCents: 500000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod2Id = p2Res.rows[0].p.id;
    createdProductIds.push(prod2Id);

    const purch2Res = await setupClient.query(`select public.create_purchase($1::jsonb) as purch`, [JSON.stringify({
      supplierName: `Proveedor Parcial 2 ${runId}`, orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Partial 2',
      items: [{ productId: prod2Id, quantity: 10, unitCostCents: 500000 }]
    })]);
    const purch2Id = purch2Res.rows[0].purch.id;
    createdPurchaseIds.push(purch2Id);
    const purch2ItemId = purch2Res.rows[0].purch.items[0].id;

    const operationIdConcurrent = crypto.randomUUID();

    await clientA.query('BEGIN');
    await clientA.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
    await clientA.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await clientA.query("set local lock_timeout = '3s'");

    await clientB.query('BEGIN');
    await clientB.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
    await clientB.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await clientB.query("set local lock_timeout = '3s'");

    const taskA = async () => {
      try {
        const res = await clientA.query(
          'select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res',
          [purch2Id, JSON.stringify([{ purchaseItemId: purch2ItemId, receivedQuantity: 3 }]), operationIdConcurrent]
        );
        await clientA.query('COMMIT');
        return res.rows[0]?.res;
      } catch (e) {
        try { await clientA.query('ROLLBACK'); } catch {}
        throw e;
      }
    };

    const taskB = async () => {
      try {
        const res = await clientB.query(
          'select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res',
          [purch2Id, JSON.stringify([{ purchaseItemId: purch2ItemId, receivedQuantity: 3 }]), operationIdConcurrent]
        );
        await clientB.query('COMMIT');
        return res.rows[0]?.res;
      } catch (e) {
        try { await clientB.query('ROLLBACK'); } catch {}
        throw e;
      }
    };

    console.log(`  → Disparando transacciones A y B en paralelo con operationId = ${operationIdConcurrent}...`);
    const [resultA, resultB] = await Promise.allSettled([taskA(), taskB()]);

    if (resultA.status !== 'fulfilled') {
      throw new Error(`Transacción A falló en carrera de idempotencia: ${resultA.reason?.message}`);
    }
    if (resultB.status !== 'fulfilled') {
      throw new Error(`Transacción B falló en carrera de idempotencia: ${resultB.reason?.message}`);
    }

    const stateConcurrent = await setupClient.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select received_quantity from public.purchase_items where id = $2) as received_qty,
        (select count(*) from public.stock_movements where purchase_id = $3 and kind = 'purchase_received') as moves_count
    `, [prod2Id, purch2ItemId, purch2Id]);

    const sc = stateConcurrent.rows[0];
    if (parseInt(sc.received_qty, 10) !== 3) {
      throw new Error(`[RACE CORRUPTION] received_qty sumó a ${sc.received_qty} en vez de 3`);
    }
    if (parseInt(sc.on_hand, 10) !== 3) {
      throw new Error(`[RACE CORRUPTION] on_hand sumó a ${sc.on_hand} en vez de 3`);
    }
    if (parseInt(sc.moves_count, 10) !== 1) {
      throw new Error(`[RACE CORRUPTION] Movimientos contables duplicados: ${sc.moves_count}`);
    }

    console.log(`  ✓ Carrera concurrente 100% EXITOSA: ambas transacciones finalizaron con éxito y el stock solo se acreditó una vez.`);

    // =========================================================================
    // PRUEBA 3: MISMA OPERATION_ID + CANTIDAD DISTINTA (MISMATCH PAYLOAD)
    // =========================================================================
    console.log(`\n[Prueba 3] Misma operationId + cantidad distinta -> rechazo por mismatch de payload...`);
    const sku3 = `PART-3-${runId}`;
    const p3Res = await setupClient.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku3, slug: `part-3-${runId}`, name: `Prod Partial 3 ${sku3}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 1000000, currentCostCents: 500000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod3Id = p3Res.rows[0].p.id;
    createdProductIds.push(prod3Id);

    const purch3Res = await setupClient.query(`select public.create_purchase($1::jsonb) as purch`, [JSON.stringify({
      supplierName: `Proveedor Parcial 3 ${runId}`, orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Partial 3',
      items: [{ productId: prod3Id, quantity: 10, unitCostCents: 500000 }]
    })]);
    const purch3Id = purch3Res.rows[0].purch.id;
    createdPurchaseIds.push(purch3Id);
    const purch3ItemId = purch3Res.rows[0].purch.items[0].id;

    const operationIdMismatchPayload = crypto.randomUUID();

    // 1. Recepción inicial de 3 unidades con operationIdMismatchPayload
    console.log(`  → Envío inicial: Recibiendo 3 unidades con operationId = ${operationIdMismatchPayload}...`);
    await setupClient.query(`
      select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res
    `, [purch3Id, JSON.stringify([{ purchaseItemId: purch3ItemId, receivedQuantity: 3 }]), operationIdMismatchPayload]);

    // 2. Reintento con la misma operationId pero payload de 5 unidades (mismatch)
    console.log(`  → Envío conflictivo: Reintentando con MISMA operationId pero cantidad = 5...`);
    let threwPayloadMismatch = false;
    try {
      await setupClient.query(`
        select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res
      `, [purch3Id, JSON.stringify([{ purchaseItemId: purch3ItemId, receivedQuantity: 5 }]), operationIdMismatchPayload]);
    } catch (err) {
      if (err.message.includes('IDEMPOTENCY_KEY_REUSE_MISMATCH')) {
        threwPayloadMismatch = true;
      } else {
        throw new Error(`Error inesperado al intentar reutilizar operationId con cantidad distinta: ${err.message}`);
      }
    }

    if (!threwPayloadMismatch) {
      throw new Error(`[FALLA DE SEGURIDAD] receive_purchase debió rechazar la operación con IDEMPOTENCY_KEY_REUSE_MISMATCH y no lo hizo.`);
    }

    // 3. Verificar que el stock y la compra no se alteraron
    const state3 = await setupClient.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select received_quantity from public.purchase_items where id = $2) as received_qty,
        (select count(*) from public.stock_movements where purchase_id = $3 and kind = 'purchase_received') as moves_count
    `, [prod3Id, purch3ItemId, purch3Id]);

    const s3 = state3.rows[0];
    if (parseInt(s3.received_qty, 10) !== 3) {
      throw new Error(`[CORRUPCIÓN DETECTADA] received_quantity se modificó a ${s3.received_qty} en vez de mantenerse en 3`);
    }
    if (parseInt(s3.on_hand, 10) !== 3) {
      throw new Error(`[CORRUPCIÓN DETECTADA] on_hand se modificó a ${s3.on_hand} en vez de mantenerse en 3`);
    }
    if (parseInt(s3.moves_count, 10) !== 1) {
      throw new Error(`[CORRUPCIÓN DETECTADA] Movimientos contables alterados: ${s3.moves_count}`);
    }
    console.log(`  ✓ Rechazo exitoso con IDEMPOTENCY_KEY_REUSE_MISMATCH: stock intacto en 3 (NO 5, NO 8), 1 solo movimiento.`);

    // =========================================================================
    // PRUEBA 4: MISMA OPERATION_ID + COMPRA DISTINTA (MISMATCH PURCHASE)
    // =========================================================================
    console.log(`\n[Prueba 4] Misma operationId + compra distinta -> rechazo por mismatch de compra...`);
    const sku4A = `PART-4A-${runId}`;
    const p4ARes = await setupClient.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku4A, slug: `part-4a-${runId}`, name: `Prod Partial 4A ${sku4A}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 1000000, currentCostCents: 500000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod4AId = p4ARes.rows[0].p.id;
    createdProductIds.push(prod4AId);

    const purch4ARes = await setupClient.query(`select public.create_purchase($1::jsonb) as purch`, [JSON.stringify({
      supplierName: `Proveedor Parcial 4A ${runId}`, orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Partial 4A',
      items: [{ productId: prod4AId, quantity: 10, unitCostCents: 500000 }]
    })]);
    const purch4AId = purch4ARes.rows[0].purch.id;
    createdPurchaseIds.push(purch4AId);
    const purch4AItemId = purch4ARes.rows[0].purch.items[0].id;

    const sku4B = `PART-4B-${runId}`;
    const p4BRes = await setupClient.query(`select public.save_product($1::jsonb) as p`, [JSON.stringify({
      sku: sku4B, slug: `part-4b-${runId}`, name: `Prod Partial 4B ${sku4B}`,
      presentation: '1kg', description: 'Test', category: 'Test',
      priceCents: 1000000, currentCostCents: 500000, reorderPoint: 1, safetyStock: 0, leadTimeDays: 3,
      imageUrl: '/demo/whey.svg', imageAlt: 'test', published: true, active: true, featured: false
    })]);
    const prod4BId = p4BRes.rows[0].p.id;
    createdProductIds.push(prod4BId);

    const purch4BRes = await setupClient.query(`select public.create_purchase($1::jsonb) as purch`, [JSON.stringify({
      supplierName: `Proveedor Parcial 4B ${runId}`, orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Partial 4B',
      items: [{ productId: prod4BId, quantity: 10, unitCostCents: 500000 }]
    })]);
    const purch4BId = purch4BRes.rows[0].purch.id;
    createdPurchaseIds.push(purch4BId);
    const purch4BItemId = purch4BRes.rows[0].purch.items[0].id;

    const operationIdMismatchPurchase = crypto.randomUUID();

    // 1. Recepción en Compra 4A con operationIdMismatchPurchase
    console.log(`  → Envío en Compra 4A: Recibiendo 2 unidades con operationId = ${operationIdMismatchPurchase}...`);
    await setupClient.query(`
      select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res
    `, [purch4AId, JSON.stringify([{ purchaseItemId: purch4AItemId, receivedQuantity: 2 }]), operationIdMismatchPurchase]);

    // 2. Intento de reutilizar la misma operationId en Compra 4B
    console.log(`  → Envío conflictivo: Intentando usar MISMA operationId en Compra 4B...`);
    let threwPurchaseMismatch = false;
    try {
      await setupClient.query(`
        select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res
      `, [purch4BId, JSON.stringify([{ purchaseItemId: purch4BItemId, receivedQuantity: 2 }]), operationIdMismatchPurchase]);
    } catch (err) {
      if (err.message.includes('IDEMPOTENCY_KEY_REUSE_MISMATCH')) {
        threwPurchaseMismatch = true;
      } else {
        throw new Error(`Error inesperado al intentar reutilizar operationId en compra distinta: ${err.message}`);
      }
    }

    if (!threwPurchaseMismatch) {
      throw new Error(`[FALLA DE SEGURIDAD] receive_purchase debió rechazar la operación en Compra 4B con IDEMPOTENCY_KEY_REUSE_MISMATCH y no lo hizo.`);
    }

    // 3. Verificar que Compra 4A sigue intacta y Compra 4B tiene CERO cambios
    const state4A = await setupClient.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select received_quantity from public.purchase_items where id = $2) as received_qty,
        (select count(*) from public.stock_movements where purchase_id = $3 and kind = 'purchase_received') as moves_count
    `, [prod4AId, purch4AItemId, purch4AId]);

    const state4B = await setupClient.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select received_quantity from public.purchase_items where id = $2) as received_qty,
        (select count(*) from public.stock_movements where purchase_id = $3 and kind = 'purchase_received') as moves_count
    `, [prod4BId, purch4BItemId, purch4BId]);

    const s4A = state4A.rows[0];
    const s4B = state4B.rows[0];

    if (parseInt(s4A.received_qty, 10) !== 2 || parseInt(s4A.on_hand, 10) !== 2 || parseInt(s4A.moves_count, 10) !== 1) {
      throw new Error(`[CORRUPCIÓN DETECTADA] Compra 4A fue afectada: received=${s4A.received_qty}, on_hand=${s4A.on_hand}`);
    }

    if (parseInt(s4B.received_qty, 10) !== 0 || parseInt(s4B.on_hand, 10) !== 0 || parseInt(s4B.moves_count, 10) !== 0) {
      throw new Error(`[CORRUPCIÓN DETECTADA] Compra 4B fue alterada indebidamente: received=${s4B.received_qty}, on_hand=${s4B.on_hand}`);
    }

    console.log(`  ✓ Rechazo exitoso con IDEMPOTENCY_KEY_REUSE_MISMATCH: Compra 4A intacta (2 un.), Compra 4B limpia con 0 un.`);

    console.log(`\n======================================================================`);
    console.log(`  RESULTADO: IDEMPOTENCIA EN RECEPCIONES PARCIALES 100% CERTIFICADA`);
    console.log(`======================================================================\n`);

  } finally {
    console.log(`[Cleanup] Limpiando entidades de test...`);
    if (createdOrderIds.length > 0) {
      await setupClient.query('delete from public.stock_movements where order_id = any($1::uuid[])', [createdOrderIds]);
      await setupClient.query('delete from public.stock_reservations where order_id = any($1::uuid[])', [createdOrderIds]);
      await setupClient.query('delete from public.order_items where order_id = any($1::uuid[])', [createdOrderIds]);
      await setupClient.query('delete from public.orders where id = any($1::uuid[])', [createdOrderIds]);
    }
    if (createdPurchaseIds.length > 0) {
      await setupClient.query('delete from public.purchase_receipts where purchase_id = any($1::uuid[])', [createdPurchaseIds]);
      await setupClient.query('delete from public.stock_movements where purchase_id = any($1::uuid[])', [createdPurchaseIds]);
      await setupClient.query('delete from public.purchase_items where purchase_id = any($1::uuid[])', [createdPurchaseIds]);
      await setupClient.query('delete from public.purchases where id = any($1::uuid[])', [createdPurchaseIds]);
    }
    if (createdProductIds.length > 0) {
      await setupClient.query('delete from public.stock_balances where product_id = any($1::uuid[])', [createdProductIds]);
      await setupClient.query('delete from public.product_financials where product_id = any($1::uuid[])', [createdProductIds]);
      await setupClient.query('delete from public.products where id = any($1::uuid[])', [createdProductIds]);
    }
    await Promise.all([
      setupClient.end(),
      clientA.end(),
      clientB.end()
    ]);
  }
}

main().catch((err) => {
  console.error('\n[FATAL PARTIAL RECEIVE IDEMPOTENCY FAILURE]', err.message);
  process.exit(1);
});
