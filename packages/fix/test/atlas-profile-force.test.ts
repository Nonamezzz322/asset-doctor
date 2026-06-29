// PURE exhaustive test of atlasNeedsForcedFormat (AB-R3) — the eligibility DECISION for force-transcoding a
// prebuilt atlas page under a SINGLE-format format-only export profile. No worker / OffscreenCanvas harness
// exists (round7-export-profile.md B2), so the per-page DECISION is pinned here against every gate; the pixel
// work itself is the existing prebuilt-atlas passthrough (verified manually). Every refusal must carry a
// honest skipReason (surfaced in skipped[]); the source===target no-op must NOT (nothing to apologize for).

import { describe, expect, it } from 'vitest';
import type { ImageMime } from '@asset-doctor/core';
import { atlasNeedsForcedFormat, type AtlasForceArgs } from '../src/index';

/** The HAPPY base: a single-format profile, TexturePacker sidecar present, nothing claimed, source≠target.
 *  Each test flips exactly ONE gate to prove that gate (and ONLY that gate) refuses. */
const base: AtlasForceArgs = {
  sourceMime: 'image/png',
  targetMime: 'image/avif',
  isMultiFormat: false,
  isSpineMultiPage: false,
  hasSidecar: true,
  alreadyClaimed: false,
};

describe('atlasNeedsForcedFormat (AB-R3 single-format atlas force)', () => {
  it('force=true ONLY for {single-format, not multi-page Spine, has sidecar, not claimed, source≠target}', () => {
    const d = atlasNeedsForcedFormat(base);
    expect(d).toEqual({ force: true }); // forces — no skipReason on a genuine force
  });

  it('source === target ⇒ force=false with NO skipReason (already the chosen format, nothing to surface)', () => {
    const d = atlasNeedsForcedFormat({ ...base, sourceMime: 'image/avif', targetMime: 'image/avif' });
    expect(d.force).toBe(false);
    expect(d.skipReason).toBeUndefined();
  });

  it('AVIF source + AVIF target ⇒ no-op force=false (the headline edge case from the design)', () => {
    expect(atlasNeedsForcedFormat({ ...base, sourceMime: 'image/avif', targetMime: 'image/avif' })).toEqual({
      force: false,
    });
  });

  it('multi-format profile ⇒ force=false, surfaced "stay single-format" (cannot fan one page across N sidecars)', () => {
    const d = atlasNeedsForcedFormat({ ...base, isMultiFormat: true });
    expect(d.force).toBe(false);
    expect(d.skipReason).toContain('single-format');
  });

  it('multi-page Spine atlas ⇒ force=false, surfaced "multi-page Spine" (one .atlas writes one page)', () => {
    const d = atlasNeedsForcedFormat({ ...base, isSpineMultiPage: true });
    expect(d.force).toBe(false);
    expect(d.skipReason).toContain('multi-page Spine');
  });

  it('no sidecar ⇒ force=false, surfaced "sidecar unavailable" (re-encoding would dangle the manifest)', () => {
    const d = atlasNeedsForcedFormat({ ...base, hasSidecar: false });
    expect(d.force).toBe(false);
    expect(d.skipReason).toContain('sidecar unavailable');
  });

  it('already claimed by another fix ⇒ force=false, surfaced "already claimed" (respect repack/merge/dedup)', () => {
    const d = atlasNeedsForcedFormat({ ...base, alreadyClaimed: true });
    expect(d.force).toBe(false);
    expect(d.skipReason).toContain('already claimed');
  });

  // ── EVERY refused gate carries a reason (honesty: never a silent no-op except source===target) ──
  it('every refusal that is NOT source===target carries a skipReason (surfaced, never silent)', () => {
    const refusals: AtlasForceArgs[] = [
      { ...base, isMultiFormat: true },
      { ...base, isSpineMultiPage: true },
      { ...base, hasSidecar: false },
      { ...base, alreadyClaimed: true },
    ];
    for (const r of refusals) {
      const d = atlasNeedsForcedFormat(r);
      expect(d.force).toBe(false);
      expect(typeof d.skipReason).toBe('string');
      expect(d.skipReason!.length).toBeGreaterThan(0);
    }
  });

  // ── GATE PRECEDENCE: claimed > sidecar > multi-page-Spine > multi-format > no-op (fixed, deterministic) ──
  it('alreadyClaimed wins over every other refusal (checked first)', () => {
    const d = atlasNeedsForcedFormat({
      ...base,
      alreadyClaimed: true,
      hasSidecar: false,
      isSpineMultiPage: true,
      isMultiFormat: true,
    });
    expect(d.skipReason).toContain('already claimed');
  });

  it('no sidecar wins over multi-page-Spine + multi-format (second in order)', () => {
    const d = atlasNeedsForcedFormat({ ...base, hasSidecar: false, isSpineMultiPage: true, isMultiFormat: true });
    expect(d.skipReason).toContain('sidecar unavailable');
  });

  it('multi-page-Spine wins over multi-format (third in order)', () => {
    const d = atlasNeedsForcedFormat({ ...base, isSpineMultiPage: true, isMultiFormat: true });
    expect(d.skipReason).toContain('multi-page Spine');
  });

  it('a claimed page whose source already === target STILL refuses with the claimed reason (claimed first)', () => {
    const d = atlasNeedsForcedFormat({ ...base, sourceMime: 'image/avif', targetMime: 'image/avif', alreadyClaimed: true });
    expect(d.force).toBe(false);
    expect(d.skipReason).toContain('already claimed');
  });

  // ── EXHAUSTIVE truth table over all six boolean/mime axes (total + deterministic) ──
  it('is TOTAL and DETERMINISTIC across the full input space (force=true ⇔ all gates pass and source≠target)', () => {
    const mimes: ImageMime[] = ['image/png', 'image/webp', 'image/avif', 'image/jpeg'];
    let forced = 0;
    let refusedWithReason = 0;
    let noOp = 0;
    for (const sourceMime of mimes)
      for (const targetMime of mimes)
        for (const isMultiFormat of [false, true])
          for (const isSpineMultiPage of [false, true])
            for (const hasSidecar of [false, true])
              for (const alreadyClaimed of [false, true]) {
                const args: AtlasForceArgs = {
                  sourceMime,
                  targetMime,
                  isMultiFormat,
                  isSpineMultiPage,
                  hasSidecar,
                  alreadyClaimed,
                };
                const d = atlasNeedsForcedFormat(args);
                // Determinism: identical inputs ⇒ identical outputs.
                expect(atlasNeedsForcedFormat(args)).toEqual(d);
                const gatesPass = !alreadyClaimed && hasSidecar && !isSpineMultiPage && !isMultiFormat;
                if (d.force) {
                  // force=true ⇔ every gate passes AND source≠target; force carries NO reason.
                  expect(gatesPass && sourceMime !== targetMime).toBe(true);
                  expect(d.skipReason).toBeUndefined();
                  forced++;
                } else if (gatesPass && sourceMime === targetMime) {
                  // the only silent no-op: gates pass but the page is already the chosen format.
                  expect(d.skipReason).toBeUndefined();
                  noOp++;
                } else {
                  // every other force=false is a SURFACED refusal.
                  expect(typeof d.skipReason).toBe('string');
                  refusedWithReason++;
                }
              }
    // 4×4×2×2×2×2 = 256 combos. Sanity: each bucket is non-empty (the predicate exercises every branch).
    expect(forced + noOp + refusedWithReason).toBe(256);
    expect(forced).toBeGreaterThan(0);
    expect(noOp).toBeGreaterThan(0);
    expect(refusedWithReason).toBeGreaterThan(0);
  });
});
