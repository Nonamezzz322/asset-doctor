// Contour tracing for the binary (bitmap-mask) polygon packer. We label the opaque islands of an
// AlphaMask (4-connected, explicit-stack flood fill — no recursion), then walk each island's OUTER
// boundary on the pixel-CORNER lattice with the FROZEN, integer-only turn machine. Holes are dropped
// (only the outer loop of each island survives); collinear runs are collapsed via the shared integer
// `orient`. Every loop is a conservative, tight, IN-BOUNDS superset of its island's opaque cells, wound
// positive (CCW under the Y-down shoelace) so downstream simplify/triangulate consume a single, stable
// orientation. Pure, zero-dependency, worker-safe.
// See docs/polygon-packer-design.md § "trace.ts — contour tracing" and § "Determinism contract / Tracing".
//
// FROZEN turn machine (directions `0=E, 1=S, 2=W, 3=N`). At each lattice corner we inspect the two cells
// that flank the FORWARD edge — `L` = front-left, `R` = front-right of the current heading — and pick the
// next heading from the frozen `(heading, L-opaque, R-opaque)` table:
//   - L && !R → turn LEFT  (heading + 3 mod 4)
//   - !L && R → turn RIGHT (heading + 1 mod 4)
//   - L &&  R → go STRAIGHT (keep heading)
//   - !L && !R → turn RIGHT (heading + 1 mod 4)   ← the single frozen SADDLE rule
// We always step one unit in the chosen heading. Because islands are 4-connected, no two diagonally-only
// touching cells share an island, so the true two-cell saddle never arises WITHIN one island's outer
// contour: the `!L && !R` row is the outer-corner case, where "turn right" keeps the opaque region on the
// right and the walk hugs the cell edges tightly (so the loop stays within `[0,w] × [0,h]` and never
// inflates outward). The result is the standard, deterministic square-corner contour.

import type { IntPoint } from './geom';
import { orient } from './geom';
import type { AlphaMask } from './mask';

/** Heading unit steps on the corner lattice (Y-down): `0=E, 1=S, 2=W, 3=N`. */
const DIR: ReadonlyArray<readonly [number, number]> = [
  [1, 0], // E
  [0, 1], // S
  [-1, 0], // W
  [0, -1], // N
];

/** Front-LEFT cell of the heading, as an offset (in CELL coords) from corner `(cx, cy)`. */
const FRONT_LEFT: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // E → cell above the forward edge
  [0, 0], // S
  [-1, 0], // W
  [-1, -1], // N
];

/** Front-RIGHT cell of the heading, as an offset (in CELL coords) from corner `(cx, cy)`. */
const FRONT_RIGHT: ReadonlyArray<readonly [number, number]> = [
  [0, 0], // E → cell below the forward edge
  [-1, 0], // S
  [-1, -1], // W
  [0, -1], // N
];

/**
 * Label every 4-connected opaque island of `mask`, then walk each island's OUTER contour on the
 * pixel-corner lattice via the FROZEN turn machine. Holes are dropped (only the outer loop survives).
 * Islands are returned in start-cell order (min row, then min col); each walk starts at that island's
 * top-left-most opaque cell heading EAST. Collinear runs are collapsed (`orient == 0`). A fully
 * transparent mask returns `[]`. Each loop is wound positive (CCW under the Y-down shoelace) and stays
 * within `[0, w] × [0, h]`.
 */
export function traceContours(mask: AlphaMask): IntPoint[][] {
  const { w, h } = mask;
  if (w <= 0 || h <= 0) return [];

  // ── 4-connected island labeling via an EXPLICIT stack (no recursion) ───────────────────────────
  // `0` = unlabeled/transparent; islands are numbered `1..n` in row-major discovery order, so a label's
  // start cell is automatically its top-left-most opaque cell (min row, then min col).
  const label = new Int32Array(w * h);
  let nextLabel = 0;
  // Start cell per label, captured at discovery (row-major ⇒ already ordered by min row then min col).
  const starts: { sc: number; sr: number; lab: number }[] = [];
  const stack: number[] = []; // flat indices `y * w + x`, reused across islands

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const seed = r * w + c;
      if (!mask.bits[seed] || label[seed] !== 0) continue;
      nextLabel++;
      starts.push({ sc: c, sr: r, lab: nextLabel });
      label[seed] = nextLabel;
      stack.push(seed);
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const x = idx % w;
        const y = (idx - x) / w;
        // 4-connected neighbors: E, W, S, N.
        if (x + 1 < w) {
          const n = idx + 1;
          if (mask.bits[n] && label[n] === 0) {
            label[n] = nextLabel;
            stack.push(n);
          }
        }
        if (x - 1 >= 0) {
          const n = idx - 1;
          if (mask.bits[n] && label[n] === 0) {
            label[n] = nextLabel;
            stack.push(n);
          }
        }
        if (y + 1 < h) {
          const n = idx + w;
          if (mask.bits[n] && label[n] === 0) {
            label[n] = nextLabel;
            stack.push(n);
          }
        }
        if (y - 1 >= 0) {
          const n = idx - w;
          if (mask.bits[n] && label[n] === 0) {
            label[n] = nextLabel;
            stack.push(n);
          }
        }
      }
    }
  }

  if (starts.length === 0) return []; // fully transparent

  // ── Walk each island's outer contour ───────────────────────────────────────────────────────────
  const loops: IntPoint[][] = [];
  for (const { sc, sr, lab } of starts) {
    loops.push(walkOuterContour(label, w, h, sc, sr, lab));
  }
  return loops;
}

/**
 * Rasterize the union of `loops` (corner-lattice polygons) into a fresh `AlphaMask` of size `w × h`,
 * then trace its single OUTER contour (the merged hull; holes dropped). Used for multi-island sprites
 * where the mesh must wrap all islands in ONE conservative loop.
 *
 * v1 BEHAVIOR (be honest about it): this returns a hull ONLY for input that already rasterizes back to
 * exactly ONE connected loop — i.e. islands that physically overlap/touch in the alpha mask (they then
 * trace as a single island in the first place, so multi-loop input here is rare). The loops are
 * rasterized AS TRACED (no dilation/inflation), so two GENUINELY SEPARATE islands stay separate and the
 * re-trace yields >1 loop ⇒ we return `[]`. In practice that means a sprite with two or more disjoint
 * islands falls back to a plain rectangle frame (no merged mesh) — see mesh.ts. This is conservative
 * and correct: a single loop can never cover the opaque pixels of a disconnected union without spanning
 * the empty gap, and picking one component would silently DROP the others' pixels (a coverage
 * violation — the moat). `traceMesh` treats `[]` as "no mesh" and uses the rectangle, which is the
 * spec's mandated behavior for separate islands (the hull-area-ratio guard alone is NOT enough:
 * measuring one component's hull underestimates and never fires). The defensive single-loop branch is
 * kept (it costs nothing) but is effectively a no-op for truly multi-island input in v1.
 */
export function outerContourOfUnion(loops: IntPoint[][], w: number, h: number): IntPoint[] {
  if (w <= 0 || h <= 0) return [];
  const bits = new Uint8Array(w * h);
  for (const loop of loops) rasterizeLoop(loop, w, h, bits);
  const traced = traceContours({ w, h, bits });
  // Exactly one outer loop ⇒ the union is connected ⇒ that loop is the conservative merged hull.
  // Zero loops (nothing opaque) or >1 loop (disconnected far-apart islands) ⇒ no single conservative
  // hull exists ⇒ signal the caller to fall back to a rectangle.
  return traced.length === 1 ? traced[0]! : [];
}

/** Walk one island's outer contour starting at its top-left corner `(sc, sr)` heading EAST. */
function walkOuterContour(
  label: Int32Array,
  w: number,
  h: number,
  sc: number,
  sr: number,
  lab: number,
): IntPoint[] {
  const isOpaque = (cx: number, cy: number): boolean =>
    cx >= 0 && cy >= 0 && cx < w && cy < h && label[cy * w + cx] === lab;

  let cx = sc;
  let cy = sr;
  let heading = 0; // EAST
  const path: IntPoint[] = [];

  // Guard: a non-self-crossing corner walk visits each (corner, heading) state at most once, so it must
  // close well within the total number of such states. (The spec's `2*(w+h)` bound holds for convex
  // silhouettes; this looser cap simply guarantees termination for concave contours without ever
  // clipping a real loop.) Pure, no Date/RNG.
  const maxSteps = 4 * (w + 1) * (h + 1) + 8;

  for (let step = 0; step < maxSteps; step++) {
    path.push({ x: cx, y: cy });

    const fl = FRONT_LEFT[heading]!;
    const fr = FRONT_RIGHT[heading]!;
    const leftOpaque = isOpaque(cx + fl[0], cy + fl[1]);
    const rightOpaque = isOpaque(cx + fr[0], cy + fr[1]);

    // FROZEN turn table (see file header). Outer corner (`!right`) → turn right; straight (`right && !left`)
    // → keep heading; inner corner (`left && right`) → turn left. The `!left && !right` saddle row collapses
    // into the outer-corner branch — same "turn right" — preserving the frozen saddle rule exactly.
    let next: number;
    if (!rightOpaque) {
      next = (heading + 1) & 3; // turn right (covers outer-corner AND the frozen saddle)
    } else if (!leftOpaque) {
      next = heading; // straight
    } else {
      next = (heading + 3) & 3; // turn left (inner corner)
    }

    const d = DIR[next]!;
    cx += d[0];
    cy += d[1];
    heading = next;

    // Closed when we return to the start corner (the outer contour of a 4-connected island is a simple
    // loop, so the start corner uniquely terminates the walk).
    if (cx === sc && cy === sr) {
      return collapseCollinear(path);
    }
  }

  // Unreachable for a well-formed island; collapse whatever we have rather than loop forever.
  return collapseCollinear(path);
}

/** Drop vertices whose three-point turn is collinear (`orient == 0`), keeping the loop minimal. */
function collapseCollinear(path: IntPoint[]): IntPoint[] {
  const n = path.length;
  if (n < 3) return path.slice();
  const out: IntPoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[(i - 1 + n) % n]!;
    const b = path[i]!;
    const c = path[(i + 1) % n]!;
    if (orient(a, b, c) !== 0) out.push(b);
  }
  return out;
}

/** Scanline-fill the interior of a corner-lattice polygon into `bits` (cell opaque iff its center is
 *  inside-or-on the loop). Even-odd rule with integer cell centers (`x + 0.5`, `y + 0.5`), so an edge
 *  exactly on a center cannot tie. Deterministic; touches only cells in `[0, w) × [0, h)`. */
function rasterizeLoop(loop: IntPoint[], w: number, h: number, bits: Uint8Array): void {
  const n = loop.length;
  if (n < 3) return;
  for (let r = 0; r < h; r++) {
    const yc2 = 2 * r + 1; // 2 * (r + 0.5) — keep the sample on integer math by doubling
    for (let c = 0; c < w; c++) {
      const xc2 = 2 * c + 1; // 2 * (c + 0.5)
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const pi = loop[i]!;
        const pj = loop[j]!;
        const yi2 = 2 * pi.y;
        const yj2 = 2 * pj.y;
        // Edge straddles the sample row (half-open in Y) ⇒ test the X-intersection against the center.
        if ((yi2 > yc2) !== (yj2 > yc2)) {
          // x-intersection of edge (pj→pi) at the sample Y, scaled by 2 to compare with xc2 exactly:
          // x = pi.x + (pj.x - pi.x) * (yc2 - yi2) / (yj2 - yi2). Cross-multiply to avoid float compare.
          const num = (pj.x - pi.x) * (yc2 - yi2);
          const den = yj2 - yi2;
          // xc2 < 2*x  ⇔  xc2 < 2*pi.x + 2*num/den. Multiply through by `den` (sign-aware).
          const lhs = (xc2 - 2 * pi.x) * den;
          const rhs = 2 * num;
          if (den > 0 ? lhs < rhs : lhs > rhs) inside = !inside;
        }
      }
      if (inside) bits[r * w + c] = 1;
    }
  }
}
