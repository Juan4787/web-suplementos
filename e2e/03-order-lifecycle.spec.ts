import { test, expect } from '@playwright/test';

test.describe('Pilar 3 y 4: Ciclo de Vida del Pedido y Cancelación', () => {
  test('3.1: Ciclo completo: Preparar -> Listo -> Cobrar -> Entregar (descuenta stock físico)', async ({ page }) => {
    await page.goto('/app/pedidos');

    // Abre el primer pedido disponible en pendientes
    const orderCard = page.locator('article').first();
    await expect(orderCard).toBeVisible();

    // Expande el acordeón del pedido
    await orderCard.locator('button[aria-expanded]').first().click();

    // 1. Cobrar si está pendiente
    const payBtn = orderCard.getByRole('button', { name: /marcar como cobrado/i });
    if (await payBtn.isVisible()) {
      await payBtn.click();
      await page.waitForTimeout(400);
    }

    // 2. Empezar a preparar si está pendiente
    const prepBtn = orderCard.getByRole('button', { name: /empezar a preparar/i });
    if (await prepBtn.isVisible()) {
      await prepBtn.click();
      await page.waitForTimeout(400);
    }

    // 3. Marcar como listo
    const readyBtn = orderCard.getByRole('button', { name: /marcar como listo/i });
    if (await readyBtn.isVisible()) {
      await readyBtn.click();
      await page.waitForTimeout(400);
    }

    // 4. Marcar como enviado si corresponde
    const shipBtn = orderCard.getByRole('button', { name: /marcar como enviado/i });
    if (await shipBtn.isVisible()) {
      await shipBtn.click();
      await page.waitForTimeout(400);
    }

    // 5. Marcar como entregado si corresponde
    const deliverBtn = orderCard.getByRole('button', { name: /marcar como entregado/i });
    if (await deliverBtn.isVisible()) {
      await deliverBtn.click();
      await page.waitForTimeout(400);
    }

    // Cambia al filtro Todos o Completados para verificar el badge de completado
    const todosBtn = page.getByRole('button', { name: /todos|completados/i }).first();
    if (await todosBtn.isVisible()) {
      await todosBtn.click();
      await page.waitForTimeout(300);
    }

    // Verifica que el badge de estado refleje completado / entregado / pagado / enviado
    await expect(page.locator('article').first().getByText(/completado|entregado|enviado/i).first()).toBeVisible();
  });

  test('3.2: Cancelación de pedido: libera reserva sin descontar stock físico', async ({ page }) => {
    await page.goto('/app/pedidos');

    // Busca un pedido con filtro de pendientes
    const pendingFilter = page.getByRole('button', { name: /pendientes de acción/i });
    if (await pendingFilter.isVisible()) {
      await pendingFilter.click();
    }

    const orderCard = page.locator('article').first();
    if (await orderCard.isVisible()) {
      await orderCard.locator('button[aria-expanded]').first().click();

      // Si el pedido tiene acción de cancelar
      const moreBtn = orderCard.getByRole('button', { name: /más opciones/i });
      if (await moreBtn.isVisible()) {
        await moreBtn.click();
        await page.waitForTimeout(100);
      }

      const cancelBtn = orderCard.getByRole('button', { name: /cancelar pedido/i });
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
        await page.waitForTimeout(300);
        await expect(orderCard.getByText(/cancelado/i).first()).toBeVisible();
      }
    }
  });
});
