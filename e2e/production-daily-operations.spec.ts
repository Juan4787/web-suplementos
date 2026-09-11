import { test, expect } from '@playwright/test';

test.describe('Verificación Rigurosa E2E de Operación Diaria', () => {
  test('Flujo completo de Dueña: Login, Dashboard, Pedidos, Ventas, Inventario y Catálogo', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    page.on('console', (msg) => console.log(`[BROWSER CONSOLE] ${msg.type()}: ${msg.text()}`));
    page.on('requestfailed', (req) => console.log(`[REQUEST FAILED] ${req.url()} - ${req.failure()?.errorText}`));

    // 1. Iniciar sesión si es necesario
    await page.goto('/ingresar');
    await expect(page.locator('#email')).toBeVisible({ timeout: 10000 });
    await page.fill('#email', 'natisfrutos@gmail.com');
    await page.fill('#password', 'natalia5050');
    
    // Click submit y esperar redirección o respuesta
    await Promise.all([
      page.waitForResponse((res) => res.url().includes('supabase') || res.status() === 200, { timeout: 15000 }).catch(() => null),
      page.getByRole('button', { name: /ingresar/i }).click()
    ]);

    // 2. Verificar Dashboard (/app)
    await page.waitForURL('**/app**', { timeout: 20000 });
    await expect(page.getByRole('heading', { name: 'Prioridades de hoy' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Facturación cobrada mes').first()).toBeVisible();
    await expect(page.getByText('$ 675.500').first()).toBeVisible();
    await expect(page.getByText('Margen estimado').first()).toBeVisible();
    
    // Verificar que NO exista ningún error boundary en la página
    await expect(page.locator('text=No pudimos completar la acción')).not.toBeVisible();
    await expect(page.locator('[role="alert"]')).not.toBeVisible();

    // 3. Verificar Pedidos (/app/pedidos)
    await page.goto('/app/pedidos');
    await expect(page.locator('text=No pudimos completar la acción')).not.toBeVisible();
    await expect(page.locator('[role="alert"]')).not.toBeVisible();
    
    // En la pestaña "Pendientes de acción", debe figurar #2410 (Pauli, esperando entrega)
    await expect(page.getByText('#2410').first()).toBeVisible({ timeout: 15000 });
    await page.getByText('#2410').first().click();
    await expect(page.getByText('PROBIOVANCE I5').first()).toBeVisible();
    await expect(page.getByText('Pauli').first()).toBeVisible();

    // Cambiar a la pestaña "Todos (8)" para ver el historial completo
    await page.getByRole('button', { name: /todos/i }).click();
    await expect(page.getByText('#2406').first()).toBeVisible({ timeout: 10000 });
    await page.getByText('#2406').first().click();
    await expect(page.getByText('MARIA ROSA PANIZZA').first()).toBeVisible();
    await expect(page.getByText('B COMPLEX ACTIVE').first()).toBeVisible();

    // 4. Verificar Ventas (/app/ventas)
    await page.goto('/app/ventas');
    await expect(page.locator('text=No pudimos completar la acción')).not.toBeVisible();
    await expect(page.getByRole('heading', { name: /ventas/i }).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('$ 675.500').first()).toBeVisible();

    // Cambiar a tab "Ventas por producto"
    const tabProducts = page.getByRole('button', { name: /ventas por producto|productos/i });
    if (await tabProducts.isVisible()) {
      await tabProducts.click();
      await expect(page.locator('table')).toBeVisible();
    }

    // 5. Verificar Inventario (/app/inventario)
    await page.goto('/app/inventario');
    await expect(page.locator('text=No pudimos completar la acción')).not.toBeVisible();
    await expect(page.getByRole('heading', { name: /inventario|stock/i }).first()).toBeVisible({ timeout: 15000 });

    // Cambiar a tab "Pedidos al proveedor / Compras"
    const tabPurchases = page.getByRole('button', { name: /pedidos al proveedor|compras/i });
    if (await tabPurchases.isVisible()) {
      await tabPurchases.click();
      // En pendientes figuran #2036 y #2035
      await expect(page.getByText('Pedido #2036').first()).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('Pedido #2035').first()).toBeVisible();
      // Cambiar a pestaña "Recibidos (1)" para verificar #2034
      await page.getByRole('button', { name: /recibidos/i }).click();
      await expect(page.getByText('Pedido #2034').first()).toBeVisible({ timeout: 10000 });
    }

    // 6. Verificar Storefront público (/catalogo o /)
    await page.goto('/');
    await expect(page.locator('text=No pudimos completar la acción')).not.toBeVisible();
    await expect(page.getByText('TIENDA DE SUPLEMENTOS').first()).toBeVisible();

    // 7. Aserción de Cero Errores no controlados de JavaScript
    expect(pageErrors).toEqual([]);
  });
});
