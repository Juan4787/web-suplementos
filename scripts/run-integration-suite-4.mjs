import { loadEnv } from 'vite';
import { Client } from 'pg';
import crypto from 'node:crypto';

const env = loadEnv('production', process.cwd(), '');
const password = env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error('ERROR: SUPABASE_DB_PASSWORD no configurada en el entorno.');
  process.exit(1);
}

const connStr = `postgresql://postgres.mvtpidtuntvebyrxivue:${encodeURIComponent(password)}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`;
const OWNER_ID = 'cded5daf-3e27-4f6b-86dd-a514fac1cd28';

async function createClient() {
  const c = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

async function setAuth(client, userId = OWNER_ID) {
  await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await client.query("SELECT set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role: 'authenticated' })
  ]);
}

async function run() {
  const masterClient = await createClient();
  const clientA = await createClient();
  const clientB = await createClient();

  console.log('=== CONECTADO A BASE DE DATOS SUPABASE (mvtpidtuntvebyrxivue) ===');
  console.log('=== INICIANDO SERIE 4: CONCURRENCIA, ATOMICIDAD E IDEMPOTENCIA PROFUNDA ===\n');

  for (const c of [masterClient, clientA, clientB]) {
    await setAuth(c, OWNER_ID);
  }

  const results = [];
  const createdOrderIds = [];
  const createdPurchaseIds = [];
  const createdProductIds = [];

  // Helper para crear producto aislado
  async function createTestProduct(prefix, price = 3300000, cost = 1800000) {
    const cleanPrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = `${cleanPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sku = `${prefix.toUpperCase().replace(/[^A-Z0-9]/g, '')}${Date.now().toString().slice(-4)}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
    const prodRes = await masterClient.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, $3, 'Pote 300g', 'Producto de prueba concurrente serie 4', 'Test', $4, true, true)
       RETURNING id, sku, slug, name, sale_price_cents`,
      [sku, slug, `Prod ${sku}`, price]
    );
    const prod = prodRes.rows[0];
    createdProductIds.push(prod.id);

    await masterClient.query(
      `INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE SET current_cost_cents = $2`,
      [prod.id, cost]
    );

    await masterClient.query(
      `INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 0, 0)
       ON CONFLICT (product_id) DO UPDATE SET on_hand = 0, reserved = 0`,
      [prod.id]
    );

    return { ...prod, costCents: cost };
  }

  // Helper para crear compra a proveedor
  async function createTestPurchase(supplierName, items) {
    const purchRes = await masterClient.query(
      `SELECT public.create_purchase($1::jsonb) AS purch`,
      [JSON.stringify({
        supplierName,
        orderedAt: new Date().toISOString(),
        expectedAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        notes: 'Compra para pruebas de concurrencia serie 4',
        items
      })]
    );
    const purch = purchRes.rows[0].purch;
    createdPurchaseIds.push(purch.id);
    return purch;
  }

  // Wrapper para ejecutar transacción de pedido confirm_imported_order en un cliente
  async function runOrderTx(client, payload) {
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [OWNER_ID]);
      await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: OWNER_ID, role: 'authenticated' })]);
      const res = await client.query('SELECT confirm_imported_order($1::jsonb) AS o', [JSON.stringify(payload)]);
      await client.query('COMMIT');
      return { ok: true, order: res.rows[0].o };
    } catch (err) {
      await client.query('ROLLBACK');
      return { ok: false, error: err.message };
    }
  }

  try {
    // =========================================================================
    // CONTRATO DE IDEMPOTENCIA — Comparación de Campos Materiales en DB
    // =========================================================================
    console.log('================================================================');
    console.log('CONTRATO DE IDEMPOTENCIA — Validación de Campos Materiales en Servidor');
    console.log('Objetivo: Validar que alterar cualquier campo material (cliente, método de pago,');
    console.log('flete, dirección, método de entrega, etc.) con la misma clave cause IDEMPOTENCY_KEY_REUSE_MISMATCH,');
    console.log('sin depender exclusivamente del checksum provisto por el cliente.');
    console.log('================================================================');

    const prodIdemp = await createTestProduct('TIDEMP');
    await masterClient.query('UPDATE stock_balances SET on_hand = 100, reserved = 0 WHERE product_id = $1', [prodIdemp.id]);

    const baseKey = crypto.randomUUID();
    const baseChecksum = '12345678';
    const basePayload = {
      customerName: 'Cliente Base Idempotencia',
      phone: '1144445555',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      shippingFeeCents: 0,
      protocolOrderId: baseKey,
      protocolChecksum: baseChecksum,
      lines: [{ productId: prodIdemp.id, quantity: 1, unitPriceCents: prodIdemp.sale_price_cents }]
    };

    // Crear orden base
    const baseOrder = (await masterClient.query('SELECT confirm_imported_order($1::jsonb) AS o', [JSON.stringify(basePayload)])).rows[0].o;
    createdOrderIds.push(baseOrder.id);
    console.log(`  ✓ Orden base creada: #${baseOrder.number} (ID: ${baseOrder.id})`);

    // Pruebas de alteración de campos individuales con MISMO protocolOrderId y MISMO checksum
    const materialCases = [
      { field: 'customerName', payload: { ...basePayload, customerName: 'Otro Cliente Distinto' } },
      { field: 'phone', payload: { ...basePayload, phone: '1199998888' } },
      { field: 'paymentMethod', payload: { ...basePayload, paymentMethod: 'transfer' } },
      { field: 'deliveryMethod', payload: { ...basePayload, deliveryMethod: 'shipping', shippingType: 'standard', shippingFeeCents: 450000, address: 'Av Mayo', addressNumber: '100' } },
      { field: 'shippingType', payload: { ...basePayload, deliveryMethod: 'shipping', shippingType: 'express', shippingFeeCents: 700000, address: 'Av Mayo', addressNumber: '100' } },
      { field: 'shippingFeeCents', payload: { ...basePayload, deliveryMethod: 'shipping', shippingType: 'standard', shippingFeeCents: 100, address: 'Av Mayo', addressNumber: '100' } },
      { field: 'productLine quantity', payload: { ...basePayload, lines: [{ productId: prodIdemp.id, quantity: 2, unitPriceCents: prodIdemp.sale_price_cents }] } }
    ];

    let allMaterialCasesRejected = true;
    for (const c of materialCases) {
      let err = null;
      try {
        await masterClient.query('SELECT confirm_imported_order($1::jsonb)', [JSON.stringify(c.payload)]);
      } catch (e) {
        err = e.message;
      }
      const isMismatch = err && err.includes('IDEMPOTENCY_KEY_REUSE_MISMATCH');
      const isPriceOrInvalid = err && (err.includes('ORDER_PRICE_CHANGED') || err.includes('INVALID_ORDER'));
      const pass = isMismatch || isPriceOrInvalid;
      console.log(`  - Alterando '${c.field}': ${pass ? 'RECHAZADO con "' + err + '"' : 'ERROR: NO RECHAZADO'}`);
      if (!pass) allMaterialCasesRejected = false;
    }

    results.push({ name: 'CONTRATO IDEMPOTENCIA — Mismatch por campo material alterado', pass: allMaterialCasesRejected });
    console.log(allMaterialCasesRejected ? '✓ CONTRATO DE IDEMPOTENCIA APROBADO EXITOSAMENTE\n' : '✗ CONTRATO FALLÓ\n');

    // =========================================================================
    // TEST 21 — Dos confirmaciones simultáneas idénticas (Stress Concurrente)
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 21 — Dos confirmaciones simultáneas idénticas (Stress x25 iteraciones)');
    console.log('Mismo protocolOrderId, checksum y payload en paralelo.');
    console.log('Debe serializar vía advisory lock y devolver el mismo order.id sin unique_violation.');
    console.log('================================================================');

    const prod21 = await createTestProduct('T21');
    await masterClient.query('UPDATE stock_balances SET on_hand = 1000, reserved = 0 WHERE product_id = $1', [prod21.id]);

    let t21AllPass = true;
    const ITERATIONS_21 = 25;

    for (let i = 1; i <= ITERATIONS_21; i++) {
      const pKey = crypto.randomUUID();
      const pChecksum = 'ABCD1234';
      const payload = {
        customerName: `Cliente Concurrente 21 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: pKey,
        protocolChecksum: pChecksum,
        lines: [{ productId: prod21.id, quantity: 1, unitPriceCents: prod21.sale_price_cents }]
      };

      const [res1, res2] = await Promise.all([
        runOrderTx(clientA, payload),
        runOrderTx(clientB, payload)
      ]);

      if (!res1.ok || !res2.ok || res1.order.id !== res2.order.id) {
        console.error(`  ✗ Falló iteración ${i}: res1=${JSON.stringify(res1)}, res2=${JSON.stringify(res2)}`);
        t21AllPass = false;
        break;
      }
      createdOrderIds.push(res1.order.id);
    }

    const t21OrdersInDb = parseInt((await masterClient.query('SELECT count(*) FROM orders WHERE customer_name_snapshot LIKE \'Cliente Concurrente 21 Iter%\'')).rows[0].count, 10);
    const t21ReservedInDb = (await masterClient.query('SELECT reserved FROM stock_balances WHERE product_id = $1', [prod21.id])).rows[0].reserved;
    console.log(`  Iteraciones ejecutadas: ${ITERATIONS_21} | Órdenes creadas en DB: ${t21OrdersInDb} | Reserved: ${t21ReservedInDb}`);

    const t21Pass = t21AllPass && t21OrdersInDb === ITERATIONS_21 && t21ReservedInDb === ITERATIONS_21;
    results.push({ name: 'TEST 21 — Dos confirmaciones simultáneas idénticas (Stress x25)', pass: !!t21Pass });
    console.log(t21Pass ? '✓ TEST 21 APROBADO EXITOSAMENTE\n' : '✗ TEST 21 FALLÓ\n');

    // =========================================================================
    // TEST 22 — Dos confirmaciones simultáneas, misma clave y payload distinto (Stress x25)
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 22 — Dos confirmaciones simultáneas, misma clave y payload distinto (Stress x25)');
    console.log('Request A (qty=1) vs Request B (qty=2) con el mismo protocolOrderId.');
    console.log('Exactamente uno debe ganar y el otro arrojar IDEMPOTENCY_KEY_REUSE_MISMATCH.');
    console.log('================================================================');

    const prod22 = await createTestProduct('T22');
    await masterClient.query('UPDATE stock_balances SET on_hand = 1000, reserved = 0 WHERE product_id = $1', [prod22.id]);

    let t22AllPass = true;
    const ITERATIONS_22 = 25;

    for (let i = 1; i <= ITERATIONS_22; i++) {
      const pKey = crypto.randomUUID();
      const payloadA = {
        customerName: `Cliente T22 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: pKey,
        protocolChecksum: 'AAAA1111',
        lines: [{ productId: prod22.id, quantity: 1, unitPriceCents: prod22.sale_price_cents }]
      };
      const payloadB = {
        customerName: `Cliente T22 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: pKey,
        protocolChecksum: 'BBBB2222',
        lines: [{ productId: prod22.id, quantity: 2, unitPriceCents: prod22.sale_price_cents }]
      };

      const [resA, resB] = await Promise.all([
        runOrderTx(clientA, payloadA),
        runOrderTx(clientB, payloadB)
      ]);

      const oneSucceeded = (resA.ok && !resB.ok) || (!resA.ok && resB.ok);
      const failedHasMismatch = (!resA.ok && resA.error.includes('IDEMPOTENCY_KEY_REUSE_MISMATCH')) ||
                                (!resB.ok && resB.error.includes('IDEMPOTENCY_KEY_REUSE_MISMATCH'));

      if (!oneSucceeded || !failedHasMismatch) {
        console.error(`  ✗ Falló iteración ${i}: resA=${JSON.stringify(resA)}, resB=${JSON.stringify(resB)}`);
        t22AllPass = false;
        break;
      }
      const winningOrder = resA.ok ? resA.order : resB.order;
      createdOrderIds.push(winningOrder.id);
    }

    const t22OrdersInDb = parseInt((await masterClient.query('SELECT count(*) FROM orders WHERE customer_name_snapshot LIKE \'Cliente T22 Iter%\'')).rows[0].count, 10);
    console.log(`  Iteraciones ejecutadas: ${ITERATIONS_22} | Órdenes ganadoras en DB: ${t22OrdersInDb}`);

    const t22Pass = t22AllPass && t22OrdersInDb === ITERATIONS_22;
    results.push({ name: 'TEST 22 — Concurrencia misma clave y payload distinto (Stress x25)', pass: !!t22Pass });
    console.log(t22Pass ? '✓ TEST 22 APROBADO EXITOSAMENTE\n' : '✗ TEST 22 FALLÓ\n');

    // =========================================================================
    // TEST 23 — Dos pedidos compitiendo por la última unidad física (Stress x25)
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 23 — Dos pedidos compitiendo por la última unidad física (Stress x25)');
    console.log('Fixture: on_hand=1, reserved=0. Dos pedidos de 1 unidad simultáneos.');
    console.log('Exactamente 1 debe confirmar y 1 debe ser INSUFFICIENT_STOCK.');
    console.log('================================================================');

    const prod23 = await createTestProduct('T23');
    let t23AllPass = true;
    const ITERATIONS_23 = 25;

    for (let i = 1; i <= ITERATIONS_23; i++) {
      await masterClient.query('UPDATE stock_balances SET on_hand = 1, reserved = 0 WHERE product_id = $1', [prod23.id]);

      const payload1 = {
        customerName: `Cliente T23-1 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: crypto.randomUUID(),
        protocolChecksum: '11112222',
        lines: [{ productId: prod23.id, quantity: 1, unitPriceCents: prod23.sale_price_cents }]
      };

      const payload2 = {
        customerName: `Cliente T23-2 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: crypto.randomUUID(),
        protocolChecksum: '33334444',
        lines: [{ productId: prod23.id, quantity: 1, unitPriceCents: prod23.sale_price_cents }]
      };

      const [res1, res2] = await Promise.all([
        runOrderTx(clientA, payload1),
        runOrderTx(clientB, payload2)
      ]);

      const oneWon = (res1.ok && !res2.ok) || (!res1.ok && res2.ok);
      const failedHadStockErr = (!res1.ok && res1.error.includes('INSUFFICIENT_STOCK')) ||
                                (!res2.ok && res2.error.includes('INSUFFICIENT_STOCK'));
      const bal = (await masterClient.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod23.id])).rows[0];

      if (!oneWon || !failedHadStockErr || bal.reserved !== 1 || (bal.on_hand - bal.reserved) !== 0) {
        console.error(`  ✗ Falló iteración ${i}: res1=${JSON.stringify(res1)}, res2=${JSON.stringify(res2)}, bal=${JSON.stringify(bal)}`);
        t23AllPass = false;
        break;
      }
      const winningOrder = res1.ok ? res1.order : res2.order;
      createdOrderIds.push(winningOrder.id);
    }

    results.push({ name: 'TEST 23 — Dos pedidos compitiendo por última unidad física (Stress x25)', pass: !!t23AllPass });
    console.log(t23AllPass ? '✓ TEST 23 APROBADO EXITOSAMENTE\n' : '✗ TEST 23 FALLÓ\n');

    // =========================================================================
    // TEST 24 — Competencia por la última unidad incoming
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 24 — Competencia por la última unidad incoming (Stress x15)');
    console.log('Fixture: on_hand=0, compra proveedor=1 en estado ordered.');
    console.log('Dos pedidos simultáneos compiten por la única unidad en camino.');
    console.log('Exactamente 1 debe confirmar (incoming=1) y 1 debe ser INSUFFICIENT_STOCK.');
    console.log('================================================================');

    let t24AllPass = true;
    const ITERATIONS_24 = 15;

    for (let i = 1; i <= ITERATIONS_24; i++) {
      const prod24 = await createTestProduct(`T24_${i}`);
      const purch24 = await createTestPurchase(`Proveedor 24 Iter ${i}`, [
        { productId: prod24.id, quantity: 1, unitCostCents: prod24.costCents }
      ]);
      const purchItemId = purch24.items[0].id;

      const payload1 = {
        customerName: `Cliente T24-1 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: crypto.randomUUID(),
        protocolChecksum: 'AAAA9999',
        lines: [{ productId: prod24.id, quantity: 1, unitPriceCents: prod24.sale_price_cents }]
      };

      const payload2 = {
        customerName: `Cliente T24-2 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: crypto.randomUUID(),
        protocolChecksum: 'BBBB8888',
        lines: [{ productId: prod24.id, quantity: 1, unitPriceCents: prod24.sale_price_cents }]
      };

      const [res1, res2] = await Promise.all([
        runOrderTx(clientA, payload1),
        runOrderTx(clientB, payload2)
      ]);

      const oneWon = (res1.ok && !res2.ok) || (!res1.ok && res2.ok);
      const failedHadStockErr = (!res1.ok && res1.error.includes('INSUFFICIENT_STOCK')) ||
                                (!res2.ok && res2.error.includes('INSUFFICIENT_STOCK'));
      const incActive = parseInt((await masterClient.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE purchase_item_id = $1 AND state = \'active\' AND source_type = \'incoming\'', [purchItemId])).rows[0].coalesce, 10);

      if (!oneWon || !failedHadStockErr || incActive !== 1) {
        console.error(`  ✗ Falló iteración ${i}: res1=${JSON.stringify(res1)}, res2=${JSON.stringify(res2)}, incActive=${incActive}`);
        t24AllPass = false;
        break;
      }
      const winningOrder = res1.ok ? res1.order : res2.order;
      createdOrderIds.push(winningOrder.id);
    }

    results.push({ name: 'TEST 24 — Competencia por última unidad incoming (Stress x15)', pass: !!t24AllPass });
    console.log(t24AllPass ? '✓ TEST 24 APROBADO EXITOSAMENTE\n' : '✗ TEST 24 FALLÓ\n');

    // =========================================================================
    // TEST 25 — Pedido vs cancelación de compra proveedor
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 25 — Pedido vs cancelación de compra proveedor (Carrera Concurrente x15)');
    console.log('T1: confirm_imported_order vs T2: cancelar compra.');
    console.log('Solo estados coherentes permitidos:');
    console.log('A. Pedido gana -> reserva incoming creada, cancelación de compra RECHAZADA.');
    console.log('B. Cancelación gana -> compra cancelada, pedido INSUFFICIENT_STOCK.');
    console.log('JAMÁS pedido confirmado + compra cancelada.');
    console.log('================================================================');

    let t25AllPass = true;
    const ITERATIONS_25 = 15;

    for (let i = 1; i <= ITERATIONS_25; i++) {
      const prod25 = await createTestProduct(`T25_${i}`);
      const purch25 = await createTestPurchase(`Proveedor 25 Iter ${i}`, [
        { productId: prod25.id, quantity: 1, unitCostCents: prod25.costCents }
      ]);
      const purchId = purch25.id;

      const orderPayload = {
        customerName: `Cliente T25 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: crypto.randomUUID(),
        protocolChecksum: '55556666',
        lines: [{ productId: prod25.id, quantity: 1, unitPriceCents: prod25.sale_price_cents }]
      };

      async function runCancelTx(client) {
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [OWNER_ID]);
          await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: OWNER_ID, role: 'authenticated' })]);
          await client.query("UPDATE purchases SET state = 'cancelled' WHERE id = $1", [purchId]);
          await client.query('COMMIT');
          return { ok: true };
        } catch (err) {
          await client.query('ROLLBACK');
          return { ok: false, error: err.message };
        }
      }

      const [resOrder, resCancel] = await Promise.all([
        runOrderTx(clientA, orderPayload),
        runCancelTx(clientB)
      ]);

      const purchState = (await masterClient.query('SELECT state FROM purchases WHERE id = $1', [purchId])).rows[0].state;
      const orderCount = parseInt((await masterClient.query('SELECT count(*) FROM orders WHERE protocol_order_id = $1', [orderPayload.protocolOrderId])).rows[0].count, 10);
      const resCount = parseInt((await masterClient.query('SELECT count(*) FROM stock_reservations WHERE product_id = $1 AND state = \'active\'', [prod25.id])).rows[0].count, 10);

      const caseA = resOrder.ok && !resCancel.ok && purchState === 'ordered' && orderCount === 1 && resCount === 1;
      const caseB = !resOrder.ok && resCancel.ok && purchState === 'cancelled' && orderCount === 0 && resCount === 0;

      if (!caseA && !caseB) {
        console.error(`  ✗ Inconsistencia en iteración ${i}: resOrder=${JSON.stringify(resOrder)}, resCancel=${JSON.stringify(resCancel)}, purchState=${purchState}, orderCount=${orderCount}, resCount=${resCount}`);
        t25AllPass = false;
        break;
      }
      if (resOrder.ok) createdOrderIds.push(resOrder.order.id);
    }

    results.push({ name: 'TEST 25 — Pedido vs cancelación de compra proveedor (Stress x15)', pass: !!t25AllPass });
    console.log(t25AllPass ? '✓ TEST 25 APROBADO EXITOSAMENTE\n' : '✗ TEST 25 FALLÓ\n');

    // =========================================================================
    // TEST 26 — Pedido vs recepción del proveedor
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 26 — Pedido vs recepción del proveedor (Carrera Concurrente x15)');
    console.log('T1: confirm_imported_order vs T2: receive_purchase.');
    console.log('Sin deadlocks. El pedido debe terminar respaldado por 1 unidad física,');
    console.log('stockReadiness=ready, on_hand=1, reserved=1, sin duplicados ni pérdidas.');
    console.log('================================================================');

    let t26AllPass = true;
    const ITERATIONS_26 = 15;

    for (let i = 1; i <= ITERATIONS_26; i++) {
      const prod26 = await createTestProduct(`T26_${i}`);
      const purch26 = await createTestPurchase(`Proveedor 26 Iter ${i}`, [
        { productId: prod26.id, quantity: 1, unitCostCents: prod26.costCents }
      ]);
      const purchId = purch26.id;
      const purchItemId = purch26.items[0].id;

      const orderPayload = {
        customerName: `Cliente T26 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: crypto.randomUUID(),
        protocolChecksum: '77778888',
        lines: [{ productId: prod26.id, quantity: 1, unitPriceCents: prod26.sale_price_cents }]
      };

      async function runReceiveTx(client) {
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [OWNER_ID]);
          await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: OWNER_ID, role: 'authenticated' })]);
          const res = await client.query(
            'SELECT public.receive_purchase($1::uuid, $2::jsonb, $3::uuid) AS r',
            [purchId, JSON.stringify([{ purchaseItemId: purchItemId, receivedQuantity: 1 }]), crypto.randomUUID()]
          );
          await client.query('COMMIT');
          return { ok: true, res: res.rows[0].r };
        } catch (err) {
          await client.query('ROLLBACK');
          return { ok: false, error: err.message };
        }
      }

      const [resOrder, resReceive] = await Promise.all([
        runOrderTx(clientA, orderPayload),
        runReceiveTx(clientB)
      ]);

      if (resOrder.ok) createdOrderIds.push(resOrder.order.id);

      if (!resOrder.ok || !resReceive.ok) {
        console.error(`  ✗ Error en iteración ${i}: resOrder=${JSON.stringify(resOrder)}, resReceive=${JSON.stringify(resReceive)}`);
        t26AllPass = false;
        break;
      }

      // Inspección de coherencia final
      const orderDb = (await masterClient.query('SELECT private.order_payload($1, true) ->> \'stockReadiness\' AS readiness FROM orders WHERE id = $1', [resOrder.order.id])).rows[0];
      const bal = (await masterClient.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod26.id])).rows[0];
      const resPhysical = parseInt((await masterClient.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'active\' AND source_type = \'physical\'', [resOrder.order.id])).rows[0].coalesce, 10);
      const resIncoming = parseInt((await masterClient.query('SELECT coalesce(sum(quantity), 0) FROM stock_reservations WHERE order_id = $1 AND state = \'active\' AND source_type = \'incoming\'', [resOrder.order.id])).rows[0].coalesce, 10);

      const isCoherent = orderDb.readiness === 'ready' && bal.on_hand === 1 && bal.reserved === 1 && resPhysical === 1 && resIncoming === 0;
      if (!isCoherent) {
        console.error(`  ✗ Inconsistencia en iteración ${i}: readiness=${orderDb.readiness}, bal=${JSON.stringify(bal)}, physical=${resPhysical}, incoming=${resIncoming}`);
        t26AllPass = false;
        break;
      }
    }

    results.push({ name: 'TEST 26 — Pedido vs recepción del proveedor (Stress x15)', pass: !!t26AllPass });
    console.log(t26AllPass ? '✓ TEST 26 APROBADO EXITOSAMENTE\n' : '✗ TEST 26 FALLÓ\n');

    // =========================================================================
    // TEST 27 — Entrega vs cancelación simultánea
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 27 — Entrega vs cancelación simultánea (Stress x15)');
    console.log('T1: mark_delivered vs T2: cancel.');
    console.log('Exactamente una transición debe ganar.');
    console.log('Si gana entrega: on_hand decrece en 1, 1 movimiento sale, reserva consumed.');
    console.log('Si gana cancelación: on_hand intacto, 0 movimientos sale, reserva released.');
    console.log('================================================================');

    let t27AllPass = true;
    const ITERATIONS_27 = 15;

    for (let i = 1; i <= ITERATIONS_27; i++) {
      const prod27 = await createTestProduct(`T27_${i}`);
      await masterClient.query('UPDATE stock_balances SET on_hand = 5, reserved = 0 WHERE product_id = $1', [prod27.id]);

      const orderPayload = {
        customerName: `Cliente T27 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: crypto.randomUUID(),
        protocolChecksum: '99990000',
        lines: [{ productId: prod27.id, quantity: 1, unitPriceCents: prod27.sale_price_cents }]
      };

      const orderRes = (await masterClient.query('SELECT confirm_imported_order($1::jsonb) AS o', [JSON.stringify(orderPayload)])).rows[0].o;
      createdOrderIds.push(orderRes.id);

      async function runTransitionTx(client, action) {
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [OWNER_ID]);
          await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: OWNER_ID, role: 'authenticated' })]);
          const res = await client.query('SELECT transition_order($1, $2) AS t', [orderRes.id, action]);
          await client.query('COMMIT');
          return { ok: true, action };
        } catch (err) {
          await client.query('ROLLBACK');
          return { ok: false, action, error: err.message };
        }
      }

      const [resDeliver, resCancel] = await Promise.all([
        runTransitionTx(clientA, 'mark_delivered'),
        runTransitionTx(clientB, 'cancel')
      ]);

      const oneWon = (resDeliver.ok && !resCancel.ok) || (!resDeliver.ok && resCancel.ok);
      const loserFailedProperly = (!resDeliver.ok && resDeliver.error.includes('INVALID_TRANSITION')) ||
                                  (!resCancel.ok && resCancel.error.includes('INVALID_TRANSITION'));

      const dbOrder = (await masterClient.query('SELECT fulfillment_state, order_state FROM orders WHERE id = $1', [orderRes.id])).rows[0];
      const bal = (await masterClient.query('SELECT on_hand, reserved FROM stock_balances WHERE product_id = $1', [prod27.id])).rows[0];
      const saleMovs = parseInt((await masterClient.query('SELECT count(*) FROM stock_movements WHERE order_id = $1 AND kind = \'sale\'', [orderRes.id])).rows[0].count, 10);

      let consistent = false;
      if (resDeliver.ok) {
        // Entrega ganó
        consistent = dbOrder.fulfillment_state === 'delivered' && bal.on_hand === 4 && bal.reserved === 0 && saleMovs === 1;
      } else {
        // Cancelación ganó
        consistent = dbOrder.order_state === 'cancelled' && bal.on_hand === 5 && bal.reserved === 0 && saleMovs === 0;
      }

      if (!oneWon || !loserFailedProperly || !consistent) {
        console.error(`  ✗ Inconsistencia en iteración ${i}: resDeliver=${JSON.stringify(resDeliver)}, resCancel=${JSON.stringify(resCancel)}, dbOrder=${JSON.stringify(dbOrder)}, bal=${JSON.stringify(bal)}`);
        t27AllPass = false;
        break;
      }
    }

    results.push({ name: 'TEST 27 — Entrega vs cancelación simultánea (Stress x15)', pass: !!t27AllPass });
    console.log(t27AllPass ? '✓ TEST 27 APROBADO EXITOSAMENTE\n' : '✗ TEST 27 FALLÓ\n');

    // =========================================================================
    // TEST 28 — Cobro simultáneo
    // =========================================================================
    console.log('================================================================');
    console.log('TEST 28 — Cobro simultáneo (Stress x15)');
    console.log('Dos llamadas concurrentes a mark_paid sobre el mismo pedido.');
    console.log('Sin duplicaciones, payment_state=paid, sin error 500.');
    console.log('================================================================');

    let t28AllPass = true;
    const ITERATIONS_28 = 15;

    for (let i = 1; i <= ITERATIONS_28; i++) {
      const prod28 = await createTestProduct(`T28_${i}`);
      await masterClient.query('UPDATE stock_balances SET on_hand = 5, reserved = 0 WHERE product_id = $1', [prod28.id]);

      const orderPayload = {
        customerName: `Cliente T28 Iter ${i}`,
        deliveryMethod: 'pickup',
        paymentMethod: 'cash',
        shippingFeeCents: 0,
        protocolOrderId: crypto.randomUUID(),
        protocolChecksum: '55667788',
        lines: [{ productId: prod28.id, quantity: 1, unitPriceCents: prod28.sale_price_cents }]
      };

      const orderRes = (await masterClient.query('SELECT confirm_imported_order($1::jsonb) AS o', [JSON.stringify(orderPayload)])).rows[0].o;
      createdOrderIds.push(orderRes.id);

      async function runMarkPaidTx(client) {
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [OWNER_ID]);
          await client.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: OWNER_ID, role: 'authenticated' })]);
          const res = await client.query("SELECT transition_order($1, 'mark_paid') AS t", [orderRes.id]);
          await client.query('COMMIT');
          return { ok: true };
        } catch (err) {
          await client.query('ROLLBACK');
          return { ok: false, error: err.message };
        }
      }

      const [res1, res2] = await Promise.all([
        runMarkPaidTx(clientA),
        runMarkPaidTx(clientB)
      ]);

      const oneWon = (res1.ok && !res2.ok) || (!res1.ok && res2.ok);
      const loserErrorOk = (!res1.ok && res1.error.includes('INVALID_TRANSITION')) ||
                           (!res2.ok && res2.error.includes('INVALID_TRANSITION'));

      const dbOrder = (await masterClient.query('SELECT payment_state, paid_at FROM orders WHERE id = $1', [orderRes.id])).rows[0];

      if (!oneWon || !loserErrorOk || dbOrder.payment_state !== 'paid' || !dbOrder.paid_at) {
        console.error(`  ✗ Error en iteración ${i}: res1=${JSON.stringify(res1)}, res2=${JSON.stringify(res2)}, dbOrder=${JSON.stringify(dbOrder)}`);
        t28AllPass = false;
        break;
      }
    }

    results.push({ name: 'TEST 28 — Cobro simultáneo (Stress x15)', pass: !!t28AllPass });
    console.log(t28AllPass ? '✓ TEST 28 APROBADO EXITOSAMENTE\n' : '✗ TEST 28 FALLÓ\n');

  } finally {
    console.log('--- TEARDOWN: Limpieza de datos de prueba creados durante la serie 4 ---');
    await setAuth(masterClient, OWNER_ID);

    if (createdOrderIds.length > 0) {
      await masterClient.query('DELETE FROM stock_reservations WHERE order_id = ANY($1)', [createdOrderIds]);
      await masterClient.query('DELETE FROM stock_movements WHERE order_id = ANY($1)', [createdOrderIds]);
      await masterClient.query('DELETE FROM order_items WHERE order_id = ANY($1)', [createdOrderIds]);
      await masterClient.query('DELETE FROM orders WHERE id = ANY($1)', [createdOrderIds]);
      console.log(`  ✓ Limpiadas ${createdOrderIds.length} órdenes y sus reservas/movimientos`);
    }

    if (createdPurchaseIds.length > 0) {
      await masterClient.query('DELETE FROM purchase_receipts WHERE purchase_id = ANY($1)', [createdPurchaseIds]);
      await masterClient.query('DELETE FROM stock_movements WHERE purchase_id = ANY($1)', [createdPurchaseIds]);
      await masterClient.query('DELETE FROM stock_reservations WHERE purchase_item_id IN (SELECT id FROM purchase_items WHERE purchase_id = ANY($1))', [createdPurchaseIds]);
      await masterClient.query('DELETE FROM purchase_items WHERE purchase_id = ANY($1)', [createdPurchaseIds]);
      await masterClient.query('DELETE FROM purchases WHERE id = ANY($1)', [createdPurchaseIds]);
      console.log(`  ✓ Limpiadas ${createdPurchaseIds.length} compras a proveedores`);
    }

    if (createdProductIds.length > 0) {
      await masterClient.query('DELETE FROM stock_reservations WHERE product_id = ANY($1)', [createdProductIds]);
      await masterClient.query('DELETE FROM order_items WHERE product_id = ANY($1)', [createdProductIds]);
      await masterClient.query('DELETE FROM stock_movements WHERE product_id = ANY($1)', [createdProductIds]);
      await masterClient.query('DELETE FROM stock_balances WHERE product_id = ANY($1)', [createdProductIds]);
      await masterClient.query('DELETE FROM product_financials WHERE product_id = ANY($1)', [createdProductIds]);
      await masterClient.query('DELETE FROM products WHERE id = ANY($1)', [createdProductIds]);
      console.log(`  ✓ Limpiados ${createdProductIds.length} productos de prueba`);
    }

    await masterClient.end();
    await clientA.end();
    await clientB.end();
  }

  // Resumen final
  console.log('================================================================');
  console.log('RESUMEN DE RESULTADOS — SERIE 4 (CONCURRENCIA Y ATOMICIDAD)');
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
  console.error('Error fatal ejecutando suite 4:', err);
  process.exit(1);
});
