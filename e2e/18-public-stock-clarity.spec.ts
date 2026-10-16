import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const evidence = '/tmp/impulso-clarity-ui-20261016';

test.beforeAll(() => mkdirSync(evidence, { recursive: true }));

for (const allDatesKnown of [true, false]) {
  test(`public cart distinguishes arrival at the store from delivery; all supplier dates known: ${allDatesKnown}`, async ({ page }, info) => {
    if (info.project.name === 'mobile-chrome') await page.setViewportSize({ width: 320, height: 800 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('dialog', dialog => { errors.push('Unexpected browser dialog'); void dialog.dismiss(); });
    await page.goto('/app/pedidos');
    expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    await expect(page.getByText('DEMO', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    const data = await page.evaluate(async known => {
      const api = await (window as any).__getBusinessApi(), key = crypto.randomUUID();
      const product = await api.saveProduct({ sku: key, slug: key, name: 'Producto con reposición prevista', presentation: '1 unidad', description: 'Prueba aislada', category: 'Pruebas', priceCents: 150000, currentCostCents: 100000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/demo/creatina.svg', imageAlt: 'Prueba', published: true, active: true });
      await api.adjustStock(product.id, 1, 'Conteo inicial');
      await api.createPurchase({ supplierName: 'Primera compra', expectedAt: '2030-01-01T15:00:00Z', items: [{ productId: product.id, quantity: 1, unitCostCents: 100000 }] });
      await api.createPurchase({ supplierName: 'Segunda compra', ...(known ? { expectedAt: '2030-01-02T15:00:00Z' } : {}), items: [{ productId: product.id, quantity: 1, unitCostCents: 100000 }] });
      const path = '/src/router.tsx'; const { router } = await import(path);
      await router.navigate({ to: '/producto/$slug', params: { slug: key } });
      return { id: product.id, orderCount: (await api.listOrders(1, 1)).total };
    }, allDatesKnown);
    await expect(page.getByRole('heading', { name: 'Producto con reposición prevista', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Sumar una unidad/i }).click();
    await page.getByRole('button', { name: /Sumar una unidad/i }).click();
    await page.getByRole('button', { name: /Agregar al carrito/i }).click();
    await page.evaluate(async () => { const path = '/src/router.tsx'; const { router } = await import(path); await router.navigate({ to: '/carrito' }); });
    for (const view of ['cart', 'checkout']) {
      const notice = page.getByText('Productos pendientes de recibir', { exact: true }).locator('..');
      await expect(notice).toBeVisible();
      if (allDatesKnown) {
        await expect(notice).toContainText('Llegada estimada al local:');
        await expect(notice).toContainText('La entrega se confirma por WhatsApp.');
      } else {
        await expect(notice).toContainText('La disponibilidad y la fecha se confirman por WhatsApp.');
        await expect(notice).not.toContainText('Llegada estimada');
      }
      await expect(page.getByText(/Tu pedido completo se entregará|se despachará a partir|Entrega unificada:/)).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await notice.screenshot({ path: `${evidence}/public-${view}-${allDatesKnown}-${info.project.name}.png` });
      if (view === 'cart') await page.getByRole('link', { name: 'Continuar', exact: true }).click();
    }
    await expect(page.getByText('Las unidades se reservan cuando te confirmamos el pedido por WhatsApp.')).toBeVisible();
    const after = await page.evaluate(async id => {
      const api = await (window as any).__getBusinessApi();
      return { stock: (await api.listInventory()).find((p: any) => p.id === id), orderCount: (await api.listOrders(1, 1)).total };
    }, data.id);
    expect(after.orderCount).toBe(data.orderCount);
    expect(after.stock).toMatchObject({ onHand: 1, reserved: 0, incoming: 2, incomingReserved: 0 });
    expect(errors).toEqual([]);
    expect(await page.locator('select,datalist,input[type="date"],input[type="number"],input[type="checkbox"]').count()).toBe(0);
  });
}
