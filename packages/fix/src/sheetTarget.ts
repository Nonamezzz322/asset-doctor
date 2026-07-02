// PURE sheet-page format decision (settings-page design §0.1/§4 — docs/improvements follow-up to
// round7-export-profile.md). The fix worker composes NEW sheet pages at three sites — STATIC repack/merge,
// SPINE repack, and the Feature-4 pack — and each historically hardcoded its encode target (lossless WebP /
// PNG / the legacy resolveOptions targetMime). This module is the ONE total, deterministic decision that maps
// {site, isSpine, spinePageFormat, resolved profile formats, legacy resolved target} → the page encode target,
// so the worker (and its Node tests) consume the SAME tested rule and can't drift.
//
// THE RULE (per the design §0.1 table — every default reproduces today's bytes):
//   - SPINE pages: `spinePageFormat` governs. 'png' (the DEFAULT — the worker maps an absent wire field
//     here) ⇒ PNG, runtime-safe, byte-identical to today. 'profile' ⇒ the resolved profile's formats[0]
//     when a profile is ON, else the LEGACY resolved target (resolveOptions(ref,'spine'|'loose',…)).
//   - STATIC repack/merge: profile ON ⇒ formats[0]; profile OFF ⇒ lossless WebP UNCONDITIONALLY (today's
//     hardcode). Repack/merge is a *lossless geometric* fix — routing it through the lossy loose-transcode
//     default because a knob moved pages would be a silent degrade (honesty guards forbid it); the explicit
//     vehicle for "sheets in format X" is the profile.
//   - STATIC pack: profile ON ⇒ formats[0]; profile OFF ⇒ the LEGACY resolved target (today's path — packed
//     sheets already followed the lossy loose default via resolveOptions).
//   - Multi-format profile ⇒ STILL formats[0] + `multiNote` (one sidecar references ONE page — fan-out is
//     impossible; the worker surfaces one honest skipped[] note per emitted sheet, never a silent pick).
//
// HONESTY (invariant 3): this module only SELECTS among honest encodes — the worker's keep-original-on-
// size-loss and PNG-fallback guards run downstream unchanged. Zero IO, no Date/Math.random.

import type { FormatTarget, ImageMime } from '@asset-doctor/core';

/** The wire vocabulary for FixOptions.spinePageFormat. The worker maps an ABSENT wire field → 'png'
 *  (the default — byte-identical to today's hardcoded PNG Spine pages). */
export type SpinePageFormat = 'png' | 'profile';

export interface SheetTargetArgs {
  /** 'repack' = STATIC repack/merge + SPINE repack; 'pack' = the Feature-4 loose→sheet pack. The two
   *  differ ONLY in the static profile-OFF fallback (repack ⇒ lossless WebP; pack ⇒ the legacy target). */
  site: 'repack' | 'pack';
  isSpine: boolean;
  /** The worker maps an absent FixOptions.spinePageFormat → 'png' before calling. Ignored for static. */
  spinePageFormat: SpinePageFormat;
  /** resolveProfile(ref).formats for this ref's representative; [] ⇒ profile OFF. */
  profileFormats: readonly FormatTarget[];
  /** The LEGACY resolved target for THIS site (pack: resolveOptions(outDir,'loose',…).targetMime; Spine
   *  repack: resolveOptions(ref,'spine',…).targetMime). UNUSED for static repack/merge (profile-OFF there
   *  is the lossless-WebP hardcode, never this). */
  legacyMime: ImageMime;
}

/** What the worker maps each decision to (its EXISTING closures — no encode logic duplicated here):
 *  - 'spine-png'     ⇒ 'image/png'  + { allowPngFallback: true }                    (today's Spine literal)
 *  - 'webp-lossless' ⇒ 'image/webp' + { lossless: true, allowPngFallback: true }    (today's repack literal)
 *  - 'legacy'        ⇒ mime + encOptsFor(resolveOptions(ref, kind, {…, targetMime: mime}), true)
 *  - 'profile'       ⇒ format.format + feToEncodeOpts(formatEncode(format, 1, resolveProfile(ref).global));
 *                      `multiNote` ⇒ the profile carried >1 format — the worker pushes one honest
 *                      skipped[] note per emitted sheet (formats[0] shipped; fan-out impossible). */
export type SheetTargetDecision =
  | { kind: 'spine-png' }
  | { kind: 'webp-lossless' }
  | { kind: 'legacy'; mime: ImageMime }
  | { kind: 'profile'; format: FormatTarget; multiNote: boolean };

/**
 * Decide the encode target for ONE freshly-composed sheet page. Total and deterministic — same args ⇒
 * a structurally-equal decision; no branch consults anything but the args.
 */
export function sheetPageTarget(a: SheetTargetArgs): SheetTargetDecision {
  const profileOn = a.profileFormats.length > 0;
  if (a.isSpine) {
    if (a.spinePageFormat !== 'profile') return { kind: 'spine-png' }; // DEFAULT — today's bytes
    if (profileOn)
      return {
        kind: 'profile',
        format: a.profileFormats[0]!,
        multiNote: a.profileFormats.length > 1,
      };
    return { kind: 'legacy', mime: a.legacyMime };
  }
  if (profileOn)
    return {
      kind: 'profile',
      format: a.profileFormats[0]!,
      multiNote: a.profileFormats.length > 1,
    };
  // Profile OFF: repack/merge keeps the lossless-WebP hardcode UNCONDITIONALLY (§0.1 — a geometry fix is
  // never silently routed through the lossy loose default); pack keeps its legacy lossy path (today's bytes).
  return a.site === 'repack' ? { kind: 'webp-lossless' } : { kind: 'legacy', mime: a.legacyMime };
}
