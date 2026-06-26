// Integer-exact ear-clipping triangulation for the binary (bitmap-mask) polygon packer. Consumes a
// simple, positive (CCW) polygon and emits a fan of triangles as index triplets into the input loop.
// Every decision is integer-exact via the shared `geom.ts` predicates (NO float, NO epsilon in any
// load-bearing path) so the output is byte-identical across runs. The ear test routes orientation and
// containment through the single orientation-truth helpers; ambiguous ears resolve to the lowest input
// index; triangles come out in generation order. Pure, zero-dependency, worker-safe.
// See docs/polygon-packer-design.md § "Determinism contract" → "Triangulate (integer-exact)".

import { orient, pointInTri, signedArea2, type IntPoint } from './geom';

/** Deterministic ear-clipping of a simple positive (CCW) polygon. An ear at working vertex `cur` is
 *  valid iff (a) it is convex — `orient(prev, cur, next) > 0` — and (b) no OTHER polygon vertex lies
 *  inside the candidate triangle (`pointInTri`, edges inclusive). All predicates are integer-exact.
 *
 *  Each pass scans the remaining vertices in fixed (working-list) order and clips the LOWEST-index
 *  valid ear, so ties resolve identically every run. Triangles are returned in generation order as
 *  index triplets `[i, j, k]` into the ORIGINAL `loop` array. If a pass finds no ear (a numerically
 *  awkward but possible stall), the vertex whose local triangle has the smallest `|signedArea2|`
 *  (tie → lowest working index) is dropped and clipping continues, guaranteeing termination.
 *
 *  For a simple CCW polygon of `n >= 3` vertices the result has exactly `n - 2` triangles. Loops of
 *  `< 3` vertices yield `[]`. */
export function triangulate(loop: IntPoint[]): number[][] {
  const n = loop.length;
  if (n < 3) return [];

  // Working ring of ORIGINAL indices; clipping an ear splices its apex out of this list.
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx[i] = i;

  const triangles: number[][] = [];

  while (idx.length > 3) {
    const m = idx.length;
    let clipped = false;

    for (let i = 0; i < m; i++) {
      const ai = idx[(i + m - 1) % m]!;
      const bi = idx[i]!;
      const ci = idx[(i + 1) % m]!;
      const a = loop[ai]!;
      const b = loop[bi]!;
      const c = loop[ci]!;

      // (a) convex apex under CCW winding.
      if (orient(a, b, c) <= 0) continue;

      // (b) no other working vertex inside the candidate ear.
      let contains = false;
      for (let j = 0; j < m; j++) {
        if (j === (i + m - 1) % m || j === i || j === (i + 1) % m) continue;
        if (pointInTri(loop[idx[j]!]!, a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      // Lowest-index valid ear: emit and splice the apex out, then restart the pass.
      triangles.push([ai, bi, ci]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }

    if (!clipped) {
      // Stall: drop the vertex with the smallest |local-triangle area|, tie → lowest working index.
      let dropAt = 0;
      let dropArea = Infinity;
      for (let i = 0; i < m; i++) {
        const a = loop[idx[(i + m - 1) % m]!]!;
        const b = loop[idx[i]!]!;
        const c = loop[idx[(i + 1) % m]!]!;
        const area = Math.abs(signedArea2([a, b, c]));
        if (area < dropArea) {
          dropArea = area;
          dropAt = i;
        }
      }
      idx.splice(dropAt, 1);
    }
  }

  // Final triangle (or the only one for n === 3).
  triangles.push([idx[0]!, idx[1]!, idx[2]!]);
  return triangles;
}
