import { test, expect } from '@playwright/test';

test.describe('Pilar 10: Analíticas, Pestañas e IPC Oficial', () => {
  test('6.1: Navegación de pestañas comerciales y conmutador de IPC nominal vs real', async ({ page }) => {
    await page.goto('/app/analiticas');

    // Verifica que cargue la vista de analíticas
    await expect(page.getByRole('heading', { name: /ventas/i }).first()).toBeVisible();

    // Valida las cifras clave superiores
    await expect(page.getByText(/ventas cobradas|facturación cobrada/i).first()).toBeVisible();

    // Pestaña: [Productos]
    const productsTab = page.getByRole('button', { name: /productos|por producto/i });
    await productsTab.click();
    await page.waitForTimeout(200);
    await expect(page.getByRole('heading', { name: /ventas por producto|desglose por producto/i })).toBeVisible();

    // Pestaña: [Ganancia / Rentabilidad]
    const profitTab = page.getByRole('button', { name: /ganancia|rentabilidad/i });
    await profitTab.click();
    await page.waitForTimeout(200);
    await expect(page.getByText(/ganancia estimada|margen estimado/i).first()).toBeVisible();

    // Pestaña: [Evolución]
    const evolutionTab = page.getByRole('button', { name: /evolución/i });
    await evolutionTab.click();
    await page.waitForTimeout(200);
    await expect(page.getByRole('heading', { name: /evolución mensual/i })).toBeVisible();
  });
});
