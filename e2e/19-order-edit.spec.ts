import { test, expect, type Page } from '@playwright/test';

async function setupEditFixture(page: Page) {
  await page.goto('/app/pedidos');
  await expect(page.getByText('DEMO', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  return page.evaluate(async () => {
    const api = await (window as any).__getBusinessApi();
    const keyA = crypto.randomUUID().slice(0, 8);
    const keyB = crypto.randomUUID().slice(0, 8);

    const prodA = await api.saveProduct({
      sku: `EDIT-A-${keyA}`,
      slug: `edit-a-${keyA}`,
      name: 'Creatina WhatsApp QA',
      presentation: '300g',
      description: 'Fixture edición A',
      category: 'Creatinas',
      priceCents: 200000,
      currentCostCents: 120000,
      reorderPoint: 0,
      safetyStock: 0,
      leadTimeDays: 1,
      imageUrl: '/demo/creatina.svg',
      imageAlt: 'Creatina QA',
      published: true,
      active: true
    });
    const prodB = await api.saveProduct({
      sku: `EDIT-B-${keyB}`,
      slug: `edit-b-${keyB}`,
      name: 'Magnesio WhatsApp QA',
      presentation: '60 caps',
      description: 'Fixture edición B',
      category: 'Vitaminas',
      priceCents: 150000,
      currentCostCents: 90000,
      reorderPoint: 0,
      safetyStock: 0,
      leadTimeDays: 1,
      imageUrl: '/demo/creatina.svg',
      imageAlt: 'Magnesio QA',
      published: true,
      active: true
    });

    await api.adjustStock(prodA.id, 5, 'Stock inicial QA A');
    await api.adjustStock(prodB.id, 4, 'Stock inicial QA B');

    let order = await api.confirmImportedOrder({
      protocolOrderId: crypto.randomUUID(),
      protocolChecksum: '1234ABCD',
      customerName: 'Cliente WhatsApp Edit QA',
      paymentMethod: 'transfer',
      deliveryMethod: 'pickup',
      shippingType: null,
      phone: '5493415559876',
      shippingFeeCents: 0,
      quotedSubtotalCents: 400000,
      quotedTotalCents: 400000,
      lines: [{ productId: prodA.id, quantity: 2, unitPriceCents: 200000 }]
    });

    order = await api.saveOrderPacking(order.id, [{ orderItemId: order.items[0].id, packedQuantity: 1 }], 0);
    order = await api.transitionOrder(order.id, 'mark_paid');

    return {
      prodAId: prodA.id,
      prodBId: prodB.id,
      orderId: order.id,
      orderNumber: order.number
    };
  });
}

async function getProductStock(page: Page, productId: string) {
  return page.evaluate(async (id) => {
    const api = await (window as any).__getBusinessApi();
    const item = (await api.listInventory()).find((p: any) => p.id === id);
    return { onHand: item.onHand, reserved: item.reserved, available: item.available };
  }, productId);
}

test('explica bloqueo en pedido cobrado, permite editar tras deshacer cobro respetando la bolsita y actualiza stock y total', async ({ page }, info) => {
  if (info.project.name === 'mobile-chrome') await page.setViewportSize({ width: 360, height: 780 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  const data = await setupEditFixture(page);
  await page.getByRole('searchbox').fill(String(data.orderNumber));

  const article = page.locator('article').filter({
    has: page.getByRole('heading', { name: 'Cliente WhatsApp Edit QA', exact: true })
  });
  await expect(article).toBeVisible();

  // Order is paid: Editar pedido is disabled and explains concisely how to proceed
  await expect(article.getByRole('button', { name: 'Editar pedido' })).toBeDisabled();
  await expect(article).toContainText('Ya figura cobrado. Usá «Deshacer cobro» en Más opciones para editar los productos y cobrar el nuevo total.');

  // Undo payment so the order can be edited
  await article.getByRole('button', { name: 'Más opciones' }).click();
  await article.getByRole('button', { name: 'Deshacer cobro', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sí, deshacer cobro' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Now Editar pedido is enabled as a link to the editor panel
  const editLink = article.getByRole('link', { name: 'Editar pedido' });
  await expect(editLink).toBeVisible();
  await editLink.click();

  await expect(page.getByRole('heading', { name: `Editar productos del Pedido #${data.orderNumber}` })).toBeVisible();
  await expect(page.getByText('En bolsita: 1 u.')).toBeVisible();

  // Decrease Creatina from 2 -> 1 (minimum allowed because 1 unit is packed in the bag)
  await page.getByRole('button', { name: 'Disminuir cantidad de Creatina WhatsApp QA' }).click();
  await expect(page.getByText('Antes: 2 u.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disminuir cantidad de Creatina WhatsApp QA' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Quitar Creatina WhatsApp QA' })).toBeDisabled();
  await expect(page.getByText('Mínimo 1 u. porque ya están en la bolsita. Para bajar más, desarmá primero la bolsita en Pedidos.')).toBeVisible();

  // Search and add Magnesio WhatsApp QA
  await page.getByPlaceholder('Buscar por nombre, código SKU o categoría...').fill('Magnesio WhatsApp QA');
  await page.getByRole('button', { name: 'Agregar', exact: true }).first().click();
  await expect(page.getByText('Nuevo', { exact: true }).first()).toBeVisible();

  // Save edited order
  const saveBtn = page.getByRole('button', { name: 'Guardar cambios del pedido' });
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  // Back in OrdersPage filtered by order number
  const updatedArticle = page.locator('article').filter({
    has: page.getByRole('heading', { name: 'Cliente WhatsApp Edit QA', exact: true })
  });
  await expect(updatedArticle).toBeVisible();
  await expect(updatedArticle).toContainText('Creatina WhatsApp QA');
  await expect(updatedArticle).toContainText('Magnesio WhatsApp QA');

  // Verify stock consistency
  expect(await getProductStock(page, data.prodAId)).toEqual({ onHand: 5, reserved: 1, available: 4 });
  expect(await getProductStock(page, data.prodBId)).toEqual({ onHand: 4, reserved: 1, available: 3 });

  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
