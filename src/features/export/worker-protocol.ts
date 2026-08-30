import type { ExportDataset } from '@/domain/types';

export type ExportWorkerRequest = { type: 'build'; requestId: string; dataset: ExportDataset };
export type ExportWorkerProgress = { type: 'progress'; requestId: string; phase: 'transforming' | 'writing' };
export type ExportWorkerSuccess = { type: 'success'; requestId: string; filename: string; mimeType: string; buffer: ArrayBuffer; byteLength: number };
export type ExportWorkerFailure = { type: 'error'; requestId: string; code: 'INVALID_DATA' | 'UNEXPECTED' };
export type ExportWorkerResponse = ExportWorkerProgress | ExportWorkerSuccess | ExportWorkerFailure;

