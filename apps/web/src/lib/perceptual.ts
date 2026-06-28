// Pure perceptual-hash helpers (testable headless). The worker decodes an image to a 9×8
// grayscale and calls these; keeping the math here means it can be unit-tested without a canvas.

import type { ContentClass } from '@asset-doctor/core';

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
export function luma(data: Uint8ClampedArray | number[], i: number): number {
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
