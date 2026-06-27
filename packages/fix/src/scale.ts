// PURE scale-tier helpers (design docs/scale-tiers-design.md §1/§2/§3b). NO pixels, NO canvas, NO IO,
// NO Date.now / Math.random — integer-only, deterministic geometry so the worker (and any future caller)
// resolves EXACTLY the same tier geometry/names for given inputs. Golden-testable.
//
// This is the loose-image analogue of scaleAtlas (repack.ts): scaleAtlas stays the ATLAS geometry
// primitive (untouched); scaleLoose is the same 1px-floor downscale for a standalone image. The TIER
// LOOP (apps/web worker) owns oversize clamping and stamps `.scale` on tiered atlases — neither of those
// belongs here. We NEVER upscale (scale >= 1 ⇒ identity), matching scaleAtlas + the builder ladder.

import type { ImageMime, ScaleTier, Size } from '@asset-doctor/core';
import { EXT } from './dedup-exec';

/**
 * Default tier ladder — a verbatim port of the builder's DEFAULT_SCALES (config.ts:7), high→low.
 * scale 1 is the source/top tier (NEVER upscaled); every suffix is a RESOLUTION_TOKEN so the generated
 * tiers round-trip back into one variant cluster on re-ingest. Defaults reproduce today when scaleTiers
 * is empty/absent — this ladder only takes effect when a caller opts in.
 */
export const DEFAULT_SCALE_TIERS: readonly ScaleTier[] = [
  { scale: 1, suffix: '_1080p' },
  { scale: 0.75, suffix: '_720p' },
  { scale: 0.5, suffix: '_540p' },
];

/**
 * Resolution-only suffix token set groupVariants recognizes — the RESOLUTION subset of variants.ts
 * TOKEN, EXCLUDING the format tokens (png|webp|avif|jpeg). A `_webp` suffix would mis-stem and collide
 * with the format-variant logic, so it is rejected. Leading separator is `_` or `-`; the body is a
 * pixel-height token (`720p`), a density token (`@2x`/`2x`), or `hd`/`sd`. Case-insensitive.
 */
export const RESOLUTION_TOKEN = /^[_-](\d{2,4}p|@?\d+x|hd|sd)$/i;

/**
 * Scaled size for a loose image — the loose-image analogue of scaleAtlas geometry: the SAME
 * `Math.max(1, Math.round(n * scale))` 1px floor (no zero-pixel dimension), integer-only, deterministic.
 * scale >= 1 ⇒ identity (NEVER upscale; a fresh copy so callers can't alias the input). Pure.
 */
export function scaleLoose(size: Size, scale: number): Size {
  const px = (n: number): number => Math.max(1, Math.round(n * scale));
  return scale >= 1 ? { w: size.w, h: size.h } : { w: px(size.w), h: px(size.h) };
}

/**
 * Insert a tier suffix before the extension, optionally swapping the extension for a transcoded mime.
 *   tieredName("ui/btn.png", "_720p")              → "ui/btn_720p.png"
 *   tieredName("ui/btn.png", "_720p", "image/webp") → "ui/btn_720p.webp"
 *   tieredName("ui/atlas.json", "_540p")           → "ui/atlas_540p.json"  (manifest ext kept)
 * The top tier (scale 1, e.g. "_1080p") is STILL suffixed so every tier shares one resolution stem and
 * the set round-trips into a single variant cluster. Pure string math, deterministic.
 */
export function tieredName(path: string, suffix: string, mime?: ImageMime): string {
  const ext = mime ? EXT[mime] : path.slice(path.lastIndexOf('.'));
  const stem = path.replace(/\.[a-z0-9]+$/i, '');
  return `${stem}${suffix}${ext}`;
}

/** Outcome of validateTiers: a fail-closed normalized ladder, or the list of reasons it was rejected. */
export type TierValidation =
  | { ok: true; tiers: ScaleTier[] }
  | { ok: false; errors: string[] };

/**
 * Fail-closed validation of a tier ladder (design §3b). Returns the normalized, deduped, high→low-sorted
 * ladder on success, or the structured list of rejection reasons. The caller (worker) turns each rejection
 * into a skipped[] honesty entry rather than silently emitting a bad export. Rejects:
 *   - empty input (nothing to emit);
 *   - any non-finite scale, scale <= 0, or scale > 1 (UPSCALE forbidden);
 *   - empty suffix, or a suffix not matching RESOLUTION_TOKEN (so tiers always cluster on re-ingest);
 *   - duplicate suffixes (case-insensitive — they would clobber each other's emitted names);
 *   - a ladder with NO scale === 1 top tier (must include/handle the full-source top tier).
 * Pure and deterministic: same input ⇒ same result (stable high→low sort, ties broken by suffix).
 */
export function validateTiers(tiers: ScaleTier[]): TierValidation {
  const errors: string[] = [];
  if (tiers.length === 0) errors.push('empty: no tiers given');

  const seen = new Set<string>();
  let hasTopTier = false;
  for (const t of tiers) {
    const s = t.scale;
    if (!Number.isFinite(s) || s <= 0) errors.push(`badScale: ${String(s)} (must be in (0,1])`);
    else if (s > 1) errors.push(`upscale: ${String(s)} (scale must be <= 1; never upscale)`);
    else if (s === 1) hasTopTier = true;

    const suffix = t.suffix;
    if (!suffix) errors.push('badSuffix: empty suffix');
    else if (!RESOLUTION_TOKEN.test(suffix)) errors.push(`badSuffix: "${suffix}" is not a resolution token`);
    else {
      const key = suffix.toLowerCase();
      if (seen.has(key)) errors.push(`dupSuffix: "${suffix}"`);
      else seen.add(key);
    }
  }
  if (tiers.length > 0 && !hasTopTier) errors.push('noTopTier: ladder must include a scale=1 top tier');

  if (errors.length > 0) return { ok: false, errors };

  // Normalize: stable high→low by scale, suffix as the deterministic tiebreaker.
  const sorted = [...tiers].sort((a, b) => b.scale - a.scale || a.suffix.localeCompare(b.suffix));
  return { ok: true, tiers: sorted };
}
