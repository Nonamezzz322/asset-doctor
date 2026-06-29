import type {
  ExportProfile,
  ImageMime,
  LazyMarking,
  OverlayZone,
  Rect,
  ScaleTier,
  SkinGuard,
} from '@asset-doctor/core';
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
  /** Opaque-encode the Pro fix for `wasted-alpha` findings (round15): re-encode a fully-opaque image WITHOUT
   *  its dead alpha channel for a DISK/download saving. HONESTY (invariant 5): DISK-only — the GPU still
   *  decodes to RGBA8888, so this is NEVER a VRAM claim. The plan stamps `opaque:true` on the transcode op
   *  for every wasted-alpha-flagged loose ref (folded into a format transcode where one already fires, else
   *  a standalone opaque transcode); the worker composes onto an `{alpha:false}` surface and the receipt
   *  measures the real byte delta (honest skip if no win). Absent/false ⇒ no op carries `opaque` ⇒ byte-
   *  identical to today (the wasted-alpha finding stays a diagnosis-only verdict). */
  opaqueAlpha?: boolean;
  /** Per-image MEASURED best-format pick (round17-per-image-measured-best-format-pick). The diagnosis
   *  ALREADY measured the smallest real encode per loose image (formatFinding compares real encoded sizes
   *  and records the winner in `params.bestMime`). When ON, the LOOSE `format` transcode op targets that
   *  measured per-image winner (WebP vs AVIF) instead of the single global `targetMime` — the fix carries the
   *  measurement forward instead of re-guessing one format for all. HONESTY: bestMime is the MEASURED winner
   *  (invariant 3 — diagnosis measures, the fix generates); a format transcode is DISK-only (invariant 5 —
   *  both decode to RGBA8888, so it is never a VRAM claim). PRECEDENCE: this is the NON-profile default-path
   *  enhancement — an active `exportProfile` governs formats on its own (worker-gated) fan-out, and a
   *  per-folder/type `override.targetMime` still WINS (it layers on the per-image pick as the resolve base).
   *  Absent/false ⇒ every op carries `targetMime` ⇒ byte-identical to today (the fixed-target behavior). */
  bestFormatPerImage?: boolean;
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

  // ── Frame-redundancy aliasing (round19) — DEFAULT ON (drop-in, lossless, shrinks the sheet). ──
  /** Alias byte-identical animation frames within an atlas onto ONE shared packed region (round19). The
   *  diagnosis MEASURES the duplicate frames (frame-redundancy finding, hashed off the decoded page); when
   *  this is ON (the default — undefined is treated as ON) the worker pre-hashes qualifying merged atlas pages
   *  BEFORE analyze so the finding fires, the finding emits its OWN repack op (a frame-redundant atlas is
   *  usually FULLY packed ⇒ no occupancy/wasted repack would otherwise schedule it), and repackAtlases packs
   *  ONE representative per byte-identical cluster while emitting a Sprite for EACH alias name at the shared
   *  rect (its own trim/pivot preserved). DROP-IN: every original frame name still resolves; the sheet is
   *  smaller (exact VRAM before→after, no estimate). `false` ⇒ no hashing, no new op, no aliasing ⇒
   *  byte-identical to today (the finding stays a diagnosis-only verdict). */
  frameRedundancy?: boolean;

  // ── Trim-margin → repack scheduling (round21 #0) — DEFAULT ON (drop-in, lossless, shrinks the sheet). ──
  /** Schedule a repack that tightens UNtrimmed sprites to their opaque bounds (round21 #0). The diagnosis
   *  MEASURES the reclaimable transparent padding (trim-margin finding, opaque bboxes off the decoded page);
   *  when this is ON (the default — undefined is treated as ON) the worker computes those bboxes BEFORE analyze
   *  so the finding fires, and the finding emits its OWN repack op (a padded atlas is usually FULLY packed ⇒ no
   *  occupancy/wasted repack would otherwise schedule it). The trim itself runs in the existing r20 trim-on-
   *  repack execute path (buildTrimArrays → repackAtlases({trim})): each untrimmed frame is tightened to its
   *  opaque core, trimmedSprites/trimmedAreaReclaimed surface in the receipt, vramSaved is the EXACT before→after
   *  (the disk number stays an estimate — invariant 5). DROP-IN: every name still resolves (trimmed:true +
   *  spriteSourceSize). `false` ⇒ no bboxes fed, no new op, no trim ⇒ byte-identical to today (the finding stays
   *  a diagnosis-only verdict). */
  trimMargin?: boolean;

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
  /** AssetPack `includeFileSizes` parity (docs/improvements/round23-includefilesizes-progresssize-in-t.md).
   *  When set, every `src` in the emitted PixiJS manifest becomes `{ src, progressSize }` (KB, 2dp — the REAL
   *  field AssetPack 1.7.0 emits) so PixiJS shows accurate Assets.load progress. `'raw'` ⇒ uncompressed KB
   *  (final byte length /1024); `'gzip'` ⇒ REAL gzipped KB (CompressionStream over the SAME final bytes /1024).
   *  Both numbers are MEASURED from the actually-shipped bytes (post pngquant/KTX2 in-place swaps) — never
   *  estimated (invariant 3). Requires `emitPixiManifest` (a bare-string manifest has no src objects to size).
   *  Absent ⇒ bare-string `src` ⇒ the manifest is BYTE-IDENTICAL to today (no new field). OPT-IN, default OFF. */
  includeFileSizes?: 'raw' | 'gzip';
  // ── OPT-IN backend native ops (docs/improvements/round12-backend-processing.md, Phase 3) ──────────
  /** OPT-IN, DEFAULT OFF carve-out of invariants 1 & 2 (user-directed amendment): native-only encodes
   *  (today only KTX2/UASTC, which is impossible in-browser) move to a backend the user explicitly enables
   *  AND consents to PER RUN. SAFETY (load-bearing): when this field is ABSENT the ENTIRE backend path is
   *  dead — no probe, no upload, no extra zip entry — so the worker output is BYTE-IDENTICAL to today. The
   *  browser fix stays the default; the backend is an opt-in fallback for native-only ops. Assets leave the
   *  device ONLY when `backend` is present (the user configured a host) AND `backend.consent === true` (the
   *  user ticked "these images are sent to the server" THIS run) AND a KTX2-eligible page exists. On any
   *  failure (unreachable / declined / non-2xx) the worker FALLS BACK to the browser raster page with an
   *  HONEST skipped[] note — never a silent skip. */
  backend?: BackendOptions;

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

/** Native op kinds the OPT-IN backend can perform (round12-backend-processing.md §2 + round13-pngquant-
 *  backend.md). A closed verb set so the worker can never request an op the gateway/sidecar doesn't
 *  allow-list. Additive: a future value here NEVER changes the default (no-backend) path.
 *  - `ktx2`     : UASTC → Zstd, baked mips. The one honest GPU-VRAM win (block-compressed ≤1 B/px).
 *  - `pngquant` : lossy-indexed PNG re-compression. DISK-ONLY: a quantized PNG still decodes to full
 *                 RGBA8888 on the GPU ⇒ ZERO VRAM change (vramCeiling stays raster w·h·4). The win is a
 *                 SMALLER DOWNLOAD / cache, NEVER a GPU/VRAM win — there is no pngquant VRAM field, ever. */
export type NativeOpKind = 'ktx2' | 'pngquant';

/** OPT-IN backend configuration (round12-backend-processing.md §5). PRESENT ⇒ the user configured a host
 *  AND we hold a valid entitlement token; the worker may offer native ops. ABSENT on FixOptions ⇒ the whole
 *  path is dead (byte-identical). HONESTY: `consent` is the per-run explicit "these images are uploaded to
 *  the server" acknowledgement — the worker uploads NOTHING unless `consent === true`. */
export interface BackendOptions {
  /** API gateway origin (apps/api), no trailing slash, e.g. https://asset-doctor-api.fly.dev. The worker
   *  POSTs page bytes to `${apiBase}/v1/encode`; the gateway verifies the token, quota-limits, and reverse-
   *  proxies to the apps/encoder sidecar (the distroless billing image does NO native work). */
  apiBase: string;
  /** ed25519 entitlement token (offline-verified in the browser; sent as `Authorization: Bearer <token>`).
   *  The gateway re-verifies it server-side before any work — closes the free-CPU hole. */
  token: string;
  /** Native ops the user opted into. v1 only `['ktx2']`. Empty/absent ⇒ no op eligible ⇒ no upload. */
  ops: NativeOpKind[];
  /** PER-RUN explicit consent. FALSE/absent ⇒ the worker NEVER uploads (it falls back to the browser path
   *  with an honest skip note). Only TRUE after the user ticked the consent box THIS run. */
  consent: boolean;
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

export type FixRequest =
  | {
      type: 'fix';
      files: FixInputFile[];
      options: FixOptions;
      /** Dry-run preview vs commit. Absent/'execute' ⇒ byte-identical to today; 'plan' ⇒ the worker posts a
       *  `fix-plan` summary and STOPS before the compose/pack/repack/tier PIXEL LOOP + zip (the format-sizing
       *  encode + aggressive feature pass still run pre-loop, to count transcodes/dedups). */
      mode?: FixMode;
    }
  /** Cooperative cancel (round18-abortable-workers): the client posts this then terminate()s when an
   *  in-flight fix/plan run is superseded. The worker sets a `cancelled` flag and stops at the next
   *  loop/post guard. ADDITIVE: never posted on a non-superseded run ⇒ every path byte-identical to today. */
  | { type: 'cancel' };

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

  /** Packed frame rects of the SOURCE sheet (beforeAtlas.sprites[].frame), copied at capture so the
   *  MAIN thread can replay them through real offscreen WebGL (sheet-probe-run.ts). ABSENT for a `pack`
   *  page (loose has no source atlas ⇒ no honest "before", mirrors occBefore=0). Plain integer rects
   *  (structured-clone, NOT transferable — they are not ArrayBuffers). Absent ⇒ no before-probe ⇒
   *  SheetDiff byte-identical to today. */
  beforeFrames?: Rect[];
  /** Packed frame rects of the EMITTED sheet (afterAtlas.sprites[].frame), copied at capture. Drives the
   *  measured AFTER reading. Present once frames are wired (afterAtlas always exists at capture). */
  afterFrames?: Rect[];

  // ── Filled AFTER the worker finishes by attachSheetProbes (MAIN thread; the worker has no WebGL). ──
  /** MEASURED issued GL draw calls for the SOURCE sheet's frames on THE USER'S GPU this run. Absent ⇒ no
   *  probe ran (no WebGL / no beforeFrames / per-sheet failure). DEVICE-LOCAL; never cross-device; never
   *  folded into any saving (invariant 5). */
  drawCallsBefore?: number;
  /** MEASURED issued GL draw calls for the EMITTED sheet — the honest "after" beside drawCallsBefore. */
  drawCallsAfter?: number;
  /** MEASURED decoded texture VRAM (ProbeReading.vramBytes = Σ w·h·4 over uploaded textures) of the SOURCE
   *  sheet — the REAL GPU footprint, a DIFFERENT quantity from the static `vramBefore` (declared w·h·4).
   *  NEVER merged with vramBefore/After/vramBytesAfter (invariant 5). */
  decodedVramBefore?: number;
  /** MEASURED decoded texture VRAM of the EMITTED sheet — beside decodedVramBefore, never folded. */
  decodedVramAfter?: number;
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
  /** Frame-redundancy aliasing (round19): the total count of byte-identical animation frames ALIASED onto a
   *  shared packed region across every repack this run (Σ RepackResult.aliasedFrames). Every aliased name
   *  still resolves in the emitted manifest — its pixels are just written ONCE — and the sheet shrank, so the
   *  VRAM win is ALREADY inside vramBytesBefore/After (exact, no estimate). Absent/0 ⇒ no frames were aliased
   *  (no frame-redundancy finding, or the toggle was off) ⇒ receipt byte-identical to today. */
  framesAliased?: number;
  /** Cross-atlas frame dedup during MERGE (round22 #1): the count of byte-identical frames that spanned ≥2
   *  SOURCE sheets and were deduped onto ONE shared region when an atlas-MERGE folded them together — every
   *  duplicate name (across all merged sheets) still resolves in the merged manifest; the pixels are written
   *  ONCE (one Blit per cluster). This is a SUBSET of `framesAliased` (the cross-sheet portion); a within-atlas
   *  dupe is the round19 frameRedundancy path's job. These are MERGE-DISCOVERED (the free cross-atlas detector,
   *  round22 #0, surfaces them in the diagnosis) — the copy says "across sheets". Absent/0 ⇒ no merge deduped a
   *  cross-sheet frame ⇒ receipt byte-identical to today. */
  crossSheetFramesDeduped?: number;
  /** Cross-atlas frame dedup during MERGE (round22 #1): the EXACT VRAM bytes reclaimed by the cross-sheet
   *  dedups — Σ RepackResult.vramReclaimedBytes, a REAL measured delta (the no-alias baseline pack of the
   *  merged group's POT bin minus the deduped bin). NOT an area floor / POT-gate estimate (that is what the
   *  DETECTOR avoids; the merge actually produces the bin, so this is measured). `0` when the dedup did not
   *  drop a POT tier (drop-in, fewer pixels on disk, but same VRAM tier ⇒ disk-only, invariant 5). The win is
   *  ALSO already inside vramBytesBefore/After. Absent ⇒ no cross-sheet dedup ran. */
  crossSheetVramReclaimedBytes?: number;
  /** Cross-atlas frame dedup during MERGE (round22 #1): TRUE iff ≥1 merge dropped the deduped group to a
   *  SMALLER POT VRAM tier (so crossSheetVramReclaimedBytes > 0). FALSE ⇒ frames were deduped (drop-in, fewer
   *  pixels on disk) but the POT bin stayed the same tier ⇒ disk-only, NOT a VRAM claim (invariant 5). Present
   *  only when crossSheetFramesDeduped > 0. */
  crossSheetPotTierDropped?: boolean;
  /** Trim-on-repack (round20): the total count of UNtrimmed sprites this run tightened to their opaque bounds
   *  during a repack (Σ RepackResult.trimmedSprites — distinct packed rects; aliases inherit the rep's trim but
   *  are not re-counted). Each tightened sprite renders identically in-engine from a smaller sheet (drop-in:
   *  every name still resolves; the manifest carries `trimmed:true` + `sourceSize` + `spriteSourceSize`). The
   *  VRAM win is ALREADY inside vramBytesBefore/After (exact). Absent/0 ⇒ nothing was trimmed (no shrinkable
   *  untrimmed sprite, or no repack ran) ⇒ receipt byte-identical to today. */
  trimmedSprites?: number;
  /** Trim-on-repack (round20): Σ atlas px MEASURED-reclaimed by tightening untrimmed frames (Σ over trimmed
   *  reps of frame area − opaque-bbox area). This is the MEASURED reclaim, never the detector's "up to" promise
   *  (the receipt says "reclaimed N px"). Absent/0 ⇒ nothing was trimmed ⇒ receipt byte-identical to today. */
  trimmedAreaReclaimed?: number;
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
  /** OPT-IN backend native ops summary (round12-backend-processing.md §7 + round13-pngquant-backend.md,
   *  Phase 3). An ARRAY — ONE entry per native op that actually ran this run (B3: a single op-discriminated
   *  field, never a parallel per-op field). Present ONLY when the user consented AND ≥1 page was actually
   *  offered to the backend; an empty/absent array ⇒ no backend op ran ⇒ receipt byte-identical to today.
   *  Per entry:
   *  - `op`       : the native op kind ('ktx2' | 'pngquant').
   *  - `uploaded` : pages sent to the backend.
   *  - `produced` : output files received + folded into the zip (`.ktx2` for ktx2; in-place re-compressed
   *                 PNG pages for pngquant).
   *  - `failed`   : pages that fell back to the browser raster/lossless page (unreachable / declined /
   *                 encode error — each surfaced in skipped[]). NOTE (M1): a pngquant quality-floor decline
   *                 is NOT a failure — the original is kept, it does NOT increment `failed`.
   *  - `host`     : the gateway origin (no token, no bytes).
   *  - `bytesBefore` / `bytesAfter` (pngquant ONLY): REAL MEASURED disk byte sums — the original page bytes
   *                 vs the pngquant'd bytes. The honest "smaller download" claim. There is NO VRAM field for
   *                 pngquant (it decodes to full RGBA8888 ⇒ vramCeiling unchanged, invariant 5). The KTX2
   *                 worst-case VRAM ceiling stays the SEPARATE sibling field `ktx2VramBytesWorstCase`. */
  backendNative?: {
    op: NativeOpKind;
    uploaded: number;
    produced: number;
    failed: number;
    host: string;
    /** pngquant ONLY: real measured original page byte sum (disk). Omitted for ktx2. */
    bytesBefore?: number;
    /** pngquant ONLY: real measured re-compressed page byte sum (disk). Omitted for ktx2. */
    bytesAfter?: number;
  }[];
  /** HONEST worst-case GPU VRAM CEILING (bytes) of the produced `.ktx2` pages — Σ vramCeilingOfPage('ktx2-
   *  uastc', w, h, mipsBaked). This is an UPPER BOUND ("GPU VRAM ≤ …"), NEVER w·h·4 and NEVER folded into the
   *  hard vramBytesAfter (invariant 5): the runtime may transcode to BC1/ETC1 (≤0.5 B/px) or fall back to
   *  raster on GPUs with no block-compression support. Reported SEPARATELY with the "≤ / fallback" caveat in
   *  the receipt copy. Absent ⇒ no KTX2 produced. */
  ktx2VramBytesWorstCase?: number;
  /** MEASURED resident GPU VRAM (bytes) of the produced .ktx2 pages on THE USER'S GPU this run — Σ
   *  ProbeKtx2Reading.compressedBytes over the probed pages (each mip level its own compressedTexImage2D
   *  call, summed ⇒ exact residency). Turns the one ESTIMATED headline into a MEASURED fact, shown BESIDE
   *  `ktx2VramBytesWorstCase` ("measured X on your GPU (BC7/ASTC), ceiling ≤ Y — this device only"). It is
   *  DEVICE-LOCAL ONLY (the GPU's chosen transcode target AND whether the transcoder loaded both move it)
   *  and is NEVER folded into the hard `vramBytesAfter` (Invariant 5) nor asserted across devices (Invariant
   *  3). Filled AFTER the worker finishes by a main-thread WebGL probe (the worker has no WebGL); ABSENT ⇒
   *  no probe ran (no WebGL / no .ktx2 produced / transcoder unavailable) ⇒ receipt byte-identical to today. */
  probedKtx2VramBytes?: number;
  /** Raster (RGBA8888 = w·h·4) baseline measured in the SAME probe pass — the honest "before" beside the
   *  measured compressed "after". Absent together with `probedKtx2VramBytes` (no probe ran). */
  probedKtx2RasterBaselineBytes?: number;
  /** True ⇒ ≥1 probed page fell back to raster on this device (no block-compression support / transcoder
   *  failed / asset 404'd) ⇒ the measured number is NOT a win here — disclosed so it is never mis-sold.
   *  Absent ⇒ no probe ran (or every probed page got real compression). */
  probedKtx2Fallback?: boolean;
  /** round19-fix-worker-memory-bounds.md (#1): DESCRIPTIVE working-set note — the high-water count of decoded
   *  SOURCE bitmaps held at once during the fix and the byte budget that bounded them. This is a transient
   *  CPU-side decode working-set bound, NOT a VRAM figure: it is NEVER folded into vramBytesBefore/After or
   *  any saving (invariant 5). Present only when ≥1 source bitmap was decoded (gated on peakCount > 0) ⇒ a
   *  no-decode run omits it ⇒ receipt byte-identical to today. The UI may show or ignore it (additive). */
  decodeWorkingSet?: { decodedPages: number; budgetBytes: number };
  /** True iff this run produced ≥1 `.ktx2`/`.ktx2.json` page (round15-emit-the-exact-pixi-v8-ktx2-loader-
   *  migration). The `.ktx2`/`.ktx2.json` paths live in `out`/the manifest variants (the loader resolves
   *  them via the entry's `src`), NOT in `changes[]` — so this boolean is the only seam that lets the
   *  loader-migration snippet lead ONCE with `import 'pixi.js/ktx2'` (which registers loadKTX2; the ktx2-first
   *  manifest `src` candidate fails to resolve without it). Set ONLY when ktx2Produced > 0 (gated ⇒ non-KTX2
   *  runs omit it ⇒ receipt byte-identical to today). */
  ktx2Produced?: boolean;
}

/* ── Dry-run plan preview (docs/improvements/dry-run-plan-preview.md) ─────────────────────────
 * The 'plan' mode payload. HONESTY (invariant 5): op COUNTS ONLY — NO byte/VRAM savings field exists
 * here. The format-sizing pass DID encode to count transcodes, but nothing is COMPOSED/packed/zipped
 * yet, so there is no real output footprint to report (disk ≠ VRAM; no faked numbers pre-compose). */

/** Per-kind op tally, keyed by the SAME OpKind vocabulary as the receipt change-manifest (op-manifest.ts).
 *  Counts the STRUCTURED FixOp[] the execute path would run (repack/merge split by atlasRefs.length;
 *  drop/dedup split by ownerRef; resize/transcode/pack literal) PLUS the worker-side `tier` multiplier
 *  (an upper bound — tiering can still be refused at pixel time). Zero-count kinds are OMITTED. */
export type PlanOpCounts = Partial<
  Record<'repack' | 'resize' | 'transcode' | 'drop' | 'merge' | 'pack' | 'dedup' | 'tier', number>
>;

/** HONEST fix-simulation footprint preview (round22 #2, docs/improvements/round22-honest-fix-simulation-
 *  footprint-pr.md). The Plan card may surface ONLY footprint deltas that are HONESTLY KNOWN before the
 *  compose loop runs — split into "measured now" (before→after disk/VRAM computable pre-compose from the
 *  already-MEASURED finding geometry/sizes) vs "computed at execute" (transcode/encode-dependent sizes the
 *  encode alone resolves). INVARIANT 5: `diskBytesSaved` and `vramBytesSaved` are kept DISTINCT — never a
 *  combined headline. INVARIANT 3: this is a fix-PLAN preview (the plan already exists; nothing is
 *  generated). Never a fabricated number; an op that contributes nothing knowable is EXCLUDED here and
 *  counted in `deferredOps` ("+N more computed at download") instead. */
export interface FixPlanFootprint {
  /** Σ measured DISK bytes the SURVIVING transcode/opaque ops save (srcBytes − bestBytes / srcBytes −
   *  opaqueBytes, clamp ≥0). The format-finding deltas are the lossy q0.9 canvas ESTIMATE (sets
   *  `estimated`); the opaque-alpha delta is a MEASURED channel-drop. ≥0. */
  diskBytesSaved: number;
  /** Σ EXACT VRAM the SURVIVING resize × dimensions-oversize ops reclaim (params.vram − to.w·to.h·4,
   *  clamp ≥0). npot/solid are EXCLUDED — planFix emits no op for them, and a resize achieves neither
   *  their POT-padding nor their 1×1 reclaim (different, non-additive baselines). ≥0. NEVER conflated
   *  with `diskBytesSaved` (invariant 5: disk weight ≠ GPU footprint). */
  vramBytesSaved: number;
  /** True iff ≥1 disk delta is the lossy q0.9 canvas ESTIMATE (a format finding) ⇒ the UI prefixes "~"
   *  so the number is shown as estimated, never an exact pre-encode saving. */
  estimated: boolean;
  /** Count of NON-summable ops that ALSO run (repack/merge/pack/dedup + the worker-folded scale-tier
   *  multiplier) — their before→after is NOT knowable pre-compose. NEVER folded into disk/vram; surfaced
   *  honestly as "+N more computed at download". */
  deferredOps: number;
}

/** The dry-run preview the worker posts in 'plan' mode. Deterministic; carries NO pixels and — by
 *  design — NO byte/VRAM savings (counts only, until execute) EXCEPT the optional honest `footprint`
 *  preview (round22 #2), which surfaces ONLY pre-compose-knowable disk/VRAM deltas + a deferred count. */
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
  /** HONEST footprint preview (round22 #2) — ONLY pre-compose-knowable disk/VRAM deltas (measured-now)
   *  + a count of ops sized at download (deferred). ADDITIVE: absent ⇒ counts-only card byte-identical to
   *  today (no measured-now rows). Distinct disk vs VRAM (invariant 5); never a fabricated total. */
  footprint?: FixPlanFootprint;
}

/** One produced `.ktx2` page + its raster source, TRANSFERRED from the worker on `fix-done` so the MAIN
 *  thread can probe real GPU residency (the worker has no WebGL). The worker holds these bytes; we ship a
 *  store-only zip *writer* (no reader), so re-reading the zip on the host is not an option — the side-channel
 *  carries fresh slices instead. Populated ONLY when ≥1 `.ktx2` was produced (capped); absent otherwise ⇒
 *  no probe ⇒ receipt + behaviour byte-identical to today. */
export interface Ktx2ProbeInput {
  /** the produced `.ktx2` page bytes (a fresh slice — the zip's copy stays intact). */
  ktx2Bytes: ArrayBuffer;
  /** the SAME page's raster bytes (a fresh slice) — decoded on the host for the w·h·4 baseline. */
  rasterBytes: ArrayBuffer;
  /** the raster bytes' MIME (so the host decodes them correctly). */
  rasterMime: string;
}

export type FixResponse =
  | { type: 'fix-progress'; label: string; done: number; total: number }
  /** `ktx2Probe` is the OPT-IN GPU-VRAM probe side-channel (round15): present (non-empty) ONLY when the
   *  backend produced ≥1 `.ktx2` page. The host (fix-client.runFix) probes these on the main thread and
   *  REPLACES `receipt` with the augmented one (the measured fields) before resolving. Absent ⇒ no probe ⇒
   *  receipt + zip byte-identical to today. The buffers are transferred zero-copy (fresh worker slices). */
  | { type: 'fix-done'; receipt: FixReceipt; zip: Blob; ktx2Probe?: Ktx2ProbeInput[] }
  /** Dry-run preview (mode:'plan'). Additive: the execute path never emits this; fix-progress/fix-done
   *  are unchanged. */
  | { type: 'fix-plan'; summary: FixPlanSummary }
  | { type: 'fix-error'; error: string };
