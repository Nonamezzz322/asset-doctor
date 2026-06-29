// Host side of PROBE-INTO-VERDICT (docs/improvements/probe-into-verdict.md). After the static
// analysis report is shown, replay each atlas's packed frames through a REAL offscreen-WebGL render
// (probeAtlas) on the MAIN thread and attach the MEASURED reading to the matching AssetMetrics. This
// is the moat: the actual GPU workload (draw calls + real decoded VRAM), not a static estimate.
//
// INVARIANTS this file upholds:
//  - Additive & non-destructive: when WebGL is unavailable OR there are no atlas frames, the SAME
//    report reference is returned unchanged (byte-identical to today; AssetMetrics.probe absent).
//  - Browser-only & feature-detected: probeAtlas needs a WebGL context; we probe a throwaway canvas
//    first and bail silently (no measured line) when it's missing.
//  - Non-blocking: the caller runs this AFTER setReport so the ≤10s first result is never delayed.
//  - Honest: probe.vramBytes is the REAL decoded texture footprint — a different quantity from the
//    static AssetMetrics.vramBytes (declared manifest size). Never combined into a savings delta.
//  - Deterministic: per-atlas integer sums are commutative; the GL instrument reports a deterministic
//    decoded size and Pixi makes no mipmaps for a one-shot render.

import type { AnalysisReport, AssetMetrics, ProbeReading, Rect } from '@asset-doctor/core';
import { probeAtlas } from '@asset-doctor/probe';

/** Feature-detect a usable WebGL context without allocating a Pixi app. Returns false (skip the
 *  probe silently) when the platform/headless env has no WebGL — e.g. some CI / privacy contexts. */
export function webglAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    return gl != null;
  } catch {
    return false;
  }
}

/** Decode an atlas's bytes to an ImageBitmap the probe can upload. The host re-reads these bytes from
 *  disk on demand (Round 21 #2 — the analyze worker holds the only resident copy); we decode our own
 *  off-critical-path copy here. Returns null on decode failure so one bad image never aborts the whole
 *  probe pass. */
async function decode(bytes: ArrayBuffer): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([bytes]));
  } catch {
    return null;
  }
}

/**
 * Probe every atlas in `report` (those with frames in report.atlasFrames) and return a NEW report
 * with each matching AssetMetrics.probe filled in and totals.probe aggregated. Non-destructive: the
 * input report and its objects are never mutated.
 *
 * @param report  the static analysis report (rendered already).
 * @param bytesOf resolve an asset's raw bytes by its assetRef. MAJOR2 invariant: the key passed here
 *                is `AssetMetrics.assetRef` === the atlas.name === the app's keyOf ref — the three are
 *                the same value, not interchangeable by luck. Asserted in tests. Round 21 #2: this may
 *                now resolve ASYNCHRONOUSLY (the host re-reads the bytes from disk on demand, since
 *                runAnalysis transfers/detaches the originals); a sync accessor still works (await of a
 *                non-Promise is the value). undefined/null ⇒ that atlas simply shows no measured line.
 * @param signal  optional abort signal: when a fresh analysis starts, the caller aborts the stale
 *                probe so its late results can't overwrite the new report.
 */
export async function attachProbeReadings(
  report: AnalysisReport,
  bytesOf: (assetRef: string) => Promise<ArrayBuffer | null | undefined> | ArrayBuffer | null | undefined,
  signal?: AbortSignal,
): Promise<AnalysisReport> {
  const frames = report.atlasFrames;
  // Nothing to probe (loose-only folder) or no WebGL ⇒ return the SAME reference unchanged.
  if (!frames || Object.keys(frames).length === 0 || !webglAvailable()) return report;
  if (signal?.aborted) return report;

  const readings = new Map<string, ProbeReading>();
  // Sequential (await-in-loop) on purpose: each probeAtlas destroys its Pixi app, freeing the GL
  // context between runs. Probing in parallel would risk hitting the browser's live-context cap.
  for (const ref of Object.keys(frames)) {
    if (signal?.aborted) return report;
    const rects = frames[ref] as Rect[];
    const bytes = await bytesOf(ref); // may re-read from disk (Round 21 #2) — sequential, off the ≤10s path
    if (signal?.aborted) return report; // a fresh run may have superseded us during the async re-read
    if (!bytes) continue; // no bytes for this atlas (re-read failed / shouldn't happen — MAJOR2 invariant)
    const bmp = await decode(bytes);
    if (!bmp) continue;
    try {
      // Pass the frame-extent bounding box (max x+w / y+h over the atlas frames) so probeAtlas sizes
      // its canvas to fit every frame (BLOCKER2): off-canvas sprites would otherwise be culled → drawCalls 0.
      const size = sizeOf(report, ref);
      const reading = await probeAtlas(bmp, rects, size);
      readings.set(ref, reading);
    } catch {
      // A per-atlas probe failure is swallowed — that atlas simply shows no measured line. The rest
      // of the report (and other atlases) is unaffected; the probe is never load-bearing.
    } finally {
      bmp.close();
    }
  }

  if (signal?.aborted || readings.size === 0) return report;

  // Build a NEW report: attach probe to matching assets, aggregate totals.probe. Pure integer sums
  // (commutative — iteration order is not load-bearing for determinism).
  let drawCalls = 0;
  let vramBytes = 0;
  const assets: AssetMetrics[] = report.assets.map((a) => {
    const r = readings.get(a.assetRef);
    if (!r) return a;
    drawCalls += r.drawCalls;
    vramBytes += r.vramBytes;
    return { ...a, probe: r };
  });

  return {
    ...report,
    assets,
    totals: {
      ...report.totals,
      probe: { drawCalls, vramBytes, atlasesProbed: readings.size },
    },
  };
}

/** The frame-extent bounding box (max x+w / y+h over the atlas frames) for an atlas ref — probeAtlas
 *  clamps this (≤ MAX_PROBE_DIM) to size its canvas so every frame renders on-canvas (drawCalls counted).
 *  Derived from the atlasFrames rects, NOT the declared meta.size (which atlasFrames doesn't carry). */
function sizeOf(report: AnalysisReport, ref: string): { w: number; h: number } | undefined {
  const rects = report.atlasFrames?.[ref] ?? [];
  let w = 0;
  let h = 0;
  for (const r of rects) {
    w = Math.max(w, r.x + r.w);
    h = Math.max(h, r.y + r.h);
  }
  return w > 0 && h > 0 ? { w, h } : undefined;
}
