// PURE GPU-residency CEILING helper (round12 backend-processing §7). NO pixels, NO canvas, NO IO,
// NO Date.now / Math.random — integer-only, deterministic arithmetic so the worker, the receipt, and
// any future caller resolve EXACTLY the same VRAM number for given inputs. Golden-testable.
//
// HONESTY (load-bearing — Invariants 3 & 5):
//   - A raster (PNG/WebP/AVIF) page is RGBA8888 ⇒ w·h·4 — unchanged from today's model.
//   - A KTX2/block-compressed page is a WORST-CASE CEILING (~1 byte/px for UASTC/BC7/ASTC-4x4),
//     NEVER w·h·4 and NEVER faked. Real residency is ≤ this on GPUs that transcode to BC1/ETC1.
//   - Mip overhead reuses the ONE shared constant (MIP_OVERHEAD = 4/3), charged ONLY when mips are
//     baked — the SAME conditional rule the raster path uses (vramBytesMipmapped). Never assumed.
// The compressed-vs-raster split + the per-format ceiling live in @asset-doctor/core — this helper
// imports them so the worker and the receipt can't drift from the single source of truth.

import {
  COMPRESSED_BYTES_PER_PX_CEILING,
  MIP_OVERHEAD,
  type TextureFootprintFormat,
} from '@asset-doctor/core';

/**
 * Worst-case resident GPU VRAM (BYTES) for one texture page — an upper bound, never asserted residency.
 *
 * @param fmt  'raster' ⇒ RGBA8888 w·h·4 (today's model, unchanged); a CompressedTextureFormat
 *             ('ktx2-uastc') ⇒ the block-compression CEILING (≤ ~1 byte/px), NEVER w·h·4.
 * @param w    pixel width  (treated as a non-negative integer; floored, clamped at 0).
 * @param h    pixel height (treated as a non-negative integer; floored, clamped at 0).
 * @param mips when true, baked mipmaps add the shared +33% chain (×MIP_OVERHEAD, ceil'd to whole bytes);
 *             when false/omitted, the base footprint only — the SAME conditional rule as the raster path.
 * @returns    integer bytes. For compressed formats this is a CEILING ("GPU VRAM ≤ …"); the real
 *             residency is lower on GPUs that transcode to BC1/ETC1, and the raster fallback (w·h·4)
 *             applies on GPUs without block-compression support.
 */
export function vramCeilingOfPage(
  fmt: TextureFootprintFormat,
  w: number,
  h: number,
  mips = false,
): number {
  // Defensive integerization: callers pass measured pixel dims, but never trust a float/negative here.
  const pw = Math.max(0, Math.floor(w));
  const ph = Math.max(0, Math.floor(h));
  const px = pw * ph;

  // raster ⇒ 4 B/px (RGBA8888); compressed ⇒ the per-format worst-case bytes/px CEILING.
  const bytesPerPx = fmt === 'raster' ? 4 : COMPRESSED_BYTES_PER_PX_CEILING[fmt];
  const base = px * bytesPerPx;

  // Mip chain reuses the ONE shared constant, charged ONLY when mips are baked. ceil ⇒ whole bytes.
  return mips ? Math.ceil(base * MIP_OVERHEAD) : base;
}
