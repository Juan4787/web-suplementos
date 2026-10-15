import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, committed: boolean) {
  await page.goto('/app/pedidos');
  await expect(page.getByText('DEMO', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  const data = await page.evaluate(async committed => {
    const api = await (window as any).__getBusinessApi();
    const key = crypto.randomUUID();
    const product = await api.saveProduct({ sku: key, slug: key, name: 'Magnesio de prueba', presentation: '1 unidad', description: 'Prueba aislada', category: 'Pruebas', priceCents: 150000, currentCostCents: 100000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/demo/creatina.svg', imageAlt: 'Producto de prueba', featured: false, published: true, active: true });
    const purchase = await api.createPurchase({ supplierName: 'Proveedor original', items: [{ productId: product.id, quantity: 5, unitCostCents: 100000 }] });
    let order = null;
    if (committed) order = await api.confirmImportedOrder({ customerName: 'Cliente de prueba', paymentMethod: 'cash', deliveryMethod: 'pickup', shippingType: null, shippingFeeCents: 0, quotedSubtotalCents: 450000, quotedTotalCents: 450000, protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD', lines: [{ productId: product.id, quantity: 3, unitPriceCents: 150000 }] });
    await api.receivePurchase(purchase.id, [{ purchaseItemId: purchase.items[0].id, receivedQuantity: 1 }], crypto.randomUUID(), 50000);
    if (order) { await api.saveOrderPacking(order.id, [{ orderItemId: order.items[0].id, packedQuantity: 1 }], 0); await api.transitionOrder(order.id, 'mark_paid'); }
    return { purchaseId: purchase.id, purchaseNumber: purchase.number, productId: product.id, orderId: order?.id };
  }, committed);
  const menu = page.getByRole('button', { name: 'Abrir navegación', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name: 'Inventario', exact: true }).first().click();
  await page.getByRole('button', { name: 'Compras', exact: true }).click();
  return data;
}
function health(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', dialog => { errors.push('Native dialog: ' + dialog.type()); void dialog.dismiss(); });
  return errors;
}
async function styled(page: Page) {
  expect(await page.locator('select,datalist,input[type="date"],input[type="month"],input[type="number"],input[type="checkbox"]').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dialog = page.getByRole('dialog');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
}

test('replace supplier atomically, preserve paid/packed customer order, and receive the replacement', async ({ page }, info) => {
  if (info.project.name === 'mobile-chrome') await page.setViewportSize({ width: 320, height: 740 });
  const errors = health(page);
  const data = await fixture(page, true);
  await page.getByRole('button', { name: `Cancelar compra #${data.purchaseNumber}`, exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Reservas que se trasladarán' })).toBeVisible();
  await expect(dialog).toContainText('Cliente de prueba');
  await expect(dialog).toContainText('2 unidades comprometidas');
  const replace = dialog.getByRole('radio', { name: /Pedir a otro proveedor/ });
  await replace.focus(); await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('button', { name: 'Confirmar cancelación' })).toBeDisabled();
  await page.keyboard.press('ArrowLeft');
  await expect(replace).toBeChecked();
  await dialog.getByLabel('Nuevo proveedor', { exact: true }).fill('Nuevo proveedor');
  await dialog.getByLabel('Nueva fecha estimada · opcional').click();
  await expect(page.getByRole('dialog').last()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: `Cancelar compra #${data.purchaseNumber}` })).toBeVisible();
  await dialog.getByLabel('Motivo de cancelación').fill('El proveedor original no enviará el saldo.');
  await dialog.getByRole('checkbox').click();
  await styled(page);
  await dialog.evaluate(el => { el.scrollTop = 0; });
  await dialog.screenshot({ path: `/tmp/impulso-cancel-audit/replacement-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Cancelar y crear reposición' }).click();
  await expect(dialog.getByRole('heading', { name: `Compra #${data.purchaseNumber} cancelada` })).toBeFocused();
  await expect(dialog).toContainText('Se trasladaron 2 unidades reservadas');
  const state = await page.evaluate(async ids => {
    const api = await (window as any).__getBusinessApi();
    const purchases = (await api.listPurchases(1,100,'all')).items;
    const original = purchases.find((p: any) => p.id === ids.purchaseId);
    const replacement = purchases.find((p: any) => p.id === original.cancellation.replacementPurchaseId);
    const order = (await api.listOrders(1,100,'','all')).items.find((o: any) => o.id === ids.orderId);
    return { replacement, order };
  }, data);
  expect(state.replacement.items[0].quantity).toBe(4);
  expect(state.order.paymentState).toBe('paid'); expect(state.order.items[0].packedQuantity).toBe(1);
  expect(state.order.stockReadiness).toBe('waiting_incoming'); expect(state.order.totalCents).toBe(450000);
  await dialog.getByRole('button', { name: 'Ver compras canceladas' }).click();
  const cancelled = page.locator('article').filter({ has: page.getByRole('heading', { name: `Pedido #${data.purchaseNumber}`, exact: true }) });
  await expect(cancelled).toContainText('Saldo cancelado');
  await expect(cancelled.getByRole('button', { name: 'Recibir mercadería' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Pendientes \(/ }).click();
  const replacement = page.locator('article').filter({ has: page.getByRole('heading', { name: `Pedido #${state.replacement.number}`, exact: true }) });
  await replacement.getByRole('button', { name: 'Recibir mercadería' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /Llegó TODO completo/ }).click();
  await dialog.getByRole('button', { name: /Confirmar/ }).click();
  await expect(dialog).toHaveCount(0);
  const after = await page.evaluate(async id => {
    const api = await (window as any).__getBusinessApi();
    return (await api.listOrders(1,100,'','all')).items.find((o: any) => o.id === id);
  }, data.orderId);
  expect(after.stockReadiness).toBe('ready'); expect(after.items[0].packedQuantity).toBe(1);
  expect(after.paymentState).toBe('paid'); expect(after.costTotalCents).toBe(300000);
  expect(errors).toEqual([]);
});

test('cancel uncommitted balance with custom confirmation and find it in history', async ({ page }, info) => {
  const errors = health(page), data = await fixture(page, false);
  await page.getByRole('button', { name: `Cancelar compra #${data.purchaseNumber}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No hay reservas pendientes de clientes');
  await expect(dialog.getByRole('button', { name: 'Confirmar cancelación' })).toBeDisabled();
  await dialog.getByLabel('Motivo de cancelación').fill('No necesitamos las unidades pendientes.');
  await dialog.getByRole('checkbox').click();
  await styled(page);
  await dialog.screenshot({ path: `/tmp/impulso-cancel-audit/plain-${info.project.name}.png` });
  await dialog.getByRole('button', { name: 'Confirmar cancelación' }).click();
  await expect(dialog).toContainText('4 unidades canceladas');
  await dialog.getByRole('button', { name: 'Ver compras canceladas' }).click();
  await expect(page.getByRole('button', { name: /^Cancelados \(/ })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
