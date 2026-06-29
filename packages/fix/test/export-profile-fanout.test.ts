// PURE export-profile FAN-OUT decision tests (round7-export-profile.md §11, T13). No worker / OffscreenCanvas
// harness exists (B2), so the fan-out DECISION — which (name, encode-opts) pairs the worker emits per
// (format × tier) — is proven here by composing the SAME pure primitives the worker calls inline:
//   validateProfile → (formats, normalized tiers)        [the fail-closed gate]
//   tieredName(imagePath, suffix, mime)                  [the per-variant IMAGE name, ext-swapped]
//   variantManifestName(manifestPath, suffix, mime, multi)[the per-variant MANIFEST name, token-aware]
//   formatEncode(fmt, scale, global)                     [the per-variant encode opts, lossless threaded]
// ADDITIVITY is the load-bearing claim: a SINGLE-format profile must reproduce today's legacy names (no
// format token) and a multi-format one must disambiguate by extension/token without collisions. The worker
// is a thin caller over these — see apps/web/src/worker/fix.worker.ts tier loop + loose fan-out — so a
// green decision golden here + the no-profile structural argument (formatsToEmit=[legacy] when profile
// absent) is the honest substitute for a pixel e2e. Pixel byte-identity is verified MANUALLY (see footer).

import { describe, expect, it } from 'vitest';
import type { Atlas, ExportProfile, ImageMime } from '@asset-doctor/core';
import {
  atlasNeedsForcedFormat,
  formatEncode,
  renamedTo,
  repointAtlasImage,
  resolveProfileForRef,
  tieredName,
  validateProfile,
  variantManifestName,
  type FixAssetKind,
} from '../src/index';

const globalKnobs = { effort: 0, scaleAwareQuality: false };

/** Model the worker's per-asset fan-out decision purely: for a validated profile, produce the ordered list
 *  of (image name, manifest name, encode opts) the tier loop / loose handler would emit for ONE asset.
 *  `multi` mirrors the worker's profileMulti (formats.length > 1). This is the EXACT composition the worker
 *  performs inline (tieredName for the image, variantManifestName for the manifest, formatEncode for opts). */
function fanoutDecision(p: ExportProfile, imagePath: string, manifestPath: string) {
  const v = validateProfile(p);
  if (!v.ok) return { ok: false as const, errors: v.errors };
  const multi = v.formats.length > 1;
  const rows: { image: string; manifest: string; mime: ImageMime; lossless: boolean; quality: number; near: number }[] = [];
  for (const tier of v.tiers) {
    for (const fmt of v.formats) {
      const fe = formatEncode(fmt, tier.scale, globalKnobs);
      rows.push({
        image: tieredName(imagePath, tier.suffix, fe.targetMime),
        manifest: variantManifestName(manifestPath, tier.suffix, fe.targetMime, multi),
        mime: fe.targetMime,
        lossless: fe.lossless,
        quality: fe.quality,
        near: fe.webpNearLossless,
      });
    }
  }
  return { ok: true as const, rows };
}

describe('export-profile fan-out decision (T13)', () => {
  it('single-format profile ⇒ LEGACY names (no format token) — additivity load-bearing', () => {
    const p: ExportProfile = { formats: [{ format: 'image/webp', quality: 80 }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const d = fanoutDecision(p, 'ui/btn.png', 'ui/btn.json');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    // One row (1 format × 1 tier). Image ext-swapped to webp; manifest keeps the LEGACY _suffix.json name.
    expect(d.rows).toEqual([{ image: 'ui/btn_1080p.webp', manifest: 'ui/btn_1080p.json', mime: 'image/webp', lossless: false, quality: 80, near: 100 }]);
  });

  it('multi-format × multi-tier ⇒ one row per (format × tier), tier-major order, tokened manifests', () => {
    const p: ExportProfile = {
      formats: [
        { format: 'image/avif', quality: 70 },
        { format: 'image/webp', quality: 85, near: 60 },
      ],
      tiers: [
        { label: 'full', scale: 1, suffix: '_1080p' },
        { label: 'half', scale: 0.5, suffix: '_540p' },
      ],
    };
    const d = fanoutDecision(p, 'ui/btn.png', 'ui/btn.json');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    // Tiers high→low (validateTiers sort), formats in given order. Multi ⇒ the format token disambiguates
    // the MANIFEST names (the image ext already disambiguates). NO two rows share an image OR manifest name.
    expect(d.rows.map((r) => r.image)).toEqual(['ui/btn_1080p.avif', 'ui/btn_1080p.webp', 'ui/btn_540p.avif', 'ui/btn_540p.webp']);
    expect(d.rows.map((r) => r.manifest)).toEqual(['ui/btn_1080p.avif.json', 'ui/btn_1080p.webp.json', 'ui/btn_540p.avif.json', 'ui/btn_540p.webp.json']);
    // Per-format encode opts: AVIF lossy (near off), WebP near-lossless 60.
    expect(d.rows[0]).toMatchObject({ mime: 'image/avif', lossless: false, quality: 70, near: 100 });
    expect(d.rows[1]).toMatchObject({ mime: 'image/webp', lossless: false, quality: 85, near: 60 });
  });

  it('every image AND manifest name is UNIQUE across the fan-out (no clobber)', () => {
    const p: ExportProfile = {
      formats: [{ format: 'image/png' }, { format: 'image/webp', lossless: true }, { format: 'image/avif', quality: 50 }],
      tiers: [
        { label: 'full', scale: 1, suffix: '_1080p' },
        { label: '3/4', scale: 0.75, suffix: '_720p' },
      ],
    };
    const d = fanoutDecision(p, 'a/sheet.png', 'a/sheet.json');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(new Set(d.rows.map((r) => r.image)).size).toBe(d.rows.length);
    expect(new Set(d.rows.map((r) => r.manifest)).size).toBe(d.rows.length);
    // 3 formats × 2 tiers = 6 variants.
    expect(d.rows).toHaveLength(6);
    // WebP lossless row carries lossless:true (B1 — the lossless flag is threaded, never silently dropped).
    const webpFull = d.rows.find((r) => r.image === 'a/sheet_1080p.webp');
    expect(webpFull).toMatchObject({ lossless: true });
  });

  it('lossless-AVIF profile is REJECTED before any emit (no faked-lossless, invariant 3)', () => {
    const p: ExportProfile = { formats: [{ format: 'image/avif', lossless: true }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const d = fanoutDecision(p, 'x.png', 'x.json');
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.errors.some((e) => e.startsWith('losslessAvif'))).toBe(true);
  });

  it('scale-aware quality folds onto the per-tier lossy quality (downscale ⇒ lower q, floor 50)', () => {
    const p: ExportProfile = {
      formats: [{ format: 'image/webp', quality: 90 }],
      tiers: [
        { label: 'full', scale: 1, suffix: '_1080p' },
        { label: 'half', scale: 0.5, suffix: '_540p' },
      ],
      scaleAwareQuality: true,
    };
    const v = validateProfile(p);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // Top tier (scale 1) keeps q=90; the 0.5× tier drops by round((1-0.5)*50)=25 ⇒ 65.
    expect(formatEncode(v.formats[0]!, 1, { effort: 0, scaleAwareQuality: true }).quality).toBe(90);
    expect(formatEncode(v.formats[0]!, 0.5, { effort: 0, scaleAwareQuality: true }).quality).toBe(65);
  });

  // ── round7 §4d: the profile-GLOBAL knobs reach the fan-out (the already-wired path, proven pure) ──
  // The worker builds its FormatEncodeGlobal from the TOP-LEVEL profile (fix.worker.ts:531-537) and feeds it
  // to formatEncode per (format × tier). Model that here: thread the profile's own globals (effort,
  // avifSubsample) into formatEncode and assert they survive onto every fan-out entry (effort) / onto the
  // AVIF entries only (avifSubsample). This is the pure proof that App.tsx populating these knobs is honored.
  function fanoutGlobals(p: ExportProfile, imagePath: string) {
    const v = validateProfile(p);
    if (!v.ok) return { ok: false as const, errors: v.errors };
    const g = { effort: p.effort ?? 0, scaleAwareQuality: p.scaleAwareQuality ?? false, avifSubsample: p.avifSubsample };
    const rows = v.tiers.flatMap((tier) =>
      v.formats.map((fmt) => {
        const fe = formatEncode(fmt, tier.scale, g);
        return { image: tieredName(imagePath, tier.suffix, fe.targetMime), mime: fe.targetMime, effort: fe.effort, subsample: fe.avifSubsample };
      }),
    );
    return { ok: true as const, rows };
  }

  it('profile-global effort reaches ALL fan-out entries (png/webp/avif × every tier)', () => {
    const p: ExportProfile = {
      formats: [{ format: 'image/png' }, { format: 'image/webp', quality: 80 }, { format: 'image/avif', quality: 70 }],
      tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }, { label: 'half', scale: 0.5, suffix: '_540p' }],
      effort: 6,
    };
    const d = fanoutGlobals(p, 'ui/btn.png');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.rows).toHaveLength(6); // 3 formats × 2 tiers
    expect(d.rows.every((r) => r.effort === 6)).toBe(true); // global effort folded onto every target
  });

  it('profile-global avifSubsample reaches AVIF fan-out entries ONLY (never webp/png)', () => {
    const p: ExportProfile = {
      formats: [{ format: 'image/webp', quality: 85 }, { format: 'image/avif', quality: 70 }, { format: 'image/png' }],
      tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }],
      avifSubsample: 3,
    };
    const d = fanoutGlobals(p, 'ui/btn.png');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const avif = d.rows.filter((r) => r.mime === 'image/avif');
    const nonAvif = d.rows.filter((r) => r.mime !== 'image/avif');
    expect(avif.length).toBeGreaterThan(0);
    expect(avif.every((r) => r.subsample === 3)).toBe(true); // AVIF entries carry the 4:4:4 knob
    expect(nonAvif.every((r) => r.subsample === undefined)).toBe(true); // webp/png never see it
  });

  it('absent profile-global avifSubsample ⇒ AVIF entries omit it (byte-identical default path)', () => {
    const p: ExportProfile = { formats: [{ format: 'image/avif', quality: 70 }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const d = fanoutGlobals(p, 'x.png');
    expect(d.ok && d.rows.every((r) => r.subsample === undefined)).toBe(true);
  });

  it('deterministic — same profile ⇒ same decision rows', () => {
    const p: ExportProfile = {
      formats: [{ format: 'image/avif', quality: 60 }, { format: 'image/webp' }],
      tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }, { label: 'half', scale: 0.5, suffix: '_540p' }],
    };
    expect(fanoutDecision(p, 'p.png', 'p.json')).toEqual(fanoutDecision(p, 'p.png', 'p.json'));
  });
});

// ── PER-REF OVERRIDE fan-out decision (round10-profile-overrides.md) ──────────────────────────────────────
// The worker resolves each ref through resolveProfileForRef BEFORE the same tieredName/variantManifestName/
// formatEncode composition modeled above (fix.worker.ts Site A/B: rp = resolveProfile(ref); refMulti =
// rp.formats.length>1). So an override flows through the EXACT same naming + encode path — proven here by
// driving the decision through resolveProfileForRef. Load-bearing: a NO-MATCH ref must reproduce the base
// fan-out byte-for-byte (additivity).

const baseGlobal = { effort: 0, scaleAwareQuality: false };

/** Model the worker's per-ref fan-out decision: resolve the ref through resolveProfileForRef, then compose
 *  names/opts exactly as the worker does (refMulti = rp.formats.length > 1). */
function overrideFanoutDecision(p: ExportProfile, ref: string, kind: FixAssetKind, imagePath: string, manifestPath: string) {
  const v = validateProfile(p);
  if (!v.ok) return { ok: false as const, errors: v.errors };
  const rp = resolveProfileForRef(ref, kind, v.formats, baseGlobal, v.overrides);
  const refMulti = rp.formats.length > 1;
  const rows: { image: string; manifest: string; mime: ImageMime; lossless: boolean; quality: number; near: number; subsample?: number }[] = [];
  for (const tier of v.tiers) {
    for (const fmt of rp.formats) {
      const fe = formatEncode(fmt, tier.scale, rp.global);
      rows.push({
        image: tieredName(imagePath, tier.suffix, fe.targetMime),
        manifest: variantManifestName(manifestPath, tier.suffix, fe.targetMime, refMulti),
        mime: fe.targetMime,
        lossless: fe.lossless,
        quality: fe.quality,
        near: fe.webpNearLossless,
        subsample: fe.avifSubsample,
      });
    }
  }
  return { ok: true as const, rows };
}

describe('per-ref override fan-out decision (round10)', () => {
  const fonts444: ExportProfile = {
    formats: [{ format: 'image/webp', quality: 85 }],
    tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }],
    overrides: [{ match: 'fonts', formats: [{ format: 'image/avif', quality: 90 }], avifSubsample: 3 }],
  };

  it('NO-MATCH ref ⇒ byte-identical to the base (no-override) fan-out — additivity', () => {
    const overridden = overrideFanoutDecision(fonts444, 'ui/btn.png', 'loose', 'ui/btn.png', 'ui/btn.json');
    const plain = fanoutDecision({ formats: fonts444.formats, tiers: fonts444.tiers }, 'ui/btn.png', 'ui/btn.json');
    expect(overridden).toEqual(plain);
  });

  it('fonts→AVIF 4:4:4: matching ref REPLACES formats + merges avifSubsample onto the running global', () => {
    const d = overrideFanoutDecision(fonts444, 'fonts/title.png', 'loose', 'fonts/title.png', 'fonts/title.json');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    // Single-format override ⇒ refMulti false ⇒ LEGACY manifest name; image ext-swapped to avif; subsample 3.
    expect(d.rows).toEqual([
      { image: 'fonts/title_1080p.avif', manifest: 'fonts/title_1080p.json', mime: 'image/avif', lossless: false, quality: 90, near: 100, subsample: 3 },
    ]);
  });

  it('dir-prefix matches nested refs but NOT a sibling prefix (fonts vs fonts2)', () => {
    const nested = overrideFanoutDecision(fonts444, 'fonts/bold/x.png', 'loose', 'fonts/bold/x.png', 'fonts/bold/x.json');
    expect(nested.ok && nested.rows[0]!.mime).toBe('image/avif');
    const sibling = overrideFanoutDecision(fonts444, 'fonts2/x.png', 'loose', 'fonts2/x.png', 'fonts2/x.json');
    expect(sibling.ok && sibling.rows[0]!.mime).toBe('image/webp'); // base, not the override
  });

  it('override format COUNT drives per-ref refMulti ⇒ tokened manifests only for the matched ref', () => {
    const p: ExportProfile = {
      formats: [{ format: 'image/webp', quality: 80 }], // base: single ⇒ legacy names
      tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }],
      overrides: [{ match: 'fx', formats: [{ format: 'image/avif', quality: 70 }, { format: 'image/webp', quality: 80 }] }],
    };
    const matched = overrideFanoutDecision(p, 'fx/spark.png', 'loose', 'fx/spark.png', 'fx/spark.json');
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;
    // refMulti true for the matched ref ⇒ format token in the manifest names.
    expect(matched.rows.map((r) => r.manifest)).toEqual(['fx/spark_1080p.avif.json', 'fx/spark_1080p.webp.json']);
    // A non-matching ref keeps the single-format LEGACY manifest name (refMulti false).
    const plain = overrideFanoutDecision(p, 'ui/btn.png', 'loose', 'ui/btn.png', 'ui/btn.json');
    expect(plain.ok && plain.rows.map((r) => r.manifest)).toEqual(['ui/btn_1080p.json']);
  });

  it('type:loose override does NOT touch a pixi/atlas ref (kind mismatch)', () => {
    const p: ExportProfile = {
      formats: [{ format: 'image/webp', quality: 85 }],
      tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }],
      overrides: [{ match: 'type:loose', formats: [{ format: 'image/avif', quality: 70 }] }],
    };
    const loose = overrideFanoutDecision(p, 'a.png', 'loose', 'a.png', 'a.json');
    expect(loose.ok && loose.rows[0]!.mime).toBe('image/avif');
    const pixi = overrideFanoutDecision(p, 'sheet.png', 'pixi', 'sheet.png', 'sheet.json');
    expect(pixi.ok && pixi.rows[0]!.mime).toBe('image/webp'); // base, unaffected
  });
});

// ── FORMAT-ONLY profile ASSET-SELECTION decision (finding [0] fix-a) ──────────────────────────────────────
// The riding fan-out in the resize/transcode handlers only fires for assets the ANALYSIS flagged (a format
// finding ⇒ transcode op, an oversize finding ⇒ resize op). A FORMAT-ONLY profile (one scale-1 tier) is an
// EXPLICIT request to emit the chosen formats for the WHOLE folder, so the worker now runs a first-class pass
// over EVERY eligible loose asset, independent of findings. There is no worker harness (B2), so the SELECTION
// rule the new pass applies is modeled + asserted here against the same pure gates the worker uses.

/** A loose asset as the worker sees it at the format-only pass: its ref, whether the analysis flagged it
 *  (drove a riding transcode/resize op = profileOwned), and whether an earlier transform claimed its path
 *  (replaced/dropped). `isAtlas` excludes atlas pages (loose-only scope). */
type LooseAsset = { ref: string; flagged: boolean; claimed: boolean; isAtlas: boolean };

/** Model the worker's format-only pass selection (fix.worker.ts): a profile with NO lower tier
 *  (profileHasLowerTier=false) fans out every loose, non-atlas asset whose path is neither owned by a riding
 *  op (flagged) nor claimed by a transform. Returns the refs that get variants emitted. Order-preserving. */
function formatOnlySelection(p: ExportProfile, assets: LooseAsset[]): string[] {
  const v = validateProfile(p);
  if (!v.ok) return [];
  const formatOnly = !v.tiers.some((t) => t.scale < 1); // single scale-1 tier ⇒ format-only
  if (!formatOnly) return assets.filter((a) => !a.isAtlas && !a.claimed).map((a) => a.ref); // tier loop owns all
  return assets.filter((a) => !a.isAtlas && !a.claimed).map((a) => a.ref); // flagged OR not — all eligible loose
}

describe('format-only profile asset selection (finding [0])', () => {
  const profile: ExportProfile = { formats: [{ format: 'image/avif', quality: 85 }, { format: 'image/webp' }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };

  it('CLEAN folder (no flagged assets) + format-only profile ⇒ EVERY eligible loose asset is emitted (not a silent no-op)', () => {
    // The regression: before fix-a, an UNFLAGGED loose image produced zero ops ⇒ no variants ⇒ silent nothing.
    const assets: LooseAsset[] = [
      { ref: 'a.png', flagged: false, claimed: false, isAtlas: false },
      { ref: 'b.png', flagged: false, claimed: false, isAtlas: false },
    ];
    expect(formatOnlySelection(profile, assets)).toEqual(['a.png', 'b.png']);
  });

  it('mixes flagged + clean loose images ⇒ ALL fanned out (flagged via riding op, clean via the new pass)', () => {
    const assets: LooseAsset[] = [
      { ref: 'flagged.png', flagged: true, claimed: false, isAtlas: false },
      { ref: 'clean.png', flagged: false, claimed: false, isAtlas: false },
    ];
    expect(formatOnlySelection(profile, assets)).toEqual(['flagged.png', 'clean.png']);
  });

  it('atlas pages and transform-claimed (replaced/dropped) refs are EXCLUDED', () => {
    const assets: LooseAsset[] = [
      { ref: 'sheet.png', flagged: false, claimed: false, isAtlas: true }, // atlas page — loose-only scope
      { ref: 'dropped-dupe.png', flagged: false, claimed: true, isAtlas: false }, // claimed by dedup/repack
      { ref: 'keep.png', flagged: false, claimed: false, isAtlas: false },
    ];
    expect(formatOnlySelection(profile, assets)).toEqual(['keep.png']);
  });

  it('atlas-only folder + format-only profile ⇒ ZERO eligible (worker surfaces an honest (profile) skip + assets=0)', () => {
    const assets: LooseAsset[] = [{ ref: 'sheet.png', flagged: false, claimed: false, isAtlas: true }];
    expect(formatOnlySelection(profile, assets)).toEqual([]);
  });
});

// ── SINGLE-FORMAT FORMAT-ONLY ATLAS-FORCE decision (AB-R3, round7-export-profile.md §5d-bis) ──────────────
// The residual the loose pass does NOT close: a PREBUILT atlas under a single-format format-only profile was
// transcoded to the chosen format ONLY when its page earned a `format` finding. The new worker driver now
// forces EVERY eligible prebuilt page. No worker harness (B2), so the per-atlas DECISION + the resulting page/
// sidecar rename is modeled here against the SAME pure primitives the worker calls: validateProfile (gate +
// single-format detection) → atlasNeedsForcedFormat (eligibility) → renamedTo (page) + repointAtlasImage
// (sidecar). Load-bearing: only a SINGLE-format format-only profile forces; multi-format / multi-tier refuse.

const sheet = (imageRef: string): Atlas => ({
  name: 'sheet',
  imageRef,
  size: { w: 1024, h: 1024 },
  sprites: [
    { name: 'a', frame: { x: 0, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, sourceSize: { w: 16, h: 16 } },
  ],
  source: { kind: 'texturepacker-hash' },
});

/** Model the worker's atlas-force pass for ONE prebuilt atlas: gate (single-format format-only?) → eligibility
 *  (atlasNeedsForcedFormat) → on force, the page rename + the sidecar repoint. Mirrors the worker driver. */
function atlasForceDecision(
  p: ExportProfile,
  args: { pagePath: string; sidecarPath: string; atlas: Atlas; sourceMime: ImageMime; isSpineMultiPage?: boolean; hasSidecar?: boolean; alreadyClaimed?: boolean },
) {
  const v = validateProfile(p);
  if (!v.ok) return { ok: false as const, errors: v.errors };
  const formatOnly = !v.tiers.some((t) => t.scale < 1); // single scale-1 tier ⇒ format-only (driver gate)
  const multi = v.formats.length > 1; // multi-format ⇒ driver gated OFF (profileMulti)
  const targetMime = v.formats[0]!.format;
  const decision = atlasNeedsForcedFormat({
    sourceMime: args.sourceMime,
    targetMime,
    isMultiFormat: multi,
    isSpineMultiPage: args.isSpineMultiPage ?? false,
    hasSidecar: args.hasSidecar ?? true,
    alreadyClaimed: args.alreadyClaimed ?? false,
  });
  // The driver only runs under format-only + single-format; outside that it never forces (byte-identical).
  const wouldRun = formatOnly && !multi;
  if (!wouldRun || !decision.force) return { ok: true as const, forced: false, skipReason: decision.skipReason };
  const newPage = renamedTo(args.pagePath, targetMime);
  const repointed = repointAtlasImage(args.atlas, args.sidecarPath, newPage);
  return { ok: true as const, forced: true, newPage, imageRef: repointed.imageRef };
}

describe('single-format format-only atlas-force decision (AB-R3)', () => {
  it('single-format AVIF, PNG sheet that earned NO finding ⇒ FORCED: page → .avif, sidecar repointed', () => {
    const p: ExportProfile = { formats: [{ format: 'image/avif', quality: 85 }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const d = atlasForceDecision(p, { pagePath: 'ui/sheet.png', sidecarPath: 'ui/sheet.json', atlas: sheet('sheet.png'), sourceMime: 'image/png' });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.forced).toBe(true);
    expect(d.newPage).toBe('ui/sheet.avif'); // page ext-swapped to the single target format
    expect(d.imageRef).toBe('sheet.avif'); // sidecar meta.image repointed (same dir ⇒ basename) — no dangle
  });

  it('AVIF source + AVIF target ⇒ NOT forced, NO skip noise (already the chosen format)', () => {
    const p: ExportProfile = { formats: [{ format: 'image/avif', quality: 85 }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const d = atlasForceDecision(p, { pagePath: 'ui/sheet.avif', sidecarPath: 'ui/sheet.json', atlas: sheet('sheet.avif'), sourceMime: 'image/avif' });
    expect(d.ok && d.forced).toBe(false);
    expect(d.ok && d.skipReason).toBeUndefined();
  });

  it('MULTI-format profile ⇒ atlas NOT forced (driver gated off; one page can\'t fan across N sidecars)', () => {
    const p: ExportProfile = { formats: [{ format: 'image/avif', quality: 85 }, { format: 'image/webp' }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const d = atlasForceDecision(p, { pagePath: 'ui/sheet.png', sidecarPath: 'ui/sheet.json', atlas: sheet('sheet.png'), sourceMime: 'image/png' });
    expect(d.ok && d.forced).toBe(false);
  });

  it('MULTI-tier profile ⇒ atlas NOT forced by this pass (the tier loop already forces it)', () => {
    const p: ExportProfile = { formats: [{ format: 'image/avif', quality: 85 }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }, { label: 'half', scale: 0.5, suffix: '_540p' }] };
    const d = atlasForceDecision(p, { pagePath: 'ui/sheet.png', sidecarPath: 'ui/sheet.json', atlas: sheet('sheet.png'), sourceMime: 'image/png' });
    expect(d.ok && d.forced).toBe(false);
  });

  it('no sidecar / multi-page Spine / already-claimed ⇒ NOT forced, surfaced skip (honest)', () => {
    const p: ExportProfile = { formats: [{ format: 'image/webp', quality: 80 }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const noSidecar = atlasForceDecision(p, { pagePath: 'a/s.png', sidecarPath: 'a/s.json', atlas: sheet('s.png'), sourceMime: 'image/png', hasSidecar: false });
    expect(noSidecar.ok && noSidecar.forced).toBe(false);
    expect(noSidecar.ok && noSidecar.skipReason).toContain('sidecar unavailable');
    const claimed = atlasForceDecision(p, { pagePath: 'a/s.png', sidecarPath: 'a/s.json', atlas: sheet('s.png'), sourceMime: 'image/png', alreadyClaimed: true });
    expect(claimed.ok && claimed.forced).toBe(false);
    expect(claimed.ok && claimed.skipReason).toContain('already claimed');
  });

  it('cross-dir sidecar ⇒ repointed imageRef stays relative to the SIDECAR dir (resolves back, no dangle)', () => {
    const p: ExportProfile = { formats: [{ format: 'image/webp', quality: 80 }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const d = atlasForceDecision(p, { pagePath: 'img/sheet.png', sidecarPath: 'data/sheet.json', atlas: sheet('../img/sheet.png'), sourceMime: 'image/png' });
    expect(d.ok && d.forced).toBe(true);
    if (!d.ok || !d.forced) return;
    expect(d.newPage).toBe('img/sheet.webp');
    expect(d.imageRef).toBe('../img/sheet.webp'); // relative to data/ → resolves back to img/sheet.webp
  });

  it('deterministic — same atlas + same single-format profile ⇒ same decision (page + repoint)', () => {
    const p: ExportProfile = { formats: [{ format: 'image/avif', quality: 70 }], tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }] };
    const a = atlasForceDecision(p, { pagePath: 'ui/sheet.png', sidecarPath: 'ui/sheet.json', atlas: sheet('sheet.png'), sourceMime: 'image/png' });
    const b = atlasForceDecision(p, { pagePath: 'ui/sheet.png', sidecarPath: 'ui/sheet.json', atlas: sheet('sheet.png'), sourceMime: 'image/png' });
    expect(a).toEqual(b);
  });
});

// ── MANUAL byte-identity check (B2 — no worker/OffscreenCanvas e2e harness exists) ───────────────────────
// The no-profile and single-format cases must be PIXEL byte-identical to today. There is no headless worker
// harness (createImageBitmap / OffscreenCanvas are browser-only), so this is verified MANUALLY:
//   1. `pnpm dev`, drop fixtures/sample-projects/<a folder with loose images + a TexturePacker atlas>.
//   2. Run the fix with the export-profile panel OFF → download zip A.
//   3. Run again with the panel ON, a SINGLE format = AVIF q85, no custom tiers → download zip B.
//   4. The image + manifest file NAMES in B must match A's (single-format ⇒ legacy names); the loose AVIF
//      bytes match A's AVIF (same encodeCanvas opts via formatEncode → feToEncodeOpts at scale 1, q85).
// The structural guarantee backing this: when the profile is ABSENT the worker's formatsToEmit is the single
// legacy descriptor (encOptsFor(eff,true)) and profileMulti=false, so names + encode opts are unchanged.
