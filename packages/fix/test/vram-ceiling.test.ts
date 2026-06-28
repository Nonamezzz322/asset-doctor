// PURE GPU-residency CEILING tests (round12 backend-processing §7 / Phase-0 T3). No pixels/canvas/IO.
// The load-bearing honesty contract (Invariants 3 & 5):
//   - raster ⇒ EXACTLY w·h·4 (today's RGBA8888 model, unchanged).
//   - ktx2-uastc ⇒ the worst-case CEILING ~1·w·h — NEVER w·h·4, NEVER faked; strictly < the raster cost.
//   - mips reuse the ONE shared constant (MIP_OVERHEAD = 4/3), charged ONLY when baked (mips === true).
//   - deterministic, integer output, defensive against floats/negatives.

import { describe, expect, it } from 'vitest';
import { COMPRESSED_BYTES_PER_PX_CEILING, MIP_OVERHEAD } from '@asset-doctor/core';
import { vramCeilingOfPage } from '../src/index';

describe('vramCeilingOfPage — raster (RGBA8888, today\'s model)', () => {
  it('charges EXACTLY w·h·4 for a raster page (no mips)', () => {
    expect(vramCeilingOfPage('raster', 2048, 2048)).toBe(2048 * 2048 * 4); // 16 MiB
    expect(vramCeilingOfPage('raster', 256, 128)).toBe(256 * 128 * 4);
    expect(vramCeilingOfPage('raster', 1, 1)).toBe(4);
  });

  it('mips add the shared +33% (×4/3) ONLY when baked', () => {
    const base = 1024 * 1024 * 4;
    expect(vramCeilingOfPage('raster', 1024, 1024, false)).toBe(base);
    expect(vramCeilingOfPage('raster', 1024, 1024, true)).toBe(Math.ceil(base * MIP_OVERHEAD));
    // mips default to OFF (omitted === false) — no surprise +33%.
    expect(vramCeilingOfPage('raster', 1024, 1024)).toBe(base);
  });
});

describe('vramCeilingOfPage — ktx2-uastc (compressed CEILING, NEVER w·h·4)', () => {
  it('charges the worst-case ~1 byte/px ceiling, NOT w·h·4', () => {
    const w = 2048;
    const h = 2048;
    const ceiling = vramCeilingOfPage('ktx2-uastc', w, h);
    expect(ceiling).toBe(w * h * COMPRESSED_BYTES_PER_PX_CEILING['ktx2-uastc']); // 1 B/px
    expect(ceiling).toBe(w * h * 1);
    // The honesty invariant: a KTX2 page is NEVER charged the raster w·h·4.
    expect(ceiling).not.toBe(w * h * 4);
    // ...and it is strictly cheaper than the raster footprint (the VRAM win is real, capped honestly).
    expect(ceiling).toBeLessThan(vramCeilingOfPage('raster', w, h));
    expect(ceiling).toBe(vramCeilingOfPage('raster', w, h) / 4); // exactly a quarter at worst case
  });

  it('mips ×4/3 only when baked (reuses the ONE shared constant), never assumed', () => {
    const base = 1024 * 1024 * 1; // 1 B/px ceiling
    expect(vramCeilingOfPage('ktx2-uastc', 1024, 1024, false)).toBe(base);
    expect(vramCeilingOfPage('ktx2-uastc', 1024, 1024)).toBe(base); // default OFF
    expect(vramCeilingOfPage('ktx2-uastc', 1024, 1024, true)).toBe(Math.ceil(base * MIP_OVERHEAD));
    // Even mipmapped, the KTX2 ceiling stays well under the (non-mipmapped) raster footprint.
    expect(vramCeilingOfPage('ktx2-uastc', 1024, 1024, true)).toBeLessThan(
      vramCeilingOfPage('raster', 1024, 1024, false),
    );
  });
});

describe('vramCeilingOfPage — determinism + defensive arithmetic', () => {
  it('is deterministic (same inputs ⇒ same integer)', () => {
    expect(vramCeilingOfPage('ktx2-uastc', 777, 333, true)).toBe(
      vramCeilingOfPage('ktx2-uastc', 777, 333, true),
    );
  });

  it('always returns a whole-byte integer (mip path is ceil\'d)', () => {
    // 3·3·1 = 9; ×4/3 = 12 exactly here, but assert integrality generally.
    for (const mips of [false, true]) {
      for (const fmt of ['raster', 'ktx2-uastc'] as const) {
        const v = vramCeilingOfPage(fmt, 333, 167, mips);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it('floors non-integer dims and clamps negatives/zero to 0 (never trusts a float dim)', () => {
    expect(vramCeilingOfPage('raster', 2.9, 2.9)).toBe(2 * 2 * 4); // floored to 2×2
    expect(vramCeilingOfPage('raster', 0, 100)).toBe(0);
    expect(vramCeilingOfPage('ktx2-uastc', -5, 100)).toBe(0);
    expect(vramCeilingOfPage('ktx2-uastc', 100, 0)).toBe(0);
  });
});
