import { test, expect } from '@playwright/test';
import { buildWhatsAppProtocol } from '../src/domain/whatsapp';
import { demoSettings } from '../src/data/demo-data';
import type { CartLine, CheckoutData } from '../src/domain/types';

test.describe('Pilar 2, 5, 6, 7: Importación, Variación de Precios e Idempotencia', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/app/pedidos/importar');
  });

  test('2.1: Flujo feliz de importación en 2 clics (Pegar -> Analizar -> Confirmar)', async ({ page }) => {
    const lines: CartLine[] = [
      {
        productId: '10000000-0000-4000-8000-000000000002',
        sku: 'WHEY908',
        name: 'Whey Protein',
        presentation: '908 g · Vainilla',
        quantity: 1,
        unitPriceCents: 3950000,
        imageUrl: '/demo/whey.svg'
      }
    ];

    const checkout: CheckoutData = {
      customerName: 'Santiago Giménez',
      phone: '1198765432',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      notes: null,
      protocolOrderId: '11111111-2222-4333-8444-555555555555'
    };

    const whatsappMessage = buildWhatsAppProtocol(checkout, lines, demoSettings).message;

    // 1. Pega el mensaje en el importador
    const textarea = page.locator('textarea');
    await textarea.fill(whatsappMessage);

    // 2. Analizar
    const analyzeBtn = page.getByRole('button', { name: /analizar y revisar pedido|analizar/i });
    await analyzeBtn.click();

    // Verifica que se dibuje el resumen con los datos del cliente y producto
    await expect(page.getByText('Santiago Giménez')).toBeVisible();
    await expect(page.getByText(/whey protein/i).first()).toBeVisible();

    // 3. Confirmar y reservar stock / Confirmar pedido
    const confirmBtn = page.getByRole('button', { name: /confirmar y reservar stock|confirmar pedido/i });
    await confirmBtn.click();

    // 4. Verifica pantalla de cierre rediseñada
    await expect(page.getByRole('heading', { name: 'Pedido cargado', level: 1 })).toBeVisible();
    await expect(page.getByText(/pedido #\d+ · santiago giménez/i)).toBeVisible();
    await expect(page.getByText(/1 producto · 1 unidad/i)).toBeVisible();
    await expect(page.getByText(/el pedido quedó cargado y las unidades fueron reservadas/i)).toBeVisible();

    // Verifica jerarquía de botones
    const viewOrderBtn = page.getByRole('link', { name: /ver pedido #\d+/i });
    await expect(viewOrderBtn).toBeVisible();
    const importAnotherBtn = page.getByRole('button', { name: /importar otro pedido/i });
    await expect(importAnotherBtn).toBeVisible();

    // Probar que "Importar otro pedido" limpia el estado local y regresa al área de pegado
    await importAnotherBtn.click();
    await expect(page.locator('textarea#order-message')).toBeVisible();
    await expect(page.getByRole('button', { name: /analizar pedido/i })).toBeVisible();
  });

  test('2.2: Variación de precio detectada con advertencia clara (Pilar 5)', async ({ page }) => {
    // Genera un mensaje con precio alterado ($1.000 en vez de $39.500)
    const alteredMessage = `*PEDIDO IMPULSO · V1*

*Código de pedido*
22222222-3333-4444-8555-666666666666

*Nombre*
Lucas Mansilla

*Productos*
- [WHEY908] Whey Protein | 908 g · Vainilla | 1 x $ 1.000 = $ 1.000

*Subtotal*
$ 1.000

*Medio de pago*
Efectivo

*Entrega*
Retiro

*Envío*
$ 0

*Total*
$ 1.000

*Código de control*
00000000`;

    await page.locator('textarea').fill(alteredMessage);
    await page.getByRole('button', { name: /analizar y revisar pedido|analizar/i }).click();

    // Al tener firma incorrecta o datos alterados, la UI avisa el error de validación
    await expect(page.getByText(/no pudimos interpretar|inválido|error/i).first()).toBeVisible();
  });

  test('2.3: Idempotencia UI: Reintentar la importación del mismo ID no duplica el pedido (Pilar 7)', async ({ page }) => {
    const lines: CartLine[] = [
      {
        productId: '10000000-0000-4000-8000-000000000002',
        sku: 'WHEY908',
        name: 'Whey Protein',
        presentation: '908 g · Vainilla',
        quantity: 1,
        unitPriceCents: 3950000,
        imageUrl: '/demo/whey.svg'
      }
    ];

    const checkout: CheckoutData = {
      customerName: 'Cliente Idempotente UI',
      phone: '1155667788',
      paymentMethod: 'cash',
      deliveryMethod: 'pickup',
      shippingType: null,
      address: null,
      addressNumber: null,
      notes: null,
      protocolOrderId: '33333333-4444-4555-8666-777777777777'
    };

    const msg = buildWhatsAppProtocol(checkout, lines, demoSettings).message;

    // Primera confirmación
    await page.locator('textarea').fill(msg);
    await page.getByRole('button', { name: /analizar y revisar pedido|analizar/i }).click();
    await page.getByRole('button', { name: /confirmar y reservar stock|confirmar pedido/i }).click();
    await expect(page.getByRole('heading', { name: 'Pedido cargado', level: 1 })).toBeVisible();

    // Para el segundo intento, hace click en "Importar otro pedido"
    await page.getByRole('button', { name: /importar otro pedido/i }).click();
    await page.locator('textarea').fill(msg);
    await page.getByRole('button', { name: /analizar y revisar pedido|analizar/i }).click();
    await page.getByRole('button', { name: /confirmar y reservar stock|confirmar pedido/i }).click();

    // La UI no debe crear un segundo pedido; debe advertir que ya fue importado
    await expect(page.getByText(/ya fue importado/i).first()).toBeVisible();
  });
});
