import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => { errors.push('Unexpected browser dialog'); void dialog.dismiss(); });
  return errors;
}
async function local(page: Page) {
  await page.goto('/app/pedidos');
  expect(new URL(page.url()).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  await expect(page.getByText('DEMO', { exact: true }).filter({ visible: true }).first()).toBeVisible();
}
async function navigateToOrder(page: Page, number: number) {
  await page.getByRole('searchbox').fill(String(number));
  const card = page.locator('article').filter({ has: page.getByText(`#${number}`, { exact: true }) });
  const header = card.getByRole('button').first();
  await expect(header).toBeEnabled();
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
  await expect(card.getByRole('region', { name: `Armado del pedido ${number}` })).toBeVisible();
  return card;
}
async function healthy(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('select,datalist,input[type="date"],input[type="number"],input[type="checkbox"]').count()).toBe(0);
}

test('explains committed physical stock, preserves partial packing and opens the exact purchase beyond the first page', async ({ page }, info) => {
  if (info.project.name === 'mobile-chrome') await page.setViewportSize({ width: 320, height: 800 });
  const errors = watch(page); await local(page);
  const data = await page.evaluate(async () => {
    const api = await (window as any).__getBusinessApi();
    const make = async (name: string) => { const key = crypto.randomUUID(); return api.saveProduct({ sku: key, slug: key, name, presentation: '1 unidad', description: 'Prueba aislada', category: 'Pruebas', priceCents: 150000, currentCostCents: 100000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/demo/creatina.svg', imageAlt: 'Prueba', published: true, active: true }); };
    const complex = await make('B COMPLEX ACTIVE'), magnesium = await make('MAGNESIO DUAL ACTION'), thyroid = await make('THYROID SUPPORT');
    await api.adjustStock(complex.id, 8, 'Conteo inicial'); await api.adjustStock(magnesium.id, 1, 'Conteo inicial'); await api.adjustStock(thyroid.id, 1, 'Conteo inicial');
    const makeOrder = (lines: any[]) => api.confirmImportedOrder({ customerName: 'Cliente de comprobación', stockSource: 'normal', paymentMethod: 'cash', deliveryMethod: 'pickup', shippingFeeCents: 0, quotedSubtotalCents: lines.reduce((n, i) => n + i.quantity * 150000, 0), quotedTotalCents: lines.reduce((n, i) => n + i.quantity * 150000, 0), protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD', lines: lines.map(i => ({ ...i, unitPriceCents: 150000 })) });
    const committed = []; for (let i = 0; i < 8; i++) committed.push(await makeOrder([{ productId: complex.id, quantity: 1 }]));
    const earlier = committed[0];
    const purchase = await api.createPurchase({ supplierName: 'Proveedor asignado', expectedAt: '2030-01-01T15:00:00Z', items: [{ productId: complex.id, quantity: 5, unitCostCents: 100000 }] });
    const order = await makeOrder([{ productId: thyroid.id, quantity: 1 }, { productId: magnesium.id, quantity: 1 }, { productId: complex.id, quantity: 1 }]);
    for (let i = 0; i < 16; i++) await api.createPurchase({ supplierName: `Otro proveedor ${i + 1}`, expectedAt: '2031-01-01T15:00:00Z', items: [{ productId: magnesium.id, quantity: 1, unitCostCents: 100000 }] });
    return { orderId: order.id, number: order.number, earlierNumber: earlier.number, purchaseId: purchase.id, purchaseNumber: purchase.number };
  });
  const card = await navigateToOrder(page, data.number);
  const packing = card.getByRole('region', { name: `Armado del pedido ${data.number}` });
  await expect(packing.getByText('1 unidad en camino')).toBeVisible();
  await expect(packing.getByLabel('Stock general del producto')).toHaveCount(0);
  await expect(packing.getByText('Pendiente de stock', { exact: true })).toBeVisible();
  await expect(packing.getByText('0 en bolsita')).toHaveCount(0);
  const count = packing.getByRole('textbox', { name: 'Unidades en bolsita de MAGNESIO DUAL ACTION' });
  await count.fill('1');
  await packing.getByRole('textbox', { name: 'Unidades en bolsita de THYROID SUPPORT' }).fill('1');
  await expect(packing.getByRole('link', { name: `Abrir compra #${data.purchaseNumber}` })).toBeVisible();
  const compactHeight = await packing.getByRole('group', { name: 'Disponibilidad de B COMPLEX ACTIVE' }).locator('..').evaluate(el => el.getBoundingClientRect().height);
  const toggle = packing.getByRole('button', { name: /Ver stock y reservas/ });
  await toggle.focus(); await toggle.press('Enter');
  await expect(packing.getByRole('button', { name: /Ocultar stock y reservas/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(packing.getByRole('link', { name: new RegExp(`Pedido #${data.earlierNumber}`) })).toBeVisible();
  const purchaseLink = packing.getByRole('link', { name: `Abrir compra #${data.purchaseNumber}` });
  await expect(purchaseLink).toHaveAttribute('target', '_blank');
  await expect(purchaseLink).toHaveAttribute('rel', 'noopener noreferrer');
  expect(new URL((await purchaseLink.getAttribute('href'))!, page.url()).searchParams.get('purchase')).toBe(data.purchaseId);
  await expect(count).toHaveValue('1');
  const reservations = packing.getByRole('list', { name: 'Pedidos con unidades físicas apartadas' });
  await expect(reservations.getByRole('link')).toHaveCount(3);
  await packing.getByRole('button', { name: 'Ver otros 5 pedidos · 5 unidades' }).click();
  await expect(reservations.getByRole('link')).toHaveCount(8);
  expect(await reservations.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await packing.getByRole('button', { name: 'Mostrar menos pedidos' }).click();
  await expect(reservations.getByRole('link')).toHaveCount(3);
  await packing.getByRole('button', { name: 'Cómo se confirma la disponibilidad' }).click();
  await expect(packing.getByText(/La disponibilidad de este pedido se confirma al registrar la recepción/)).toBeVisible();
  await expect(count).toHaveValue('1');
  await packing.getByRole('button', { name: 'Cómo se confirma la disponibilidad' }).click();
  const layout = await packing.evaluate(element => ({
    viewport: innerWidth,
    panel: { x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width, client: element.clientWidth, scroll: element.scrollWidth },
    clipped: Array.from(element.querySelectorAll('p,a,input,button,button > span,dt,dd')).filter(node => {
      const box = node.getBoundingClientRect();
      // A rotating SVG can paint outside its own box during the transition.
      // Check the button bounds and its text span, rather than that paint area.
      return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1 || (node.tagName !== 'BUTTON' && node.scrollWidth > node.clientWidth + 1));
    }).map(node => ({ tag: node.tagName, text: node.textContent?.slice(0, 80), width: node.getBoundingClientRect().width, x: node.getBoundingClientRect().x, client: node.clientWidth, scroll: node.scrollWidth }))
  }));
  const expandedHeight = await packing.getByRole('group', { name: 'Disponibilidad de B COMPLEX ACTIVE' }).locator('..').evaluate(el => el.getBoundingClientRect().height);
  writeFileSync(`/tmp/impulso-packing-ux-20261016/layout-${info.project.name}.json`, JSON.stringify({ ...layout, compactHeight, expandedHeight }, null, 2));
  await page.screenshot({ path: `/tmp/impulso-packing-ux-20261016/page-${info.project.name}.png`, fullPage: true });
  expect(layout.clipped).toEqual([]);
  expect(layout.panel.x + layout.panel.width).toBeLessThanOrEqual(layout.viewport + 1);
  await packing.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `/tmp/impulso-packing-ux-20261016/packing-${info.project.name}.png` });
  await packing.getByRole('button', { name: 'Guardar armado' }).click();
  await expect(packing.getByText(/Armado parcial guardado/)).toBeVisible();
  await healthy(page, errors);
  // Demo state lives in one document. Exercise the exact target through its
  // router; real cross-tab persistence is checked read-only after publication.
  await page.evaluate(async id => { const path = '/src/router.tsx'; const { router } = await import(path); await router.navigate({ to: '/app/inventario', search: { tab: 'compras', purchase: id } }); }, data.purchaseId);
  await expect(page.getByRole('heading', { name: `Pedido #${data.purchaseNumber}`, exact: true })).toBeVisible();
  await expect(page.locator('article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Recibir mercadería', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ver todas las compras' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.has('purchase')).toBe(false);
  await expect(page.getByRole('button', { name: /Pendientes \(/ })).toBeVisible();
  await healthy(page, errors);
});

test('explicit future stock survives unrelated operations and only its partial receipt becomes packable', async ({ page }, info) => {
  if (info.project.name === 'mobile-chrome') await page.setViewportSize({ width: 320, height: 800 });
  const errors = watch(page); await local(page);
  const data = await page.evaluate(async () => {
    const api = await (window as any).__getBusinessApi(), key = crypto.randomUUID();
    const product = await api.saveProduct({ sku: key, slug: key, name: 'Compra en camino de comprobación', presentation: '1 unidad', description: 'Prueba aislada', category: 'Pruebas', priceCents: 150000, currentCostCents: 100000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/demo/creatina.svg', imageAlt: 'Prueba', published: true, active: true });
    await api.adjustStock(product.id, 4, 'Conteo inicial');
    const purchase = await api.createPurchase({ supplierName: 'Proveedor asignado', items: [{ productId: product.id, quantity: 3, unitCostCents: 100000 }] });
    const order = await api.confirmImportedOrder({ customerName: 'Cliente que eligió mercadería en camino', stockSource: 'incoming_only', paymentMethod: 'cash', deliveryMethod: 'pickup', shippingFeeCents: 0, quotedSubtotalCents: 450000, quotedTotalCents: 450000, protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD', lines: [{ productId: product.id, quantity: 3, unitPriceCents: 150000 }] });
    await api.adjustStock(product.id, 1, 'Nuevo conteo');
    const other = await api.createPurchase({ supplierName: 'Otro proveedor', items: [{ productId: product.id, quantity: 1, unitCostCents: 200000 }] });
    await api.receivePurchase(other.id, undefined, crypto.randomUUID());
    return { number: order.number, orderId: order.id, purchaseId: purchase.id, purchaseItemId: purchase.items[0].id, productId: product.id };
  });
  const card = await navigateToOrder(page, data.number), packing = card.getByRole('region', { name: `Armado del pedido ${data.number}` });
  await expect(packing.getByText('3 unidades en camino')).toBeVisible();
  await expect(packing.getByRole('button', { name: 'Guardar armado' })).toBeDisabled();
  await expect(packing.getByText('Todavía no hay unidades habilitadas para guardar.')).toBeVisible();
  await expect(packing.locator('input')).toHaveCount(0);
  await packing.getByRole('button', { name: /Ver stock y reservas/ }).click();
  await expect(packing.getByText(/Este pedido reserva sólo mercadería en camino/)).toBeVisible();
  await expect(packing.getByLabel('Stock general del producto').getByText('Libres').locator('..')).toContainText('6');
  await page.evaluate(async data => { const api = await (window as any).__getBusinessApi(); await api.receivePurchase(data.purchaseId, [{ purchaseItemId: data.purchaseItemId, receivedQuantity: 1 }], crypto.randomUUID()); }, data);
  await packing.getByRole('button', { name: 'Actualizar datos' }).click();
  const count = packing.getByRole('textbox', { name: 'Unidades en bolsita de Compra en camino de comprobación' });
  await expect(count).toBeVisible(); await count.fill('2');
  await expect(packing.getByRole('button', { name: 'Guardar armado' })).toBeDisabled();
  await count.fill('1'); await packing.getByRole('button', { name: 'Guardar armado' }).click();
  await expect(packing.getByText(/Armado parcial guardado/)).toBeVisible();
  const snapshot = await page.evaluate(async id => { const api = await (window as any).__getBusinessApi(); return api.getOrderStockContext(id); }, data.orderId);
  expect(snapshot.items[0]).toMatchObject({ physicalQuantity: 1, incomingQuantity: 2, available: 6 });
  await healthy(page, errors);
  await packing.evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `/tmp/impulso-packing-ux-20261016/incoming-${info.project.name}.png` });
});

test('focused purchase replacement keeps its exact link, paid customer and packed units through receipt', async ({ page }, info) => {
  if (info.project.name === 'mobile-chrome') await page.setViewportSize({ width: 320, height: 800 });
  const errors = watch(page); await local(page);
  const data = await page.evaluate(async () => {
    const api = await (window as any).__getBusinessApi(), key = crypto.randomUUID();
    const product = await api.saveProduct({ sku: key, slug: key, name: 'Reposición de comprobación', presentation: '1 unidad', description: 'Prueba aislada', category: 'Pruebas', priceCents: 150000, currentCostCents: 100000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/demo/creatina.svg', imageAlt: 'Prueba', published: true, active: true });
    const purchase = await api.createPurchase({ supplierName: 'Proveedor original', items: [{ productId: product.id, quantity: 5, unitCostCents: 100000 }] });
    const order = await api.confirmImportedOrder({ customerName: 'Cliente con armado parcial', stockSource: 'incoming_only', paymentMethod: 'cash', deliveryMethod: 'pickup', shippingFeeCents: 0, quotedSubtotalCents: 450000, quotedTotalCents: 450000, protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD', lines: [{ productId: product.id, quantity: 3, unitPriceCents: 150000 }] });
    await api.receivePurchase(purchase.id, [{ purchaseItemId: purchase.items[0].id, receivedQuantity: 1 }], crypto.randomUUID());
    await api.saveOrderPacking(order.id, [{ orderItemId: order.items[0].id, packedQuantity: 1 }], 0); await api.transitionOrder(order.id, 'mark_paid');
    const path = '/src/router.tsx'; const { router } = await import(path); await router.navigate({ to: '/app/inventario', search: { tab: 'compras', purchase: purchase.id } });
    return { orderId: order.id, purchaseId: purchase.id, purchaseNumber: purchase.number };
  });
  await page.getByRole('button', { name: `Cancelar compra #${data.purchaseNumber}`, exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nuevo proveedor', { exact: true }).fill('Proveedor de reposición');
  await dialog.getByLabel('Motivo de cancelación').fill('El proveedor no completa el saldo.');
  await dialog.getByRole('checkbox').click();
  await dialog.getByRole('button', { name: 'Cancelar y crear reposición' }).click();
  await expect(dialog.getByRole('heading', { name: `Compra #${data.purchaseNumber} cancelada` })).toBeVisible();
  const replacement = await page.evaluate(async id => { const api = await (window as any).__getBusinessApi(); const previous = await api.getPurchase(id); return api.getPurchase(previous.cancellation.replacementPurchaseId); }, data.purchaseId);
  await dialog.getByRole('button', { name: `Revisar reposición #${replacement.number}` }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: `Editar pedido #${replacement.number}` })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('purchase')).toBe(replacement.id);
  await dialog.getByLabel('Notas · opcional').fill('Compra de reposición revisada.');
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(dialog).toHaveCount(0);
  const purchase = page.locator('article').filter({ has: page.getByRole('heading', { name: `Pedido #${replacement.number}`, exact: true }) });
  await expect(purchase).toContainText('Compra de reposición revisada.');
  await purchase.getByRole('button', { name: 'Recibir mercadería', exact: true }).click();
  dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: /Llegó TODO completo/ }).click();
  await dialog.getByRole('button', { name: /Confirmar/ }).click(); await expect(dialog).toHaveCount(0);
  const current = await page.evaluate(async id => { const api = await (window as any).__getBusinessApi(); return (await api.listOrders(1, 100)).items.find((o: any) => o.id === id); }, data.orderId);
  expect(current).toMatchObject({ stockSource: 'incoming_only', stockReadiness: 'ready', paymentState: 'paid', totalCents: 450000, costTotalCents: 300000 });
  expect(current.items[0].packedQuantity).toBe(1);
  await healthy(page, errors);
});

test('receipt explains a pending supplier reassignment instead of linking a customer to a closed purchase', async ({ page }, info) => {
  if (info.project.name === 'mobile-chrome') await page.setViewportSize({ width: 320, height: 800 });
  const errors = watch(page); await local(page);
  const data = await page.evaluate(async () => {
    const api = await (window as any).__getBusinessApi(), key = crypto.randomUUID();
    const product = await api.saveProduct({ sku: key, slug: key, name: 'Reasignación de comprobación', presentation: '1 unidad', description: 'Prueba aislada', category: 'Pruebas', priceCents: 150000, currentCostCents: 100000, reorderPoint: 0, safetyStock: 0, leadTimeDays: 1, imageUrl: '/demo/creatina.svg', imageAlt: 'Prueba', published: true, active: true });
    const createOrder = (stockSource: string) => api.confirmImportedOrder({ customerName: 'Cliente de comprobación', stockSource, paymentMethod: 'cash', deliveryMethod: 'pickup', shippingFeeCents: 0, quotedSubtotalCents: 150000, quotedTotalCents: 150000, protocolOrderId: crypto.randomUUID(), protocolChecksum: '1234ABCD', lines: [{ productId: product.id, quantity: 1, unitPriceCents: 150000 }] });
    const first = await api.createPurchase({ supplierName: 'Primero', expectedAt: '2030-01-01T15:00:00Z', items: [{ productId: product.id, quantity: 1, unitCostCents: 100000 }] });
    const older = await createOrder('normal');
    const second = await api.createPurchase({ supplierName: 'Segundo', expectedAt: '2030-01-02T15:00:00Z', items: [{ productId: product.id, quantity: 1, unitCostCents: 200000 }] });
    const future = await createOrder('incoming_only'); await api.transitionOrder(future.id, 'mark_paid');
    const path = '/src/router.tsx'; const { router } = await import(path); await router.navigate({ to: '/app/inventario', search: { tab: 'compras', purchase: second.id } });
    return { firstId: first.id, firstNumber: first.number, secondNumber: second.number, futureNumber: future.number, futureId: future.id, olderNumber: older.number };
  });
  await page.getByRole('button', { name: 'Recibir mercadería', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: /Llegó TODO completo/ }).click();
  await dialog.getByRole('button', { name: /Confirmar/ }).click(); await expect(dialog).toHaveCount(0);
  const notice = page.getByRole('status').filter({ hasText: 'Revisá los pedidos que siguen pendientes' });
  await expect(notice.getByRole('link', { name: `Pedido #${data.futureNumber}`, exact: true })).toBeVisible();
  await expect(notice).toContainText('1 unidad sigue en camino con otra compra');
  expect(await notice.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await notice.getByRole('link', { name: `Pedido #${data.futureNumber}`, exact: true }).click();
  const card = await navigateToOrder(page, data.futureNumber);
  const packing = card.getByRole('region', { name: `Armado del pedido ${data.futureNumber}` });
  await packing.getByRole('button', { name: /Ver stock y reservas/ }).click();
  const source = packing.getByRole('link', { name: `Abrir compra #${data.firstNumber}`, exact: true });
  await expect(source).toBeVisible(); expect(new URL((await source.getAttribute('href'))!, page.url()).searchParams.get('purchase')).toBe(data.firstId);
  await expect(packing.getByRole('link', { name: `Abrir compra #${data.secondNumber}`, exact: true })).toHaveCount(0);
  const actual = await page.evaluate(async id => { const api = await (window as any).__getBusinessApi(); return (await api.listOrders(1, 100)).items.find((o: any) => o.id === id); }, data.futureId);
  expect(actual).toMatchObject({ paymentState: 'paid', costTotalCents: 200000, stockReadiness: 'waiting_incoming' });
  await healthy(page, errors);
});
