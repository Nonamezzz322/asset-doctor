// Symmetric-gutter packer goldens — docs/improvements/edge-extrude.md OPTION A, task T2. The existing
// `pack (MaxRects)` block in fix.test.ts is the gutter=0 golden (today's behaviour); these add the
// gutter>0 case WITHOUT weakening it. Two load-bearing claims:
//   1. gutter unset === gutter:0 === today: placements are BYTE-IDENTICAL (the default OFF path).
//   2. gutter=g>0: EVERY sprite is offset by +g and OWNS a g-wide band on all four sides — the
//      `g`-inflated sprite boxes are pairwise non-overlapping and stay inside the POT bin. This is the
//      OPTION-A guarantee that makes order-independent edge-extrude correct (a strip never reaches a
//      neighbour). No real pixels here (OffscreenCanvas is unavailable in Vitest — real composed-gutter
//      pixels are the deferred Playwright test T12); this is pure placement geometry.

import { describe, expect, it } from 'vitest';
import { pack, type PackBin, type PackItem, type Placement } from '../src/index';

const ITEMS: PackItem[] = Array.from({ length: 24 }, (_, i) => ({ id: `r${i}`, w: 30 + (i % 7) * 11, h: 20 + (i % 5) * 13 }));

const byId = (bins: PackBin[]): Map<string, Placement> =>
  new Map(bins.flatMap((b) => b.placements).map((p) => [p.id, p]));

/** Two rects share interior area (touching edges is fine — reserved bands abut). */
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('pack — gutter default (OFF) is byte-identical to today', () => {
  const opts = { maxSize: 2048, allowRotation: false, padding: 2 };

  it('gutter unset === gutter:0 (same bins, same placements, same order)', () => {
    const a = pack(ITEMS, opts);
    const b = pack(ITEMS, { ...opts, gutter: 0 });
    expect(b).toEqual(a); // deep structural equality ⇒ default OFF never moves a pixel
  });

  it('a negative/fractional gutter floors to 0 ⇒ still today (no inflation, no offset)', () => {
    const today = pack(ITEMS, opts);
    expect(pack(ITEMS, { ...opts, gutter: -3 })).toEqual(today);
    expect(pack(ITEMS, { ...opts, gutter: 0.9 })).toEqual(today); // floor(0.9)=0
  });

  it('matches the existing fix.test.ts golden invariants at gutter=0 (POT, in-bin, overlap-free)', () => {
    const bins = pack(ITEMS, { ...opts, gutter: 0 });
    expect(bins.flatMap((b) => b.placements).length).toBe(ITEMS.length);
    for (const bin of bins) {
      expect(Number.isInteger(Math.log2(bin.w))).toBe(true);
      expect(Number.isInteger(Math.log2(bin.h))).toBe(true);
      for (const p of bin.placements) {
        expect(p.x + p.w).toBeLessThanOrEqual(bin.w);
        expect(p.y + p.h).toBeLessThanOrEqual(bin.h);
      }
      for (let i = 0; i < bin.placements.length; i++)
        for (let j = i + 1; j < bin.placements.length; j++) expect(overlaps(bin.placements[i]!, bin.placements[j]!)).toBe(false);
    }
  });
});

describe('pack — gutter>0 offsets every sprite by +g and reserves g on all four sides', () => {
  const opts = { maxSize: 2048, allowRotation: false, padding: 2 };

  for (const g of [1, 2, 4]) {
    it(`gutter=${g}: every sprite sits >= ${g} in from the bin origin (owns its left/top gutter) and keeps its body size`, () => {
      const base = byId(pack(ITEMS, { ...opts, gutter: 0 }));
      const bins = pack(ITEMS, { ...opts, gutter: g });
      const gut = byId(bins);
      expect(gut.size).toBe(base.size);
      // NB: inflating each item by 2*g changes the MaxRects free-list, so the chosen best corner can move
      // — placements are NOT a rigid +g translation of the gutter=0 pack (that strong claim is false). What
      // OPTION A DOES guarantee, asserted here + below: (a) the body is untouched (pixels relocated, not
      // resized), and (b) the sprite is placed at best.{x,y}+g, so it owns g px on its top/left side ⇒ no
      // sprite hugs the bin origin (min x/y >= g). Right/bottom gutter is covered by the owned-box test.
      for (const [id, p0] of base) {
        const pg = gut.get(id)!;
        expect(pg.w).toBe(p0.w);
        expect(pg.h).toBe(p0.h);
      }
      for (const p of bins.flatMap((b) => b.placements)) {
        expect(p.x).toBeGreaterThanOrEqual(g); // owns g px of left gutter (sprite offset +g off best.x)
        expect(p.y).toBeGreaterThanOrEqual(g); // owns g px of top gutter
      }
    });

    it(`gutter=${g}: each sprite's g-inflated box owns g px on all 4 sides AND is overlap-free + in-bin`, () => {
      const bins = pack(ITEMS, { ...opts, gutter: g });
      expect(bins.flatMap((b) => b.placements).length).toBe(ITEMS.length);
      for (const bin of bins) {
        // The owned region = sprite grown by g on every side (the room edge-extrude bleeds into).
        const owned = bin.placements.map((p) => ({ id: p.id, x: p.x - g, y: p.y - g, w: p.w + 2 * g, h: p.h + 2 * g }));
        for (const o of owned) {
          // gutter on left/top is real (sprite was offset +g): the owned box never goes negative because
          // the reserved block started at best.{x,y} = sprite-{x,y}-g >= 0.
          expect(o.x).toBeGreaterThanOrEqual(0);
          expect(o.y).toBeGreaterThanOrEqual(0);
          expect(o.x + o.w).toBeLessThanOrEqual(bin.w); // owned gutter stays inside the POT sheet
          expect(o.y + o.h).toBeLessThanOrEqual(bin.h);
        }
        // No two sprites' OWNED gutter bands overlap ⇒ an extrude strip (extrude<=g) of one sprite can
        // never reach another sprite's body or gutter ⇒ order-independent, neighbour-safe bleed.
        for (let i = 0; i < owned.length; i++)
          for (let j = i + 1; j < owned.length; j++) expect(overlaps(owned[i]!, owned[j]!)).toBe(false);
      }
    });
  }
});

describe('pack — gutter>0 is deterministic and may grow the bin (honest VRAM cost)', () => {
  const opts = { maxSize: 2048, allowRotation: false, padding: 2 };

  it('repeated packs with the same gutter are byte-identical (determinism)', () => {
    expect(pack(ITEMS, { ...opts, gutter: 4 })).toEqual(pack(ITEMS, { ...opts, gutter: 4 }));
  });

  it('a large gutter can push items to a bigger POT bin than gutter=0 (never smaller)', () => {
    // 4 tiles that exactly tile a 64² bin at gutter=0; a gutter inflates each by 2*g and forces a 128² bin.
    const tiles: PackItem[] = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, w: 32, h: 32 }));
    const tight = pack(tiles, { maxSize: 2048, allowRotation: false, padding: 0, gutter: 0 });
    const bled = pack(tiles, { maxSize: 2048, allowRotation: false, padding: 0, gutter: 8 });
    const area = (b: PackBin[]): number => b.reduce((s, bin) => s + bin.w * bin.h, 0);
    expect(area(bled)).toBeGreaterThanOrEqual(area(tight)); // honesty: gutter can ⇒ MORE VRAM, never less
    expect(area(bled)).toBeGreaterThan(area(tight)); // and in this case it genuinely grows
  });
});
