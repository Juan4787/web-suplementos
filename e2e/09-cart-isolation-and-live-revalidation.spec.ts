import { test, expect } from '@playwright/test';
import { parseWhatsAppProtocol } from '../src/domain/whatsapp';

test.describe('Pilar 1: Aislamiento entre BrowserContexts, 0 mutaciones y Revalidación en vivo', () => {
  test('Aislamiento total: Contexto A expira a las 24h con 0 mutaciones de red, mientras Contexto B permanece intacto', async ({
    browser
  }) => {
    // 1. Crear Contexto A
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();

    // Espiar que Contexto A no envíe ninguna mutación (POST, PUT, PATCH, DELETE)
    const mutationRequestsA: string[] = [];
    pageA.on('request', (request) => {
      const method = request.method();
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        mutationRequestsA.push(`${method} ${request.url()}`);
      }
    });

    // Cargar producto en Contexto A
    await pageA.goto('/');
    const firstProductLinkA = pageA.locator('article a[href^="/producto/"]').first();
    await firstProductLinkA.click();
    await pageA.getByRole('button', { name: /agregar al carrito/i }).click();
    await pageA.goto('/carrito');
    await expect(pageA.locator('article')).toHaveCount(1);

    // 2. Crear Contexto B (completamente aislado)
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    await pageB.goto('/');
    const productLinksB = pageB.locator('article a[href^="/producto/"]');
    await productLinksB.nth(1).click();
    // Sumar una unidad extra
    const plusBtnB = pageB.getByRole('button', { name: /sumar una unidad/i });
    if (await plusBtnB.isVisible()) {
      await plusBtnB.click();
    }
    await pageB.getByRole('button', { name: /agregar al carrito/i }).click();
    await pageB.goto('/carrito');
    await expect(pageB.locator('article')).toHaveCount(1);

    // 3. Forzar expiración (> 24h) exclusivamente en Contexto A
    await pageA.evaluate(() => {
      const stored = localStorage.getItem('impulso-cart-v2');
      if (stored) {
        const parsed = JSON.parse(stored);
        parsed.lastActivityAt = Date.now() - 25 * 3600 * 1000; // 25 horas atrás
        localStorage.setItem('impulso-cart-v2', JSON.stringify(parsed));
      }
    });

    // Recargar Contexto A para activar la comprobación de expiración
    await pageA.reload();

    // Contexto A debe estar vacío y mostrar aviso de expiración de 24h
    await expect(pageA.getByText(/tu carrito está vacío/i)).toBeVisible();
    await expect(pageA.getByText(/venció después de 24 horas sin actividad/i)).toBeVisible();

    // Comprobar que expirar Contexto A NO generó ninguna mutación en la base de datos
    expect(mutationRequestsA.length).toBe(0);

    // 4. Comprobar Contexto B: DEBE PERMANECER INTACTO
    await pageB.reload();
    await expect(pageB.locator('article')).toHaveCount(1);
    await expect(pageB.getByText(/tu carrito está vacío/i)).not.toBeVisible();

    await contextA.close();
    await contextB.close();
  });

  test('Revalidación en vivo: cambio Retiro ↔ Envío sanitiza datos ocultos y nunca incluye dirección en Retiro', async ({
    page
  }) => {
    let capturedUrl = '';
    await page.route(/^https:\/\/(api\.whatsapp\.com|web\.whatsapp\.com|wa\.me)\//, (route) => {
      capturedUrl = route.request().url();
      void route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>WhatsApp Mock</body></html>'
      });
    });

    await page.addInitScript(() => {
      (window as any).__lastOpenedUrl = '';
      window.open = (url) => {
        if (typeof url === 'string') (window as any).__lastOpenedUrl = url;
        return {
          location: {
            set href(val: string) {
              (window as any).__lastOpenedUrl = val;
            },
            get href() {
              return (window as any).__lastOpenedUrl;
            }
          },
          close: () => {}
        };
      };
    });

    // 1. Agregar producto y navegar a Checkout
    await page.goto('/');
    await page.locator('article a[href^="/producto/"]').first().click();
    await page.getByRole('button', { name: /agregar al carrito/i }).click();
    await page.goto('/checkout');

    // 2. Completar nombre
    await page.locator('#customerName').fill('Florencia Peña');

    // 3. Seleccionar Envío a domicilio y completar dirección
    await page.getByRole('button', { name: /envío a domicilio/i }).click();
    await page.locator('#address').fill('Calle San Martín');
    await page.locator('#addressNumber').fill('1234');
    await page.locator('#phone').fill('1122334455');

    // 4. Cambiar a Retiro
    await page.getByRole('button', { name: /retiro/i }).click();

    // 5. Continuar por WhatsApp
    await page.getByRole('button', { name: /continuar por whatsapp/i }).click();
    await page.waitForTimeout(600);

    const openedUrl = (await page.evaluate(() => (window as any).__lastOpenedUrl)) || capturedUrl;
    expect(openedUrl).toContain('text=');

    const parsedProtocol = parseWhatsAppProtocol(
      decodeURIComponent(openedUrl.split('text=')[1] ?? '')
    );

    // Verificación estricta del protocolo
    expect(parsedProtocol.deliveryMethod).toBe('pickup');
    expect(parsedProtocol.shippingType).toBeNull();
    expect(parsedProtocol.shippingFeeCents).toBe(0);
    expect(parsedProtocol.address).toBeNull();
    expect(parsedProtocol.phone).toBeNull();
  });

  test('Estabilidad e invalidación de protocolOrderId según cambios en el pedido', async ({
    page
  }) => {
    const routedUrls: string[] = [];
    await page.route(/^https:\/\/(api\.whatsapp\.com|web\.whatsapp\.com|wa\.me)\//, (route) => {
      routedUrls.push(route.request().url());
      void route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body>WhatsApp Mock</body></html>'
      });
    });

    await page.addInitScript(() => {
      (window as any).__capturedUrls = [];
      window.open = (initialUrl) => {
        const win = {
          location: {
            set href(val: string) {
              if (val && val !== 'about:blank') {
                (window as any).__capturedUrls.push(val);
              }
            },
            get href() {
              return '';
            }
          },
          close: () => {}
        };
        if (initialUrl && initialUrl !== 'about:blank') {
          (window as any).__capturedUrls.push(initialUrl);
        }
        return win;
      };
    });

    const getUrls = async (): Promise<string[]> => {
      const windowUrls = (await page.evaluate(() => (window as any).__capturedUrls || [])) as string[];
      return [...windowUrls, ...routedUrls];
    };

    // 1. Agregar producto y hacer checkout inicial
    await page.goto('/');
    await page.locator('article a[href^="/producto/"]').first().click();
    await page.getByRole('button', { name: /agregar al carrito/i }).click();
    await page.goto('/checkout');
    await page.locator('#customerName').fill('Martín Fierro');

    // Clic inicial
    await page.getByRole('button', { name: /continuar por whatsapp/i }).click();
    await page.waitForTimeout(1400); // Espera que pase el debounce

    // Segundo clic SIN modificar nada (si navegó en mobile, vuelve a la pestaña de checkout)
    if (!page.url().includes('/checkout')) {
      await page.goto('/checkout');
    }
    await page.getByRole('button', { name: /continuar por whatsapp/i }).click();
    await page.waitForTimeout(600);

    let allUrls = await getUrls();
    expect(allUrls.length).toBeGreaterThanOrEqual(2);

    const proto1 = parseWhatsAppProtocol(decodeURIComponent(allUrls[0]!.split('text=')[1]!));
    const proto2 = parseWhatsAppProtocol(decodeURIComponent(allUrls[1]!.split('text=')[1]!));

    // Mismo pedido sin cambios debe REUTILIZAR protocolOrderId
    expect(proto1.protocolOrderId).toBe(proto2.protocolOrderId);

    // 2. Modificar cliente (si navegó en mobile, vuelve a checkout)
    if (!page.url().includes('/checkout')) {
      await page.goto('/checkout');
    }
    await page.locator('#customerName').fill('Martín Fierro Modificado');
    await page.waitForTimeout(1300); // Debounce
    await page.getByRole('button', { name: /continuar por whatsapp/i }).click();
    await page.waitForTimeout(600);

    allUrls = await getUrls();
    const proto3 = parseWhatsAppProtocol(
      decodeURIComponent(allUrls[allUrls.length - 1]!.split('text=')[1]!)
    );

    // Modificar datos DEBE generar un nuevo protocolOrderId
    expect(proto3.protocolOrderId).not.toBe(proto1.protocolOrderId);
    expect(proto3.customerName).toBe('Martín Fierro Modificado');
  });

  test('Revalidación en vivo: Alerta y bloquea si el stock disminuyó antes de abrir WhatsApp', async ({
    page
  }) => {
    // 1. Agregar producto al carrito (3 unidades)
    await page.goto('/');
    await page.locator('article a[href^="/producto/"]').first().click();
    await page.waitForURL(/\/producto\//);

    const plusBtn = page.getByRole('button', { name: 'Sumar una unidad' });
    await plusBtn.click();
    await plusBtn.click();

    await page.getByRole('button', { name: /agregar al carrito/i }).click();
    await page.goto('/checkout');
    await page.locator('#customerName').fill('Gonzalo Valenzuela');

    // 2. Simular reducción de stock en tiempo real antes de abrir WhatsApp
    await page.evaluate(async () => {
      const api = await (window as any).__getBusinessApi();
      const inventory = await api.listInventory();
      const item = inventory.find((i: any) => i.name.includes('Creatina') || i.available >= 3);
      if (item) {
        // Reducir el stock disponible a solo 1 unidad
        await api.adjustStock(item.id, -(item.available - 1), 'Venta simultánea');
      }
    });

    // 3. Intentar continuar por WhatsApp
    await page.getByRole('button', { name: /continuar por whatsapp/i }).click();

    // 4. Debe alertar claramente y BLOQUEAR la apertura de WhatsApp
    await expect(
      page.getByText(/ahora quedan \d+ unidades de/i)
    ).toBeVisible();
    await expect(
      page.getByText(/volvé al carrito y ajustá la cantidad antes de continuar/i)
    ).toBeVisible();
  });
});
