// Host side of RENDER-PROBE-THE-PRODUCED-FIX (docs/improvements/round17-render-probe-the-produced-fix-measured.md).
// The fix worker emits each repacked/merged/packed sheet's before/after page bytes + packed frame rects on
// `fix-done` (SheetDiff), but it has NO WebGL. Here, on the MAIN thread, we replay each sheet's frames as
// sprites through a REAL offscreen-WebGL render (probeAtlas) and read the ACTUAL GPU workload — turning the
// static `before → after` VRAM strip into a SEPARATE, MEASURED "on your GPU this run" surface (draw calls +
// real decoded VRAM). This is the third sibling of the host probe seam (attachProbeReadings on the audit,
// attachKtx2Probe on the produced .ktx2).
//
// INVARIANTS this file upholds:
//  - DEVICE-LOCAL honesty (inv. 3 & 5): the four measured fields are "on YOUR GPU this run". `decodedVram*`
//    is the REAL decoded footprint (ProbeReading.vramBytes), a DIFFERENT quantity from the static `vram*`
//    (declared w·h·4). They are attached as SEPARATE SheetDiff fields, NEVER folded into vramBefore/After,
//    vramBytesAfter, or vramSaved — the static `→` strip stays the SOLE declared saving claim.
//  - Additive & non-destructive: no sheetDiffs / no WebGL / abort / zero successes ⇒ the SAME receipt
//    reference is returned unchanged (byte-identical to today). A per-sheet failure is swallowed — the
//    probe is NEVER load-bearing.
//  - Browser-only & feature-detected: reuses webglAvailable() (probe-run.ts); bails silently when missing.
//  - BUFFER SAFETY: we decode each sheet's bytes via createImageBitmap(new Blob([bytes])). Blob COPIES the
//    bytes ⇒ the ArrayBuffer is NEVER detached, so the FilmViewer's later reads of the SAME
//    diff.before/afterBytes (App.tsx) are unaffected. A future refactor MUST NOT switch to a transferable
//    decode path — that would silently detach the bytes the FilmViewer still needs.
//  - Deterministic shape: per-sheet integer readouts, no cross-sheet aggregation ⇒ iteration order is not
//    load-bearing. (The measured device values themselves are device-local, not asserted deterministic.)

import type { FixReceipt, SheetDiff } from '../worker/fix-protocol';
import type { Rect } from '@asset-doctor/core';
import { probeAtlas } from '@asset-doctor/probe';
import { webglAvailable } from './probe-run';

/** Decode raster sheet bytes → ImageBitmap via Blob (Blob COPIES ⇒ the ArrayBuffer is NOT detached, so the
 *  FilmViewer's later reads of the SAME diff.before/afterBytes are unaffected). null on failure: one bad
 *  sheet never aborts the pass. */
async function decode(bytes: ArrayBuffer): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(new Blob([bytes]));
  } catch {
    return null;
  }
}

/** Max frame extent (w = max x+w, h = max y+h) so probeAtlas sizes its canvas to fit every frame (mirrors
 *  probe-run.sizeOf / BLOCKER2): off-canvas sprites would otherwise be culled → drawCalls 0. undefined ⇒
 *  probeAtlas falls back to 256². */
function extentOf(frames: Rect[]): { w: number; h: number } | undefined {
  let w = 0;
  let h = 0;
  for (const f of frames) {
    w = Math.max(w, f.x + f.w);
    h = Math.max(h, f.y + f.h);
  }
  return w > 0 && h > 0 ? { w, h } : undefined;
}

/** The measured fields one sheet's probe pass can fill — built per sheet, spread onto a fresh SheetDiff. */
type MeasuredFields = Partial<
  Pick<SheetDiff, 'drawCallsBefore' | 'drawCallsAfter' | 'decodedVramBefore' | 'decodedVramAfter'>
>;

/**
 * Replay each capped SheetDiff's before+after frames through real offscreen WebGL and return a NEW receipt
 * whose sheetDiffs carry the MEASURED draw-calls / decoded-VRAM fields. Returns the SAME receipt reference
 * (byte-identical to today) when: there are no sheetDiffs, OR WebGL is unavailable, OR the caller already
 * aborted, OR zero sheets produced ANY measured field. Non-destructive: the input receipt and its
 * SheetDiffs are never mutated.
 *
 * @param receipt the worker's receipt (untouched on the no-op paths).
 * @param signal  optional abort: a fresh fix run can cancel a stale probe (the worker is also terminated).
 */
export async function attachSheetProbes(receipt: FixReceipt, signal?: AbortSignal): Promise<FixReceipt> {
  if (!receipt.sheetDiffs?.length || !webglAvailable() || signal?.aborted) return receipt;

  const measured: MeasuredFields[] = [];
  let any = false;

  // Sequential (await-in-loop) on purpose: each probeAtlas destroys its Pixi app, freeing the GL context
  // between runs (same live-context-cap reasoning as attachProbeReadings / attachKtx2Probe).
  for (const d of receipt.sheetDiffs) {
    if (signal?.aborted) break;
    const m: MeasuredFields = {};

    // BEFORE: absent for a pack page (no source atlas ⇒ no honest "before").
    if (d.beforeFrames?.length) {
      const bmp = await decode(d.beforeBytes);
      if (bmp) {
        try {
          const r = await probeAtlas(bmp, d.beforeFrames, extentOf(d.beforeFrames));
          m.drawCallsBefore = r.drawCalls;
          m.decodedVramBefore = r.vramBytes;
          any = true;
        } catch {
          // per-sheet failure swallowed — this side simply shows no measured "before".
        } finally {
          bmp.close();
        }
      }
    }

    // AFTER: the emitted sheet (afterFrames present once frames are wired). Independent of the before side.
    if (d.afterFrames?.length) {
      const bmp = await decode(d.afterBytes);
      if (bmp) {
        try {
          const r = await probeAtlas(bmp, d.afterFrames, extentOf(d.afterFrames));
          m.drawCallsAfter = r.drawCalls;
          m.decodedVramAfter = r.vramBytes;
          any = true;
        } catch {
          // per-sheet failure swallowed — this side simply shows no measured "after".
        } finally {
          bmp.close();
        }
      }
    }

    measured.push(m);
  }

  if (!any || signal?.aborted) return receipt;

  // Build a NEW receipt: attach the measured, device-local fields BESIDE the static strip. Each SheetDiff
  // is a fresh spread ⇒ the input receipt + its SheetDiffs are never mutated.
  return {
    ...receipt,
    sheetDiffs: receipt.sheetDiffs.map((d, i) => ({ ...d, ...measured[i] })),
  };
}
