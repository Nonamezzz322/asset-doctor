// Binary (bitmap-mask) polygon nester. Bottom-left-fill occupancy nesting at the SINGLE `ACC_CELL`
// grid: a per-column skyline accelerator seeds candidate origins over a bit-packed `Uint32Array`
// accumulator, and the overlap test is a word-wise AND of the (pre-shifted) mask rows against the
// accumulator rows — the first nonzero word is a collision. Same POT / spill-to-maxSize logic as
// pack(), reusing its `binCandidates` (and `potsUpTo` through it), but the starting-bin lower bound
// is the Σ mask-cell area (smaller than the bbox area) so the nester may begin at a smaller POT than
// the rectangle packer — that is the source of the packing win. Pure, zero-dependency, worker-safe;
// deterministic across input permutations (explicit total-order sort + integer tie-breaks).
// See docs/polygon-packer-design.md § "polygon-pack.ts — the bitmap-mask nester".

import { binCandidates, type PackBin, type PackOptions, type Placement } from './pack';
import { packMaskWords, type MaskItem } from './mask';
import { ACC_CELL } from './polygon-config';

/** A MaskItem prepared for the AND-loop: MSB-first 32-bit row words (see packMaskWords) plus the raw
 *  byte-per-cell `bits` (for skyline updates) and a precomputed opaque-cell count (the lower bound). */
interface PackedMask {
  id: string;
  w: number; // full-res px (for the emitted Placement)
  h: number;
  cols: number; // cell-grid extent
  rows: number;
  stride: number; // words per row
  words: Uint32Array;
  bits: Uint8Array; // length cols*rows, 1 = opaque
  cellCount: number; // opaque cells
}

function toPacked(m: MaskItem): PackedMask {
  const { stride, words } = packMaskWords(m);
  let cellCount = 0;
  for (let i = 0; i < m.bits.length; i++) if (m.bits[i]) cellCount++;
  return { id: m.id, w: m.w, h: m.h, cols: m.cols, rows: m.rows, stride, words, bits: m.bits, cellCount };
}

/** Total order (determinism): maskCellCount desc → bbox(w*h) desc → max(w,h) desc → id.localeCompare.
 *  ids are unique, so this is a strict total order and the result is permutation-invariant. */
function sortPacked(items: PackedMask[]): PackedMask[] {
  return [...items].sort(
    (a, b) =>
      b.cellCount - a.cellCount ||
      b.w * b.h - a.w * a.h ||
      Math.max(b.w, b.h) - Math.max(a.w, a.h) ||
      a.id.localeCompare(b.id),
  );
}

/** A W×H (cells) bit-packed accumulator with a per-column skyline of the topmost free cell. */
interface Accumulator {
  cols: number;
  rows: number;
  stride: number;
  words: Uint32Array;
  /** skyline[c] = first cell-row in column `c` that is still free (lowest occupied boundary + 1). */
  skyline: Int32Array;
}

function makeAccumulator(cols: number, rows: number): Accumulator {
  const stride = (cols + 31) >>> 5;
  return {
    cols,
    rows,
    stride,
    words: new Uint32Array(stride * rows),
    skyline: new Int32Array(cols), // all 0 = whole column free
  };
}

/** Test whether `mask` placed with its top-left at cell (ox, oy) collides with the accumulator. The
 *  mask is shifted right by `ox` bits per row; the AND of each shifted mask word with the matching
 *  accumulator word is checked, first nonzero word = collision (true). Callers guarantee the mask fits
 *  the bin bounds (ox+cols ≤ acc.cols, oy+rows ≤ acc.rows).
 *
 *  IN-BOUNDS INVARIANT: the highest bit any mask word can set lands at accumulator column < acc.cols
 *  (because ox+mask.cols ≤ acc.cols), so the high word `wordShift + w` is always ≤ acc.stride-1. The
 *  spill word `wordShift + w + 1` CAN equal acc.stride (one past the row) — but only when the spilled
 *  bits would fall at column ≥ acc.cols, i.e. `lo` is necessarily 0 there. We still gate the spill
 *  access on `spillIdx < accRowBase + acc.stride` so the array read is provably in-bounds regardless of
 *  any future change to the guards. */
function collides(acc: Accumulator, mask: PackedMask, ox: number, oy: number): boolean {
  const wordShift = ox >>> 5; // whole-word offset into the accumulator row
  const bitShift = ox & 31; // sub-word right shift applied to each mask word
  for (let r = 0; r < mask.rows; r++) {
    const accRowBase = (oy + r) * acc.stride;
    const accRowEnd = accRowBase + acc.stride; // exclusive: one past this row's last word
    const maskRowBase = r * mask.stride;
    for (let w = 0; w < mask.stride; w++) {
      const m = mask.words[maskRowBase + w]! >>> 0;
      if (m === 0) continue;
      const hi = bitShift === 0 ? m : m >>> bitShift; // lands in accumulator word (wordShift + w)
      if (hi !== 0 && (acc.words[accRowBase + wordShift + w]! & hi) !== 0) return true;
      if (bitShift !== 0) {
        const lo = (m << (32 - bitShift)) >>> 0; // remainder spills into the next accumulator word
        const spillIdx = accRowBase + wordShift + w + 1;
        if (lo !== 0 && spillIdx < accRowEnd && (acc.words[spillIdx]! & lo) !== 0) return true;
      }
    }
  }
  return false;
}

/** Stamp `mask` into the accumulator at cell (ox, oy) (OR the shifted bits) and raise the skyline for
 *  every column the mask occupies. Mirrors the shift arithmetic — and the same provably-in-bounds spill
 *  invariant (see `collides`) — so the spill write is gated on `spillIdx < accRowEnd`. */
function stamp(acc: Accumulator, mask: PackedMask, ox: number, oy: number): void {
  const wordShift = ox >>> 5;
  const bitShift = ox & 31;
  for (let r = 0; r < mask.rows; r++) {
    const accRowBase = (oy + r) * acc.stride;
    const accRowEnd = accRowBase + acc.stride; // exclusive: one past this row's last word
    const maskRowBase = r * mask.stride;
    for (let w = 0; w < mask.stride; w++) {
      const m = mask.words[maskRowBase + w]! >>> 0;
      if (m === 0) continue;
      const hi = bitShift === 0 ? m : m >>> bitShift;
      if (hi !== 0) acc.words[accRowBase + wordShift + w]! |= hi;
      if (bitShift !== 0) {
        const lo = (m << (32 - bitShift)) >>> 0;
        const spillIdx = accRowBase + wordShift + w + 1;
        if (lo !== 0 && spillIdx < accRowEnd) acc.words[spillIdx]! |= lo;
      }
    }
  }
  // Raise the skyline: each occupied cell pushes its column's free boundary to one row below it.
  for (let r = 0; r < mask.rows; r++) {
    const maskRowBase = r * mask.cols;
    for (let c = 0; c < mask.cols; c++) {
      if (mask.bits[maskRowBase + c]) {
        const col = ox + c;
        const below = oy + r + 1;
        if (below > acc.skyline[col]!) acc.skyline[col] = below;
      }
    }
  }
}

/** Bottom-left-fill placement of one mask into an in-progress accumulator. Candidate origins: X asc
 *  then Y asc from the per-column skyline seed; the first feasible origin in that scan wins (BL
 *  tie-break = min Y then, within a row, min X). Stamps on success and returns the cell origin; null
 *  if it does not fit anywhere. */
function placeOne(acc: Accumulator, mask: PackedMask): { x: number; y: number } | null {
  if (mask.cols > acc.cols || mask.rows > acc.rows) return null;
  for (let ox = 0; ox + mask.cols <= acc.cols; ox++) {
    // Skyline seed: lowest free row across the columns this item would span at `ox`.
    let seedY = 0;
    for (let c = 0; c < mask.cols; c++) {
      const s = acc.skyline[ox + c]!;
      if (s > seedY) seedY = s;
    }
    for (let oy = seedY; oy + mask.rows <= acc.rows; oy++) {
      if (!collides(acc, mask, ox, oy)) {
        stamp(acc, mask, ox, oy);
        return { x: ox, y: oy };
      }
    }
  }
  // The skyline seed only floors the scan; a tall item can leave a usable pocket below the seed in a
  // neighbouring column, so retry from the bin floor before declaring failure.
  for (let ox = 0; ox + mask.cols <= acc.cols; ox++) {
    for (let oy = 0; oy + mask.rows <= acc.rows; oy++) {
      if (!collides(acc, mask, ox, oy)) {
        stamp(acc, mask, ox, oy);
        return { x: ox, y: oy };
      }
    }
  }
  return null;
}

/** Place all `packed` masks (already in sort order) into a `cols`×`rows` cell bin. Returns the cell
 *  origins (parallel to `packed`) or null if any item cannot be placed. */
function placeAll(packed: PackedMask[], cols: number, rows: number): { x: number; y: number }[] | null {
  const acc = makeAccumulator(cols, rows);
  const out: { x: number; y: number }[] = [];
  for (const mask of packed) {
    const at = placeOne(acc, mask);
    if (!at) return null;
    out.push(at);
  }
  return out;
}

/** Convert a parallel list of cell origins into full-res Placements snapped to ACC_CELL. `w/h` stay
 *  full-res (from the MaskItem); x/y are integer multiples of ACC_CELL. v1: rotated always false. */
function toPlacements(origins: { x: number; y: number }[], ordered: PackedMask[]): Placement[] {
  const out: Placement[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const o = origins[i]!;
    const it = ordered[i]!;
    out.push({ id: it.id, x: o.x * ACC_CELL, y: o.y * ACC_CELL, w: it.w, h: it.h, rotated: false });
  }
  return out;
}

/** Smallest-area POT bin (px) that fits ALL masks via bottom-left-fill, else null. The lower bound is
 *  the Σ mask-cell area (cells × ACC_CELL²), smaller than the bbox area, so a concave set may start at
 *  a smaller POT than rectangle packing. Bins explored in `binCandidates` order (area asc, then
 *  narrower width). */
function fitOneBin(ordered: PackedMask[], opts: PackOptions): PackBin | null {
  let totalCells = 0;
  for (const p of ordered) totalCells += p.cellCount;
  const totalArea = totalCells * ACC_CELL * ACC_CELL;
  const maxDim = Math.max(...ordered.map((it) => Math.max(it.w, it.h)));
  const minDim = Math.max(...ordered.map((it) => Math.min(it.w, it.h)));
  const candidates = binCandidates(totalArea, maxDim, minDim, opts.maxSize);
  for (const c of candidates) {
    const cols = Math.ceil(c.w / ACC_CELL);
    const rows = Math.ceil(c.h / ACC_CELL);
    const origins = placeAll(ordered, cols, rows);
    if (origins) return { w: c.w, h: c.h, placements: toPlacements(origins, ordered) };
  }
  return null;
}

/**
 * Bitmap-mask occupancy nesting at the SINGLE `ACC_CELL` grid. Bottom-left-fill with a per-column
 * skyline accelerator over a bit-packed `Uint32Array` accumulator; the overlap test is a word-wise
 * AND of the pre-shifted mask rows against the accumulator rows (first nonzero word = collision) via
 * `packMaskWords`. Same POT and spill-to-maxSize logic as `pack()`, reusing `binCandidates` /
 * `potsUpTo`, but with a Σ mask-cell-area lower bound for the starting bin (so it may be smaller than
 * rectangle packing — the win's source). v1: `rotated` is always false. All placements snap to
 * `ACC_CELL` ⇒ frame `x/y` are integer multiples of `ACC_CELL`. Deterministic across input
 * permutations (explicit total-order sort + integer tie-breaks). Empty input ⇒ `[]`; a single
 * oversize item mirrors `pack()`'s clamp-alone branch.
 */
export function nestMasks(items: MaskItem[], opts: PackOptions): PackBin[] {
  if (items.length === 0) return [];

  const ordered = sortPacked(items.map(toPacked));

  const one = fitOneBin(ordered, opts);
  if (one) return [one];

  // Spill: greedily fill maxSize×maxSize bins; an item that cannot fit even alone is clamped solo
  // (mirrors pack.ts's clamp-alone branch — single oversize sprite).
  const bins: PackBin[] = [];
  const size = opts.maxSize;
  const cellSize = Math.ceil(size / ACC_CELL);
  let remaining = ordered;
  while (remaining.length > 0) {
    const acc = makeAccumulator(cellSize, cellSize);
    const placements: Placement[] = [];
    const unplaced: PackedMask[] = [];
    for (const mask of remaining) {
      const at = placeOne(acc, mask);
      if (at) {
        placements.push({ id: mask.id, x: at.x * ACC_CELL, y: at.y * ACC_CELL, w: mask.w, h: mask.h, rotated: false });
      } else {
        unplaced.push(mask);
      }
    }
    if (placements.length === 0) {
      // a single item exceeds maxSize even at the cell grid — emit it clamped, alone (best effort).
      const it = remaining[0]!;
      bins.push({
        w: size,
        h: size,
        placements: [{ id: it.id, x: 0, y: 0, w: Math.min(it.w, size), h: Math.min(it.h, size), rotated: false }],
      });
      remaining = remaining.slice(1);
      continue;
    }
    bins.push({ w: size, h: size, placements });
    remaining = unplaced;
  }
  return bins;
}
