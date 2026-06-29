// Unit test for the PURE high-frequency-energy measurement behind the OPT-IN resample receipt (round24).
// The worker can't run headless (createImageBitmap/OffscreenCanvas), so the load-bearing honesty math — the
// HF-energy measure + the clamped retention delta — is exercised here directly in Node against the real
// shared code. HONESTY: the measure is high-frequency CONTENT retention, NOT a "sharper/better" verdict.

import { describe, it, expect } from 'vitest';
import { hfEnergy, tileHfEnergyDelta, aggregateHfEnergyDelta } from './resample-quality';

/** Build a w×h RGBA buffer from a per-pixel gray function (R=G=B=gray, A=255). */
function grayImage(w: number, h: number, fn: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = fn(x, y);
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}

describe('hfEnergy — mean |Laplacian| over luma', () => {
  it('is ~0 for a flat image (no high-frequency content)', () => {
    const flat = grayImage(8, 8, () => 128);
    expect(hfEnergy(flat, 8, 8)).toBeCloseTo(0, 6);
  });

  it('is larger for a sharp checkerboard than for a smooth ramp', () => {
    const checker = grayImage(8, 8, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
    const ramp = grayImage(8, 8, (x) => Math.round((x / 7) * 255));
    expect(hfEnergy(checker, 8, 8)).toBeGreaterThan(hfEnergy(ramp, 8, 8));
  });

  it('returns 0 when there is no interior to measure (w<3 or h<3)', () => {
    expect(hfEnergy(grayImage(2, 8, () => 200), 2, 8)).toBe(0);
    expect(hfEnergy(grayImage(8, 2, () => 200), 8, 2)).toBe(0);
  });

  it('is deterministic (same bytes ⇒ same number)', () => {
    const a = grayImage(8, 8, (x, y) => ((x * 31 + y * 17) % 256));
    const b = grayImage(8, 8, (x, y) => ((x * 31 + y * 17) % 256));
    expect(hfEnergy(a, 8, 8)).toBe(hfEnergy(b, 8, 8));
  });
});

describe('tileHfEnergyDelta — clamped retention fraction', () => {
  it('is POSITIVE when the vips tile carries more high-frequency content (sharp vs box-blurred)', () => {
    const sharp = grayImage(8, 8, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
    // A box-blurred version of the same content has LESS high-frequency energy.
    const blurred = grayImage(8, 8, (x, y) => {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= 8 || yy >= 8) continue;
          s += (xx + yy) % 2 === 0 ? 0 : 255;
          n++;
        }
      }
      return Math.round(s / n);
    });
    // vips=sharp, browser=blurred ⇒ positive (lanczos retained more HF content than the blur).
    expect(tileHfEnergyDelta(sharp, blurred, 8, 8)).toBeGreaterThan(0);
  });

  it('is exactly 0 for identical tiles (no fabricated win)', () => {
    const a = grayImage(8, 8, (x, y) => ((x * 7 + y * 13) % 256));
    const b = grayImage(8, 8, (x, y) => ((x * 7 + y * 13) % 256));
    expect(tileHfEnergyDelta(a, b, 8, 8)).toBe(0);
  });

  it('CLAMPS to 0 when the vips tile has LESS high-frequency content (≤0 ⇒ keep browser, delta 0)', () => {
    const sharp = grayImage(8, 8, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
    const flat = grayImage(8, 8, () => 128);
    // vips=flat (less HF) vs browser=sharp ⇒ negative raw ⇒ clamped to 0.
    expect(tileHfEnergyDelta(flat, sharp, 8, 8)).toBe(0);
  });

  it('is 0 when the browser tile is flat (nothing to be more than — no fabricated ratio)', () => {
    const sharp = grayImage(8, 8, (x, y) => ((x + y) % 2 === 0 ? 0 : 255));
    const flat = grayImage(8, 8, () => 200);
    expect(tileHfEnergyDelta(sharp, flat, 8, 8)).toBe(0);
  });
});

describe('aggregateHfEnergyDelta — one honest receipt number', () => {
  it('computes the clamped Σ-energy retention fraction', () => {
    expect(aggregateHfEnergyDelta(120, 100)).toBeCloseTo(0.2, 9);
  });
  it('clamps a negative aggregate to 0', () => {
    expect(aggregateHfEnergyDelta(80, 100)).toBe(0);
  });
  it('is 0 when there is no measurable browser energy', () => {
    expect(aggregateHfEnergyDelta(50, 0)).toBe(0);
  });
});
