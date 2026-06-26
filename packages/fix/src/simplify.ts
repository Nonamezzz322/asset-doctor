// Conservative integer-exact outline simplification for the binary (bitmap-mask) polygon packer.
// Two passes, both load-bearing-deterministic and FLOAT-FREE: (1) outward-only Ramer–Douglas–Peucker
// that splits at the largest EXACT integer cross-product distance (compared as `cross^2` vs
// `tolerance2 * segLen2`, both integers — never a sqrt or epsilon), then (2) an integer-exact
// Visvalingam count-cap that removes the smallest-|2A| local triangle first until the vertex budget
// is met. EVERY removal is guarded so the dropped points stay on/outside the kept edge (integer
// `orient` sign), making the result a conservative SUPERSET of the input loop — it can only grow
// outward, never clip an opaque texel. The output is normalized positive (CCW) via `signedArea2`.
// If the vertex cap cannot be met conservatively, we fall back to the bounding-rect quad (always a
// safe superset). Pure, zero-dependency, worker-safe.
// See docs/polygon-packer-design.md § "Determinism contract / Simplify".

import { type IntPoint, orient, signedArea2 } from './geom';

export interface SimplifyOptions {
  /** Squared-px RDP epsilon (INTEGER). A vertex survives RDP iff its `cross^2 > tolerance2 * segLen2`. */
  tolerance2: number;
  /** Hard cap on the output vertex count. */
  maxVerts: number;
}

/** Axis-aligned bounding-rect quad of `loop`, CCW under Y-down (the unconditional conservative fallback). */
function boundingRectQuad(loop: IntPoint[]): IntPoint[] {
  let minX = loop[0]!.x;
  let minY = loop[0]!.y;
  let maxX = loop[0]!.x;
  let maxY = loop[0]!.y;
  for (const p of loop) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // Positive (CCW) under the Y-down shoelace: TL → TR → BR → BL.
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

/** Drop consecutive coincident points and collinear runs (orient == 0), keeping the loop simple. */
function dedupeCollinear(loop: IntPoint[]): IntPoint[] {
  const pts: IntPoint[] = [];
  for (const p of loop) {
    const prev = pts[pts.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) pts.push(p);
  }
  // Wrap-around coincidence.
  while (pts.length >= 2 && pts[0]!.x === pts[pts.length - 1]!.x && pts[0]!.y === pts[pts.length - 1]!.y) {
    pts.pop();
  }
  if (pts.length < 3) return pts;
  const out: IntPoint[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n]!;
    const b = pts[i]!;
    const c = pts[(i + 1) % n]!;
    if (orient(a, b, c) !== 0) out.push(b);
  }
  return out;
}

/** Normalize to positive (CCW under Y-down). Reverses in place when `signedArea2 < 0`. */
function toCCW(loop: IntPoint[]): IntPoint[] {
  return signedArea2(loop) < 0 ? [...loop].reverse() : loop;
}

/** Outward-only RDP on the open chain `pts[lo..hi]` (inclusive endpoints kept). Returns the sorted set
 *  of surviving indices in [lo,hi]. EXACT integer distance: a point's perpendicular distance² to the
 *  segment (a,b) is `cross² / segLen²`; we compare `cross² > tolerance2 * segLen²` without dividing. */
function rdp(pts: IntPoint[], lo: number, hi: number, tolerance2: number, keep: boolean[]): void {
  if (hi <= lo + 1) return; // no interior point
  const a = pts[lo]!;
  const b = pts[hi]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const segLen2 = dx * dx + dy * dy;

  let split = -1;
  let bestCross2 = -1;
  for (let i = lo + 1; i < hi; i++) {
    const p = pts[i]!;
    // 2*area of triangle (a,b,p) = cross of (b-a)×(p-a); |cross| is the perpendicular distance numerator.
    const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
    const cross2 = cross * cross;
    if (cross2 > bestCross2) {
      // strictly greater ⇒ ties resolve to the LOWEST index (first seen wins)
      bestCross2 = cross2;
      split = i;
    }
  }
  if (split < 0) return;

  let exceeds: boolean;
  if (segLen2 === 0) {
    // Degenerate segment (coincident endpoints): distance² is the squared point distance to `a`.
    exceeds = bestCross2 > 0 || (pts[split]!.x - a.x) ** 2 + (pts[split]!.y - a.y) ** 2 > tolerance2;
  } else {
    // cross² / segLen² > tolerance2  ⇔  cross² > tolerance2 * segLen²  (both integers, no division)
    exceeds = bestCross2 > tolerance2 * segLen2;
  }

  if (exceeds) {
    keep[split] = true;
    rdp(pts, lo, split, tolerance2, keep);
    rdp(pts, split, hi, tolerance2, keep);
  }
  // else: all interior points fall within tolerance and are dropped — inherently outward for a CCW loop
  // only when they sit on/outside the chord; RDP on a CCW outline keeps the hull-side bulge, so the
  // conservative guard is enforced by the caller's full re-check below.
}

/**
 * Outward-only RDP (exact integer cross² distance) + integer-exact Visvalingam count-cap. Each removal
 * is guarded so dropped points stay on/outside the kept edge (integer `orient` sign), so the result is
 * a conservative superset of `loop`, normalized positive (CCW via `signedArea2`). If the vertex cap
 * cannot be met conservatively, returns the bounding-rect quad. NO float comparison in any load-bearing
 * path — distances use `cross²`, areas use integer `signedArea2`.
 */
export function simplifyConservative(loop: IntPoint[], opts: SimplifyOptions): IntPoint[] {
  if (loop.length === 0) return [];
  const cleaned = dedupeCollinear(loop);
  // Degenerate after cleanup (a single point or a thin line) ⇒ the bounding-rect quad is the smallest
  // conservative superset. `loop` is non-empty here, so the quad always has finite extent.
  if (cleaned.length < 3) return boundingRectQuad(loop);

  const ccw = toCCW(cleaned);
  const n = ccw.length;

  // ── Pass 1: outward-only RDP ──────────────────────────────────────────────────────────────────
  // Anchor at the lowest-index extreme point (min x, then min y) for a deterministic split of the loop
  // into two open chains. The anchor and its antipode are always kept; RDP simplifies each chain.
  let anchor = 0;
  for (let i = 1; i < n; i++) {
    const p = ccw[i]!;
    const a = ccw[anchor]!;
    if (p.x < a.x || (p.x === a.x && p.y < a.y)) anchor = i;
  }
  // Rotate so the anchor is index 0 (stable, deterministic).
  const rot: IntPoint[] = [];
  for (let i = 0; i < n; i++) rot.push(ccw[(anchor + i) % n]!);

  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  // Antipode = farthest index from the anchor along the chain (deterministic: lowest index on tie).
  let anti = 0;
  let bestD2 = -1;
  for (let i = 1; i < n; i++) {
    const p = rot[i]!;
    const d2 = (p.x - rot[0]!.x) ** 2 + (p.y - rot[0]!.y) ** 2;
    if (d2 > bestD2) {
      bestD2 = d2;
      anti = i;
    }
  }
  keep[anti] = true;
  rdp(rot, 0, anti, opts.tolerance2, keep);
  // Second chain wraps from anti back to 0; treat it as the open chain rot[anti..n] with rot[0] as the
  // closing endpoint by appending it as a virtual hi index.
  const wrap = [...rot, rot[0]!];
  const keepWrap = new Array<boolean>(n + 1).fill(false);
  keepWrap[n] = true; // virtual closing endpoint (== rot[0])
  rdp(wrap, anti, n, opts.tolerance2, keepWrap);
  for (let i = anti; i < n; i++) if (keepWrap[i]) keep[i] = true;

  // Build the RDP-simplified loop, then enforce the conservative outward guard edge-by-edge: any vertex
  // RDP dropped must lie on/outside its replacing edge. If a drop would clip inward, KEEP that vertex.
  let simplified = enforceOutwardGuard(rot, keep);
  simplified = dedupeCollinear(simplified);
  if (simplified.length < 3) return boundingRectQuad(rot);

  // ── Pass 2: integer-exact Visvalingam count-cap ───────────────────────────────────────────────
  const capped = visvalingamCap(simplified, opts.maxVerts);
  if (capped === null) return boundingRectQuad(rot);

  const result = dedupeCollinear(capped);
  if (result.length < 3) return boundingRectQuad(rot);
  // The bounding-rect quad is itself ≤ 4 verts; if the cap is < 4 we cannot stay conservative below it.
  if (result.length > opts.maxVerts) return boundingRectQuad(rot);

  return toCCW(result);
}

/** Rebuild the kept loop from `rot`/`keep`, but un-drop any vertex whose removal would clip inward
 *  (`orient < 0` vs its replacing edge, i.e. strictly outside a positive Y-down loop), so the
 *  simplified loop is a guaranteed outward superset. */
function enforceOutwardGuard(rot: IntPoint[], keep: boolean[]): IntPoint[] {
  const n = rot.length;
  const finalKeep = [...keep];
  // Iterate to a fixed point: re-checking is cheap and guarantees no inward clip survives.
  let changed = true;
  while (changed) {
    changed = false;
    const kept: number[] = [];
    for (let i = 0; i < n; i++) if (finalKeep[i]) kept.push(i);
    if (kept.length < 2) break;
    for (let k = 0; k < kept.length; k++) {
      const a = rot[kept[k]!]!;
      const b = rot[kept[(k + 1) % kept.length]!]!;
      const startIdx = kept[k]!;
      const endIdx = kept[(k + 1) % kept.length]!;
      // Walk the dropped vertices strictly between startIdx and endIdx (handling wrap).
      let i = (startIdx + 1) % n;
      while (i !== endIdx) {
        if (!finalKeep[i] && orient(a, b, rot[i]!) < 0) {
          // For a positive (CCW, Y-down) loop the interior is the `orient > 0` side, so a dropped vertex
          // with `orient < 0` lies strictly OUTSIDE the replacing edge ⇒ the chord clips its coverage.
          // Restore it to stay a conservative outward superset.
          finalKeep[i] = true;
          changed = true;
        }
        i = (i + 1) % n;
      }
      if (changed) break; // restart the fixed-point scan with the updated keep set
    }
  }
  const out: IntPoint[] = [];
  for (let i = 0; i < n; i++) if (finalKeep[i]) out.push(rot[i]!);
  return out;
}

/** Integer-exact Visvalingam count-cap. Repeatedly removes the vertex with the smallest |2A| of its
 *  local triangle (tie → lowest index), but ONLY when the dropped vertex lies on/outside the new edge
 *  (integer `orient` sign), keeping the loop a conservative outward superset. Returns null if no
 *  conservative removal exists while still over budget. Pure integer arithmetic. */
function visvalingamCap(loop: IntPoint[], maxVerts: number): IntPoint[] | null {
  const pts = [...loop];
  while (pts.length > maxVerts) {
    const n = pts.length;
    let bestIdx = -1;
    let bestArea2 = Infinity;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % n]!;
      // Removing b replaces edges a→b,b→c with a→c. For a positive (CCW, Y-down) loop the interior is the
      // `orient > 0` side, so removal is conservative only when b is concave — on/inside the new chord
      // (`orient(a,c,b) >= 0`). A convex bulge (`orient < 0`) would be clipped off, so skip it.
      if (orient(a, c, b) < 0) continue;
      const area2 = Math.abs(signedArea2([a, b, c])); // |2A| of the local triangle, integer-exact
      if (area2 < bestArea2) {
        // strictly less ⇒ ties resolve to the LOWEST index (first seen wins)
        bestArea2 = area2;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null; // no conservative removal possible while still over budget
    pts.splice(bestIdx, 1);
    if (pts.length < 3) return null;
  }
  return pts;
}
