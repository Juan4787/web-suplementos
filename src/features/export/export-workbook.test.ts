import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import writeXlsxFile from 'write-excel-file/node';
import { demoBusinessApi } from '@/services/demo-business-api';
import { buildBusinessWorkbook } from './export-workbook';
import { toWritableSheets } from './xlsx-adapter';

const execFileAsync = promisify(execFile);
const libreOfficePath = ['/usr/bin/libreoffice', '/usr/local/bin/libreoffice']
  .find((path) => existsSync(path));
const libreOfficeIt = libreOfficePath ? it : it.skip;

describe('business XLSX contract', () => {
  it('keeps every recovery sheet even when a section is empty', async () => {
    const dataset = await demoBusinessApi.getExportDataset();
    const workbook = buildBusinessWorkbook(dataset);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual([
      'Resumen', 'Productos', 'Stock', 'Pedidos', 'Detalle pedidos', 'Ventas', 'Compras', 'Detalle compras', 'Movimientos', 'Reservas', 'Clientes', 'IPC', 'Usuarios'
    ]);
    expect(workbook.filename).toMatch(/^respaldo-impulso-\d{8}-\d{4}\.xlsx$/);
  });

  it('types user-controlled strings as text, including formula-like content', async () => {
    const dataset = await demoBusinessApi.getExportDataset();
    dataset.products[0]!.description = '=HYPERLINK("https://example.test")';
    const workbook = buildBusinessWorkbook(dataset);
    const writable = toWritableSheets(workbook);
    const productSheet = writable.find((sheet) => sheet.sheet === 'Productos')!;
    const descriptionCell = productSheet.data[1]![4] as { type: unknown; value: unknown };
    expect(descriptionCell.type).toBe(String);
    expect(descriptionCell.value).toBe('=HYPERLINK("https://example.test")');
  });

  it('produces a valid OOXML package without executable formulas', async () => {
    const dataset = await demoBusinessApi.getExportDataset();
    dataset.products[0]!.description = '=HYPERLINK("https://example.test")';
    const workbook = buildBusinessWorkbook(dataset);
    const buffer = await writeXlsxFile(toWritableSheets(workbook)).toBuffer();
    const files = unzipSync(buffer);

    expect(files['[Content_Types].xml']).toBeDefined();
    expect(files['xl/workbook.xml']).toBeDefined();
    expect(files['xl/styles.xml']).toBeDefined();

    const workbookXml = strFromU8(files['xl/workbook.xml']!);
    expect(workbookXml.match(/<sheet\b/gu)).toHaveLength(13);

    const xmlEntries = Object.entries(files)
      .filter(([path]) => path.endsWith('.xml'))
      .map(([path, contents]) => [path, strFromU8(contents)] as const);
    expect(xmlEntries.some(([, xml]) => /<f(?:\s|>)/u.test(xml))).toBe(false);

    const sharedStrings = xmlEntries.find(([path]) => path === 'xl/sharedStrings.xml')?.[1] ?? '';
    expect(sharedStrings).toContain('=HYPERLINK("https://example.test")');
  });

  it('includes stable IDs and snapshots required to reconstruct relationships', async () => {
    const dataset = await demoBusinessApi.getExportDataset();
    const workbook = buildBusinessWorkbook(dataset);
    const details = workbook.sheets.find((sheet) => sheet.name === 'Detalle pedidos')!;
    expect(details.headers).toEqual(expect.arrayContaining(['Pedido ID', 'Producto ID', 'Precio unitario ARS', 'Costo unitario ARS']));
    expect(details.rows.length).toBeGreaterThan(0);
    const orders = workbook.sheets.find((sheet) => sheet.name === 'Pedidos')!;
    expect(orders.headers).toEqual(expect.arrayContaining(['Código protocolo', 'Checksum protocolo', 'Reembolsado', 'Cancelado']));
    const reservations = workbook.sheets.find((sheet) => sheet.name === 'Reservas')!;
    expect(reservations.headers).toEqual(expect.arrayContaining(['Pedido ID', 'Producto ID', 'Estado']));
  });

  libreOfficeIt('can be reopened and saved again by LibreOffice', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'impulso-xlsx-'));
    const sourceDirectory = join(temporaryRoot, 'source');
    const reopenedDirectory = join(temporaryRoot, 'reopened');
    const profileDirectory = join(temporaryRoot, 'libreoffice-profile');
    await Promise.all([
      mkdir(sourceDirectory),
      mkdir(reopenedDirectory),
      mkdir(profileDirectory)
    ]);
    try {
      const dataset = await demoBusinessApi.getExportDataset();
      const workbook = buildBusinessWorkbook(dataset);
      const sourcePath = join(sourceDirectory, workbook.filename);
      await writeXlsxFile(toWritableSheets(workbook)).toFile(sourcePath);
      await execFileAsync(libreOfficePath!, [
        `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
        '--headless',
        '--convert-to',
        'xlsx',
        '--outdir',
        reopenedDirectory,
        sourcePath
      ], { timeout: 30_000 });

      const reopenedPath = join(reopenedDirectory, workbook.filename);
      expect((await stat(reopenedPath)).size).toBeGreaterThan(0);
      const reopenedFiles = unzipSync(await readFile(reopenedPath));
      const reopenedWorkbookXml = strFromU8(reopenedFiles['xl/workbook.xml']!);
      expect(reopenedWorkbookXml.match(/<sheet\b/gu)).toHaveLength(13);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 40_000);
});
