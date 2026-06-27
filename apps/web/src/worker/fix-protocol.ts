import type { ImageMime, LazyMarking, ScaleTier, SkinGuard } from '@asset-doctor/core';
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
  /** Multi-resolution scale-tier export (own Pro toggle, DEFAULT OFF). Each entry emits one
   *  downscaled copy of every eligible asset `<name><suffix>.<ext>` at `scale` (atlas via scaleAtlas,
   *  loose via scaleLoose). REFERENCE-CHANGING: the game's loader must select a tier at runtime ⇒ sets
   *  FixReceipt.referencesChanged. INVARIANTS (validated, fail-closed): every scale ∈ (0,1] (1.0 = the
   *  source/top tier, NEVER upscale); suffix non-empty, unique, and a RESOLUTION token groupVariants
   *  recognizes (/^[_-](\d{2,4}p|@?\d+x|hd|sd)$/i). Empty/absent ⇒ single-scale (byte-identical to today). */
  scaleTiers?: ScaleTier[];
  /** Bypass the already-tiered skip (per-asset AND whole-folder, design §8) for the rare legit case
   *  where `*_hd`/`*_2x` art should still be re-tiered. Mirrors packForced. Default false. */
  tierForce?: boolean;

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

  // ── Edge-extrude (bleed) — own Pro toggle, DEFAULT OFF (0). ──
  /** Replicate each rectangle sprite's outermost edge rows/cols into the symmetric packing gutter (px),
   *  to kill bilinear/mipmap seams in packed sheets. UI knob 0(off)/1/2. The plan sets each repack/pack
   *  op's symmetric gutter to >= extrude; the worker clamps the effective extrude to that gutter and
   *  applies it to RECTANGLE blits only (meshed/rotated blits skipped + surfaced). A symmetric gutter
   *  CAN grow a sheet to the next POT ⇒ MORE VRAM — reported honestly (extrudeVramDelta + existing
   *  vramBytes*), never claimed free (invariant 5). Absent/0 ⇒ no extrude (byte-identical to today). */
  extrude?: number;
}

export interface FixOverride {
  /** Folder prefix (dir-aware) OR pseudo-type key 'type:spine'|'type:pixi'|'type:loose'. */
  match: string;
  quality?: number;
  effort?: number;
  targetMime?: ImageMime;
  webpNearLossless?: number;
}

/** Dry-run preview vs the real run. 'plan' runs parse + analyze + planFix + the pre-loop gates, posts a
 *  `fix-plan` response (op COUNTS + would-be-skips determinable WITHOUT the compose loop + the
 *  reference-changing prediction), then STOPS before the compose/pack/repack/tier PIXEL LOOP + zip. It is
 *  NOT zero-pixel: the format-sizing encode pass + (aggressive) the dHash/SHA feature pass still run — the
 *  same pre-loop costs execute pays — to count transcodes/dedups honestly. 'execute' (the DEFAULT, today's
 *  one-click path) is byte-identical to today. Absent ⇒ 'execute'. */
export type FixMode = 'plan' | 'execute';

export type FixRequest = {
  type: 'fix';
  files: FixInputFile[];
  options: FixOptions;
  /** Dry-run preview vs commit. Absent/'execute' ⇒ byte-identical to today; 'plan' ⇒ the worker posts a
   *  `fix-plan` summary and STOPS before the compose/pack/repack/tier PIXEL LOOP + zip (the format-sizing
   *  encode + aggressive feature pass still run pre-loop, to count transcodes/dedups). */
  mode?: FixMode;
};

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
  /** Scale-tier export summary. `tiers` = validated ladder size; `assets`/`filesEmitted` count ONLY
   *  assets actually tiered (exclude already-tiered / mesh / multipage-spine / dedup-conflict skips).
   *  referencesChanged is also set. Absent ⇒ no tiering ran (byte-identical to today). */
  scaleTiered?: { tiers: number; filesEmitted: number; assets: number };
  /** Per-tier loaded VRAM (Σ w×h×4 of TIERED assets AT that tier) — the honest "VRAM if the device
   *  picks this tier" ladder. The runtime loads ONE tier, so this is NEVER summed into vramBytesAfter
   *  (invariant 5); tiering contributes 0 to vramSaved (the top tier == the source footprint). */
  tierVram?: { suffix: string; scale: number; vramBytes: number }[];
  /** Edge-extrude (bleed) summary. `extrudePx` = the requested extrude width; `extrudedBlits` = rectangle
   *  blits that got an extrude; `extrudeSkipped` = blits where extrude was REQUESTED but skipped (meshed
   *  clip / rotated — no polygon-edge extrude in v1). Descriptive only. Absent ⇒ no extrude ran. */
  extrudePx?: number;
  extrudedBlits?: number;
  extrudeSkipped?: number;
  /** HONEST VRAM delta caused by the symmetric gutter inflation pushing a sheet to the next POT
   *  (vramBytesAfter WITH the extrude gutter − the same pack WITHOUT it). POSITIVE ⇒ extrude RAISED VRAM
   *  (invariant 5: a symmetric gutter can grow a bin — never claimed free). Reported SEPARATELY; the
   *  growth is ALSO already reflected in vramBytes*. Absent/0 ⇒ no bin grew. */
  extrudeVramDelta?: number;
}

/* ── Dry-run plan preview (docs/improvements/dry-run-plan-preview.md) ─────────────────────────
 * The 'plan' mode payload. HONESTY (invariant 5): op COUNTS ONLY — NO byte/VRAM savings field exists
 * here. The format-sizing pass DID encode to count transcodes, but nothing is COMPOSED/packed/zipped
 * yet, so there is no real output footprint to report (disk ≠ VRAM; no faked numbers pre-compose). */

/** Per-kind op tally, keyed by the SAME OpKind vocabulary as the receipt change-manifest (op-manifest.ts).
 *  Counts the STRUCTURED FixOp[] the execute path would run (repack/merge split by atlasRefs.length;
 *  drop/dedup split by ownerRef; resize/transcode/pack literal) PLUS the worker-side `tier` multiplier
 *  (an upper bound — tiering can still be refused at pixel time). Zero-count kinds are OMITTED. */
export type PlanOpCounts = Partial<Record<'repack' | 'resize' | 'transcode' | 'drop' | 'merge' | 'pack' | 'dedup' | 'tier', number>>;

/** The dry-run preview the worker posts in 'plan' mode. Deterministic; carries NO pixels and — by
 *  design — NO byte/VRAM savings (counts only, until execute). */
export interface FixPlanSummary {
  /** Op tally grouped by kind (zero kinds omitted). */
  opCounts: PlanOpCounts;
  /** Σ of opCounts — total ops the execute path would run (tier counted as its upper-bound). */
  totalOps: number;
  /** Skips DETERMINABLE WITHOUT composing pixels only (e.g. multi-page Spine, already-tiered,
   *  name-collision, mesh-refusal). Pixel-dependent skips (polygon-no-win, near-dup dHash, codec-
   *  unavailable, …) are NOT predicted here — they surface only in the execute receipt. */
  skipped: { assetRef: string; reason: string }[];
  /** Conservative-true PREDICTION: would committing this plan rewrite manifest/loader references (merge /
   *  pack / owner-aware dedup / scale-tier / a loose image whose emitted ext differs)? A prediction — a
   *  PNG fallback can still resolve drop-in at execute. NO byte/VRAM claim attached. */
  referencesChanged: boolean;
  /** True ⇒ some checks are deferred to execute (pixel-dependent skips, the refs-flag caveat, the tier
   *  "up to N" upper bound). The UI surfaces this as the honesty note. */
  hasDeferredChecks: boolean;
}

export type FixResponse =
  | { type: 'fix-progress'; label: string; done: number; total: number }
  | { type: 'fix-done'; receipt: FixReceipt; zip: Blob }
  /** Dry-run preview (mode:'plan'). Additive: the execute path never emits this; fix-progress/fix-done
   *  are unchanged. */
  | { type: 'fix-plan'; summary: FixPlanSummary }
  | { type: 'fix-error'; error: string };
