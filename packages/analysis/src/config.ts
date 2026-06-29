import type { ThresholdConfig } from '@asset-doctor/core';

/** Default audit thresholds. Provisional — calibrate on fixtures, then on real assets.
 *  Kept here as the single source so rule logic never hardcodes magic numbers. */
export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  occupancy: { warn: 0.8, crit: 0.6 }, // fraction of atlas area covered by frames (calibrated on real packed exports: median 0.92)
  oversizePx: { warn: 2048, crit: 2730 }, // longest texture edge, px (budget-Android GL_MAX often 2048; crit = mid-device danger line)
  formatSaving: { warn: 0.25 }, // fraction of disk bytes a better format could save
  npotPadding: { warn: 0.25 }, // POT-padding waste before an NPOT finding fires (NPOT alone is fine on WebGL2/Pixi)
  duplicates: { similarHammingMax: 6 }, // dHash bits that may differ for "near-identical"
  shouldAtlas: { minLooseImages: 8, maxSpriteEdgePx: 512 }, // loose sprites worth packing
  atlasMerge: { occupancyBelow: 0.5, minAtlases: 2 }, // under-filled atlases worth merging
  mipmap: { warn: 4_194_304 }, // total conditional mip overhead (bytes) before the aggregate info fires.
  // One 2048² atlas alone is +5.59 MB and trips it; small UI-only sets (a 1024² page is only +1.33 MB) stay quiet.
  fragmentation: { warn: 0.4 }, // empty-space dispersion (largest hole / total empty) at/below which the
  // waste reads as shredded. The honest copy is dispersion-AWARE (scales the "full repack, not a trim"
  // wording with the measured frag at any value); it does NOT switch on this threshold today — the
  // value is the calibration hook for a future standalone fragmentation finding. PROVISIONAL — a
  // display/copy gate ONLY, NOT a savings gate (a MaxRects repack reclaims waste at any dispersion).
  solidFill: { minEdgePx: 256, warnEdgePx: 1024 }, // CALIBRATE — single-color loose image gate.
  // Both edges ≥ minEdgePx before flagging (a tiny swatch is harmless); ≥ warnEdgePx ⇒ warn (a 1024²
  // solid pins 4 MB VRAM for one color), else info. Loose-only; atlases never trip it.
  wastedAlpha: { minEdgePx: 64, minDiskSaving: 0.05 }, // CALIBRATE — fully-opaque-with-alpha-channel gate.
  // A loose PNG/WebP whose alpha is 255 everywhere carries a dead channel. Both edges ≥ minEdgePx before
  // flagging; the measured opaque re-encode (same format) must save ≥ minDiskSaving of disk bytes before
  // the finding fires. DISK-only (invariant 5: the GPU still allocates RGBA8888). Loose-only; atlases
  // never trip it. Browser-only — NOT in resolveThresholds (the CLI/budget gate never opts in).
  frameRedundancy: { minDuplicates: 3 }, // CALIBRATE — within-atlas duplicate-frame gate. A cluster of
  // byte-identical sprite REGIONS this large (counted by DISTINCT packed rect) before the finding fires:
  // a stray dupe pair is often a deliberate shared region, a redundant animation set is many. Recoverable
  // atlas AREA → VRAM; the disk number is an area-proportional ESTIMATE (invariant 5). Browser-only — NOT
  // in resolveThresholds (the worker hashes regions off the already-decoded page; the CLI never opts in).
  trimMargin: { minMarginPx: 4, minRecoverablePct: 0.05 }, // CALIBRATE — untrimmed-sprite transparent-padding
  // gate. `minMarginPx`: the largest single-side transparent border a sprite must carry before it counts (a
  // 1–2px border is noise / deliberate bleed). `minRecoverablePct`: the summed reclaimable margin must reach
  // this fraction of the WHOLE atlas before firing (baked-in uniform-cell padding is common and sometimes
  // intentional, so the floor keeps it quiet). Recoverable atlas AREA → VRAM (exact); the disk number is an
  // area-proportional ESTIMATE (invariant 5). Browser-only — NOT in resolveThresholds (the worker computes
  // opaque bboxes off the already-decoded page, the SAME pass as frameRedundancy; the CLI never opts in).
};
