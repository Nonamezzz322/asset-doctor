// @asset-doctor/fix — the PURE half of the Phase-2 fix: rectangle packing, geometry-only atlas repack,
// deterministic manifest emission, and findings→FixPlan translation. No pixels, no canvas, no IO — the
// worker reads/writes pixels per the Blit contract. Golden-testable against the Atlas model.

export { pack } from './pack';
export type { PackItem, Placement, PackBin, PackOptions } from './pack';
export { repackAtlases, repackAtlasesPolygon, polygonWins, scaleAtlas } from './repack';
export type { RepackOptions, PolygonRepackOptions } from './repack';
export { emitTexturePackerJson, emitSpineAtlasText } from './manifest';
export { planFix } from './plan';
export type { PlanOptions } from './plan';

// ── Polygon mode (Phase 2 — bitmap-mask packer) ───────────────────────────────────────────────
export { nestMasks } from './polygon-pack';
export { traceMesh, scaleMeshToFrame } from './mesh';
export type { RawMesh, MeshOptions } from './mesh';
export { traceContours, outerContourOfUnion } from './trace';
export { simplifyConservative } from './simplify';
export type { SimplifyOptions } from './simplify';
export { triangulate } from './triangulate';
export { packMaskWords, maskItemFromRGBA, alphaMaskFromRGBA } from './mask';
export type { MaskItem, AlphaMask, RGBASource, Region } from './mask';
export { signedArea2, orient, pointInTri } from './geom';
export type { IntPoint } from './geom';
// Frozen polygon constants — re-exported so the fix worker reads the SAME single source of truth as
// the pure pipeline (no value can drift between the worker and packages/fix).
export { ACC_CELL, DILATE_CELLS, EPSILON, HULL_AREA_RATIO_MAX, MESH_MAX_CELLS, POLY_ALPHA_THRESHOLD, POLY_MAX_VERTS, POLY_TOLERANCE2 } from './polygon-config';
// Re-export of the core mesh contract for convenience (repackAtlasesPolygon emits Sprite.mesh: SpriteMesh).
export type { SpriteMesh } from '@asset-doctor/core';
