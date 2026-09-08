import { test, expect, type Page } from '@playwright/test';

async function createDailyOrder(page: Page, customer: string) {
  await page.goto('/app/pedidos/nuevo');
  // This suite only writes to the browser's disposable demo.
  await expect(page.getByText('DEMO', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.getByPlaceholder('Buscar creatina, proteína, colágeno, SKU…').fill('Creatina');
  await page.getByRole('button', { name: 'Agregar', exact: true }).click();
  await page.getByPlaceholder('Ej. Marta Gómez').fill(customer);
  await page.getByRole('button', { name: 'Confirmar pedido manual' }).click();
  await page.getByRole('link', { name: /Ver pedido #\d+ en la lista/ }).click();
  const order = page.locator('article').filter({ has: page.getByRole('heading', { name: customer, exact: true }) });
  await expect(order.getByRole('button', { name: 'Marcar como cobrado' })).toBeVisible();
  return order;
}

async function expectStock(page: Page, onHand: number, reserved: number) {
  const menu = page.getByRole('button', { name: 'Abrir navegación' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name: 'Inventario', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: /Creatina Monohidratada.*u\./ }).click();
  const drawer = page.getByRole('dialog', { name: 'Creatina Monohidratada' });
  await expect(drawer.getByText('Total', { exact: true }).locator('..')).toHaveText(`Total${onHand}u.`);
  await expect(drawer.getByText('Reservado', { exact: true }).locator('..')).toHaveText(`Reservado${reserved}u.`);
}

test.describe('Operación diaria de pedidos', () => {
  test('cobrar y entregar completa el pedido, libera la reserva y descuenta una unidad física', async ({ page }) => {
    const order = await createDailyOrder(page, 'Cliente entrega auditoría');
    await order.getByRole('button', { name: 'Marcar como cobrado' }).click();
    await expect(order.getByRole('button', { name: 'Marcar como cobrado' })).toHaveCount(0);
    await order.getByRole('button', { name: 'Marcar como entregado' }).click();
    await page.getByRole('button', { name: /^Completados/ }).click();
    await expect(order).toBeVisible();
    await expect(order.getByText('Pedido completado y stock actualizado.')).toBeVisible();
    await expectStock(page, 6, 3);
  });

  test('cancelar solicita confirmación, libera la reserva y conserva las unidades físicas', async ({ page }) => {
    const order = await createDailyOrder(page, 'Cliente cancelación auditoría');
    await order.getByRole('button', { name: 'Más opciones' }).click();
    await order.getByRole('button', { name: 'Cancelar pedido', exact: true }).click();
    const confirmation = page.getByRole('dialog');
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Sí, cancelar pedido' }).click();
    await expect(confirmation).toHaveCount(0);
    await page.getByRole('button', { name: /^Completados/ }).click();
    await expect(order.getByText('Cancelado', { exact: true })).toBeVisible();
    await expectStock(page, 7, 3);
  });
});
