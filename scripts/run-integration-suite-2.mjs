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

async function run() {
  await client.connect();
  console.log('=== CONECTADO A BASE DE DATOS SUPABASE (mvtpidtuntvebyrxivue) ===\n');

  await setAuth(OWNER_ID);

  const results = [];
  const createdOrderIds = [];
  const createdPurchaseIds = [];
  const createdProductIds = [];

  // Helper para crear producto aislado
  async function createTestProduct(prefix, price = 3300000, cost = 1800000) {
    const slug = `${prefix.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sku = `${prefix.toUpperCase()}${Date.now().toString().slice(-4)}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
    const prodRes = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, $3, 'Pote 300g', 'Producto de prueba de integracion serie 2', 'Test', $4, true, true)
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
        notes: 'Compra de prueba automatizada serie 2',
        items
      })]
    );
    const purch = purchRes.rows[0].purch;
    createdPurchaseIds.push(purch.id);
    return purch;
  }

  try {
    // =========================================================================
    // TEST 8 — Pedido manual 100% en camino
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 8 — Pedido manual 100% en camino');
    console.log('Fixture: on_hand=0, reserved=0. Compra proveedor: qty=5, state=ordered.');
    console.log('Pedido manual: qty=1, cash, pickup.');
    console.log('Verificar: reserva incoming=1, física=0, stockReadiness=waiting_incoming.');
    console.log('Y que mark_delivered se rechaza con CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK.');
    console.log('================================================================');

    const prod8 = await createTestProduct('T8');
    const purch8 = await createTestPurchase('Distribuidor Test 8', [
      { productId: prod8.id, quantity: 5, unitCostCents: prod8.costCents }
    ]);
    const purchItem8Id = purch8.items[0].id;

    console.log(`✓ Fixture T8: Producto ${prod8.sku} (on_hand=0, reserved=0), Compra #${purch8.number} (qty=5, state=ordered)`);

    // Pedido manual de 1 unidad
    const t8Payload = {
      customerName: 'Cliente Test 8 Incoming',
      lines: [{ productId: prod8.id, quantity: 1, unitPriceCents: prod8.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };
    const t8Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t8Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t8Order.id);

    // Inspección profunda de tablas
    const t8DbOrder = (await client.query('SELECT id, order_number, order_state, fulfillment_state, subtotal_cents, total_cents FROM orders WHERE id = $1', [t8Order.id])).rows[0];
    const t8DbItems = (await client.query('SELECT id, product_id, quantity, unit_price_cents FROM order_items WHERE order_id = $1', [t8Order.id])).rows;
    const t8DbReservations = (await client.query('SELECT id, product_id, quantity, state, source_type, purchase_item_id FROM stock_reservations WHERE order_id = $1', [t8Order.id])).rows;
    const t8DbBalance = (await client.query('SELECT on_hand, reserved, (on_hand - reserved) AS available FROM stock_balances WHERE product_id = $1', [prod8.id])).rows[0];
    const t8Readiness = (await client.query("SELECT private.order_payload($1, true) ->> 'stockReadiness' AS readiness", [t8Order.id])).rows[0].readiness;

    console.log(`  Order: #${t8DbOrder.order_number} | fulfillment_state=${t8DbOrder.fulfillment_state}`);
    console.log(`  Items: ${t8DbItems.length} | Cantidad=${t8DbItems[0].quantity}`);
    console.log(`  Reservas: ${t8DbReservations.length}`);
    for (const r of t8DbReservations) {
      console.log(`    - ID=${r.id} | source_type=${r.source_type} | qty=${r.quantity} | purchase_item_id=${r.purchase_item_id}`);
    }
    console.log(`  Stock balances: on_hand=${t8DbBalance.on_hand} | reserved=${t8DbBalance.reserved} | available=${t8DbBalance.available}`);
    console.log(`  stockReadiness: ${t8Readiness}`);

    const t8IncomingRes = t8DbReservations.filter(r => r.state === 'active' && r.source_type === 'incoming');
    const t8PhysicalRes = t8DbReservations.filter(r => r.state === 'active' && r.source_type === 'physical');

    let t8DeliverError = null;
    try {
      await client.query("SELECT transition_order($1, 'mark_delivered')", [t8Order.id]);
    } catch (err) {
      t8DeliverError = err.message;
    }
    console.log(`  Intento mark_delivered: ${t8DeliverError ? 'RECHAZADO con "' + t8DeliverError + '"' : 'ERROR: NO FUE RECHAZADO'}`);

    const t8Pass =
      t8DbOrder.id &&
      t8DbItems.length === 1 &&
      t8IncomingRes.length === 1 &&
      t8IncomingRes[0].quantity === 1 &&
      t8IncomingRes[0].purchase_item_id === purchItem8Id &&
      t8PhysicalRes.length === 0 &&
      t8DbBalance.on_hand === 0 &&
      t8DbBalance.reserved === 0 &&
      t8Readiness === 'waiting_incoming' &&
      t8DeliverError &&
      t8DeliverError.includes('CANNOT_DELIVER_ORDER_WAITING_FOR_STOCK');

    results.push({ name: 'TEST 8 — Pedido manual 100% en camino', pass: !!t8Pass });
    console.log(t8Pass ? '✓ TEST 8 APROBADO EXITOSAMENTE\n' : '✗ TEST 8 FALLÓ\n');

    // =========================================================================
    // TEST 9 — Mismo producto: parte físico + parte en camino
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 9 — Mismo producto: parte físico + parte en camino');
    console.log('Fixture: on_hand=2, reserved=0. Compra proveedor: incoming=3.');
    console.log('Pedido manual: qty=4.');
    console.log('Debe asignar: 2 physical + 2 incoming (no 4 incoming, no 2 y perder 2).');
    console.log('Verificar: sum(reservas)=4, physical=2, incoming=2, stockReadiness=waiting_incoming, available físico=0.');
    console.log('================================================================');

    const prod9 = await createTestProduct('T9');
    // Cargar 2 unidades físicas
    await client.query('UPDATE stock_balances SET on_hand = 2, reserved = 0 WHERE product_id = $1', [prod9.id]);

    // Compra con 3 unidades en camino
    const purch9 = await createTestPurchase('Distribuidor Test 9', [
      { productId: prod9.id, quantity: 3, unitCostCents: prod9.costCents }
    ]);
    const purchItem9Id = purch9.items[0].id;

    console.log(`✓ Fixture T9: Producto ${prod9.sku} (on_hand=2, reserved=0), Compra #${purch9.number} (qty=3 en camino)`);

    // Pedido manual de 4 unidades
    const t9Payload = {
      customerName: 'Cliente Test 9 Split',
      lines: [{ productId: prod9.id, quantity: 4, unitPriceCents: prod9.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };
    const t9Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t9Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t9Order.id);

    // Inspección profunda
    const t9DbReservations = (await client.query('SELECT id, product_id, quantity, state, source_type, purchase_item_id FROM stock_reservations WHERE order_id = $1', [t9Order.id])).rows;
    const t9DbBalance = (await client.query('SELECT on_hand, reserved, (on_hand - reserved) AS available FROM stock_balances WHERE product_id = $1', [prod9.id])).rows[0];
    const t9Readiness = (await client.query("SELECT private.order_payload($1, true) ->> 'stockReadiness' AS readiness", [t9Order.id])).rows[0].readiness;

    console.log(`  Reservas creadas (${t9DbReservations.length}):`);
    let t9PhysQty = 0;
    let t9IncQty = 0;
    for (const r of t9DbReservations) {
      console.log(`    - ID=${r.id} | source_type=${r.source_type} | qty=${r.quantity} | state=${r.state} | purchase_item_id=${r.purchase_item_id}`);
      if (r.state === 'active' && r.source_type === 'physical') t9PhysQty += r.quantity;
      if (r.state === 'active' && r.source_type === 'incoming') t9IncQty += r.quantity;
    }
    console.log(`  Totales asignados: Físico=${t9PhysQty} | En camino=${t9IncQty} | Total=${t9PhysQty + t9IncQty}`);
    console.log(`  Stock balances: on_hand=${t9DbBalance.on_hand} | reserved=${t9DbBalance.reserved} | available=${t9DbBalance.available}`);
    console.log(`  stockReadiness: ${t9Readiness}`);

    const t9Pass =
      (t9PhysQty + t9IncQty) === 4 &&
      t9PhysQty === 2 &&
      t9IncQty === 2 &&
      t9DbBalance.on_hand === 2 &&
      t9DbBalance.reserved === 2 &&
      t9DbBalance.available === 0 &&
      t9Readiness === 'waiting_incoming';

    results.push({ name: 'TEST 9 — Mismo producto: parte físico + parte en camino', pass: !!t9Pass });
    console.log(t9Pass ? '✓ TEST 9 APROBADO EXITOSAMENTE\n' : '✗ TEST 9 FALLÓ\n');

    // =========================================================================
    // TEST 10 — Pedido manual con dos productos distintos y fuentes distintas
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 10 — Pedido manual con dos productos distintos y fuentes distintas');
    console.log('Fixture: Prod A (1 físico disponible), Prod B (0 físico, 2 incoming disponibles).');
    console.log('Pedido: A x 1 + B x 1.');
    console.log('Verificar: 2 order_items, A->physical, B->incoming, total correcto, stockReadiness=waiting_incoming.');
    console.log('Luego: recibir producto B vía receive_purchase.');
    console.log('Verificar: pasa automáticamente a ready sin modificar la reserva física de A.');
    console.log('================================================================');

    const prod10A = await createTestProduct('T10A', 2000000, 1000000);
    const prod10B = await createTestProduct('T10B', 3000000, 1500000);

    // Prod A: 1 físico disponible
    await client.query('UPDATE stock_balances SET on_hand = 1, reserved = 0 WHERE product_id = $1', [prod10A.id]);

    // Prod B: 0 físico, 2 incoming en compra
    const purch10 = await createTestPurchase('Distribuidor Test 10', [
      { productId: prod10B.id, quantity: 2, unitCostCents: prod10B.costCents }
    ]);
    const purchItem10BId = purch10.items[0].id;

    console.log(`✓ Fixture T10: Prod A ${prod10A.sku} (1 físico), Prod B ${prod10B.sku} (0 físico, 2 incoming en Compra #${purch10.number})`);

    // Pedido manual A x 1 + B x 1
    const t10Payload = {
      customerName: 'Cliente Test 10 Mixto',
      lines: [
        { productId: prod10A.id, quantity: 1, unitPriceCents: prod10A.sale_price_cents },
        { productId: prod10B.id, quantity: 1, unitPriceCents: prod10B.sale_price_cents }
      ],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };
    const t10Order = (await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t10Payload)])).rows[0].confirm_imported_order;
    createdOrderIds.push(t10Order.id);

    // Verificación inicial
    const t10DbOrder = (await client.query('SELECT total_cents, subtotal_cents FROM orders WHERE id = $1', [t10Order.id])).rows[0];
    const t10DbItems = (await client.query('SELECT id, product_id, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY product_id', [t10Order.id])).rows;
    const t10DbResInitial = (await client.query('SELECT id, product_id, quantity, state, source_type, purchase_item_id FROM stock_reservations WHERE order_id = $1', [t10Order.id])).rows;
    const t10ReadinessInitial = (await client.query("SELECT private.order_payload($1, true) ->> 'stockReadiness' AS readiness", [t10Order.id])).rows[0].readiness;

    const resA = t10DbResInitial.find(r => r.product_id === prod10A.id);
    const resB = t10DbResInitial.find(r => r.product_id === prod10B.id);

    const expectedTotal = Number(prod10A.sale_price_cents) + Number(prod10B.sale_price_cents);
    console.log(`  Orden total: $${Number(t10DbOrder.total_cents) / 100} (Esperado: $${expectedTotal / 100})`);
    console.log(`  Items creados: ${t10DbItems.length}`);
    console.log(`  Reserva Prod A: source_type=${resA?.source_type} | qty=${resA?.quantity} | purchase_item_id=${resA?.purchase_item_id}`);
    console.log(`  Reserva Prod B: source_type=${resB?.source_type} | qty=${resB?.quantity} | purchase_item_id=${resB?.purchase_item_id}`);
    console.log(`  stockReadiness inicial: ${t10ReadinessInitial}`);

    const t10InitialOk =
      t10DbItems.length === 2 &&
      Number(t10DbOrder.total_cents) === expectedTotal &&
      resA?.source_type === 'physical' && resA?.quantity === 1 &&
      resB?.source_type === 'incoming' && resB?.quantity === 1 &&
      t10ReadinessInitial === 'waiting_incoming';

    // Recibir compra del producto B
    console.log('\n  --> Ejecutando receive_purchase para recibir 2 unidades de Prod B...');
    const receiveResult = (await client.query(
      'SELECT public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) AS res',
      [
        purch10.id,
        JSON.stringify([{ purchaseItemId: purchItem10BId, receivedQuantity: 2 }]),
        crypto.randomUUID()
      ]
    )).rows[0].res;

    console.log(`  Respuesta de recepción: unblockedOrders=${JSON.stringify(receiveResult.unblockedOrders)}`);

    // Verificación tras recepción
    const t10DbResAfter = (await client.query('SELECT id, product_id, quantity, state, source_type, purchase_item_id FROM stock_reservations WHERE order_id = $1', [t10Order.id])).rows;
    const t10ReadinessAfter = (await client.query("SELECT private.order_payload($1, true) ->> 'stockReadiness' AS readiness", [t10Order.id])).rows[0].readiness;
    const resAAfter = t10DbResAfter.find(r => r.product_id === prod10A.id);
    const resBAfter = t10DbResAfter.find(r => r.product_id === prod10B.id);

    console.log(`  Reserva Prod A tras recepción: ID=${resAAfter?.id} | source_type=${resAAfter?.source_type} | qty=${resAAfter?.quantity}`);
    console.log(`  Reserva Prod B tras recepción: ID=${resBAfter?.id} | source_type=${resBAfter?.source_type} | qty=${resBAfter?.quantity}`);
    console.log(`  stockReadiness tras recepción: ${t10ReadinessAfter}`);

    // Balances de stock
    const balA = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod10A.id])).rows[0];
    const balB = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod10B.id])).rows[0];
    console.log(`  Stock Prod A: on_hand=${balA.on_hand} | reserved=${balA.reserved}`);
    console.log(`  Stock Prod B: on_hand=${balB.on_hand} | reserved=${balB.reserved}`);

    const t10Pass =
      t10InitialOk &&
      resAAfter?.id === resA?.id &&
      resAAfter?.source_type === 'physical' &&
      resAAfter?.quantity === 1 &&
      resBAfter?.source_type === 'physical' &&
      resBAfter?.quantity === 1 &&
      t10ReadinessAfter === 'ready' &&
      balA.on_hand === 1 && balA.reserved === 1 &&
      balB.on_hand === 2 && balB.reserved === 1;

    results.push({ name: 'TEST 10 — Pedido manual con dos productos distintos y fuentes distintas', pass: !!t10Pass });
    console.log(t10Pass ? '✓ TEST 10 APROBADO EXITOSAMENTE\n' : '✗ TEST 10 FALLÓ\n');

    // =========================================================================
    // TEST 11 — Incoming insuficiente
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 11 — Incoming insuficiente');
    console.log('Fixture: on_hand=0, incoming disponible=2.');
    console.log('Pedido manual: qty=3.');
    console.log('Debe rechazar con INSUFFICIENT_STOCK y dejar 0 orders, 0 items, 0 reservas, 0 movimientos, compra intacta.');
    console.log('================================================================');

    const prod11 = await createTestProduct('T11');
    const purch11 = await createTestPurchase('Distribuidor Test 11', [
      { productId: prod11.id, quantity: 2, unitCostCents: prod11.costCents }
    ]);
    const purchItem11Id = purch11.items[0].id;

    console.log(`✓ Fixture T11: Producto ${prod11.sku} (on_hand=0), Compra #${purch11.number} (qty=2 en camino)`);

    const ordersCountBefore11 = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
    const reservationsCountBefore11 = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1', [prod11.id])).rows[0].count, 10);
    const movementsCountBefore11 = parseInt((await client.query('SELECT count(*) FROM stock_movements WHERE product_id = $1', [prod11.id])).rows[0].count, 10);

    const t11Payload = {
      customerName: 'Cliente Test 11 Insuficiente',
      lines: [{ productId: prod11.id, quantity: 3, unitPriceCents: prod11.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };

    let t11Error = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t11Payload)]);
    } catch (err) {
      t11Error = err.message;
    }

    const ordersCountAfter11 = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
    const reservationsCountAfter11 = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1', [prod11.id])).rows[0].count, 10);
    const movementsCountAfter11 = parseInt((await client.query('SELECT count(*) FROM stock_movements WHERE product_id = $1', [prod11.id])).rows[0].count, 10);
    const pi11After = (await client.query('SELECT quantity, received_quantity, shortage_quantity FROM purchase_items WHERE id = $1', [purchItem11Id])).rows[0];
    const bal11After = (await client.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod11.id])).rows[0];

    console.log(`  Resultado RPC: ${t11Error ? 'RECHAZADO con "' + t11Error + '"' : 'ERROR: NO RECHAZADO'}`);
    console.log(`  Orders creadas: ${ordersCountAfter11 - ordersCountBefore11}`);
    console.log(`  Reservas creadas: ${reservationsCountAfter11 - reservationsCountBefore11}`);
    console.log(`  Movimientos creados: ${movementsCountAfter11 - movementsCountBefore11}`);
    console.log(`  Purchase item intacto: qty=${pi11After.quantity} | received=${pi11After.received_quantity} | shortage=${pi11After.shortage_quantity}`);
    console.log(`  Stock balance: on_hand=${bal11After.on_hand} | reserved=${bal11After.reserved}`);

    const t11Pass =
      t11Error &&
      t11Error.includes('INSUFFICIENT_STOCK') &&
      ordersCountAfter11 === ordersCountBefore11 &&
      reservationsCountAfter11 === reservationsCountBefore11 &&
      movementsCountAfter11 === movementsCountBefore11 &&
      pi11After.quantity === 2 &&
      pi11After.received_quantity === 0 &&
      bal11After.on_hand === 0 &&
      bal11After.reserved === 0;

    results.push({ name: 'TEST 11 — Incoming insuficiente', pass: !!t11Pass });
    console.log(t11Pass ? '✓ TEST 11 APROBADO EXITOSAMENTE\n' : '✗ TEST 11 FALLÓ\n');

    // =========================================================================
    // TEST 12 — Compra proveedor deja de ser válida antes de confirmar
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 12 — Compra proveedor deja de ser válida antes de confirmar');
    console.log('Preparar producto con incoming disponible.');
    console.log('Antes de confirmar el pedido manual, cancelar/cerrar la compra proveedor.');
    console.log('Confirmar pedido.');
    console.log('Debe rechazar (INSUFFICIENT_STOCK) y no crear pedidos ni reservas contra compra inválida.');
    console.log('================================================================');

    const prod12 = await createTestProduct('T12');
    const purch12 = await createTestPurchase('Distribuidor Test 12', [
      { productId: prod12.id, quantity: 5, unitCostCents: prod12.costCents }
    ]);

    console.log(`✓ Fixture T12: Producto ${prod12.sku} (on_hand=0), Compra #${purch12.number} creada.`);

    // Cancelar la compra proveedor antes de confirmar el pedido
    console.log('  --> Cancelando la compra a proveedor antes de confirmar el pedido manual...');
    await client.query("UPDATE purchases SET state = 'cancelled' WHERE id = $1", [purch12.id]);
    const purch12State = (await client.query('SELECT state FROM purchases WHERE id = $1', [purch12.id])).rows[0].state;
    console.log(`  Estado de compra proveedor tras cancelación: '${purch12State}'`);

    const ordersCountBefore12 = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
    const reservationsCountBefore12 = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1', [prod12.id])).rows[0].count, 10);

    const t12Payload = {
      customerName: 'Cliente Test 12 Cancelled Purchase',
      lines: [{ productId: prod12.id, quantity: 1, unitPriceCents: prod12.sale_price_cents }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };

    let t12Error = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t12Payload)]);
    } catch (err) {
      t12Error = err.message;
    }

    const ordersCountAfter12 = parseInt((await client.query('SELECT count(*) FROM orders')).rows[0].count, 10);
    const reservationsCountAfter12 = parseInt((await client.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1', [prod12.id])).rows[0].count, 10);

    console.log(`  Resultado RPC: ${t12Error ? 'RECHAZADO con "' + t12Error + '"' : 'ERROR: NO RECHAZADO'}`);
    console.log(`  Orders creadas: ${ordersCountAfter12 - ordersCountBefore12}`);
    console.log(`  Reservas creadas: ${reservationsCountAfter12 - reservationsCountBefore12}`);

    const t12Pass =
      t12Error &&
      t12Error.includes('INSUFFICIENT_STOCK') &&
      ordersCountAfter12 === ordersCountBefore12 &&
      reservationsCountAfter12 === reservationsCountBefore12;

    results.push({ name: 'TEST 12 — Compra proveedor deja de ser válida antes de confirmar', pass: !!t12Pass });
    console.log(t12Pass ? '✓ TEST 12 APROBADO EXITOSAMENTE\n' : '✗ TEST 12 FALLÓ\n');

    // =========================================================================
    // TEST 13 — Autoridad de precios en pedido manual
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 13 — Autoridad de precios en pedido manual');
    console.log('Producto DB: sale_price = $33.000. Store settings: shipping estándar = $4.500.');
    console.log('Caso A: Mandar directamente unitPriceCents = 100 ($1) a la RPC.');
    console.log('Caso B: Mandar shippingFeeCents = 100 ($1) con shipping estándar a la RPC.');
    console.log('Verificar: Servidor/DB rechaza con ORDER_PRICE_CHANGED. JAMÁS crea órdenes a $1.');
    console.log('================================================================');

    const prod13 = await createTestProduct('T13', 3300000); // $33.000
    // Asignar stock físico suficiente para que no falle por stock
    await client.query('UPDATE stock_balances SET on_hand = 10, reserved = 0 WHERE product_id = $1', [prod13.id]);

    const settings = (await client.query('SELECT standard_shipping_cents FROM store_settings WHERE singleton_id = 1')).rows[0];
    const realStandardShipping = settings.standard_shipping_cents;
    console.log(`✓ Fixture T13: Prod ${prod13.sku} precio real = $${prod13.sale_price_cents / 100} | Flete real estándar = $${realStandardShipping / 100}`);

    // Caso 13A: Precio unitario manipulado ($1 = 100 cents en vez de $33.000 = 3.300.000 cents)
    console.log('\n  [13A] Prueba con precio unitario manipulado ($1 / 100 cents)...');
    const t13APayload = {
      customerName: 'Cliente Intento Hack Precio',
      lines: [{ productId: prod13.id, quantity: 1, unitPriceCents: 100 }],
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0
    };

    let t13AError = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t13APayload)]);
    } catch (err) {
      t13AError = err.message;
    }

    const count13A = parseInt((await client.query('SELECT count(*) FROM orders WHERE total_cents = 100')).rows[0].count, 10);
    console.log(`  Resultado 13A: ${t13AError ? 'RECHAZADO con "' + t13AError + '"' : 'ERROR: NO RECHAZADO'}`);
    console.log(`  Órdenes creadas a $1 en DB: ${count13A}`);

    // Caso 13B: Flete manipulado ($1 = 100 cents en vez de flete estándar real)
    console.log('\n  [13B] Prueba con flete de envío manipulado ($1 / 100 cents)...');
    const t13BPayload = {
      customerName: 'Cliente Intento Hack Flete',
      phone: '1122334455',
      address: 'Av Corrientes',
      addressNumber: '1234',
      lines: [{ productId: prod13.id, quantity: 1, unitPriceCents: prod13.sale_price_cents }],
      deliveryMethod: 'shipping',
      shippingType: 'standard',
      paymentMethod: 'cash',
      shippingFeeCents: 100 // $1 en vez de $4.500
    };

    let t13BError = null;
    try {
      await client.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(t13BPayload)]);
    } catch (err) {
      t13BError = err.message;
    }

    const count13B = parseInt((await client.query('SELECT count(*) FROM orders WHERE shipping_fee_cents = 100')).rows[0].count, 10);
    console.log(`  Resultado 13B: ${t13BError ? 'RECHAZADO con "' + t13BError + '"' : 'ERROR: NO RECHAZADO'}`);
    console.log(`  Órdenes creadas con flete de $1 en DB: ${count13B}`);

    const t13Pass =
      t13AError &&
      t13AError.includes('ORDER_PRICE_CHANGED') &&
      count13A === 0 &&
      t13BError &&
      t13BError.includes('ORDER_PRICE_CHANGED') &&
      count13B === 0;

    results.push({ name: 'TEST 13 — Autoridad de precios en pedido manual', pass: !!t13Pass });
    console.log(t13Pass ? '✓ TEST 13 APROBADO EXITOSAMENTE\n' : '✗ TEST 13 FALLÓ\n');

  } finally {
    console.log('--- TEARDOWN: Limpieza de datos de prueba creados durante la suite ---');
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

    await client.end();
  }

  // Resumen final
  console.log('================================================================');
  console.log('RESUMEN DE RESULTADOS — SERIE 2 (TESTS 8 A 13)');
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
  console.error('Error fatal ejecutando suite 2:', err);
  process.exit(1);
});
