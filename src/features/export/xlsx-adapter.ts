import type { CellObject, SheetData } from 'write-excel-file/browser';
import type { BusinessWorkbook, WorkbookCell } from './export-workbook';

export type WritableSheet = {
  sheet: string;
  data: SheetData;
  columns: { width: number }[];
  stickyRowsCount: number;
  showGridLines: boolean;
};

const header = (value: string): CellObject => ({
  value,
  type: String,
  fontWeight: 'bold',
  textColor: '#FFFFFF',
  backgroundColor: '#0A1E3F',
  align: 'left',
  alignVertical: 'center',
  wrap: true,
  height: 30,
  bottomBorderColor: '#3B82F6',
  bottomBorderStyle: 'thin'
});

const cell = (value: WorkbookCell): CellObject | null => {
  if (value === null) return null;
  if (value.kind === 'number') return { value: value.value, type: Number, align: 'right', alignVertical: 'top' };
  return { value: value.value, type: String, alignVertical: 'top', wrap: true };
};

export const toWritableSheets = (workbook: BusinessWorkbook): WritableSheet[] =>
  workbook.sheets.map((source) => ({
    sheet: source.name,
    data: [source.headers.map(header), ...source.rows.map((row) => row.map(cell))],
    columns: source.widths.map((width) => ({ width })),
    stickyRowsCount: 1,
    showGridLines: true
  }));

