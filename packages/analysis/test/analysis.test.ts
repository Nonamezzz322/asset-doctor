import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Asset, Atlas, Rect } from '@asset-doctor/core';
import { parseAtlas, parseImage } from '@asset-doctor/parsers';
import { analyze, buildCoverage, mergeEmptyRects, mergeSharedAtlases, groupVariants, stemOf } from '../src/index';

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
    expect(v.groups).toHaveLength(1); // hero variant set; 'other' is a singleton
    expect(v.groups[0]?.members).toHaveLength(4);
    expect(v.summedVram).toBe(2 * v540 + 2 * v1080 + v100);
    expect(v.loadedVramMax).toBe(v1080 + v100); // one tier (largest) per group
    expect(v.loadedVramMin).toBe(v540 + v100);
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
