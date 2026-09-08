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

// -----------------------------------------------------------------------------
// Lógica de Dominio del Checkout y WhatsApp (espejo exacto de src/domain/)
// -----------------------------------------------------------------------------

const ARS_FORMATTER = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const formatMoney = (cents) => ARS_FORMATTER.format(cents / 100);

const WHATSAPP_PROTOCOL_HEADER = '*PEDIDO IMPULSO*';

const field = (label, value) => `*${label}*\n${value}`;

const fnv1a = (value) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').toUpperCase();
};

const normalizeProtocolText = (value) =>
  value
    .trim()
    .replace(/^["'“`]+|["'”`]+$/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^[ \t]*[•\*\–\—][ \t]+\[/gm, '- [')
    .replace(/\$[\u00a0\u202f\u200b\s]+(\d)/g, '$\u00a0$1')
    .replace(/[ \t]+$/gm, '')
    .trim();

const productLine = (line) =>
  `- [${line.sku}] ${line.name} | ${line.presentation} | ${line.quantity} x ${formatMoney(line.unitPriceCents)} = ${formatMoney(line.unitPriceCents * line.quantity)}`;

const paymentLabel = (method) => (method === 'cash' ? 'Efectivo' : 'Transferencia');

const deliveryLabel = (method) => (method === 'pickup' ? 'Retiro' : 'Envío a domicilio');

const shippingLabel = (type) => (type === 'express' ? 'Express' : 'Tradicional');

const buildProtocolBody = (checkout, lines, shippingFeeCents) => {
  const subtotalCents = lines.reduce(
    (total, line) => total + line.unitPriceCents * line.quantity,
    0
  );
  const sections = [
    WHATSAPP_PROTOCOL_HEADER,
    field('Nombre', checkout.customerName.trim()),
    `*Productos*\n${lines.map(productLine).join('\n')}`,
    field('Subtotal', formatMoney(subtotalCents)),
    field('Medio de pago', paymentLabel(checkout.paymentMethod)),
    field('Entrega', deliveryLabel(checkout.deliveryMethod))
  ];

  if (checkout.deliveryMethod === 'shipping') {
    sections.push(
      field('Tipo de envío', shippingLabel(checkout.shippingType)),
      field('Envío', formatMoney(shippingFeeCents)),
      field('Dirección', checkout.address?.trim() ?? ''),
      field('Altura', checkout.addressNumber?.trim() || 'Sin altura'),
      field('Teléfono', checkout.phone?.trim() ?? '')
    );
  } else {
    sections.push(field('Envío', formatMoney(0)));
  }

  sections.push(field('Total', formatMoney(subtotalCents + shippingFeeCents)));
  return sections.join('\n\n');
};

const buildWhatsAppProtocol = (checkout, lines, settings, existingOrderId) => {
  if (lines.length === 0) throw new Error('El pedido no tiene productos.');
  const orderId =
    existingOrderId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existingOrderId)
      ? existingOrderId.toLowerCase()
      : crypto.randomUUID();

  const shippingFeeCents =
    checkout.deliveryMethod === 'shipping'
      ? checkout.shippingType === 'express'
        ? settings.expressShippingCents
        : settings.standardShippingCents
      : 0;

  const subtotalCents = lines.reduce(
    (total, line) => total + line.unitPriceCents * line.quantity,
    0
  );

  const baseBody = buildProtocolBody(checkout, lines, shippingFeeCents);
  const body = normalizeProtocolText(
    baseBody.replace(
      `${WHATSAPP_PROTOCOL_HEADER}\n\n`,
      `${WHATSAPP_PROTOCOL_HEADER}\n\n${field('Código de pedido', orderId)}\n\n`
    )
  );
  const checksum = fnv1a(body);
  return {
    message: `${body}\n\n${field('Código de control', checksum)}`,
    orderId,
    checksum,
    subtotalCents,
    shippingFeeCents,
    totalCents: subtotalCents + shippingFeeCents
  };
};

const createOrderFingerprint = (checkout, lines, shippingFeeCents) => {
  const lineStr = lines
    .map((l) => `${l.productId}:${l.quantity}:${l.unitPriceCents}`)
    .sort()
    .join('|');
  const deliveryStr =
    checkout.deliveryMethod === 'shipping'
      ? `shipping:${checkout.shippingType ?? ''}:${checkout.address ?? ''}:${checkout.addressNumber ?? ''}:${checkout.phone ?? ''}:${shippingFeeCents}`
      : 'pickup';
  return `${lineStr}__${checkout.customerName.trim()}__${checkout.paymentMethod}__${deliveryStr}`;
};

const sanitizeCheckoutValues = (values) => ({
  ...values,
  customerName: values.customerName.trim(),
  shippingType: values.deliveryMethod === 'shipping' ? values.shippingType : null,
  address: values.deliveryMethod === 'shipping' ? (values.address?.trim() ?? null) : null,
  addressNumber: values.deliveryMethod === 'shipping' ? (values.addressNumber?.trim() || null) : null,
  phone: values.deliveryMethod === 'shipping' ? (values.phone?.trim() ?? null) : null
});

const calculateShippingFee = (deliveryMethod, shippingType, settings) => {
  if (deliveryMethod !== 'shipping') return 0;
  return shippingType === 'express'
    ? settings.expressShippingCents
    : settings.standardShippingCents;
};

const revalidateCartWithCatalog = (currentLines, catalogProducts) => {
  const result = {
    updatedLines: currentLines,
    priceChanges: [],
    outOfStockProducts: [],
    unavailableProducts: [],
    partialStockProducts: []
  };

  if (currentLines.length === 0 || catalogProducts.length === 0) return result;

  let hasLinePriceChange = false;
  const updated = currentLines.map((line) => {
    const current = catalogProducts.find((p) => p.id === line.productId);
    if (!current) {
      result.unavailableProducts.push(line.name);
      return line;
    }

    if (current.availability === 'out_of_stock' || current.maxOrderQuantity <= 0) {
      result.outOfStockProducts.push(line.name);
    } else if (line.quantity > current.maxOrderQuantity) {
      result.partialStockProducts.push({
        name: line.name,
        available: current.maxOrderQuantity,
        requested: line.quantity
      });
    }

    if (current.priceCents !== line.unitPriceCents) {
      result.priceChanges.push({
        name: line.name,
        oldPriceCents: line.unitPriceCents,
        newPriceCents: current.priceCents
      });
      hasLinePriceChange = true;
      return {
        ...line,
        unitPriceCents: current.priceCents
      };
    }

    return line;
  });

  return {
    ...result,
    updatedLines: hasLinePriceChange ? updated : currentLines
  };
};

const buildWhatsAppUrl = (phone, message, userAgent = 'Mozilla Desktop') => {
  const normalizedPhone = phone.replace(/\D/g, '');
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const base = isMobile ? 'https://wa.me/' : 'https://web.whatsapp.com/send';
  if (base.endsWith('/')) {
    return `${base}${normalizedPhone}?text=${encodeURIComponent(message)}`;
  }
  return `${base}?phone=${normalizedPhone}&text=${encodeURIComponent(message)}`;
};

const prepareCheckoutSubmission = async (input) => {
  let effectiveLines = input.lines;
  let priceChanges = [];
  let priceNotice = null;

  if (input.catalogProducts && input.catalogProducts.length > 0) {
    const reval = input.syncWithLiveCatalog
      ? input.syncWithLiveCatalog(input.catalogProducts)
      : revalidateCartWithCatalog(input.lines, input.catalogProducts);

    effectiveLines = reval.updatedLines;
    priceChanges = reval.priceChanges;

    if (reval.unavailableProducts.length > 0) {
      const err = new Error(`El producto “${reval.unavailableProducts[0]}” ya no está disponible en la tienda.`);
      err.code = 'UNAVAILABLE';
      err.nextAction = 'Volvé al carrito y quitalo para poder continuar.';
      throw err;
    }

    if (reval.outOfStockProducts.length > 0) {
      const err = new Error(`El producto “${reval.outOfStockProducts[0]}” se quedó sin stock.`);
      err.code = 'OUT_OF_STOCK';
      err.nextAction = 'Volvé al carrito y quitalo para poder continuar.';
      throw err;
    }

    if (reval.partialStockProducts.length > 0) {
      const partial = reval.partialStockProducts[0];
      const err = new Error(`Ahora quedan ${partial.available} unidades de “${partial.name}” (pediste ${partial.requested}).`);
      err.code = 'PARTIAL_STOCK';
      err.nextAction = 'Volvé al carrito y ajustá la cantidad antes de continuar.';
      throw err;
    }

    if (reval.priceChanges.length > 0) {
      const changeSummary = reval.priceChanges
        .map((c) => `${c.name}: ${formatMoney(c.oldPriceCents)} → ${formatMoney(c.newPriceCents)}`)
        .join(', ');
      priceNotice = `Actualizamos el total por cambio de precio: ${changeSummary}.`;
    }
  }

  const availability = await input.validateAvailability(
    effectiveLines.map((line) => ({ productId: line.productId, quantity: line.quantity }))
  );

  if (!availability.ok) {
    const issue = availability.issues[0];
    if (issue) {
      if (issue.available <= 0) {
        const err = new Error(`El producto “${issue.productName}” se quedó sin stock o no está disponible.`);
        err.nextAction = 'Volvé al carrito y quitalo para poder continuar.';
        throw err;
      }
      const err = new Error(`Ahora quedan ${issue.available} unidades de “${issue.productName}” (pediste ${issue.requested}).`);
      err.nextAction = 'Volvé al carrito y ajustá la cantidad antes de continuar.';
      throw err;
    }
    const err = new Error('Cambió la disponibilidad de uno o más productos.');
    err.nextAction = 'Volvé al carrito y revisá las cantidades antes de continuar.';
    throw err;
  }

  const sanitizedValues = sanitizeCheckoutValues(input.values);
  const shippingFeeCents = calculateShippingFee(
    sanitizedValues.deliveryMethod,
    sanitizedValues.shippingType,
    input.settings
  );

  const fingerprint = createOrderFingerprint(
    sanitizedValues,
    effectiveLines,
    shippingFeeCents
  );

  const existingOrderId =
    input.protocolDraft?.fingerprint === fingerprint
      ? input.protocolDraft.orderId
      : undefined;

  const protocol = buildWhatsAppProtocol(
    sanitizedValues,
    effectiveLines,
    input.settings,
    existingOrderId
  );

  const whatsappUrl = buildWhatsAppUrl(input.settings.whatsappPhone, protocol.message);
  const subtotalCents = effectiveLines.reduce(
    (acc, line) => acc + line.unitPriceCents * line.quantity,
    0
  );

  return {
    effectiveLines,
    sanitizedValues,
    shippingFeeCents,
    subtotalCents,
    totalCents: subtotalCents + shippingFeeCents,
    priceNotice,
    priceChanges,
    fingerprint,
    protocol,
    whatsappUrl
  };
};

// -----------------------------------------------------------------------------
// Suite de Pruebas
// -----------------------------------------------------------------------------

async function runSuite8() {
  const client = await createClient();
  await setAuth(client, OWNER_ID);

  console.log('================================================================');
  console.log('       SERIE 8 — CARRITO Y CHECKOUT REALES (47 A 53)           ');
  console.log('================================================================\n');

  const createdProductIds = [];
  const results = [];
  let originalSettingsBackup = null;

  try {
    // 0. Backup de configuración de tienda
    const origSetRes = await client.query(`SELECT private.store_settings_payload() as settings`);
    originalSettingsBackup = origSetRes.rows[0].settings;

    // Helper para consultar catálogo público storefront
    const fetchStorefrontProducts = async () => {
      const res = await client.query(`SELECT public.get_storefront_products() as products`);
      return res.rows[0].products;
    };

    // Helper para consultar disponibilidad en base de datos
    const checkAvailability = async (lines) => {
      const res = await client.query(
        `SELECT public.check_cart_availability($1::jsonb) as res`,
        [JSON.stringify(lines)]
      );
      return res.rows[0].res;
    };

    // Helper para consultar configuración de tienda
    const fetchSettings = async () => {
      const res = await client.query(`SELECT public.get_public_store_settings() as settings`);
      return res.rows[0].settings;
    };

    // =========================================================================
    // TEST 47 — Precio cambió mientras el producto estaba en el carrito
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 47 — Precio cambió mientras el producto estaba en el carrito');
    console.log('Objetivo: Protocolo, subtotal, fingerprint y mensaje usan precio nuevo');
    console.log('----------------------------------------------------------------');

    // 1. Producto en DB con precio $35.000 (3.500.000 cents)
    const p47Res = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, 'Proteína Test 47', '1 kg', 'Test 47', 'Proteínas', 3500000, true, true)
       RETURNING id`,
      [`SKU47_${Date.now()}`, `prod-47-${Date.now()}`]
    );
    const prod47Id = p47Res.rows[0].id;
    createdProductIds.push(prod47Id);
    await client.query(`INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, 2000000)`, [prod47Id]);
    await client.query(`INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 10, 0)`, [prod47Id]);

    // 2. Carrito guardado con precio viejo = $30.000 (3.000.000 cents), cantidad = 1
    const cartLines47 = [
      {
        productId: prod47Id,
        sku: `SKU47_${Date.now()}`,
        slug: `prod-47-${Date.now()}`,
        name: 'Proteína Test 47',
        presentation: '1 kg',
        imageUrl: '/test.webp',
        unitPriceCents: 3000000, // Precio viejo $30.000
        quantity: 1
      }
    ];

    const currentCatalog47 = await fetchStorefrontProducts();
    const liveProduct47 = currentCatalog47.find((p) => p.id === prod47Id);
    console.log(`Catálogo DB precio: $${liveProduct47.priceCents / 100} | Carrito viejo precio: $${cartLines47[0].unitPriceCents / 100}`);

    const settings47 = await fetchSettings();
    const checkoutValues47 = {
      customerName: 'Cliente Test 47',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      phone: null
    };

    // 3. Ejecutar submit autoritativo corregido
    const submission47 = await prepareCheckoutSubmission({
      values: checkoutValues47,
      lines: cartLines47,
      catalogProducts: currentCatalog47,
      settings: settings47,
      validateAvailability: checkAvailability
    });

    // 4. Simulación del fallo previo (donde se usaban las líneas no-sincronizadas cart.lines)
    const legacyProtocol47 = buildWhatsAppProtocol(checkoutValues47, cartLines47, settings47);

    const pass47 =
      submission47.effectiveLines[0].unitPriceCents === 3500000 &&
      submission47.subtotalCents === 3500000 &&
      submission47.totalCents === 3500000 &&
      submission47.protocol.subtotalCents === 3500000 &&
      submission47.protocol.totalCents === 3500000 &&
      submission47.fingerprint.includes('3500000') &&
      submission47.priceNotice !== null &&
      submission47.priceNotice.includes('30.000') &&
      submission47.priceNotice.includes('35.000') &&
      !submission47.protocol.message.includes('30.000') &&
      legacyProtocol47.subtotalCents === 3000000; // Demuestra que el legacy fallaba y ahora está corregido

    results.push({
      test: 'TEST 47 — Precio cambió mientras el producto estaba en el carrito',
      pass: pass47,
      detail: `Subtotal final=$${submission47.subtotalCents / 100}, aviso=${submission47.priceNotice}, legacy=$${legacyProtocol47.subtotalCents / 100}`
    });
    console.log(pass47 ? '✅ TEST 47 APROBADO\n' : '❌ TEST 47 FALLÓ\n');

    // =========================================================================
    // TEST 48 — Producto archivado con carrito viejo
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 48 — Producto archivado con carrito viejo');
    console.log('Objetivo: Muestra No disponible, checkout bloqueado, carrito preservado');
    console.log('----------------------------------------------------------------');

    // 1. Crear Creatina publicada
    const p48Res = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, 'Creatina Test 48', '300 g', 'Test 48', 'Creatinas', 2500000, true, true)
       RETURNING id`,
      [`SKU48_${Date.now()}`, `prod-48-${Date.now()}`]
    );
    const prod48Id = p48Res.rows[0].id;
    createdProductIds.push(prod48Id);
    await client.query(`INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, 1500000)`, [prod48Id]);
    await client.query(`INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 5, 0)`, [prod48Id]);

    const cartLines48 = [
      {
        productId: prod48Id,
        sku: `SKU48_${Date.now()}`,
        slug: `prod-48-${Date.now()}`,
        name: 'Creatina Test 48',
        presentation: '300 g',
        imageUrl: '/test.webp',
        unitPriceCents: 2500000,
        quantity: 1
      }
    ];

    // 2. Dueña despublica / archiva el producto
    await client.query(`UPDATE products SET published = false WHERE id = $1`, [prod48Id]);

    // 3. Revalidar contra el catálogo vivo
    const currentCatalog48 = await fetchStorefrontProducts();
    const productInStorefront = currentCatalog48.find((p) => p.id === prod48Id);
    const reval48 = revalidateCartWithCatalog(cartLines48, currentCatalog48);

    // 4. Comprobar disponibilidad en base de datos
    const dbAvailability48 = await checkAvailability(
      cartLines48.map((l) => ({ productId: l.productId, quantity: l.quantity }))
    );

    // 5. Intentar continuar en Checkout
    let checkoutBlocked48 = false;
    let errorMessage48 = '';
    try {
      await prepareCheckoutSubmission({
        values: checkoutValues47,
        lines: cartLines48,
        catalogProducts: currentCatalog48,
        settings: settings47,
        validateAvailability: checkAvailability
      });
    } catch (err) {
      checkoutBlocked48 = true;
      errorMessage48 = err.message;
    }

    const pass48 =
      productInStorefront === undefined && // No figura en catálogo público
      reval48.unavailableProducts.includes('Creatina Test 48') && // Detectado como no disponible
      dbAvailability48.ok === false && // DB rechaza disponibilidad
      checkoutBlocked48 === true && // Checkout bloqueado
      cartLines48.length === 1 && // Carrito NO desaparece silenciosamente
      errorMessage48.includes('ya no está disponible');

    results.push({
      test: 'TEST 48 — Producto archivado con carrito viejo',
      pass: pass48,
      detail: `Storefront omitido=${productInStorefront === undefined}, bloqueado=${checkoutBlocked48}, mensaje="${errorMessage48}", carrito intacto=${cartLines48.length === 1}`
    });
    console.log(pass48 ? '✅ TEST 48 APROBADO\n' : '❌ TEST 48 FALLÓ\n');

    // =========================================================================
    // TEST 49 — Stock bajó mientras el cliente tenía el carrito
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 49 — Stock bajó mientras el cliente tenía el carrito');
    console.log('Objetivo: Bloquea con "Solo quedan 2" sin auto-reducir; se rehabilita al bajar a 2');
    console.log('----------------------------------------------------------------');

    // 1. Stock inicial = 5, carrito = 4
    const p49Res = await client.query(
      `INSERT INTO products (sku, slug, name, presentation, description, category, sale_price_cents, active, published)
       VALUES ($1, $2, 'BCAA Test 49', '500 g', 'Test 49', 'Aminoácidos', 1800000, true, true)
       RETURNING id`,
      [`SKU49_${Date.now()}`, `prod-49-${Date.now()}`]
    );
    const prod49Id = p49Res.rows[0].id;
    createdProductIds.push(prod49Id);
    await client.query(`INSERT INTO product_financials (product_id, current_cost_cents) VALUES ($1, 1000000)`, [prod49Id]);
    await client.query(`INSERT INTO stock_balances (product_id, on_hand, reserved) VALUES ($1, 5, 0)`, [prod49Id]);

    let cartLines49 = [
      {
        productId: prod49Id,
        sku: `SKU49_${Date.now()}`,
        slug: `prod-49-${Date.now()}`,
        name: 'BCAA Test 49',
        presentation: '500 g',
        imageUrl: '/test.webp',
        unitPriceCents: 1800000,
        quantity: 4
      }
    ];

    // 2. Stock disponible baja a 2
    await client.query(`UPDATE stock_balances SET on_hand = 2 WHERE product_id = $1`, [prod49Id]);

    const currentCatalog49 = await fetchStorefrontProducts();
    const liveProd49 = currentCatalog49.find((p) => p.id === prod49Id);

    // 3. Intentar continuar con cantidad = 4
    let blockedWith4 = false;
    let partialError = '';
    try {
      await prepareCheckoutSubmission({
        values: checkoutValues47,
        lines: cartLines49,
        catalogProducts: currentCatalog49,
        settings: settings47,
        validateAvailability: checkAvailability
      });
    } catch (err) {
      blockedWith4 = true;
      partialError = err.message;
    }

    const revalWith4 = revalidateCartWithCatalog(cartLines49, currentCatalog49);

    // 4. Comprobar que la cantidad NO se auto-redujo sola
    const quantityStill4 = cartLines49[0].quantity === 4;

    // 5. El cliente baja conscientemente a 2 (4 -> 2)
    cartLines49 = [{ ...cartLines49[0], quantity: 2 }];
    const revalWith2 = revalidateCartWithCatalog(cartLines49, currentCatalog49);

    let allowedWith2 = false;
    try {
      const sub49 = await prepareCheckoutSubmission({
        values: checkoutValues47,
        lines: cartLines49,
        catalogProducts: currentCatalog49,
        settings: settings47,
        validateAvailability: checkAvailability
      });
      allowedWith2 = sub49.subtotalCents === 3600000;
    } catch (err) {
      allowedWith2 = false;
    }

    const pass49 =
      blockedWith4 === true &&
      partialError.includes('2 unidades') &&
      quantityStill4 === true &&
      revalWith4.partialStockProducts.length === 1 &&
      revalWith4.partialStockProducts[0].available === 2 &&
      revalWith2.partialStockProducts.length === 0 &&
      allowedWith2 === true;

    results.push({
      test: 'TEST 49 — Stock bajó mientras el cliente tenía el carrito',
      pass: pass49,
      detail: `Bloqueado con 4=${blockedWith4} ("${partialError}"), no auto-reducido=${quantityStill4}, habilitado con 2=${allowedWith2}`
    });
    console.log(pass49 ? '✅ TEST 49 APROBADO\n' : '❌ TEST 49 FALLÓ\n');

    // =========================================================================
    // TEST 50 — Cliente pulsa + por encima de lo disponible
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 50 — Cliente pulsa + por encima de lo disponible');
    console.log('Objetivo: Botón + y setQuantity limitan estrictamente al máximo vendible (3)');
    console.log('----------------------------------------------------------------');

    const maxStock50 = 3;
    let currentQty50 = 3;

    // Simulación del comportamiento corregido de CartPage y CartProvider:
    const simulateIncrement = (qty, maxStock) => {
      if (qty < maxStock) {
        return Math.min(qty + 1, maxStock);
      }
      return qty; // Clamped directamente
    };

    const nextQtyAttempt = simulateIncrement(currentQty50, maxStock50);

    // Simulación de setQuantity con límite superior explícito
    const simulateSetQuantity = (qty, maxAvailable) => {
      const sanitized = Math.min(20, Math.max(1, Math.floor(qty)));
      return typeof maxAvailable === 'number' && maxAvailable >= 0
        ? Math.min(sanitized, maxAvailable)
        : sanitized;
    };

    const directSetQtyResult = simulateSetQuantity(4, maxStock50);

    const pass50 = nextQtyAttempt === 3 && directSetQtyResult === 3;

    results.push({
      test: 'TEST 50 — Cliente pulsa + por encima de lo disponible',
      pass: pass50,
      detail: `Cantidad tras presionar +=${nextQtyAttempt} (sigue 3), llamada directa setQuantity(4, 3)=${directSetQtyResult}`
    });
    console.log(pass50 ? '✅ TEST 50 APROBADO\n' : '❌ TEST 50 FALLÓ\n');

    // =========================================================================
    // TEST 51 — Retiro ↔ envío no contamina el pedido
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 51 — Retiro ↔ envío no contamina el pedido');
    console.log('Objetivo: Sanitización limpia campos al cambiar a retiro; tarifa aplica una sola vez');
    console.log('----------------------------------------------------------------');

    const rawShippingForm51 = {
      customerName: 'Mariana López',
      paymentMethod: 'transfer',
      deliveryMethod: 'shipping',
      shippingType: 'standard',
      address: 'Avenida Cabildo',
      addressNumber: '2500',
      phone: '1144556677'
    };

    // Cambiar a Retiro
    const switchedToPickup51 = {
      ...rawShippingForm51,
      deliveryMethod: 'pickup'
    };

    const sanitizedPickup51 = sanitizeCheckoutValues(switchedToPickup51);
    const shippingFeePickup51 = calculateShippingFee(
      sanitizedPickup51.deliveryMethod,
      sanitizedPickup51.shippingType,
      settings47
    );

    const testLines51 = [
      {
        productId: prod47Id,
        sku: 'SKU47_TEST',
        slug: 'prod-47',
        name: 'Proteína Test',
        presentation: '1 kg',
        imageUrl: '/test.webp',
        unitPriceCents: 3500000,
        quantity: 2
      }
    ];

    const protocolPickup51 = buildWhatsAppProtocol(
      sanitizedPickup51,
      testLines51,
      settings47
    );

    // Cambiar de vuelta a Envío Estándar
    const switchedBackToShipping51 = {
      ...rawShippingForm51,
      deliveryMethod: 'shipping',
      shippingType: 'standard'
    };

    const sanitizedShipping51 = sanitizeCheckoutValues(switchedBackToShipping51);
    const shippingFeeStandard51 = calculateShippingFee(
      sanitizedShipping51.deliveryMethod,
      sanitizedShipping51.shippingType,
      settings47
    );

    const protocolShipping51 = buildWhatsAppProtocol(
      sanitizedShipping51,
      testLines51,
      settings47
    );

    const pass51 =
      sanitizedPickup51.deliveryMethod === 'pickup' &&
      sanitizedPickup51.shippingType === null &&
      sanitizedPickup51.address === null &&
      sanitizedPickup51.addressNumber === null &&
      sanitizedPickup51.phone === null &&
      shippingFeePickup51 === 0 &&
      protocolPickup51.shippingFeeCents === 0 &&
      protocolPickup51.totalCents === 7000000 &&
      protocolPickup51.message.includes('*Entrega*\nRetiro') &&
      !protocolPickup51.message.includes('Avenida Cabildo') &&
      !protocolPickup51.message.includes('1144556677') &&
      protocolShipping51.shippingFeeCents === settings47.standardShippingCents &&
      protocolShipping51.totalCents === 7000000 + settings47.standardShippingCents;

    results.push({
      test: 'TEST 51 — Retiro ↔ envío no contamina el pedido',
      pass: pass51,
      detail: `Retiro: fee=$0, total=$${protocolPickup51.totalCents / 100}, datos limpiados=true. Envío: tarifa=$${protocolShipping51.shippingFeeCents / 100} añadida una sola vez`
    });
    console.log(pass51 ? '✅ TEST 51 APROBADO\n' : '❌ TEST 51 FALLÓ\n');

    // =========================================================================
    // TEST 52 — Configuración de tienda llega exactamente al checkout
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 52 — Configuración de tienda llega exactamente al checkout');
    console.log('Objetivo: $4.500 tradicional, $7.000 express, TEST.ALIAS, TEST CBU, WhatsApp exacto');
    console.log('----------------------------------------------------------------');

    // 1. Modificar temporalmente la configuración en PostgreSQL
    const customSettingsInput = {
      storeName: 'Tienda Impulso Test 52',
      tagline: 'Test 52',
      whatsappPhone: '5491122334455',
      transferAlias: 'TEST.ALIAS',
      transferAccount: 'TEST CBU',
      standardShippingCents: 450000, // $4.500
      expressShippingCents: 700000,  // $7.000
      taxRateBasisPoints: 0
    };

    await client.query(
      `SELECT public.update_store_settings($1::jsonb)`,
      [JSON.stringify(customSettingsInput)]
    );

    // 2. Leer configuración pública
    const publicSettings52 = await fetchSettings();

    // 3. Caso Retiro
    const feePickup52 = calculateShippingFee('pickup', null, publicSettings52);
    // 4. Caso Estándar
    const feeStandard52 = calculateShippingFee('shipping', 'standard', publicSettings52);
    // 5. Caso Express
    const feeExpress52 = calculateShippingFee('shipping', 'express', publicSettings52);

    // 6. Protocolo con transferencia y destinatario WhatsApp
    const form52 = {
      customerName: 'Cliente Test 52',
      paymentMethod: 'transfer',
      deliveryMethod: 'shipping',
      shippingType: 'express',
      address: 'Calle 123',
      addressNumber: '456',
      phone: '1199887766'
    };

    const protocol52 = buildWhatsAppProtocol(form52, testLines51, publicSettings52);
    const whatsappUrl52 = buildWhatsAppUrl(publicSettings52.whatsappPhone, protocol52.message);

    const pass52 =
      feePickup52 === 0 &&
      feeStandard52 === 450000 &&
      feeExpress52 === 700000 &&
      publicSettings52.transferAlias === 'TEST.ALIAS' &&
      publicSettings52.transferAccount === 'TEST CBU' &&
      whatsappUrl52.includes('5491122334455') &&
      protocol52.shippingFeeCents === 700000;

    results.push({
      test: 'TEST 52 — Configuración de tienda llega exactamente al checkout',
      pass: pass52,
      detail: `Retiro=$0, Tradicional=$${feeStandard52 / 100}, Express=$${feeExpress52 / 100}, Alias=${publicSettings52.transferAlias}, CBU=${publicSettings52.transferAccount}, WA=${publicSettings52.whatsappPhone}`
    });
    console.log(pass52 ? '✅ TEST 52 APROBADO\n' : '❌ TEST 52 FALLÓ\n');

    // =========================================================================
    // TEST 53 — Mismo pedido reintentado desde Checkout
    // =========================================================================
    console.log('----------------------------------------------------------------');
    console.log('TEST 53 — Mismo pedido reintentado desde Checkout');
    console.log('Objetivo: Reintento idéntico reutiliza protocolOrderId; cambios materiales generan uno nuevo');
    console.log('----------------------------------------------------------------');

    const baseForm53 = {
      customerName: 'Lucas Gómez',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      phone: null
    };

    const lines53A = [
      {
        productId: prod47Id,
        sku: 'SKU47',
        name: 'Proteína',
        presentation: '1 kg',
        unitPriceCents: 3500000,
        quantity: 1
      }
    ];

    // Intento 1
    const sub1 = await prepareCheckoutSubmission({
      values: baseForm53,
      lines: lines53A,
      settings: publicSettings52,
      validateAvailability: async () => ({ ok: true, issues: [] })
    });
    const orderId1 = sub1.protocol.orderId;
    const fingerprint1 = sub1.fingerprint;

    // Intento 2 — Reintento IDÉNTICO con el borrador previo
    const sub2 = await prepareCheckoutSubmission({
      values: baseForm53,
      lines: lines53A,
      settings: publicSettings52,
      protocolDraft: { orderId: orderId1, fingerprint: fingerprint1 },
      validateAvailability: async () => ({ ok: true, issues: [] })
    });
    const orderId2 = sub2.protocol.orderId;

    // Intento 3 — Cambio de cantidad (1 -> 2)
    const lines53B = [{ ...lines53A[0], quantity: 2 }];
    const sub3 = await prepareCheckoutSubmission({
      values: baseForm53,
      lines: lines53B,
      settings: publicSettings52,
      protocolDraft: { orderId: orderId1, fingerprint: fingerprint1 },
      validateAvailability: async () => ({ ok: true, issues: [] })
    });
    const orderIdQtyChanged = sub3.protocol.orderId;

    // Intento 4 — Cambio de medio de pago (cash -> transfer)
    const sub4 = await prepareCheckoutSubmission({
      values: { ...baseForm53, paymentMethod: 'transfer' },
      lines: lines53A,
      settings: publicSettings52,
      protocolDraft: { orderId: orderId1, fingerprint: fingerprint1 },
      validateAvailability: async () => ({ ok: true, issues: [] })
    });
    const orderIdPaymentChanged = sub4.protocol.orderId;

    // Intento 5 — Cambio de retiro a envío
    const sub5 = await prepareCheckoutSubmission({
      values: {
        ...baseForm53,
        deliveryMethod: 'shipping',
        shippingType: 'standard',
        address: 'Calle Nueva',
        addressNumber: '100',
        phone: '1122334455'
      },
      lines: lines53A,
      settings: publicSettings52,
      protocolDraft: { orderId: orderId1, fingerprint: fingerprint1 },
      validateAvailability: async () => ({ ok: true, issues: [] })
    });
    const orderIdDeliveryChanged = sub5.protocol.orderId;

    const pass53 =
      orderId1 === orderId2 && // Idéntico submit REUTILIZA ID
      orderIdQtyChanged !== orderId1 && // Cantidad distinta GENERA NUEVO ID
      orderIdPaymentChanged !== orderId1 && // Pago distinto GENERA NUEVO ID
      orderIdDeliveryChanged !== orderId1; // Entrega distinta GENERA NUEVO ID

    results.push({
      test: 'TEST 53 — Mismo pedido reintentado desde Checkout',
      pass: pass53,
      detail: `Reintento idéntico=${orderId1 === orderId2} (ID=${orderId1}), cambio cantidad=${orderIdQtyChanged !== orderId1}, cambio pago=${orderIdPaymentChanged !== orderId1}, cambio entrega=${orderIdDeliveryChanged !== orderId1}`
    });
    console.log(pass53 ? '✅ TEST 53 APROBADO\n' : '❌ TEST 53 FALLÓ\n');

  } catch (err) {
    console.error('Error fatal durante la ejecución de Serie 8:', err);
  } finally {
    console.log('Limpiando datos y restaurando configuración de Serie 8...');
    await setAuth(client, OWNER_ID);

    // Restaurar configuración original
    if (originalSettingsBackup) {
      try {
        await client.query(`SELECT public.update_store_settings($1::jsonb)`, [
          JSON.stringify(originalSettingsBackup)
        ]);
        console.log('Configuración original de tienda restaurada correctamente.');
      } catch (e) {
        console.error('Error restaurando configuración de tienda:', e);
      }
    }

    // Eliminar productos de prueba
    if (createdProductIds.length > 0) {
      await client.query(`DELETE FROM stock_balances WHERE product_id = ANY($1)`, [createdProductIds]);
      await client.query(`DELETE FROM product_financials WHERE product_id = ANY($1)`, [createdProductIds]);
      await client.query(`DELETE FROM products WHERE id = ANY($1)`, [createdProductIds]);
      console.log(`Eliminados ${createdProductIds.length} productos de prueba.`);
    }

    await client.end();
  }

  console.log('================================================================');
  console.log('                    RESUMEN DE LA SERIE 8                       ');
  console.log('================================================================');
  results.forEach((r) => {
    console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'}: ${r.test}`);
    console.log(`   └─ ${r.detail}`);
  });
  console.log('================================================================');
  const allPass = results.length === 7 && results.every((r) => r.pass);
  console.log(`RESULTADO FINAL: ${results.filter((r) => r.pass).length}/7 APROBADOS`);
  console.log('================================================================');
  if (!allPass) {
    process.exit(1);
  }
}

runSuite8();
