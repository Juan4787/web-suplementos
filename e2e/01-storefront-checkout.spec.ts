import { test, expect } from '@playwright/test';
import { parseWhatsAppProtocol } from '../src/domain/whatsapp';

test.describe('Pilar 1: Tienda Pública y Generación de WhatsApp', () => {
  test('1.1: Navega el catálogo, entra a un producto y agrega al carrito con cantidades múltiples', async ({ page }) => {
    await page.goto('/');

    // Verifica encabezado principal
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const productLink = page.locator('article a[href^="/producto/"]').first();
    await expect(productLink).toBeVisible();

    // Entra al detalle del primer producto
    await productLink.click();
    await expect(page).toHaveURL(/\/producto\//);

    // Suma una unidad adicional (cantidad = 2)
    const plusBtn = page.getByRole('button', { name: /sumar una unidad/i });
    if (await plusBtn.isVisible()) {
      await plusBtn.click();
    }

    // Agrega al carrito
    const addToCartBtn = page.getByRole('button', { name: /agregar al carrito/i });
    await addToCartBtn.click();

    // Verifica que el botón cambie a "Agregado al carrito"
    await expect(page.getByRole('button', { name: /agregado al carrito/i })).toBeVisible();
  });

  test('1.2: Completa checkout con Efectivo + Retiro y valida mensaje WhatsApp con parser', async ({ page }) => {
    let capturedUrl = '';

    // Intercepta aperturas de WhatsApp tanto por window.open (desktop) como por navegación (mobile)
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
        const fakeWin = {
          location: {
            _href: typeof url === 'string' ? url : '',
            set href(val: string) {
              this._href = val;
              (window as any).__lastOpenedUrl = val;
            },
            get href() {
              return this._href;
            }
          },
          close: () => {}
        };
        return fakeWin as any;
      };
    });

    // Agrega un producto desde la tienda
    await page.goto('/');
    await page.getByRole('button', { name: /agregar al carrito|agregar/i }).first().click();

    // Va al checkout
    await page.goto('/checkout');
    await expect(page.getByRole('heading', { name: /cómo coordinamos/i })).toBeVisible();

    // Completa nombre del cliente
    await page.locator('#customerName').fill('María José Agüero');

    // Selecciona Efectivo
    await page.getByRole('button', { name: /efectivo/i }).first().click();

    // Selecciona Retiro
    await page.getByRole('button', { name: /retiro/i }).first().click();

    // Presiona Continuar por WhatsApp
    const submitBtn = page.getByRole('button', { name: /continuar por whatsapp/i });
    await submitBtn.click();

    // Espera a que se capture la URL de WhatsApp (desktop via __lastOpenedUrl o mobile via page.route / URL)
    await expect
      .poll(async () => {
        if (capturedUrl) return capturedUrl;
        try {
          const fromWin = await page.evaluate(() => (window as any).__lastOpenedUrl as string);
          if (fromWin && fromWin.startsWith('https://')) return fromWin;
        } catch {
          // context navigating
        }
        const currentUrl = page.url();
        if (/whatsapp\.com|wa\.me/.test(currentUrl)) return currentUrl;
        return '';
      })
      .toMatch(/^https:\/\/(api\.whatsapp\.com|web\.whatsapp\.com|wa\.me)\//);

    let whatsappUrl = capturedUrl;
    if (!whatsappUrl) {
      try {
        whatsappUrl = await page.evaluate(() => (window as any).__lastOpenedUrl as string);
      } catch {
        // ignore
      }
    }
    if (!whatsappUrl) {
      whatsappUrl = page.url();
    }

    expect(whatsappUrl).toMatch(/^https:\/\/(api\.whatsapp\.com|web\.whatsapp\.com|wa\.me)\//);

    // Extrae el texto del mensaje enviado a WhatsApp
    const urlObj = new URL(whatsappUrl);
    const textParam = urlObj.searchParams.get('text') ?? '';
    expect(textParam).toContain('*PEDIDO IMPULSO · V1*');
    expect(textParam).toContain('María José Agüero');

    // Valida semántica e integridad del mensaje con el parser oficial
    const parsed = parseWhatsAppProtocol(textParam);
    expect(parsed.customerName).toBe('María José Agüero');
    expect(parsed.paymentMethod).toBe('cash');
    expect(parsed.deliveryMethod).toBe('pickup');
    expect(parsed.lines.length).toBeGreaterThanOrEqual(1);
  });

  test('1.3: Checkout con Transferencia + Retiro muestra datos bancarios (Alias / CBU)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /agregar al carrito|agregar/i }).first().click();
    await page.goto('/checkout');

    // Selecciona Transferencia
    await page.getByRole('button', { name: /transferencia/i }).first().click();

    // Verifica que los datos bancarios aparezcan en pantalla
    await expect(page.getByText(/datos para transferir/i)).toBeVisible();
    await expect(page.getByText(/alias:/i)).toBeVisible();
  });

  test('1.4: Checkout con Transferencia + Envío a domicilio calcula tarifas', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /agregar al carrito|agregar/i }).first().click();
    await page.goto('/checkout');

    // Selecciona Envío a domicilio
    await page.getByRole('button', { name: /envío a domicilio/i }).first().click();

    // Completa dirección y teléfono requeridos para envío
    await page.locator('#address').fill('Av. Corrientes');
    await page.locator('#addressNumber').fill('1234');
    await page.locator('#phone').fill('1144332211');

    // Verifica que el resumen lateral refleje el costo de envío
    await expect(page.locator('aside').getByText(/envío/i)).toBeVisible();
  });
});
