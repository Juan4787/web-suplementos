import { test, expect } from '@playwright/test';

test.describe('Pilar 9: Stock y Exception-Driven UI', () => {
  test('5.1: Vista adaptativa de stock: filtros rápidos, tarjetas contextuales y Drawer de radiografía', async ({ page }) => {
    await page.goto('/app/stock');

    // Verifica que cargue el encabezado
    await expect(page.getByRole('heading', { name: /inventario|stock/i }).first()).toBeVisible();

    // Filtros rápidos: "Todos", "Requieren atención", "En orden"
    const attentionFilter = page.getByRole('button', { name: /necesitan atención/i });
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
    const detailBtn = page.getByRole('button', { name: /creatina monohidratada.*u\./i });
    await expect(detailBtn).toBeVisible();
    await detailBtn.click();

    // Verifica que el Drawer muestre la radiografía de stock
    const drawer = page.getByRole('dialog', { name: 'Creatina Monohidratada' });
    await expect(drawer.getByRole('heading', { name: 'Stock registrado y reservas' })).toBeVisible();
    await expect(drawer.getByText('Libres', { exact: true }).locator('..')).toHaveText('Libres4u.');
    await expect(drawer.getByText('Reservadas', { exact: true }).locator('..')).toHaveText('Reservadas3u.');
    await expect(drawer.getByText('Stock registrado', { exact: true }).locator('..')).toHaveText('Stock registrado7u.');
  });
});
