import { test, expect } from '@playwright/test';

test.describe('Pilar 9: Stock y Exception-Driven UI', () => {
  test('5.1: Vista adaptativa de stock: filtros rápidos, tarjetas contextuales y Drawer de radiografía', async ({ page }) => {
    await page.goto('/app/stock');

    // Verifica que cargue el encabezado
    await expect(page.getByRole('heading', { name: /inventario|stock/i }).first()).toBeVisible();

    // Filtros rápidos: "Todos", "Requieren atención", "En orden"
    const attentionFilter = page.getByRole('button', { name: /requieren atención/i });
    if (await attentionFilter.isVisible()) {
      await attentionFilter.click();
      await page.waitForTimeout(200);
    }

    const allFilter = page.getByRole('button', { name: /^todos/i });
    if (await allFilter.isVisible()) {
      await allFilter.click();
      await page.waitForTimeout(200);
    }

    // Abre el Drawer de detalles del primer producto
    const detailBtn = page.getByRole('button', { name: /detalles|ver detalle completo/i }).first();
    await expect(detailBtn).toBeVisible();
    await detailBtn.click();

    // Verifica que el Drawer muestre la radiografía de stock
    await expect(page.getByText(/físico|stock real/i).first()).toBeVisible();
    await expect(page.getByText(/reservado/i).first()).toBeVisible();
    await expect(page.getByText(/stock proyectado/i)).toBeVisible();
  });
});
