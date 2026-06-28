import type { AnalysisReport } from '@asset-doctor/core';

export interface InputFile {
  path: string;
  name: string;
  bytes: ArrayBuffer;
}

export type WorkerRequest =
  | { type: 'analyze'; files: InputFile[] }
  /** Cooperative cancel (round18-abortable-workers): the client posts this then terminate()s when an
   *  in-flight analysis is superseded. The worker sets a `cancelled` flag and stops at the next loop/post
   *  guard. ADDITIVE: never posted on a non-superseded run ⇒ every path byte-identical to today. */
  | { type: 'cancel' };

export type WorkerResponse =
  | { type: 'progress'; done: number; total: number; label: string }
  | { type: 'done'; report: AnalysisReport }
  | { type: 'error'; error: string };
