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

/** Coarse visual content class for format-suitability, measured from a 9×8 RGBA sample
 *  (grayStdDev band + alpha-pole histogram). Drives the lossy-vs-lossless VERDICT in analysis and
 *  the Pro transcode lossless flag in the fix engine. 'unknown' ⇒ undecoded ⇒ today's lossy path. */
export type ContentClass = 'flat' | 'alpha-art' | 'photographic' | 'unknown';

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

/* ── Config-driven export profile (round7-export-profile.md §2) ────────────────────────────────
 * v1 generalizes the fix engine's single hardcoded target/quality + closed tier ladder into a
 * config-driven { resolutions × formats × per-format compression } profile. ADDITIVE on FixOptions:
 * ABSENT ⇒ output byte-identical to today; a single-format profile ⇒ legacy file names. When present
 * it is the SOLE source of formats + resolutions + per-format compression for the loose-transcode /
 * loose-resize / tier (reference-changing) paths only; repack/merge sheets (lossless WebP) + Spine
 * pages (PNG) keep their runtime-safe formats. Deterministic — every number is finite/integer, no
 * Date.now / Math.random anywhere. Honest browser subset only (see ExportFormat). */

/** Honest browser subset only: png | webp | avif. NO jpeg (no alpha — wrong for game atlases), NO
 *  pngquant (lossy-PNG quantization is native-only). All three encode via OffscreenCanvas + lazy
 *  @jsquash WASM (no native libs), matching encodeCanvas. */
export type ExportFormat = 'image/png' | 'image/webp' | 'image/avif';

/** One emit target inside a profile. `quality` 0..100 governs LOSSY encodes (webp/avif); it is
 *  ignored when `lossless` is set or for png (native lossless). `lossless`: webp → @jsquash lossless;
 *  png → native (+ oxipng when pngRecompressLevel is set); AVIF lossless is REJECTED by validateProfile
 *  (no honest @jsquash lossless-avif path — never a faked-lossless, invariant 3). `near` (webp only)
 *  0..100 maps to @jsquash near_lossless; 100/omit ⇒ off; ignored for non-webp. */
export interface FormatTarget {
  format: ExportFormat;
  /** 0..100; omit ⇒ profile default 85. Ignored when `lossless` or for png. */
  quality?: number;
  /** webp/png only; REJECTED for avif (no faked-lossless). */
  lossless?: boolean;
  /** webp near-lossless 0..100 (100/omit ⇒ off). Ignored for non-webp. */
  near?: number;
  /** PNG ONLY (round13-pngquant-backend.md): route this PNG target through the OPT-IN pngquant backend
   *  (lossy-indexed re-compression). DISK-ONLY — a quantized PNG still decodes to full RGBA8888 on the GPU
   *  ⇒ ZERO footprint/VRAM change (vramCeiling stays raster w·h·4, invariant 5). The win is a SMALLER
   *  DOWNLOAD, never a GPU win. validateProfile MUST reject it on any non-png format AND must split the PNG
   *  dup-target key (`image/png|lossy` vs `image/png`) so a lossless+lossy PNG pair is not a false dupTarget
   *  (B2). Backend OFF/declined/quality-floor ⇒ the worker emits a lossless PNG instead (honest fallback).
   *  Omit/false ⇒ ordinary (native lossless) PNG, byte-identical to today. */
  pngLossy?: boolean;
}

/** One resolution rung of a profile. `label` is presentation-only; `suffix` is the on-disk
 *  RESOLUTION_TOKEN (the scale-tier suffix). Structurally a ScaleTier + label — the worker derives
 *  ScaleTier[] by dropping `label` (tiersOf). `scale` ∈ (0,1] (1 = full source; NEVER upscale). */
export interface ResolutionTier {
  label: string;
  scale: number;
  suffix: string;
}

/** Config-driven export profile (v1). ADDITIVE on FixOptions — ABSENT ⇒ byte-identical to today.
 *  When present it REPLACES the single targetMime + closed ladder for the loose-transcode /
 *  loose-resize / tier (reference-changing) paths only. Repack/merge sheets + Spine pages keep their
 *  runtime-safe formats. Validated fail-closed (validateProfile): ≥1 format, ≥1 tier with a scale===1
 *  top, no lossless-AVIF, valid suffix tokens, no duplicate targets. Deterministic. */
export interface ExportProfile {
  /** ≥1; emits one file per (format × tier) per eligible asset. */
  formats: FormatTarget[];
  /** ≥1; MUST include exactly one scale===1 top tier (validateTiers). */
  tiers: ResolutionTier[];
  /** Encoder effort 0..6, all formats. Omit ⇒ 0 (native fast-path). */
  effort?: number;
  /** Lossless PNG recompress via @jsquash/oxipng level 0..6 on png emits. Omit ⇒ off. */
  pngRecompressLevel?: number;
  /** AVIF chroma subsample integer (3 = YUV444). Omit ⇒ @jsquash default. (UI stays gated.) */
  avifSubsample?: number;
  /** AVIF alpha quality (qualityAlpha). Omit ⇒ -1. */
  avifQualityAlpha?: number;
  /** Scale-aware quality (lower q on downscaled output). Pure deterministic formula. Omit ⇒ off. */
  scaleAwareQuality?: boolean;
  /** ADDITIVE per-folder/prefix/type overrides (round10-profile-overrides.md). Absent/empty ⇒ identical
   *  to a no-override profile run (the resolver returns the base BY REFERENCE on no match). Validated
   *  fail-closed alongside the base (validateProfile). */
  overrides?: ProfileOverride[];
}

/** One per-folder/prefix/type override on the export profile (round10-profile-overrides.md). ADDITIVE: an
 *  absent or empty overrides[] ⇒ the resolver returns the base profile unchanged ⇒ byte-identical to a
 *  no-override run; the profile itself absent ⇒ byte-identical to pre-round7 (the worker's profile branch
 *  is profileOn-gated). `match` reuses the EXISTING dir-aware predicate (overrideMatches, settings.ts):
 *  case-SENSITIVE exact ref, dir-prefix `<m>/...`, or a `type:spine|type:pixi|type:loose` pseudo-key —
 *  NOT a glob, NOT a bare substring (so `fonts` never matches `fonts2`). Match is on the dir-aware ingest
 *  key (keyOf), not a basename. Precedence: LATER matching entry wins, field-by-field (mirrors
 *  resolveOptions' fold — NOT most-specific). Fields are a SUBSET; omitted fields fall through from the
 *  base profile. */
export interface ProfileOverride {
  /** Dir prefix ("fonts" | "ui/buttons"), exact ref, or 'type:spine'|'type:pixi'|'type:loose'. Case-sensitive. */
  match: string;
  /** REPLACE the whole format list for matching refs (atomic; e.g. fonts → [{format:'image/avif'}]).
   *  Omit ⇒ keep base profile.formats. Validated EXACTLY like profile.formats (≥1, valid, no lossless-avif,
   *  no dup target) via the shared validateFormatList. */
  formats?: FormatTarget[];
  /** Overlay the lossy quality (0..100) onto EVERY non-png/non-lossless format of the matching refs. */
  quality?: number;
  /** Overlay webp near-lossless (0..100; 100/omit ⇒ off) onto matching refs' webp targets only. */
  near?: number;
  /** Force matching refs to lossless where honest (webp/png); IGNORED for avif (no faked-lossless). */
  lossless?: boolean;
  /** Merge encoder effort (0..6) onto the running profile-global for matching refs. */
  effort?: number;
  /** The fonts→4:4:4 port: merge AVIF chroma subsample (3 = YUV444) onto the running profile-global. */
  avifSubsample?: number;
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
  | 'solid-fill'
  | 'wasted-alpha'
  // whole-folder (scope: 'folder')
  | 'duplicate-exact'
  | 'duplicate-similar'
  | 'should-atlas'
  | 'atlas-merge'
  | 'integrity-missing-image'
  | 'variants'
  | 'mipmap-cost'
  // per-atlas group: frames whose pixel REGIONS are identical within ONE atlas (redundant frames)
  | 'frame-redundancy'
  // per-atlas group: untrimmed sprites whose transparent margin (frame − opaque bbox) wastes atlas space
  | 'trim-margin';

/** Mipmap chain multiplier on base texture VRAM: a full chain adds Σ(1/4ⁿ) for n≥1 → 4/3 (+33%).
 *  The ONE place this factor lives — both the static analysis path AND the runtime probe import it
 *  and BOTH apply it CONDITIONALLY (the probe charges it per actual generateMipmap call; static
 *  surfaces it as an explicit "if mipmaps are enabled" ceiling). Never assume mipmaps are universal —
 *  that would be a guess, not a measurement (Invariant 3). */
export const MIP_OVERHEAD = 4 / 3;

/* ── Compressed (GPU-block) texture residency — HONEST CEILING model (round12) ────────────────────
 * A KTX2/block-compressed texture is NEVER charged w·h·4 and NEVER faked. Its resident VRAM is a
 * worst-case CEILING that depends on the runtime transcode target the build cannot know:
 *   - UASTC / BC7 / ASTC-4x4 = 8 bpp = 1 byte/px  ← we charge this WORST case as the headline.
 *   - A GPU that transcodes down to BC1 / ETC1 = 4 bpp = 0.5 byte/px ⇒ real residency is ≤ the charge.
 *   - A GPU with no block-compression support ⇒ raster fallback (w·h·4) — that is the raster path.
 * So the number we surface is an upper bound ("GPU VRAM ≤ …"), not asserted residency (Invariant 3 +
 * Invariant 5). Mip overhead reuses the ONE constant above (MIP_OVERHEAD = 4/3), charged ONLY when mips
 * are baked into the .ktx2 (the round12 v1 profile bakes them) — same conditional rule as the raster path. */

/** Compressed texture formats the fix path can emit. Additive: a value here NEVER changes the raster
 *  (PNG/WebP/AVIF) accounting — those keep w·h·4. Today only UASTC-supercompressed KTX2 (round12 v1). */
export type CompressedTextureFormat = 'ktx2-uastc';

/** Worst-case GPU bytes-per-pixel CEILING per compressed format (the headline VRAM charge). For
 *  'ktx2-uastc' = 1 (8 bpp = ASTC-4x4/BC7); real residency is ≤ this on GPUs that transcode to BC1/ETC1
 *  (0.5 B/px). This is a CEILING, never an exact value, never w·h·4. Raster formats are NOT keyed here —
 *  they stay on the w·h·4 (×4/3 if mipmapped) model unchanged. */
export const COMPRESSED_BYTES_PER_PX_CEILING: Record<CompressedTextureFormat, number> = {
  'ktx2-uastc': 1,
};

/** Texture footprint format used by the GPU-residency ceiling helper: the existing raster RGBA8888
 *  model ('raster' ⇒ w·h·4) OR a compressed-block ceiling (CompressedTextureFormat ⇒ ≤ bpp·w·h). */
export type TextureFootprintFormat = 'raster' | CompressedTextureFormat;

/** Highlight zones drawn on the film-viewer snapshot, in atlas pixel coords. */
export interface OverlayZone {
  kind: 'empty' | 'transparent' | 'bleeding' | 'duplicate-frame';
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
  /** Coarse visual content class from the SAME 9×8 RGBA sample as dHash (zero extra decode). Drives the
   *  lossy-vs-lossless format verdict for LOOSE images (atlases pass 'unknown'). Additive: absent/'unknown'
   *  ⇒ today's lossy path, byte-identical. */
  contentClass?: ContentClass;
  /** True iff the SAME 9×8 RGBA sample is a single color (or fully transparent) — every channel's
   *  per-sample stdDev is below SOLID_STD. Drives the loose-only `solid-fill` finding (a big solid PNG
   *  pins w×h×4 VRAM for one color). Additive: only ever SET when true; absent ⇒ today's behavior. */
  solid?: boolean;
  /** True iff a FULL-FRAME alpha scan found EVERY pixel fully opaque (alpha === 255) — i.e. the image
   *  carries an alpha channel it never uses. Drives the loose-only `wasted-alpha` finding (the dead
   *  channel costs DISK bytes, never VRAM — the GPU still allocates RGBA8888). Measured on the
   *  full-resolution decode (NOT the 9×8 sample: one transparent pixel must not average away), with a
   *  short-circuit on the first non-opaque pixel so most images bail instantly. Additive: only ever SET
   *  when true; absent (not opaque, decode skipped/failed, or no host scan) ⇒ today's behavior. */
  opaque?: boolean;
}

/** Per-atlas sprite-region hashes computed by the host (worker) from the ALREADY-DECODED atlas page, fed
 *  to analysis for the within-atlas `frame-redundancy` check (frames whose PIXEL REGIONS are identical).
 *  `atlasRef` === Atlas.name (post-merge); `frameHashes` is index-aligned to the merged atlas's sprites:
 *  entry i is the hex SHA of sprite i's region pixels, or `null` when the host SKIPPED that sprite (a flat
 *  /solid region — which would falsely cluster — or a decode/read failure). A `null` is NEVER clustered.
 *  Additive: absent (no host hashing — CLI/headless) ⇒ the frame-redundancy finding never fires ⇒
 *  byte-identical to today, gated exactly like the dHash `ImageFeatures`. */
export interface AtlasFrameHashes {
  atlasRef: string;
  frameHashes: (string | null)[];
}

/** Per-atlas sprite OPAQUE bounding boxes computed by the host (worker) from the ALREADY-DECODED atlas page
 *  (the SAME decode pass as `AtlasFrameHashes` — no second decode), fed to analysis for the within-atlas
 *  `trim-margin` check (untrimmed sprites whose transparent margin wastes atlas space). `atlasRef` ===
 *  Atlas.name (post-merge); `bboxes` is index-aligned to the merged atlas's sprites: entry i is sprite i's
 *  opaque bbox in PLACED-PAGE px (TOP-LEFT origin, RELATIVE to its frame — `{x,y}` is the inset from the
 *  frame corner), or `null` when the host SKIPPED it (an already-trimmed sprite, a fully-transparent frame —
 *  no opaque pixel — or a decode/read failure / cap). A `null` for an UNtrimmed sprite means a fully-dead
 *  frame (whole frame is recoverable margin); the rule disambiguates via `Sprite.trimmed`. Additive: absent
 *  (no host bbox pass — CLI/headless) ⇒ the trim-margin finding never fires ⇒ byte-identical to today, gated
 *  exactly like `AtlasFrameHashes`. */
export interface AtlasFrameTrims {
  atlasRef: string;
  bboxes: (TrimRect | null)[];
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

/* ── Render-probe reading (output of @asset-doctor/probe — MEASURED, not estimated) ─────────────
 * The ACTUAL GPU workload read from a real offscreen-WebGL render of an atlas: a Spector.js-style
 * GL instrument counts the issued draw calls and sums Σ w×h×4 over the textures the driver actually
 * uploaded (the +33% mip chain charged ONLY per observed generateMipmap call). This is the moat —
 * a MEASUREMENT, distinct from the static estimate. Crucially `vramBytes` here is the real DECODED
 * texture footprint (the image's true pixel dims), which DIFFERS from the static `AssetMetrics.vramBytes`
 * estimate (the atlas's DECLARED manifest size) whenever the manifest size ≠ the image's real pixels.
 * The two are different quantities measured two ways — declared vs measured — never a savings delta.
 * Lives in core (zero-dep) so AssetMetrics/AnalysisReport can carry it without core depending on probe;
 * @asset-doctor/probe re-exports this type for back-compat. Superset of these fields stays in probe's
 * GlStats (independent, untouched). */
export interface ProbeReading {
  /** Issued GL draw calls for the rendered frames (the batcher collapses N sprites → few draws). */
  drawCalls: number;
  /** Σ w×h×4 over the textures the driver actually uploaded (+33% per observed generateMipmap).
   *  The REAL decoded texture footprint — differs from the static estimate when manifest size ≠ image pixels. */
  vramBytes: number;
  /** Number of distinct base textures resident after the render. */
  liveTextures: number;
  /** texImage2D / texSubImage2D upload calls observed during the render. */
  textureUploads: number;
  /** compileShader calls observed during the render. */
  shaderCompiles: number;
}

/** MEASURED resident GPU bytes of a transcoded .ktx2 page on THE PROBING DEVICE ONLY — read from a real
 *  offscreen-WebGL render via compressedTexImage2D byteLengths (incl. baked mips, each level its own call,
 *  so the sum IS the exact residency). NOT a cross-device claim, NOT a ceiling: the GPU-chosen transcode
 *  target (BC7/ASTC/BC1/ETC1) AND whether the transcoder loaded at all both move this number, so it is
 *  labelled "on your GPU / this device only" and shown BESIDE COMPRESSED_BYTES_PER_PX_CEILING — NEVER
 *  folded into a hard vramBytesAfter (Invariant 5) or any cross-device assertion (Invariant 3).
 *  `rasterBaselineBytes` = the SAME page measured RGBA8888 (w·h·4) — the honest "before". `fallback:true`
 *  ⇒ this GPU has NO block-compression support (or the transcoder failed to load / asset 404'd) and the
 *  loader produced a raster texture ⇒ `compressedBytes === rasterBaselineBytes` and it is NOT a win on this
 *  device (reported honestly, never mis-sold). Zero-dep + ADDITIVE: a caller that never runs the probe
 *  simply omits it; mirrors `ProbeReading` (re-exported by @asset-doctor/probe for back-compat). */
export interface ProbeKtx2Reading {
  /** Σ compressedTexImage2D/compressedTexSubImage2D data byteLengths over the transcoded texture (all mip
   *  levels). The MEASURED resident compressed footprint on this GPU — NOT w·h·4, NOT a ceiling. */
  compressedBytes: number;
  /** The SAME page as RGBA8888 (w·h·4) measured in the same probe pass — the honest "before" state. */
  rasterBaselineBytes: number;
  /** True ⇒ no block-compression support on this GPU OR the transcoder failed/asset 404'd ⇒ the loader gave
   *  a raster texture ⇒ `compressedBytes === rasterBaselineBytes` ⇒ NO win on this device (disclosed). */
  fallback: boolean;
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
  /** DISPERSION of empty space, atlases only: largestEmptyRectArea / totalEmptyArea, in (0,1].
   *  1 = the waste is ONE contiguous hole; →0 = many scattered gaps. This describes the SHAPE of the
   *  waste, NOT the recoverable amount — a MaxRects repack recovers empty space regardless of how
   *  fragmented it is (it re-places sprites freely). Computed over the conservatively grid-merged empty
   *  rects, so it inherits the coverage map's under-claim. Absent when there is no empty space to map
   *  (treat as 1 = contiguous) or for loose (non-atlas) assets. */
  fragmentation?: number;
  /** MEASURED render-probe reading from a real offscreen-WebGL render of this atlas (drawCalls +
   *  actual decoded VRAM). Additive & non-blocking: filled in by the host AFTER static analysis, only
   *  on the main thread when WebGL is available; absent ⇒ byte-identical to today (no probe ran, no
   *  WebGL, or a loose non-atlas asset). NOT a second opinion on the static estimate above — it is the
   *  real GPU footprint (declared vs measured), never compared as a savings delta. */
  probe?: ProbeReading;
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
  /** Dispersion threshold (atlas fragmentation): the empty-space `fragmentation` (largest hole /
   *  total empty) at or below which the waste reads as SHREDDED. The honest copy is dispersion-AWARE
   *  (scales the "full repack, not a trim" recommendation with the measured dispersion at any frag) —
   *  it does NOT switch on this threshold today; the value is the calibration hook for a future
   *  standalone fragmentation finding. PROVISIONAL — a display/copy gate only, NOT a savings gate
   *  (a repack reclaims waste at any dispersion). Optional/additive: absent ⇒ no effect. */
  fragmentation?: { warn: number };
  /** Solid-fill (single-color loose image) gate. `minEdgePx` — both edges must be ≥ this before a
   *  solid loose image is worth flagging (a tiny solid swatch is harmless). `warnEdgePx` — at/above
   *  this edge the finding is `warn` (a 1024² solid pins 4 MB VRAM), else `info`. Optional/additive:
   *  absent ⇒ the solid-fill finding is suppressed (CLI/budget configs that don't opt in). */
  solidFill?: { minEdgePx: number; warnEdgePx: number };
  /** Wasted-alpha (a fully-opaque image still carrying an alpha channel) gate. `minEdgePx` — both edges
   *  must be ≥ this before flagging (a tiny icon's dead channel is negligible). `minDiskSaving` — the
   *  measured fraction of disk bytes that dropping the channel (re-encode opaque to the same format)
   *  must save before the finding fires (a near-zero saving isn't worth a verdict). DISK-only — invariant
   *  5: the GPU still allocates RGBA8888 regardless, so this is NEVER a VRAM win. Optional/additive:
   *  absent ⇒ the wasted-alpha finding is suppressed (CLI/budget configs that don't opt in — it is also
   *  browser-only, NOT enumerated by resolveThresholds, so the CLI never opts in). */
  wastedAlpha?: { minEdgePx: number; minDiskSaving: number };
  /** Frame-redundancy (within-atlas duplicate frames) gate. `minDuplicates` — the size a cluster of
   *  byte-identical sprite REGIONS must reach before the finding fires (a single accidental dupe pair is
   *  often a deliberate shared region; a real redundant animation set is many). Counted by DISTINCT rect
   *  so two manifest names pointing at the SAME packed rect (pre-aliased Spine/TP sheets) never inflate the
   *  count. Recoverable atlas AREA → VRAM (the duplicate regions pin sheet space); the disk number is an
   *  area-proportional ESTIMATE (no per-region disk bytes exist), the two never conflated (invariant 5).
   *  Optional/additive: absent ⇒ the frame-redundancy finding is suppressed (CLI/budget configs that don't
   *  opt in). Browser-only — NOT enumerated by resolveThresholds (mirrors solidFill/wastedAlpha). */
  frameRedundancy?: { minDuplicates: number };
  /** Trim-margin (untrimmed sprites with reclaimable transparent padding) gate. `minMarginPx` — the
   *  largest single-side transparent border (px) a sprite must carry before it counts (a 1–2px border is
   *  noise / deliberate bleed). `minRecoverablePct` — the fraction of the WHOLE atlas area the summed
   *  recoverable margin (Σ frame area − opaque bbox area over UNtrimmed qualifying sprites) must reach
   *  before the finding fires (baked-in uniform-cell padding is common and sometimes intentional, so a
   *  conservative floor keeps it from being noisy). Recoverable atlas AREA → VRAM (the padding pins sheet
   *  space a trimmed repack reclaims); the disk number is an area-proportional ESTIMATE, never conflated
   *  (invariant 5). Optional/additive: absent ⇒ the trim-margin finding is suppressed (CLI/budget configs
   *  that don't opt in). Browser-only — NOT enumerated by resolveThresholds (mirrors frameRedundancy: the
   *  worker computes the opaque bboxes off the already-decoded page; the CLI never opts in). */
  trimMargin?: { minMarginPx: number; minRecoverablePct: number };
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
    /** MEASURED aggregate over every probed atlas (render-probe). Additive & non-blocking: present only
     *  when ≥1 atlas was probed on the main thread with WebGL available; absent ⇒ byte-identical to today.
     *  Sums are pure integer addition (commutative — iteration order is not load-bearing for determinism).
     *  Honest aggregate of the moat metric, never compared as a savings delta against the static totals. */
    probe?: {
      /** Σ measured draw calls across all probed atlases. */
      drawCalls: number;
      /** Σ measured (real decoded) VRAM bytes across all probed atlases. */
      vramBytes: number;
      /** How many atlases actually yielded a probe reading (denominator for the measured aggregate). */
      atlasesProbed: number;
    };
  };
  /** The thresholds actually applied (for transparency in the UI). */
  thresholds: ThresholdConfig;
  /** Per-atlas packed frame rects, keyed by atlas.name (=== AssetMetrics.assetRef === the fileMap keyOf
   *  ref — this equality is an invariant, asserted in tests, not interchangeable by luck). Drives the
   *  host render-probe (which sprites to draw) without re-parsing manifests. Additive: absent/per-key
   *  undefined ⇒ no atlas frames to probe (loose-only folder); byte-identical to today when omitted. */
  atlasFrames?: Record<string, Rect[]>;
  /** Would-be assets the diagnosis could NOT parse — surfaced honestly instead of silently dropped
   *  (symmetric with the fix engine's skipped[]). NEVER benign non-asset files. `ref` = dir-aware key /
   *  basename / "<page>#<region>". Additive & order-stable (sorted by ref): absent/empty ⇒ byte-identical. */
  unparsed?: { ref: string; reason: string }[];
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
  | { kind: 'transcode'; assetRef: string; targetMime: ImageMime; quality: number; lossless: boolean;
      /** Drop the (here-DEAD) alpha channel before encoding to `targetMime` — the Pro fix for a
       *  `wasted-alpha` finding (a fully-opaque RGBA image whose alpha plane is constant 255). The worker
       *  composes onto a genuinely opaque `{alpha:false}` surface (the strongest signal that the encoder may
       *  omit the channel), so the emitted file is RGB/opaque. HONESTY (invariant 5): this is a DISK/download
       *  saving ONLY — the GPU still decodes to RGBA8888 and allocates the same VRAM (unless a different GPU
       *  format is chosen, which this op never does). The saving carried in the receipt is the MEASURED byte
       *  delta, never a VRAM claim. Absent/false ⇒ today's alpha-preserving transcode (byte-identical). */
      opaque?: boolean }
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
  /** Frame-redundancy aliasing (round19): the count of byte-identical frame names that were ALIASED onto a
   *  shared packed region instead of packing their own copy — every alias name still resolves in the emitted
   *  manifest, but its pixels are written ONCE (one Blit per representative). This is the count of source
   *  sprites BEYOND the one kept per byte-identical cluster (Σ over clusters of distinctRects − 1 ⇒ matches the
   *  frame-redundancy finding's `dupes`). Absent/0 ⇒ no aliasMaps were supplied ⇒ byte-identical to today. */
  aliasedFrames?: number;
  /** Trim-on-repack (round20): the count of DISTINCT packed rects (representatives) that were tightened to
   *  their opaque bounds during this repack — every untrimmed sprite carrying reclaimable transparent padding
   *  is packed at its bbox extent (smaller), with `trimmed:true` + `sourceSize` (full) + `spriteSourceSize`
   *  emitted so it renders identically in-engine. Aliases sharing a trimmed rep's rect INHERIT the rep's trim
   *  (byte-identical pixels ⇒ same bbox) but are NOT re-counted here. Absent/0 ⇒ no `trim` array was supplied
   *  or nothing was shrinkable ⇒ byte-identical to today. */
  trimmedSprites?: number;
  /** Trim-on-repack (round20): Σ over the trimmed representatives of (frame area − opaque-bbox area) — the
   *  MEASURED atlas px reclaimed by tightening untrimmed frames (exact, never the detector's "up to" estimate).
   *  Absent/0 ⇒ nothing was trimmed ⇒ byte-identical to today. */
  trimmedAreaReclaimed?: number;
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
