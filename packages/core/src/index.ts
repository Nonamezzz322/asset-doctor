// @asset-doctor/core — shared contracts between parsers, analysis, probe and the UI.
// Single source of truth for the inter-package data model. Changing a shape here is a
// coordinated change across every consumer — do not drift package-local copies.

/* ── Geometry ─────────────────────────────────────────────────────────── */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ── Atlas model (output of @asset-doctor/parsers) ─────────────────────────
 * Fidelity rules: `frame` is the packed rect AS PLACED in the atlas image
 * (width/height swapped when `rotated`). `trimmed` / `sourceSize` /
 * `spriteSourceSize` must survive parsing — occupancy and the grid coverage map
 * depend on them. Absent source fields stay `undefined`, never fabricated. */

export type AtlasSourceKind = 'texturepacker-hash' | 'texturepacker-array' | 'pixi' | 'spine';

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
  /** Packed rectangle in the atlas image, as placed (w/h swapped if rotated). */
  frame: Rect;
  /** 90° rotation in the atlas (TexturePacker convention). */
  rotated: boolean;
  trimmed: boolean;
  /** Original, untrimmed sprite size. */
  sourceSize: Size;
  /** Trimmed-region offset/size within the source (present when trimmed). */
  spriteSourceSize?: Rect;
  pivot?: Vec2;
  /** Optional tight mesh (polygon mode). Additive; absent ⇒ rectangle-only sprite. */
  mesh?: SpriteMesh;
}

export interface Atlas {
  name: string;
  /** Relative path / handle key to the image file. Never fabricated. */
  imageRef: string;
  size: Size;
  /** e.g. 'RGBA8888' from meta.format, when present. */
  format?: string;
  scale?: number;
  sprites: Sprite[];
  source: { kind: AtlasSourceKind };
}

export type ImageMime = 'image/png' | 'image/webp' | 'image/jpeg' | 'image/avif';

export interface ImageAsset {
  name: string;
  imageRef: string;
  size: Size;
  mime: ImageMime;
  /** On-disk byte size. */
  byteSize: number;
}

export type Asset =
  | { kind: 'atlas'; atlas: Atlas; image: ImageAsset }
  | { kind: 'image'; image: ImageAsset };

/* ── Scale-tier export (multi-resolution variant generation) ──────────────────────────────────
 * One resolution tier of a scale-tier export. The worker emits one downscaled copy of every
 * eligible asset `<name><suffix>.<ext>` at `scale` (atlas via scaleAtlas, loose via scaleLoose).
 * REFERENCE-CHANGING: the game's loader must select a tier at runtime (sets referencesChanged). */

/** `scale` ∈ (0,1] (1 = full source; NEVER upscale). `suffix` is appended to the basename stem
 *  before the extension and MUST be a groupVariants resolution token (e.g. '_1080p', '@2x') so the
 *  generated tiers round-trip back into one variant cluster on re-ingest. */
export interface ScaleTier {
  scale: number;
  suffix: string;
}

/* ── Feature 4: pack loose assets into spritesheets ───────────────────────────────────────────
 * Turns OWNED loose images into ONE logical sheet (TP JSON) or ONE logical Spine atlas (.atlas,
 * N page blocks). REFERENCE-CHANGING (FixReceipt.referencesChanged): the game must load the
 * sheet/atlas, not the loose files. Geometry is pure (trim.ts + packLoose); the worker supplies
 * each region's alpha bbox. v1 never rotates a blit, so rotated/rotate is always false/0. */

/** Trimmed-content bbox of a loose image, TOP-LEFT source px coords (the worker's alpha bbox).
 *  w/h = opaque extent. Fully transparent ⇒ caller decides sentinel/skip (never zero-size region). */
export interface TrimRect { x: number; y: number; w: number; h: number; }

/** One loose image to pack. `ref` = dir-aware ingest key (keyOf). `name` = the region/frame name
 *  the sheet exposes (relative-path stem, slash-preserved). `sourceSize` = FULL untrimmed size.
 *  `trim` (optional) = worker-measured opaque bbox; absent ⇒ pack untrimmed. */
export interface LooseRegion {
  ref: string;
  name: string;
  sourceSize: Size;
  trim?: TrimRect;
}

export type PackKind = 'static' | 'spine';

/** A deterministic grouping of loose refs → ONE sheet (static) or ONE .atlas (spine).
 *  `id` = stable group key (the sheet's output dir + stem). `root` = dir all region names are
 *  relative to. `outDir` = directory the sheet/JSON/.atlas is written to (= the dir meta.image /
 *  page-image basenames resolve against). Spine groups MAY carry the skeleton ref for verification. */
export interface PackGroup {
  id: string;
  kind: PackKind;
  root: string;
  outDir: string;
  stem: string;                 // sheet basename stem (no ext); collision-checked in the worker
  regions: LooseRegion[];
  skeletonRef?: string;         // spine only: the .json/.skel ref driving verification
}

/* ── Analysis model (output of @asset-doctor/analysis, input of the UI) ──── */

export type Severity = 'crit' | 'warn' | 'ok' | 'info';

export type Rule =
  // per-asset
  | 'occupancy'
  | 'wasted-regions'
  | 'format'
  | 'dimensions-npot'
  | 'dimensions-oversize'
  // whole-folder (scope: 'folder')
  | 'duplicate-exact'
  | 'duplicate-similar'
  | 'should-atlas'
  | 'atlas-merge'
  | 'integrity-missing-image'
  | 'variants'
  | 'mipmap-cost';

/** Mipmap chain multiplier on base texture VRAM: a full chain adds Σ(1/4ⁿ) for n≥1 → 4/3 (+33%).
 *  The ONE place this factor lives — both the static analysis path AND the runtime probe import it
 *  and BOTH apply it CONDITIONALLY (the probe charges it per actual generateMipmap call; static
 *  surfaces it as an explicit "if mipmaps are enabled" ceiling). Never assume mipmaps are universal —
 *  that would be a guess, not a measurement (Invariant 3). */
export const MIP_OVERHEAD = 4 / 3;

/** Highlight zones drawn on the film-viewer snapshot, in atlas pixel coords. */
export interface OverlayZone {
  kind: 'empty' | 'transparent' | 'bleeding';
  rects: Rect[];
}

export interface FindingEstimate {
  diskBytesSaved?: number;
  vramBytesSaved?: number;
  occupancyPct?: number;
}

/** Raw interpolation values for localized rendering of a finding (numbers stay raw — the presentation
 *  layer formats bytes/percentages per locale). Strings (filenames, joined refs) are passed verbatim. */
export type FindingParams = Record<string, string | number>;

export interface Finding {
  id: string;
  rule: Rule;
  severity: Severity;
  /** 'asset' (default) for a single-asset finding, 'folder' for a whole-folder one. */
  scope?: 'asset' | 'folder';
  /** Asset this finding refers to (Atlas.name / ImageAsset.name); the primary one for folder findings. */
  assetRef: string;
  /** All assets a folder finding spans (duplicate group, merge candidates, …). */
  relatedRefs?: string[];
  /** Verdict, readout style. The baked English string — also the i18n fallback. */
  title: string;
  /** Explanation plus the proof (numbers). The baked English string. */
  detail: string;
  /** Suggested action. */
  fix?: string;
  /** Stable i18n key for this finding's template family (e.g. 'occupancy', 'should-atlas'). When set
   *  with `params`, the presentation layer renders title/detail/fix per locale; English is identical
   *  to the baked strings above. Absent → render the baked English. */
  messageKey?: string;
  /** Raw interpolation values for the localized templates. */
  params?: FindingParams;
  /** Quantified effect — only defensible numbers; leave sparse when uncertain. */
  estimate?: FindingEstimate;
  overlay?: OverlayZone[];
}

/** Per-image features computed by the host (worker) and fed to analysis for folder-level checks. */
export interface ImageFeatures {
  assetRef: string;
  /** Hex digest of the raw file bytes — exact-duplicate detection. */
  contentHash: string;
  /** 64-bit perceptual hash as 16 hex chars — near-duplicate detection. Absent if decode failed. */
  dHash?: string;
}

/* ── Bundle / lazy marking (Feature 3 — UI-sourced) ────────────────────────────────────────
 * A "bundle" is the runtime load unit. Identity: bundle(ref) = FIRST PATH SEGMENT of the dir-aware
 * ref ("main_game/ui/x.png" → "main_game"); a ref with no "/" has bundle === ref (its own singleton).
 * The UI marks each top-level bundle. Marking semantics (precise, binding for correctness):
 *   'eager'    = GLOBALLY RESIDENT: loaded before any other bundle's assets are referenced, never
 *                unloaded. Only an eager owner may serve a consumer in a different bundle.
 *   'lazy'     = resident only after its own bundle loads; load order vs other lazy bundles is unknown.
 *   'isolated' = DEFAULT for any UNMARKED bundle: treated as its own self-contained unit; may neither
 *                own across bundles nor consume across bundles. (Fail-safe: an unmarked bundle can
 *                never silently become a global owner that a lazy consumer breaks against.) */
export type BundleAvailability = 'eager' | 'lazy' | 'isolated';

/** UI-supplied marking, keyed by top-level bundle name. Absent key ⇒ 'isolated'. Pure data; flows in
 *  the FixRequest. Sub-bundle granularity and user-declared lazy load-order are future extensions. */
export type LazyMarking = Record<string, BundleAvailability>;

/* ── Dedup partition dimensions (Feature 1) ────────────────────────────────────────────────
 * A dedup may only collapse members of the SAME (pool, skinGroup) partition. */
export type DedupPool = 'spine' | 'pixi';

/** Skin/variation guard. Renamed from the rejected "AssetVariations" to avoid collision with the
 *  unrelated variants.ts model. Keeps skin "key" assets distinct from their "value" variants so a
 *  skin-switch build never loses an asset. Matched on the dir-aware ref's FILE basename (no ext) —
 *  this is AD's DELIBERATELY STRICTER rule (no general-owner fallback), NOT builder parity. */
export type SkinGuard = Record<string, string>; // { keyBasename: valueBasename }
export type SkinGroup = 'general' | 'keys' | 'values';

/* ── Owner/consumer dedup result model (whole-file only) ────────────────────────────────────
 * One DedupGroup per contentHash AFTER (pool, skinGroup) partitioning. A group may have >1 owner
 * (the lazy/isolated case: each such bundle keeps its own owner). Every consumer names exactly one
 * owner whose bundle DOMINATES the consumer's bundle (same bundle OR eager owner). */
export interface DedupConsumer {
  /** Dir-aware ref of the whole duplicate to drop. */
  ref: string;
  /** Retained ref this consumer's references repoint to. Same (pool, skinGroup) partition AND
   *  bundle(ownerRef) dominates bundle(ref). */
  ownerRef: string;
  /** Why this edge is safe — for the receipt + golden tests. */
  reason: 'same-eager-bundle' | 'eager-owner-cross-bundle' | 'same-lazy-bundle' | 'same-isolated-bundle';
}

/** One contentHash group within one (pool, skinGroup) partition. `owners` length ≥ 1. */
export interface DedupGroup {
  contentHash: string;
  pool: DedupPool;
  skinGroup: SkinGroup;
  /** Retained refs (never dropped). >1 only when members span multiple non-eager bundles. Sorted by
   *  the deterministic codepoint comparator. */
  owners: string[];
  /** Drops, each bound to one owner. Sorted by `ref` (codepoint). */
  consumers: DedupConsumer[];
}

export interface AssetMetrics {
  assetRef: string;
  diskBytes: number;
  /** BASE GPU footprint: Σ w×h×4 (RGBA8888). Disk weight ≠ VRAM. Residency without mipmaps;
   *  see vramBytesMipmapped for the conditional "if mipmapped" ceiling. */
  vramBytes: number;
  /** GPU footprint IF mipmaps are enabled: ceil(w×h×4 × 4/3). An upper bound, NOT asserted residency —
   *  static analysis cannot observe whether the engine calls generateMipmap. Pixi/Phaser make mipmaps
   *  opt-in per texture source, so this is conditional, never guaranteed. See vramBytes for the base. */
  vramBytesMipmapped: number;
  /** 0..1, atlases only. */
  occupancy?: number;
}

/** Calibrated audit thresholds. Lives in config, never hardcoded inside rules. */
export interface ThresholdConfig {
  occupancy: { warn: number; crit: number };
  oversizePx: { warn: number; crit: number };
  formatSaving: { warn: number };
  /** Fraction of the POT-padded area wasted before flagging an NPOT info finding. */
  npotPadding: { warn: number };
  /** Folder-level checks. */
  duplicates: { similarHammingMax: number };
  shouldAtlas: { minLooseImages: number; maxSpriteEdgePx: number };
  atlasMerge: { occupancyBelow: number; minAtlases: number };
  /** Total CONDITIONAL mipmap overhead (Σ vramBytesMipmapped − vramBytes) across the folder before the
   *  aggregate mipmap-cost info finding fires. Geometry only; no pixel read. Optional: absent ⇒ the
   *  mipmap-cost finding is suppressed (e.g. a budget/CLI config that doesn't opt into it). */
  mipmap?: { warn: number };
}

export interface AnalysisReport {
  assets: AssetMetrics[];
  findings: Finding[];
  totals: {
    diskBytes: number;
    /** Σ w×h×4 over every asset (variants summed — the naive footprint). */
    vramBytes: number;
    /** Σ vramBytesMipmapped — the same naive footprint IF every texture mipmaps (the +33% ceiling).
     *  Conditional, not asserted residency: static analysis cannot observe generateMipmap. */
    vramBytesMipmapped: number;
    /** Realistic upper bound: one variant per logical asset (format-deduped, highest resolution tier). */
    loadedVramBytes: number;
    /** loadedVramBytes × 4/3 — the loaded-set ceiling IF mipmaps are enabled. Conditional, not residency. */
    loadedVramBytesMipmapped: number;
    potentialDiskSaved: number;
  };
  /** The thresholds actually applied (for transparency in the UI). */
  thresholds: ThresholdConfig;
}

/* ── Fix model (Phase 2 — output of @asset-doctor/fix + the fix worker) ─────────────────────
 * The paid fix. A FixPlan is a PURE, structured-cloneable translation of MEASURED findings (never
 * invented) and NEVER carries pixel bytes. The pure packages/fix computes geometry (RepackResult +
 * Blits); the impure worker reads/writes pixels per the Blit contract and emits FixedFiles. */

/** A single optimization operation, derived mechanically from the diagnosis. */
export type FixOp =
  | { kind: 'repack'; atlasRefs: string[]; targetMime: ImageMime; pot: boolean; allowRotation: boolean; padding: number; maxSize: number;
      /** Edge-extrude (bleed) px replicated from each rect sprite's outermost rows/cols into the
       *  surrounding symmetric packing gutter, to kill bilinear/mipmap seams. The worker clamps the
       *  effective extrude to the op's symmetric gutter (effectiveExtrude = min(extrude, gutter)).
       *  Rectangle blits only — meshed/rotated blits are skipped + surfaced honestly. Absent/0 ⇒ no
       *  extrude (today's behavior, byte-identical). */
      extrude?: number }
  | { kind: 'transcode'; assetRef: string; targetMime: ImageMime; quality: number; lossless: boolean }
  | { kind: 'resize'; assetRef: string; to: Size; targetMime: ImageMime; quality: number }
  | { kind: 'drop'; assetRef: string; reason: 'duplicate-exact' | 'duplicate-similar';
      /** Owner-aware drop (Feature 1): retained ref this drop's references repoint to. Absent ⇒ legacy
       *  bare-delete (today's behavior). */
      ownerRef?: string;
      /** True when this consumer is a whole atlas image+manifest pair identical to the owner's; the
       *  worker keeps the consumer manifest, repoints meta.image → owner image, drops only the image. */
      repointManifest?: boolean;
      /** True iff owner-aware repoint is disabled for this drop (scale tiering renames the owner, so the
       *  owner's predicted name won't exist post-tier — design correction 8). Phase C MUST short-circuit
       *  to keep-consumer (surface skipped[], drop NOTHING) rather than fall through to the loose/atlas
       *  repoint branch (which would still repoint+drop against the owner's pre-tier name and dangle once
       *  the tier loop renames the owner). Absent ⇒ normal owner-aware execution. */
      keepConsumer?: boolean }
  | { kind: 'pack';
      /** ONE PackGroup → ONE sheet (static) or ONE multi-page .atlas (spine). Carries only OWNED
       *  loose refs — never a dedup consumer scheduled for drop (enforced in plan.ts). */
      group: PackGroup;
      /** Sheet image target. Spine defaults to PNG (runtime-safe); static may use WebP/AVIF. */
      targetMime: ImageMime;
      /** Trim transparent margins (→ TP spriteSourceSize / Spine offset) before packing. */
      trim: boolean;
      padding: number;
      maxSize: number;
      /** ALWAYS false in v1 — the worker compose path cannot rotate a blit (verified). Typed literal. */
      allowRotation: false;
      /** Edge-extrude (bleed) px replicated from each packed loose region's outermost rows/cols into the
       *  surrounding symmetric packing gutter, to kill bilinear/mipmap seams. Clamped in the worker to
       *  the op's gutter (effectiveExtrude = min(extrude, gutter)). Rectangle blits only. Absent/0 ⇒ no
       *  extrude (today's behavior, byte-identical). */
      extrude?: number };

export interface FixPlan {
  ops: FixOp[];
  thresholds: ThresholdConfig;
}

/** Where a sprite's pixels come from and where they land in the new sheet — the pure→impure compose
 *  contract. `rotate90` is reserved for packer-introduced rotation (v1 preserves source orientation). */
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

/** Geometry-only repack result (no pixels). `atlases` is plural to model maxSize/POT bin spill. */
export interface RepackResult {
  atlases: Atlas[];
  blits: Blit[];
  occupancyBefore: number;
  occupancyAfter: number;
  vramBytesBefore: number;
  vramBytesAfter: number;
}

/** One emitted file in the optimized download. `originalPath` drives the zip tree; `bytes` is the new
 *  content; `newName` rewrites the basename (e.g. btn.png → btn.webp). */
export interface FixedFile {
  originalPath: string;
  newName?: string;
  bytes: ArrayBuffer;
  /** Audit trail of ops applied to this file (e.g. ['repack', 'transcode webp']). */
  operations: string[];
}

/** The receipt for a whole fix run + the files to zip. disk AND vram both carried (POT-rounding can
 *  shrink one while the other moves — invariant 5); after-numbers are measured, not estimated. */
export interface FixReport {
  files: FixedFile[];
  diskBytesBefore: number;
  diskBytesAfter: number;
  vramBytesBefore: number;
  vramBytesAfter: number;
  /** Every fix the browser couldn't perform (e.g. AVIF unsupported) — surfaced, never silent. */
  skipped: { assetRef: string; reason: string }[];
}

/* ── Entitlement model (Slice B — the only thing the thin backend signs) ───────────────────────
 * The web client verifies an Entitlement OFFLINE with an embedded ed25519 public key. The token wire
 * form is `base64url(payloadJSON) + "." + base64url(sig)`; the SIGNED message is the literal first
 * segment, so there is no canonical-JSON requirement. `dev` is a client-generated random id (NOT a
 * fingerprint). Kept here so apps/web and apps/api (Go) share one source of truth for the claim shape. */
export const ENTITLEMENT_VERSION = 1;

export interface Entitlement {
  /** token version (must equal ENTITLEMENT_VERSION) */
  v: number;
  /** license key */
  lic: string;
  /** device id (opaque, client-generated random) */
  dev: string;
  /** plan, e.g. "pro" */
  plan: string;
  /** issued-at (unix seconds) */
  iat: number;
  /** expiry (unix seconds) */
  exp: number;
}
