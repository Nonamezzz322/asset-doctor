import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Atlas, Rect } from '@asset-doctor/core';
import { parseAtlas, parseImage } from '@asset-doctor/parsers';
import { analyze, buildCoverage, mergeEmptyRects } from '../src/index';

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
      const got = report.findings.filter((f) => f.assetRef === im.name);
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

    const big = await analyze([r.asset], undefined, { encodeWebp: async () => Math.round(disk * 0.5) });
    expect(big.findings.some((f) => f.rule === 'format' && f.severity === 'warn')).toBe(true);
    expect(big.totals.potentialDiskSaved).toBeGreaterThan(0);

    const small = await analyze([r.asset], undefined, { encodeWebp: async () => Math.round(disk * 0.95) });
    expect(small.findings.some((f) => f.rule === 'format')).toBe(false);
  });
});
