// Frozen constants for the binary (bitmap-mask) polygon packer. Determinism is load-bearing: these
// are the SINGLE source of every tunable the mesh/nest/simplify/triangulate pipeline depends on, shared
// by the pure core and the fix worker so no value can drift between files. Nothing here is derived from
// variable/runtime data — they are literal constants (DILATE_CELLS is a pure function of its argument).
// See docs/polygon-packer-design.md § "Determinism contract / Frozen constants".

/** Opaque iff `alpha >= POLY_ALPHA_THRESHOLD`. Single comparison operator, opaque bias. */
export const POLY_ALPHA_THRESHOLD = 1;

/** The SINGLE nesting grid edge (px). Every MaskItem is extracted at this grid; there is no dual grid. */
export const ACC_CELL = 4;

/** Mask dilation in cells for a given padding. `ceil(padding / ACC_CELL)` ⇒ >= `padding` px real
 *  separation, so bleed lives in the dilated mask and the nester runs with padding:0 (no double-pad). */
export function DILATE_CELLS(padding: number): number {
  return Math.ceil(padding / ACC_CELL);
}

/** Long-edge cap (cells) for the mesh AlphaMask — bounds trace cost/memory for huge sprites. */
export const MESH_MAX_CELLS = 256;

/** Squared-px RDP epsilon (INTEGER) — compared as `cross^2 vs POLY_TOLERANCE2 * segLen2`, no float. */
export const POLY_TOLERANCE2 = 1;

/** Max outline vertices per mesh (Visvalingam count-cap). */
export const POLY_MAX_VERTS = 12;

/** Merged-hull guard: traceMesh returns null when hull area > HULL_AREA_RATIO_MAX * opaque area. */
export const HULL_AREA_RATIO_MAX = 2.0;

/** Reserved EXCLUSIVELY for the non-load-bearing area-sum sanity assertion in tests. No load-bearing
 *  decision uses a float epsilon — all geometry predicates are integer-exact. */
export const EPSILON = 1e-7;
