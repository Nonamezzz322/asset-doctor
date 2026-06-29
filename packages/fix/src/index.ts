// @asset-doctor/fix — the PURE half of the Phase-2 fix: rectangle packing, geometry-only atlas repack,
// deterministic manifest emission, and findings→FixPlan translation. No pixels, no canvas, no IO — the
// worker reads/writes pixels per the Blit contract. Golden-testable against the Atlas model.

export { pack } from './pack';
export type { PackItem, Placement, PackBin, PackOptions } from './pack';
// PURE edge-extrude (bleed) geometry — the drawImage src/dst rects the worker replicates into the
// symmetric packing gutter (pack.ts OPTION A) to kill bilinear/mipmap seams. Geometry only, no canvas.
export { effectiveExtrude, canExtrude, extrudePlan } from './extrude';
export type { ExtrudeRect } from './extrude';
export { repackAtlases, repackAtlasesPolygon, polygonWins, scaleAtlas } from './repack';
export type { RepackOptions, PolygonRepackOptions } from './repack';
// Frame-redundancy aliasing (round19) — PURE byte-identical-frame clustering that mirrors the detector's
// distinct-rect logic. The worker feeds the result into repackAtlases so duplicate frames share ONE packed
// region (one Blit per representative) while EVERY original name still resolves in the emitted manifest.
export { buildAtlasAliasMap, buildAtlasAliasMaps, buildMergeAliasMap } from './alias';
export type { AtlasAliasMap, MergeAliasMap } from './alias';
export { emitTexturePackerJson, emitSpineAtlasText } from './manifest';
// PURE atlas-sidecar repoint for the prebuilt-atlas passthrough transcode (round20 #1) — re-encoding an atlas
// PAGE renames it (sheet.png → sheet.webp), so the sidecar meta.image / Spine texture line is repointed at the
// new page (relativeImageRef inverse) or it dangles. Imported by the fix worker so its repoint can't drift.
export { repointAtlasImage } from './atlas-transcode';
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
export { scaleAwareQuality, resolveOptions, SCALE_QUALITY_FLOOR, formatEncode, DEFAULT_FORMAT_QUALITY, resolveProfileForRef } from './settings';
export type { EffectiveOptions, FixOverride, FixAssetKind, FormatEncode, FormatEncodeGlobal, ProfileOverride, ResolvedProfile } from './settings';
// PURE scale-tier helpers (design docs/scale-tiers-design.md §1/§2) — the loose-image analogue of
// scaleAtlas (scaleLoose), tier suffix naming, fail-closed ladder validation, the default ladder, and the
// resolution-token regex. scaleAtlas stays the atlas primitive; the worker's tier loop owns oversize +
// `.scale`. Imported by the worker so its tier geometry/names can't drift from the tested pure source.
export { scaleLoose, tieredName, validateTiers, DEFAULT_SCALE_TIERS, RESOLUTION_TOKEN } from './scale';
export type { TierValidation } from './scale';
// PURE config-driven export-profile helpers (round7-export-profile.md §4a) — ResolutionTier→ScaleTier
// strip, fail-closed profile validation (delegates the tier axis to validateTiers), and the format-token
// naming math (single-format ⇒ legacy names; multi ⇒ format-disambiguated). Imported by the worker so its
// fan-out names/validation can't drift from the tested pure source.
export { tiersOf, validateProfile, formatToken, variantManifestName } from './scale';
export type { ProfileValidation } from './scale';
// PURE owner-aware dedup repoint path math (design §3d) — single source of truth, imported by fix.worker
// so the meta.image repoint round-trips through @asset-doctor/parsers (no hand-rolled copy can drift).
export { dirOf, normalize, resolveImageRef, relativeImageRef } from './dedup-repoint';
// PURE owner-aware dedup EXECUTION helpers (design §3d / §10.8): the rename rule + the Phase-A owner
// final-name prediction (the two-phase contract's first phase). Single source of truth for the worker's
// dangling-reference guard — the worker and its Node round-trip test both import these (no re-implementation).
export { EXT, renamedTo, predictOwnerFinalNames, isOwnerAwareDrop } from './dedup-exec';
export type { OwnerFinalName, OwnerPlanInput } from './dedup-exec';

// ── GPU-residency CEILING (round12 backend-processing §7) ──────────────────────────────────────
// PURE worst-case VRAM helper: raster ⇒ w·h·4 (today's model); KTX2/compressed ⇒ ≤ ~1 B/px CEILING
// (NEVER w·h·4, NEVER faked); mips reuse the shared MIP_OVERHEAD ×4/3, only when baked. Imported by the
// fix worker + the receipt so the honest VRAM number can't drift from this single tested source.
export { vramCeilingOfPage } from './vram-ceiling';

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

// ── PixiJS-v8 AssetsManifest (round8-pixi-manifest.md) ─────────────────────────────────────────
// PURE deterministic builder for the additive, opt-in `manifest.json` the fix output can emit so a PixiJS v8
// game loads the whole output with Assets.init({ manifest }). Emits a REAL { bundles:[{name,assets:[{alias,src}]}] }
// and NOTHING else (no version/meta, no `data.resolution` — Pixi #10108; tiers = one alias-suffixed entry each).
// hashedName is the naming primitive of content-hash cache-busting (round9-cache-busting.md), wired by the
// worker's hashFilenames option. Imported by the fix worker so its manifest can't drift from the tested source.
export { buildPixiManifest, countPixiManifestEntries, hashedName } from './pixi-manifest';
export type {
  PixiAssetsManifest,
  PixiAssetsBundle,
  PixiUnresolvedAsset,
  PixiSizedSrc,
  ManifestAsset,
  EmittedVariant,
  ManifestAssetKind,
  BuildPixiManifestOptions,
} from './pixi-manifest';

// ── Content-hash cache-busting (round9-cache-busting.md) ───────────────────────────────────────
// PURE test-double mirroring the worker's in-place `imageRef`-patch (returns a NEW atlas {...atlas, imageRef}).
// NEVER called by the worker (it owns the one in-place mutation); exists for golden-testing the reference chain
// image→imageRef→sidecar. The naming primitive `hashedName` is exported above with buildPixiManifest.
export { withHashedImageRef } from './cache-bust';
