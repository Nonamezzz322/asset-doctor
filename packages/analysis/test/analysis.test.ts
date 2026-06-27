import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Asset, Atlas, Rect } from '@asset-doctor/core';
import { parseAtlas, parseImage } from '@asset-doctor/parsers';
import { analyze, buildCoverage, mergeEmptyRects, summarizeEmpty, occupancyValue, occupancyFinding, wastedRegions, formatFinding, DEFAULT_THRESHOLDS, mergeSharedAtlases, groupVariants, stemOf, hasResolutionToken } from '../src/index';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sample-projects');
const readJson = (p: string): unknown => JSON.parse(readFileSync(join(FIXTURES, p), 'utf8'));
const readBytes = (p: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, p)));

interface ExpectedFinding {
  rule: string;
  severity: string;
}
interface ExpectedAtlas {
  occupancy: number;
  atlas: { w: number; h: number };
  findings: ExpectedFinding[];
}
interface ExpectedImages {
  images: { name: string; w: number; h: number; vramBytes: number; findings: ExpectedFinding[] }[];
}

const sig = (fs: ReadonlyArray<{ rule: string; severity: string }>): string[] =>
  fs.map((f) => `${f.rule}:${f.severity}`).sort();

const ATLAS_CASES = [
  { dir: 'tp-hash-symbols', manifest: 'symbols.json', img: 'symbols.png' },
  { dir: 'tp-array-oversize', manifest: 'sheet.json', img: 'sheet.png' },
  { dir: 'pixi-packed-ok', manifest: 'packed.json', img: 'packed.png' },
];

describe('analyze — atlas goldens', () => {
  for (const c of ATLAS_CASES) {
    it(`matches expected.json for ${c.dir}`, async () => {
      const expected = readJson(`${c.dir}/expected.json`) as ExpectedAtlas;
      const parsed = parseAtlas(readJson(`${c.dir}/${c.manifest}`), {
        ref: c.img,
        bytes: readBytes(`${c.dir}/${c.img}`),
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const report = await analyze([parsed.asset]);
      const m = report.assets[0];

      expect(Math.round((m?.occupancy ?? 0) * 10000) / 10000).toBe(expected.occupancy);
      expect(sig(report.findings)).toEqual(sig(expected.findings));
      expect(m?.vramBytes).toBe(expected.atlas.w * expected.atlas.h * 4);
    });
  }
});

describe('analyze — single images', () => {
  it('matches expected.json for single-images', async () => {
    const expected = readJson('single-images/expected.json') as ExpectedImages;
    const assets = expected.images.map((im) => {
      const r = parseImage(im.name, readBytes(`single-images/${im.name}`));
      if (!r.ok) throw new Error(`parse failed: ${im.name}`);
      return r.asset;
    });
    const report = await analyze(assets);

    for (const im of expected.images) {
      const got = report.findings.filter((f) => f.assetRef === im.name && f.scope !== 'folder');
      expect(sig(got)).toEqual(sig(im.findings));
      expect(report.assets.find((a) => a.assetRef === im.name)?.vramBytes).toBe(im.vramBytes);
    }
  });
});

describe('atlasFrames (host render-probe input)', () => {
  it('carries one rect per sprite, keyed by atlas.name === assetRef === the fileMap key', async () => {
    const c = ATLAS_CASES[0]!; // tp-hash-symbols
    const parsed = parseAtlas(readJson(`${c.dir}/${c.manifest}`), {
      ref: c.img,
      bytes: readBytes(`${c.dir}/${c.img}`),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const atlas = (parsed.asset as Extract<Asset, { kind: 'atlas' }>).atlas;

    const report = await analyze([parsed.asset]);
    expect(report.atlasFrames).toBeDefined();
    const frames = report.atlasFrames?.[atlas.name];
    expect(frames).toBeDefined();
    // One rect per sprite, matching the packed frame geometry verbatim (already w/h-swapped if rotated).
    expect(frames?.length).toBe(atlas.sprites.length);
    expect(frames?.[0]).toEqual(atlas.sprites[0]?.frame);

    // INVARIANT (MAJOR2): every atlasFrames key === an AssetMetrics.assetRef. The web app keys its
    // fileMap by the same value (keyOf === atlas.name for atlases), so this guards the probe lookup
    // against a future ingest change silently breaking it.
    const refs = new Set(report.assets.map((a) => a.assetRef));
    for (const key of Object.keys(report.atlasFrames ?? {})) expect(refs.has(key)).toBe(true);
  });

  it('is omitted entirely for a loose-only folder (byte-identical to today)', async () => {
    const r = parseImage('hero.png', readBytes('single-images/hero.png'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = await analyze([r.asset]);
    expect(report.atlasFrames).toBeUndefined();
  });
});

describe('wasted-regions overlay', () => {
  const intersects = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it('maps only empty space — no overlay rect intersects a sprite frame', async () => {
    const parsed = parseAtlas(readJson('tp-hash-symbols/symbols.json'), {
      ref: 'symbols.png',
      bytes: readBytes('tp-hash-symbols/symbols.png'),
    });
    if (!parsed.ok || parsed.asset.kind !== 'atlas') throw new Error('expected atlas');
    const report = await analyze([parsed.asset]);

    const waste = report.findings.find((f) => f.rule === 'wasted-regions');
    expect(waste?.overlay?.[0]?.kind).toBe('empty');
    const rects = waste?.overlay?.[0]?.rects ?? [];
    expect(rects.length).toBeGreaterThan(0);

    const frames = parsed.asset.atlas.sprites.map((s) => s.frame);
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      for (const f of frames) expect(intersects(r, f)).toBe(false);
    }
  });

  it('grid merge covers exactly the empty cells', () => {
    const atlas: Atlas = {
      name: 't',
      imageRef: 't.png',
      size: { w: 40, h: 40 },
      sprites: [
        { name: 'a', frame: { x: 0, y: 0, w: 20, h: 20 }, rotated: false, trimmed: false, sourceSize: { w: 20, h: 20 } },
      ],
      source: { kind: 'pixi' },
    };
    const rects = mergeEmptyRects(buildCoverage(atlas, 10), atlas.size);
    // 40×40 = 1600px; a 20×20 frame covers 400px → 1200px empty.
    expect(rects.reduce((s, r) => s + r.w * r.h, 0)).toBe(1200);
  });
});

describe('format audit — injected encoder', () => {
  it('flags a saving past the threshold and stays silent below it', async () => {
    const r = parseImage('hero.png', readBytes('single-images/hero.png'));
    if (!r.ok || r.asset.kind !== 'image') throw new Error('parse failed');
    const disk = r.asset.image.byteSize;

    const big = await analyze([r.asset], undefined, { encodeImage: async () => Math.round(disk * 0.5) });
    expect(big.findings.some((f) => f.rule === 'format' && f.severity === 'warn')).toBe(true);
    expect(big.totals.potentialDiskSaved).toBeGreaterThan(0);

    const small = await analyze([r.asset], undefined, { encodeImage: async () => Math.round(disk * 0.95) });
    expect(small.findings.some((f) => f.rule === 'format')).toBe(false);
  });
});

describe('format audit — content-class lossless verdict', () => {
  const looseImg = (name: string): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 10000 },
  });

  it('photographic / unknown ⇒ byte-identical to today (rule format, messageKey format, no contentClass)', async () => {
    const photo = (await formatFinding('p.png', looseImg('p.png').image, DEFAULT_THRESHOLDS, async () => 4000, 'photographic'))!;
    const unknown = (await formatFinding('u.png', looseImg('u.png').image, DEFAULT_THRESHOLDS, async () => 4000))!;
    for (const f of [photo, unknown]) {
      expect(f.rule).toBe('format');
      expect(f.messageKey).toBe('format');
      expect(f.params?.contentClass).toBeUndefined();
    }
  });

  it('flat / alpha-art ⇒ rule stays format (B2), messageKey switches, lossy saving + contentClass param', async () => {
    for (const cls of ['flat', 'alpha-art'] as const) {
      const f = (await formatFinding('a.png', looseImg('a.png').image, DEFAULT_THRESHOLDS, async () => 4000, cls))!;
      expect(f.rule).toBe('format'); // plan.ts + aggregate key off this
      expect(f.messageKey).toBe('format-lossless');
      expect(f.params?.contentClass).toBe(cls);
      // Inv 4: the shown saving is today's LOSSY delta (10000 − 4000), NOT a lossless number.
      expect(f.estimate?.diskBytesSaved).toBe(6000);
    }
  });

  it('analyze threads contentClass to LOOSE images via features', async () => {
    const report = await analyze([looseImg('flat.png')], undefined, {
      encodeImage: async () => 4000,
      features: [{ assetRef: 'flat.png', contentHash: 'h', contentClass: 'flat' }],
    });
    const fmt = report.findings.find((f) => f.rule === 'format');
    expect(fmt?.messageKey).toBe('format-lossless');
    expect(fmt?.params?.contentClass).toBe('flat');
  });

  it('analyze NEVER drives a lossless verdict for an ATLAS, even if a feature classes it flat (M1)', async () => {
    const atlasAsset: Asset = {
      kind: 'atlas',
      atlas: {
        name: 'sheet.png',
        imageRef: 'sheet.png',
        size: { w: 256, h: 256 },
        sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
        source: { kind: 'pixi' },
      },
      image: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 10000 },
    };
    const report = await analyze([atlasAsset], undefined, {
      encodeImage: async () => 4000,
      features: [{ assetRef: 'sheet.png', contentHash: 'h', contentClass: 'flat' }],
    });
    const fmt = report.findings.find((f) => f.rule === 'format' && f.scope !== 'folder');
    expect(fmt?.messageKey).toBe('format'); // atlas keeps today's lossy verdict
    expect(fmt?.params?.contentClass).toBeUndefined();
  });

  it('absent features ⇒ every format finding is today\'s lossy verdict (CLI / headless unaffected)', async () => {
    const report = await analyze([looseImg('x.png')], undefined, { encodeImage: async () => 4000 });
    const fmt = report.findings.find((f) => f.rule === 'format');
    expect(fmt?.messageKey).toBe('format');
  });
});

describe('folder-level findings', () => {
  const img = (name: string, w: number, h: number, byteSize = 100): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize },
  });
  const atlasOf = (name: string, w: number, h: number, frames: Rect[]): Asset => ({
    kind: 'atlas',
    atlas: {
      name,
      imageRef: name,
      size: { w, h },
      sprites: frames.map((f, i) => ({
        name: `f${i}`,
        frame: f,
        rotated: false,
        trimmed: false,
        sourceSize: { w: f.w, h: f.h },
      })),
      source: { kind: 'pixi' },
    },
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 1000 },
  });

  it('flags exact duplicate files and counts the wasted bytes', async () => {
    const assets = [img('a.png', 64, 64, 500), img('b.png', 64, 64, 500)];
    const features = [
      { assetRef: 'a.png', contentHash: 'deadbeefdead' },
      { assetRef: 'b.png', contentHash: 'deadbeefdead' },
    ];
    const rep = await analyze(assets, undefined, { features });
    const dup = rep.findings.find((f) => f.rule === 'duplicate-exact');
    expect(dup?.scope).toBe('folder');
    expect(dup?.relatedRefs).toEqual(['a.png', 'b.png']);
    expect(dup?.estimate?.diskBytesSaved).toBe(500);
    expect(rep.totals.potentialDiskSaved).toBeGreaterThanOrEqual(500);
  });

  it('flags near-duplicate images via dHash but not exact ones', async () => {
    const assets = [img('a.png', 64, 64), img('b.png', 64, 64)];
    const features = [
      { assetRef: 'a.png', contentHash: 'h1', dHash: 'ffffffffffffffff' },
      { assetRef: 'b.png', contentHash: 'h2', dHash: 'ffffffffffffff3f' }, // 2 bits differ
    ];
    const rep = await analyze(assets, undefined, { features });
    const sim = rep.findings.find((f) => f.rule === 'duplicate-similar');
    expect(sim?.relatedRefs).toEqual(['a.png', 'b.png']);
    expect(rep.findings.some((f) => f.rule === 'duplicate-exact')).toBe(false);
  });

  it('suggests atlasing many loose sprites', async () => {
    const assets = Array.from({ length: 8 }, (_, i) => img(`s${i}.png`, 32, 32));
    const rep = await analyze(assets);
    expect(rep.findings.some((f) => f.rule === 'should-atlas' && f.scope === 'folder')).toBe(true);
  });

  it('suggests merging under-filled atlases', async () => {
    const frame: Rect[] = [{ x: 0, y: 0, w: 300, h: 300 }]; // ~8.6% of 1024²
    const rep = await analyze([atlasOf('a1.png', 1024, 1024, frame), atlasOf('a2.png', 1024, 1024, frame)]);
    const m = rep.findings.find((f) => f.rule === 'atlas-merge');
    expect(m?.relatedRefs).toEqual(['a1.png', 'a2.png']);
  });

  it('flags a manifest referencing a missing image', async () => {
    const rep = await analyze([], undefined, {
      missingImages: [{ manifest: 'broken.json', image: 'nope.png' }],
    });
    const ig = rep.findings.find((f) => f.rule === 'integrity-missing-image');
    expect(ig?.severity).toBe('crit');
    expect(ig?.relatedRefs).toContain('nope.png');
  });
});

describe('mergeSharedAtlases', () => {
  const atlasWith = (names: string[]): Asset => ({
    kind: 'atlas',
    atlas: {
      name: 'page.png',
      imageRef: 'page.png',
      size: { w: 100, h: 100 },
      sprites: names.map((n, i) => ({
        name: n,
        frame: { x: i * 10, y: 0, w: 10, h: 10 },
        rotated: false,
        trimmed: false,
        sourceSize: { w: 10, h: 10 },
      })),
      source: { kind: 'spine' },
    },
    image: { name: 'page.png', imageRef: 'page.png', size: { w: 100, h: 100 }, mime: 'image/png', byteSize: 1 },
  });

  it('unions regions of atlases sharing one image and counts it once', () => {
    const merged = mergeSharedAtlases([atlasWith(['a', 'b', 'c']), atlasWith(['c', 'd'])]);
    const atlases = merged.filter((x) => x.kind === 'atlas');
    expect(atlases).toHaveLength(1);
    const first = atlases[0];
    if (!first || first.kind !== 'atlas') throw new Error('expected atlas');
    expect(first.atlas.sprites.map((s) => s.name).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('variant grouping (VRAM inflation)', () => {
  const img = (name: string, w: number, h: number): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 1 },
  });

  it('strips resolution + format tokens to a stem', () => {
    expect(stemOf('bonus_background_1080p_webp.webp')).toBe('bonus_background');
    expect(stemOf('bonus_background_540p.png')).toBe('bonus_background');
    expect(stemOf('icon.png')).toBe('icon');
  });

  it('strips the directory before stemming, then re-prefixes it (dir-aware refs)', () => {
    // A path-prefixed name must stem on the BASENAME (so tokens peel) yet keep the dir prefix so two
    // same-stem files in different folders stay distinct stems.
    expect(stemOf('ui/hero_1080p.png')).toBe('ui/hero');
    expect(stemOf('a/sprite.png')).not.toBe(stemOf('b/sprite.png'));
    expect(stemOf('a/sprite.png')).toBe('a/sprite');
  });

  it('groups format+resolution variants and computes the loaded VRAM range', () => {
    const v540 = 540 * 540 * 4;
    const v1080 = 1080 * 1080 * 4;
    const v100 = 100 * 100 * 4;
    const v = groupVariants([
      img('hero_540p.png', 540, 540),
      img('hero_540p_webp.webp', 540, 540),
      img('hero_1080p.png', 1080, 1080),
      img('hero_1080p_avif.avif', 1080, 1080),
      img('other.png', 100, 100),
    ]);
    // Resolution-stem clustering (correction 3): the two RESOLUTION-token files (hero_540p / hero_1080p)
    // cluster by stem ALONE ("hero"); the two FORMAT-suffixed files (hero_540p_webp / hero_1080p_avif),
    // whose TRAILING token is a format, keep the stem|aspectBucket key (both aspect 1:1 → one group).
    // So this set forms TWO logical groups, each a 540p+1080p resolution pair; 'other' is a singleton.
    expect(v.groups).toHaveLength(2);
    for (const g of v.groups) expect(g.members).toHaveLength(2);
    expect(v.summedVram).toBe(2 * v540 + 2 * v1080 + v100);
    // One tier loads per group: each group's largest is 1080² → 2·v1080, plus the 'other' singleton.
    expect(v.loadedVramMax).toBe(2 * v1080 + v100);
    expect(v.loadedVramMin).toBe(2 * v540 + v100);
  });

  it('clusters a resolution tier with its source despite an independently-rounded aspect ratio', () => {
    // A 100×50 banner downscaled to _720p (×0.75) rounds to 75×38 — aspectBucket round(w/h·50) is
    // 100 (source) vs 99 (tier), so the old stem|aspectBucket key would split them into two groups
    // and over-count loaded VRAM. The resolution-only stem path must put both in ONE group.
    const vTop = 100 * 50 * 4;
    const v = groupVariants([img('banner_1080p.png', 100, 50), img('banner_720p.png', 75, 38)]);
    expect(hasResolutionToken('banner_720p.png')).toBe(true);
    expect(hasResolutionToken('banner_webp.webp')).toBe(false); // format token, not resolution
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]?.members).toHaveLength(2);
    expect(v.groups[0]?.stem).toBe('banner');
    // One tier loads at runtime: loaded VRAM is the largest tier (the top), NOT the sum of both.
    expect(v.loadedVramMax).toBe(vTop);
    expect(v.loadedVramMax).toBeLessThan(v.summedVram);
  });

  it('clusters odd/non-divisible tier sets (33×17, 3×100) into one group each', () => {
    // Two assets whose default-ladder tiers all round independently — the aspect-bucket key would scatter
    // them, the resolution-stem path must keep each asset's three tiers together.
    const v = groupVariants([
      img('a/icon_1080p.png', 33, 17), img('a/icon_720p.png', 25, 13), img('a/icon_540p.png', 17, 9),
      img('b/bar_1080p.png', 3, 100), img('b/bar_720p.png', 2, 75), img('b/bar_540p.png', 2, 50),
    ]);
    expect(v.groups).toHaveLength(2);
    for (const g of v.groups) expect(g.members).toHaveLength(3); // every tier in its asset's group
    // loadedVramMax = the two top tiers only (33×17 + 3×100), never under-counting the top tier.
    expect(v.loadedVramMax).toBe(33 * 17 * 4 + 3 * 100 * 4);
    expect(v.loadedVramMax).toBeLessThan(v.summedVram);
  });

  it('surfaces a folder finding + loadedVramBytes < vramBytes in totals', async () => {
    const rep = await analyze([
      img('a_540p.png', 540, 540),
      img('a_1080p.png', 1080, 1080),
      img('b_540p.png', 540, 540),
      img('b_1080p.png', 1080, 1080),
    ]);
    expect(rep.findings.some((f) => f.rule === 'variants' && f.scope === 'folder')).toBe(true);
    expect(rep.totals.loadedVramBytes).toBeLessThan(rep.totals.vramBytes);
  });
});

describe('atlas fragmentation (dispersion of empty space)', () => {
  // Synthetic atlases built directly on the model (pure: no pixel read — frag operates on the rects
  // already merged). `cell` is fixed explicitly where the unit test asserts an exact frag so the grid
  // is deterministic and independent of defaultCell's size heuristic.
  const atlasOf = (name: string, w: number, h: number, frames: Rect[]): Atlas => ({
    name,
    imageRef: `${name}.png`,
    size: { w, h },
    sprites: frames.map((f, i) => ({
      name: `f${i}`,
      frame: f,
      rotated: false,
      trimmed: false,
      sourceSize: { w: f.w, h: f.h },
    })),
    source: { kind: 'pixi' },
  });
  const asset = (atlas: Atlas): Asset => ({
    kind: 'atlas',
    atlas,
    image: { name: atlas.name, imageRef: atlas.imageRef, size: atlas.size, mime: 'image/png', byteSize: 100 },
  });

  // CONTIGUOUS waste: one wide strip covers the whole top row → the remainder is ONE empty block.
  const contiguous = atlasOf('contig', 40, 40, [{ x: 0, y: 0, w: 40, h: 10 }]);
  // SHREDDED waste: a checkerboard of 10×10 sprites leaves 8 disjoint single-cell gaps, none dominant.
  const shreddedFrames: Rect[] = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) shreddedFrames.push({ x: c * 10, y: r * 10, w: 10, h: 10 });
  const shredded = atlasOf('shred', 40, 40, shreddedFrames);

  it('summarizeEmpty: [] → fragmentation undefined (no dispersion to describe)', () => {
    const e = summarizeEmpty([]);
    expect(e.n).toBe(0);
    expect(e.totalArea).toBe(0);
    expect(e.largestArea).toBe(0);
    expect(e.fragmentation).toBeUndefined();
  });

  it('summarizeEmpty: one rect → frag 1; many equal rects → frag = 1/n', () => {
    expect(summarizeEmpty([{ x: 0, y: 0, w: 10, h: 10 }]).fragmentation).toBe(1);
    const four: Rect[] = [
      { x: 0, y: 0, w: 5, h: 5 },
      { x: 10, y: 0, w: 5, h: 5 },
      { x: 0, y: 10, w: 5, h: 5 },
      { x: 10, y: 10, w: 5, h: 5 },
    ];
    expect(summarizeEmpty(four).fragmentation).toBe(0.25); // largest 25 / total 100
  });

  it('contiguous waste → frag near 1; shredded waste → frag well below 1', () => {
    const c = summarizeEmpty(mergeEmptyRects(buildCoverage(contiguous, 10), contiguous.size));
    expect(c.n).toBe(1); // one merged empty block
    expect(c.fragmentation).toBe(1);

    const s = summarizeEmpty(mergeEmptyRects(buildCoverage(shredded, 10), shredded.size));
    expect(s.n).toBeGreaterThan(1); // many scattered gaps
    expect(s.fragmentation).toBe(0.125); // largest 100 / total 800 — 8 equal cells
    expect(s.fragmentation!).toBeLessThan(0.5);
  });

  it('analyze populates AssetMetrics.fragmentation (defined when wasted-regions fires)', async () => {
    // Default cell (defaultCell(40)=8 → 5×5 grid): contiguous frag = 1, shredded frag < 1, both populated.
    const contigFrag = (await analyze([asset(contiguous)])).assets[0]?.fragmentation;
    const shredFrag = (await analyze([asset(shredded)])).assets[0]?.fragmentation;
    expect(contigFrag).toBe(1);
    expect(typeof shredFrag).toBe('number');
    expect(shredFrag!).toBeLessThan(1);
    // The dispersion ordering is the whole point: shredded is more fragmented than contiguous.
    expect(shredFrag!).toBeLessThan(contigFrag!);
  });

  it('occupancyFinding carries the frag/largestPct params it was given', () => {
    const occ = occupancyFinding(shredded, DEFAULT_THRESHOLDS, { fragmentation: 0.125, largestPct: 0.0625 });
    expect(occ?.params?.frag).toBe(0.125);
    expect(occ?.params?.largestPct).toBe(0.0625);
  });

  // occupancyValue clamp: aliased TexturePacker frames / shared Spine regions double-count Σ, so the
  // naive sum can exceed the sheet area. Clamping kills the impossible ">100% packed" verdict; for
  // non-aliased atlases min(1,x)=x so behavior (and every occupancy golden) is unchanged.
  it('occupancyValue: overlapping frames (Σ frame area > sheet) clamp to exactly 1.0, never >1', () => {
    // Two identical 30×30 frames aliased onto the same 40×40 sheet: Σ = 1800 / 1600 = 1.125 → clamps to 1.
    const overlap = atlasOf('alias', 40, 40, [
      { x: 0, y: 0, w: 30, h: 30 },
      { x: 0, y: 0, w: 30, h: 30 },
    ]);
    const occ = occupancyValue(overlap);
    expect(occ).toBe(1); // exactly 1.0, never the impossible 1.125
    expect(occ).toBeLessThanOrEqual(1);
    // The finding's wasted is correspondingly 0, never negative.
    const f = occupancyFinding(overlap, DEFAULT_THRESHOLDS);
    expect(f).toBeNull(); // occ 1.0 ≥ warn → ok → no finding
  });

  it('occupancyValue: non-overlapping atlas unchanged (clamp inert, min(1,x)=x)', () => {
    const normal = atlasOf('normal', 40, 40, [{ x: 0, y: 0, w: 20, h: 20 }]); // 400 / 1600 = 0.25
    expect(occupancyValue(normal)).toBe(0.25);
    expect(occupancyValue(atlasOf('empty', 16, 16, []))).toBe(0); // no sprites → 0
    expect(occupancyValue(atlasOf('zero', 0, 0, [{ x: 0, y: 0, w: 4, h: 4 }]))).toBe(0); // total 0 guard
  });

  it('occupancyFinding: wasted never negative on an over-summed atlas', () => {
    const overlap = atlasOf('alias2', 40, 40, [
      { x: 0, y: 0, w: 30, h: 30 },
      { x: 0, y: 0, w: 30, h: 30 },
    ]);
    // Verdict ok at occ 1.0, so verify the guard directly: a partial-overlap atlas that still trips warn.
    const partial = atlasOf('partial', 40, 40, [
      { x: 0, y: 0, w: 20, h: 30 }, // 600
      { x: 10, y: 0, w: 20, h: 30 }, // 600, overlaps the first column band → Σ 1200/1600 = 0.75 (no clamp)
    ]);
    const f = occupancyFinding(partial, DEFAULT_THRESHOLDS);
    expect(f?.params?.wasted).toBeGreaterThanOrEqual(0);
    expect(f?.title).not.toContain('-'); // no "-X% wasted" leaks
    // And the clamp keeps wasted at 0 (not negative) for the fully-over-summed case if it ever fired.
    expect(occupancyValue(overlap)).toBe(1);
  });

  // B1 (default): an atlas where occupancy fires (occ < warn) but mergeEmptyRects returns [] — frag is
  // undefined yet the occupancy finding MUST still render a coherent, brace-free clause (frag defaults to
  // 1 = contiguous), never an empty interpolation. The 2×2 frame straddles every cell of the 2×2 grid.
  const degenerate = atlasOf('tiny', 16, 16, [{ x: 7, y: 7, w: 2, h: 2 }]); // touches all 4 cells, area 4/256
  it('B1: zero empty rects → wasted-regions null, occupancy still fires, metrics.fragmentation undefined', async () => {
    const cell = Math.max(8, Math.round(16 / 64)); // 8 → 2×2 grid
    expect(mergeEmptyRects(buildCoverage(degenerate, cell), degenerate.size)).toHaveLength(0);
    expect(wastedRegions(degenerate, DEFAULT_THRESHOLDS)).toBeNull();

    const occ = occupancyFinding(degenerate, DEFAULT_THRESHOLDS, {}); // no frag supplied → must default
    expect(occ).not.toBeNull();
    expect(occ?.severity).toBe('crit'); // occ 1.6% < crit 0.6 → fires
    expect(occ?.params?.frag).toBe(1); // B1: defaults to contiguous, never undefined
    expect(occ?.detail).not.toContain('{'); // no empty/missing interpolation leaked
    expect(occ?.detail).not.toContain('  '); // and no double-space artifact from a dropped value

    const rep = await analyze([asset(degenerate)]);
    expect(rep.assets[0]?.fragmentation).toBeUndefined(); // no empty rects ⇒ no measured dispersion
    expect(rep.findings.some((f) => f.rule === 'occupancy')).toBe(true);
    expect(rep.findings.some((f) => f.rule === 'wasted-regions')).toBe(false);
  });
});
