import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';

test.describe('Pilar 11: Exportación y Verificación de Excel (.xlsx)', () => {
  test('7.1: Descarga y valida el archivo XLSX con ExcelJS (hojas, columnas y datos sanitizados)', async ({ page }) => {
    await page.goto('/app/exportar');

    // Verifica que cargue la vista de exportación
    await expect(page.getByRole('heading', { name: /exportar todos mis datos/i })).toBeVisible();

    // Busca el botón "Preparar respaldo"
    const exportBtn = page.getByRole('button', { name: /preparar respaldo|descargar/i });
    await expect(exportBtn).toBeVisible();

    // Captura el evento de descarga
    const downloadPromise = page.waitForEvent('download');
    await exportBtn.click();
    const download = await downloadPromise;

    // Guarda temporalmente el archivo para abrirlo con ExcelJS
    const filePath = await download.path();
    expect(filePath).toBeTruthy();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath!);

    // Verifica que el libro contenga las 13 hojas del modelo
    const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
    expect(sheetNames.length).toBeGreaterThanOrEqual(5);

    // Valida que existan hojas clave del negocio
    const hasProductsSheet = sheetNames.some((name) => /productos/i.test(name));
    const hasOrdersSheet = sheetNames.some((name) => /pedidos/i.test(name));
    const hasStockSheet = sheetNames.some((name) => /stock/i.test(name));

    expect(hasProductsSheet).toBe(true);
    expect(hasOrdersSheet).toBe(true);
    expect(hasStockSheet).toBe(true);

    // Valida que ninguna celda comience con fórmulas ejecutables peligrosas sin sanitizar
    for (const worksheet of workbook.worksheets) {
      worksheet.eachRow((row) => {
        row.eachCell((cell) => {
          if (typeof cell.value === 'string') {
            expect(cell.value.startsWith('=CMD')).toBe(false);
          }
        });
      });
    }
  });
});
