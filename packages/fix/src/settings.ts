// Pure, deterministic settings helpers for the Phase-2 fix (design §4b). NO pixels, NO canvas, NO IO,
// NO Date.now / Math.random — integer math only, so the worker and any future caller resolve EXACTLY the
// same effective encode options for a given (ref, kind, base, overrides). Golden-testable.
//
// Two responsibilities:
//   1. scaleAwareQuality — port of the builder's applyScaleAwareQuality: lower the encode quality on
//      downscaled output (smaller scale ⇒ lower q), floored so we never produce garbage. Pure formula.
//   2. resolveOptions — fold an ordered override list onto a base, matching by dir-aware folder prefix
//      OR a `type:*` pseudo-key, with LATER overrides winning (stable, order-preserving). The override
//      shape is structurally identical to the worker's FixOverride (kept here so packages/fix stays a
//      leaf — it must NOT import from the apps/web worker).

import type { FormatTarget, ImageMime } from '@asset-doctor/core';

/** Floor below which scale-aware quality never drops, so a heavy downscale can't yield mush. */
export const SCALE_QUALITY_FLOOR = 50;

/**
 * Builder applyScaleAwareQuality, ported verbatim (§4b): scale a 0..100 quality down for downscaled
 * output, clamped to [SCALE_QUALITY_FLOOR, 100]. Pure integer math (Math.round), deterministic.
 *
 * @param q       base quality, 0..100.
 * @param scale   output scale factor (1 = full size). scale >= 1 ⇒ no reduction.
 * @param enabled when false ⇒ identity (returns q unchanged — today's behavior).
 */
export function scaleAwareQuality(q: number, scale: number, enabled: boolean): number {
  if (!enabled || scale >= 1) return q;
  return Math.max(SCALE_QUALITY_FLOOR, Math.min(100, q - Math.round((1 - scale) * 50)));
}

/** The asset kind a `type:*` override key matches. Mirrors the worker's pool/kind vocabulary. */
export type FixAssetKind = 'spine' | 'pixi' | 'loose';

/**
 * One per-folder / per-type override. Structurally identical to the worker's FixOverride (fix-protocol)
 * so the worker can pass its list straight through; redeclared here to keep packages/fix dependency-free
 * of the apps/web layer.
 */
export interface FixOverride {
  /** Dir-aware folder prefix (e.g. "ui" or "ui/buttons") OR a pseudo-type key 'type:spine'|'type:pixi'|'type:loose'. */
  match: string;
  quality?: number;
  effort?: number;
  targetMime?: ImageMime;
  webpNearLossless?: number;
}

/** The override-resolvable subset of encode options — exactly the fields a FixOverride may set, PLUS
 *  `lossless` (round7-export-profile.md B1). `lossless` is NOT override-settable in v1 (FixOverride has
 *  no `lossless`); it defaults false and is threaded from the base so a profile asking for lossless
 *  webp/png is genuinely lossless rather than silently lossy (invariant 3 — never a faked-lossless).
 *  Default false ⇒ byte-identical to today's loose/tier encode path (which never set lossless). */
export interface EffectiveOptions {
  quality: number;
  effort: number;
  targetMime: ImageMime;
  webpNearLossless: number;
  lossless: boolean;
}

/** True iff `match` selects the asset at `ref` of kind `kind`. */
function overrideMatches(match: string, ref: string, kind: FixAssetKind): boolean {
  if (match.startsWith('type:')) return match.slice(5) === kind;
  // Folder-prefix match: the folder itself, or anything nested under it. Exact `ref===match` lets a
  // single-file path also be targeted directly.
  return ref === match || ref.startsWith(`${match}/`);
}

/**
 * Resolve the effective encode options for one asset. Starts from `base`, then applies every matching
 * override IN GIVEN ORDER so LATER overrides win (stable, order-preserving — not a "most specific"
 * heuristic). Only fields the override explicitly sets are overridden; the rest fall through from base.
 * Pure and deterministic: same inputs ⇒ same output.
 */
export function resolveOptions(
  ref: string,
  kind: FixAssetKind,
  base: EffectiveOptions,
  overrides?: FixOverride[],
): EffectiveOptions {
  let out: EffectiveOptions = { ...base };
  if (overrides) {
    for (const o of overrides) {
      if (!overrideMatches(o.match, ref, kind)) continue;
      out = {
        quality: o.quality ?? out.quality,
        effort: o.effort ?? out.effort,
        targetMime: o.targetMime ?? out.targetMime,
        webpNearLossless: o.webpNearLossless ?? out.webpNearLossless,
        // `lossless` is NOT override-settable in v1 — it falls through from the base unchanged.
        lossless: out.lossless,
      };
    }
  }
  return out;
}

/** Default lossy quality (0..100) when a FormatTarget omits `quality` (design §2). */
export const DEFAULT_FORMAT_QUALITY = 85;

/** The encode parameters one FormatTarget resolves to for a given scale — the EncodeOpts-shaped fields
 *  the worker passes to encodeCanvas. `targetMime`/`quality`/`lossless`/`effort`/`webpNearLossless`
 *  mirror the worker's EncodeOpts; the optional avif / png fields are forwarded only when set. */
export interface FormatEncode {
  targetMime: ImageMime;
  /** 0..100 (the settings vocabulary; the worker divides by 100 for encodeCanvas's 0..1). */
  quality: number;
  lossless: boolean;
  effort: number;
  /** webp near-lossless 0..100 (100 ⇒ off). */
  webpNearLossless: number;
  avifQualityAlpha?: number;
  avifSubsample?: number;
  pngRecompressLevel?: number;
}

/**
 * Map one FormatTarget + output scale + the profile's global knobs → a FormatEncode (design §4b). PURE
 * and deterministic — the single source of truth for how a profile target becomes encode parameters, so
 * the worker can't drift from this tested mapping. Rules:
 *   - quality: the target's `quality` (default DEFAULT_FORMAT_QUALITY), folded through scaleAwareQuality
 *     (floor SCALE_QUALITY_FLOOR) when enabled and downscaling. Ignored downstream for png/lossless.
 *   - PNG: lossless implied (native lossless); quality is irrelevant; pngRecompressLevel forwarded.
 *   - WEBP: lossless | near-lossless (`near`, 100/omit ⇒ off) | lossy. `near` is forwarded as
 *     webpNearLossless; avif fields are not.
 *   - AVIF: lossy only (validateProfile already rejected lossless-avif); avifQualityAlpha/avifSubsample
 *     forwarded; webpNearLossless is off (100).
 * `near`/`webpNearLossless` and the avif fields are forwarded ONLY for their owning format so an unrelated
 * codec never sees a stray knob. No Date/random; integer math via scaleAwareQuality.
 */
export function formatEncode(
  fmt: FormatTarget,
  scale: number,
  global: {
    effort: number;
    scaleAwareQuality: boolean;
    avifQualityAlpha?: number;
    avifSubsample?: number;
    pngRecompressLevel?: number;
  },
): FormatEncode {
  const baseQuality = fmt.quality ?? DEFAULT_FORMAT_QUALITY;
  const quality = scaleAwareQuality(baseQuality, scale, global.scaleAwareQuality);

  if (fmt.format === 'image/png') {
    return {
      targetMime: 'image/png',
      quality, // irrelevant for png (native lossless); kept for shape consistency.
      lossless: true, // PNG is always lossless in our wiring.
      effort: global.effort,
      webpNearLossless: 100, // off — not a webp.
      pngRecompressLevel: global.pngRecompressLevel,
    };
  }

  if (fmt.format === 'image/webp') {
    // 100/omit ⇒ off. Lossless wins over near (a lossless emit ignores near-lossless).
    const near = fmt.lossless ? 100 : (fmt.near ?? 100);
    return {
      targetMime: 'image/webp',
      quality,
      lossless: fmt.lossless ?? false,
      effort: global.effort,
      webpNearLossless: near,
    };
  }

  // AVIF — lossy only (lossless-avif rejected by validateProfile). avif knobs forwarded.
  return {
    targetMime: 'image/avif',
    quality,
    lossless: false,
    effort: global.effort,
    webpNearLossless: 100, // off — not a webp.
    avifQualityAlpha: global.avifQualityAlpha,
    avifSubsample: global.avifSubsample,
  };
}
