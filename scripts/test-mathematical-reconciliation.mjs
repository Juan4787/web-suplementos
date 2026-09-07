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
  throw new Error('[reconciliation-test] Contraseña no configurada o inválida.');
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
  console.log(`  TEST 2: RECONCILIACIÓN MATEMÁTICA GLOBAL DE INVENTARIO Y CONTABILIDAD`);
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
    console.log(`[Paso 1] Creando fixture multivariable (3 productos, 2 compras, stocks dispares)...`);

    // Crear 3 productos
    const prods = [
      { key: 'A', name: 'Creatina Creapure', price: 3500000, cost: 1000000, initial: 5 },
      { key: 'B', name: 'Whey Isolate', price: 4500000, cost: 2000000, initial: 0 },
      { key: 'C', name: 'Pre-Workout Shot', price: 2000000, cost: 800000, initial: 2 }
    ];

    const prodMap = {};
    for (const p of prods) {
      const sku = `RECON-${p.key}-${runId}`;
      const res = await client.query(`
        select public.save_product($1::jsonb) as prod
      `, [JSON.stringify({
        sku,
        slug: `recon-${p.key.toLowerCase()}-${runId}`,
        name: `${p.name} ${sku}`,
        presentation: '500g',
        description: 'Test reconciliación matemática.',
        category: 'Suplementos',
        priceCents: p.price,
        currentCostCents: p.cost,
        reorderPoint: 2,
        safetyStock: 1,
        leadTimeDays: 5,
        imageUrl: '/demo/whey.svg',
        imageAlt: p.name,
        published: true,
        active: true,
        featured: false
      })]);
      const id = res.rows[0].prod.id;
      createdProductIds.push(id);
      prodMap[p.key] = { id, sku, initial: p.initial, cost: p.cost, price: p.price };

      if (p.initial > 0) {
        await client.query(`
          update public.stock_balances
          set on_hand = $1, reserved = 0
          where product_id = $2
        `, [p.initial, id]);
      }
    }

    console.log(`  ✓ Productos creados: A (init: 5), B (init: 0), C (init: 2)`);

    // Crear 2 órdenes de compra
    // Compra 1: A = 10 (@1.100.000), B = 8 (@2.100.000)
    const purch1Res = await client.query(`
      select public.create_purchase($1::jsonb) as purch
    `, [JSON.stringify({
      supplierName: `Distribuidora Alpha ${runId}`,
      orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      notes: `Recon Compra 1 ${runId}`,
      items: [
        { productId: prodMap.A.id, quantity: 10, unitCostCents: 1100000 },
        { productId: prodMap.B.id, quantity: 8, unitCostCents: 2100000 }
      ]
    })]);
    const purch1 = purch1Res.rows[0].purch;
    createdPurchaseIds.push(purch1.id);
    const purch1ItemA = purch1.items.find(i => i.productId === prodMap.A.id).id;
    const purch1ItemB = purch1.items.find(i => i.productId === prodMap.B.id).id;

    // Compra 2: B = 5 (@2.200.000), C = 10 (@900.000)
    const purch2Res = await client.query(`
      select public.create_purchase($1::jsonb) as purch
    `, [JSON.stringify({
      supplierName: `Distribuidora Beta ${runId}`,
      orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 4 * 86400000).toISOString(),
      notes: `Recon Compra 2 ${runId}`,
      items: [
        { productId: prodMap.B.id, quantity: 5, unitCostCents: 2200000 },
        { productId: prodMap.C.id, quantity: 10, unitCostCents: 900000 }
      ]
    })]);
    const purch2 = purch2Res.rows[0].purch;
    createdPurchaseIds.push(purch2.id);

    console.log(`  ✓ Compras creadas: Compra 1 (A:10, B:8), Compra 2 (B:5, C:10)`);

    // Crear 7 pedidos diversos
    console.log(`\n[Paso 2] Confirmando 7 pedidos con diversas combinaciones de stock...`);
    const orderDefs = [
      { num: 1, lines: [{ key: 'A', qty: 4 }] },                                // Físico puro (de A)
      { num: 2, lines: [{ key: 'A', qty: 6 }] },                                // Mixto (1 físico + 5 incoming de A)
      { num: 3, lines: [{ key: 'B', qty: 4 }] },                                // Incoming puro (de Compra 1)
      { num: 4, lines: [{ key: 'B', qty: 6 }] },                                // Incoming multi-compra (4 de Compra 1 + 2 de Compra 2)
      { num: 5, lines: [{ key: 'C', qty: 5 }] },                                // Mixto (2 físico + 3 de Compra 2)
      { num: 6, lines: [{ key: 'C', qty: 4 }] },                                // Incoming puro (de Compra 2)
      { num: 7, lines: [{ key: 'A', qty: 2 }] }                                 // Incoming puro (de Compra 1)
    ];

    const orderMap = {};
    for (const od of orderDefs) {
      const pId = crypto.randomUUID();
      const lines = od.lines.map(l => ({
        productId: prodMap[l.key].id,
        quantity: l.qty,
        unitPriceCents: prodMap[l.key].price
      }));
      const subtotal = lines.reduce((acc, l) => acc + l.quantity * l.unitPriceCents, 0);

      const ordRes = await client.query(`
        select public.confirm_imported_order($1::jsonb) as res
      `, [JSON.stringify({
        customerName: `Cliente Recon ${od.num}`,
        customerPhone: '+5491100000000',
        phone: '+5491100000000',
        paymentMethod: 'transfer',
        deliveryMethod: 'pickup',
        shippingType: null,
        shippingFeeCents: 0,
        protocolOrderId: pId,
        protocolChecksum: `CAFE${String(od.num).padStart(4, '0')}`,
        quotedSubtotalCents: subtotal,
        quotedTotalCents: subtotal,
        lines
      })]);
      const ord = ordRes.rows[0].res;
      createdOrderIds.push(ord.id);
      orderMap[od.num] = ord;
    }

    console.log(`  ✓ 7 pedidos confirmados exitosamente`);

    // Paso 3: Cancelar Pedido 3 (tenía 4 unidades incoming de B en Compra 1)
    console.log(`\n[Paso 3] Cancelando Pedido 3 (reserva incoming se libera)...`);
    await client.query(`select public.transition_order($1::uuid, 'cancel')`, [orderMap[3].id]);
    console.log(`  ✓ Pedido 3 cancelado`);

    // Paso 4: Recepción Parcial de Compra 1
    // Llegan 6 unidades de A y 4 unidades de B
    console.log(`\n[Paso 4] Recepción parcial de Compra 1 (A: 6/10, B: 4/8)...`);
    await client.query(`
      select public.receive_purchase($1::uuid, $2::jsonb)
    `, [purch1.id, JSON.stringify([
      { purchaseItemId: purch1ItemA, receivedQuantity: 6 },
      { purchaseItemId: purch1ItemB, receivedQuantity: 4 }
    ])]);
    console.log(`  ✓ Arribo parcial de Compra 1 procesado`);

    // Paso 5: Entregar Pedidos Listos (Pedido 1 y Pedido 2)
    console.log(`\n[Paso 5] Entregando Pedidos 1 y 2 (ambos quedaron 100% físicos)...`);
    await client.query(`select public.transition_order($1::uuid, 'mark_delivered')`, [orderMap[1].id]);
    await client.query(`select public.transition_order($1::uuid, 'mark_delivered')`, [orderMap[2].id]);
    console.log(`  ✓ Pedidos 1 y 2 entregados`);

    // Paso 6: Cierre con Faltante Definitivo de Compra 2
    // Proveedor Beta confirma que NADA de Compra 2 va a llegar
    console.log(`\n[Paso 6] Cerrando Compra 2 con faltante definitivo del 100%...`);
    await client.query(`
      select public.close_purchase_with_shortage($1::uuid, 'Quiebre de stock de Distribuidora Beta')
    `, [purch2.id]);
    console.log(`  ✓ Compra 2 cerrada con shortage`);

    // Paso 7: Cancelar Pedido 6 (que quedó en 'uncovered')
    console.log(`\n[Paso 7] Cancelando Pedido 6 (reserva uncovered)...`);
    await client.query(`select public.transition_order($1::uuid, 'cancel')`, [orderMap[6].id]);
    console.log(`  ✓ Pedido 6 cancelado`);

    // Paso 8: Recepción Final de Compra 1 (las 4 restantes de A y las 4 restantes de B)
    console.log(`\n[Paso 8] Recepción de las unidades remanentes de Compra 1 (A: 4/10, B: 4/8)...`);
    await client.query(`
      select public.receive_purchase($1::uuid, $2::jsonb)
    `, [purch1.id, JSON.stringify([
      { purchaseItemId: purch1ItemA, receivedQuantity: 4 },
      { purchaseItemId: purch1ItemB, receivedQuantity: 4 }
    ])]);
    console.log(`  ✓ Compra 1 completada al 100%`);

    // =========================================================================
    // AUDITORÍA MATEMÁTICA DE PRECISIÓN ABSOLUTA
    // =========================================================================
    console.log(`\n======================================================================`);
    console.log(`  AUDITORÍA DE ECUACIONES CONTABLES FUNDAMENTALES`);
    console.log(`======================================================================`);

    const violations = [];

    // ECUACIÓN 1: stock_balances.reserved = SUM(reservas físicas activas) por producto
    console.log(`\n[Ecuación 1] stock_balances.reserved == SUM(reservas físicas activas)...`);
    for (const [key, p] of Object.entries(prodMap)) {
      const res = await client.query(`
        select
          sb.reserved,
          coalesce(sum(sr.quantity), 0)::integer as sum_physical_active
        from public.stock_balances sb
        left join public.stock_reservations sr
          on sr.product_id = sb.product_id
          and sr.state = 'active'
          and sr.source_type = 'physical'
        where sb.product_id = $1
        group by sb.reserved
      `, [p.id]);
      const row = res.rows[0];
      const reserved = parseInt(row.reserved, 10);
      const sumActive = parseInt(row.sum_physical_active, 10);
      if (reserved !== sumActive) {
        violations.push(`[ECUACIÓN 1 ERROR] Producto ${key}: sb.reserved (${reserved}) <> SUM(physical active) (${sumActive})`);
      } else {
        console.log(`  ✓ Producto ${key}: sb.reserved (${reserved}) == SUM(physical active) (${sumActive})`);
      }
    }

    // ECUACIÓN 2: stock físico final = stock inicial + compras recibidas - ventas entregadas
    console.log(`\n[Ecuación 2] stock físico final == inicial + compras_recibidas - ventas_entregadas...`);
    for (const [key, p] of Object.entries(prodMap)) {
      const res = await client.query(`
        select
          (select on_hand from public.stock_balances where product_id = $1) as current_on_hand,
          (select coalesce(sum(received_quantity), 0)::integer from public.purchase_items where product_id = $1) as total_received,
          (select coalesce(abs(sum(physical_delta)), 0)::integer from public.stock_movements where product_id = $1 and kind = 'sale') as total_delivered
      `, [p.id]);
      const row = res.rows[0];
      const currentOnHand = parseInt(row.current_on_hand, 10);
      const totalReceived = parseInt(row.total_received, 10);
      const totalDelivered = parseInt(row.total_delivered, 10);
      const expectedOnHand = p.initial + totalReceived - totalDelivered;

      if (currentOnHand !== expectedOnHand) {
        violations.push(`[ECUACIÓN 2 ERROR] Producto ${key}: on_hand (${currentOnHand}) <> esperado (${expectedOnHand} = ${p.initial} + ${totalReceived} - ${totalDelivered})`);
      } else {
        console.log(`  ✓ Producto ${key}: on_hand (${currentOnHand}) == ${p.initial} init + ${totalReceived} rec - ${totalDelivered} sold`);
      }
    }

    // ECUACIÓN 3: cada order_item.cost_total_cents = SUM(reservation.quantity * reservation.cost_snapshot_cents)
    console.log(`\n[Ecuación 3] order_item.cost_total_cents == SUM(quantity × unit_cost_snapshot)...`);
    const oiRes = await client.query(`
      select
        oi.id,
        oi.order_id,
        oi.cost_total_cents,
        coalesce(sum(sr.quantity * sr.cost_snapshot_cents), 0)::bigint as sum_reservation_cost
      from public.order_items oi
      join public.stock_reservations sr on sr.order_item_id = oi.id
      where oi.order_id = any($1::uuid[])
      group by oi.id, oi.order_id, oi.cost_total_cents
    `, [createdOrderIds]);

    for (const r of oiRes.rows) {
      const costTotal = BigInt(r.cost_total_cents);
      const sumResCost = BigInt(r.sum_reservation_cost);
      if (costTotal !== sumResCost) {
        violations.push(`[ECUACIÓN 3 ERROR] OrderItem ${r.id} en Orden ${r.order_id}: cost_total (${costTotal}) <> sum_res (${sumResCost})`);
      }
    }
    console.log(`  ✓ ${oiRes.rows.length} líneas de pedido auditadas: 100% exactas al centavo con sus reservas`);

    // ECUACIÓN 4: received_quantity + shortage_quantity <= quantity en cada compra
    console.log(`\n[Ecuación 4] received_quantity + shortage_quantity <= quantity por purchase_item...`);
    const piRes = await client.query(`
      select
        id, purchase_id, quantity, received_quantity, shortage_quantity
      from public.purchase_items
      where purchase_id = any($1::uuid[])
    `, [createdPurchaseIds]);

    for (const r of piRes.rows) {
      const q = parseInt(r.quantity, 10);
      const rec = parseInt(r.received_quantity, 10);
      const sho = parseInt(r.shortage_quantity, 10);
      if (rec + sho > q) {
        violations.push(`[ECUACIÓN 4 ERROR] PurchaseItem ${r.id}: ${rec} + ${sho} > ${q}`);
      } else {
        console.log(`  ✓ PurchaseItem ${r.id}: ${rec} rec + ${sho} short <= ${q} qty`);
      }
    }

    // ECUACIÓN 5: Cero reservas incoming activas sobre compras ya cerradas
    console.log(`\n[Ecuación 5] Cero reservas incoming sobre compras cerradas...`);
    const leakRes = await client.query(`
      select count(*)::integer as leaked_count
      from public.stock_reservations sr
      join public.purchase_items pi on pi.id = sr.purchase_item_id
      join public.purchases pu on pu.id = pi.purchase_id
      where pu.id = any($1::uuid[])
        and pu.state in ('received', 'cancelled')
        and sr.state = 'active'
        and sr.source_type = 'incoming'
    `, [createdPurchaseIds]);

    const leakedCount = parseInt(leakRes.rows[0].leaked_count, 10);
    if (leakedCount !== 0) {
      violations.push(`[ECUACIÓN 5 ERROR] Se encontraron ${leakedCount} reservas incoming huérfanas en compras cerradas`);
    } else {
      console.log(`  ✓ 0 reservas incoming huérfanas`);
    }

    if (violations.length > 0) {
      console.error('\n[VIOLACIONES DETECTADAS]:\n' + violations.join('\n'));
      throw new Error(`Se detectaron ${violations.length} inconsistencias matemáticas.`);
    }

    console.log(`\n======================================================================`);
    console.log(`  RESULTADO: TEST 2 (RECONCILIACIÓN MATEMÁTICA) 100% EXITOSO`);
    console.log(`  Ecuaciones contables e invariantes de stock verificadas a 0 tolerancia.`);
    console.log(`======================================================================\n`);

  } finally {
    console.log(`[Cleanup] Limpiando entidades de reconciliación...`);
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
  console.error('\n[FATAL RECONCILIATION FAILURE]', err.message);
  process.exit(1);
});
