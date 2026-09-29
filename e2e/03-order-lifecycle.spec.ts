import { test, expect, type Page } from '@playwright/test';

async function createDailyOrder(page: Page, customer: string) {
  await page.goto('/app/pedidos/nuevo');
  // This suite only writes to the browser's disposable demo.
  await expect(page.getByText('DEMO', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await page.getByPlaceholder('Buscar creatina, proteína, colágeno, SKU…').fill('Creatina');
  await page.getByRole('button', { name: 'Agregar', exact: true }).click();
  const [first, ...rest] = customer.split(' ');
  await page.locator('#customerFirstName').fill(first || customer);
  await page.locator('#customerLastName').fill(rest.join(' ') || 'Auditoría');
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
  test('el conteo de bolsita admite borrar y reescribir sin completar ceros solo', async ({ page }) => {
    const order = await createDailyOrder(page, 'Cliente conteo auditoría');
    await order.getByRole('button', { name: 'Completar vacíos con 0' }).click();
    const count = order.getByRole('textbox', { name: 'Unidades en bolsita de Creatina Monohidratada' });
    await expect(count).toHaveValue('0');

    await count.fill('');
    await order.getByText(/Armado de la bolsita/).click();
    await expect(count).toHaveValue('');
    await expect(order.getByRole('button', { name: 'Guardar armado' })).toBeDisabled();

    await count.fill('01');
    await expect(count).toHaveValue('1');
    await count.fill('10');
    await expect(count).toHaveValue('10');
    await expect(order.getByRole('button', { name: 'Guardar armado' })).toBeDisabled();
    await count.fill('');
    await expect(count).toHaveValue('');
    await count.fill('1');
    await order.getByRole('button', { name: 'Guardar armado' }).click();
    await expect(order.getByText(/Armado completo guardado/)).toBeVisible();
  });

  test('cobrar y entregar completa el pedido, libera la reserva y descuenta una unidad física', async ({ page }) => {
    const order = await createDailyOrder(page, 'Cliente entrega auditoría');
    await order.getByRole('button', { name: 'Marcar como cobrado' }).click();
    await expect(order.getByRole('button', { name: 'Marcar como cobrado' })).toHaveCount(0);
    await order.getByRole('button', { name: 'Ya guardé todo lo reservado' }).click();
    await order.getByRole('button', { name: 'Guardar armado' }).click();
    await expect(order.getByText(/Armado completo guardado/)).toBeVisible();
    await order.getByRole('button', { name: 'Marcar listo para entregar' }).click();
    await order.getByRole('button', { name: 'Marcar como entregado' }).click();
    await page.getByRole('button', { name: /^Completados/ }).click();
    await expect(order).toBeVisible();
    await expect(order.getByText('Completado', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /completado\. Lo encontrás en Completados/i })).toBeVisible();
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
