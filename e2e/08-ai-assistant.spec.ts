import { test, expect } from '@playwright/test';

test.describe('Pilar 12: Asistente de Negocio e IA (Determinístico)', () => {
  test('8.1: Pantalla del asistente responde consultas o indica estado de configuración segura', async ({ page }) => {
    await page.goto('/app/ia');

    // Verifica que cargue el encabezado del asistente
    await expect(page.getByRole('heading', { name: /asistente/i }).first()).toBeVisible();

    // Verifica que la vista presente la explicación de seguridad o la interfaz de consulta
    await expect(
      page.getByText(/el núcleo no depende de la ia|asistente del negocio|solo lectura/i).first()
    ).toBeVisible();
  });
});
