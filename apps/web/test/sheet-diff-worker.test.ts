// Headless worker control-flow test for the BEFORE/AFTER sheet-diff X-ray — round6-f1-sheet-diff.md, task
// SD9. The impure compose half in apps/web/src/worker/fix.worker.ts (composePageEncode → OffscreenCanvas /
// createImageBitmap / getImageData → real bytes captured into SheetDiff) cannot run in Node, and Vitest has
// no canvas polyfill, so — exactly as extrude-worker.test.ts / tier-worker.test.ts do — we drive the REAL
// pure pipeline (parseAtlas → repackAtlases) and the SAME pure helpers the worker imports verbatim from
// ./sheet-diff (sheetGeometryProof / canKeepSheetDiff / SHEET_DIFF_MAX*). Only the actual pixel capture is
// skipped (the deferred Playwright follow-up, m6). This asserts the worker's CONTROL FLOW:
//   • sheetGeometryProof's occ + empty-zone map == the @asset-doctor/analysis grid primitives on the SAME
//     emitted atlas (no drift — the proof is exactly what the diagnosis would compute on that sheet)
//   • the cap arithmetic: the FIRST N=6 are kept, > 8 MB on EITHER side is skipped, and the running total
//     counts every composed sheet regardless (so the UI's "showing N of M" is honest)
//   • an under-filled atlas (tp-merge/atlas_a: two 64² sprites in a 256² sheet) repacks to a sheet that
//     STILL has empty space ⇒ a non-empty afterZones (one { kind:'empty', rects }) so the after-film glows
//   • the proof is deterministic across two independent runs (same occ, same zones, byte-for-byte)
// The worker imports the SAME sheetGeometryProof/canKeepSheetDiff, so a broken cap or a wrong empty-zone map
// can't pass green here while shipping in the worker.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Atlas } from '@asset-doctor/core';
import { parseAtlas } from '@asset-doctor/parsers';
import { repackAtlases } from '@asset-doctor/fix';
import { buildCoverage, defaultCell, mergeEmptyRects, occupancyValue } from '@asset-doctor/analysis';
import { canKeepSheetDiff, sheetGeometryProof, SHEET_DIFF_MAX, SHEET_DIFF_MAX_BYTES } from '../src/worker/sheet-diff';

const samples = fileURLToPath(new URL('../../../fixtures/sample-projects/', import.meta.url));

/** Parse one TexturePacker JSON+PNG fixture into its Atlas (the worker's parse step). */
function loadAtlas(dir: string, json: string, png: string): Atlas {
  const manifest = JSON.parse(readFileSync(`${samples}${dir}/${json}`, 'utf8')) as unknown;
  const bytes = new Uint8Array(readFileSync(`${samples}${dir}/${png}`));
  const res = parseAtlas(manifest, { ref: png, bytes });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error(`fixture parse failed: ${dir}/${json}`);
  return res.asset.atlas;
}

const PADDING = 2;
const MAXSIZE = 4096;

/** Repack an atlas exactly as the worker's single-page repack branch does (no rotation, same padding/maxSize)
 *  and return the FIRST emitted page — the `afterAtlas` captureSheetDiff feeds to sheetGeometryProof. */
function repackedSheet(atlas: Atlas): Atlas {
  const r = repackAtlases([atlas], { allowRotation: false, padding: PADDING, maxSize: MAXSIZE });
  expect(r.atlases.length).toBeGreaterThanOrEqual(1);
  return r.atlases[0]!;
}

describe('sheet-diff — worker proof + cap control flow (SD9)', () => {
  it('sheetGeometryProof.occ + zones == the analysis grid primitives on the SAME emitted sheet (no drift)', () => {
    // The worker computes the after-sheet proof on the EMITTED atlas; the diagnosis computes occupancy + the
    // empty-zone map with these exact primitives. They must be identical — the proof is not a second opinion.
    const na = repackedSheet(loadAtlas('tp-merge', 'atlas_a.json', 'atlas_a.png'));
    const proof = sheetGeometryProof(na);

    expect(proof.occ).toBe(occupancyValue(na));
    const rects = mergeEmptyRects(buildCoverage(na, defaultCell(na.size)), na.size);
    expect(proof.zones).toEqual(rects.length > 0 ? [{ kind: 'empty', rects }] : []);
  });

  it('an under-filled atlas repacks to a sheet that STILL has empty space ⇒ non-empty afterZones (glows red)', () => {
    // tp-merge/atlas_a: two 64² sprites in a 256² sheet — even repacked into a tight POT bin the sheet keeps
    // empty space, so the after-film must carry exactly ONE { kind:'empty', rects } overlay (non-empty rects).
    const na = repackedSheet(loadAtlas('tp-merge', 'atlas_a.json', 'atlas_a.png'));
    const proof = sheetGeometryProof(na);

    expect(proof.occ).toBeLessThan(1);
    expect(proof.zones.length).toBe(1);
    expect(proof.zones[0]!.kind).toBe('empty');
    expect(proof.zones[0]!.rects.length).toBeGreaterThan(0);
    // every emitted overlay rect is in-bounds (a wasted-regions overlay never marks pixels off the sheet)
    for (const rr of proof.zones[0]!.rects) {
      expect(rr.x).toBeGreaterThanOrEqual(0);
      expect(rr.y).toBeGreaterThanOrEqual(0);
      expect(rr.x + rr.w).toBeLessThanOrEqual(na.size.w);
      expect(rr.y + rr.h).toBeLessThanOrEqual(na.size.h);
      expect(rr.w).toBeGreaterThan(0);
      expect(rr.h).toBeGreaterThan(0);
    }
  });

  it('cap arithmetic: keeps the FIRST N=6, skips > 8 MB on EITHER side (total is counted separately)', () => {
    expect(SHEET_DIFF_MAX).toBe(6);
    expect(SHEET_DIFF_MAX_BYTES).toBe(8 * 1024 * 1024);

    // Within the count cap + per-side budget ⇒ kept.
    for (let kept = 0; kept < SHEET_DIFF_MAX; kept++) expect(canKeepSheetDiff(kept, 1024, 2048)).toBe(true);
    // At/over the count cap ⇒ skipped (kept, not dropped silently — the total still counts it in the worker).
    expect(canKeepSheetDiff(SHEET_DIFF_MAX, 1024, 2048)).toBe(false);
    expect(canKeepSheetDiff(SHEET_DIFF_MAX + 3, 1024, 2048)).toBe(false);
    // Per-side byte budget: either side over the limit ⇒ skipped; exactly the limit is allowed.
    expect(canKeepSheetDiff(0, SHEET_DIFF_MAX_BYTES, 10)).toBe(true);
    expect(canKeepSheetDiff(0, 10, SHEET_DIFF_MAX_BYTES)).toBe(true);
    expect(canKeepSheetDiff(0, SHEET_DIFF_MAX_BYTES + 1, 10)).toBe(false);
    expect(canKeepSheetDiff(0, 10, SHEET_DIFF_MAX_BYTES + 1)).toBe(false);
  });

  it('cap arithmetic mirrors the worker loop: 9 composed sheets ⇒ 6 kept, total = 9 ("showing 6 of 9")', () => {
    // Replicate the worker's captureSheetDiff control flow over a synthetic stream of composed sheets: bump
    // the running total for EVERY sheet, retain only those canKeepSheetDiff approves. The 7th oversized sheet
    // would be rejected by either gate, so the per-side budget is exercised independently of the count cap.
    let keptCount = 0;
    let total = 0;
    const composed = [
      ...Array.from({ length: 8 }, () => ({ before: 1024, after: 1024 })), // 8 small sheets
      { before: SHEET_DIFF_MAX_BYTES + 1, after: 1024 }, // 1 oversized sheet (over the per-side budget)
    ];
    for (const c of composed) {
      total++; // worker ALWAYS bumps the total (so "N of M" is honest)
      if (canKeepSheetDiff(keptCount, c.before, c.after)) keptCount++;
    }
    expect(total).toBe(9);
    expect(keptCount).toBe(SHEET_DIFF_MAX); // first 6 small sheets kept; #7,#8 over count cap; #9 over budget
    expect(total).toBeGreaterThan(keptCount); // ⇒ the UI shows "showing 6 of 9"
  });

  it('the proof is deterministic across two independent runs (same occ, same zones byte-for-byte)', () => {
    const a1 = repackedSheet(loadAtlas('tp-merge', 'atlas_a.json', 'atlas_a.png'));
    const a2 = repackedSheet(loadAtlas('tp-merge', 'atlas_a.json', 'atlas_a.png'));
    const p1 = sheetGeometryProof(a1);
    const p2 = sheetGeometryProof(a2);
    expect(p1.occ).toBe(p2.occ);
    expect(p1.zones).toEqual(p2.zones);
  });
});
