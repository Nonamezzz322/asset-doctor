// Translate a MEASURED AnalysisReport into a FixPlan — a pure, structured-cloneable list of operations
// (never invented, never carrying pixels). The worker executes it. Conservative by design: repack
// under-filled atlases, transcode images a better format would shrink, drop exact-duplicate copies.

import type { AnalysisReport, FixOp, FixPlan, ImageMime } from '@asset-doctor/core';

export interface PlanOptions {
  /** Target format for transcode + the repacked sheet image. */
  targetMime: ImageMime;
  quality: number;
  lossless: boolean;
  padding: number;
  maxSize: number;
}

export function planFix(report: AnalysisReport, opts: PlanOptions): FixPlan {
  const ops: FixOp[] = [];
  const repacked = new Set<string>();
  const dropped = new Set<string>();

  for (const f of report.findings) {
    if (f.rule === 'occupancy' || f.rule === 'wasted-regions') {
      if (repacked.has(f.assetRef)) continue;
      repacked.add(f.assetRef);
      ops.push({ kind: 'repack', atlasRefs: [f.assetRef], targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize });
    } else if (f.rule === 'duplicate-exact') {
      // keep the first ref, drop the rest
      for (const ref of (f.relatedRefs ?? []).slice(1)) {
        if (!dropped.has(ref)) {
          dropped.add(ref);
          ops.push({ kind: 'drop', assetRef: ref, reason: 'duplicate-exact' });
        }
      }
    } else if (f.rule === 'format' && f.scope !== 'folder') {
      ops.push({ kind: 'transcode', assetRef: f.assetRef, targetMime: opts.targetMime, quality: opts.quality, lossless: opts.lossless });
    }
  }
  return { ops, thresholds: report.thresholds };
}
