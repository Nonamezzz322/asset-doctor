import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Asset, Atlas, ImageAsset, ImageMime, Rect } from '@asset-doctor/core';
import { parseAtlas, parseImage, parseFntText, parseFntPage, type FntPage } from '@asset-doctor/parsers';
import { groupFiles, type RawFile } from '@asset-doctor/ingest';
import { analyze, buildCoverage, mergeEmptyRects, summarizeEmpty, occupancyValue, occupancyFinding, wastedRegions, formatFinding, solidFillFinding, frameRedundancyFinding, trimMarginFinding, bleedingFinding, dimensionMismatchFinding, wastedAlphaFinding, strippableMetadataFinding, strippableMetadataAggregateFinding, crossAtlasRedundancyFinding, DEFAULT_THRESHOLDS, mergeSharedAtlases, groupVariants, stemOf, hasResolutionToken } from '../src/index';

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
  // Declared meta.size (1024²) ≠ the real PNG (512²); one frame sampled past the real edge → crit.
  { dir: 'dimension-mismatch', manifest: 'sheet.json', img: 'sheet.png' },
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

// ── Per-image MEASURED best-format pick (round17): formatFinding ALREADY measures both candidates
// (FORMAT_TARGETS) and now RECORDS the winning mime in params.bestMime — the machine-readable counterpart
// of the display `target` label. The diagnosis stays measurement-only (invariant 3); the Pro fix opts into
// carrying this forward. A DIFFERENTIATING encoder mock is required (the constant `async () => 4000` only
// ever proves AVIF wins) to exercise the WebP-wins branch + the deterministic tie-break.
describe('format audit — measured bestMime param (round17)', () => {
  const looseImg = (name: string, mime: ImageMime = 'image/png'): ImageAsset =>
    ({ name, imageRef: name, size: { w: 256, h: 256 }, mime, byteSize: 10000 });

  it('records bestMime = AVIF when AVIF encodes smallest (lossy verdict)', async () => {
    const f = (await formatFinding('a.png', looseImg('a.png'), DEFAULT_THRESHOLDS, async (_r, _s, t) => (t === 'image/avif' ? 6000 : 7000)))!;
    expect(f.messageKey).toBe('format');
    expect(f.params?.bestMime).toBe('image/avif');
    expect(f.params?.target).toBe('AVIF'); // the display label stays beside the machine-readable mime
  });

  it('records bestMime = WebP when WebP encodes smallest (the branch the constant mock can never hit)', async () => {
    const f = (await formatFinding('b.png', looseImg('b.png'), DEFAULT_THRESHOLDS, async (_r, _s, t) => (t === 'image/avif' ? 7000 : 6000)))!;
    expect(f.params?.bestMime).toBe('image/webp');
    expect(f.params?.target).toBe('WebP');
  });

  it('deterministic tie-break: equal encodes keep AVIF (first FORMAT_TARGETS candidate)', async () => {
    const f = (await formatFinding('c.png', looseImg('c.png'), DEFAULT_THRESHOLDS, async () => 6000))!;
    expect(f.params?.bestMime).toBe('image/avif'); // strict-smaller pick ⇒ tie keeps the first iterated
  });

  it('records bestMime on the flat/alpha-art lossless verdict too', async () => {
    for (const cls of ['flat', 'alpha-art'] as const) {
      const f = (await formatFinding('d.png', looseImg('d.png'), DEFAULT_THRESHOLDS, async (_r, _s, t) => (t === 'image/avif' ? 7000 : 6000), cls))!;
      expect(f.messageKey).toBe('format-lossless');
      expect(f.params?.bestMime).toBe('image/webp');
    }
  });

  it('bestMime is NEVER the source mime: a WebP source yields AVIF (candidate loop skips target===source)', async () => {
    const f = (await formatFinding('e.webp', looseImg('e.webp', 'image/webp'), DEFAULT_THRESHOLDS, async () => 6000))!;
    expect(f.params?.bestMime).toBe('image/avif'); // only AVIF is a candidate for a WebP source
  });
});

describe('solid-fill (single-color loose image)', () => {
  const looseImg = (name: string, w: number, h: number): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 10000 },
  });

  it('a 1024² solid ⇒ warn, vramBytesSaved = w·h·4 − 4, NO diskBytesSaved (Inv 3)', () => {
    const f = solidFillFinding('plate.png', { w: 1024, h: 1024 }, DEFAULT_THRESHOLDS)!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('solid-fill');
    expect(f.messageKey).toBe('solid-fill');
    expect(f.severity).toBe('warn'); // 1024 ≥ warnEdgePx (1024)
    expect(f.estimate?.vramBytesSaved).toBe(1024 * 1024 * 4 - 4);
    expect(f.estimate?.diskBytesSaved).toBeUndefined(); // measure VRAM only; the 1×1 is the fix engine's
    expect(f.params).toEqual({ w: 1024, h: 1024, vram: 1024 * 1024 * 4 });
  });

  it('below warnEdgePx but at/above minEdgePx ⇒ info', () => {
    const f = solidFillFinding('s.png', { w: 512, h: 512 }, DEFAULT_THRESHOLDS)!;
    expect(f.severity).toBe('info');
  });

  it('below minEdgePx ⇒ null (a tiny solid swatch is harmless)', () => {
    expect(solidFillFinding('tiny.png', { w: 128, h: 128 }, DEFAULT_THRESHOLDS)).toBeNull();
    // shorter edge gates: a tall-thin sliver under minEdgePx on either axis ⇒ null
    expect(solidFillFinding('sliver.png', { w: 2048, h: 64 }, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('no solidFill config ⇒ null (CLI / budget configs that don\'t opt in)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.solidFill;
    expect(solidFillFinding('p.png', { w: 1024, h: 1024 }, cfg)).toBeNull();
  });

  it('analyze threads solid:true to a LOOSE image via features ⇒ finding', async () => {
    const report = await analyze([looseImg('plate.png', 1024, 1024)], undefined, {
      encodeImage: async () => 9999,
      features: [{ assetRef: 'plate.png', contentHash: 'h', solid: true }],
    });
    const solid = report.findings.find((f) => f.rule === 'solid-fill');
    expect(solid?.assetRef).toBe('plate.png');
    expect(solid?.severity).toBe('warn');
  });

  it('analyze NEVER fires solid-fill for an ATLAS, even if a feature marks it solid (loose-only)', async () => {
    const atlasAsset: Asset = {
      kind: 'atlas',
      atlas: {
        name: 'sheet.png',
        imageRef: 'sheet.png',
        size: { w: 1024, h: 1024 },
        sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
        source: { kind: 'pixi' },
      },
      image: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, mime: 'image/png', byteSize: 10000 },
    };
    const report = await analyze([atlasAsset], undefined, {
      features: [{ assetRef: 'sheet.png', contentHash: 'h', solid: true }],
    });
    expect(report.findings.find((f) => f.rule === 'solid-fill')).toBeUndefined();
  });

  it('absent features ⇒ no solid-fill finding (CLI / headless byte-identical)', async () => {
    const report = await analyze([looseImg('plate.png', 1024, 1024)], undefined, { encodeImage: async () => 9999 });
    expect(report.findings.find((f) => f.rule === 'solid-fill')).toBeUndefined();
    // potentialDiskSaved is unaffected (solid-fill carries no diskBytesSaved)
    const withSolid = await analyze([looseImg('plate.png', 1024, 1024)], undefined, {
      encodeImage: async () => 9999,
      features: [{ assetRef: 'plate.png', contentHash: 'h', solid: true }],
    });
    expect(withSolid.totals.potentialDiskSaved).toBe(report.totals.potentialDiskSaved);
  });
});

describe('wasted-alpha (fully-opaque image carrying a dead alpha channel)', () => {
  const looseImg = (name: string, w: number, h: number, mime: 'image/png' | 'image/webp' | 'image/jpeg' | 'image/avif' = 'image/png', byteSize = 10000): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime, byteSize },
  });
  const px = looseImg('flat.png', 512, 512).image; // a 512² PNG over both gates

  it('opaque PNG with a real disk saving ⇒ warn, diskBytesSaved only, NO vramBytesSaved (Inv 5)', async () => {
    const f = (await wastedAlphaFinding('flat.png', px, DEFAULT_THRESHOLDS, async () => 7000))!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('wasted-alpha');
    expect(f.messageKey).toBe('wasted-alpha');
    expect(f.severity).toBe('warn');
    expect(f.estimate?.diskBytesSaved).toBe(10000 - 7000);
    expect(f.estimate?.vramBytesSaved).toBeUndefined(); // disk-only; the GPU still allocates RGBA8888
    expect(f.params).toEqual({ srcLabel: 'PNG', srcBytes: 10000, opaqueBytes: 7000, saved: 3000, frac: 0.3 });
  });

  it('saving below minDiskSaving ⇒ null (a near-zero channel isn\'t worth a verdict)', async () => {
    // 10000 → 9900 = 1% < 5% gate
    expect(await wastedAlphaFinding('flat.png', px, DEFAULT_THRESHOLDS, async () => 9900)).toBeNull();
  });

  it('below minEdgePx ⇒ null (a tiny icon\'s dead channel is negligible)', async () => {
    const tiny = looseImg('i.png', 32, 32).image; // shorter edge 32 < minEdgePx 64
    expect(await wastedAlphaFinding('i.png', tiny, DEFAULT_THRESHOLDS, async () => 100)).toBeNull();
  });

  it('JPEG / AVIF source ⇒ null (JPEG has no alpha; AVIF is the recommended target)', async () => {
    expect(await wastedAlphaFinding('p.jpg', looseImg('p.jpg', 512, 512, 'image/jpeg').image, DEFAULT_THRESHOLDS, async () => 1)).toBeNull();
    expect(await wastedAlphaFinding('p.avif', looseImg('p.avif', 512, 512, 'image/avif').image, DEFAULT_THRESHOLDS, async () => 1)).toBeNull();
  });

  it('no encodeOpaque sizer ⇒ null (CLI / headless never fires)', async () => {
    expect(await wastedAlphaFinding('flat.png', px, DEFAULT_THRESHOLDS, undefined)).toBeNull();
  });

  it('no wastedAlpha config ⇒ null (budget configs that don\'t opt in)', async () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.wastedAlpha;
    expect(await wastedAlphaFinding('flat.png', px, cfg, async () => 7000)).toBeNull();
  });

  it('sizer returns null ⇒ null (codec fallback — never miscount)', async () => {
    expect(await wastedAlphaFinding('flat.png', px, DEFAULT_THRESHOLDS, async () => null)).toBeNull();
  });

  it('analyze threads opaque:true to a LOOSE image via features ⇒ finding + bumps potentialDiskSaved', async () => {
    const report = await analyze([looseImg('flat.png', 512, 512)], undefined, {
      encodeOpaque: async () => 7000,
      features: [{ assetRef: 'flat.png', contentHash: 'h', opaque: true }],
    });
    const wa = report.findings.find((f) => f.rule === 'wasted-alpha');
    expect(wa?.assetRef).toBe('flat.png');
    expect(report.totals.potentialDiskSaved).toBe(3000);
  });

  it('a ref with BOTH a format AND a wasted-alpha finding contributes its disk saving ONCE (no double-count)', async () => {
    // 10000-byte PNG: format → AVIF estimate 6000 (saved 4000); opaque re-encode → 7000 (saved 3000).
    // The two overlap (transcode already drops the dead alpha plane). The aggregate must take the MAX
    // per-ref (4000), NOT the sum (7000).
    const report = await analyze([looseImg('flat.png', 512, 512)], undefined, {
      encodeImage: async () => 6000, // AVIF/WebP transcode estimate → saved 4000
      encodeOpaque: async () => 7000, // opaque same-format re-encode → saved 3000
      features: [{ assetRef: 'flat.png', contentHash: 'h', contentClass: 'photographic', opaque: true }],
    });
    expect(report.findings.find((f) => f.rule === 'format')?.estimate?.diskBytesSaved).toBe(4000);
    expect(report.findings.find((f) => f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(3000);
    // MAX(4000, 3000) = 4000 — NOT 7000. The per-finding estimates are still honest individually.
    expect(report.totals.potentialDiskSaved).toBe(4000);
  });

  it('wasted-alpha saving LARGER than format saving ⇒ aggregate = the larger (max), still counted once', async () => {
    // format → 6000 (saved 4000, 40% > 25% gate); opaque → 3500 (saved 6500). MAX = 6500, not 10500.
    const report = await analyze([looseImg('flat.png', 512, 512)], undefined, {
      encodeImage: async () => 6000,
      encodeOpaque: async () => 3500,
      features: [{ assetRef: 'flat.png', contentHash: 'h', contentClass: 'photographic', opaque: true }],
    });
    expect(report.findings.find((f) => f.rule === 'format')?.estimate?.diskBytesSaved).toBe(4000);
    expect(report.findings.find((f) => f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(6500);
    expect(report.totals.potentialDiskSaved).toBe(6500);
  });

  it('analyze NEVER fires wasted-alpha for an ATLAS, even if a feature marks it opaque (loose-only)', async () => {
    const atlasAsset: Asset = {
      kind: 'atlas',
      atlas: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }], source: { kind: 'pixi' } },
      image: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, mime: 'image/png', byteSize: 10000 },
    };
    const report = await analyze([atlasAsset], undefined, {
      encodeOpaque: async () => 1,
      features: [{ assetRef: 'sheet.png', contentHash: 'h', opaque: true }],
    });
    expect(report.findings.find((f) => f.rule === 'wasted-alpha')).toBeUndefined();
  });

  it('absent feature / absent dep ⇒ no finding (CLI / headless byte-identical)', async () => {
    const noFeat = await analyze([looseImg('flat.png', 512, 512)], undefined, { encodeOpaque: async () => 7000 });
    expect(noFeat.findings.find((f) => f.rule === 'wasted-alpha')).toBeUndefined();
    expect(noFeat.totals.potentialDiskSaved).toBe(0);
    const noDep = await analyze([looseImg('flat.png', 512, 512)], undefined, {
      features: [{ assetRef: 'flat.png', contentHash: 'h', opaque: true }],
    });
    expect(noDep.findings.find((f) => f.rule === 'wasted-alpha')).toBeUndefined();
  });
});

// ── Test B: strippable-metadata rule + folder rollup + the analyze de-overlap (three-way MAX). The rule is
// pure over ImageAsset.strippableBytes; analyze plumbs it for loose images AND atlas pages.
describe('strippable-metadata (ancillary ICC/EXIF/XMP + non-essential chunks)', () => {
  const metaImg = (name: string, strippableBytes: number, byteSize = 200000, mime: ImageMime = 'image/png'): ImageAsset => ({
    name, imageRef: name, size: { w: 512, h: 512 }, mime, byteSize, ...(strippableBytes > 0 ? { strippableBytes } : {}),
  });
  const looseMeta = (name: string, strippableBytes: number): Asset => ({ kind: 'image', image: metaImg(name, strippableBytes) });

  it('warn at/above warnBytes, diskBytesSaved EXACT, NO vramBytesSaved (Inv 5)', () => {
    const f = strippableMetadataFinding('a.png', metaImg('a.png', 80000), DEFAULT_THRESHOLDS)!;
    expect(f.rule).toBe('strippable-metadata');
    expect(f.messageKey).toBe('strippable-metadata');
    expect(f.severity).toBe('warn'); // 80000 >= warnBytes 65536
    expect(f.estimate?.diskBytesSaved).toBe(80000);
    expect(f.estimate?.vramBytesSaved).toBeUndefined(); // disk-only — the GPU still allocates RGBA8888
    expect(f.params).toEqual({ label: 'PNG', bytes: 80000 });
  });

  it('info below warnBytes but at/above minBytes', () => {
    const f = strippableMetadataFinding('a.png', metaImg('a.png', 5000), DEFAULT_THRESHOLDS)!;
    expect(f.severity).toBe('info'); // 4096 <= 5000 < 65536
    expect(f.estimate?.diskBytesSaved).toBe(5000);
  });

  it('below minBytes ⇒ null', () => {
    expect(strippableMetadataFinding('a.png', metaImg('a.png', 1000), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('absent strippableBytes ⇒ null', () => {
    expect(strippableMetadataFinding('a.png', metaImg('a.png', 0), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('no strippableMetadata config ⇒ null (budget configs that don\'t opt in)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.strippableMetadata;
    expect(strippableMetadataFinding('a.png', metaImg('a.png', 80000), cfg)).toBeNull();
  });

  it('analyze fires the finding for a LOOSE image and bumps potentialDiskSaved', async () => {
    const report = await analyze([looseMeta('a.png', 50000)]);
    const sm = report.findings.find((f) => f.rule === 'strippable-metadata' && f.scope !== 'folder');
    expect(sm?.assetRef).toBe('a.png');
    expect(report.totals.potentialDiskSaved).toBe(50000);
  });

  it('analyze fires the finding for an ATLAS PAGE image (strippableBytes on the page)', async () => {
    const atlasAsset: Asset = {
      kind: 'atlas',
      atlas: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }], source: { kind: 'pixi' } },
      image: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, mime: 'image/png', byteSize: 200000, strippableBytes: 50000 },
    };
    const report = await analyze([atlasAsset]);
    expect(report.findings.find((f) => f.rule === 'strippable-metadata' && f.assetRef === 'sheet.png')).toBeTruthy();
    expect(report.totals.potentialDiskSaved).toBe(50000);
  });

  it('THREE-WAY MAX: fmt=4000 + alpha=6000 + strip=5000 ⇒ potentialDiskSaved === 6000 (honest MAX, not 7000)', async () => {
    // 10000-byte PNG. format → 6000 estimate (saved 4000); opaque → 4000 (saved 6000); strip → 5000.
    // The three overlap on one re-encode; the aggregate must be MAX(4000,6000,5000) === 6000, NOT 7000.
    const asset: Asset = { kind: 'image', image: { name: 'x.png', imageRef: 'x.png', size: { w: 512, h: 512 }, mime: 'image/png', byteSize: 10000, strippableBytes: 5000 } };
    const report = await analyze([asset], undefined, {
      encodeImage: async () => 6000,  // format saved = 10000 - 6000 = 4000
      encodeOpaque: async () => 4000, // wasted-alpha saved = 10000 - 4000 = 6000
      features: [{ assetRef: 'x.png', contentHash: 'h', contentClass: 'photographic', opaque: true }],
    });
    expect(report.findings.find((f) => f.rule === 'format')?.estimate?.diskBytesSaved).toBe(4000);
    expect(report.findings.find((f) => f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(6000);
    expect(report.findings.find((f) => f.rule === 'strippable-metadata' && f.scope !== 'folder')?.estimate?.diskBytesSaved).toBe(5000);
    expect(report.totals.potentialDiskSaved).toBe(6000); // MAX, never 4000 + 2000 + 1000 = 7000
  });

  it('folder rollup: ≥2 per-asset findings ⇒ summed aggregate (display-only, NOT folded into totals)', () => {
    const f1 = strippableMetadataFinding('a.png', metaImg('a.png', 10000), DEFAULT_THRESHOLDS)!;
    const f2 = strippableMetadataFinding('b.png', metaImg('b.png', 20000), DEFAULT_THRESHOLDS)!;
    const agg = strippableMetadataAggregateFinding([f1, f2])!;
    expect(agg.scope).toBe('folder');
    expect(agg.rule).toBe('strippable-metadata');
    expect(agg.messageKey).toBe('strippable-metadata-aggregate');
    expect(agg.estimate?.diskBytesSaved).toBe(30000);
    expect(agg.relatedRefs).toEqual(['a.png', 'b.png']);
    expect(strippableMetadataAggregateFinding([f1])).toBeNull(); // <2 ⇒ null
  });

  it('analyze emits the folder aggregate but does NOT double-count it into potentialDiskSaved', async () => {
    const report = await analyze([looseMeta('a.png', 10000), looseMeta('b.png', 20000)]);
    const agg = report.findings.find((f) => f.scope === 'folder' && f.messageKey === 'strippable-metadata-aggregate');
    expect(agg?.estimate?.diskBytesSaved).toBe(30000);
    // Aggregate is display-only: the per-asset findings already bumped potentialDiskSaved to 10000 + 20000.
    expect(report.totals.potentialDiskSaved).toBe(30000);
  });

  it('golden fixture: parse(metadata.png) -> analyze fires info strippable-metadata, diskBytesSaved=8347', async () => {
    const r = parseImage('metadata.png', readBytes('strippable-metadata/metadata.png'));
    if (!r.ok) throw new Error('fixture parse failed');
    const report = await analyze([r.asset]);
    const sm = report.findings.find((f) => f.rule === 'strippable-metadata' && f.scope !== 'folder')!;
    expect(sm.severity).toBe('info'); // 8347 in [minBytes 4096, warnBytes 65536)
    expect(sm.estimate?.diskBytesSaved).toBe(8347);
    expect(sm.estimate?.vramBytesSaved).toBeUndefined(); // invariant 5 — never a VRAM win
    expect(report.totals.potentialDiskSaved).toBe(8347);
  });
});

describe('frame-redundancy (within-atlas duplicate frames)', () => {
  // A pure atlas with N frames at DISTINCT packed rects (so the distinct-rect guard never collapses them
  // unless they truly alias). The test injects the region hashes directly — no canvas, fully deterministic.
  const animAtlas = (name: string, frames: { x: number; y: number; w: number; h: number }[]): Atlas => ({
    name,
    imageRef: name,
    size: { w: 256, h: 256 },
    sprites: frames.map((f, i) => ({ name: `f${i}`, frame: f, rotated: false, trimmed: false, sourceSize: { w: f.w, h: f.h } })),
    source: { kind: 'pixi' },
  });
  const animAsset = (atlas: Atlas, byteSize = 8000): Asset => ({
    kind: 'atlas',
    atlas,
    image: { name: atlas.name, imageRef: atlas.imageRef, size: atlas.size, mime: 'image/png', byteSize },
  });
  // 4 frames in a row (distinct rects), 3 sharing one region hash → 2 recoverable beyond the kept one.
  const fourFrames = [
    { x: 0, y: 0, w: 32, h: 32 },
    { x: 32, y: 0, w: 32, h: 32 },
    { x: 64, y: 0, w: 32, h: 32 },
    { x: 96, y: 0, w: 32, h: 32 },
  ];

  it('a cluster ≥ minDuplicates ⇒ warn, exact VRAM, refs, one overlay zone per cluster', () => {
    const atlas = animAtlas('anim.png', fourFrames);
    const f = frameRedundancyFinding(atlas, DEFAULT_THRESHOLDS, ['aa', 'aa', 'aa', 'bb'], 8000)!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('frame-redundancy');
    expect(f.severity).toBe('warn');
    expect(f.messageKey).toBe('frame-redundancy');
    // 3 distinct dupe rects → 2 recoverable; each 32×32 = 1024px → 2048px → ×4 = 8192 bytes VRAM.
    expect(f.params?.dupes).toBe(2);
    expect(f.params?.groups).toBe(1);
    expect(f.estimate?.vramBytesSaved).toBe(2 * 32 * 32 * 4);
    expect(f.params?.area).toBe(2 * 32 * 32);
    expect(f.relatedRefs).toEqual(['f0', 'f1', 'f2']); // sorted dupe refs
    expect(f.overlay).toHaveLength(1); // one zone per cluster
    expect(f.overlay?.[0]?.kind).toBe('duplicate-frame');
    expect(f.overlay?.[0]?.rects).toHaveLength(2); // the redundant rects (representative excluded)
    // disk is an area-proportional estimate: 8000 × (2048 / 4096) = 4000.
    expect(f.estimate?.diskBytesSaved).toBe(4000);
    expect(f.params?.disk).toBe(4000);
  });

  it('two separate clusters ⇒ two overlay zones, summed recoverable area', () => {
    const six = [
      { x: 0, y: 0, w: 32, h: 32 }, { x: 32, y: 0, w: 32, h: 32 }, { x: 64, y: 0, w: 32, h: 32 },
      { x: 0, y: 32, w: 16, h: 16 }, { x: 32, y: 32, w: 16, h: 16 }, { x: 64, y: 32, w: 16, h: 16 },
    ];
    const f = frameRedundancyFinding(animAtlas('two.png', six), DEFAULT_THRESHOLDS, ['aa', 'aa', 'aa', 'bb', 'bb', 'bb'], 9000)!;
    expect(f.params?.groups).toBe(2);
    expect(f.params?.dupes).toBe(4); // 2 from each cluster
    expect(f.overlay).toHaveLength(2);
    // recoverable area = 2×(32²) + 2×(16²) = 2048 + 512 = 2560 px.
    expect(f.params?.area).toBe(2 * 32 * 32 + 2 * 16 * 16);
    expect(f.estimate?.vramBytesSaved).toBe((2 * 1024 + 2 * 256) * 4);
  });

  it('below minDuplicates ⇒ null (a stray dupe pair is not a verdict)', () => {
    // 2 frames sharing a hash < minDuplicates (3).
    const f = frameRedundancyFinding(animAtlas('p.png', fourFrames), DEFAULT_THRESHOLDS, ['aa', 'aa', 'bb', 'cc'], 8000);
    expect(f).toBeNull();
  });

  it('null hashes never cluster (host-skipped flat regions)', () => {
    // Four nulls would falsely cluster if treated as a value — must be skipped entirely.
    const f = frameRedundancyFinding(animAtlas('n.png', fourFrames), DEFAULT_THRESHOLDS, [null, null, null, null], 8000);
    expect(f).toBeNull();
  });

  it('pre-aliased frames (same rect, same hash) ⇒ collapse to one distinct rect ⇒ null', () => {
    // 3 manifest names ALL pointing at the identical packed rect: one GPU region, not three dupes.
    const aliased = animAtlas('alias.png', [
      { x: 0, y: 0, w: 32, h: 32 },
      { x: 0, y: 0, w: 32, h: 32 },
      { x: 0, y: 0, w: 32, h: 32 },
      { x: 32, y: 0, w: 32, h: 32 },
    ]);
    const f = frameRedundancyFinding(aliased, DEFAULT_THRESHOLDS, ['aa', 'aa', 'aa', 'bb'], 8000);
    expect(f).toBeNull(); // distinctRects = 1 < minDuplicates → no finding
  });

  it('no frameRedundancy config ⇒ null (CLI / budget configs that don\'t opt in)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.frameRedundancy;
    expect(frameRedundancyFinding(animAtlas('p.png', fourFrames), cfg, ['aa', 'aa', 'aa', 'bb'], 8000)).toBeNull();
  });

  it('length mismatch ⇒ null (stale/desynced dep, never mis-key a region)', () => {
    expect(frameRedundancyFinding(animAtlas('p.png', fourFrames), DEFAULT_THRESHOLDS, ['aa', 'aa'], 8000)).toBeNull();
  });

  it('analyze threads frameHashes to an ATLAS and does NOT fold the disk estimate into potentialDiskSaved', async () => {
    const atlas = animAtlas('anim.png', fourFrames);
    const baseline = await analyze([animAsset(atlas)]); // no frameHashes ⇒ rule dormant
    expect(baseline.findings.some((f) => f.rule === 'frame-redundancy')).toBe(false);

    const report = await analyze([animAsset(atlas)], undefined, {
      frameHashes: [{ atlasRef: 'anim.png', frameHashes: ['aa', 'aa', 'aa', 'bb'] }],
    });
    const fr = report.findings.find((f) => f.rule === 'frame-redundancy');
    expect(fr?.assetRef).toBe('anim.png');
    expect(fr?.estimate?.vramBytesSaved).toBe(2 * 32 * 32 * 4);
    // The disk number is an area-proportional ESTIMATE — NEVER folded into the aggregate (invariant 5).
    expect(report.totals.potentialDiskSaved).toBe(baseline.totals.potentialDiskSaved);
  });

  it('absent frameHashes ⇒ byte-identical to today (CLI / headless unaffected)', async () => {
    const atlas = animAsset(animAtlas('anim.png', fourFrames));
    const a = await analyze([atlas]);
    const b = await analyze([atlas], undefined, {});
    expect(a.findings.some((f) => f.rule === 'frame-redundancy')).toBe(false);
    expect(b.findings.some((f) => f.rule === 'frame-redundancy')).toBe(false);
  });

  it('golden: frame-redundant fixture fires warn with the documented cluster', async () => {
    // This package is headless/pure — it can't decode the fixture PNG (no canvas/pngjs dep). It verifies the
    // RULE wiring given the documented cluster (idle_* share one region, walk_* distinct). The REAL decode
    // path — fixture PNG → pure extractFrameRegions → SHA → this same finding — is asserted end-to-end in
    // apps/web/src/lib/perceptual.test.ts (where the page is actually decoded), which is what proves the
    // textured fixture reproduces the defect through production code, not just through injected hashes.
    interface FrExpected { atlas: { w: number; h: number }; recoverableArea: number; vramBytesSaved: number; findings: { rule: string; severity: string }[] }
    const expected = readJson('frame-redundant/expected.json') as FrExpected;
    const parsed = parseAtlas(readJson('frame-redundant/anim.json'), {
      ref: 'anim.png',
      bytes: readBytes('frame-redundant/anim.png'),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.asset.kind !== 'atlas') return;

    // Index-aligned hashes BY SPRITE NAME so the golden is robust to parser ordering: idle_* share one hash,
    // walk_* each get their own — mirroring the documented cluster in expected.json.
    const hashByName = (n: string): string => (n.startsWith('idle_') ? 'idle' : n);
    const frameHashes = parsed.asset.atlas.sprites.map((s) => hashByName(s.name));
    expect(frameHashes.filter((h) => h === 'idle')).toHaveLength(4); // sanity: the cluster is present

    const report = await analyze([parsed.asset], undefined, {
      frameHashes: [{ atlasRef: 'anim.png', frameHashes }],
    });
    const fr = report.findings.find((f) => f.rule === 'frame-redundancy');
    expect(fr?.severity).toBe('warn');
    expect(fr?.estimate?.vramBytesSaved).toBe(expected.vramBytesSaved);
    expect(fr?.params?.area).toBe(expected.recoverableArea);
    expect(sig(report.findings.filter((f) => f.rule === 'frame-redundancy'))).toEqual(sig(expected.findings));
  });

  it('a LOOSE asset never fires frame-redundancy even if a hash entry names it', async () => {
    const loose: Asset = { kind: 'image', image: { name: 'x.png', imageRef: 'x.png', size: { w: 64, h: 64 }, mime: 'image/png', byteSize: 1000 } };
    const report = await analyze([loose], undefined, {
      frameHashes: [{ atlasRef: 'x.png', frameHashes: ['aa', 'aa', 'aa'] }],
    });
    expect(report.findings.some((f) => f.rule === 'frame-redundancy')).toBe(false);
  });
});

describe('bleeding (frame pairs touching with 0px gutter)', () => {
  // A pure atlas with frames at the given placed rects. No decode — the rule reads frame rects only.
  const blAtlas = (
    name: string,
    frames: { x: number; y: number; w: number; h: number; rotated?: boolean; sameName?: string }[],
  ): Atlas => ({
    name,
    imageRef: name,
    size: { w: 256, h: 256 },
    sprites: frames.map((f, i) => ({
      name: f.sameName ?? `b${i}`,
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: f.rotated ?? false,
      trimmed: false,
      sourceSize: { w: f.w, h: f.h },
    })),
    source: { kind: 'pixi' },
  });
  // Opt-in config with a low gate so a single pair fires (DEFAULT minPairs is 4).
  const cfg1 = { ...DEFAULT_THRESHOLDS, bleeding: { minPairs: 1, warnPairs: 16 } };

  const blAsset = (atlas: Atlas, byteSize = 8000): Asset => ({
    kind: 'atlas',
    atlas,
    image: { name: atlas.name, imageRef: atlas.imageRef, size: atlas.size, mime: 'image/png', byteSize },
  });

  it('two frames touching with 0 gutter + vertical overlap ⇒ pair counted, 1px strip, NO estimate', () => {
    // A={0,0,32,32}, B={32,0,32,32}: B's right edge (64) ≠ A.x, but A's right edge (32) === B.x — so from
    // B's perspective A touches B's left. The rule finds the pair either way (symmetric record).
    const f = bleedingFinding(blAtlas('tight.png', [{ x: 0, y: 0, w: 32, h: 32 }, { x: 32, y: 0, w: 32, h: 32 }]), cfg1)!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('bleeding');
    expect(f.severity).toBe('info'); // 1 pair < warnPairs(16)
    expect(f.messageKey).toBe('bleeding');
    expect(f.params?.pairs).toBe(1);
    // One overlay zone, kind 'bleeding', with a thin 1px-wide vertical seam strip at the shared edge x=32.
    expect(f.overlay).toHaveLength(1);
    expect(f.overlay?.[0]?.kind).toBe('bleeding');
    expect(f.overlay?.[0]?.rects).toHaveLength(1);
    const strip = f.overlay![0]!.rects[0]!;
    expect(strip.w).toBe(1); // a SEAM line, not a region fill
    expect(strip).toEqual({ x: 32, y: 0, w: 1, h: 32 });
    // INVARIANT 5: a correctness finding carries NO estimate at all — edge-extrude can GROW the sheet.
    expect(f.estimate).toBeUndefined();
    expect(f.relatedRefs).toEqual(['b0', 'b1']);
  });

  it('a horizontal touch yields a 1px-tall strip', () => {
    // A={0,0,32,32}, B={0,32,32,32}: A's bottom edge (32) === B.y → B touches A's top. 1px-tall strip.
    const f = bleedingFinding(blAtlas('h.png', [{ x: 0, y: 0, w: 32, h: 32 }, { x: 0, y: 32, w: 32, h: 32 }]), cfg1)!;
    expect(f.params?.pairs).toBe(1);
    const strip = f.overlay![0]!.rects[0]!;
    expect(strip.h).toBe(1);
    expect(strip).toEqual({ x: 0, y: 32, w: 32, h: 1 });
  });

  it('padded frames (1px gap) ⇒ null (the silence calibration case)', () => {
    // A={0,0,32,32}, B={33,0,32,32}: A's right edge 32 ≠ B.x 33 — a 1px gutter, no bleed.
    expect(bleedingFinding(blAtlas('pad.png', [{ x: 0, y: 0, w: 32, h: 32 }, { x: 33, y: 0, w: 32, h: 32 }]), cfg1)).toBeNull();
  });

  it('corner-only touch ⇒ null (0 perpendicular overlap, strict <)', () => {
    // A={0,0,32,32}, B={32,32,32,32}: they meet at the single point (32,32) — edge coords match but the
    // perpendicular overlap is exactly 0 (top===bottom), so NOT a bleeding pair.
    expect(bleedingFinding(blAtlas('corner.png', [{ x: 0, y: 0, w: 32, h: 32 }, { x: 32, y: 32, w: 32, h: 32 }]), cfg1)).toBeNull();
  });

  it('below minPairs ⇒ null', () => {
    // One touching pair, but DEFAULT minPairs is 4 ⇒ suppressed.
    expect(bleedingFinding(blAtlas('one.png', [{ x: 0, y: 0, w: 32, h: 32 }, { x: 32, y: 0, w: 32, h: 32 }]), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('at/above warnPairs ⇒ warn, else info', () => {
    // A 4×4 grid of 32×32 cells, 0 gutter → 24 touching pairs (12 horizontal + 12 vertical). With a config
    // whose warnPairs=24 ⇒ warn; with warnPairs=25 ⇒ info (24 < 25). Proves the boundary is inclusive.
    const grid: { x: number; y: number; w: number; h: number }[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) grid.push({ x: c * 32, y: r * 32, w: 32, h: 32 });
    const warnAt24 = bleedingFinding(blAtlas('grid.png', grid), { ...DEFAULT_THRESHOLDS, bleeding: { minPairs: 1, warnPairs: 24 } })!;
    expect(warnAt24.params?.pairs).toBe(24);
    expect(warnAt24.severity).toBe('warn'); // pairs >= warnPairs ⇒ warn (inclusive)
    const infoAt25 = bleedingFinding(blAtlas('grid.png', grid), { ...DEFAULT_THRESHOLDS, bleeding: { minPairs: 1, warnPairs: 25 } })!;
    expect(infoAt25.severity).toBe('info'); // 24 < 25 ⇒ info
  });

  it('rotated frames excluded (extrude fix is rect-only, seam direction ambiguous)', () => {
    // A touching pair where one frame is rotated ⇒ the rotated frame is filtered out ⇒ no pair ⇒ null.
    expect(bleedingFinding(blAtlas('rot.png', [{ x: 0, y: 0, w: 32, h: 32 }, { x: 32, y: 0, w: 32, h: 32, rotated: true }]), cfg1)).toBeNull();
  });

  it('aliased frames (identical rect, 2 names) ⇒ not a bleeding pair (cannot bleed against itself)', () => {
    // Two manifest names on the IDENTICAL packed rect collapse to one distinct rect — one GPU region, no pair.
    expect(bleedingFinding(blAtlas('alias.png', [
      { x: 0, y: 0, w: 32, h: 32, sameName: 'shared' },
      { x: 0, y: 0, w: 32, h: 32, sameName: 'shared' },
    ]), cfg1)).toBeNull();
  });

  it('aliases on a touching distinct rect still join the proof (relatedRefs)', () => {
    // A and B touch; A is referenced by two names (same rect) — both alias names appear in refs, B too.
    const f = bleedingFinding(blAtlas('attr.png', [
      { x: 0, y: 0, w: 32, h: 32, sameName: 'left' },
      { x: 0, y: 0, w: 32, h: 32, sameName: 'left_alias' },
      { x: 32, y: 0, w: 32, h: 32, sameName: 'right' },
    ]), cfg1)!;
    expect(f.params?.pairs).toBe(1);
    expect(f.relatedRefs).toEqual(['left', 'left_alias', 'right']);
  });

  it('no bleeding config ⇒ null (CLI/budget configs that don\'t opt in)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.bleeding;
    expect(bleedingFinding(blAtlas('t.png', [{ x: 0, y: 0, w: 32, h: 32 }, { x: 32, y: 0, w: 32, h: 32 }]), cfg)).toBeNull();
  });

  it('a single-frame / empty atlas ⇒ null (no pairs possible)', () => {
    expect(bleedingFinding(blAtlas('solo.png', [{ x: 0, y: 0, w: 32, h: 32 }]), cfg1)).toBeNull();
    expect(bleedingFinding(blAtlas('void.png', []), cfg1)).toBeNull();
  });

  it('analyze() emits bleeding for a zero-gutter atlas and NOTHING flows into totals.potentialDiskSaved', async () => {
    // A 4×4 0-gutter grid trips the DEFAULT gate (24 pairs ≥ minPairs 4). The finding is unconditional —
    // it fires in-browser by default (no host dep). Its estimate is absent, so potentialDiskSaved is untouched.
    const grid: { x: number; y: number; w: number; h: number }[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) grid.push({ x: c * 32, y: r * 32, w: 32, h: 32 });
    const report = await analyze([blAsset(blAtlas('grid.png', grid))]);
    const bl = report.findings.find((f) => f.rule === 'bleeding');
    expect(bl).toBeDefined();
    expect(bl?.severity).toBe('warn'); // 24 ≥ DEFAULT warnPairs(16)
    expect(bl?.estimate).toBeUndefined();
    // Invariant 5 aggregate honesty: the bleeding finding contributes nothing to the disk savings headline.
    expect(report.totals.potentialDiskSaved).toBe(0);
  });

  it('analyze() stays silent for a padded atlas (no 0-gutter pair) — DEFAULT byte-identical', async () => {
    // 2 frames with a 1px gutter ⇒ no pair ⇒ no bleeding finding, even with the DEFAULT gate live.
    const report = await analyze([blAsset(blAtlas('pad2.png', [{ x: 0, y: 0, w: 32, h: 32 }, { x: 33, y: 0, w: 32, h: 32 }]))]);
    expect(report.findings.some((f) => f.rule === 'bleeding')).toBe(false);
  });
});

describe('dimension-mismatch (declared meta.size ≠ real decoded image pixels)', () => {
  // A pure atlas with a DECLARED size and placed frames. The real image size is supplied separately on the
  // ImageAsset (the rule compares atlas.size against image.size — no decode).
  const dmAtlas = (
    name: string,
    declared: { w: number; h: number },
    frames: { x: number; y: number; w: number; h: number }[],
  ): Atlas => ({
    name,
    imageRef: name,
    size: declared,
    sprites: frames.map((f, i) => ({ name: `d${i}`, frame: { x: f.x, y: f.y, w: f.w, h: f.h }, rotated: false, trimmed: false, sourceSize: { w: f.w, h: f.h } })),
    source: { kind: 'pixi' },
  });
  const realImg = (name: string, real: { w: number; h: number }): ImageAsset => ({
    name, imageRef: name, size: real, mime: 'image/png', byteSize: 8000,
  });
  const dmAsset = (atlas: Atlas, real: { w: number; h: number }, byteSize = 8000): Asset => ({
    kind: 'atlas', atlas, image: { name: atlas.name, imageRef: atlas.imageRef, size: real, mime: 'image/png', byteSize },
  });

  it('real < declared with a frame past the REAL edge ⇒ crit, off-edge messageKey, NO estimate, NO overlay', () => {
    // Declared 1024², real 512². A frame at x600+w100=700 is within declared 1024 (survives parsing) but
    // past the real 512 → it samples off the smaller texture ⇒ crit.
    const a = dmAtlas('off.png', { w: 1024, h: 1024 }, [{ x: 0, y: 0, w: 100, h: 100 }, { x: 600, y: 0, w: 100, h: 100 }]);
    const f = dimensionMismatchFinding(a, realImg('off.png', { w: 512, h: 512 }), DEFAULT_THRESHOLDS)!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('dimension-mismatch');
    expect(f.severity).toBe('crit');
    expect(f.messageKey).toBe('dimension-mismatch-shrunk-offedge');
    // Two MEASUREMENTS, never a delta-saving (invariant 5).
    expect(f.estimate).toBeUndefined();
    expect(f.overlay).toBeUndefined();
    expect(f.params).toEqual({ dw: 1024, dh: 1024, rw: 512, rh: 512, off: 1, dir: 'shrunk' });
  });

  it('real < declared but ALL frames in real bounds ⇒ warn (milder), shrunk messageKey, off:0', () => {
    const a = dmAtlas('in.png', { w: 1024, h: 1024 }, [{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 100 }]);
    const f = dimensionMismatchFinding(a, realImg('in.png', { w: 512, h: 512 }), DEFAULT_THRESHOLDS)!;
    expect(f.severity).toBe('warn');
    expect(f.messageKey).toBe('dimension-mismatch-shrunk');
    expect(f.params).toEqual({ dw: 1024, dh: 1024, rw: 512, rh: 512, off: 0, dir: 'shrunk' });
    expect(f.estimate).toBeUndefined();
  });

  it('real > declared (extra border) ⇒ info, grown messageKey, off:0', () => {
    const a = dmAtlas('grown.png', { w: 512, h: 512 }, [{ x: 0, y: 0, w: 100, h: 100 }]);
    const f = dimensionMismatchFinding(a, realImg('grown.png', { w: 1024, h: 1024 }), DEFAULT_THRESHOLDS)!;
    expect(f.severity).toBe('info');
    expect(f.messageKey).toBe('dimension-mismatch-grown');
    expect(f.params).toEqual({ dw: 512, dh: 512, rw: 1024, rh: 1024, off: 0, dir: 'grown' });
    expect(f.estimate).toBeUndefined();
  });

  it('within tolerance on BOTH axes ⇒ null (benign rounding stays silent)', () => {
    // declared 1026×1024, real 1024² → dw=2, dh=0, both ≤ tolerancePx(2) ⇒ null.
    const a = dmAtlas('tol.png', { w: 1026, h: 1024 }, [{ x: 0, y: 0, w: 100, h: 100 }]);
    expect(dimensionMismatchFinding(a, realImg('tol.png', { w: 1024, h: 1024 }), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('declared == real ⇒ null', () => {
    const a = dmAtlas('eq.png', { w: 512, h: 512 }, [{ x: 0, y: 0, w: 100, h: 100 }]);
    expect(dimensionMismatchFinding(a, realImg('eq.png', { w: 512, h: 512 }), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('just past tolerance on ONE axis ⇒ fires (dw=3 > 2)', () => {
    const a = dmAtlas('edge.png', { w: 1027, h: 1024 }, [{ x: 0, y: 0, w: 100, h: 100 }]);
    const f = dimensionMismatchFinding(a, realImg('edge.png', { w: 1024, h: 1024 }), DEFAULT_THRESHOLDS)!;
    expect(f).not.toBeNull();
    expect(f.severity).toBe('warn'); // real smaller, frame in bounds
  });

  it('no dimensionMismatch config ⇒ null (a budget config that omits the key suppresses it)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.dimensionMismatch;
    const a = dmAtlas('nocfg.png', { w: 1024, h: 1024 }, [{ x: 600, y: 0, w: 100, h: 100 }]);
    expect(dimensionMismatchFinding(a, realImg('nocfg.png', { w: 512, h: 512 }), cfg)).toBeNull();
  });

  it('off-edge proof is deterministic (frame names sorted) and counts only genuine overruns', () => {
    // Two frames past the real 512 edge (x600 and y700), one in-bounds. off counts the two overruns.
    const a = dmAtlas('multi.png', { w: 1024, h: 1024 }, [
      { x: 0, y: 0, w: 100, h: 100 },       // d0 in bounds
      { x: 600, y: 0, w: 100, h: 100 },     // d1 past x
      { x: 0, y: 700, w: 100, h: 100 },     // d2 past y
    ]);
    const f = dimensionMismatchFinding(a, realImg('multi.png', { w: 512, h: 512 }), DEFAULT_THRESHOLDS)!;
    expect(f.severity).toBe('crit');
    expect(f.params?.off).toBe(2);
  });

  it('analyze() emits dimension-mismatch by default (DEFAULT_THRESHOLDS) and NOTHING flows into totals', async () => {
    const a = dmAtlas('flow.png', { w: 1024, h: 1024 }, [{ x: 600, y: 0, w: 100, h: 100 }]);
    const report = await analyze([dmAsset(a, { w: 512, h: 512 })]);
    const dm = report.findings.find((f) => f.rule === 'dimension-mismatch');
    expect(dm).toBeDefined();
    expect(dm?.severity).toBe('crit');
    expect(dm?.estimate).toBeUndefined();
    // Invariant 5: a correctness finding never contributes to the disk savings headline.
    expect(report.totals.potentialDiskSaved).toBe(0);
  });

  it('analyze() stays silent when declared == real (DEFAULT byte-identical)', async () => {
    const a = dmAtlas('match.png', { w: 512, h: 512 }, [{ x: 0, y: 0, w: 100, h: 100 }]);
    const report = await analyze([dmAsset(a, { w: 512, h: 512 })]);
    expect(report.findings.some((f) => f.rule === 'dimension-mismatch')).toBe(false);
  });
});

describe('cross-atlas-redundancy (frames byte-identical ACROSS ≥2 atlases)', () => {
  // A pure atlas with one row of distinct-rect frames. Region hashes are injected directly (no canvas).
  const sheetAtlas = (name: string, frames: { x: number; y: number; w: number; h: number }[]): Atlas => ({
    name,
    imageRef: name,
    size: { w: 256, h: 256 },
    sprites: frames.map((f, i) => ({ name: `${name}_${i}`, frame: f, rotated: false, trimmed: false, sourceSize: { w: f.w, h: f.h } })),
    source: { kind: 'pixi' },
  });
  const sheetAsset = (atlas: Atlas, byteSize = 8000): Asset => ({
    kind: 'atlas',
    atlas,
    image: { name: atlas.name, imageRef: atlas.imageRef, size: atlas.size, mime: 'image/png', byteSize },
  });
  const cell = { w: 32, h: 32 };
  const row = (n: number): { x: number; y: number; w: number; h: number }[] =>
    Array.from({ length: n }, (_, i) => ({ x: i * 32, y: 0, w: 32, h: 32 }));

  it('two atlases share ONE frame on a distinct rect each ⇒ warn, dupes:1, groups:1, sheets:2, exact VRAM, DISTINCT messageKey', () => {
    const A = sheetAtlas('A.png', row(2)); // A_0 shares the hash; A_1 distinct
    const B = sheetAtlas('B.png', row(2)); // B_0 shares the hash; B_1 distinct
    const hashes = new Map([
      ['A.png', ['shared', 'aOnly']],
      ['B.png', ['shared', 'bOnly']],
    ]);
    const bytes = new Map([['A.png', 8000], ['B.png', 8000]]);
    const f = crossAtlasRedundancyFinding([A, B], hashes, bytes, DEFAULT_THRESHOLDS)!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('cross-atlas-redundancy');
    expect(f.severity).toBe('warn');
    expect(f.scope).toBe('folder');
    // BLOCKER 1: the messageKey MUST be the DISTINCT cross-atlas key, NOT 'frame-redundancy' (a wrong key
    // silently renders the within-atlas template against the wrong placeholders).
    expect(f.messageKey).toBe('cross-atlas-redundancy');
    expect(f.params?.dupes).toBe(1); // 2 distinct cross-sheet copies → 1 recoverable beyond the kept one
    expect(f.params?.groups).toBe(1);
    expect(f.params?.sheets).toBe(2);
    // B2: VRAM = recoverableArea × 4 EXACTLY (one freed 32×32 copy) — no bin-tier / POT inflation.
    expect(f.params?.area).toBe(cell.w * cell.h);
    expect(f.estimate?.vramBytesSaved).toBe(cell.w * cell.h * 4);
    expect(f.assetRef).toBe('A.png'); // lowest-sorted atlas
    expect(f.relatedRefs).toEqual(['A.png_0', 'B.png_0']); // sorted member names (only the shared cluster)
    expect(f.params?.atlases).toBe('A.png, B.png');
  });

  it('mixed-case anchor — output sets follow localeCompare (matches cluster/rep collation), not code-unit', () => {
    // Round 24: code-unit and locale collation DISAGREE here — 'B' (0x42) < 'a' (0x61) by code unit, but
    // localeCompare orders 'a.png' before 'B.png'. The output sets (assetRef, params.atlases, relatedRefs) now
    // share the SAME localeCompare collation as the cluster ordering (345) and representative selection (375),
    // so the anchor is 'a.png' (not 'B.png'). This locks the comparator unification.
    const B = sheetAtlas('B.png', row(1));
    const a = sheetAtlas('a.png', row(1));
    const hashes = new Map([['B.png', ['sh']], ['a.png', ['sh']]]);
    const bytes = new Map([['B.png', 8000], ['a.png', 8000]]);
    const f = crossAtlasRedundancyFinding([B, a], hashes, bytes, DEFAULT_THRESHOLDS)!;
    expect(f).not.toBeNull();
    expect(f.assetRef).toBe('a.png'); // localeCompare anchor, NOT code-unit 'B.png'
    expect(f.params?.atlases).toBe('a.png, B.png');
    expect(f.relatedRefs).toEqual(['a.png_0', 'B.png_0']);
  });

  it('a single-atlas cluster ⇒ null (frame-redundancy owns within-atlas; no double-report)', () => {
    const A = sheetAtlas('A.png', row(3));
    const hashes = new Map([['A.png', ['dup', 'dup', 'other']]]); // 2 copies but all on ONE sheet
    const f = crossAtlasRedundancyFinding([A], hashes, new Map([['A.png', 8000]]), DEFAULT_THRESHOLDS);
    expect(f).toBeNull();
  });

  it('three atlases share a frame ⇒ dupes:2, sheets:3, area = 2 freed copies', () => {
    const A = sheetAtlas('A.png', row(1));
    const B = sheetAtlas('B.png', row(1));
    const C = sheetAtlas('C.png', row(1));
    const hashes = new Map([['A.png', ['z']], ['B.png', ['z']], ['C.png', ['z']]]);
    const bytes = new Map([['A.png', 8000], ['B.png', 8000], ['C.png', 8000]]);
    const f = crossAtlasRedundancyFinding([A, B, C], hashes, bytes, DEFAULT_THRESHOLDS)!;
    expect(f.params?.dupes).toBe(2); // 3 copies → 2 recoverable
    expect(f.params?.groups).toBe(1);
    expect(f.params?.sheets).toBe(3);
    expect(f.params?.area).toBe(2 * cell.w * cell.h);
    expect(f.estimate?.vramBytesSaved).toBe(2 * cell.w * cell.h * 4);
  });

  it('pre-aliased rect in one sheet ⇒ collapses to one unit per atlas (distinct-rect guard)', () => {
    // A.png has TWO manifest names on the IDENTICAL packed rect (a pre-aliased sheet) + B.png shares the hash.
    const A: Atlas = {
      name: 'A.png', imageRef: 'A.png', size: { w: 256, h: 256 }, source: { kind: 'pixi' },
      sprites: [
        { name: 'A_alias0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: cell },
        { name: 'A_alias1', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: cell },
      ],
    };
    const B = sheetAtlas('B.png', row(1));
    const hashes = new Map([['A.png', ['sh', 'sh']], ['B.png', ['sh']]]);
    const bytes = new Map([['A.png', 8000], ['B.png', 8000]]);
    const f = crossAtlasRedundancyFinding([A, B], hashes, bytes, DEFAULT_THRESHOLDS)!;
    // A's two aliases collapse to ONE unit; with B's one ⇒ 2 distinct units across 2 sheets → 1 recoverable.
    expect(f.params?.dupes).toBe(1);
    expect(f.params?.sheets).toBe(2);
    expect(f.params?.area).toBe(cell.w * cell.h);
  });

  it('atlas with intra-atlas dupes of a cross-sheet frame ⇒ counts ONE unit per atlas, NOT one per rect', () => {
    // REGRESSION (r27): Atlas A packs the SAME 'z' frame at THREE DISTINCT rects (an intra-atlas redundancy)
    // and the frame ALSO appears on Atlas B once. The honest CROSS-SHEET reclaim is 1 (B's single copy can
    // reference A's shared copy). A's 2 internal dupes are within-atlas reclaim owned by frameRedundancyFinding;
    // counting them here double-claims the same pixels (invariant 3/5). Pre-fix this asserts dupes=3 (keyed by
    // atlas|rect → 4 distinct units → 3 freed); post-fix each atlas collapses to ONE unit → 2 units → 1 freed.
    const A = sheetAtlas('A.png', row(3)); // A_0,A_1,A_2 at distinct rects (x 0,32,64), all hash 'z'
    const B = sheetAtlas('B.png', row(1)); // B_0 at x:0, hash 'z'
    const hashes = new Map([
      ['A.png', ['z', 'z', 'z']],
      ['B.png', ['z']],
    ]);
    const bytes = new Map([['A.png', 8000], ['B.png', 8000]]);
    const f = crossAtlasRedundancyFinding([A, B], hashes, bytes, DEFAULT_THRESHOLDS)!;
    expect(f).not.toBeNull();
    expect(f.params?.dupes).toBe(1); // ONE honest cross-sheet copy freed (NOT 3)
    expect(f.params?.sheets).toBe(2);
    expect(f.params?.area).toBe(cell.w * cell.h); // one freed 32×32 cell, not three
    expect(f.estimate?.vramBytesSaved).toBe(cell.w * cell.h * 4);
  });

  it('partition proof: frame-redundancy owns A intra-atlas dupes (2); cross-atlas owns the cross-sheet copy (1) — disjoint', () => {
    // The SAME atlases as the regression above. frameRedundancy (within-atlas, gate minDuplicates:3) sees A's
    // 3 distinct 'z' rects → fires with dupes=2 (2 intra-atlas copies beyond the kept one). cross-atlas sees
    // 2 sheets → fires with dupes=1 (B's cross-sheet copy). The two reclaim DISJOINT pixel sets: within=2×cell
    // (A's two internal dupes), cross=1×cell (one shared copy across sheets) — no overlap, the duplicate set
    // is PARTITIONED (the docstring orthogonality claim now holds for real).
    const A = sheetAtlas('A.png', row(3));
    const B = sheetAtlas('B.png', row(1));
    const within = frameRedundancyFinding(A, DEFAULT_THRESHOLDS, ['z', 'z', 'z'], 8000)!;
    expect(within).not.toBeNull();
    expect(within.params?.dupes).toBe(2); // 3 distinct rects → 2 recoverable WITHIN A
    expect(within.params?.area).toBe(2 * cell.w * cell.h); // 2×cell within-atlas reclaim

    const hashes = new Map([['A.png', ['z', 'z', 'z']], ['B.png', ['z']]]);
    const cross = crossAtlasRedundancyFinding([A, B], hashes, new Map([['A.png', 8000], ['B.png', 8000]]), DEFAULT_THRESHOLDS)!;
    expect(cross.params?.dupes).toBe(1); // 1 cross-sheet copy
    expect(cross.params?.area).toBe(cell.w * cell.h); // 1×cell cross-atlas reclaim
    // Disjoint reclaim: the two areas address different pixels (within = A's internal dupes; cross = one shared
    // copy across the 2 sheets), so they are additive with ZERO overlap — the partition the docstrings assert.
    expect((within.params?.area as number) + (cross.params?.area as number)).toBe(3 * cell.w * cell.h);
  });

  it('<2 atlases with hashes ⇒ null', () => {
    const A = sheetAtlas('A.png', row(2));
    const f = crossAtlasRedundancyFinding([A], new Map([['A.png', ['x', 'x']]]), new Map([['A.png', 8000]]), DEFAULT_THRESHOLDS);
    expect(f).toBeNull();
  });

  it('length mismatch on one atlas ⇒ that atlas excluded; the rest still compared', () => {
    const A = sheetAtlas('A.png', row(2));
    const B = sheetAtlas('B.png', row(1));
    const C = sheetAtlas('C.png', row(1));
    // A's hash array length (1) ≠ sprite count (2) ⇒ A is dropped. B & C still share a hash → fires across 2.
    const hashes = new Map([['A.png', ['sh']], ['B.png', ['sh']], ['C.png', ['sh']]]);
    const bytes = new Map([['A.png', 8000], ['B.png', 8000], ['C.png', 8000]]);
    const f = crossAtlasRedundancyFinding([A, B, C], hashes, bytes, DEFAULT_THRESHOLDS)!;
    expect(f.params?.sheets).toBe(2); // A excluded
    expect(f.params?.atlases).toBe('B.png, C.png');
    expect(f.relatedRefs).toEqual(['B.png_0', 'C.png_0']);
  });

  it('all-null hashes ⇒ null (host-skipped flat regions never cluster)', () => {
    const A = sheetAtlas('A.png', row(1));
    const B = sheetAtlas('B.png', row(1));
    const hashes = new Map<string, (string | null)[]>([['A.png', [null]], ['B.png', [null]]]);
    const f = crossAtlasRedundancyFinding([A, B], hashes, new Map([['A.png', 8000], ['B.png', 8000]]), DEFAULT_THRESHOLDS);
    expect(f).toBeNull();
  });

  it('no crossAtlasRedundancy config ⇒ null (CLI / budget configs that don\'t opt in)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.crossAtlasRedundancy;
    const A = sheetAtlas('A.png', row(1));
    const B = sheetAtlas('B.png', row(1));
    const hashes = new Map([['A.png', ['sh']], ['B.png', ['sh']]]);
    expect(crossAtlasRedundancyFinding([A, B], hashes, new Map([['A.png', 8000], ['B.png', 8000]]), cfg)).toBeNull();
  });

  it('disk is area-proportional per freed copy\'s OWN atlas; missing byteSize ⇒ that copy\'s disk skipped', () => {
    // Two atlases share a 32×32 frame. A is the representative (kept); B's copy is freed → its disk attributes
    // to B's bytes: 8000 × (1024 / Σ B frame area). B has only the one 32×32 frame ⇒ Σ = 1024 ⇒ disk = 8000.
    const A = sheetAtlas('A.png', row(1));
    const B = sheetAtlas('B.png', row(1));
    const hashes = new Map([['A.png', ['sh']], ['B.png', ['sh']]]);
    const f = crossAtlasRedundancyFinding([A, B], hashes, new Map([['A.png', 8000], ['B.png', 8000]]), DEFAULT_THRESHOLDS)!;
    expect(f.params?.disk).toBe(8000);
    expect(f.estimate?.diskBytesSaved).toBe(8000);
    // Missing byteSize for B ⇒ B's freed copy contributes NO disk (VRAM/area still reported).
    const f2 = crossAtlasRedundancyFinding([A, B], hashes, new Map([['A.png', 8000]]), DEFAULT_THRESHOLDS)!;
    expect(f2.params?.disk).toBe(0);
    expect(f2.estimate?.diskBytesSaved).toBeUndefined(); // omitted when 0
    expect(f2.estimate?.vramBytesSaved).toBe(cell.w * cell.h * 4); // VRAM unaffected
  });

  it('analyze threads the folder-wide hashes and does NOT fold the disk estimate into potentialDiskSaved', async () => {
    const A = sheetAtlas('A.png', row(1));
    const B = sheetAtlas('B.png', row(1));
    const baseline = await analyze([sheetAsset(A), sheetAsset(B)]); // no frameHashes ⇒ dormant
    expect(baseline.findings.some((f) => f.rule === 'cross-atlas-redundancy')).toBe(false);

    const report = await analyze([sheetAsset(A), sheetAsset(B)], undefined, {
      frameHashes: [
        { atlasRef: 'A.png', frameHashes: ['sh'] },
        { atlasRef: 'B.png', frameHashes: ['sh'] },
      ],
    });
    const car = report.findings.find((f) => f.rule === 'cross-atlas-redundancy');
    expect(car).toBeTruthy();
    expect(car?.scope).toBe('folder');
    expect(car?.estimate?.vramBytesSaved).toBe(cell.w * cell.h * 4);
    // The disk number is an area-proportional ESTIMATE — NEVER folded into the aggregate (invariant 5).
    expect(report.totals.potentialDiskSaved).toBe(baseline.totals.potentialDiskSaved);
  });
});

describe('trim-margin (untrimmed sprites with reclaimable transparent padding)', () => {
  // A pure atlas on a 256×256 sheet; each sprite is UNtrimmed (frame == full untrimmed image). The test
  // injects opaque bboxes directly (no canvas) — each bbox is RELATIVE to its frame, top-left origin.
  type Bbox = { x: number; y: number; w: number; h: number };
  const padAtlas = (
    name: string,
    sprites: { frame: Bbox; trimmed?: boolean; spriteSourceSize?: Bbox }[],
  ): Atlas => ({
    name,
    imageRef: name,
    size: { w: 256, h: 256 },
    sprites: sprites.map((s, i) => ({
      name: `s${i}`,
      frame: s.frame,
      rotated: false,
      trimmed: s.trimmed ?? false,
      sourceSize: { w: s.frame.w, h: s.frame.h },
      ...(s.spriteSourceSize ? { spriteSourceSize: s.spriteSourceSize } : {}),
    })),
    source: { kind: 'pixi' },
  });
  const padAsset = (atlas: Atlas, byteSize = 8000): Asset => ({
    kind: 'atlas',
    atlas,
    image: { name: atlas.name, imageRef: atlas.imageRef, size: atlas.size, mime: 'image/png', byteSize },
  });
  // Two 64×64 untrimmed frames, each with a 32×32 opaque core inset 16px on all sides → 16px margin per side,
  // recoverable = 64² − 32² = 4096 − 1024 = 3072 px each → 6144 px total (> 5% of 256² = 3276.8).
  const twoPadded = [
    { frame: { x: 0, y: 0, w: 64, h: 64 } },
    { frame: { x: 64, y: 0, w: 64, h: 64 } },
  ];
  const twoBboxes: (Bbox | null)[] = [
    { x: 16, y: 16, w: 32, h: 32 },
    { x: 16, y: 16, w: 32, h: 32 },
  ];

  it('untrimmed sprites with padding ⇒ warn, EXACT VRAM, refs, one transparent overlay zone', () => {
    const atlas = padAtlas('pad.png', twoPadded);
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, twoBboxes, 8000)!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('trim-margin');
    expect(f.severity).toBe('warn');
    expect(f.messageKey).toBe('trim-margin');
    expect(f.params?.sprites).toBe(2);
    // recoverable = 2 × (64² − 32²) = 2 × 3072 = 6144 px → ×4 = 24576 bytes VRAM (EXACT).
    expect(f.params?.area).toBe(2 * (64 * 64 - 32 * 32));
    expect(f.estimate?.vramBytesSaved).toBe(2 * (64 * 64 - 32 * 32) * 4);
    expect(f.relatedRefs).toEqual(['s0', 's1']);
    expect(f.overlay).toHaveLength(1);
    expect(f.overlay?.[0]?.kind).toBe('transparent');
    expect(f.overlay?.[0]?.rects.length).toBeGreaterThan(0); // border strips
    // disk is area-proportional: 8000 × (6144 / ΣframeArea=8192) = 6000.
    expect(f.params?.disk).toBe(Math.round((8000 * 6144) / (2 * 64 * 64)));
    expect(f.estimate?.diskBytesSaved).toBe(Math.round((8000 * 6144) / (2 * 64 * 64)));
  });

  it('overlay strips are translated into ATLAS px (frame.xy offset) and cover the four borders', () => {
    const atlas = padAtlas('pad.png', [{ frame: { x: 64, y: 0, w: 64, h: 64 } }]);
    // Need ≥ minRecoverablePct: 1 × 3072 / 65536 = 4.7% < 5% → won't fire. Use a bigger frame.
    const big = padAtlas('big.png', [{ frame: { x: 64, y: 0, w: 100, h: 100 } }]);
    const f = trimMarginFinding(big, DEFAULT_THRESHOLDS, [{ x: 20, y: 20, w: 40, h: 40 }], 8000)!;
    expect(f).not.toBeNull();
    const rects = f.overlay![0]!.rects;
    // top strip y == frame.y (0); left strip x == frame.x (64). Proves atlas-px translation.
    expect(rects.some((r) => r.x === 64)).toBe(true);
    expect(rects.some((r) => r.y === 0)).toBe(true);
    expect(atlas.sprites[0]!.frame.x).toBe(64); // (silence unused)
  });

  it('skips ALREADY-TRIMMED sprites (those with spriteSourceSize) — never re-counts a trimmed frame', () => {
    const atlas = padAtlas('mixed.png', [
      { frame: { x: 0, y: 0, w: 64, h: 64 }, trimmed: true, spriteSourceSize: { x: 16, y: 16, w: 32, h: 32 } },
      { frame: { x: 64, y: 0, w: 64, h: 64 } }, // only THIS one is untrimmed
      { frame: { x: 128, y: 0, w: 64, h: 64 } },
    ]);
    const bboxes: (Bbox | null)[] = [null, { x: 16, y: 16, w: 32, h: 32 }, { x: 16, y: 16, w: 32, h: 32 }];
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, bboxes, 8000)!;
    expect(f.params?.sprites).toBe(2); // s1 + s2 only; the trimmed s0 is skipped despite its null bbox
    expect(f.relatedRefs).toEqual(['s1', 's2']);
  });

  it('a null bbox on an UNtrimmed sprite = fully-transparent frame ⇒ the whole frame is recoverable', () => {
    const atlas = padAtlas('dead.png', [{ frame: { x: 0, y: 0, w: 64, h: 64 } }, { frame: { x: 64, y: 0, w: 64, h: 64 } }]);
    const bboxes: (Bbox | null)[] = [null, { x: 16, y: 16, w: 32, h: 32 }];
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, bboxes, 8000)!;
    // s0 (null) whole frame = 4096 px; s1 padding = 3072 px → 7168 px total.
    expect(f.params?.area).toBe(64 * 64 + (64 * 64 - 32 * 32));
  });

  it('per-side margin below minMarginPx ⇒ that sprite is skipped (thin border is noise)', () => {
    // 2px border per side on a 100×100 frame: margin 2 < minMarginPx (4) → skipped → no qualifying sprite.
    const atlas = padAtlas('thin.png', [{ frame: { x: 0, y: 0, w: 100, h: 100 } }]);
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, [{ x: 2, y: 2, w: 96, h: 96 }], 8000);
    expect(f).toBeNull();
  });

  it('aliased frames (same rect) ⇒ padding counted ONCE; both names still appear in refs', () => {
    const atlas = padAtlas('alias.png', [
      { frame: { x: 0, y: 0, w: 100, h: 100 } },
      { frame: { x: 0, y: 0, w: 100, h: 100 } }, // same packed rect → ONE GPU region
    ]);
    const bb: Bbox = { x: 20, y: 20, w: 40, h: 40 };
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, [bb, bb], 8000)!;
    expect(f.params?.sprites).toBe(1); // one distinct rect
    expect(f.params?.area).toBe(100 * 100 - 40 * 40); // counted once
    expect(f.relatedRefs).toEqual(['s0', 's1']); // both names attributed
  });

  it('below minRecoverablePct ⇒ null (a single small padded sprite is not a verdict)', () => {
    // 1 × (64²−32²) = 3072 px / 65536 = 4.7% < 5% → null.
    const atlas = padAtlas('small.png', [{ frame: { x: 0, y: 0, w: 64, h: 64 } }]);
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, [{ x: 16, y: 16, w: 32, h: 32 }], 8000);
    expect(f).toBeNull();
  });

  it('no trimMargin config ⇒ null (CLI / budget configs that don\'t opt in)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.trimMargin;
    expect(trimMarginFinding(padAtlas('pad.png', twoPadded), cfg, twoBboxes, 8000)).toBeNull();
  });

  it('length mismatch ⇒ null (stale/desynced dep, never mis-key a sprite)', () => {
    expect(trimMarginFinding(padAtlas('pad.png', twoPadded), DEFAULT_THRESHOLDS, [twoBboxes[0]!], 8000)).toBeNull();
  });

  it('analyze threads frameTrims to an ATLAS and does NOT fold the disk estimate into potentialDiskSaved', async () => {
    const atlas = padAtlas('pad.png', twoPadded);
    const baseline = await analyze([padAsset(atlas)]); // no frameTrims ⇒ rule dormant
    expect(baseline.findings.some((f) => f.rule === 'trim-margin')).toBe(false);

    const report = await analyze([padAsset(atlas)], undefined, {
      frameTrims: [{ atlasRef: 'pad.png', bboxes: twoBboxes }],
    });
    const tm = report.findings.find((f) => f.rule === 'trim-margin');
    expect(tm?.assetRef).toBe('pad.png');
    expect(tm?.estimate?.vramBytesSaved).toBe(2 * (64 * 64 - 32 * 32) * 4);
    // The disk number is an area-proportional ESTIMATE — NEVER folded into the aggregate (invariant 5).
    expect(report.totals.potentialDiskSaved).toBe(baseline.totals.potentialDiskSaved);
  });

  it('absent frameTrims ⇒ byte-identical to today (CLI / headless unaffected)', async () => {
    const atlas = padAsset(padAtlas('pad.png', twoPadded));
    const a = await analyze([atlas]);
    const b = await analyze([atlas], undefined, {});
    expect(a.findings.some((f) => f.rule === 'trim-margin')).toBe(false);
    expect(b.findings.some((f) => f.rule === 'trim-margin')).toBe(false);
  });

  it('a LOOSE asset never fires trim-margin even if a trim entry names it', async () => {
    const loose: Asset = { kind: 'image', image: { name: 'x.png', imageRef: 'x.png', size: { w: 64, h: 64 }, mime: 'image/png', byteSize: 1000 } };
    const report = await analyze([loose], undefined, {
      frameTrims: [{ atlasRef: 'x.png', bboxes: [{ x: 16, y: 16, w: 32, h: 32 }] }],
    });
    expect(report.findings.some((f) => f.rule === 'trim-margin')).toBe(false);
  });

  it('golden: untrimmed-padding fixture fires warn with the documented recoverable area', async () => {
    // Headless/pure — can't decode the PNG here (no canvas). Verifies the RULE wiring given the documented
    // opaque bboxes (authored in expected.json). The REAL decode path — fixture PNG → alphaBBox → this same
    // finding — is asserted end-to-end in apps/web/src/lib/perceptual.test.ts (where the page is decoded).
    interface TmExpected {
      atlas: { w: number; h: number };
      recoverableArea: number;
      vramBytesSaved: number;
      regions: { name: string; frame: Rect; bbox: { x: number; y: number; w: number; h: number } | null; trimmed: boolean }[];
      findings: { rule: string; severity: string }[];
    }
    const expected = readJson('untrimmed-padding/expected.json') as TmExpected;
    const parsed = parseAtlas(readJson('untrimmed-padding/sheet.json'), {
      ref: 'sheet.png',
      bytes: readBytes('untrimmed-padding/sheet.png'),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.asset.kind !== 'atlas') return;
    const atlas = parsed.asset.atlas;

    // bboxes BY SPRITE NAME (robust to parser ordering): the authored opaque bbox per region, RELATIVE to
    // the frame; an already-trimmed region contributes null (the rule skips it via Sprite.trimmed anyway).
    const bboxByName = new Map(expected.regions.map((r) => [r.name, r.bbox]));
    const bboxes = atlas.sprites.map((s) => bboxByName.get(s.name) ?? null);

    const report = await analyze([parsed.asset], undefined, {
      frameTrims: [{ atlasRef: 'sheet.png', bboxes }],
    });
    const tm = report.findings.find((f) => f.rule === 'trim-margin');
    expect(tm?.severity).toBe('warn');
    expect(tm?.estimate?.vramBytesSaved).toBe(expected.vramBytesSaved);
    expect(tm?.params?.area).toBe(expected.recoverableArea);
    expect(sig(report.findings.filter((f) => f.rule === 'trim-margin'))).toEqual(sig(expected.findings));
  });
});

describe('unparsed pass-through (F3)', () => {
  const looseImg = (name: string): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 10000 },
  });

  it('threads deps.unparsed verbatim onto the report (no re-sort, no filter)', async () => {
    const unparsed = [
      { ref: 'broken.json', reason: 'manifest JSON parse failed: x' },
      { ref: 'noimage.json', reason: 'manifest has frames but no meta.image' },
    ];
    const report = await analyze([looseImg('good.png')], undefined, { unparsed });
    expect(report.unparsed).toEqual(unparsed); // pure pass-through (host already sorted)
    expect(report.assets.map((a) => a.assetRef)).toEqual(['good.png']); // good asset survives
  });

  it('absent / empty unparsed ⇒ field omitted (byte-identical to today)', async () => {
    const a = await analyze([looseImg('good.png')], undefined, {});
    expect('unparsed' in a).toBe(false);
    const b = await analyze([looseImg('good.png')], undefined, { unparsed: [] });
    expect('unparsed' in b).toBe(false);
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

  it('atlas-merge VRAM saving is a conservative lower bound (packEfficiency, not 100% packing)', async () => {
    // 4× 1024² atlases, each one 700×700 frame → occupancy 0.467 (< occupancyBelow 0.5), so all 4 merge.
    // Area/capacity = 1.869. A 100% pack would claim 2 sheets / 8MB saved; a realistic pack (packEfficiency
    // 0.8) needs ~3 → 4MB. usedArea=1_960_000, usable=838_860.8, minAtlases=ceil(2.336)=3,
    // currentVram=16_777_216, mergedVram=12_582_912, vramBytesSaved=4_194_304.
    const frame: Rect[] = [{ x: 0, y: 0, w: 700, h: 700 }];
    const atlases = ['m1.png', 'm2.png', 'm3.png', 'm4.png'].map((n) => atlasOf(n, 1024, 1024, frame));
    const rep = await analyze(atlases);
    const m = rep.findings.find((f) => f.rule === 'atlas-merge');
    expect(m).toBeDefined();
    expect(m!.relatedRefs).toEqual(['m1.png', 'm2.png', 'm3.png', 'm4.png']);
    // conservative: merged count is 3 (not the 100%-packing 2), saving 4MB (not 8MB).
    expect(m!.params!.merged).toBe(3); // ~3 sheets, not ~2
    expect(m!.estimate!.vramBytesSaved).toBe(4 * 1024 * 1024); // 4_194_304, i.e. one sheet, not two
    // calibration-agnostic: strictly more conservative than the old 100%-packing result.
    expect(m!.params!.merged as number).toBeGreaterThan(2);
    expect(m!.estimate!.vramBytesSaved).toBeLessThan(8 * 1024 * 1024);
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

describe('bmfont-sparse — BMFont .fnt glyph-page readout through the REAL path', () => {
  interface BmExpected {
    face: string;
    atlas: { w: number; h: number };
    glyphCount: number;
    kerningCount: number;
    occupancy: number;
    malformedGlyph: { id: string; reason: string };
    findings: { rule: string; severity: string }[];
  }
  const readArrayBuffer = (p: string): ArrayBuffer => {
    const u8 = readBytes(p);
    const ab = new ArrayBuffer(u8.byteLength);
    new Uint8Array(ab).set(u8);
    return ab;
  };

  // The SAME font in all THREE serializations (TEXT/XML/binary): each .fnt is dispatched by magic to its
  // parser, and ALL three must yield the IDENTICAL expected.json verdicts through the REAL pipeline. This
  // proves the original defect (XML/binary → unsupported) is gone and font-glyph-page fires for each form.
  it.each(['bmfont-sparse', 'bmfont-sparse-xml', 'bmfont-sparse-bin'])(
    '%s: groupFiles → parseFntPage → analyze fires font-glyph-page (warn) + the generic atlas findings',
    async (dir) => {
      const expected = readJson(`${dir}/expected.json`) as BmExpected;
      // REAL path: ingest groups the .fnt + its page PNG as a bmfont atlas …
      const files: RawFile[] = [
        { name: 'font.fnt', path: 'font.fnt', bytes: readArrayBuffer(`${dir}/font.fnt`) },
        { name: 'font.png', path: 'font.png', bytes: readArrayBuffer(`${dir}/font.png`) },
      ];
      const grouped = groupFiles(files);
      expect(grouped.atlases).toHaveLength(1);
      const a = grouped.atlases[0]!;
      expect(a.kind).toBe('bmfont');
      const fp = a.manifest as FntPage;
      // per-glyph recovery: the OOB glyph (id=255) is surfaced, the page kept its 16 usable glyphs.
      expect(fp.sprites).toHaveLength(expected.glyphCount);
      expect(fp.kerningCount).toBe(expected.kerningCount);
      expect(fp.face).toBe(expected.face);
      expect(fp.malformedGlyphs).toEqual([expected.malformedGlyph]);

      // … parseFntPage builds the Atlas off the page-image bytes …
      const res = parseFntPage(fp, { ref: a.name, bytes: new Uint8Array(a.image.bytes) }, { name: a.name });
      expect(res.ok).toBe(true);
      if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');

      // … and analyze fires the font readout BESIDE the generic findings (fontPages dep mirrors the worker).
      const report = await analyze([res.asset], DEFAULT_THRESHOLDS, {
        fontPages: [{ atlasRef: a.name, faceName: fp.face, kerningCount: fp.kerningCount }],
      });
      const f = report.findings.find((x) => x.rule === 'font-glyph-page');
      expect(f).toBeTruthy();
      expect(f!.severity).toBe('warn');
      expect(f!.params!.glyphs).toBe(expected.glyphCount);
      expect(f!.params!.kerning).toBe(expected.kerningCount);
      expect(f!.params!.face).toBe(expected.face);
      // the estimate carries ONLY occupancyPct (invariant 5 — no fabricated disk/VRAM saved)
      expect(f!.estimate?.occupancyPct).toBeCloseTo(expected.occupancy, 4);
      expect(f!.estimate?.vramBytesSaved).toBeUndefined();
      expect(f!.estimate?.diskBytesSaved).toBeUndefined();

      // the generic occupancy + wasted-regions findings fire for free (the .fnt page IS an atlas).
      expect(sig(report.findings)).toEqual(sig(expected.findings));
      expect(report.assets[0]?.vramBytes).toBe(expected.atlas.w * expected.atlas.h * 4);
    },
  );

  it('with fontGlyphPage OMITTED from cfg the font finding does NOT fire (gate proof + byte-identity)', async () => {
    const fnt = parseFntText(new TextDecoder().decode(readBytes('bmfont-sparse/font.fnt')));
    const fp = fnt[0]!;
    const res = parseFntPage(fp, { ref: 'font.png', bytes: readBytes('bmfont-sparse/font.png') }, { name: 'font.png' });
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    const cfgNoFont = { ...DEFAULT_THRESHOLDS };
    delete (cfgNoFont as { fontGlyphPage?: unknown }).fontGlyphPage;
    const report = await analyze([res.asset], cfgNoFont, {
      fontPages: [{ atlasRef: 'font.png', faceName: fp.face, kerningCount: fp.kerningCount }],
    });
    expect(report.findings.some((x) => x.rule === 'font-glyph-page')).toBe(false);
    // the generic atlas findings still fire (the page is an atlas regardless of the font gate).
    expect(report.findings.some((x) => x.rule === 'occupancy')).toBe(true);
  });
});

// ── Exact-dup de-overlap vs format/alpha/strippable (potentialDiskSaved cap). The dropped copies of an
// exact-duplicate group VANISH on dedup, so their per-ref format/alpha/strippable bumps were phantom and
// must be reverted from the headline total — while the dedup term (perDisk*(n-1)) and the KEPT copy's full
// MAX contribution both stay. Each per-finding estimate stays honest standalone (Inv 5 over-claim removal).
describe('exact-dup de-overlap vs format/alpha (potentialDiskSaved cap)', () => {
  // Two byte-identical loose PNGs (same dims/mime/byteSize) so both clear the format/alpha gates identically.
  const dupImg = (name: string, strippableBytes = 0): Asset => ({
    kind: 'image',
    image: {
      name,
      imageRef: name,
      size: { w: 512, h: 512 },
      mime: 'image/png',
      byteSize: 10000,
      ...(strippableBytes > 0 ? { strippableBytes } : {}),
    },
  });

  it('dup + format: dropped copy format saving is phantom ⇒ 14000, NOT 18000', async () => {
    const report = await analyze([dupImg('a.png'), dupImg('b.png')], undefined, {
      encodeImage: async () => 6000, // each format-saving = 10000 - 6000 = 4000
      features: [
        { assetRef: 'a.png', contentHash: 'h', contentClass: 'photographic' },
        { assetRef: 'b.png', contentHash: 'h', contentClass: 'photographic' },
      ],
    });
    // dup saving = perDisk*(n-1) = 10000; kept (a.png === refs[0]) keeps its 4000 format; b.png's 4000 reverted.
    expect(report.totals.potentialDiskSaved).toBe(14000); // NOT 18000
    // Per-finding honesty preserved (each estimate unchanged standalone):
    const fmtB = report.findings.find((f) => f.assetRef === 'b.png' && f.rule === 'format');
    expect(fmtB?.estimate?.diskBytesSaved).toBe(4000); // dropped copy's finding still 4000 standalone
    const fmtA = report.findings.find((f) => f.assetRef === 'a.png' && f.rule === 'format');
    expect(fmtA?.estimate?.diskBytesSaved).toBe(4000); // kept copy's finding still 4000 standalone
    const dup = report.findings.find((f) => f.rule === 'duplicate-exact');
    expect(dup?.estimate?.diskBytesSaved).toBe(10000); // dedup term unchanged
  });

  it('regression — dup with NO format findings stays byte-identical (only the dedup term) ⇒ 10000', async () => {
    const report = await analyze([dupImg('a.png'), dupImg('b.png')], undefined, {
      features: [
        { assetRef: 'a.png', contentHash: 'h' },
        { assetRef: 'b.png', contentHash: 'h' },
      ],
    }); // no encodeImage/encodeOpaque ⇒ no per-ref bumps ⇒ nothing to revert
    expect(report.totals.potentialDiskSaved).toBe(10000); // == today: only the dedup term
  });

  it('three-way MAX kept copy + dup: dup 10000 + kept MAX 6000 = 16000 (dropped MAX reverted)', async () => {
    // a.png & b.png byte-identical, both opaque + strippable(5000) + AVIF-transcodable.
    // format → 6000 (saved 4000); opaque → 4000 (saved 6000); strip → 5000. Per-ref MAX = 6000 each.
    const report = await analyze([dupImg('a.png', 5000), dupImg('b.png', 5000)], undefined, {
      encodeImage: async () => 6000, // format saved = 4000
      encodeOpaque: async () => 4000, // wasted-alpha saved = 6000
      features: [
        { assetRef: 'a.png', contentHash: 'h', contentClass: 'photographic', opaque: true },
        { assetRef: 'b.png', contentHash: 'h', contentClass: 'photographic', opaque: true },
      ],
    });
    // dup 10000 + kept (a.png) MAX 6000, dropped (b.png) 6000 reverted ⇒ 16000 (NOT 10000 + 2×6000 = 22000).
    expect(report.totals.potentialDiskSaved).toBe(16000);
    // Per-finding estimates each honest standalone:
    expect(report.findings.find((f) => f.assetRef === 'a.png' && f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(6000);
    expect(report.findings.find((f) => f.assetRef === 'b.png' && f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(6000);
    expect(report.findings.find((f) => f.rule === 'duplicate-exact')?.estimate?.diskBytesSaved).toBe(10000);
  });

  it('non-dup sanity — two DIFFERENT contentHashes ⇒ no dup finding, both format savings stand ⇒ 8000', async () => {
    const report = await analyze([dupImg('a.png'), dupImg('b.png')], undefined, {
      encodeImage: async () => 6000, // each format-saving = 4000
      features: [
        { assetRef: 'a.png', contentHash: 'h1', contentClass: 'photographic' },
        { assetRef: 'b.png', contentHash: 'h2', contentClass: 'photographic' },
      ],
    });
    expect(report.findings.some((f) => f.rule === 'duplicate-exact')).toBe(false);
    expect(report.totals.potentialDiskSaved).toBe(8000); // 2×4000 — cap only fires on real dup groups
  });

  it('atlas-page dup: dropped page format saving reverted, dedup term kept ⇒ 14000', async () => {
    const dupAtlas = (name: string): Asset => ({
      kind: 'atlas',
      atlas: {
        name,
        imageRef: name,
        size: { w: 1024, h: 1024 },
        sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
        source: { kind: 'pixi' },
      },
      image: { name, imageRef: name, size: { w: 1024, h: 1024 }, mime: 'image/png', byteSize: 10000 },
    });
    const report = await analyze([dupAtlas('p1.png'), dupAtlas('p2.png')], undefined, {
      encodeImage: async () => 6000, // each page format-saving = 4000
      features: [
        { assetRef: 'p1.png', contentHash: 'h' },
        { assetRef: 'p2.png', contentHash: 'h' },
      ],
    });
    // dup 10000 + kept page (p1.png === refs[0]) 4000, dropped page (p2.png) 4000 reverted ⇒ 14000.
    expect(report.totals.potentialDiskSaved).toBe(14000);
    expect(report.findings.find((f) => f.rule === 'duplicate-exact')?.estimate?.diskBytesSaved).toBe(10000);
  });
});
