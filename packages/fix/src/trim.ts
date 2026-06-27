// Feature 4 (pack loose assets into spritesheets) — PURE alpha-bbox → trim metadata. This is the SINGLE
// place the Spine Y-flip lives: `spineOffsetFrom` converts a TOP-LEFT opaque bbox into the libGDX
// BOTTOM-LEFT `offset` that `emitSpineAtlasText` writes verbatim (the emitter is unchanged — editing it
// would double-flip an already-bottom-left value). `alphaBBox` reuses `RGBASource`/`Region`/
// `POLY_ALPHA_THRESHOLD` from the polygon packer so the trim threshold can never drift from mask/mesh.
// Pure, integer-only, NO canvas/getImageData/browser APIs (the worker hands the pixels in).
// See docs/spritesheet-packing-design.md § 3a + § 5 (field math).

import type { Rect, Size, TrimRect } from '@asset-doctor/core';
import type { RGBASource, Region } from './mask';
import { POLY_ALPHA_THRESHOLD } from './polygon-config';

/** Read the alpha of pixel `(px, py)` of `src` (out-of-bounds ⇒ 0 / transparent). Mirrors mask.ts's
 *  private `alphaAt` so the bounds/transparency convention stays identical across the trim + nest paths. */
function alphaAt(src: RGBASource, px: number, py: number): number {
  if (px < 0 || py < 0 || px >= src.width) return 0;
  return src.data[(py * src.width + px) * 4 + 3] ?? 0;
}

/**
 * Opaque bounding box of `region` in `src`, in TOP-LEFT source-px coords. A pixel counts as opaque iff
 * `alpha >= POLY_ALPHA_THRESHOLD` (=1; the SAME threshold mask/mesh use — single source of truth, so trim
 * never drifts). `w/h` are the opaque extent (≥1 when any pixel clears the threshold). A region with NO
 * opaque pixel ⇒ `null` (caller decides 1×1 sentinel / spine-skip — never a zero-size region). Pure,
 * integer-only, no canvas.
 */
export function alphaBBox(src: RGBASource, region: Region): TrimRect | null {
  let minX = region.w;
  let minY = region.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      if (alphaAt(src, region.x + x, region.y + y) >= POLY_ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // fully transparent — no opaque pixel found
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * TexturePacker `spriteSourceSize` (TOP-LEFT origin, TP convention) from the untrimmed size + the opaque
 * bbox: `{ x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h }`. `sourceSize` is accepted for symmetry with
 * `spineOffsetFrom` and to document that the result is the trim INSET relative to the full image; TP
 * needs no flip here. Pure, integer-only.
 */
export function spriteSourceSizeFrom(_sourceSize: Size, bbox: TrimRect): Rect {
  return { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h };
}

/**
 * Spine `offset` (libGDX BOTTOM-LEFT origin) from the untrimmed size + the TOP-LEFT opaque bbox:
 *   offsetX = bbox.x
 *   offsetY = sourceSize.h - (bbox.y + bbox.h)   ← the Y-FLIP.
 * This is the ONLY place the flip lives. `packLoose` stores the result into `spriteSourceSize.y` for
 * `kind:'spine'` so `emitSpineAtlasText` writes it verbatim and a re-parse recovers it. Pure,
 * integer-only.
 */
export function spineOffsetFrom(sourceSize: Size, bbox: TrimRect): { x: number; y: number } {
  return { x: bbox.x, y: sourceSize.h - (bbox.y + bbox.h) };
}
