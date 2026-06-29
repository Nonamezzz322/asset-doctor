// PURE atlas-sidecar repoint for the prebuilt-atlas PASSTHROUGH TRANSCODE (round20 #1). A prebuilt sheet
// that is NOT being repacked can still earn a `format` finding on its PAGE IMAGE (analyze.ts sizes atlas
// pages too) → a standalone `transcode` op. Re-encoding the page swaps its EXTENSION (sheet.png → sheet.webp),
// so the sidecar manifest's `meta.image` (TexturePacker JSON) / Spine `.atlas` texture line MUST be repointed
// at the new page or it DANGLES (the loader resolves a file that no longer exists). This helper computes the
// repointed Atlas; the worker re-serializes it via emitTexturePackerJson / emitSpineAtlasText.
//
// Routes through relativeImageRef(dirOf(sidecar), newPagePath) — the proven inverse of the parser's
// resolveImageRef (dedup-repoint.ts) — so the rewritten ref resolves back to the new page through
// @asset-doctor/parsers (same-dir collapses to a basename; cross-dir + cache-busted names handled). PURE path
// math + a shallow Atlas clone (frame geometry / mesh preserved): no pixels, no canvas, Node-testable.

import type { Atlas } from '@asset-doctor/core';
import { dirOf, relativeImageRef } from './dedup-repoint';

/** Return a shallow clone of `atlas` with `imageRef` repointed at `newPagePath`, expressed RELATIVE to the
 *  sidecar's own directory (so it re-parses back to the new page). Only the extension changes on a passthrough
 *  transcode — frames/trim/pivot/mesh AND the top-level `animations` map are carried verbatim (the shallow
 *  spread keeps them; `animations` refs frame keys, which a page rename does not touch). */
export function repointAtlasImage(atlas: Atlas, sidecarPath: string, newPagePath: string): Atlas {
  return { ...atlas, imageRef: relativeImageRef(dirOf(sidecarPath), newPagePath) };
}
