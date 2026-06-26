// Shared integer geometry for the binary (bitmap-mask) polygon packer — the SINGLE source of
// orientation truth. Every contour/simplify/triangulate decision routes its winding, orientation
// and point-in-triangle test through here so the CCW sign cannot drift between files. All inputs
// are integer pixels and every result is computed with exact integer arithmetic: NO floats, NO
// epsilon in any load-bearing predicate. Pure, zero-dependency, worker-safe.
// See docs/polygon-packer-design.md § "Determinism contract".

export interface IntPoint {
  x: number;
  y: number;
}

/** Y-down shoelace `2A = Σ (x_i·y_{i+1} − x_{i+1}·y_i)`. Returns EXACTLY twice the signed area as an
 *  integer (inputs are integers). >0 = CCW under the Y-down convention; <0 = CW; 0 = degenerate. */
export function signedArea2(loop: IntPoint[]): number {
  let sum = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/** Exact integer orientation of (a→b→c): the cross product of (a→b)×(a→c). >0 = c left of a→b
 *  (CCW under Y-down), 0 = collinear, <0 = c right of a→b. Returns the raw integer cross. */
export function orient(a: IntPoint, b: IntPoint, c: IntPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Exact integer point-in-triangle, inclusive of edges and vertices, via integer cross products only.
 *  True iff `p` lies on the same side of (or on) every edge of triangle (a,b,c), independent of the
 *  triangle's winding (handles both CCW and CW). No float, no epsilon. */
export function pointInTri(p: IntPoint, a: IntPoint, b: IntPoint, c: IntPoint): boolean {
  const d1 = orient(a, b, p);
  const d2 = orient(b, c, p);
  const d3 = orient(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  // Inside-or-on iff p is not strictly on both sides of any edge pair (zeros count as on-edge).
  return !(hasNeg && hasPos);
}
