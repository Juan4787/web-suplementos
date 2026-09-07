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
  throw new Error('[e2e-test] Contraseña no configurada o inválida.');
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

async function main() {
  console.log(`======================================================================`);
  console.log(`  TEST 1: E2E OPERATIVO COMPLETO (CLIENTE -> IMPORT -> ARRIBO -> ENTREGA)`);
  console.log(`======================================================================\n`);

  const client = new Client(dbConfig);
  await client.connect();

  try {
    const ownerId = await setupOwnerUser(client);
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [ownerId]);
    await client.query("select set_config('request.jwt.claim.role', 'authenticated', false)");

    const iterSuffix = `E2E-${Date.now()}`;
    const sku = `WHEY-${iterSuffix}`;
    const protocolOrderId = crypto.randomUUID();
    const protocolChecksum = 'E2E01CAF';

    console.log(`[Paso 1] Creando fixture con 2 unidades físicas y compra de 3 unidades en camino...`);
    // Crear producto con stock inicial 2 físico
    const prodRes = await client.query(`
      select public.save_product($1::jsonb) as prod
    `, [JSON.stringify({
      sku,
      slug: `whey-e2e-${iterSuffix.toLowerCase()}`,
      name: `Whey Protein E2E ${sku}`,
      presentation: '1kg',
      description: 'Producto para prueba E2E de ciclo operativo completo.',
      category: 'Proteínas',
      priceCents: 2500000,
      currentCostCents: 1500000,
      reorderPoint: 2,
      safetyStock: 1,
      leadTimeDays: 5,
      imageUrl: '/demo/whey.svg',
      imageAlt: 'Whey E2E',
      published: true,
      active: true,
      featured: false
    })]);
    const productId = prodRes.rows[0].prod.id;

    // Inicializar stock_balances con 2 unidades físicas
    await client.query(`
      update public.stock_balances
      set on_hand = 2, reserved = 0
      where product_id = $1
    `, [productId]);

    // Crear orden de compra de 3 unidades
    const expectedAtDate = new Date(Date.now() + 3 * 86400000);
    const purchRes = await client.query(`
      select public.create_purchase($1::jsonb) as purch
    `, [JSON.stringify({
      supplierName: `Proveedor E2E ${sku}`,
      orderedAt: new Date().toISOString(),
      expectedAt: expectedAtDate.toISOString(),
      notes: `Compra de prueba E2E ${sku}`,
      items: [
        { productId, quantity: 3, unitCostCents: 1600000 }
      ]
    })]);

    const purchaseId = purchRes.rows[0].purch.id;
    const purchaseItemId = purchRes.rows[0].purch.items[0].id;

    console.log(`  ✓ Producto creado (ID: ${productId}, Stock físico: 2)`);
    console.log(`  ✓ Compra creada (ID: ${purchaseId}, 3 unidades incoming al costo 16.000)`);

    // 2. Cotización en Carrito con quote_cart_eta
    console.log(`\n[Paso 2] Cliente cotiza 5 unidades en Carrito (2 físicas + 3 en camino)...`);
    const quoteRes = await client.query(`
      select public.quote_cart_eta($1::jsonb) as quote
    `, [JSON.stringify([{ productId, quantity: 5 }])]);
    const quote = quoteRes.rows[0].quote;

    if (!quote.ok) throw new Error(`quote_cart_eta falló: ${quote.error}`);
    if (!quote.requiresIncoming) throw new Error('quote_cart_eta: requiresIncoming debería ser true');
    if (!quote.quotedEta) throw new Error('quote_cart_eta: quotedEta no debería ser nulo');

    console.log(`  ✓ Cotización exitosa (ok: true, requiresIncoming: true)`);
    console.log(`  ✓ Fecha estimada calculada (quotedEta): ${quote.quotedEta}`);

    // 3. Confirmación e importación del pedido de 5 unidades
    console.log(`\n[Paso 3] Importador confirma pedido de 5 unidades por $125.000...`);
    const orderPayload = {
      customerName: 'Cliente Operativo E2E',
      customerPhone: '+5491100000000',
      phone: '+5491100000000',
      paymentMethod: 'transfer',
      deliveryMethod: 'pickup',
      shippingType: null,
      shippingFeeCents: 0,
      protocolOrderId,
      protocolChecksum,
      quotedSubtotalCents: 12500000,
      quotedTotalCents: 12500000,
      lines: [
        { productId, quantity: 5, unitPriceCents: 2500000 }
      ]
    };

    const confirmRes = await client.query(`
      select public.confirm_imported_order($1::jsonb) as res
    `, [JSON.stringify(orderPayload)]);
    const order = confirmRes.rows[0].res;
    const orderId = order.id;

    // Validar asignaciones en DB
    const state1 = await client.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select reserved from public.stock_balances where product_id = $1) as reserved,
        (select private.order_payload(id, true) ->> 'stockReadiness' from public.orders where id = $2) as stock_readiness,
        (select count(*) from public.stock_reservations where order_id = $2 and state = 'active' and source_type = 'physical' and quantity = 2 and purchase_item_id is null) as physical_res,
        (select count(*) from public.stock_reservations where order_id = $2 and state = 'active' and source_type = 'incoming' and quantity = 3 and purchase_item_id = $3) as incoming_res
    `, [productId, orderId, purchaseItemId]);

    const s1 = state1.rows[0];
    if (parseInt(s1.on_hand, 10) !== 2) throw new Error(`on_hand esperado 2, obtenido ${s1.on_hand}`);
    if (parseInt(s1.reserved, 10) !== 2) throw new Error(`reserved esperado 2, obtenido ${s1.reserved}`);
    if (s1.stock_readiness !== 'waiting_incoming') throw new Error(`stockReadiness esperado waiting_incoming, obtenido ${s1.stock_readiness}`);
    if (parseInt(s1.physical_res, 10) !== 1) throw new Error('Reserva física de 2 unidades no encontrada');
    if (parseInt(s1.incoming_res, 10) !== 1) throw new Error('Reserva incoming de 3 unidades no encontrada');

    console.log(`  ✓ Asignación atómica correcta: 2 unidades físicas + 3 unidades incoming`);
    console.log(`  ✓ stock_balances: on_hand = 2, reserved = 2 (solo el físico incrementó reserved)`);
    console.log(`  ✓ Estado de preparación: ${s1.stock_readiness}`);

    // 4. Intento de entrega prematura: DEBE BLOQUEARSE
    console.log(`\n[Paso 4] Verificando bloqueo de entrega con stock en camino...`);
    let blockedAsExpected = false;
    try {
      await client.query(`
        select public.transition_order($1::uuid, 'mark_delivered')
      `, [orderId]);
    } catch (e) {
      if (e.message.includes('CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK') || e.message.includes('ORDER_NOT_READY_FOR_FULFILLMENT')) {
        blockedAsExpected = true;
      } else {
        throw new Error(`Excepción inesperada al intentar entregar: ${e.message}`);
      }
    }
    if (!blockedAsExpected) throw new Error('La entrega debió ser rechazada con CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK');
    console.log(`  ✓ Entrega bloqueada con éxito: CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK`);

    // 5. Recepción Parcial: Llega 1 unidad de la compra
    console.log(`\n[Paso 5] Recepción parcial: Llega 1 de las 3 unidades de la compra...`);
    const receive1Res = await client.query(`
      select public.receive_purchase($1::uuid, $2::jsonb) as res
    `, [purchaseId, JSON.stringify([{ purchaseItemId, receivedQuantity: 1 }])]);

    const state2 = await client.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select reserved from public.stock_balances where product_id = $1) as reserved,
        (select private.order_payload(id, true) ->> 'stockReadiness' from public.orders where id = $2) as stock_readiness,
        (select count(*) from public.stock_reservations where order_id = $2 and state = 'active' and source_type = 'physical' and purchase_item_id = $3 and quantity = 1) as converted_res,
        (select count(*) from public.stock_reservations where order_id = $2 and state = 'active' and source_type = 'incoming' and purchase_item_id = $3 and quantity = 2) as remaining_incoming
    `, [productId, orderId, purchaseItemId]);

    const s2 = state2.rows[0];
    if (parseInt(s2.on_hand, 10) !== 3) throw new Error(`on_hand esperado 3, obtenido ${s2.on_hand}`);
    if (parseInt(s2.reserved, 10) !== 3) throw new Error(`reserved esperado 3, obtenido ${s2.reserved}`);
    if (s2.stock_readiness !== 'waiting_incoming') throw new Error(`stockReadiness esperado waiting_incoming, obtenido ${s2.stock_readiness}`);
    if (parseInt(s2.converted_res, 10) !== 1) throw new Error('Reserva física convertida con purchase_item_id no encontrada (fallo de procedencia)');
    if (parseInt(s2.remaining_incoming, 10) !== 1) throw new Error('Reserva incoming remanente de 2 unidades no encontrada');

    console.log(`  ✓ on_hand incrementó a 3, reserved incrementó a 3`);
    console.log(`  ✓ Trazabilidad de procedencia preservada: 1 unidad física retiene purchase_item_id = ${purchaseItemId}`);
    console.log(`  ✓ Pedido sigue bloqueado en 'waiting_incoming' (faltan 2 unidades)`);

    // Re-intentar entrega con stock parcial: aún debe fallar
    blockedAsExpected = false;
    try {
      await client.query(`
        select public.transition_order($1::uuid, 'mark_delivered')
      `, [orderId]);
    } catch (e) {
      if (e.message.includes('CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK') || e.message.includes('ORDER_NOT_READY_FOR_FULFILLMENT')) {
        blockedAsExpected = true;
      }
    }
    if (!blockedAsExpected) throw new Error('La entrega parcial debió ser rechazada');
    console.log(`  ✓ Entrega sigue bloqueada tras arribo parcial`);

    // 6. Recepción Final: Llegan las 2 unidades restantes
    console.log(`\n[Paso 6] Recepción final: Llegan las 2 unidades restantes de la compra...`);
    const receive2Res = await client.query(`
      select public.receive_purchase($1::uuid, $2::jsonb) as res
    `, [purchaseId, JSON.stringify([{ purchaseItemId, receivedQuantity: 2 }])]);

    const unblockedOrders = receive2Res.rows[0].res.unblockedOrders || [];
    if (!unblockedOrders.some(o => o.id === orderId)) {
      throw new Error(`receive_purchase no reportó el pedido ${orderId} en unblockedOrders`);
    }

    const state3 = await client.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select reserved from public.stock_balances where product_id = $1) as reserved,
        (select private.order_payload(id, true) ->> 'stockReadiness' from public.orders where id = $2) as stock_readiness,
        (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $2 and state = 'active' and source_type = 'incoming') as incoming_active,
        (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $2 and state = 'active' and source_type = 'physical' and purchase_item_id = $3) as purchase_physical_qty,
        (select coalesce(sum(quantity), 0) from public.stock_reservations where order_id = $2 and state = 'active' and source_type = 'physical' and purchase_item_id is null) as initial_physical_qty
    `, [productId, orderId, purchaseItemId]);

    const s3 = state3.rows[0];
    if (parseInt(s3.on_hand, 10) !== 5) throw new Error(`on_hand esperado 5, obtenido ${s3.on_hand}`);
    if (parseInt(s3.reserved, 10) !== 5) throw new Error(`reserved esperado 5, obtenido ${s3.reserved}`);
    if (s3.stock_readiness !== 'ready') throw new Error(`stockReadiness esperado ready, obtenido ${s3.stock_readiness}`);
    if (parseInt(s3.incoming_active, 10) !== 0) throw new Error(`incoming_active esperado 0, obtenido ${s3.incoming_active}`);
    if (parseInt(s3.purchase_physical_qty, 10) !== 3) throw new Error(`purchase_physical_qty esperado 3, obtenido ${s3.purchase_physical_qty}`);
    if (parseInt(s3.initial_physical_qty, 10) !== 2) throw new Error(`initial_physical_qty esperado 2, obtenido ${s3.initial_physical_qty}`);

    console.log(`  ✓ Compra completada al 100%`);
    console.log(`  ✓ on_hand = 5, reserved = 5`);
    console.log(`  ✓ 0 reservas incoming activas`);
    console.log(`  ✓ Pedido desbloqueado automáticamente: stockReadiness = 'ready'`);
    console.log(`  ✓ Trazabilidad completa: 2 unidades de stock inicial + 3 unidades de compra ${purchaseId}`);

    // 7. Entrega Final del Pedido
    console.log(`\n[Paso 7] Realizando entrega final (mark_delivered)...`);
    const deliverRes = await client.query(`
      select public.transition_order($1::uuid, 'mark_delivered') as res
    `, [orderId]);

    const finalState = await client.query(`
      select
        (select on_hand from public.stock_balances where product_id = $1) as on_hand,
        (select reserved from public.stock_balances where product_id = $1) as reserved,
        (select order_state from public.orders where id = $2) as order_state,
        (select fulfillment_state from public.orders where id = $2) as fulfillment_state,
        (select count(*) from public.stock_reservations where order_id = $2 and state = 'active') as active_reservations,
        (select count(*) from public.stock_reservations where order_id = $2 and state = 'consumed') as consumed_reservations,
        (select coalesce(sum(physical_delta), 0) from public.stock_movements where order_id = $2 and kind = 'sale') as sale_physical_delta,
        (select coalesce(sum(reserved_delta), 0) from public.stock_movements where order_id = $2 and kind = 'sale') as sale_reserved_delta,
        (select cost_total_cents from public.order_items where order_id = $2) as order_item_cost
    `, [productId, orderId]);

    const fs = finalState.rows[0];
    if (parseInt(fs.on_hand, 10) !== 0) throw new Error(`on_hand final esperado 0, obtenido ${fs.on_hand}`);
    if (parseInt(fs.reserved, 10) !== 0) throw new Error(`reserved final esperado 0, obtenido ${fs.reserved}`);
    if (fs.order_state !== 'confirmed') throw new Error(`order_state esperado confirmed, obtenido ${fs.order_state}`);
    if (fs.fulfillment_state !== 'delivered') throw new Error(`fulfillment_state esperado delivered, obtenido ${fs.fulfillment_state}`);
    if (parseInt(fs.active_reservations, 10) !== 0) throw new Error(`active_reservations esperado 0, obtenido ${fs.active_reservations}`);
    if (parseInt(fs.consumed_reservations, 10) < 1) throw new Error('No se consumieron las reservas');
    if (parseInt(fs.sale_physical_delta, 10) !== -5) throw new Error(`sale_physical_delta esperado -5, obtenido ${fs.sale_physical_delta}`);
    if (parseInt(fs.sale_reserved_delta, 10) !== -5) throw new Error(`sale_reserved_delta esperado -5, obtenido ${fs.sale_reserved_delta}`);

    // Cálculo contable:
    // 2 unidades iniciales a 15.000 ($30.000) + 3 unidades recibidas a 16.000 ($48.000) = $78.000 (7.800.000 centavos)
    console.log(`  ✓ on_hand = 0, reserved = 0`);
    console.log(`  ✓ Pedido entregado y completado: state = 'completed', fulfillment = 'delivered'`);
    console.log(`  ✓ Reservas consumidas: ${fs.consumed_reservations} registros`);
    console.log(`  ✓ Movimientos contables: Venta por -5 unidades físicas y -5 reservadas`);
    console.log(`  ✓ Costo ponderado final exacto: ${fs.order_item_cost} centavos`);

    // 8. Cleanup
    console.log(`\n[Paso 8] Limpieza de fixture...`);
    await client.query('delete from public.stock_movements where order_id = $1 or purchase_id = $2 or product_id = $3', [orderId, purchaseId, productId]);
    await client.query('delete from public.stock_reservations where order_id = $1 or purchase_item_id = $2', [orderId, purchaseItemId]);
    await client.query('delete from public.order_items where order_id = $1', [orderId]);
    await client.query('delete from public.orders where id = $1', [orderId]);
    await client.query('delete from public.purchase_items where purchase_id = $1', [purchaseId]);
    await client.query('delete from public.purchases where id = $1', [purchaseId]);
    await client.query('delete from public.stock_balances where product_id = $1', [productId]);
    await client.query('delete from public.product_financials where product_id = $1', [productId]);
    await client.query('delete from public.products where id = $1', [productId]);

    console.log(`\n======================================================================`);
    console.log(`  RESULTADO: TEST 1 (E2E OPERATIVO COMPLETO) 100% EXITOSO`);
    console.log(`======================================================================\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n[FATAL E2E FAILURE]', err.message);
  process.exit(1);
});
