import { loadEnv } from 'vite';
import { Client } from 'pg';
import crypto from 'node:crypto';

const env = loadEnv('production', process.cwd(), '');
const password = env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error('ERROR: SUPABASE_DB_PASSWORD no configurada en el entorno.');
  process.exit(1);
}

const client = new Client({
  connectionString: `postgresql://postgres.mvtpidtuntvebyrxivue:${encodeURIComponent(password)}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`,
  ssl: { rejectUnauthorized: false }
});

const OWNER_ID = 'cded5daf-3e27-4f6b-86dd-a514fac1cd28';

async function setAuth(userId = OWNER_ID, role = 'authenticated') {
  if (!userId) {
    await client.query("SELECT set_config('request.jwt.claim.sub', '', false)");
    await client.query("SELECT set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ role: 'anon' })
    ]);
    return;
  }
  await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await client.query("SELECT set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role })
  ]);
}

async function run() {
  await client.connect();
  console.log('=== CONECTADO A BASE DE DATOS SUPABASE (mvtpidtuntvebyrxivue) ===\n');

  await setAuth(OWNER_ID);

  const results = [];
  const createdOrderIds = [];
  const createdPurchaseIds = [];
  const createdProductIds = [];
  const createdUserIds = [];

  // Helper para crear producto aislado
  async function createTestProduct(prefix, price = 3300000, cost = 1800000) {
    const slug = `${prefix.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sku = `${prefix.toUpperCase()}${Date.now().toString().slice(-4)}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
    const prodRes = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, $3, 'Pote 300g', 'Producto de prueba de integracion serie 3', 'Test', $4, true, true)
       RETURNING id, sku, slug, name, sale_price_cents`,
      [sku, slug, `Prod ${sku}`, price]
    );
    const prod = prodRes.rows[0];
    createdProductIds.push(prod.id);

    await client.query(
      `INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE SET current_cost_cents = $2`,
      [prod.id, cost]
    );

    await client.query(
      `INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 0, 0)
       ON CONFLICT (product_id) DO UPDATE SET on_hand = 0, reserved = 0`,
      [prod.id]
    );

    return { ...prod, costCents: cost };
  }

  // Helper para crear compra a proveedor
  async function createTestPurchase(supplierName, items) {
    const purchRes = await client.query(
      `SELECT public.create_purchase($1::jsonb) AS purch`,
      [JSON.stringify({
        supplierName,
        orderedAt: new Date().toISOString(),
        expectedAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        notes: 'Compra de prueba automatizada serie 3',
        items
      })]
    );
    const purch = purchRes.rows[0].purch;
    createdPurchaseIds.push(purch.id);
    return purch;
  }

  try {
    // =========================================================================
    // TEST 14 — Reintento / doble creación del mismo pedido manual
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 14 — Reintento / doble creación del mismo pedido manual');
    console.log('Fixture: producto físico disponible = 10, pedido manual = 1 unidad.');
    console.log('Paso 1: Llamada 1 crea el pedido.');
    console.log('Paso 2: Llamada 2 con idéntico payload y clave devuelve el mismo pedido (idempotencia UX).');
    console.log('Verificar: orders=1, order_items=1, reservas activas=1, reserved=1 (nunca 2 pedidos ni 2 reservas).');
    console.log('Paso 3: Reutilizar la misma clave con cantidad = 2 -> RECHAZO por reutilización inconsistente.');
    console.log('================================================================');

    const prod14 = await createTestProduct('T14');
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [prod14.id]);

    const protocolOrderId14 = crypto.randomUUID();
    const checksum14A = '11223344';
    const t14PayloadA = {
      customerName: 'Cliente Test 14 Idempotencia',
      lines: [{ productId: prod14.id, quantity: 1, unitPriceCents: prod14.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: protocolOrderId14,
      protocolChecksum: checksum14A
    };

    // Llamada 1: creación
    const t14Res1 = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t14PayloadA)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t14Res1.id);
    console.log(`  Llamada 1 (creación): Pedido #${t14Res1.number} (ID: ${t14Res1.id})`);

    // Llamada 2: reintento idéntico
    const t14Res2 = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t14PayloadA)])).rows[0].confirm_imported_order;
    console.log(`  Llamada 2 (reintento exacto): Devolvió ID ${t14Res2.id} (Coincide: ${t14Res1.id === t14Res2.id})`);

    // Inspección DB tras llamada 2
    const t14OrdersCount = parseInt((await client.query('SELECT count(*) FROM orders WHERE protocol_order_id = $1', [protocolOrderId14])).rows[0].count, 10);
    const t14ItemsCount = parseInt((await client.query('SELECT count(*) FROM order_items WHERE order_id = $1', [t14Res1.id])).rows[0].count, 10);
    const t14ResCount = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE order_id = $1 AND state = \'active\'', [t14Res1.id])).rows[0].count, 10);
    const t14Bal = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod14.id])).rows[0];

    console.log(`  Estado DB: orders=${t14OrdersCount} | items=${t14ItemsCount} | reservas=${t14ResCount} | reserved=${t14Bal.reserved}`);

    // Llamada 3: misma clave con cantidad distinta (qty = 2) y checksum distinto
    console.log('\n  --> Llamada 3: Reutilizando misma clave con cantidad = 2...');
    const t14PayloadB = {
      customerName: 'Cliente Test 14 Idempotencia',
      lines: [{ productId: prod14.id, quantity: 2, unitPriceCents: prod14.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: protocolOrderId14,
      protocolChecksum: 'AABBCCDD'
    };

    let t14Error = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t14PayloadB)]);
    } catch (err) {
      t14Error = err.message;
    }
    console.log(`  Resultado llamada 3: ${t14Error ? 'RECHAZADO con "' + t14Error + '"' : 'ERROR: NO RECHAZADO'}`);

    // Verificar que los invariantes en DB siguen intactos
    const t14OrdersCountFinal = parseInt((await client.query('SELECT count(*) FROM orders WHERE protocol_order_id = $1', [protocolOrderId14])).rows[0].count, 10);
    const t14BalFinal = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod14.id])).rows[0];

    const t14Pass =
      t14Res1.id === t14Res2.id &&
      t14OrdersCount === 1 &&
      t14ItemsCount === 1 &&
      t14ResCount === 1 &&
      t14Bal.reserved === 1 &&
      t14Error &&
      t14Error.includes('IDEMPOTENCY_KEY_REUSE_MISMATCH') &&
      t14OrdersCountFinal === 1 &&
      t14BalFinal.reserved === 1;

    results.push({ name: 'TEST 14 — Reintento / doble creación del mismo pedido manual', pass: !!t14Pass });
    console.log(t14Pass ? '✓ TEST 14 APROBADO EXITOSAMENTE\n' : '✗ TEST 14 FALLÓ\n');

    // =========================================================================
    // TEST 15 — Permisos para crear pedidos manuales
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 15 — Permisos para crear pedidos manuales');
    console.log('Probar llamada como:');
    console.log('A. owner activo -> PERMITIDO');
    console.log('B. staff activo -> PERMITIDO');
    console.log('C. staff deshabilitado -> RECHAZADO (FORBIDDEN)');
    console.log('D. usuario autenticado sin rol de tienda -> RECHAZADO (FORBIDDEN)');
    console.log('E. anónimo -> RECHAZADO (FORBIDDEN)');
    console.log('================================================================');

    const prod15 = await createTestProduct('T15');
    await client.query('UPDATE stock_balances SET on_hand = 50, reserved = 0 WHERE product_id = $1', [prod15.id]);

    // Crear usuarios de prueba en auth.users y store_users
    const activeStaffId = crypto.randomUUID();
    const disabledStaffId = crypto.randomUUID();
    const noRoleUserId = crypto.randomUUID();
    createdUserIds.push(activeStaffId, disabledStaffId, noRoleUserId);

    for (const uid of [activeStaffId, disabledStaffId, noRoleUserId]) {
      await client.query(
        `INSERT INTO auth.users (id, instance_id, email, aud, role) VALUES ($1, '00000000-0000-0000-0000-000000000000', $2, 'authenticated', 'authenticated')`,
        [uid, `test-${uid.slice(0, 8)}@test.local`]
      );
    }

    // Staff activo (activar registro creado por trigger)
    await client.query(
      `UPDATE store_users SET active = true, role = 'staff' WHERE user_id = $1`,
      [activeStaffId]
    );

    // Staff deshabilitado (ya viene active = false por defecto)
    await client.query(
      `UPDATE store_users SET active = false, role = 'staff' WHERE user_id = $1`,
      [disabledStaffId]
    );

    // Usuario autenticado sin rol de tienda (eliminar registro de store_users)
    await client.query(
      `DELETE FROM store_users WHERE user_id = $1`,
      [noRoleUserId]
    );

    // Payload base para Test 15
    const basePayload15 = (name) => ({
      customerName: name,
      lines: [{ productId: prod15.id, quantity: 1, unitPriceCents: prod15.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    });

    // 15A: Owner Activo
    await setAuth(OWNER_ID);
    const res15A = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(basePayload15('Cliente 15A Owner'))])).rows[0].confirm_imported_order;
    createdOrderIds.push(res15A.id);
    console.log(`  [15A] Owner activo: PERMITIDO (Pedido #${res15A.number} creado)`);

    // 15B: Staff Activo
    await setAuth(activeStaffId);
    const res15B = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(basePayload15('Cliente 15B Staff'))])).rows[0].confirm_imported_order;
    createdOrderIds.push(res15B.id);
    console.log(`  [15B] Staff activo: PERMITIDO (Pedido #${res15B.number} creado)`);

    // 15C: Staff Deshabilitado
    await setAuth(disabledStaffId);
    let err15C = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(basePayload15('Cliente 15C Disabled Staff'))]);
    } catch (err) {
      err15C = err.message;
    }
    console.log(`  [15C] Staff deshabilitado: ${err15C ? 'RECHAZADO con "' + err15C + '"' : 'ERROR: PERMITIDO'}`);

    // 15D: Usuario autenticado sin rol de tienda
    await setAuth(noRoleUserId);
    let err15D = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(basePayload15('Cliente 15D No Role'))]);
    } catch (err) {
      err15D = err.message;
    }
    console.log(`  [15D] Usuario sin rol: ${err15D ? 'RECHAZADO con "' + err15D + '"' : 'ERROR: PERMITIDO'}`);

    // 15E: Anónimo
    await setAuth(null);
    let err15E = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(basePayload15('Cliente 15E Anon'))]);
    } catch (err) {
      err15E = err.message;
    }
    console.log(`  [15E] Anónimo: ${err15E ? 'RECHAZADO con "' + err15E + '"' : 'ERROR: PERMITIDO'}`);

    // Restaurar auth como owner
    await setAuth(OWNER_ID);

    const t15Pass =
      res15A.id &&
      res15B.id &&
      err15C && err15C.includes('FORBIDDEN') &&
      err15D && err15D.includes('FORBIDDEN') &&
      err15E && err15E.includes('FORBIDDEN');

    results.push({ name: 'TEST 15 — Permisos para crear pedidos manuales', pass: !!t15Pass });
    console.log(t15Pass ? '✓ TEST 15 APROBADO EXITOSAMENTE\n' : '✗ TEST 15 FALLÓ\n');

    // =========================================================================
    // TEST 16 — Cancelar pedido 100% en camino
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 16 — Cancelar pedido 100% en camino');
    console.log('Fixture: on_hand=0, incoming=5. Pedido manual=2 incoming.');
    console.log('Crear -> incoming reservado=2, libre=3, stockReadiness=waiting_incoming.');
    console.log('Cancelar -> state=cancelled, reservas incoming activas=0, released=2, capacidad entrante libre=5, on_hand=0, reserved=0.');
    console.log('Re-cancelar -> RECHAZADO y capacidad entrante libre sigue siendo 5.');
    console.log('================================================================');

    const prod16 = await createTestProduct('T16');
    const purch16 = await createTestPurchase('Distribuidor Test 16', [
      { productId: prod16.id, quantity: 5, unitCostCents: prod16.costCents }
    ]);
    const purchItem16Id = purch16.items[0].id;

    // Crear pedido de 2 unidades
    const t16Payload = {
      customerName: 'Cliente Test 16 Cancel Incoming',
      lines: [{ productId: prod16.id, quantity: 2, unitPriceCents: prod16.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };
    const t16Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t16Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t16Order.id);

    // Comprobar estado inicial tras creación
    const t16ActiveResBefore = parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'active\' AND source_type = \'incoming\'', [t16Order.id])).rows[0].coalesce, 10);
    const t16IncomingCapBefore = 5 - parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE purchase_item_id = $1 AND state = \'active\' AND source_type = \'incoming\'', [purchItem16Id])).rows[0].coalesce, 10);
    const t16ReadinessBefore = (await client.query("SELECT private.order_payload($1, true) ->> 'stockReadiness' AS readiness", [t16Order.id])).rows[0].readiness;

    console.log(`  Estado tras crear: reservas activas=${t16ActiveResBefore} | capacidad libre proveedor=${t16IncomingCapBefore} | stockReadiness=${t16ReadinessBefore}`);

    // Cancelar el pedido
    console.log('  --> Cancelando pedido...');
    await client.query("SELECT transition_order($1, 'cancel')", [t16Order.id]);

    // Comprobar estado tras cancelación
    const t16DbOrderAfter = (await client.query('SELECT fulfillment_state, order_state FROM orders WHERE id = $1', [t16Order.id])).rows[0];
    const t16ActiveResAfter = parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'active\'', [t16Order.id])).rows[0].coalesce, 10);
    const t16ReleasedResAfter = parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'released\' AND source_type = \'incoming\'', [t16Order.id])).rows[0].coalesce, 10);
    const t16IncomingCapAfter = 5 - parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE purchase_item_id = $1 AND state = \'active\' AND source_type = \'incoming\'', [purchItem16Id])).rows[0].coalesce, 10);
    const t16BalAfter = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod16.id])).rows[0];
    const t16SalesMovements = parseInt((await client.query('SELECT count(*) FROM stock_movements WHERE order_id = $1 AND kind = \'sale\'', [t16Order.id])).rows[0].count, 10);

    console.log(`  Estado tras cancelar: fulfillment_state=${t16DbOrderAfter.fulfillment_state} | order_state=${t16DbOrderAfter.order_state}`);
    console.log(`  Reservas: activas=${t16ActiveResAfter} | liberadas=${t16ReleasedResAfter}`);
    console.log(`  Capacidad entrante libre restituida: ${t16IncomingCapAfter} (debe ser 5)`);
    console.log(`  Stock balances: on_hand=${t16BalAfter.on_hand} | reserved=${t16BalAfter.reserved}`);
    console.log(`  Movimientos tipo sale: ${t16SalesMovements}`);

    // Intentar re-cancelar
    console.log('  --> Intentando cancelar nuevamente...');
    let t16ReCancelErr = null;
    try {
      await client.query("SELECT transition_order($1, 'cancel')", [t16Order.id]);
    } catch (err) {
      t16ReCancelErr = err.message;
    }
    const t16IncomingCapAfterReCancel = 5 - parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE purchase_item_id = $1 AND state = \'active\' AND source_type = \'incoming\'', [purchItem16Id])).rows[0].coalesce, 10);
    console.log(`  Re-cancelación: ${t16ReCancelErr ? 'RECHAZADO con "' + t16ReCancelErr + '"' : 'ERROR: PERMITIDO'} | Capacidad libre proveedor: ${t16IncomingCapAfterReCancel}`);

    const t16Pass =
      t16ActiveResBefore === 2 &&
      t16IncomingCapBefore === 3 &&
      t16ReadinessBefore === 'waiting_incoming' &&
      t16DbOrderAfter.order_state === 'cancelled' &&
      t16DbOrderAfter.fulfillment_state === 'cancelled' &&
      t16ActiveResAfter === 0 &&
      t16ReleasedResAfter === 2 &&
      t16IncomingCapAfter === 5 &&
      t16BalAfter.on_hand === 0 &&
      t16BalAfter.reserved === 0 &&
      t16SalesMovements === 0 &&
      t16ReCancelErr &&
      t16ReCancelErr.includes('INVALID_TRANSITION') &&
      t16IncomingCapAfterReCancel === 5;

    results.push({ name: 'TEST 16 — Cancelar pedido 100% en camino', pass: !!t16Pass });
    console.log(t16Pass ? '✓ TEST 16 APROBADO EXITOSAMENTE\n' : '✗ TEST 16 FALLÓ\n');

    // =========================================================================
    // TEST 17 — Cancelar pedido mixto físico + incoming
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 17 — Cancelar pedido mixto físico + incoming');
    console.log('Fixture: on_hand=2, incoming=3. Pedido=4 unidades (2 physical + 2 incoming).');
    console.log('Cancelar -> physical active=0, incoming active=0, physical released=2, incoming released=2, on_hand=2, reserved=0, available=2, incoming libre=3.');
    console.log('================================================================');

    const prod17 = await createTestProduct('T17');
    await client.query('UPDATE stock_balances SET on_hand = 2, reserved = 0 WHERE product_id = $1', [prod17.id]);

    const purch17 = await createTestPurchase('Distribuidor Test 17', [
      { productId: prod17.id, quantity: 3, unitCostCents: prod17.costCents }
    ]);
    const purchItem17Id = purch17.items[0].id;

    // Pedido manual de 4 unidades
    const t17Payload = {
      customerName: 'Cliente Test 17 Cancel Split',
      lines: [{ productId: prod17.id, quantity: 4, unitPriceCents: prod17.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };
    const t17Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t17Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t17Order.id);

    // Cancelar pedido mixto
    console.log('  --> Cancelando pedido mixto...');
    await client.query("SELECT transition_order($1, 'cancel')", [t17Order.id]);

    // Inspección en ambos libros de disponibilidad
    const t17PhysActive = parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'active\' AND source_type = \'physical\'', [t17Order.id])).rows[0].coalesce, 10);
    const t17IncActive = parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'active\' AND source_type = \'incoming\'', [t17Order.id])).rows[0].coalesce, 10);
    const t17PhysReleased = parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'released\' AND source_type = \'physical\'', [t17Order.id])).rows[0].coalesce, 10);
    const t17IncReleased = parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'released\' AND source_type = \'incoming\'', [t17Order.id])).rows[0].coalesce, 10);
    const t17BalAfter = (await client.query('SELECT on_hand, reserved, (on_hand - reserved) AS available FROM stock_balances WHERE product_id = $1', [prod17.id])).rows[0];
    const t17IncCapAfter = 3 - parseInt((await client.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE purchase_item_id = $1 AND state = \'active\' AND source_type = \'incoming\'', [purchItem17Id])).rows[0].coalesce, 10);
    const t17SalesMovs = parseInt((await client.query('SELECT count(*) FROM stock_movements WHERE order_id = $1 AND kind = \'sale\'', [t17Order.id])).rows[0].count, 10);

    console.log(`  Reservas físicas: activas=${t17PhysActive} | liberadas=${t17PhysReleased}`);
    console.log(`  Reservas incoming: activas=${t17IncActive} | liberadas=${t17IncReleased}`);
    console.log(`  Stock balances: on_hand=${t17BalAfter.on_hand} | reserved=${t17BalAfter.reserved} | disponible físico=${t17BalAfter.available}`);
    console.log(`  Capacidad entrante libre restituida: ${t17IncCapAfter} (debe ser 3)`);
    console.log(`  Movimientos tipo sale: ${t17SalesMovs}`);

    const t17Pass =
      t17PhysActive === 0 &&
      t17IncActive === 0 &&
      t17PhysReleased === 2 &&
      t17IncReleased === 2 &&
      t17BalAfter.on_hand === 2 &&
      t17BalAfter.reserved === 0 &&
      t17BalAfter.available === 2 &&
      t17IncCapAfter === 3 &&
      t17SalesMovs === 0;

    results.push({ name: 'TEST 17 — Cancelar pedido mixto físico + incoming', pass: !!t17Pass });
    console.log(t17Pass ? '✓ TEST 17 APROBADO EXITOSAMENTE\n' : '✗ TEST 17 FALLÓ\n');

    // =========================================================================
    // TEST 18 — Recepción parcial de un pedido manual en camino
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 18 — Recepción parcial de un pedido manual en camino');
    console.log('Fixture: on_hand=0, compra proveedor=3. Pedido manual=2 incoming.');
    console.log('Paso 1: Recibir solo 1 unidad del proveedor.');
    console.log('Verificar: stockReadiness sigue waiting_incoming, mark_delivered y mark_shipped se RECHAZAN.');
    console.log('Paso 2: Recibir la segunda unidad.');
    console.log('Verificar: stockReadiness pasa a ready, conversión a física sin duplicados y preservando purchase_item_id.');
    console.log('Paso 3: Ahora sí mark_delivered se permite y descuenta stock.');
    console.log('================================================================');

    const prod18 = await createTestProduct('T18');
    const purch18 = await createTestPurchase('Distribuidor Test 18', [
      { productId: prod18.id, quantity: 3, unitCostCents: prod18.costCents }
    ]);
    const purchItem18Id = purch18.items[0].id;

    // Pedido manual de 2 unidades
    const t18Payload = {
      customerName: 'Cliente Test 18 Parcial',
      lines: [{ productId: prod18.id, quantity: 2, unitPriceCents: prod18.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };
    const t18Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t18Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t18Order.id);

    // Paso 1: Recepción parcial de 1 unidad
    console.log('  --> [Paso 1] Recepción parcial de 1 unidad...');
    await client.query(
      'SELECT public.receive_purchase($1::uuid, $2::jsonb, $3::uuid)',
      [purch18.id, JSON.stringify([{ purchaseItemId: purchItem18Id, receivedQuantity: 1 }]), crypto.randomUUID()]
    );

    const t18ReadinessP1 = (await client.query("SELECT private.order_payload($1, true) ->> 'stockReadiness' AS readiness", [t18Order.id])).rows[0].readiness;
    const t18ResP1 = (await client.query('SELECT id, source_type, quantity, purchase_item_id FROM stock_reservations WHERE order_id = $1 AND state = \'active\'', [t18Order.id])).rows;

    console.log(`  stockReadiness tras recepción parcial (1/2): ${t18ReadinessP1}`);
    console.log(`  Reservas tras paso 1 (${t18ResP1.length}):`);
    for (const r of t18ResP1) {
      console.log(`    - ID=${r.id} | source_type=${r.source_type} | qty=${r.quantity} | purchase_item_id=${r.purchase_item_id}`);
    }

    // Intentar despachar / entregar con stock incompleto
    let t18DeliverErrP1 = null;
    let t18ShipErrP1 = null;
    try {
      await client.query("SELECT transition_order($1, 'mark_delivered')", [t18Order.id]);
    } catch (err) {
      t18DeliverErrP1 = err.message;
    }
    try {
      await client.query("SELECT transition_order($1, 'mark_shipped')", [t18Order.id]);
    } catch (err) {
      t18ShipErrP1 = err.message;
    }
    console.log(`  Intento mark_delivered: ${t18DeliverErrP1 ? 'RECHAZADO con "' + t18DeliverErrP1 + '"' : 'ERROR: NO RECHAZADO'}`);
    console.log(`  Intento mark_shipped: ${t18ShipErrP1 ? 'RECHAZADO con "' + t18ShipErrP1 + '"' : 'ERROR: NO RECHAZADO'}`);

    // Paso 2: Recepción de la segunda unidad
    console.log('\n  --> [Paso 2] Recepción de segunda unidad (2/2)...');
    await client.query(
      'SELECT public.receive_purchase($1::uuid, $2::jsonb, $3::uuid)',
      [purch18.id, JSON.stringify([{ purchaseItemId: purchItem18Id, receivedQuantity: 1 }]), crypto.randomUUID()]
    );

    const t18ReadinessP2 = (await client.query("SELECT private.order_payload($1, true) ->> 'stockReadiness' AS readiness", [t18Order.id])).rows[0].readiness;
    const t18ResP2 = (await client.query('SELECT id, source_type, quantity, purchase_item_id FROM stock_reservations WHERE order_id = $1 AND state = \'active\'', [t18Order.id])).rows;

    console.log(`  stockReadiness tras completar arribo: ${t18ReadinessP2}`);
    console.log(`  Reservas tras paso 2 (${t18ResP2.length}):`);
    for (const r of t18ResP2) {
      console.log(`    - ID=${r.id} | source_type=${r.source_type} | qty=${r.quantity} | purchase_item_id=${r.purchase_item_id}`);
    }

    // Paso 3: Ahora entregar pedido
    console.log('\n  --> [Paso 3] Entregando pedido completado...');
    await client.query("SELECT transition_order($1, 'mark_delivered')", [t18Order.id]);
    const t18OrderFinal = (await client.query('SELECT fulfillment_state FROM orders WHERE id = $1', [t18Order.id])).rows[0];
    const t18BalFinal = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod18.id])).rows[0];
    const t18ActiveResFinal = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE order_id = $1 AND state = \'active\'', [t18Order.id])).rows[0].count, 10);

    console.log(`  Estado final orden: ${t18OrderFinal.fulfillment_state}`);
    console.log(`  Stock balance final: on_hand=${t18BalFinal.on_hand} (ingresaron 2, salieron 2) | reserved=${t18BalFinal.reserved}`);
    console.log(`  Reservas activas finales: ${t18ActiveResFinal}`);

    const t18Pass =
      t18ReadinessP1 === 'waiting_incoming' &&
      t18DeliverErrP1 && t18DeliverErrP1.includes('CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK') &&
      t18ShipErrP1 &&
      t18ReadinessP2 === 'ready' &&
      t18ResP2.length === 1 &&
      t18ResP2[0].source_type === 'physical' &&
      t18ResP2[0].quantity === 2 &&
      t18ResP2[0].purchase_item_id === purchItem18Id &&
      t18OrderFinal.fulfillment_state === 'delivered' &&
      t18BalFinal.on_hand === 0 &&
      t18BalFinal.reserved === 0 &&
      t18ActiveResFinal === 0;

    results.push({ name: 'TEST 18 — Recepción parcial de un pedido manual en camino', pass: !!t18Pass });
    console.log(t18Pass ? '✓ TEST 18 APROBADO EXITOSAMENTE\n' : '✗ TEST 18 FALLÓ\n');

    // =========================================================================
    // TEST 19 — Transferencia + envío expreso
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 19 — Transferencia + envío expreso');
    console.log('Fixture: Producto=$33.000, Flete express=$7.000.');
    console.log('Paso 1: Crear pedido transfer + express -> payment_state=pending, subtotal=33.000, shipping=7.000, total=40.000.');
    console.log('Paso 2: Transiciones: mark_paid -> mark_shipped -> mark_delivered.');
    console.log('Verificar: paid, delivered, 1 solo consumo de stock, 0 reservas activas.');
    console.log('Paso 3: Manipular shippingFeeCents=100 en express -> RECHAZO con ORDER_PRICE_CHANGED.');
    console.log('================================================================');

    const prod19 = await createTestProduct('T19', 3300000);
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [prod19.id]);

    const t19Payload = {
      customerName: 'Cliente Test 19 Transfer Express',
      phone: '1144556677',
      address: 'Av Santa Fe',
      addressNumber: '2500',
      lines: [{ productId: prod19.id, quantity: 1, unitPriceCents: prod19.sale_price_cents }],
      deliveryMethod: 'shipping',
      shippingType: 'express',
      paymentMethod: 'transfer',
      shippingFeeCents: 700000 // $7.000
    };

    const t19Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t19Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t19Order.id);

    const t19DbOrder = (await client.query('SELECT payment_method, payment_state, fulfillment_state, subtotal_cents, shipping_fee_cents, total_cents FROM orders WHERE id = $1', [t19Order.id])).rows[0];
    console.log(`  Creado: payment_method=${t19DbOrder.payment_method} | payment_state=${t19DbOrder.payment_state} | subtotal=$${t19DbOrder.subtotal_cents / 100} | flete=$${t19DbOrder.shipping_fee_cents / 100} | total=$${t19DbOrder.total_cents / 100}`);

    // Ejecutar transiciones
    console.log('  --> Ejecutando mark_paid...');
    await client.query("SELECT transition_order($1, 'mark_paid')", [t19Order.id]);
    console.log('  --> Ejecutando mark_shipped...');
    await client.query("SELECT transition_order($1, 'mark_shipped')", [t19Order.id]);
    console.log('  --> Ejecutando mark_delivered...');
    await client.query("SELECT transition_order($1, 'mark_delivered')", [t19Order.id]);

    const t19DbOrderAfter = (await client.query('SELECT payment_state, fulfillment_state FROM orders WHERE id = $1', [t19Order.id])).rows[0];
    const t19SalesMovements = (await client.query('SELECT id, kind, physical_delta, reserved_delta, reason FROM stock_movements WHERE order_id = $1 AND kind = \'sale\'', [t19Order.id])).rows;
    const t19ActiveRes = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE order_id = $1 AND state = \'active\'', [t19Order.id])).rows[0].count, 10);
    const t19Bal = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod19.id])).rows[0];

    console.log(`  Estado final: payment_state=${t19DbOrderAfter.payment_state} | fulfillment_state=${t19DbOrderAfter.fulfillment_state}`);
    console.log(`  Movimientos de salida (sale): ${t19SalesMovements.length}`);
    for (const m of t19SalesMovements) {
      console.log(`    - ID=${m.id} | phys_delta=${m.physical_delta} | res_delta=${m.reserved_delta} | reason="${m.reason}"`);
    }
    console.log(`  Reservas activas: ${t19ActiveRes} | Stock balance: on_hand=${t19Bal.on_hand} | reserved=${t19Bal.reserved}`);

    // Prueba de manipulación de flete express a $1
    console.log('\n  --> Prueba de manipulación de flete express a $1 (100 cents)...');
    const t19TamperedPayload = {
      ...t19Payload,
      customerName: 'Cliente Hack Flete Express',
      shippingFeeCents: 100
    };
    let t19TamperErr = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t19TamperedPayload)]);
    } catch (err) {
      t19TamperErr = err.message;
    }
    console.log(`  Resultado flete manipulado: ${t19TamperErr ? 'RECHAZADO con "' + t19TamperErr + '"' : 'ERROR: NO RECHAZADO'}`);

    const t19Pass =
      t19DbOrder.payment_method === 'transfer' &&
      t19DbOrder.payment_state === 'pending' &&
      Number(t19DbOrder.subtotal_cents) === 3300000 &&
      Number(t19DbOrder.shipping_fee_cents) === 700000 &&
      Number(t19DbOrder.total_cents) === 4000000 &&
      t19DbOrderAfter.payment_state === 'paid' &&
      t19DbOrderAfter.fulfillment_state === 'delivered' &&
      t19SalesMovements.length === 1 &&
      t19SalesMovements[0].physical_delta === -1 &&
      t19ActiveRes === 0 &&
      t19Bal.on_hand === 9 &&
      t19Bal.reserved === 0 &&
      t19TamperErr &&
      t19TamperErr.includes('ORDER_PRICE_CHANGED');

    results.push({ name: 'TEST 19 — Transferencia + envío expreso', pass: !!t19Pass });
    console.log(t19Pass ? '✓ TEST 19 APROBADO EXITOSAMENTE\n' : '✗ TEST 19 FALLÓ\n');

    // =========================================================================
    // TEST 20 — Producto cambia mientras se está armando el pedido
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 20 — Producto cambia mientras se está armando el pedido');
    console.log('Caso 20A: Seleccionar producto a $33.000. Antes de confirmar, cambiar en DB a $35.000.');
    console.log('Confirmar con $33.000 -> RECHAZADO con ORDER_PRICE_CHANGED (orders=0, reservas=0).');
    console.log('Caso 20B: Seleccionar producto y archivarlo antes de confirmar.');
    console.log('Confirmar -> RECHAZADO con PRODUCT_NOT_FOUND (orders=0, reservas=0).');
    console.log('================================================================');

    // Caso 20A: Cambio de precio concurrente
    const prod20A = await createTestProduct('T20A', 3300000);
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [prod20A.id]);

    console.log(`  [20A] Producto ${prod20A.sku} creado a $33.000.`);
    console.log('  --> Modificando precio en DB a $35.000 antes de confirmar...');
    await client.query('UPDATE products SET sale_price_cents = 3500000 WHERE id = $1', [prod20A.id]);

    const ordersCountBefore20A = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
    const resCountBefore20A = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1', [prod20A.id])).rows[0].count, 10);

    const t20APayload = {
      customerName: 'Cliente 20A Cambio Precio',
      lines: [{ productId: prod20A.id, quantity: 1, unitPriceCents: 3300000 }], // Payload desactualizado
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };

    let t20AErr = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t20APayload)]);
    } catch (err) {
      t20AErr = err.message;
    }

    const ordersCountAfter20A = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
    const resCountAfter20A = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1', [prod20A.id])).rows[0].count, 10);

    console.log(`  Resultado 20A: ${t20AErr ? 'RECHAZADO con "' + t20AErr + '"' : 'ERROR: NO RECHAZADO'}`);
    console.log(`  Órdenes creadas: ${ordersCountAfter20A - ordersCountBefore20A} | Reservas creadas: ${resCountAfter20A - resCountBefore20A}`);

    // Caso 20B: Producto archivado antes de confirmar
    console.log('\n  [20B] Creando producto y archivándolo antes de confirmar...');
    const prod20B = await createTestProduct('T20B', 3300000);
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [prod20B.id]);

    // Archivar producto en DB
    await client.query('UPDATE products SET active = false, published = false WHERE id = $1', [prod20B.id]);

    const ordersCountBefore20B = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
    const resCountBefore20B = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1', [prod20B.id])).rows[0].count, 10);

    const t20BPayload = {
      customerName: 'Cliente 20B Producto Archivado',
      lines: [{ productId: prod20B.id, quantity: 1, unitPriceCents: prod20B.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };

    let t20BErr = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t20BPayload)]);
    } catch (err) {
      t20BErr = err.message;
    }

    const ordersCountAfter20B = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
    const resCountAfter20B = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1', [prod20B.id])).rows[0].count, 10);

    console.log(`  Resultado 20B: ${t20BErr ? 'RECHAZADO con "' + t20BErr + '"' : 'ERROR: NO RECHAZADO'}`);
    console.log(`  Órdenes creadas: ${ordersCountAfter20B - ordersCountBefore20B} | Reservas creadas: ${resCountAfter20B - resCountBefore20B}`);

    const t20Pass =
      t20AErr &&
      t20AErr.includes('ORDER_PRICE_CHANGED') &&
      ordersCountAfter20A === ordersCountBefore20A &&
      resCountAfter20A === resCountBefore20A &&
      t20BErr &&
      t20BErr.includes('PRODUCT_NOT_FOUND') &&
      ordersCountAfter20B === ordersCountBefore20B &&
      resCountAfter20B === resCountBefore20B;

    results.push({ name: 'TEST 20 — Producto cambia mientras se está armando el pedido', pass: !!t20Pass });
    console.log(t20Pass ? '✓ TEST 20 APROBADO EXITOSAMENTE\n' : '✗ TEST 20 FALLÓ\n');

  } finally {
    console.log('--- TEARDOWN: Limpieza de datos de prueba creados durante la serie 3 ---');
    await setAuth(OWNER_ID);

    if (createdOrderIds.length > 0) {
      await client.query('DELETE FROM stock_reservations WHERE order_id = ANY($1)', [createdOrderIds]);
      await client.query('DELETE FROM stock_movements WHERE order_id = ANY($1)', [createdOrderIds]);
      await client.query('DELETE FROM order_items WHERE order_id = ANY($1)', [createdOrderIds]);
      await client.query('DELETE FROM orders WHERE id = ANY($1)', [createdOrderIds]);
      console.log(`  ✓ Limpiadas ${createdOrderIds.length} órdenes y sus reservas/movimientos`);
    }

    if (createdPurchaseIds.length > 0) {
      await client.query('DELETE FROM purchase_receipts WHERE purchase_id = ANY($1)', [createdPurchaseIds]);
      await client.query('DELETE FROM stock_movements WHERE purchase_id = ANY($1)', [createdPurchaseIds]);
      await client.query('DELETE FROM stock_reservations WHERE purchase_item_id IN (SELECT id FROM purchase_items WHERE purchase_id = ANY($1))', [createdPurchaseIds]);
      await client.query('DELETE FROM purchase_items WHERE purchase_id = ANY($1)', [createdPurchaseIds]);
      await client.query('DELETE FROM purchases WHERE id = ANY($1)', [createdPurchaseIds]);
      console.log(`  ✓ Limpiadas ${createdPurchaseIds.length} compras a proveedores`);
    }

    if (createdProductIds.length > 0) {
      await client.query('DELETE FROM stock_movements WHERE product_id = ANY($1)', [createdProductIds]);
      await client.query('DELETE FROM stock_balances WHERE product_id = ANY($1)', [createdProductIds]);
      await client.query('DELETE FROM product_financials WHERE product_id = ANY($1)', [createdProductIds]);
      await client.query('DELETE FROM products WHERE id = ANY($1)', [createdProductIds]);
      console.log(`  ✓ Limpiados ${createdProductIds.length} productos de prueba`);
    }

    if (createdUserIds.length > 0) {
      await client.query('DELETE FROM store_users WHERE user_id = ANY($1)', [createdUserIds]);
      await client.query('DELETE FROM auth.users WHERE id = ANY($1)', [createdUserIds]);
      console.log(`  ✓ Limpiados ${createdUserIds.length} usuarios temporales`);
    }

    await client.end();
  }

  // Resumen final
  console.log('================================================================');
  console.log('RESUMEN DE RESULTADOS — SERIE 3 (TESTS 14 A 20)');
  console.log('================================================================');
  let allPass = true;
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    console.log(`  ${status.padEnd(6)} | ${r.name}`);
    if (!r.pass) allPass = false;
  }
  console.log('================================================================');
  console.log(`TOTAL: ${results.filter(r => r.pass).length}/${results.length} PASARON`);
  if (!allPass) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Error fatal ejecutando suite 3:', err);
  process.exit(1);
});
