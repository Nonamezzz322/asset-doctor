// Mask types + word-packing + RGBA extraction for the binary (bitmap-mask) polygon packer. There is a
// SINGLE grid (`ACC_CELL`): every MaskItem is extracted directly at that grid, so there is no dual-grid
// resampling here (no `resampleMask`). The byte-per-cell representation is what the mesh/nest pipeline
// consumes; `packMaskWords` collapses it into 32-bit words for the nester's word-wise AND overlap test.
// `maskItemFromRGBA` / `alphaMaskFromRGBA` are the PURE cores of the worker's per-sprite extraction:
// they take a plain RGBA buffer (+ its row width) and a region rect and derive the nesting MaskItem /
// mesh AlphaMask. The worker keeps the browser-only `getImageData` and just hands the pixels here, so
// these are the SINGLE source of truth (and Vitest-covered) for the threshold/dilation/downscale logic.
// Pure, zero-dependency, worker-safe (NO canvas/getImageData/browser APIs).
// See docs/polygon-packer-design.md § "mask.ts — mask types + word-packing".

import { ACC_CELL, DILATE_CELLS, MESH_MAX_CELLS, POLY_ALPHA_THRESHOLD } from './polygon-config';

/** A sprite's nesting footprint at the single `ACC_CELL` grid. `w/h` stay FULL-RES (px) for the
 *  emitted Placement; `bits` is the occupancy grid at `ACC_CELL`: `cols * rows` bytes, one byte per
 *  cell, `1` = opaque (dilated to carry bleed), `0` = free. `cols = ceil(w/ACC_CELL)`, likewise rows. */
export interface MaskItem {
  id: string;
  w: number;
  h: number;
  cols: number;
  rows: number;
  bits: Uint8Array;
}

/** A capped-resolution alpha silhouette used by the mesh pipeline (trace→simplify→triangulate).
 *  `bits` has length `w * h`, one byte per pixel, `1` = opaque, `0` = transparent. */
export interface AlphaMask {
  w: number;
  h: number;
  bits: Uint8Array;
}

/** Pack a MaskItem's byte-per-cell `bits` into 32-bit words for the nester's AND-loop. Layout is
 *  row-major and MSB-first: cell `(r, c)` lands in word `r * stride + (c >>> 5)` at bit `31 - (c & 31)`.
 *  Each row starts on a fresh word boundary (`stride = ceil(cols / 32)` words per row) so the nester
 *  can shift a row horizontally without bleeding into the next row, and an overlap is the first word
 *  whose AND with the accumulator is nonzero. Deterministic, integer-only; allocates a zero-filled
 *  `Uint32Array`. */
export function packMaskWords(m: MaskItem): { stride: number; words: Uint32Array } {
  const stride = (m.cols + 31) >>> 5;
  const words = new Uint32Array(stride * m.rows);
  for (let r = 0; r < m.rows; r++) {
    const rowByteBase = r * m.cols;
    const rowWordBase = r * stride;
    for (let c = 0; c < m.cols; c++) {
      if (m.bits[rowByteBase + c]) {
        const bit = 31 - (c & 31);
        const wi = rowWordBase + (c >>> 5);
        words[wi] = (words[wi] ?? 0) | (1 << bit);
      }
    }
  }
  return { stride, words };
}

/** A plain RGBA pixel buffer (4 bytes/px, row-major, no alpha pre-multiply assumed) plus the row width
 *  in pixels. The worker fills `data` from `getImageData(...).data` and `width` from the source canvas
 *  width; nothing here touches a canvas. */
export interface RGBASource {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
}

/** A rectangular region (px) of an `RGBASource` to extract from. The worker draws each sprite frame to a
 *  throwaway canvas at origin, so it passes `{ x: 0, y: 0, w: frame.w, h: frame.h }`. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Read the alpha of pixel `(px, py)` of `src` (out-of-bounds ⇒ 0 / transparent). */
function alphaAt(src: RGBASource, px: number, py: number): number {
  if (px < 0 || py < 0 || px >= src.width) return 0;
  return src.data[(py * src.width + px) * 4 + 3] ?? 0;
}

/**
 * PURE core of the worker's `buildMaskItem`: the nesting footprint for one sprite at the SINGLE `ACC_CELL`
 * grid. A cell is opaque iff ANY contained source px in `region` has `alpha >= POLY_ALPHA_THRESHOLD`
 * (opaque bias), then the opaque cells are dilated by `DILATE_CELLS(padding)` cells (Chebyshev) so the
 * bleed budget lives in the mask and `nestMasks` runs with `padding:0`. The dilation is deliberately
 * CONSERVATIVE: `DILATE_CELLS(padding) * ACC_CELL` px of real separation (≥ `padding`, usually more) — it
 * only ever over-separates. `w/h` stay full-res (region size) for the emitted Placement; `bits` is the
 * dilated occupancy grid. Deterministic, integer-only, no browser APIs.
 */
export function maskItemFromRGBA(id: string, src: RGBASource, region: Region, padding: number): MaskItem {
  const w = region.w;
  const h = region.h;
  const cols = Math.ceil(w / ACC_CELL);
  const rows = Math.ceil(h / ACC_CELL);
  const raw = new Uint8Array(cols * rows);
  // Cell opaque iff ANY contained source px clears the alpha threshold.
  for (let y = 0; y < h; y++) {
    const cy = (y / ACC_CELL) | 0;
    for (let x = 0; x < w; x++) {
      if (alphaAt(src, region.x + x, region.y + y) >= POLY_ALPHA_THRESHOLD) {
        raw[cy * cols + ((x / ACC_CELL) | 0)] = 1;
      }
    }
  }
  const d = DILATE_CELLS(padding);
  if (d <= 0) return { id, w, h, cols, rows, bits: raw };
  // Chebyshev dilation by `d` cells: a free cell becomes opaque if any opaque cell lies within the
  // d-radius square. Deterministic, integer-only; bounds the bleed margin into the mask.
  const bits = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!raw[r * cols + c]) continue;
      const r0 = Math.max(0, r - d);
      const r1 = Math.min(rows - 1, r + d);
      const c0 = Math.max(0, c - d);
      const c1 = Math.min(cols - 1, c + d);
      for (let rr = r0; rr <= r1; rr++) {
        const base = rr * cols;
        for (let cc = c0; cc <= c1; cc++) bits[base + cc] = 1;
      }
    }
  }
  return { id, w, h, cols, rows, bits };
}

/**
 * PURE core of the worker's `buildAlphaMask`: the capped-resolution alpha silhouette for the mesh
 * pipeline. The long edge is capped at `MESH_MAX_CELLS` via an INTEGER downscale factor
 * (`ceil(longEdge / MESH_MAX_CELLS)`) to bound trace cost/memory for huge sprites; a downscaled cell is
 * opaque iff ANY contained source px in `region` clears the threshold (conservative/outward). The pure
 * mesh works in this capped space, so the caller scales the returned vertices back to frame px (see
 * `scaleMeshToFrame`). Deterministic, integer-only, no browser APIs.
 */
export function alphaMaskFromRGBA(src: RGBASource, region: Region): { mask: AlphaMask; scale: number } {
  const longEdge = Math.max(region.w, region.h);
  const scale = Math.max(1, Math.ceil(longEdge / MESH_MAX_CELLS));
  const w = Math.ceil(region.w / scale);
  const h = Math.ceil(region.h / scale);
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < region.h; y++) {
    const dy = (y / scale) | 0;
    for (let x = 0; x < region.w; x++) {
      if (alphaAt(src, region.x + x, region.y + y) >= POLY_ALPHA_THRESHOLD) {
        bits[dy * w + ((x / scale) | 0)] = 1;
      }
    }
  }
  return { mask: { w, h, bits }, scale };
}
