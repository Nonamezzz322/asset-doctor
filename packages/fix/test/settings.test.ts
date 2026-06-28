// Settings helpers (design §10.11–10.12) + worker-level dedup seams (design §10.7–10.10).
//
// packages/fix is PURE (no DOM/canvas), and the worker's owner-aware dedup execution lives inside the
// fix.worker runFix loop (OffscreenCanvas-bound, not Node-importable). Per design §10, for the parts
// that need the worker/canvas we test the PURE SEAM and note it:
//   §10.7  meta.image repoint round-trips through @asset-doctor/parsers parseAtlas — exercised against
//          the REAL emitTexturePackerJson + parseAtlas, with the worker's relativeImageRef/resolveImageRef
//          pure string seam mirrored verbatim (the worker keeps these private; they are pure functions).
//   §10.8  transcoded-owner final-name resolution — modelled as the worker's ownerFinalName derivation
//          (a deterministic function of op kind + target mime) and asserted via the round-trip.
//   §10.9  loose-repath gating — the pure KEEP-vs-rewrite decision predicate + the looseRepathSkipped count.
//   §10.10 VRAM honesty receipt split — the pure accounting: real dedupDiskBytesSaved vs upper-bound
//          dedupVramBytesSavedUpperBound, never folded into the hard vramBytesAfter.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Atlas, ImageMime } from '@asset-doctor/core';
import { parseAtlas, parseAtlasManifest } from '@asset-doctor/parsers';
import {
  DEFAULT_FORMAT_QUALITY,
  emitTexturePackerJson,
  formatEncode,
  resolveOptions,
  resolveProfileForRef,
  scaleAwareQuality,
  SCALE_QUALITY_FLOOR,
  type EffectiveOptions,
  type FormatEncodeGlobal,
  type ProfileOverride,
} from '../src/index';
import type { FormatTarget } from '@asset-doctor/core';

const globalKnobs = { effort: 0, scaleAwareQuality: false } as const;

// ── §10.11 scaleAwareQuality ────────────────────────────────────────────────────────────────────
describe('scaleAwareQuality (§10.11)', () => {
  it('scaleAwareQuality(90, 0.5, true) === 65', () => {
    // 90 - round((1 - 0.5) * 50) = 90 - 25 = 65.
    expect(scaleAwareQuality(90, 0.5, true)).toBe(65);
  });

  it('clamps at the floor on a heavy downscale', () => {
    // 60 - round((1 - 0.1) * 50) = 60 - 45 = 15 → clamped up to the floor (50).
    expect(scaleAwareQuality(60, 0.1, true)).toBe(SCALE_QUALITY_FLOOR);
    expect(SCALE_QUALITY_FLOOR).toBe(50);
    // an extreme downscale of a high base still floors, never below.
    expect(scaleAwareQuality(100, 0.01, true)).toBe(SCALE_QUALITY_FLOOR);
  });

  it('is identity when disabled or not downscaling (today\'s behavior)', () => {
    expect(scaleAwareQuality(90, 0.5, false)).toBe(90); // disabled ⇒ unchanged
    expect(scaleAwareQuality(80, 1, true)).toBe(80); // scale >= 1 ⇒ no reduction
    expect(scaleAwareQuality(80, 2, true)).toBe(80);
  });

  it('is deterministic integer math (no float drift)', () => {
    const q = scaleAwareQuality(85, 0.5, true); // 85 - 25 = 60
    expect(q).toBe(60);
    expect(Number.isInteger(q)).toBe(true);
  });
});

// ── §10.12 resolveOptions folder/type matching ──────────────────────────────────────────────────
describe('resolveOptions folder/type matching (§10.12)', () => {
  const base: EffectiveOptions = { quality: 80, effort: 0, targetMime: 'image/webp', webpNearLossless: 100, lossless: false };

  it('returns a copy of the base when no override matches', () => {
    const out = resolveOptions('ui/btn.png', 'pixi', base, [{ match: 'fx', quality: 40 }]);
    expect(out).toEqual(base);
    expect(out).not.toBe(base); // fresh object
  });

  it('threads lossless through from the base (B1) — FixOverride cannot set it in v1', () => {
    // A matching override leaves lossless untouched: it falls through from the base unchanged.
    const lossy = resolveOptions('ui/btn.png', 'pixi', base, [{ match: 'ui', quality: 50 }]);
    expect(lossy.lossless).toBe(false);
    // A base that IS lossless stays lossless across a matching override (no FixOverride.lossless field).
    const losslessBase: EffectiveOptions = { ...base, lossless: true };
    expect(resolveOptions('ui/btn.png', 'pixi', losslessBase, [{ match: 'ui', effort: 6 }]).lossless).toBe(true);
  });

  it('folder prefix matches the folder itself and anything nested under it', () => {
    const overrides = [{ match: 'ui', quality: 50 }];
    expect(resolveOptions('ui/btn.png', 'pixi', base, overrides).quality).toBe(50);
    expect(resolveOptions('ui/sub/btn.png', 'pixi', base, overrides).quality).toBe(50);
    // a prefix must be a full path segment, not a substring: 'uikit/...' is NOT under 'ui'.
    expect(resolveOptions('uikit/btn.png', 'pixi', base, overrides).quality).toBe(80);
    // an exact single-file path is also targetable directly.
    expect(resolveOptions('ui', 'pixi', base, overrides).quality).toBe(50);
  });

  it('type:* matches the asset kind, not a folder', () => {
    const overrides = [{ match: 'type:spine', targetMime: 'image/png' as ImageMime }];
    expect(resolveOptions('skel/page.png', 'spine', base, overrides).targetMime).toBe('image/png');
    expect(resolveOptions('skel/page.png', 'pixi', base, overrides).targetMime).toBe('image/webp');
    expect(resolveOptions('img.png', 'loose', base, [{ match: 'type:loose', effort: 6 }]).effort).toBe(6);
  });

  it('later overrides win (stable order, not "most specific"); only set fields override', () => {
    const overrides = [
      { match: 'ui', quality: 50, effort: 2 },
      { match: 'ui/btn.png', quality: 90 }, // later, wins on quality; leaves effort from the earlier one
    ];
    const out = resolveOptions('ui/btn.png', 'pixi', base, overrides);
    expect(out.quality).toBe(90); // later override wins
    expect(out.effort).toBe(2); // from the earlier matching override (not reset to base)
    expect(out.targetMime).toBe('image/webp'); // untouched ⇒ base
  });

  it('is deterministic: same inputs ⇒ deep-equal output', () => {
    const overrides = [{ match: 'ui', quality: 50 }, { match: 'type:pixi', effort: 3 }];
    const a = resolveOptions('ui/x.png', 'pixi', base, overrides);
    const b = resolveOptions('ui/x.png', 'pixi', base, overrides);
    expect(a).toEqual(b);
  });
});

// ── formatEncode (export profile §4b) ─────────────────────────────────────────────────────────────
describe('formatEncode (export profile §4b)', () => {
  it('webp lossy: defaults quality to DEFAULT_FORMAT_QUALITY, near off (100), not lossless', () => {
    const fe = formatEncode({ format: 'image/webp' }, 1, globalKnobs);
    expect(fe).toEqual({
      targetMime: 'image/webp',
      quality: DEFAULT_FORMAT_QUALITY,
      lossless: false,
      effort: 0,
      webpNearLossless: 100,
    });
  });

  it('webp lossless: lossless true, near forced off even if a near was given', () => {
    const fe = formatEncode({ format: 'image/webp', lossless: true, near: 40 }, 1, globalKnobs);
    expect(fe.lossless).toBe(true);
    expect(fe.webpNearLossless).toBe(100); // lossless wins over near
  });

  it('webp near-lossless: forwards near as webpNearLossless when not lossless', () => {
    const fe = formatEncode({ format: 'image/webp', near: 60 }, 1, globalKnobs);
    expect(fe.lossless).toBe(false);
    expect(fe.webpNearLossless).toBe(60);
  });

  it('png: lossless implied, quality irrelevant, webpNearLossless off, no avif knobs; forwards pngRecompressLevel', () => {
    const fe = formatEncode({ format: 'image/png', quality: 10 }, 1, { ...globalKnobs, pngRecompressLevel: 4 });
    expect(fe.targetMime).toBe('image/png');
    expect(fe.lossless).toBe(true);
    expect(fe.webpNearLossless).toBe(100);
    expect(fe.pngRecompressLevel).toBe(4);
    expect(fe.avifSubsample).toBeUndefined();
    expect(fe.avifQualityAlpha).toBeUndefined();
  });

  it('png plain: NO nativePng marker (byte-identical to today — additive omit)', () => {
    const fe = formatEncode({ format: 'image/png' }, 1, globalKnobs);
    expect(fe.targetMime).toBe('image/png');
    expect(fe.lossless).toBe(true);
    expect('nativePng' in fe).toBe(false); // omitted, never `false` — keeps the legacy shape exactly
  });

  it('png pngLossy: emits nativePng:true (still a lossless encode — pngquant re-compresses in-place later)', () => {
    const fe = formatEncode({ format: 'image/png', pngLossy: true }, 1, globalKnobs);
    expect(fe.targetMime).toBe('image/png');
    expect(fe.lossless).toBe(true); // the worker composes a lossless PNG; the pngquant post-pass re-encodes it
    expect(fe.nativePng).toBe(true);
  });

  it('avif: lossy only, forwards avif knobs, webpNearLossless off, no png knob', () => {
    const fe = formatEncode({ format: 'image/avif', quality: 70 }, 1, {
      ...globalKnobs,
      avifQualityAlpha: 80,
      avifSubsample: 3,
    });
    expect(fe.targetMime).toBe('image/avif');
    expect(fe.lossless).toBe(false);
    expect(fe.quality).toBe(70);
    expect(fe.avifQualityAlpha).toBe(80);
    expect(fe.avifSubsample).toBe(3);
    expect(fe.webpNearLossless).toBe(100);
    expect(fe.pngRecompressLevel).toBeUndefined();
  });

  it('folds scaleAwareQuality onto the format quality (floor 50) when downscaling', () => {
    // 90 - round((1 - 0.5) * 50) = 65, exactly as scaleAwareQuality.
    const fe = formatEncode({ format: 'image/webp', quality: 90 }, 0.5, { effort: 0, scaleAwareQuality: true });
    expect(fe.quality).toBe(scaleAwareQuality(90, 0.5, true));
    expect(fe.quality).toBe(65);
    // heavy downscale floors at SCALE_QUALITY_FLOOR.
    const floored = formatEncode({ format: 'image/avif', quality: 60 }, 0.1, { effort: 0, scaleAwareQuality: true });
    expect(floored.quality).toBe(SCALE_QUALITY_FLOOR);
  });

  it('scaleAwareQuality disabled ⇒ quality unchanged (today\'s behavior)', () => {
    const fe = formatEncode({ format: 'image/avif', quality: 85 }, 0.5, { effort: 0, scaleAwareQuality: false });
    expect(fe.quality).toBe(85);
  });

  it('threads global effort to every format', () => {
    expect(formatEncode({ format: 'image/webp' }, 1, { effort: 6, scaleAwareQuality: false }).effort).toBe(6);
    expect(formatEncode({ format: 'image/avif' }, 1, { effort: 6, scaleAwareQuality: false }).effort).toBe(6);
    expect(formatEncode({ format: 'image/png' }, 1, { effort: 6, scaleAwareQuality: false }).effort).toBe(6);
  });

  it('is deterministic: same inputs ⇒ deep-equal output', () => {
    const args = [{ format: 'image/webp' as const, quality: 75, near: 30 }, 0.75, { effort: 3, scaleAwareQuality: true }] as const;
    expect(formatEncode(...args)).toEqual(formatEncode(...args));
  });
});

// ── resolveProfileForRef (round10-profile-overrides.md §3) ──────────────────────────────────────────
describe('resolveProfileForRef (round10 profile overrides §3)', () => {
  const baseFormats: FormatTarget[] = [{ format: 'image/webp', quality: 80 }, { format: 'image/png' }];
  const baseGlobal: FormatEncodeGlobal = { effort: 2, scaleAwareQuality: false, avifQualityAlpha: 70 };

  it('no overrides ⇒ base returned BY REFERENCE (additivity anchor — byte-identical fan-out)', () => {
    const rp = resolveProfileForRef('fonts/title.png', 'loose', baseFormats, baseGlobal);
    expect(rp.formats).toBe(baseFormats); // SAME object, not a copy
    expect(rp.global).toBe(baseGlobal);
  });

  it('empty overrides[] ⇒ base by reference (no-op loop)', () => {
    const rp = resolveProfileForRef('fonts/title.png', 'loose', baseFormats, baseGlobal, []);
    expect(rp.formats).toBe(baseFormats);
    expect(rp.global).toBe(baseGlobal);
  });

  it('no MATCH ⇒ base by reference (identity), even with a non-empty override list', () => {
    const overrides: ProfileOverride[] = [{ match: 'fx', quality: 40 }];
    const rp = resolveProfileForRef('ui/btn.png', 'pixi', baseFormats, baseGlobal, overrides);
    expect(rp.formats).toBe(baseFormats);
    expect(rp.global).toBe(baseGlobal);
  });

  it('fonts → AVIF 4:4:4: formats REPLACE + avifSubsample merges onto global (the headline port)', () => {
    const overrides: ProfileOverride[] = [
      { match: 'fonts', formats: [{ format: 'image/avif', quality: 85 }], avifSubsample: 3 },
    ];
    const rp = resolveProfileForRef('fonts/title.png', 'loose', baseFormats, baseGlobal, overrides);
    expect(rp.formats).toEqual([{ format: 'image/avif', quality: 85 }]); // REPLACED
    expect(rp.formats).not.toBe(baseFormats); // a new list, base untouched
    expect(rp.global.avifSubsample).toBe(3); // merged (the 4:4:4 knob)
    expect(rp.global.effort).toBe(2); // untouched profile-global
    expect(rp.global.avifQualityAlpha).toBe(70); // profile-global preserved
    expect(rp.global).not.toBe(baseGlobal); // a fresh global, base untouched
    // a sibling ref outside fonts/ still gets the base by reference (override is scoped).
    expect(resolveProfileForRef('ui/btn.png', 'loose', baseFormats, baseGlobal, overrides).formats).toBe(baseFormats);
  });

  it('quality/near/lossless overlay per format; png is carved out (native lossless)', () => {
    const overrides: ProfileOverride[] = [{ match: 'ui', quality: 50, near: 60, lossless: true }];
    const rp = resolveProfileForRef('ui/btn.png', 'pixi', baseFormats, baseGlobal, overrides);
    // webp honors all three; png ignores all (carve-out).
    expect(rp.formats).toEqual([
      { format: 'image/webp', quality: 50, lossless: true, near: 60 },
      { format: 'image/png' },
    ]);
    expect(rp.formats[1]).toBe(baseFormats[1]); // png target returned by reference (no-op overlay)
  });

  it('avif carve-out: quality overlays but lossless/near are dropped (no faked-lossless, invariant 3)', () => {
    const avifBase: FormatTarget[] = [{ format: 'image/avif', quality: 80 }];
    const overrides: ProfileOverride[] = [{ match: 'fonts', quality: 60, lossless: true, near: 40 }];
    const rp = resolveProfileForRef('fonts/x.png', 'loose', avifBase, baseGlobal, overrides);
    expect(rp.formats).toEqual([{ format: 'image/avif', quality: 60 }]); // only quality; no lossless/near
  });

  it('effort merges onto the running global; scaleAwareQuality/qualityAlpha/png stay profile-global', () => {
    const g: FormatEncodeGlobal = { effort: 1, scaleAwareQuality: true, avifQualityAlpha: 50, pngRecompressLevel: 4 };
    const rp = resolveProfileForRef('fonts/x.png', 'loose', baseFormats, g, [{ match: 'fonts', effort: 6 }]);
    expect(rp.global).toEqual({
      effort: 6, // merged
      scaleAwareQuality: true, // profile-global
      avifQualityAlpha: 50, // profile-global
      avifSubsample: undefined,
      pngRecompressLevel: 4, // profile-global
    });
  });

  it('multiple matches: later wins on formats AND each scalar, field-by-field', () => {
    const overrides: ProfileOverride[] = [
      { match: 'fonts', formats: [{ format: 'image/webp', quality: 90 }], effort: 3, avifSubsample: 1 },
      { match: 'fonts/title.png', formats: [{ format: 'image/avif', quality: 70 }], avifSubsample: 3 }, // later wins
    ];
    const rp = resolveProfileForRef('fonts/title.png', 'loose', baseFormats, baseGlobal, overrides);
    expect(rp.formats).toEqual([{ format: 'image/avif', quality: 70 }]); // LAST formats wins
    expect(rp.global.effort).toBe(3); // from the earlier match (later one didn't set effort)
    expect(rp.global.avifSubsample).toBe(3); // LAST avifSubsample wins
  });

  it('first-set scalar persists when a later match omits it (only set fields override)', () => {
    const overrides: ProfileOverride[] = [
      { match: 'fonts', quality: 40 },
      { match: 'fonts/title.png', near: 55 }, // later match sets near only — quality stays 40
    ];
    const rp = resolveProfileForRef('fonts/title.png', 'pixi', baseFormats, baseGlobal, overrides);
    expect(rp.formats[0]).toEqual({ format: 'image/webp', quality: 40, near: 55 });
  });

  it('sibling-prefix: "fonts" never matches "fonts2" (full segment, not a substring)', () => {
    const overrides: ProfileOverride[] = [{ match: 'fonts', formats: [{ format: 'image/avif' }] }];
    expect(resolveProfileForRef('fonts2/title.png', 'loose', baseFormats, baseGlobal, overrides).formats).toBe(baseFormats);
    expect(resolveProfileForRef('fonts/title.png', 'loose', baseFormats, baseGlobal, overrides).formats).not.toBe(baseFormats);
  });

  it('match is case-SENSITIVE: "Fonts/title.png" is NOT matched by "fonts"', () => {
    const overrides: ProfileOverride[] = [{ match: 'fonts', quality: 30 }];
    expect(resolveProfileForRef('Fonts/title.png', 'loose', baseFormats, baseGlobal, overrides).formats).toBe(baseFormats);
  });

  it('type:* matches the asset kind, not a folder', () => {
    const overrides: ProfileOverride[] = [{ match: 'type:loose', avifSubsample: 3 }];
    expect(resolveProfileForRef('any/x.png', 'loose', baseFormats, baseGlobal, overrides).global.avifSubsample).toBe(3);
    // a pixi/atlas ref of a different kind is untouched (base by reference).
    expect(resolveProfileForRef('any/x.png', 'pixi', baseFormats, baseGlobal, overrides).global).toBe(baseGlobal);
  });

  it('is deterministic: same inputs ⇒ deep-equal output (double-call eq)', () => {
    const overrides: ProfileOverride[] = [
      { match: 'fonts', formats: [{ format: 'image/avif' }], avifSubsample: 3 },
      { match: 'type:loose', quality: 55 },
    ];
    const a = resolveProfileForRef('fonts/x.png', 'loose', baseFormats, baseGlobal, overrides);
    const b = resolveProfileForRef('fonts/x.png', 'loose', baseFormats, baseGlobal, overrides);
    expect(a).toEqual(b);
  });
});

// ── worker-level dedup seams (pure halves) ──────────────────────────────────────────────────────
// Mirror of the worker's PRIVATE pure path helpers (fix.worker.ts dirOf/normalize/relativeImageRef/
// resolveImageRef). The worker keeps these module-private; they are pure string functions, so the
// round-trip property they guarantee is exercised here against the REAL emit/parse. Kept byte-faithful.
const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
};
const normalize = (p: string): string => {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
};
const resolveImageRef = (manifestPath: string, img: string): string => normalize(dirOf(manifestPath) + img);
const relativeImageRef = (fromDir: string, toPath: string): string => {
  const from = normalize(fromDir).split('/').filter(Boolean);
  const to = normalize(toPath).split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => '..');
  const down = to.slice(i);
  const rel = [...up, ...down].join('/');
  return rel === '' ? (to[to.length - 1] ?? toPath) : rel;
};

const fixDir = fileURLToPath(new URL('../../../fixtures/sample-projects/raw-multifolder-dupes/', import.meta.url));
function loadConsumerAtlas(): Atlas {
  // extra/sheet.{png,json} is byte-identical to the owner main_game/sheet.{png,json} (fixture case h).
  const manifest = JSON.parse(readFileSync(`${fixDir}extra/sheet.json`, 'utf8')) as unknown;
  const bytes = new Uint8Array(readFileSync(`${fixDir}extra/sheet.png`));
  const res = parseAtlas(manifest, { ref: 'extra/sheet.png', bytes });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error('fixture parse failed');
  return res.asset.atlas;
}

describe('meta.image repoint round-trips via parseAtlas (§10.7)', () => {
  it('repointing a consumer manifest meta.image at the owner image re-parses cleanly', () => {
    const consumer = loadConsumerAtlas();
    const ownerImage = 'main_game/sheet.png'; // owner's folder-relative image path
    const consumerManifestPath = 'extra/sheet.json';
    // worker Phase-C: meta.image relative to the consumer manifest's own directory.
    const repointedRef = relativeImageRef(dirOf(consumerManifestPath), ownerImage);
    expect(repointedRef).toBe('../main_game/sheet.png');

    const repointed: Atlas = { ...consumer, imageRef: repointedRef };
    const emitted = emitTexturePackerJson(repointed);

    // re-parse the emitted JSON via @asset-doctor/parsers (uses the owner image bytes) — proves the
    // rewritten meta.image is a valid drop-in atlas that resolves against the owner sheet.
    const ownerBytes = new Uint8Array(readFileSync(`${fixDir}main_game/sheet.png`));
    const reparsed = parseAtlas(JSON.parse(emitted) as unknown, { ref: 'extra/sheet.png', bytes: ownerBytes });
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok || reparsed.asset.kind !== 'atlas') throw new Error('re-parse failed');
    // every original frame survives, identical rects (the consumer keeps its frame table).
    expect(reparsed.asset.atlas.sprites.map((s) => s.name).sort()).toEqual(consumer.sprites.map((s) => s.name).sort());
    // meta.image as parsed back resolves (relative to the consumer manifest dir) to the owner image.
    const parsedMeta = (JSON.parse(emitted) as { meta: { image: string } }).meta;
    expect(parsedMeta.image).toBe('../main_game/sheet.png');
    expect(resolveImageRef(consumerManifestPath, parsedMeta.image)).toBe(ownerImage);
  });

  it('parseAtlasManifest reads the rewritten meta.image (the only mechanism — no linkedFrames/alias)', () => {
    const consumer = loadConsumerAtlas();
    const emitted = emitTexturePackerJson({ ...consumer, imageRef: 'owner.png' });
    const json = JSON.parse(emitted) as Record<string, unknown>;
    expect((json.meta as { image: string }).image).toBe('owner.png');
    expect('linkedFrames' in json).toBe(false); // rejected mechanism never emitted
    const res = parseAtlasManifest(json, { imageRef: 'owner.png', imageSize: { w: 128, h: 128 } });
    expect(res.ok).toBe(true);
  });
});

describe('transcoded-owner final-name resolution (§10.8)', () => {
  // Pure model of the worker's ownerFinalName derivation: a deterministic function of op kind + target
  // mime. When the owner is transcoded, its emitted image basename gains the target extension; the
  // consumer's repointed meta.image must resolve to that FINAL name (not the owner's original name).
  const EXT: Record<ImageMime, string> = { 'image/webp': '.webp', 'image/avif': '.avif', 'image/png': '.png', 'image/jpeg': '.jpg' };
  const transcodedName = (imagePath: string, target: ImageMime): string =>
    imagePath.replace(/\.[a-z0-9]+$/i, EXT[target]);

  it('owner transcoded to webp → consumer meta.image points at the .webp final name', () => {
    const consumer = loadConsumerAtlas();
    const ownerOriginal = 'main_game/sheet.png';
    const ownerFinal = transcodedName(ownerOriginal, 'image/webp');
    expect(ownerFinal).toBe('main_game/sheet.webp');

    const consumerManifestPath = 'extra/sheet.json';
    const repointedRef = relativeImageRef(dirOf(consumerManifestPath), ownerFinal);
    expect(repointedRef).toBe('../main_game/sheet.webp');

    const emitted = emitTexturePackerJson({ ...consumer, imageRef: repointedRef });
    const meta = (JSON.parse(emitted) as { meta: { image: string } }).meta;
    // resolves (from the consumer dir) back to the owner's FINAL emitted path, not the stale .png.
    expect(resolveImageRef(consumerManifestPath, meta.image)).toBe(ownerFinal);
    expect(resolveImageRef(consumerManifestPath, meta.image)).not.toBe(ownerOriginal);
  });

  it('owner transcoded to avif → consumer resolves to the .avif final name', () => {
    const ownerFinal = transcodedName('main_game/sheet.png', 'image/avif');
    expect(ownerFinal).toBe('main_game/sheet.avif');
    const rel = relativeImageRef(dirOf('extra/sheet.json'), ownerFinal);
    expect(resolveImageRef('extra/sheet.json', rel)).toBe('main_game/sheet.avif');
  });
});

describe('loose-repath gating keeps the file + counts looseRepathSkipped (§10.9)', () => {
  // Pure model of the worker's Phase-C KEEP-vs-rewrite decision. A whole-file (loose) consumer is only
  // dropped+rewritten where AD itself emits the referencing manifest; otherwise the reference may live
  // in game code ⇒ KEEP the file and surface it in looseRepathSkipped (fail-safe).
  interface Outcome { dropped: boolean; rewritten: number; looseRepathSkipped: number; skipped: string[] }
  function gateLooseConsumer(opts: { repointManifest: boolean; isSpine: boolean; hasReferencingManifest: boolean }): Outcome {
    const o: Outcome = { dropped: false, rewritten: 0, looseRepathSkipped: 0, skipped: [] };
    if (opts.isSpine) {
      o.looseRepathSkipped++;
      o.skipped.push('Spine cross-page dedup not drop-in — kept duplicate');
      return o;
    }
    if (opts.repointManifest) {
      o.dropped = true; // only the redundant image is dropped (manifest kept + repointed)
      o.rewritten++;
      return o;
    }
    if (!opts.hasReferencingManifest) {
      o.looseRepathSkipped++;
      o.skipped.push('loose duplicate reference may live in game code — kept duplicate');
      return o; // KEEP — never silently delete a loose dup whose ref may be in code
    }
    o.dropped = true;
    o.rewritten++;
    return o;
  }

  it('a loose dup with NO AD-emitted referencing manifest is KEPT and counted', () => {
    // fixture case i: loose/orphan_copy.png — same isolated bundle as loose/orphan.png, no manifest refs.
    const out = gateLooseConsumer({ repointManifest: false, isSpine: false, hasReferencingManifest: false });
    expect(out.dropped).toBe(false); // KEPT — file survives
    expect(out.looseRepathSkipped).toBe(1);
    expect(out.rewritten).toBe(0);
    expect(out.skipped[0]).toContain('game code');
  });

  it('an atlas-image consumer (repointManifest) drops the image and rewrites — not skipped', () => {
    const out = gateLooseConsumer({ repointManifest: true, isSpine: false, hasReferencingManifest: true });
    expect(out.dropped).toBe(true);
    expect(out.rewritten).toBe(1);
    expect(out.looseRepathSkipped).toBe(0);
  });

  it('a Spine consumer is never silently deleted — kept + counted', () => {
    const out = gateLooseConsumer({ repointManifest: true, isSpine: true, hasReferencingManifest: true });
    expect(out.dropped).toBe(false);
    expect(out.looseRepathSkipped).toBe(1);
    expect(out.skipped[0]).toContain('Spine');
  });

  it('the fixture authors loose/orphan_copy.png as the looseRepathSkipped case', () => {
    const golden = JSON.parse(readFileSync(`${fixDir}expected.json`, 'utf8')) as { worker: { looseRepathSkipped: string[] } };
    expect(golden.worker.looseRepathSkipped).toEqual(['loose/orphan_copy.png']);
  });
});

describe('VRAM honesty receipt split (§10.10)', () => {
  // Pure model of the worker's dedup receipt accounting. DISK saving is REAL (summed consumer bytes);
  // VRAM saving is an UPPER BOUND tracked SEPARATELY and never folded into the hard vramBytesAfter
  // (invariant 5: disk weight ≠ GPU footprint). A cross-bundle drop gets no unqualified VRAM credit.
  interface Receipt {
    vramBytesBefore: number;
    vramBytesAfter: number;
    dedupDiskBytesSaved: number;
    dedupVramBytesSavedUpperBound: number;
  }
  function accrueDedup(
    consumers: { diskBytes: number; vramBytes: number; repointed: boolean }[],
    vramBefore: number,
  ): Receipt {
    let dedupDiskBytesSaved = 0;
    let dedupVramBytesSavedUpperBound = 0;
    for (const c of consumers) {
      if (!c.repointed) continue; // KEPT consumers contribute nothing
      dedupDiskBytesSaved += c.diskBytes; // REAL: the file is gone from the zip
      dedupVramBytesSavedUpperBound += c.vramBytes; // UPPER BOUND: only if runtime shares the upload
    }
    return {
      vramBytesBefore: vramBefore,
      // owner-aware dedup does NOT credit the hard vram figure — vramBytesAfter excludes dedup VRAM.
      vramBytesAfter: vramBefore,
      dedupDiskBytesSaved,
      dedupVramBytesSavedUpperBound,
    };
  }

  it('reports real disk saving and upper-bound VRAM saving in SEPARATE fields', () => {
    const r = accrueDedup(
      [
        { diskBytes: 500, vramBytes: 64 * 64 * 4, repointed: true },
        { diskBytes: 300, vramBytes: 32 * 32 * 4, repointed: true },
        { diskBytes: 999, vramBytes: 99 * 99 * 4, repointed: false }, // kept ⇒ no credit
      ],
      10_000,
    );
    expect(r.dedupDiskBytesSaved).toBe(800); // 500 + 300, the dropped copies only
    expect(r.dedupVramBytesSavedUpperBound).toBe(64 * 64 * 4 + 32 * 32 * 4);
    // the upper-bound VRAM is NOT subtracted from the hard vramBytesAfter (invariant 5).
    expect(r.vramBytesAfter).toBe(r.vramBytesBefore);
    expect(r.dedupVramBytesSavedUpperBound).toBeGreaterThan(0);
    // disk and VRAM are distinct measures — never the same field.
    expect(r.dedupDiskBytesSaved).not.toBe(r.dedupVramBytesSavedUpperBound);
  });

  it('a fully-kept dedup (no repoint) credits nothing', () => {
    const r = accrueDedup([{ diskBytes: 500, vramBytes: 1024, repointed: false }], 10_000);
    expect(r.dedupDiskBytesSaved).toBe(0);
    expect(r.dedupVramBytesSavedUpperBound).toBe(0);
    expect(r.vramBytesAfter).toBe(10_000);
  });
});
