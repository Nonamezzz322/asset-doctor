// PURE test-double for the content-hash cache-busting reference-chain (docs/improvements/round9-cache-busting.md).
//
// Content-hash cache-busting renames every emitted image/sheet AD references to `name.<8hex>.ext` (hash =
// sha256 of the FINAL emitted bytes) and repoints EVERY referrer at the hashed name. For a static atlas / Spine
// page the referrer is the sheet's OWN sidecar: `meta.image` in the TexturePacker JSON, line 0 (the texture
// line) of the `.atlas` text — both of which `manifest.ts` derives verbatim from `atlas.imageRef`. So the
// cardinal ordering rule is: hash the IMAGE bytes → patch `imageRef` to the hashed image basename → emit the
// sidecar (it now embeds the hashed name) → hash the sidecar bytes.
//
// In the worker that patch is a single in-place mutation (`na.imageRef = basename(emittedImage)`), kept as the
// ONE source of truth (round9 §B3). This module exists ONLY as the PURE, golden-testable mirror of that one
// assignment: it is NEVER called by the worker. It lets `cache-bust.test.ts` prove the chain — that feeding a
// hashed image basename through `imageRef` and into `emitTexturePackerJson` / `emitSpineAtlasText` produces a
// sidecar whose referrer points at the hashed image (and whose own bytes — therefore its own hash — change as a
// result of the patch). No pixels, no canvas, no IO, no Date.now / Math.random — pure deterministic string work.

import type { Atlas } from '@asset-doctor/core';

/**
 * Return a NEW atlas with `imageRef` replaced by `hashedImageBasename` — the pure mirror of the worker's
 * in-place `na.imageRef = basename(emittedImage)` patch (round9 §3b/§3c). Non-destructive: the input atlas is
 * untouched (spreads into a fresh object); every other field (sprites, size, format, scale, source) is carried
 * through by reference unchanged, so a downstream `emitTexturePackerJson` / `emitSpineAtlasText` of the result
 * differs from the original ONLY in the referrer (`meta.image` / `.atlas` line 0).
 *
 * `hashedImageBasename` must be a BASENAME (the final emitted file name, e.g. `atlas-merged.a1b2c3d4.webp`),
 * not a directory path — matching what the worker writes into `imageRef` (the parsers/manifest convention is a
 * basename-relative texture reference). PURE: NEVER called by the worker (it owns the one in-place mutation);
 * exists solely as the golden test double for the reference-chain ordering.
 */
export function withHashedImageRef(atlas: Atlas, hashedImageBasename: string): Atlas {
  return { ...atlas, imageRef: hashedImageBasename };
}
