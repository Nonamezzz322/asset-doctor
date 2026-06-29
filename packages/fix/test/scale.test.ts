// PURE scale-tier tests (design docs/scale-tiers-design.md §test plan T1/T2/T3/T4 + T-RT). All inputs are
// built inline or loaded from a fixture — the pure layer touches NO pixels/canvas/IO. We exercise:
//   T1  scaleLoose — 1px floor + never-upscale (identity for scale >= 1).
//   T2  scaleAtlas purity — stays a geometry primitive: NEVER stamps `.scale`, and DROPS mesh (the
//       data-driven gate rationale for correction 2 — a tiered meshed region would silently downgrade).
//   T3  tieredName — suffix injection before the ext, optional transcode-mime swap, manifest ext kept.
//   T4  validateTiers — fail-closed: rejects scale>1 / <=0 / non-finite, empty/dup/non-resolution suffix,
//       a ladder missing the scale=1 top tier, and empty input; sorts high→low; the default ladder passes.
//   per-tier manifest — the worker's tier-loop emit modelled purely: scaleAtlas(atlas, scale) → set
//       .scale = tier.scale (exact ladder, NOT scaleAtlas) → tieredName for meta.image → re-parses via
//       parseAtlasManifest with SCALED frames + per-tier meta.image + per-tier meta.scale.
//   T-RT round-trip clustering — generate loose tiers through the REAL scaleLoose + tieredName geometry
//       (incl. odd 100×50 / 33×17 / 3×100 sizes) → groupVariants clusters every tier of one asset into
//       ONE group, loadedVramMax === the top tier (one tier loads), never under-counts (correction 3).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Atlas, ExportProfile, Size } from '@asset-doctor/core';
import { parseAtlas, parseAtlasManifest } from '@asset-doctor/parsers';
import { groupVariants } from '@asset-doctor/analysis';
import {
  DEFAULT_SCALE_TIERS,
  RESOLUTION_TOKEN,
  SUFFIX_TOKEN,
  emitTexturePackerJson,
  formatToken,
  isSafeSuffix,
  scaleAtlas,
  scaleLoose,
  tieredName,
  tiersOf,
  validateProfile,
  validateTiers,
  variantManifestName,
} from '../src/index';

// ── T1: scaleLoose — same 1px-floor downscale as scaleAtlas, never upscale ────────────────────────
describe('scaleLoose (T1)', () => {
  it('halves both dimensions', () => {
    expect(scaleLoose({ w: 100, h: 50 }, 0.5)).toEqual({ w: 50, h: 25 });
  });

  it('rounds each axis independently (Math.round), like scaleAtlas', () => {
    // 3 * 0.5 = 1.5 → round → 2; matches scaleAtlas's px = max(1, round(n*scale)).
    expect(scaleLoose({ w: 3, h: 3 }, 0.5)).toEqual({ w: 2, h: 2 });
    expect(scaleLoose({ w: 33, h: 17 }, 0.75)).toEqual({ w: 25, h: 13 }); // 24.75→25, 12.75→13
  });

  it('floors at 1px — a zero-pixel dimension is never produced', () => {
    expect(scaleLoose({ w: 1, h: 10 }, 0.5)).toEqual({ w: 1, h: 5 }); // 0.5→round 1 (floored), 5
    expect(scaleLoose({ w: 1, h: 1 }, 0.01)).toEqual({ w: 1, h: 1 });
  });

  it('NEVER upscales: scale >= 1 ⇒ identity (a fresh, non-aliasing copy)', () => {
    const src: Size = { w: 64, h: 48 };
    expect(scaleLoose(src, 1)).toEqual(src);
    expect(scaleLoose(src, 2)).toEqual(src); // would-be upscale clamps to identity
    expect(scaleLoose(src, 1)).not.toBe(src); // fresh object — caller can't alias the input
  });
});

// ── T3: tieredName — suffix before ext, optional transcode-mime swap ──────────────────────────────
describe('tieredName (T3)', () => {
  it('inserts the suffix before the original extension', () => {
    expect(tieredName('ui/btn.png', '_720p')).toBe('ui/btn_720p.png');
    expect(tieredName('hero.png', '_1080p')).toBe('hero_1080p.png');
  });

  it('swaps the extension for a transcoded mime', () => {
    expect(tieredName('ui/btn.png', '_720p', 'image/webp')).toBe('ui/btn_720p.webp');
    expect(tieredName('ui/btn.png', '_540p', 'image/avif')).toBe('ui/btn_540p.avif');
  });

  it('keeps the manifest extension (.json) when no mime is given', () => {
    expect(tieredName('ui/atlas.json', '_540p')).toBe('ui/atlas_540p.json');
  });

  it('still suffixes the top tier so every tier shares one resolution stem', () => {
    expect(tieredName('bg.png', '_1080p')).toBe('bg_1080p.png');
  });
});

// ── T4: validateTiers — fail-closed normalization ─────────────────────────────────────────────────
describe('validateTiers (T4)', () => {
  it('accepts the default ladder and returns it high→low', () => {
    const r = validateTiers([...DEFAULT_SCALE_TIERS]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tiers.map((t) => t.scale)).toEqual([1, 0.75, 0.5]);
  });

  it('sorts an unsorted ladder high→low (deterministic, suffix tiebreaker)', () => {
    const r = validateTiers([{ scale: 0.5, suffix: '_540p' }, { scale: 1, suffix: '_1080p' }, { scale: 0.75, suffix: '_720p' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tiers.map((t) => t.suffix)).toEqual(['_1080p', '_720p', '_540p']);
  });

  it('rejects an upscale (scale > 1) — never upscale', () => {
    const r = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: 2, suffix: '@2x' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('upscale'))).toBe(true);
  });

  it('rejects a non-positive or non-finite scale', () => {
    const zero = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: 0, suffix: '_540p' }]);
    const neg = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: -0.5, suffix: '_540p' }]);
    const nan = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: Number.NaN, suffix: '_540p' }]);
    for (const r of [zero, neg, nan]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.startsWith('badScale'))).toBe(true);
    }
  });

  it('rejects an empty suffix', () => {
    const r = validateTiers([{ scale: 1, suffix: '' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('badSuffix'))).toBe(true);
  });

  it('rejects a format-name suffix (would collide with multi-format naming / stemOf format-peel)', () => {
    const r = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: 0.5, suffix: '_webp' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('badSuffix') && e.includes('not a format name'))).toBe(true);
  });

  it('rejects duplicate suffixes (case-insensitive — they would clobber emitted names)', () => {
    const r = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: 0.5, suffix: '_1080P' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('dupSuffix'))).toBe(true);
  });

  it('rejects a ladder with no scale=1 top tier', () => {
    const r = validateTiers([{ scale: 0.75, suffix: '_720p' }, { scale: 0.5, suffix: '_540p' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('noTopTier'))).toBe(true);
  });

  it('rejects empty input (nothing to emit)', () => {
    const r = validateTiers([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('empty'))).toBe(true);
  });

  it('every default suffix matches RESOLUTION_TOKEN (generation always clusters)', () => {
    for (const t of DEFAULT_SCALE_TIERS) expect(RESOLUTION_TOKEN.test(t.suffix)).toBe(true);
  });
});

// ── AB-R4: user-chosen safe tier suffixes (isSafeSuffix is a SUPERSET of RESOLUTION_TOKEN) ─────────
// Build-side relax ONLY: validateTiers now accepts a safe free-form suffix as WELL as every legacy
// resolution suffix (zero regression). Clustering (packages/analysis) is intentionally NOT widened — a
// custom non-resolution suffix is documented to over-count the advisory variants WARN on re-ingest, never
// to fabricate a cluster. See docs/improvements/ab-r4-suffix-policy.md.
describe('isSafeSuffix + validateTiers free-form suffixes (AB-R4)', () => {
  it('isSafeSuffix is a SUPERSET — every RESOLUTION_TOKEN suffix stays valid (zero regression)', () => {
    // RESOLUTION_TOKEN requires a leading [_-]; `@2x` (no separator) was never a valid standalone suffix —
    // it is preserved via the legacy alternation only WITH a separator (`_2x`/`-2x`). See ab-r4 doc.
    for (const s of ['_1080p', '_720p', '_540p', '_2x', '_hd', '_sd', '-2x', '_4x']) {
      expect(RESOLUTION_TOKEN.test(s), `${s} legacy`).toBe(true);
      expect(isSafeSuffix(s), `${s} isSafeSuffix`).toBe(true);
    }
    // and every DEFAULT_SCALE_TIERS suffix
    for (const t of DEFAULT_SCALE_TIERS) expect(isSafeSuffix(t.suffix)).toBe(true);
  });

  it('isSafeSuffix ACCEPTS safe free-form suffixes (_mobile / _lq / _hidpi / _x2 / -hi-dpi)', () => {
    for (const s of ['_mobile', '_lq', '_hidpi', '_x2', '-hi-dpi', '_HD2', '_a']) {
      expect(isSafeSuffix(s), s).toBe(true);
    }
  });

  it('isSafeSuffix REJECTS format-name bodies (case-insensitive) — collision with multi-format naming', () => {
    for (const s of ['_png', '_webp', '_avif', '_jpg', '_jpeg', '_JPG', '_WebP', '-avif']) {
      expect(isSafeSuffix(s), s).toBe(false);
    }
  });

  it('isSafeSuffix REJECTS unsafe charset / shape — dot, slash, @-free-form, no-separator, empty body, overlong', () => {
    for (const s of [
      '_a.b',      // dot would fake an extension in variantManifestName
      '_a/b',      // slash would inject a directory
      '@mobile',   // @ only allowed via the legacy density token, not the free-form branch
      'mobile',    // no leading separator
      '_',         // empty body
      '__',        // body must start with [A-Za-z0-9]
      '-_x',       // body must start with [A-Za-z0-9]
      `_${'a'.repeat(25)}`, // 25-char body (max is 24: leading char + 23 more) → overlong
    ]) {
      expect(isSafeSuffix(s), s).toBe(false);
    }
  });

  it('SUFFIX_TOKEN is the safe-charset shape (sanity: bounds at the 24-char body)', () => {
    expect(SUFFIX_TOKEN.test(`_${'a'.repeat(24)}`)).toBe(true);  // body = leading char + 23 more = 24 (max)
    expect(SUFFIX_TOKEN.test(`_${'a'.repeat(25)}`)).toBe(false); // one over the 24-char body cap
  });

  it('validateTiers ACCEPTS a free-form lower tier with a resolution top tier (mixed ladder)', () => {
    const r = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: 0.5, suffix: '_mobile' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tiers.map((t) => t.suffix)).toEqual(['_1080p', '_mobile']); // high→low
  });

  it('validateTiers ACCEPTS an all-free-form ladder (top tier free-form too)', () => {
    const r = validateTiers([{ scale: 1, suffix: '_full' }, { scale: 0.5, suffix: '_mobile' }, { scale: 0.25, suffix: '_lq' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tiers.map((t) => t.scale)).toEqual([1, 0.5, 0.25]);
  });

  it('validateTiers REJECTS each format-name / dotted / slashed / no-separator / empty-body / overlong suffix', () => {
    for (const bad of ['_png', '_webp', '_avif', '_jpeg', '_a.b', '_a/b', 'mobile', '__', `_${'a'.repeat(25)}`]) {
      const r = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: 0.5, suffix: bad }]);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => e.startsWith('badSuffix')), bad).toBe(true);
    }
  });

  it('the other guards are UNCHANGED with free-form suffixes (dup case-insensitive, no top tier)', () => {
    const dup = validateTiers([{ scale: 1, suffix: '_Mobile' }, { scale: 0.5, suffix: '_mobile' }]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.some((e) => e.startsWith('dupSuffix'))).toBe(true);
    const noTop = validateTiers([{ scale: 0.75, suffix: '_mobile' }, { scale: 0.5, suffix: '_lq' }]);
    expect(noTop.ok).toBe(false);
    if (!noTop.ok) expect(noTop.errors.some((e) => e.startsWith('noTopTier'))).toBe(true);
  });

  it('is deterministic: same input ⇒ deep-equal result (regex + Set, no Date/Math.random)', () => {
    const tiers = [{ scale: 1, suffix: '_1080p' }, { scale: 0.5, suffix: '_mobile' }, { scale: 0.25, suffix: '_lq' }];
    expect(validateTiers([...tiers])).toEqual(validateTiers([...tiers]));
    expect(isSafeSuffix('_mobile')).toBe(isSafeSuffix('_mobile'));
  });
});

// ── Fixture loaders (the tier-source case) ────────────────────────────────────────────────────────
const tierDir = fileURLToPath(new URL('../../../fixtures/sample-projects/tier-source/', import.meta.url));
function loadTierAtlas(): Atlas {
  const manifest = JSON.parse(readFileSync(`${tierDir}sheet.json`, 'utf8')) as unknown;
  const bytes = new Uint8Array(readFileSync(`${tierDir}sheet.png`));
  const res = parseAtlas(manifest, { ref: 'sheet.png', bytes });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error('tier-source atlas parse failed');
  return res.asset.atlas;
}
function loadMeshedAtlas(): Atlas {
  const manifest = JSON.parse(readFileSync(`${tierDir}meshed.json`, 'utf8')) as unknown;
  const bytes = new Uint8Array(readFileSync(`${tierDir}meshed.png`));
  const res = parseAtlas(manifest, { ref: 'meshed.png', bytes });
  if (!res.ok || res.asset.kind !== 'atlas') throw new Error('tier-source meshed atlas parse failed');
  return res.asset.atlas;
}

// ── T2: scaleAtlas stays a pure geometry primitive (correction 1 + correction 2 gate rationale) ──
describe('scaleAtlas purity (T2)', () => {
  it('does NOT stamp .scale — the tier loop owns it (correction 1)', () => {
    // An atlas with no scale: scaleAtlas must leave it undefined (it never invents .scale).
    const noScale: Atlas = { name: 'a', imageRef: 'a.png', size: { w: 64, h: 64 }, sprites: [], source: { kind: 'pixi' } };
    expect(scaleAtlas(noScale, 0.5).scale).toBeUndefined();
    // An atlas WITH a scale: scaleAtlas passes it through UNCHANGED (it does not multiply/stamp it) —
    // setting the tier's exact ladder scale is the worker tier loop's job, not this primitive's.
    const atlas = loadTierAtlas(); // fixture manifest carries meta.scale '1' → atlas.scale === 1
    expect(scaleAtlas(atlas, 0.5).scale).toBe(atlas.scale); // untouched, NOT downscaled to 0.5
  });

  it('DROPS mesh — every scaled sprite has mesh === undefined (correction 2 gate rationale)', () => {
    // The data-driven refuse-to-tier gate exists BECAUSE scaleAtlas drops mesh: a meshed region scaled
    // here would silently lose its tight outline and downgrade to a rectangle. The fixture's regions
    // carry a source mesh (parsed back from the manifest), so this is a real round-tripped mesh.
    const meshed = loadMeshedAtlas();
    expect(meshed.sprites.some((s) => s.mesh !== undefined)).toBe(true); // fixture actually carries meshes
    const scaled = scaleAtlas(meshed, 0.5);
    for (let i = 0; i < scaled.sprites.length; i++) expect(scaled.sprites[i]!.mesh).toBeUndefined();
  });
});

// ── Per-tier atlas manifest emit/re-parse (the worker tier-loop emit, modelled purely) ────────────
describe('per-tier atlas manifest (emit → parse with scaled frames + per-tier meta)', () => {
  it('re-parses via parseAtlasManifest with scaled frames + per-tier meta.image + per-tier meta.scale', () => {
    const atlas = loadTierAtlas();
    const tier = { scale: 0.75, suffix: '_720p' };

    // The tier loop: scale geometry (scaleAtlas), then SET .scale to the exact ladder value (NOT
    // scaleAtlas), and point the manifest image at the tier's own image via tieredName.
    const scaled = scaleAtlas(atlas, tier.scale);
    const tierImage = tieredName(atlas.imageRef, tier.suffix, 'image/webp'); // e.g. sheet_720p.webp
    // The atlas name follows its image (parseAtlasManifest reconstructs name = imageRef).
    const tierAtlas: Atlas = { ...scaled, scale: tier.scale, name: tierImage, imageRef: tierImage };

    const json = emitTexturePackerJson(tierAtlas);
    const parsed = JSON.parse(json) as { meta: { image: string; scale: string } };
    expect(parsed.meta.image).toBe(tierImage);        // per-tier meta.image (its own image)
    expect(parsed.meta.scale).toBe(String(tier.scale)); // meta.scale = "0.75" (manifest.ts:33)

    const res = parseAtlasManifest(JSON.parse(json), { imageRef: tierImage, imageSize: tierAtlas.size });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.atlas).toEqual(tierAtlas); // emit → parse → same scaled Atlas (frames already scaled)
      // every re-parsed frame is the scaled frame, in bounds of the scaled sheet
      for (const s of res.atlas.sprites) {
        expect(s.frame.x + s.frame.w).toBeLessThanOrEqual(res.atlas.size.w);
        expect(s.frame.y + s.frame.h).toBeLessThanOrEqual(res.atlas.size.h);
      }
    }
  });

  it('is deterministic: re-emitting an identical tier atlas is byte-identical', () => {
    const atlas = loadTierAtlas();
    const make = (): Atlas => ({ ...scaleAtlas(atlas, 0.5), scale: 0.5, imageRef: tieredName(atlas.imageRef, '_540p', 'image/webp') });
    expect(emitTexturePackerJson(make())).toBe(emitTexturePackerJson(make()));
  });
});

// ── T-RT: round-trip clustering through the REAL tier geometry (correction 3) ──────────────────────
// Generate the loose tiers exactly as the worker would (scaleLoose + tieredName), then re-ingest into
// groupVariants. Every tier of one logical asset must land in ONE cluster (so loaded VRAM stays one
// tier/asset), even at odd, independently-rounded sizes that the old stem|aspectBucket key would split.
describe('round-trip clustering (T-RT, correction 3)', () => {
  const ladder = [...DEFAULT_SCALE_TIERS]; // 1 / 0.75 / 0.5
  const vram = (s: Size): number => s.w * s.h * 4;

  /** Emit the tier set for one loose asset the way the worker would: name = tieredName(src, suffix),
   *  size = scaleLoose(src, scale). Returns groupVariants items. */
  const tiersOf = (path: string, src: Size) =>
    ladder.map((t) => ({ name: tieredName(path, t.suffix), size: scaleLoose(src, t.scale) }));

  for (const [label, src] of [
    ['square 256', { w: 256, h: 256 }],
    ['odd banner 100×50', { w: 100, h: 50 }],
    ['odd 33×17', { w: 33, h: 17 }],
    ['extreme 3×100', { w: 3, h: 100 }],
  ] as const) {
    it(`clusters all ${ladder.length} tiers of a ${label} loose asset into ONE group`, () => {
      const items = tiersOf('ui/banner.png', src);
      // groupVariants takes Assets; wrap each generated tier as a loose image asset.
      const v = groupVariants(items.map((it) => ({ kind: 'image' as const, image: { name: it.name, imageRef: it.name, size: it.size, mime: 'image/png' as const, byteSize: 1 } })));
      expect(v.groups).toHaveLength(1);
      expect(v.groups[0]?.members).toHaveLength(ladder.length); // members.length === tiers.length
      expect(v.groups[0]?.stem).toBe('ui/banner');

      // One tier loads at runtime: loaded VRAM is the TOP tier (scale 1 == source), not the sum.
      const topVram = vram(scaleLoose(src, 1));
      expect(v.loadedVramMax).toBe(topVram);
      // Safe direction: loaded VRAM is never UNDER the top tier (a future rounding change can't silently
      // under-count) and is strictly below the naive sum of every tier.
      expect(v.loadedVramMax).toBeGreaterThanOrEqual(topVram);
      expect(v.loadedVramMax).toBeLessThan(v.summedVram);
    });
  }

  it('clusters a generated ATLAS tier set by stem too (scaleAtlas drives the sheet size)', () => {
    const atlas = loadTierAtlas();
    const items = ladder.map((t) => {
      const scaled = scaleAtlas(atlas, t.scale);
      return { name: tieredName(atlas.imageRef, t.suffix), size: scaled.size };
    });
    const v = groupVariants(items.map((it) => ({
      kind: 'atlas' as const,
      atlas: { name: it.name, imageRef: it.name, size: it.size, sprites: [], source: { kind: 'texturepacker-hash' as const } },
      image: { name: it.name, imageRef: it.name, size: it.size, mime: 'image/png' as const, byteSize: 1 },
    })));
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]?.members).toHaveLength(ladder.length);
    expect(v.loadedVramMax).toBe(vram(atlas.size)); // top tier == the source sheet footprint
  });
});

// ── Config-driven export profile (round7-export-profile.md §4a) — tiersOf / validateProfile / naming ──
const okTiers = [{ label: '1080p', scale: 1, suffix: '_1080p' }] as const;

describe('tiersOf (export profile §4a)', () => {
  it('strips the label, preserving order + scale + suffix', () => {
    const tiers = [
      { label: 'full', scale: 1, suffix: '_1080p' },
      { label: 'half', scale: 0.5, suffix: '_540p' },
    ];
    expect(tiersOf(tiers)).toEqual([
      { scale: 1, suffix: '_1080p' },
      { scale: 0.5, suffix: '_540p' },
    ]);
  });

  it('returns fresh objects (caller cannot alias the input)', () => {
    const tiers = [{ label: 'full', scale: 1, suffix: '_1080p' }];
    const out = tiersOf(tiers);
    expect(out[0]).not.toBe(tiers[0] as unknown);
  });
});

describe('validateProfile (export profile §4a)', () => {
  it('accepts a valid multi-format / multi-tier profile, formats in given order, tiers high→low', () => {
    const p: ExportProfile = {
      formats: [
        { format: 'image/avif', quality: 70 },
        { format: 'image/webp', lossless: true },
        { format: 'image/png' },
      ],
      tiers: [
        { label: 'half', scale: 0.5, suffix: '_540p' },
        { label: 'full', scale: 1, suffix: '_1080p' },
      ],
    };
    const r = validateProfile(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.formats.map((f) => f.format)).toEqual(['image/avif', 'image/webp', 'image/png']); // given order
      expect(r.tiers.map((t) => t.suffix)).toEqual(['_1080p', '_540p']); // delegated high→low sort
    }
  });

  it('rejects empty formats', () => {
    const r = validateProfile({ formats: [], tiers: [...okTiers] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('emptyFormats'))).toBe(true);
  });

  it('rejects a format outside png/webp/avif (no jpeg — no alpha)', () => {
    const r = validateProfile({ formats: [{ format: 'image/jpeg' as never }], tiers: [...okTiers] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('badFormat'))).toBe(true);
  });

  it('rejects lossless AVIF (no honest in-browser lossless path — never a faked-lossless)', () => {
    const r = validateProfile({ formats: [{ format: 'image/avif', lossless: true }], tiers: [...okTiers] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('losslessAvif'))).toBe(true);
  });

  it('rejects quality / near outside [0,100]', () => {
    const badQ = validateProfile({ formats: [{ format: 'image/webp', quality: 101 }], tiers: [...okTiers] });
    const badN = validateProfile({ formats: [{ format: 'image/webp', near: -1 }], tiers: [...okTiers] });
    expect(badQ.ok).toBe(false);
    if (!badQ.ok) expect(badQ.errors.some((e) => e.startsWith('badQuality'))).toBe(true);
    expect(badN.ok).toBe(false);
    if (!badN.ok) expect(badN.errors.some((e) => e.startsWith('badNear'))).toBe(true);
  });

  it('rejects duplicate (format, lossless, quality, near) targets — they would clobber', () => {
    const r = validateProfile({
      formats: [
        { format: 'image/webp', quality: 80 },
        { format: 'image/webp', quality: 80 },
      ],
      tiers: [...okTiers],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('dupTarget'))).toBe(true);
  });

  it('allows two webp targets that differ on lossless (not a dup)', () => {
    const r = validateProfile({
      formats: [
        { format: 'image/webp', quality: 80 },
        { format: 'image/webp', lossless: true },
      ],
      tiers: [...okTiers],
    });
    expect(r.ok).toBe(true);
  });

  it('B2: a lossless PNG + a pngLossy PNG pair is NOT a dupTarget (split dup-key image/png vs image/png|lossy)', () => {
    const r = validateProfile({
      formats: [
        { format: 'image/png' }, // plain native-lossless PNG
        { format: 'image/png', pngLossy: true }, // pngquant-routed (different emitted bytes)
      ],
      tiers: [...okTiers],
    });
    expect(r.ok).toBe(true); // would falsely fail closed without the dup-key split
  });

  it('still rejects two PLAIN PNG targets (they emit identical bytes ⇒ clobber)', () => {
    const r = validateProfile({
      formats: [{ format: 'image/png' }, { format: 'image/png' }],
      tiers: [...okTiers],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('dupTarget'))).toBe(true);
  });

  it('still rejects two pngLossy PNG targets (same pngquant emit ⇒ clobber)', () => {
    const r = validateProfile({
      formats: [
        { format: 'image/png', pngLossy: true },
        { format: 'image/png', pngLossy: true },
      ],
      tiers: [...okTiers],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('dupTarget') && e.includes('lossy'))).toBe(true);
  });

  it('rejects pngLossy on a non-png format (pngLossy is PNG-only)', () => {
    const r = validateProfile({
      formats: [{ format: 'image/webp', pngLossy: true } as never],
      tiers: [...okTiers],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('pngLossyNonPng'))).toBe(true);
  });

  // ── round7 §4d: PROFILE-GLOBAL knob fail-closed validation (the twins of the override guards) ──
  it('accepts valid profile-global knobs (effort 0-6, pngRecompressLevel 0-6, avifSubsample 0/1/2/3, avifQualityAlpha -1..100)', () => {
    for (const sub of [0, 1, 2, 3]) {
      const r = validateProfile({
        formats: [{ format: 'image/avif', quality: 70 }],
        tiers: [...okTiers],
        effort: 6,
        pngRecompressLevel: 0,
        avifSubsample: sub,
        avifQualityAlpha: -1,
      });
      expect(r.ok).toBe(true);
    }
    // the upper-bound alpha + a mid effort/png level also pass.
    const r = validateProfile({ formats: [{ format: 'image/avif' }], tiers: [...okTiers], effort: 0, pngRecompressLevel: 6, avifQualityAlpha: 100 });
    expect(r.ok).toBe(true);
  });

  it('REJECTS a non-integer profile-global avifSubsample (fail-closed — never reaches the codec)', () => {
    const r = validateProfile({ formats: [{ format: 'image/avif' }], tiers: [...okTiers], avifSubsample: 3.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('badSubsample'))).toBe(true);
  });

  it('REJECTS an out-of-set profile-global avifSubsample (integer but not in {0,1,2,3})', () => {
    const r = validateProfile({ formats: [{ format: 'image/avif' }], tiers: [...okTiers], avifSubsample: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('badSubsample'))).toBe(true);
  });

  it('REJECTS a profile-global effort of 7 (out of [0,6])', () => {
    const r = validateProfile({ formats: [{ format: 'image/webp' }], tiers: [...okTiers], effort: 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('badEffort'))).toBe(true);
  });

  it('REJECTS a profile-global pngRecompressLevel of -1 (out of [0,6])', () => {
    const r = validateProfile({ formats: [{ format: 'image/png' }], tiers: [...okTiers], pngRecompressLevel: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('badPngRecompressLevel'))).toBe(true);
  });

  it('REJECTS a profile-global avifQualityAlpha of 101 (out of -1..100)', () => {
    const r = validateProfile({ formats: [{ format: 'image/avif' }], tiers: [...okTiers], avifQualityAlpha: 101 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('badQualityAlpha'))).toBe(true);
  });

  it('delegates every tier rejection to validateTiers (prefixed "tier ...")', () => {
    // no scale=1 top tier ⇒ validateTiers noTopTier, surfaced as a "tier ..." error here.
    const r = validateProfile({
      formats: [{ format: 'image/webp' }],
      tiers: [{ label: 'half', scale: 0.5, suffix: '_540p' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('tier ') && e.includes('noTopTier'))).toBe(true);
  });

  it('is deterministic: same input ⇒ deep-equal result', () => {
    const p: ExportProfile = { formats: [{ format: 'image/avif', quality: 70 }], tiers: [...okTiers] };
    expect(validateProfile(p)).toEqual(validateProfile(p));
  });

  // ── round10 profile overrides (§4) ──
  it('absent/empty overrides ⇒ success carries overrides:[] (additivity)', () => {
    const absent = validateProfile({ formats: [{ format: 'image/webp' }], tiers: [...okTiers] });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.overrides).toEqual([]);
    const empty = validateProfile({ formats: [{ format: 'image/webp' }], tiers: [...okTiers], overrides: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.overrides).toEqual([]);
  });

  it('accepts valid overrides and carries them in given order', () => {
    const r = validateProfile({
      formats: [{ format: 'image/webp' }],
      tiers: [...okTiers],
      overrides: [
        { match: 'fonts', formats: [{ format: 'image/avif', quality: 85 }], avifSubsample: 3 },
        { match: 'ui', quality: 50, effort: 6 },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.overrides.map((o) => o.match)).toEqual(['fonts', 'ui']);
  });

  it('rejects lossless-AVIF inside an override.formats (prefixed override[i].formats:)', () => {
    const r = validateProfile({
      formats: [{ format: 'image/webp' }],
      tiers: [...okTiers],
      overrides: [{ match: 'fonts', formats: [{ format: 'image/avif', lossless: true }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('override[0].formats: losslessAvif'))).toBe(true);
  });

  it('rejects an empty override.formats (emptyFormats, prefixed)', () => {
    const r = validateProfile({
      formats: [{ format: 'image/webp' }],
      tiers: [...okTiers],
      overrides: [{ match: 'fonts', formats: [] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('override[0].formats: emptyFormats'))).toBe(true);
  });

  it('rejects bad override quality / near / effort / subsample', () => {
    const r = validateProfile({
      formats: [{ format: 'image/webp' }],
      tiers: [...okTiers],
      overrides: [{ match: 'a', quality: 101 }, { match: 'b', near: -1 }, { match: 'c', effort: 9 }, { match: 'd', avifSubsample: 1.5 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith('override[0]: badQuality'))).toBe(true);
      expect(r.errors.some((e) => e.startsWith('override[1]: badNear'))).toBe(true);
      expect(r.errors.some((e) => e.startsWith('override[2]: badEffort'))).toBe(true);
      expect(r.errors.some((e) => e.startsWith('override[3]: badSubsample'))).toBe(true);
    }
  });

  it('rejects an empty/blank override match (must never silently match)', () => {
    const r = validateProfile({
      formats: [{ format: 'image/webp' }],
      tiers: [...okTiers],
      overrides: [{ match: '   ' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('override[0]: emptyMatch'))).toBe(true);
  });

  it('rejects a dup target inside override.formats (prefixed)', () => {
    const r = validateProfile({
      formats: [{ format: 'image/webp' }],
      tiers: [...okTiers],
      overrides: [{ match: 'fonts', formats: [{ format: 'image/webp', quality: 80 }, { format: 'image/webp', quality: 80 }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.startsWith('override[0].formats: dupTarget'))).toBe(true);
  });
});

describe('formatToken / variantManifestName (export profile §4a)', () => {
  it('formatToken is empty when NOT multi (single-format ⇒ legacy byte-identical names)', () => {
    expect(formatToken('image/webp', false)).toBe('');
    expect(formatToken('image/avif', false)).toBe('');
  });

  it('formatToken is the bare format extension when multi', () => {
    expect(formatToken('image/webp', true)).toBe('.webp');
    expect(formatToken('image/avif', true)).toBe('.avif');
    expect(formatToken('image/png', true)).toBe('.png');
  });

  it('variantManifestName: single-format keeps the legacy _suffix.json name', () => {
    expect(variantManifestName('ui/btn.json', '_720p', 'image/webp', false)).toBe('ui/btn_720p.json');
    expect(variantManifestName('skel.atlas', '_540p', 'image/avif', false)).toBe('skel_540p.atlas');
  });

  it('variantManifestName: multi-format injects the format token before the manifest ext', () => {
    expect(variantManifestName('ui/btn.json', '_720p', 'image/webp', true)).toBe('ui/btn_720p.webp.json');
    expect(variantManifestName('ui/btn.json', '_720p', 'image/avif', true)).toBe('ui/btn_720p.avif.json');
    expect(variantManifestName('skel.atlas', '_540p', 'image/png', true)).toBe('skel_540p.png.atlas');
  });

  it('is deterministic string math', () => {
    expect(variantManifestName('a/b/c.json', '_1080p', 'image/webp', true)).toBe(
      variantManifestName('a/b/c.json', '_1080p', 'image/webp', true),
    );
  });
});
