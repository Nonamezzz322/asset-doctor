// Pure rectangle bin-packing (MaxRects, BSSF heuristic) for atlas repacking. Produces power-of-two
// sheet(s); finds the smallest-area POT bin that fits all rects, else spills into multiple maxSize
// bins. Deterministic (stable item sort). Worker-safe, zero-dependency — this IS the paid product,
// so it must be golden-testable against the Atlas model the diagnosis predicts.

import type { Rect } from '@asset-doctor/core';

export interface PackItem {
  id: string;
  w: number;
  h: number;
}
export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotated: boolean;
}
export interface PackBin {
  w: number;
  h: number;
  placements: Placement[];
}
export interface PackOptions {
  /** Largest allowed sheet edge (e.g. a conservative GPU max-texture-size). */
  maxSize: number;
  allowRotation: boolean;
  /** Gap added around each sprite's footprint (prevents bleeding). */
  padding: number;
}

const itemArea = (it: PackItem): number => it.w * it.h;

/** Stable sort: biggest area first, then longer side, then id (determinism). */
function sortItems(items: PackItem[]): PackItem[] {
  return [...items].sort(
    (a, b) => itemArea(b) - itemArea(a) || Math.max(b.w, b.h) - Math.max(a.w, a.h) || a.id.localeCompare(b.id),
  );
}

// MaxRects free-rectangle split: remove `used` from every overlapping free rect, add the up-to-4
// remainders, then drop any free rect fully contained in another.
function splitFree(free: Rect[], used: Rect): void {
  const out: Rect[] = [];
  for (const fr of free) {
    const noOverlap = used.x >= fr.x + fr.w || used.x + used.w <= fr.x || used.y >= fr.y + fr.h || used.y + used.h <= fr.y;
    if (noOverlap) {
      out.push(fr);
      continue;
    }
    if (used.x > fr.x) out.push({ x: fr.x, y: fr.y, w: used.x - fr.x, h: fr.h });
    if (used.x + used.w < fr.x + fr.w) out.push({ x: used.x + used.w, y: fr.y, w: fr.x + fr.w - (used.x + used.w), h: fr.h });
    if (used.y > fr.y) out.push({ x: fr.x, y: fr.y, w: fr.w, h: used.y - fr.y });
    if (used.y + used.h < fr.y + fr.h) out.push({ x: fr.x, y: used.y + used.h, w: fr.w, h: fr.y + fr.h - (used.y + used.h) });
  }
  const contains = (a: Rect, b: Rect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  free.length = 0;
  for (let i = 0; i < out.length; i++) {
    if (!out.some((b, j) => j !== i && contains(out[i]!, b))) free.push(out[i]!);
  }
}

/** Place sorted items into a W×H bin via best-short-side-fit. Returns placements + whatever didn't fit. */
function placeInBin(items: PackItem[], W: number, H: number, opts: PackOptions): { placements: Placement[]; unplaced: PackItem[] } {
  const free: Rect[] = [{ x: 0, y: 0, w: W, h: H }];
  const placements: Placement[] = [];
  const unplaced: PackItem[] = [];
  const pad = opts.padding;
  for (const it of items) {
    const iw = it.w + pad;
    const ih = it.h + pad;
    let best: Rect | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    let bestRot = false;
    for (const fr of free) {
      if (iw <= fr.w && ih <= fr.h) {
        const ss = Math.min(fr.w - iw, fr.h - ih);
        const ls = Math.max(fr.w - iw, fr.h - ih);
        if (ss < bestShort || (ss === bestShort && ls < bestLong)) {
          best = fr;
          bestShort = ss;
          bestLong = ls;
          bestRot = false;
        }
      }
      if (opts.allowRotation && ih <= fr.w && iw <= fr.h) {
        const ss = Math.min(fr.w - ih, fr.h - iw);
        const ls = Math.max(fr.w - ih, fr.h - iw);
        if (ss < bestShort || (ss === bestShort && ls < bestLong)) {
          best = fr;
          bestShort = ss;
          bestLong = ls;
          bestRot = true;
        }
      }
    }
    if (!best) {
      unplaced.push(it);
      continue;
    }
    const usedW = bestRot ? ih : iw;
    const usedH = bestRot ? iw : ih;
    placements.push({ id: it.id, x: best.x, y: best.y, w: it.w, h: it.h, rotated: bestRot });
    splitFree(free, { x: best.x, y: best.y, w: usedW, h: usedH });
  }
  return { placements, unplaced };
}

/** Powers of two from 1 up to and including `max` (the largest POT ≤ max). */
export function potsUpTo(max: number): number[] {
  const out: number[] = [];
  for (let s = 1; s <= max; s *= 2) out.push(s);
  return out;
}

/** Ordered candidate POT bin sizes that can hold `totalArea` while respecting the long-/short-edge
 *  lower bounds (`maxDim`/`minDim`). Sorted smallest-area first, then narrower width (determinism).
 *  Shared by the rectangle packer and the polygon nester so both explore bins identically. */
export function binCandidates(totalArea: number, maxDim: number, minDim: number, maxSize: number): { w: number; h: number }[] {
  const pots = potsUpTo(maxSize);
  const candidates: { w: number; h: number }[] = [];
  for (const w of pots) {
    for (const h of pots) {
      if (w * h < totalArea) continue;
      if (Math.max(w, h) < maxDim || Math.min(w, h) < minDim) continue;
      candidates.push({ w, h });
    }
  }
  candidates.sort((a, b) => a.w * a.h - b.w * b.h || a.w - b.w);
  return candidates;
}

/** Smallest-area POT bin that fits ALL items, else null. */
function fitOneBin(sorted: PackItem[], opts: PackOptions): PackBin | null {
  const pad = opts.padding;
  const totalArea = sorted.reduce((s, it) => s + (it.w + pad) * (it.h + pad), 0);
  const maxDim = Math.max(...sorted.map((it) => Math.max(it.w + pad, it.h + pad)));
  const minDim = Math.max(...sorted.map((it) => Math.min(it.w + pad, it.h + pad)));
  const candidates = binCandidates(totalArea, maxDim, minDim, opts.maxSize);
  for (const c of candidates) {
    const { placements, unplaced } = placeInBin(sorted, c.w, c.h, opts);
    if (unplaced.length === 0) return { w: c.w, h: c.h, placements };
  }
  return null;
}

/** Pack items into POT sheet(s). One bin when everything fits ≤ maxSize, else greedy spill. */
export function pack(items: PackItem[], opts: PackOptions): PackBin[] {
  if (items.length === 0) return [];
  const sorted = sortItems(items);
  const one = fitOneBin(sorted, opts);
  if (one) return [one];

  const bins: PackBin[] = [];
  let remaining = sorted;
  const size = opts.maxSize;
  while (remaining.length > 0) {
    const { placements, unplaced } = placeInBin(remaining, size, size, opts);
    if (placements.length === 0) {
      // a single item exceeds maxSize even rotated — emit it clamped, alone (best effort)
      const it = remaining[0]!;
      bins.push({ w: size, h: size, placements: [{ id: it.id, x: 0, y: 0, w: Math.min(it.w, size), h: Math.min(it.h, size), rotated: false }] });
      remaining = remaining.slice(1);
      continue;
    }
    bins.push({ w: size, h: size, placements });
    remaining = unplaced;
  }
  return bins;
}
