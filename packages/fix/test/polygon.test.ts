// Pure-pipeline tests for the binary (bitmap-mask) polygon packer. Every fixture is a synthetic
// AlphaMask / MaskItem built inline (no image files) so the suite is fully DETERMINISTIC and exercises
// the geom → trace → simplify → triangulate → mesh → nest chain directly. The manifest/parser
// round-trip, back-compat (f) and UV/spill (l) cases live in fix.test.ts; this file owns the moat:
// (0) win-proof, (a) coverage superset, (b)/(c) determinism, (d) vertex cap, (e) triangulation
// soundness, (f) null guards, (g) nesting overlap + no-phantom-win.
// See docs/polygon-packer-design.md § "Test plan (final)".

import { describe, expect, it } from 'vitest';
import type { Atlas, Vec2 } from '@asset-doctor/core';
import {
  ACC_CELL,
  alphaMaskFromRGBA,
  DILATE_CELLS,
  EPSILON,
  HULL_AREA_RATIO_MAX,
  maskItemFromRGBA,
  MESH_MAX_CELLS,
  nestMasks,
  orient,
  pack,
  packMaskWords,
  POLY_MAX_VERTS,
  POLY_TOLERANCE2,
  polygonWins,
  repackAtlases,
  repackAtlasesPolygon,
  scaleMeshToFrame,
  signedArea2,
  simplifyConservative,
  traceContours,
  traceMesh,
  triangulate,
  type AlphaMask,
  type IntPoint,
  type MaskItem,
  type RawMesh,
} from '../src/index';

// ── Shared options + fixture builders (all deterministic, all integer) ──────────────────────────

const MESH_OPTS = { tolerance2: POLY_TOLERANCE2, maxVerts: POLY_MAX_VERTS, hullAreaRatioMax: HULL_AREA_RATIO_MAX };
const PACK_OPTS = { allowRotation: false, padding: 0, maxSize: 4096 };

/** Build an AlphaMask from a `predicate(c, r) -> opaque` over a `w × h` pixel grid. */
function maskFrom(w: number, h: number, opaque: (c: number, r: number) => boolean): AlphaMask {
  const bits = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (opaque(c, r)) bits[r * w + c] = 1;
  return { w, h, bits };
}

/** Build a MaskItem at the ACC_CELL grid (`cols × rows` cells) from a per-CELL predicate. `w/h` are the
 *  full-res px the emitted Placement uses; the opaque cells drive the nesting footprint. */
function maskItem(id: string, cols: number, rows: number, opaque: (c: number, r: number) => boolean): MaskItem {
  const bits = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (opaque(c, r)) bits[r * cols + c] = 1;
  return { id, w: cols * ACC_CELL, h: rows * ACC_CELL, cols, rows, bits };
}

// ── Concrete shapes (validated by hand) ─────────────────────────────────────────────────────────
// L-shape: left band (c<4) ∪ bottom band (r>=8) — the exact 6-vertex L, area == opaque area.
const lShape = (): AlphaMask => maskFrom(12, 12, (c, r) => c < 4 || r >= 8);
// U-shape: left/right columns + bottom band — deep concavity, single connected loop.
const uShape = (): AlphaMask => maskFrom(12, 12, (c, r) => c < 3 || c >= 9 || r >= 9);
// Plus/cross: a horizontal bar ∪ a vertical bar — 12-vertex concave (hits the cap exactly).
const plusShape = (): AlphaMask => maskFrom(12, 12, (c, r) => (c >= 4 && c < 8) || (r >= 4 && r < 8));
// Diagonal slot: thick main-diagonal band (|c-r| <= 2) — concave on both sides of the band.
const diagSlot = (): AlphaMask => maskFrom(10, 10, (c, r) => Math.abs(c - r) <= 2);
// Dumbbell: two tall bars bridged by a 1-row band — connected "near islands" that merge into ONE hull.
const dumbbell = (): AlphaMask =>
  maskFrom(11, 7, (c, r) => c < 3 || c >= 8 || (r === 3 && c >= 3 && c < 8));
// Far-apart islands: two 4×4 blocks separated by a wide transparent gap (4-connected ⇒ disconnected).
const farIslands = (): AlphaMask =>
  maskFrom(20, 8, (c, r) => r >= 2 && r < 6 && ((c >= 2 && c < 6) || (c >= 14 && c < 18)));

// ── Coverage oracle (the moat): rasterize the OUTPUT polygon at half-integer resolution ─────────
// We scale the polygon and every query point by 2 so cell centers (c+0.5, r+0.5 → 2c+1, 2r+1) and the
// four cell corners (2c,2r … 2c+2,2r+2) are all integers — no float predicate. `insideOrOn2x` is an
// inclusive even-odd test with an explicit on-edge short-circuit, so a point exactly ON the boundary
// counts as covered. This is the independent rasterizer that proves the mesh is a SUPERSET of the mask.

/** Inclusive point-in-polygon at the 2× lattice. Returns true iff `(qx, qy)` is inside OR on `loop2`. */
function insideOrOn2x(qx: number, qy: number, loop2: IntPoint[]): boolean {
  const n = loop2.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = loop2[j]!;
    const b = loop2[i]!;
    // On-edge (collinear AND within the edge's bbox, endpoints inclusive) ⇒ covered.
    if (
      orient(a, b, { x: qx, y: qy }) === 0 &&
      Math.min(a.x, b.x) <= qx &&
      qx <= Math.max(a.x, b.x) &&
      Math.min(a.y, b.y) <= qy &&
      qy <= Math.max(a.y, b.y)
    ) {
      return true;
    }
    if (a.y > qy !== b.y > qy) {
      const xCross = a.x + ((qy - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (qx < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Assert (returns the first failing cell, or null) that `loop` covers every opaque cell's CENTER and
 *  all FOUR corners. `loop` is in trimmed-local px; we double it once and probe the doubled lattice. */
function firstUncoveredCell(mask: AlphaMask, loop: ReadonlyArray<Vec2>): string | null {
  const loop2 = loop.map((p) => ({ x: 2 * p.x, y: 2 * p.y }));
  for (let r = 0; r < mask.h; r++) {
    for (let c = 0; c < mask.w; c++) {
      if (!mask.bits[r * mask.w + c]) continue;
      const probes: ReadonlyArray<readonly [number, number]> = [
        [2 * c + 1, 2 * r + 1], // center
        [2 * c, 2 * r], // TL corner
        [2 * c + 2, 2 * r], // TR
        [2 * c, 2 * r + 2], // BL
        [2 * c + 2, 2 * r + 2], // BR
      ];
      for (const [x, y] of probes) {
        if (!insideOrOn2x(x, y, loop2)) return `cell(${c},${r}) point(${x / 2},${y / 2})`;
      }
    }
  }
  return null;
}

// ── (0) WIN PROOF — the feature only ships if this holds ─────────────────────────────────────────

describe('(0) win proof — concave nesting beats rectangle packing', () => {
  /** Diagonal-slot MaskItem: only the main diagonal cell of each row is opaque. Tiny cell-area, full
   *  square bbox ⇒ many of them interlock into a far smaller POT than their bounding rectangles. */
  const diagItem = (id: string, n: number): MaskItem => maskItem(id, n, n, (c, r) => c === r);

  it('nestMasks reaches a strictly smaller POT bin than pack() on the trimmed bboxes', () => {
    const masks = Array.from({ length: 4 }, (_, i) => diagItem(`d${i}`, 8));
    const nestBins = nestMasks(masks, PACK_OPTS);
    const rectBins = pack(masks.map((m) => ({ id: m.id, w: m.w, h: m.h })), PACK_OPTS);

    // Single POT bin each (everything fits ≤ maxSize).
    expect(nestBins).toHaveLength(1);
    expect(rectBins).toHaveLength(1);
    const nestArea = nestBins[0]!.w * nestBins[0]!.h;
    const rectArea = rectBins[0]!.w * rectBins[0]!.h;
    // The interlock collapses one POT step: 32×64 (nest) vs 32×128 (pack).
    expect(nestBins[0]).toMatchObject({ w: 32, h: 64 });
    expect(rectBins[0]).toMatchObject({ w: 32, h: 128 });
    expect(nestArea).toBeLessThan(rectArea); // strictly smaller bin
  });

  it('polygonWins() is true for that pair through the full repack path (VRAM strictly down)', () => {
    const names = ['d0', 'd1', 'd2', 'd3'];
    const px = 8 * ACC_CELL; // 32px square sprites
    const atlas: Atlas = {
      name: 'concave.png',
      imageRef: 'concave.png',
      size: { w: 256, h: 256 },
      source: { kind: 'texturepacker-hash' },
      sprites: names.map((nm) => ({ name: nm, frame: { x: 0, y: 0, w: px, h: px }, rotated: false, trimmed: false, sourceSize: { w: px, h: px } })),
    };
    const masks = names.map((nm) => diagItem(`${atlas.name} ${nm}`, 8));

    const poly = repackAtlasesPolygon([atlas], masks, new Map(), { ...PACK_OPTS, emitMesh: false });
    const rect = repackAtlases([atlas], PACK_OPTS);

    expect(polygonWins(poly, rect)).toBe(true);
    expect(poly.vramBytesAfter).toBeLessThan(rect.vramBytesAfter);
    // Both keep every sprite (a win must not silently drop placements).
    expect(poly.blits).toHaveLength(names.length);
    expect(new Set(poly.atlases.flatMap((a) => a.sprites.map((s) => s.name))).size).toBe(names.length);
  });
});

// ── (a) COVERAGE INVARIANT (the moat) ────────────────────────────────────────────────────────────

describe('(a) coverage — the output polygon is a superset of the opaque mask', () => {
  const cases: ReadonlyArray<readonly [string, () => AlphaMask]> = [
    ['L-shape', lShape],
    ['U-shape (deep concavity)', uShape],
    ['plus/cross (deep concavity)', plusShape],
    ['diagonal slot', diagSlot],
    ['dumbbell (near islands merged into one hull)', dumbbell],
  ];
  for (const [name, fn] of cases) {
    it(`covers every opaque cell center + 4 corners — ${name}`, () => {
      const mask = fn();
      const mesh = traceMesh(mask, MESH_OPTS);
      expect(mesh, `${name} must mesh (sub-rectangular concave shape)`).not.toBeNull();
      const fail = firstUncoveredCell(mask, mesh!.vertices);
      expect(fail, `${name}: uncovered ${fail}`).toBeNull();
    });
  }

  it('far-apart islands fall back to rectangle (null) rather than emit a non-conservative hull', () => {
    // A single outer loop cannot cover two disconnected blocks without crossing the empty gap, and any
    // single component would DROP the other island's pixels (a coverage violation). traceMesh must null.
    const mask = farIslands();
    expect(traceMesh(mask, MESH_OPTS)).toBeNull();
  });
});

// ── (b) DETERMINISM — byte-identical across runs and input permutations ──────────────────────────

describe('(b) determinism', () => {
  it('traceMesh is byte-identical across two runs', () => {
    for (const fn of [lShape, uShape, plusShape, diagSlot, dumbbell]) {
      const a = traceMesh(fn(), MESH_OPTS);
      const b = traceMesh(fn(), MESH_OPTS);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('nestMasks is byte-identical across two runs', () => {
    const masks = Array.from({ length: 6 }, (_, i) => maskItem(`m${i}`, 6, 6, (c, r) => c <= r));
    expect(JSON.stringify(nestMasks(masks, PACK_OPTS))).toBe(JSON.stringify(nestMasks(masks, PACK_OPTS)));
  });

  it('nestMasks is invariant under input permutation (permutation-stable total order)', () => {
    const base = Array.from({ length: 7 }, (_, i) => maskItem(`s${i}`, 5 + (i % 3), 6, (c, r) => (c + r) % 2 === 0));
    const ref = nestMasks(base, PACK_OPTS);
    // Reverse order.
    expect(JSON.stringify(nestMasks([...base].reverse(), PACK_OPTS))).toBe(JSON.stringify(ref));
    // A deterministic shuffle (rotate by 3).
    const rotated = [...base.slice(3), ...base.slice(0, 3)];
    expect(JSON.stringify(nestMasks(rotated, PACK_OPTS))).toBe(JSON.stringify(ref));
  });
});

// ── (c) WALK DETERMINISM — fixed, asserted loops ─────────────────────────────────────────────────

describe('(c) walk determinism — checkerboard + diagonal chain produce fixed loops', () => {
  it('a 3×3 checkerboard traces 5 unit-square loops in row-major start order', () => {
    const mask = maskFrom(3, 3, (c, r) => (r + c) % 2 === 0);
    const loops = traceContours(mask);
    expect(loops).toEqual([
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      [{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 2, y: 1 }],
      [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }],
      [{ x: 0, y: 2 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 0, y: 3 }],
      [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 2, y: 3 }],
    ]);
    // Determinism: a second trace is byte-identical.
    expect(JSON.stringify(traceContours(mask))).toBe(JSON.stringify(loops));
  });

  it('a 4-pixel diagonal chain traces 4 unit-square loops down the diagonal', () => {
    const mask = maskFrom(4, 4, (c, r) => c === r);
    const loops = traceContours(mask);
    expect(loops).toEqual([
      [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }],
      [{ x: 2, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 2, y: 3 }],
      [{ x: 3, y: 3 }, { x: 4, y: 3 }, { x: 4, y: 4 }, { x: 3, y: 4 }],
    ]);
  });

  it('every traced loop is wound positive (CCW under the Y-down shoelace) and stays in-bounds', () => {
    const mask = uShape();
    for (const loop of traceContours(mask)) {
      expect(signedArea2(loop)).toBeGreaterThan(0); // positive winding
      for (const p of loop) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(mask.w);
        expect(p.y).toBeLessThanOrEqual(mask.h);
      }
    }
  });
});

// ── (d) VERTEX CAP ───────────────────────────────────────────────────────────────────────────────

describe('(d) vertex cap', () => {
  it('every mesh respects POLY_MAX_VERTS and triangles.length === vertices.length - 2', () => {
    for (const fn of [lShape, uShape, plusShape, diagSlot, dumbbell]) {
      const mesh = traceMesh(fn(), MESH_OPTS);
      expect(mesh).not.toBeNull();
      expect(mesh!.vertices.length).toBeLessThanOrEqual(POLY_MAX_VERTS);
      expect(mesh!.triangles.length).toBe(mesh!.vertices.length - 2);
      for (const tri of mesh!.triangles) expect(tri).toHaveLength(3);
    }
  });

  it('a jagged outline exceeding the cap is simplified down to <= maxVerts (still conservative)', () => {
    // A sawtooth top edge has many vertices; the count-cap must bring it under POLY_MAX_VERTS while the
    // result stays a coverage superset.
    const mask = maskFrom(24, 12, (c, r) => r >= 4 || (c % 2 === 0 && r >= 2));
    const mesh = traceMesh(mask, MESH_OPTS);
    if (mesh) {
      expect(mesh.vertices.length).toBeLessThanOrEqual(POLY_MAX_VERTS);
      expect(firstUncoveredCell(mask, mesh.vertices)).toBeNull();
    }
  });

  it('simplifyConservative never exceeds the requested maxVerts', () => {
    // A 16-vertex star-ish loop simplified to a tight cap.
    const loop: IntPoint[] = [];
    const r1 = 20;
    const r2 = 10;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      loop.push({ x: Math.round(30 + r1 * Math.cos(a)), y: Math.round(30 + r1 * Math.sin(a)) });
      const b = a + Math.PI / 8;
      loop.push({ x: Math.round(30 + r2 * Math.cos(b)), y: Math.round(30 + r2 * Math.sin(b)) });
    }
    const out = simplifyConservative(loop, { tolerance2: POLY_TOLERANCE2, maxVerts: 8 });
    expect(out.length).toBeLessThanOrEqual(8);
  });
});

// ── (e) TRIANGULATION SOUNDNESS ──────────────────────────────────────────────────────────────────

describe('(e) triangulation soundness', () => {
  /** Σ |2A| over triangles, integer-exact (each triangle area via signedArea2). */
  function triAreaSum2(verts: ReadonlyArray<Vec2>, tris: number[][]): number {
    let sum = 0;
    for (const [i, j, k] of tris) sum += Math.abs(signedArea2([verts[i]!, verts[j]!, verts[k]!]));
    return sum;
  }

  it('Σ triangle |2A| == polygon |2A| and every triangle is positively wound (CCW)', () => {
    for (const fn of [lShape, uShape, plusShape, diagSlot, dumbbell]) {
      const mesh = traceMesh(fn(), MESH_OPTS);
      expect(mesh).not.toBeNull();
      const polyArea2 = Math.abs(signedArea2(mesh!.vertices));
      const sum2 = triAreaSum2(mesh!.vertices, mesh!.triangles);
      // The ONLY float-epsilon use in the suite (a non-load-bearing sanity sum); the values are exact
      // integers so this is really an equality, expressed with EPSILON per the spec.
      expect(Math.abs(sum2 - polyArea2)).toBeLessThan(EPSILON);
      // Positive winding: polygon and every emitted triangle.
      expect(signedArea2(mesh!.vertices)).toBeGreaterThan(0);
      for (const [i, j, k] of mesh!.triangles) {
        const a2 = signedArea2([mesh!.vertices[i]!, mesh!.vertices[j]!, mesh!.vertices[k]!]);
        expect(a2).toBeGreaterThan(0); // CCW, non-degenerate (no zero-area triangle)
      }
    }
  });

  it('triangulate() on a CCW square emits n-2 positively-wound triangles', () => {
    const square: IntPoint[] = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    const tris = triangulate(square);
    expect(tris).toHaveLength(square.length - 2);
    let sum2 = 0;
    for (const [i, j, k] of tris) {
      const a2 = signedArea2([square[i]!, square[j]!, square[k]!]);
      expect(a2).toBeGreaterThan(0);
      sum2 += a2;
    }
    expect(sum2).toBe(Math.abs(signedArea2(square))); // exact integer area partition
  });
});

// ── (f) NULL GUARDS ──────────────────────────────────────────────────────────────────────────────

describe('(f) null guards — traceMesh returns null when a mesh is useless', () => {
  it('a fully transparent mask returns null', () => {
    expect(traceMesh(maskFrom(8, 8, () => false), MESH_OPTS)).toBeNull();
  });

  it('a fully opaque (rectangular) mask returns null — the mesh would cover the whole frame', () => {
    expect(traceMesh(maskFrom(8, 8, () => true), MESH_OPTS)).toBeNull();
  });

  it('a near-rectangular mask (hollow ring) returns null — its OUTER hull is the full frame', () => {
    // A hollow ring (opaque border, transparent center) drops its hole, so the outer contour is the
    // full bounding rectangle ⇒ polyArea2 >= 2*w*h ⇒ the near-rectangular guard fires (no useful mesh).
    const mask = maskFrom(8, 8, (c, r) => c === 0 || c === 7 || r === 0 || r === 7);
    expect(traceMesh(mask, MESH_OPTS)).toBeNull();
  });

  it('a zero-size mask returns null', () => {
    expect(traceMesh({ w: 0, h: 0, bits: new Uint8Array(0) }, MESH_OPTS)).toBeNull();
  });

  it('a tiny opaque mask (single cell) yields the conservative bounding-rect quad (per the impl)', () => {
    // A single opaque cell traces to a unit-square loop (>= 3 verts), area 1 < frame area, so the
    // implementation returns the 4-vertex bounding-rect quad — itself the smallest conservative superset.
    const mask = maskFrom(8, 8, (c, r) => c === 0 && r === 0);
    const mesh = traceMesh(mask, MESH_OPTS);
    expect(mesh).not.toBeNull();
    expect(mesh!.vertices).toHaveLength(4); // bounding-rect quad
    expect(mesh!.triangles).toHaveLength(2);
    expect(firstUncoveredCell(mask, mesh!.vertices)).toBeNull(); // still a conservative superset
  });
});

// ── (g) NESTING — overlap-free at the mask level; no phantom padding win ──────────────────────────

describe('(g) nesting', () => {
  /** Word-wise overlap of two placed PackedMasks would mean their opaque cells collide. Re-derive each
   *  mask's occupied cells at its placement origin and assert no opaque cell is claimed twice. */
  function maskCellsOverlapFree(items: MaskItem[], opts = PACK_OPTS): boolean {
    const bins = nestMasks(items, opts);
    const byId = new Map(items.map((m) => [m.id, m]));
    for (const bin of bins) {
      const occupied = new Set<number>();
      const cols = Math.ceil(bin.w / ACC_CELL);
      for (const p of bin.placements) {
        const m = byId.get(p.id);
        if (!m) continue; // clamp-alone spill items carry no original id mapping in pathological cases
        const ox = p.x / ACC_CELL;
        const oy = p.y / ACC_CELL;
        for (let r = 0; r < m.rows; r++) {
          for (let c = 0; c < m.cols; c++) {
            if (!m.bits[r * m.cols + c]) continue;
            const key = (oy + r) * cols + (ox + c);
            if (occupied.has(key)) return false; // an opaque cell placed on top of another
            occupied.add(key);
          }
        }
      }
    }
    return true;
  }

  it('interlocked masks never overlap at the OPAQUE-CELL level', () => {
    const masks = Array.from({ length: 5 }, (_, i) => maskItem(`d${i}`, 8, 8, (c, r) => c === r));
    expect(maskCellsOverlapFree(masks)).toBe(true);
  });

  it('every placement snaps to the ACC_CELL grid and the bin is trimmed tight (no empty bottom/right)', () => {
    const masks = Array.from({ length: 5 }, (_, i) => maskItem(`s${i}`, 6, 6, (c, r) => c <= r));
    const bins = nestMasks(masks, PACK_OPTS);
    for (const bin of bins) {
      // The bin is trimmed to its exact content extent (TexturePacker-style tight): the POT candidate's
      // unused bottom/right margin is never shipped as empty sheet space.
      let usedW = 0;
      let usedH = 0;
      for (const p of bin.placements) {
        if (p.x + p.w > usedW) usedW = p.x + p.w;
        if (p.y + p.h > usedH) usedH = p.y + p.h;
      }
      expect(bin.w).toBe(usedW);
      expect(bin.h).toBe(usedH);
      for (const p of bin.placements) {
        expect(p.x % ACC_CELL).toBe(0);
        expect(p.y % ACC_CELL).toBe(0);
        expect(p.rotated).toBe(false); // v1: never rotated
        expect(p.x + p.w).toBeLessThanOrEqual(bin.w);
        expect(p.y + p.h).toBeLessThanOrEqual(bin.h);
      }
    }
  });

  it('no phantom padding win: a fully-rectangular fixture yields identical bins and polygonWins()===false', () => {
    const names = ['s0', 's1', 's2', 's3'];
    const px = 8 * ACC_CELL;
    const atlas: Atlas = {
      name: 'solid.png',
      imageRef: 'solid.png',
      size: { w: 256, h: 256 },
      source: { kind: 'texturepacker-hash' },
      sprites: names.map((nm) => ({ name: nm, frame: { x: 0, y: 0, w: px, h: px }, rotated: false, trimmed: false, sourceSize: { w: px, h: px } })),
    };
    // Fully-opaque masks ⇒ the nester's cell-area lower bound equals the bbox area ⇒ same POT bins.
    const masks = names.map((nm) => maskItem(`${atlas.name} ${nm}`, 8, 8, () => true));

    const poly = repackAtlasesPolygon([atlas], masks, new Map(), { ...PACK_OPTS, emitMesh: true });
    const rect = repackAtlases([atlas], PACK_OPTS);

    expect(poly.atlases.map((a) => a.size)).toEqual(rect.atlases.map((a) => a.size)); // identical bin sizes
    expect(poly.vramBytesAfter).toBe(rect.vramBytesAfter);
    expect(polygonWins(poly, rect)).toBe(false); // equal VRAM ⇒ no claimed win
  });
});

// ── (h) INTERLOCK PIXEL-SURVIVAL — the cardinal feature claim ─────────────────────────────────────
// The design's load-bearing safety proof (test (h)): full-res FRAME overlap is ALLOWED, but clipping
// each meshed blit to its conservative `verticesUV` under source-over leaves every sprite's opaque
// texel intact — no opaque pixel of one sprite is overwritten by a later blit. This REPLACES the old
// bbox-overlap-free assertion (which still holds only for the non-meshed/rectangle path, covered in (g)).
// We use the downward-chevron silhouette: its opaque TOP nests into the previous chevron's empty BOTTOM,
// so nestMasks produces genuinely OVERLAPPING bounding boxes while each sprite carries a conservative mesh.

describe('(h) interlock pixel-survival under mesh-clip compose', () => {
  const N = 8; // 8×8 cells ⇒ 32px sprites (ACC_CELL = 4)
  // Downward chevron: opaque iff r <= c AND r <= (N-1-c). Top row is widest, point at the bottom — the
  // empty lower-left/right wings let the next chevron's top nest in, forcing overlapping bounding boxes.
  const chevron = (c: number, r: number): boolean => r <= c && r <= N - 1 - c;
  const chevronCellMask = (id: string): MaskItem => maskItem(id, N, N, chevron);
  // Full-res opaque silhouette of one sprite (px-exact). ACC_CELL == 4, so cell (c,r) opaque ⇒ the 4×4
  // px block [c·4,(c+1)·4) × [r·4,(r+1)·4) is opaque. This is the conservative source the clip must keep.
  const spriteOpaqueAt = (lx: number, ly: number): boolean => chevron((lx / ACC_CELL) | 0, (ly / ACC_CELL) | 0);

  /** Inclusive point-in-polygon on the integer lattice (no doubling needed — coords are integers). */
  const pointInLoop = (px: number, py: number, loop: ReadonlyArray<Vec2>): boolean => insideOrOn2x(px, py, loop as IntPoint[]);

  it('nestMasks places ≥1 meshed pair with OVERLAPPING bounding boxes (interlock actually happens)', () => {
    const masks = Array.from({ length: 4 }, (_, i) => chevronCellMask(`c${i}`));
    const bins = nestMasks(masks, PACK_OPTS);
    const ps = bins.flatMap((b) => b.placements);
    let overlaps = 0;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]!;
        const b = ps[j]!;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
      }
    }
    expect(overlaps, 'the fixture must produce interlocked (bbox-overlapping) placements, else (h) is vacuous').toBeGreaterThan(0);
    // And each sprite must actually carry a conservative mesh (else the clip path is never exercised).
    const mesh = traceMesh(maskFrom(N, N, chevron), MESH_OPTS);
    expect(mesh, 'the chevron silhouette must mesh').not.toBeNull();
    expect(firstUncoveredCell(maskFrom(N, N, chevron), mesh!.vertices)).toBeNull(); // conservative
  });

  it('clipping each blit to its verticesUV under source-over preserves every opaque texel', () => {
    const names = ['c0', 'c1', 'c2', 'c3'];
    const px = N * ACC_CELL; // 32px
    const atlas: Atlas = {
      name: 'chevron.png',
      imageRef: 'chevron.png',
      size: { w: 256, h: 256 },
      source: { kind: 'texturepacker-hash' },
      sprites: names.map((nm) => ({ name: nm, frame: { x: 0, y: 0, w: px, h: px }, rotated: false, trimmed: false, sourceSize: { w: px, h: px } })),
    };
    // Every sprite shares the same chevron silhouette ⇒ build one mesh and key it per dir-aware id.
    // The mesh is built at the FULL FRAME resolution (px²), matching how the worker derives it (the
    // AlphaMask is the frame-px silhouette), so `verticesUV` lives in the same px space as the sprite.
    const raw = traceMesh(maskFrom(px, px, (x, y) => spriteOpaqueAt(x, y)), MESH_OPTS)!;
    const masks = names.map((nm) => maskItem(`${atlas.name} ${nm}`, N, N, chevron));
    const meshById = new Map(names.map((nm) => [`${atlas.name} ${nm}`, raw] as const));

    const poly = repackAtlasesPolygon([atlas], masks, meshById, { ...PACK_OPTS, emitMesh: true });

    // Every meshed blit must carry a clip; collect the blits in a single atlas (no spill expected here).
    expect(poly.atlases).toHaveLength(1);
    const sheet = poly.atlases[0]!;
    const clipped = poly.blits.filter((b) => b.clip && b.clip.length >= 3);
    expect(clipped.length, 'all four chevrons must carry a mesh clip').toBe(names.length);

    // Assert interlock at the FRAME level: at least one pair of these blits has overlapping `to` rects.
    let frameOverlap = false;
    for (let i = 0; i < poly.blits.length && !frameOverlap; i++) {
      for (let j = i + 1; j < poly.blits.length; j++) {
        const a = poly.blits[i]!.to;
        const b = poly.blits[j]!.to;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          frameOverlap = true;
          break;
        }
      }
    }
    expect(frameOverlap, 'interlock requires overlapping destination rects (else nothing to prove)').toBe(true);

    // ── Software source-over recompose, clipped per blit, in DETERMINISTIC draw order ──────────────
    // owner[i] = index of the blit whose opaque texel currently occupies sheet pixel i (-1 = empty). A
    // later blit may only WRITE where its clip polygon admits it (clip emulates c2d.clip()); within the
    // clip it stamps wherever its SOURCE is opaque (source-over). The invariant: no opaque texel that an
    // earlier sprite already owns is overwritten by a later sprite — i.e. opaque pixels never collide.
    const W = sheet.size.w;
    const Hh = sheet.size.h;
    const owner = new Int32Array(W * Hh).fill(-1);
    // Map each blit (by name) back to its destination origin; the chevron is unrotated, frame == 32².
    const blitByName = new Map(poly.blits.map((b) => [b.name, b] as const));
    names.forEach((nm, drawIdx) => {
      const b = blitByName.get(nm)!;
      const clip = b.clip!; // verticesUV in atlas space
      const ox = b.to.x;
      const oy = b.to.y;
      for (let ly = 0; ly < px; ly++) {
        for (let lx = 0; lx < px; lx++) {
          if (!spriteOpaqueAt(lx, ly)) continue; // transparent source pixel writes nothing
          const ax = ox + lx;
          const ay = oy + ly;
          // c2d.clip(): only pixels whose CENTER is inside-or-on the clip polygon are written. The clip is
          // the conservative verticesUV, so every opaque source pixel must fall inside it (else the clip
          // would itself erase opaque content — a separate failure we also catch here).
          if (!pointInLoop(ax + 0.5, ay + 0.5, clip)) {
            // Probe corners too: a conservative clip must admit the whole opaque texel.
            throw new Error(`clip clipped its OWN opaque texel: sprite ${nm} local(${lx},${ly}) atlas(${ax},${ay})`);
          }
          const idx = ay * W + ax;
          if (owner[idx] !== -1 && owner[idx] !== drawIdx) {
            throw new Error(`opaque corruption: sprite ${nm} (draw ${drawIdx}) overwrote opaque texel of draw ${owner[idx]} at atlas(${ax},${ay})`);
          }
          owner[idx] = drawIdx;
        }
      }
    });
    // If we got here, every opaque texel of every sprite survived the interlocked, clipped recompose.
    expect(true).toBe(true);

    // ── Stronger safety property (finding #1): the CLIP REGIONS are mutually disjoint ───────────────
    // The pixel-survival above only stamps OPAQUE SOURCE pixels; the deeper guarantee the design rests
    // on is that each blit's clip masks it so that — even if a source frame had stray opaque bleed in
    // its transparent margin — a later full-rect drawImage could never write into a neighbor's region.
    // We rasterize the WHOLE clip polygon of each blit and assert no sheet pixel is admitted by two
    // different clips. Disjoint clip regions ⇒ overlapping bounding boxes are provably safe regardless
    // of source content (the clip ⊆ the nester's reserved footprint, so no foreign opaque can land).
    const clipOwner = new Int32Array(W * Hh).fill(-1);
    names.forEach((nm, drawIdx) => {
      const clip = blitByName.get(nm)!.clip!;
      // Bounding box of the clip in sheet space (clamp to the sheet).
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of clip) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      for (let ay = Math.max(0, minY); ay < Math.min(Hh, maxY); ay++) {
        for (let ax = Math.max(0, minX); ax < Math.min(W, maxX); ax++) {
          if (!pointInLoop(ax + 0.5, ay + 0.5, clip)) continue; // outside this clip ⇒ not drawn
          const idx = ay * W + ax;
          if (clipOwner[idx] !== -1 && clipOwner[idx] !== drawIdx) {
            throw new Error(`clip regions overlap: sprite ${nm} clip admits atlas(${ax},${ay}) already claimed by draw ${clipOwner[idx]} — a later full-rect blit could corrupt it`);
          }
          clipOwner[idx] = drawIdx;
        }
      }
    });
  });
});

// ── (h2) SCALE>1 conservative coverage — the capped→full-res mesh scale-up is a superset ───────────
// scaleMeshToFrame maps a capped-resolution mesh (long edge > MESH_MAX_CELLS sprites) back to full-res
// frame px. It MUST stay a conservative superset of the opaque silhouette at full res — a centroid
// heuristic does not, so this exercises the per-vertex outward-normal interval snap directly on concave
// shapes whose capped outline is scaled up by 2× and 3×.

describe('(h2) scaleMeshToFrame is a conservative superset at full resolution', () => {
  /** Probe every full-res opaque pixel of `cappedMask` blown up by `scale` and assert the scaled mesh
   *  covers each pixel's CENTER and all four CORNERS (the same superset bar as firstUncoveredCell). */
  function firstUncoveredFullRes(cappedMask: AlphaMask, scaledLoop: ReadonlyArray<Vec2>, scale: number): string | null {
    const loop2 = scaledLoop.map((p) => ({ x: 2 * p.x, y: 2 * p.y }));
    for (let r = 0; r < cappedMask.h; r++) {
      for (let c = 0; c < cappedMask.w; c++) {
        if (!cappedMask.bits[r * cappedMask.w + c]) continue;
        // capped cell (c,r) ⇒ full-res pixel block [c·scale,(c+1)·scale) × [r·scale,(r+1)·scale)
        for (let fy = r * scale; fy < (r + 1) * scale; fy++) {
          for (let fx = c * scale; fx < (c + 1) * scale; fx++) {
            const probes: ReadonlyArray<readonly [number, number]> = [
              [2 * fx + 1, 2 * fy + 1],
              [2 * fx, 2 * fy],
              [2 * fx + 2, 2 * fy],
              [2 * fx, 2 * fy + 2],
              [2 * fx + 2, 2 * fy + 2],
            ];
            for (const [x, y] of probes) {
              if (!insideOrOn2x(x, y, loop2)) return `fullres(${fx},${fy}) from cell(${c},${r})`;
            }
          }
        }
      }
    }
    return null;
  }

  const cappedCases: ReadonlyArray<readonly [string, () => AlphaMask]> = [
    ['L-shape', lShape],
    ['U-shape (deep concavity)', uShape],
    ['plus/cross', plusShape],
    ['diagonal slot', diagSlot],
  ];

  for (const scale of [2, 3]) {
    for (const [name, fn] of cappedCases) {
      it(`scale=${scale} — ${name} stays a full-res superset`, () => {
        const cappedMask = fn();
        const raw = traceMesh(cappedMask, MESH_OPTS);
        expect(raw, `${name} must mesh at capped res`).not.toBeNull();
        // Sanity: the capped mesh itself is already conservative at capped res.
        expect(firstUncoveredCell(cappedMask, raw!.vertices)).toBeNull();
        // Scale up to a full-res frame (cappedW·scale × cappedH·scale) and re-check coverage.
        const frameW = cappedMask.w * scale;
        const frameH = cappedMask.h * scale;
        const scaled = scaleMeshToFrame(raw as RawMesh, scale, frameW, frameH);
        // Vertex count + triangulation are preserved (SpriteMesh contract unchanged by the scale-up).
        expect(scaled.vertices).toHaveLength(raw!.vertices.length);
        expect(scaled.triangles).toEqual(raw!.triangles);
        // Every full-res opaque pixel (center + corners) is covered ⇒ the clip never erases opaque content.
        expect(firstUncoveredFullRes(cappedMask, scaled.vertices, scale)).toBeNull();
        // Stays inside the frame.
        for (const v of scaled.vertices) {
          expect(v.x).toBeGreaterThanOrEqual(0);
          expect(v.y).toBeGreaterThanOrEqual(0);
          expect(v.x).toBeLessThanOrEqual(frameW);
          expect(v.y).toBeLessThanOrEqual(frameH);
        }
      });
    }
  }

  it('scale=1 is the identity (no change to the capped mesh)', () => {
    const raw = traceMesh(uShape(), MESH_OPTS) as RawMesh;
    const same = scaleMeshToFrame(raw, 1, 100, 100);
    expect(same).toBe(raw);
  });
});

// ── packMaskWords sanity — the nester's overlap primitive packs/round-trips bit-exactly ─────────

describe('packMaskWords', () => {
  it('packs cell bits MSB-first with one fresh word boundary per row, round-tripping every opaque cell', () => {
    // 40 cols crosses a 32-bit word boundary, exercising the multi-word-per-row stride.
    const cols = 40;
    const rows = 3;
    const m = maskItem('w', cols, rows, (c, r) => (c + r) % 3 === 0);
    const { stride, words } = packMaskWords(m);
    expect(stride).toBe(Math.ceil(cols / 32));
    expect(words.length).toBe(stride * rows);
    const get = (r: number, c: number): number => {
      const wi = r * stride + (c >>> 5);
      const bit = 31 - (c & 31);
      return (words[wi]! >>> bit) & 1;
    };
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) expect(get(r, c)).toBe(m.bits[r * cols + c]);
  });
});

// ── RGBA extraction (pure cores of the worker's buildMaskItem / buildAlphaMask) ──────────────────
// Build an RGBA buffer of `imgW × imgH` px; `opaque(x, y)` decides whether the pixel's alpha is set.
// RGB channels are left 0 — only alpha is load-bearing for the threshold. Returns the worker's `src`.
function rgbaFrom(imgW: number, imgH: number, opaque: (x: number, y: number) => boolean): { data: Uint8ClampedArray; width: number } {
  const data = new Uint8ClampedArray(imgW * imgH * 4);
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x++) {
      if (opaque(x, y)) data[(y * imgW + x) * 4 + 3] = 255;
    }
  }
  return { data, width: imgW };
}

describe('maskItemFromRGBA — pure nesting-footprint extraction', () => {
  it('w/h stay full-res and the cell grid is ceil(size / ACC_CELL)', () => {
    // 10 px wide ⇒ ceil(10/4) = 3 cols; 8 px tall ⇒ 2 rows.
    const src = rgbaFrom(10, 8, () => true);
    const m = maskItemFromRGBA('x', src, { x: 0, y: 0, w: 10, h: 8 }, 0);
    expect(m.w).toBe(10);
    expect(m.h).toBe(8);
    expect(m.cols).toBe(Math.ceil(10 / ACC_CELL));
    expect(m.rows).toBe(Math.ceil(8 / ACC_CELL));
  });

  it('a cell is opaque iff ANY contained source px clears the alpha threshold (opaque bias)', () => {
    // Exactly one opaque px at (5, 1) ⇒ only cell (col 1, row 0) is set; everything else free.
    const src = rgbaFrom(12, 12, (x, y) => x === 5 && y === 1);
    const m = maskItemFromRGBA('x', src, { x: 0, y: 0, w: 12, h: 12 }, 0);
    const cell = (c: number, r: number): number => m.bits[r * m.cols + c]!;
    expect(cell(1, 0)).toBe(1); // 5/4 = 1, 1/4 = 0
    let set = 0;
    for (const b of m.bits) set += b;
    expect(set).toBe(1);
  });

  it('respects the region offset (reads from region.x/y, not the buffer origin)', () => {
    // Opaque only at absolute (6, 6); a region starting at (4, 4) sees it at local (2, 2) ⇒ cell (0,0).
    const src = rgbaFrom(12, 12, (x, y) => x === 6 && y === 6);
    const m = maskItemFromRGBA('x', src, { x: 4, y: 4, w: 4, h: 4 }, 0);
    expect(m.cols).toBe(1);
    expect(m.rows).toBe(1);
    expect(m.bits[0]).toBe(1);
  });

  it('padding 0 ⇒ NO dilation; the opaque cell set equals the thresholded set', () => {
    // A single ACC_CELL-ALIGNED block (cell (1,1): px [4,8) × [4,8)) ⇒ exactly one opaque cell.
    const src = rgbaFrom(16, 16, (x, y) => x >= ACC_CELL && x < 2 * ACC_CELL && y >= ACC_CELL && y < 2 * ACC_CELL);
    const m = maskItemFromRGBA('x', src, { x: 0, y: 0, w: 16, h: 16 }, 0);
    let set = 0;
    for (const b of m.bits) set += b;
    expect(set).toBe(1); // exactly the single cell, no neighbours
  });

  it('dilation grows the opaque cell set by exactly DILATE_CELLS(padding) cells (Chebyshev)', () => {
    // A single opaque cell in the middle of a generous grid. Chebyshev dilation by d cells turns it into
    // a (2d+1)×(2d+1) opaque block — a deterministic count we can assert exactly.
    const cell = ACC_CELL; // one opaque ACC_CELL block at cells (4,4) of a 9x9-cell grid (36x36 px)
    const cx = 4 * cell;
    const cy = 4 * cell;
    const src = rgbaFrom(36, 36, (x, y) => x >= cx && x < cx + cell && y >= cy && y < cy + cell);
    for (const padding of [ACC_CELL, 2 * ACC_CELL]) {
      const d = DILATE_CELLS(padding);
      expect(d).toBeGreaterThan(0);
      const m = maskItemFromRGBA('x', src, { x: 0, y: 0, w: 36, h: 36 }, padding);
      let set = 0;
      for (const b of m.bits) set += b;
      expect(set).toBe((2 * d + 1) * (2 * d + 1)); // the dilated block, fully inside the 9x9 grid
    }
  });

  it('padding 2 dilates by exactly 1 cell (the conservative >= padding separation)', () => {
    // padding 2 ⇒ ceil(2/4) = 1 cell of dilation ⇒ a single cell becomes a 3×3 block (9 cells).
    expect(DILATE_CELLS(2)).toBe(1);
    const cell = ACC_CELL;
    const src = rgbaFrom(36, 36, (x, y) => x >= 4 * cell && x < 5 * cell && y >= 4 * cell && y < 5 * cell);
    const m = maskItemFromRGBA('x', src, { x: 0, y: 0, w: 36, h: 36 }, 2);
    let set = 0;
    for (const b of m.bits) set += b;
    expect(set).toBe(9);
  });

  it('the dilated mask is a conservative SUPERSET of the un-dilated (padding 0) mask', () => {
    const src = rgbaFrom(40, 40, (x, y) => ((x >> 2) + (y >> 2)) % 3 === 0); // scattered opaque cells
    const bare = maskItemFromRGBA('x', src, { x: 0, y: 0, w: 40, h: 40 }, 0);
    const padded = maskItemFromRGBA('x', src, { x: 0, y: 0, w: 40, h: 40 }, ACC_CELL);
    expect(bare.bits.length).toBe(padded.bits.length);
    for (let i = 0; i < bare.bits.length; i++) {
      if (bare.bits[i]) expect(padded.bits[i], `cell ${i} must survive dilation`).toBe(1);
    }
  });
});

describe('alphaMaskFromRGBA — pure capped-resolution silhouette extraction', () => {
  it('scale = 1 for small sprites (long edge <= MESH_MAX_CELLS); dims match the region', () => {
    const src = rgbaFrom(64, 48, () => true);
    const { mask, scale } = alphaMaskFromRGBA(src, { x: 0, y: 0, w: 64, h: 48 });
    expect(scale).toBe(1);
    expect(mask.w).toBe(64);
    expect(mask.h).toBe(48);
  });

  it('downscale factor is exactly ceil(longEdge / MESH_MAX_CELLS) at and across the cap boundary', () => {
    // long edge == MESH_MAX_CELLS ⇒ still scale 1 (boundary is inclusive).
    expect(alphaMaskFromRGBA(rgbaFrom(1, 1, () => false), { x: 0, y: 0, w: MESH_MAX_CELLS, h: 1 }).scale).toBe(1);
    // long edge == MESH_MAX_CELLS + 1 ⇒ first crosses into scale 2.
    expect(alphaMaskFromRGBA(rgbaFrom(1, 1, () => false), { x: 0, y: 0, w: MESH_MAX_CELLS + 1, h: 1 }).scale).toBe(2);
    // exactly 2× the cap ⇒ scale 2; one past ⇒ scale 3.
    expect(alphaMaskFromRGBA(rgbaFrom(1, 1, () => false), { x: 0, y: 0, w: 2 * MESH_MAX_CELLS, h: 1 }).scale).toBe(2);
    expect(alphaMaskFromRGBA(rgbaFrom(1, 1, () => false), { x: 0, y: 0, w: 2 * MESH_MAX_CELLS + 1, h: 1 }).scale).toBe(3);
  });

  it('downscaled mask dims are ceil(region / scale) and bound the long edge by the cap', () => {
    const w = 3 * MESH_MAX_CELLS; // ⇒ scale 3
    const { mask, scale } = alphaMaskFromRGBA(rgbaFrom(1, 1, () => false), { x: 0, y: 0, w, h: 10 });
    expect(scale).toBe(3);
    expect(mask.w).toBe(Math.ceil(w / 3));
    expect(mask.h).toBe(Math.ceil(10 / 3));
    expect(Math.max(mask.w, mask.h)).toBeLessThanOrEqual(MESH_MAX_CELLS);
  });

  it('a downscaled cell is opaque iff ANY contained source px is opaque (conservative SUPERSET)', () => {
    // Build a sprite whose long edge forces scale 2, with a sparse opaque pattern. Every opaque source
    // px must land in an opaque downscaled cell (the silhouette never loses opaque coverage).
    const W = 2 * MESH_MAX_CELLS; // ⇒ scale 2
    const H = 20;
    const opaque = (x: number, y: number): boolean => (x * 7 + y * 13) % 11 === 0;
    const src = rgbaFrom(W, H, opaque);
    const { mask, scale } = alphaMaskFromRGBA(src, { x: 0, y: 0, w: W, h: H });
    expect(scale).toBe(2);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (opaque(x, y)) {
          const cx = (x / scale) | 0;
          const cy = (y / scale) | 0;
          expect(mask.bits[cy * mask.w + cx], `opaque px (${x},${y}) must be covered`).toBe(1);
        }
      }
    }
  });
});
