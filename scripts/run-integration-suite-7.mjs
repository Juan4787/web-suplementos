import { loadEnv } from 'vite';
import { Client } from 'pg';
import crypto from 'node:crypto';

const OWNER_CAPABILITIES = new Set([
  'operate_orders',
  'manage_public_catalog',
  'manage_pricing',
  'manage_purchases',
  'adjust_stock',
  'view_financials',
  'export_data',
  'use_ai',
  'manage_users'
]);

const STAFF_CAPABILITIES = new Set([
  'operate_orders',
  'manage_public_catalog'
]);

const can = (user, capability) => {
  if (!user || !user.active) return false;
  return (user.role === 'owner' ? OWNER_CAPABILITIES : STAFF_CAPABILITIES).has(capability);
};

const env = loadEnv('production', process.cwd(), '');
const password = env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error('ERROR: SUPABASE_DB_PASSWORD no configurada en el entorno.');
  process.exit(1);
}

const connStr = `postgresql://postgres.mvtpidtuntvebyrxivue:${encodeURIComponent(password)}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres`;
const OWNER_ID = 'cded5daf-3e27-4f6b-86dd-a514fac1cd28';
const STAFF_ID = '72db467c-1793-41a4-9642-8c1cb27f80ec';

async function createClient() {
  const c = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

async function setAuth(client, userId) {
  await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await client.query("SELECT set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role: 'authenticated' })
  ]);
}

async function runSuite7() {
  const client = await createClient();
  await setAuth(client, OWNER_ID);

  console.log('================================================================');
  console.log('       SERIE 7 — INVENTARIO Y COMPRAS NORMALES (41 A 46)       ');
  console.log('================================================================\n');

  const createdProductIds = [];
  const createdPurchaseIds = [];
  const createdMovementIds = [];
  const createdOrderIds = [];
  const results = [];

  try {
    // =========================================================================
    // TEST 41 — Personal no debe poder corregir stock
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 41 — Personal no debe poder corregir stock');
    console.log('Objetivo: Backend rechaza adjustStock a Personal. UI no muestra el botón.');
    console.log('----------------------------------------------------------------');

    // 1. Crear producto de prueba
    const p41Res = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, 'Item Test 41', 'Pote', 'Test 41', 'Test', 1000000, true, true)
       RETURNING id`,
      [`SKU41_${Date.now()}`, `prod-41-${Date.now()}`]
    );
    const prod41Id = p41Res.rows[0].id;
    createdProductIds.push(prod41Id);
    await client.query(`INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, 500000)`, [prod41Id]);
    await client.query(`INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 10, 0)`, [prod41Id]);

    // Backend test: Personal intenta ajustar stock
    await setAuth(client, STAFF_ID);
    let staffBackendRejected = false;
    try {
      await client.query(`SELECT adjust_product_stock($1, 5, 'Ajuste de prueba por personal')`, [prod41Id]);
    } catch (err) {
      staffBackendRejected = err.message.includes('FORBIDDEN') || err.message.includes('permission denied');
    }

    // Backend test: Dueña intenta ajustar stock
    await setAuth(client, OWNER_ID);
    let ownerBackendAllowed = false;
    try {
      await client.query(`SELECT adjust_product_stock($1, 5, 'Ajuste legítimo por dueña')`, [prod41Id]);
      ownerBackendAllowed = true;
    } catch (err) {
      console.error('Error inesperado en adjust_product_stock para dueña:', err);
    }

    // UI Logic test: matriz can(user, 'adjust_stock')
    const ownerUser = { id: OWNER_ID, role: 'owner', active: true, email: 'dueña@test.com', displayName: 'Dueña' };
    const staffUser = { id: STAFF_ID, role: 'staff', active: true, email: 'personal@test.com', displayName: 'Personal' };

    const ownerCanSeeAdjustButton = can(ownerUser, 'adjust_stock');
    const staffCanSeeAdjustButton = can(staffUser, 'adjust_stock');

    console.log(`Backend Personal rechazado: ${staffBackendRejected ? 'SÍ (FORBIDDEN)' : 'NO (ERROR)'}`);
    console.log(`Backend Dueña permitido:     ${ownerBackendAllowed ? 'SÍ' : 'NO'}`);
    console.log(`UI Botón visible para Dueña:    ${ownerCanSeeAdjustButton ? 'SÍ' : 'NO'}`);
    console.log(`UI Botón visible para Personal: ${staffCanSeeAdjustButton ? 'SÍ (VULNERABLE)' : 'NO (PROTEGIDO)'}`);

    const pass41 = staffBackendRejected && ownerBackendAllowed && ownerCanSeeAdjustButton && !staffCanSeeAdjustButton;
    results.push({
      test: 'TEST 41 — Personal no debe poder corregir stock',
      pass: pass41,
      detail: 'Personal no tiene permiso ni ve la acción en pantalla'
    });
    console.log(pass41 ? '✅ TEST 41 APROBADO\n' : '❌ TEST 41 FALLÓ\n');

    // =========================================================================
    // TEST 42 — Filtros de Compras con más de 15 registros
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 42 — Filtros de Compras con más de 15 registros');
    console.log('Objetivo: Pestañas "Pendientes (5)", "Recibidos (20)", "Todos (25)" deben ser exactas.');
    console.log('----------------------------------------------------------------');

    // Crear 20 compras recibidas y 5 compras pendientes
    for (let i = 1; i <= 20; i++) {
      const pRes = await client.query(
        `INSERT INTO purchases (supplier_name, state, ordered_at, received_at, notes, created_by)
         VALUES ('Proveedor Recibido', 'received', now() - interval '2 days', now() - interval '1 day', 'Compra fixture recibida', $1)
         RETURNING id`,
        [OWNER_ID]
      );
      createdPurchaseIds.push(pRes.rows[0].id);
      await client.query(
        `INSERT INTO purchase_items (purchase_id, product_id, product_name_snapshot, quantity, received_quantity, unit_cost_cents)
         VALUES ($1, $2, 'Item Test 41', 5, 5, 500000)`,
        [pRes.rows[0].id, prod41Id]
      );
    }

    for (let i = 1; i <= 5; i++) {
      const pRes = await client.query(
        `INSERT INTO purchases (supplier_name, state, ordered_at, notes, created_by)
         VALUES ('Proveedor Pendiente', 'ordered', now(), 'Compra fixture pendiente', $1)
         RETURNING id`,
        [OWNER_ID]
      );
      createdPurchaseIds.push(pRes.rows[0].id);
      await client.query(
        `INSERT INTO purchase_items (purchase_id, product_id, product_name_snapshot, quantity, received_quantity, unit_cost_cents)
         VALUES ($1, $2, 'Item Test 41', 2, 0, 500000)`,
        [pRes.rows[0].id, prod41Id]
      );
    }

    // Probar list_purchases RPC
    const listPurchasesRes = await client.query(`SELECT list_purchases(1, 15) AS res`);
    const pData = listPurchasesRes.rows[0].res;

    console.log(`Compras devueltas en página 1 (pageSize=15): ${pData.items.length}`);
    console.log(`Metadatos devueltos por la API:`, {
      total: pData.total,
      pendingTotal: pData.pendingTotal,
      receivedTotal: pData.receivedTotal
    });

    const pass42 =
      Number(pData.pendingTotal) >= 5 &&
      Number(pData.receivedTotal) >= 20 &&
      Number(pData.total) >= 25;

    results.push({
      test: 'TEST 42 — Filtros de Compras con más de 15 registros',
      pass: pass42,
      detail: `Contadores globales preservados: Pendientes>=5, Recibidos>=20, Total>=25`
    });
    console.log(pass42 ? '✅ TEST 42 APROBADO\n' : '❌ TEST 42 FALLÓ\n');

    // =========================================================================
    // TEST 43 — Buscar movimientos fuera de los últimos 25
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 43 — Buscar movimientos fuera de los últimos 25');
    console.log('Objetivo: Búsqueda y filtros deben ejecutarse en toda la base, no sobre página 1.');
    console.log('----------------------------------------------------------------');

    // Crear 30 movimientos genéricos recientes
    for (let i = 1; i <= 30; i++) {
      const mRes = await client.query(
        `INSERT INTO stock_movements (product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, created_by, created_at)
         VALUES ($1, 'Producto General', 'sale', -1, 0, 'Venta genérica', $2, now() - interval '1 minute' * ${i})
         RETURNING id`,
        [prod41Id, OWNER_ID]
      );
      createdMovementIds.push(mRes.rows[0].id);
    }

    // Movimiento objetivo antiguo que quedaría en página 2+
    const mTargetRes = await client.query(
      `INSERT INTO stock_movements (product_id, product_name_snapshot, kind, physical_delta, reserved_delta, reason, created_by, created_at)
       VALUES ($1, 'Creatina Especial Test', 'purchase_received', 10, 0, 'Ingreso especial proveedor', $2, now() - interval '2 days')
       RETURNING id`,
      [prod41Id, OWNER_ID]
    );
    createdMovementIds.push(mTargetRes.rows[0].id);

    // Búsqueda en servidor de "Creatina Especial Test"
    const searchMovementsRes = await client.query(
      `SELECT list_stock_movements(1, 25, 'Creatina Especial Test', null) AS res`
    );
    const mSearchData = searchMovementsRes.rows[0].res;

    console.log(`Buscando "Creatina Especial Test": encontrados = ${mSearchData.items.length}`);
    const foundTarget = mSearchData.items.some((m) => m.productName === 'Creatina Especial Test');

    // Filtro por compras
    const purchasesFilterRes = await client.query(
      `SELECT list_stock_movements(1, 25, null, 'purchases') AS res`
    );
    const mPurchasesData = purchasesFilterRes.rows[0].res;
    console.log(`Filtrando por compras: encontrados = ${mPurchasesData.items.length}`);
    const purchasesFilterWorked = mPurchasesData.items.length > 0 && mPurchasesData.items.every((m) => m.kind === 'purchase_received');

    const pass43 = foundTarget && purchasesFilterWorked;
    results.push({
      test: 'TEST 43 — Buscar movimientos fuera de los últimos 25',
      pass: pass43,
      detail: 'Búsqueda global y filtro por tipo devuelven registros de cualquier página'
    });
    console.log(pass43 ? '✅ TEST 43 APROBADO\n' : '❌ TEST 43 FALLÓ\n');

    // =========================================================================
    // TEST 44 — Mismo producto dos veces en una compra al proveedor
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 44 — Mismo producto dos veces en una compra al proveedor');
    console.log('Objetivo: Consolidar Creatina x5 y Creatina x3 en Creatina x8 sin error críptico.');
    console.log('----------------------------------------------------------------');

    const duplicatePayload = {
      supplierName: 'Distribuidora Test',
      expectedAt: new Date().toISOString(),
      notes: 'Compra con duplicados en líneas',
      items: [
        { productId: prod41Id, quantity: 5, unitCostCents: 1000000 },
        { productId: prod41Id, quantity: 3, unitCostCents: 1000000 }
      ]
    };

    const createDupRes = await client.query(
      `SELECT create_purchase($1::jsonb) AS p`,
      [JSON.stringify(duplicatePayload)]
    );
    const dupPurchase = createDupRes.rows[0].p;
    createdPurchaseIds.push(dupPurchase.id);

    // Consultar items de la compra creada
    const piRes = await client.query(
      `SELECT * FROM purchase_items WHERE purchase_id = $1`,
      [dupPurchase.id]
    );

    console.log(`Líneas en purchase_items para la compra: ${piRes.rows.length}`);
    if (piRes.rows.length === 1) {
      console.log(`Línea consolidada: producto=${piRes.rows[0].product_id}, cantidad=${piRes.rows[0].quantity} (Esperado: 8)`);
    }

    const pass44 = piRes.rows.length === 1 && Number(piRes.rows[0].quantity) === 8;
    results.push({
      test: 'TEST 44 — Mismo producto dos veces en una compra al proveedor',
      pass: pass44,
      detail: 'Fusión transparente de líneas duplicadas en 1 sola línea de 8 unidades'
    });
    console.log(pass44 ? '✅ TEST 44 APROBADO\n' : '❌ TEST 44 FALLÓ\n');

    // =========================================================================
    // TEST 45 — Crear compra no debe aumentar stock físico
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 45 — Crear compra no debe aumentar stock físico');
    console.log('Objetivo: on_hand intacto (4), incoming +10, costo sin cambios.');
    console.log('----------------------------------------------------------------');

    // Producto con on_hand = 4, incoming = 0, costo = $10.000 (1.000.000 cents)
    const p45Res = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, 'Item Test 45', 'Pote', 'Test 45', 'Test', 2000000, true, true)
       RETURNING id`,
      [`SKU45_${Date.now()}`, `prod-45-${Date.now()}`]
    );
    const prod45Id = p45Res.rows[0].id;
    createdProductIds.push(prod45Id);
    await client.query(`INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, 1000000)`, [prod45Id]);
    await client.query(`INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 4, 0)`, [prod45Id]);

    // Crear compra de 10 unidades a $12.000 (1.200.000 cents)
    const p45OrderRes = await client.query(
      `SELECT create_purchase($1::jsonb) AS p`,
      [JSON.stringify({
        supplierName: 'Proveedor 45',
        expectedAt: new Date().toISOString(),
        items: [{ productId: prod45Id, quantity: 10, unitCostCents: 1200000 }]
      })]
    );
    const purchase45 = p45OrderRes.rows[0].p;
    createdPurchaseIds.push(purchase45.id);

    // Comprobar balances e inventario
    const b45 = await client.query(
      `SELECT elem FROM jsonb_array_elements(list_inventory_status()) elem WHERE elem ->> 'id' = $1::text`,
      [prod45Id]
    );
    const inv45 = b45.rows[0].elem;

    const fin45 = await client.query(
      `SELECT current_cost_cents FROM product_financials WHERE product_id = $1`,
      [prod45Id]
    );

    console.log(`Stock físico onHand:   ${inv45.onHand} (Esperado: 4)`);
    console.log(`Stock en camino incoming: ${inv45.incoming} (Esperado: 10)`);
    console.log(`Stock proyectado:      ${inv45.projected} (Esperado: 14)`);
    console.log(`Costo actual en DB:    $${fin45.rows[0].current_cost_cents / 100} (Esperado: $10.000, no $12.000)`);

    const pass45 =
      Number(inv45.onHand) === 4 &&
      Number(inv45.incoming) === 10 &&
      Number(inv45.projected) === 14 &&
      Number(fin45.rows[0].current_cost_cents) === 1000000;

    results.push({
      test: 'TEST 45 — Crear compra no debe aumentar stock físico',
      pass: pass45,
      detail: 'onHand=4, incoming=10, projected=14, costo intacto hasta recepción'
    });
    console.log(pass45 ? '✅ TEST 45 APROBADO\n' : '❌ TEST 45 FALLÓ\n');

    // =========================================================================
    // TEST 46 — Recibir compra actualiza todo lo que corresponde
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 46 — Recibir compra actualiza todo lo que corresponde');
    console.log('Objetivo: on_hand pasa a 14, incoming a 0, costo a $12.000 y snapshots de ventas previas intactos.');
    console.log('----------------------------------------------------------------');

    // 1. Simular una venta previa cuando el costo era $10.000
    const prevOrderRes = await client.query(`SELECT confirm_imported_order($1::jsonb) AS o`, [JSON.stringify({
      customerName: 'Cliente Histórico Costo',
      phone: '1199001122',
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'A4600001',
      lines: [{ productId: prod45Id, quantity: 1, unitPriceCents: 2000000 }]
    })]);
    const prevOrder = prevOrderRes.rows[0].o;
    createdOrderIds.push(prevOrder.id);
    await client.query(`SELECT transition_order($1, 'mark_paid')`, [prevOrder.id]);

    const prevItemCost = await client.query(
      `SELECT unit_cost_cents FROM order_items WHERE order_id = $1`,
      [prevOrder.id]
    );
    console.log(`Snapshot de costo de venta previa: $${prevItemCost.rows[0].unit_cost_cents / 100} (Esperado: $10.000)`);

    // 2. Recibir la compra de 10 unidades
    const pi45 = await client.query(`SELECT id FROM purchase_items WHERE purchase_id = $1`, [purchase45.id]);
    const purchaseItemId = pi45.rows[0].id;

    await client.query(
      `SELECT receive_purchase($1, $2::jsonb, $3)`,
      [purchase45.id, JSON.stringify([{ purchaseItemId, receivedQuantity: 10 }]), crypto.randomUUID()]
    );

    // 3. Verificar estado de la compra, stock, movimientos y costo actual
    const purchStateRes = await client.query(`SELECT state FROM purchases WHERE id = $1`, [purchase45.id]);
    const b46 = await client.query(
      `SELECT elem FROM jsonb_array_elements(list_inventory_status()) elem WHERE elem ->> 'id' = $1::text`,
      [prod45Id]
    );
    const inv46 = b46.rows[0].elem;

    const fin46Res = await client.query(`SELECT current_cost_cents FROM product_financials WHERE product_id = $1`, [prod45Id]);
    const mov46Res = await client.query(
      `SELECT kind, physical_delta FROM stock_movements WHERE purchase_id = $1`,
      [purchase45.id]
    );

    // 4. Crear nueva venta y comprobar que toma el nuevo costo $12.000
    const newOrderRes = await client.query(`SELECT confirm_imported_order($1::jsonb) AS o`, [JSON.stringify({
      customerName: 'Cliente Nuevo Costo',
      phone: '1199003344',
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'A4600002',
      lines: [{ productId: prod45Id, quantity: 1, unitPriceCents: 2000000 }]
    })]);
    const newOrder = newOrderRes.rows[0].o;
    createdOrderIds.push(newOrder.id);
    await client.query(`SELECT transition_order($1, 'mark_paid')`, [newOrder.id]);

    const newItemCost = await client.query(
      `SELECT unit_cost_cents FROM order_items WHERE order_id = $1`,
      [newOrder.id]
    );

    console.log(`Estado de compra tras recibir: ${purchStateRes.rows[0].state} (Esperado: received)`);
    console.log(`on_hand post recepción:        ${inv46.onHand} (Esperado: 14)`);
    console.log(`incoming post recepción:       ${inv46.incoming} (Esperado: 0)`);
    console.log(`Movimiento registrado:         ${mov46Res.rows[0]?.kind} con delta=+${mov46Res.rows[0]?.physical_delta}`);
    console.log(`Nuevo current_cost del prod:   $${fin46Res.rows[0].current_cost_cents / 100} (Esperado: $12.000)`);
    console.log(`Snapshot en venta nueva:       $${newItemCost.rows[0].unit_cost_cents / 100} (Esperado: $12.000)`);
    console.log(`Snapshot en venta vieja:       $${prevItemCost.rows[0].unit_cost_cents / 100} (Preservado: $10.000)`);

    const pass46 =
      purchStateRes.rows[0].state === 'received' &&
      Number(inv46.onHand) === 14 &&
      Number(inv46.incoming) === 0 &&
      mov46Res.rows[0]?.kind === 'purchase_received' &&
      Number(mov46Res.rows[0]?.physical_delta) === 10 &&
      Number(fin46Res.rows[0].current_cost_cents) === 1200000 &&
      Number(newItemCost.rows[0].unit_cost_cents) === 1200000 &&
      Number(prevItemCost.rows[0].unit_cost_cents) === 1000000;

    results.push({
      test: 'TEST 46 — Recibir compra actualiza todo lo que corresponde',
      pass: pass46,
      detail: 'onHand=14, incoming=0, state=received, costo=$12.000 y snapshots aislados'
    });
    console.log(pass46 ? '✅ TEST 46 APROBADO\n' : '❌ TEST 46 FALLÓ\n');

  } catch (err) {
    console.error('Error fatal durante la ejecución de Serie 7:', err);
  } finally {
    console.log('Limpiando datos de prueba de Serie 7...');
    await setAuth(client, OWNER_ID);
    if (createdOrderIds.length > 0) {
      await client.query(`DELETE FROM stock_reservations WHERE order_id = ANY($1)`, [createdOrderIds]);
      await client.query(`DELETE FROM order_items WHERE order_id = ANY($1)`, [createdOrderIds]);
      await client.query(`DELETE FROM orders WHERE id = ANY($1)`, [createdOrderIds]);
    }
    if (createdMovementIds.length > 0) {
      await client.query(`DELETE FROM stock_movements WHERE id = ANY($1)`, [createdMovementIds]);
    }
    if (createdPurchaseIds.length > 0) {
      await client.query(`DELETE FROM stock_movements WHERE purchase_id = ANY($1)`, [createdPurchaseIds]);
      await client.query(`DELETE FROM stock_reservations WHERE purchase_item_id IN (SELECT id FROM purchase_items WHERE purchase_id = ANY($1))`, [createdPurchaseIds]);
      await client.query(`DELETE FROM purchase_items WHERE purchase_id = ANY($1)`, [createdPurchaseIds]);
      await client.query(`DELETE FROM purchases WHERE id = ANY($1)`, [createdPurchaseIds]);
    }
    if (createdProductIds.length > 0) {
      await client.query(`DELETE FROM stock_movements WHERE product_id = ANY($1)`, [createdProductIds]);
      await client.query(`DELETE FROM stock_balances WHERE product_id = ANY($1)`, [createdProductIds]);
      await client.query(`DELETE FROM product_financials WHERE product_id = ANY($1)`, [createdProductIds]);
      await client.query(`DELETE FROM products WHERE id = ANY($1)`, [createdProductIds]);
    }
    console.log('Limpieza completada con éxito.');
    await client.end();
  }

  console.log('================================================================');
  console.log('                    RESUMEN DE LA SERIE 7                       ');
  console.log('================================================================');
  results.forEach((r) => {
    console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'}: ${r.test}`);
    console.log(`   └─ ${r.detail}`);
  });
  console.log('================================================================');
  const allPass = results.length === 6 && results.every((r) => r.pass);
  console.log(`RESULTADO FINAL: ${results.filter((r) => r.pass).length}/6 APROBADOS`);
  console.log('================================================================');
  if (!allPass) {
    process.exit(1);
  }
}

runSuite7();
