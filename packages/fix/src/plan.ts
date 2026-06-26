// Translate a MEASURED AnalysisReport into a FixPlan — a pure, structured-cloneable list of operations
// (never invented, never carrying pixels). The worker executes it. Conservative by design: repack
// under-filled atlases, downscale oversized loose images, transcode images a better format would
// shrink, drop exact-duplicate copies. Resize takes precedence over transcode for the same image.

import type { AnalysisReport, FixOp, FixPlan, ImageMime } from '@asset-doctor/core';

export interface PlanOptions {
  /** Target format for transcode / resize encode + the repacked sheet image. */
  targetMime: ImageMime;
  quality: number;
  lossless: boolean;
  padding: number;
  maxSize: number;
  /** Downscale a loose image whose longest edge exceeds this (px). */
  maxEdge: number;
  /** Merge under-filled atlases into fewer sheets (NON-drop-in: rewrites manifest references). */
  mergeAtlases: boolean;
}

export function planFix(report: AnalysisReport, opts: PlanOptions): FixPlan {
  const ops: FixOp[] = [];
  const repacked = new Set<string>();
  const dropped = new Set<string>();
  const resized = new Set<string>();
  const isAtlas = (ref: string): boolean => report.assets.find((a) => a.assetRef === ref)?.occupancy !== undefined;

  // pass 0 (opt-in): merge under-filled atlas groups into one repack op BEFORE per-atlas repack, so
  // the merged atlases aren't also individually repacked. A multi-ref repack op = the merge.
  if (opts.mergeAtlases) {
    for (const f of report.findings) {
      if (f.rule !== 'atlas-merge') continue;
      const fresh = (f.relatedRefs ?? []).filter((r) => !repacked.has(r));
      if (fresh.length < 2) continue;
      fresh.forEach((r) => repacked.add(r));
      ops.push({ kind: 'repack', atlasRefs: fresh, targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize });
    }
  }

  // pass 1: repack under-filled atlases · drop exact dupes · resize oversized loose images
  for (const f of report.findings) {
    if (f.rule === 'occupancy' || f.rule === 'wasted-regions') {
      if (repacked.has(f.assetRef)) continue;
      repacked.add(f.assetRef);
      ops.push({ kind: 'repack', atlasRefs: [f.assetRef], targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize });
    } else if (f.rule === 'duplicate-exact') {
      for (const ref of (f.relatedRefs ?? []).slice(1)) {
        if (dropped.has(ref)) continue;
        dropped.add(ref);
        ops.push({ kind: 'drop', assetRef: ref, reason: 'duplicate-exact' });
      }
    } else if (f.rule === 'dimensions-oversize' && f.scope !== 'folder' && !isAtlas(f.assetRef)) {
      const w = Number(f.params?.w ?? 0);
      const h = Number(f.params?.h ?? 0);
      const longest = Math.max(w, h);
      if (w > 0 && h > 0 && longest > opts.maxEdge && !resized.has(f.assetRef)) {
        const s = opts.maxEdge / longest;
        resized.add(f.assetRef);
        ops.push({ kind: 'resize', assetRef: f.assetRef, to: { w: Math.round(w * s), h: Math.round(h * s) }, targetMime: opts.targetMime, quality: opts.quality });
      }
    }
  }

  // pass 2: transcode format-improvable images that weren't already resized or dropped
  for (const f of report.findings) {
    if (f.rule === 'format' && f.scope !== 'folder' && !resized.has(f.assetRef) && !dropped.has(f.assetRef)) {
      ops.push({ kind: 'transcode', assetRef: f.assetRef, targetMime: opts.targetMime, quality: opts.quality, lossless: opts.lossless });
    }
  }
  return { ops, thresholds: report.thresholds };
}
