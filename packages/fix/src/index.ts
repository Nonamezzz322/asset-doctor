// @asset-doctor/fix — the PURE half of the Phase-2 fix: rectangle packing, geometry-only atlas repack,
// deterministic manifest emission, and findings→FixPlan translation. No pixels, no canvas, no IO — the
// worker reads/writes pixels per the Blit contract. Golden-testable against the Atlas model.

export { pack } from './pack';
export type { PackItem, Placement, PackBin, PackOptions } from './pack';
export { repackAtlases, repackAtlasesPolygon, polygonWins, scaleAtlas } from './repack';
export type { RepackOptions, PolygonRepackOptions } from './repack';
export { emitTexturePackerJson, emitSpineAtlasText } from './manifest';
// Feature 4 (pack loose assets) — PURE alpha-bbox → trim metadata; the SINGLE home of the Spine Y-flip
// (spineOffsetFrom). See docs/spritesheet-packing-design.md § 3a.
export { alphaBBox, spriteSourceSizeFrom, spineOffsetFrom } from './trim';
// Feature 4 PURE orchestrator — loose images → Atlas[] + Blit[] (reuses pack(); rotate90 always false;
// localeCompare sort == emitted manifest order; pageOfName drives per-page emit). See design § 3c.
export { packLoose } from './packLoose';
export type { PackLooseOptions, PackLooseResult } from './packLoose';
// Feature 4 PURE Spine skeleton verifier (design § 5) — reads the UNTOUCHED skeleton .json (skins ARRAY
// or legacy OBJECT; per-type resolution; path override; linkedmesh→parent) and asserts every attachment
// that needs a region resolves to one the packed atlas ships. Unrecognized shape/.skel ⇒ honest
// `unverified` (never a false 0-of-0). The worker imports this so the verifier can't drift from its test.
export { scanSkeleton, verifySpineSkeleton } from './spine-verify';
export type { RequiredRegion, SkeletonScan, SpineVerifyResult } from './spine-verify';
export { planFix } from './plan';
export type { PlanOptions } from './plan';
export { scaleAwareQuality, resolveOptions, SCALE_QUALITY_FLOOR } from './settings';
export type { EffectiveOptions, FixOverride, FixAssetKind } from './settings';
// PURE scale-tier helpers (design docs/scale-tiers-design.md §1/§2) — the loose-image analogue of
// scaleAtlas (scaleLoose), tier suffix naming, fail-closed ladder validation, the default ladder, and the
// resolution-token regex. scaleAtlas stays the atlas primitive; the worker's tier loop owns oversize +
// `.scale`. Imported by the worker so its tier geometry/names can't drift from the tested pure source.
export { scaleLoose, tieredName, validateTiers, DEFAULT_SCALE_TIERS, RESOLUTION_TOKEN } from './scale';
export type { TierValidation } from './scale';
// PURE owner-aware dedup repoint path math (design §3d) — single source of truth, imported by fix.worker
// so the meta.image repoint round-trips through @asset-doctor/parsers (no hand-rolled copy can drift).
export { dirOf, normalize, resolveImageRef, relativeImageRef } from './dedup-repoint';
// PURE owner-aware dedup EXECUTION helpers (design §3d / §10.8): the rename rule + the Phase-A owner
// final-name prediction (the two-phase contract's first phase). Single source of truth for the worker's
// dangling-reference guard — the worker and its Node round-trip test both import these (no re-implementation).
export { EXT, renamedTo, predictOwnerFinalNames, isOwnerAwareDrop } from './dedup-exec';
export type { OwnerFinalName, OwnerPlanInput } from './dedup-exec';

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
