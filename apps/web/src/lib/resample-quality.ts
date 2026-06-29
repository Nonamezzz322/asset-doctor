// Pure HIGH-FREQUENCY-ENERGY measurement for the OPT-IN libvips lanczos3 resample op (round24-libvips-
// lanczos3-resample-op-sidecar.md). The worker decodes the vips tile + the browser-canvas tile (SAME
// dimensions) to RGBA and calls these; keeping the math here means it can be unit-tested in Node without a
// canvas, exactly like perceptual.ts (luma + box-average pixel math, deterministic).
//
// HONESTY (load-bearing, invariant 3): this measures high-frequency CONTENT RETENTION — the mean absolute
// 4-neighbour Laplacian over luma — NOT "sharpness / cleanliness / better detail". lanczos3's extra
// high-frequency energy includes ringing/overshoot, which is an ARTIFACT, not detail. The number this
// produces is a measured FACT ("retained N% more high-frequency content at the same file size"), never a
// verdict. It is NEVER a VRAM or disk-saving figure (invariant 5 — the tile is the same dims as the browser
// tile and decodes to full RGBA8888).

import { luma } from './perceptual';

/** Mean absolute discrete Laplacian of the luma channel over an RGBA image (row-major, w×h, 4 bytes/px).
 *  The Laplacian (4·center − up − down − left − right) is a standard high-frequency / edge-energy operator;
 *  averaging |Laplacian| over the INTERIOR pixels gives one deterministic, resolution-comparable scalar of
 *  how much high-frequency content the image carries. A smooth/blurred image → near 0; a sharp/ringing image
 *  → larger. Pure float math over integer samples (deterministic). Returns 0 for an image with no interior
 *  (w<3 or h<3) — nothing to measure, never a fabricated number. */
export function hfEnergy(rgba: Uint8ClampedArray | Uint8Array | number[], w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  const at = (x: number, y: number): number => luma(rgba, (y * w + x) * 4);
  let sum = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const lap = 4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
      sum += Math.abs(lap);
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** The MEASURED high-frequency-energy retention delta of a lanczos3 (vips) tile vs the browser-canvas tile
 *  at the SAME dimensions: (hfEnergy(vips) − hfEnergy(browser)) / hfEnergy(browser), CLAMPED to ≥0. A
 *  positive value means the lanczos3 tile retained MORE high-frequency content (the common case for a
 *  high-quality downscale kernel). HONESTY: clamped ≥0 — a ≤0 result means lanczos3 did NOT retain more here,
 *  so the worker keeps the browser tile and this contributes 0 (NOT a failure). When the browser tile has
 *  zero measurable HF energy (a flat tile) there is nothing to be "more" than ⇒ 0 (no fabricated ratio).
 *  Returns a per-tile FRACTION; the worker sums energies across all produced tiles and computes ONE aggregate
 *  via `aggregateHfEnergyDelta` so the receipt is a single honest number. */
export function tileHfEnergyDelta(
  vips: Uint8ClampedArray | Uint8Array | number[],
  browser: Uint8ClampedArray | Uint8Array | number[],
  w: number,
  h: number,
): number {
  const ev = hfEnergy(vips, w, h);
  const eb = hfEnergy(browser, w, h);
  if (eb <= 0) return 0;
  return Math.max(0, (ev - eb) / eb);
}

/** Aggregate the produced tiles' HF energies into ONE retention delta for the receipt: (ΣvipsEnergy −
 *  ΣbrowserEnergy) / ΣbrowserEnergy, clamped ≥0. Summing the energies (rather than averaging per-tile
 *  fractions) weights larger/sharper tiles correctly and stays a single deterministic measured fact. Empty
 *  input or zero total browser energy ⇒ 0 (nothing measurable — never a fabricated number). */
export function aggregateHfEnergyDelta(sumVipsEnergy: number, sumBrowserEnergy: number): number {
  if (sumBrowserEnergy <= 0) return 0;
  return Math.max(0, (sumVipsEnergy - sumBrowserEnergy) / sumBrowserEnergy);
}
