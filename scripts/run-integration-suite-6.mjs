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

// Emula la lógica corregida de CustomersPage.tsx para el detalle
function computeAuthoritativeCustomerDetail(customer, recentOrdersSlice) {
  const customerOrders = recentOrdersSlice.filter(
    (o) =>
      o.customerId === customer.id ||
      (customer.phone && o.customerPhone && o.customerPhone === customer.phone) ||
      (o.customerName && customer.name && o.customerName.trim().toLowerCase() === customer.name.trim().toLowerCase())
  );

  const pendingInRecent = customerOrders.filter((o) => o.paymentState === 'pending' && o.orderState !== 'cancelled');

  return {
    orderCount: customer.orderCount,
    totalPaidCents: customer.totalPaidCents ?? 0,
    hasPending: (customer.pendingOrderCount ?? 0) > 0,
    pendingOrderCount: customer.pendingOrderCount ?? pendingInRecent.length,
    pendingTotalCents: customer.pendingTotalCents ?? pendingInRecent.reduce((sum, o) => sum + o.totalCents, 0)
  };
}

// Emula la lógica antigua que fallaba
function computeLegacyCustomerDetail(customer, recentOrdersSlice) {
  const customerOrders = recentOrdersSlice.filter(
    (o) =>
      o.customerId === customer.id ||
      (customer.phone && o.customerPhone && o.customerPhone === customer.phone) ||
      (o.customerName && customer.name && o.customerName.trim().toLowerCase() === customer.name.trim().toLowerCase())
  );

  const pendingInRecent = customerOrders.filter((o) => o.paymentState === 'pending' && o.orderState !== 'cancelled');
  const paidInRecent = customerOrders.filter((o) => o.paymentState === 'paid' && o.orderState !== 'cancelled');

  const totalPaidCents =
    customerOrders.length > 0
      ? paidInRecent.reduce((sum, o) => sum + o.totalCents, 0)
      : customer.totalPaidCents ?? 0;

  const orderCount =
    customerOrders.length > 0
      ? customerOrders.filter((o) => o.orderState !== 'cancelled').length
      : customer.orderCount || 0;

  const hasPending = pendingInRecent.length > 0;

  return {
    orderCount,
    totalPaidCents,
    hasPending,
    pendingOrderCount: pendingInRecent.length
  };
}

async function runSuite6() {
  const client = await createClient();
  await setAuth(client, OWNER_ID);

  console.log('================================================================');
  console.log('       SERIE 6 — CLIENTES REALES (TESTS 35 A 40)               ');
  console.log('================================================================\n');

  const createdCustomerIds = [];
  const createdOrderIds = [];
  const createdProductIds = [];
  const results = [];

  // Helper para crear producto
  const prodRes = await client.query(
    `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
     VALUES ($1, $2, 'Item Suite 6', 'Pote 300g', 'Item prueba serie 6', 'Test', 3000000, true, true)
     RETURNING id`,
    [`S6SKU${Date.now().toString().slice(-4)}`, `prod-s6-${Date.now()}`]
  );
  const productId = prodRes.rows[0].id;
  createdProductIds.push(productId);

  await client.query(`INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, 1000000)`, [productId]);
  await client.query(`INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 500, 0)`, [productId]);

  try {
    // =========================================================================
    // TEST 35 — Buscar un cliente que está en otra página
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 35 — Buscar un cliente que está en otra página');
    console.log('Objetivo: Validar que el buscador ejecute sobre toda la base, no solo en los 30 de la página 1.');
    console.log('----------------------------------------------------------------');

    const baseTime = Date.now();
    // Crear 34 clientes que queden en página 1
    for (let i = 1; i <= 34; i++) {
      const pad = String(i).padStart(2, '0');
      const cRes = await client.query(
        `INSERT INTO customers (name, phone, first_order_at, last_order_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          `Cliente Paginado ${pad}`,
          `117700${pad}`,
          new Date(baseTime + i * 1000).toISOString(),
          new Date(baseTime + i * 1000).toISOString()
        ]
      );
      createdCustomerIds.push(cRes.rows[0].id);
    }

    // Cliente #35: "Marcelo Buscado", fecha más antigua para quedar en página 2
    const c35Res = await client.query(
      `INSERT INTO customers (name, phone, first_order_at, last_order_at)
       VALUES ('Marcelo Buscado', '1199887766', $1, $2) RETURNING id`,
      [new Date(baseTime - 50000).toISOString(), new Date(baseTime - 50000).toISOString()]
    );
    const marceloId = c35Res.rows[0].id;
    createdCustomerIds.push(marceloId);

    // 1. Sin búsqueda, página 1 (debe traer 30 clientes y Marcelo no debe estar)
    const page1NoSearch = (await client.query(`SELECT list_customers(1, 30, null) AS c`)).rows[0].c;
    const marceloInPage1 = page1NoSearch.items.some((c) => c.id === marceloId);

    // 2. Con búsqueda en servidor "Marcelo Buscado" desde página 1
    const searchRes = (await client.query(`SELECT list_customers(1, 30, 'Marcelo Buscado') AS c`)).rows[0].c;
    const foundMarcelo = searchRes.items.find((c) => c.id === marceloId);

    console.log(`Clientes totales en página 1 sin filtro: ${page1NoSearch.items.length}`);
    console.log(`¿Marcelo está en los 30 iniciales de pág 1? ${marceloInPage1 ? 'SÍ' : 'NO (está en página 2)'}`);
    console.log(`Buscando "Marcelo Buscado" en servidor:`);
    console.log(`  Resultados encontrados: ${searchRes.items.length}`);
    console.log(`  Cliente retornado: ${foundMarcelo?.name ?? 'Ninguno'}`);

    const pass35 = !marceloInPage1 && foundMarcelo && foundMarcelo.name === 'Marcelo Buscado';
    results.push({
      test: 'TEST 35 — Búsqueda entre páginas',
      pass: pass35,
      detail: `Marcelo Buscado estaba en pág 2 y fue retornado inmediatamente en búsqueda (total=${searchRes.total})`
    });
    console.log(pass35 ? '✅ TEST 35 APROBADO\n' : '❌ TEST 35 FALLÓ\n');

    // =========================================================================
    // TEST 36 — Buscar teléfono con distintos formatos
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 36 — Buscar teléfono con distintos formatos');
    console.log('Objetivo: Validar que 1145678901, 45678901 y +54 9 11 4567-8901 encuentren al mismo cliente.');
    console.log('----------------------------------------------------------------');

    const c36Res = await client.query(
      `INSERT INTO customers (name, phone, first_order_at, last_order_at)
       VALUES ('Carlos Formatos', '+54 9 11 4567-8901', now(), now()) RETURNING id`
    );
    const carlosId = c36Res.rows[0].id;
    createdCustomerIds.push(carlosId);

    const s1 = (await client.query(`SELECT list_customers(1, 30, '1145678901') AS c`)).rows[0].c.items;
    const s2 = (await client.query(`SELECT list_customers(1, 30, '45678901') AS c`)).rows[0].c.items;
    const s3 = (await client.query(`SELECT list_customers(1, 30, '+54 9 11 4567-8901') AS c`)).rows[0].c.items;

    const f1 = s1.some((c) => c.id === carlosId);
    const f2 = s2.some((c) => c.id === carlosId);
    const f3 = s3.some((c) => c.id === carlosId);

    console.log(`Cliente registrado: Carlos Formatos (+54 9 11 4567-8901)`);
    console.log(`  Búsqueda "1145678901":          ${f1 ? '✅ ENCONTRADO' : '❌ NO ENCONTRADO'}`);
    console.log(`  Búsqueda "45678901":            ${f2 ? '✅ ENCONTRADO' : '❌ NO ENCONTRADO'}`);
    console.log(`  Búsqueda "+54 9 11 4567-8901":  ${f3 ? '✅ ENCONTRADO' : '❌ NO ENCONTRADO'}`);

    const pass36 = f1 && f2 && f3;
    results.push({
      test: 'TEST 36 — Búsqueda de teléfono normalizada',
      pass: pass36,
      detail: 'Las 3 variaciones de formato encontraron a Carlos Formatos con éxito'
    });
    console.log(pass36 ? '✅ TEST 36 APROBADO\n' : '❌ TEST 36 FALLÓ\n');

    // =========================================================================
    // TEST 37 — Cliente con historial mayor a 100 pedidos globales
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 37 — Cliente con historial mayor a 100 pedidos globales');
    console.log('Objetivo: orderCount = 5 y totalPaid = $150.000 deben preservarse íntegros.');
    console.log('----------------------------------------------------------------');

    const c37Res = await client.query(
      `INSERT INTO customers (name, phone, first_order_at, last_order_at)
       VALUES ('Cliente Histórico 37', '1188776655', now(), now()) RETURNING id`
    );
    const cust37Id = c37Res.rows[0].id;
    createdCustomerIds.push(cust37Id);

    // 5 pedidos históricos de $30.000 cada uno = $150.000 total pagado
    const cust37OrderIds = [];
    for (let i = 1; i <= 5; i++) {
      const oRes = await client.query(
        `INSERT INTO orders (
           customer_id, customer_name_snapshot, customer_phone_snapshot, payment_method, delivery_method,
           source, subtotal_cents, shipping_fee_cents, total_cents, cost_total_cents, tax_rate_basis_points,
           tax_amount_cents, order_state, payment_state, created_by, created_at, paid_at
         ) VALUES ($1, 'Cliente Histórico 37', '1188776655', 'cash', 'pickup', 'manual', 3000000, 0, 3000000,
                   1000000, 0, 0, 'confirmed', 'paid', $2, $3, $3)
         RETURNING id`,
        [cust37Id, OWNER_ID, new Date(baseTime - 1000000 + i * 1000).toISOString()]
      );
      cust37OrderIds.push(oRes.rows[0].id);
      createdOrderIds.push(oRes.rows[0].id);
    }

    // Simular que en la muestra global de los últimos 100 pedidos solo entró 1 pedido de este cliente (los otros 4 quedaron afuera)
    const simulatedRecent100 = [
      {
        id: cust37OrderIds[0],
        customerId: cust37Id,
        customerName: 'Cliente Histórico 37',
        customerPhone: '1188776655',
        totalCents: 3000000,
        paymentState: 'paid',
        orderState: 'confirmed'
      },
      // 99 pedidos de otros clientes
      ...Array.from({ length: 99 }, (_, i) => ({
        id: crypto.randomUUID(),
        customerId: crypto.randomUUID(),
        customerName: `Otro ${i}`,
        customerPhone: `110000${i}`,
        totalCents: 3000000,
        paymentState: 'paid',
        orderState: 'confirmed'
      }))
    ];

    // Consultar registro del cliente desde la API de clientes
    const cust37Api = (await client.query(`SELECT list_customers(1, 30, 'Cliente Histórico 37') AS c`)).rows[0].c.items[0];

    // Evaluar detalle con la lógica autoritativa corregida vs la lógica antigua
    const detailCorrected = computeAuthoritativeCustomerDetail(cust37Api, simulatedRecent100);
    const detailLegacy = computeLegacyCustomerDetail(cust37Api, simulatedRecent100);

    console.log(`Valores en API list_customers:`);
    console.log(`  orderCount: ${cust37Api.orderCount}`);
    console.log(`  totalPaidCents: $${cust37Api.totalPaidCents / 100}`);

    console.log(`Detalle en pantalla (Lógica Autoritativa):`);
    console.log(`  Pedidos mostrados: ${detailCorrected.orderCount} (Exacto 5)`);
    console.log(`  Total cobrado: $${detailCorrected.totalPaidCents / 100} (Exacto $150.000)`);

    console.log(`Detalle en pantalla (Lógica Antigua Distorsionada - Rechazada):`);
    console.log(`  Pedidos mostrados: ${detailLegacy.orderCount} (Truncado a 1)`);
    console.log(`  Total cobrado: $${detailLegacy.totalPaidCents / 100} (Truncado a $30.000)`);

    const pass37 =
      cust37Api.orderCount === 5 &&
      cust37Api.totalPaidCents === 15000000 &&
      detailCorrected.orderCount === 5 &&
      detailCorrected.totalPaidCents === 15000000 &&
      detailLegacy.totalPaidCents !== 15000000;

    results.push({
      test: 'TEST 37 — Historial mayor a 100 pedidos',
      pass: pass37,
      detail: `Preservó 5 pedidos y $150.000 cobrados sin sustituir por la muestra de 100`
    });
    console.log(pass37 ? '✅ TEST 37 APROBADO\n' : '❌ TEST 37 FALLÓ\n');

    // =========================================================================
    // TEST 38 — Pago pendiente que quedó fuera de los últimos 100 pedidos
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 38 — Pago pendiente que quedó fuera de los últimos 100 pedidos');
    console.log('Objetivo: Garantizar que un pedido pendiente antiguo no desaparezca ni diga "✓ Al día".');
    console.log('----------------------------------------------------------------');

    const c38Res = await client.query(
      `INSERT INTO customers (name, phone, first_order_at, last_order_at)
       VALUES ('Cliente Deuda 38', '1133445566', now(), now()) RETURNING id`
    );
    const cust38Id = c38Res.rows[0].id;
    createdCustomerIds.push(cust38Id);

    // 1 pedido pendiente antiguo de $35.000
    const o38Res = await client.query(
      `INSERT INTO orders (
         customer_id, customer_name_snapshot, customer_phone_snapshot, payment_method, delivery_method,
         source, subtotal_cents, shipping_fee_cents, total_cents, cost_total_cents, tax_rate_basis_points,
         tax_amount_cents, order_state, payment_state, created_by, created_at
       ) VALUES ($1, 'Cliente Deuda 38', '1133445566', 'cash', 'pickup', 'manual', 3500000, 0, 3500000,
                 1500000, 0, 0, 'confirmed', 'pending', $2, $3)
       RETURNING id`,
      [cust38Id, OWNER_ID, new Date(baseTime - 2000000).toISOString()]
    );
    createdOrderIds.push(o38Res.rows[0].id);

    // Muestra de últimos 100 donde este pedido NO está presente
    const simulatedRecent100NoCust38 = Array.from({ length: 100 }, (_, i) => ({
      id: crypto.randomUUID(),
      customerId: crypto.randomUUID(),
      customerName: `Otro ${i}`,
      customerPhone: `110000${i}`,
      totalCents: 3000000,
      paymentState: 'paid',
      orderState: 'confirmed'
    }));

    const cust38Api = (await client.query(`SELECT list_customers(1, 30, 'Cliente Deuda 38') AS c`)).rows[0].c.items[0];

    const detail38Corrected = computeAuthoritativeCustomerDetail(cust38Api, simulatedRecent100NoCust38);
    const detail38Legacy = computeLegacyCustomerDetail(cust38Api, simulatedRecent100NoCust38);

    console.log(`Datos en list_customers:`);
    console.log(`  pendingOrderCount: ${cust38Api.pendingOrderCount}`);
    console.log(`  pendingTotalCents: $${cust38Api.pendingTotalCents / 100}`);

    console.log(`Pantalla Clientes (Lógica Corregida):`);
    console.log(`  Chip "Pago pendiente": ${detail38Corrected.hasPending ? 'VISIBLE (warning)' : 'OCULTO'}`);
    console.log(`  Detalle: ${detail38Corrected.pendingOrderCount} pedido pendiente por $${detail38Corrected.pendingTotalCents / 100}`);

    console.log(`Pantalla Clientes (Lógica Antigua Falsa - Rechazada):`);
    console.log(`  Chip "Pago pendiente": ${detail38Legacy.hasPending ? 'VISIBLE' : 'OCULTO (Desapareció la deuda)'}`);
    console.log(`  Detalle: ${detail38Legacy.hasPending ? 'Pendiente' : '"✓ Al día · Sin pagos pendientes" (FALSO)'}`);

    const pass38 =
      cust38Api.pendingOrderCount === 1 &&
      cust38Api.pendingTotalCents === 3500000 &&
      detail38Corrected.hasPending === true &&
      detail38Corrected.pendingOrderCount === 1 &&
      detail38Corrected.pendingTotalCents === 3500000 &&
      detail38Legacy.hasPending === false;

    results.push({
      test: 'TEST 38 — Deuda pendiente fuera de los últimos 100 pedidos',
      pass: pass38,
      detail: `Deuda de $35.000 permanece 100% visible (evitó el falso "Al día")`
    });
    console.log(pass38 ? '✅ TEST 38 APROBADO\n' : '❌ TEST 38 FALLÓ\n');

    // =========================================================================
    // TEST 39 — Cliente recurrente con el mismo teléfono
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 39 — Cliente recurrente con el mismo teléfono');
    console.log('Objetivo: Pedidos con "11 5555 1234", "1155551234" y "+54 9 11 5555-1234" deben unificarse en 1 solo cliente.');
    console.log('----------------------------------------------------------------');

    const phoneT39 = '1155551234';

    // Crear 3 productos con los precios respectivos del fixture
    const p39_1 = (await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ('SKU391', $1, 'Item 39-1', 'Pote', 'Desc', 'Test', 2000000, true, true) RETURNING id`,
      [`p39-1-${Date.now()}`]
    )).rows[0].id;
    const p39_2 = (await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ('SKU392', $1, 'Item 39-2', 'Pote', 'Desc', 'Test', 3000000, true, true) RETURNING id`,
      [`p39-2-${Date.now()}`]
    )).rows[0].id;
    const p39_3 = (await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ('SKU393', $1, 'Item 39-3', 'Pote', 'Desc', 'Test', 4000000, true, true) RETURNING id`,
      [`p39-3-${Date.now()}`]
    )).rows[0].id;
    createdProductIds.push(p39_1, p39_2, p39_3);

    for (const pid of [p39_1, p39_2, p39_3]) {
      await client.query(`INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, 1000000)`, [pid]);
      await client.query(`INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 100, 0)`, [pid]);
    }

    // Pedido 1: Juan Pérez, 11 5555 1234 ($20.000)
    const p1 = await client.query(`SELECT confirm_imported_order($1::jsonb) AS o`, [JSON.stringify({
      customerName: 'Juan Pérez',
      phone: '11 5555 1234',
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'A1B2C3D4',
      lines: [{ productId: p39_1, quantity: 1, unitPriceCents: 2000000 }]
    })]);
    const o1 = p1.rows[0].o;
    createdOrderIds.push(o1.id);
    await client.query(`SELECT transition_order($1, 'mark_paid')`, [o1.id]);

    // Pedido 2: Juan Perez, 1155551234 ($30.000)
    const p2 = await client.query(`SELECT confirm_imported_order($1::jsonb) AS o`, [JSON.stringify({
      customerName: 'Juan Perez',
      phone: '1155551234',
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'E5F6A7B8',
      lines: [{ productId: p39_2, quantity: 1, unitPriceCents: 3000000 }]
    })]);
    const o2 = p2.rows[0].o;
    createdOrderIds.push(o2.id);
    await client.query(`SELECT transition_order($1, 'mark_paid')`, [o2.id]);

    // Pedido 3: JUAN PEREZ, +54 9 11 5555-1234 ($40.000)
    const p3 = await client.query(`SELECT confirm_imported_order($1::jsonb) AS o`, [JSON.stringify({
      customerName: 'JUAN PEREZ',
      phone: '+54 9 11 5555-1234',
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'C9D0E1F2',
      lines: [{ productId: p39_3, quantity: 1, unitPriceCents: 4000000 }]
    })]);
    const o3 = p3.rows[0].o;
    createdOrderIds.push(o3.id);
    await client.query(`SELECT transition_order($1, 'mark_paid')`, [o3.id]);

    // Buscar clientes resultantes en DB
    const cust39Db = await client.query(
      `SELECT c.*, count(o.id) as orders_count, sum(o.total_cents) as total_paid
       FROM customers c
       JOIN orders o ON o.customer_id = c.id
       WHERE public.canonical_phone(c.phone) = '1155551234'
       GROUP BY c.id`
    );

    console.log(`Clientes creados en la base de datos para este teléfono: ${cust39Db.rows.length}`);
    cust39Db.rows.forEach((c) => {
      createdCustomerIds.push(c.id);
      console.log(`  Cliente: ${c.name} (id=${c.id}), Teléfono=${c.phone}, Pedidos=${c.orders_count}, Total=$${c.total_paid / 100}`);
    });

    const pass39 =
      cust39Db.rows.length === 1 &&
      Number(cust39Db.rows[0].orders_count) === 3 &&
      Number(cust39Db.rows[0].total_paid) === 9000000; // $20k + $30k + $40k = $90k

    results.push({
      test: 'TEST 39 — Cliente recurrente con el mismo teléfono',
      pass: pass39,
      detail: `1 solo cliente unificado con 3 pedidos y $90.000 cobrados`
    });
    console.log(pass39 ? '✅ TEST 39 APROBADO\n' : '❌ TEST 39 FALLÓ\n');

    // =========================================================================
    // TEST 40 — Mismo nombre, personas distintas
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 40 — Mismo nombre, personas distintas');
    console.log('Objetivo: Dos "Juan Pérez" con teléfonos distintos (1111111111 vs 2222222222) deben ser 2 clientes separados.');
    console.log('----------------------------------------------------------------');

    // Juan Pérez A
    const pa = await client.query(`SELECT confirm_imported_order($1::jsonb) AS o`, [JSON.stringify({
      customerName: 'Juan Pérez Homónimo',
      phone: '1111111111',
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'B0000001',
      lines: [{ productId, quantity: 1, unitPriceCents: 3000000 }]
    })]);
    const oa = pa.rows[0].o;
    createdOrderIds.push(oa.id);
    await client.query(`SELECT transition_order($1, 'mark_paid')`, [oa.id]);

    // Juan Pérez B
    const pb = await client.query(`SELECT confirm_imported_order($1::jsonb) AS o`, [JSON.stringify({
      customerName: 'Juan Pérez Homónimo',
      phone: '2222222222',
      deliveryMethod: 'pickup',
      paymentMethod: 'cash',
      shippingFeeCents: 0,
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'B0000002',
      lines: [{ productId, quantity: 1, unitPriceCents: 3000000 }]
    })]);
    const ob = pb.rows[0].o;
    createdOrderIds.push(ob.id);
    await client.query(`SELECT transition_order($1, 'mark_paid')`, [ob.id]);

    const cust40Db = await client.query(
      `SELECT c.id, c.name, c.phone, count(o.id) as order_count, sum(o.total_cents) as total_cents
       FROM customers c
       JOIN orders o ON o.customer_id = c.id
       WHERE c.name = 'Juan Pérez Homónimo'
       GROUP BY c.id
       ORDER BY c.phone`
    );

    console.log(`Clientes creados para el mismo nombre con distinto teléfono: ${cust40Db.rows.length}`);
    cust40Db.rows.forEach((c) => {
      createdCustomerIds.push(c.id);
      console.log(`  Cliente ID=${c.id.slice(0, 8)}... Nombre=${c.name}, Tel=${c.phone}, Pedidos=${c.order_count}, Total=$${c.total_cents / 100}`);
    });

    const pass40 =
      cust40Db.rows.length === 2 &&
      cust40Db.rows[0].id !== cust40Db.rows[1].id &&
      Number(cust40Db.rows[0].order_count) === 1 &&
      Number(cust40Db.rows[1].order_count) === 1;

    results.push({
      test: 'TEST 40 — Mismo nombre, personas distintas',
      pass: pass40,
      detail: `2 clientes distintos preservados con sus respectivos teléfonos y pedidos aislados`
    });
    console.log(pass40 ? '✅ TEST 40 APROBADO\n' : '❌ TEST 40 FALLÓ\n');

    // =========================================================================
    // RESUMEN GENERAL DE LA SERIE 6
    // =========================================================================
    console.log('================================================================');
    console.log('                    RESUMEN DE LA SERIE 6                       ');
    console.log('================================================================');
    let allPassed = true;
    for (const r of results) {
      console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'}: ${r.test}`);
      console.log(`   └─ ${r.detail}`);
      if (!r.pass) allPassed = false;
    }
    console.log('================================================================');
    console.log(`RESULTADO FINAL: ${allPassed ? '6/6 APROBADOS' : 'FALLOS DETECTADOS'}`);
    console.log('================================================================\n');

  } finally {
    console.log('Limpiando datos de prueba de Serie 6...');
    if (createdOrderIds.length > 0) {
      await client.query(`DELETE FROM stock_movements WHERE order_id = ANY($1::uuid[])`, [createdOrderIds]);
      await client.query(`DELETE FROM stock_reservations WHERE order_id = ANY($1::uuid[])`, [createdOrderIds]);
      await client.query(`DELETE FROM order_items WHERE order_id = ANY($1::uuid[])`, [createdOrderIds]);
      await client.query(`DELETE FROM orders WHERE id = ANY($1::uuid[])`, [createdOrderIds]);
    }
    if (createdCustomerIds.length > 0) {
      await client.query(`DELETE FROM customers WHERE id = ANY($1::uuid[])`, [createdCustomerIds]);
    }
    if (createdProductIds.length > 0) {
      await client.query(`DELETE FROM stock_balances WHERE product_id = ANY($1::uuid[])`, [createdProductIds]);
      await client.query(`DELETE FROM product_financials WHERE product_id = ANY($1::uuid[])`, [createdProductIds]);
      await client.query(`DELETE FROM products WHERE id = ANY($1::uuid[])`, [createdProductIds]);
    }
    await client.end();
    console.log('Limpieza completada con éxito.');
  }
}

runSuite6().catch((err) => {
  console.error('Error fatal en ejecución de Serie 6:', err);
  process.exit(1);
});
