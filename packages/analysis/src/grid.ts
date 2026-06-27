// Grid coverage map for the wasted-space overlay. Deliberately simple and robust (no exact
// polygon-complement geometry): rasterize every sprite frame into cells, then merge the
// untouched cells into disjoint rectangles. A cell touched by ANY frame counts as covered,
// so the emptiness overlay under-claims rather than over-claims — it never marks used pixels.

import type { Atlas, Rect, Size } from '@asset-doctor/core';

export interface Coverage {
  cols: number;
  rows: number;
  cell: number;
  covered: boolean[];
}

/** Cell size that keeps the grid ~64 cells on the long edge (min 8px). */
export function defaultCell(size: Size): number {
  return Math.max(8, Math.round(Math.max(size.w, size.h) / 64));
}

export function buildCoverage(atlas: Atlas, cell: number): Coverage {
  const cols = Math.ceil(atlas.size.w / cell);
  const rows = Math.ceil(atlas.size.h / cell);
  const covered = new Array<boolean>(cols * rows).fill(false);
  for (const sp of atlas.sprites) {
    const f = sp.frame;
    const c0 = Math.max(0, Math.floor(f.x / cell));
    const r0 = Math.max(0, Math.floor(f.y / cell));
    const c1 = Math.min(cols, Math.ceil((f.x + f.w) / cell));
    const r1 = Math.min(rows, Math.ceil((f.y + f.h) / cell));
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) covered[r * cols + c] = true;
    }
  }
  return { cols, rows, cell, covered };
}

interface OpenRect {
  c0: number;
  c1: number;
  r0: number;
}

function toPixelRect(rect: OpenRect, rEnd: number, cell: number, size: Size): Rect {
  const x = rect.c0 * cell;
  const y = rect.r0 * cell;
  return {
    x,
    y,
    w: Math.min(rect.c1 * cell, size.w) - x,
    h: Math.min(rEnd * cell, size.h) - y,
  };
}

/** Merge uncovered cells into disjoint, atlas-clamped rectangles (row runs merged vertically
 *  when their column span is identical). Produces a small set of non-overlapping rects. */
export function mergeEmptyRects(cov: Coverage, size: Size): Rect[] {
  const { cols, rows, cell, covered } = cov;
  const out: Rect[] = [];
  let open = new Map<string, OpenRect>();

  for (let r = 0; r < rows; r++) {
    const next = new Map<string, OpenRect>();
    let c = 0;
    while (c < cols) {
      if (covered[r * cols + c]) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < cols && !covered[r * cols + c]) c++;
      const key = `${c0}:${c}`;
      next.set(key, open.get(key) ?? { c0, c1: c, r0: r });
    }
    for (const [key, rect] of open) {
      if (!next.has(key)) out.push(toPixelRect(rect, r, cell, size));
    }
    open = next;
  }
  for (const rect of open.values()) out.push(toPixelRect(rect, rows, cell, size));
  return out;
}

/** Dispersion summary of the merged empty rects — the SHAPE of the waste, not its recoverable amount.
 *  Pure and Size-free (caller already knows the atlas size). `fragmentation` = largestArea / totalArea
 *  ∈ (0,1]: 1 = one contiguous hole, →0 = many scattered gaps. `fragmentation` is `undefined` when
 *  there is no empty area (totalArea === 0), i.e. there is no dispersion to describe — the caller
 *  treats that as contiguous (frag = 1). */
export interface EmptySpace {
  /** Number of disjoint empty rects. */
  n: number;
  /** Σ w×h over the empty rects (px²). */
  totalArea: number;
  /** Largest single empty rect's area (px²); 0 when there are no rects. */
  largestArea: number;
  /** largestArea / totalArea ∈ (0,1]; undefined when totalArea === 0. */
  fragmentation?: number;
}

export function summarizeEmpty(rects: Rect[]): EmptySpace {
  let totalArea = 0;
  let largestArea = 0;
  for (const r of rects) {
    const a = r.w * r.h;
    totalArea += a;
    if (a > largestArea) largestArea = a;
  }
  return {
    n: rects.length,
    totalArea,
    largestArea,
    ...(totalArea > 0 ? { fragmentation: largestArea / totalArea } : {}),
  };
}
