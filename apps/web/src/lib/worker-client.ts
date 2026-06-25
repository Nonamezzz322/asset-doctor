import type { AnalysisReport } from '@asset-doctor/core';
import type { PickedFile } from './import';
import type { WorkerResponse } from '../worker/protocol';

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
): Promise<AnalysisReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../worker/analyze.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>): void => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress({ done: msg.done, total: msg.total, label: msg.label });
      } else if (msg.type === 'done') {
        resolve(msg.report);
        worker.terminate();
      } else {
        reject(new Error(msg.error));
        worker.terminate();
      }
    };
    worker.onerror = (e): void => {
      reject(new Error(e.message || 'worker error'));
      worker.terminate();
    };
    worker.postMessage({
      type: 'analyze',
      files: files.map((f) => ({ path: f.path, name: f.name, bytes: f.bytes })),
    });
  });
}
