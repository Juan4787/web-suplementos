import { expect, test, type Page } from '@playwright/test';

const openVisibleNavigation = async (page: Page) => {
  const menu = page.getByRole('button', { name: 'Abrir navegación' });
  if (await menu.isVisible()) await menu.click();
};

test.describe('Gastos varios y ganancia neta', () => {
  test('crea una recurrencia con revelado progresivo y la descuenta del período', async ({ page }) => {
    await page.goto('/app/configuracion');
    await expect(page.getByText('DEMO', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gastos varios' })).toBeVisible();

    await page.getByRole('button', { name: 'Agregar gasto' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Agregar gasto' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Fecha de finalización')).toHaveCount(0);

    await dialog.getByLabel('Título del gasto').fill('Etiquetas auditoría');
    await dialog.getByLabel('Monto (ARS)').fill('12345,67');
    await expect(dialog.getByLabel('Monto (ARS)')).toHaveValue('12.345,67');
    await dialog.getByRole('button', { name: 'Mensual' }).click();
    await expect(dialog.getByText('¿Este gasto termina en una fecha?')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'Sí' })).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog.getByLabel('Fecha de finalización')).toHaveCount(0);
    await expect(dialog.getByText(/se descontará cada mes/i)).toBeVisible();
    await dialog.getByRole('button', { name: 'Agregar gasto' }).click();

    await expect(page.getByText('Gasto agregado')).toBeVisible();
    const expenseRow = page.locator('article').filter({ hasText: 'Etiquetas auditoría' });
    await expect(expenseRow).toContainText('Mensual');
    await expect(expenseRow).toContainText('12.345,67');

    const selectedMonth = await page.locator('#misc-expenses-month').inputValue();
    const from = `${selectedMonth}-01`;
    const [year, month] = selectedMonth.split('-').map(Number);
    const to = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
    const analytics = await page.evaluate(async ({ from, to }) => {
      const api = await (window as typeof window & {
        __getBusinessApi: () => Promise<{ getAnalytics: (start: string, end: string) => Promise<{
          commercialMarginCents: number;
          miscExpensesCents: number;
          estimatedMarginCents: number;
        }> }>;
      }).__getBusinessApi();
      return api.getAnalytics(from, to);
    }, { from, to });
    expect(analytics.miscExpensesCents).toBe(1_234_567);
    expect(analytics.estimatedMarginCents).toBe(
      analytics.commercialMarginCents - analytics.miscExpensesCents
    );

    await openVisibleNavigation(page);
    await page.getByRole('link', { name: 'Ventas', exact: true }).filter({ visible: true }).click();
    const netProfitCard = page.locator('article').filter({ hasText: 'Ganancia neta' }).first();
    await expect(netProfitCard).toContainText('gastos varios');

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(hasHorizontalOverflow).toBe(false);
  });
});
