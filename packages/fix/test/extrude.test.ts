// Pure edge-extrude (bleed) GEOMETRY goldens — docs/improvements/edge-extrude.md OPTION A, task T4.
// These assert ONLY the drawImage src/dst descriptors extrudePlan emits (+ effectiveExtrude clamp +
// canExtrude gate). NO canvas: OffscreenCanvas/getImageData are unavailable in Vitest, so the REAL
// composed-pixel assertion (gutter texel == adjacent sprite edge colour) is a deferred Playwright test
// (T12). Here we prove the geometry the worker will faithfully execute:
//   • effectiveExtrude(e, gutter) = min(floor(e), floor(gutter)), never the (rejected) draft's 2× factor;
//   • canExtrude gates to plain unrotated rectangle blits (meshed/from.rotated/rotate90 ⇒ no bleed);
//   • extrudePlan emits 4 edge strips + 4 corners in FIXED order, each a 1px source slice scaled into the
//     gutter band, clamped to the bin, with zero-area rects dropped, and NEVER overlapping the sprite body.

import { describe, expect, it } from 'vitest';
import type { Blit, Vec2 } from '@asset-doctor/core';
import { canExtrude, effectiveExtrude, extrudePlan, type ExtrudeRect } from '../src/index';

/** A plain unrotated rectangle blit whose source frame == its destination rect (the common repack case:
 *  pixels are relocated, not resized). `to` is offset by `gutter` so a `gutter`-wide band exists on all
 *  four sides (OPTION A places the sprite at best.{x,y}+gutter). */
function rectBlit(to: { x: number; y: number; w: number; h: number }, src = to): Blit {
  return {
    name: 'r',
    from: { atlasRef: 'src.png', rect: { x: src.x, y: src.y, w: src.w, h: src.h }, rotated: false },
    to: { x: to.x, y: to.y, w: to.w, h: to.h },
    rotate90: false,
  };
}

/** True iff two rects share any interior area (touching edges is OK — gutter bands abut the body). */
const overlaps = (a: ExtrudeRect['dst'], b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('effectiveExtrude (clamp the bleed to the symmetric gutter)', () => {
  it('is min(extrude, gutter) — the draft 2× factor is GONE', () => {
    expect(effectiveExtrude(2, 4)).toBe(2);
    expect(effectiveExtrude(4, 2)).toBe(2); // gutter is the cap (no overflow into a neighbour)
    expect(effectiveExtrude(3, 3)).toBe(3);
  });

  it('floors both args and never returns a negative', () => {
    expect(effectiveExtrude(2.9, 4)).toBe(2);
    expect(effectiveExtrude(4, 2.9)).toBe(2);
    expect(effectiveExtrude(-5, 4)).toBe(0);
    expect(effectiveExtrude(2, -1)).toBe(0);
    expect(effectiveExtrude(0, 4)).toBe(0); // OFF
  });
});

describe('canExtrude (gate to plain unrotated rectangle blits)', () => {
  const base = rectBlit({ x: 10, y: 10, w: 8, h: 6 });

  it('allows a plain unrotated rectangle blit', () => {
    expect(canExtrude(base)).toBe(true);
  });

  it('rejects a meshed (clip-polygon) blit — no rectangular edge to replicate', () => {
    const clip: Vec2[] = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 4, y: 6 }];
    expect(canExtrude({ ...base, clip })).toBe(false);
    // an empty clip array is NOT meshed (no polygon) ⇒ still extrudable.
    expect(canExtrude({ ...base, clip: [] })).toBe(true);
  });

  it('rejects a source-rotated blit (from.rotated)', () => {
    expect(canExtrude({ ...base, from: { ...base.from, rotated: true } })).toBe(false);
  });

  it('rejects a packer-rotated blit (rotate90)', () => {
    expect(canExtrude({ ...base, rotate90: true })).toBe(false);
  });
});

describe('extrudePlan (8 deterministic strips/corners around a rectangle sprite)', () => {
  // A 2×2-ish interior sprite: 8×6 body at (10,10), source frame at (3,4), gutter ≥ extrude available on
  // all sides because OPTION A reserved it. extrude = 2 ≤ gutter, bin large enough that nothing clamps.
  const E = 2;
  const blit = rectBlit({ x: 10, y: 10, w: 8, h: 6 }, { x: 3, y: 4, w: 8, h: 6 });
  const plan = extrudePlan(blit, E, 256, 256);

  it('emits exactly 8 rects in FIXED order (determinism)', () => {
    expect(plan.map((r) => r.kind)).toEqual(['top', 'bottom', 'left', 'right', 'tl', 'tr', 'bl', 'br']);
  });

  it('edge strips copy the correct 1px SOURCE slice scaled into the gutter band', () => {
    const by = Object.fromEntries(plan.map((r) => [r.kind, r])) as Record<ExtrudeRect['kind'], ExtrudeRect>;
    const sr = blit.from.rect; // {3,4,8,6}
    const to = blit.to; // {10,10,8,6}
    // TOP: source = outermost top row (1px high spanning sr.w); dest = E-high band directly above `to`.
    expect(by.top.src).toEqual({ x: sr.x, y: sr.y, w: sr.w, h: 1 });
    expect(by.top.dst).toEqual({ x: to.x, y: to.y - E, w: to.w, h: E });
    // BOTTOM: source = bottom row; dest = E-high band directly below.
    expect(by.bottom.src).toEqual({ x: sr.x, y: sr.y + sr.h - 1, w: sr.w, h: 1 });
    expect(by.bottom.dst).toEqual({ x: to.x, y: to.y + to.h, w: to.w, h: E });
    // LEFT: source = leftmost col (1px wide spanning sr.h); dest = E-wide band to the left.
    expect(by.left.src).toEqual({ x: sr.x, y: sr.y, w: 1, h: sr.h });
    expect(by.left.dst).toEqual({ x: to.x - E, y: to.y, w: E, h: to.h });
    // RIGHT: source = rightmost col; dest = E-wide band to the right.
    expect(by.right.src).toEqual({ x: sr.x + sr.w - 1, y: sr.y, w: 1, h: sr.h });
    expect(by.right.dst).toEqual({ x: to.x + to.w, y: to.y, w: E, h: to.h });
  });

  it('corners copy the matching 1×1 source pixel into an E×E corner block', () => {
    const by = Object.fromEntries(plan.map((r) => [r.kind, r])) as Record<ExtrudeRect['kind'], ExtrudeRect>;
    const sr = blit.from.rect;
    const to = blit.to;
    expect(by.tl.src).toEqual({ x: sr.x, y: sr.y, w: 1, h: 1 });
    expect(by.tl.dst).toEqual({ x: to.x - E, y: to.y - E, w: E, h: E });
    expect(by.tr.src).toEqual({ x: sr.x + sr.w - 1, y: sr.y, w: 1, h: 1 });
    expect(by.tr.dst).toEqual({ x: to.x + to.w, y: to.y - E, w: E, h: E });
    expect(by.bl.src).toEqual({ x: sr.x, y: sr.y + sr.h - 1, w: 1, h: 1 });
    expect(by.bl.dst).toEqual({ x: to.x - E, y: to.y + to.h, w: E, h: E });
    expect(by.br.src).toEqual({ x: sr.x + sr.w - 1, y: sr.y + sr.h - 1, w: 1, h: 1 });
    expect(by.br.dst).toEqual({ x: to.x + to.w, y: to.y + to.h, w: E, h: E });
  });

  it('NO extrude dest rect overlaps the sprite body (OPTION A: bleed lives only in the owned gutter)', () => {
    for (const r of plan) expect(overlaps(r.dst, blit.to)).toBe(false);
  });

  it('every dest rect stays inside the bin and is positive-area', () => {
    for (const r of plan) {
      expect(r.dst.x).toBeGreaterThanOrEqual(0);
      expect(r.dst.y).toBeGreaterThanOrEqual(0);
      expect(r.dst.x + r.dst.w).toBeLessThanOrEqual(256);
      expect(r.dst.y + r.dst.h).toBeLessThanOrEqual(256);
      expect(r.dst.w).toBeGreaterThan(0);
      expect(r.dst.h).toBeGreaterThan(0);
    }
  });
});

describe('extrudePlan — empty cases (no bleed emitted)', () => {
  const blit = rectBlit({ x: 10, y: 10, w: 8, h: 6 });

  it('extrude <= 0 ⇒ [] (default OFF; the worker still draws the main blit)', () => {
    expect(extrudePlan(blit, 0, 256, 256)).toEqual([]);
    expect(extrudePlan(blit, -1, 256, 256)).toEqual([]);
  });

  it('meshed / rotated blits ⇒ [] (gated by canExtrude — surfaced honestly by the worker)', () => {
    const clip: Vec2[] = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 4, y: 6 }];
    expect(extrudePlan({ ...blit, clip }, 2, 256, 256)).toEqual([]);
    expect(extrudePlan({ ...blit, from: { ...blit.from, rotated: true } }, 2, 256, 256)).toEqual([]);
    expect(extrudePlan({ ...blit, rotate90: true }, 2, 256, 256)).toEqual([]);
  });

  it('floors the extrude px (2.9 ⇒ E=2 bands)', () => {
    const r = extrudePlan(blit, 2.9, 256, 256).find((x) => x.kind === 'top')!;
    expect(r.dst.h).toBe(2);
  });
});

describe('extrudePlan — bin-edge clamping (a band running off the sheet is trimmed, never crosses the edge)', () => {
  // Sprite hugging the TOP-LEFT bin corner: its top/left gutter would run negative ⇒ those bands clamp to
  // zero area and DROP; bottom/right (interior) survive. (At a true sheet edge UV-clamp covers the seam;
  // the geometry must still never emit an out-of-bin rect.)
  it('drops the off-sheet bands at the bin origin, keeps the interior ones', () => {
    const blit = rectBlit({ x: 0, y: 0, w: 8, h: 6 }, { x: 0, y: 0, w: 8, h: 6 });
    const plan = extrudePlan(blit, 2, 256, 256);
    const kinds = plan.map((r) => r.kind);
    // top/left/tl/tr/bl all touch x<0 or y<0 ⇒ dropped; bottom + right + br survive (all in-bin).
    expect(kinds).toEqual(['bottom', 'right', 'br']);
    for (const r of plan) {
      expect(r.dst.x).toBeGreaterThanOrEqual(0);
      expect(r.dst.y).toBeGreaterThanOrEqual(0);
      expect(r.dst.w).toBeGreaterThan(0);
      expect(r.dst.h).toBeGreaterThan(0);
    }
  });

  it('clamps a band straddling the bin far edge to the in-bin slice (dest never exceeds the bin)', () => {
    // 8×6 body ending exactly at the bin's right/bottom edge (binW=binH=16): the right/bottom/corner
    // bands would extend past 16 ⇒ clamped to zero area and dropped; top/left survive.
    const blit = rectBlit({ x: 8, y: 10, w: 8, h: 6 }, { x: 0, y: 0, w: 8, h: 6 });
    const plan = extrudePlan(blit, 2, 16, 16);
    for (const r of plan) {
      expect(r.dst.x + r.dst.w).toBeLessThanOrEqual(16);
      expect(r.dst.y + r.dst.h).toBeLessThanOrEqual(16);
      expect(r.dst.w).toBeGreaterThan(0);
      expect(r.dst.h).toBeGreaterThan(0);
    }
    // the right edge is at x=16 (8+8) ⇒ the 'right'/'tr'/'br' bands have zero in-bin width ⇒ dropped.
    expect(plan.some((r) => r.kind === 'right' || r.kind === 'tr' || r.kind === 'br')).toBe(false);
  });
});
