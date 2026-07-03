// Pure perceptual-hash helpers (testable headless). The worker decodes an image to a 9×8
// grayscale and calls these; keeping the math here means it can be unit-tested without a canvas.

import type { ContentClass } from '@asset-doctor/core';
import { ANALYZE_PAGE_MAX_PX } from './bitmap-budget';

const DW = 9; // sample width
const DH = 8; // sample height

// ── Content-class consts (docs/improvements/content-class.md §4, calibrated above dedup's minStdDev=6).
/** grayStdDev below this ⇒ genuinely low-variance fill ⇒ 'flat'. Mid/high-variance (incl. smooth
 *  gradients) falls to 'photographic' — gradients are deliberately OUT of the confident set (M2). */
export const FLAT_STD = 12;
/** Alpha ≥ this counts toward the near-opaque pole. */
export const OPAQUE = 250;
/** Alpha ≤ this counts toward the near-clear pole. */
export const CLEAR = 8;
/** Minimum fraction of samples each pole must hold for a hard-alpha verdict. */
export const minPole = 0.12;

/** Below this per-channel sample stdDev, a channel reads as constant. Tighter than FLAT_STD=12 (a flat
 *  icon still has edges/text) and below dedup's minStdDev=6 — a SOLID image has no variance at all. */
export const SOLID_STD = 2;

/** Grayscale luma from RGBA pixel data at byte index i. */
export function luma(data: Uint8ClampedArray | Uint8Array | number[], i: number): number {
  return 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
}

/** 9×8 grayscale samples → 64-bit difference hash (dHash) as 16 hex chars. */
export function dHashFromGray(gray: number[]): string {
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW - 1; x++) {
      const a = gray[y * DW + x] ?? 0;
      const b = gray[y * DW + x + 1] ?? 0;
      nibble = (nibble << 1) | (a < b ? 1 : 0);
      if (++bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex.padStart(16, '0');
}

/** Standard deviation of the grayscale samples. A featureless image is ~0. */
export function grayStdDev(gray: number[]): number {
  if (gray.length === 0) return 0;
  const mean = gray.reduce((s, v) => s + v, 0) / gray.length;
  const variance = gray.reduce((s, v) => s + (v - mean) ** 2, 0) / gray.length;
  return Math.sqrt(variance);
}

/** Flat / near-uniform images collapse to the same dHash and would produce false
 *  "near-duplicate" matches — exclude them from perceptual matching. */
export function isFlat(gray: number[], minStdDev = 6): boolean {
  return grayStdDev(gray) < minStdDev;
}

/** Standard deviation of channel `c` (0=R,1=G,2=B,3=A) across the interleaved RGBA samples. */
function channelStdDev(rgba: Uint8ClampedArray | number[], c: number): number {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return 0;
  let sum = 0;
  for (let p = 0; p < n; p++) sum += rgba[p * 4 + c] ?? 0;
  const mean = sum / n;
  let varSum = 0;
  for (let p = 0; p < n; p++) {
    const v = (rgba[p * 4 + c] ?? 0) - mean;
    varSum += v * v;
  }
  return Math.sqrt(varSum / n);
}

/** True iff the 9×8 sample is a single color (or fully transparent): EVERY channel — R, G, B, alpha,
 *  and the derived gray (catches a chromatic shift at equal luma) — has a per-sample stdDev below
 *  SOLID_STD. A fully-transparent image has zero variance on every channel ⇒ also "solid". A short /
 *  empty sample (below the 9×8 sample resolution) ⇒ false. Pure integer-sample math (deterministic). */
export function isSolidColor(
  gray: number[],
  rgba: Uint8ClampedArray | number[],
  std = SOLID_STD,
): boolean {
  const n = Math.floor(rgba.length / 4);
  if (n === 0 || gray.length === 0) return false;
  if (grayStdDev(gray) >= std) return false;
  for (let c = 0; c < 4; c++) if (channelStdDev(rgba, c) >= std) return false;
  return true;
}

/** Hard alpha present iff BOTH alpha poles are populated in the sample: a meaningful fraction of
 *  pixels are near-opaque (α ≥ OPAQUE) AND a meaningful fraction near-clear (α ≤ CLEAR). HISTOGRAM
 *  form (NOT edge-adjacency) — robust to the 9×8 bilinear resample that smears hard cutout edges into
 *  alpha ramps (design M3). A soft vignette keeps most α in the mid band ⇒ at most one pole is
 *  populated ⇒ false. `rgba` is interleaved RGBA bytes; the alpha channel is every 4th byte. */
export function hasHardAlpha(
  rgba: Uint8ClampedArray | number[],
  opaque = OPAQUE,
  clear = CLEAR,
  pole = minPole,
): boolean {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return false;
  let opaqueCount = 0;
  let clearCount = 0;
  for (let p = 0; p < n; p++) {
    const a = rgba[p * 4 + 3] ?? 0;
    if (a >= opaque) opaqueCount++;
    else if (a <= clear) clearCount++;
  }
  return opaqueCount / n >= pole && clearCount / n >= pole;
}

/** Alpha is FULLY opaque iff EVERY pixel's alpha byte === 255 — i.e. the image carries an alpha
 *  channel it never uses. Runs over the FULL-RESOLUTION interleaved RGBA bytes (the alpha channel is
 *  every 4th byte), NOT the 9×8 sample: a single transparent pixel must not box-average away. SHORT-
 *  CIRCUITS on the first non-opaque pixel — most images bail almost instantly (instant-wow safe), and a
 *  fully-opaque image is the worst case (one full sweep, strictly cheaper than the existing format-audit
 *  decode+encode). An empty buffer ⇒ false (nothing to measure — never claim a saving on no data).
 *  Pure integer-byte read, deterministic. Mirrors the alpha-pole loop in hasHardAlpha but with a hard
 *  255 threshold (a 254 alpha is a real, used channel — not dead). */
export function alphaFullyOpaque(rgba: Uint8ClampedArray | number[]): boolean {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return false;
  for (let p = 0; p < n; p++) if ((rgba[p * 4 + 3] ?? 0) !== 255) return false;
  return true;
}

/** Below this per-channel FULL-RESOLUTION min↔max spread, the channel reads as one value. A small
 *  band (not 0) tolerates lossy-format ringing on a genuinely flat fill; any REAL feature swings a
 *  channel far past it. Full-res sibling of SOLID_STD (which gates the 9×8 sample). */
export const SOLID_FULL_TOL = 8;

/** True iff EVERY pixel is within a per-channel band of one color — the FULL-RESOLUTION confirmation
 *  of the 9×8 `isSolidColor` pre-filter. Tracks per-channel min/max over the interleaved RGBA
 *  (alpha included: a fully-transparent image is 0,0,0,0 everywhere ⇒ solid; a hard cutout swings
 *  alpha 0↔255 ⇒ NOT solid). SHORT-CIRCUITS false the moment any channel's spread exceeds `tol`, so a
 *  non-solid image (a real feature) bails as soon as the scan reaches it. An empty buffer ⇒ false
 *  (never claim a saving on no data). Pure integer read, deterministic — and, unlike the 9×8
 *  downsample, resampler-INDEPENDENT (the full-res draw is 1:1, no canvas resampling). */
export function isSolidFullRes(rgba: Uint8ClampedArray | Uint8Array | number[], tol = SOLID_FULL_TOL): boolean {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return false;
  const mn = [255, 255, 255, 255];
  const mx = [0, 0, 0, 0];
  for (let p = 0; p < n; p++) {
    const b = p * 4;
    for (let c = 0; c < 4; c++) {
      const v = rgba[b + c] ?? 0;
      if (v < mn[c]!) mn[c] = v;
      if (v > mx[c]!) mx[c] = v;
      if (mx[c]! - mn[c]! > tol) return false; // a real feature — bail immediately
    }
  }
  return true;
}

/** Axis-aligned packed rect of a sprite AS PLACED in the atlas page (already w/h-swapped when rotated). */
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Per-page caps mirroring the worker's full-frame opaque scan (instant-wow ≤10s). A page above the px cap
 *  or with more than the sprite cap is skipped WHOLE (the rule never fires for it) rather than risking a
 *  slow read — honestly, not silently. Round 21 #2: the px ceiling is now SINGLE-SOURCED as
 *  ANALYZE_PAGE_MAX_PX in bitmap-budget.ts (the worker's old inline ALPHA_SCAN_MAX_PX used the same value;
 *  re-exporting it here unifies the two so they can't drift). FRAME_HASH_MAX_SPRITES stays — a distinct axis. */
export { ANALYZE_PAGE_MAX_PX as FRAME_HASH_MAX_PX } from './bitmap-budget';
export const FRAME_HASH_MAX_SPRITES = 4096; // real animation sheets are well under this

/** Area-average a sub-rect of a full-resolution RGBA page down to a 9×8 grayscale sample (the same grid the
 *  dHash/flat-guard uses). Pure box filter: each of the 72 cells averages the source pixels that map into
 *  it (deterministic — no canvas resampler), then converts to luma. Mirrors the worker's old
 *  `drawImage(bmp, x,y,w,h, 0,0, 9,8)` downscale but canvas-free so the flat-guard is unit-testable. */
function regionGray9x8(
  page: Uint8ClampedArray | Uint8Array,
  pageW: number,
  rect: FrameRect,
): number[] {
  const gray: number[] = [];
  for (let cy = 0; cy < DH; cy++) {
    for (let cx = 0; cx < DW; cx++) {
      // Source span [sx0, sx1) × [sy0, sy1) inside the region that maps to cell (cx, cy).
      const sx0 = rect.x + Math.floor((cx * rect.w) / DW);
      const sx1 = rect.x + Math.max(Math.floor(((cx + 1) * rect.w) / DW), Math.floor((cx * rect.w) / DW) + 1);
      const sy0 = rect.y + Math.floor((cy * rect.h) / DH);
      const sy1 = rect.y + Math.max(Math.floor(((cy + 1) * rect.h) / DH), Math.floor((cy * rect.h) / DH) + 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (pageW * sy + sx) * 4;
          r += page[i] ?? 0;
          g += page[i + 1] ?? 0;
          b += page[i + 2] ?? 0;
          n++;
        }
      }
      if (n === 0) {
        gray.push(0);
      } else {
        gray.push(0.299 * (r / n) + 0.587 * (g / n) + 0.114 * (b / n));
      }
    }
  }
  return gray;
}

/** Extract a sprite's RGBA region bytes (tightly packed, row-major w×h) from the full-resolution page
 *  buffer. The returned bytes are exactly what the host SHA-256s for the frame hash — identical region
 *  pixels (anywhere on the page) ⇒ identical bytes ⇒ identical hash (deterministic, position-independent). */
function extractRegion(
  page: Uint8ClampedArray | Uint8Array,
  pageW: number,
  rect: FrameRect,
): Uint8Array {
  const out = new Uint8Array(rect.w * rect.h * 4);
  let o = 0;
  for (let yy = 0; yy < rect.h; yy++) {
    const rowStart = (pageW * (rect.y + yy) + rect.x) * 4;
    for (let xx = 0; xx < rect.w * 4; xx++) out[o++] = page[rowStart + xx] ?? 0;
  }
  return out;
}

/** PURE core of the within-atlas frame-redundancy hashing (the load-bearing half of the worker's
 *  `hashAtlasFrames` — canvas-free, deterministic, unit-testable). Given an ALREADY-DECODED full-resolution
 *  RGBA page + the sprite rects AS PLACED, returns a per-rect array index-aligned to `rects`:
 *    • the tightly-packed region RGBA bytes (what the host SHA-256s) for a TEXTURED region — identical
 *      region pixels (anywhere on the page) ⇒ identical bytes ⇒ identical hash (clusters by content);
 *    • `null` for a region that is flat/near-uniform (box-averaged 9×8 grayStdDev < the dHash flat
 *      threshold — a featureless fill would falsely cluster, mirroring the dHash isFlat skip), or whose rect
 *      is zero/negative/out-of-bounds (can't be hashed honestly → never clustered).
 *  Returns the WHOLE page as `null` (no regions extracted) when there are more than FRAME_HASH_MAX_SPRITES
 *  rects or the page exceeds FRAME_HASH_MAX_PX (skipped honestly — the rule simply never fires for that
 *  page). Splitting extraction (pure, sync) from the SHA (async crypto.subtle, in the worker) keeps the
 *  region-extraction + flat-guard + caps + bounds — everything the rule's runtime correctness depends on —
 *  unit-testable canvas-free; the worker just maps each non-null region through its hash. */
export function extractFrameRegions(
  page: Uint8ClampedArray | Uint8Array,
  pageW: number,
  pageH: number,
  rects: FrameRect[],
): (Uint8Array | null)[] | null {
  if (rects.length > FRAME_HASH_MAX_SPRITES) return null;
  if (pageW <= 0 || pageH <= 0 || pageW * pageH > ANALYZE_PAGE_MAX_PX) return null;
  const out: (Uint8Array | null)[] = [];
  for (const rect of rects) {
    const { x, y, w, h } = rect;
    if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > pageW || y + h > pageH) {
      out.push(null);
      continue;
    }
    if (isFlat(regionGray9x8(page, pageW, rect))) {
      out.push(null); // featureless region — never cluster (same skip as the dHash path)
      continue;
    }
    out.push(extractRegion(page, pageW, rect));
  }
  return out;
}

/** Convenience: `extractFrameRegions` then map each non-null region through `hash` (a sync stand-in in
 *  tests; the worker uses its own async SHA loop instead, since crypto.subtle is async). Deterministic. */
export function hashFrameRegions(
  page: Uint8ClampedArray | Uint8Array,
  pageW: number,
  pageH: number,
  rects: FrameRect[],
  hash: (bytes: Uint8Array) => string,
): (string | null)[] | null {
  const regions = extractFrameRegions(page, pageW, pageH, rects);
  if (!regions) return null;
  return regions.map((r) => (r === null ? null : hash(r)));
}

/** Classify a 9×8 RGBA sample into a coarse content class for the format-suitability verdict.
 *  Order (design §4): hard alpha first (a flat icon WITH a hard cutout is 'alpha-art', so checking
 *  alpha before variance keeps it out of the 'flat' bucket) → low-variance fill ('flat') → else
 *  'photographic'. Empty / short sample ⇒ 'unknown' (caller falls back to today's lossy path). */
export function classifyContent(
  gray: number[],
  rgba: Uint8ClampedArray | number[],
): ContentClass {
  if (gray.length === 0 || rgba.length < 4) return 'unknown';
  if (hasHardAlpha(rgba)) return 'alpha-art';
  if (grayStdDev(gray) < FLAT_STD) return 'flat';
  return 'photographic';
}
