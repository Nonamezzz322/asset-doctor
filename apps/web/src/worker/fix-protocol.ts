import type { ExportProfile, ImageMime, LazyMarking, OverlayZone, ScaleTier, SkinGuard } from '@asset-doctor/core';
import type { PackMode, StaticGranularity } from '@asset-doctor/ingest';
// Type-only import (erased under verbatimModuleSyntax ⇒ no runtime cycle with op-manifest, which already
// type-imports FixPlanSummary/PlanOpCounts from here). op-manifest.ts is the documented OWNER of the OpKind
// vocabulary (the closed verb set + REFERENCE_CHANGING + OP_KIND_ORDER); selective-fix reuses it verbatim.
import type { OpKind } from '../lib/op-manifest';

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
  /** Per-folder + per-type overrides (folder-prefix or type:* key) for the LEGACY (profile-OFF) loose/
   *  transcode + pack-sheet paths. Resolved in worker (resolveOptions). INDEPENDENT of the export profile's
   *  per-folder overrides (ExportProfile.overrides, round10-profile-overrides.md): when a profile is active
   *  these stay inert on the fan-out/tier paths — that fan-out is governed by ExportProfile.overrides
   *  instead. The two never both drive one ref's profile fan-out. */
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

  /** Config-driven export profile (round7-export-profile.md §2/§3). ADDITIVE: absent ⇒ byte-identical to
   *  today. When present it is the SOLE source of formats + resolutions + per-format compression for the
   *  loose-transcode / loose-resize / tier paths; SUPERSEDES the legacy targetMime + scaleTiers +
   *  webpNearLossless for THOSE paths only. Repack/merge sheets (lossless WebP) + Spine pages (PNG) are
   *  UNCHANGED. Validated fail-closed (validateProfile): ≥1 format, ≥1 tier with a scale===1 top, no
   *  lossless-AVIF, valid suffix tokens, no duplicate targets; invalid ⇒ NO emit + an honest skipped[]
   *  entry. MUTUALLY EXCLUSIVE with scaleTiers (buildOptions omits scaleTiers when a profile is sent —
   *  never both). Per-folder/prefix/type OVERRIDES (round10-profile-overrides.md) ride INSIDE this object as
   *  ExportProfile.overrides — there is NO separate wire field; buildOptions threads them through this
   *  exportProfile untouched, the worker validates them in validateProfile and resolves per-ref via
   *  resolveProfileForRef. Absent/empty overrides ⇒ byte-identical to a no-override profile run. */
  exportProfile?: ExportProfile;

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

  // ── Selective fix (docs/improvements/selective-fix.md) — let the dev deselect op categories in the
  //    dry-run Plan card and execute only the chosen subset. ──
  /** Op KINDS (OpKind, op-manifest.ts) the user DESELECTED in the Plan card → the worker SKIPS them and
   *  surfaces an honest `skipped[]` note (never a silent drop; counts/receipt reflect what actually ran).
   *  Reuses the SAME OpKind vocabulary the plan tally + receipt change-manifest key on, incl. the worker-
   *  side `tier` multiplier (gated, not a FixOp). Forwarded VERBATIM through buildOptions to BOTH plan and
   *  execute so a re-previewed plan and its committed run share the mask byte-for-byte. ADDITIVE:
   *  absent/empty ⇒ full fix, byte-identical to today (no behavior change). Deterministic (a set of OpKind;
   *  skip notes ordered by OP_KIND_ORDER). */
  excludeKinds?: OpKind[];

  // ── PixiJS-v8 asset manifest (docs/improvements/round8-pixi-manifest.md) ──
  /** Emit an additive PixiJS-v8 `manifest.json` describing every emitted variant so the game can load the
   *  whole output with one `Assets.init({ manifest })`. OPT-IN: absent/false ⇒ NO entry ⇒ zip BYTE-IDENTICAL
   *  to today (the worker's collector stays unallocated; the emit is gated on ≥1 recorded entry). Pure string
   *  work in the worker (no native libs, no network — invariant 1). Deterministic (a total re-sort, no
   *  Date.now/Math.random). A real `{ bundles:[{name,assets:[{alias,src}]}] }` and NOTHING else (no
   *  version/meta/data.resolution — Pixi #10108); multi-resolution tiers = one alias-suffixed entry per tier;
   *  sheets list the `.json`/`.atlas` sidecar; Spine still needs `pixi-spine`. Implies no saving (invariant 5
   *  — the manifest sums nothing). */
  emitPixiManifest?: boolean;
  /** Content-hash cache-busting (docs/improvements/round9-cache-busting.md). When ON, every emitted
   *  image/sheet AD references is renamed `name.<8hex>.ext` where the hash = sha256 of the FINAL emitted
   *  bytes, and EVERY referrer is repointed at the hashed name (atlas meta.image / Spine .atlas texture
   *  line / the PixiJS manifest src[] / dedup consumer meta.image / the loader-migration rows) so there is
   *  never a broken reference chain. Order: image bytes → patch imageRef → emit sidecar → hash sidecar.
   *  Carve-outs: manifest.json itself, the Spine skeleton, the dedup consumer .json name (its meta.image IS
   *  repointed), and pass-through LOOSE images unless emitPixiManifest is also on (the manifest is then the
   *  guaranteed referrer). ADDITIVE: absent/false ⇒ no hashing branch runs ⇒ zip BYTE-IDENTICAL to today. */
  hashFilenames?: boolean;
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

/** ONE loader-CALL change this fix performed (loader-migration guide, docs/improvements/loader-migration.md).
 *  `from` = the path the game's loader called BEFORE; `to` = the path(s) it must call NOW — a SET because a
 *  multi-page merge/pack sheet or a scale-tier ladder is genuinely set→set (B2/B3), never a fabricated 1:1
 *  target; `to: []` ⇒ the file was REMOVED (bare drop). Captured ONLY for events that change a real load
 *  call — merge / pack / scale-tier / a loose resize-or-transcode rename / a bare drop. DEDUP IS EXCLUDED
 *  (B1): it rewrites an AD-owned consumer manifest IN PLACE (same-named .json re-emitted with a patched
 *  meta.image, only the redundant image dropped), so the game's load call is UNCHANGED — dedup contributes
 *  ZERO rows (referencesRewritten + the fix.mergeWarn banner already cover it). `kind` is for display/
 *  grouping only (reuses the op-manifest OpKind vocabulary). HONEST (invariant 3): from/to are real paths the
 *  loader called / will call, never invented. */
export interface FixChange {
  from: string;
  /** New load target(s): [] ⇒ removed; ≥1 ⇒ the path(s) the loader must call now (>1 for a multi-page
   *  sheet/atlas or a tier ladder). */
  to: string[];
  /** Map of a TexturePacker `.json` manifest path in `to[]` → the REAL page-image path the worker wrote +
   *  recorded in that manifest's `meta.image` (e.g. `atlas-merged.webp`, NOT a `.png` guessed by ext-swap).
   *  Phaser's `this.load.atlas(key, textureURL, atlasURL)` needs the actual textureURL; Pixi reads meta.image
   *  itself so it never consults this. Present ONLY for static `.json` targets whose page image the worker
   *  knows (merge/pack); Spine `.atlas` + loose images omit it. HONEST (invariant 3): the textureURL is a
   *  real file on disk, never fabricated. */
  pageImages?: Record<string, string>;
  kind: OpKind;
}

/** Before/after X-ray of ONE repacked/merged/packed/Spine-repacked sheet (round6-f1-sheet-diff.md).
 *  Carries the encoded source + emitted page bytes (transferred to the main thread) so the receipt can
 *  show two FilmViewers per sheet — the trust proof for a paid repack. HONESTY (invariant 5): occ/VRAM/
 *  dims are TWO MEASURED STATES (`before → after`), NEVER a "% saved" — the receipt's vramBytesAfter is
 *  the SOLE saving claim. `afterZones` glows the after-film's still-empty space (a wasted-regions
 *  overlay). `occBefore = 0` for a `pack` page (loose has no source atlas — honest "0% packed"). */
export interface SheetDiff {
  name: string;
  beforeBytes: ArrayBuffer;
  afterBytes: ArrayBuffer;
  beforeWxH: { w: number; h: number };
  afterWxH: { w: number; h: number };
  /** Packed-area fraction 0..1 (occBefore = 0 for a pack page — loose has no source atlas). */
  occBefore: number;
  occAfter: number;
  /** Base GPU footprint w·h·4 (bytes) — two measured states, never a delta claim. */
  vramBefore: number;
  vramAfter: number;
  /** [] or one { kind:'empty', rects } — the after-film's still-empty space (no cast; feeds Finding.overlay). */
  afterZones: OverlayZone[];
}

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
  /** Loader-migration guide (additive, optional; docs/improvements/loader-migration.md): the concrete
   *  loader-CALL rewrites this run made, so the UI can list real repointings + emit engine-aware
   *  (Pixi/Phaser) loader snippets. Emitted ONLY on referencesChanged runs that have ≥1 genuine load-call
   *  change; DEDUP IS EXCLUDED (B1 — manifest rewritten in place, no load-call change). Deterministic
   *  (OP_KIND_ORDER then from). Absent ⇒ no guide; drop-in / no-op runs omit it ⇒ receipt byte-identical to
   *  today. */
  changes?: FixChange[];
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
  /** Config-driven export-profile summary (round7-export-profile.md §3). `formats`/`tiers` = the
   *  VALIDATED counts; `assets` = assets fanned out; `filesEmitted` = total variant files (Σ assets ×
   *  emitted formats × tiers). Present whenever a VALID profile ran — INCLUDING assets=0 (an explicit
   *  profile request always reports what it produced; finding [0]). Absent only when no valid profile ran
   *  (byte-identical to today). The per-tier VRAM ladder is STILL `tierVram` (never summed; invariant 5);
   *  format fan-out adds DISK only — the runtime loads ONE format × ONE tier — so it contributes 0 to
   *  vramBytesAfter. */
  exportProfile?: { formats: number; tiers: number; assets: number; filesEmitted: number };
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
  /** Before/after X-ray of the repacked/merged/packed/Spine-repacked sheets, capped at the first N=6
   *  composed (≤8 MB/side). `sheetDiffsTotal` = how many were composed in all, so the UI can say
   *  "showing N of M". The bytes are transferred to the main thread. Additive: empty ⇒ both omitted ⇒
   *  receipt byte-identical to today. */
  sheetDiffs?: SheetDiff[];
  sheetDiffsTotal?: number;
  /** Additive PixiJS-v8 manifest summary (round8-pixi-manifest.md): emitted ONLY when the opt-in ran with
   *  ≥1 logical entry. `assets` = logical entries listed (one per resolution tier); `path` = the manifest's
   *  zip-entry name (`manifest.json`, or a collision-avoiding fallback). Absent ⇒ no manifest emitted ⇒
   *  receipt byte-identical to today. Names/structure only — sums no saving (invariant 5). */
  pixiManifest?: { assets: number; path: string };
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
