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
import type { Atlas, Size } from '@asset-doctor/core';
import { parseAtlas, parseAtlasManifest } from '@asset-doctor/parsers';
import { groupVariants } from '@asset-doctor/analysis';
import {
  DEFAULT_SCALE_TIERS,
  RESOLUTION_TOKEN,
  emitTexturePackerJson,
  scaleAtlas,
  scaleLoose,
  tieredName,
  validateTiers,
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

  it('rejects a non-resolution (format) suffix so tiers always round-trip into one cluster', () => {
    const r = validateTiers([{ scale: 1, suffix: '_1080p' }, { scale: 0.5, suffix: '_webp' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('not a resolution token'))).toBe(true);
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
