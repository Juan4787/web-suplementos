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

async function setAuth(userId = OWNER_ID) {
  await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await client.query("SELECT set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role: 'authenticated' })
  ]);
}

function generateChecksum(name, lines) {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function run() {
  await client.connect();
  console.log('=== CONECTADO A BASE DE DATOS SUPABASE (mvtpidtuntvebyrxivue) ===\n');

  await setAuth(OWNER_ID);

  const results = [];
  const createdOrderIds = [];
  let fixtureProductId = null;

  try {
    // -------------------------------------------------------------------------
    // SETUP: Crear Producto Fixture Aislado para Pruebas
    // -------------------------------------------------------------------------
    console.log('--- SETUP: Preparando producto fixture para la serie de pruebas ---');
    const slug = `test-inv-${Date.now()}`;
    const sku = `TINV${Date.now().toString().slice(-6)}`;
    const prodRes = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, $3, 'Pote 300g', 'Producto de prueba de integracion', 'Test', 3300000, true, true)
       RETURNING id, sku, slug, name, sale_price_cents`,
      [sku, slug, `Producto Test Invariantes ${sku}`]
    );
    fixtureProductId = prodRes.rows[0].id;
    const fixturePrice = 3300000; // 33.000 ARS
    const fixtureCost = 1800000;  // 18.000 ARS

    // Finanzas del producto
    await client.query(
      `INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE SET current_cost_cents = $2`,
      [fixtureProductId, fixtureCost]
    );

    // Stock balances inicial: on_hand = 10, reserved = 0
    await client.query(
      `INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 10, 0)
       ON CONFLICT (product_id) DO UPDATE SET on_hand = 10, reserved = 0`,
      [fixtureProductId]
    );

    console.log(`✓ Fixture creado: ID=${fixtureProductId} | SKU=${sku} | on_hand=10 | reserved=0 | precio=$33.000 | costo=$18.000\n`);

    // =========================================================================
    // TEST 1 — Pedido manual inválido
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 1 — Pedido manual inválido');
    console.log('Objetivo: no permitir basura desde la API con verificación de invariantes en DB');
    console.log('================================================================');

    const t1Cases = [
      {
        name: 'A. Carrito vacío (lines = [])',
        payload: {
          customerName: 'Cliente Valido',
          lines: [],
          deliveryMethod: 'pickup',
          paymentMethod: 'cash',
          shippingFeeCents: 0,
          protocolChecksum: '11223344'
        },
        expectedErr: 'INVALID_ORDER'
      },
      {
        name: 'B. Nombre vacío (customerName = "")',
        payload: {
          customerName: '',
          lines: [{ productId: fixtureProductId, quantity: 1, unitPriceCents: fixturePrice }],
          deliveryMethod: 'pickup',
          paymentMethod: 'cash',
          shippingFeeCents: 0,
          protocolChecksum: '11223344'
        },
        expectedErr: 'INVALID_ORDER'
      },
      {
        name: 'C. Nombre de 1 carácter (customerName = "A")',
        payload: {
          customerName: 'A',
          lines: [{ productId: fixtureProductId, quantity: 1, unitPriceCents: fixturePrice }],
          deliveryMethod: 'pickup',
          paymentMethod: 'cash',
          shippingFeeCents: 0,
          protocolChecksum: '11223344'
        },
        expectedErr: 'INVALID_ORDER'
      },
      {
        name: 'D. Cantidad = 0 (quantity = 0)',
        payload: {
          customerName: 'Cliente Valido',
          lines: [{ productId: fixtureProductId, quantity: 0, unitPriceCents: fixturePrice }],
          deliveryMethod: 'pickup',
          paymentMethod: 'cash',
          shippingFeeCents: 0,
          protocolChecksum: '11223344'
        },
        expectedErr: 'INVALID_ORDER'
      },
      {
        name: 'E. Cantidad = -1 (quantity = -1)',
        payload: {
          customerName: 'Cliente Valido',
          lines: [{ productId: fixtureProductId, quantity: -1, unitPriceCents: fixturePrice }],
          deliveryMethod: 'pickup',
          paymentMethod: 'cash',
          shippingFeeCents: 0,
          protocolChecksum: '11223344'
        },
        expectedErr: 'INVALID_ORDER'
      },
      {
        name: 'F. Cantidad > stock disponible (quantity = 50 con stock 10)',
        payload: {
          customerName: 'Cliente Valido',
          lines: [{ productId: fixtureProductId, quantity: 50, unitPriceCents: fixturePrice }],
          deliveryMethod: 'pickup',
          paymentMethod: 'cash',
          shippingFeeCents: 0,
          protocolChecksum: '11223344'
        },
        expectedErr: 'INSUFFICIENT_STOCK'
      }
    ];

    const t1Details = [];
    let t1AllPassed = true;

    for (const c of t1Cases) {
      // Estado antes
      const ordersBefore = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
      const itemsBefore = parseInt((await client.query('SELECT count(*) FROM order_items')).rows[0].count, 10);
      const resBefore = parseInt((await client.query('SELECT count(*) FROM stock_reservations')).rows[0].count, 10);
      const movsBefore = parseInt((await client.query('SELECT count(*) FROM stock_movements WHERE product_id = $1', [fixtureProductId])).rows[0].count, 10);
      const balBefore = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];

      let gotError = null;
      try {
        await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(c.payload)]);
      } catch (err) {
        gotError = err.message;
      }

      // Estado después
      const ordersAfter = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
      const itemsAfter = parseInt((await client.query('SELECT count(*) FROM order_items')).rows[0].count, 10);
      const resAfter = parseInt((await client.query('SELECT count(*) FROM stock_reservations')).rows[0].count, 10);
      const movsAfter = parseInt((await client.query('SELECT count(*) FROM stock_movements WHERE product_id = $1', [fixtureProductId])).rows[0].count, 10);
      const balAfter = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];

      const ordersDiff = ordersAfter - ordersBefore;
      const itemsDiff = itemsAfter - itemsBefore;
      const resDiff = resAfter - resBefore;
      const movsDiff = movsAfter - movsBefore;
      const stockIntact = balBefore.on_hand === balAfter.on_hand && balBefore.reserved === balAfter.reserved;
      const errorMatch = gotError === c.expectedErr;

      const casePassed = errorMatch && ordersDiff === 0 && itemsDiff === 0 && resDiff === 0 && movsDiff === 0 && stockIntact;
      if (!casePassed) t1AllPassed = false;

      t1Details.push({
        caso: c.name,
        esperado: c.expectedErr,
        recibido: gotError,
        ordersCreados: ordersDiff,
        itemsCreados: itemsDiff,
        reservasCreadas: resDiff,
        movsStock: movsDiff,
        stockIntacto: stockIntact ? `on_hand=${balAfter.on_hand}, reserved=${balAfter.reserved}` : 'ALTERADO',
        ok: casePassed
      });

      console.log(`  [${casePassed ? 'OK' : 'FAIL'}] ${c.name} -> Error: ${gotError} | Orders creados: ${ordersDiff} | Items: ${itemsDiff} | Reservas: ${resDiff} | Stock: ${balAfter.on_hand}/${balAfter.reserved}`);
    }

    results.push({ test: 'TEST 1 — Pedido manual inválido', ok: t1AllPassed, details: t1Details });
    console.log(`Resultado TEST 1: ${t1AllPassed ? 'APROBADO' : 'RECHAZADO'}\n`);

    // =========================================================================
    // TEST 2 — Cancelación de pedido
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 2 — Cancelación de pedido');
    console.log('Objetivo: comprobar que cancelar libera stock exactamente una vez');
    console.log('================================================================');

    // Fixture: on_hand = 10, reserved = 0
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [fixtureProductId]);

    // Crear pedido de 2 unidades
    const t2OrderPayload = {
      customerName: 'Cliente Test Cancel',
      lines: [{ productId: fixtureProductId, quantity: 2, unitPriceCents: fixturePrice }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolChecksum: '22334455'
    };
    const t2OrderRes = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t2OrderPayload)])).rows[0].confirm_imported_order;
    const t2OrderId = t2OrderRes.id;
    createdOrderIds.push(t2OrderId);

    // Estado tras crear
    const t2BalAfterCreate = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t2ResAfterCreate = (await client.query('SELECT state, quantity, source_type FROM stock_reservations WHERE order_id = $1', [t2OrderId])).rows;
    console.log(`  Tras crear pedido #2: on_hand=${t2BalAfterCreate.on_hand} | reserved=${t2BalAfterCreate.reserved} (disp=${t2BalAfterCreate.on_hand - t2BalAfterCreate.reserved}) | reservas activas=${t2ResAfterCreate.filter(r => r.state === 'active').length}`);

    // Cancelar pedido
    const t2CancelRes = (await client.query("SELECT transition_order($1, 'cancel')", [t2OrderId])).rows[0].transition_order;

    // Estado tras cancelar
    const t2BalAfterCancel = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t2ResAfterCancel = (await client.query('SELECT state, quantity, source_type FROM stock_reservations WHERE order_id = $1', [t2OrderId])).rows;
    const t2Movs = (await client.query('SELECT kind, physical_delta, reserved_delta FROM stock_movements WHERE order_id = $1', [t2OrderId])).rows;

    const t2ActiveRes = t2ResAfterCancel.filter(r => r.state === 'active').reduce((s, r) => s + r.quantity, 0);
    const t2ReleasedRes = t2ResAfterCancel.filter(r => r.state === 'released').reduce((s, r) => s + r.quantity, 0);
    const t2SaleMovs = t2Movs.filter(m => m.kind === 'sale').length;

    console.log(`  Tras cancelar: fulfillment_state=${t2CancelRes.fulfillmentState} | on_hand=${t2BalAfterCancel.on_hand} | reserved=${t2BalAfterCancel.reserved} | disp=${t2BalAfterCancel.on_hand - t2BalAfterCancel.reserved}`);
    console.log(`  Reservas: activas=${t2ActiveRes} | released=${t2ReleasedRes} | Movimientos de venta=${t2SaleMovs}`);

    // Intentar cancelar de nuevo
    let t2SecondCancelError = null;
    try {
      await client.query("SELECT transition_order($1, 'cancel')", [t2OrderId]);
    } catch (err) {
      t2SecondCancelError = err.message;
    }

    const t2BalAfterSecond = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t2ResAfterSecond = (await client.query('SELECT state, quantity FROM stock_reservations WHERE order_id = $1', [t2OrderId])).rows;
    const t2ReleasedAfterSecond = t2ResAfterSecond.filter(r => r.state === 'released').reduce((s, r) => s + r.quantity, 0);

    console.log(`  Re-cancelar: Error="${t2SecondCancelError}" | on_hand=${t2BalAfterSecond.on_hand} | reserved=${t2BalAfterSecond.reserved} | released=${t2ReleasedAfterSecond}`);

    const t2Ok =
      t2CancelRes.fulfillmentState === 'cancelled' &&
      t2BalAfterCancel.on_hand === 10 &&
      t2BalAfterCancel.reserved === 0 &&
      t2ActiveRes === 0 &&
      t2ReleasedRes === 2 &&
      t2SaleMovs === 0 &&
      t2SecondCancelError === 'INVALID_TRANSITION' &&
      t2BalAfterSecond.on_hand === 10 &&
      t2BalAfterSecond.reserved === 0 &&
      t2ReleasedAfterSecond === 2;

    results.push({
      test: 'TEST 2 — Cancelación de pedido',
      ok: t2Ok,
      details: {
        orderState: t2CancelRes.orderState,
        fulfillmentState: t2CancelRes.fulfillmentState,
        onHandAfterCancel: t2BalAfterCancel.on_hand,
        reservedAfterCancel: t2BalAfterCancel.reserved,
        availableAfterCancel: t2BalAfterCancel.on_hand - t2BalAfterCancel.reserved,
        reservasActivas: t2ActiveRes,
        reservasReleased: t2ReleasedRes,
        movimientosVenta: t2SaleMovs,
        segundaCancelacionError: t2SecondCancelError,
        stockInalteradoTrasSegunda: t2BalAfterSecond.on_hand === 10 && t2BalAfterSecond.reserved === 0
      }
    });
    console.log(`Resultado TEST 2: ${t2Ok ? 'APROBADO' : 'RECHAZADO'}\n`);

    // =========================================================================
    // TEST 3 — Reintegro / refund
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 3 — Reintegro / refund');
    console.log('Objetivo: que marcar reintegro no duplique efectos de cancelación');
    console.log('================================================================');

    // Fixture: stock on_hand = 10, reserved = 0
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [fixtureProductId]);

    // Crear pedido de 2 unidades
    const t3OrderPayload = {
      customerName: 'Cliente Test Reintegro',
      lines: [{ productId: fixtureProductId, quantity: 2, unitPriceCents: fixturePrice }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolChecksum: '33445566'
    };
    const t3Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t3OrderPayload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t3Order.id);

    // 1. Marcar cobrado
    await client.query("SELECT transition_order($1, 'mark_paid')", [t3Order.id]);
    const t3PaidBal = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];

    // 2. Marcar reintegro realizado
    const t3RefundRes = (await client.query("SELECT transition_order($1, 'mark_refunded')", [t3Order.id])).rows[0].transition_order;
    const t3RefundBal = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t3RefundMovs = (await client.query('SELECT count(*) FROM stock_movements WHERE order_id = $1', [t3Order.id])).rows[0].count;

    console.log(`  Tras marcar reintegro: payment_state=${t3RefundRes.paymentState} | stock: on_hand=${t3RefundBal.on_hand}, reserved=${t3RefundBal.reserved} (intacto respecto a cobro: ${t3PaidBal.reserved === t3RefundBal.reserved})`);

    // 3. Cancelar pedido tras reintegro
    const t3CancelRes = (await client.query("SELECT transition_order($1, 'cancel')", [t3Order.id])).rows[0].transition_order;
    const t3CancelBal = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t3Reservations = (await client.query('SELECT state, quantity FROM stock_reservations WHERE order_id = $1', [t3Order.id])).rows;
    const t3ActiveRes = t3Reservations.filter(r => r.state === 'active').reduce((s, r) => s + r.quantity, 0);
    const t3ReleasedRes = t3Reservations.filter(r => r.state === 'released').reduce((s, r) => s + r.quantity, 0);
    const t3TotalMovs = (await client.query('SELECT count(*) FROM stock_movements WHERE order_id = $1', [t3Order.id])).rows[0].count;

    // 4. Si ya estaba cancelado, intentar marcar reintegro de nuevo -> debe rechazar
    let t3RefundAfterCancelErr = null;
    try {
      await client.query("SELECT transition_order($1, 'mark_refunded')", [t3Order.id]);
    } catch (err) {
      t3RefundAfterCancelErr = err.message;
    }
    const t3BalAfterAll = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];

    const t3Ok =
      t3RefundRes.paymentState === 'refunded' &&
      t3RefundBal.reserved === 2 && // Reintegro NO liberó stock antes de tiempo
      t3CancelBal.on_hand === 10 &&
      t3CancelBal.reserved === 0 && // Cancelación liberó exactamente una vez
      t3CancelBal.reserved >= 0 &&
      t3ActiveRes === 0 &&
      t3ReleasedRes === 2 &&
      parseInt(t3TotalMovs, 10) === 0 &&
      t3RefundAfterCancelErr === 'INVALID_TRANSITION' &&
      t3BalAfterAll.on_hand === 10 &&
      t3BalAfterAll.reserved === 0;

    results.push({
      test: 'TEST 3 — Reintegro / refund',
      ok: t3Ok,
      details: {
        paymentStateAfterRefund: t3RefundRes.paymentState,
        stockNoAfectadoPorRefundSolo: t3RefundBal.reserved === 2,
        onHandFinal: t3CancelBal.on_hand,
        reservedFinal: t3CancelBal.reserved,
        availableFinal: t3CancelBal.on_hand - t3CancelBal.reserved,
        reservedNuncaMenorQueCero: t3CancelBal.reserved >= 0,
        reservasActivas: t3ActiveRes,
        reservasReleased: t3ReleasedRes,
        movimientosDuplicados: parseInt(t3TotalMovs, 10),
        refundSobreCanceladoRechazado: t3RefundAfterCancelErr === 'INVALID_TRANSITION'
      }
    });
    console.log(`Resultado TEST 3: ${t3Ok ? 'APROBADO' : 'RECHAZADO'}\n`);

    // =========================================================================
    // TEST 4 — Autoprotección de la dueña
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 4 — Autoprotección de la dueña');
    console.log('Objetivo: protección a nivel DB/RPC contra auto-degradación o auto-bloqueo');
    console.log('================================================================');

    await setAuth(OWNER_ID);

    // Intento A: cambiar owner -> staff
    let errA = null;
    try {
      await client.query('SELECT update_store_user_access($1, $2, $3)', [OWNER_ID, 'staff', true]);
    } catch (err) {
      errA = err.message;
    }

    // Intento B: cambiar owner -> staff + disabled
    let errB = null;
    try {
      await client.query('SELECT update_store_user_access($1, $2, $3)', [OWNER_ID, 'staff', false]);
    } catch (err) {
      errB = err.message;
    }

    // Intento C: cambiar active = false (owner -> disabled)
    let errC = null;
    try {
      await client.query('SELECT update_store_user_access($1, $2, $3)', [OWNER_ID, 'owner', false]);
    } catch (err) {
      errC = err.message;
    }

    // Comprobar estado en tabla store_users
    const ownerRow = (await client.query('SELECT user_id, role, active, display_name FROM store_users WHERE user_id = $1', [OWNER_ID])).rows[0];

    // Comprobar que la sesión sigue siendo válida ejecutando consulta con require_owner
    let sessionValid = false;
    try {
      await client.query('SELECT private.require_owner()');
      sessionValid = true;
    } catch {
      sessionValid = false;
    }

    console.log(`  Intento A (owner -> staff): Error="${errA}"`);
    console.log(`  Intento B (owner -> staff + inactive): Error="${errB}"`);
    console.log(`  Intento C (active = false): Error="${errC}"`);
    console.log(`  Estado real en DB: role=${ownerRow.role} | active=${ownerRow.active} | sesión válida=${sessionValid}`);

    const t4Ok =
      errA === 'CANNOT_CHANGE_OWN_ACCESS' &&
      errB === 'CANNOT_CHANGE_OWN_ACCESS' &&
      errC === 'CANNOT_CHANGE_OWN_ACCESS' &&
      ownerRow.role === 'owner' &&
      ownerRow.active === true &&
      sessionValid === true;

    results.push({
      test: 'TEST 4 — Autoprotección dueña',
      ok: t4Ok,
      details: {
        errorA_CambioAStaff: errA,
        errorB_CambioADisabledStaff: errB,
        errorC_CambioAInactiva: errC,
        rolEnBaseDeDatos: ownerRow.role,
        cuentaActivaEnBaseDeDatos: ownerRow.active,
        sesionSigueValidaYConRolOwner: sessionValid
      }
    });
    console.log(`Resultado TEST 4: ${t4Ok ? 'APROBADO' : 'RECHAZADO'}\n`);

    // =========================================================================
    // TEST 5 — Archivar producto
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 5 — Archivar producto');
    console.log('Objetivo: ocultar de tienda pública y pedidos sin borrar historial');
    console.log('================================================================');

    // 1. Generar historial previo para el fixture (1 orden completada previa)
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [fixtureProductId]);
    const histOrderRes = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify({
      customerName: 'Cliente Histórico',
      lines: [{ productId: fixtureProductId, quantity: 1, unitPriceCents: fixturePrice }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolChecksum: '55667788'
    })])).rows[0].confirm_imported_order;
    createdOrderIds.push(histOrderRes.id);
    await client.query("SELECT transition_order($1, 'mark_paid')", [histOrderRes.id]);
    await client.query("SELECT transition_order($1, 'mark_delivered')", [histOrderRes.id]);

    const histOrderItemsBefore = parseInt((await client.query('SELECT count(*) FROM order_items WHERE product_id = $1', [fixtureProductId])).rows[0].count, 10);
    const histMovsBefore = parseInt((await client.query('SELECT count(*) FROM stock_movements WHERE product_id = $1', [fixtureProductId])).rows[0].count, 10);

    // 2. Archivar producto
    await client.query('SELECT archive_product($1, true)', [fixtureProductId]);

    // Comprobar tienda pública
    const sfProductsAfterArchive = (await client.query('SELECT get_storefront_products()')).rows[0].get_storefront_products;
    const inStorefrontArchived = sfProductsAfterArchive.some(p => p.id === fixtureProductId);

    // Comprobar creación de pedido nuevo con producto archivado
    let createOrderArchivedError = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify({
        customerName: 'Intento Pedido Archivado',
        lines: [{ productId: fixtureProductId, quantity: 1, unitPriceCents: fixturePrice }],
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolChecksum: '66778899'
      })]);
    } catch (err) {
      createOrderArchivedError = err.message;
    }

    // Comprobar que en DB sigue existiendo y con historial intacto
    const prodRowInDb = (await client.query('SELECT id, active, published FROM products WHERE id = $1', [fixtureProductId])).rows[0];
    const histOrderItemsAfter = parseInt((await client.query('SELECT count(*) FROM order_items WHERE product_id = $1', [fixtureProductId])).rows[0].count, 10);
    const histMovsAfter = parseInt((await client.query('SELECT count(*) FROM stock_movements WHERE product_id = $1', [fixtureProductId])).rows[0].count, 10);

    console.log(`  Archivado: en tienda pública=${inStorefrontArchived} | intento nuevo pedido: error="${createOrderArchivedError}"`);
    console.log(`  Historial conservado: order_items=${histOrderItemsAfter} (antes=${histOrderItemsBefore}) | stock_movements=${histMovsAfter} (antes=${histMovsBefore})`);

    // 3. Desarchivar producto
    await client.query('SELECT archive_product($1, false)', [fixtureProductId]);
    const sfProductsAfterRestore = (await client.query('SELECT get_storefront_products()')).rows[0].get_storefront_products;
    const inStorefrontRestored = sfProductsAfterRestore.some(p => p.id === fixtureProductId);
    const prodRowRestored = (await client.query('SELECT id, active, published FROM products WHERE id = $1', [fixtureProductId])).rows[0];

    console.log(`  Desarchivado: en tienda pública=${inStorefrontRestored} | active=${prodRowRestored.active} | published=${prodRowRestored.published}`);

    const t5Ok =
      inStorefrontArchived === false &&
      createOrderArchivedError === 'PRODUCT_NOT_FOUND' &&
      prodRowInDb !== undefined &&
      prodRowInDb.active === false &&
      prodRowInDb.published === false &&
      histOrderItemsBefore === histOrderItemsAfter &&
      histMovsBefore === histMovsAfter &&
      inStorefrontRestored === true &&
      prodRowRestored.active === true &&
      prodRowRestored.published === true;

    results.push({
      test: 'TEST 5 — Archivar producto',
      ok: t5Ok,
      details: {
        visibleEnTiendaArchivado: inStorefrontArchived,
        errorAlIntentarPedirArchivado: createOrderArchivedError,
        productoPermaneceEnDb: Boolean(prodRowInDb),
        itemsHistóricosIntactos: histOrderItemsAfter === histOrderItemsBefore,
        movimientosStockHistóricosIntactos: histMovsAfter === histMovsBefore,
        visibleEnTiendaDesarchivado: inStorefrontRestored,
        estadoActivoTrasDesarchivar: prodRowRestored.active && prodRowRestored.published
      }
    });
    console.log(`Resultado TEST 5: ${t5Ok ? 'APROBADO' : 'RECHAZADO'}\n`);

    // =========================================================================
    // TEST 6 — Pedido manual simple con stock físico
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 6 — Pedido manual simple con stock físico');
    console.log('Objetivo: validar el ciclo completo de venta física sin navegador');
    console.log('================================================================');

    // Fixture: precio = 33.000, costo = 18.000, on_hand = 10, reserved = 0
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [fixtureProductId]);

    // Crear pedido de 1 unidad
    const t6Payload = {
      customerName: 'Cliente Test Venta Fisica',
      lines: [{ productId: fixtureProductId, quantity: 1, unitPriceCents: 3300000 }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolChecksum: '77889900'
    };
    const t6Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t6Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t6Order.id);

    // Estado después de crear
    const t6Bal1 = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t6OrderInDb1 = (await client.query('SELECT * FROM orders WHERE id = $1', [t6Order.id])).rows[0];

    console.log(`  1. Creado: subtotal=${t6OrderInDb1.subtotal_cents} ($33.000) | shipping=${t6OrderInDb1.shipping_fee_cents} ($0) | total=${t6OrderInDb1.total_cents} ($33.000)`);
    console.log(`     Stock: on_hand=${t6Bal1.on_hand} | reserved=${t6Bal1.reserved} | available=${t6Bal1.on_hand - t6Bal1.reserved} | payment=${t6OrderInDb1.payment_state} | fulfillment=${t6OrderInDb1.fulfillment_state}`);

    // Marcar cobrado
    await client.query("SELECT transition_order($1, 'mark_paid')", [t6Order.id]);
    const t6Bal2 = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t6OrderInDb2 = (await client.query('SELECT payment_state, paid_at FROM orders WHERE id = $1', [t6Order.id])).rows[0];

    console.log(`  2. Cobrado: payment_state=${t6OrderInDb2.payment_state} | stock intacto: on_hand=${t6Bal2.on_hand}, reserved=${t6Bal2.reserved}`);

    // Marcar entregado
    await client.query("SELECT transition_order($1, 'mark_delivered')", [t6Order.id]);
    const t6Bal3 = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t6OrderInDb3 = (await client.query('SELECT fulfillment_state, cost_total_cents, total_cents FROM orders WHERE id = $1', [t6Order.id])).rows[0];
    const t6Movements = (await client.query('SELECT kind, physical_delta, reserved_delta FROM stock_movements WHERE order_id = $1', [t6Order.id])).rows;

    const t6SaleMovements = t6Movements.filter(m => m.kind === 'sale');
    const t6Income = parseInt(t6OrderInDb3.total_cents, 10);
    const t6Cost = parseInt(t6OrderInDb3.cost_total_cents, 10);
    const t6Profit = t6Income - t6Cost;

    console.log(`  3. Entregado: fulfillment_state=${t6OrderInDb3.fulfillment_state} | on_hand=${t6Bal3.on_hand} (esperado 9) | reserved=${t6Bal3.reserved} (esperado 0) | available=${t6Bal3.on_hand - t6Bal3.reserved}`);
    console.log(`     Consumo stock: ${t6SaleMovements.length} movimiento(s) de venta (delta=${t6SaleMovements[0]?.physical_delta})`);
    console.log(`     Ventas y Margen: Ingreso=$${t6Income / 100} | Costo Snapshot=$${t6Cost / 100} | Ganancia Real=$${t6Profit / 100}`);

    const t6Ok =
      parseInt(t6OrderInDb1.subtotal_cents, 10) === 3300000 &&
      parseInt(t6OrderInDb1.shipping_fee_cents, 10) === 0 &&
      parseInt(t6OrderInDb1.total_cents, 10) === 3300000 &&
      t6Bal1.on_hand === 10 &&
      t6Bal1.reserved === 1 &&
      (t6Bal1.on_hand - t6Bal1.reserved) === 9 &&
      t6OrderInDb2.payment_state === 'paid' &&
      t6Bal2.on_hand === 10 &&
      t6Bal2.reserved === 1 &&
      t6OrderInDb3.fulfillment_state === 'delivered' &&
      t6Bal3.on_hand === 9 &&
      t6Bal3.reserved === 0 &&
      (t6Bal3.on_hand - t6Bal3.reserved) === 9 &&
      t6SaleMovements.length === 1 &&
      t6SaleMovements[0]?.physical_delta === -1 &&
      t6Income === 3300000 &&
      t6Cost === 1800000 &&
      t6Profit === 1500000;

    results.push({
      test: 'TEST 6 — Pedido manual simple con stock físico',
      ok: t6Ok,
      details: {
        subtotalInicial: t6OrderInDb1.subtotal_cents,
        shippingInicial: t6OrderInDb1.shipping_fee_cents,
        totalInicial: t6OrderInDb1.total_cents,
        stockTrasCrear: `on_hand=${t6Bal1.on_hand}, reserved=${t6Bal1.reserved}, disp=9`,
        stockTrasCobrar: `on_hand=${t6Bal2.on_hand}, reserved=${t6Bal2.reserved}`,
        stockTrasEntregar: `on_hand=${t6Bal3.on_hand}, reserved=${t6Bal3.reserved}, disp=9`,
        movimientosVenta: t6SaleMovements.length,
        deltaFisico: t6SaleMovements[0]?.physical_delta,
        ingresoCents: t6Income,
        costoSnapshotCents: t6Cost,
        gananciaCents: t6Profit
      }
    });
    console.log(`Resultado TEST 6: ${t6Ok ? 'APROBADO' : 'RECHAZADO'}\n`);

    // =========================================================================
    // TEST 7 — Pedido manual con envío pago
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 7 — Pedido manual con envío pago');
    console.log('Objetivo: validar flete, transiciones secuenciales y defensas de entrega');
    console.log('================================================================');

    // Fixture: stock on_hand = 10, reserved = 0
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [fixtureProductId]);

    // 1. Defensa: Shipping sin dirección -> rechazo
    let errNoAddress = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify({
        customerName: 'Cliente Sin Direccion',
        lines: [{ productId: fixtureProductId, quantity: 1, unitPriceCents: fixturePrice }],
        deliveryMethod: 'shipping',
        shippingType: 'standard',
        shippingFeeCents: 450000,
        address: '',
        addressNumber: '',
        phone: '+5491144445555',
        paymentMethod: 'cash',
        protocolChecksum: '88990011'
      })]);
    } catch (err) {
      errNoAddress = err.message;
    }

    // 2. Defensa: Pickup con shipping_fee > 0 -> rechazo
    let errPickupFee = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify({
        customerName: 'Cliente Pickup Con Flete',
        lines: [{ productId: fixtureProductId, quantity: 1, unitPriceCents: fixturePrice }],
        deliveryMethod: 'pickup',
        shippingFeeCents: 450000,
        paymentMethod: 'cash',
        protocolChecksum: '99001122'
      })]);
    } catch (err) {
      errPickupFee = err.message;
    }

    console.log(`  Defensas de flete:`);
    console.log(`    Shipping sin dirección -> Error="${errNoAddress}" (esperado INVALID_ORDER)`);
    console.log(`    Pickup con flete > 0   -> Error="${errPickupFee}" (esperado INVALID_ORDER)`);

    // 3. Pedido válido con envío estándar ($4.500)
    const t7Payload = {
      customerName: 'Cliente Envio Valido',
      lines: [{ productId: fixtureProductId, quantity: 1, unitPriceCents: 3300000 }],
      deliveryMethod: 'shipping',
      shippingType: 'standard',
      shippingFeeCents: 450000, // 4.500 ARS
      address: 'Av. Corrientes',
      addressNumber: '1234',
      phone: '+5491144445555',
      paymentMethod: 'transfer',
      protocolChecksum: '00112233'
    };
    const t7Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t7Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t7Order.id);

    const t7OrderInDb1 = (await client.query('SELECT subtotal_cents, shipping_fee_cents, total_cents FROM orders WHERE id = $1', [t7Order.id])).rows[0];
    console.log(`  Pedido con envío creado: subtotal=${t7OrderInDb1.subtotal_cents} ($33.000) | shipping=${t7OrderInDb1.shipping_fee_cents} ($4.500) | total=${t7OrderInDb1.total_cents} ($37.500)`);

    // Secuencia de transiciones: pending -> paid -> shipped -> delivered
    // A. Mark paid
    await client.query("SELECT transition_order($1, 'mark_paid')", [t7Order.id]);
    const t7BalPaid = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];

    // B. Mark shipped (aquí el stock físico debe salir y registrar 1 movimiento)
    await client.query("SELECT transition_order($1, 'mark_shipped')", [t7Order.id]);
    const t7BalShipped = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t7MovsShipped = (await client.query('SELECT count(*) FROM stock_movements WHERE order_id = $1', [t7Order.id])).rows[0].count;

    // C. Mark delivered (aquí NO se debe descontar stock de nuevo ni duplicar movimiento)
    await client.query("SELECT transition_order($1, 'mark_delivered')", [t7Order.id]);
    const t7BalDelivered = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [fixtureProductId])).rows[0];
    const t7MovsDelivered = (await client.query('SELECT count(*) FROM stock_movements WHERE order_id = $1', [t7Order.id])).rows[0].count;
    const t7FinalOrder = (await client.query('SELECT payment_state, fulfillment_state FROM orders WHERE id = $1', [t7Order.id])).rows[0];

    console.log(`  Tras mark_paid: stock on_hand=${t7BalPaid.on_hand}, reserved=${t7BalPaid.reserved}`);
    console.log(`  Tras mark_shipped: stock on_hand=${t7BalShipped.on_hand}, reserved=${t7BalShipped.reserved} | movs=${t7MovsShipped}`);
    console.log(`  Tras mark_delivered: stock on_hand=${t7BalDelivered.on_hand}, reserved=${t7BalDelivered.reserved} | movs=${t7MovsDelivered} (duplicados: ${parseInt(t7MovsDelivered, 10) === parseInt(t7MovsShipped, 10) ? 'NO' : 'SÍ'})`);

    const t7Ok =
      errNoAddress === 'INVALID_ORDER' &&
      errPickupFee === 'INVALID_ORDER' &&
      parseInt(t7OrderInDb1.subtotal_cents, 10) === 3300000 &&
      parseInt(t7OrderInDb1.shipping_fee_cents, 10) === 450000 &&
      parseInt(t7OrderInDb1.total_cents, 10) === 3750000 &&
      t7BalPaid.on_hand === 10 &&
      t7BalPaid.reserved === 1 &&
      t7BalShipped.on_hand === 9 &&
      t7BalShipped.reserved === 0 &&
      parseInt(t7MovsShipped, 10) === 1 &&
      t7BalDelivered.on_hand === 9 &&
      t7BalDelivered.reserved === 0 &&
      parseInt(t7MovsDelivered, 10) === 1 && // Consumo único sin duplicación
      t7FinalOrder.payment_state === 'paid' &&
      t7FinalOrder.fulfillment_state === 'delivered';

    results.push({
      test: 'TEST 7 — Pedido manual con envío pago',
      ok: t7Ok,
      details: {
        rechazoEnvioSinDireccion: errNoAddress === 'INVALID_ORDER',
        rechazoRetiroConFlete: errPickupFee === 'INVALID_ORDER',
        subtotalCents: t7OrderInDb1.subtotal_cents,
        shippingFeeCents: t7OrderInDb1.shipping_fee_cents,
        totalCents: t7OrderInDb1.total_cents,
        stockAlEnviar: `on_hand=${t7BalShipped.on_hand}, reserved=${t7BalShipped.reserved}`,
        stockAlEntregar: `on_hand=${t7BalDelivered.on_hand}, reserved=${t7BalDelivered.reserved}`,
        movimientosTotales: parseInt(t7MovsDelivered, 10),
        consumoUnicoSinDuplicacion: parseInt(t7MovsDelivered, 10) === 1,
        estadoFinal: `payment=${t7FinalOrder.payment_state}, fulfillment=${t7FinalOrder.fulfillment_state}`
      }
    });
    console.log(`Resultado TEST 7: ${t7Ok ? 'APROBADO' : 'RECHAZADO'}\n`);

  } finally {
    // -------------------------------------------------------------------------
    // TEARDOWN: Limpieza de registros de prueba
    // -------------------------------------------------------------------------
    console.log('--- TEARDOWN: Limpiando órdenes y fixtures creados para el test ---');
    if (createdOrderIds.length > 0) {
      await client.query('DELETE FROM stock_movements WHERE order_id = ANY($1)', [createdOrderIds]);
      await client.query('DELETE FROM stock_reservations WHERE order_id = ANY($1)', [createdOrderIds]);
      await client.query('DELETE FROM order_items WHERE order_id = ANY($1)', [createdOrderIds]);
      await client.query('DELETE FROM orders WHERE id = ANY($1)', [createdOrderIds]);
      console.log(`✓ Eliminadas ${createdOrderIds.length} órdenes de prueba y sus tablas hijas.`);
    }
    if (fixtureProductId) {
      await client.query('DELETE FROM stock_balances WHERE product_id = $1', [fixtureProductId]);
      await client.query('DELETE FROM product_financials WHERE product_id = $1', [fixtureProductId]);
      await client.query('DELETE FROM products WHERE id = $1', [fixtureProductId]);
      console.log(`✓ Eliminado producto fixture temporal ID=${fixtureProductId}`);
    }
    await client.end();
  }

  // ---------------------------------------------------------------------------
  // REPORTE FINAL CONSOLIDADO
  // ---------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log('RESUMEN DE LA SUITE DE INTEGRACIÓN / BASE DE DATOS (7/7)');
  console.log('================================================================');
  console.log(JSON.stringify(results, null, 2));

  const allPassed = results.every(r => r.ok);
  console.log(`\nESTADO GENERAL: ${allPassed ? 'TODOS LOS TESTS APROBADOS (7/7)' : 'HAY FALLAS EN LA SUITE'}`);
  process.exit(allPassed ? 0 : 1);
}

run().catch((err) => {
  console.error('Error fatal ejecutando la suite:', err);
  process.exit(1);
});
