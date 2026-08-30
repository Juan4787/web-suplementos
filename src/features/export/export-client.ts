import type { ExportDataset } from '@/domain/types';
import { XLSX_MIME } from './export-workbook';
import type { ExportWorkerRequest, ExportWorkerResponse } from './worker-protocol';

export class ExportBuildError extends Error {
  constructor(message: string) { super(message); this.name = 'ExportBuildError'; }
}

export const buildExport = (
  dataset: ExportDataset,
  onProgress?: (phase: 'transforming' | 'writing') => void
): Promise<{ blob: Blob; filename: string; byteLength: number }> => {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./business-export.worker.ts', import.meta.url), { type: 'module', name: 'impulso-business-export' });
  } catch {
    return Promise.reject(new ExportBuildError('No pudimos iniciar la creación del archivo. Volvé a intentarlo.'));
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      callback();
    };
    worker.addEventListener('error', () => finish(() => reject(new ExportBuildError('No pudimos crear el archivo Excel. Volvé a intentarlo.'))));
    worker.addEventListener('message', (event: MessageEvent<ExportWorkerResponse>) => {
      const message = event.data;
      if (message.requestId !== requestId) return;
      if (message.type === 'progress') { onProgress?.(message.phase); return; }
      if (message.type === 'error') { finish(() => reject(new ExportBuildError(message.code === 'INVALID_DATA' ? 'No pudimos comprobar que todos los datos del respaldo fueran válidos.' : 'No pudimos crear el archivo Excel. Volvé a intentarlo.'))); return; }
      if (message.type === 'success' && message.mimeType === XLSX_MIME && /^respaldo-impulso-\d{8}-\d{4}\.xlsx$/.test(message.filename) && message.buffer instanceof ArrayBuffer && message.byteLength === message.buffer.byteLength) {
        finish(() => resolve({ blob: new Blob([message.buffer], { type: XLSX_MIME }), filename: message.filename, byteLength: message.byteLength }));
        return;
      }
      finish(() => reject(new ExportBuildError('El archivo generado estaba incompleto. Volvé a intentarlo.')));
    });
    const request: ExportWorkerRequest = { type: 'build', requestId, dataset };
    worker.postMessage(request);
  });
};

export const downloadExport = ({ blob, filename }: { blob: Blob; filename: string }) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

