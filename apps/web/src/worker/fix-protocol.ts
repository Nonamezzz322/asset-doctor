import type { ImageMime, LazyMarking, SkinGuard } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';

export interface FixInputFile {
  path: string;
  name: string;
  bytes: ArrayBuffer;
}

export interface FixOptions {
  /** Preferred transcode target for loose images (falls back to WebP / skip if unavailable). */
  targetMime: ImageMime;
  quality: number;
  padding: number;
  maxSize: number;
  /** Downscale an image/atlas whose longest edge exceeds this (px). */
  maxEdge: number;
  /** Aggressive, NON-drop-in: merge under-filled atlases + drop exact/near duplicates. */
  aggressive: boolean;
  /** Polygon mode: bitmap-mask nesting + tight mesh. Execution-time choice (worker treats undefined as false). */
  polygon: boolean;

  // ── NEW (Feature 2) ──
  /** Encoder effort, ONE UI slider 0(fast)..6(max). Mapped per-codec in encodeCanvas: WebP→method(0-6),
   *  AVIF→speed(10-6, inverse: higher effort = slower/better). Default fast preset. */
  effort?: number;
  /** WebP near-lossless 0-100 (100 ⇒ off). Maps to @jsquash webp near_lossless. */
  webpNearLossless?: number;
  /** AVIF alpha quality (qualityAlpha). Omit ⇒ -1 (track quality). */
  avifQualityAlpha?: number;
  /** AVIF chroma subsample integer. FIELD ships; UI toggle GATED until Task 14 verifies 0/1/2 mapping
   *  (3=YUV444 is already confirmed in @jsquash encode.js). Omit ⇒ @jsquash default. */
  avifSubsample?: number;
  /** Lossless PNG recompress via @jsquash/oxipng level 0-6. Omit ⇒ off (no new WASM loaded). */
  pngRecompressLevel?: number;
  /** Scale-aware quality (lower q on downscaled output). Pure deterministic formula. Default false. */
  scaleAwareQuality?: boolean;
  /** UI-supplied lazy/bundle marking (Feature 3). Absent ⇒ all bundles treated as 'isolated'. */
  marking?: LazyMarking;
  /** Skin guard pairs (Feature 1): keep declared key/value skins from collapsing during dedup. */
  skinGuard?: SkinGuard;
  /** Per-folder + per-type overrides (folder-prefix or type:* key). Resolved in worker. */
  overrides?: FixOverride[];
  /** RESERVED (deferred slice): multi-resolution tiers. Empty ⇒ single-scale (today). */
  scaleTiers?: { scale: number; suffix: string }[];

  // ── Feature 4 (pack loose assets into spritesheets) — own Pro toggle, DEFAULT OFF (NOT folded under
  //    aggressive). Absent/false ⇒ no pack groups built, no pack ops, byte-identical to today. ──
  /** Pack loose images into new sheets (static TexturePacker JSON) / Spine `.atlas`. Default false.
   *  REFERENCE-CHANGING (the game must load the sheet/atlas, not the loose files) ⇒ never default-on. */
  packLoose?: boolean;
  /** Pack grouping mode: auto (spine where a skeleton is detected) | force static | force spine. */
  packMode?: PackMode;
  /** Static sheet granularity: per-leaf-folder (default) | one-sheet-for-all | per-top-level-bundle. */
  packGranularity?: StaticGranularity;
  /** Trim transparent margins before packing (→ TP spriteSourceSize / Spine offset). Default true. */
  packTrim?: boolean;
  /** Bypass the minLooseImages floor (a forced 1-region sheet is valid). Default false. */
  packForced?: boolean;
}

export interface FixOverride {
  /** Folder prefix (dir-aware) OR pseudo-type key 'type:spine'|'type:pixi'|'type:loose'. */
  match: string;
  quality?: number;
  effort?: number;
  targetMime?: ImageMime;
  webpNearLossless?: number;
}

export type FixRequest = { type: 'fix'; files: FixInputFile[]; options: FixOptions };

/** Lightweight receipt (no bytes — the optimized files live in the zip Blob). */
export interface FixReceipt {
  diskBytesBefore: number;
  diskBytesAfter: number;
  vramBytesBefore: number;
  vramBytesAfter: number;
  fileCount: number;
  changedCount: number;
  operations: string[];
  skipped: { assetRef: string; reason: string }[];
  /** True when a merge rewrote manifest references — the folder is NOT a drop-in replacement. */
  referencesChanged: boolean;
  /** Owner-aware dedup: consumer references repointed to an owner (meta.image rewrites + external). */
  referencesRewritten?: number;
  /** Whole duplicates that could NOT be safely repathed (reference may live in game code) — KEPT. */
  looseRepathSkipped?: number;
  /** DISK bytes removed by dedup drops (ALWAYS real). Separate from VRAM (invariant 5). */
  dedupDiskBytesSaved?: number;
  /** UPPER-BOUND VRAM saving from dedup: only realized if the runtime shares one GPU upload across the
   *  dropped copies. Reported separately + flagged as upper bound; never folded into a hard VRAM claim. */
  dedupVramBytesSavedUpperBound?: number;
  /** Polygon mode: count of sprites carrying a mesh in the FINAL selected result (0 on fallback). */
  meshSprites?: number;
  /** Polygon mode: measured VRAM saving (%) of the selected result, only when polygon packing won. */
  polygonAreaSavedPct?: number;
  /** Feature 4: loose images packed into new sheets/atlases. `groups` = packs performed; `sheets` =
   *  emitted page images; `regions` = total loose files folded in (now dropped). Building a sheet is
   *  reference-changing ⇒ referencesChanged is also set (NOT a blind drop-in). */
  packedSheets?: { groups: number; sheets: number; regions: number };
  /** Spine path verification result (per pack op, accumulated). `verified` = attachment paths matched
   *  to a region; `unverified` = .skel/unrecognized-skins/no-skeleton case (honest "paths not verified"). */
  packVerification?: { verified: number; unmatched: number; unverified: number };
  /** Feature 4 VRAM delta of packing (new-sheet footprint − summed loose footprint), reported SEPARATELY
   *  and NEVER folded into vramBytesAfter (invariant 5 / design §6.8). POSITIVE ⇒ packing RAISED VRAM
   *  (POT padding on NPOT loose images, the common case); the real win is fewer draw calls / texture binds.
   *  Mirrors dedupVramBytesSavedUpperBound's separate-honesty treatment. */
  packVramDelta?: number;
}

export type FixResponse =
  | { type: 'fix-progress'; label: string; done: number; total: number }
  | { type: 'fix-done'; receipt: FixReceipt; zip: Blob }
  | { type: 'fix-error'; error: string };
