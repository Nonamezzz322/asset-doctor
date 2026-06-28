// PURE, Node-testable half of the before/after sheet-diff X-ray (docs/improvements/round6-f1-sheet-diff.md).
// Factored OUT of fix.worker.ts (which can't run in Node — it references `self`/DedicatedWorkerGlobalScope
// and OffscreenCanvas) so the cap arithmetic + the emitted-sheet geometry proof can be asserted headless,
// against the SAME @asset-doctor/analysis grid primitives the diagnosis uses (no drift). The impure worker
// imports BOTH helpers verbatim, so a broken cap or a wrong empty-zone map can't pass green here while
// shipping in the worker.

import type { Atlas, OverlayZone } from '@asset-doctor/core';
import { buildCoverage, defaultCell, mergeEmptyRects, occupancyValue } from '@asset-doctor/analysis';

// Sheet-diff caps: capture the FIRST N composed sheets, and skip any pair where the before OR after bytes
// exceed the per-side budget (keeps the receipt payload + the two FilmViewer decodes bounded). The TOTAL is
// counted by the worker regardless (so the UI can say "showing N of M") — these caps gate only what is KEPT.
export const SHEET_DIFF_MAX = 6;
export const SHEET_DIFF_MAX_BYTES = 8 * 1024 * 1024;

/** PURE geometry proof of an emitted sheet: its packed-area occupancy + the still-empty grid rects (a
 *  wasted-regions overlay), computed with the SAME analysis primitives the diagnosis uses (no drift — no
 *  analysis change). Returns [] zones when the sheet is fully packed. Testable headless. */
export function sheetGeometryProof(atlas: Atlas): { occ: number; zones: OverlayZone[] } {
  const occ = occupancyValue(atlas);
  const rects = mergeEmptyRects(buildCoverage(atlas, defaultCell(atlas.size)), atlas.size);
  return { occ, zones: rects.length > 0 ? [{ kind: 'empty', rects }] : [] };
}

/** PURE cap decision for one composed sheet: keep its before/after bytes only when fewer than
 *  SHEET_DIFF_MAX are already kept AND neither side exceeds SHEET_DIFF_MAX_BYTES. The worker ALWAYS bumps
 *  its running total before consulting this (the total counts every composed sheet); this predicate gates
 *  only whether the pair is RETAINED for the receipt. Deterministic, side-effect-free. */
export function canKeepSheetDiff(keptSoFar: number, beforeByteLength: number, afterByteLength: number): boolean {
  if (keptSoFar >= SHEET_DIFF_MAX) return false;
  if (beforeByteLength > SHEET_DIFF_MAX_BYTES || afterByteLength > SHEET_DIFF_MAX_BYTES) return false;
  return true;
}
