import type { AnalysisReport } from '@asset-doctor/core';

export interface InputFile {
  path: string;
  name: string;
  bytes: ArrayBuffer;
}

export type WorkerRequest = { type: 'analyze'; files: InputFile[] };

export type WorkerResponse =
  | { type: 'progress'; done: number; total: number; label: string }
  | { type: 'done'; report: AnalysisReport }
  | { type: 'error'; error: string };
