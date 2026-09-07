import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { loadEnv } from 'vite';
import {
  PROJECT_ROOT,
  SUPABASE_PROJECT_REF,
  SUPABASE_PROJECT_REGION
} from '../scripts/project-targets.mjs';

const fileEnv = loadEnv('production', PROJECT_ROOT, '');
const password = (process.env.SUPABASE_DB_PASSWORD || fileEnv.SUPABASE_DB_PASSWORD)?.trim();
const adminEmail = (process.env.E2E_EMAIL || fileEnv.E2E_EMAIL)?.trim() || 'juanpabloaltamira@protonmail.com';
const adminPassword = (process.env.E2E_PASSWORD || fileEnv.E2E_PASSWORD)?.trim() || '456546544';

const OWNER_USER_ID = 'cded5daf-3e27-4f6b-86dd-a514fac1cd28';

test.describe('E2E Real: Ciclo de Vida de Stock Entrante (Cliente a Entrega y Ventas)', () => {
  let dbClient: Client;
  let testProductId: string;
  let testPurchaseId: string;
  let testSku: string;
  let testSlug: string;
  let createdOrderId: string | null = null;
  let createdOrderNumber: number | null = null;

  test.beforeAll(async () => {
    if (!password) {
      throw new Error('SUPABASE_DB_PASSWORD no está disponible para configurar el fixture E2E.');
    }

    dbClient = new Client({
      host: `aws-0-${SUPABASE_PROJECT_REGION}.pooler.supabase.com`,
      port: 5432,
      database: 'postgres',
      user: `postgres.${SUPABASE_PROJECT_REF}`,
      password,
      ssl: { rejectUnauthorized: false }
    });

    await dbClient.connect();
    await dbClient.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_USER_ID]);

    const timestamp = Date.now();
    testSku = `E2E-LC-${timestamp}`;
    testSlug = `whey-e2e-lc-${timestamp}`;

    // 1. Guardar producto con precio $20.000 y costo $10.000
    const prodRes = await dbClient.query(`
      select public.save_product($1::jsonb) as prod
    `, [JSON.stringify({
      sku: testSku,
      slug: testSlug,
      name: `Whey E2E Lifecycle ${testSku}`,
      presentation: '1 kg',
      description: 'Producto para prueba E2E de ciclo de vida completo.',
      category: 'Proteínas',
      priceCents: 2000000,
      currentCostCents: 1000000,
      reorderPoint: 2,
      safetyStock: 1,
      leadTimeDays: 3,
      imageUrl: '/demo/whey.svg',
      imageAlt: 'Whey E2E Lifecycle',
      published: true,
      active: true,
      featured: false
    })]);

    testProductId = prodRes.rows[0].prod.id;

    // 2. Stock físico: 2 unidades
    await dbClient.query('update public.stock_balances set on_hand = 2 where product_id = $1', [testProductId]);

    // 3. Compra entrante en camino: 3 unidades
    const purchRes = await dbClient.query(`
      select public.create_purchase($1::jsonb) as purch
    `, [JSON.stringify({
      supplierName: `Distribuidor Central E2E ${timestamp}`,
      orderedAt: new Date().toISOString(),
      expectedAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      notes: 'Compra entrante para ciclo E2E',
      items: [
        { productId: testProductId, quantity: 3, unitCostCents: 1000000 }
      ]
    })]);

    testPurchaseId = purchRes.rows[0].purch.id;

    // 4. Validar que la tienda pública calcula 5 unidades vendibles (2 físicas + 3 entrantes)
    const sfCheck = await dbClient.query('select public.get_storefront_product($1) as p', [testSlug]);
    const sfProd = sfCheck.rows[0].p;
    expect(sfProd.maxOrderQuantity).toBe(5);
    expect(sfProd.incomingAvailable).toBe(3);
  });

  test.afterAll(async () => {
    if (dbClient) {
      try {
        await dbClient.query("select set_config('request.jwt.claim.sub', $1, false)", [OWNER_USER_ID]);

        if (createdOrderId) {
          await dbClient.query('delete from public.stock_movements where order_id = $1', [createdOrderId]);
          await dbClient.query('delete from public.stock_reservations where order_id = $1', [createdOrderId]);
          await dbClient.query('delete from public.order_items where order_id = $1', [createdOrderId]);
          await dbClient.query('delete from public.orders where id = $1', [createdOrderId]);
        }

        if (testProductId) {
          await dbClient.query('delete from public.stock_movements where purchase_id = $1 or product_id = $2', [testPurchaseId, testProductId]);
          await dbClient.query('delete from public.stock_reservations where product_id = $1', [testProductId]);
          await dbClient.query('delete from public.order_items where product_id = $1', [testProductId]);
          await dbClient.query('delete from public.purchase_receipts where purchase_id = $1', [testPurchaseId]);
          await dbClient.query('delete from public.purchase_items where product_id = $1', [testProductId]);
          await dbClient.query('delete from public.purchases where id = $1', [testPurchaseId]);
          await dbClient.query('delete from public.product_financials where product_id = $1', [testProductId]);
          await dbClient.query('delete from public.stock_balances where product_id = $1', [testProductId]);
          await dbClient.query('delete from public.products where id = $1', [testProductId]);
        }
      } catch (cleanupErr) {
        console.warn('Error durante el cleanup de la prueba E2E:', cleanupErr);
      } finally {
        await dbClient.end();
      }
    }
  });

  test('Recorrido completo: Storefront 5 u. -> Carrito ETA -> WhatsApp -> Importar -> Bloqueado -> Recibir 1 -> Sigue Bloqueado -> Recibir 2 -> Entregar -> Ventas', async ({ page }) => {
    test.setTimeout(120000);

    // Preparar intercepción de WhatsApp desde el inicio del contexto de página
    let capturedWhatsAppUrl = '';
    await page.route(/^https:\/\/(api\.whatsapp\.com|web\.whatsapp\.com|wa\.me)\//, (route) => {
      capturedWhatsAppUrl = route.request().url();
      void route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>WhatsApp Intercepted</body></html>'
      });
    });

    const setupFakeOpen = () => {
      (window as any).__lastCapturedWhatsAppUrl = '';
      const fakeWin = {
        location: {
          _href: '',
          set href(val: string) {
            this._href = val;
            if (val && val !== 'about:blank') {
              (window as any).__lastCapturedWhatsAppUrl = val;
            }
          },
          get href() {
            return this._href;
          }
        },
        close: () => {}
      };
      window.open = (url) => {
        if (typeof url === 'string' && url !== 'about:blank') {
          (window as any).__lastCapturedWhatsAppUrl = url;
        }
        return fakeWin as any;
      };
    };

    await page.addInitScript(setupFakeOpen);

    // -------------------------------------------------------------------------
    // PASO 1: Navegación a Storefront y selección de 5 unidades (2 físicas + 3 entrantes)
    // -------------------------------------------------------------------------
    await page.goto(`/producto/${testSlug}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Whey E2E Lifecycle ${testSku}`);

    // Sumamos unidades hasta llegar a 5
    const plusBtn = page.getByRole('button', { name: /sumar una unidad/i });
    for (let i = 0; i < 4; i++) {
      await plusBtn.click();
      await page.waitForTimeout(100);
    }

    const addToCartBtn = page.getByRole('button', { name: /agregar al carrito/i });
    await addToCartBtn.click();
    await expect(page.getByRole('button', { name: /agregado al carrito/i })).toBeVisible();

    // -------------------------------------------------------------------------
    // PASO 2: Carrito y verificación del aviso "En camino / reposición" con ETA
    // -------------------------------------------------------------------------
    await page.goto('/carrito');
    await expect(page.getByRole('heading', { name: /carrito/i })).toBeVisible();
    await expect(page.getByText(`Whey E2E Lifecycle ${testSku}`)).toBeVisible();

    // Verificamos el banner de reposición / en camino
    const etaBanner = page.locator('aside').getByText(/incluye productos en reposición|reposición/i);
    await expect(etaBanner).toBeVisible();

    // -------------------------------------------------------------------------
    // PASO 3: Checkout y generación del mensaje de WhatsApp
    // -------------------------------------------------------------------------
    const continueBtn = page.getByRole('link', { name: /continuar/i });
    await continueBtn.click();
    await expect(page).toHaveURL(/\/checkout/);

    // Reasegurar interceptor en el contexto activo de checkout
    await page.evaluate(setupFakeOpen);

    // Completar datos mínimos requeridos
    await page.locator('#customerName').fill('Santiago E2E Lifecycle');

    capturedWhatsAppUrl = '';
    await page.route(/whatsapp\.com|wa\.me/, (route) => {
      capturedWhatsAppUrl = route.request().url();
      void route.abort();
    });

    const submitCheckoutBtn = page.getByRole('button', { name: /continuar por whatsapp/i });
    await submitCheckoutBtn.click();

    // Esperar captura de la URL definitiva de WhatsApp (window.open en desktop o page.route en mobile)
    for (let attempt = 0; attempt < 30; attempt++) {
      if (capturedWhatsAppUrl) break;
      const u = await page.evaluate(() => (window as any).__lastCapturedWhatsAppUrl || '').catch(() => '');
      if (u.includes('whatsapp.com') || u.includes('wa.me')) {
        capturedWhatsAppUrl = u;
        break;
      }
      await page.waitForTimeout(500);
    }

    const generatedUrl = capturedWhatsAppUrl;
    expect(generatedUrl).toBeTruthy();

    const parsedUrl = new URL(generatedUrl);
    const whatsappMessage = decodeURIComponent(parsedUrl.searchParams.get('text') || '');
    expect(whatsappMessage).toContain('PEDIDO IMPULSO');
    expect(whatsappMessage).toContain(testSku);
    expect(whatsappMessage).toContain('Santiago E2E Lifecycle');

    // -------------------------------------------------------------------------
    // PASO 4: Ingreso al Panel Admin y autenticación
    // -------------------------------------------------------------------------
    await page.goto('/ingresar');
    await page.locator('#email').fill(adminEmail);
    await page.locator('#password').fill(adminPassword);
    await page.getByRole('button', { name: /ingresar/i }).click();
    await page.waitForURL(/\/app/, { timeout: 15000 });

    await page.goto('/app/pedidos/importar');
    await expect(page.getByRole('heading', { name: /importar pedido/i })).toBeVisible();

    // -------------------------------------------------------------------------
    // PASO 5: Pegar protocolo, analizar y confirmar pedido en admin
    // -------------------------------------------------------------------------
    const textarea = page.locator('textarea');
    await textarea.fill(whatsappMessage);

    const analyzeBtn = page.getByRole('button', { name: /analizar y revisar pedido|analizar/i });
    await analyzeBtn.click();

    await expect(page.getByText('Santiago E2E Lifecycle')).toBeVisible();
    await expect(page.getByText(testSku)).toBeVisible();

    const confirmOrderBtn = page.getByRole('button', { name: /confirmar pedido/i });
    await confirmOrderBtn.click();

    // Pantalla de pedido confirmado
    await expect(page.getByRole('heading', { name: /pedido cargado/i, level: 1 })).toBeVisible();
    const headingOrderText = await page.getByText(/pedido #\d+/i).first().innerText();
    const orderMatch = headingOrderText.match(/#(\d+)/);
    expect(orderMatch).not.toBeNull();
    createdOrderNumber = parseInt(orderMatch![1]!, 10);

    // Obtener ID del pedido en base de datos para tracking y teardown
    const orderRow = await dbClient.query('select id, order_number as number from public.orders where order_number = $1', [createdOrderNumber]);
    createdOrderId = orderRow.rows[0].id;

    // -------------------------------------------------------------------------
    // PASO 6: Verificar en Pedidos que el pedido está en waiting_incoming y bloqueado
    // -------------------------------------------------------------------------
    await page.goto('/app/pedidos');
    await expect(page.getByRole('heading', { name: /pedidos/i })).toBeVisible();

    // Ubicamos la tarjeta del pedido
    const orderCard = page.locator('article').filter({ hasText: `#${createdOrderNumber}` }).first();
    await expect(orderCard).toBeVisible();

    // Abrimos el acordeón si no está abierto
    const expandBtn = orderCard.locator('button[aria-expanded]').first();
    if ((await expandBtn.getAttribute('aria-expanded')) !== 'true') {
      await expandBtn.click();
    }

    // Verificamos el badge / aviso de espera de reposición
    await expect(orderCard.getByText(/en camino/i).first()).toBeVisible();

    // El botón de entrega DEBE estar bloqueado / ausente
    const deliverButton = orderCard.getByRole('button', { name: /marcar como entregado/i });
    await expect(deliverButton).toHaveCount(0);

    // -------------------------------------------------------------------------
    // PASO 7: Inventario -> Recepción Parcial de 1 unidad
    // -------------------------------------------------------------------------
    await page.goto('/app/inventario');
    await expect(page.getByRole('heading', { name: /inventario/i })).toBeVisible();

    // Cambiamos a la pestaña de compras al proveedor
    const purchasesTabBtn = page.getByRole('button', { name: /compras/i });
    await purchasesTabBtn.click();

    // Ubicamos la compra
    const purchaseArticle = page.locator('article').filter({ hasText: `Distribuidor Central E2E` }).first();
    await expect(purchaseArticle).toBeVisible();

    const receiveBtn = purchaseArticle.getByRole('button', { name: /recibir mercadería/i });
    await receiveBtn.click();

    // Modal de recepción
    const modalTitle = page.getByRole('heading', { name: /recepción de compra/i });
    await expect(modalTitle).toBeVisible();

    // Seteamos cantidad a recibir: 1 (recepción parcial de 1 de 3)
    const qtyInput = page.locator(`input[id^="receive-qty-"]`).first();
    await qtyInput.fill('1');

    // Confirmamos la recepción de 1 unidad
    const submitReceiveBtn = page.getByRole('button', { name: /ingresar 1 unidades/i });
    await submitReceiveBtn.click();

    // El modal debe cerrarse
    await expect(modalTitle).toBeHidden();

    // -------------------------------------------------------------------------
    // PASO 8: Verificar que Pedidos SIGUE BLOQUEADO tras recepción parcial
    // -------------------------------------------------------------------------
    await page.goto('/app/pedidos');
    const orderCardAfterPartial = page.locator('article').filter({ hasText: `#${createdOrderNumber}` }).first();
    await expect(orderCardAfterPartial).toBeVisible();

    const expandBtnAfterPartial = orderCardAfterPartial.locator('button[aria-expanded]').first();
    if ((await expandBtnAfterPartial.getAttribute('aria-expanded')) !== 'true') {
      await expandBtnAfterPartial.click();
    }

    // El pedido SIGUE en espera con badge en camino y sin botón de entrega
    await expect(orderCardAfterPartial.getByText(/en camino/i).first()).toBeVisible();
    await expect(orderCardAfterPartial.getByRole('button', { name: /marcar como entregado/i })).toHaveCount(0);

    // -------------------------------------------------------------------------
    // PASO 9: Inventario -> Recepción de las 2 unidades restantes
    // -------------------------------------------------------------------------
    await page.goto('/app/inventario');
    await page.getByRole('button', { name: /compras/i }).click();

    const purchaseArticleRest = page.locator('article').filter({ hasText: `Distribuidor Central E2E` }).first();
    await expect(purchaseArticleRest).toBeVisible();
    await purchaseArticleRest.getByRole('button', { name: /recibir mercadería/i }).click();

    await expect(page.getByRole('heading', { name: /recepción de compra/i })).toBeVisible();

    // El modal debe proponer las 2 unidades restantes pendientes
    const submitRemainingBtn = page.getByRole('button', { name: /ingresar 2 unidades/i });
    await submitRemainingBtn.click();
    await expect(page.getByRole('heading', { name: /recepción de compra/i })).toBeHidden();

    // -------------------------------------------------------------------------
    // PASO 10: Pedidos -> Desbloqueo automático a ready y entrega
    // -------------------------------------------------------------------------
    await page.goto('/app/pedidos');
    const orderCardReady = page.locator('article').filter({ hasText: `#${createdOrderNumber}` }).first();
    await expect(orderCardReady).toBeVisible();

    const expandBtnReady = orderCardReady.locator('button[aria-expanded]').first();
    if ((await expandBtnReady.getAttribute('aria-expanded')) !== 'true') {
      await expandBtnReady.click();
    }

    // El aviso de bloqueo ya NO debe estar
    await expect(orderCardReady.getByText(/en camino/i)).toHaveCount(0);

    // El botón de entrega AHORA SÍ está habilitado
    const markDeliveredBtn = orderCardReady.getByRole('button', { name: /marcar como entregado/i });
    await expect(markDeliveredBtn).toBeVisible();

    // Marcamos como cobrado primero si está pendiente de cobro
    const markPaidBtn = orderCardReady.getByRole('button', { name: /marcar como cobrado/i });
    if (await markPaidBtn.isVisible()) {
      await markPaidBtn.click();
      await page.waitForTimeout(500);
    }

    // Marcamos como entregado
    await markDeliveredBtn.click();
    await page.waitForTimeout(800);

    // Cambiamos al filtro "Completados" para verificar el pedido completado
    const completedFilterBtn = page.getByRole('button', { name: /completados/i });
    await completedFilterBtn.click();

    const deliveredCard = page.locator('article').filter({ hasText: `#${createdOrderNumber}` }).first();
    await expect(deliveredCard).toBeVisible();
    await expect(deliveredCard.getByText(/entregado/i).first()).toBeVisible();

    // -------------------------------------------------------------------------
    // PASO 11: Módulo de Ventas -> Costo y Margen correctos
    // -------------------------------------------------------------------------
    await page.goto('/app/ventas');
    await expect(page.getByRole('heading', { name: /ventas|analíticas/i }).first()).toBeVisible();

    // Buscamos la fila del pedido
    const salesTable = page.locator('table');
    await expect(salesTable).toBeVisible();

    const orderRowInSales = salesTable.locator('tr').filter({ hasText: `#${createdOrderNumber}` }).first();
    await expect(orderRowInSales).toBeVisible();

    // Verificamos que contenga el cliente y los números correctos:
    // Total: 5 u. * $20.000 = $100.000
    // Costo: 5 u. * $10.000 = $50.000
    const rowText = (await orderRowInSales.innerText()).replace(/\u00a0/g, ' ');
    expect(rowText).toContain('Santiago E2E Lifecycle');
    expect(rowText).toMatch(/100\.000/);
    expect(rowText).toMatch(/50\.000/);
  });
});
