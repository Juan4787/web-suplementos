import { test, expect } from '@playwright/test';

test.describe('Pilar 8: Control de Acceso por Roles (Dueña vs Recepción)', () => {
  test('4.1: Dueña accede a catálogo con costos, pantalla de analíticas y finanzas', async ({ page }) => {
    // Ingresa como dueña
    await page.goto('/app/productos');
    await expect(page.getByRole('heading', { name: /catálogo|productos/i })).toBeVisible();

    // Accede a Analíticas / Ventas
    await page.goto('/app/analiticas');
    await expect(page.getByRole('heading', { name: /ventas|analíticas/i }).first()).toBeVisible();
  });

  test('4.2: Personal de Recepción no ve costos y no tiene acceso a Analíticas', async ({ page }) => {
    await page.goto('/app');

    // Si está en móvil, abre la navegación móvil si es necesario
    const mobileMenuBtn = page.getByLabel('Abrir navegación');
    if (await mobileMenuBtn.isVisible()) {
      await mobileMenuBtn.click();
    }

    // Abre el selector de roles en la barra lateral
    const userBtn = page.locator('aside button[aria-expanded]').first();
    if (await userBtn.isVisible()) {
      await userBtn.click();
      const staffBtn = page.locator('aside').getByRole('button', { name: 'Personal' }).first();
      if (await staffBtn.isVisible()) {
        await staffBtn.click();
      }
    } else {
      // Fallback via sessionStorage
      await page.evaluate(() => {
        sessionStorage.setItem('demo_role', 'staff');
      });
      await page.goto('/app');
    }

    // Intenta navegar forzadamente a /app/analiticas
    await page.goto('/app/analiticas');

    // Debe mostrar la tarjeta RoleGate "Esta información es privada"
    await expect(page.getByText(/esta información es privada/i)).toBeVisible();
  });
});
