import type { PickedFile } from './import';
import type { FixOptions, FixPlanSummary, FixReceipt, FixResponse } from '../worker/fix-protocol';

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
 *  quality, near-lossless, oxipng level, overrides, lazy `marking`, `skinGuard` — the Feature 4 pack
 *  fields — `packLoose`/`packMode`/`packGranularity`/`packTrim`/`packForced` — the scale-tier export
 *  fields `scaleTiers`/`tierForce`, the edge-extrude knob `extrude`, and the selective-fix `excludeKinds`
 *  mask — docs/improvements/selective-fix.md) is forwarded verbatim; this is a thin pass-through, no
 *  transformation. Absent/empty fields reproduce today (empty/absent scaleTiers ⇒ no tiering; extrude
 *  unset/0 ⇒ no gutter; excludeKinds absent/empty ⇒ full fix — all byte-identical). The execute run MUST
 *  carry the SAME `excludeKinds` the plan was previewed with so the committed subset matches the preview. */
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
      } else if (m.type === 'fix-error') {
        reject(new Error(m.error));
        worker.terminate();
      }
      // 'fix-plan' is never emitted on this path (runFix posts no mode ⇒ 'execute'); ignored if it arrives.
    };
    worker.onerror = (e): void => {
      reject(new Error(e.message || 'fix worker error'));
      worker.terminate();
    };
    worker.postMessage({ type: 'fix', files: files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes })), options });
  });
}

/** Dry-run preview (docs/improvements/dry-run-plan-preview.md): post the SAME files+options with
 *  mode:'plan'. The worker runs parse + analyze + planFix + the pre-loop gates, resolves with the
 *  deterministic `FixPlanSummary` (op COUNTS + would-be-skips + the reference-changing prediction; NO
 *  byte/VRAM number — honesty, invariant 5), then STOPS before the compose/pack/repack/tier pixel loop +
 *  zip. It is faster than execute (skips the heavy loop), NOT zero-pixel — the format-sizing encode +
 *  (aggressive) the feature pass still run to count transcodes/dedups. `options.excludeKinds` (selective
 *  fix) is forwarded verbatim so a re-previewed masked plan reflects exactly the subset execute will run.
 *  Pass the IDENTICAL `options` object (same `excludeKinds`) to runFix afterward to commit the plan
 *  byte-for-byte. Thin pass-through. */
export function planFix(files: PickedFile[], options: FixOptions): Promise<FixPlanSummary> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../worker/fix.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FixResponse>): void => {
      const m = e.data;
      if (m.type === 'fix-plan') {
        resolve(m.summary);
        worker.terminate();
      } else if (m.type === 'fix-error') {
        reject(new Error(m.error));
        worker.terminate();
      }
      // fix-progress/fix-done are never emitted in plan mode (the worker STOPS before the pixel loop);
      // ignored if one arrives.
    };
    worker.onerror = (e): void => {
      reject(new Error(e.message || 'fix worker error'));
      worker.terminate();
    };
    worker.postMessage({ type: 'fix', files: files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes })), options, mode: 'plan' });
  });
}
