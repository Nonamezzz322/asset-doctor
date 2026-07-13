import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SpineSkeletonBinding, Asset, Atlas, ImageAsset, ImageFeatures, ImageMime, Rect, ThresholdConfig } from '@asset-doctor/core';
import { parseAtlas, parseImage, parseFntText, parseFntPage, type FntPage } from '@asset-doctor/parsers';
import { groupFiles, type RawFile } from '@asset-doctor/ingest';
import { analyze, buildCoverage, mergeEmptyRects, summarizeEmpty, occupancyValue, occupancyFinding, wastedRegions, formatFinding, solidFillFinding, upscaledSourceFinding, frameRedundancyFinding, trimMarginFinding, bleedingFinding, dimensionMismatchFinding, wastedAlphaFinding, strippableMetadataFinding, strippableMetadataAggregateFinding, iccNonSrgbFinding, interiorTransparencyFinding, binaryAlphaFinding, crossAtlasRedundancyFinding, premultipliedAlphaFinding, gpuCompressionAlignmentFinding, gutterFinding, spineUnreferencedRegionsFindings, duplicateSimilarFindings, DEFAULT_THRESHOLDS, mergeSharedAtlases, groupVariants, stemOf, hasResolutionToken } from '../src/index';

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

describe('occupancy — absolute wasted-VRAM floor (minWastedBytes)', () => {
  // One sprite whose frame area sets the occupancy fraction exactly; shape mirrors the grid-merge atlas.
  const atlasAt = (page: number, spriteW: number, spriteH: number): Atlas => ({
    name: 'o',
    imageRef: 'o.png',
    size: { w: page, h: page },
    sprites: [
      { name: 'a', frame: { x: 0, y: 0, w: spriteW, h: spriteH }, rotated: false, trimmed: false, sourceSize: { w: spriteW, h: spriteH } },
    ],
    source: { kind: 'pixi' },
  });

  it('256² at occ≈0.55 (crit fraction, ~118 KB waste) demotes to info — waste stays reported', () => {
    const f = occupancyFinding(atlasAt(256, 190, 190), DEFAULT_THRESHOLDS)!; // occ = 36100/65536 ≈ 0.551 < crit 0.6
    expect(f).not.toBeNull();
    expect(f.severity).toBe('info'); // (1−0.551)·262144 ≈ 117.7 KB < 256 KB floor
    expect(f.rule).toBe('occupancy');
    expect(f.messageKey).toBe('occupancy'); // identical copy/params — severity-only demotion
  });

  it('2048² at the same fraction keeps crit (≈7.5 MB waste clears the floor)', () => {
    const f = occupancyFinding(atlasAt(2048, 1520, 1520), DEFAULT_THRESHOLDS)!; // occ ≈ 0.551
    expect(f.severity).toBe('crit');
  });

  it('waste exactly === the floor keeps the fractional severity (strict <)', () => {
    // 512² page: sprite 512×384 ⇒ occ = 0.75 exactly (warn range); waste = 0.25·1 MiB = 262144 === floor.
    const f = occupancyFinding(atlasAt(512, 512, 384), DEFAULT_THRESHOLDS)!;
    expect(f.severity).toBe('warn');
  });

  it('minWastedBytes: 0 override reproduces legacy fraction-only severity', () => {
    const cfg = { ...DEFAULT_THRESHOLDS, occupancy: { ...DEFAULT_THRESHOLDS.occupancy, minWastedBytes: 0 } };
    const f = occupancyFinding(atlasAt(256, 190, 190), cfg)!;
    expect(f.severity).toBe('crit');
  });

  it('key absent entirely (legacy config shape) also reproduces fraction-only severity', () => {
    const cfg = { ...DEFAULT_THRESHOLDS, occupancy: { warn: 0.8, crit: 0.6 } };
    const f = occupancyFinding(atlasAt(256, 190, 190), cfg)!;
    expect(f.severity).toBe('crit');
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
  // byteSize 100000 (not 10000): these tests document DEFAULT-config behavior, and the minBytes=4096
  // floor would eat a 10000→6000/7000 saving (4000/3000 bytes). ×10 keeps every frac / MAX relation /
  // tie-break identical while the measured savings (40000/30000) clear the floor realistically.
  const looseImg = (name: string, mime: ImageMime = 'image/png'): ImageAsset =>
    ({ name, imageRef: name, size: { w: 256, h: 256 }, mime, byteSize: 100000 });

  it('records bestMime = AVIF when AVIF encodes smallest (lossy verdict)', async () => {
    const f = (await formatFinding('a.png', looseImg('a.png'), DEFAULT_THRESHOLDS, async (_r, _s, t) => (t === 'image/avif' ? 60000 : 70000)))!;
    expect(f.messageKey).toBe('format');
    expect(f.params?.bestMime).toBe('image/avif');
    expect(f.params?.target).toBe('AVIF'); // the display label stays beside the machine-readable mime
  });

  it('records bestMime = WebP when WebP encodes smallest (the branch the constant mock can never hit)', async () => {
    const f = (await formatFinding('b.png', looseImg('b.png'), DEFAULT_THRESHOLDS, async (_r, _s, t) => (t === 'image/avif' ? 70000 : 60000)))!;
    expect(f.params?.bestMime).toBe('image/webp');
    expect(f.params?.target).toBe('WebP');
  });

  it('deterministic tie-break: equal encodes keep AVIF (first FORMAT_TARGETS candidate)', async () => {
    const f = (await formatFinding('c.png', looseImg('c.png'), DEFAULT_THRESHOLDS, async () => 60000))!;
    expect(f.params?.bestMime).toBe('image/avif'); // strict-smaller pick ⇒ tie keeps the first iterated
  });

  it('records bestMime on the flat/alpha-art lossless verdict too', async () => {
    for (const cls of ['flat', 'alpha-art'] as const) {
      const f = (await formatFinding('d.png', looseImg('d.png'), DEFAULT_THRESHOLDS, async (_r, _s, t) => (t === 'image/avif' ? 70000 : 60000), cls))!;
      expect(f.messageKey).toBe('format-lossless');
      expect(f.params?.bestMime).toBe('image/webp');
    }
  });

  it('bestMime is NEVER the source mime: a WebP source yields AVIF (candidate loop skips target===source)', async () => {
    const f = (await formatFinding('e.webp', looseImg('e.webp', 'image/webp'), DEFAULT_THRESHOLDS, async () => 60000))!;
    expect(f.params?.bestMime).toBe('image/avif'); // only AVIF is a candidate for a WebP source
  });
});

// ── Absolute byte floor on the MEASURED format saving (formatSaving.minBytes). A high PERCENTAGE on a
// tiny file is byte-noise — 30% of a 2 KB icon is ~600 bytes, not a per-file warn. Same rationale (and
// same strict-`<` gate shape) as strippableMetadata.minBytes.
describe('format audit — absolute byte floor (minBytes)', () => {
  const img = (name: string, byteSize: number): ImageAsset =>
    ({ name, imageRef: name, size: { w: 64, h: 64 }, mime: 'image/png', byteSize });

  it('2048-byte icon saving 35% (718 bytes) ⇒ null — the headline byte-noise case', async () => {
    // frac 718/2048 ≈ 0.35 > warn 0.25, but saved 718 < minBytes 4096 ⇒ suppressed.
    expect(await formatFinding('i.png', img('i.png', 2048), DEFAULT_THRESHOLDS, async () => 1330)).toBeNull();
  });

  it('saved === minBytes (4096) FIRES — strict `<` boundary (mirrors strippableMetadata)', async () => {
    // 16384 → 12288: saved exactly 4096; frac exactly 0.25 also passes the non-strict side of `frac < warn`.
    const f = await formatFinding('b.png', img('b.png', 16384), DEFAULT_THRESHOLDS, async () => 12288);
    expect(f).not.toBeNull();
    expect(f!.estimate?.diskBytesSaved).toBe(4096);
  });

  it('saved === minBytes − 1 (4095) ⇒ null — one-below boundary', async () => {
    expect(await formatFinding('c.png', img('c.png', 16384), DEFAULT_THRESHOLDS, async () => 12289)).toBeNull();
  });

  it('the floor gates the LOSSLESS branch too (flat content, tiny file) ⇒ null', async () => {
    expect(await formatFinding('f.png', img('f.png', 2048), DEFAULT_THRESHOLDS, async () => 1330, 'flat')).toBeNull();
  });

  it('legacy config WITHOUT minBytes ⇒ fraction-only, byte-identical (`?? 0`)', async () => {
    // The exact partial shape budget/correlate/ingest test configs declare — must keep typechecking AND firing.
    const legacy: ThresholdConfig = { ...DEFAULT_THRESHOLDS, formatSaving: { warn: 0.25 } };
    const f = await formatFinding('l.png', img('l.png', 2048), legacy, async () => 1330);
    expect(f).not.toBeNull();
    expect(f!.estimate?.diskBytesSaved).toBe(718);
  });

  it('analyze: sub-floor tiny warns vanish ⇒ no per-file finding, no folder format-aggregate, potentialDiskSaved 0', async () => {
    const loose = (n: string): Asset => ({
      kind: 'image',
      image: { name: n, imageRef: n, size: { w: 64, h: 64 }, mime: 'image/png', byteSize: 2048 },
    });
    // Two tiny icons each "saving" ~35% (718 bytes each) — below the floor, so NOTHING format-shaped survives.
    const report = await analyze([loose('a.png'), loose('b.png')], undefined, { encodeImage: async () => 1330 });
    expect(report.findings.some((f) => f.rule === 'format')).toBe(false); // per-file AND aggregate share rule 'format'
    expect(report.totals.potentialDiskSaved).toBe(0);
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

describe('upscaled-source (provable nearest-2× upscale)', () => {
  const looseImg = (name: string, w: number, h: number): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 10000 },
  });

  it('depth 1 on 2048² ⇒ warn, vramBytesSaved = full − quarter, NO diskBytesSaved (Inv 5), params pinned', () => {
    const f = upscaledSourceFinding('u.png', { w: 2048, h: 2048 }, DEFAULT_THRESHOLDS, 1)!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('upscaled-source');
    expect(f.messageKey).toBe('upscaled-source');
    expect(f.severity).toBe('warn'); // longest 2048 ≥ warnEdgePx (1024)
    expect(f.estimate?.vramBytesSaved).toBe(2048 * 2048 * 4 - 1024 * 1024 * 4);
    expect(f.estimate?.diskBytesSaved).toBeUndefined(); // VRAM only — never re-encoded the source
    expect(f.params).toEqual({
      w: 2048, h: 2048, effW: 1024, effH: 1024, depth: 1, block: 2,
      vramFull: 2048 * 2048 * 4, vramEff: 1024 * 1024 * 4, vramSaved: 2048 * 2048 * 4 - 1024 * 1024 * 4,
    });
  });

  it('depth 2 ⇒ quarter-edge effective resolution + block 4, bigger saving', () => {
    const f = upscaledSourceFinding('u.png', { w: 2048, h: 2048 }, DEFAULT_THRESHOLDS, 2)!;
    expect(f.params).toMatchObject({ effW: 512, effH: 512, depth: 2, block: 4 });
    expect(f.estimate?.vramBytesSaved).toBe(2048 * 2048 * 4 - 512 * 512 * 4);
  });

  it('below warnEdgePx but ≥ minEdgePx ⇒ info; below minEdgePx ⇒ null; depth 0/undefined ⇒ null', () => {
    expect(upscaledSourceFinding('s.png', { w: 512, h: 512 }, DEFAULT_THRESHOLDS, 1)!.severity).toBe('info');
    expect(upscaledSourceFinding('tiny.png', { w: 128, h: 128 }, DEFAULT_THRESHOLDS, 1)).toBeNull();
    expect(upscaledSourceFinding('n.png', { w: 2048, h: 2048 }, DEFAULT_THRESHOLDS, 0)).toBeNull();
    expect(upscaledSourceFinding('n.png', { w: 2048, h: 2048 }, DEFAULT_THRESHOLDS, undefined)).toBeNull();
  });

  it('no effectiveResolution config ⇒ null (CLI / budget — needs a full-res decode)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.effectiveResolution;
    expect(upscaledSourceFinding('u.png', { w: 2048, h: 2048 }, cfg, 2)).toBeNull();
  });

  it('analyze threads blockUpscaleDepth to a LOOSE image ⇒ finding; absent ⇒ none; no total shift', async () => {
    const report = await analyze([looseImg('u.png', 2048, 2048)], undefined, {
      encodeImage: async () => 9999,
      features: [{ assetRef: 'u.png', contentHash: 'h', blockUpscaleDepth: 1 }],
    });
    const up = report.findings.find((f) => f.rule === 'upscaled-source');
    expect(up?.assetRef).toBe('u.png');
    expect(up?.severity).toBe('warn');
    // absent feature ⇒ no finding, and the VRAM estimate never moves potentialDiskSaved (a disk total)
    const bare = await analyze([looseImg('u.png', 2048, 2048)], undefined, { encodeImage: async () => 9999 });
    expect(bare.findings.find((f) => f.rule === 'upscaled-source')).toBeUndefined();
    expect(report.totals.potentialDiskSaved).toBe(bare.totals.potentialDiskSaved);
  });

  it('de-overlap: a solid image is solid-fill\'s, never upscaled-source (even if both features present)', async () => {
    const report = await analyze([looseImg('flat.png', 2048, 2048)], undefined, {
      encodeImage: async () => 9999,
      features: [{ assetRef: 'flat.png', contentHash: 'h', solid: true, blockUpscaleDepth: 11 }],
    });
    expect(report.findings.find((f) => f.rule === 'solid-fill')).toBeDefined();
    expect(report.findings.find((f) => f.rule === 'upscaled-source')).toBeUndefined();
  });

  it('analyze NEVER fires upscaled-source for an ATLAS (loose-only)', async () => {
    const atlasAsset: Asset = {
      kind: 'atlas',
      atlas: {
        name: 'sheet.png', imageRef: 'sheet.png', size: { w: 2048, h: 2048 },
        sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
        source: { kind: 'pixi' },
      },
      image: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 2048, h: 2048 }, mime: 'image/png', byteSize: 10000 },
    };
    const report = await analyze([atlasAsset], undefined, {
      features: [{ assetRef: 'sheet.png', contentHash: 'h', blockUpscaleDepth: 1 }],
    });
    expect(report.findings.find((f) => f.rule === 'upscaled-source')).toBeUndefined();
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
    // 100000-byte PNG (×10 vs the old 10000 so the format saving clears the DEFAULT minBytes=4096 floor;
    // all fracs and the MAX relation are scale-invariant): format → AVIF estimate 60000 (saved 40000);
    // opaque re-encode → 70000 (saved 30000). The two overlap (transcode already drops the dead alpha
    // plane). The aggregate must take the MAX per-ref (40000), NOT the sum (70000).
    const report = await analyze([looseImg('flat.png', 512, 512, 'image/png', 100000)], undefined, {
      encodeImage: async () => 60000, // AVIF/WebP transcode estimate → saved 40000
      encodeOpaque: async () => 70000, // opaque same-format re-encode → saved 30000
      features: [{ assetRef: 'flat.png', contentHash: 'h', contentClass: 'photographic', opaque: true }],
    });
    expect(report.findings.find((f) => f.rule === 'format')?.estimate?.diskBytesSaved).toBe(40000);
    expect(report.findings.find((f) => f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(30000);
    // MAX(40000, 30000) = 40000 — NOT 70000. The per-finding estimates are still honest individually.
    expect(report.totals.potentialDiskSaved).toBe(40000);
  });

  it('wasted-alpha saving LARGER than format saving ⇒ aggregate = the larger (max), still counted once', async () => {
    // format → 60000 (saved 40000, 40% > 25% gate + over the 4096 floor); opaque → 35000 (saved 65000).
    // MAX = 65000, not 105000.
    const report = await analyze([looseImg('flat.png', 512, 512, 'image/png', 100000)], undefined, {
      encodeImage: async () => 60000,
      encodeOpaque: async () => 35000,
      features: [{ assetRef: 'flat.png', contentHash: 'h', contentClass: 'photographic', opaque: true }],
    });
    expect(report.findings.find((f) => f.rule === 'format')?.estimate?.diskBytesSaved).toBe(40000);
    expect(report.findings.find((f) => f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(65000);
    expect(report.totals.potentialDiskSaved).toBe(65000);
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

  it('THREE-WAY MAX: fmt=40000 + alpha=60000 + strip=50000 ⇒ potentialDiskSaved === 60000 (honest MAX, not 70000)', async () => {
    // 100000-byte PNG (×10 vs the old 10000 so the format saving clears the DEFAULT minBytes=4096 floor;
    // fracs + MAX relations scale-invariant; strip 50000 stays within [minBytes 4096, warnBytes 65536) so
    // its severity is unchanged). format → 60000 estimate (saved 40000); opaque → 40000 (saved 60000);
    // strip → 50000. The three overlap on one re-encode; aggregate = MAX(40000,60000,50000) === 60000.
    const asset: Asset = { kind: 'image', image: { name: 'x.png', imageRef: 'x.png', size: { w: 512, h: 512 }, mime: 'image/png', byteSize: 100000, strippableBytes: 50000 } };
    const report = await analyze([asset], undefined, {
      encodeImage: async () => 60000,  // format saved = 100000 - 60000 = 40000
      encodeOpaque: async () => 40000, // wasted-alpha saved = 100000 - 40000 = 60000
      features: [{ assetRef: 'x.png', contentHash: 'h', contentClass: 'photographic', opaque: true }],
    });
    expect(report.findings.find((f) => f.rule === 'format')?.estimate?.diskBytesSaved).toBe(40000);
    expect(report.findings.find((f) => f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(60000);
    expect(report.findings.find((f) => f.rule === 'strippable-metadata' && f.scope !== 'folder')?.estimate?.diskBytesSaved).toBe(50000);
    expect(report.totals.potentialDiskSaved).toBe(60000); // MAX, never 40000 + 20000 + 10000 = 70000
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

// ── icc-non-srgb: a non-provably-sRGB embedded ICC profile. A DISCLOSURE/correctness finding — NO estimate
// (invariant 3/5 — removing a non-sRGB profile is a colour change, not a saving). Fires purely on image.icc.
describe('icc-non-srgb (non-provable embedded ICC profile — disclosure, NO estimate)', () => {
  const iccImg = (name: string, icc?: ImageAsset['icc'], mime: ImageMime = 'image/png'): ImageAsset => ({
    name, imageRef: name, size: { w: 512, h: 512 }, mime, byteSize: 200000, ...(icc ? { icc } : {}),
  });

  it('fires info with NO estimate; params pinned', () => {
    const f = iccNonSrgbFinding('p3.png', iccImg('p3.png', { bytes: 8227, provableSrgb: false, label: 'Display P3' }))!;
    expect(f.rule).toBe('icc-non-srgb');
    expect(f.messageKey).toBe('icc-non-srgb');
    expect(f.severity).toBe('info');
    expect(f.estimate).toBeUndefined(); // NO diskBytesSaved, NO vramBytesSaved — a colour change is not a saving
    expect(f.params).toEqual({ label: 'PNG', bytes: 8227, profile: 'Display P3' });
  });

  it('provably-sRGB ICC ⇒ null (a free strip, never disclosed here)', () => {
    expect(iccNonSrgbFinding('s.png', iccImg('s.png', { bytes: 8227, provableSrgb: true, label: 'sRGB IEC61966-2.1' }))).toBeNull();
  });

  it('no ICC ⇒ null', () => {
    expect(iccNonSrgbFinding('n.png', iccImg('n.png'))).toBeNull();
  });

  it('null profile label ⇒ neutral "unnamed" fallback in params', () => {
    const f = iccNonSrgbFinding('u.png', iccImg('u.png', { bytes: 4096, provableSrgb: false, label: null }))!;
    expect(f.params).toEqual({ label: 'PNG', bytes: 4096, profile: 'unnamed' });
  });

  it('analyze fires it for a LOOSE image and adds NOTHING to potentialDiskSaved', async () => {
    const asset: Asset = { kind: 'image', image: iccImg('p3.png', { bytes: 8227, provableSrgb: false, label: 'Display P3' }) };
    const report = await analyze([asset]);
    expect(report.findings.find((f) => f.rule === 'icc-non-srgb')?.assetRef).toBe('p3.png');
    expect(report.totals.potentialDiskSaved).toBe(0); // disclosure only — no saving folded in
  });

  it('analyze fires it for an ATLAS PAGE image', async () => {
    const atlasAsset: Asset = {
      kind: 'atlas',
      atlas: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }], source: { kind: 'pixi' } },
      image: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 1024, h: 1024 }, mime: 'image/png', byteSize: 200000, icc: { bytes: 5000, provableSrgb: false, label: 'Adobe RGB (1998)' } },
    };
    const report = await analyze([atlasAsset]);
    expect(report.findings.find((f) => f.rule === 'icc-non-srgb' && f.assetRef === 'sheet.png')).toBeTruthy();
  });

  it('golden fixture: parse(metadata-p3.png) -> analyze fires icc-non-srgb, NO strippable-metadata', async () => {
    const r = parseImage('metadata-p3.png', readBytes('strippable-metadata/metadata-p3.png'));
    if (!r.ok) throw new Error('fixture parse failed');
    const report = await analyze([r.asset]);
    const icc = report.findings.find((f) => f.rule === 'icc-non-srgb')!;
    expect(icc.severity).toBe('info');
    expect(icc.estimate).toBeUndefined();
    expect(icc.params).toEqual({ label: 'PNG', bytes: 3024, profile: 'Display P3' });
    // strippable does NOT fire — only 62 B remain after excluding the non-sRGB iCCP (< minBytes 4096).
    expect(report.findings.find((f) => f.rule === 'strippable-metadata')).toBeUndefined();
    expect(report.totals.potentialDiskSaved).toBe(0);
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
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, twoBboxes)!;
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
    // No disk estimate: the recoverable area is TRANSPARENT padding (alpha=0), the cheapest-compressing
    // pixels — an area-proportional byte number would over-state 10x+ (solid-fill precedent).
    expect(f.params?.disk).toBeUndefined();
    expect(f.estimate?.diskBytesSaved).toBeUndefined();
  });

  it('overlay strips are translated into ATLAS px (frame.xy offset) and cover the four borders', () => {
    const atlas = padAtlas('pad.png', [{ frame: { x: 64, y: 0, w: 64, h: 64 } }]);
    // Need ≥ minRecoverablePct: 1 × 3072 / 65536 = 4.7% < 5% → won't fire. Use a bigger frame.
    const big = padAtlas('big.png', [{ frame: { x: 64, y: 0, w: 100, h: 100 } }]);
    const f = trimMarginFinding(big, DEFAULT_THRESHOLDS, [{ x: 20, y: 20, w: 40, h: 40 }])!;
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
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, bboxes)!;
    expect(f.params?.sprites).toBe(2); // s1 + s2 only; the trimmed s0 is skipped despite its null bbox
    expect(f.relatedRefs).toEqual(['s1', 's2']);
  });

  it('a null bbox on an UNtrimmed sprite = fully-transparent frame ⇒ the whole frame is recoverable', () => {
    const atlas = padAtlas('dead.png', [{ frame: { x: 0, y: 0, w: 64, h: 64 } }, { frame: { x: 64, y: 0, w: 64, h: 64 } }]);
    const bboxes: (Bbox | null)[] = [null, { x: 16, y: 16, w: 32, h: 32 }];
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, bboxes)!;
    // s0 (null) whole frame = 4096 px; s1 padding = 3072 px → 7168 px total.
    expect(f.params?.area).toBe(64 * 64 + (64 * 64 - 32 * 32));
  });

  it('per-side margin below minMarginPx ⇒ that sprite is skipped (thin border is noise)', () => {
    // 2px border per side on a 100×100 frame: margin 2 < minMarginPx (4) → skipped → no qualifying sprite.
    const atlas = padAtlas('thin.png', [{ frame: { x: 0, y: 0, w: 100, h: 100 } }]);
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, [{ x: 2, y: 2, w: 96, h: 96 }]);
    expect(f).toBeNull();
  });

  it('aliased frames (same rect) ⇒ padding counted ONCE; both names still appear in refs', () => {
    const atlas = padAtlas('alias.png', [
      { frame: { x: 0, y: 0, w: 100, h: 100 } },
      { frame: { x: 0, y: 0, w: 100, h: 100 } }, // same packed rect → ONE GPU region
    ]);
    const bb: Bbox = { x: 20, y: 20, w: 40, h: 40 };
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, [bb, bb])!;
    expect(f.params?.sprites).toBe(1); // one distinct rect
    expect(f.params?.area).toBe(100 * 100 - 40 * 40); // counted once
    expect(f.relatedRefs).toEqual(['s0', 's1']); // both names attributed
  });

  it('below minRecoverablePct ⇒ null (a single small padded sprite is not a verdict)', () => {
    // 1 × (64²−32²) = 3072 px / 65536 = 4.7% < 5% → null.
    const atlas = padAtlas('small.png', [{ frame: { x: 0, y: 0, w: 64, h: 64 } }]);
    const f = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, [{ x: 16, y: 16, w: 32, h: 32 }]);
    expect(f).toBeNull();
  });

  it('no trimMargin config ⇒ null (CLI / budget configs that don\'t opt in)', () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.trimMargin;
    expect(trimMarginFinding(padAtlas('pad.png', twoPadded), cfg, twoBboxes)).toBeNull();
  });

  it('length mismatch ⇒ null (stale/desynced dep, never mis-key a sprite)', () => {
    expect(trimMarginFinding(padAtlas('pad.png', twoPadded), DEFAULT_THRESHOLDS, [twoBboxes[0]!])).toBeNull();
  });

  it('analyze threads frameTrims to an ATLAS, reports VRAM only, folds nothing into potentialDiskSaved', async () => {
    const atlas = padAtlas('pad.png', twoPadded);
    const baseline = await analyze([padAsset(atlas)]); // no frameTrims ⇒ rule dormant
    expect(baseline.findings.some((f) => f.rule === 'trim-margin')).toBe(false);

    const report = await analyze([padAsset(atlas)], undefined, {
      frameTrims: [{ atlasRef: 'pad.png', bboxes: twoBboxes }],
    });
    const tm = report.findings.find((f) => f.rule === 'trim-margin');
    expect(tm?.assetRef).toBe('pad.png');
    expect(tm?.estimate?.vramBytesSaved).toBe(2 * (64 * 64 - 32 * 32) * 4);
    // No disk on transparent padding (solid-fill precedent) — nothing to fold into the aggregate (invariant 5).
    expect(tm?.estimate?.diskBytesSaved).toBeUndefined();
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

  // ── Mean-color guard: dHash is luma-sign-only ⇒ color-blind, so a hue-swapped shape twin (recolored
  // symbol set — the standard slot-game pattern) hashes identically. Pairs whose alpha-weighted 9×8 mean
  // color differs by more than duplicates.maxMeanColorDelta on any channel must NOT cluster. Distinct
  // contentHashes everywhere so the exact-dup dedupe guard doesn't eat the case.
  describe('duplicate-similar — mean-color guard (dHash is color-blind)', () => {
    const H = 'ffffffffffffffff';
    const feat = (ref: string, hash: string, meanColor?: { r: number; g: number; b: number }): ImageFeatures => ({
      assetRef: ref,
      contentHash: hash,
      dHash: H,
      ...(meanColor ? { meanColor } : {}),
    });

    it('same dHash, red vs blue mean ⇒ NO finding (hue-swap split)', () => {
      const out = duplicateSimilarFindings(
        [feat('red.png', 'h1', { r: 200, g: 40, b: 40 }), feat('blue.png', 'h2', { r: 40, g: 60, b: 200 })],
        DEFAULT_THRESHOLDS,
      );
      expect(out.some((f) => f.rule === 'duplicate-similar')).toBe(false);
    });

    it('same dHash, mean delta within 24 ⇒ finding fires (re-export regime survives)', () => {
      const out = duplicateSimilarFindings(
        [feat('a.png', 'h1', { r: 200, g: 40, b: 40 }), feat('b.png', 'h2', { r: 195, g: 45, b: 42 })],
        DEFAULT_THRESHOLDS,
      );
      expect(out.find((f) => f.rule === 'duplicate-similar')?.relatedRefs).toEqual(['a.png', 'b.png']);
    });

    it('one side missing meanColor ⇒ guard self-skips, finding fires (legacy byte-identity proof)', () => {
      const out = duplicateSimilarFindings(
        [feat('a.png', 'h1', { r: 200, g: 40, b: 40 }), feat('b.png', 'h2')],
        DEFAULT_THRESHOLDS,
      );
      expect(out.find((f) => f.rule === 'duplicate-similar')?.relatedRefs).toEqual(['a.png', 'b.png']);
    });

    it('three same-dHash features: two red-ish + one blue ⇒ ONE finding with exactly the 2 red refs', () => {
      const out = duplicateSimilarFindings(
        [
          feat('r1.png', 'h1', { r: 200, g: 40, b: 40 }),
          feat('blue.png', 'h2', { r: 40, g: 60, b: 200 }),
          feat('r2.png', 'h3', { r: 190, g: 50, b: 45 }),
        ],
        DEFAULT_THRESHOLDS,
      );
      const sims = out.filter((f) => f.rule === 'duplicate-similar');
      expect(sims).toHaveLength(1); // no singleton finding for the excluded blue twin
      expect(sims[0]!.relatedRefs).toEqual(['r1.png', 'r2.png']);
    });

    // ── Complete-linkage: the reported set must satisfy the claimed "≤ N bits + color-compatible" bound
    // PAIRWISE, not just anchor-to-member. Anchor-only clustering over-claims via the triangle inequality.
    it('Hamming triangle-inequality: B,C each ≤6 bits from anchor A but 12 apart ⇒ C excluded (not lumped)', () => {
      // A=0…0, B has 6 low bits set, C has 6 different bits set. hamming(A,B)=hamming(A,C)=6; hamming(B,C)=12.
      // No meanColor ⇒ the color guard self-skips, isolating the Hamming triangle inequality.
      const feats: ImageFeatures[] = [
        { assetRef: 'a.png', contentHash: 'h1', dHash: '0000000000000000' },
        { assetRef: 'b.png', contentHash: 'h2', dHash: '000000000000003f' }, // 6 bits vs A
        { assetRef: 'c.png', contentHash: 'h3', dHash: '0000000000003f00' }, // 6 OTHER bits vs A ⇒ 12 vs B
      ];
      const sims = duplicateSimilarFindings(feats, DEFAULT_THRESHOLDS).filter((f) => f.rule === 'duplicate-similar');
      // Anchor A groups B (6≤6). C is 6 from A but 12 from B ⇒ complete-linkage refuses it; A pairs only with B.
      expect(sims).toHaveLength(1);
      expect(sims[0]!.relatedRefs).toEqual(['a.png', 'b.png']);
    });

    it('color triangle-inequality: a neutral anchor must NOT bridge two 48-apart recolors', () => {
      // n(eutral) is ≤24 from both red-ish and green-ish, but red vs green differ by 48 on r/g ⇒ splitting
      // them is the whole point of the recolor guard; an anchor-only check would lump all three.
      const out = duplicateSimilarFindings(
        [
          feat('n.png', 'h1', { r: 128, g: 128, b: 128 }),
          feat('red.png', 'h2', { r: 152, g: 104, b: 128 }), // Δ(n)=24 ok; Δ(green)=48 on r & g
          feat('green.png', 'h3', { r: 104, g: 152, b: 128 }), // Δ(n)=24 ok
        ],
        DEFAULT_THRESHOLDS,
      );
      const sims = out.filter((f) => f.rule === 'duplicate-similar');
      // n anchors with red (first compatible); green is 48 from red ⇒ excluded. No 3-way over-claim.
      expect(sims).toHaveLength(1);
      expect(sims[0]!.relatedRefs).toEqual(['n.png', 'red.png']);
    });
  });

  it('suggests atlasing many loose sprites', async () => {
    const assets = Array.from({ length: 8 }, (_, i) => img(`s${i}.png`, 32, 32));
    const rep = await analyze(assets);
    const sa = rep.findings.find((f) => f.rule === 'should-atlas' && f.scope === 'folder');
    expect(sa).toBeDefined();
    // 8 DISTINCT stems ⇒ logical == raw == 8 (no variant clustering) ⇒ fires exactly as before.
    expect(sa!.params!.n).toBe(8);
  });

  it('does NOT fire should-atlas when loose files are format variants of < minLooseImages logical images', async () => {
    // 3 logical icons × 3 formats (png/webp/avif) = 9 loose files. Raw 9 ≥ 8 fired TODAY, but only 3
    // textures load at runtime (one format per platform) → logical 3 < 8 must stay SILENT.
    const names = ['icon1', 'icon2', 'icon3'].flatMap((s) => [`${s}.png`, `${s}.webp`, `${s}.avif`]);
    const rep = await analyze(names.map((n) => img(n, 64, 64)));
    expect(rep.findings.some((f) => f.rule === 'should-atlas')).toBe(false);
    // (a variants finding MAY fire here — they ARE format variants; we assert only should-atlas absence.)
  });

  it('counts LOGICAL images (not raw variant files) for should-atlas', async () => {
    // 8 logical icons × 3 formats = 24 loose files. Honest runtime count is 8, not 24.
    const names = Array.from({ length: 8 }, (_, i) => `ic${i}`).flatMap((s) => [`${s}.png`, `${s}.webp`, `${s}.avif`]);
    const sa = (await analyze(names.map((n) => img(n, 64, 64)))).findings.find((f) => f.rule === 'should-atlas');
    expect(sa).toBeDefined();
    expect(sa!.params!.n).toBe(8); // logical headline, not 24
    expect(sa!.relatedRefs).toHaveLength(24); // relatedRefs still lists every loose file (fold set preserved)
  });

  it('clusters resolution tiers as one logical image for should-atlas', async () => {
    // 3 logical × two ≤512px tiers each = 6 files → logical 3 < 8 → silent (RES_TOKEN clustering path).
    const names = ['a', 'b', 'c'].flatMap((s) => [`${s}_540p.png`, `${s}_270p.png`]);
    const rep = await analyze(names.map((n, i) => img(n, i % 2 ? 270 : 512, i % 2 ? 270 : 512)));
    expect(rep.findings.some((f) => f.rule === 'should-atlas')).toBe(false);
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

  it('atlas-merge emits a BATCHING-ONLY variant (no VRAM claim) when the merged-square model saves no VRAM', async () => {
    // Heterogeneous under-filled set whose largest atlas is a WIDE 2048×512 banner. The merged sheet is
    // modelled as a SQUARE at maxDim (2048²), which over-allocates so badly that the MODELLED merge raises
    // VRAM: currentVram = 4_194_304 + 4_194_304 + 1_048_576 = 9_437_184; minAtlases = 1 (usedArea 120_000
    // ÷ usable 3_355_443.2 = 0.036 → 1); mergedVram = 1 × 2048² × 4 = 16_777_216 ⇒ vramSaved = −7_340_032.
    // (A real tight repack — what the Pro fix's MaxRects POT pass actually does — would SHRINK VRAM here;
    // the crude square model just can't show it, so the honest read is that the VRAM change is UNQUANTIFIED,
    // not that there is none.) The batching win (3 sheets → 1, fewer binds/draw calls) is REAL, so the
    // finding still fires — but the VRAM clause is suppressed and no vramBytesSaved is claimed
    // (invariant 3/5: never over-claim VRAM, and never assert a negative the model can't prove).
    const frame: Rect[] = [{ x: 0, y: 0, w: 200, h: 200 }]; // 40_000 px each ⇒ all under 50% full
    const atlases = [
      atlasOf('banner.png', 2048, 512, frame), // wide, dominates maxDim
      atlasOf('sq1.png', 1024, 1024, frame),
      atlasOf('sq2.png', 512, 512, frame),
    ];
    const rep = await analyze(atlases);
    const m = rep.findings.find((f) => f.rule === 'atlas-merge');
    expect(m).toBeDefined();
    expect(m!.messageKey).toBe('atlas-merge-batching'); // VRAM clause suppressed
    expect(m!.severity).toBe('warn'); // unchanged severity (matches should-atlas, a batching-only warn)
    expect(m!.estimate).toBeUndefined(); // no vramBytesSaved (it would have been a phantom clamped-0)
    expect(m!.params!.merged).toBe(1);
    expect(m!.relatedRefs).toEqual(['banner.png', 'sq1.png', 'sq2.png']);
    // honesty (invariant 3): the detail must NOT claim a VRAM cut, MUST name fewer draws as the certain
    // win, and MUST frame the VRAM change as UNQUANTIFIED here — never assert there is none (a false
    // certainty the product's own tight-repack fix would contradict).
    expect(m!.detail).not.toMatch(/and VRAM/); // no VRAM-cut clause (that lives in the savesVram branch)
    expect(m!.detail).toMatch(/fewer draws/); // the certain, guaranteed win
    expect(m!.detail).toMatch(/can't be quantified/); // uncertainty, not an asserted absence
    expect(m!.detail).not.toMatch(/No VRAM is reclaimed|not less VRAM/); // the removed false certainty
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
    // Resolution-stem clustering (correction 3, trailing-format fix): hasResolutionToken now peels a
    // trailing FORMAT suffix before the res check, so hero_540p_webp / hero_1080p_avif are seen as the
    // resolution tiers they are. All FOUR hero files (two res tiers, each also carrying a format suffix)
    // therefore cluster by stem ALONE ("hero") into ONE group; 'other' is the only singleton.
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]!.members).toHaveLength(4); // the merged hero ladder: 540p×2 + 1080p×2
    // logicalImages = bucket count: {hero ladder} + {other singleton} = 2 ≤ 5 raw.
    expect(v.logicalImages).toBe(2);
    expect(v.summedVram).toBe(2 * v540 + 2 * v1080 + v100); // unchanged — every file still summed
    // One tier loads per logical image: the hero group's largest is 1080² → v1080 (counted ONCE),
    // plus the 'other' singleton. No longer double-counts the top tier across a png/webp+avif split.
    expect(v.loadedVramMax).toBe(v1080 + v100);
    expect(v.loadedVramMin).toBe(v540 + v100);
  });

  it('treats a format-suffixed resolution tier as ONE logical image with the png/other tiers', () => {
    // <stem>_<res>_<fmt> must be a resolution tier even though a format suffix trails the res token.
    expect(hasResolutionToken('hero_1080p_webp.webp')).toBe(true);
    expect(hasResolutionToken('hero_540p_avif.avif')).toBe(true);
    expect(hasResolutionToken('sprite_webp.webp')).toBe(false); // format-only, not a tier
    const v = groupVariants([
      img('hero_1080p.png', 1080, 1080),
      img('hero_1080p_webp.webp', 1080, 1080),
      img('hero_1080p_avif.avif', 1080, 1080),
    ]);
    expect(v.logicalImages).toBe(1); // one bucket, not three
    expect(v.loadedVramMax).toBe(1080 * 1080 * 4); // top tier counted ONCE
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

describe('loadedTextures (static draw-call FLOOR on totals — count of distinct loaded textures)', () => {
  const img = (name: string, w: number, h: number): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 1 },
  });
  const atlasAsset = (name: string, w: number, h: number): Asset => ({
    kind: 'atlas',
    atlas: {
      name,
      imageRef: `${name}.png`,
      size: { w, h },
      sprites: [{ name: 'f0', frame: { x: 0, y: 0, w, h }, rotated: false, trimmed: false, sourceSize: { w, h } }],
      source: { kind: 'texturepacker-hash' },
    },
    image: { name, imageRef: `${name}.png`, size: { w, h }, mime: 'image/png', byteSize: 1 },
  });

  it('loose-only folder ⇒ one texture per loose image (= N)', async () => {
    const rep = await analyze([img('a.png', 64, 64), img('b.png', 128, 128), img('c.png', 32, 32)]);
    // N distinct loose images ⇒ N bound textures ⇒ the draw-call FLOOR is N (each is at least one draw).
    expect(rep.totals.loadedTextures).toBe(3);
  });

  it('atlas + loose folder ⇒ atlas PAGES (1) + loose count', async () => {
    const rep = await analyze([atlasAsset('sheet', 512, 512), img('logo.png', 64, 64), img('bg.png', 256, 256)]);
    // one atlas page (the normalized model is one Atlas per page) + two loose images = 3 loaded textures.
    // The atlas would batch its sprites down toward ~1 draw — exactly the win should-atlas recommends.
    expect(rep.totals.loadedTextures).toBe(3);
  });

  it('multi-variant/multi-format asset counts the logical asset ONCE (same loaded-set dedup as loadedVramBytes)', async () => {
    // The exact scenario from the loaded-VRAM range test: 4 hero files (two res tiers, each also carrying a
    // format suffix) = ONE logical image, plus one singleton. loadedVramMax counts hero ONCE (v1080), so
    // the texture floor is 2 — the SAME population, never a different dedup, never the 5 raw files.
    const rep = await analyze([
      img('hero_540p.png', 540, 540),
      img('hero_540p_webp.webp', 540, 540),
      img('hero_1080p.png', 1080, 1080),
      img('hero_1080p_avif.avif', 1080, 1080),
      img('other.png', 100, 100),
    ]);
    expect(rep.totals.loadedTextures).toBe(2);
    // Proves it rides the identical loaded set as loadedVramBytes (hero's top tier + other, counted once):
    expect(rep.totals.loadedVramBytes).toBe(1080 * 1080 * 4 + 100 * 100 * 4);
  });

  it('groupVariants.loadedTextures mirrors the loaded-set grouping (totals reads it verbatim)', () => {
    const assets = [atlasAsset('sheet', 256, 256), img('x_540p.png', 540, 540), img('x_1080p.png', 1080, 1080)];
    const v = groupVariants(assets);
    // atlas page (1) + x's single loaded tier (1) = 2 — one variant loads per logical asset.
    expect(v.loadedTextures).toBe(2);
    expect(v.loadedTextures).toBe(v.logicalImages); // page-summed value == bucket count while every page is 1
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
    // occ 1.6% < crit 0.6 → fires; the tiny page's ~1 KB waste is under minWastedBytes ⇒ demoted to info
    // (the demotion is severity-only — B1's actual subject, the frag defaulting, is unaffected below).
    expect(occ?.severity).toBe('info');
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
  // byteSize 100000 (×10 vs the old 10000): the format saving must clear the DEFAULT minBytes=4096 floor
  // (100000→60000 saves 40000); every frac / MAX / revert relation below is scale-invariant.
  const dupImg = (name: string, strippableBytes = 0): Asset => ({
    kind: 'image',
    image: {
      name,
      imageRef: name,
      size: { w: 512, h: 512 },
      mime: 'image/png',
      byteSize: 100000,
      ...(strippableBytes > 0 ? { strippableBytes } : {}),
    },
  });

  it('dup + format: dropped copy format saving is phantom ⇒ 140000, NOT 180000', async () => {
    const report = await analyze([dupImg('a.png'), dupImg('b.png')], undefined, {
      encodeImage: async () => 60000, // each format-saving = 100000 - 60000 = 40000
      features: [
        { assetRef: 'a.png', contentHash: 'h', contentClass: 'photographic' },
        { assetRef: 'b.png', contentHash: 'h', contentClass: 'photographic' },
      ],
    });
    // dup saving = perDisk*(n-1) = 100000; kept (a.png === refs[0]) keeps its 40000 format; b.png's 40000 reverted.
    expect(report.totals.potentialDiskSaved).toBe(140000); // NOT 180000
    // Per-finding honesty preserved (each estimate unchanged standalone):
    const fmtB = report.findings.find((f) => f.assetRef === 'b.png' && f.rule === 'format');
    expect(fmtB?.estimate?.diskBytesSaved).toBe(40000); // dropped copy's finding still 40000 standalone
    const fmtA = report.findings.find((f) => f.assetRef === 'a.png' && f.rule === 'format');
    expect(fmtA?.estimate?.diskBytesSaved).toBe(40000); // kept copy's finding still 40000 standalone
    const dup = report.findings.find((f) => f.rule === 'duplicate-exact');
    expect(dup?.estimate?.diskBytesSaved).toBe(100000); // dedup term unchanged
  });

  it('regression — dup with NO format findings stays byte-identical (only the dedup term) ⇒ 100000', async () => {
    const report = await analyze([dupImg('a.png'), dupImg('b.png')], undefined, {
      features: [
        { assetRef: 'a.png', contentHash: 'h' },
        { assetRef: 'b.png', contentHash: 'h' },
      ],
    }); // no encodeImage/encodeOpaque ⇒ no per-ref bumps ⇒ nothing to revert
    expect(report.totals.potentialDiskSaved).toBe(100000); // == today: only the dedup term
  });

  it('three-way MAX kept copy + dup: dup 100000 + kept MAX 60000 = 160000 (dropped MAX reverted)', async () => {
    // a.png & b.png byte-identical, both opaque + strippable(50000) + AVIF-transcodable.
    // format → 60000 (saved 40000); opaque → 40000 (saved 60000); strip → 50000. Per-ref MAX = 60000 each.
    const report = await analyze([dupImg('a.png', 50000), dupImg('b.png', 50000)], undefined, {
      encodeImage: async () => 60000, // format saved = 40000
      encodeOpaque: async () => 40000, // wasted-alpha saved = 60000
      features: [
        { assetRef: 'a.png', contentHash: 'h', contentClass: 'photographic', opaque: true },
        { assetRef: 'b.png', contentHash: 'h', contentClass: 'photographic', opaque: true },
      ],
    });
    // dup 100000 + kept (a.png) MAX 60000, dropped (b.png) 60000 reverted ⇒ 160000 (NOT 100000 + 2×60000 = 220000).
    expect(report.totals.potentialDiskSaved).toBe(160000);
    // Per-finding estimates each honest standalone:
    expect(report.findings.find((f) => f.assetRef === 'a.png' && f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(60000);
    expect(report.findings.find((f) => f.assetRef === 'b.png' && f.rule === 'wasted-alpha')?.estimate?.diskBytesSaved).toBe(60000);
    expect(report.findings.find((f) => f.rule === 'duplicate-exact')?.estimate?.diskBytesSaved).toBe(100000);
  });

  it('non-dup sanity — two DIFFERENT contentHashes ⇒ no dup finding, both format savings stand ⇒ 80000', async () => {
    const report = await analyze([dupImg('a.png'), dupImg('b.png')], undefined, {
      encodeImage: async () => 60000, // each format-saving = 40000
      features: [
        { assetRef: 'a.png', contentHash: 'h1', contentClass: 'photographic' },
        { assetRef: 'b.png', contentHash: 'h2', contentClass: 'photographic' },
      ],
    });
    expect(report.findings.some((f) => f.rule === 'duplicate-exact')).toBe(false);
    expect(report.totals.potentialDiskSaved).toBe(80000); // 2×40000 — cap only fires on real dup groups
  });

  it('atlas-page dup: dropped page format saving reverted, dedup term kept ⇒ 140000', async () => {
    const dupAtlas = (name: string): Asset => ({
      kind: 'atlas',
      atlas: {
        name,
        imageRef: name,
        size: { w: 1024, h: 1024 },
        sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
        source: { kind: 'pixi' },
      },
      image: { name, imageRef: name, size: { w: 1024, h: 1024 }, mime: 'image/png', byteSize: 100000 },
    });
    const report = await analyze([dupAtlas('p1.png'), dupAtlas('p2.png')], undefined, {
      encodeImage: async () => 60000, // each page format-saving = 40000
      features: [
        { assetRef: 'p1.png', contentHash: 'h' },
        { assetRef: 'p2.png', contentHash: 'h' },
      ],
    });
    // dup 100000 + kept page (p1.png === refs[0]) 40000, dropped page (p2.png) 40000 reverted ⇒ 140000.
    expect(report.totals.potentialDiskSaved).toBe(140000);
    expect(report.findings.find((f) => f.rule === 'duplicate-exact')?.estimate?.diskBytesSaved).toBe(100000);
  });
});

describe('premultiplied-alpha (premultiplied-shaped edges — folder disclosure, NO estimate)', () => {
  // DEFAULT gate: { minEdgePixels: 24, fringeFrac: 0.75, minSprites: 2 } (config.ts — fringeFrac
  // corpus-recalibrated 0.5→0.75 on 2026-07-11; boundary pins below updated deliberately).
  const looseImg = (name: string): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w: 64, h: 64 }, mime: 'image/png', byteSize: 1000 },
  });
  const atlasAsset = (name: string): Asset => ({
    kind: 'atlas',
    atlas: {
      name,
      imageRef: name,
      size: { w: 256, h: 256 },
      sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
      source: { kind: 'pixi' },
    },
    image: { name, imageRef: name, size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 8000 },
  });
  // Distinct contentHashes everywhere so duplicate-exact never enters the analyze-level assertions.
  const feat = (ref: string, edge?: { edgePixels: number; fringeFrac: number }): ImageFeatures => ({
    assetRef: ref,
    contentHash: `hash-${ref}`,
    ...(edge ? { premultipliedEdge: edge } : {}),
  });

  it('fires at EXACTLY minSprites qualifying loose images: info, folder scope, NO estimate, sorted refs', () => {
    // Both AT the gate boundaries (edgePixels === 24, fringeFrac === 0.75 qualify — inclusive thresholds);
    // features deliberately given out of name order to prove the output sort.
    const f = premultipliedAlphaFinding(
      [looseImg('b.png'), looseImg('a.png')],
      [feat('b.png', { edgePixels: 24, fringeFrac: 0.75 }), feat('a.png', { edgePixels: 40, fringeFrac: 1 })],
      DEFAULT_THRESHOLDS,
    );
    expect(f).not.toBeNull();
    expect(f!.rule).toBe('premultiplied-alpha');
    expect(f!.severity).toBe('info'); // ALWAYS info — a conditional disclosure, never a proven defect
    expect(f!.scope).toBe('folder');
    expect(f!.estimate).toBeUndefined(); // NO estimate AT ALL (no disk, no VRAM) — invariant 3/5
    expect(f!.assetRef).toBe('a.png'); // first flagged ref, sorted
    expect(f!.relatedRefs).toEqual(['a.png', 'b.png']); // deterministic sorted
    expect(f!.messageKey).toBe('premultiplied-alpha');
    expect(f!.params).toEqual({ n: 2, refs: 'a.png, b.png' });
  });

  it('does NOT fire at minSprites − 1 qualifying images', () => {
    expect(
      premultipliedAlphaFinding(
        [looseImg('a.png'), looseImg('b.png')],
        [feat('a.png', { edgePixels: 40, fringeFrac: 1 }), feat('b.png')], // only ONE qualifies
        DEFAULT_THRESHOLDS,
      ),
    ).toBeNull();
  });

  it('below minEdgePixels or below fringeFrac ⇒ that sprite is NOT counted', () => {
    // 23 edge pixels (< 24) — too few transition pixels to classify, even at fringeFrac 1.
    expect(
      premultipliedAlphaFinding(
        [looseImg('a.png'), looseImg('b.png')],
        [feat('a.png', { edgePixels: 23, fringeFrac: 1 }), feat('b.png', { edgePixels: 40, fringeFrac: 1 })],
        DEFAULT_THRESHOLDS,
      ),
    ).toBeNull();
    // fringeFrac 0.74 (< 0.75) — the corpus showed a 0.5–0.7 ambiguity band; below the floor is not counted.
    expect(
      premultipliedAlphaFinding(
        [looseImg('a.png'), looseImg('b.png')],
        [feat('a.png', { edgePixels: 40, fringeFrac: 0.74 }), feat('b.png', { edgePixels: 40, fringeFrac: 1 })],
        DEFAULT_THRESHOLDS,
      ),
    ).toBeNull();
  });

  it('absent config ⇒ null (suppressed — browser-only gate, NOT in resolveThresholds)', () => {
    const cfgNo = { ...DEFAULT_THRESHOLDS };
    delete cfgNo.premultipliedAlpha;
    expect(
      premultipliedAlphaFinding(
        [looseImg('a.png'), looseImg('b.png')],
        [feat('a.png', { edgePixels: 40, fringeFrac: 1 }), feat('b.png', { edgePixels: 40, fringeFrac: 1 })],
        cfgNo,
      ),
    ).toBeNull();
  });

  it('ATLAS assets are never counted (loose-only) — a qualifying atlas-page feature does not fill the quota', () => {
    expect(
      premultipliedAlphaFinding(
        [atlasAsset('sheet.png'), looseImg('a.png')],
        [feat('sheet.png', { edgePixels: 400, fringeFrac: 1 }), feat('a.png', { edgePixels: 40, fringeFrac: 1 })],
        DEFAULT_THRESHOLDS,
      ),
    ).toBeNull(); // only 1 LOOSE flagged < minSprites 2
  });

  it('via analyze: absent premultipliedEdge features ⇒ no finding (CLI byte-identical); totals unmoved by the feature', async () => {
    const assets = [looseImg('a.png'), looseImg('b.png')];
    const featsWith = [
      feat('a.png', { edgePixels: 40, fringeFrac: 1 }),
      feat('b.png', { edgePixels: 40, fringeFrac: 1 }),
    ];
    const featsWithout = [feat('a.png'), feat('b.png')]; // same features minus the edge readout (the CLI shape)
    const repWith = await analyze(assets, undefined, { features: featsWith });
    const repWithout = await analyze(assets, undefined, { features: featsWithout });
    // The finding fires ONLY with the host-measured feature present…
    const pma = repWith.findings.find((f) => f.rule === 'premultiplied-alpha');
    expect(pma).toBeDefined();
    expect(pma!.severity).toBe('info');
    expect(pma!.estimate).toBeUndefined();
    expect(repWithout.findings.some((f) => f.rule === 'premultiplied-alpha')).toBe(false);
    // …and it moves NO total: potentialDiskSaved (and every other total) identical with and without it.
    expect(repWith.totals.potentialDiskSaved).toBe(repWithout.totals.potentialDiskSaved);
    expect(repWith.totals).toEqual(repWithout.totals);
    // The finding is the ONLY report difference (no per-asset finding, no metric shift).
    expect(repWith.findings.filter((f) => f.rule !== 'premultiplied-alpha')).toEqual(repWithout.findings);
    expect(repWith.assets).toEqual(repWithout.assets);
  });
});

describe('interior-transparency (transparent pixels INSIDE the opaque bbox — fill-rate disclosure, NO estimate)', () => {
  // DEFAULT gate: { minBboxPx: 16384 (a 128×128-equivalent bbox), minRatio: 0.6 } (config.ts — minRatio
  // corpus-recalibrated 0.35→0.6 on 2026-07-11: the real-corpus MEDIAN sprite measures 0.42, so the old
  // floor sat below the median and would have flagged 71% of a real folder; pins updated deliberately).
  type Shape = NonNullable<ImageFeatures['alphaShape']>;
  const shape = (over: Partial<Shape> = {}): Shape => ({
    bboxW: 128, bboxH: 128, interiorTransparent: 8192, binaryAlpha: false, opaqueCount: 8192, ...over,
  });
  const looseImg = (name: string, w: number, h: number): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 10000 },
  });

  it('fires at EXACTLY the bbox floor (128×128 = 16384 = minBboxPx, ratio 0.75): info, NO estimate, params pinned', () => {
    const f = interiorTransparencyFinding('ring.png', { w: 256, h: 256 }, DEFAULT_THRESHOLDS, shape({ interiorTransparent: 12288 }))!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('interior-transparency');
    expect(f.messageKey).toBe('interior-transparency');
    expect(f.severity).toBe('info'); // ALWAYS info — a fill-rate disclosure, never a byte-backed verdict
    expect(f.estimate).toBeUndefined(); // NO estimate AT ALL — fill-rate is not byte-measurable (Inv 3/5)
    expect(f.params).toEqual({ w: 256, h: 256, bboxW: 128, bboxH: 128, ratioPct: 75, px: 12288 });
  });

  it('bbox ONE px-area short of minBboxPx (127×129 = 16383) ⇒ null even at a huge ratio', () => {
    expect(
      interiorTransparencyFinding('r.png', { w: 256, h: 256 }, DEFAULT_THRESHOLDS,
        shape({ bboxW: 127, bboxH: 129, interiorTransparent: 16000 })),
    ).toBeNull();
  });

  it('ratio boundary is inclusive: exactly minRatio (12288/20480 = 0.6) fires; one px below ⇒ null', () => {
    const at = interiorTransparencyFinding('r.png', { w: 256, h: 256 }, DEFAULT_THRESHOLDS,
      shape({ bboxW: 128, bboxH: 160, interiorTransparent: 12288 }))!;
    expect(at).not.toBeNull();
    expect(at.params).toMatchObject({ ratioPct: 60, px: 12288 });
    expect(
      interiorTransparencyFinding('r.png', { w: 256, h: 256 }, DEFAULT_THRESHOLDS,
        shape({ bboxW: 128, bboxH: 160, interiorTransparent: 12287 })),
    ).toBeNull();
  });

  it('absent config ⇒ null (browser-only gate, NOT in resolveThresholds); absent shape ⇒ null (CLI/headless)', () => {
    const cfgNo = { ...DEFAULT_THRESHOLDS };
    delete cfgNo.interiorTransparency;
    expect(interiorTransparencyFinding('r.png', { w: 256, h: 256 }, cfgNo, shape())).toBeNull();
    expect(interiorTransparencyFinding('r.png', { w: 256, h: 256 }, DEFAULT_THRESHOLDS, undefined)).toBeNull();
  });

  it('analyze threads alphaShape to a LOOSE image ⇒ finding; solid images are solid-fill\'s (de-overlap)', async () => {
    // ratio 0.75 (12288/16384) — above the corpus-recalibrated 0.6 floor (the old 0.5 default sat below it).
    const feats: ImageFeatures[] = [{ assetRef: 'ring.png', contentHash: 'h1', alphaShape: shape({ interiorTransparent: 12288 }) }];
    const report = await analyze([looseImg('ring.png', 256, 256)], undefined, { features: feats });
    const it_ = report.findings.find((f) => f.rule === 'interior-transparency');
    expect(it_?.assetRef).toBe('ring.png');
    expect(it_?.severity).toBe('info');
    expect(it_?.estimate).toBeUndefined();
    // solid:true ⇒ solid-fill owns the image; interior-transparency never fires beside it.
    const solidRep = await analyze([looseImg('ring.png', 1024, 1024)], undefined, {
      features: [{ assetRef: 'ring.png', contentHash: 'h1', solid: true, alphaShape: shape({ interiorTransparent: 12288 }) }],
    });
    expect(solidRep.findings.find((f) => f.rule === 'solid-fill')).toBeDefined();
    expect(solidRep.findings.find((f) => f.rule === 'interior-transparency')).toBeUndefined();
  });

  it('analyze NEVER fires interior-transparency for an ATLAS (loose-only), and no total ever moves', async () => {
    const atlasAsset: Asset = {
      kind: 'atlas',
      atlas: {
        name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 },
        sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
        source: { kind: 'pixi' },
      },
      image: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 10000 },
    };
    const rep = await analyze([atlasAsset], undefined, {
      features: [{ assetRef: 'sheet.png', contentHash: 'h', alphaShape: shape() }],
    });
    expect(rep.findings.find((f) => f.rule === 'interior-transparency')).toBeUndefined();
    // potentialDiskSaved (and every total) identical with and without the feature — NO estimate exists.
    const assets = [looseImg('ring.png', 256, 256)];
    const withF = await analyze(assets, undefined, { features: [{ assetRef: 'ring.png', contentHash: 'h', alphaShape: shape() }] });
    const without = await analyze(assets, undefined, { features: [{ assetRef: 'ring.png', contentHash: 'h' }] });
    expect(withF.totals).toEqual(without.totals);
    expect(withF.totals.potentialDiskSaved).toBe(without.totals.potentialDiskSaved);
  });
});

describe('binary-alpha (every alpha byte exactly 0 or 255 — 1-bit channel disclosure, NO estimate)', () => {
  // DEFAULT gate: { minEdgePx: 128 } (config.ts). Fully-opaque is wasted-alpha's case (de-overlap);
  // fully-transparent yields no alphaShape at all (the scan returns null there).
  type Shape = NonNullable<ImageFeatures['alphaShape']>;
  const shape = (over: Partial<Shape> = {}): Shape => ({
    bboxW: 100, bboxH: 100, interiorTransparent: 0, binaryAlpha: true, opaqueCount: 10000, ...over,
  });
  const looseImg = (name: string, w: number, h: number): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 10000 },
  });

  it('a binary-alpha cutout at EXACTLY minEdgePx (longest edge 128) ⇒ info, NO estimate, params pinned', () => {
    // opaqueCount 4000 < 128·64 = 8192 so the fully-opaque de-overlap gate stays out of this boundary test.
    const f = binaryAlphaFinding('cutout.png', { w: 128, h: 64 }, DEFAULT_THRESHOLDS, shape({ opaqueCount: 4000 }))!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('binary-alpha');
    expect(f.messageKey).toBe('binary-alpha');
    expect(f.severity).toBe('info'); // ALWAYS info — an exact fact disclosed without a byte claim
    expect(f.estimate).toBeUndefined(); // NO estimate — a 1-bit re-encode is not measurable in-browser (Inv 3/5)
    expect(f.params).toEqual({ w: 128, h: 64 });
  });

  it('longest edge one px below minEdgePx (127) ⇒ null (tiny icons\' alpha depth is irrelevant)', () => {
    expect(binaryAlphaFinding('i.png', { w: 127, h: 64 }, DEFAULT_THRESHOLDS, shape())).toBeNull();
  });

  it('non-binary alpha ⇒ null; fully-opaque (opaqueCount = w·h) ⇒ null (wasted-alpha owns that case)', () => {
    expect(binaryAlphaFinding('s.png', { w: 256, h: 256 }, DEFAULT_THRESHOLDS, shape({ binaryAlpha: false }))).toBeNull();
    expect(
      binaryAlphaFinding('o.png', { w: 100, h: 100 }, DEFAULT_THRESHOLDS, shape({ opaqueCount: 100 * 100 })),
    ).toBeNull();
  });

  it('absent config ⇒ null (browser-only gate, NOT in resolveThresholds); absent shape ⇒ null (CLI/headless)', () => {
    const cfgNo = { ...DEFAULT_THRESHOLDS };
    delete cfgNo.binaryAlpha;
    expect(binaryAlphaFinding('c.png', { w: 256, h: 256 }, cfgNo, shape())).toBeNull();
    expect(binaryAlphaFinding('c.png', { w: 256, h: 256 }, DEFAULT_THRESHOLDS, undefined)).toBeNull();
  });

  it('analyze threads alphaShape to a LOOSE image ⇒ finding; solid/opaque refs are de-overlapped away', async () => {
    const rep = await analyze([looseImg('cutout.png', 256, 256)], undefined, {
      features: [{ assetRef: 'cutout.png', contentHash: 'h', alphaShape: shape() }],
    });
    const ba = rep.findings.find((f) => f.rule === 'binary-alpha');
    expect(ba?.assetRef).toBe('cutout.png');
    expect(ba?.severity).toBe('info');
    expect(ba?.estimate).toBeUndefined();
    // solid:true ⇒ solid-fill owns the ref ⇒ binary-alpha suppressed at the analyze gate.
    const solidRep = await analyze([looseImg('cutout.png', 1024, 1024)], undefined, {
      features: [{ assetRef: 'cutout.png', contentHash: 'h', solid: true, alphaShape: shape() }],
    });
    expect(solidRep.findings.find((f) => f.rule === 'binary-alpha')).toBeUndefined();
    // opaque:true ⇒ wasted-alpha owns the ref ⇒ binary-alpha suppressed at the analyze gate. (The shape is
    // deliberately contradictory — opaqueCount < w·h beside opaque:true — to isolate the ANALYZE-level gate
    // from the rule's own opaqueCount de-overlap, which the unit test above already pins.)
    const opaqueRep = await analyze([looseImg('cutout.png', 256, 256)], undefined, {
      features: [{ assetRef: 'cutout.png', contentHash: 'h', opaque: true, alphaShape: shape() }],
    });
    expect(opaqueRep.findings.find((f) => f.rule === 'binary-alpha')).toBeUndefined();
  });

  it('analyze NEVER fires binary-alpha for an ATLAS (loose-only), and potentialDiskSaved never moves', async () => {
    const atlasAsset: Asset = {
      kind: 'atlas',
      atlas: {
        name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 },
        sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 32, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 32, h: 32 } }],
        source: { kind: 'pixi' },
      },
      image: { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 10000 },
    };
    const rep = await analyze([atlasAsset], undefined, {
      features: [{ assetRef: 'sheet.png', contentHash: 'h', alphaShape: shape() }],
    });
    expect(rep.findings.find((f) => f.rule === 'binary-alpha')).toBeUndefined();
    // With and without the feature the totals are IDENTICAL — neither disclosure carries any estimate.
    const assets = [looseImg('cutout.png', 256, 256)];
    const withF = await analyze(assets, undefined, { features: [{ assetRef: 'cutout.png', contentHash: 'h', alphaShape: shape() }] });
    const without = await analyze(assets, undefined, { features: [{ assetRef: 'cutout.png', contentHash: 'h' }] });
    expect(withF.totals).toEqual(without.totals);
    expect(withF.findings.filter((f) => f.rule !== 'binary-alpha' && f.rule !== 'interior-transparency')).toEqual(without.findings);
  });
});

describe('gpu-compression-alignment (4px block alignment, header-only folder disclosure)', () => {
  const looseImg = (name: string, w: number, h: number): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 10000 },
  });
  const atlasAsset = (name: string, w: number, h: number): Asset => ({
    kind: 'atlas',
    atlas: {
      name, imageRef: name, size: { w, h }, source: { kind: 'pixi' },
      sprites: [{ name: 's0', frame: { x: 0, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, sourceSize: { w: 16, h: 16 } }],
    },
    image: { name, imageRef: name, size: { w, h }, mime: 'image/png', byteSize: 10000 },
  });

  it('fires at exactly minTextures misaligned textures — info, folder, NO estimate, sorted refs', () => {
    const f = gpuCompressionAlignmentFinding(
      [looseImg('z_odd.png', 130, 64), looseImg('a_odd.png', 64, 66), looseImg('clean.png', 64, 64)],
      DEFAULT_THRESHOLDS,
    )!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('gpu-compression-alignment');
    expect(f.messageKey).toBe('gpu-compression-alignment');
    expect(f.scope).toBe('folder');
    expect(f.severity).toBe('info');
    expect(f.estimate).toBeUndefined(); // alignment fact only — never a predicted footprint (Inv 3)
    expect(f.relatedRefs).toEqual(['a_odd.png', 'z_odd.png']); // sorted, deterministic
    expect(f.assetRef).toBe('a_odd.png');
    expect(f.params).toEqual({ n: 2, refs: 'a_odd.png, z_odd.png' });
  });

  it('does NOT fire at minTextures-1; %4-clean sizes (incl. POT) never counted', () => {
    expect(
      gpuCompressionAlignmentFinding([looseImg('one.png', 130, 64), looseImg('pot.png', 1024, 1024)], DEFAULT_THRESHOLDS),
    ).toBeNull();
    expect(
      gpuCompressionAlignmentFinding([looseImg('a.png', 512, 256), looseImg('b.png', 4100, 1024)], DEFAULT_THRESHOLDS),
    ).toBeNull(); // 4100 % 4 === 0 — clean
  });

  it('counts BOTH loose images and atlas PAGE images (block compression applies to any texture)', () => {
    const f = gpuCompressionAlignmentFinding(
      [atlasAsset('sheet.png', 1025, 512), looseImg('odd.png', 30, 30)],
      DEFAULT_THRESHOLDS,
    )!;
    expect(f.relatedRefs).toEqual(['odd.png', 'sheet.png']);
  });

  it('height misalignment alone counts; absent config => null (CLI byte-identical)', () => {
    const f = gpuCompressionAlignmentFinding(
      [looseImg('a.png', 64, 66), looseImg('b.png', 64, 130)],
      DEFAULT_THRESHOLDS,
    )!;
    expect(f.params).toMatchObject({ n: 2 });
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.gpuCompression;
    expect(gpuCompressionAlignmentFinding([looseImg('a.png', 64, 66), looseImg('b.png', 64, 130)], cfg)).toBeNull();
  });

  it('analyze surfaces it without features and it never shifts totals', async () => {
    const assets = [looseImg('a_odd.png', 130, 64), looseImg('b_odd.png', 64, 66)];
    const report = await analyze(assets, undefined, { encodeImage: async () => 9999 });
    const f = report.findings.find((x) => x.rule === 'gpu-compression-alignment');
    expect(f?.relatedRefs).toEqual(['a_odd.png', 'b_odd.png']);
    const clean = await analyze([looseImg('a.png', 128, 64), looseImg('b.png', 64, 64)], undefined, { encodeImage: async () => 9999 });
    expect(clean.findings.find((x) => x.rule === 'gpu-compression-alignment')).toBeUndefined();
    expect(report.totals.potentialDiskSaved).toBe(clean.totals.potentialDiskSaved);
  });
});

describe('excessive-gutter (over-padded packing, per-atlas disclosure)', () => {
  const row = (name: string, n: number, step: number, w = 64): Atlas => ({
    name, imageRef: name, size: { w: 2048, h: 128 }, source: { kind: 'pixi' },
    sprites: Array.from({ length: n }, (_, i) => ({
      name: `s${i}`, frame: { x: i * step, y: 0, w, h: 64 }, rotated: false, trimmed: false, sourceSize: { w, h: 64 },
    })),
  });

  it('a 5-frame row with uniform 16px gaps fires — info, NO estimate, median + gap count pinned', () => {
    const f = gutterFinding(row('padded.png', 5, 80), DEFAULT_THRESHOLDS)!;
    expect(f).not.toBeNull();
    expect(f.rule).toBe('excessive-gutter');
    expect(f.messageKey).toBe('excessive-gutter');
    expect(f.severity).toBe('info');
    expect(f.estimate).toBeUndefined(); // packing disclosure — the repack receipt measures reclaim (Inv 3)
    expect(f.params).toEqual({ median: 16, n: 4 }); // last frame has no right/below neighbour — honest skip
  });

  it('a tightly packed row (0px gaps) never fires — touching frames pull the median to 0', () => {
    expect(gutterFinding(row('tight.png', 6, 64), DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('median below minMedianPx (2px standard padding) never fires', () => {
    expect(gutterFinding(row('normal.png', 6, 66), DEFAULT_THRESHOLDS)).toBeNull(); // 2px gaps
  });

  it('fewer than minGaps measured gaps never fires (a 2-frame strip is not a pattern)', () => {
    expect(gutterFinding(row('two.png', 2, 96), DEFAULT_THRESHOLDS)).toBeNull(); // 1 gap < minGaps 4
  });

  it('lower median on an even count is deterministic; aliased identical rects collapse to one region', () => {
    // Gaps 8,8,16,16 -> lower median (index 1) = 8 => fires at exactly the floor.
    const a: Atlas = {
      name: 'mixed.png', imageRef: 'mixed.png', size: { w: 1024, h: 256 }, source: { kind: 'pixi' },
      sprites: [
        { name: 'a', frame: { x: 0, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } },
        { name: 'a-alias', frame: { x: 0, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } },
        { name: 'b', frame: { x: 72, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } }, // 8px after a
        { name: 'c', frame: { x: 144, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } }, // 8px after b
        { name: 'd', frame: { x: 224, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } }, // 16px after c
        { name: 'e', frame: { x: 304, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } }, // 16px after d
      ],
    };
    const f = gutterFinding(a, DEFAULT_THRESHOLDS)!;
    expect(f.params).toEqual({ median: 8, n: 4 });
  });

  it('absent config => null (CLI byte-identical); analyze surfaces it per-atlas and totals never shift', async () => {
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.gutter;
    expect(gutterFinding(row('padded.png', 5, 80), cfg)).toBeNull();
    const asset: Asset = {
      kind: 'atlas',
      atlas: row('padded.png', 5, 80),
      image: { name: 'padded.png', imageRef: 'padded.png', size: { w: 2048, h: 128 }, mime: 'image/png', byteSize: 10000 },
    };
    const withG = await analyze([asset], undefined, { encodeImage: async () => 999999 });
    expect(withG.findings.find((x) => x.rule === 'excessive-gutter')?.assetRef).toBe('padded.png');
    const withoutG = await analyze([asset], cfg, { encodeImage: async () => 999999 });
    expect(withoutG.findings.find((x) => x.rule === 'excessive-gutter')).toBeUndefined();
    expect(withG.totals.potentialDiskSaved).toBe(withoutG.totals.potentialDiskSaved);
  });
});

describe('folder-disclosure refs preview cap (corpus-driven: 387/414 misaligned would have joined 387 names)', () => {
  const looseImg = (name: string): Asset => ({
    kind: 'image',
    image: { name, imageRef: name, size: { w: 30, h: 30 }, mime: 'image/png', byteSize: 1000 },
  });
  it('gpu-compression-alignment prose lists 10 + a locale-neutral count; relatedRefs stays FULL', () => {
    const assets = Array.from({ length: 13 }, (_, i) => looseImg(`t${String(i).padStart(2, '0')}.png`));
    const f = gpuCompressionAlignmentFinding(assets, DEFAULT_THRESHOLDS)!;
    expect(f.relatedRefs).toHaveLength(13); // the UI source of truth is never truncated
    expect(f.params!.refs).toBe(
      't00.png, t01.png, t02.png, t03.png, t04.png, t05.png, t06.png, t07.png, t08.png, t09.png … (+3)',
    );
    expect(f.detail).toContain('… (+3)');
  });
});

describe('excessive-gutter OVERLAY strips (V1 visualization — the measured gaps themselves)', () => {
  const row = (name: string, n: number, step: number, w = 64): Atlas => ({
    name, imageRef: name, size: { w: 2048, h: 128 }, source: { kind: 'pixi' },
    sprites: Array.from({ length: n }, (_, i) => ({
      name: `s${i}`, frame: { x: i * step, y: 0, w, h: 64 }, rotated: false, trimmed: false, sourceSize: { w, h: 64 },
    })),
  });

  it('5-frame row: 4 measured gaps ⇒ 4 gutter strips at the exact inter-frame air, sig-stable', () => {
    const f = gutterFinding(row('padded.png', 5, 80), DEFAULT_THRESHOLDS)!;
    expect(f.overlay).toEqual([{
      kind: 'gutter',
      rects: [
        { x: 64, y: 0, w: 16, h: 64 },
        { x: 144, y: 0, w: 16, h: 64 },
        { x: 224, y: 0, w: 16, h: 64 },
        { x: 304, y: 0, w: 16, h: 64 },
      ],
    }]);
    // sig-stability proof: the overlay is ADDITIVE — id/severity/messageKey/params byte-identical to before.
    expect(f.id).toBe('padded.png:excessive-gutter');
    expect(f.severity).toBe('info');
    expect(f.messageKey).toBe('excessive-gutter');
    expect(f.params).toEqual({ median: 16, n: 4 });
    expect(f.estimate).toBeUndefined();
  });

  it('tie (gx === gy === g) emits BOTH strips — both are genuinely measured equal minima', () => {
    // 2x3 grid of 64px frames with 16px gaps both ways (5 measurable gaps ≥ minGaps 4); the top-row
    // interior frames measure gx = gy = 16 — a genuine tie, BOTH strips are honest measurements.
    const fr = (x: number, y: number) =>
      ({ name: `f${x}_${y}`, frame: { x, y, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 } });
    const a: Atlas = {
      name: 'grid.png', imageRef: 'grid.png', size: { w: 256, h: 256 }, source: { kind: 'pixi' },
      sprites: [fr(0, 0), fr(80, 0), fr(160, 0), fr(0, 80), fr(80, 80), fr(160, 80)],
    };
    const f = gutterFinding(a, DEFAULT_THRESHOLDS)!;
    expect(f.params).toEqual({ median: 16, n: 5 }); // bottom-right frame has no right/below neighbour
    expect(f.overlay![0]!.rects).toEqual([
      { x: 64, y: 0, w: 16, h: 64 },
      { x: 144, y: 0, w: 16, h: 64 },
      { x: 0, y: 64, w: 64, h: 16 },
      { x: 80, y: 64, w: 64, h: 16 },
      { x: 160, y: 64, w: 64, h: 16 },
      { x: 64, y: 80, w: 16, h: 64 },
      { x: 144, y: 80, w: 16, h: 64 },
    ]);
  });

  it('no fire ⇒ no overlay anywhere; a tight row never carries a gutter overlay', () => {
    expect(gutterFinding(row('tight.png', 6, 64), DEFAULT_THRESHOLDS)).toBeNull();
  });
});

describe('spine-unreferenced-regions (paired-skeleton disclosure — trust-gated, NO estimate)', () => {
  const page = (name: string, sprites: [string, number][]): Atlas => ({
    name, imageRef: name, size: { w: 256, h: 256 }, source: { kind: 'spine' },
    sprites: sprites.map(([n, x]) => ({
      name: n, frame: { x, y: 0, w: 64, h: 64 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 64 },
    })),
  });
  const bind = (over: Partial<SpineSkeletonBinding> = {}): SpineSkeletonBinding => ({
    atlasRefs: ['a.png'], refNames: [], refPrefixes: [], skeletonRefs: ['a.json'], ...over,
  });

  it('discloses the unreferenced regions: info, NO estimate, real rects overlay, params pinned', () => {
    const a = page('a.png', [['head', 0], ['body', 80], ['fx_unused', 160]]);
    const fs = spineUnreferencedRegionsFindings([a], [bind({ refNames: ['head', 'body'] })], DEFAULT_THRESHOLDS);
    expect(fs).toHaveLength(1);
    const f = fs[0]!;
    expect(f.rule).toBe('spine-unreferenced-regions');
    expect(f.severity).toBe('info');
    expect(f.estimate).toBeUndefined(); // conditional disclosure — numbers ride params only (Inv 3)
    expect(f.overlay).toEqual([{ kind: 'dead-region', rects: [{ x: 160, y: 0, w: 64, h: 64 }] }]);
    expect(f.params).toEqual({
      dead: 1, total: 3, areaPx: 64 * 64, areaPct: Math.round(((64 * 64) / (256 * 256)) * 100),
      skeletons: 'a.json', names: 'fx_unused',
    });
  });

  it('PAIRING-TRUST gate: a mispaired skeleton (matched fraction below the floor) yields NO verdict at all', () => {
    const a = page('a.png', [['head', 0], ['body', 80], ['arm', 160]]);
    // Foreign skeleton references none of the three names ⇒ matched 0/3 < 0.5 ⇒ silence (never "all dead").
    expect(spineUnreferencedRegionsFindings([a], [bind({ refNames: ['other'] })], DEFAULT_THRESHOLDS)).toHaveLength(0);
  });

  it('sequence prefixes match name = prefix + digits (and ONLY digits)', () => {
    const a = page('a.png', [['fx_01', 0], ['fx_02', 80], ['fx_final', 160]]);
    const fs = spineUnreferencedRegionsFindings([a], [bind({ refPrefixes: ['fx_'] })], DEFAULT_THRESHOLDS);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.params!.names).toBe('fx_final'); // digits matched; a non-digit suffix did not
  });

  it('fully-referenced page ⇒ no finding; absent config / no bindings ⇒ no findings (CLI byte-identical)', () => {
    const a = page('a.png', [['head', 0]]);
    expect(spineUnreferencedRegionsFindings([a], [bind({ refNames: ['head'] })], DEFAULT_THRESHOLDS)).toHaveLength(0);
    const cfg = { ...DEFAULT_THRESHOLDS };
    delete cfg.spineUnreferencedRegions;
    expect(spineUnreferencedRegionsFindings([a], [bind()], cfg)).toHaveLength(0);
    expect(spineUnreferencedRegionsFindings([a], [], DEFAULT_THRESHOLDS)).toHaveLength(0);
  });

  it('analyze threads deps.spineBindings and totals never shift', async () => {
    const a = page('spine/hero.png', [['head', 0], ['fx_unused', 80]]);
    const asset: Asset = {
      kind: 'atlas', atlas: a,
      image: { name: 'spine/hero.png', imageRef: 'spine/hero.png', size: { w: 256, h: 256 }, mime: 'image/png', byteSize: 9000 },
    };
    const binding: SpineSkeletonBinding = {
      atlasRefs: ['spine/hero.png'], refNames: ['head'], refPrefixes: [], skeletonRefs: ['spine/hero.json'],
    };
    const withB = await analyze([asset], undefined, { spineBindings: [binding] });
    expect(withB.findings.find((x) => x.rule === 'spine-unreferenced-regions')?.assetRef).toBe('spine/hero.png');
    const withoutB = await analyze([asset], undefined, {});
    expect(withoutB.findings.find((x) => x.rule === 'spine-unreferenced-regions')).toBeUndefined();
    expect(withB.totals).toEqual(withoutB.totals);
  });
});
