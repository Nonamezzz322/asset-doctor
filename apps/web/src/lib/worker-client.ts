import type { AnalysisReport } from '@asset-doctor/core';
import type { PickedFile } from './import';
import type { WorkerResponse } from '../worker/protocol';
import { ABORT_ERROR, wireAbort } from './worker-abort';

export interface Progress {
  done: number;
  total: number;
  label: string;
}

/** Run the analysis worker. Round 21 #2: bytes are TRANSFERRED into the worker when EVERY PickedFile carries
 *  a re-readable `file` — the worker becomes the SOLE resident copy (killing the former ~2× copy: worker
 *  clone + main-thread eager byte map), and the caller re-reads on demand from disk (lib/source-bytes.ts) for
 *  the FilmViewer/probe/fix. If ANY file lacks `file` (a legacy producer with no re-read path), bytes are
 *  CLONED instead (today's behavior) so those callers stay correct. Either way no network is involved. */
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
    const payload = files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes }));
    // TRANSFER only when the caller can re-read every file from disk afterward (else the detach would strand
    // the FilmViewer/probe/fix with no bytes). All-or-nothing: a single legacy file ⇒ clone the whole batch.
    const canTransfer = files.length > 0 && files.every((f) => f.file !== undefined);
    worker.postMessage(
      { type: 'analyze', files: payload },
      canTransfer ? payload.map((f) => f.bytes) : [],
    );
  });
}
