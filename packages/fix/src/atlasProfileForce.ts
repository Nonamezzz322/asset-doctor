// PURE eligibility predicate for FORCING the chosen format onto a PREBUILT ATLAS page under a
// SINGLE-format format-only export profile (AB-R3, docs/improvements/round7-export-profile.md §5d-bis).
//
// The residual gap this closes: a format-only profile (one scale-1 tier ⇒ tieringOn=false) is an EXPLICIT
// "emit the chosen format for the WHOLE folder" request, but a prebuilt atlas page was transcoded ONLY when
// it earned a `format` finding (the passthrough-transcode op). A page already in the target format, near-
// optimal, or sub-threshold passed through VERBATIM ⇒ picking "AVIF, single tier" silently produced a MIXED
// folder. The worker now drives a first-class atlas-force pass; this module lifts the SAME branch logic the
// worker already applies inline at the prebuilt-atlas passthrough (multi-format guard / multi-page-Spine
// refusal / sidecar requirement / already-claimed) so the decision is total, deterministic and Node-tested.
//
// HONESTY (invariant 3): every refusal carries a `skipReason` so the worker can surface it in skipped[]
// (never a silent no-op). The ONE no-op that is NOT a refusal — source mime === target mime — returns
// force=false WITHOUT a reason (there is nothing to do and nothing to apologize for).
//
// SCOPE: SINGLE-format profiles only. A multi-format profile can't safely fan one atlas page across N
// sidecar entries (one sidecar resolves ONE page), so it is refused here exactly as the worker's existing
// multi-format atlas guard refuses it.

import type { ImageMime } from '@asset-doctor/core';

export interface AtlasForceArgs {
  /** The atlas page's CURRENT image mime (its on-disk format). */
  sourceMime: ImageMime;
  /** The profile's single target format (resolveProfile(ref).formats[0].format). */
  targetMime: ImageMime;
  /** True iff the resolved profile for this ref carries >1 format (cannot fan one page across N sidecars). */
  isMultiFormat: boolean;
  /** True iff this is a Spine `.atlas` page whose sidecar describes MORE than one page (emitSpineAtlasText
   *  writes ONE page ⇒ a multi-page sidecar would drop its siblings). */
  isSpineMultiPage: boolean;
  /** True iff a sidecar (TexturePacker JSON / Spine `.atlas`) is available to repoint at the new page. */
  hasSidecar: boolean;
  /** True iff a prior op/transform (passthrough transcode, repack, merge, dedup) already claimed this ref. */
  alreadyClaimed: boolean;
}

export interface AtlasForceDecision {
  /** True iff the worker should re-encode this atlas page to `targetMime` and repoint its sidecar. */
  force: boolean;
  /** Present whenever the page WOULD be a force candidate but is refused — surfaced in skipped[] (honest).
   *  Absent on a genuine force=true and on the source===target no-op (nothing to surface). */
  skipReason?: string;
}

/**
 * Decide whether a prebuilt atlas page must be force-transcoded to the format-only profile's single target.
 *
 * Total + deterministic. The gates (checked in a fixed order so the surfaced reason is stable):
 *   1. already claimed by another fix          ⇒ force=false, skip ("already repacked/re-emitted")
 *   2. no sidecar to repoint                    ⇒ force=false, skip ("sidecar unavailable")
 *   3. multi-page Spine atlas                   ⇒ force=false, skip ("multi-page Spine atlas")
 *   4. multi-format profile (one page, N fmts)  ⇒ force=false, skip ("atlas pages stay single-format")
 *   5. source mime === target mime (no-op)      ⇒ force=false, NO reason (already the chosen format)
 *   else                                        ⇒ force=true
 *
 * The reasons mirror the worker's existing inline prebuilt-atlas passthrough skips so the new driver reuses
 * the same honest phrasing (no new i18n surface).
 */
export function atlasNeedsForcedFormat(args: AtlasForceArgs): AtlasForceDecision {
  if (args.alreadyClaimed)
    return {
      force: false,
      skipReason: 'export profile: atlas already claimed by another fix — kept that page',
    };
  if (!args.hasSidecar)
    return {
      force: false,
      skipReason: 'export profile: atlas sidecar unavailable — kept original page',
    };
  if (args.isSpineMultiPage)
    return {
      force: false,
      skipReason: 'export profile: multi-page Spine atlas — kept original page',
    };
  if (args.isMultiFormat)
    return {
      force: false,
      skipReason: 'export profile: atlas pages stay single-format — kept original page',
    };
  if (args.sourceMime === args.targetMime) return { force: false }; // already the chosen format — no-op, nothing to surface
  return { force: true };
}
