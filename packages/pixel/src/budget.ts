// Per-page scan-budget POLICY for the analyze pixel path — the ONE source of truth for the full-resolution
// read cap, importable by every host that decodes pages (the web analyze worker, the extension overlay).
// Extracted from apps/web's bitmap-budget.ts (Round 21 #2) so the worker and the extension share it verbatim
// instead of re-declaring the constant and drifting.
//
// HONESTY (Inv 5): ANALYZE_PAGE_MAX_PX is a WORKING-SET bound on a transient decode buffer — NEVER a VRAM or
// saving number. ADDITIVITY: above the cap the host SKIPS the optional feature (opaque/premult scan / frame
// hash) honestly and surfaces it in the report's `unparsed[]`; the value is unchanged from before, so the
// exact same pages are scanned ⇒ identical findings. DETERMINISM: pure integer-ish px math, no Date/random.

/** Per-page px cap on a host's FULL-RESOLUTION reads (the alpha/premult scan + the frame-hash page buffer,
 *  each a w·h·4 RGBA surface resident transiently). 4096·4096·1.5 ≈ 25.2 MP — a generous loose-art/page
 *  ceiling. Above it the host skips honestly. */
export const ANALYZE_PAGE_MAX_PX = 4096 * 4096 * 1.5; // ≈ 25.2 MP

/** TRUE when a w×h page exceeds the scan budget (skip the full-resolution read honestly). Pure. A
 *  degenerate w≤0 || h≤0 page ⇒ true (nothing to scan — matches the host's existing >0 guards). Uses
 *  `>` so a page EXACTLY at the cap is still scanned. */
export const pageExceedsScanBudget = (w: number, h: number): boolean =>
  w <= 0 || h <= 0 || w * h > ANALYZE_PAGE_MAX_PX;

/** Deterministic English reason for an oversize-skip `unparsed[]` entry (free-form, matching the existing
 *  ingest/parse skip reasons; CLI stays EN). `toFixed(1)` ⇒ stable across runs. */
export const scanSkipReason = (w: number, h: number): string =>
  `skipped for size: ${w}×${h} (${((w * h) / 1e6).toFixed(1)} MP) exceeds ${(ANALYZE_PAGE_MAX_PX / 1e6).toFixed(1)} MP scan budget`;
