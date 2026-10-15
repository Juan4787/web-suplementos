import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, deliveryMethod: 'pickup' | 'shipping') {
  await page.goto('/app/pedidos');
  await expect(page.getByText('DEMO', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  return page.evaluate(async method => {
    const api = await (window as any).__getBusinessApi();
    const key = crypto.randomUUID();
    const product = await api.saveProduct({ sku: key, slug: key, name: 'Producto Correcciones QA', presentation: '1 u.',
      description: 'Fixture de navegador aislado', category: 'QA', priceCents: 150000, currentCostCents: 100000,
      reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/demo/creatina.svg', imageAlt: 'Producto QA', published: true, active: true });
    await api.adjustStock(product.id, 4, 'Fixture de navegador');
    let order = await api.confirmImportedOrder({ protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD',
      customerName: 'Cliente Correcciones QA', paymentMethod: 'cash', deliveryMethod: method,
      shippingType: method === 'shipping' ? 'standard' : null, address: method === 'shipping' ? 'Calle QA' : undefined,
      addressNumber: method === 'shipping' ? '123' : undefined, phone: '5493415551234', shippingFeeCents: 0,
      quotedSubtotalCents: 150000, quotedTotalCents: 150000, lines: [{ productId: product.id, quantity: 1, unitPriceCents: 150000 }] });
    order = await api.saveOrderPacking(order.id, [{ orderItemId: order.items[0].id, packedQuantity: 1 }], 0);
    order = await api.transitionOrder(order.id, 'mark_paid');
    if (method === 'shipping') order = await api.transitionOrder(order.id, 'mark_shipped');
    order = await api.transitionOrder(order.id, 'mark_delivered');
    return { productId: product.id, orderId: order.id, number: order.number };
  }, deliveryMethod);
}
async function stock(page: Page, productId: string) {
  return page.evaluate(async id => {
    const api = await (window as any).__getBusinessApi();
    const item = (await api.listInventory()).find((p: any) => p.id === id);
    return { onHand: item.onHand, reserved: item.reserved, available: item.available, averageDailySales: item.averageDailySales };
  }, productId);
}
function health(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test('corrige un pedido completado, conserva sus reservas y guía la cancelación sin perder el pedido', async ({ page }, info) => {
  if (info.project.name === 'mobile-chrome') await page.setViewportSize({ width: 320, height: 740 });
  const errors = health(page);
  const data = await fixture(page, 'pickup');
  // Demo state lives in this page instance; use the app's search to preserve it.
  await page.getByRole('searchbox').fill(String(data.number));
  await expect(page).toHaveTitle('TIENDA DE SUPLEMENTOS');
  const article = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Cliente Correcciones QA', exact: true }) });
  const panel = article.getByRole('region', { name: `Qué sigue del pedido #${data.number}` });
  await article.getByRole('button', { name: 'Más opciones' }).click();
  await expect(panel.getByRole('button', { name: 'Cancelar pedido', exact: true })).toBeDisabled();
  await expect(panel).toContainText('Primero resolvé el cobro');
  await panel.screenshot({ path: `/tmp/order-reversals-options-${info.project.name}.png` });

  await panel.getByRole('button', { name: 'Deshacer cobro', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.locator('#confirm-order-action-description')).toContainText('Esta acción corrige el registro');
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Volver', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Deshacer cobro', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Deshacer cobro', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Sí, deshacer cobro' }).click();
  await expect(dialog).toHaveCount(0);
  const notice = page.getByRole('status').filter({ hasText: 'cobro deshecho' });
  await expect(notice).toBeVisible();
  await expect(notice.locator('..')).toBeFocused();
  await expect(panel).toContainText('Primero deshacé la entrega');
  expect(await stock(page, data.productId)).toEqual({ onHand: 3, reserved: 0, available: 3, averageDailySales: 0.03 });

  await panel.getByRole('button', { name: 'Deshacer entrega', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('#confirm-order-action-description')).toContainText('reservadas para este mismo pedido');
  const titleBounds = await dialog.locator('#confirm-order-action-title').boundingBox();
  const bodyBounds = await dialog.locator('#confirm-order-action-description').boundingBox();
  expect(bodyBounds!.y).toBeGreaterThan(titleBounds!.y + titleBounds!.height);
  await expect(dialog).toContainText('mercadería está en el local');
  await page.screenshot({ path: `/tmp/order-reversals-confirmation-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Sí, deshacer entrega' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText('guardá el armado en cero');
  expect(await stock(page, data.productId)).toEqual({ onHand: 4, reserved: 1, available: 3, averageDailySales: 0 });

  const count = article.getByRole('textbox', { name: 'Unidades en bolsita de Producto Correcciones QA' });
  await count.fill('0');
  await article.getByRole('button', { name: 'Guardar armado' }).click();
  await expect(panel.getByRole('button', { name: 'Cancelar pedido', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Cancelar pedido', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sí, cancelar pedido' }).click();
  await expect(article.getByText('Cancelado', { exact: true })).toBeVisible();
  expect(await stock(page, data.productId)).toEqual({ onHand: 4, reserved: 0, available: 4, averageDailySales: 0 });
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('deshacer entrega de un envío mantiene el stock fuera del local hasta deshacer el envío', async ({ page }) => {
  const errors = health(page);
  const data = await fixture(page, 'shipping');
  // Demo state lives in this page instance; use the app's search to preserve it.
  await page.getByRole('searchbox').fill(String(data.number));
  const article = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Cliente Correcciones QA', exact: true }) });
  await article.getByRole('button', { name: 'Más opciones' }).click();
  await article.getByRole('button', { name: 'Deshacer entrega', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('stock no cambiará');
  await page.getByRole('dialog').getByRole('button', { name: 'Sí, deshacer entrega' }).click();
  await expect(article.getByRole('button', { name: 'Deshacer envío', exact: true })).toBeVisible();
  expect(await stock(page, data.productId)).toMatchObject({ onHand: 3, reserved: 0 });
  await article.getByRole('button', { name: 'Deshacer envío', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sí, deshacer envío' }).click();
  await expect(article.getByRole('button', { name: 'Deshacer envío', exact: true })).toHaveCount(0);
  expect(await stock(page, data.productId)).toMatchObject({ onHand: 4, reserved: 1 });
  expect(errors).toEqual([]);
});
