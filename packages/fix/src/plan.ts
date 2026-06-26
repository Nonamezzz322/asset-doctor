// Translate a MEASURED AnalysisReport into a FixPlan — a pure, structured-cloneable list of operations
// (never invented, never carrying pixels). The worker executes it.
//
// DROP-IN (default): repack under-filled atlases, downscale oversized atlases AND loose images,
// transcode loose images. AGGRESSIVE (opt-in, reference-changing): merge under-filled atlas groups
// and drop exact + near duplicate copies. Resize takes precedence over transcode for the same image.

import type { AnalysisReport, FixOp, FixPlan, ImageMime } from '@asset-doctor/core';

export interface PlanOptions {
  /** Target format for transcode + the repacked sheet image. */
  targetMime: ImageMime;
  quality: number;
  lossless: boolean;
  padding: number;
  maxSize: number;
  /** Downscale any image/atlas whose longest edge exceeds this (px). */
  maxEdge: number;
  /** Aggressive, NON-drop-in: merge under-filled atlas groups + drop exact & near duplicates. */
  aggressive: boolean;
}

export function planFix(report: AnalysisReport, opts: PlanOptions): FixPlan {
  const ops: FixOp[] = [];
  const repacked = new Set<string>();
  const dropped = new Set<string>();
  const resized = new Set<string>();

  const dropGroup = (refs: string[]): void => {
    for (const ref of refs.slice(1)) {
      if (dropped.has(ref) || repacked.has(ref)) continue;
      dropped.add(ref);
      ops.push({ kind: 'drop', assetRef: ref, reason: 'duplicate-exact' });
    }
  };

  // pass 0 (aggressive): collapse each atlas-merge group into one multi-ref repack op (the merge),
  // before per-atlas repack so merged atlases aren't also individually repacked.
  if (opts.aggressive) {
    for (const f of report.findings) {
      if (f.rule !== 'atlas-merge') continue;
      const fresh = (f.relatedRefs ?? []).filter((r) => !repacked.has(r));
      if (fresh.length < 2) continue;
      fresh.forEach((r) => repacked.add(r));
      ops.push({ kind: 'repack', atlasRefs: fresh, targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize });
    }
  }

  // pass 1: repack under-filled atlases · resize oversized atlases/images · (aggressive) drop dupes
  for (const f of report.findings) {
    if (f.rule === 'occupancy' || f.rule === 'wasted-regions') {
      if (repacked.has(f.assetRef)) continue;
      repacked.add(f.assetRef);
      ops.push({ kind: 'repack', atlasRefs: [f.assetRef], targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize });
    } else if (f.rule === 'dimensions-oversize' && f.scope !== 'folder') {
      const w = Number(f.params?.w ?? 0);
      const h = Number(f.params?.h ?? 0);
      const longest = Math.max(w, h);
      // an atlas that's also being repacked may already shrink; don't double-handle it
      if (w > 0 && h > 0 && longest > opts.maxEdge && !resized.has(f.assetRef) && !repacked.has(f.assetRef)) {
        const s = opts.maxEdge / longest;
        resized.add(f.assetRef);
        ops.push({ kind: 'resize', assetRef: f.assetRef, to: { w: Math.round(w * s), h: Math.round(h * s) }, targetMime: opts.targetMime, quality: opts.quality });
      }
    } else if (opts.aggressive && (f.rule === 'duplicate-exact' || f.rule === 'duplicate-similar')) {
      dropGroup(f.relatedRefs ?? []);
    }
  }

  // pass 2: transcode format-improvable images not already resized or dropped
  for (const f of report.findings) {
    if (f.rule === 'format' && f.scope !== 'folder' && !resized.has(f.assetRef) && !dropped.has(f.assetRef)) {
      ops.push({ kind: 'transcode', assetRef: f.assetRef, targetMime: opts.targetMime, quality: opts.quality, lossless: opts.lossless });
    }
  }
  return { ops, thresholds: report.thresholds };
}
