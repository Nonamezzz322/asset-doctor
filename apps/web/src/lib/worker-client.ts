import type { AnalysisReport } from '@asset-doctor/core';
import type { PickedFile } from './import';
import type { WorkerResponse } from '../worker/protocol';
import { ABORT_ERROR, wireAbort } from './worker-abort';

export interface Progress {
  done: number;
  total: number;
  label: string;
}

/** Run the analysis worker. Bytes are structured-cloned (not transferred), so the caller
 *  keeps its copies for rendering the film-viewer. No network is involved. */
export function runAnalysis(
  files: PickedFile[],
  onProgress: (p: Progress) => void,
  // round18-abortable-workers: optional abort. ABSENT ⇒ no listener, no extra terminate ⇒ byte-identical
  // to today. Already-aborted at call time ⇒ reject AbortError WITHOUT constructing the worker.
  signal?: AbortSignal,
): Promise<AnalysisReport> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(ABORT_ERROR());
      return;
    }
    const worker = new Worker(new URL('../worker/analyze.worker.ts', import.meta.url), {
      type: 'module',
    });
    const wiring = wireAbort(worker, signal, reject);
    worker.onmessage = (e: MessageEvent<WorkerResponse>): void => {
      const msg = e.data;
      if (msg.type === 'progress') {
        if (wiring.aborted()) return; // superseded — drop a late progress (no UI write)
        onProgress({ done: msg.done, total: msg.total, label: msg.label });
      } else if (msg.type === 'done') {
        if (wiring.aborted()) return; // a done racing the terminate must not resolve an abandoned run
        wiring.cleanup();
        resolve(msg.report);
        worker.terminate();
      } else {
        wiring.cleanup();
        reject(new Error(msg.error));
        worker.terminate();
      }
    };
    worker.onerror = (e): void => {
      wiring.cleanup();
      reject(new Error(e.message || 'worker error'));
      worker.terminate();
    };
    worker.postMessage({
      type: 'analyze',
      files: files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes })),
    });
  });
}
