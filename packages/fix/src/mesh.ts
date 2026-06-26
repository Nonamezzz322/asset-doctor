// Single-sprite mesh pipeline for the binary (bitmap-mask) polygon packer. Takes one capped-resolution
// `AlphaMask` and runs the full trace → simplify → triangulate chain on a SINGLE island, returning a
// trimmed-local outline + triangulation an engine MAY consume to cut overdraw AND the worker uses as
// interlock-clip geometry. Returns `null` (⇒ rectangle-only sprite, no mesh) whenever a mesh would be
// useless or wasteful (fully transparent, near-rectangular, too few vertices, or — in v1 — a sprite with
// multiple separate islands), so the caller falls back to the plain rectangle frame. When non-null the outline is GUARANTEED conservative — it contains every
// opaque pixel — because both the trace and the simplify are outward-only supersets. Pure, zero-dependency,
// worker-safe; every load-bearing comparison is integer-exact (no float epsilon).
// See docs/polygon-packer-design.md § "mesh.ts — trace→simplify→triangulate for ONE sprite".

import type { Vec2 } from '@asset-doctor/core';
import { signedArea2 } from './geom';
import type { AlphaMask } from './mask';
import { type SimplifyOptions, simplifyConservative } from './simplify';
import { outerContourOfUnion, traceContours } from './trace';
import { triangulate } from './triangulate';

/** A sprite's tight outline + triangulation in TRIMMED-SPRITE-LOCAL pixel space (Y-down, integer px).
 *  No `verticesUV` yet — the caller recomputes that from the FINAL per-bin frame.xy on placement. */
export interface RawMesh {
  vertices: Vec2[];
  triangles: number[][];
}

/** Mesh pipeline tuning. Inherits the simplify budget (`tolerance2`, `maxVerts`) and adds the distant-
 *  island guard: a merged hull whose area exceeds `hullAreaRatioMax * opaque-pixel area` is rejected
 *  (the mesh would wrap mostly-empty space, so a plain rectangle is the honest choice). */
export interface MeshOptions extends SimplifyOptions {
  hullAreaRatioMax: number;
}

/**
 * Full single-sprite mesh pipeline. Traces `mask`'s opaque island(s) and, for a single island, conservatively
 * simplifies and triangulates its outer contour.
 *
 * MULTI-ISLAND (v1): a sprite with two or more genuinely separate islands falls back to a plain rectangle
 * (no merged mesh). `outerContourOfUnion` only returns a hull when the input rasterizes back to ONE connected
 * loop (overlapping/touching islands), which separate islands do not — so `traceMesh` returns `null` for them
 * and the caller keeps the rectangle frame. The merged-hull branch is kept as a defensive no-op (see trace.ts).
 *
 * Returns `null` (⇒ rectangle-only sprite, no mesh) when a mesh is pointless or wasteful:
 *  - the mask is fully transparent (no contour);
 *  - the islands are disconnected (no single conservative hull — `outerContourOfUnion` returns `[]`);
 *  - fewer than 3 distinct vertices survive simplification (a point/thin line — bounding rect is enough);
 *  - the polygon area is `>=` the frame area (near-rectangular: the mesh saves nothing, just bloats);
 *  - the (single-loop) hull area exceeds `hullAreaRatioMax * opaque-pixel area` (the hull would cover
 *    mostly empty space).
 *
 * When non-null the outline is a conservative SUPERSET of the opaque mask (contains every opaque pixel),
 * positive (CCW under the Y-down shoelace), with `triangles.length === 3 * (vertices.length - 2)`. All
 * comparisons are integer-exact (areas via doubled `signedArea2`, never a float division). Pure.
 */
export function traceMesh(mask: AlphaMask, opts: MeshOptions): RawMesh | null {
  const { w, h } = mask;
  if (w <= 0 || h <= 0) return null;

  // Trace the opaque islands. Empty ⇒ fully transparent ⇒ no mesh.
  const loops = traceContours(mask);
  if (loops.length === 0) return null;

  // Single island ⇒ its outer contour. Multiple islands ⇒ outerContourOfUnion, which in v1 returns a
  // hull ONLY if they rasterize back to one connected loop (overlapping/touching); genuinely separate
  // islands yield `[]` here ⇒ rectangle fallback below (no merged mesh in v1).
  const hull = loops.length === 1 ? loops[0]! : outerContourOfUnion(loops, w, h);
  if (hull.length < 3) return null;

  // Distant-island guard. Compare with DOUBLED areas to stay integer-exact (signedArea2 returns 2*area).
  // hullArea > hullAreaRatioMax * opaqueArea  ⇔  |2*hullArea| > hullAreaRatioMax * 2*opaqueArea.
  const hullArea2 = Math.abs(signedArea2(hull));
  const opaqueArea2 = 2 * countOpaque(mask);
  if (opaqueArea2 === 0) return null; // no opaque pixels survived rasterization
  if (hullArea2 > opts.hullAreaRatioMax * opaqueArea2) return null;

  // Conservative simplify (outward-only superset, positive/CCW, capped vertex count).
  const simplified = simplifyConservative(hull, { tolerance2: opts.tolerance2, maxVerts: opts.maxVerts });
  if (simplified.length < 3) return null;

  // Near-rectangular guard: a mesh whose polygon area covers the whole frame is pointless bloat.
  // polygonArea >= frameArea  ⇔  |2*polygonArea| >= 2 * (w * h).
  const polyArea2 = Math.abs(signedArea2(simplified));
  if (polyArea2 >= 2 * w * h) return null;

  const triangles = triangulate(simplified);
  // Contract guard: a sound triangulation of an n-vertex simple loop has EXACTLY n-2 triangles and
  // partitions the polygon. `triangulate()` has a stall path that drops a vertex to guarantee
  // termination (numerically awkward / non-simple loops), which yields FEWER than n-2 triangles — a
  // triangle set that no longer covers every vertex. Shipping that would violate the frozen SpriteMesh
  // contract (`triangles.length === vertices.length - 2`) and render with gaps. If it ever fires, fall
  // back to a rectangle-only sprite (null) rather than emit a non-conservative mesh.
  if (triangles.length !== simplified.length - 2) return null;

  // The simplified loop's points are integer pixels ⇒ structurally valid Vec2.
  const vertices: Vec2[] = simplified.map((p) => ({ x: p.x, y: p.y }));
  return { vertices, triangles };
}

/** Scale a capped-resolution `RawMesh` back to full-res pixel space with a PROVABLY-conservative
 *  per-vertex outward snap so the outline stays a superset of the opaque silhouette at full res.
 *
 *  The capped outline already wraps the capped opaque CELLS; each capped cell `(c,r)` covers the full-res
 *  block `[c·scale,(c+1)·scale) × [r·scale,(r+1)·scale)`, so the conservative full-res outline is the
 *  capped loop scaled by `scale` and EXPANDED OUTWARD by one cell (`scale` px) on each axis whose interior
 *  side faces inward. Outward direction is derived per-vertex from the LOCAL interior side via the incident
 *  edges' outward normals (CCW Y-down: outward = right of travel = `(dy, −dx)`) — never from a global
 *  centroid, which is NOT provably conservative for concave outlines (a notch/diagonal vertex on the
 *  centroid-near side can round the wrong way and clip opaque pixels). Vertex count, order and the triangle
 *  index set are preserved, so the `SpriteMesh` contract is unchanged. Output stays trimmed-local integer
 *  px, clamped to `[0, frameW] × [0, frameH]`. `scale === 1` is the identity. Pure. */
export function scaleMeshToFrame(raw: RawMesh, scale: number, frameW: number, frameH: number): RawMesh {
  if (scale === 1) return raw;
  const n = raw.vertices.length;
  const vertices: Vec2[] = raw.vertices.map((cur, i) => {
    const prev = raw.vertices[(i - 1 + n) % n]!;
    const next = raw.vertices[(i + 1) % n]!;
    // For a positive (CCW) Y-down loop the interior is the `orient > 0` (left) side, so the OUTWARD normal
    // of an edge `(dx, dy)` is `(dy, −dx)`. Summing the incoming + outgoing edge normals gives the vertex's
    // combined outward direction; `sign` collapses to {−1,0,+1}. We expand outward by one cell only on an
    // axis whose outward sign is positive (the larger-coordinate side of the bounding interval).
    const ox = Math.sign(next.y - prev.y); // = sign((cur.y−prev.y) + (next.y−cur.y))
    const oy = Math.sign(prev.x - next.x); // = sign(−(cur.x−prev.x) − (next.x−cur.x))
    const x = cur.x * scale + (ox > 0 ? scale : 0);
    const y = cur.y * scale + (oy > 0 ? scale : 0);
    return { x: Math.max(0, Math.min(frameW, x)), y: Math.max(0, Math.min(frameH, y)) };
  });
  return { vertices, triangles: raw.triangles };
}

/** Count opaque cells (`bits !== 0`) in `mask` — the conservative outline must cover at least this area. */
function countOpaque(mask: AlphaMask): number {
  let count = 0;
  const { bits } = mask;
  for (let i = 0; i < bits.length; i++) if (bits[i]) count++;
  return count;
}
