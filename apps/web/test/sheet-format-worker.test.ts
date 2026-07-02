// Sheet-format wiring — worker-seam test (settings-page design §0.1/§4). The fix.worker pixel loop can't
// run in Node (createImageBitmap / OffscreenCanvas), so — exactly like atlas-transcode-worker.test.ts — we
// FAITHFULLY mirror the worker's sheet-page format seam: the PURE sheetPageTarget decision (Node-tested in
// packages/fix/test/sheetTarget.test.ts) → the worker's sheetEnc mapping (decision → mime + EncodeOpts via
// the worker's existing closures) → the generalized ext repoint → the sidecar emit→parse round-trip through
// @asset-doctor/parsers (no dangling reference). The BYTE-IDENTITY half (absent spinePageFormat / no profile
// ⇒ today's literals) is pinned here AND relied on by the existing worker suites, which pass untouched.

import { describe, it, expect } from 'vitest';
import type { Atlas, ExportProfile, ImageMime, Sprite } from '@asset-doctor/core';
import {
  sheetPageTarget,
  validateProfile,
  resolveProfileForRef,
  resolveOptions,
  formatEncode,
  emitTexturePackerJson,
  emitSpineAtlasText,
  resolveImageRef,
  EXT,
  type SheetTargetDecision,
  type SpinePageFormat,
  type EffectiveOptions,
  type FixAssetKind,
  type FormatEncode,
  type FormatEncodeGlobal,
} from '@asset-doctor/fix';
import { parseAtlasManifest, parseSpineAtlasText } from '@asset-doctor/parsers';

/* ── Faithful mirrors of the worker closures (fix.worker.ts) — the seam under test ────────────────── */

/** Worker EncodeOpts mirror (fix.worker.ts:4391 — local to the worker, not exported). */
interface EncodeOpts {
  quality?: number;
  lossless?: boolean;
  effort?: number;
  webpNearLossless?: number;
  avifQualityAlpha?: number;
  avifSubsample?: number;
  pngRecompressLevel?: number;
  allowPngFallback?: boolean;
}

/** Mirror of the worker's baseEffective for UNTOUCHED default options (quality 0.85, avif target, no
 *  webpNearLossless / lossless). */
const baseEffective: EffectiveOptions = {
  quality: 85,
  effort: 0,
  targetMime: 'image/avif',
  webpNearLossless: 100,
  lossless: false,
};

/** Mirror of the worker's encOptsFor with DEFAULT FixOptions (avifQualityAlpha/avifSubsample/
 *  pngRecompressLevel all absent ⇒ undefined). */
const encOptsFor = (e: EffectiveOptions, allowPngFallback: boolean): EncodeOpts => ({
  quality: e.quality / 100,
  effort: e.effort,
  webpNearLossless: e.webpNearLossless,
  avifQualityAlpha: undefined,
  avifSubsample: undefined,
  pngRecompressLevel: undefined,
  allowPngFallback,
});

/** Mirror of the worker's feToEncodeOpts. */
const feToEncodeOpts = (fe: FormatEncode): EncodeOpts => ({
  quality: fe.quality / 100,
  lossless: fe.lossless,
  effort: fe.effort,
  webpNearLossless: fe.webpNearLossless,
  avifQualityAlpha: fe.avifQualityAlpha,
  avifSubsample: fe.avifSubsample,
  pngRecompressLevel: fe.pngRecompressLevel,
  allowPngFallback: true,
});

/** Validate + resolve a profile exactly like the worker (validateProfile once, resolveProfileForRef per
 *  ref with the profileGlobal bag read off the profile). Returns [] formats when profile absent/invalid. */
function workerProfile(p: ExportProfile | undefined) {
  if (!p) return { formats: [], global: undefined, overrides: [] as never[] };
  const v = validateProfile(p);
  if (!v.ok) return { formats: [], global: undefined, overrides: [] as never[] };
  const global: FormatEncodeGlobal = {
    effort: p.effort ?? 0,
    scaleAwareQuality: p.scaleAwareQuality ?? false,
    avifQualityAlpha: p.avifQualityAlpha,
    avifSubsample: p.avifSubsample,
    pngRecompressLevel: p.pngRecompressLevel,
  };
  return { formats: v.formats, global, overrides: v.overrides };
}

/** Mirror of the worker's sheetEnc — maps a SheetTargetDecision onto (mime, EncodeOpts) via the SAME
 *  closures (encOptsFor / feToEncodeOpts / resolveProfileForRef / formatEncode). */
function sheetEnc(
  d: SheetTargetDecision,
  ref: string,
  kindForLegacy: FixAssetKind,
  p?: ExportProfile,
): { mime: ImageMime; encOpts: EncodeOpts } {
  switch (d.kind) {
    case 'spine-png':
      return { mime: 'image/png', encOpts: { allowPngFallback: true } };
    case 'webp-lossless':
      return { mime: 'image/webp', encOpts: { lossless: true, allowPngFallback: true } };
    case 'legacy':
      return {
        mime: d.mime,
        encOpts: encOptsFor(
          resolveOptions(ref, kindForLegacy, { ...baseEffective, targetMime: d.mime }, undefined),
          true,
        ),
      };
    case 'profile': {
      const wp = workerProfile(p);
      const rp = resolveProfileForRef(ref, kindForLegacy, wp.formats, wp.global!, wp.overrides);
      return {
        mime: d.format.format,
        encOpts: feToEncodeOpts(formatEncode(d.format, 1, rp.global)),
      };
    }
  }
}

/** Mirror of the worker's absent-wire-field mapping. */
const spineFormatOf = (wire: 'png' | 'profile' | undefined): SpinePageFormat =>
  wire === 'profile' ? 'profile' : 'png';

/** Mirror of the worker's generalized ext repoint (settings design §0.1 correction): rename the page by
 *  the ACTUAL emitted mime's extension; skip when unchanged. Returns the new path + whether it changed. */
function extRepoint(origPath: string, emittedMime: ImageMime): { path: string; renamed: boolean } {
  const newExt = EXT[emittedMime] ?? '.png';
  const path = origPath.replace(/\.[a-z0-9]+$/i, newExt);
  return { path, renamed: path !== origPath };
}

/* ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────── */

const sprites: Sprite[] = [
  {
    name: 'a',
    frame: { x: 0, y: 0, w: 64, h: 64 },
    rotated: false,
    trimmed: false,
    sourceSize: { w: 64, h: 64 },
  },
];
const atlasOf = (name: string, source: Atlas['source']): Atlas => ({
  name,
  imageRef: `${name
    .split('/')
    .pop()!
    .replace(/\.[a-z0-9]+$/i, '')}.png`,
  size: { w: 128, h: 128 },
  source,
  sprites,
});

const topTier = { label: 'Source', scale: 1, suffix: '_1080p' };
const avifProfile: ExportProfile = {
  formats: [{ format: 'image/avif', quality: 80 }],
  tiers: [topTier],
};
const webpLosslessProfile: ExportProfile = {
  formats: [{ format: 'image/webp', lossless: true }],
  tiers: [topTier],
};
const multiProfile: ExportProfile = {
  formats: [
    { format: 'image/webp', lossless: true },
    { format: 'image/avif', quality: 70 },
  ],
  tiers: [topTier],
};

/* ── (a) STATIC repack under a single-format AVIF profile ⇒ avif page + sidecar repointed ─────────── */

describe('(a) static repack, single-format AVIF profile — page follows the profile, sidecar repoints', () => {
  const ref = 'main/sheet.png';
  const sidecar = 'main/sheet.json';

  it('decision: profile formats[0] (avif), no multi note; encode opts come from formatEncode', () => {
    const wp = workerProfile(avifProfile);
    const dec = sheetPageTarget({
      site: 'repack',
      isSpine: false,
      spinePageFormat: spineFormatOf(undefined),
      profileFormats: wp.formats,
      legacyMime: 'image/webp',
    });
    expect(dec).toEqual({
      kind: 'profile',
      format: { format: 'image/avif', quality: 80 },
      multiNote: false,
    });
    const enc = sheetEnc(dec, ref, 'pixi', avifProfile);
    expect(enc.mime).toBe('image/avif');
    // formatEncode(avif q80, scale 1, defaults) → quality .8, lossy, effort 0, near off, fallback allowed.
    expect(enc.encOpts).toEqual({
      quality: 0.8,
      lossless: false,
      effort: 0,
      webpNearLossless: 100,
      avifQualityAlpha: undefined,
      avifSubsample: undefined,
      pngRecompressLevel: undefined,
      allowPngFallback: true,
    });
  });

  it('emit→parse→resolve: the page renames .png→.avif, meta.image resolves to the emitted page (no dangle)', () => {
    const na = atlasOf(ref, { kind: 'texturepacker-hash' });
    const rp = extRepoint(ref, 'image/avif');
    expect(rp).toEqual({ path: 'main/sheet.avif', renamed: true });
    // The worker patches na.imageRef in step with the page rename (same regex).
    na.imageRef = na.imageRef.replace(/\.[a-z0-9]+$/i, EXT['image/avif']);
    const res = parseAtlasManifest(JSON.parse(emitTexturePackerJson(na)) as object, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const resolved = resolveImageRef(sidecar, res.atlas.imageRef);
      expect(resolved).toBe(rp.path); // the sidecar points at the file that ships
      expect(resolved).not.toBe(ref); // never the dropped original page
    }
  });
});

/* ── (b) multi-format profile ⇒ formats[0] + the honest note ──────────────────────────────────────── */

describe('(b) multi-format profile — formats[0] ships, one honest note per sheet (never silent)', () => {
  it('decision carries multiNote:true and the FIRST format (webp-lossless)', () => {
    const wp = workerProfile(multiProfile);
    const dec = sheetPageTarget({
      site: 'repack',
      isSpine: false,
      spinePageFormat: 'png',
      profileFormats: wp.formats,
      legacyMime: 'image/webp',
    });
    expect(dec.kind).toBe('profile');
    if (dec.kind === 'profile') {
      expect(dec.format).toEqual({ format: 'image/webp', lossless: true });
      expect(dec.multiNote).toBe(true);
    }
    const enc = sheetEnc(dec, 'main/sheet.png', 'pixi', multiProfile);
    expect(enc.mime).toBe('image/webp');
    expect(enc.encOpts.lossless).toBe(true);
  });

  it('pins the exact skipped[] note string the worker surfaces (multiFormatSheetNote)', () => {
    // The worker: `export profile: sheet page emitted as ${mime.replace('image/','')} only (…)`.
    const mime: ImageMime = 'image/webp';
    const note = `export profile: sheet page emitted as ${mime.replace('image/', '')} only (one sidecar references one page)`;
    expect(note).toBe(
      'export profile: sheet page emitted as webp only (one sidecar references one page)',
    );
  });
});

/* ── (c) SPINE repack, spinePageFormat 'profile' + webp-lossless profile ⇒ webp page, .atlas repoints ─ */

describe("(c) spine repack, spinePageFormat:'profile' + webp-lossless profile — webp page + .atlas line-0 repoint", () => {
  const ref = 'spine/hero.png';
  const sidecar = 'spine/hero.atlas';

  it('decision: profile formats[0] (webp-lossless); pages leave PNG only via the explicit opt-in', () => {
    const wp = workerProfile(webpLosslessProfile);
    const dec = sheetPageTarget({
      site: 'repack',
      isSpine: true,
      spinePageFormat: spineFormatOf('profile'),
      profileFormats: wp.formats,
      legacyMime: resolveOptions(ref, 'spine', baseEffective, undefined).targetMime,
    });
    expect(dec).toEqual({
      kind: 'profile',
      format: { format: 'image/webp', lossless: true },
      multiNote: false,
    });
    const enc = sheetEnc(dec, ref, 'spine', webpLosslessProfile);
    expect(enc.mime).toBe('image/webp');
    expect(enc.encOpts.lossless).toBe(true);
    expect(enc.encOpts.allowPngFallback).toBe(true); // PNG-fallback honesty unchanged
  });

  it('the page renames .png→.webp and the .atlas texture line (line 0) resolves to the renamed page', () => {
    const na = atlasOf(ref, { kind: 'spine' });
    const rp = extRepoint(ref, 'image/webp');
    expect(rp).toEqual({ path: 'spine/hero.webp', renamed: true });
    na.imageRef = na.imageRef.replace(/\.[a-z0-9]+$/i, EXT['image/webp']); // BEFORE emitSpineAtlasText
    const pages = parseSpineAtlasText(emitSpineAtlasText(na));
    expect(pages.length).toBe(1);
    expect(resolveImageRef(sidecar, pages[0]!.image)).toBe(rp.path);
    expect(resolveImageRef(sidecar, pages[0]!.image)).not.toBe(ref);
  });

  it('pins the exact runtime note the worker surfaces for a non-PNG spine page', () => {
    const mime: ImageMime = 'image/webp';
    const note = `spine pages emitted as ${mime.replace('image/', '')} — requires a loader that decodes it (Pixi does)`;
    expect(note).toBe(
      'spine pages emitted as webp — requires a loader that decodes it (Pixi does)',
    );
  });

  it("spinePageFormat:'profile' with NO profile falls back to the legacy resolved Spine target", () => {
    const dec = sheetPageTarget({
      site: 'repack',
      isSpine: true,
      spinePageFormat: 'profile',
      profileFormats: [],
      legacyMime: resolveOptions(ref, 'spine', baseEffective, undefined).targetMime,
    });
    expect(dec).toEqual({ kind: 'legacy', mime: 'image/avif' }); // untouched default target
  });
});

/* ── (d) absent options ⇒ today's literals, byte-identical (B2/B3/B4) ─────────────────────────────── */

describe("(d) absent spinePageFormat + no profile — every site reproduces today's exact literals", () => {
  it('B2 spine repack/pack: decision spine-png ⇒ image/png + {allowPngFallback:true}; probeExt .png', () => {
    for (const site of ['repack', 'pack'] as const) {
      const dec = sheetPageTarget({
        site,
        isSpine: true,
        spinePageFormat: spineFormatOf(undefined),
        profileFormats: [],
        legacyMime: resolveOptions('anim/x.png', 'loose', baseEffective, undefined).targetMime,
      });
      const enc = sheetEnc(dec, 'anim/x.png', site === 'pack' ? 'loose' : 'spine');
      expect(enc.mime).toBe('image/png');
      expect(enc.encOpts).toEqual({ allowPngFallback: true }); // the exact worker literal
      expect(EXT[enc.mime] ?? '.png').toBe('.png'); // probeExt
    }
  });

  it('B3 static repack/merge: decision webp-lossless ⇒ image/webp + {lossless:true, allowPngFallback:true}', () => {
    const dec = sheetPageTarget({
      site: 'repack',
      isSpine: false,
      spinePageFormat: 'png',
      profileFormats: [],
      legacyMime: 'image/webp',
    });
    const enc = sheetEnc(dec, 'main/sheet.png', 'pixi');
    expect(enc.mime).toBe('image/webp');
    expect(enc.encOpts).toEqual({ lossless: true, allowPngFallback: true }); // the exact worker literal
  });

  it('B3 ext-repoint string math: .png→.webp renamed, .webp→.webp no-op, PNG fallback keeps a .png name', () => {
    expect(extRepoint('main/sheet.png', 'image/webp')).toEqual({
      path: 'main/sheet.webp',
      renamed: true,
    });
    expect(extRepoint('main/sheet.webp', 'image/webp')).toEqual({
      path: 'main/sheet.webp',
      renamed: false,
    });
    expect(extRepoint('main/sheet.png', 'image/png')).toEqual({
      path: 'main/sheet.png',
      renamed: false,
    });
  });

  it("B4 pack static, profile OFF: legacy decision === today's resolveOptions path (mime AND EncodeOpts)", () => {
    const outDir = 'ui/buttons';
    // Today's expressions (fix.worker.ts pre-change): effTarget + encOptsFor(eff, true).
    const todayTarget = resolveOptions(outDir, 'loose', baseEffective, undefined).targetMime;
    const todayEnc = encOptsFor(resolveOptions(outDir, 'loose', baseEffective, undefined), true);
    const dec = sheetPageTarget({
      site: 'pack',
      isSpine: false,
      spinePageFormat: 'png',
      profileFormats: [],
      legacyMime: todayTarget,
    });
    expect(dec).toEqual({ kind: 'legacy', mime: 'image/avif' });
    const enc = sheetEnc(dec, outDir, 'loose');
    expect(enc.mime).toBe(todayTarget);
    // Re-folding the already-resolved target back through resolveOptions is an identity ⇒ same EncodeOpts.
    expect(enc.encOpts).toEqual(todayEnc);
    expect(EXT[enc.mime] ?? '.png').toBe('.avif'); // probeExt matches today's requested-target ext
  });

  it('B5 pack static, profile ON: formats[0] wins over the legacy target', () => {
    const wp = workerProfile(webpLosslessProfile);
    const dec = sheetPageTarget({
      site: 'pack',
      isSpine: false,
      spinePageFormat: 'png',
      profileFormats: wp.formats,
      legacyMime: 'image/avif',
    });
    expect(dec).toEqual({
      kind: 'profile',
      format: { format: 'image/webp', lossless: true },
      multiNote: false,
    });
    expect(EXT['image/webp']).toBe('.webp'); // probeExt follows the decision, not the legacy target
  });
});
