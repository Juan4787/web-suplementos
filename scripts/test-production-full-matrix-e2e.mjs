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
  throw new Error('[e2e-matrix] SUPABASE_DB_PASSWORD no configurada o inválida.');
}

const dbConfig = {
  host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`,
  port: 5432,
  database: 'postgres',
  user: `postgres.${SUPABASE_PROJECT_REF}`,
  password,
  ssl: { rejectUnauthorized: false }
};

const OWNER_USER_ID = 'cded5daf-3e27-4f6b-86dd-a514fac1cd28';

// Pacing de seguridad contra rate limits y saturación del pool de conexiones
async function safeWait(ms = 600) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Checksum FNV-1a idéntico al del dominio para el protocolo de WhatsApp
function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

async function setupOwnerContext(client) {
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_USER_ID]);
  await client.query("select set_config('request.jwt.claim.role', 'authenticated', false)");
}

async function main() {
  console.log(`================================================================================`);
  console.log(`  E2E REAL EN PRODUCCIÓN: MATRIZ COMPLETA DE COMPRAS Y CICLO DE INVENTARIO`);
  console.log(`  Target: aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com (Ref: ${SUPABASE_PROJECT_REF})`);
  console.log(`================================================================================\n`);

  const client = new Client(dbConfig);
  await client.connect();

  const createdOrderIds = [];
  let testProductId = null;
  let testPurchaseId = null;
  let testPurchaseItemId = null;

  try {
    await setupOwnerContext(client);

    // 0. Obtener configuración vigente de la tienda (fletes oficiales en producción)
    console.log(`[Paso 0] Leyendo configuración de la tienda en producción...`);
    const settingsRes = await client.query(`
      select standard_shipping_cents, express_shipping_cents, store_name, currency
      from public.store_settings where singleton_id = 1
    `);
    const settings = settingsRes.rows[0];
    const standardFeeCents = parseInt(settings.standard_shipping_cents, 10);
    const expressFeeCents = parseInt(settings.express_shipping_cents, 10);
    console.log(`  ✓ Tienda: ${settings.store_name} (${settings.currency})`);
    console.log(`  ✓ Flete Estándar: $${standardFeeCents / 100} | Flete Expreso: $${expressFeeCents / 100}`);
    await safeWait(400);

    // 1. Fixture: Producto de prueba aislado con 3 unidades físicas
    const timestamp = Date.now();
    const sku = `PROD-MATRIX-${timestamp}`;
    const slug = `whey-matrix-${timestamp}`;
    const unitPriceCents = 2500000; // $25.000
    const initialCostCents = 1500000; // $15.000 costo inicial

    console.log(`\n[Paso 1] Creando producto aislado con 3 unidades físicas iniciales...`);
    const prodRes = await client.query(`
      select public.save_product($1::jsonb) as prod
    `, [JSON.stringify({
      sku,
      slug,
      name: `Whey Protein Matrix ${sku}`,
      presentation: '1kg',
      description: 'Producto para prueba E2E de matriz completa en producción.',
      category: 'Proteínas',
      priceCents: unitPriceCents,
      currentCostCents: initialCostCents,
      reorderPoint: 2,
      safetyStock: 1,
      leadTimeDays: 3,
      imageUrl: '/demo/whey.svg',
      imageAlt: 'Whey Matrix E2E',
      published: true,
      active: true,
      featured: false
    })]);

    testProductId = prodRes.rows[0].prod.id;

    // Asignar stock físico: 3 unidades
    await client.query(`
      update public.stock_balances
      set on_hand = 3, reserved = 0
      where product_id = $1
    `, [testProductId]);

    console.log(`  ✓ Producto creado: ID ${testProductId} (SKU: ${sku})`);
    console.log(`  ✓ Stock físico inicial configurado: on_hand = 3, reserved = 0`);
    await safeWait(600);

    // =========================================================================
    // FASE 1: Agotamiento del Stock Físico (Órdenes 1, 2 y 3)
    // =========================================================================
    console.log(`\n========================================================================`);
    console.log(`  FASE 1: AGOTAMIENTO DE STOCK FÍSICO A CERO MEDIANTE COMPRAS REALES`);
    console.log(`========================================================================\n`);

    // Variante 1: Mariana López | Efectivo | Retiro en local
    console.log(`[Variante 1/6] Mariana López -> Efectivo + Retiro en local (1u)...`);
    const protoId1 = crypto.randomUUID();
    const checksum1 = fnv1a(`V1-${protoId1}`);
    const v1Res = await client.query(`
      select public.confirm_imported_order($1::jsonb) as order
    `, [JSON.stringify({
      customerName: 'Mariana López',
      customerPhone: '+5491140010001',
      phone: '+5491140010001',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      protocolOrderId: protoId1,
      protocolChecksum: checksum1,
      quotedSubtotalCents: unitPriceCents,
      quotedTotalCents: unitPriceCents,
      lines: [{ productId: testProductId, quantity: 1, unitPriceCents }]
    })]);
    const order1 = v1Res.rows[0].order;
    createdOrderIds.push(order1.id);
    if (order1.stockReadiness !== 'ready') throw new Error(`V1 debió ser 'ready', obtenido '${order1.stockReadiness}'`);
    console.log(`  ✓ Pedido #${order1.number} creado (ID: ${order1.id}) - stockReadiness: ${order1.stockReadiness}`);
    await safeWait(600);

    // Variante 2: Santiago Gómez | Efectivo | Envío Estándar
    console.log(`\n[Variante 2/6] Santiago Gómez -> Efectivo + Envío Estándar (1u)...`);
    const protoId2 = crypto.randomUUID();
    const checksum2 = fnv1a(`V2-${protoId2}`);
    const v2Res = await client.query(`
      select public.confirm_imported_order($1::jsonb) as order
    `, [JSON.stringify({
      customerName: 'Santiago Gómez',
      customerPhone: '+5491140010002',
      phone: '+5491140010002',
      paymentMethod: 'cash',
      deliveryMethod: 'shipping',
      shippingType: 'standard',
      shippingFeeCents: standardFeeCents,
      address: 'Av. Santa Fe',
      addressNumber: '1234',
      protocolOrderId: protoId2,
      protocolChecksum: checksum2,
      quotedSubtotalCents: unitPriceCents,
      quotedTotalCents: unitPriceCents + standardFeeCents,
      lines: [{ productId: testProductId, quantity: 1, unitPriceCents }]
    })]);
    const order2 = v2Res.rows[0].order;
    createdOrderIds.push(order2.id);
    if (order2.stockReadiness !== 'ready') throw new Error(`V2 debió ser 'ready', obtenido '${order2.stockReadiness}'`);
    console.log(`  ✓ Pedido #${order2.number} creado (ID: ${order2.id}) - Flete: $${standardFeeCents / 100} - stockReadiness: ${order2.stockReadiness}`);
    await safeWait(600);

    // Variante 3: Lucía Fernández | Efectivo | Envío Expreso
    console.log(`\n[Variante 3/6] Lucía Fernández -> Efectivo + Envío Expreso (1u)...`);
    const protoId3 = crypto.randomUUID();
    const checksum3 = fnv1a(`V3-${protoId3}`);
    const v3Res = await client.query(`
      select public.confirm_imported_order($1::jsonb) as order
    `, [JSON.stringify({
      customerName: 'Lucía Fernández',
      customerPhone: '+5491140010003',
      phone: '+5491140010003',
      paymentMethod: 'cash',
      deliveryMethod: 'shipping',
      shippingType: 'express',
      shippingFeeCents: expressFeeCents,
      address: 'Belgrano',
      addressNumber: '456',
      protocolOrderId: protoId3,
      protocolChecksum: checksum3,
      quotedSubtotalCents: unitPriceCents,
      quotedTotalCents: unitPriceCents + expressFeeCents,
      lines: [{ productId: testProductId, quantity: 1, unitPriceCents }]
    })]);
    const order3 = v3Res.rows[0].order;
    createdOrderIds.push(order3.id);
    if (order3.stockReadiness !== 'ready') throw new Error(`V3 debió ser 'ready', obtenido '${order3.stockReadiness}'`);
    console.log(`  ✓ Pedido #${order3.number} creado (ID: ${order3.id}) - Flete: $${expressFeeCents / 100} - stockReadiness: ${order3.stockReadiness}`);
    await safeWait(600);

    // Verificación de stock agotado
    console.log(`\n[Verificación] Evaluando agotamiento del stock físico...`);
    const stockAfterExhaust = await client.query(`
      select on_hand, reserved from public.stock_balances where product_id = $1
    `, [testProductId]);
    const sbExhaust = stockAfterExhaust.rows[0];
    const onHand1 = parseInt(sbExhaust.on_hand, 10);
    const reserved1 = parseInt(sbExhaust.reserved, 10);
    const available1 = onHand1 - reserved1;
    console.log(`  ✓ Balance físico: on_hand = ${onHand1}, reserved = ${reserved1}, disponible físico = ${available1}`);
    if (available1 !== 0) throw new Error(`El stock físico debió ser 0 pero es ${available1}`);

    // Validar rechazo de disponibilidad física para nueva compra
    const availCheck = await client.query(`
      select public.check_cart_availability($1::jsonb) as avail
    `, [JSON.stringify([{ productId: testProductId, quantity: 1 }])]);
    const ac = availCheck.rows[0].avail;
    if (ac.ok !== false) throw new Error('check_cart_availability debió fallar por stock físico agotado');
    console.log(`  ✓ check_cart_availability rechaza correctamente: ok = false (disponibilidad física: 0)`);
    await safeWait(600);

    // =========================================================================
    // FASE 2: Compra al Proveedor (Mercadería en Camino / Tránsito)
    // =========================================================================
    console.log(`\n========================================================================`);
    console.log(`  FASE 2: COMPRA AL PROVEEDOR (ORDEN DE COMPRA EN CAMINO)`);
    console.log(`========================================================================\n`);

    const supplierCostCents = 1600000; // $16.000 costo unitario reposición
    const purchQty = 6;
    const expectedDelivery = new Date(Date.now() + 3 * 86400000);

    console.log(`[Compra Proveedor] Creando compra de 6 unidades al proveedor con ETA en 3 días...`);
    const purchRes = await client.query(`
      select public.create_purchase($1::jsonb) as purch
    `, [JSON.stringify({
      supplierName: `Distribuidor Matrix Oficial ${timestamp}`,
      orderedAt: new Date().toISOString(),
      expectedAt: expectedDelivery.toISOString(),
      notes: 'Reposición de stock para certificación E2E en producción',
      items: [
        { productId: testProductId, quantity: purchQty, unitCostCents: supplierCostCents }
      ]
    })]);

    const purch = purchRes.rows[0].purch;
    testPurchaseId = purch.id;
    testPurchaseItemId = purch.items[0].id;
    console.log(`  ✓ Compra creada: ID ${testPurchaseId} (Estado: ${purch.state})`);
    console.log(`  ✓ Purchase Item ID: ${testPurchaseItemId} (${purchQty} unidades en camino)`);
    await safeWait(600);

    // Validar cotización de carrito con stock entrante (quote_cart_eta)
    console.log(`\n[Cotización ETA] Verificando que el cliente detecta stock en camino y calcula ETA...`);
    const quoteRes = await client.query(`
      select public.quote_cart_eta($1::jsonb) as quote
    `, [JSON.stringify([{ productId: testProductId, quantity: 3 }])]);
    const quote = quoteRes.rows[0].quote;
    if (!quote.ok) throw new Error(`quote_cart_eta falló: ${quote.error}`);
    if (!quote.requiresIncoming) throw new Error('quote_cart_eta debió marcar requiresIncoming = true');
    if (!quote.quotedEta) throw new Error('quote_cart_eta debió devolver una fecha estimada');
    console.log(`  ✓ Cotización exitosa: requiresIncoming = true | ETA calculada: ${quote.quotedEta}`);
    await safeWait(600);

    // =========================================================================
    // FASE 3: Compra mientras está en camino (Backorders / Órdenes 4, 5 y 6)
    // =========================================================================
    console.log(`\n========================================================================`);
    console.log(`  FASE 3: COMPRA MIENTRAS ESTÁ EN CAMINO (BACKORDERS EN TRÁNSITO)`);
    console.log(`========================================================================\n`);

    // Variante 4: Mateo Benítez | Transferencia | Retiro en local
    console.log(`[Variante 4/6] Mateo Benítez -> Transferencia + Retiro en local (1u en camino)...`);
    const protoId4 = crypto.randomUUID();
    const checksum4 = fnv1a(`V4-${protoId4}`);
    const v4Res = await client.query(`
      select public.confirm_imported_order($1::jsonb) as order
    `, [JSON.stringify({
      customerName: 'Mateo Benítez',
      customerPhone: '+5491140010004',
      phone: '+5491140010004',
      paymentMethod: 'transfer',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      protocolOrderId: protoId4,
      protocolChecksum: checksum4,
      quotedSubtotalCents: unitPriceCents,
      quotedTotalCents: unitPriceCents,
      lines: [{ productId: testProductId, quantity: 1, unitPriceCents }]
    })]);
    const order4 = v4Res.rows[0].order;
    createdOrderIds.push(order4.id);
    if (order4.stockReadiness !== 'waiting_incoming') {
      throw new Error(`V4 debió ser 'waiting_incoming', obtenido '${order4.stockReadiness}'`);
    }
    console.log(`  ✓ Pedido #${order4.number} creado (ID: ${order4.id}) - stockReadiness: ${order4.stockReadiness}`);
    await safeWait(600);

    // Variante 5: Camila Rossi | Transferencia | Envío Estándar
    console.log(`\n[Variante 5/6] Camila Rossi -> Transferencia + Envío Estándar (1u en camino)...`);
    const protoId5 = crypto.randomUUID();
    const checksum5 = fnv1a(`V5-${protoId5}`);
    const v5Res = await client.query(`
      select public.confirm_imported_order($1::jsonb) as order
    `, [JSON.stringify({
      customerName: 'Camila Rossi',
      customerPhone: '+5491140010005',
      phone: '+5491140010005',
      paymentMethod: 'transfer',
      deliveryMethod: 'shipping',
      shippingType: 'standard',
      shippingFeeCents: standardFeeCents,
      address: 'Av. Corrientes',
      addressNumber: '789',
      protocolOrderId: protoId5,
      protocolChecksum: checksum5,
      quotedSubtotalCents: unitPriceCents,
      quotedTotalCents: unitPriceCents + standardFeeCents,
      lines: [{ productId: testProductId, quantity: 1, unitPriceCents }]
    })]);
    const order5 = v5Res.rows[0].order;
    createdOrderIds.push(order5.id);
    if (order5.stockReadiness !== 'waiting_incoming') {
      throw new Error(`V5 debió ser 'waiting_incoming', obtenido '${order5.stockReadiness}'`);
    }
    console.log(`  ✓ Pedido #${order5.number} creado (ID: ${order5.id}) - Flete: $${standardFeeCents / 100} - stockReadiness: ${order5.stockReadiness}`);
    await safeWait(600);

    // Variante 6: Nicolás Castro | Transferencia | Envío Expreso
    console.log(`\n[Variante 6/6] Nicolás Castro -> Transferencia + Envío Expreso (1u en camino)...`);
    const protoId6 = crypto.randomUUID();
    const checksum6 = fnv1a(`V6-${protoId6}`);
    const v6Res = await client.query(`
      select public.confirm_imported_order($1::jsonb) as order
    `, [JSON.stringify({
      customerName: 'Nicolás Castro',
      customerPhone: '+5491140010006',
      phone: '+5491140010006',
      paymentMethod: 'transfer',
      deliveryMethod: 'shipping',
      shippingType: 'express',
      shippingFeeCents: expressFeeCents,
      address: 'San Martín',
      addressNumber: '321',
      protocolOrderId: protoId6,
      protocolChecksum: checksum6,
      quotedSubtotalCents: unitPriceCents,
      quotedTotalCents: unitPriceCents + expressFeeCents,
      lines: [{ productId: testProductId, quantity: 1, unitPriceCents }]
    })]);
    const order6 = v6Res.rows[0].order;
    createdOrderIds.push(order6.id);
    if (order6.stockReadiness !== 'waiting_incoming') {
      throw new Error(`V6 debió ser 'waiting_incoming', obtenido '${order6.stockReadiness}'`);
    }
    console.log(`  ✓ Pedido #${order6.number} creado (ID: ${order6.id}) - Flete: $${expressFeeCents / 100} - stockReadiness: ${order6.stockReadiness}`);
    await safeWait(600);

    // Verificación estricta de bloqueo de entrega mientras la mercadería está en viaje
    console.log(`\n[Bloqueo Canónico] Comprobando que los pedidos en camino NO pueden despacharse...`);
    for (const blockedId of [order4.id, order5.id, order6.id]) {
      let deliveryBlocked = false;
      try {
        await client.query(`select public.transition_order($1::uuid, 'mark_delivered')`, [blockedId]);
      } catch (err) {
        if (err.message.includes('CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK') || err.message.includes('ORDER_NOT_READY_FOR_FULFILLMENT')) {
          deliveryBlocked = true;
        } else {
          throw err;
        }
      }
      if (!deliveryBlocked) {
        throw new Error(`El pedido ${blockedId} en estado waiting_incoming debió ser bloqueado para entrega`);
      }
    }
    console.log(`  ✓ Bloqueo estricto verificado: CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK activo en Órdenes 4, 5 y 6`);
    await safeWait(600);

    // =========================================================================
    // FASE 4: Arribo de Mercadería del Proveedor y Desbloqueo Automático
    // =========================================================================
    console.log(`\n========================================================================`);
    console.log(`  FASE 4: ARRIBO DE MERCADERÍA Y DESBLOQUEO AUTOMÁTICO (RECEIVE PURCHASE)`);
    console.log(`========================================================================\n`);

    const receiveOpId = crypto.randomUUID();
    console.log(`[Recepción Proveedor] Recibiendo las 6 unidades de la compra (Operation ID: ${receiveOpId})...`);
    const receiveRes = await client.query(`
      select public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) as res
    `, [testPurchaseId, JSON.stringify([{ purchaseItemId: testPurchaseItemId, receivedQuantity: 6 }]), receiveOpId]);

    const receiveData = receiveRes.rows[0].res;
    const unblocked = receiveData.unblockedOrders || [];
    const unblockedIds = unblocked.map(o => o.id);

    console.log(`  ✓ Recepción procesada exitosamente`);
    console.log(`  ✓ Pedidos desbloqueados reportados: ${unblockedIds.length} (${unblockedIds.join(', ')})`);

    if (!unblockedIds.includes(order4.id) || !unblockedIds.includes(order5.id) || !unblockedIds.includes(order6.id)) {
      throw new Error(`receive_purchase no desbloqueó todos los pedidos que aguardaban mercadería`);
    }

    // Verificar en DB que los estados cambiaron a 'ready'
    for (const unblockedId of [order4.id, order5.id, order6.id]) {
      const checkRes = await client.query(`
        select private.order_payload(id, true) ->> 'stockReadiness' as readiness
        from public.orders where id = $1
      `, [unblockedId]);
      const readiness = checkRes.rows[0].readiness;
      if (readiness !== 'ready') throw new Error(`Pedido ${unblockedId} debió pasar a 'ready', está en '${readiness}'`);
    }
    console.log(`  ✓ Los pedidos 4, 5 y 6 pasaron atómicamente a stockReadiness = 'ready'`);

    // Validar balances post-recepción
    const sbPostRecv = await client.query(`
      select on_hand, reserved from public.stock_balances where product_id = $1
    `, [testProductId]);
    const sbPR = sbPostRecv.rows[0];
    console.log(`  ✓ Balance tras recepción: on_hand = ${sbPR.on_hand}, reserved = ${sbPR.reserved} (3 iniciales + 6 recibidas = 9; 6 reservadas)`);
    if (parseInt(sbPR.on_hand, 10) !== 9 || parseInt(sbPR.reserved, 10) !== 6) {
      throw new Error(`Balance post-recepción incorrecto: on_hand=${sbPR.on_hand}, reserved=${sbPR.reserved}`);
    }
    await safeWait(600);

    // =========================================================================
    // FASE 5: Cobro y Cumplimiento Completo de Todas las Modalidades
    // =========================================================================
    console.log(`\n========================================================================`);
    console.log(`  FASE 5: COBRO Y ENTREGA FINAL DE TODAS LAS MODALIDADES DE COMPRA`);
    console.log(`========================================================================\n`);

    // 1. Confirmar pago de los 6 pedidos (mark_paid)
    console.log(`[Cobro] Marcando como pagados los 6 pedidos (Efectivo y Transferencias)...`);
    for (let i = 0; i < createdOrderIds.length; i++) {
      const orderId = createdOrderIds[i];
      await client.query(`select public.transition_order($1::uuid, 'mark_paid')`, [orderId]);
      await safeWait(300);
    }
    console.log(`  ✓ 6 pedidos marcados como 'paid'`);

    // 2. Entregar pedidos de retiro en local (Órdenes 1 y 4)
    console.log(`\n[Entrega - Retiro] Despachando entregas en mostrador (V1 Mariana López & V4 Mateo Benítez)...`);
    for (const pickupId of [order1.id, order4.id]) {
      await client.query(`select public.transition_order($1::uuid, 'mark_delivered')`, [pickupId]);
      await safeWait(400);
    }
    console.log(`  ✓ Retiros en local entregados (fulfillment: delivered)`);

    // 3. Despachar y entregar pedidos a domicilio (Órdenes 2, 3, 5 y 6)
    console.log(`\n[Entrega - Envíos] Despachando a transporte y entregando a domicilio (V2, V3, V5, V6)...`);
    for (const shipId of [order2.id, order3.id, order5.id, order6.id]) {
      // Envío en tránsito
      await client.query(`select public.transition_order($1::uuid, 'mark_shipped')`, [shipId]);
      await safeWait(300);
      // Entrega al cliente final
      await client.query(`select public.transition_order($1::uuid, 'mark_delivered')`, [shipId]);
      await safeWait(400);
    }
    console.log(`  ✓ Envíos a domicilio despachados y entregados con éxito`);

    // =========================================================================
    // FASE 6: Reconciliación Contable, Inventario e Idempotencia
    // =========================================================================
    console.log(`\n========================================================================`);
    console.log(`  FASE 6: RECONCILIACIÓN MATEMÁTICA Y AUDITORÍA FINANCIERA`);
    console.log(`========================================================================\n`);

    const auditState = await client.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as final_on_hand,
        (select reserved from public.stock_balances where product_id = $1) as final_reserved,
        (select count(*) from public.stock_reservations where product_id = $1 and state = 'active') as active_res_count,
        (select count(*) from public.stock_reservations where product_id = $1 and state = 'consumed') as consumed_res_count,
        (select coalesce(sum(physical_delta), 0) from public.stock_movements where product_id = $1 and kind = 'sale') as total_sale_delta,
        (select coalesce(sum(physical_delta), 0) from public.stock_movements where product_id = $1 and kind = 'purchase_received') as total_purchase_delta,
        (select count(*) from public.orders where id = any($2::uuid[]) and payment_state = 'paid' and fulfillment_state = 'delivered') as completed_orders_count
    `, [testProductId, createdOrderIds]);

    const audit = auditState.rows[0];
    const finalOnHand = parseInt(audit.final_on_hand, 10);
    const finalReserved = parseInt(audit.final_reserved, 10);
    const activeRes = parseInt(audit.active_res_count, 10);
    const consumedRes = parseInt(audit.consumed_res_count, 10);
    const totalSaleDelta = parseInt(audit.total_sale_delta, 10);
    const totalPurchaseDelta = parseInt(audit.total_purchase_delta, 10);
    const completedOrders = parseInt(audit.completed_orders_count, 10);

    console.log(`  • Balance final on_hand: ${finalOnHand} (Esperado: 3 unidades restantes)`);
    console.log(`  • Balance final reserved: ${finalReserved} (Esperado: 0)`);
    console.log(`  • Reservas activas: ${activeRes} (Esperado: 0)`);
    console.log(`  • Reservas consumidas: ${consumedRes} (Esperado: 6)`);
    console.log(`  • Movimientos de entrada (reception): +${totalPurchaseDelta} unidades`);
    console.log(`  • Movimientos de salida (sales): ${totalSaleDelta} unidades`);
    console.log(`  • Órdenes cobradas y entregadas: ${completedOrders}/6`);

    if (finalOnHand !== 3) throw new Error(`on_hand final debió ser 3, obtenido ${finalOnHand}`);
    if (finalReserved !== 0) throw new Error(`reserved final debió ser 0, obtenido ${finalReserved}`);
    if (activeRes !== 0) throw new Error(`Reservas activas debió ser 0, obtenido ${activeRes}`);
    if (consumedRes !== 6) throw new Error(`Reservas consumidas debió ser 6, obtenido ${consumedRes}`);
    if (totalPurchaseDelta !== 6) throw new Error(`Delta de compras debió ser +6, obtenido ${totalPurchaseDelta}`);
    if (totalSaleDelta !== -6) throw new Error(`Delta de ventas debió ser -6, obtenido ${totalSaleDelta}`);
    if (completedOrders !== 6) throw new Error(`Órdenes completadas debió ser 6, obtenido ${completedOrders}`);

    console.log(`\n  ✓ RECONCILIACIÓN MATEMÁTICA Y CONTABLE 100% PERFECTA.`);

    // =========================================================================
    // FASE 7: Teardown / Limpieza Completa de Registros de Prueba
    // =========================================================================
    console.log(`\n========================================================================`);
    console.log(`  FASE 7: LIMPIEZA SEGURA DE FIXTURE (TEARDOWN)`);
    console.log(`========================================================================\n`);

    await client.query('delete from public.stock_movements where order_id = any($1::uuid[]) or purchase_id = $2 or product_id = $3', [createdOrderIds, testPurchaseId, testProductId]);
    await client.query('delete from public.stock_reservations where order_id = any($1::uuid[]) or product_id = $2', [createdOrderIds, testProductId]);
    await client.query('delete from public.order_items where order_id = any($1::uuid[]) or product_id = $2', [createdOrderIds, testProductId]);
    await client.query('delete from public.orders where id = any($1::uuid[])', [createdOrderIds]);
    await client.query('delete from public.purchase_receipts where purchase_id = $1', [testPurchaseId]);
    await client.query('delete from public.purchase_items where purchase_id = $1 or product_id = $2', [testPurchaseId, testProductId]);
    await client.query('delete from public.purchases where id = $1', [testPurchaseId]);
    await client.query('delete from public.stock_balances where product_id = $1', [testProductId]);
    await client.query('delete from public.product_financials where product_id = $1', [testProductId]);
    await client.query('delete from public.products where id = $1', [testProductId]);

    console.log(`  ✓ Todos los registros de prueba eliminados limpiamente. El catálogo productivo queda intacto.`);

    console.log(`\n================================================================================`);
    console.log(`  RESULTADO: CERTIFICACIÓN E2E EN PRODUCCIÓN EXITOSA AL 100%`);
    console.log(`  6 MODALIDADES DE COMPRA CERTIFICADAS, AGOTAMIENTO, BACKORDERS Y ARRIBO`);
    console.log(`================================================================================\n`);

  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n[FATAL ERROR EN CERTIFICACIÓN E2E]:', err);
  process.exit(1);
});
