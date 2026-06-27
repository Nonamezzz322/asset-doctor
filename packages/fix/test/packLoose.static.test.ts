// PURE golden coverage for packLoose(kind:'static') (design §11.2 + §11.5 determinism + §11.6 sentinel).
// Builds LooseRegions from the loose-static fixture (trim = the authored opaque bbox the worker's
// alphaBBox recovers), packs them, and proves: frame/sourceSize/spriteSourceSize; `trimmed` only when the
// bbox is strictly inside the source; multi-page spill (forced small maxSize) with per-page meta.image and
// single page → NO suffix; Blit.from.rect == the trimmed bbox; the emitted TP JSON re-parses via the REAL
// @asset-doctor/parsers; determinism + shuffle-invariance + sprite-order == emitted manifest order; and the
// fully-transparent 1×1 sentinel re-parses (trimmed=true, sourceSize=original) with no analysis div-by-zero.

import { describe, it, expect } from 'vitest';
import type { Atlas, LooseRegion } from '@asset-doctor/core';
import { parseAtlasManifest } from '@asset-doctor/parsers';
import { buildCoverage, defaultCell, occupancyValue } from '@asset-doctor/analysis';
import { packLoose, emitTexturePackerJson, type PackLooseOptions } from '../src/index';

// (name, sourceSize w/h, trim x/y/w/h authored by the generator). `trim` undefined ⇒ fully opaque (the
// worker would still hand the whole-image bbox; here we model the two emit shapes explicitly).
type Spec = { name: string; w: number; h: number; trim?: { x: number; y: number; w: number; h: number } };
const STATIC: Spec[] = [
  { name: 'coin', w: 64, h: 64, trim: { x: 8, y: 8, w: 48, h: 48 } },
  { name: 'gem', w: 64, h: 64, trim: { x: 0, y: 0, w: 64, h: 64 } }, // full opaque (bbox == source)
  { name: 'key', w: 80, h: 40, trim: { x: 10, y: 4, w: 60, h: 32 } },
  { name: 'potion', w: 48, h: 96, trim: { x: 6, y: 12, w: 36, h: 72 } },
  { name: 'ring', w: 40, h: 40, trim: { x: 4, y: 4, w: 32, h: 32 } },
  { name: 'scroll', w: 100, h: 60, trim: { x: 0, y: 0, w: 100, h: 60 } }, // full opaque
  { name: 'shield', w: 72, h: 72, trim: { x: 4, y: 8, w: 64, h: 56 } },
  { name: 'sword', w: 32, h: 120, trim: { x: 8, y: 0, w: 16, h: 120 } },
];

const regionsOf = (specs: Spec[]): LooseRegion[] =>
  specs.map((s) => ({ ref: `loose-static/${s.name}.png`, name: s.name, sourceSize: { w: s.w, h: s.h }, ...(s.trim ? { trim: s.trim } : {}) }));

const opts = (over: Partial<PackLooseOptions> = {}): PackLooseOptions => ({
  kind: 'static',
  imageBase: 'loose-static',
  targetMime: 'image/png',
  trim: true,
  padding: 2,
  maxSize: 4096,
  allowRotation: false,
  ...over,
});

const spriteOf = (atlases: Atlas[], name: string) => atlases.flatMap((a) => a.sprites).find((s) => s.name === name)!;

describe('packLoose static — frame / sourceSize / spriteSourceSize (§11.2)', () => {
  const { atlases, blits, pageOfName } = packLoose(regionsOf(STATIC), opts());

  it('packs onto a SINGLE POT page (all 8 fit at maxSize 4096)', () => {
    expect(atlases).toHaveLength(1);
    expect(atlases[0]!.size.w & (atlases[0]!.size.w - 1)).toBe(0); // power of two
    expect(atlases[0]!.size.h & (atlases[0]!.size.h - 1)).toBe(0);
    expect(atlases[0]!.source.kind).toBe('texturepacker-hash');
  });

  it('single page ⇒ NO _N suffix on the imageRef', () => {
    expect(atlases[0]!.imageRef).toBe('loose-static.png');
  });

  it('every region is folded in exactly once (no loss/dupe)', () => {
    const names = atlases.flatMap((a) => a.sprites.map((s) => s.name)).sort();
    expect(names).toEqual(STATIC.map((s) => s.name).sort());
  });

  it('a trimmed region: frame.w/h == trimmed bbox, sourceSize == full, spriteSourceSize == top-left bbox', () => {
    const coin = spriteOf(atlases, 'coin');
    expect(coin.trimmed).toBe(true);
    expect(coin.frame.w).toBe(48); // packed at the TRIMMED size, not the 64×64 source
    expect(coin.frame.h).toBe(48);
    expect(coin.sourceSize).toEqual({ w: 64, h: 64 });
    expect(coin.spriteSourceSize).toEqual({ x: 8, y: 8, w: 48, h: 48 }); // TOP-LEFT (TP convention)
    expect(coin.rotated).toBe(false);
  });

  it('a fully-opaque region (bbox == source): trimmed:false, NO spriteSourceSize, frame == source', () => {
    const gem = spriteOf(atlases, 'gem');
    expect(gem.trimmed).toBe(false);
    expect(gem.spriteSourceSize).toBeUndefined();
    expect(gem.frame.w).toBe(64);
    expect(gem.frame.h).toBe(64);
    expect(gem.sourceSize).toEqual({ w: 64, h: 64 });
  });

  it('Blit.from.rect == the trimmed bbox (the source pixels the worker copies); rotate90 false', () => {
    const blit = blits.find((b) => b.name === 'coin')!;
    expect(blit.from.atlasRef).toBe('loose-static/coin.png');
    expect(blit.from.rect).toEqual({ x: 8, y: 8, w: 48, h: 48 });
    expect(blit.from.rotated).toBe(false);
    expect(blit.rotate90).toBe(false);
    expect(blit.to.w).toBe(48); // lands at the trimmed extent
    expect(blit.to.h).toBe(48);
  });

  it('Blit.from.rect for a full-opaque region is the whole image', () => {
    const blit = blits.find((b) => b.name === 'gem')!;
    expect(blit.from.rect).toEqual({ x: 0, y: 0, w: 64, h: 64 });
  });

  it('pageOfName records bin 0 for every region on the single page', () => {
    for (const s of STATIC) expect(pageOfName.get(s.name)).toBe(0);
  });
});

describe('packLoose static — trim:false packs the untrimmed footprint', () => {
  it('with trim off, every sprite is trimmed:false and frame == sourceSize', () => {
    const { atlases } = packLoose(regionsOf(STATIC), opts({ trim: false }));
    const coin = spriteOf(atlases, 'coin');
    expect(coin.trimmed).toBe(false);
    expect(coin.spriteSourceSize).toBeUndefined();
    expect(coin.frame.w).toBe(64); // untrimmed
    expect(coin.frame.h).toBe(64);
  });
});

describe('packLoose static — re-parse via the REAL @asset-doctor/parsers (§11.2)', () => {
  it('emitted TP JSON re-parses to the same frames; meta.image == sheet basename', () => {
    const atlas = packLoose(regionsOf(STATIC), opts()).atlases[0]!;
    const json = emitTexturePackerJson(atlas);
    const parsed = JSON.parse(json) as { meta: { image: string } };
    expect(parsed.meta.image).toBe('loose-static.png'); // meta.image = the sheet basename beside the JSON

    const res = parseAtlasManifest(JSON.parse(json), { imageRef: atlas.imageRef, imageSize: atlas.size });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.atlas).toEqual(atlas); // emit → parse → identical Atlas (contract closes)
  });
});

describe('packLoose static — multi-page spill: per-page meta.image (§11.2)', () => {
  // Force a tiny maxSize so the 8 regions cannot share one POT page → spill onto page 1+.
  const { atlases, pageOfName } = packLoose(regionsOf(STATIC), opts({ maxSize: 128 }));

  it('spills across ≥2 pages', () => {
    expect(atlases.length).toBeGreaterThanOrEqual(2);
  });

  it('page 0 imageRef has NO suffix; page i>0 imageRef is `${base}_${i}`', () => {
    expect(atlases[0]!.imageRef).toBe('loose-static.png');
    expect(atlases[1]!.imageRef).toBe('loose-static_1.png');
  });

  it("each page's TP JSON meta.image == THAT page's image basename (re-parses per page)", () => {
    atlases.forEach((atlas, i) => {
      const json = emitTexturePackerJson(atlas);
      const expectedImage = i === 0 ? 'loose-static.png' : `loose-static_${i}.png`;
      expect((JSON.parse(json) as { meta: { image: string } }).meta.image).toBe(expectedImage);
      const res = parseAtlasManifest(JSON.parse(json), { imageRef: atlas.imageRef, imageSize: atlas.size });
      expect(res.ok).toBe(true);
    });
  });

  it('pageOfName maps each region to its actual page; union of pages == all regions', () => {
    const byPage = new Map<number, string[]>();
    for (const [name, page] of pageOfName) (byPage.get(page) ?? byPage.set(page, []).get(page)!).push(name);
    // every region appears in exactly the page whose sprite list contains it
    for (const atlas of atlases) {
      const idx = atlases.indexOf(atlas);
      for (const s of atlas.sprites) expect(pageOfName.get(s.name)).toBe(idx);
    }
    const all = atlases.flatMap((a) => a.sprites.map((s) => s.name)).sort();
    expect(all).toEqual(STATIC.map((s) => s.name).sort());
  });
});

describe('packLoose static — determinism & order (§11.5)', () => {
  it('packLoose + emit twice → deep-equal Atlas[] AND byte-identical JSON', () => {
    const r1 = packLoose(regionsOf(STATIC), opts());
    const r2 = packLoose(regionsOf(STATIC), opts());
    expect(r2.atlases).toEqual(r1.atlases);
    expect(r1.atlases.map(emitTexturePackerJson)).toEqual(r2.atlases.map(emitTexturePackerJson));
  });

  it('shuffled input → identical Atlas[] and identical bytes (shuffle-invariant)', () => {
    const ordered = regionsOf(STATIC);
    const shuffled = [...ordered].reverse(); // a deterministic non-identity permutation
    const a = packLoose(ordered, opts());
    const b = packLoose(shuffled, opts());
    expect(b.atlases).toEqual(a.atlases);
    expect(a.atlases.map(emitTexturePackerJson)).toEqual(b.atlases.map(emitTexturePackerJson));
  });

  it('packLoose sprite order === emitted manifest frame order (localeCompare)', () => {
    const atlas = packLoose([...regionsOf(STATIC)].reverse(), opts()).atlases[0]!;
    const spriteOrder = atlas.sprites.map((s) => s.name);
    const emittedOrder = Object.keys((JSON.parse(emitTexturePackerJson(atlas)) as { frames: Record<string, unknown> }).frames);
    expect(spriteOrder).toEqual(emittedOrder);
    expect(spriteOrder).toEqual([...spriteOrder].sort((x, y) => x.localeCompare(y))); // == localeCompare
  });
});

describe('packLoose static — 1×1 fully-transparent sentinel (§11.6)', () => {
  // The worker resolves a fully-transparent region (alphaBBox === null) to a 1×1 sentinel: a 1×1 trim at
  // origin, trimmed=true, sourceSize=original. We model that LooseRegion and pack it alongside real regions.
  const sentinel: LooseRegion = { ref: 'loose-static/blank.png', name: 'blank', sourceSize: { w: 50, h: 50 }, trim: { x: 0, y: 0, w: 1, h: 1 } };
  const { atlases } = packLoose([...regionsOf(STATIC), sentinel], opts());
  const atlas = atlases.find((a) => a.sprites.some((s) => s.name === 'blank'))!;
  const blank = atlas.sprites.find((s) => s.name === 'blank')!;

  it('the sentinel is a 1×1 frame, trimmed:true, sourceSize == the original', () => {
    expect(blank.frame.w).toBe(1);
    expect(blank.frame.h).toBe(1);
    expect(blank.trimmed).toBe(true); // 1×1 bbox is strictly inside 50×50
    expect(blank.sourceSize).toEqual({ w: 50, h: 50 });
    expect(blank.spriteSourceSize).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('the sentinel re-parses via parseAtlasManifest (frame stays resolvable)', () => {
    const res = parseAtlasManifest(JSON.parse(emitTexturePackerJson(atlas)), { imageRef: atlas.imageRef, imageSize: atlas.size });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const re = res.atlas.sprites.find((s) => s.name === 'blank')!;
      expect(re.trimmed).toBe(true);
      expect(re.sourceSize).toEqual({ w: 50, h: 50 });
    }
  });

  it('analysis (grid coverage + occupancy) does NOT divide-by-zero on the 1px frame', () => {
    const cell = defaultCell(atlas.size);
    expect(() => buildCoverage(atlas, cell)).not.toThrow();
    const occ = occupancyValue(atlas);
    expect(Number.isFinite(occ)).toBe(true);
    expect(occ).toBeGreaterThanOrEqual(0);
  });
});
