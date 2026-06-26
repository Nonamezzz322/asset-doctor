Every contested fact is confirmed. The most important realization, which reshapes the entire design: **the compose loop does full-rect `drawImage`, so any nesting that lets bounding boxes overlap will corrupt sprites.** This means silhouette nesting CANNOT yield a packing win while keeping the compose loop unchanged. The skeptics' "Option B" is correct — and on already-trimmed atlases the rectangle-nesting win is marginal.

This forces a decisive architectural pivot. I'll commit to making the compose loop **mesh-aware (per-triangle clip)** so interlocking is actually safe and the win is real — OR scope the packing claim honestly. Given the user's explicit end-to-end scope and "the win must be measurable" invariant, I'll choose the version that is correct and shippable: **mesh-clipped compose enabling true interlock**, with a single-grid nester, integer-exact predicates, rotated-source skip, parser symmetry, and honest gating. Here is the final plan.

---

# Binary (Bitmap-Mask) Polygon Packer — FINAL Implementation-Ready Design

**Status:** Final. Every skeptic blocker and major is resolved below or explicitly rebutted with justification. Verified against repo HEAD (`packages/core/src/index.ts`, `packages/fix/src/{pack,repack,manifest}.ts`, `apps/web/src/worker/fix.worker.ts`, `apps/web/src/worker/fix-protocol.ts`, `apps/web/src/lib/fix-client.ts`, `apps/web/src/App.tsx`, `packages/fix/test/fix.test.ts`, `packages/parsers/src/*`, `fixtures/sample-projects/tp-hash-symbols/symbols.json`).

---

## TL;DR

- **Algorithm: bitmap/binary-mask occupancy nesting** on a single fixed-pixel grid, bottom-left-fill with a bit-packed `Uint32Array` accumulator and integer-only tie-breaks. NFP is rejected (its genetic optimizer + float ClipperLib geometry are non-deterministic and ~5 min slow — both fatal here).
- **Headline data-flow:** worker extracts ONE `getImageData` per sprite → derives a conservative `MaskItem` (nesting) + a capped `AlphaMask` (mesh), both plain `Uint8Array`; pure `packages/fix` does nest → trace → simplify → triangulate → build `Atlas[]` + `Blit[]` carrying `Sprite.mesh`; worker composes the sheet **per-triangle-clipped** (NOT full-rect), encodes, emits a manifest with additive polygon keys that the parser reads back symmetrically.
- **The cardinal fix:** the win from interlocking silhouettes REQUIRES bounding boxes to overlap, which the current full-rect `drawImage` compose would corrupt. So **the compose loop becomes mesh-aware** (clip each blit to its mesh triangles when `Blit.clip` is present). This is the one real worker change; without it there is no honest packing win on trimmed art.
- **Headline risk:** the measurable win is concentrated in *concave/diagonal* sprites; on already-trimmed rectangular art (4/5 of the calibration fixture) polygon mode correctly degrades to a **measured no-op** via a VRAM/POT-bin-gated fallback that emits no mesh and claims no saving. We prove the win on a purpose-built concave fixture before shipping (Task 0).
- **Determinism & honesty:** all simplify/triangulate decisions use **exact integer predicates** (no float epsilon in load-bearing paths); the "win" is gated on a **measurable POT-bin/VRAM delta**, never intra-bin area; every per-sprite/per-atlas fallback is recorded in `skipped[]`.

---

## Algorithm decision (final)

**Bitmap / binary-mask occupancy nesting. NFP rejected.** Unchanged from the draft and reinforced by the skeptics — nobody contested it. The decisive axes:

| Axis | Bitmap-mask nesting | No-Fit-Polygon (SVGnest/deepnest) |
|---|---|---|
| Determinism (inv. 3) | Integer bit-AND on a fixed grid + fixed sort + integer BL tie-break → byte-identical | GA (RNG/population) + float ClipperLib NFP — non-deterministic by construction. **Fatal.** |
| Worker-safety (inv. 2) | Core consumes plain `Uint8Array`; zero browser deps; Vitest-able | Contour-trace + polygon-clip + GA — determinism hazards |
| Perf (inv. 4, ≤10s) | Tens of ms–low seconds for ~200 sprites; dwarfed by encode | README: ~5 min to rival commercial tools. **Fatal.** |
| Deps/effort | Zero new deps; reuses `pack.ts` helpers | ClipperLib + simplifier; fragile concave NFP |

**Two decoupled geometries (final, but now correctly coupled to compose):**
- **(A) Packing win** — comes from the nester placing sprites tighter by interlocking silhouettes. This is now **only realizable because compose is mesh-clipped** (see Worker integration). On a sprite with no usable mesh, nesting reduces to rectangle packing and the fallback gate fires.
- **(B) Mesh decoration** — `vertices`/`verticesUV`/`triangles` emitted additively so an engine MAY cut overdraw. Also the **clip geometry** the worker uses to make (A) safe. The mesh is therefore load-bearing for interlock, not merely decorative.

---

## Core contract additions (final exact TypeScript)

Additive only. Absent `mesh` ⇒ byte-identical to today. This is the one cross-package (`core`) schema change and is gated on human sign-off (OPEN QUESTION 1).

```ts
/* ── Sprite mesh (Phase 2 polygon mode — additive, TexturePacker-compatible) ──────────────
 * A tight outline + triangulation an engine MAY consume to cut overdraw, AND the clip geometry
 * the fix worker uses to compose interlocked sprites without corrupting neighbors. The rectangle
 * `frame` + metadata remain the authoritative default render path. Absent ⇒ a pure rectangle
 * sprite (today's behavior). All coordinates are INTEGER pixels (no float ever enters here). */
export interface SpriteMesh {
  /** Outline in TRIMMED-SPRITE-LOCAL pixel space: origin = top-left of the frame region, Y-DOWN,
   *  positive (CCW under the Y-down shoelace convention, see Determinism §). Repack-INVARIANT —
   *  copied verbatim on re-placement. Length >= 3; no two consecutive coincident; no collinear triple. */
  vertices: Vec2[];
  /** Same points in PACKED-ATLAS pixel space (NOT normalized). For an unrotated frame:
   *  verticesUV[i] = vertices[i] + (frame.x, frame.y). RECOMPUTED on every re-placement from the
   *  FINAL per-bin frame.xy — never carried from the source. Same length & order as `vertices`. */
  verticesUV: Vec2[];
  /** Index triplets into BOTH vertices and verticesUV (same ordering). Each length 3. Positive
   *  (CCW) winding, emitted in triangulation order. Length === 3*(vertices.length - 2). */
  triangles: number[][];
}

export interface Sprite {
  name: string;
  frame: Rect;
  rotated: boolean;
  trimmed: boolean;
  sourceSize: Size;
  spriteSourceSize?: Rect;
  pivot?: Vec2;
  /** Optional tight mesh (polygon mode). Additive; absent ⇒ rectangle-only sprite. */
  mesh?: SpriteMesh;          // ← ONLY ADDITION TO Sprite
}
```

**`Blit` extension (final) — the compose contract gains an optional clip path:**

```ts
export interface Blit {
  name: string;
  from: { atlasRef: string; rect: Rect; rotated: boolean };
  to: Rect;
  rotate90: boolean;
  /** OPTIONAL clip polygon in DESTINATION atlas pixel space (= the new sprite's verticesUV). When
   *  present the worker MUST clip the drawImage to this polygon so an interlocked neighbor's
   *  bounding box can overlap this one's transparent margin without overwriting opaque pixels.
   *  Absent ⇒ full-rect blit (today's behavior, unchanged). */
  clip?: Vec2[];
}
```

**Coordinate-space contract (frozen):**
- `vertices`: trimmed-local, Y-down, integer px. Excludes `spriteSourceSize` offset (consumer applies at render, same as rectangle path).
- `verticesUV` (unrotated frame — the only meshed case in v1): `= vertices + (frame.x, frame.y)`, integer.
- **Winding:** positive under the **Y-down shoelace** `2A = Σ (x_i·y_{i+1} − x_{i+1}·y_i)`. One shared `signedArea2()` helper in `geom.ts` is the ONLY place this is computed; trace/simplify/triangulate all import it (resolves the winding-drift major).
- **Rotation:** meshed sprites are always `rotated:false` (output). **Source-rotated sprites (`s.rotated === true`) are NEVER meshed** (resolves the rotated-source blocker) — see Edge cases.

---

## packages/fix new files + exact signatures (final)

All pure, zero browser deps, Vitest-able in Node.

### `geom.ts` — shared integer geometry (pure, the single source of orientation truth)
```ts
import type { Vec2 } from '@asset-doctor/core';
export interface IntPoint { x: number; y: number; }
/** Y-down shoelace, returns 2*signed area as an EXACT integer (inputs are integers). >0 = CCW. */
export function signedArea2(loop: IntPoint[]): number;
/** Exact integer orientation of (a→b→c): sign of cross product. >0 left/CCW, 0 collinear, <0 right. */
export function orient(a: IntPoint, b: IntPoint, c: IntPoint): number;
/** Exact integer point-in-triangle (inclusive of edges), all integer cross products. */
export function pointInTri(p: IntPoint, a: IntPoint, b: IntPoint, c: IntPoint): boolean;
```

### `mask.ts` — mask types + word-packing (pure). **Single grid; no `resampleMask`.**
```ts
export interface MaskItem { id: string; w: number; h: number; cols: number; rows: number; bits: Uint8Array; }
export interface AlphaMask { w: number; h: number; bits: Uint8Array; } // len w*h, 1 byte/px, 1=opaque
/** Pack a MaskItem's byte-per-cell bits into 32-bit words (row-major, MSB-first) for the AND-loop. */
export function packMaskWords(m: MaskItem): { stride: number; words: Uint32Array };
```
> **`resampleMask` is deleted.** Every `MaskItem` is extracted in the worker directly at the single global grid `ACC_CELL` (`cols = ceil(w/ACC_CELL)`), so there is no dual-grid pooling. This resolves the integer-grid-phase determinism major and the dual-grid MustFix. `MaskItem.w/h` stay full-res for the emitted `Placement`; `bits` is at `ACC_CELL`.

### `trace.ts` — contour tracing (pure)
```ts
import type { AlphaMask } from './mask';
import type { IntPoint } from './geom';
/** Label 4-connected opaque islands, then walk each island's OUTER contour on the pixel-CORNER
 *  lattice via the FROZEN turn-table (see Determinism §). Holes dropped. Islands ordered by start
 *  cell (min row, then min col). Collinear runs collapsed. Empty ⇒ fully transparent. Terminates
 *  in <= 2*(w+h)*islands steps (asserted). */
export function traceContours(mask: AlphaMask): IntPoint[][];
/** Rasterize the union of given loops into a fresh AlphaMask, then trace its outer contour. Returns a
 *  hull ONLY when the union rasterizes back to exactly ONE connected loop (overlapping/touching
 *  islands); for genuinely separate islands it returns [] (no merged hull). v1 NOTE: the loops are
 *  rasterized as-traced (no dilation), so multi-island sprites with disjoint islands fall back to a
 *  rectangle (mesh=null) — see traceMesh. The branch is kept as a defensive no-op. */
export function outerContourOfUnion(loops: IntPoint[][], w: number, h: number): IntPoint[];
```

### `simplify.ts` — conservative integer-exact simplification (pure)
```ts
import type { IntPoint } from './geom';
export interface SimplifyOptions { tolerance2: number; maxVerts: number; } // tolerance2 = squared px (integer)
/** Outward-only RDP using EXACT integer cross-product distance comparison (cross^2 vs tolerance2*len2,
 *  no sqrt, no float), then an integer-exact Visvalingam count-cap (smallest |2A| first, tie→lowest
 *  index), with a conservative guard (dropped points stay on/outside the kept edge by integer orient).
 *  Normalized positive (CCW). If the cap can't be met conservatively, returns the bounding-rect quad. */
export function simplifyConservative(loop: IntPoint[], opts: SimplifyOptions): IntPoint[];
```

### `triangulate.ts` — integer-exact ear-clipping (pure)
```ts
import type { IntPoint } from './geom';
/** Deterministic ear-clipping of a simple positive (CCW) polygon. Ear test = orient()>0 AND no other
 *  vertex inside (pointInTri), all integer. Lowest-index valid ear tie-break; triangles in generation
 *  order. On stall, drops the smallest-|2A| vertex and continues. Returns index triplets. */
export function triangulate(loop: IntPoint[]): number[][];
```

### `mesh.ts` — trace→simplify→triangulate for ONE sprite (pure)
```ts
import type { Vec2 } from '@asset-doctor/core';
import type { AlphaMask } from './mask';
import type { SimplifyOptions } from './simplify';
export interface RawMesh { vertices: Vec2[]; triangles: number[][]; } // trimmed-local, NO verticesUV yet
export interface MeshOptions extends SimplifyOptions { hullAreaRatioMax: number; } // distant-island guard
/** Full mesh pipeline. Returns null (⇒ rectangle-only sprite, no mesh) when:
 *  - fully transparent, OR
 *  - <3 distinct vertices after simplify, OR
 *  - polygon area >= frame area (near-rectangular: mesh is pointless bloat), OR
 *  - hull area > hullAreaRatioMax * opaque area (mesh would waste area).
 *  v1: a sprite with multiple SEPARATE islands returns null (rectangle fallback — no merged mesh);
 *  outerContourOfUnion only yields a hull for input that already rasterizes to one connected loop.
 *  Always conservative when non-null. */
export function traceMesh(mask: AlphaMask, opts: MeshOptions): RawMesh | null;
```

### `polygon-pack.ts` — the bitmap-mask nester (pure)
```ts
import type { PackBin, PackOptions } from './pack';
import type { MaskItem } from './mask';
/** Bitmap-mask occupancy nesting at the SINGLE ACC_CELL grid. Bottom-left-fill with a per-column
 *  skyline accelerator over a bit-packed Uint32Array accumulator; overlap test = word-wise AND of
 *  the (pre-shifted) mask rows vs accumulator rows, first nonzero word = collision. Same POT/spill
 *  logic + same deterministic sort family as pack(). All placements snap to ACC_CELL ⇒ frame.x/y are
 *  integer multiples of ACC_CELL. v1 rotated always false. */
export function nestMasks(items: MaskItem[], opts: PackOptions): PackBin[];
```
- **Reuses** `potsUpTo` + a new exported `binCandidates(totalMaskArea, maxDim, minDim, maxSize)` helper extracted from `pack.ts`'s `fitOneBin` (small refactor, Task 7a).
- **Sort:** `maskCellCount desc → bbox(w*h) desc → max(w,h) desc → id.localeCompare` (total order; ids unique).
- **Bin lower bound** = Σ mask-cell area (smaller than bbox area) ⇒ may start at a smaller POT than rectangle packing — this is the win's source.

### `repack.ts` extension (pure) — the seam + the honest gate
```ts
import type { MaskItem } from './mask';
import type { RawMesh } from './mesh';
export interface PolygonRepackOptions extends RepackOptions { emitMesh: boolean; }
/** Polygon-mode repack: place via nestMasks instead of pack, attach Sprite.mesh, and set Blit.clip =
 *  verticesUV for meshed sprites. masks[i].id and meshById keys use the SAME `${atlas.name} ${sprite.name}`
 *  id repack.ts uses (NOT bare sprite.name — fixes merge-mode mis-attribution). verticesUV + Blit.clip
 *  are recomputed from the FINAL per-bin frame.xy of each placement (correct under spill/merge). */
export function repackAtlasesPolygon(
  atlases: Atlas[],
  masks: MaskItem[],
  meshById: Map<string, RawMesh>,   // key = `${atlas.name} ${sprite.name}`
  opts: PolygonRepackOptions,
): RepackResult;
/** Honest win gate. TRUE iff the polygon result is a MEASURABLE disk/VRAM improvement:
 *  poly.vramBytesAfter < rect.vramBytesAfter  (fewer/smaller POT bins). Intra-bin area is NEVER
 *  the signal (resolves the phantom-win minor + MustFix). Equal VRAM ⇒ false ⇒ rectangle, no mesh. */
export function polygonWins(poly: RepackResult, rect: RepackResult): boolean;
```
Internals: near-copy of `repackAtlases` with (1) `nestMasks(masks, …)`; (2) after building the rectangle `Sprite`, if `opts.emitMesh && meshById.has(id)`, attach `mesh` with `verticesUV = vertices.map(v => ({x:v.x+p.x, y:v.y+p.y}))` and push `clip` onto the blit. Occupancy/VRAM computed as today.

### `index.ts` exports
Add: `nestMasks`, `repackAtlasesPolygon`, `polygonWins`, `traceMesh`, `traceContours`, `outerContourOfUnion`, `simplifyConservative`, `triangulate`, `packMaskWords`, `signedArea2`, `orient`, `pointInTri`, and types `MaskItem`, `AlphaMask`, `RawMesh`, `IntPoint`, `PolygonRepackOptions`, `MeshOptions`, `SimplifyOptions`.

### `packages/parsers` — additive mesh parse-back (NEW, in the same slice)
`packages/parsers/src/atlas.ts`: when a frame entry has `vertices`/`verticesUV`/`triangles`, parse them into `Sprite.mesh` (integer arrays → `Vec2[]`/`number[][]`). Absent ⇒ no `mesh` (unchanged). This keeps the canonical `emit → parse → toEqual` round-trip intact for meshed atlases (resolves the parser-asymmetry blocker/MustFix — chosen option (a), full symmetry, not the weaker contract).

---

## Worker integration (final)

`apps/web/src/worker/fix.worker.ts`. **The one substantive change vs the draft: the compose loop becomes mesh-clip-aware.**

1. **`FixOptions` (fix-protocol.ts):** add `polygon: boolean` (default false). `planFix`/`PlanOptions` untouched — polygon is an *execution* choice read in the repack arm, not a plan decision (rebuttal stands, see skeptic table). `fix-client.ts` already forwards `options` verbatim — no change.

2. **`FixReceipt` (fix-protocol.ts):** add **OPTIONAL** `meshSprites?: number` and `polygonAreaSavedPct?: number` (optional ⇒ existing receipt literal still typechecks — resolves the "required field breaks build" major). Both are sourced from the FINAL selected `RepackResult`, counting only sprites that actually carry `mesh` ⇒ on fallback both are `0/undefined` (resolves the phantom-mesh-count major).

3. **Single extraction per sprite (impure helpers in fix.worker.ts):** draw `s.frame` region once to a throwaway `OffscreenCanvas`, one `getImageData`, derive BOTH:
   - `buildMaskItem(id, frame, data) → MaskItem` at `ACC_CELL` grid: `cols=ceil(w/ACC_CELL)`, cell opaque iff ANY source px in it has `alpha >= POLY_ALPHA_THRESHOLD` (opaque bias), then **dilate by `DILATE_CELLS` (= `ceil(padding/ACC_CELL)`, floored so real separation >= `padding` px)** so bleed lives in the mask and the nester runs with `padding:0` (no double-pad).
   - `buildAlphaMask(frame, data) → AlphaMask` at a **capped** resolution: long edge ≤ `MESH_MAX_CELLS` (256), integer scale factor, conservative outward rounding; vertices scaled back to frame px. This bounds trace cost and memory for huge sprites (resolves the AlphaMask-memory + super-linear-trace majors). Reusing the single `getImageData` resolves the duplicate-extraction major.
   - Cache `MaskItem` and `RawMesh` keyed by `${atlas.name} ${sprite.name}`, like `bitmapOf`.
   - **Skip rule:** if `s.rotated` is true, do NOT build a mesh for it (rectangle-only) and push `{ assetRef: id, reason: 'mesh skipped: source sprite is rotated' }` to `skipped[]` (honest, not silent).

4. **Repack branch rewrite (`op.kind==='repack'`, non-Spine arm):**
   - If `opts.polygon`:
     - build `masks: MaskItem[]` (all sprites) + `meshById: Map` (non-rotated, non-null `traceMesh`).
     - `const poly = repackAtlasesPolygon(group, masks, meshById, { allowRotation:false, padding:0, maxSize:op.maxSize, emitMesh:true })`.
     - `const rect = repackAtlases(group, { allowRotation:false, padding:op.padding, maxSize:op.maxSize })`.
     - **Bleed-equivalence (resolves the apples-to-apples major):** the dilated mask guarantees ≥ `padding` px real separation (proven by `DILATE_CELLS = ceil(padding/ACC_CELL)` ⇒ ≥ `padding` px), so the two results carry the SAME bleed budget. A Task-11 test asserts that on a fully-rectangular fixture `poly` and `rect` produce **identical bin sizes** (no phantom padding win).
     - **Gate:** `const r = polygonWins(poly, rect) ? poly : rect;`. If `r === rect`, push `{ assetRef:id, reason:'polygon mode: no measurable VRAM win, used rectangle packing' }` to `skipped[]` per affected atlas (honest fallback surfacing — resolves the skip-honesty minor).
   - Else: today's `repackAtlases(group, …)` path, untouched.
   - **Compose loop change (the cardinal fix):** in the per-blit draw, if `blit.clip` is present, clip before drawing:
     ```
     c2d.save();
     c2d.beginPath();
     c2d.moveTo(clip[0].x, clip[0].y);
     for (const p of clip.slice(1)) c2d.lineTo(p.x, p.y);
     c2d.closePath();
     c2d.clip();
     c2d.drawImage(bmp, from.rect…, to…);   // unchanged args
     c2d.restore();
     ```
     Default `OffscreenCanvas` compositing is `source-over` (documented assumption, asserted by the pixel-survival test). With clip = the conservative (dilated→outward) `verticesUV`, opaque pixels of an interlocked neighbor are masked out of this blit's transparent margin ⇒ **no corruption, real interlock**. When `blit.clip` is absent (rectangle path or non-meshed sprite), the loop is byte-for-byte today's behavior.
   - **Spine arm:** polygon skipped in v1; if `opts.polygon`, push `{ assetRef:ref, reason:'polygon mode not supported for Spine (no mesh slot in .atlas)' }` to `skipped[]` (honest, not silent) and use rectangle repack.
   - **Merge mode:** `meshById` keyed by `${atlas.name} ${sprite.name}` ⇒ no cross-atlas name collision mis-attribution (resolves that minor). Merge may run polygon nesting too; the existing name-collision guard is unchanged.

5. **Receipt stats:** `meshSprites = Σ sprites with mesh in r.atlases`; `polygonAreaSavedPct` = measured `(vramBefore-vramAfter)/vramBefore` of the selected result (only when `r===poly`). `operations.push('repack … (polygon) → WxH')`.

---

## Manifest JSON shape (final, with example)

`emitTexturePackerJson` appends polygon keys **after** the rectangle keys, **conditional on `s.mesh`**. Absent ⇒ byte-identical to today.

Fixed key order: `frame, rotated, trimmed, [spriteSourceSize], sourceSize, [pivot], [vertices], [verticesUV], [triangles]`.

```json
"hero": {
  "frame": { "x": 12, "y": 8, "w": 64, "h": 48 },
  "rotated": false,
  "trimmed": true,
  "spriteSourceSize": { "x": 4, "y": 2, "w": 64, "h": 48 },
  "sourceSize": { "w": 72, "h": 52 },
  "vertices":    [[0,10],[24,0],[64,18],[40,48],[0,30]],
  "verticesUV":  [[12,18],[36,8],[76,26],[52,56],[12,38]],
  "triangles":   [[0,1,2],[0,2,3],[0,3,4]]
}
```
Implementation (spread after existing keys):
```ts
...(s.mesh ? {
  vertices:   s.mesh.vertices.map(p => [p.x, p.y]),
  verticesUV: s.mesh.verticesUV.map(p => [p.x, p.y]),
  triangles:  s.mesh.triangles,
} : {}),
```
All integers ⇒ identical stringification; frames stay sorted by name; no timestamps. `verticesUV` recomputed from the new per-bin `frame.xy`. `emitSpineAtlasText` is **unchanged** (no mesh in Spine v1). **Parser reads these three keys back** (parsers task) so `emit → parse → toEqual` holds for meshed atlases.

---

## UI plan (final)

`apps/web/src/App.tsx` `FixCard` — re-anchored to symbols (no line numbers).

- **State:** `const [polygon, setPolygon] = useState(false);` (next to `aggressive`).
- **Control** (mirrors the `fix.merge` `<label>`):
  ```tsx
  <label className="mt-2 flex items-center justify-center gap-1.5 font-mono text-[10px] text-ink-soft">
    <input type="checkbox" checked={polygon} onChange={(e) => setPolygon(e.target.checked)} className="accent-teal" />
    {t('fix.polygon')}
  </label>
  ```
- **Call site:** add `polygon` to the existing `runFix(files, { targetMime:'image/avif', quality:0.85, padding:2, maxSize:4096, maxEdge:2048, aggressive, polygon }, …)` literal.
- **Receipt:** when `(receipt.meshSprites ?? 0) > 0`, add a mono line `${receipt.meshSprites} sprites meshed · tighter packing` and a `t('fix.meshNote')` honest caveat: disk/VRAM rows already reflect the measured packing win; overdraw savings from the mesh are **engine-side opt-in** (Pixi/Phaser ignore the mesh unless the dev builds a `Mesh`). The "% saved" shown is the measured VRAM delta, never the silhouette-area figure (inv. 4).
- **i18n:** add `fix.polygon`, `fix.polygonHint`, `fix.meshNote` (en source + 8 locales; drift test bakes en). CLI stays EN.

---

## Determinism contract (final, exhaustive)

**Frozen constants (`packages/fix/src/polygon-config.ts`, imported by both worker and core — one source per skeptic):**
- `POLY_ALPHA_THRESHOLD = 1` (opaque iff `alpha >= 1`).
- `ACC_CELL = 4` (px) — the SINGLE nesting grid (no `MASK_TARGET_CELLS`; the dual grid is removed).
- `DILATE_CELLS(padding) = Math.ceil(padding / ACC_CELL)` cells ⇒ ≥ `padding` px separation.
- `MESH_MAX_CELLS = 256` (long-edge cap for the mesh AlphaMask).
- `POLY_TOLERANCE2 = 1` (squared-px RDP epsilon, **integer**), `POLY_MAX_VERTS = 12`, `HULL_AREA_RATIO_MAX = 2.0`.
- `EPSILON = 1e-7` — **reserved exclusively for the non-load-bearing area-sum sanity assertion in tests.** No load-bearing decision uses a float epsilon.

**Mask extraction (worker, deterministic fn of pixels):** fixed `ceil` for grid dims; opaque bias (`>=`, single operator); fixed outward dilation. No `Date`/`Math.random`.

**Tracing — FROZEN turn-table (resolves the underspecified-walk major + MustFix).** Square/corner tracing on the pixel-corner lattice, 4-connected fill, with this exact state machine. Direction codes: `0=E,1=S,2=W,3=N`. At each corner we inspect the two cells diagonally ahead-left / ahead-right of the current heading; the next direction is a pure function of `(heading, leftCellOpaque, rightCellOpaque)`:

| heading | L opaque | R opaque | next |
|---|---|---|---|
| any | true | false | turn **left** (heading-1 mod 4) |
| any | false | true | turn **right** (heading+1 mod 4) |
| any | true | true | go **straight** (keep heading) |
| any | false | false | turn **right** (heading+1 mod 4) — the single frozen **saddle rule** |

Start: top-left-most opaque cell (min row, then min col), initial heading `E`. Walk until returning to start with the start heading. **Termination:** ≤ `2*(w+h)` steps per island (asserted). Islands processed in start-cell row-major order. Collinear runs collapsed by `orient()==0`. Holes dropped (only the outer loop is kept). One connectivity convention (4-connected) used uniformly. A degenerate-fixture test (checkerboard, single-pixel diagonal chain) asserts byte-identical loops across runs AND a fixed expected loop.

**Simplify (integer-exact, no sqrt):** RDP splits at the vertex with the largest integer `cross^2`; compared against `POLY_TOLERANCE2 * segLen2` (both integer). Tie → lowest index. Outward-only guard via `orient()` sign (a vertex is removable only if all dropped points are on/outside the kept edge). Visvalingam cap removes smallest `|2A|` (integer `signedArea2` of the local triangle) first, tie → lowest index, same guard. CCW-normalized via `signedArea2` sign. Cap-unmet ⇒ bounding-rect quad. **No float compare anywhere** (resolves the float-epsilon minor + MustFix).

**Triangulate (integer-exact):** ear test = `orient()>0` AND no other vertex inside via `pointInTri` (all integer). Iterate vertices in fixed index order; ambiguous ears → lowest-index valid ear; triangles in generation order. Stall → drop smallest-`|2A|` vertex and continue. Index width = `number[][]` in manifest.

**Winding:** ONE `signedArea2()` helper in `geom.ts` used by trace/simplify/triangulate ⇒ the CCW sign cannot drift between files (resolves the cross-space winding major). A test asserts every emitted polygon has positive `signedArea2` and triangulate consumes exactly that orientation.

**Nesting:** sort = `maskCellCount desc → bbox area desc → max(w,h) desc → id.localeCompare` (total order, unique ids). Candidate iteration X asc then Y asc from the skyline seed. BL tie-break = min Y then min X. Bin-candidate order = `area, then width` (matches `pack.ts`). Placements snap to `ACC_CELL` ⇒ integer `frame.x/y`. **No RNG/GA/Date/Map-iteration dependence** in load-bearing paths (collect to arrays, sort by explicit keys). A test asserts byte-identical placement across runs AND across input permutations.

**Emit:** integer vertices/UV ⇒ identical stringify; frames sorted by name; `verticesUV` recomputed from the final per-bin `frame.xy`.

---

## Edge cases & fallbacks (final)

| Case | Handling |
|---|---|
| **Source-rotated sprite (`s.rotated`)** | **NEVER meshed** (rectangle-only, no clip); recorded in `skipped[]`. Nesting uses its bbox mask. Resolves the rotated-source blocker. |
| **Fully transparent** | `traceMesh`→null; no mesh; mask ~0 area. Rectangle frame kept. |
| **Fully opaque / near-rectangular** | `traceMesh`→null (polygon area ≥ frame area). Mask==bbox ⇒ nester ties rectangles ⇒ `polygonWins`==false ⇒ global fallback to rectangle, no mesh, no claimed win. |
| **1×1 / single px** | Mask 1 cell; mesh = unit-square quad. |
| **1×N / N×1 thin line** | Valid rectangle loop; `<3 distinct verts` guard ⇒ bounding-rect quad. |
| **Islands that overlap/touch** | Already trace as ONE island ⇒ single outer contour, simplified + triangulated normally. |
| **Disconnected islands (v1, any spacing)** | `traceMesh`→null ⇒ plain rectangle frame, no merged mesh. `outerContourOfUnion` returns `[]` because the as-traced (un-dilated) loops re-trace to >1 loop. The merged-hull branch is kept as a defensive no-op; true multi-polygon meshes are deferred to v2. |
| **Donut / hole** | Outer contour only; hole stays inside (conservative overdraw). |
| **Opaque flush to all 4 edges** | Conceptual 1-cell exterior border closes the walk. |
| **Diagonal-touch / checkerboard** | 4-connected ⇒ separate islands ⇒ multi-island ⇒ v1 rectangle fallback (no merged mesh). Per-island traces stay self-intersection-free via the frozen saddle rule. |
| **Huge sprite (~2048²)** | Mesh AlphaMask capped at `MESH_MAX_CELLS`; flood-fill uses explicit stack; mask byte-packed. |
| **Padding/bleed** | Lives in dilated mask (`nestMasks` padding:0); dilation ≥ `padding` px ⇒ same bleed budget as rectangle path; tested for no phantom win. |
| **Single oversize sprite (>maxSize)** | Mirror `pack.ts`'s clamp-alone branch in `nestMasks`. |
| **Polygon loses to rectangles** | `polygonWins`==false ⇒ rectangle result, no mesh; recorded in `skipped[]`. Always a measured improvement or an honest no-op. |
| **Interlock vs compose** | Compose clips each meshed blit to `Blit.clip` (conservative `verticesUV`) under source-over ⇒ overlapping bounding boxes are safe; pixel-survival test proves every opaque texel survives. Resolves the cardinal contradiction. |
| **Spine** | Polygon skipped; recorded in `skipped[]`. |
| **Empty item list** | `nestMasks([]) → []`. |

---

## Test plan (final)

`packages/fix/test/` — synthetic `AlphaMask`/`MaskItem` fixtures built inline (no image files for the pure layer) plus the existing `tp-hash-symbols` and a NEW concave fixture.

- **(0) Win-exists proof (gates the feature):** a purpose-built concave fixture (gear/ring/diagonal-slot, several sprites) where `nestMasks` yields a strictly smaller POT bin (or higher occupancy) than `pack` on trimmed rects, and `polygonWins()===true`. Hand-checked. **If the realistic delta is <3–5%, escalate (OPEN QUESTION 4).**
- **(a) Coverage (THE invariant):** for every fixture, rasterize the output polygon (scanline) and assert it is a **superset** of the thresholded opaque mask — every opaque texel center AND its 4 corners inside-or-on the polygon. Includes far-apart-islands and deep-concavity fixtures.
- **(b) Determinism:** `traceMesh` + `repackAtlasesPolygon` + `emitTexturePackerJson` twice → byte-identical; plus `nestMasks` byte-identical across runs AND input permutations.
- **(c) Walk determinism:** checkerboard + diagonal-pixel-chain fixtures → byte-identical loops AND a fixed expected loop.
- **(d) Vertex cap:** every mesh `vertices.length ≤ POLY_MAX_VERTS`; `triangles.length === 3*(verts-2)`.
- **(e) Triangulation soundness:** Σ triangle `|2A|` == polygon `|2A|` within `EPSILON` (the only float-epsilon use); positive winding for polygon and every triangle; no zero-area/overlap.
- **(f) Back-compat (inv. 5 regression):** non-polygon emit byte-identical to current golden; `Blit.clip` absent ⇒ today's behavior.
- **(g) Round-trip symmetry (meshed):** meshed atlas `emit → parseAtlasManifest → toEqual repacked` (requires parser mesh parse-back) — keeps the repo's central golden for meshed atlases.
- **(h) Full-res FRAME overlap is ALLOWED but opaque-pixel-survival holds:** assert (1) meshed placements may have overlapping bounding boxes (interlock exists), (2) a software re-compose (rasterize each clip polygon in deterministic draw order) leaves every sprite's opaque mask intact — no opaque texel overwritten. **This replaces the old bbox-overlap-free test** (resolves the contradictory §11f). For non-meshed/rectangle placements, the existing overlap-free assertion still holds.
- **(i) Rotated-source skip:** the `sym_d` (rotated) sprite gets no mesh, no `clip`, and appears in `skipped[]`.
- **(j) No phantom padding win:** on a fully-rectangular fixture, `poly` and `rect` produce identical bin sizes and `polygonWins()===false`.
- **(k) Fallback honesty:** fully-opaque fixture ⇒ `polygonWins()===false`, selected result is rectangle, `meshSprites===0`, no mesh in emitted JSON.
- **(l) UV + spill correctness:** for a meshed sprite that spills into bin `_1`, `verticesUV[i] === vertices[i] + thatBin.frame.xy` and `Blit.clip` equals those `verticesUV`; integers; not normalized.

---

## ORDERED IMPLEMENTATION TASK BREAKDOWN

| id | title | files touched | tag | deps | acceptance check |
|---|---|---|---|---|---|
| 0 | Build concave win-proof fixture + hand-checked test | `fixtures/sample-projects/poly-concave/*`, `packages/fix/test/polygon.test.ts` | test | — | `nestMasks` POT bin strictly smaller than `pack` on the fixture; `polygonWins()===true` |
| 1 | Add `SpriteMesh` + `Sprite.mesh?` + `Blit.clip?` to core (additive) | `packages/core/src/index.ts` | core-contract | — | `pnpm typecheck` green; no consumer breaks |
| 2 | `polygon-config.ts` frozen constants | `packages/fix/src/polygon-config.ts` | pure-core | — | constants exported; no derivation from variable data |
| 3 | `geom.ts`: `signedArea2`/`orient`/`pointInTri`/`IntPoint` (integer-exact) | `packages/fix/src/geom.ts` | pure-core | — | unit test: known cross-products/areas exact |
| 4 | `mask.ts`: `MaskItem`/`AlphaMask`/`packMaskWords` (single grid, no resample) | `packages/fix/src/mask.ts` | pure-core | 2 | round-trip pack/unpack words byte-identical |
| 5 | `trace.ts`: `traceContours` (frozen turn-table) + `outerContourOfUnion` | `packages/fix/src/trace.ts` | pure-core | 3,4 | checkerboard/diagonal fixtures → fixed expected loop; terminates ≤2(w+h) |
| 6 | `simplify.ts`: `simplifyConservative` (integer-exact outward RDP + Visvalingam) | `packages/fix/src/simplify.ts` | pure-core | 3 | coverage superset + cap ≤ maxVerts; no float compare |
| 7 | `triangulate.ts`: integer-exact ear-clipping | `packages/fix/src/triangulate.ts` | pure-core | 3 | Σtri area == poly area; positive winding; stall-safe |
| 7a | Extract `binCandidates` + export `potsUpTo` from `pack.ts` | `packages/fix/src/pack.ts` | pure-core | — | existing pack tests still green |
| 8 | `mesh.ts`: `traceMesh` (merged-hull + null guards incl. hull-ratio) | `packages/fix/src/mesh.ts` | pure-core | 5,6,7 | null on transparent/near-rect/distant-island; conservative otherwise |
| 9 | `polygon-pack.ts`: `nestMasks` (single-grid skyline BL, word AND, POT/spill) | `packages/fix/src/polygon-pack.ts` | pure-core | 4,7a | overlap-free at mask level; POT bins; deterministic across permutations |
| 10 | `repack.ts`: `repackAtlasesPolygon` + `polygonWins`; recompute UV/clip per-bin; export all | `packages/fix/src/repack.ts`, `packages/fix/src/index.ts` | pure-core | 8,9 | meshed `RepackResult` with per-bin UV + `Blit.clip`; `polygonWins` VRAM-gated |
| 11 | `manifest.ts`: conditional vertices/verticesUV/triangles emit | `packages/fix/src/manifest.ts` | pure-core | 1 | no-mesh emit byte-identical to golden; meshed emit deterministic |
| 12 | parsers: additive mesh parse-back | `packages/parsers/src/atlas.ts`, `packages/parsers/src/types.ts` | core-contract | 1 | meshed `emit→parse→toEqual` round-trip green |
| 13 | Pure tests: geom/trace/simplify/triangulate/mesh coverage+determinism+cap+soundness (a–e) | `packages/fix/test/polygon.test.ts` | test | 3–8,11 | all green |
| 14 | Pure tests: nesting overlap+win+phantom-pad+fallback (b,h,j,k); UV/spill (l); round-trip (g); back-compat (f); rotated-skip (i) | `packages/fix/test/polygon.test.ts`, `fix.test.ts` | test | 9,10,11,12 | all green |
| 15 | `fix-protocol.ts`: add `polygon` to `FixOptions`; optional `meshSprites?`/`polygonAreaSavedPct?` to `FixReceipt` | `apps/web/src/worker/fix-protocol.ts` | worker | 1 | `pnpm typecheck` green; existing receipt literal still valid |
| 16 | `fix.worker.ts`: single-extraction `buildMaskItem`/`buildAlphaMask`; `traceMesh`; rotated/Spine skips; repack arm with gate; **mesh-clip compose**; receipt stats | `apps/web/src/worker/fix.worker.ts` | worker | 8,9,10,15 | polygon run on concave fixture emits mesh + smaller sheet; rectangle path unchanged; skips surfaced |
| 17 | `App.tsx` FixCard: polygon checkbox + state + call-site key; Receipt mesh line | `apps/web/src/App.tsx` | ui | 15 | toggle threads through; receipt shows meshed count honestly |
| 18 | i18n: `fix.polygon`/`fix.polygonHint`/`fix.meshNote` (en + 8 locales + drift) | `packages/i18n/**`, locale catalogs | ui | 17 | drift test green; CLI EN unaffected |

**Parallel lanes:** A(mesh) 2→3→4→5→6→7→8; B(nest) 2→4, 7a→9; C(contract+manifest+parser) 1→11, 1→12; D(worker) 15→16 (needs 8,9,10); E(UI) 15→17→18. Tests 13/14 trail their deps. **Task 0 gates Task 1** (don't change the core contract until the win is proven).

---

## How each skeptic blocker/major was resolved

| Skeptic finding | Resolution |
|---|---|
| **Compose-loop contradiction (full-rect blit corrupts interlock)** — blocker ×2 + MustFix ×2 | Compose becomes **mesh-clip-aware** via new optional `Blit.clip`; meshed blits are clipped to their conservative `verticesUV` under source-over. Interlock is now safe and real. Test (h) replaces bbox-overlap-free with **opaque-pixel-survival** + allows bbox overlap. |
| **Win unproven on calibration fixture** — blocker + MustFix | **Task 0** builds a concave fixture and hand-proves a smaller POT bin before the contract change; the gate degrades rectangular art to a measured no-op. If delta <3–5% → OPEN QUESTION 4. |
| **Rotated SOURCE sprites** — blocker ×2 + MustFix | Meshed sprites with `s.rotated===true` are **never meshed** (rectangle-only, no clip), recorded in `skipped[]`; test (i) on `sym_d`. |
| **Dual-grid determinism (MASK_TARGET_CELLS vs ACC_CELL)** — blocker + MustFix | **Single grid** `ACC_CELL=4`; `resampleMask` deleted; permutation-invariance tested. |
| **Float epsilon in load-bearing decisions** — minor + MustFix | All simplify/triangulate predicates are **integer-exact** (`cross^2`, `orient`, `pointInTri`); `EPSILON` reserved for the area-sum sanity test only. |
| **Contour walk underspecified** — major + MustFix | **Frozen turn-table** (heading × L/R opaque) + single saddle rule; termination ≤2(w+h); test (c) with fixed expected loop. |
| **Winding sign drift across files** — major + MustFix | One shared `signedArea2()` in `geom.ts`; test asserts positive winding everywhere. |
| **Merged-hull distant islands / ill-defined outward** — major + MustFix | `outerContourOfUnion` (outer boundary of dilated union, holes dropped); `HULL_AREA_RATIO_MAX` guard ⇒ null (rectangle) when hull >> opaque area; coverage tested on far-apart + deep-concavity fixtures. |
| **Phantom area win (intra-bin)** — minor + MustFix | `polygonWins` gated **only** on `vramBytesAfter` (POT-bin/VRAM delta); intra-bin area is never the signal. |
| **Padding/bleed not apples-to-apples** — major + MustFix ×2 | Dilation = `ceil(padding/ACC_CELL)` ⇒ ≥ `padding` px separation = same bleed budget; test (j) asserts identical bin sizes on rectangular fixtures. |
| **Parser asymmetry breaks round-trip** — blocker + MustFix ×2 | Chose **full symmetry**: parsers gain additive mesh parse-back (Task 12); meshed `emit→parse→toEqual` holds. |
| **Required FixReceipt field breaks build** — major + MustFix | `meshSprites?`/`polygonAreaSavedPct?` are **optional**. |
| **meshSprites from meshById vs selected result** — major + MustFix | Sourced from the **final selected `RepackResult`**; fallback ⇒ 0; test (k). |
| **verticesUV under spill/merge** — major + MustFix | Recomputed from **final per-bin frame.xy**; `meshById` keyed by `${atlas.name} ${sprite.name}`; test (l). |
| **meshByName collision in merge** — minor + MustFix | Keyed by dir-aware id, not bare name. |
| **AlphaMask memory / super-linear trace for 2048²** — major ×2 + MustFix | Mesh AlphaMask capped at `MESH_MAX_CELLS=256`; single `getImageData` builds both mask + alpha. |
| **Stale line numbers / `lossless` not in literal** — minor | Re-anchored to symbols; call-site literal updated to add `polygon` only. |
| **Spine + rotated silent skips** — minor | All fallbacks (Spine, rotated, no-win) recorded in `skipped[]`. |

**Where I disagree with a concern (explicit):**
- **Skeptic [PERF] "Option B: admit no interlock, maybe drop the feature."** I disagree that the only honest path is dropping interlock. Making compose mesh-clip-aware (one localized worker change) preserves a *real* interlock win while staying deterministic and honest. The feature earns its keep specifically on concave slot symbols (gears, rings, diagonal reels), which is exactly the asset class the product targets. I accept the *conditional* form of the concern (no win on trimmed rectangles) and resolve it with the VRAM gate + Task 0 proof — not by abandoning interlock.
- **Plan vs execution placement of the `polygon` flag.** I keep it on `FixOptions` (worker-read), NOT `FixOp`/`PlanOptions`. The plan "translates findings mechanically"; *how* a repack is packed is an execution detail, identical to how Spine/merge already branch on worker-side context rather than new op kinds. This touches fewer `core` contracts. I rebut the implied need to move it into the plan.

---

## Remaining OPEN QUESTIONS for the human (genuine product decisions)

1. **Core contract sign-off (required by CLAUDE.md).** Adding `Sprite.mesh?` + `SpriteMesh` + `Blit.clip?` to `packages/core` is the cross-package schema change requiring explicit approval before Task 1.
2. **Multi-island = rectangle fallback in v1.** As implemented, a sprite with multiple SEPARATE islands gets no mesh and uses its plain rectangle frame (the merged-hull branch only fires for islands that already trace as one connected loop, so it is a defensive no-op for disjoint islands). TexturePacker supports true multi-polygon sprites — defer real multi-island meshing to v2? (Recommend: yes; v1 = rectangle fallback for disjoint islands.)
3. **Mesh emission default.** Ship tighter packing as the headline win and always emit the mesh additively when polygon is on (cheap, harmless, honest UI note that engines must opt in)? Or make mesh a sub-toggle? (Recommend: always emit when polygon on.)
4. **Win threshold escalation.** If Task 0 shows the realistic delta on representative slot art is <3–5%, do we still ship (mesh as engine-opt-in overdraw only, packing a no-op) or defer the whole feature? This is the one genuine go/no-go.
5. **Constant tuning** (`ACC_CELL=4`, `MESH_MAX_CELLS=256`, `POLY_MAX_VERTS=12`, `POLY_TOLERANCE2=1`, `HULL_AREA_RATIO_MAX=2.0`) — frozen for determinism but should be validated on the real slot-game fixture the thresholds were calibrated on. Confirm we golden-test on that asset.
6. **Spine polygon = skipped in v1** (no mesh slot in `.atlas`; rectangle repack, surfaced in `skipped[]`). Confirm acceptable.