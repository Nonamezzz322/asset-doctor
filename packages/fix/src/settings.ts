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

import type { ImageMime } from '@asset-doctor/core';

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

/** The override-resolvable subset of encode options — exactly the fields a FixOverride may set. */
export interface EffectiveOptions {
  quality: number;
  effort: number;
  targetMime: ImageMime;
  webpNearLossless: number;
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
      };
    }
  }
  return out;
}
