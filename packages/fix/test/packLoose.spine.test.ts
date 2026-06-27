// PURE golden coverage for packLoose(kind:'spine') (design §11.3 + §11.4 existing-round-trip guard + §11.5
// determinism). Spine differs from static in ONE place: spriteSourceSize.y carries the libGDX BOTTOM-LEFT
// offset (the Y-flip lives only in trim.ts/packLoose), so emitSpineAtlasText writes it verbatim and a
// parseSpineAtlasText re-parse recovers it. Coverage: nested region names preserved; the NEW-producer
// offset (feed a top-left bbox → assert the emitted offset is bottom-left and re-parses correct); multi-page
// per-page region membership (driven by pageOfName, ONE .atlas = N page blocks); determinism; and the
// existing spine-basic repack round-trip stays BYTE-IDENTICAL (proves the emitters are unchanged — §3b).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Atlas, LooseRegion } from '@asset-doctor/core';
import { parseSpineAtlasText, parseSpinePage } from '@asset-doctor/parsers';
import { packLoose, emitSpineAtlasText, repackAtlases, type PackLooseOptions } from '../src/index';

// (region name, sourceSize, top-left bbox the worker's alphaBBox recovers) from the spine-loose fixture.
type Spec = { name: string; w: number; h: number; trim: { x: number; y: number; w: number; h: number } };
const SPINE: Spec[] = [
  { name: 'head', w: 64, h: 64, trim: { x: 4, y: 4, w: 56, h: 56 } },
  { name: 'items/sword', w: 32, h: 96, trim: { x: 8, y: 0, w: 16, h: 96 } }, // nested + trimmed
  { name: 'shield', w: 72, h: 72, trim: { x: 6, y: 6, w: 60, h: 60 } },
  { name: 'cape', w: 80, h: 100, trim: { x: 10, y: 20, w: 60, h: 60 } }, // asymmetric → Y-flip visible
];

const regionsOf = (specs: Spec[]): LooseRegion[] =>
  specs.map((s) => ({ ref: `spine-loose/${s.name}.png`, name: s.name, sourceSize: { w: s.w, h: s.h }, trim: s.trim }));

const opts = (over: Partial<PackLooseOptions> = {}): PackLooseOptions => ({
  kind: 'spine',
  imageBase: 'spine-loose',
  targetMime: 'image/png', // spine sheets default to PNG (runtime-safe)
  trim: true,
  padding: 2,
  maxSize: 4096,
  allowRotation: false,
  format: 'RGBA8888',
  ...over,
});

/** Emit a multi-page Spine .atlas the way the worker does: per-bin emitSpineAtlasText concatenated with a
 *  blank line, so each region sits under ITS page header (parseSpineAtlasText detects the page boundary). */
const emitAtlasText = (atlases: Atlas[]): string => atlases.map(emitSpineAtlasText).join('\n');

const spriteOf = (atlases: Atlas[], name: string) => atlases.flatMap((a) => a.sprites).find((s) => s.name === name)!;

describe('packLoose spine — region naming + bottom-left offset (§11.3)', () => {
  const { atlases } = packLoose(regionsOf(SPINE), opts());

  it('packs into ONE page (4 small regions fit); source.kind spine; format carried', () => {
    expect(atlases).toHaveLength(1);
    expect(atlases[0]!.source.kind).toBe('spine');
    expect(atlases[0]!.format).toBe('RGBA8888');
    expect(atlases[0]!.imageRef).toBe('spine-loose.png'); // single page → no suffix
  });

  it('a NESTED region keeps its slash-preserved sub-path (never flattened)', () => {
    expect(atlases.flatMap((a) => a.sprites.map((s) => s.name))).toContain('items/sword');
  });

  it('spriteSourceSize.y carries the BOTTOM-LEFT offset (the Y-flip), not the top-left bbox.y', () => {
    // cape: source 80×100, bbox {x:10,y:20,w:60,h:60} → bottom-left offsetY = 100-(20+60) = 20.
    const cape = spriteOf(atlases, 'cape');
    expect(cape.trimmed).toBe(true);
    expect(cape.spriteSourceSize!.x).toBe(10);
    expect(cape.spriteSourceSize!.y).toBe(20); // bottom-left (NOT the top-left bbox.y, which is also 20 here)
    // head: bbox {x:4,y:4,...,h:56} on a 64-tall source → bottom-left offsetY = 64-(4+56) = 4.
    expect(spriteOf(atlases, 'head').spriteSourceSize!.y).toBe(4);
    // items/sword: bbox {x:8,y:0,w:16,h:96} flush-top on a 96-tall source → offsetY = 96-(0+96) = 0.
    expect(spriteOf(atlases, 'items/sword').spriteSourceSize!.y).toBe(0);
  });

  it('every emitted sprite is rotated:false (v1 never rotates a blit)', () => {
    expect(atlases.every((a) => a.sprites.every((s) => s.rotated === false))).toBe(true);
  });
});

describe('packLoose spine — NEW-producer offset re-parses via parseSpineAtlasText (§11.3)', () => {
  it('a TOP-LEFT bbox in → BOTTOM-LEFT offset emitted → re-parse recovers the region', () => {
    // A single region with a clearly asymmetric top-left bbox so the flip is non-trivial.
    const region: LooseRegion = { ref: 'a.png', name: 'glyph', sourceSize: { w: 64, h: 80 }, trim: { x: 4, y: 8, w: 40, h: 50 } };
    const { atlases } = packLoose([region], opts());
    const text = emitSpineAtlasText(atlases[0]!);
    const page = parseSpineAtlasText(text)[0]!;
    const re = page.sprites.find((s) => s.name === 'glyph')!;

    // expected bottom-left offset: x = bbox.x = 4 ; y = sourceSize.h - (bbox.y + bbox.h) = 80 - (8+50) = 22.
    expect(re.trimmed).toBe(true);
    expect(re.sourceSize).toEqual({ w: 64, h: 80 }); // .atlas orig:
    expect(re.frame.w).toBe(40); // .atlas size: == un-rotated trimmed extent
    expect(re.frame.h).toBe(50);
    expect(re.spriteSourceSize).toMatchObject({ x: 4, y: 22 }); // re-parsed bottom-left offset
    expect(re.rotated).toBe(false);
  });

  it('the full spine-loose set round-trips: every region recovers orig/size/offset/rotate', () => {
    const { atlases } = packLoose(regionsOf(SPINE), opts());
    const page = parseSpineAtlasText(emitAtlasText(atlases))[0]!;
    const byName = new Map(page.sprites.map((s) => [s.name, s]));
    for (const s of SPINE) {
      const re = byName.get(s.name)!;
      expect(re.sourceSize).toEqual({ w: s.w, h: s.h });
      expect(re.frame.w).toBe(s.trim.w);
      expect(re.frame.h).toBe(s.trim.h);
      const expectedOffsetY = s.h - (s.trim.y + s.trim.h);
      expect(re.spriteSourceSize).toMatchObject({ x: s.trim.x, y: expectedOffsetY });
      expect(re.rotated).toBe(false);
    }
  });
});

describe('packLoose spine — multi-page per-page region membership (§11.3)', () => {
  // Mirror spine-loose-spill: 12 opaque 64×64 regions + a forced small maxSize → spill across ≥2 pages.
  const N = 12;
  const SPILL: LooseRegion[] = Array.from({ length: N }, (_, i) => {
    const name = `part_${String(i).padStart(2, '0')}`;
    return { ref: `spine-loose-spill/${name}.png`, name, sourceSize: { w: 64, h: 64 } };
  });
  const { atlases, pageOfName } = packLoose(SPILL, opts({ maxSize: 128, padding: 2, trim: false }));

  it('spills across ≥2 pages with per-page image suffixes', () => {
    expect(atlases.length).toBeGreaterThanOrEqual(2);
    expect(atlases[0]!.imageRef).toBe('spine-loose.png');
    expect(atlases[1]!.imageRef).toBe('spine-loose_1.png');
  });

  it('ONE .atlas = N page blocks: parseSpineAtlasText recovers each page with its own image', () => {
    const pages = parseSpineAtlasText(emitAtlasText(atlases));
    expect(pages.length).toBe(atlases.length);
    pages.forEach((p, i) => expect(p.image).toBe(atlases[i]!.imageRef));
  });

  it("each re-parsed region sits under ITS page header (membership matches pageOfName)", () => {
    const pages = parseSpineAtlasText(emitAtlasText(atlases));
    pages.forEach((p, i) => {
      for (const s of p.sprites) expect(pageOfName.get(s.name)).toBe(i); // region is on the page packLoose placed it
    });
    // and the union over pages is exactly all 12 regions (no spilled region lost or mis-paged)
    const all = pages.flatMap((p) => p.sprites.map((s) => s.name)).sort();
    expect(all).toEqual(SPILL.map((r) => r.name).sort());
  });

  it("every re-parsed region's frame.xy is within ITS page size", () => {
    const pages = parseSpineAtlasText(emitAtlasText(atlases));
    pages.forEach((p, i) => {
      const size = atlases[i]!.size;
      for (const s of p.sprites) {
        expect(s.frame.x + s.frame.w).toBeLessThanOrEqual(size.w);
        expect(s.frame.y + s.frame.h).toBeLessThanOrEqual(size.h);
      }
    });
  });
});

describe('packLoose spine — determinism (§11.5)', () => {
  it('twice → deep-equal Atlas[] and byte-identical .atlas text', () => {
    const a = packLoose(regionsOf(SPINE), opts());
    const b = packLoose(regionsOf(SPINE), opts());
    expect(b.atlases).toEqual(a.atlases);
    expect(emitAtlasText(a.atlases)).toBe(emitAtlasText(b.atlases));
  });

  it('shuffled input → identical Atlas[] and identical .atlas bytes', () => {
    const ordered = regionsOf(SPINE);
    const a = packLoose(ordered, opts());
    const b = packLoose([...ordered].reverse(), opts());
    expect(b.atlases).toEqual(a.atlases);
    expect(emitAtlasText(a.atlases)).toBe(emitAtlasText(b.atlases));
  });

  it('sprite order === emitted region order (localeCompare)', () => {
    const atlas = packLoose([...regionsOf(SPINE)].reverse(), opts()).atlases[0]!;
    const order = atlas.sprites.map((s) => s.name);
    expect(order).toEqual([...order].sort((x, y) => x.localeCompare(y)));
    // the emitter sorts the same way → re-parsed page preserves that order
    const reOrder = parseSpineAtlasText(emitSpineAtlasText(atlas))[0]!.sprites.map((s) => s.name);
    expect(reOrder).toEqual(order);
  });
});

// EXISTING-round-trip guard (§11.4): the spine-basic repack round-trip must stay BYTE-IDENTICAL. This proves
// emitSpineAtlasText / parseSpineAtlasText are UNCHANGED by Feature 4 (the Y-flip lives only in trim.ts; a
// stray edit to the emitter would double-flip an already-bottom-left value and break spine-basic).
describe('existing-round-trip guard — spine-basic stays byte-identical (§11.4)', () => {
  const spineDir = fileURLToPath(new URL('../../../fixtures/sample-projects/spine-basic/', import.meta.url));
  const loadSpineBasic = (): Atlas => {
    const page = parseSpineAtlasText(readFileSync(`${spineDir}sheet.atlas`, 'utf8'))[0]!;
    const res = parseSpinePage(page, { ref: 'sheet.png', bytes: new Uint8Array(readFileSync(`${spineDir}sheet.png`)) });
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('spine-basic fixture parse failed');
    return res.asset.atlas;
  };

  it('repack → emit twice yields byte-identical .atlas text (emitters deterministic & unchanged)', () => {
    const atlas = loadSpineBasic();
    const r1 = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }).atlases[0]!;
    const r2 = repackAtlases([atlas], { allowRotation: false, padding: 2, maxSize: 4096 }).atlases[0]!;
    expect(emitSpineAtlasText(r1)).toBe(emitSpineAtlasText(r2));
  });

  it('emit → parse → re-emit is a byte-identical fixpoint for spine-basic', () => {
    const atlas = loadSpineBasic();
    const once = emitSpineAtlasText(atlas);
    const reparsed = parseSpineAtlasText(once)[0]!;
    const twice = emitSpineAtlasText({ ...atlas, sprites: reparsed.sprites, size: reparsed.size ?? atlas.size });
    expect(twice).toBe(once); // a stray emitter Y-flip edit would break this fixpoint
  });

  it('every spine-basic sprite survives the round-trip (orig/size/offset/rotate preserved)', () => {
    const atlas = loadSpineBasic();
    const re = parseSpineAtlasText(emitSpineAtlasText(atlas))[0]!;
    const sort = <T extends { name: string }>(a: T[]) => [...a].sort((x, y) => x.name.localeCompare(y.name));
    expect(sort(re.sprites)).toEqual(sort(atlas.sprites));
  });
});
