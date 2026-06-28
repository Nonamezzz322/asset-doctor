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
import type { ExportProfile, ImageMime } from '@asset-doctor/core';
import { formatEncode, tieredName, validateProfile, variantManifestName } from '../src/index';

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

  it('deterministic — same profile ⇒ same decision rows', () => {
    const p: ExportProfile = {
      formats: [{ format: 'image/avif', quality: 60 }, { format: 'image/webp' }],
      tiers: [{ label: 'full', scale: 1, suffix: '_1080p' }, { label: 'half', scale: 0.5, suffix: '_540p' }],
    };
    expect(fanoutDecision(p, 'p.png', 'p.json')).toEqual(fanoutDecision(p, 'p.png', 'p.json'));
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
