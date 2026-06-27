import type { PickedFile } from './import';
import type { FixOptions, FixReceipt, FixResponse } from '../worker/fix-protocol';

export interface FixProgress {
  label: string;
  done: number;
  total: number;
}
export interface FixOutcome {
  receipt: FixReceipt;
  zip: Blob;
}

/** Run the fix worker. Bytes are structured-cloned (never uploaded); the optimized folder comes back
 *  as a zip Blob for direct download. `options` (incl. the Feature 2/3 fields — effort, scale-aware
 *  quality, near-lossless, oxipng level, overrides, lazy `marking`, `skinGuard` — and the Feature 4
 *  pack fields — `packLoose`/`packMode`/`packGranularity`/`packTrim`/`packForced`) is forwarded
 *  verbatim; this is a thin pass-through, no transformation. Absent/empty fields reproduce today. */
export function runFix(files: PickedFile[], options: FixOptions, onProgress: (p: FixProgress) => void): Promise<FixOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../worker/fix.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FixResponse>): void => {
      const m = e.data;
      if (m.type === 'fix-progress') {
        onProgress({ label: m.label, done: m.done, total: m.total });
      } else if (m.type === 'fix-done') {
        resolve({ receipt: m.receipt, zip: m.zip });
        worker.terminate();
      } else {
        reject(new Error(m.error));
        worker.terminate();
      }
    };
    worker.onerror = (e): void => {
      reject(new Error(e.message || 'fix worker error'));
      worker.terminate();
    };
    worker.postMessage({ type: 'fix', files: files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes })), options });
  });
}
