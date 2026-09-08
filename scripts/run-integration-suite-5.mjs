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

// Función que replica exactamente el cálculo de ganancia por producto de SalesPage.tsx (versión corregida)
function computeSalesPageGainByProduct(analyticsData) {
  const raw = analyticsData?.topProducts ?? [];
  if (raw.length === 0) return [];

  return raw.map((p) => {
    const gainCents = p.estimatedMarginCents;
    const costCents = p.costCents ?? Math.max(0, p.revenueCents - p.estimatedMarginCents);
    const gainPct = p.revenueCents > 0 ? (gainCents / p.revenueCents) * 100 : 0;
    return {
      ...p,
      salesCents: p.revenueCents,
      costCents,
      gainCents,
      gainPct
    };
  }).sort((a, b) => b.gainCents - a.gainCents);
}

// Función que replica la lógica antigua/distorsionada para evidenciar el contraste en el test
function computeLegacyDistortedGain(analyticsData) {
  const raw = analyticsData?.topProducts ?? [];
  const totalRev = analyticsData?.revenueCents ?? 0;
  const totalCost = analyticsData?.costCents ?? 0;
  const totalTax = analyticsData?.taxCents ?? 0;

  if (totalRev <= 0) return [];

  return raw.map((p) => {
    const share = p.revenueCents / totalRev;
    const costCents = Math.round(totalCost * share);
    const taxCents = Math.round(totalTax * share);
    const gainCents = p.revenueCents - costCents - taxCents;
    const gainPct = p.revenueCents > 0 ? (gainCents / p.revenueCents) * 100 : 0;
    return {
      ...p,
      salesCents: p.revenueCents,
      costCents,
      gainCents,
      gainPct
    };
  }).sort((a, b) => b.gainCents - a.gainCents);
}

async function runSuite5() {
  const client = await createClient();
  await setAuth(client, OWNER_ID);

  console.log('================================================================');
  console.log('       SERIE 5 — VENTAS Y NÚMEROS REALES (TESTS 29 A 34)       ');
  console.log('================================================================\n');

  const createdProductIds = [];
  const createdOrderIds = [];
  const results = [];

  // Helper para crear producto aislado
  async function createProduct(name, salePriceCents, costCents) {
    const sku = `S5${Date.now().toString().slice(-4)}${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
    const slug = `${sku.toLowerCase()}-${Date.now()}`;
    const res = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, $3, 'Pote 300g', 'Item Serie 5', 'Test', $4, true, true)
       RETURNING id, sku, slug, name, sale_price_cents`,
      [sku, slug, name, salePriceCents]
    );
    const prod = res.rows[0];
    createdProductIds.push(prod.id);

    await client.query(
      `INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, $2)
       ON CONFLICT (product_id) DO UPDATE SET current_cost_cents = $2`,
      [prod.id, costCents]
    );
    await client.query(
      `INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 100, 0)
       ON CONFLICT (product_id) DO UPDATE SET on_hand = 100, reserved = 0`,
      [prod.id]
    );

    return { ...prod, costCents };
  }

  // Helper para crear y cobrar pedido
  async function createOrder(customerName, lines, options = {}) {
    const payload = {
      customerName,
      phone: '1144556677',
      deliveryMethod: options.deliveryMethod || 'pickup',
      shippingType: options.shippingType || null,
      shippingFeeCents: options.shippingFeeCents || 0,
      address: options.address || null,
      paymentMethod: options.paymentMethod || 'cash',
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: 'AAAA' + Math.random().toString(16).slice(2, 6).toUpperCase(),
      lines
    };

    const res = await client.query(`SELECT confirm_imported_order($1::jsonb) AS o`, [JSON.stringify(payload)]);
    const order = res.rows[0].o;
    createdOrderIds.push(order.id);

    if (options.markPaid) {
      await client.query(`SELECT transition_order($1, 'mark_paid')`, [order.id]);
    }
    if (options.markRefunded) {
      await client.query(`SELECT transition_order($1, 'mark_refunded')`, [order.id]);
    }
    if (options.paidAt) {
      await client.query(`UPDATE orders SET paid_at = $1 WHERE id = $2`, [options.paidAt, order.id]);
    }

    return order;
  }

  try {
    // =========================================================================
    // TEST 29 — Ganancia real por producto
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 29 — Ganancia real por producto');
    console.log('Objetivo: Evitar que el frontend diluya márgenes individuales con reparto proporcional.');
    console.log('----------------------------------------------------------------');

    const D29 = '2026-11-20';
    const prod29A = await createProduct('Producto A Test 29', 3000000, 1000000); // Venta: $30k, Costo: $10k
    const prod29B = await createProduct('Producto B Test 29', 3000000, 2500000); // Venta: $30k, Costo: $25k

    await createOrder('Cliente 29 A', [{ productId: prod29A.id, quantity: 1, unitPriceCents: 3000000 }], {
      markPaid: true,
      paidAt: `${D29} 10:00:00-03`
    });
    await createOrder('Cliente 29 B', [{ productId: prod29B.id, quantity: 1, unitPriceCents: 3000000 }], {
      markPaid: true,
      paidAt: `${D29} 11:00:00-03`
    });

    const res29 = await client.query(`SELECT get_sales_analytics($1::date, $2::date) AS a`, [D29, D29]);
    const a29 = res29.rows[0].a;

    const topA29 = a29.topProducts.find((p) => p.productId === prod29A.id);
    const topB29 = a29.topProducts.find((p) => p.productId === prod29B.id);

    const gainSalesPage29 = computeSalesPageGainByProduct(a29);
    const spA29 = gainSalesPage29.find((p) => p.productId === prod29A.id);
    const spB29 = gainSalesPage29.find((p) => p.productId === prod29B.id);

    const legacyGain29 = computeLegacyDistortedGain(a29);
    const legA29 = legacyGain29.find((p) => p.productId === prod29A.id);
    const legB29 = legacyGain29.find((p) => p.productId === prod29B.id);

    console.log(`Global: Facturación=$${a29.revenueCents / 100}, Costo=$${a29.costCents / 100}, Ganancia=$${a29.estimatedMarginCents / 100}`);
    console.log(`RPC Backend:`);
    console.log(`  Prod A: Ventas=$${topA29.revenueCents / 100}, Costo=$${topA29.costCents / 100}, Margen=$${topA29.estimatedMarginCents / 100}`);
    console.log(`  Prod B: Ventas=$${topB29.revenueCents / 100}, Costo=$${topB29.costCents / 100}, Margen=$${topB29.estimatedMarginCents / 100}`);
    console.log(`Pantalla Ventas (Corregida):`);
    console.log(`  Prod A: Ventas=$${spA29.salesCents / 100}, Costo=$${spA29.costCents / 100}, Ganancia=$${spA29.gainCents / 100} (${spA29.gainPct.toFixed(1)}%)`);
    console.log(`  Prod B: Ventas=$${spB29.salesCents / 100}, Costo=$${spB29.costCents / 100}, Ganancia=$${spB29.gainCents / 100} (${spB29.gainPct.toFixed(1)}%)`);
    console.log(`Pantalla Ventas (Fórmula Antigua Proporcional - Rechazada):`);
    console.log(`  Prod A antiguo: Ganancia=$${legA29.gainCents / 100} (Diluida a $12.500)`);
    console.log(`  Prod B antiguo: Ganancia=$${legB29.gainCents / 100} (Diluida a $12.500)`);

    const pass29 =
      a29.revenueCents === 6000000 &&
      a29.costCents === 3500000 &&
      a29.estimatedMarginCents === 2500000 &&
      spA29.gainCents === 2000000 &&
      spA29.costCents === 1000000 &&
      spB29.gainCents === 500000 &&
      spB29.costCents === 2500000 &&
      spA29.gainCents !== 1250000;

    results.push({
      test: 'TEST 29 — Ganancia real por producto',
      pass: pass29,
      detail: `A=$${spA29.gainCents / 100}, B=$${spB29.gainCents / 100} (excluye distorsión de $12.500)`
    });
    console.log(pass29 ? '✅ TEST 29 APROBADO\n' : '❌ TEST 29 FALLÓ\n');

    // =========================================================================
    // TEST 30 — Cambiar costo/precio no modifica ventas históricas
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 30 — Snapshots históricos de costo y precio');
    console.log('Objetivo: Validar que editar precio o costo futuro jamás altere ventas ya cerradas.');
    console.log('----------------------------------------------------------------');

    const D30_1 = '2026-11-21';
    const D30_2 = '2026-11-22';
    const prod30 = await createProduct('Producto Test 30', 3300000, 1800000); // $33.000 venta, $18.000 costo

    // Primera venta
    const o30_1 = await createOrder('Cliente 30 Primera', [{ productId: prod30.id, quantity: 1, unitPriceCents: 3300000 }], {
      markPaid: true,
      paidAt: `${D30_1} 10:00:00-03`
    });

    // Editar producto en catálogo: precio nuevo $40.000, costo nuevo $22.000
    await client.query(`UPDATE products SET sale_price_cents = 4000000 WHERE id = $1`, [prod30.id]);
    await client.query(`UPDATE product_financials SET current_cost_cents = 2200000 WHERE product_id = $1`, [prod30.id]);

    // Segunda venta con el nuevo precio/costo
    const o30_2 = await createOrder('Cliente 30 Segunda', [{ productId: prod30.id, quantity: 1, unitPriceCents: 4000000 }], {
      markPaid: true,
      paidAt: `${D30_2} 10:00:00-03`
    });

    // Consultar snapshots en order_items
    const items30_1 = (await client.query(`SELECT unit_price_cents, unit_cost_cents FROM order_items WHERE order_id = $1`, [o30_1.id])).rows[0];
    const items30_2 = (await client.query(`SELECT unit_price_cents, unit_cost_cents FROM order_items WHERE order_id = $1`, [o30_2.id])).rows[0];

    // Consultar analítica del día 1
    const a30_1 = (await client.query(`SELECT get_sales_analytics($1::date, $2::date) AS a`, [D30_1, D30_1])).rows[0].a;
    // Consultar analítica del día 2
    const a30_2 = (await client.query(`SELECT get_sales_analytics($1::date, $2::date) AS a`, [D30_2, D30_2])).rows[0].a;
    // Consultar analítica global de ambos días
    const a30_all = (await client.query(`SELECT get_sales_analytics($1::date, $2::date) AS a`, [D30_1, D30_2])).rows[0].a;

    console.log(`Venta 1 (Histórica): Venta=$${items30_1.unit_price_cents / 100}, Costo=$${items30_1.unit_cost_cents / 100}, Margen=$${(items30_1.unit_price_cents - items30_1.unit_cost_cents) / 100}`);
    console.log(`Venta 2 (Nueva): Venta=$${items30_2.unit_price_cents / 100}, Costo=$${items30_2.unit_cost_cents / 100}, Margen=$${(items30_2.unit_price_cents - items30_2.unit_cost_cents) / 100}`);
    console.log(`Analítica Período 1: Venta=$${a30_1.revenueCents / 100}, Costo=$${a30_1.costCents / 100}, Margen=$${a30_1.estimatedMarginCents / 100}`);
    console.log(`Analítica Período 2: Venta=$${a30_2.revenueCents / 100}, Costo=$${a30_2.costCents / 100}, Margen=$${a30_2.estimatedMarginCents / 100}`);
    console.log(`Analítica Acumulada: Venta=$${a30_all.revenueCents / 100}, Costo=$${a30_all.costCents / 100}, Margen=$${a30_all.estimatedMarginCents / 100}`);

    const pass30 =
      items30_1.unit_price_cents === '3300000' &&
      items30_1.unit_cost_cents === '1800000' &&
      items30_2.unit_price_cents === '4000000' &&
      items30_2.unit_cost_cents === '2200000' &&
      a30_1.revenueCents === 3300000 &&
      a30_1.costCents === 1800000 &&
      a30_1.estimatedMarginCents === 1500000 &&
      a30_2.revenueCents === 4000000 &&
      a30_2.costCents === 2200000 &&
      a30_2.estimatedMarginCents === 1800000 &&
      a30_all.revenueCents === 7300000 &&
      a30_all.costCents === 4000000 &&
      a30_all.estimatedMarginCents === 3300000;

    results.push({
      test: 'TEST 30 — Snapshots históricos',
      pass: pass30,
      detail: 'Venta 1 inmune a $18.000 costo / $15.000 margen; Venta 2 a $22.000 costo / $18.000 margen'
    });
    console.log(pass30 ? '✅ TEST 30 APROBADO\n' : '❌ TEST 30 FALLÓ\n');

    // =========================================================================
    // TEST 31 — Pendiente → cobrado → reintegrado
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 31 — Qué entra realmente en Ventas (Pendiente vs Cobrado vs Reintegrado)');
    console.log('Objetivo: Garantizar que la analítica filtre con precisión estricta payment_state = paid.');
    console.log('----------------------------------------------------------------');

    const D31 = '2026-11-23';
    const prod31A = await createProduct('Prod 31 A', 2000000, 1000000);
    const prod31B = await createProduct('Prod 31 B', 3000000, 1500000);
    const prod31C = await createProduct('Prod 31 C', 4000000, 2000000);

    // Pedido A = $20.000 -> pendiente
    await createOrder('Cliente 31 A', [{ productId: prod31A.id, quantity: 1, unitPriceCents: 2000000 }], {
      markPaid: false
    });

    // Pedido B = $30.000 -> cobrado
    await createOrder('Cliente 31 B', [{ productId: prod31B.id, quantity: 1, unitPriceCents: 3000000 }], {
      markPaid: true,
      paidAt: `${D31} 12:00:00-03`
    });

    // Pedido C = $40.000 -> cobrado y luego reintegrado
    await createOrder('Cliente 31 C', [{ productId: prod31C.id, quantity: 1, unitPriceCents: 4000000 }], {
      markPaid: true,
      markRefunded: true,
      paidAt: `${D31} 12:00:00-03`
    });

    const res31 = await client.query(`SELECT get_sales_analytics($1::date, $2::date) AS a`, [D31, D31]);
    const a31 = res31.rows[0].a;

    console.log(`Ventas cobradas en período: ${a31.orders}`);
    console.log(`Facturación registrada: $${a31.revenueCents / 100}`);
    console.log(`Unidades vendidas: ${a31.units}`);
    console.log(`Productos en ranking: ${a31.topProducts.map((p) => `${p.name} ($${p.revenueCents / 100})`).join(', ')}`);

    const hasA = a31.topProducts.some((p) => p.productId === prod31A.id);
    const hasB = a31.topProducts.some((p) => p.productId === prod31B.id);
    const hasC = a31.topProducts.some((p) => p.productId === prod31C.id);

    const pass31 =
      a31.orders === 1 &&
      a31.revenueCents === 3000000 &&
      a31.units === 1 &&
      hasB &&
      !hasA &&
      !hasC;

    results.push({
      test: 'TEST 31 — Pendiente → cobrado → reintegrado',
      pass: pass31,
      detail: `Excluyó A (pendiente) y C (reintegrado). Ventas=${a31.orders}, Facturación=$${a31.revenueCents / 100}`
    });
    console.log(pass31 ? '✅ TEST 31 APROBADO\n' : '❌ TEST 31 FALLÓ\n');

    // =========================================================================
    // TEST 32 — Venta con envío
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 32 — Envíos y rentabilidad (Desglose Global vs Producto)');
    console.log('Objetivo: Documentar explícitamente la atribución del flete de $4.500.');
    console.log('----------------------------------------------------------------');

    const D32 = '2026-11-24';
    const prod32 = await createProduct('Proteína 32', 3000000, 1800000); // Producto: $30.000, costo $18.000

    await createOrder('Cliente 32 Envío', [{ productId: prod32.id, quantity: 1, unitPriceCents: 3000000 }], {
      deliveryMethod: 'shipping',
      shippingType: 'standard',
      shippingFeeCents: 450000, // $4.500
      address: 'Calle Falsa 123',
      markPaid: true,
      paidAt: `${D32} 14:00:00-03`
    });

    const res32 = await client.query(`SELECT get_sales_analytics($1::date, $2::date) AS a`, [D32, D32]);
    const a32 = res32.rows[0].a;
    const topProd32 = a32.topProducts.find((p) => p.productId === prod32.id);
    const spGain32 = computeSalesPageGainByProduct(a32).find((p) => p.productId === prod32.id);

    console.log('Resumen General (Orden completa con envío):');
    console.log(`  Ventas cobradas: $${a32.revenueCents / 100} (incluye $4.500 de envío)`);
    console.log(`  Costo mercadería: $${a32.costCents / 100}`);
    console.log(`  Ganancia estimada global: $${a32.estimatedMarginCents / 100}`);
    console.log(`  Pedidos: ${a32.orders}, Unidades: ${a32.units}`);

    console.log('Ventas por Producto (Ítem físico):');
    console.log(`  Producto: ${topProd32.name}`);
    console.log(`  Unidades: ${topProd32.units}`);
    console.log(`  Total vendido del producto: $${topProd32.revenueCents / 100}`);
    console.log(`  Costo del producto: $${topProd32.costCents / 100}`);
    console.log(`  Margen neto del producto: $${topProd32.estimatedMarginCents / 100}`);
    console.log(`  Ganancia mostrada en SalesPage: $${spGain32.gainCents / 100}`);

    const shippingDifference = a32.estimatedMarginCents - topProd32.estimatedMarginCents;
    console.log(`\nDocumentación del flete:`);
    console.log(`  Diferencia entre Ganancia Global ($${a32.estimatedMarginCents / 100}) y Ganancia de Producto ($${topProd32.estimatedMarginCents / 100}) = $${shippingDifference / 100}`);
    console.log(`  -> Esos $${shippingDifference / 100} corresponden al flete facturado en la orden.`);
    console.log(`  -> El flete NO se asigna al producto individual porque es un cargo logístico de la orden.`);

    const pass32 =
      a32.revenueCents === 3450000 &&
      a32.costCents === 1800000 &&
      a32.estimatedMarginCents === 1650000 &&
      a32.orders === 1 &&
      a32.units === 1 &&
      topProd32.units === 1 &&
      topProd32.revenueCents === 3000000 &&
      topProd32.costCents === 1800000 &&
      topProd32.estimatedMarginCents === 1200000 &&
      spGain32.gainCents === 1200000 &&
      shippingDifference === 450000;

    results.push({
      test: 'TEST 32 — Venta con envío',
      pass: pass32,
      detail: `Global=$34.500 ($16.500 margen), Producto=$30.000 ($12.000 margen), Flete atribuido=$4.500`
    });
    console.log(pass32 ? '✅ TEST 32 APROBADO\n' : '❌ TEST 32 FALLÓ\n');

    // =========================================================================
    // TEST 33 — Ranking por producto
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 33 — Ranking por producto (Unidades vs Facturación y % Share)');
    console.log('Objetivo: Validar ordenamientos y porcentajes exactos sin interferencia de fletes.');
    console.log('----------------------------------------------------------------');

    const D33 = '2026-11-25';
    // Creatina: 10 unidades x $20.000 = $200.000
    const prodCreatina = await createProduct('Creatina Test 33', 2000000, 1000000);
    // Omega: 3 unidades x $100.000 = $300.000
    const prodOmega = await createProduct('Omega Test 33', 10000000, 5000000);

    await createOrder('Cliente Creatina', [{ productId: prodCreatina.id, quantity: 10, unitPriceCents: 2000000 }], {
      markPaid: true,
      paidAt: `${D33} 10:00:00-03`
    });
    await createOrder('Cliente Omega', [{ productId: prodOmega.id, quantity: 3, unitPriceCents: 10000000 }], {
      markPaid: true,
      paidAt: `${D33} 11:00:00-03`
    });

    const res33 = await client.query(`SELECT get_sales_analytics($1::date, $2::date) AS a`, [D33, D33]);
    const a33 = res33.rows[0].a;

    // Ordenar por unidades descendente (default de la RPC)
    const sortedByUnits = [...a33.topProducts].sort((a, b) => b.units - a.units);
    // Ordenar por facturación descendente
    const sortedByRev = [...a33.topProducts].sort((a, b) => b.revenueCents - a.revenueCents);

    const totalProductRev = a33.revenueCents;
    const omegaShare = (sortedByRev.find((p) => p.productId === prodOmega.id).revenueCents / totalProductRev) * 100;
    const creatinaShare = (sortedByRev.find((p) => p.productId === prodCreatina.id).revenueCents / totalProductRev) * 100;

    console.log(`Ranking por unidades vendidas:`);
    sortedByUnits.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}: ${p.units} unidades`));

    console.log(`Ranking por facturación:`);
    sortedByRev.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}: $${p.revenueCents / 100} (${((p.revenueCents / totalProductRev) * 100).toFixed(1)}%)`));

    const pass33 =
      sortedByUnits[0].productId === prodCreatina.id && sortedByUnits[0].units === 10 &&
      sortedByUnits[1].productId === prodOmega.id && sortedByUnits[1].units === 3 &&
      sortedByRev[0].productId === prodOmega.id && sortedByRev[0].revenueCents === 30000000 &&
      sortedByRev[1].productId === prodCreatina.id && sortedByRev[1].revenueCents === 20000000 &&
      Math.round(omegaShare) === 60 &&
      Math.round(creatinaShare) === 40;

    results.push({
      test: 'TEST 33 — Ranking por producto',
      pass: pass33,
      detail: `Unidades: 1. Creatina (10), 2. Omega (3) | Facturación: 1. Omega ($300k, 60%), 2. Creatina ($200k, 40%)`
    });
    console.log(pass33 ? '✅ TEST 33 APROBADO\n' : '❌ TEST 33 FALLÓ\n');

    // =========================================================================
    // TEST 34 — Inicio y Ventas tienen que decir lo mismo
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 34 — Reconciliación Inicio ↔ Ventas');
    console.log('Objetivo: get_dashboard_summary() vs get_sales_analytics(inicio_mes, hoy) deben coincidir exactamente.');
    console.log('----------------------------------------------------------------');

    // Obtener las fechas del mes actual en hora Argentina
    const dateQuery = await client.query(`
      SELECT
        (date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires'))::date AS start_of_month,
        (now() at time zone 'America/Argentina/Buenos_Aires')::date AS today;
    `);
    const { start_of_month: startOfMonth, today } = dateQuery.rows[0];

    // Crear una venta cobrada HOY para asegurar actividad en el mes actual
    const prod34 = await createProduct('Prod 34 Reconciliación', 5000000, 2000000); // $50k venta, $20k costo
    await createOrder('Cliente 34 Reconciliación', [{ productId: prod34.id, quantity: 1, unitPriceCents: 5000000 }], {
      markPaid: true,
      paidAt: new Date().toISOString()
    });

    // Consultar get_dashboard_summary()
    const dashRes = await client.query(`SELECT get_dashboard_summary() AS d`);
    const dash = dashRes.rows[0].d;

    // Consultar get_sales_analytics(startOfMonth, today)
    const salesRes = await client.query(`SELECT get_sales_analytics($1::date, $2::date) AS s`, [startOfMonth, today]);
    const sales = salesRes.rows[0].s;

    console.log(`Período evaluado: ${startOfMonth.toISOString().slice(0, 10)} a ${today.toISOString().slice(0, 10)}`);
    console.log(`Dashboard (Inicio):`);
    console.log(`  paidRevenueMonthCents:     $${(dash.paidRevenueMonthCents / 100).toLocaleString('es-AR')}`);
    console.log(`  paidOrdersMonth:           ${dash.paidOrdersMonth}`);
    console.log(`  estimatedMarginMonthCents: $${(dash.estimatedMarginMonthCents / 100).toLocaleString('es-AR')}`);

    console.log(`Ventas (Analítica):`);
    console.log(`  revenueCents:              $${(sales.revenueCents / 100).toLocaleString('es-AR')}`);
    console.log(`  orders:                    ${sales.orders}`);
    console.log(`  estimatedMarginCents:      $${(sales.estimatedMarginCents / 100).toLocaleString('es-AR')}`);

    const revMatch = String(dash.paidRevenueMonthCents) === String(sales.revenueCents);
    const countMatch = String(dash.paidOrdersMonth) === String(sales.orders);
    const marginMatch = String(dash.estimatedMarginMonthCents) === String(sales.estimatedMarginCents);

    console.log(`Coincidencia Facturación: ${revMatch ? '✅ EXACTO' : '❌ DISCREPANCIA'}`);
    console.log(`Coincidencia Cantidad:    ${countMatch ? '✅ EXACTO' : '❌ DISCREPANCIA'}`);
    console.log(`Coincidencia Ganancia:    ${marginMatch ? '✅ EXACTO' : '❌ DISCREPANCIA'}`);

    const pass34 = revMatch && countMatch && marginMatch;

    results.push({
      test: 'TEST 34 — Reconciliación Inicio ↔ Ventas',
      pass: pass34,
      detail: `Facturación=$${sales.revenueCents / 100}, Pedidos=${sales.orders}, Margen=$${sales.estimatedMarginCents / 100} (100% idénticos)`
    });
    console.log(pass34 ? '✅ TEST 34 APROBADO\n' : '❌ TEST 34 FALLÓ\n');

    // =========================================================================
    // RESUMEN GENERAL DE LA SERIE 5
    // =========================================================================
    console.log('================================================================');
    console.log('                    RESUMEN DE LA SERIE 5                       ');
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
    console.log('Limpiando datos generados para la Serie 5...');
    if (createdOrderIds.length > 0) {
      await client.query(`DELETE FROM stock_movements WHERE order_id = ANY($1::uuid[])`, [createdOrderIds]);
      await client.query(`DELETE FROM stock_reservations WHERE order_id = ANY($1::uuid[])`, [createdOrderIds]);
      await client.query(`DELETE FROM order_items WHERE order_id = ANY($1::uuid[])`, [createdOrderIds]);
      await client.query(`DELETE FROM orders WHERE id = ANY($1::uuid[])`, [createdOrderIds]);
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

runSuite5().catch((err) => {
  console.error('Error fatal en ejecución de Serie 5:', err);
  process.exit(1);
});
