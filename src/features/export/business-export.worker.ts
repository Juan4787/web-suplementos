/// <reference lib="webworker" />

import writeXlsxFile from 'write-excel-file/browser';
import { buildBusinessWorkbook, WorkbookBuildError } from './export-workbook';
import { toWritableSheets } from './xlsx-adapter';
import type { ExportWorkerRequest, ExportWorkerResponse } from './worker-protocol';

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let busy = false;
const respond = (message: ExportWorkerResponse, transfer?: Transferable[]) => scope.postMessage(message, transfer ?? []);

scope.addEventListener('message', async (event: MessageEvent<ExportWorkerRequest>) => {
  const request = event.data;
  if (busy || request?.type !== 'build' || !request.requestId) {
    respond({ type: 'error', requestId: request?.requestId ?? 'invalid', code: 'INVALID_DATA' });
    return;
  }
  busy = true;
  try {
    respond({ type: 'progress', requestId: request.requestId, phase: 'transforming' });
    const workbook = buildBusinessWorkbook(request.dataset);
    respond({ type: 'progress', requestId: request.requestId, phase: 'writing' });
    const blob = await writeXlsxFile(toWritableSheets(workbook)).toBlob();
    const buffer = await blob.arrayBuffer();
    respond({ type: 'success', requestId: request.requestId, filename: workbook.filename, mimeType: workbook.mimeType, buffer, byteLength: buffer.byteLength }, [buffer]);
  } catch (error) {
    console.error('Falló la construcción del respaldo XLSX', { name: error instanceof Error ? error.name : typeof error });
    respond({ type: 'error', requestId: request.requestId, code: error instanceof WorkbookBuildError ? 'INVALID_DATA' : 'UNEXPECTED' });
  } finally {
    busy = false;
    scope.close();
  }
});

