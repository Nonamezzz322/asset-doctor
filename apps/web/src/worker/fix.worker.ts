/// <reference lib="webworker" />
// The Phase-2 fix executor (impure half). Reuses the analysis pipeline to diagnose, plans the fix
// (@asset-doctor/fix, pure), then does the pixel work: repack atlases (crop each sprite from the source
// sheet → compose a tighter POT sheet → re-emit a deterministic manifest), transcode loose images
// (native WebP, or AVIF via @jsquash with honest fallback), drop exact duplicates, and zip a drop-in
// optimized folder. Assets never leave the device. Every fix the browser can't do lands in skipped[].

import type {
  Asset,
  Atlas,
  AtlasFrameHashes,
  AtlasFrameTrims,
  Blit,
  FixOp,
  FormatTarget,
  ImageMime,
  ImageFeatures,
  PackGroup,
  Rect,
  ScaleTier,
  Size,
  Sprite,
  TrimRect,
} from '@asset-doctor/core';
import {
  groupFiles,
  groupLooseForPacking,
  keyOf,
  type LooseImage,
  type RawFile,
} from '@asset-doctor/ingest';
import {
  parseAtlas,
  parseImage,
  parseSpineAtlasText,
  parseSpinePage,
  type SpinePage,
} from '@asset-doctor/parsers';
import {
  analyze,
  buildDedupGroups,
  DEFAULT_THRESHOLDS,
  hasResolutionToken,
  mergeSharedAtlases,
  occupancyValue,
  type EncodeSizer,
} from '@asset-doctor/analysis';
import {
  emitSpineAtlasText,
  emitTexturePackerJson,
  planFix,
  polygonWins,
  repackAtlases,
  repackAtlasesPolygon,
  scaleAtlas,
  // Frame-redundancy aliasing (round19) — PURE byte-identical-frame clustering (mirrors the detector's
  // distinct-rect logic). The worker pre-hashes qualifying merged atlas pages, builds these per-atlas alias
  // maps, and threads them into repackAtlases so duplicate frames share ONE packed region (one Blit per
  // representative) while every original name still resolves. Single Vitest-covered source so it can't drift.
  buildAtlasAliasMaps,
  type AtlasAliasMap,
  // Cross-atlas frame dedup during MERGE (round22 #1) — the WHOLE-GROUP analogue of buildAtlasAliasMaps. The
  // merge branch lazily hashes any group sheet missing from frameHashByRef, then builds ONE flat (atlasName,
  // frameName) alias map so byte-identical frames spanning MULTIPLE merged sheets pack ONE region (every name
  // resolves; one Blit per representative). EXACT VRAM delta comes from the real repackAtlases baseline. Same
  // Vitest-covered pure source the within-atlas path uses ⇒ no drift.
  buildMergeAliasMap,
  type MergeAliasMap,
  // PURE edge-extrude (bleed) geometry (design OPTION A / docs/improvements/edge-extrude.md). The worker
  // reserves a symmetric gutter in pack()/packLoose()/repackAtlases() via `gutter`, then turns each
  // ExtrudeRect into ONE drawImage AFTER the main blit. effectiveExtrude clamps the bleed to the op's
  // gutter; extrudePlan internally gates to rectangle blits (returns [] for meshed/rotated — the worker
  // surfaces those honestly). No drift — the worker imports the SAME tested geometry the Vitest goldens cover.
  effectiveExtrude,
  extrudePlan,
  type ExtrudeRect,
  scaleMeshToFrame,
  traceMesh,
  // PURE settings helpers (design §4b): per-asset effective-option resolution (folder/type overrides)
  // + scale-aware quality. Single Vitest-covered source of truth so the worker can't drift.
  resolveOptions,
  scaleAwareQuality,
  type EffectiveOptions,
  type FixAssetKind,
  // PURE scale-tier helpers (design docs/scale-tiers-design.md §3b) — the loose-image geometry analogue
  // of scaleAtlas (scaleLoose), tier suffix naming (tieredName), and fail-closed ladder validation
  // (validateTiers). The tier loop below OWNS oversize clamping + stamps `.scale`; these stay pure.
  scaleLoose,
  tieredName,
  validateTiers,
  // PURE config-driven export-profile helpers (round7-export-profile.md §4a/§4b) — fail-closed profile
  // validation (validateProfile, delegates the resolution axis to validateTiers), the per-format encode
  // mapping (formatEncode → encodeCanvas params, incl. the threaded lossless B1), and the format-token
  // naming math (variantManifestName: single-format ⇒ byte-identical legacy `.json`, multi ⇒ a `.webp`/
  // `.avif` token before the manifest ext). The worker reuses these VERBATIM so the fan-out can't drift.
  validateProfile,
  formatEncode,
  variantManifestName,
  type FormatEncode,
  // PURE per-folder/prefix/type profile-override resolver (round10-profile-overrides.md §3). Reuses the
  // ONE match predicate (overrideMatches) + formatEncode's global bag type so the per-ref fan-out can't
  // drift from the legacy resolveOptions match semantics. ADDITIVE: absent/empty overrides ⇒ the base
  // formats/global are returned BY REFERENCE ⇒ formatEncode runs on the SAME objects ⇒ byte-identical.
  resolveProfileForRef,
  type ProfileOverride,
  type FormatEncodeGlobal,
  // PURE owner-aware dedup repoint path math (design §3d) — SINGLE source of truth, Vitest-covered in
  // packages/fix, so the meta.image repoint resolves back through @asset-doctor/parsers and can't drift.
  dirOf,
  resolveImageRef,
  relativeImageRef,
  // PURE atlas-sidecar repoint for the prebuilt-atlas passthrough transcode (round20 #1) — re-encoding an
  // atlas PAGE renames it, so the sidecar meta.image / Spine texture line is repointed (relativeImageRef
  // inverse) or it dangles. Single Vitest-covered source so the worker's repoint can't drift.
  repointAtlasImage,
  // PURE owner-aware dedup EXECUTION helpers (design §3d / §10.8): the rename rule (EXT/renamedTo) + the
  // Phase-A owner final-name prediction. SINGLE source of truth — the worker and its Node round-trip test
  // both import these, so the two-phase dangling-reference guard can't drift between them.
  EXT,
  renamedTo,
  predictOwnerFinalNames,
  isOwnerAwareDrop,
  type OwnerFinalName,
  // PURE per-sprite extraction cores — single source of truth for the threshold/dilation/downscale
  // logic (Vitest-covered in packages/fix). The worker only reads pixels and delegates here.
  maskItemFromRGBA,
  alphaMaskFromRGBA,
  // Frozen polygon constants — re-exported from the SINGLE source of truth (polygon-config) so no
  // tunable the mesh/mesh-trace path depends on can drift between the worker and packages/fix.
  HULL_AREA_RATIO_MAX,
  POLY_MAX_VERTS,
  POLY_TOLERANCE2,
  type MaskItem,
  type RawMesh,
  // Feature 4 (pack loose assets) — PURE halves: alphaBBox (worker's per-region opaque bbox), packLoose
  // (loose regions → Atlas[]+Blit[]), and the Spine skeleton verifier. The worker supplies pixels +
  // composes; ALL geometry/verification math lives in these tested pure helpers (no drift).
  alphaBBox,
  packLoose,
  verifySpineSkeleton,
  // PURE PixiJS-v8 AssetsManifest builder (round8-pixi-manifest.md). Deterministic string work — the worker
  // feeds it the variants it RECORDED at each verified out.push site (post-fallback enc.mime paths), so the
  // emitted manifest.json can only reference files that exist. Off ⇒ the collector is never allocated ⇒ no
  // entry ⇒ zip byte-identical. countPixiManifestEntries gives the receipt count without re-parsing the JSON.
  buildPixiManifest,
  countPixiManifestEntries,
  // PURE naming primitive of content-hash cache-busting (round9-cache-busting.md): insert `.<8hex>` before
  // the final extension, preserving dir + any compound token. The worker computes the hash (shortHash of the
  // FINAL emitted bytes) and threads the hashed name into out.push / the referrer (imageRef / .atlas line 0 /
  // recordVariant.src / the loader-migration rows). Off ⇒ never called ⇒ emitted paths byte-identical to today.
  hashedName,
  // PURE GPU-residency CEILING helper (round12-backend-processing.md §7): a .ktx2 page's worst-case VRAM is
  // ≤ ~1 B/px (UASTC/BC7), NEVER w·h·4; mips baked ⇒ ×4/3. The ONE source of truth for the receipt's
  // ktx2VramBytesWorstCase so the worker can't drift from the honest ceiling model.
  vramCeilingOfPage,
  type ManifestAsset,
  type EmittedVariant,
  type ManifestAssetKind,
} from '@asset-doctor/fix';
import { dHashFromGray, extractFrameRegions, isFlat, luma } from '../lib/perceptual';
import { makeZip, type ZipEntry } from './zip';
// PURE dry-run plan summary (docs/improvements/dry-run-plan-preview.md): tallies the STRUCTURED FixOp[]
// the execute path would run + the worker-side tier multiplier into the receipt's OpKind vocabulary. No
// byte/VRAM number (honesty, invariant 5). The worker only assembles the pixel-free gate facts.
import {
  dedupKeepConsumerSkip,
  deselectedSkips,
  fixOpKind,
  summarizePlan,
  type OpKind,
  type PlanGateInputs,
} from '../lib/op-manifest';
// PURE honest fix-simulation footprint preview (round22 #2): sums ONLY pre-compose-knowable disk/VRAM
// deltas (transcode/opaque disk · oversize×resize VRAM) + a count of ops sized at download. NEVER a
// fabricated total; disk vs VRAM distinct (invariant 5). Absent footprint ⇒ summary byte-identical.
import { summarizeFixPlanFootprint } from '../lib/plan-footprint';
// PURE loader-migration row builders (docs/improvements/loader-migration.md). The worker captures only
// GENUINE loader-CALL changes (merge/pack/tier/loose-rename/bare-drop — NOT dedup, which rewrites the
// consumer manifest in place) as one-line builder calls; finalizeChanges sorts+dedups deterministically.
// SAME constructors the unit test drives directly (the worker can't run in Node — createImageBitmap).
import {
  dropChange,
  finalizeChanges,
  looseRenameChange,
  mergeChanges,
  packChanges,
  repackChanges,
  tierChanges,
} from '../lib/loader-migration';
import { canKeepSheetDiff, sheetGeometryProof } from './sheet-diff';
// PURE keep-original-on-size-LOSS guard for the opaque transcode path (round15 #2) — never ship a larger
// page from an alpha-drop "optimization". Imported verbatim so the predicate is unit-tested in Node.
import { transcodeIsSizeLoss } from './transcode-guard';
// GPU-VRAM probe COLLECTION gate + fresh-slice build (round15 #0) — extracted PURE so the cap +
// copy-not-alias guarantee are unit-testable in Node (the worker can't run headless). Single source of truth.
import { collectKtx2Probe, KTX2_PROBE_MAX } from '../lib/ktx2-probe-collect';
// round19-fix-worker-memory-bounds.md (#1): bound the decoded SOURCE working-set. The PURE LRU-with-byte-
// budget policy (close()+evict the LRU UNPINNED bitmap on an over-budget insert; never evict a pinned in-
// flight-op ref) lives in this Node-testable module so the eviction correctness can't drift. bitmapOf routes
// through it; the runFix finally + every cancel path drain() it (frees native memory immediately). ADDITIVE:
// under budget nothing evicts ⇒ byte-identical output to before this change (re-decode on a miss is safe —
// the source bytes are retained whole-run).
import { BITMAP_BUDGET_BYTES, BitmapBudget } from '../lib/bitmap-budget';
import type {
  FixChange,
  FixInputFile,
  FixMode,
  FixOptions,
  FixReceipt,
  FixRequest,
  FixResponse,
  Ktx2ProbeInput,
  NativeOpKind,
  SheetDiff,
} from './fix-protocol';
// OPT-IN backend native KTX2 (round12-backend-processing.md, Phase 3). encodeRemote is the ONLY network
// call in the fix path and it fires ONLY behind opts.backend + per-run consent (backendOn). KTX2_PROFILE_
// BAKES_MIPS keeps the wire profile + the VRAM-ceiling accounting (vramCeilingOfPage mips arg) in sync.
import { encodeRemote, KTX2_PROFILE_BAKES_MIPS } from '../lib/backend-client';
// OPT-IN libvips lanczos3 resample tier post-pass (round24-libvips-lanczos3-resample-op-sidecar.md). The
// gate predicate (opt-in/consent + the B1 hashFilenames interaction) + the HF-energy measure are PURE +
// Node-tested so the control flow can't drift (the worker can't run headless). resampleOn gates the WHOLE
// path: false ⇒ the existing OffscreenCanvas tier downscale runs ⇒ byte-identical output.
import { resampleOn, resampleSkippedByHashFilenames } from '../lib/resample-collect';
import { hfEnergy, aggregateHfEnergyDelta } from '../lib/resample-quality';
// Round 24: gzip file-size helper extracted to a PURE, Node-testable module (the worker can't run headless);
// 0-byte ⇒ 0 guard lives there. Call site unchanged.
import { gzipLen } from './gzip-len';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FixResponse): void => ctx.postMessage(m);
const basename = (p: string): string => p.split('/').pop() ?? p;

// round18-abortable-workers: cooperative cancel. Set on {type:'cancel'}; checked at the top of each
// per-op loop (op / ktx2 / pngquant) + before each terminal post (fix-plan / zipping+makeZip / fix-done),
// so a superseded run stops heavy pixel/encode/zip work in the microtask gap before terminate() lands and
// never posts a terminal that races the terminate. ADDITIVE: a non-aborted run never sees a cancel ⇒ this
// stays false ⇒ every guard is a dead `if`.
let cancelled = false;

/** Pixi manifest (round8-pixi-manifest.md §6.6): pick a NON-colliding zip-entry name for the emitted
 *  manifest. Preferred `manifest.json`; if taken by an input OR an already-emitted output, fall back to
 *  `asset-doctor.manifest.json`, then `asset-doctor.manifest.2.json`, … Never overwrites an existing file.
 *  Deterministic (fixed candidate order). `taken` is the set of paths already in play. */
const pickManifestPath = (inputs: Set<string>, emitted: { path: string }[]): string => {
  const taken = new Set<string>([...inputs, ...emitted.map((e) => e.path)]);
  if (!taken.has('manifest.json')) return 'manifest.json';
  if (!taken.has('asset-doctor.manifest.json')) return 'asset-doctor.manifest.json';
  for (let i = 2; ; i++) {
    const cand = `asset-doctor.manifest.${i}.json`;
    if (!taken.has(cand)) return cand;
  }
};

// Sheet-diff caps + the emitted-sheet geometry proof + the cap decision (docs/improvements/round6-f1-
// sheet-diff.md) live in the PURE, Node-testable ./sheet-diff module — the worker imports them verbatim so
// a Vitest test can assert the cap arithmetic + the empty-zone map against the analysis primitives headless
// (the worker itself can't run in Node — `self` / OffscreenCanvas). sheetDiffsTotal still counts ALL
// composed so the UI can say "showing N of M"; canKeepSheetDiff gates only what is RETAINED in the receipt.
// dirOf / resolveImageRef / relativeImageRef are imported from @asset-doctor/fix (PURE, tested).
const td = new TextDecoder();
const te = new TextEncoder();
// EXT (mime → ext) + renamedTo (the loose-image/owner rename) are imported from @asset-doctor/fix (PURE,
// tested) — single source of truth shared with the Phase-A owner-final-name prediction.

// ── Content-hash cache-busting (docs/improvements/round9-cache-busting.md K3) ──────────────────────────
// HASH_LEN = the short content-hash width appended before the final extension (8 hex = 32 bits; the
// directory + stem are preserved by hashedName, so a real collision is negligible — and the emitted-path
// Set in the execute body catches the astronomically-rare different-bytes/same-stem case deterministically).
const HASH_LEN = 8;
// sha256 of the FINAL emitted bytes → first HASH_LEN hex. DEFENSIVE: encodeCanvas returns fresh
// full-buffer-backed Uint8Arrays (byteOffset 0), but oxipng/other paths could hand back a subarray view, so
// slice the EXACT bytes when the view is not the whole backing buffer (never hash a neighbor's bytes). PURE
// WebCrypto (invariant 1: in-browser, no native libs/network). Deterministic: same bytes ⇒ same hash.
const shortHash = async (bytes: Uint8Array): Promise<string> => {
  const buf =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return (await sha256Hex(buf as ArrayBuffer)).slice(0, HASH_LEN);
};

ctx.onmessage = async (e: MessageEvent<FixRequest>): Promise<void> => {
  if (e.data.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (e.data.type !== 'fix') return;
  cancelled = false; // defensive reset (clients build a fresh worker per run today, so this is normally moot)
  try {
    // Dry-run preview vs commit (docs/improvements/dry-run-plan-preview.md). Absent/'execute' ⇒
    // byte-identical to today's one-click path; 'plan' ⇒ the worker posts a `fix-plan` summary and STOPS
    // before the pixel loop (no compose/encode/zip).
    await runFix(e.data.files, e.data.options, e.data.mode ?? 'execute');
  } catch (err) {
    // A cancelled run that threw mid-teardown must NOT post a spurious fix-error after the host already
    // rejected with AbortError + terminated. Non-cancelled ⇒ same fix-error as today.
    if (!cancelled)
      post({ type: 'fix-error', error: err instanceof Error ? err.message : String(err) });
  }
};

async function runFix(files: FixInputFile[], opts: FixOptions, mode: FixMode): Promise<void> {
  // round19-fix-worker-memory-bounds.md (#1): hoisted so the finally below — and the existing cancel/abort
  // returns — release the decoded-source working-set. Constructed lazily at the execute path (it is undefined
  // through the analyze + plan-mode prefix, which return BEFORE any decode), so `bmpBudget?.drain()` is a
  // no-op for plan mode / an early-cancel before the pixel loop ⇒ byte-identical to today there. On every
  // EXECUTE exit (normal end, thrown error, or a cancel `return` after construction) the finally close()s
  // every still-cached bitmap so a finished/superseded run frees native memory immediately.
  let bmpBudget: BitmapBudget<ImageBitmap> | undefined;
  try {
    post({ type: 'fix-progress', label: 'analyzing', done: 0, total: 1 });

    // ── parse + analyze (same pipeline as the diagnosis) ──
    const raw: RawFile[] = files.map((f) => ({ name: f.name, path: f.path, bytes: f.bytes }));
    const grouped = groupFiles(raw);
    // Bytes of EVERY input file by its dir-aware key (keyOf) — lets the Feature 4 Spine verifier read the
    // skeleton .json (a marker file, NOT in bytesByRef which only holds parsed image/atlas bytes).
    const bytesByRefAll = new Map<string, ArrayBuffer>();
    for (const f of raw) bytesByRefAll.set(keyOf(f), f.bytes);
    const assets: Asset[] = [];
    const bytesByRef = new Map<string, ArrayBuffer>();
    const pathByRef = new Map<string, string>();
    const spineRefs = new Set<string>();
    for (const a of grouped.atlases) {
      const image = { ref: a.name, bytes: new Uint8Array(a.image.bytes) };
      // a.name is ingest's dir-aware key — pass it as the asset name so atlases sharing a meta.image
      // basename across folders are keyed distinctly (atlas.name otherwise defaults to the bare imageRef).
      const res =
        a.kind === 'spine'
          ? parseSpinePage(a.manifest as SpinePage, image, { name: a.name })
          : parseAtlas(a.manifest, image, { name: a.name });
      if (res.ok && res.asset.kind === 'atlas') {
        assets.push(res.asset);
        bytesByRef.set(res.asset.atlas.name, a.image.bytes);
        pathByRef.set(res.asset.atlas.name, a.image.path ?? a.image.name);
        if (a.kind === 'spine') spineRefs.add(res.asset.atlas.name);
      }
    }
    for (const im of grouped.images) {
      // Key loose images by the dir-aware path so same-basename files in different folders stay distinct
      // across bytesByRef / pathByRef / vramByRef / features (no silent overwrite).
      const ref = keyOf(im);
      const res = parseImage(ref, new Uint8Array(im.bytes));
      if (res.ok && res.asset.kind === 'image') {
        assets.push(res.asset);
        bytesByRef.set(res.asset.image.name, im.bytes);
        pathByRef.set(res.asset.image.name, im.path ?? im.name);
      }
    }

    // manifest file path keyed by the RESOLVED image path (dir-aware — two atlases can share a basename
    // across folders): TexturePacker / Pixi JSON …
    const manifestPathByImage = new Map<string, string>();
    for (const f of files) {
      if (!/\.json$/i.test(f.name)) continue;
      try {
        const j = JSON.parse(td.decode(f.bytes)) as { meta?: { image?: unknown } };
        if (typeof j.meta?.image === 'string')
          manifestPathByImage.set(resolveImageRef(f.path, j.meta.image), f.path);
      } catch {
        /* not a manifest */
      }
    }
    // … and Spine `.atlas` (resolved page image path → its atlas file + page count)
    const spineAtlasInfo = new Map<string, { path: string; pages: number }>();
    for (const f of files) {
      if (!/\.atlas$/i.test(f.name)) continue;
      try {
        const pages = parseSpineAtlasText(td.decode(f.bytes));
        for (const pg of pages)
          spineAtlasInfo.set(resolveImageRef(f.path, pg.image), {
            path: f.path,
            pages: pages.length,
          });
      } catch {
        /* not a spine atlas */
      }
    }
    const manifestPathOf = (ref: string): string | undefined =>
      manifestPathByImage.get(pathByRef.get(ref) ?? '');
    const spineInfoOf = (ref: string): { path: string; pages: number } | undefined =>
      spineAtlasInfo.get(pathByRef.get(ref) ?? '');

    const merged = mergeSharedAtlases(assets);
    const atlasByRef = new Map<string, Atlas>();
    const vramByRef = new Map<string, number>();
    // Source pixel dimensions per ref (atlas sheet size or loose image size). The tier loop reads this to
    // own oversize clamping (clamp the top tier once, derive every lower tier from it) — see design §7.
    const sizeByRef = new Map<string, Size>();
    for (const a of merged) {
      if (a.kind === 'atlas') {
        atlasByRef.set(a.atlas.name, a.atlas);
        vramByRef.set(a.atlas.name, a.atlas.size.w * a.atlas.size.h * 4);
        sizeByRef.set(a.atlas.name, { w: a.atlas.size.w, h: a.atlas.size.h });
      } else {
        vramByRef.set(a.image.name, a.image.size.w * a.image.size.h * 4);
        sizeByRef.set(a.image.name, { w: a.image.size.w, h: a.image.size.h });
      }
    }

    // aggressive dedup needs per-image features (SHA-256 + dHash); skip the decode cost otherwise.
    const features = opts.aggressive ? await computeFeatures(bytesByRef) : undefined;

    // ── Diagnosis decode pass: frame-redundancy hashes (round19) + trim-margin bboxes (round21 #0) ───────
    // BLOCKER B0/B1: the fix worker re-runs analyze() itself, so the within-atlas frame-redundancy AND
    // trim-margin findings ONLY fire here if the worker computes the per-atlas hashes/bboxes and FEEDS them in
    // (mirroring analyze.worker.ts:224-261/143). Both are usually FULLY-PACKED atlases ⇒ NO occupancy/wasted
    // finding ⇒ NO repack today, so without this the plan's frame-redundancy / trim-margin branches match
    // NOTHING and the toggle is a dead no-op. The decode is SHARED: ONE full-resolution decode per qualifying
    // merged atlas page (identical magnitude to the composePageEncode source decode a repack already pays)
    // yields BOTH the region hashes and the opaque bboxes (hashAtlasFrames returns {hashes,bboxes}; the bboxes
    // piggyback on the SAME page buffer ⇒ zero extra decode when both toggles are on). B1: the pass runs when
    // `frameRedundancyOn || trimMarginOn`, and EACH array is kept independently — `frameRedundancy:false,
    // trimMargin:true` still gets trim bboxes (no minDuplicates floor — a single padded sprite can fire),
    // `trimMargin:false` keeps no bboxes ⇒ byte-identical to today. `frameHashByRef` is REUSED below to build
    // the per-atlas alias maps threaded into repackAtlases; its minDuplicates pre-filter is preserved exactly
    // (a sheet with fewer sprites can never cluster — frame-redundancy stays byte-identical). Respect cancelled.
    const frameRedundancyOn = opts.frameRedundancy !== false;
    const trimMarginOn = opts.trimMargin !== false;
    const minDuplicates = DEFAULT_THRESHOLDS.frameRedundancy?.minDuplicates ?? Infinity;
    const frameHashByRef = new Map<string, (string | null)[]>();
    const frameTrimByRef = new Map<string, (TrimRect | null)[]>();
    if (frameRedundancyOn || trimMarginOn) {
      for (const a of merged) {
        if (cancelled) return; // superseded — stop before the next (heavy) page decode
        if (a.kind !== 'atlas') continue;
        // Frame-redundancy's cheap pre-filter (a page with fewer than minDuplicates sprites can never reach the
        // cluster gate) gates ONLY whether we want hashes for THIS page; trim-margin has no such floor. Skip
        // the decode entirely only when NEITHER half wants this page.
        const wantHashes = frameRedundancyOn && a.atlas.sprites.length >= minDuplicates;
        const wantTrims = trimMarginOn;
        if (!wantHashes && !wantTrims) continue;
        const bytes = bytesByRef.get(a.atlas.name);
        if (!bytes) continue;
        const res = await hashAtlasFrames(bytes, a.atlas.sprites);
        if (!res) continue; // whole page skipped (caps / decode fail) — both rules honestly never fire for it
        if (wantHashes) frameHashByRef.set(a.atlas.name, res.hashes);
        if (wantTrims) frameTrimByRef.set(a.atlas.name, res.bboxes);
      }
      if (cancelled) return;
    }
    const frameHashes: AtlasFrameHashes[] = [...frameHashByRef].map(([atlasRef, hashes]) => ({
      atlasRef,
      frameHashes: hashes,
    }));
    const frameTrims: AtlasFrameTrims[] = [...frameTrimByRef].map(([atlasRef, bboxes]) => ({
      atlasRef,
      bboxes,
    }));

    // measure format savings (native WebP) so format findings → transcode ops appear; feed the frame-region
    // hashes so the frame-redundancy finding fires (its plan branch emits a repack op for the aliasing) AND the
    // per-frame opaque bboxes so the trim-margin finding fires (its plan branch emits a repack op for the trim).
    const report = await analyze(merged, undefined, {
      missingImages: grouped.missing,
      encodeImage: makeEncoder(bytesByRef),
      ...(features ? { features } : {}),
      ...(frameHashes.length ? { frameHashes } : {}),
      ...(frameTrims.length ? { frameTrims } : {}),
    });

    // Owner/consumer dedup (Feature 1, aggressive only): decide which exact-dup copy is the OWNER (kept,
    // references repointed) and which are CONSUMERS (dropped). Pure + load-order-safe; takes spineRefs
    // (pool separation), the UI lazy/bundle marking, and the skin guard. Plan turns each consumer into an
    // owner-aware `drop` (repointManifest:true for atlas pairs); owners become protected (never targets).
    const dedupGroups =
      opts.aggressive && features
        ? buildDedupGroups(features, spineRefs, opts.marking ?? {}, opts.skinGuard ?? {})
        : undefined;

    // ── Feature 4 (pack loose assets) — group OWNED loose images into deterministic PackGroups (design §4).
    // Gated behind the own "Pack loose" toggle (default OFF ⇒ no groups, no pack ops, byte-identical to
    // today). Re-derived & dir-aware: groupLooseForPacking re-applies shouldAtlas.maxSpriteEdgePx per image
    // (NOT the should-atlas finding's relatedRefs). LooseImage sizes come from the parsed loose-image assets;
    // markers (skeleton .json/.skel) come from the raw files. File→region collisions are surfaced as skips
    // (the colliding region is dropped from its group by buildRegions). planFix excludes any region.ref
    // already in `dropped` (pack owners only) and records each packed ref to guard pass-2 transcode.
    let packGroups: PackGroup[] | undefined;
    const packCollisionSkips: { assetRef: string; reason: string }[] = [];
    if (opts.packLoose) {
      const looseImages: LooseImage[] = [];
      for (const a of merged)
        if (a.kind === 'image') looseImages.push({ ref: a.image.name, size: a.image.size });
      const grouped2 = groupLooseForPacking(looseImages, raw, {
        thresholds: report.thresholds,
        mode: opts.packMode ?? 'auto',
        granularity: opts.packGranularity ?? 'per-leaf-folder',
        forced: opts.packForced ?? false,
      });
      packGroups = grouped2.groups;
      for (const c of grouped2.collisions)
        packCollisionSkips.push({
          assetRef: c.refs.join(' | '),
          reason: `pack skipped: two files map to one region name '${c.name}' — kept the first`,
        });
    }

    // ── Config-driven export profile (round7-export-profile.md §5a, T6) — own Pro toggle, DEFAULT OFF ─────
    // Validate the profile ONCE, fail-closed. Absent ⇒ profileOn stays false ⇒ every path below reproduces
    // today byte-identically. Invalid ⇒ NO emit + an HONEST `(profile)` skipped[] entry per reason (never a
    // silent drop). The profile is MUTUALLY EXCLUSIVE with scaleTiers (buildOptions omits scaleTiers when a
    // profile is sent), so opts.scaleTiers is empty when profileOn — the two never both feed the tier axis.
    let profileOn = false;
    let profileFormats: FormatTarget[] = [];
    let profileTiers: ScaleTier[] = [];
    let profileMulti = false; // >1 format ⇒ the format token disambiguates manifest names (single ⇒ legacy).
    // round10-profile-overrides.md §4/§5: the VALIDATED per-folder/prefix/type overrides (given order; [] when
    // absent/empty). Read from the validation result, NEVER raw opts.exportProfile.overrides, so an invalid
    // override has already failed the whole profile closed above. Empty ⇒ resolveProfileForRef returns the base
    // BY REFERENCE ⇒ byte-identical fan-out (additivity anchor).
    let profileOverrides: ProfileOverride[] = [];
    const profileSkips: { assetRef: string; reason: string }[] = [];
    if (opts.exportProfile) {
      const v = validateProfile(opts.exportProfile);
      if (!v.ok) {
        for (const e of v.errors)
          profileSkips.push({ assetRef: '(profile)', reason: `export profile rejected: ${e}` });
      } else {
        profileFormats = v.formats;
        profileTiers = v.tiers;
        profileMulti = v.formats.length > 1;
        profileOverrides = v.overrides;
        profileOn = true;
      }
    }
    // The profile's global encode knobs (effort/scaleAwareQuality/avif*/pngRecompress) — folded into every
    // formatEncode below. Read from the profile (NOT the legacy top-level opts) when profileOn so the panel's
    // knobs govern the fan-out; falls through harmlessly when profile absent (profileFormats is empty).
    // Typed as FormatEncodeGlobal so resolveProfileForRef and formatEncode consume the SAME bag (no drift).
    const profileGlobal: FormatEncodeGlobal = {
      effort: opts.exportProfile?.effort ?? 0,
      scaleAwareQuality: opts.exportProfile?.scaleAwareQuality ?? false,
      avifQualityAlpha: opts.exportProfile?.avifQualityAlpha,
      avifSubsample: opts.exportProfile?.avifSubsample,
      pngRecompressLevel: opts.exportProfile?.pngRecompressLevel,
    };

    // ── Scale-tier export (design docs/scale-tiers-design.md §5/§7) — own Pro toggle, DEFAULT OFF ─────────
    // Validate the requested ladder ONCE (fail-closed). An invalid/empty ladder arrives at planFix as
    // absent so today's single-scale path reproduces byte-identically. A whole-folder skip flag + the
    // per-asset eligibility predicate (mesh / multi-page Spine / already-tiered gates) are computed here so
    // both planFix (the resize/transcode/dedup guards) and the worker tier loop below share ONE decision.
    // ROUND7 T6: a profile's RESOLUTION axis (profileTiers) feeds the SAME tier multiplier — but ONLY when it
    // carries a real LOWER tier (some scale<1). A format-only profile (single scale-1 top tier) keeps
    // tieringOn=false (B3): the tier loop is NOT entered and fan-out happens in the loose handlers (T8), so a
    // pure-format run is never mislabeled a `tier` op and never trips the dedup-repoint-disable / owner-rename
    // machinery. The profile's tiers are already validated (validateProfile) so we use them directly here.
    const tierReq = opts.scaleTiers ?? [];
    const tierValidation = tierReq.length > 0 ? validateTiers(tierReq) : null;
    const profileHasLowerTier = profileOn && profileTiers.some((tt) => tt.scale < 1);
    const tiers = profileHasLowerTier
      ? profileTiers
      : tierValidation?.ok
        ? tierValidation.tiers
        : [];
    const tieringOn = tiers.length > 0;
    // Whole-folder already-tiered: if any cluster already differs by a resolution token, the folder ships
    // tiers — skip tiering globally (design §8). A png+webp same-size folder does NOT trip this (format
    // tokens are excluded from hasResolutionToken). tierForce (mirrors packForced) bypasses the skip.
    const folderAlreadyTiered =
      tieringOn &&
      !opts.tierForce &&
      merged.some((a) => hasResolutionToken(a.kind === 'atlas' ? a.atlas.name : a.image.name));
    /** Refuse-tiering reason for a ref, or null when it is eligible. Data-driven gates only (design §8/§10):
     *  already-tiered (resolution token in the name), atlases carrying a source mesh (scaleAtlas drops mesh),
     *  and multi-page Spine (per-page emit would clobber one info.path). Loose/single-page-atlas/single-page
     *  Spine are eligible. The result is shared by planFix (excludes eligible refs from resize/transcode) and
     *  the tier loop (a refused ref is surfaced in skipped[] and never tiered). */
    const tierRefusal = (ref: string): string | null => {
      if (!opts.tierForce && hasResolutionToken(ref))
        return 'tier skipped: asset is already a resolution tier';
      const atlas = atlasByRef.get(ref);
      if (atlas) {
        if (atlas.sprites.some((s) => s.mesh))
          return 'tier skipped: meshed atlas not supported (scaleAtlas drops mesh)';
        if (spineRefs.has(ref)) {
          const info = spineInfoOf(ref);
          if (info && info.pages > 1) return 'tier skipped: multi-page Spine not supported in v1';
        }
      }
      return null;
    };
    const tierEligible = (ref: string): boolean => tierRefusal(ref) === null;

    const plan = planFix(
      report,
      {
        targetMime: opts.targetMime,
        quality: opts.quality,
        lossless: true,
        padding: opts.padding,
        maxSize: opts.maxSize,
        maxEdge: opts.maxEdge,
        aggressive: opts.aggressive,
        // Opaque-alpha (round15): forward the Pro toggle so the plan stamps `opaque:true` on the transcode op
        // for every wasted-alpha-flagged loose ref (DISK-only saving, invariant 5). Off ⇒ no op carries opaque.
        opaqueAlpha: opts.opaqueAlpha,
        // Per-image MEASURED best-format pick (round17): forward the Pro toggle so the plan routes each LOOSE
        // `format` transcode op to the winner the diagnosis already measured (params.bestMime) instead of the
        // single global targetMime. Off ⇒ every op carries opts.targetMime ⇒ byte-identical to today.
        bestFormatPerImage: opts.bestFormatPerImage,
        // Frame-redundancy aliasing (round19, B1): forward the toggle so a frame-redundancy finding emits its
        // OWN repack op (the atlas is usually fully packed ⇒ no occupancy repack would schedule it). The
        // aliasing itself is worker-side (alias maps below, threaded into repackAtlases). false ⇒ no new op.
        frameRedundancy: frameRedundancyOn,
        // Trim-margin → repack scheduling (round21 #0): forward the toggle so a trim-margin finding emits its
        // OWN repack op (the padded atlas is usually fully packed ⇒ no occupancy repack would schedule it). The
        // trim itself is worker-side (buildTrimArrays → repackAtlases({trim}), the r20 execute path). false ⇒
        // no new op (and no frameTrims fed above) ⇒ byte-identical to today.
        trimMargin: trimMarginOn,
        isAtlasRef: (ref) => atlasByRef.has(ref),
        // Edge-extrude (bleed, design OPTION A): forward the UI knob. planFix floors it to a non-negative
        // int and STAMPS it onto every repack/pack op (the only ops whose worker compose blits a rectangle
        // the gutter can wrap). 0/absent ⇒ no op carries `extrude` ⇒ byte-identical to today (default OFF).
        ...(opts.extrude && opts.extrude > 0 ? { extrude: opts.extrude } : {}),
        // Only fold tier-eligible refs into the plan's `tiered` guard when the FOLDER isn't already tiered;
        // a globally-skipped folder keeps every asset on its normal single-scale resize/transcode op.
        ...(tieringOn && !folderAlreadyTiered ? { scaleTiers: tiers, tierEligible } : {}),
      },
      dedupGroups,
      packGroups,
    );

    // ── Frame-redundancy alias maps (round19) ──────────────────────────────────────────────────────────
    // Build the per-atlas {representative → [aliasNames]} decision from the raw frame hashes (the finding's
    // flat relatedRefs can't reconstruct clusters — raw hashes are the only source of truth). REUSES the
    // detector's distinct-rect guard (rules.ts) byte-for-byte, so pre-aliased source rects never double-count
    // and the aliasedFrames realized below EQUALS the finding's `dupes`. Threaded into every repackAtlases call
    // (single, merge, Spine). Empty when frameRedundancy is off / no atlas has duplicates ⇒ repackAtlases
    // falls through to today's byte-identical path. Keyed by Atlas.name (= the merged-atlas name hashed above).
    const aliasMinDistinct = report.thresholds.frameRedundancy?.minDuplicates ?? Infinity;
    const aliasMaps: Map<string, AtlasAliasMap> =
      frameRedundancyOn && frameHashByRef.size
        ? buildAtlasAliasMaps(
            merged.flatMap((a) => (a.kind === 'atlas' ? [a.atlas] : [])),
            frameHashByRef,
            aliasMinDistinct,
          )
        : new Map();
    // Cross-atlas frame dedup during MERGE (round22 #1): the gate is the CROSS-ATLAS detector's minDuplicates
    // (cross-sheet duplicate COPIES, default 2 — distinct units beyond the one kept), NOT the within-atlas one.
    // The merge map is built per-op in the merge branch (the group is known there); this is just the shared gate.
    const crossAtlasMinDistinct =
      report.thresholds.crossAtlasRedundancy?.minDuplicates ?? Infinity;

    // ── SELECTIVE FIX (docs/improvements/selective-fix.md) ────────────────────────────────────────────
    // The dev can DESELECT op categories in the dry-run Plan card; the deselected OpKinds arrive in
    // opts.excludeKinds and the worker SKIPS them (no pixel work) while surfacing an honest skipped[] note.
    // `runs(op)` classifies a FixOp through the SHARED fixOpKind (op-manifest.ts — same repack/merge +
    // drop/dedup split as the plan tally + receipt) and returns false when its kind is excluded; the execute
    // loop / Phase A prediction / dedup-drop deferral all gate on it. `tierExcluded` gates the worker-side
    // `tier` multiplier (a gated loop, never a FixOp). ADDITIVE: empty/absent excludeKinds ⇒ everything runs
    // ⇒ byte-identical to today (no behavior change). Deterministic (a Set of OpKind; skip notes ordered by
    // OP_KIND_ORDER via deselectedSkips). The plan-mode short-circuit BELOW honors the SAME mask (design S4):
    // it predicts refs/counts/skips over the SUBSET that still runs, so a re-preview after a toggle reflects
    // the masked plan the committed run will execute (honest preview, not the full plan).
    const excluded = new Set<OpKind>(opts.excludeKinds ?? []);
    const runs = (op: FixOp): boolean => !excluded.has(fixOpKind(op));
    const tierExcluded = excluded.has('tier');
    // The set of OpKinds this run actually has work for (BEFORE exclusion) — so deselectedSkips surfaces a
    // skip ONLY for a deselected kind that WOULD have run, never a phantom skip for a kind with nothing to do.
    // Covers the structured FixOps (via fixOpKind) PLUS the worker-side `tier` multiplier (gated, not a FixOp)
    // when the tier loop would be entered. Deterministic; computed once from the unfiltered plan.
    const wouldRunByKind = new Set<OpKind>(plan.ops.map(fixOpKind));
    if (tieringOn && !folderAlreadyTiered) wouldRunByKind.add('tier');

    // ── per-asset effective encode options (Feature 2, design §4c/§6) ─────────────────────────────────
    // Resolve the EFFECTIVE quality/effort/target per asset: fold the per-folder/per-type overrides onto
    // the request base (resolveOptions, pure), then lower quality on downscaled output (scaleAwareQuality).
    // Defaults reproduce today's behavior: no overrides + scaleAwareQuality off ⇒ base quality/target,
    // effort 0 (fast/native lossy path). quality lives in 0..100 here (the settings vocabulary); encodeCanvas
    // takes a 0..1 fraction, so we divide on the way out.
    const baseEffective: EffectiveOptions = {
      quality: Math.round((opts.quality ?? 0.85) * 100),
      effort: opts.effort ?? 0,
      targetMime: opts.targetMime,
      webpNearLossless: opts.webpNearLossless ?? 100,
      // round7-export-profile.md B1: default false ⇒ today's loose/tier encode path is byte-identical
      // (it never set lossless). A profile's per-format lossless is threaded in via formatEncode (T4).
      lossless: false,
    };
    const kindOf = (ref: string): FixAssetKind =>
      spineRefs.has(ref) ? 'spine' : atlasByRef.has(ref) ? 'pixi' : 'loose';
    // round10-profile-overrides.md §5: the ONE per-ref profile resolution every fan-out site calls. Folds the
    // validated overrides (later-wins) onto the base profileFormats/profileGlobal for THIS ref's kind. No
    // matching override (incl. the empty-overrides case) ⇒ profileFormats/profileGlobal returned BY REFERENCE
    // ⇒ formatEncode runs on the SAME objects as a no-override run ⇒ byte-identical fan-out. Pure/deterministic.
    const resolveProfile = (ref: string) =>
      resolveProfileForRef(ref, kindOf(ref), profileFormats, profileGlobal, profileOverrides);
    /** Effective encode options for a loose-image op at `ref`, optionally downscaled by `scale` (1 = none). */
    const effectiveFor = (ref: string, scale: number): EffectiveOptions => {
      const e = resolveOptions(ref, kindOf(ref), baseEffective, opts.overrides);
      return {
        ...e,
        quality: scaleAwareQuality(e.quality, scale, opts.scaleAwareQuality ?? false),
      };
    };
    /** Effective options for a TRANSCODE op, honoring its per-op `targetMime` as the resolve BASE (round17,
     *  per-image MEASURED best-format pick). When bestFormatPerImage is ON the plan stamped the op with the
     *  format the diagnosis already measured smallest (params.bestMime); we feed that as the base so it
     *  REPLACES the global default — while a user's per-folder/type override (resolveOptions, later-wins) still
     *  WINS over it (honest precedence: explicit user override > auto-measured per-image default). When the opt
     *  is OFF, `op.targetMime === opts.targetMime` for every op, so this === effectiveFor(ref, 1) (scale 1 ⇒
     *  scaleAwareQuality is a no-op) ⇒ byte-identical to today. No downscale here (transcode never resizes). */
    const effectiveForTranscode = (ref: string, opMime: ImageMime): EffectiveOptions =>
      resolveOptions(ref, kindOf(ref), { ...baseEffective, targetMime: opMime }, opts.overrides);
    /** Build the encodeCanvas opts for a resolved per-asset EffectiveOptions (quality 0..100 → 0..1). */
    const encOptsFor = (e: EffectiveOptions, allowPngFallback: boolean): EncodeOpts => ({
      quality: e.quality / 100,
      effort: e.effort,
      webpNearLossless: e.webpNearLossless,
      avifQualityAlpha: opts.avifQualityAlpha,
      avifSubsample: opts.avifSubsample,
      pngRecompressLevel: opts.pngRecompressLevel,
      allowPngFallback,
    });
    /** Build the encodeCanvas opts for a profile FormatEncode (round7-export-profile.md §5c/§5d, T7/T8): map
     *  the pure FormatEncode (quality 0..100, threaded lossless B1, per-format knobs) onto EncodeOpts (quality
     *  0..1). allowPngFallback is ALWAYS true here — a fan-out target that can't encode degrades to PNG (the
     *  B4 collision guard then de-dups same-mime fallbacks). The per-format avif/png knobs are forwarded ONLY
     *  for their owning codec (formatEncode already nulled the others), so a stray knob never reaches a codec. */
    const feToEncodeOpts = (fe: FormatEncode): EncodeOpts => ({
      quality: fe.quality / 100,
      lossless: fe.lossless,
      effort: fe.effort,
      webpNearLossless: fe.webpNearLossless,
      avifQualityAlpha: fe.avifQualityAlpha,
      avifSubsample: fe.avifSubsample,
      pngRecompressLevel: fe.pngRecompressLevel,
      allowPngFallback: true,
    });

    // ── DRY-RUN PLAN SHORT-CIRCUIT (docs/improvements/dry-run-plan-preview.md) ──────────────────────────
    // mode 'plan': everything above (parse + analyze + planFix + the PIXEL-FREE gates) has already run. NOTE
    // it is NOT zero-pixel: the format-sizing pass (makeEncoder, line 189) decodes + WebP/AVIF-encodes every
    // image to SIZE format findings → transcode counts, and aggressive mode runs computeFeatures (line 187,
    // SHA-256 + dHash getImageData) for the dedup tally — both are the SAME pre-loop costs the execute path
    // pays anyway. What plan SKIPS is the heavy half: the compose/pack/repack/resize/tier PIXEL LOOP + zip.
    // Assemble the deterministic gate facts the summary needs (op counts from the structured plan; the
    // would-be-skips + the reference-changing prediction + the tier UPPER BOUND from the plan ops × the pure
    // gates), post the `fix-plan` summary, and STOP before the pixel loop. mode 'execute' (the default) falls
    // straight through ⇒ byte-identical to today. HONESTY (invariant 5): the summary carries op COUNTS only —
    // no byte/VRAM number is computed here.
    // SELECTIVE FIX (design S4): this block honors the SAME mask the execute path does — every prediction
    // below gates on runs()/tierExcluded, so the previewed opCounts / referencesChanged / skipped reflect the
    // SUBSET the committed run will execute, and deselectedSkips() appends one honest note per deselected kind.
    // Empty/absent excludeKinds ⇒ runs() always true, tierExcluded false, no notes ⇒ byte-identical to today.
    if (mode === 'plan') {
      // Refs a repack/merge/pack op claims (mirrors the execute path's `tierTransformed`): their emitted
      // sheet is not re-fed into tiering in v1, so the tier loop would surface an honest skip, not a tier.
      const planTransformed = new Set<string>();
      // Refs a drop op removes (legacy or owner-aware) and refs a resize/transcode op replaces — neither is
      // ever ALSO tiered (plan.ts already excluded resize/transcode refs from its `tiered` guard).
      const planDropped = new Set<string>();
      const planReplaced = new Set<string>();
      let predictRefsChanged = false;
      for (const op of plan.ops) {
        // SELECTIVE FIX (design S4): a DESELECTED op does no work at execute, so it must NOT drive the
        // transformed/dropped/replaced tracking NOR the reference-changing prediction. Mask with runs(op) —
        // empty/absent excludeKinds ⇒ runs() always true ⇒ today's full-plan prediction, byte-identical.
        if (!runs(op)) continue;
        if (op.kind === 'repack') {
          for (const rf of op.atlasRefs) planTransformed.add(rf);
          if (op.atlasRefs.length > 1) predictRefsChanged = true; // a merge rewrites manifest references
        } else if (op.kind === 'pack') {
          for (const r of op.group.regions) planTransformed.add(r.ref);
          predictRefsChanged = true; // building a sheet is reference-changing (the game must load the sheet)
        } else if (op.kind === 'drop') {
          planDropped.add(op.assetRef);
          predictRefsChanged = true; // dedup repoint / removing a file changes the folder's references
        } else if (op.kind === 'resize' || op.kind === 'transcode') {
          planReplaced.add(op.assetRef);
          // A LOOSE image whose emitted ext differs from the source is renamed ⇒ NOT drop-in (conservative:
          // a PNG fallback can still resolve drop-in at execute — disclosed in the deferred-checks note).
          if (!atlasByRef.has(op.assetRef)) {
            const path = pathByRef.get(op.assetRef);
            if (path && renamedTo(path, effectiveFor(op.assetRef, 1).targetMime) !== path)
              predictRefsChanged = true;
          } else if (op.kind === 'transcode') {
            // round20 #1: a prebuilt-ATLAS passthrough transcode renames the page by extension and repoints its
            // sidecar ⇒ NOT a stable-name drop-in (the execute block sets referencesChanged unconditionally).
            // Conservative: an encode-unavailable / size-loss skip can still drop in, disclosed via deferred-checks.
            const path = pathByRef.get(op.assetRef);
            if (path && renamedTo(path, effectiveForTranscode(op.assetRef, op.targetMime).targetMime) !== path)
              predictRefsChanged = true;
          }
        }
      }

      // Pixel-free would-be-skips, in the same deterministic order the execute path surfaces them (limited to
      // the subset knowable WITHOUT composing pixels). Pixel-dependent skips (polygon-no-win, near-dup dHash,
      // codec-unavailable, post-compose name-collision, …) are NOT predicted — they surface only at execute.
      const planSkips: { assetRef: string; reason: string }[] = [];
      // ROUND7 T6: an invalid export profile is rejected up front (no emit) — surface its honest `(profile)`
      // reasons FIRST so the preview mirrors the execute receipt's leading entries.
      for (const s of profileSkips) planSkips.push(s);
      for (const s of packCollisionSkips) planSkips.push(s); // execute pushes these first (file→region collisions)
      // Multi-page Spine single-atlas repack refusal — determinable pre-compose via spineInfoOf (the execute
      // repack branch refuses a >1-page Spine before any pixel work).
      for (const op of plan.ops) {
        if (op.kind !== 'repack' || op.atlasRefs.length !== 1) continue;
        if (!runs(op)) continue; // deselected repack ⇒ no repack runs ⇒ no per-op repack skip (deselectedSkips covers it)
        const ref = op.atlasRefs[0]!;
        if (!spineRefs.has(ref)) continue;
        const info = spineInfoOf(ref);
        if (info && info.pages > 1)
          planSkips.push({ assetRef: ref, reason: 'multi-page Spine repack not supported in v1' });
      }
      // Owner-aware dedup would-be-skips (Phase C, fix.worker.ts:1118-1203) — Phase C turns a subset of the
      // owner-aware drop ops into NO-OP keeps for PIXEL-FREE, plan-determinable reasons (drops nothing). They
      // must NOT be counted as `dedup` (they perform zero dedup) and must surface here as skips, in Phase C's
      // emission order (after Phase B transforms, before the tier multiplier). The PIXEL-DEPENDENT keep —
      // owner final name diverged via a transcode PNG-fallback (line 1137) — is NOT predicted here. Kept
      // consumers are also un-marked from `planDropped` (their source survives ⇒ the tier loop CAN tier them,
      // matching execute). `countedOps` is the plan with these no-op dedup drops removed → summarizeOpCounts
      // tallies only the drops that actually dedup, so the count matches what execute would do.
      const dedupSkipped = new Set<FixOp>();
      for (const op of plan.ops) {
        if (!isOwnerAwareDrop(op)) continue;
        if (!runs(op)) continue; // deselected dedup ⇒ Phase C drops nothing ⇒ no keep-consumer skip (deselectedSkips covers it)
        const consumerRef = op.assetRef;
        const reason = dedupKeepConsumerSkip(basename(op.ownerRef!), {
          keepConsumer: op.keepConsumer ?? false,
          repointManifest: op.repointManifest ?? false,
          isSpine: spineRefs.has(consumerRef),
          hasManifest: manifestPathOf(consumerRef) != null,
          isAtlas: atlasByRef.get(consumerRef) != null,
        });
        if (reason !== null) {
          planSkips.push({ assetRef: consumerRef, reason });
          dedupSkipped.add(op);
          planDropped.delete(consumerRef); // kept ⇒ source survives ⇒ tier-eligible like execute
        }
      }
      // SELECTIVE FIX (design S4): count only the ops the committed run will actually execute — drop the
      // no-op keep-consumer dedup drops AND every DESELECTED op (runs()). Empty/absent excludeKinds ⇒ runs()
      // always true ⇒ exactly today's `plan.ops` (minus the keep-consumer no-ops), byte-identical.
      const countedOps = plan.ops.filter((op) => !dedupSkipped.has(op) && runs(op));
      // Tier gates (same emission as the tier multiplier loop, pixel-free subset). DESELECTING `tier` gates the
      // whole multiplier off (tierExcluded), so its tier count AND its tier-context skips (folder-already-tiered,
      // dedup-disabled, per-asset refusals/transformed) are all suppressed — they describe tiering that won't run.
      let tierAssets = 0;
      if (tieringOn && !tierExcluded && folderAlreadyTiered) {
        planSkips.push({
          assetRef: '(folder)',
          reason: 'tier skipped: folder already ships resolution tiers',
        });
      }
      if (
        tieringOn &&
        !tierExcluded &&
        !folderAlreadyTiered &&
        opts.aggressive &&
        dedupGroups &&
        dedupGroups.length > 0
      ) {
        planSkips.push({
          assetRef: '(dedup)',
          reason: 'dedup repoint disabled: scale tiering renames owners (kept duplicate consumers)',
        });
      }
      if (tieringOn && !tierExcluded && !folderAlreadyTiered) {
        for (const a of merged) {
          const ref = a.kind === 'atlas' ? a.atlas.name : a.image.name;
          const refusal = tierRefusal(ref);
          if (refusal) {
            planSkips.push({ assetRef: ref, reason: refusal });
            continue;
          }
          // Repacked/merged/packed assets are surfaced (their sheet isn't tiered in v1); transformed/
          // dropped/replaced refs are never tiered ⇒ excluded from the upper-bound count.
          if (planTransformed.has(ref)) {
            planSkips.push({
              assetRef: ref,
              reason:
                'tier skipped: asset was repacked/merged/packed (its sheet is not tiered in v1)',
            });
            continue;
          }
          if (planDropped.has(ref) || planReplaced.has(ref)) continue;
          tierAssets++; // UPPER BOUND — tiering can still be refused at compose time (no 2D context / encode)
        }
      }
      if (tieringOn && tierAssets > 0) predictRefsChanged = true; // tiering renames the source ⇒ reference-changing

      // SELECTIVE FIX (design S4): surface ONE honest "<kind> skipped: deselected in plan" note per deselected
      // kind that WOULD have run — the SAME deterministic (OP_KIND_ORDER) emitter the execute path appends to
      // the receipt, so the preview's skip list mirrors the committed run. Empty mask ⇒ no notes ⇒ today.
      for (const s of deselectedSkips(excluded, wouldRunByKind)) planSkips.push(s);

      const gate: PlanGateInputs = {
        ops: countedOps,
        tierAssets,
        skipped: planSkips,
        referencesChanged: predictRefsChanged,
      };
      // HONEST footprint preview (round22 #2): sum ONLY pre-compose-knowable disk/VRAM deltas off the
      // SURVIVING countedOps (transcode/opaque disk · oversize×resize VRAM); everything else (repack/merge/
      // pack/dedup) is a count. The scale-tier multiplier is a worker-side per-asset op (NOT a FixOp), so
      // fold its upper bound into the deferred count when tiering survives the mask — it contributes 0 to
      // disk/VRAM (invariant 5: the runtime loads ONE tier; the top tier == the source footprint).
      const footprint = summarizeFixPlanFootprint(report, countedOps, excluded);
      if (footprint && !tierExcluded && tierAssets > 0) footprint.deferredOps += tierAssets;
      if (cancelled) return; // superseded — suppress a fix-plan that would race the terminate
      post({ type: 'fix-plan', summary: { ...summarizePlan(gate), ...(footprint ? { footprint } : {}) } });
      return;
    }

    // ── execute ──
    const out: { path: string; bytes: Uint8Array }[] = [];
    // Sheet-diff X-ray (docs/improvements/round6-f1-sheet-diff.md): a before/after FilmViewer pair per
    // repack/merge/pack-page/Spine-repack op that successfully composes. CAPPED at the first SHEET_DIFF_MAX;
    // sheetDiffsTotal counts ALL composed so the UI can say "showing N of M". The bytes are transferred to
    // the main thread. Empty ⇒ both fields spread-omitted ⇒ receipt byte-identical to today.
    const sheetDiffs: SheetDiff[] = [];
    let sheetDiffsTotal = 0;
    /** Capture one composed sheet's before/after proof. `beforeRef` = the source atlas/loose ref (its bytes
     *  live in bytesByRef); `beforeDims` = the source pixel size; `afterAtlas` = the emitted Atlas (occupancy
     *  + dims + zones); `afterBytes` = the emitted page bytes; `beforeAtlas` (optional) = the source atlas for
     *  occBefore (absent ⇒ occBefore=0, the honest "0% packed" for a pack page with no source atlas). ALWAYS
     *  bumps sheetDiffsTotal; only pushes within the cap + per-side byte budget. Copies BOTH buffers so the
     *  live source/emitted buffers (still headed to the zip) survive the transfer. */
    const captureSheetDiff = (
      beforeRef: string,
      beforeDims: Size,
      afterAtlas: Atlas,
      afterBytes: Uint8Array,
      afterName: string,
      beforeAtlas?: Atlas,
    ): void => {
      sheetDiffsTotal++;
      const before = bytesByRef.get(beforeRef);
      if (!before) return;
      // PURE cap decision (count cap + per-side byte budget) — shared with the headless test so the worker
      // and its proof can't drift. The total above is always bumped; this gates only what is RETAINED.
      if (!canKeepSheetDiff(sheetDiffs.length, before.byteLength, afterBytes.byteLength)) return;
      const proof = sheetGeometryProof(afterAtlas);
      sheetDiffs.push({
        name: afterName,
        // Copy BOTH: before is a live source buffer (still readable for the zip / other ops); after is the
        // emitted Uint8Array also pushed to `out` → zip. slice() yields a fresh exact-length buffer to transfer.
        beforeBytes: before.slice(0),
        afterBytes: afterBytes.slice().buffer,
        beforeWxH: { w: beforeDims.w, h: beforeDims.h },
        afterWxH: { w: afterAtlas.size.w, h: afterAtlas.size.h },
        occBefore: beforeAtlas ? occupancyValue(beforeAtlas) : 0,
        occAfter: proof.occ,
        vramBefore: beforeDims.w * beforeDims.h * 4,
        vramAfter: afterAtlas.size.w * afterAtlas.size.h * 4,
        afterZones: proof.zones,
        // NEW (additive): packed frame rects the MAIN-thread render-probe (sheet-probe-run.ts) replays
        // through real offscreen WebGL. beforeFrames absent for a pack page (no source atlas ⇒ no honest
        // "before", mirrors occBefore=0); afterFrames always present. Plain integer Rect objects ⇒
        // structured-cloned, NOT added to the transfer list below (they are not ArrayBuffers).
        ...(beforeAtlas ? { beforeFrames: beforeAtlas.sprites.map((s) => s.frame) } : {}),
        afterFrames: afterAtlas.sprites.map((s) => s.frame),
      });
    };
    // Input file paths — the collision pre-check (Feature 4, design §6 step 1) asserts a synthesized
    // sheet/page/JSON/.atlas path never overwrites an existing input or an already-emitted output.
    const inputPaths = new Set(files.map((f) => f.path));
    const replaced = new Set<string>();
    const dropped = new Set<string>();
    // ── PixiJS-v8 asset manifest (round8-pixi-manifest.md) — GATED collector ──────────────────────────
    // Opt-in (default OFF). When OFF the map is NEVER allocated and recordVariant is a no-op ⇒ no behavior
    // change ⇒ dedupedOut unchanged ⇒ zip byte-identical. When ON, recordVariant is called at the VERIFIED
    // out.push sites with the POST-FALLBACK enc.mime path so the manifest can only reference files that exist.
    // The builder groups one ManifestAsset's variants by suffix (one entry per resolution tier — Pixi #10108);
    // ref is the map key so all of an asset's tiers/formats accumulate into a single ManifestAsset.
    const manifestOn = opts.emitPixiManifest === true;
    const manifestAssets = manifestOn ? new Map<string, ManifestAsset>() : undefined;
    // ── Content-hash cache-busting (round9-cache-busting.md K3) — GATED. ──────────────────────────────────
    // OFF (the default) ⇒ hashOn false ⇒ every hashing branch short-circuits (hashedName / shortHash never
    // called, imageRef keeps today's value, emitted paths unchanged) ⇒ dedupedOut unchanged ⇒ zip byte-
    // identical to today. ON ⇒ each emitted image/sheet AD references gets `.<8hex>.ext` (hash = sha256 of the
    // FINAL emitted bytes) and EVERY referrer is repointed (atlas meta.image / Spine .atlas line 0 / the Pixi
    // manifest src[] / dedup consumer meta.image / the loader-migration rows) — no broken reference chain.
    const hashOn = opts.hashFilenames === true;
    // §6.4 collision tracking: the FULL sha256 of the bytes already emitted at each hashed path. 8-hex over
    // the SAME stem makes a different-bytes collision ~1e-9, but if one occurs (a hashed path repeats with
    // DIFFERENT bytes) we widen the colliding file to the full sha256 + surface an honest note rather than let
    // dedupedOut clobber it. An IDENTICAL-bytes re-emit at the same path (a true dup of the same sheet) maps to
    // the same full hash ⇒ NO widen (dedupedOut collapses it to one). Maps emitted path → its full content hash.
    const emittedHashedPaths = new Map<string, string>();
    // Compute the hashed emit path for `path` from its FINAL `bytes`, register it for collision tracking, and
    // return it. OFF ⇒ returns `path` unchanged (never hashes). Deterministic: same bytes ⇒ same name. On the
    // astronomically-rare DIFFERENT-bytes/same-8-hex-name collision, widen to the full 64-hex sha256 (still
    // deterministic) and surface an honest skip note — never silently overwrite a distinct file.
    const hashEmit = async (path: string, bytes: Uint8Array): Promise<string> => {
      if (!hashOn) return path;
      // The short (8-hex) hash names the file; the FULL (64-hex) hash is the collision discriminator stored in
      // the map (two different byte streams that collide on the same 8-hex share that 8-hex by definition, so
      // only the full hash can tell a true identical-bytes dup from a real collision).
      const short = await shortHash(bytes);
      const full = await sha256Hex(
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : (bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer),
      );
      let emitted = hashedName(path, short);
      const prior = emittedHashedPaths.get(emitted);
      if (prior !== undefined && prior !== full) {
        // Same 8-hex name, DIFFERENT bytes (a real collision) — widen this file to the full 64-hex hash so
        // dedupedOut's last-write-wins never clobbers a distinct file. (prior === full ⇒ true identical-bytes
        // dup ⇒ keep the 8-hex name; dedupedOut collapses the pair to one entry — correct.)
        emitted = hashedName(path, full);
        skipped.push({
          assetRef: path,
          reason: 'cache-bust: 8-hex name collided with different bytes — widened to full hash',
        });
      }
      emittedHashedPaths.set(emitted, full);
      return emitted;
    };
    const recordVariant = (
      ref: string,
      kind: ManifestAssetKind,
      source: string,
      v: EmittedVariant,
    ): void => {
      if (!manifestAssets) return;
      let a = manifestAssets.get(ref);
      if (!a) {
        a = { ref, kind, source, variants: [] };
        manifestAssets.set(ref, a);
      }
      a.variants.push(v);
    };
    // ── OPT-IN backend native KTX2 (round12-backend-processing.md, Phase 3) — GATED collector ─────────────
    // SAFETY (load-bearing): the path is LIVE only when opts.backend is present AND consented AND ≥1 op opted
    // in. ABSENT/declined ⇒ `backendOn` is false ⇒ recordKtx2Candidate is a no-op ⇒ the candidates array is
    // never populated ⇒ the post-pass below is skipped ⇒ `out` is unchanged ⇒ zip BYTE-IDENTICAL to today.
    // The browser fix stays the default; KTX2 is an additive native-only sibling page, never a replacement.
    const backendOn =
      opts.backend != null &&
      opts.backend.consent === true &&
      opts.backend.ops.includes('ktx2') &&
      opts.backend.apiBase.trim() !== '' &&
      opts.backend.token.trim() !== '';
    // One emitted RASTER page the backend MAY also produce as .ktx2. `imagePath` = the page image already in
    // `out` (KEPT — KTX2 is ADDITIVE, never a replacement); `pageBytes`/`pageMime` = the emitted raster page
    // (the post-pass re-decodes it to a lossless PNG source the sidecar transcodes, so the .ktx2 matches the
    // browser page); `w/h` = page dims (for the honest VRAM ceiling); `atlasSidecar` (atlas pages only) =
    // { path, atlas } so the post-pass can emit a SECOND `.ktx2.json` sidecar (round8: a multi-format atlas
    // needs TWO json sidecars, not a multi-format `src` array).
    interface Ktx2Candidate {
      ref: string;
      imagePath: string;
      pageBytes: Uint8Array;
      pageMime: ImageMime;
      w: number;
      h: number;
      atlasSidecar?: { path: string; atlas: Atlas };
    }
    const ktx2Candidates: Ktx2Candidate[] = [];
    // Record a candidate ONLY when the backend path is live. A no-op when backendOn is false (the default) ⇒
    // no allocation, no behavior change. Deterministic: candidates are processed in push order in the post-pass.
    const recordKtx2Candidate = (c: Ktx2Candidate): void => {
      if (!backendOn) return;
      ktx2Candidates.push(c);
    };
    // ── OPT-IN backend native pngquant (round13-pngquant-backend.md, Phase 3) — GATED collector ───────────
    // Same gate shape as backendOn, but for the 'pngquant' op. SAFETY (load-bearing): pngquantOn false ⇒
    // recordPngquantCandidate is a no-op ⇒ the candidates array stays empty ⇒ the post-pass below never runs ⇒
    // `out` is unchanged ⇒ zip BYTE-IDENTICAL to today. Unlike KTX2 (an ADDITIVE sibling .ktx2), pngquant is an
    // IN-PLACE post-pass: it REPLACES the already-composed PNG page's bytes at the SAME path (B4, via the
    // pre-zip Map last-write-wins) — NO new file, NO referencesChanged, NO VRAM field (disk-only; a quantized
    // PNG still decodes to full RGBA8888 on the GPU ⇒ vramCeiling unchanged, invariant 5).
    const pngquantOn =
      opts.backend != null &&
      opts.backend.consent === true &&
      opts.backend.ops.includes('pngquant') &&
      opts.backend.apiBase.trim() !== '' &&
      opts.backend.token.trim() !== '';
    // One emitted PNG page eligible for in-place pngquant re-compression. `path` = the exact emitted page path
    // already in `out` (the post-pass REPLACES the bytes here, never adds a file); `bytes` = the composed
    // lossless PNG bytes (pngquant re-encodes THESE, so the disk delta is real + the pixels match the browser
    // page); `w/h` = page dims (only the upload envelope needs them — pngquant adds NO VRAM accounting). Only a
    // `nativePng`-marked PNG target (FormatTarget.pngLossy) records here, so the export-profile produces the
    // PNG and pngquant merely re-compresses its bytes — clean deterministic either/or (no double-emit/race).
    interface PngquantCandidate {
      ref: string;
      path: string;
      bytes: Uint8Array;
      w: number;
      h: number;
    }
    const pngquantCandidates: PngquantCandidate[] = [];
    const recordPngquantCandidate = (c: PngquantCandidate): void => {
      if (!pngquantOn) return;
      pngquantCandidates.push(c);
    };
    // round13 finding [0]: pngquant is SCOPED to single-tier loose pages in v1 (it is a page re-compressor; an
    // atlas sheet / a per-tier downscale is out of scope). The candidate is therefore recorded ONLY in
    // emitLooseProfileFanout. But a `nativePng`-marked PNG can also flow through the MULTI-TIER loop (a profile
    // with a lower tier, or any atlas/Spine page) — there the lossless PNG ships WITHOUT a pngquant attempt.
    // Per invariant 3 (never a silent skip) that decline must be SURFACED, not dropped: emit ONE honest
    // skipped[] note per ref (mirroring the tier loop's other v1-scope notes — Spine-stays-PNG :2034,
    // tierTransformed :2011). Gated on pngquantOn so backend-off stays byte-identical. Once-per-ref via this set.
    const pngquantTierSkipNoted = new Set<string>();
    // ── OPT-IN libvips lanczos3 resample (round24-libvips-lanczos3-resample-op-sidecar.md) — GATED collector ─
    // SAFETY (load-bearing): the resample path is LIVE only when the user configured a backend AND ticked
    // per-run consent AND opted the `resample` op in AND a host+token exist — the SAME opt-in shape as the
    // KTX2/pngquant gates — AND (B1) hashFilenames is OFF. The gate lives in the PURE resampleOn predicate
    // (Node-tested) so it can't drift. FALSE ⇒ recordResampleCandidate is a no-op ⇒ the candidates array stays
    // empty ⇒ the post-pass never runs ⇒ the existing OffscreenCanvas tier downscale's output is BYTE-IDENTICAL
    // to today. resample is an IN-PLACE tier replace (the produced tile is the SAME dims/format/path the
    // browser would have emitted — DISK/QUALITY-only, NO new file, NO referencesChanged, NO VRAM/disk claim);
    // the ONLY thing it carries is a MEASURED high-frequency-energy retention delta.
    //
    // B1 (cache-busting integrity, the central skeptic blocker): an in-place tile replace under content-hash
    // names would leave the filename's hash describing the OLD (browser) bytes ⇒ content/hash mismatch that
    // defeats round9. v1 takes the simpler accepted route: resampleOn is FALSE when hashFilenames is on, so the
    // in-place replace below is only ever reached on the byte-stable (hashOff) path. When resample WOULD be
    // eligible but is suppressed solely by hashFilenames, surface ONE honest skip note (invariant 3 — never a
    // silent no-op).
    const resampleEnabled = resampleOn({ backend: opts.backend, hashFilenames: opts.hashFilenames });
    // One emitted tier the backend MAY re-downscale with lanczos3. `srcBytes` = the FULL-RES source page bytes
    // (the post-pass PNG-re-encodes these and uploads them — the asymmetry vs ktx2/pngquant, which upload the
    // already-downscaled page); `targetW/H` = the EXACT tier dims the browser composed (the vips OUTPUT box);
    // `browserTile` = the browser tile's RGBA ImageData (captured once per tier, for the HF-energy measure);
    // `targets` = each (path, mime, encOpts) variant emitted at this tier — the post-pass re-encodes the vips
    // bitmap to each + replaces `out` at the SAME path. hashOff guarantees the path is byte-stable (B1).
    interface ResampleTarget {
      path: string;
      mime: ImageMime;
      encOpts: EncodeOpts;
    }
    interface ResampleCandidate {
      ref: string;
      srcBytes: ArrayBuffer;
      targetW: number;
      targetH: number;
      browserTile: ImageData;
      targets: ResampleTarget[];
    }
    const resampleCandidates: ResampleCandidate[] = [];
    const recordResampleCandidate = (c: ResampleCandidate): void => {
      if (!resampleEnabled) return;
      resampleCandidates.push(c);
    };
    // round24 B1 honest-skip: resample WOULD be eligible (backend + consent + op opted in) but is suppressed
    // SOLELY by hashFilenames (an in-place tile replace under content-hash names would break round9). Surface
    // ONE note per downscaled-tier ref (invariant 3 — never a silent no-op). Once-per-ref via this set.
    const resampleHashSkipPending = resampleSkippedByHashFilenames({
      backend: opts.backend,
      hashFilenames: opts.hashFilenames,
    });
    const resampleHashSkipNoted = new Set<string>();
    const skipped: { assetRef: string; reason: string }[] = [];
    // ROUND7 T6: an invalid export profile rejected above ⇒ no emit + honest `(profile)` reasons. Seed
    // `skipped` with them so the receipt is honest (never a silent drop). Valid/absent profile ⇒ empty.
    for (const s of profileSkips) skipped.push(s);
    const operations: string[] = [];
    let referencesChanged = false;
    // Loader-migration guide (docs/improvements/loader-migration.md): accumulate ONLY genuine loader-CALL
    // changes here — merge/pack (old refs → the new manifest SET), tier (source load target → the tier
    // ladder), loose resize/transcode RENAME (logo.png → logo.webp), bare drop (removal). DEDUP IS EXCLUDED
    // (B1: it rewrites the consumer manifest in place ⇒ the load call is unchanged). Pushed in execution
    // order; finalizeChanges sorts/dedups before the receipt. Empty ⇒ `changes` omitted (byte-identical).
    const changeRows: FixChange[] = [];
    // Owner-aware dedup receipt counters (Feature 1 / Tasks 6+7). DISK saving is REAL; VRAM saving is an
    // UPPER BOUND (only realized if the runtime shares one GPU upload across the dropped copies) — reported
    // as a SEPARATE flagged field, never folded into the hard vramBytesAfter claim (invariant 5).
    let referencesRewritten = 0;
    let looseRepathSkipped = 0;
    let dedupDiskBytesSaved = 0;
    let dedupVramBytesSavedUpperBound = 0;
    // Feature 4 (pack loose) receipt counters. packedGroups/packedSheetCount/packedRegionCount feed
    // FixReceipt.packedSheets; packVerified/packUnmatched/packUnverified feed FixReceipt.packVerification.
    // Building a sheet is reference-changing ⇒ referencesChanged is also set (NOT a blind drop-in).
    let packedGroups = 0;
    let packedSheetCount = 0;
    let packedRegionCount = 0;
    // Pack VRAM delta (new sheet footprint − summed loose footprint). NEVER folded into the headline
    // vramBytesAfter (invariant 5 / design §6.8): packing NPOT loose images into POT sheets with padding
    // routinely RAISES VRAM, so this is frequently positive (an increase). Reported SEPARATELY as "sheets
    // add X MB VRAM (POT padding); the win is fewer draw calls/binds", mirroring dedupVramBytesSavedUpperBound.
    let packVramDelta = 0;
    let packVerified = 0;
    let packUnmatched = 0;
    let packUnverified = 0;
    // Edge-extrude (bleed) receipt counters (design OPTION A). extrudePxApplied = the requested width (the
    // first op that actually extrudes records it); extrudedBlits = rectangle blits that got a bleed;
    // extrudeSkipped = blits where extrude was REQUESTED but skipped (meshed clip / rotated — no polygon-edge
    // extrude in v1). extrudeVramDelta = HONEST VRAM growth from the symmetric gutter pushing a bin to the
    // next POT (invariant 5: a gutter CAN grow a sheet ⇒ MORE VRAM — never claimed free; ALSO reflected in
    // vramBytes* via vramSaved). All 0/absent unless extrude>0 actually ran ⇒ receipt byte-identical to today.
    let extrudePxApplied = 0;
    let extrudedBlits = 0;
    let extrudeSkippedCount = 0;
    let extrudeVramDelta = 0;
    // dir-aware blit ids already surfaced as an extrude no-op skip — surface each meshed/rotated blit's
    // skip at most once per op group (mirrors rotatedSkipped's once-only honesty for mesh skips).
    const extrudeSkipped = new Set<string>();
    // Scale-tier receipt counters (design §5/§6). tieredAssets/tierFilesEmitted count ONLY assets actually
    // tiered (refused/skipped assets excluded). tierVramBytes[i] = Σ w×h×4 of tiered assets AT tier i — the
    // honest "VRAM if the device picks this tier" ladder; NEVER folded into vramBytesAfter (invariant 5),
    // and tiering contributes 0 to vramSaved (the top tier == the source footprint, tiers are alternatives).
    let tieredAssets = 0;
    let tierFilesEmitted = 0;
    const tierVramBytes = tiers.map(() => 0);
    // ── Config-driven export-profile receipt counters + format-only ownership (round7-export-profile.md
    //    §5d/§9, T8/T9) ──. profileAssets = assets fanned out across formats×tiers; profileFilesEmitted =
    // total variant files emitted (image + manifest/skeleton). DISK-only — the runtime loads ONE format ×
    // ONE tier, so this never folds into vramBytesAfter (invariant 5). `profileOwned` records refs the
    // format-only fan-out (T8) emitted from the loose transcode/resize handlers, so the standalone op is NOT
    // ALSO run (double-emit guard) WITHOUT disabling dedup repoint (B3 — first-class, not a `_1x` tier hack).
    let profileAssets = 0;
    let profileFilesEmitted = 0;
    const profileOwned = new Set<string>();
    // Refs claimed by a repack / atlas-merge / Feature-4 pack pass. In v1 the tier loop runs over the
    // PRE-transform asset list (`merged`), so a repacked/merged/packed asset's EMITTED sheet is not re-fed
    // into tiering (design §7 scopes this out for v1). Tracking the refs here lets the tier loop surface an
    // HONEST skipped[] note instead of a silent no-op on the headline case (an under-filled atlas the user
    // enabled tiers on gets repacked → no tiers). Empty unless a repack/merge/pack op runs.
    const tierTransformed = new Set<string>();
    // Surface file→region collisions detected during grouping (a region dropped from its group).
    for (const s of packCollisionSkips) skipped.push(s);

    // ── TWO-PHASE OWNER-NAME RESOLUTION (design §3d) ──────────────────────────────────────────────────
    // Owner-aware drops repoint a consumer's references at the OWNER's FINAL emitted name — but an owner
    // can itself be transcoded (renamed by extension) in the same run. So we (A) compute every retained
    // owner's expected FINAL name from the PLAN before executing anything, (B) execute transforms and
    // record each owner's ACTUAL emitted name, then (C) execute consumer drops against the actual map,
    // KEEPING the consumer (never dangling) if an owner's actual name diverged from the prediction.
    // Phase A — plan-predicted FINAL name per retained owner, computed by the PURE predictOwnerFinalNames
    // (@asset-doctor/fix). Owners are protected from repack/resize/merge in plan.ts, so the ONLY rename-
    // producing op that can hit an owner is `transcode` (ext swap → the EFFECTIVE target, since per-folder/
    // type overrides may redirect it). The lookup callback hands the helper the worker's own path/manifest/
    // op facts so the helper stays browser-API-free. Same logic the Node round-trip test drives.
    const ownerFinalName = predictOwnerFinalNames(dedupGroups, (ref) => {
      const op = plan.ops.find((o) => 'assetRef' in o && o.assetRef === ref);
      // Selective fix: a DESELECTED transcode op will NOT rename this owner at execute, so it must NOT be
      // predicted as transcoded — else the owner's actual name (original) would diverge from the prediction
      // (renamed) and Phase C would silently degrade an otherwise-running dedup to keep-consumer. Mask with
      // runs(op). When transcode is NOT excluded this is exactly today's `op?.kind === 'transcode'`.
      const transcoded = op?.kind === 'transcode' && runs(op);
      // round10-profile-overrides.md §5 (M2, load-bearing): when profileOn, a transcoded owner actually fans
      // out via emitLooseProfileFanout, whose canonical owner image is renamedTo(srcPath, <mime of the FIRST
      // resolved format>). Predict THAT first-format mime (honoring overrides) so Phase C doesn't see a false
      // divergence and silently degrade the dedup. This ALSO fixes a pre-existing latent mismatch: profile-on
      // owners were predicted with the legacy opts.targetMime, not the profile's first format. Profile OFF ⇒
      // route the owner through the SAME resolution the transcode execute uses — effectiveForTranscode(ref,
      // op.targetMime) — so the per-image MEASURED best-format pick (round17) is reflected here too. When
      // bestFormatPerImage is ON the plan stamped this op with the diagnosis-measured winner (params.bestMime,
      // e.g. AVIF), and execute renames the owner via renamedTo(path, enc.mime) where enc.mime derives from
      // effectiveForTranscode(ref, op.targetMime).targetMime; predicting from the GLOBAL opts.targetMime (the
      // old effectiveFor(ref,1) base) would diverge from that actual emit ⇒ Phase C would falsely KEEP the
      // consumer and silently stop dropping the duplicate (round17 MAJOR). Feeding op.targetMime as the resolve
      // BASE mirrors execute exactly (an override redirect still wins). bestFormatPerImage OFF ⇒ op.targetMime
      // === opts.targetMime ⇒ effectiveForTranscode(ref, op.targetMime) === effectiveFor(ref,1) ⇒ byte-identical.
      const targetMime =
        transcoded && op?.kind === 'transcode'
          ? profileOn
            ? resolveProfile(ref).formats[0]!.format
            : effectiveForTranscode(ref, op.targetMime).targetMime
          : opts.targetMime;
      return {
        imagePath: pathByRef.get(ref),
        manifestPath: manifestPathOf(ref),
        transcoded,
        targetMime,
      };
    });
    // Owner ACTUAL emitted name, filled during Phase B. Defaults to the original emitted paths; transform
    // handlers below overwrite the image entry when they rename an owner. Phase C reconciles against the
    // plan prediction and skips (keeps) any consumer whose owner diverged.
    const ownerActualName = new Map<string, OwnerFinalName>();
    for (const [ref, fn] of ownerFinalName) ownerActualName.set(ref, { ...fn });
    // Cache-bust (round9 K8): the owner's actual emitted image WITHOUT the content hash — the basis Phase C
    // compares against the Phase-A prediction (also un-hashed). Defaults to the predicted image; transform
    // handlers overwrite it alongside ownerActualName.image. Decoupling the divergence check from the hash
    // means appending a content hash to a busted owner NEVER falsely degrades a dedup to keep-consumer (that
    // guard is only for a real format divergence, e.g. an AVIF→PNG fallback). hashOff ⇒ equals the hashed name.
    const ownerActualUnhashed = new Map<string, string>();
    for (const [ref, fn] of ownerFinalName) ownerActualUnhashed.set(ref, fn.image);
    // Cache-bust (round9 BLOCKER-0): a dedup OWNER that is a LOOSE image AND is NOT transcoded/resized never
    // has its ownerActualName.image overwritten (only the transcode/resize/fan-out handlers do that), so it
    // keeps its Phase-A default = the ORIGINAL un-hashed path. But that very image flows to the pass-through
    // loop where, under hashOn, it is renamed to name.<hash>.ext and the original is NOT emitted. Phase C
    // (below) would then write the consumer's meta.image = the un-hashed owner path while only the hashed
    // file ships ⇒ runtime 404. Fix: pre-hash every non-transformed LOOSE owner HERE (from its FINAL bytes,
    // which for a pass-through owner ARE the original bytes), record the hashed name in ownerActualName.image
    // so Phase C repoints to the file that actually ships, and remember the mapping so the pass-through loop
    // emits THAT same hashed path (once) instead of independently re-hashing. The un-hashed basis stays the
    // original (ownerActualUnhashed default), so the Phase-C divergence guard still passes (hash ≠ divergence).
    // A loose owner that IS later transcoded/resized has its original path `replaced.add`-ed and its
    // ownerActualName.image overwritten with the correct transcoded hash, so the pass-through `continue`s past
    // its (now-replaced) original ⇒ this pre-hash is harmlessly superseded. hashOff ⇒ this block is skipped
    // (hashEmit short-circuits) ⇒ ownerActualName.image stays the original ⇒ byte-identical to today.
    const prehashedLooseOwner = new Map<string, string>(); // original owner image path → its hashed emit path
    if (hashOn) {
      for (const [ref, fn] of ownerFinalName) {
        if (kindOf(ref) !== 'loose') continue;
        const p = pathByRef.get(ref);
        // ONLY pre-hash a loose owner the plan does NOT rename (its predicted final image === its original
        // path). A loose owner the plan transcodes (predicted image has a swapped extension) is handled by the
        // transcode/fan-out handler, which `replaced.add`s the original and overwrites ownerActualName.image
        // with the correctly-hashed transcoded name. Skipping it here avoids registering a hash for a file
        // that is never emitted (which could spuriously trip §6.4 collision widening for a real file).
        if (fn.image !== p) continue;
        const b = p ? bytesByRef.get(ref) : undefined;
        if (!p || !b) continue;
        const hashed = await hashEmit(p, new Uint8Array(b));
        if (hashed === p) continue;
        ownerActualName.get(ref)!.image = hashed; // Phase C repoints meta.image at the file that ships
        prehashedLooseOwner.set(p, hashed); // pass-through emits this exact name (no independent re-hash)
      }
    }
    // Owner-aware drops are DEFERRED to Phase C (executed after all transforms settle the owner names).
    // Selective fix: a deselected `dedup` kind drops NONE of these (filtered out here ⇒ no repoint/drop work
    // in Phase C); the honest skip is surfaced once via deselectedSkips below (not per consumer). When dedup
    // is NOT excluded `runs` is always true here ⇒ today's `plan.ops.filter(isOwnerAwareDrop)` exactly.
    const dedupDrops = plan.ops.filter(isOwnerAwareDrop).filter(runs);

    // round19-fix-worker-memory-bounds.md (#1): the decoded-source working-set, bounded by a documented byte
    // budget (Σ w·h·4) so a multi-dozen-page fix can't pile hundreds of MB resident and OOM the tab on the PAID
    // path. Assigned to the `bmpBudget` hoisted at the top of runFix so the function's finally (and every cancel
    // path) drain()s it — freeing native memory immediately when a run finishes OR is superseded. Eviction
    // policy is PURE/Node-tested (bitmap-budget.ts): an over-budget insert close()+evicts the LRU UNPINNED
    // bitmap; pinned refs (the in-flight op's sources, pinned per-op below) are NEVER evicted. ADDITIVE: under
    // budget nothing evicts ⇒ same decode set/order ⇒ byte-identical output (a miss re-decodes safely from the
    // whole-run-retained bytesByRef — never a wrong pixel, only CPU).
    bmpBudget = new BitmapBudget<ImageBitmap>(BITMAP_BUDGET_BYTES);
    const bitmapOf = async (ref: string): Promise<ImageBitmap | null> => {
      const hit = bmpBudget!.get(ref);
      if (hit) return hit;
      const b = bytesByRef.get(ref);
      if (!b) return null;
      return bmpBudget!.insert(ref, await createImageBitmap(new Blob([b])));
    };

    // ── Shared compose-page-and-encode helper (design §6 step 4–5) ───────────────────────────────────────
    // Composes one POT page from its blits (straight drawImage, source-over) and encodes it. FACTORED so the
    // `repack` and `pack` branches use ONE compose+encode path and can't drift (so BOTH get edge-extrude).
    // Each blit's source rect is cropped from its own source via bitmapOf (correct across merged/loose pages).
    // A blit.clip polygon (polygon-repack only — pack blits never carry one) clips the drawImage so an
    // interlocked neighbor's bbox can overlap this one's transparent margin without overwriting opaque pixels.
    //
    // EDGE-EXTRUDE (bleed, design OPTION A): when `extrude>0`, AFTER each RECTANGLE blit's main draw, replicate
    // the sprite's outermost source rows/cols into the symmetric packing gutter (extrudePlan → up to 8 1px-slice
    // drawImage calls). GATED to rectangle blits (`extrudePlan` returns [] for meshed/rotated — same gate as
    // canExtrude): a meshed (`clip`) or rotated blit gets NO bleed (no polygon-edge extrude in v1) and is
    // surfaced once as an honest no-op skip. `extrude` is the ALREADY-EFFECTIVE width the caller computed
    // (effectiveExtrude(op.extrude, gutter)); the gutter room was reserved by pack()/packLoose(). extrude=0 ⇒
    // the loop never runs ⇒ output is byte-identical to today (same drawImage order, imageSmoothingQuality).
    // Returns null on any missing source / no-2D-context (the caller surfaces an honest skip).
    const composePageEncode = async (
      blits: Blit[],
      binW: number,
      binH: number,
      target: ImageMime,
      encOpts: EncodeOpts,
      extrude = 0,
    ): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> => {
      const canvas = new OffscreenCanvas(binW, binH);
      const c2d = canvas.getContext('2d');
      if (!c2d) return null;
      c2d.imageSmoothingQuality = 'high'; // best-effort resampling for any scaled blit (§4c)
      for (const blit of blits) {
        const bmp = await bitmapOf(blit.from.atlasRef); // per-blit source (correct across merged/loose pages)
        if (!bmp) return null;
        if (blit.clip && blit.clip.length >= 3) {
          c2d.save();
          c2d.beginPath();
          c2d.moveTo(blit.clip[0]!.x, blit.clip[0]!.y);
          for (let k = 1; k < blit.clip.length; k++) c2d.lineTo(blit.clip[k]!.x, blit.clip[k]!.y);
          c2d.closePath();
          c2d.clip();
          c2d.drawImage(
            bmp,
            blit.from.rect.x,
            blit.from.rect.y,
            blit.from.rect.w,
            blit.from.rect.h,
            blit.to.x,
            blit.to.y,
            blit.to.w,
            blit.to.h,
          );
          c2d.restore();
          // Meshed/clip blit + extrude requested: NO bleed in v1 (no polygon-edge extrude). Surface honestly.
          if (extrude > 0) noteExtrudeSkip(blit);
        } else {
          c2d.drawImage(
            bmp,
            blit.from.rect.x,
            blit.from.rect.y,
            blit.from.rect.w,
            blit.from.rect.h,
            blit.to.x,
            blit.to.y,
            blit.to.w,
            blit.to.h,
          );
          if (extrude > 0) {
            // extrudePlan internally gates via canExtrude → [] for a rotated blit (skip note below) or
            // when clamped extrude is 0; non-empty ⇒ this rectangle blit got a real bleed.
            const rects: ExtrudeRect[] = extrudePlan(blit, extrude, binW, binH);
            if (rects.length > 0) {
              for (const r of rects)
                c2d.drawImage(
                  bmp,
                  r.src.x,
                  r.src.y,
                  r.src.w,
                  r.src.h,
                  r.dst.x,
                  r.dst.y,
                  r.dst.w,
                  r.dst.h,
                );
              extrudedBlits++;
              if (extrudePxApplied === 0) extrudePxApplied = extrude;
            } else {
              // A rotated rectangle blit (from.rotated / rotate90) yields no plan in v1 — surface the no-op.
              noteExtrudeSkip(blit);
            }
          }
        }
      }
      return encodeCanvas(canvas, c2d, target, encOpts);
    };
    /** Record an honest extrude no-op for a meshed/rotated/degenerate blit at most once (keyed by source
     *  ref + name) — surfaced so the receipt never silently under-extrudes. */
    const noteExtrudeSkip = (blit: Blit): void => {
      const id = `${blit.from.atlasRef} ${blit.name}`;
      if (extrudeSkipped.has(id)) return;
      extrudeSkipped.add(id);
      extrudeSkippedCount++;
      const why =
        blit.clip && blit.clip.length > 0
          ? 'meshed (clip polygon)'
          : blit.from.rotated || blit.rotate90
            ? 'rotated'
            : 'degenerate';
      skipped.push({
        assetRef: id,
        reason: `edge-extrude skipped: ${why} blit — no polygon-edge/rotated extrude in v1`,
      });
    };

    // Polygon-mode per-sprite extraction cache, keyed by the dir-aware id `${atlas.name} ${sprite.name}`
    // (same key repack.ts / repackAtlasesPolygon use — no cross-atlas mis-attribution in merge mode).
    // Each sprite's frame region is drawn ONCE to a throwaway canvas and read with ONE getImageData; both
    // the nesting MaskItem and the mesh AlphaMask come from that single read (no duplicate extraction).
    const maskCache = new Map<string, MaskItem>();
    const meshCache = new Map<string, RawMesh | null>();
    const rotatedSkipped = new Set<string>(); // dir-aware ids already surfaced as rotated-source skips
    // Feature 4: per-region opaque-bbox cache (keyed by loose-image ref). null = fully transparent. A region
    // can appear in only one pack group, but caching keeps a forced re-run / repeated probe cheap + consistent.
    const trimCache = new Map<string, TrimRect | null>();
    /** Extract a sprite's MaskItem (always) and RawMesh (null for rotated/degenerate sprites) from a
     *  single getImageData of its frame region. Caches by dir-aware id; pushes the rotated-source skip
     *  to skipped[] exactly once. Returns null only when the source sheet is unavailable. */
    const extractSprite = async (
      id: string,
      atlasRef: string,
      frame: Rect,
      rotated: boolean,
    ): Promise<MaskItem | null> => {
      if (maskCache.has(id)) return maskCache.get(id)!;
      // Defense-in-depth: a 0×0 or negative frame can't be a sprite (OffscreenCanvas(0,0) throws). The
      // parsers now reject these upstream (F3), but never construct a degenerate canvas here regardless.
      if (frame.w <= 0 || frame.h <= 0) return null;
      const bmp = await bitmapOf(atlasRef);
      if (!bmp) return null;
      const c = new OffscreenCanvas(frame.w, frame.h);
      const c2d = c.getContext('2d');
      if (!c2d) return null;
      c2d.drawImage(bmp, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
      const imageData = c2d.getImageData(0, 0, frame.w, frame.h);
      // The frame region was drawn at the canvas origin, so the extraction region is the whole canvas.
      const src = { data: imageData.data, width: imageData.width };
      const region = { x: 0, y: 0, w: frame.w, h: frame.h };
      const mask = maskItemFromRGBA(id, src, region, opts.padding);
      maskCache.set(id, mask);
      // Source-rotated sprites are NEVER meshed (rectangle-only, no clip) — recorded honestly, not silent.
      if (rotated) {
        if (!rotatedSkipped.has(id)) {
          rotatedSkipped.add(id);
          skipped.push({ assetRef: id, reason: 'mesh skipped: source sprite is rotated' });
        }
        meshCache.set(id, null);
        return mask;
      }
      const { mask: alpha, scale } = alphaMaskFromRGBA(src, region);
      const raw = traceMesh(alpha, {
        tolerance2: POLY_TOLERANCE2,
        maxVerts: POLY_MAX_VERTS,
        hullAreaRatioMax: HULL_AREA_RATIO_MAX,
      });
      meshCache.set(id, raw ? scaleMeshToFrame(raw, scale, frame.w, frame.h) : null);
      return mask;
    };

    // Trim-on-repack (round20): build an index-aligned (TrimRect|null)[] per atlas for the repack `trim` arg.
    // For each UNtrimmed sprite (trimmed===false && no spriteSourceSize) compute the FRAME-RELATIVE opaque
    // bbox via the SAME pure alphaBBox the analyze pass / detector use, off the decoded atlas page. Already-
    // trimmed sprites ⇒ null WITHOUT a decode (repack.ts copies them verbatim). The page is decoded ONCE per
    // atlas (bitmapOf is LRU-cached + pinned); each frame region is read with ONE getImageData. Cached by the
    // dir-aware id `${atlas.name} ${sprite.name}` in the shared trimCache (teardownPrevOp drops it cross-op).
    // Returns null when ANY source page is unavailable (the caller then omits `trim` ⇒ verbatim repack, the
    // op's own bitmap-missing skip fires below). The OUTER array index matches the group/atlas order given.
    const buildTrimArrays = async (group: Atlas[]): Promise<((TrimRect | null)[])[] | null> => {
      const out: ((TrimRect | null)[])[] = [];
      for (const a of group) {
        let bmp: ImageBitmap | null = null;
        let c2d: OffscreenCanvasRenderingContext2D | null = null;
        let imageData: ImageData | null = null;
        const arr: (TrimRect | null)[] = [];
        for (const s of a.sprites) {
          // Already trimmed (or 0-area) ⇒ verbatim, no decode needed.
          if (s.trimmed !== false || s.spriteSourceSize !== undefined || s.frame.w <= 0 || s.frame.h <= 0) {
            arr.push(null);
            continue;
          }
          const id = `${a.name} ${s.name}`;
          if (trimCache.has(id)) {
            arr.push(trimCache.get(id)!);
            continue;
          }
          // Lazily decode the page ONCE for this atlas (only when an untrimmed sprite forces it).
          if (!imageData) {
            bmp = await bitmapOf(a.name);
            if (!bmp) return null; // source page unavailable ⇒ caller omits trim (op handles the skip)
            const c = new OffscreenCanvas(bmp.width, bmp.height);
            c2d = c.getContext('2d');
            if (!c2d) return null;
            c2d.drawImage(bmp, 0, 0);
            imageData = c2d.getImageData(0, 0, bmp.width, bmp.height);
          }
          // alphaBBox returns a FRAME-RELATIVE top-left bbox (x/y relative to the frame) — exactly what the
          // repack `trim` arg + the detector expect.
          const bbox = alphaBBox(
            { data: imageData.data, width: imageData.width },
            { x: s.frame.x, y: s.frame.y, w: s.frame.w, h: s.frame.h },
          );
          trimCache.set(id, bbox);
          arr.push(bbox);
        }
        out.push(arr);
      }
      return out;
    };

    let vramSaved = 0;
    let trimmedSpritesTotal = 0; // round20: Σ untrimmed sprites tightened to their opaque bounds across repacks
    let trimmedAreaTotal = 0; // round20: Σ MEASURED atlas px reclaimed by those trims (frame − bbox, exact)
    let framesAliasedTotal = 0; // round19: Σ byte-identical frames aliased onto a shared region across repacks
    // Cross-atlas frame dedup during MERGE (round22 #1): Σ byte-identical frames that spanned ≥2 SOURCE sheets
    // and were deduped onto one merged region (the headline cross-sheet figure) + the EXACT VRAM reclaimed by
    // those dedups (Σ RepackResult.vramReclaimedBytes — a real measured delta from the merge's actual bin) +
    // whether ANY merge dropped a POT VRAM tier (else the win is disk-only, invariant 5). 0/false ⇒ omitted.
    let crossSheetFramesTotal = 0;
    let crossSheetVramReclaimed = 0;
    let crossSheetPotTierDropped = false;
    let meshSpritesTotal = 0; // Σ sprites carrying a mesh in the SELECTED polygon results (0 on fallback)
    let polyVramBefore = 0; // Σ vramBytesBefore of polygon-WON ops (basis for the honest saved-% figure)
    let polyVramAfter = 0; // Σ vramBytesAfter of those same ops
    let done = 0;
    // Selective fix: count ONLY the ops that will actually run (+1 for the zip step) so the progress bar
    // fills to 100% when kinds are excluded. excludeKinds empty ⇒ plan.ops.filter(runs).length === plan.ops
    // .length ⇒ today's `plan.ops.length + 1` exactly. Owner-aware drops are deferred to Phase C (the main
    // loop `continue`s past them), but they were already counted by today's total too — identical here.
    const total = plan.ops.filter(runs).length + 1;

    // Edge-extrude (bleed, design OPTION A) per-op resolution. The symmetric packing gutter must be ≥ the
    // requested extrude (so the bleed never crosses into a neighbor — pack.ts owns the band on all 4 sides),
    // but also ≥ the op's padding budget so we never SHRINK the existing neighbor gap. `gutter` 0 ⇒ today's
    // pack (no inflation/offset). `eff` is the bleed actually drawn (clamped to gutter). Pure, deterministic.
    const extrudeOf = (op: {
      extrude?: number;
      padding: number;
    }): { gutter: number; eff: number } => {
      const e = Math.max(0, Math.floor(op.extrude ?? 0));
      if (e <= 0) return { gutter: 0, eff: 0 };
      const gutter = Math.max(op.padding, e);
      return { gutter, eff: effectiveExtrude(e, gutter) };
    };

    // ── ROUND7 T8: format-only export-profile fan-out for a LOOSE image (round7-export-profile.md §5d) ────
    // The first-class fan-out the design mandates instead of the B3 `_1x`-tier hack: compose ONCE (the caller
    // hands us the composed canvas at the output scale), then emit ONE file per profile FORMAT off that single
    // canvas. The FIRST emitted variant is the canonical rename target (renamedTo + replaced.add — same as
    // today's single-transcode path), so dedup-repoint stays intact (B3); later variants are additional files.
    // B4 collision guard: two formats can fall back to the SAME actual mime — emit the first, skip the later
    // with an honest note (keyed on the actual emitted path). Returns the OWNER's final image path (for the
    // dedup ownerActualName bookkeeping) + whether references changed. `kind` distinguishes the loader row.
    // Called ONLY when profileOn; records profileOwned so the standalone op never double-runs (the caller skips
    // its own emit). profileAssets/profileFilesEmitted accrue here. Deterministic (profileFormats given order).
    const emitLooseProfileFanout = async (
      ref: string,
      srcPath: string,
      scale: number,
      canvas: OffscreenCanvas,
      c2d: OffscreenCanvasRenderingContext2D,
      kind: 'resize' | 'transcode',
      // Opaque-alpha (round15): the caller has already composed `canvas` opaque ({alpha:false}); pass the flag
      // through to each per-format feToEncodeOpts so the @jsquash AVIF path encodes the dead alpha plane at
      // minimum cost. DISK-only (invariant 5). Default false ⇒ alpha preserved (byte-identical to today).
      opaque = false,
    ): Promise<{ ownerImage: string; ownerImageUnhashed: string; referencesChanged: boolean }> => {
      profileOwned.add(ref);
      profileAssets++;
      // round10-profile-overrides.md §5 Site A: resolve THIS ref's effective formats+global ONCE. No matching
      // override ⇒ rp.formats===profileFormats / rp.global===profileGlobal (by reference) ⇒ byte-identical to
      // the pre-round10 loop. Covers loose-transcode/resize, the resize/transcode owner fan-out, AND the
      // format-only standalone pass (all route through here).
      const rp = resolveProfile(ref);
      // Honesty guard (round17): SOURCE byte length + mime for the same-format opaque size-loss check below.
      // `opaque` is only ever true on a transcode op (plan.ts sets opaque on transcode ops, never resize), and
      // the guard fires ONLY when a variant re-encodes to the SAME mime as the source — a real format change
      // (PNG→WebP/AVIF) is a legitimate downstream-accounted choice (transcode-guard.ts scope comment), never
      // gated. bytesByRef always holds the parsed source on this loose path (both callers `continue` on !bytes).
      const srcBytes = bytesByRef.get(ref)?.byteLength ?? 0;
      const srcMime = mimeOf(srcPath);
      const emittedThis = new Set<string>();
      let ownerImage = srcPath; // falls back to the source if every format fails (caller leaves it un-renamed)
      // Cache-bust (round9 K8): the un-hashed canonical owner image (the renamedTo() name BEFORE the content
      // hash). Phase C compares THIS against the Phase-A prediction (also un-hashed), so appending a content
      // hash never trips the divergence guard (which exists for a real format divergence like a PNG fallback).
      // The hashed `ownerImage` is what the dedup repoint actually writes into meta.image. Off ⇒ they're equal.
      let ownerImageUnhashed = srcPath;
      let firstEmitted = false;
      let refsChanged = false;
      for (const f of rp.formats) {
        const fe = formatEncode(f, scale, rp.global);
        // Opaque-alpha (round15): spread `opaque` so the @jsquash AVIF path drops the dead channel. The canvas
        // is already {alpha:false} from the caller. Default false ⇒ feToEncodeOpts unchanged (byte-identical).
        const enc = await encodeCanvas(canvas, c2d, fe.targetMime, {
          ...feToEncodeOpts(fe),
          opaque,
        });
        if (!enc) {
          skipped.push({
            assetRef: ref,
            reason: `variant ${f.format} skipped: encode to ${fe.targetMime} unavailable`,
          });
          continue;
        }
        const variantPath = renamedTo(srcPath, enc.mime);
        if (emittedThis.has(variantPath)) {
          skipped.push({
            assetRef: ref,
            reason: `${f.format} fell back to ${enc.mime} and collides with another variant — skipped`,
          });
          continue;
        }
        // Honesty guard (round17): a SAME-FORMAT opaque re-encode that is not strictly smaller is no
        // optimization — never ship a larger/equal page under a "fix" banner (invariant 3/5). Mirror the
        // single-emit transcode path's note and record NOTHING (don't even add to emittedThis — this variant
        // never existed). A real PNG→WebP/AVIF change is NOT gated (enc.mime !== srcMime) per the guard's
        // documented scope; it can legitimately grow and is handled by downstream dedup/Phase-C accounting.
        if (
          opaque &&
          enc.mime === srcMime &&
          transcodeIsSizeLoss(true, enc.bytes.length, srcBytes)
        ) {
          skipped.push({
            assetRef: ref,
            reason: `transcode kept original: opaque re-encode was not smaller (${enc.bytes.length} ≥ ${srcBytes} B)`,
          });
          continue;
        }
        emittedThis.add(variantPath);
        // Cache-bust (round9 K4): hash the FINAL emitted bytes and thread the hashed name into out.push, the
        // Pixi manifest src[], the loader-migration row, AND the dedup owner image. The format-fallback
        // collision guard above keys on the UNHASHED variantPath (so two formats falling back to the same mime
        // are de-duped pre-hash); hashing then makes each kept variant's name content-addressed. Off ⇒ emittedPath
        // === variantPath (today's behavior, byte-identical).
        const emittedPath = await hashEmit(variantPath, enc.bytes);
        out.push({ path: emittedPath, bytes: enc.bytes });
        // Pixi manifest: each fanned-out format is a `src` candidate of the SAME (loose, suffix:'') entry.
        recordVariant(ref, 'loose', srcPath, { scale, suffix: '', src: emittedPath });
        profileFilesEmitted++;
        // round13: a `nativePng`-marked PNG (FormatTarget.pngLossy) → record this page for the IN-PLACE
        // pngquant post-pass (it REPLACES `emittedPath`'s bytes via the pre-zip Map, never adds a file).
        // No-op unless pngquantOn; clean either/or — only PNG targets carry the marker so there is no race
        // with the webp/avif siblings of this same ref. Off/declined/floor ⇒ the lossless PNG above is KEPT.
        if (enc.mime === 'image/png' && fe.nativePng) {
          recordPngquantCandidate({
            ref,
            path: emittedPath,
            bytes: enc.bytes,
            w: canvas.width,
            h: canvas.height,
          });
        }
        if (!firstEmitted) {
          // The FIRST emitted variant is the canonical rename (today's single-transcode behavior) — replaced
          // + the loader row + the dedup owner image all point here, so dedup-repoint resolves to a real file.
          firstEmitted = true;
          ownerImage = emittedPath;
          ownerImageUnhashed = variantPath; // the canonical rename BEFORE hashing (Phase-C divergence basis)
          replaced.add(srcPath);
          if (emittedPath !== srcPath) {
            refsChanged = true;
            changeRows.push(looseRenameChange(srcPath, emittedPath, kind));
          }
        } else if (emittedPath !== srcPath) {
          // Additional formats are extra load targets (the loader picks by name) — a reference change too.
          refsChanged = true;
          changeRows.push(looseRenameChange(srcPath, emittedPath, kind));
        }
      }
      return { ownerImage, ownerImageUnhashed, referencesChanged: refsChanged };
    };

    // round19-fix-worker-memory-bounds.md (#1, task d): per-op teardown. The op-loop body has 20+ `continue`
    // exits per op, so we tear down the PREVIOUS op at the TOP of the next iteration (and once after the loop) —
    // a SINGLE site that fires regardless of how the prior op exited, instead of editing every continue.
    // teardownPrevOp (a) unpins the prior op's source bitmaps so the LRU can evict them again, and (b) drops the
    // mask/mesh/trim cache entries that prior op added (each id is dir-aware and belongs to exactly one op, so a
    // cross-op drop is safe), keeping those extraction caches from growing unbounded across many ops. The pre-*
    // snapshots are the cache keys present BEFORE the prior op ran; anything new is its contribution. ADDITIVE:
    // unpin/drop only free memory — they never change which pixels an op composes ⇒ byte-identical output.
    const snapKeys = (m: Map<string, unknown>): Set<string> => new Set(m.keys());
    let preMask = snapKeys(maskCache);
    let preMesh = snapKeys(meshCache);
    let preTrim = snapKeys(trimCache);
    const teardownPrevOp = (): void => {
      bmpBudget!.unpinAll();
      for (const k of maskCache.keys()) if (!preMask.has(k)) maskCache.delete(k);
      for (const k of meshCache.keys()) if (!preMesh.has(k)) meshCache.delete(k);
      for (const k of trimCache.keys()) if (!preTrim.has(k)) trimCache.delete(k);
      preMask = snapKeys(maskCache);
      preMesh = snapKeys(meshCache);
      preTrim = snapKeys(trimCache);
    };
    for (const op of plan.ops) {
      if (cancelled) return; // superseded — stop the (heavy) pixel-op loop before the next op (drain frees pins)
      teardownPrevOp(); // unpin + drop the PRIOR op's extraction caches (no-op on op 0 — empty snapshots)
      // Selective fix: this op's KIND was deselected in the Plan card → do NO pixel work for it. The honest
      // skip is surfaced once-per-kind via deselectedSkips after the loop (not per op). `total` already
      // excludes these, so the progress bar stays accurate. excludeKinds empty ⇒ runs() always true ⇒ today.
      if (!runs(op)) continue;
      // Owner-aware dedup drops are executed in Phase C (after transforms settle owner names) — skip here.
      if (op.kind === 'drop' && op.ownerRef != null) continue;
      post({ type: 'fix-progress', label: op.kind, done: done++, total });

      if (op.kind === 'repack') {
        // Spine single-page repack: emit a .atlas (not JSON) and keep PNG (Spine-runtime safe). Drop-in.
        if (op.atlasRefs.length === 1 && spineRefs.has(op.atlasRefs[0]!)) {
          const ref = op.atlasRefs[0]!;
          const info = spineInfoOf(ref);
          const atlas = atlasByRef.get(ref);
          if (!atlas || !info || info.pages > 1) {
            skipped.push({
              assetRef: ref,
              reason:
                info && info.pages > 1
                  ? 'multi-page Spine repack not supported in v1'
                  : 'Spine atlas not found',
            });
            continue;
          }
          // Polygon mode has no mesh slot in the Spine `.atlas` format → rectangle repack, surfaced honestly.
          if (opts.polygon)
            skipped.push({
              assetRef: ref,
              reason: 'polygon mode not supported for Spine (no mesh slot in .atlas)',
            });
          // Edge-extrude: reserve a symmetric gutter so the bleed has room. gutter=0 ⇒ today's repack exactly.
          const { gutter, eff } = extrudeOf(op);
          // Trim-on-repack (round20): tighten any UNtrimmed Spine region to its opaque bounds. The bbox is the
          // libGDX BOTTOM-LEFT offset (trimAsSpineOffset) so emitSpineAtlasText writes it verbatim. null ⇒ a
          // page was unavailable ⇒ omit trim (verbatim repack; the op's own missing-source skip fires below).
          const trim = await buildTrimArrays([atlas]);
          const trimOpt = trim ? { trim, trimAsSpineOffset: true } : {};
          const r = repackAtlases(
            [atlas],
            {
              allowRotation: false,
              padding: op.padding,
              maxSize: op.maxSize,
              ...(gutter ? { gutter } : {}),
              ...trimOpt,
            },
            aliasMaps,
          );
          if (r.atlases.length !== 1) {
            skipped.push({ assetRef: ref, reason: 'Spine repack spilled into multiple sheets' });
            continue;
          }
          const na = r.atlases[0]!;
          // Compose + encode via the shared helper (Spine pages stay PNG, runtime-safe). encodeCanvas for PNG
          // with no recompress level returns the native PNG bytes — same result as the prior convertToBlob.
          // eff>0 ⇒ each rectangle blit's edge pixels are replicated into the reserved gutter (seam fix).
          const enc = await composePageEncode(
            r.blits,
            na.size.w,
            na.size.h,
            'image/png',
            { allowPngFallback: true },
            eff,
          );
          if (!enc) {
            skipped.push({ assetRef: ref, reason: 'source sheet unavailable' });
            continue;
          }
          const imagePath = pathByRef.get(ref)!;
          // Cache-bust chain (round9 K6): hash the PNG bytes → patch na.imageRef (the .atlas texture line, line 0)
          // to the hashed basename → emit the .atlas (it now points at the hashed PNG) → hash the joined .atlas.
          // PNG bytes are preserved (Spine pages stay PNG). hashOff ⇒ emittedImage===imagePath, emittedAtlas===
          // info.path, no row ⇒ byte-identical drop-in to today.
          const emittedImage = await hashEmit(imagePath, enc.bytes);
          if (hashOn) na.imageRef = basename(emittedImage);
          out.push({ path: emittedImage, bytes: enc.bytes });
          const atlasBytes = te.encode(emitSpineAtlasText(na));
          const emittedAtlas = await hashEmit(info.path, atlasBytes);
          out.push({ path: emittedAtlas, bytes: atlasBytes });
          // Pixi manifest: a Spine sheet loads via its `.atlas` SIDECAR (Pixi/pixi-spine reads the page from it).
          recordVariant(ref, 'spine', emittedImage, { scale: 1, suffix: '', src: emittedAtlas });
          // A single Spine repack keeps the .atlas name today (drop-in, no row). When hashing renames it the
          // load call changes — emit ONE loader-migration row + referencesChanged (gated on the name change ⇒
          // hashOff ⇒ no row, identical). Spine .atlas carries no static page-image map (read from inside it).
          if (emittedAtlas !== info.path) {
            referencesChanged = true;
            changeRows.push(...repackChanges(info.path, emittedAtlas));
          }
          captureSheetDiff(ref, atlas.size, na, enc.bytes, basename(emittedImage), atlas);
          replaced.add(imagePath);
          replaced.add(info.path);
          vramSaved += r.vramBytesBefore - r.vramBytesAfter;
          // HONESTY (invariant 5): if the gutter grew this sheet's POT, the .atlas `size:` line + PNG dims
          // changed — surface the VRAM growth (no "identical round-trip" claim when the bin grew). The delta
          // is the gutter pack's footprint minus the SAME pack with no gutter. B3: the baseline MUST carry the
          // IDENTICAL trim so the delta isolates ONLY the gutter (else trim shrinks the main pack below an
          // untrimmed baseline ⇒ the sign flips and the readout lies).
          if (gutter > 0)
            extrudeVramDelta +=
              r.vramBytesAfter -
              repackAtlases(
                [atlas],
                { allowRotation: false, padding: op.padding, maxSize: op.maxSize, ...trimOpt },
                aliasMaps,
              ).vramBytesAfter;
          if (tieringOn) tierTransformed.add(ref); // repacked → tier loop surfaces an honest skip (§7 v1 scope)
          // Frame-redundancy (round19): count + surface the byte-identical frames this repack aliased onto a
          // shared region (the smaller-sheet VRAM win is ALREADY inside vramSaved). 0/absent ⇒ today's string.
          framesAliasedTotal += r.aliasedFrames ?? 0;
          // Trim-on-repack (round20): count + measure the untrimmed regions this repack tightened (the VRAM win
          // is ALREADY inside vramSaved). 0/absent ⇒ today's string + no receipt field.
          trimmedSpritesTotal += r.trimmedSprites ?? 0;
          trimmedAreaTotal += r.trimmedAreaReclaimed ?? 0;
          operations.push(
            `repack ${basename(ref)} (spine) → ${na.size.w}×${na.size.h}${r.aliasedFrames ? ` (${r.aliasedFrames} frames aliased)` : ''}${r.trimmedSprites ? ` (${r.trimmedSprites} sprites trimmed, ${r.trimmedAreaReclaimed}px reclaimed)` : ''}`,
          );
          continue;
        }
        for (const rf of op.atlasRefs)
          if (spineRefs.has(rf))
            skipped.push({ assetRef: rf, reason: 'Spine atlas not mergeable in v1' });
        const refs = op.atlasRefs.filter((rf) => !spineRefs.has(rf));
        const group = refs.map((rf) => atlasByRef.get(rf)).filter((a): a is Atlas => !!a);
        if (group.length === 0) {
          if (refs[0]) skipped.push({ assetRef: refs[0], reason: 'atlas not found' });
          continue;
        }
        const merge = group.length > 1; // multi-atlas op = the non-drop-in "merge atlases" mode
        // round19 (#1): pin every source atlas this op composes from — a merge re-reads all N group sources
        // across many composePageEncode pages, and polygon extracts every sprite of every group atlas, so
        // without a pin a large group could evict a source it still needs THIS op (a re-decode storm, never a
        // wrong pixel since bytesByRef is retained). The LRU never evicts a pinned ref; teardownPrevOp unpins
        // before the next op. A single-atlas repack pins one ref ⇒ a trivial no-op (nothing to evict it for).
        bmpBudget!.pin(group.map((a) => a.name));

        // ── Cross-atlas frame dedup during MERGE (round22 #1) ─────────────────────────────────────────────
        // For a MULTI-sheet merge, dedup byte-identical frames that span MULTIPLE source sheets: pack ONE
        // region per cross-sheet cluster, point every duplicate name (across all merged sheets) at it in the
        // merged manifest. B2 (lazy hash-on-demand): the upfront frame-redundancy pass only hashes a sheet with
        // ≥minDuplicates sprites, so the headline many-small-sheets case (e.g. 2-in-A + 1-in-B) never gets B's
        // hashes — starving the feature. Here, with the group known, hash ANY group sheet still missing from
        // frameHashByRef (its source bytes are pinned above) and CACHE it back so a later op reuses it. Then
        // build ONE flat (atlasName,frameName) alias map over the whole group (atlas-qualified distinct-rect
        // guard — B1). frameRedundancy OFF ⇒ no hashing, no map ⇒ byte-identical. Single-atlas repack ⇒ no map
        // (a within-atlas dupe is the round19 path's job, threaded via aliasMaps). Respect cancelled.
        let mergeAliasMap: MergeAliasMap | undefined;
        if (merge && frameRedundancyOn) {
          for (const a of group) {
            if (frameHashByRef.has(a.name)) continue; // already hashed upfront (≥minDuplicates) or by a prior op
            if (cancelled) return;
            const bytes = bytesByRef.get(a.name);
            if (!bytes) continue; // missing source — its frames contribute null hashes (never cluster), fail-safe
            const res = await hashAtlasFrames(bytes, a.sprites);
            if (res) frameHashByRef.set(a.name, res.hashes); // cache back: a later merge/repack reuses it
          }
          mergeAliasMap = buildMergeAliasMap(group, frameHashByRef, crossAtlasMinDistinct);
        }

        // Edge-extrude (bleed): reserve a symmetric gutter for the RECTANGLE repack path. Polygon mode emits
        // meshed blits that are never extruded (the design's rectangle-only scope), so its nester takes no
        // gutter; `eff` is only fed to compose when the selected result is the rectangle path (below).
        const { gutter, eff } = extrudeOf(op);

        // Trim-on-repack (round20): tighten any UNtrimmed sprite to its opaque bounds (TexturePacker top-left
        // inset). Index-aligned per group atlas. null ⇒ a source page was unavailable ⇒ omit trim (verbatim
        // repack; the op's own missing-source skip fires below). Fed into the RECTANGLE paths only — the
        // polygon nester is untouched, but the rect baseline below carries the SAME trim so polygonWins
        // compares against a TRIMMED rect (honest gate: polygon must beat the tighter rectangle).
        const trim = await buildTrimArrays(group);
        const trimOpt = trim ? { trim } : {};

        // Polygon mode: nest by silhouette and keep it only when it is a MEASURABLE VRAM win; otherwise
        // fall back to today's rectangle repack (honest no-op, surfaced in skipped[]). When opts.polygon
        // is false we take exactly today's path — byte-identical behavior, no mask extraction at all.
        let r: ReturnType<typeof repackAtlases>;
        let polySelected = false; // true iff the polygon nesting won and was selected for this op
        if (opts.polygon) {
          // ONE getImageData per sprite → both the nesting MaskItem (all sprites) and the mesh (non-rotated,
          // non-null traceMesh). bitmapOf failures abort this op honestly (same as the compose paths below).
          const masks: MaskItem[] = [];
          const meshById = new Map<string, RawMesh>();
          let extractOk = true;
          for (const a of group) {
            for (const s of a.sprites) {
              const id = `${a.name} ${s.name}`;
              const mask = await extractSprite(id, a.name, s.frame, s.rotated);
              if (!mask) {
                extractOk = false;
                break;
              }
              masks.push(mask);
              const raw = meshCache.get(id);
              if (raw) meshById.set(id, raw); // only non-rotated sprites with a non-null traceMesh carry a mesh
            }
            if (!extractOk) break;
          }
          if (!extractOk) {
            for (const rf of refs)
              skipped.push({ assetRef: rf, reason: 'source sheet unavailable' });
            continue;
          }
          const poly = repackAtlasesPolygon(group, masks, meshById, {
            allowRotation: false,
            padding: 0,
            maxSize: op.maxSize,
            emitMesh: true,
          });
          // The rectangle fallback owns the gutter (only it composes with extrude); the polygon nester never does.
          const rect = repackAtlases(
            group,
            {
              allowRotation: false,
              padding: op.padding,
              maxSize: op.maxSize,
              ...(gutter ? { gutter } : {}),
              ...trimOpt,
            },
            aliasMaps,
            mergeAliasMap,
          );
          if (polygonWins(poly, rect)) {
            r = poly;
            polySelected = true; // receipt stats are accrued only AFTER this op composes (below), never on a later skip
          } else {
            r = rect;
            for (const rf of refs)
              skipped.push({
                assetRef: rf,
                reason: 'polygon mode: no measurable VRAM win, used rectangle packing',
              });
          }
        } else {
          r = repackAtlases(
            group,
            {
              allowRotation: false,
              padding: op.padding,
              maxSize: op.maxSize,
              ...(gutter ? { gutter } : {}),
              ...trimOpt,
            },
            aliasMaps,
            mergeAliasMap,
          );
        }

        if (!merge && r.atlases.length !== 1) {
          skipped.push({
            assetRef: refs[0]!,
            reason: 'repack spilled into multiple sheets (v1 keeps single-sheet atlases)',
          });
          continue;
        }
        // merging atlases with a shared sprite name would clobber manifest keys — skip honestly
        const names = r.atlases.flatMap((a) => a.sprites.map((s) => s.name));
        if (merge && new Set(names).size !== names.length) {
          for (const rf of refs)
            skipped.push({
              assetRef: rf,
              reason: 'merge skipped: sprite-name collision across atlases',
            });
          continue;
        }

        let composeOk = true;
        const baseDir = merge ? dirOf(pathByRef.get(refs[0]!) ?? '') : '';
        // Loader-migration: every NEW merged-page manifest the game must load (collected as pages compose),
        // plus the REAL page-image path for each (parallel) so Phaser's textureURL is the file that exists.
        const mergedManifestPaths: string[] = [];
        const mergedPageImages: string[] = [];
        // Extrude only the RECTANGLE result — a selected polygon result emits meshed blits (never extruded);
        // feeding eff there would just surface a meshed no-op skip per sprite. eff already gated the gutter.
        const composeExtrude = polySelected ? 0 : eff;
        for (let i = 0; i < r.atlases.length && composeOk; i++) {
          const na = r.atlases[i]!;
          const naNames = new Set(na.sprites.map((s) => s.name));
          // Compose + encode this page via the shared helper (same clip/imageSmoothing handling as before).
          // null ⇒ source sheet / no-2D-context — surfaced as the honest skip below (composeOk false).
          // composeExtrude>0 ⇒ each rectangle blit's edge pixels are replicated into the reserved gutter.
          const sheet = await composePageEncode(
            r.blits.filter((b) => naNames.has(b.name)),
            na.size.w,
            na.size.h,
            'image/webp',
            { lossless: true, allowPngFallback: true },
            composeExtrude,
          );
          if (!sheet) {
            composeOk = false;
            break;
          }
          const ext = EXT[sheet!.mime] ?? '.png';
          if (merge) {
            const stem = `atlas-merged${r.atlases.length > 1 ? `-${i}` : ''}`;
            // Cache-bust chain (round9 K5): hash the IMAGE bytes → patch na.imageRef to the hashed basename →
            // emit the sidecar (it now embeds the hashed meta.image) → hash the sidecar. So the .json points at
            // a page image that exists. hashOff ⇒ emittedImage/emittedJson === today's plain paths (byte-identical).
            const emittedImage = await hashEmit(`${baseDir}${stem}${ext}`, sheet!.bytes);
            na.imageRef = basename(emittedImage);
            out.push({ path: emittedImage, bytes: sheet!.bytes });
            const jsonBytes = te.encode(emitTexturePackerJson(na));
            const emittedJson = await hashEmit(`${baseDir}${stem}.json`, jsonBytes);
            out.push({ path: emittedJson, bytes: jsonBytes });
            // OPT-IN KTX2 (round12): offer the merged page for a sibling .ktx2 + its own .ktx2.json sidecar.
            // No-op unless the backend path is live; the raster page above is KEPT (additive).
            recordKtx2Candidate({
              ref: emittedJson,
              imagePath: emittedImage,
              pageBytes: sheet!.bytes,
              pageMime: sheet!.mime,
              w: na.size.w,
              h: na.size.h,
              atlasSidecar: { path: emittedJson, atlas: na },
            });
            // Pixi manifest: one entry per merged page `.json` (distinct ref per page so aliases never collide).
            recordVariant(emittedJson, 'atlas', emittedImage, {
              scale: 1,
              suffix: '',
              src: emittedJson,
            });
            mergedManifestPaths.push(emittedJson); // loader-migration: a NEW manifest to load
            mergedPageImages.push(emittedImage); // ...and its REAL page image (na.imageRef on disk)
            // Sheet-diff: group[0] is the representative source page ("1 of N" — merge folds many into few).
            captureSheetDiff(
              refs[0]!,
              group[0]!.size,
              na,
              sheet!.bytes,
              `${basename(na.imageRef)} (1 of ${refs.length})`,
              group[0],
            );
          } else {
            const ref = refs[0]!;
            const origPath = pathByRef.get(ref)!;
            const imagePath =
              sheet!.mime === 'image/webp' ? origPath.replace(/\.[a-z0-9]+$/i, '.webp') : origPath;
            if (sheet!.mime === 'image/webp')
              na.imageRef = na.imageRef.replace(/\.[a-z0-9]+$/i, '.webp');
            // Cache-bust chain (round9 K5): hash the IMAGE bytes → patch na.imageRef to the hashed basename →
            // emit the sidecar → hash it. hashOff ⇒ emittedImage === imagePath, emittedJson === mPath (identical).
            const emittedImage = await hashEmit(imagePath, sheet!.bytes);
            na.imageRef = basename(emittedImage);
            out.push({ path: emittedImage, bytes: sheet!.bytes });
            captureSheetDiff(
              ref,
              group[0]!.size,
              na,
              sheet!.bytes,
              basename(na.imageRef),
              group[0],
            );
            replaced.add(origPath);
            replaced.add(imagePath);
            const mPath = manifestPathOf(ref);
            if (mPath) {
              const jsonBytes = te.encode(emitTexturePackerJson(na));
              const emittedJson = await hashEmit(mPath, jsonBytes);
              out.push({ path: emittedJson, bytes: jsonBytes });
              replaced.add(mPath);
              // OPT-IN KTX2 (round12): offer the repacked page for a sibling .ktx2 + its own .ktx2.json sidecar
              // (round8 two-sidecar rule). No-op unless the backend path is live; the raster page is KEPT (additive).
              recordKtx2Candidate({
                ref,
                imagePath: emittedImage,
                pageBytes: sheet!.bytes,
                pageMime: sheet!.mime,
                w: na.size.w,
                h: na.size.h,
                atlasSidecar: { path: emittedJson, atlas: na },
              });
              // Pixi manifest: a repacked sheet loads via its `.json` SIDECAR (Pixi reads meta.image), NOT the image.
              recordVariant(ref, 'atlas', emittedImage, { scale: 1, suffix: '', src: emittedJson });
              // Cache-bust (round9 K5): a single repack normally keeps the .json name (rewritten in place) so the
              // load.atlas call is unchanged ⇒ drop-in, no row. When hashing RENAMES the sidecar the load call
              // genuinely changes — emit ONE loader-migration row + flag referencesChanged so the game updates
              // its load.atlas(key, json, image). Gated on the name actually changing ⇒ hashOff ⇒ no row (identical).
              if (emittedJson !== mPath) {
                referencesChanged = true;
                changeRows.push(...repackChanges(mPath, emittedJson, emittedImage));
              }
            }
            operations.push(
              `repack ${basename(ref)}${polySelected ? ' (polygon)' : ''} → ${na.size.w}×${na.size.h} ${sheet!.mime.replace('image/', '')}${r.aliasedFrames ? ` (${r.aliasedFrames} frames aliased)` : ''}${r.trimmedSprites ? ` (${r.trimmedSprites} sprites trimmed, ${r.trimmedAreaReclaimed}px reclaimed)` : ''}`,
            );
          }
        }
        if (!composeOk) {
          for (const rf of refs) skipped.push({ assetRef: rf, reason: 'source sheet unavailable' });
          continue;
        }
        // repacked/merged refs → tier loop surfaces an honest skip rather than a silent no-op (§7 v1 scope).
        if (tieringOn) for (const rf of refs) tierTransformed.add(rf);
        // Cross-atlas dedup (round22 #1): the subset of aliases that spanned ≥2 SOURCE sheets. Computed ONCE
        // here so the merge note (below) and the run accumulator (further below, outside the `if (merge)` block)
        // read the SAME gated value. mergeAliasMap is undefined for a single-atlas repack ⇒ 0 ⇒ no change there.
        // HONESTY (R22 #0): read from the SELECTED result, never the map. repackAtlasesPolygon never consumes
        // mergeAliasMap (no param) ⇒ a SELECTED polygon page physically wrote every cross-sheet duplicate
        // separately and carries no aliasedFrames/vramReclaimedBytes/potTierDropped. Gate crossN on !polySelected
        // so the note + accumulator stay consistent with what shipped (mirrors r.aliasedFrames, already absent
        // for poly — the receipt must reflect the emitted output).
        const crossN = polySelected ? 0 : (mergeAliasMap?.crossSheetFrames ?? 0);
        if (merge) {
          for (const rf of refs) {
            const ip = pathByRef.get(rf);
            if (ip) dropped.add(ip);
            const mp = manifestPathOf(rf);
            if (mp) dropped.add(mp);
          }
          referencesChanged = true;
          // potTierDropped FALSE ⇒ the bin stayed the same POT tier ⇒ the win is DISK-only (invariant 5),
          // disclosed in the string (and the receipt's exact vramReclaimedBytes is 0). r.aliasedFrames already
          // covers the headline "(N frames aliased)" — this notes how many of those crossed a sheet boundary.
          const crossNote =
            crossN > 0
              ? ` (${crossN} across sheets${r.potTierDropped ? '' : ', same tier, disk only'})`
              : '';
          operations.push(
            `merge ${refs.length} atlases → ${r.atlases.length} sheet${r.atlases.length === 1 ? '' : 's'}${r.aliasedFrames ? ` (${r.aliasedFrames} frames aliased)` : ''}${crossNote}${r.trimmedSprites ? ` (${r.trimmedSprites} sprites trimmed, ${r.trimmedAreaReclaimed}px reclaimed)` : ''}`,
          );
          // Loader-migration (SET→SET): each OLD atlas manifest the game loaded → the merged manifest set.
          changeRows.push(
            ...mergeChanges(
              refs.map((rf) => manifestPathOf(rf)).filter((m): m is string => !!m),
              mergedManifestPaths,
              mergedPageImages,
            ),
          );
        }
        vramSaved += r.vramBytesBefore - r.vramBytesAfter;
        // Frame-redundancy (round19): count the byte-identical frames this repack/merge aliased (the
        // smaller-sheet VRAM win is ALREADY inside vramSaved). 0/absent ⇒ no change to the receipt.
        framesAliasedTotal += r.aliasedFrames ?? 0;
        // Cross-atlas frame dedup during MERGE (round22 #1): the subset of those aliases that spanned ≥2 SOURCE
        // sheets (the headline cross-sheet figure) + the EXACT VRAM reclaimed (r.vramReclaimedBytes — already
        // inside vramSaved) + whether ANY merge dropped a POT tier. mergeAliasMap is undefined for a single-atlas
        // repack ⇒ contributes 0/false ⇒ receipt byte-identical to today there.
        // HONESTY (R22 #0): crossN already zeroes when a polygon page was SELECTED (it never consumed
        // mergeAliasMap, so it wrote those duplicates separately) ⇒ the accumulator stays consistent with the
        // companion crossSheetVramReclaimed/crossSheetPotTierDropped, which read from r (0/false for poly).
        crossSheetFramesTotal += crossN;
        crossSheetVramReclaimed += r.vramReclaimedBytes ?? 0;
        if (r.potTierDropped) crossSheetPotTierDropped = true;
        // Trim-on-repack (round20): count + measure the untrimmed sprites this repack/merge tightened (the VRAM
        // win is ALREADY inside vramSaved). A SELECTED polygon result carries no trim fields ⇒ 0 (polygon path
        // is never trimmed). 0/absent ⇒ no receipt field.
        trimmedSpritesTotal += r.trimmedSprites ?? 0;
        trimmedAreaTotal += r.trimmedAreaReclaimed ?? 0;
        // HONESTY (invariant 5): a symmetric gutter CAN grow a sheet to the next POT ⇒ MORE VRAM. When the
        // rectangle path shipped WITH a gutter, surface the truthful delta (gutter pack footprint − the SAME
        // pack with no gutter). The growth is ALSO already inside vramSaved/vramBytes* — never claimed free.
        // B3: the baseline MUST carry the IDENTICAL trim so the delta isolates ONLY the gutter (else a trimmed
        // main pack vs an untrimmed baseline flips the sign and the readout lies).
        // B3 (round22 #1): the no-gutter baseline MUST also carry the SAME mergeAliasMap so the delta isolates
        // ONLY the gutter — an aliased main pack vs a non-aliased baseline would conflate the dedup win with the
        // gutter growth and the readout would lie.
        if (composeExtrude > 0 && gutter > 0)
          extrudeVramDelta +=
            r.vramBytesAfter -
            repackAtlases(
              group,
              { allowRotation: false, padding: op.padding, maxSize: op.maxSize, ...trimOpt },
              aliasMaps,
              mergeAliasMap,
            ).vramBytesAfter;
        // Accrue polygon receipt stats only now that the op has fully composed (skips above never reach here),
        // so meshSprites / polygonAreaSavedPct reflect ONLY sheets that actually shipped.
        if (polySelected) {
          meshSpritesTotal += r.atlases.reduce(
            (n, a) => n + a.sprites.filter((s) => s.mesh).length,
            0,
          );
          polyVramBefore += r.vramBytesBefore;
          polyVramAfter += r.vramBytesAfter;
        }
      } else if (op.kind === 'resize') {
        const ref = op.assetRef;
        const path = pathByRef.get(ref);
        const bytes = bytesByRef.get(ref);
        if (!path || !bytes) {
          skipped.push({ assetRef: ref, reason: 'image unavailable' });
          continue;
        }
        const bmp = await createImageBitmap(new Blob([bytes]));
        const origPx = bmp.width * bmp.height;
        const srcW = bmp.width; // captured before bmp.close() — used for the scale-aware quality factor
        const atlas = atlasByRef.get(ref);

        if (atlas) {
          // resize an ATLAS: scale the manifest frames too, keep the filename + source format → drop-in.
          const scaled = scaleAtlas(atlas, op.to.w / atlas.size.w);
          const canvas = new OffscreenCanvas(scaled.size.w, scaled.size.h);
          const c2d = canvas.getContext('2d');
          if (!c2d) {
            bmp.close();
            skipped.push({ assetRef: ref, reason: 'no 2D context' });
            continue;
          }
          c2d.imageSmoothingQuality = 'high'; // best-effort downscale resampling (free quality win, §4c)
          c2d.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, scaled.size.w, scaled.size.h);
          bmp.close();
          const srcMime = mimeOf(path);
          const blob = await canvas.convertToBlob({ type: srcMime });
          const imgBytes = new Uint8Array(await blob.arrayBuffer());
          // Cache-bust chain (round9 K5/B1): the resize-atlas path keeps the source filename+format ⇒ a pure
          // drop-in today (no row). Hashing demotes it to a reference-changing event: hash the IMAGE bytes →
          // patch scaled.imageRef to the hashed basename → emit the sidecar (it embeds the hashed image) → hash
          // the sidecar → emit ONE loader-migration row + referencesChanged. hashOff ⇒ emittedImage===path,
          // emittedSidecar===the original sidecar, no row ⇒ byte-identical drop-in to today.
          const emittedImage = await hashEmit(path, imgBytes);
          if (hashOn) scaled.imageRef = basename(emittedImage);
          out.push({ path: emittedImage, bytes: imgBytes });
          replaced.add(path);
          if (spineRefs.has(ref)) {
            const info = spineInfoOf(ref);
            if (info) {
              const atlasBytes = te.encode(emitSpineAtlasText(scaled));
              const emittedAtlas = await hashEmit(info.path, atlasBytes);
              out.push({ path: emittedAtlas, bytes: atlasBytes });
              replaced.add(info.path);
              // Pixi manifest + loader row are added ONLY under hashing — resize-atlas is a stable-name drop-in
              // today (NOT in the manifest, no row), so gating on hashOn keeps the hashOff path (incl. manifest-on)
              // byte-identical. A Spine sheet loads via its `.atlas` SIDECAR (the hashed image is its texture line).
              if (hashOn) {
                recordVariant(ref, 'spine', emittedImage, {
                  scale: 1,
                  suffix: '',
                  src: emittedAtlas,
                });
                if (emittedAtlas !== info.path) {
                  referencesChanged = true;
                  changeRows.push(...repackChanges(info.path, emittedAtlas)); // Spine .atlas carries no page-image map
                }
              }
            }
          } else {
            const mPath = manifestPathOf(ref);
            if (mPath) {
              const jsonBytes = te.encode(emitTexturePackerJson(scaled));
              const emittedJson = await hashEmit(mPath, jsonBytes);
              out.push({ path: emittedJson, bytes: jsonBytes });
              replaced.add(mPath);
              // Pixi manifest + loader row are added ONLY under hashing — resize-atlas is a stable-name drop-in
              // today (NOT in the manifest, no row), so gating on hashOn keeps the hashOff path (incl. manifest-on)
              // byte-identical. A resized atlas loads via its `.json` SIDECAR (Pixi reads meta.image = hashed image).
              if (hashOn) {
                recordVariant(ref, 'atlas', emittedImage, {
                  scale: 1,
                  suffix: '',
                  src: emittedJson,
                });
                if (emittedJson !== mPath) {
                  referencesChanged = true;
                  changeRows.push(...repackChanges(mPath, emittedJson, emittedImage));
                }
              }
            }
          }
          vramSaved += Math.max(0, (origPx - scaled.size.w * scaled.size.h) * 4);
          operations.push(`resize atlas ${basename(ref)} → ${scaled.size.w}×${scaled.size.h}`);
        } else {
          // loose image: downscale + transcode to the target format
          const canvas = new OffscreenCanvas(op.to.w, op.to.h);
          const c2d = canvas.getContext('2d');
          if (!c2d) {
            bmp.close();
            skipped.push({ assetRef: ref, reason: 'no 2D context' });
            continue;
          }
          c2d.imageSmoothingQuality = 'high'; // best-effort downscale resampling (free quality win, §4c)
          c2d.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, op.to.w, op.to.h);
          bmp.close();
          const scale = srcW > 0 ? op.to.w / srcW : 1;
          if (profileOn && !profileOwned.has(ref)) {
            // ROUND7 T8: format-only fan-out — emit one variant per profile format off this single downscaled
            // canvas (B3 first-class, NOT a `_1x` tier hack). The standalone single-format emit below is
            // skipped (profileOwned). dedup-repoint stays intact (the first variant is the canonical rename).
            const r = await emitLooseProfileFanout(ref, path, scale, canvas, c2d, 'resize');
            if (ownerActualName.has(ref)) {
              // Cache-bust (round9 K8): the dedup owner image is the fan-out's first (content-hashed) variant;
              // the un-hashed name is the Phase-C divergence basis (a hash is not a divergence). hashOff ⇒ equal.
              ownerActualName.get(ref)!.image = r.ownerImage;
              ownerActualUnhashed.set(ref, r.ownerImageUnhashed);
            }
            if (r.referencesChanged) referencesChanged = true;
            vramSaved += Math.max(0, (origPx - op.to.w * op.to.h) * 4);
            // Per-ref count (overrides may REPLACE the format list); no override ⇒ === profileFormats.length.
            const nFmt = resolveProfile(ref).formats.length;
            operations.push(
              `resize ${basename(path)} → ${op.to.w}×${op.to.h} (${nFmt} format${nFmt === 1 ? '' : 's'})`,
            );
          } else {
            // Effective per-asset options (folder/type overrides + scale-aware quality on the downscale).
            const eff = effectiveFor(ref, scale);
            const enc = await encodeCanvas(canvas, c2d, eff.targetMime, encOptsFor(eff, true));
            const newPath = renamedTo(path, enc!.mime); // same rename the owner-final-name prediction uses
            // Cache-bust (round9 K4): hash the FINAL bytes; thread the hashed name into out.push, the Pixi
            // manifest src[], and the loader-migration row. Off ⇒ emittedPath === newPath (byte-identical).
            const emittedPath = await hashEmit(newPath, enc!.bytes);
            out.push({ path: emittedPath, bytes: enc!.bytes });
            // Pixi manifest: a resized loose image loads directly (single format, single tier).
            recordVariant(ref, 'loose', path, { scale: 1, suffix: '', src: emittedPath });
            // OPT-IN KTX2 (round12): offer the resized loose page for a direct-format sibling .ktx2 (no JSON
            // sidecar — loose lists [x.ktx2, x.webp] in the manifest src). No-op unless the backend path is live.
            recordKtx2Candidate({
              ref,
              imagePath: emittedPath,
              pageBytes: enc!.bytes,
              pageMime: enc!.mime,
              w: op.to.w,
              h: op.to.h,
            });
            replaced.add(path);
            if (emittedPath !== path) {
              referencesChanged = true; // a loose-image rename is NOT drop-in
              changeRows.push(looseRenameChange(path, emittedPath, 'resize')); // loader-migration: logo.png → logo.webp
            }
            vramSaved += Math.max(0, (origPx - op.to.w * op.to.h) * 4);
            operations.push(
              `resize ${basename(path)} → ${op.to.w}×${op.to.h} ${enc!.mime.replace('image/', '')}`,
            );
          }
        }
      } else if (op.kind === 'transcode') {
        const ref = op.assetRef;
        const path = pathByRef.get(ref);
        const bytes = bytesByRef.get(ref);
        if (!path || !bytes) {
          skipped.push({ assetRef: ref, reason: 'image unavailable' });
          continue;
        }
        if (profileOn && !profileOwned.has(ref) && !atlasByRef.has(ref)) {
          // ROUND7 T8: format-only fan-out — decode ONCE to a canvas, then emit one variant per profile format
          // (B3 first-class). LOOSE images only (design scope "loose-transcode") — an ATLAS page keeps today's
          // single-format transcode below so its manifest meta.image isn't left dangling across N variants.
          // dedup-repoint stays intact: the first emitted variant is the canonical owner image
          // (ownerActualName.image), and a complete encode failure leaves the owner on its ORIGINAL.
          const bmp = await createImageBitmap(new Blob([bytes]));
          const canvas = new OffscreenCanvas(bmp.width, bmp.height);
          // Opaque-alpha (round15): in profile mode the fan-out decodes ITS OWN canvas — compose onto a
          // genuinely opaque `{alpha:false}` surface when the op is opaque so EVERY fanned-out variant drops
          // the dead alpha channel (DISK-only, invariant 5). feToEncodeOpts below also carries `op.opaque` so
          // the @jsquash AVIF path encodes the constant alpha plane at minimum cost. Absent ⇒ alpha-true canvas.
          const c2d = canvas.getContext('2d', op.opaque ? { alpha: false } : undefined);
          if (!c2d) {
            bmp.close();
            skipped.push({ assetRef: ref, reason: 'no 2D context' });
            if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = path;
            continue;
          }
          c2d.drawImage(bmp, 0, 0);
          bmp.close();
          const r = await emitLooseProfileFanout(ref, path, 1, canvas, c2d, 'transcode', op.opaque);
          if (ownerActualName.has(ref)) {
            // Cache-bust (round9 K8): dedup owner image = the fan-out's first (hashed) variant; un-hashed for
            // Phase C's divergence comparison (a content hash is not a divergence). hashOff ⇒ the two are equal.
            ownerActualName.get(ref)!.image = r.ownerImage;
            ownerActualUnhashed.set(ref, r.ownerImageUnhashed);
          }
          if (r.referencesChanged) referencesChanged = true;
          // Per-ref count (overrides may REPLACE the format list); no override ⇒ === profileFormats.length.
          const nFmt = resolveProfile(ref).formats.length;
          operations.push(`transcode ${basename(path)} → ${nFmt} format${nFmt === 1 ? '' : 's'}`);
          continue;
        }
        // ── Prebuilt-atlas PASSTHROUGH transcode (round20 #1) ─────────────────────────────────────────────
        // A prebuilt sheet that is NOT being repacked can still earn a `format` finding on its PAGE IMAGE
        // (analyze.ts sizes atlas pages too) → a standalone transcode op reaching HERE. Re-encoding the page
        // VERBATIM (no recompose — frame geometry/trim/pivot/mesh untouched) swaps its extension
        // (sheet.png → sheet.webp), so the sidecar's meta.image (TP) / Spine texture line MUST be repointed at
        // the new page AND the old page dropped — else the loader resolves a file that no longer exists
        // (dangling-reference bug). DROP-IN: the sidecar still resolves every frame; manifest round-trips.
        // HONESTY (invariant 5): identical pixel dims ⇒ identical RGBA8888 VRAM ⇒ NO VRAM claim (disk-only).
        // The loose single-format path below is now reached ONLY for non-atlas refs (this block `continue`s).
        const atlasOfRef = atlasByRef.get(ref);
        if (atlasOfRef) {
          const isSpinePage = spineRefs.has(ref);
          const sidecar = isSpinePage ? spineInfoOf(ref)?.path : manifestPathOf(ref);
          if (!sidecar) {
            // No sidecar to repoint ⇒ re-encoding the page would dangle the (untouched) manifest. Keep original.
            skipped.push({
              assetRef: ref,
              reason: 'transcode skipped: atlas sidecar unavailable — kept original page',
            });
            continue;
          }
          // BELT-AND-SUSPENDERS (round20 #0): if a prior pass-1 repack/merge already emitted this atlas page
          // OR its sidecar (replaced.add at :1715-1716 / :1952-1959), re-encoding here from the ORIGINAL
          // bytesByRef + PRE-repack atlasOfRef geometry would silently CLOBBER the repack (last-write-wins
          // pre-zip dedup) — undoing the repack while operations[]/vramSaved already credited it. The plan's
          // `!repacked.has` guard (plan.ts:340) makes this unreachable today; this is a fail-safe so a future
          // op-ordering change can never reintroduce the double-emit. Skip honestly, keep the repacked output.
          if (replaced.has(path) || replaced.has(sidecar)) {
            skipped.push({
              assetRef: ref,
              reason: 'transcode skipped: atlas already repacked/re-emitted — kept the repacked page',
            });
            continue;
          }
          if (isSpinePage && (spineInfoOf(ref)?.pages ?? 1) > 1) {
            // emitSpineAtlasText writes ONE page; a multi-page `.atlas` would drop its sibling pages. Keep original.
            skipped.push({
              assetRef: ref,
              reason: 'transcode skipped: multi-page Spine atlas — kept original page',
            });
            continue;
          }
          // An active multi-format export profile can't safely fan one atlas page across N sidecar entries —
          // we emit ONE page in the op's target format (same scope as the loose-only fan-out gate at :2190).
          if (profileOn && resolveProfile(ref).formats.length > 1)
            skipped.push({
              assetRef: ref,
              reason: 'export profile: atlas pages stay single-format — emitted one page only',
            });
          const effA = effectiveForTranscode(ref, op.targetMime);
          const encA = await transcode(bytes, effA.targetMime, {
            ...encOptsFor(effA, false),
            opaque: op.opaque,
          });
          if (!encA) {
            skipped.push({ assetRef: ref, reason: `transcode to ${effA.targetMime} unavailable` });
            continue;
          }
          // Never ship a WORSE page from the fix that fixes dangling refs. The opaque guard (parity with the
          // loose path) PLUS a general size-loss guard for the atlas path: a larger atlas page has no
          // downstream dedup/Phase-C accounting to absorb it, so on size loss we KEEP the original page AND
          // the original sidecar (no out.push, no rename) ⇒ no dangling ref created. Honest skip.
          if (
            transcodeIsSizeLoss(op.opaque, encA.bytes.length, bytes.byteLength) ||
            encA.bytes.length >= bytes.byteLength
          ) {
            skipped.push({
              assetRef: ref,
              reason: `transcode kept original: re-encode was not smaller (${encA.bytes.length} ≥ ${bytes.byteLength} B)`,
            });
            continue;
          }
          const newPageA = renamedTo(path, encA.mime);
          // Cache-bust (round9): hash the FINAL page bytes → patch the sidecar's imageRef to the hashed page →
          // emit the sidecar → hash it. hashOff ⇒ emittedPage===newPageA, emittedSidecar===sidecar (no rename),
          // but the page name STILL changed by extension ⇒ this is reference-changing (see below).
          const emittedPageA = await hashEmit(newPageA, encA.bytes);
          out.push({ path: emittedPageA, bytes: encA.bytes });
          replaced.add(path);
          // Repoint the sidecar at the new page (relative to the SIDECAR's own dir → resolves back through
          // parseAtlas) and re-serialize it deterministically (frames/trim/pivot/mesh carried verbatim).
          const repointedA = repointAtlasImage(atlasOfRef, sidecar, emittedPageA);
          const sidecarBytesA = te.encode(
            isSpinePage ? emitSpineAtlasText(repointedA) : emitTexturePackerJson(repointedA),
          );
          const emittedSidecarA = await hashEmit(sidecar, sidecarBytesA);
          out.push({ path: emittedSidecarA, bytes: sidecarBytesA });
          replaced.add(sidecar);
          // A page-format change ALWAYS renames the page ⇒ NOT a stable-name drop-in ⇒ fire these
          // UNCONDITIONALLY (do NOT copy resize-atlas's `if (hashOn)` gate — resize keeps the source extension,
          // transcode does not). Pixi manifest: the page loads via its sidecar (meta.image / .atlas line).
          referencesChanged = true;
          recordVariant(ref, isSpinePage ? 'spine' : 'atlas', emittedPageA, {
            scale: 1,
            suffix: '',
            src: emittedSidecarA,
          });
          changeRows.push(
            ...(isSpinePage
              ? repackChanges(sidecar, emittedSidecarA) // Spine .atlas carries no static page-image map
              : repackChanges(sidecar, emittedSidecarA, emittedPageA)),
          );
          // Phase B bookkeeping: if this atlas page is a retained dedup OWNER, record its ACTUAL emitted image
          // so Phase C repoints CONSUMERS at the real page (no-op when not an owner). Mirrors the loose path.
          if (ownerActualName.has(ref)) {
            ownerActualName.get(ref)!.image = emittedPageA;
            ownerActualUnhashed.set(ref, newPageA);
          }
          // OPT-IN KTX2 (round12): offer the re-encoded page for a sibling .ktx2 + its own .ktx2.json sidecar —
          // TexturePacker ONLY. The post-pass hardcodes `.json`→`.ktx2.json` + emitTexturePackerJson, so a Spine
          // `.atlas` sidecar would ship malformed; the Spine repack path likewise records no KTX2 candidate.
          if (!isSpinePage)
            recordKtx2Candidate({
              ref,
              imagePath: emittedPageA,
              pageBytes: encA.bytes,
              pageMime: encA.mime,
              w: atlasOfRef.size.w,
              h: atlasOfRef.size.h,
              atlasSidecar: { path: emittedSidecarA, atlas: repointedA },
            });
          // DISK-only: identical pixel dims ⇒ identical RGBA8888 VRAM (invariant 5). No vramSaved increment.
          operations.push(
            `transcode atlas ${basename(ref)} → ${encA.mime.replace('image/', '')}${op.opaque ? ' (opaque)' : ''}`,
          );
          continue;
        }
        // Effective per-asset options (folder/type overrides; no downscale ⇒ scale 1 ⇒ quality unchanged).
        // Per-image MEASURED best-format pick (round17): honor the op's per-op targetMime as the resolve BASE
        // (the plan set it to the diagnosis-measured winner when bestFormatPerImage is on, else opts.targetMime
        // ⇒ identical to effectiveFor(ref, 1)). A user per-folder/type override still wins over it.
        const eff = effectiveForTranscode(ref, op.targetMime);
        // Opaque-alpha (round15): thread the op's channel-drop intent into transcode() — it composes onto an
        // `{alpha:false}` surface and (AVIF) encodes the dead alpha plane at minimum cost. DISK-only saving
        // (invariant 5); the receipt's measured before/after captures the real delta. Absent ⇒ alpha preserved.
        const enc = await transcode(bytes, eff.targetMime, {
          ...encOptsFor(eff, false),
          opaque: op.opaque,
        });
        if (!enc) {
          skipped.push({ assetRef: ref, reason: `transcode to ${eff.targetMime} unavailable` });
          // Owner transcode skipped ⇒ the owner keeps its ORIGINAL image; correct the actual name so Phase
          // C detects the divergence from its (renamed) prediction and KEEPS the consumer.
          if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = path;
          continue;
        }
        // Keep-original-on-size-LOSS (round15 #2): an "opaque" re-encode that does NOT shrink the file is no
        // optimization — never ship a LARGER (or equal) page from a drop-the-dead-alpha pass. Scoped to the
        // OPAQUE path (transcodeIsSizeLoss gates on op.opaque): the general transcode CHANGES format
        // (PNG→WebP/AVIF) where a same-or-larger result is a legitimate format choice already handled by the
        // downstream dedup/Phase-C accounting; narrowing the guard avoids regressing those flows. On loss we
        // KEEP the original: no out.push, no rename, an HONEST skip, and (owner) the actual name stays the
        // ORIGINAL so Phase C keeps the consumer pointed at it (same bookkeeping as the !enc skip above).
        if (transcodeIsSizeLoss(op.opaque, enc.bytes.length, bytes.byteLength)) {
          skipped.push({
            assetRef: ref,
            reason: `transcode kept original: opaque re-encode was not smaller (${enc.bytes.length} ≥ ${bytes.byteLength} B)`,
          });
          if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = path;
          continue;
        }
        const newPath = renamedTo(path, enc.mime); // same rename the owner-final-name prediction uses
        // Cache-bust (round9 K4): hash the FINAL bytes; the hashed name is the dedup owner image (consumers
        // repoint to it) AND the loader-migration `to`. The un-hashed newPath is the Phase-C divergence basis.
        const emittedPath = await hashEmit(newPath, enc.bytes);
        out.push({ path: emittedPath, bytes: enc.bytes });
        // Pixi manifest: a transcoded loose image loads directly (single format, single tier).
        recordVariant(ref, 'loose', path, { scale: 1, suffix: '', src: emittedPath });
        // OPT-IN KTX2 (round12): offer the transcoded loose page for a direct-format sibling .ktx2 (no JSON
        // sidecar — loose lists [x.ktx2, x.webp] in the manifest src). No-op unless the backend path is live.
        {
          const sz = sizeByRef.get(ref);
          if (sz)
            recordKtx2Candidate({
              ref,
              imagePath: emittedPath,
              pageBytes: enc.bytes,
              pageMime: enc.mime,
              w: sz.w,
              h: sz.h,
            });
        }
        replaced.add(path);
        // Phase B bookkeeping: if this transcoded image is a retained dedup OWNER, record its ACTUAL final
        // image path so Phase C points consumers at the real (possibly PNG-fallback, now content-hashed) name,
        // not the guess. The un-hashed name is recorded in parallel for Phase C's divergence comparison (K8).
        if (ownerActualName.has(ref)) {
          ownerActualName.get(ref)!.image = emittedPath;
          ownerActualUnhashed.set(ref, newPath);
        }
        if (emittedPath !== path) {
          referencesChanged = true; // a loose-image rename is NOT drop-in
          changeRows.push(looseRenameChange(path, emittedPath, 'transcode')); // loader-migration: logo.png → logo.webp
        }
        // Opaque-alpha (round15): annotate the audit trail when the dead channel was dropped (DISK-only).
        operations.push(
          `transcode ${basename(path)} → ${enc.mime.replace('image/', '')}${op.opaque ? ' (opaque)' : ''}`,
        );
      } else if (op.kind === 'drop' && op.ownerRef == null) {
        // Legacy bare-drop (no owner-aware repoint): today's behavior — delete every copy after the first.
        // Owner-aware drops (op.ownerRef set) are DEFERRED to Phase C below.
        const path = pathByRef.get(op.assetRef);
        if (path) {
          dropped.add(path);
          // if the dropped duplicate is an atlas image, drop its manifest too (else it dangles)
          const mPath = manifestPathOf(op.assetRef);
          if (mPath) dropped.add(mPath);
          const sInfo = spineInfoOf(op.assetRef);
          if (sInfo) dropped.add(sInfo.path);
          referencesChanged = true; // removing a file changes the folder's references
          changeRows.push(dropChange(path)); // loader-migration: a file the loader called was REMOVED (to: [])
          vramSaved += vramByRef.get(op.assetRef) ?? 0;
          operations.push(`drop duplicate ${basename(path)}`);
        }
      } else if (op.kind === 'pack') {
        // ── Feature 4: pack OWNED loose images into ONE new sheet (static TexturePacker JSON) or ONE
        // multi-page Spine `.atlas` (design §6). REFERENCE-CHANGING — the game must load the sheet/atlas,
        // not the loose files. The plan already excluded any dedup-consumer ref (pack owners only).
        const group = op.group;
        const isSpine = group.kind === 'spine';
        const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
        // round19 (#1): pin every loose source this pack op reads — the trim pass (bitmapOf per region) then the
        // compose pass both re-read these refs, so a big group must not evict an earlier source mid-op. Unpinned
        // by teardownPrevOp before the next op. ADDITIVE: under budget nothing evicts, so this only matters for
        // a group large enough to exceed the budget — and then it prevents a re-decode storm, never wrong pixels.
        bmpBudget!.pin(group.regions.map((r) => r.ref));

        // (1) Collision pre-check — synthesize every page/JSON/.atlas path this op would write and assert
        // none overwrites an input file or an already-emitted output. On collision, disambiguate the stem to
        // `${stem}.packed`; if THAT still collides, skip the whole group + surface (never overwrite).
        const used = new Set<string>([...inputPaths, ...out.map((o) => o.path)]);
        // The max number of pages we might emit (one page per region is the worst case) — used only to
        // synthesize candidate paths for the collision probe; the real page count comes from packLoose.
        // Probe with the REQUESTED target ext (a later AVIF→WebP/PNG fallback only narrows the real set, so
        // probing the requested ext is a superset — safe). Worst case = one page per region (the real page
        // count from packLoose is ≤ this); we probe every candidate page name + its manifest.
        const probeExt = isSpine
          ? '.png'
          : (EXT[resolveOptions(group.outDir, 'loose', baseEffective, opts.overrides).targetMime] ??
            '.png');
        const synthFor = (s: string): string[] => {
          const paths: string[] = [];
          for (let i = 0; i < group.regions.length; i++) {
            const base = i === 0 ? s : `${s}_${i}`;
            paths.push(join(group.outDir, `${base}${probeExt}`)); // page image
            if (!isSpine) paths.push(join(group.outDir, `${base}.json`)); // static: one TP JSON per page
          }
          if (isSpine) paths.push(join(group.outDir, `${s}.atlas`)); // spine: ONE multi-page .atlas
          return paths;
        };
        let stem = group.stem;
        if (synthFor(stem).some((p) => used.has(p))) {
          stem = `${group.stem}.packed`;
          if (synthFor(stem).some((p) => used.has(p))) {
            skipped.push({
              assetRef: group.id,
              reason: `pack skipped: sheet name '${group.stem}' collides with an existing file`,
            });
            continue;
          }
        }

        // (2) Per-region alpha bbox (only when op.trim): draw the FULL image once → ONE getImageData →
        // alphaBBox. Cache by ref. Fully transparent ⇒ static: 1×1 sentinel (frame resolvable, trimmed);
        // spine: skip + surface (a transparent attachment is a decoy — never a zero-size region).
        const regions: typeof group.regions = [];
        let bitmapMissing = false;
        for (const r of group.regions) {
          if (!op.trim) {
            regions.push({ ref: r.ref, name: r.name, sourceSize: r.sourceSize });
            continue;
          }
          if (trimCache.has(r.ref)) {
            const cached = trimCache.get(r.ref)!;
            if (cached === null) {
              if (isSpine) {
                skipped.push({
                  assetRef: r.ref,
                  reason: 'pack skipped: fully-transparent region (Spine decoy)',
                });
                continue;
              }
              regions.push({
                ref: r.ref,
                name: r.name,
                sourceSize: r.sourceSize,
                trim: { x: 0, y: 0, w: 1, h: 1 },
              });
            } else {
              regions.push({ ref: r.ref, name: r.name, sourceSize: r.sourceSize, trim: cached });
            }
            continue;
          }
          const bmp = await bitmapOf(r.ref);
          if (!bmp) {
            bitmapMissing = true;
            skipped.push({ assetRef: r.ref, reason: 'pack skipped: image unavailable' });
            break;
          }
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const c2d = c.getContext('2d');
          if (!c2d) {
            bitmapMissing = true;
            skipped.push({ assetRef: r.ref, reason: 'pack skipped: no 2D context' });
            break;
          }
          c2d.drawImage(bmp, 0, 0);
          const imageData = c2d.getImageData(0, 0, bmp.width, bmp.height);
          const bbox = alphaBBox(
            { data: imageData.data, width: imageData.width },
            { x: 0, y: 0, w: bmp.width, h: bmp.height },
          );
          trimCache.set(r.ref, bbox);
          if (bbox === null) {
            if (isSpine) {
              skipped.push({
                assetRef: r.ref,
                reason: 'pack skipped: fully-transparent region (Spine decoy)',
              });
              continue;
            }
            // static: 1×1 sentinel so the frame stays resolvable (trimmed, sourceSize = original).
            regions.push({
              ref: r.ref,
              name: r.name,
              sourceSize: r.sourceSize,
              trim: { x: 0, y: 0, w: 1, h: 1 },
            });
          } else {
            regions.push({ ref: r.ref, name: r.name, sourceSize: r.sourceSize, trim: bbox });
          }
        }
        if (bitmapMissing) continue; // a source image was unavailable — surfaced above, skip the group
        if (regions.length === 0) continue; // every region was a transparent decoy — nothing to pack

        // (3) Pack (pure). Spine sheets default to PNG (runtime-safe); static uses the effective target.
        const effTarget = isSpine
          ? 'image/png'
          : resolveOptions(group.outDir, 'loose', baseEffective, opts.overrides).targetMime;
        // Edge-extrude (bleed): reserve a symmetric gutter so each packed region's edge pixels have room to
        // replicate into. gutter=0 ⇒ today's pack exactly (byte-identical placements + output).
        const { gutter: extGutter, eff: extEff } = extrudeOf(op);
        const pl = packLoose(regions, {
          kind: group.kind,
          imageBase: stem,
          targetMime: effTarget,
          trim: op.trim,
          padding: op.padding,
          maxSize: op.maxSize,
          allowRotation: false,
          ...(isSpine ? { format: 'RGBA8888' } : {}),
          ...(extGutter ? { gutter: extGutter } : {}),
        });

        // (4–6) Compose + encode + emit each page. Static: sheet image + ONE TP JSON per bin (meta.image =
        // that page's basename). Spine: each page image + ONE `.atlas` concatenating emitSpineAtlasText per
        // page (each region under ITS page header, via pl.pageOfName built into the per-bin atlases).
        const eff = resolveOptions(
          group.outDir,
          isSpine ? 'spine' : 'loose',
          baseEffective,
          opts.overrides,
        );
        const encOpts: EncodeOpts = isSpine ? { allowPngFallback: true } : encOptsFor(eff, true);
        const emitted: { path: string; bytes: Uint8Array }[] = [];
        const spineBlocks: string[] = [];
        // Loader-migration: the NEW manifest(s) the game must load instead of the loose files — one TP JSON
        // per static page (collected below), or the single Spine `.atlas` (added after the compose loop) —
        // plus the REAL page-image path parallel to each static `.json` (Spine `.atlas` carries none).
        const packManifestPaths: string[] = [];
        const packPageImages: string[] = [];
        let composeOk = true;
        for (let i = 0; i < pl.atlases.length && composeOk; i++) {
          const na = pl.atlases[i]!;
          const naNames = new Set(na.sprites.map((s) => s.name));
          // extEff>0 ⇒ each packed region's edge pixels are replicated into the reserved gutter (seam fix).
          const enc = await composePageEncode(
            pl.blits.filter((b) => naNames.has(b.name)),
            na.size.w,
            na.size.h,
            effTarget,
            encOpts,
            extEff,
          );
          if (!enc) {
            composeOk = false;
            break;
          }
          const ext = EXT[enc.mime] ?? '.png';
          // packLoose synthesized imageRef from the *requested* target ext; re-point it at the ACTUAL emitted
          // mime (e.g. AVIF→WebP/PNG fallback) so meta.image / the page header name matches the real file.
          const pageBase = i === 0 ? stem : `${stem}_${i}`;
          // Cache-bust chain (round9 K5/K6): hash THIS page's IMAGE bytes → patch na.imageRef to the hashed
          // basename (the meta.image for a static page; the .atlas texture line for a Spine page) BEFORE building
          // the sidecar/block, so the referrer points at the page image that exists. hashOff ⇒ the emitted paths
          // === today's plain ones (byte-identical). The Spine .atlas is hashed LAST (joined, below).
          const emittedImage = await hashEmit(join(group.outDir, `${pageBase}${ext}`), enc.bytes);
          na.imageRef = basename(emittedImage);
          emitted.push({ path: emittedImage, bytes: enc.bytes });
          if (isSpine) {
            spineBlocks.push(emitSpineAtlasText(na)); // block now points at the hashed page image (line 0 / texture)
          } else {
            const jsonBytes = te.encode(emitTexturePackerJson(na));
            const emittedJson = await hashEmit(join(group.outDir, `${pageBase}.json`), jsonBytes);
            emitted.push({ path: emittedJson, bytes: jsonBytes });
            // Pixi manifest: one entry per packed static page `.json` (distinct ref per page; Pixi reads meta.image).
            recordVariant(emittedJson, 'atlas', emittedImage, {
              scale: 1,
              suffix: '',
              src: emittedJson,
            });
            packManifestPaths.push(emittedJson); // loader-migration: a NEW sheet manifest
            packPageImages.push(emittedImage); // ...and its REAL page image (na.imageRef on disk)
            // Sheet-diff (STATIC pages only): loose has no source atlas ⇒ occBefore=0 (honest "0% packed").
            // The representative "before" is the first packed loose region's source image (its full dims).
            const beforeRef = regions[0]!.ref;
            captureSheetDiff(
              beforeRef,
              sizeByRef.get(beforeRef) ?? na.size,
              na,
              enc.bytes,
              basename(na.imageRef),
            );
          }
        }
        if (!composeOk) {
          skipped.push({
            assetRef: group.id,
            reason: 'pack skipped: source image unavailable during compose',
          });
          continue;
        }
        if (isSpine) {
          // ONE `.atlas` = the per-page blocks concatenated (blank line between), each region already under
          // ITS page header (per-bin atlases), each texture line already pointing at the hashed page image.
          // Cache-bust (round9 K6): hash the JOINED .atlas bytes LAST (after every page block is assembled) so
          // the .atlas name reflects its final content. The skeleton .json/.skel is passed through untouched below.
          const atlasBytes = te.encode(spineBlocks.join('\n'));
          const emittedAtlas = await hashEmit(join(group.outDir, `${stem}.atlas`), atlasBytes);
          emitted.push({ path: emittedAtlas, bytes: atlasBytes });
          // Pixi manifest: a packed Spine group loads via its single multi-page `.atlas` SIDECAR (needs pixi-spine).
          recordVariant(emittedAtlas, 'spine', emittedAtlas, {
            scale: 1,
            suffix: '',
            src: emittedAtlas,
          });
          packManifestPaths.push(emittedAtlas); // loader-migration: the NEW Spine .atlas
          packPageImages.push(''); // Spine .atlas has no static-JSON page image (setChanges skips non-.json entries)
        }

        // (8b) Spine verifier — read the UNTOUCHED skeleton .json and assert every attachment that needs a
        // region resolves to one we packed. Unmatched ⇒ surface (the atlas ships, but the loader will miss
        // that attachment — honest, not silent). Unrecognized shape / .skel ⇒ honest "paths not verified".
        // A convention-detected spine root (animations/<name>/, spine/<name>/) carries NO skeletonRef — we
        // still ship its `.atlas`, but we must NOT do so silently: surface it as unverified (the central
        // honesty promise — never ship an unverified atlas with no "paths not verified" disclosure).
        if (isSpine) {
          if (!group.skeletonRef) {
            packUnverified++;
            skipped.push({
              assetRef: group.id,
              reason:
                'pack: skeleton paths not verified (no skeleton file found for this spine group)',
            });
          } else {
            const skelBytes = bytesByRefAll.get(group.skeletonRef);
            let skelJson: unknown = null;
            if (skelBytes && /\.json$/i.test(group.skeletonRef)) {
              try {
                skelJson = JSON.parse(td.decode(skelBytes));
              } catch {
                skelJson = null;
              }
            }
            const v = verifySpineSkeleton(
              skelJson,
              new Set(pl.atlases.flatMap((a) => a.sprites.map((s) => s.name))),
            );
            if (v.unverified) {
              packUnverified++;
              skipped.push({
                assetRef: group.skeletonRef,
                reason:
                  'pack: skeleton paths not verified (.skel binary or unrecognized skins shape)',
              });
            } else {
              packVerified += v.verified;
              packUnmatched += v.unmatched.length;
              for (const u of v.unmatched)
                skipped.push({
                  assetRef: group.id,
                  reason: `pack: attachment '${u.attachment}' path '${u.region}' has no matching region`,
                });
            }
          }
        }

        // (6/7) Commit the emitted files + drop the packed loose refs. Building a sheet is reference-changing.
        for (const e of emitted) out.push(e);
        for (const r of regions) {
          const p = pathByRef.get(r.ref);
          if (p) dropped.add(p);
          // packed loose source → tier loop surfaces an honest skip rather than silently dropping its tiers
          // (the packed SHEET itself is not re-fed into tiering in v1 — design §7 scope).
          if (tieringOn) tierTransformed.add(r.ref);
        }
        referencesChanged = true;
        // Loader-migration (SET→SET): each packed LOOSE file the game loaded → the new sheet/atlas manifest set.
        changeRows.push(
          ...packChanges(
            regions.map((r) => pathByRef.get(r.ref)).filter((p): p is string => !!p),
            packManifestPaths,
            packPageImages,
          ),
        );
        packedGroups++;
        packedSheetCount += pl.atlases.length;
        packedRegionCount += regions.length;
        // VRAM honesty (invariant 5 / §6.8): track the pack delta SEPARATELY — never fold it into the
        // headline vramSaved. delta = new-sheet footprint − summed loose footprint; positive ⇒ packing RAISED
        // VRAM (POT padding), which is the common case for NPOT loose images. Surfaced as its own receipt row.
        packVramDelta +=
          pl.vramBytesAfter - regions.reduce((s, r) => s + (vramByRef.get(r.ref) ?? 0), 0);
        // HONESTY (invariant 5): the extrude gutter alone may have pushed this sheet to a larger POT. Surface
        // ONLY the gutter-attributable growth (gutter pack footprint − the SAME pack with no gutter), kept
        // distinct from packVramDelta (the pack-vs-loose delta). Never claimed free; also inside packVramDelta.
        if (extGutter > 0) {
          const base = packLoose(regions, {
            kind: group.kind,
            imageBase: stem,
            targetMime: effTarget,
            trim: op.trim,
            padding: op.padding,
            maxSize: op.maxSize,
            allowRotation: false,
            ...(isSpine ? { format: 'RGBA8888' } : {}),
          });
          extrudeVramDelta += pl.vramBytesAfter - base.vramBytesAfter;
        }
        operations.push(
          `pack ${regions.length} loose → ${isSpine ? `${stem}.atlas` : `${stem} sheet`} (${pl.atlases.length} page${pl.atlases.length === 1 ? '' : 's'})`,
        );
      }
    }
    teardownPrevOp(); // round19 (#1): release the FINAL op's pins + extraction caches before Phase C / encode / zip

    // ── PHASE C — owner-aware consumer rewrites / drops (design §3d, §6) ───────────────────────────────
    // Every consumer is repointed at its OWNER's reconciled final name. We KEEP the consumer (never
    // dangle) whenever a rewrite isn't provably drop-in: a transcoded owner whose actual name diverged
    // from the prediction, a loose dup whose reference may live in game code, or a Spine page. DISK saving
    // is real and accrued here; VRAM saving is an UPPER BOUND tracked separately (invariant 5).
    for (const op of dedupDrops) {
      const consumerRef = op.assetRef;
      const consumerPath = pathByRef.get(consumerRef);
      const ownerRef = op.ownerRef!;
      const predicted = ownerFinalName.get(ownerRef);
      const actual = ownerActualName.get(ownerRef);
      // Owner missing, or its actual emitted name diverged from the plan prediction (e.g. a transcode
      // PNG-fallback) → KEEP the consumer rather than point it at a name that may not exist.
      if (!consumerPath) continue;
      // keepConsumer (design correction 8): scale tiering renames the owner away from its predicted name, so
      // owner-aware repoint is impossible. Short-circuit to keep-the-consumer here — drop NOTHING, surface a
      // skip. WITHOUT this, an atlas consumer (repointManifest suppressed) would fall through to the loose/
      // atlas repoint branch, repoint+drop against the owner's PRE-tier name, and dangle once the tier loop
      // renames + drops the owner. The kept consumer keeps its original image+manifest untouched.
      if (op.keepConsumer) {
        looseRepathSkipped++;
        skipped.push({
          assetRef: consumerRef,
          reason: `dedup skipped: owner ${basename(ownerRef)} renamed by scale tiering — kept duplicate`,
        });
        continue;
      }
      // Compare the owner's actual emitted name against the prediction on the UN-HASHED basis (round9 K8): a
      // content hash appended by cache-busting is NOT a divergence — only a real format change (e.g. an
      // AVIF→PNG fallback) is. `actual.image` (used for the repoint below) carries the hashed name; the
      // un-hashed name lives in ownerActualUnhashed. hashOff ⇒ the two are equal ⇒ identical to today.
      if (
        !predicted ||
        !actual ||
        (ownerActualUnhashed.get(ownerRef) ?? actual.image) !== predicted.image
      ) {
        looseRepathSkipped++;
        skipped.push({
          assetRef: consumerRef,
          reason: `dedup skipped: owner ${basename(ownerRef)} final name diverged — kept duplicate`,
        });
        continue;
      }
      const consumerVram = vramByRef.get(consumerRef) ?? 0;
      const consumerDisk = bytesByRef.get(consumerRef)?.byteLength ?? 0;

      // Spine consumer (checked BEFORE the repointManifest branch — a Spine ref is an atlas in atlasByRef,
      // so isAtlasRef set repointManifest, but a .atlas page has NO portable cross-page redirect and must
      // never be re-emitted as TexturePacker JSON). Never silently delete a Spine page — KEEP + surface.
      if (spineRefs.has(consumerRef)) {
        looseRepathSkipped++;
        skipped.push({
          assetRef: consumerRef,
          reason: 'dedup skipped: Spine cross-page dedup not drop-in — kept duplicate',
        });
        continue;
      }

      if (op.repointManifest) {
        // Atlas consumer: KEEP its manifest (frame rects == owner sheet by content-hash identity), repoint
        // meta.image → the owner's FINAL image, drop only the redundant consumer IMAGE. Round-trips through
        // @asset-doctor/parsers parseAtlas (which reads meta.image), so it stays a valid drop-in atlas.
        const consumerManifest = manifestPathOf(consumerRef);
        const consumerAtlas = atlasByRef.get(consumerRef);
        if (!consumerManifest || !consumerAtlas) {
          looseRepathSkipped++;
          skipped.push({
            assetRef: consumerRef,
            reason: 'dedup skipped: atlas consumer manifest unavailable — kept duplicate',
          });
          continue;
        }
        // meta.image must be relative to the consumer manifest's own directory (the owner image may sit in
        // another folder), reusing dirOf/normalize so it resolves the same way the parser does.
        const repointed: Atlas = {
          ...consumerAtlas,
          imageRef: relativeImageRef(dirOf(consumerManifest), actual.image),
        };
        out.push({ path: consumerManifest, bytes: te.encode(emitTexturePackerJson(repointed)) });
        replaced.add(consumerManifest);
        dropped.add(consumerPath); // drop only the redundant image; manifest is kept (rewritten above)
        referencesChanged = true;
        referencesRewritten++;
        dedupDiskBytesSaved += consumerDisk;
        dedupVramBytesSavedUpperBound += consumerVram;
        operations.push(
          `dedup ${basename(consumerRef)} → ${basename(ownerRef)} (repoint meta.image)`,
        );
        continue;
      }

      // Whole-file (loose) consumer: drop + rewrite ONLY where AD itself emits the referencing manifest;
      // otherwise the reference may live in game code → KEEP + surface (fail-safe, the one place dedup
      // could silently break a build).
      const referencingManifest = manifestPathOf(consumerRef);
      if (!referencingManifest) {
        looseRepathSkipped++;
        skipped.push({
          assetRef: consumerRef,
          reason: 'dedup skipped: loose duplicate reference may live in game code — kept duplicate',
        });
        continue;
      }
      const referencingAtlas = atlasByRef.get(consumerRef);
      if (!referencingAtlas) {
        looseRepathSkipped++;
        skipped.push({
          assetRef: consumerRef,
          reason: 'dedup skipped: referencing manifest unavailable — kept duplicate',
        });
        continue;
      }
      const repointed: Atlas = {
        ...referencingAtlas,
        imageRef: relativeImageRef(dirOf(referencingManifest), actual.image),
      };
      out.push({ path: referencingManifest, bytes: te.encode(emitTexturePackerJson(repointed)) });
      replaced.add(referencingManifest);
      dropped.add(consumerPath);
      referencesChanged = true;
      referencesRewritten++;
      dedupDiskBytesSaved += consumerDisk;
      dedupVramBytesSavedUpperBound += consumerVram;
      operations.push(
        `dedup ${basename(consumerRef)} → ${basename(ownerRef)} (repoint meta.image)`,
      );
    }

    // ── SCALE-TIER MULTIPLIER (design docs/scale-tiers-design.md §5/§7) ─────────────────────────────────
    // The OUTERMOST per-asset multiplier: for each tier-eligible asset that no earlier transform claimed
    // (its source path is neither `replaced` nor `dropped`), emit one downscaled copy per validated tier
    // and rename the source away (every original path → `dropped`, so the pass-through never ships an
    // un-suffixed original beside `_1080p`). This loop OWNS oversize clamping: it clamps the top tier to
    // maxEdge ONCE, then derives EVERY tier from the SAME source bitmap with one high-quality drawImage
    // each (single resample chain, never tier-from-tier; NEVER upscales). Tiering is REFERENCE-CHANGING
    // (the game must select a tier at runtime) and contributes 0 to vramSaved (tiers are alternatives — the
    // top tier == the source footprint). The folder-already-tiered case skips the whole loop honestly.
    // Selective fix: when `tier` is DESELECTED the whole tier multiplier is skipped (no pixel work); the
    // honest "tier skipped: deselected in plan" note is surfaced once via deselectedSkips below, so the
    // tier-context skips here (folder-already-tiered / dedup-disabled) — which describe tiering behavior that
    // will NOT happen — are gated off. tierExcluded false ⇒ identical to today.
    if (tieringOn && !tierExcluded && folderAlreadyTiered) {
      skipped.push({
        assetRef: '(folder)',
        reason: 'tier skipped: folder already ships resolution tiers',
      });
    }
    // Dedup × tiering (design correction 8): when both are on, plan.ts disables owner-aware repoint (tiering
    // renames owners, so a repoint would target a name that no longer exists). Surface it once, honestly.
    if (
      tieringOn &&
      !tierExcluded &&
      !folderAlreadyTiered &&
      opts.aggressive &&
      dedupGroups &&
      dedupGroups.length > 0
    ) {
      skipped.push({
        assetRef: '(dedup)',
        reason: 'dedup repoint disabled: scale tiering renames owners (kept duplicate consumers)',
      });
    }
    if (tieringOn && !tierExcluded && !folderAlreadyTiered) {
      // Edge-clamp source dimensions to maxEdge (same longest-edge math as plan.ts pass-1 oversize). NEVER
      // upscales — only the longest edge over maxEdge is shrunk; otherwise identity.
      const clampToMaxEdge = (size: Size): Size => {
        const longest = Math.max(size.w, size.h);
        if (!(longest > opts.maxEdge)) return { w: size.w, h: size.h };
        const s = opts.maxEdge / longest;
        return { w: Math.max(1, Math.round(size.w * s)), h: Math.max(1, Math.round(size.h * s)) };
      };
      for (const a of merged) {
        const ref = a.kind === 'atlas' ? a.atlas.name : a.image.name;
        const refusal = tierRefusal(ref);
        if (refusal) {
          skipped.push({ assetRef: ref, reason: refusal });
          continue;
        }
        const imagePath = pathByRef.get(ref);
        if (!imagePath) continue;
        // A repack / atlas-merge / Feature-4 pack pass claimed this asset. In v1 the tier loop does NOT
        // re-feed the emitted sheet into tiering (design §7 scope), so be HONEST rather than a silent no-op:
        // surface a skipped[] entry so the receipt count reflects it. (This is the common headline case — an
        // under-filled atlas the user enabled tiers on gets repacked.) Checked BEFORE the generic
        // replaced/dropped guard so dedup-dropped duplicates stay correctly silent (they're redundant).
        if (tierTransformed.has(ref)) {
          skipped.push({
            assetRef: ref,
            reason:
              'tier skipped: asset was repacked/merged/packed (its sheet is not tiered in v1)',
          });
          continue;
        }
        // An earlier transform already owns this asset (resize/transcode/dedup) — it is NOT in the plan's
        // `tiered` set, so it kept its single-scale op. Never double-emit a tier of it.
        if (replaced.has(imagePath) || dropped.has(imagePath)) continue;
        const bytes = bytesByRef.get(ref);
        const srcSize = sizeByRef.get(ref);
        if (!bytes || !srcSize) continue;
        const isSpine = spineRefs.has(ref);
        const atlas = atlasByRef.get(ref);
        // round10-profile-overrides.md §5 Site B: resolve THIS ref's effective formats+global ONCE for the whole
        // tier loop (reused inside every tier iteration). No matching override ⇒ rp.formats===profileFormats /
        // rp.global===profileGlobal (by reference) ⇒ byte-identical to the pre-round10 tier emit. `refMulti` is
        // the PER-REF multi flag (an override can change the format COUNT) — it replaces the global profileMulti
        // at the Spine note + every variantManifestName below so per-ref single/multi naming is correct.
        const rp = profileOn ? resolveProfile(ref) : undefined;
        const refMulti = rp ? rp.formats.length > 1 : profileMulti;
        // ROUND7 T9: Spine pages STAY PNG (runtime-safe) — a multi-format profile can't fan a Spine page out
        // across webp/avif, so it degrades to a single PNG per tier. Surface ONE honest note per Spine asset
        // (never a silent single-format result for a multi-format profile request). Single-format ⇒ no note.
        // Keys on the PER-REF count (refMulti) so a font/folder override that drops Spine to one format is silent.
        if (profileOn && refMulti && isSpine) {
          skipped.push({
            assetRef: ref,
            reason:
              'export profile: Spine pages stay PNG — emitted PNG only (no webp/avif fan-out)',
          });
        }
        const srcBmp = await createImageBitmap(new Blob([bytes]));
        const srcW = srcBmp.width;
        const srcH = srcBmp.height;
        // Top-tier (full-source) size after the oversize clamp — every tier derives from THIS, scaled.
        const top = clampToMaxEdge(srcSize);

        const manifestPath = !isSpine ? manifestPathOf(ref) : undefined;
        const spineInfo = isSpine ? spineInfoOf(ref) : undefined;
        // Spine skeleton (.json/.skel) lives in bytesByRefAll (a marker file), not pathByRef — read it so we
        // can emit one copy per tier under the suffixed name (design §3c), then drop the original.
        const skelPath = isSpine ? findSpineSkeletonPath(files, imagePath) : undefined;
        const skelBytes = skelPath ? bytesByRefAll.get(skelPath) : undefined;

        // Loader-migration: the path the game's loader CALLED before tiering — the MANIFEST for an atlas/Spine
        // asset (the loader loads thing.json/.atlas, which tieredName renames), the IMAGE for a loose tiered
        // image (B3). Falls back to the image only when no AD-emitted manifest exists (rare parsed-atlas case).
        const tierSourceLoad = (isSpine ? spineInfo?.path : manifestPath) ?? imagePath;
        const tierTargetPaths: string[] = []; // the tier ladder of NEW load targets (one per emitted tier)
        let emittedAny = false;
        let composeFailed = false;
        for (let ti = 0; ti < tiers.length; ti++) {
          const tier = tiers[ti]!;
          // Atlas geometry FIRST (so the pixel canvas matches scaleAtlas's sheet dims EXACTLY — same as the
          // resize-atlas path). scaleAtlas is the PURE primitive (NEVER stamps .scale); effectiveScale folds
          // the oversize clamp (top.w/srcSize.w) into the tier scale, mirroring resize's `op.to.w/size.w`.
          // The TIER LOOP sets scaled.scale = tier.scale (exact ladder value only). Loose: the 1px-floor
          // scaleLoose of the clamped top. For an un-oversized top tier at scale 1 both are the identity.
          const effectiveScale = (top.w / srcSize.w) * tier.scale;
          const scaled = atlas ? scaleAtlas(atlas, effectiveScale) : undefined;
          const dst: Size = scaled
            ? { w: scaled.size.w, h: scaled.size.h }
            : scaleLoose(top, tier.scale);
          const canvas = new OffscreenCanvas(dst.w, dst.h);
          const c2d = canvas.getContext('2d');
          if (!c2d) {
            skipped.push({ assetRef: ref, reason: 'tier skipped: no 2D context' });
            composeFailed = true;
            break;
          }
          c2d.imageSmoothingQuality = 'high'; // best-effort resample — kernel/pre-blur disclosed honestly
          // ONE drawImage from the SAME source bitmap (never tier-from-tier): src full rect → dst. The canvas
          // is composed ONCE per tier and REUSED across every format below (multiple getImageData / encode
          // off the same c2d) — honesty + the cost cap preserved (round7-export-profile.md §5c).
          c2d.drawImage(srcBmp, 0, 0, srcW, srcH, 0, 0, dst.w, dst.h);

          // Effective per-asset encode options + scale-aware quality on the downscale (folds folder/type
          // overrides). The tiered output uses the POST-transcode mime so a format+tiered asset is one
          // encode per tier at the target. Spine pages stay PNG (runtime-safe), mirroring repack/resize.
          const eff = effectiveFor(ref, tier.scale);
          // ROUND7 T7: inner FORMAT loop — emit one file per (format × tier). PROFILE ON ⇒ fan out across the
          // validated profile formats (formatEncode → encodeCanvas with lossless THREADED, B1). PROFILE OFF ⇒
          // a SINGLE legacy descriptor reproducing today's `encOptsFor(eff, true)` exactly ⇒ byte-identical.
          // Spine pages STAY PNG regardless (a webp/avif profile target degrades to PNG with one honest note).
          const tierEncodes: {
            mime: ImageMime;
            encOpts: EncodeOpts;
            fmtLabel: string;
            nativePng?: boolean;
          }[] = rp
            ? rp.formats.map((f) => {
                const fe = formatEncode(f, tier.scale, rp.global);
                // round13: thread the `nativePng` marker (FormatTarget.pngLossy) so the tier PNG-emit site can be
                // HONEST about pngquant being out of v1 scope on the multi-tier/atlas path (see the skip below).
                return {
                  mime: isSpine ? 'image/png' : fe.targetMime,
                  encOpts: feToEncodeOpts(fe),
                  fmtLabel: f.format,
                  nativePng: fe.nativePng,
                };
              })
            : [
                {
                  mime: isSpine ? 'image/png' : eff.targetMime,
                  encOpts: encOptsFor(eff, true),
                  fmtLabel: eff.targetMime,
                },
              ];
          // B4 collision guard (round7-export-profile.md §5b/§9): two formats can resolve to the SAME actual
          // mime post-encode via the AVIF→WebP→PNG / WebP→PNG fallbacks; emit the FIRST, SKIP the later (honest
          // note) — never overwrite. Keyed on the actual emitted image path (which carries the post-encode ext).
          const emittedThisTier = new Set<string>();
          // round24 resample: collect the (path, mime, encOpts) variants emitted at THIS tier so the post-pass
          // can re-encode the vips tile to each + replace `out` in place. A no-op shell when resample is off
          // (resampleTierTargets stays empty ⇒ no candidate recorded ⇒ byte-identical). The tile.scale<1 guard
          // below ensures the top tier (scale 1, no downscale ⇒ nothing for lanczos3 to improve) is skipped.
          const resampleTierTargets: ResampleTarget[] = [];
          for (const te0 of tierEncodes) {
            const enc = await encodeCanvas(canvas, c2d, te0.mime, te0.encOpts);
            if (!enc) {
              skipped.push({
                assetRef: ref,
                reason: `tier skipped: encode to ${te0.mime} unavailable`,
              });
              // PROFILE OFF (single descriptor): a failed encode is fatal for the whole asset, as today.
              // PROFILE ON (fan-out): skip just THIS format and try the next one (honest per-format note).
              if (!profileOn) {
                composeFailed = true;
                break;
              }
              continue;
            }
            // Image path: insert the tier suffix before the extension, swapping ext for the emitted mime.
            const tierImagePath = tieredName(imagePath, tier.suffix, enc.mime);
            if (emittedThisTier.has(tierImagePath)) {
              // B4: a later format fell back to a mime an earlier variant already emitted at this tier. The guard
              // keys on the UN-hashed tier image name so a format-fallback collision is caught before hashing.
              skipped.push({
                assetRef: ref,
                reason: `${te0.fmtLabel} fell back to ${enc.mime} and collides with another variant — skipped`,
              });
              continue;
            }
            emittedThisTier.add(tierImagePath);
            // Cache-bust chain (round9 K7/M1): compute the hashed image + hashed sidecar names ONCE per
            // (tier×format) iteration and thread the SAME locals into out.push / recordVariant / tierChanges AND
            // tierTargetPaths (never re-derive an un-hashed name). Order: hash the IMAGE → patch scaled.imageRef →
            // emit sidecar → hash sidecar. hashOff ⇒ emittedImage===tierImagePath, emittedSidecar===the plain
            // variantManifestName (byte-identical). The skeleton copy is NOT hashed (runtime-convention referrer).
            const emittedImage = await hashEmit(tierImagePath, enc.bytes);
            out.push({ path: emittedImage, bytes: enc.bytes });
            // round24 resample: record this variant's emitted path + format so the post-pass can replace its
            // bytes in place with the lanczos3 tile (only collected when resampleEnabled, and only for a real
            // downscale — tier.scale<1; the candidate is pushed after the format loop). hashOff is guaranteed by
            // the gate (B1) ⇒ emittedImage===tierImagePath is byte-stable, so the in-place replace is sound.
            if (resampleEnabled && tier.scale < 1)
              resampleTierTargets.push({ path: emittedImage, mime: enc.mime, encOpts: te0.encOpts });
            tierFilesEmitted++;
            if (profileOn) profileFilesEmitted++;
            // round13 finding [0]: a `nativePng`-marked PNG (FormatTarget.pngLossy) reached the MULTI-TIER path
            // (a profile with a lower tier, or an atlas/Spine page). pngquant is single-tier-loose-only in v1 —
            // so this lossless PNG ships WITHOUT a pngquant attempt. NEVER a silent drop (invariant 3): surface
            // ONE honest skipped[] note per ref. Gated on pngquantOn so backend-off/declined ⇒ byte-identical.
            if (
              pngquantOn &&
              enc.mime === 'image/png' &&
              te0.nativePng &&
              !pngquantTierSkipNoted.has(ref)
            ) {
              pngquantTierSkipNoted.add(ref);
              skipped.push({
                assetRef: ref,
                reason:
                  'pngquant skipped: lossy PNG applies only to single-tier loose pages — emitted lossless',
              });
            }
            // The variant's NEW load target = the suffixed+tokened MANIFEST (atlas/Spine) or the IMAGE (loose);
            // computed once below (hashed) and pushed into tierTargetPaths + recordVariant.
            let emittedLoadTarget = emittedImage;
            // Pixi manifest: a LOOSE tier loads the IMAGE directly; record here (the atlas/Spine sidecar push
            // below records those tiers). Variants sharing tier.suffix (e.g. avif+webp) merge into one entry.
            if (!scaled)
              recordVariant(ref, 'loose', imagePath, {
                scale: tier.scale,
                suffix: tier.suffix,
                src: emittedImage,
              });

            if (scaled) {
              // Repoint imageRef at THIS tier+format's own image + stamp the exact ladder scale, so the
              // per-tier manifest's meta.image/meta.scale describe THIS emit (emitTexturePackerJson / Spine).
              // Single-format ⇒ variantManifestName produces the LEGACY `_suffix.json` name (byte-identical);
              // multi-format ⇒ the format token (`.webp`/`.avif`) disambiguates so the manifests never clobber.
              scaled.scale = tier.scale;
              scaled.imageRef = basename(emittedImage);
              if (isSpine && spineInfo) {
                const atlasBytes = te.encode(emitSpineAtlasText(scaled));
                const emittedSidecar = await hashEmit(
                  variantManifestName(spineInfo.path, tier.suffix, enc.mime, refMulti),
                  atlasBytes,
                );
                out.push({ path: emittedSidecar, bytes: atlasBytes });
                emittedLoadTarget = emittedSidecar;
                // Pixi manifest: a Spine tier loads via its per-tier `.atlas` SIDECAR (one entry per tier suffix).
                recordVariant(ref, 'spine', imagePath, {
                  scale: tier.scale,
                  suffix: tier.suffix,
                  src: emittedSidecar,
                });
                tierFilesEmitted++;
                if (profileOn) profileFilesEmitted++;
                if (skelBytes && skelPath) {
                  // Skeleton copy is NOT content-hashed (K7): it is referenced by runtime convention, no
                  // AD-owned writable link. Emit one per-tier copy under its suffixed name, unchanged.
                  out.push({
                    path: variantManifestName(skelPath, tier.suffix, enc.mime, refMulti),
                    bytes: new Uint8Array(skelBytes),
                  });
                  tierFilesEmitted++;
                  if (profileOn) profileFilesEmitted++;
                }
              } else if (manifestPath) {
                const jsonBytes = te.encode(emitTexturePackerJson(scaled));
                const emittedSidecar = await hashEmit(
                  variantManifestName(manifestPath, tier.suffix, enc.mime, refMulti),
                  jsonBytes,
                );
                out.push({ path: emittedSidecar, bytes: jsonBytes });
                emittedLoadTarget = emittedSidecar;
                // Pixi manifest: an atlas tier loads via its per-tier `.json` SIDECAR (one entry per tier suffix;
                // avif+webp at the same tier merge into one entry's `src`). Pixi reads meta.image from the sidecar.
                recordVariant(ref, 'atlas', imagePath, {
                  scale: tier.scale,
                  suffix: tier.suffix,
                  src: emittedSidecar,
                });
                tierFilesEmitted++;
                if (profileOn) profileFilesEmitted++;
              }
            }

            // Loader-migration: this variant's NEW load target — the SAME hashed local computed above (never
            // re-derived via a second variantManifestName call, M1), so the row references the file that exists.
            tierTargetPaths.push(emittedLoadTarget);
            emittedAny = true;
          }
          if (composeFailed) break;
          // VRAM ladder rung: ONE footprint per tier (the loaded tier's pixel area), regardless of how many
          // FORMATS were emitted — the runtime loads ONE format at this tier, so format fan-out adds DISK
          // only, never VRAM (invariant 5). Recorded once per tier, after the format loop.
          if (emittedThisTier.size > 0)
            tierVramBytes[ti] = (tierVramBytes[ti] ?? 0) + dst.w * dst.h * 4;
          // round24 resample: register ONE candidate per downscaled tier that emitted ≥1 variant. Capture the
          // browser tile's RGBA ImageData (off the canvas the browser already composed — the HONEST fallback
          // baseline the HF-energy delta measures against) + the full-res source bytes + the exact tier dims.
          // No-op when resample is off (resampleTierTargets is empty). The post-pass uploads the full-res source
          // (PNG-re-encoded) ONCE per tier, gets the lanczos3 tile, measures the delta, and replaces each
          // target's bytes in place. cancelled is re-checked per candidate in the post-pass.
          if (resampleEnabled && resampleTierTargets.length > 0) {
            const browserTile = c2d.getImageData(0, 0, dst.w, dst.h);
            recordResampleCandidate({
              ref,
              srcBytes: bytes,
              targetW: dst.w,
              targetH: dst.h,
              browserTile,
              targets: resampleTierTargets,
            });
          }
          // round24 B1: resample is opted-in but SUPPRESSED by hashFilenames (v1 gates it off rather than
          // re-threading the cache-bust chain). Surface ONE honest note per downscaled-tier ref so it is never
          // a silent no-op (invariant 3); emittedThisTier>0 means this ref actually got a downscaled tier.
          if (resampleHashSkipPending && tier.scale < 1 && emittedThisTier.size > 0 && !resampleHashSkipNoted.has(ref)) {
            resampleHashSkipNoted.add(ref);
            skipped.push({
              assetRef: ref,
              reason:
                'resample skipped: lanczos3 tier downscale is not yet supported with content-hash cache-busting — used the browser resampler',
            });
          }
        }
        srcBmp.close();
        if (composeFailed || !emittedAny) continue;

        // Rename the source away: drop EVERY original path for this asset (image + manifest/.atlas +
        // skeleton) so the pass-through can't ship an un-suffixed original next to the tiers.
        dropped.add(imagePath);
        if (atlas) {
          if (isSpine) {
            if (spineInfo) dropped.add(spineInfo.path);
            if (skelPath) dropped.add(skelPath);
          } else if (manifestPath) {
            dropped.add(manifestPath);
          }
        }
        referencesChanged = true; // tiering renames the source ⇒ NOT a drop-in replacement
        // Loader-migration (SET→SET): the source load target → the full tier ladder of new load targets.
        changeRows.push(...tierChanges(tierSourceLoad, tierTargetPaths));
        tieredAssets++;
        // ROUND7 T9: when the profile drove this multi-tier emit, count it as a fanned-out profile asset too
        // (profileFilesEmitted was accrued per variant above). The asset is owned ⇒ no standalone op double-runs.
        if (profileOn) {
          profileAssets++;
          profileOwned.add(ref);
        }
        operations.push(
          `tier ${basename(ref)} → ${tiers.length} resolution${tiers.length === 1 ? '' : 's'}`,
        );
      }
    }

    // ── FORMAT-ONLY EXPORT-PROFILE PASS (round7-export-profile.md §5d, finding [0] fix-a) ───────────────
    // A format-only profile (≥1 format, single scale-1 tier ⇒ profileHasLowerTier=false ⇒ tieringOn=false)
    // is an EXPLICIT request to emit the chosen formats for the FOLDER, not a fix that rides an existing
    // analysis finding. The riding fan-out in the resize/transcode handlers only fires for assets the
    // analysis FLAGGED (a `format` finding ⇒ transcode op, a `dimensions-oversize` finding ⇒ resize op —
    // plan.ts:234/262). So a clean loose image (already a good format, not oversized) produced ZERO ops, the
    // riding fan-out never ran, and the user got NOTHING and no feedback — a silent no-op that contradicts a
    // "config-driven EXPORT profile" + violates the surfaced-never-silent honesty discipline (invariant 3).
    // This first-class pass closes that gap: drive the fan-out over EVERY eligible loose asset (mirroring how
    // the tier loop iterates `merged`), independent of whether the analysis flagged it. Multi-tier profiles
    // are UNAFFECTED — they already iterate all of `merged` via the tier loop above (this pass is gated off
    // for them by !profileHasLowerTier). Loose images only (design scope "loose-transcode/loose-resize"): an
    // atlas page keeps its single-format manifest meta.image so it isn't left dangling across N variants.
    // Respects every prior claim: `profileOwned` (already fanned out by a riding op), `replaced`/`dropped`
    // (claimed by a transform), and the selective-fix tier exclusion is irrelevant (no tier kind here). Each
    // eligible image is decoded ONCE to a scale-1 canvas; emitLooseProfileFanout owns the per-format emit +
    // B4 collision guard + dedup-owner bookkeeping. Profile absent / multi-tier ⇒ this block never runs ⇒
    // byte-identical to today. Deterministic: `merged` is a stable order; profileFormats is the given order.
    if (profileOn && !profileHasLowerTier) {
      for (const a of merged) {
        if (a.kind !== 'image') continue; // loose images only (atlases keep their single-format manifest)
        const ref = a.image.name;
        if (profileOwned.has(ref)) continue; // a riding resize/transcode op already fanned this out
        const imagePath = pathByRef.get(ref);
        if (!imagePath) continue;
        if (replaced.has(imagePath) || dropped.has(imagePath)) continue; // claimed by an earlier transform
        const bytes = bytesByRef.get(ref);
        if (!bytes) continue;
        const bmp = await createImageBitmap(new Blob([bytes]));
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const c2d = canvas.getContext('2d');
        if (!c2d) {
          bmp.close();
          skipped.push({ assetRef: ref, reason: 'export profile: no 2D context' });
          continue;
        }
        c2d.drawImage(bmp, 0, 0); // scale 1 (the format-only profile's single top tier)
        bmp.close();
        const r = await emitLooseProfileFanout(ref, imagePath, 1, canvas, c2d, 'transcode');
        if (ownerActualName.has(ref)) {
          // Cache-bust (round9 K8): dedup owner image = the fan-out's first (hashed) variant; un-hashed for
          // Phase C's divergence comparison (a content hash is not a divergence). hashOff ⇒ the two are equal.
          ownerActualName.get(ref)!.image = r.ownerImage;
          ownerActualUnhashed.set(ref, r.ownerImageUnhashed);
        }
        if (r.referencesChanged) referencesChanged = true;
        // Per-ref count (overrides may REPLACE the format list); no override ⇒ === profileFormats.length.
        const nFmt = resolveProfile(ref).formats.length;
        operations.push(
          `export profile ${basename(imagePath)} → ${nFmt} format${nFmt === 1 ? '' : 's'}`,
        );
      }
    }

    // A VALID profile that fanned out NOTHING (e.g. an atlas-only folder, or every loose image was already
    // dropped/repacked/owned) — surface an honest `(profile)` skip so the user sees WHY their explicit
    // request produced no variants (finding [0]: surfaced-never-silent). The receipt still carries
    // exportProfile with assets=0 (above), so the two together are fully honest. profileOff ⇒ no note.
    if (profileOn && profileAssets === 0) {
      skipped.push({
        assetRef: '(profile)',
        reason:
          'export profile: no eligible loose images to emit (atlas-only folder or all claimed by another fix)',
      });
    }

    // ── SELECTIVE FIX honest skips (docs/improvements/selective-fix.md) ───────────────────────────────
    // For every op KIND the dev DESELECTED in the Plan card that WOULD have run, surface ONE honest skipped[]
    // note ("<kind> skipped: deselected in plan"), in OP_KIND_ORDER. No pixel work ran for these (the loops
    // above already `continue`d/gated past them), so the receipt now reflects exactly what executed — a
    // deselected op is SURFACED, never silently dropped (no faked savings). excludeKinds empty ⇒ this is a
    // no-op ⇒ skipped[] / receipt byte-identical to today.
    for (const s of deselectedSkips(excluded, wouldRunByKind)) skipped.push(s);

    // ── pass-through untouched files → drop-in optimized folder ──
    // Pixi manifest: a pass-through that is a PARSED LOOSE IMAGE still belongs in the asset map (a complete
    // load map). Reverse-index the loose-image refs by path so we record ONLY those — a non-image / non-asset
    // pass-through (README, hand-authored .json, font, audio) is never an entry. Built only when the toggle is on.
    const looseRefByPath = manifestAssets
      ? new Map<string, string>(
          [...pathByRef.entries()]
            .filter(([ref]) => kindOf(ref) === 'loose')
            .map(([ref, p]) => [p, ref]),
        )
      : undefined;
    for (const f of files) {
      if (replaced.has(f.path) || dropped.has(f.path)) continue;
      const bytes = new Uint8Array(f.bytes);
      const looseRef = looseRefByPath?.get(f.path);
      // Cache-bust (round9 BLOCKER-0): a non-transformed LOOSE dedup OWNER was pre-hashed before Phase C (its
      // hashed name is already in ownerActualName.image, which the consumer's meta.image now points at). Emit
      // it at THAT exact pre-hashed path — REGARDLESS of `looseRef`/manifestOn — because the consumer atlas
      // manifest (always re-emitted by Phase C) is the guaranteed AD-owned referrer, so the rename can't 404.
      // Reusing the recorded name (not re-hashing) keeps the emission single-sourced and order-safe.
      const prehashed = hashOn ? prehashedLooseOwner.get(f.path) : undefined;
      // Cache-bust pass-through gate (round9 K8/B2): a pass-through LOOSE image is content-hashed ONLY when it
      // is a recorded loose ref — which (looseRefByPath being built solely when manifestOn) ALSO means the Pixi
      // manifest is emitted, the GUARANTEED referrer AD can patch. A loose image with no AD-owned referrer
      // (manifest off, OR a hand-authored/unparsed manifest, OR a name hard-coded in game code) is NOT hashed
      // (its rename would 404). Non-asset pass-throughs (README/font/audio/unparsed .json) are never `looseRef`
      // ⇒ never hashed. hashOff or no manifest ⇒ emitted at f.path unchanged (byte-identical to today).
      const emittedPath =
        prehashed ?? (hashOn && looseRef ? await hashEmit(f.path, bytes) : f.path);
      out.push({ path: emittedPath, bytes });
      if (looseRef)
        recordVariant(looseRef, 'loose', f.path, { scale: 1, suffix: '', src: emittedPath });
      if (looseRef && emittedPath !== f.path) {
        // The manifest src[] (recorded above) is the guaranteed referrer; also surface an honest loader-migration
        // row so a game loading this image directly (not via the manifest) learns the new name.
        referencesChanged = true;
        changeRows.push(looseRenameChange(f.path, emittedPath, 'transcode'));
      }
    }

    // ── OPT-IN backend native KTX2 post-pass (round12-backend-processing.md, Phase 3 T14/T15/T16) ─────────
    // SAFETY (load-bearing): backendOn false ⇒ ktx2Candidates is empty ⇒ this loop never runs ⇒ `out` is
    // unchanged ⇒ the zip is BYTE-IDENTICAL to today. It runs ONLY when the user configured a backend AND
    // ticked per-run consent AND a KTX2-eligible page exists. Assets leave the device HERE and ONLY here.
    //
    // For each eligible RASTER page already in `out` (KEPT — KTX2 is additive, never a replacement):
    //   1. re-decode the emitted page to a lossless PNG (the sidecar transcodes THIS, so the .ktx2 matches
    //      the browser-composed page byte-for-byte in pixels).
    //   2. upload it via encodeRemote → the gateway verifies the token + quota-limits + reverse-proxies to
    //      the apps/encoder sidecar; on success we get raw .ktx2 bytes.
    //   3. add `<name>.ktx2` to `out`. For an ATLAS page, ALSO emit a SECOND `.ktx2.json` sidecar (round8:
    //      a multi-format atlas needs TWO json sidecars, not a multi-format `src` array) with meta.image →
    //      the .ktx2, and record a manifest variant whose `src` is that .ktx2.json (ktx2-first). For a LOOSE
    //      page, record a direct-format `.ktx2` manifest variant so the entry's src lists [x.ktx2, x.webp].
    //   4. charge the HONEST worst-case VRAM CEILING (vramCeilingOfPage, NEVER w·h·4) — reported SEPARATELY
    //      (ktx2VramBytesWorstCase), never folded into vramBytesAfter (invariant 5).
    // On ANY failure (unreachable / declined / size cap / encode error) we KEEP the browser raster page and
    // surface an HONEST skipped[] note — never a silent skip. referencesChanged is set (the game must add a
    // KTX2 transcoder bundle + loader); the receipt note discloses the extra weight + that requirement.
    let ktx2Op: NativeOpKind | undefined;
    let ktx2Uploaded = 0;
    let ktx2Produced = 0;
    let ktx2Failed = 0;
    let ktx2VramBytesWorstCase = 0;
    // GPU-VRAM probe side-channel (round15): collect the produced `.ktx2` + its raster page (FRESH slices, so
    // the zip/`out` buffers stay intact — same discipline as captureSheetDiff) for the MAIN-thread probe (the
    // worker has no WebGL). Capped (KTX2_PROBE_MAX, mirror SHEET_DIFF_MAX) to bound the zero-copy transfer; the
    // rest still contribute ktx2VramBytesWorstCase only ("measured N of M"). Empty ⇒ no probe ⇒ byte-identical.
    // The gate + fresh-slice build live in the pure ktx2-probe-collect helper (unit-tested in Node).
    const ktx2Probe: Ktx2ProbeInput[] = [];
    if (backendOn && ktx2Candidates.length > 0) {
      const backend = opts.backend!; // backendOn guarantees presence + consent
      ktx2Op = 'ktx2';
      let i = 0;
      for (const c of ktx2Candidates) {
        if (cancelled) return; // superseded — stop before the next (re-encode + upload) ktx2 candidate
        post({
          type: 'fix-progress',
          label: `ktx2 ${basename(c.imagePath)}`,
          done: i++,
          total: ktx2Candidates.length,
        });
        // (1) re-decode the emitted page → lossless PNG source for the sidecar.
        let pngBytes: Uint8Array | null = null;
        try {
          const bmp = await createImageBitmap(
            new Blob([c.pageBytes as BlobPart], { type: c.pageMime }),
          );
          const canvas = new OffscreenCanvas(bmp.width, bmp.height);
          const c2d = canvas.getContext('2d');
          if (c2d) {
            c2d.drawImage(bmp, 0, 0);
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            pngBytes = new Uint8Array(await blob.arrayBuffer());
          }
          bmp.close();
        } catch {
          pngBytes = null;
        }
        if (!pngBytes) {
          ktx2Failed++;
          skipped.push({
            assetRef: c.ref,
            reason: 'ktx2 skipped: could not re-encode page for upload — kept browser image',
          });
          continue;
        }
        // (2) upload (the ONLY network call; gated by consent above). Never throws (encodeRemote catches).
        ktx2Uploaded++;
        const res = await encodeRemote(pngBytes, 'ktx2', c.w, c.h, {
          apiBase: backend.apiBase,
          token: backend.token,
        });
        if (!res.ok) {
          // HONEST fallback: keep the browser raster page (already in `out`), surface WHY (the gateway code).
          ktx2Failed++;
          skipped.push({
            assetRef: c.ref,
            reason: `ktx2 skipped: backend ${res.code} — kept browser image`,
          });
          continue;
        }
        // (3) ADD the .ktx2 sibling (raster page kept). Path = the page image path with a .ktx2 extension.
        const ktx2Path = c.imagePath.replace(/\.[a-z0-9]+$/i, '.ktx2');
        out.push({ path: ktx2Path, bytes: res.bytes });
        ktx2Produced++;
        // GPU-VRAM probe (round15): retain the produced `.ktx2` + its raster page as FRESH slices (the `out`/zip
        // copies stay intact) so the host can measure real compressed residency on its GPU. Capped (the rest
        // keep only the worst-case ceiling). Detached ArrayBuffers transfer zero-copy on fix-done. The cap gate +
        // the fresh-slice build are the PURE collectKtx2Probe helper (unit-tested in Node).
        collectKtx2Probe(ktx2Probe, res.bytes, c.pageBytes, c.pageMime, KTX2_PROBE_MAX);
        referencesChanged = true; // the game must add a KTX2 transcoder bundle + loader (not a drop-in)
        if (c.atlasSidecar) {
          // ATLAS: emit a SECOND sidecar `<page>.ktx2.json` (round8 two-sidecar rule) whose meta.image → the
          // .ktx2, relative to the original sidecar's directory. List it (ktx2-first) in the manifest src.
          const sidecarDir = dirOf(c.atlasSidecar.path);
          const ktx2Sidecar: Atlas = {
            ...c.atlasSidecar.atlas,
            imageRef: relativeImageRef(sidecarDir, ktx2Path),
          };
          const ktx2JsonPath = c.atlasSidecar.path.replace(/\.json$/i, '.ktx2.json');
          out.push({ path: ktx2JsonPath, bytes: te.encode(emitTexturePackerJson(ktx2Sidecar)) });
          // Pixi manifest: the .ktx2.json sidecar is the ktx2-first src candidate for this page's entry.
          recordVariant(c.ref, 'atlas', ktx2Path, { scale: 1, suffix: '', src: ktx2JsonPath });
        } else {
          // LOOSE: direct-format candidate — record the .ktx2 itself so the entry's src lists [x.ktx2, x.webp].
          recordVariant(c.ref, 'loose', ktx2Path, { scale: 1, suffix: '', src: ktx2Path });
        }
        // (4) HONEST VRAM ceiling (≤, never w·h·4). Mips baked per the pinned profile ⇒ ×4/3 (the SAME
        // conditional rule the raster path uses). Reported SEPARATELY (invariant 5), never folded.
        ktx2VramBytesWorstCase += vramCeilingOfPage(
          'ktx2-uastc',
          c.w,
          c.h,
          KTX2_PROFILE_BAKES_MIPS,
        );
      }
    }

    // ── OPT-IN backend native pngquant IN-PLACE post-pass (round13-pngquant-backend.md, Phase 3 T11) ───────
    // SAFETY (load-bearing): pngquantOn false ⇒ pngquantCandidates is empty ⇒ this loop never runs ⇒ `out` is
    // unchanged ⇒ the zip is BYTE-IDENTICAL to today. It runs ONLY when the user configured a backend AND
    // ticked per-run consent AND a `nativePng`-marked PNG page exists. Assets leave the device HERE (and in the
    // KTX2 pass) and only here.
    //
    // For each eligible composed PNG page already in `out`:
    //   1. upload its lossless PNG bytes via encodeRemote('pngquant', …) → the gateway verifies the token +
    //      quota-limits + reverse-proxies to the apps/encoder sidecar; on 200 we get the re-compressed PNG.
    //   2. REPLACE the page bytes at the SAME path (push a new `out` entry at c.path; the pre-zip Map below is
    //      last-write-wins, so the pngquant bytes win — NO new file, NO referencesChanged: a quantized PNG is
    //      a drop-in for the lossless one, the loader calls the SAME name).
    //   3. accumulate REAL measured disk byte sums (bytesBefore = the lossless page; bytesAfter = the quantized
    //      page) — the honest "smaller download" claim. NO VRAM field (disk-only; vramCeiling stays w·h·4).
    // On a quality-floor DECLINE (M1: code 'quality_floor') we KEEP the lossless page — it is NOT a failure and
    // does NOT increment `failed`. On any other failure (unreachable / declined / encode error) we KEEP the
    // lossless page, surface an HONEST skipped[] note, and DO count it as failed.
    let pngquantUploaded = 0;
    let pngquantProduced = 0;
    let pngquantFailed = 0;
    let pngquantBytesBefore = 0;
    let pngquantBytesAfter = 0;
    if (pngquantOn && pngquantCandidates.length > 0) {
      const backend = opts.backend!; // pngquantOn guarantees presence + consent
      let i = 0;
      for (const c of pngquantCandidates) {
        if (cancelled) return; // superseded — stop before the next (upload) pngquant candidate
        post({
          type: 'fix-progress',
          label: `pngquant ${basename(c.path)}`,
          done: i++,
          total: pngquantCandidates.length,
        });
        pngquantUploaded++;
        const res = await encodeRemote(c.bytes, 'pngquant', c.w, c.h, {
          apiBase: backend.apiBase,
          token: backend.token,
        });
        if (!res.ok) {
          if (res.code === 'quality_floor') {
            // HONEST DECLINE (M1): pngquant couldn't beat the floor → keep the lossless PNG. NOT a failure.
            skipped.push({
              assetRef: c.ref,
              reason: 'pngquant kept original: could not meet the quality floor',
            });
          } else {
            pngquantFailed++;
            skipped.push({
              assetRef: c.ref,
              reason: `pngquant skipped: backend ${res.code} — kept lossless PNG`,
            });
          }
          continue;
        }
        // REPLACE in place (same path). The pre-zip Map is last-write-wins, so this overrides the lossless page.
        // NO referencesChanged (drop-in same-name), NO new file, NO VRAM field (disk-only — invariant 5).
        out.push({ path: c.path, bytes: res.bytes });
        pngquantProduced++;
        pngquantBytesBefore += c.bytes.length;
        pngquantBytesAfter += res.bytes.length;
      }
    }

    // ── OPT-IN libvips lanczos3 resample tier post-pass (round24-libvips-lanczos3-resample-op-sidecar.md) ───
    // SAFETY (load-bearing): resampleEnabled false ⇒ resampleCandidates is empty ⇒ this loop never runs ⇒
    // `out` is unchanged ⇒ the zip is BYTE-IDENTICAL to today (the existing OffscreenCanvas tier downscale's
    // output stands). It runs ONLY when the user configured a backend AND ticked per-run consent AND opted the
    // `resample` op in AND hashFilenames is OFF (B1). Assets leave the device HERE (and in the KTX2/pngquant
    // passes) and only here.
    //
    // For each DOWNSCALED tier candidate (one per ref×tier):
    //   1. PNG-re-encode the FULL-RES source page (M2: the source may be lossy JPEG/WebP, but the sidecar's
    //      `png` field expects PNG — reuse the KTX2 createImageBitmap→drawImage→convertToBlob('image/png')
    //      idiom). The full-res PNG is materially larger than a tile and pushes the 32 MiB/8192/64 Mpx caps —
    //      an oversized upload 413/415s and we fall back to the browser tile honestly.
    //   2. upload it via encodeRemote('resample', targetW, targetH) → the gateway verifies token + quota +
    //      reverse-proxies to the sidecar; on 200 we get a lanczos3 PNG tile at EXACTLY the tier dims.
    //   3. measure the HONEST high-frequency-energy retention delta (vips tile vs the browser tile, SAME dims)
    //      — a MEASURED fact, never a verdict (invariant 3). Accumulate the energies for ONE aggregate.
    //   4. re-encode the vips bitmap to EACH tier format for this candidate + REPLACE the page bytes at the
    //      SAME path (the pre-zip Map is last-write-wins). DISK/QUALITY-only: same dims/format/path as the
    //      browser tile ⇒ NO new file, NO referencesChanged, NO VRAM/disk claim, ever.
    // On ANY failure (re-encode fail / unreachable / declined / size cap / vips decode fail) or a ≤0 delta we
    // KEEP the browser tile (already in `out`) and surface an HONEST skipped[] note. `failed` counts only REAL
    // failures (≤0 delta = kept, NOT a failure).
    let resampleOpRan = false;
    let resampleUploaded = 0;
    let resampleProduced = 0;
    let resampleFailed = 0;
    let resampleSumVipsEnergy = 0;
    let resampleSumBrowserEnergy = 0;
    if (resampleEnabled && resampleCandidates.length > 0) {
      const backend = opts.backend!; // resampleEnabled guarantees presence + consent + token + host
      resampleOpRan = true;
      let i = 0;
      for (const c of resampleCandidates) {
        if (cancelled) return; // superseded — stop before the next (re-encode + upload) resample candidate
        post({
          type: 'fix-progress',
          label: `resample ${basename(c.ref)}`,
          done: i++,
          total: resampleCandidates.length,
        });
        // (1) PNG-re-encode the FULL-RES source for the sidecar (M2 — handles lossy JPEG/WebP sources).
        let pngBytes: Uint8Array | null = null;
        try {
          const bmp = await createImageBitmap(new Blob([c.srcBytes as BlobPart]));
          const canvas = new OffscreenCanvas(bmp.width, bmp.height);
          const c2d = canvas.getContext('2d');
          if (c2d) {
            c2d.drawImage(bmp, 0, 0);
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            pngBytes = new Uint8Array(await blob.arrayBuffer());
          }
          bmp.close();
        } catch {
          pngBytes = null;
        }
        if (!pngBytes) {
          resampleFailed++;
          skipped.push({
            assetRef: c.ref,
            reason: 'resample skipped: could not re-encode the full-res source for upload — kept browser tile',
          });
          continue;
        }
        // (2) upload (the ONLY network call; gated by consent above). Never throws (encodeRemote catches).
        //     For resample, w/h are the OUTPUT target tier dims (the asymmetry vs ktx2/pngquant).
        resampleUploaded++;
        const res = await encodeRemote(pngBytes, 'resample', c.targetW, c.targetH, {
          apiBase: backend.apiBase,
          token: backend.token,
        });
        if (!res.ok) {
          resampleFailed++;
          skipped.push({
            assetRef: c.ref,
            reason: `resample skipped: backend ${res.code} — kept browser tile`,
          });
          continue;
        }
        // (3) decode the vips PNG tile + measure the HONEST HF-energy retention vs the browser tile (same dims).
        let vipsData: ImageData | null = null;
        try {
          const vbmp = await createImageBitmap(new Blob([res.bytes as BlobPart], { type: 'image/png' }));
          if (vbmp.width === c.targetW && vbmp.height === c.targetH) {
            const vcanvas = new OffscreenCanvas(c.targetW, c.targetH);
            const vctx = vcanvas.getContext('2d');
            if (vctx) {
              vctx.drawImage(vbmp, 0, 0);
              vipsData = vctx.getImageData(0, 0, c.targetW, c.targetH);
            }
          }
          vbmp.close();
        } catch {
          vipsData = null;
        }
        if (!vipsData) {
          resampleFailed++;
          skipped.push({
            assetRef: c.ref,
            reason: 'resample skipped: could not decode the backend tile — kept browser tile',
          });
          continue;
        }
        const vipsEnergy = hfEnergy(vipsData.data, c.targetW, c.targetH);
        const browserEnergy = hfEnergy(c.browserTile.data, c.targetW, c.targetH);
        if (vipsEnergy <= browserEnergy) {
          // ≤0 delta: lanczos3 did NOT retain more high-frequency content here — KEEP the browser tile. This is
          // an HONEST outcome (NOT a failure): it does NOT increment `failed`, and it contributes 0 to the
          // aggregate (the browser tile is already in `out`). Surface it so it's never a silent no-op.
          skipped.push({
            assetRef: c.ref,
            reason: 'resample kept browser tile: lanczos3 did not retain more high-frequency content here',
          });
          continue;
        }
        // (4) re-encode the vips bitmap to EACH tier format + REPLACE the page bytes in place (B1: hashOff ⇒
        //     the path is byte-stable, so an in-place replace is sound — the pre-zip Map is last-write-wins).
        let replacedAny = false;
        try {
          const tbmp = await createImageBitmap(
            new ImageData(
              new Uint8ClampedArray(vipsData.data),
              c.targetW,
              c.targetH,
            ),
          );
          for (const tgt of c.targets) {
            const tcanvas = new OffscreenCanvas(c.targetW, c.targetH);
            const tctx = tcanvas.getContext('2d');
            if (!tctx) continue;
            tctx.drawImage(tbmp, 0, 0);
            const enc = await encodeCanvas(tcanvas, tctx, tgt.mime, tgt.encOpts);
            if (enc) {
              out.push({ path: tgt.path, bytes: enc.bytes }); // in-place replace (same path, last-write-wins)
              replacedAny = true;
            }
          }
          tbmp.close();
        } catch {
          replacedAny = false;
        }
        if (!replacedAny) {
          resampleFailed++;
          skipped.push({
            assetRef: c.ref,
            reason: 'resample skipped: could not re-encode the backend tile to the tier format(s) — kept browser tile',
          });
          continue;
        }
        resampleProduced++;
        resampleSumVipsEnergy += vipsEnergy;
        resampleSumBrowserEnergy += browserEnergy;
      }
    }

    if (cancelled) return; // superseded — skip the (potentially large) zip build entirely
    post({ type: 'fix-progress', label: 'zipping', done: total - 1, total });
    // `out` path-dedup before zip (design §6 step 9): last-write-wins for a deliberate replace; guards
    // against a duplicate path ever reaching makeZip. Order-preserving on first appearance (determinism).
    const byPath = new Map<string, Uint8Array>();
    for (const e of out) byPath.set(e.path, e.bytes);
    const dedupedOut: { path: string; bytes: Uint8Array }[] = [];
    const seen = new Set<string>();
    for (const e of out) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      dedupedOut.push({ path: e.path, bytes: byPath.get(e.path)! });
    }
    // ── PixiJS-v8 asset manifest (round8-pixi-manifest.md C5) — emit ONE entry, AFTER dedup, LAST ────────
    // ADDITIVITY (load-bearing): OFF ⇒ manifestAssets is undefined ⇒ this block is skipped ⇒ dedupedOut is
    // unchanged ⇒ makeZip input byte-identical ⇒ zip byte-identical to today. ON-but-empty (a do-nothing fix)
    // ⇒ size===0 ⇒ also skipped ⇒ byte-identical. ON-with-entries ⇒ ONE deterministic manifest.json appended.
    // Pure string work (no native libs, no network — invariant 1); sums no saving (invariant 5).
    let pixiManifest: { assets: number; path: string } | undefined;
    if (manifestAssets && manifestAssets.size > 0) {
      const assets = [...manifestAssets.values()];
      // includeFileSizes (round23 #2): when set, build a Map<src, finalByteLength> over `dedupedOut` — the
      // FINAL shipped bytes (post pngquant/KTX2 in-place replacement), keyed by exactly the path strings the
      // manifest `src` uses. This avoids the stale-lossless-size trap of recording bytes at the push site, and
      // supplies the gzip source for 'gzip' mode. Absent ⇒ srcBytes stays undefined ⇒ the spread-gated call
      // below omits BOTH options ⇒ the builder's off-path runs ⇒ manifest BYTE-IDENTICAL to today.
      let srcBytes: Map<string, number> | undefined;
      if (opts.includeFileSizes) {
        srcBytes = new Map();
        for (const e of dedupedOut) {
          const len = opts.includeFileSizes === 'gzip' ? await gzipLen(e.bytes) : e.bytes.length;
          srcBytes.set(e.path, len);
        }
      }
      const json = buildPixiManifest(
        assets,
        opts.includeFileSizes ? { includeFileSizes: opts.includeFileSizes, srcBytes } : {},
      );
      const path = pickManifestPath(inputPaths, dedupedOut);
      dedupedOut.push({ path, bytes: te.encode(json) });
      pixiManifest = { assets: countPixiManifestEntries(assets), path };
    }
    const entries: ZipEntry[] = dedupedOut.map((e) => ({ name: e.path, bytes: e.bytes }));
    const zip = makeZip(entries);

    const diskBefore = files.reduce((s, f) => s + f.bytes.byteLength, 0);
    const diskAfter = dedupedOut.reduce((s, e) => s + e.bytes.byteLength, 0);
    const vramBefore = report.totals.vramBytes;
    // Loader-migration guide (docs/improvements/loader-migration.md): the genuine loader-CALL changes this
    // run made, sorted+deduped deterministically. DEDUP contributed ZERO rows (B1). Attached ONLY when
    // referencesChanged AND ≥1 real row exists — drop-in / no-op runs omit it ⇒ receipt byte-identical.
    const changes = finalizeChanges(changeRows);
    // OPT-IN backend native ops (round12 §7 + round13): ONE backendNative entry per op that actually ran
    // (uploaded>0). KTX2 carries the SEPARATE ktx2VramBytesWorstCase sibling (GPU-VRAM win); pngquant carries
    // bytesBefore/bytesAfter (REAL measured disk-only "smaller download") and NO VRAM field — a quantized PNG
    // decodes to full RGBA8888 ⇒ vramCeiling unchanged (invariant 5). Empty ⇒ omitted ⇒ byte-identical to today.
    const backendHost = opts.backend ? opts.backend.apiBase.replace(/\/+$/, '') : '';
    const backendNative: NonNullable<FixReceipt['backendNative']> = [];
    if (ktx2Op && ktx2Uploaded > 0) {
      backendNative.push({
        op: ktx2Op,
        uploaded: ktx2Uploaded,
        produced: ktx2Produced,
        failed: ktx2Failed,
        host: backendHost,
      });
    }
    // round13 #8: SUPPRESS an all-decline pngquant entry. When every candidate fell back (produced===0 — e.g.
    // already-optimal PNGs that can't beat the 256-color quality floor) the entry would read a MISLEADING
    // "0 of N re-compressed — 0 B → 0 B download". The per-page declines are ALREADY surfaced honestly in
    // skipped[] ("pngquant kept original: could not meet the quality floor"), so we omit the empty receipt
    // block rather than fake a no-op success. We still emit the entry when ≥1 page was produced (real disk
    // win) OR when ≥1 page hard-FAILED (so receiptFailed surfaces the unreachable/declined count honestly).
    if (pngquantProduced > 0 || pngquantFailed > 0) {
      backendNative.push({
        op: 'pngquant',
        uploaded: pngquantUploaded,
        produced: pngquantProduced,
        failed: pngquantFailed,
        host: backendHost,
        bytesBefore: pngquantBytesBefore,
        bytesAfter: pngquantBytesAfter,
      });
    }
    // round24 resample: ONE entry when the op ran AND ≥1 tile was produced OR ≥1 hard-FAILED (mirrors the
    // pngquant all-decline suppression — a run where every candidate was a ≤0-delta KEEP surfaces those in
    // skipped[] but emits no misleading "0 produced" block). The ONLY number it carries is the MEASURED
    // high-frequency-energy retention delta (invariant 3 — a fact, not a verdict); there is NO disk/VRAM field
    // (invariant 5 — the tile is the SAME dims/format as the browser tile). On a 0-produced/failed-only run the
    // aggregate is 0 (no fabricated number). Empty ⇒ omitted ⇒ receipt byte-identical to today.
    if (resampleOpRan && (resampleProduced > 0 || resampleFailed > 0)) {
      backendNative.push({
        op: 'resample',
        uploaded: resampleUploaded,
        produced: resampleProduced,
        failed: resampleFailed,
        host: backendHost,
        qualityHfEnergyDelta: aggregateHfEnergyDelta(resampleSumVipsEnergy, resampleSumBrowserEnergy),
      });
    }
    const receipt: FixReceipt = {
      diskBytesBefore: diskBefore,
      diskBytesAfter: diskAfter,
      vramBytesBefore: vramBefore,
      vramBytesAfter: Math.max(0, vramBefore - vramSaved),
      fileCount: dedupedOut.length,
      changedCount: replaced.size + dropped.size,
      operations,
      skipped,
      referencesChanged,
      // Loader-migration guide (additive, optional): the concrete loader-CALL rewrites this run made, so the
      // UI can list real repointings + emit engine-aware (Pixi/Phaser) snippets. Emitted ONLY when references
      // genuinely changed AND ≥1 real load-call row exists (dedup contributes none — B1). Absent ⇒ no guide;
      // drop-in / no-op runs omit it ⇒ receipt byte-identical to today.
      ...(referencesChanged && changes.length > 0 ? { changes } : {}),
      // Owner-aware dedup (additive, optional — absent in non-dedup runs ⇒ receipt byte-identical to today).
      // referencesRewritten / looseRepathSkipped count Phase-C outcomes. dedupDiskBytesSaved is REAL; the
      // VRAM saving is an UPPER BOUND (realized only if the runtime shares one GPU upload across the dropped
      // copies) — reported SEPARATELY and never folded into the hard vramBytesAfter (invariant 5).
      ...(referencesRewritten > 0 ? { referencesRewritten } : {}),
      ...(looseRepathSkipped > 0 ? { looseRepathSkipped } : {}),
      ...(dedupDiskBytesSaved > 0 ? { dedupDiskBytesSaved } : {}),
      ...(dedupVramBytesSavedUpperBound > 0 ? { dedupVramBytesSavedUpperBound } : {}),
      // Polygon mode (additive, optional): meshSprites counts sprites carrying a mesh in the SELECTED
      // results (0 on fallback ⇒ omit); polygonAreaSavedPct is the measured VRAM delta, only when a
      // polygon result actually won. Absent in non-polygon runs ⇒ receipt is byte-identical to today.
      ...(meshSpritesTotal > 0 ? { meshSprites: meshSpritesTotal } : {}),
      ...(polyVramBefore > 0
        ? { polygonAreaSavedPct: (polyVramBefore - polyVramAfter) / polyVramBefore }
        : {}),
      // Feature 4 (pack loose, additive, optional): packedSheets = packs performed / page images emitted /
      // loose files folded in (now dropped). packVerification = Spine path-verification (verified matched /
      // unmatched / unverified). Absent in non-pack runs ⇒ receipt byte-identical to today.
      ...(packedGroups > 0
        ? {
            packedSheets: {
              groups: packedGroups,
              sheets: packedSheetCount,
              regions: packedRegionCount,
            },
          }
        : {}),
      ...(packVerified > 0 || packUnmatched > 0 || packUnverified > 0
        ? {
            packVerification: {
              verified: packVerified,
              unmatched: packUnmatched,
              unverified: packUnverified,
            },
          }
        : {}),
      // Pack VRAM delta (invariant 5): present SEPARATELY, never folded into vramBytesAfter. Emitted only on
      // an actual pack run with a non-zero delta — a positive value means packing RAISED VRAM (POT padding).
      ...(packedGroups > 0 && packVramDelta !== 0 ? { packVramDelta } : {}),
      // Scale-tier export (additive, optional — absent in non-tier runs ⇒ receipt byte-identical to today).
      // Counts ONLY assets actually tiered (refused/skipped excluded). tierVram exposes the per-tier loaded
      // footprint ladder; it is NEVER folded into vramBytesAfter (invariant 5) and tiering adds 0 to vramSaved
      // (the top tier == the source footprint — tiers are alternatives, the runtime loads exactly one).
      ...(tieredAssets > 0
        ? {
            scaleTiered: {
              tiers: tiers.length,
              filesEmitted: tierFilesEmitted,
              assets: tieredAssets,
            },
          }
        : {}),
      ...(tieredAssets > 0
        ? {
            tierVram: tiers.map((t, i) => ({
              suffix: t.suffix,
              scale: t.scale,
              vramBytes: tierVramBytes[i]!,
            })),
          }
        : {}),
      // Config-driven export profile (round7-export-profile.md §3/§9, T9 — additive, optional). `formats`/
      // `tiers` = the VALIDATED counts; `assets` = assets fanned out; `filesEmitted` = total variant files (Σ
      // image + manifest/skeleton across formats × tiers). DISK-only — the runtime loads ONE format × ONE tier,
      // so this contributes 0 to vramBytesAfter (the per-tier VRAM ladder stays `tierVram`; invariant 5).
      // Surfaced whenever the profile was VALID (profileOn) — finding [0]: an explicit profile request must
      // ALWAYS report what it produced, INCLUDING assets=0 (an honest "nothing to fan out" — never silent).
      // `tiers` uses profileTiers.length (the validated profile ladder: a format-only profile carries a single
      // scale-1 top tier even though the legacy `tiers` array is empty for it). Absent only when no valid
      // profile ran ⇒ receipt byte-identical to today.
      ...(profileOn
        ? {
            exportProfile: {
              formats: profileFormats.length,
              tiers: profileTiers.length,
              assets: profileAssets,
              filesEmitted: profileFilesEmitted,
            },
          }
        : {}),
      // Edge-extrude (bleed, design OPTION A — additive, optional). extrudePx = the requested bleed width;
      // extrudedBlits = rectangle blits that got a real bleed; extrudeSkipped = blits where extrude was
      // REQUESTED but skipped (meshed clip / rotated — no polygon-edge/rotated extrude in v1). extrudeVramDelta
      // = HONEST VRAM growth from the symmetric gutter pushing a sheet to a larger POT (invariant 5: a gutter
      // CAN grow a bin ⇒ MORE VRAM — never claimed free; the growth is ALSO already inside vramBytes*). All
      // absent unless extrude>0 actually ran ⇒ receipt byte-identical to today (default OFF).
      ...(extrudedBlits > 0 ? { extrudePx: extrudePxApplied, extrudedBlits } : {}),
      ...(extrudeSkippedCount > 0 ? { extrudeSkipped: extrudeSkippedCount } : {}),
      ...(extrudeVramDelta !== 0 ? { extrudeVramDelta } : {}),
      // Frame-redundancy aliasing (round19, additive/optional): the total byte-identical frames aliased onto a
      // shared region. The smaller-sheet VRAM win is ALREADY inside vramBytesBefore/After (exact). 0 ⇒ omitted
      // ⇒ receipt byte-identical to today (no frame-redundancy finding, or the toggle was off).
      ...(framesAliasedTotal > 0 ? { framesAliased: framesAliasedTotal } : {}),
      // Cross-atlas frame dedup during MERGE (round22 #1, additive/optional): byte-identical frames that spanned
      // MULTIPLE source sheets, deduped onto ONE merged region. crossSheetFramesDeduped = the headline count
      // (subset of framesAliased); crossSheetVramReclaimedBytes = the EXACT measured VRAM delta (0 ⇒ disk-only,
      // POT tier unchanged — invariant 5); crossSheetPotTierDropped = TRUE iff a POT tier actually dropped. The
      // VRAM win is ALSO already inside vramBytesBefore/After. 0 ⇒ omitted ⇒ receipt byte-identical to today.
      ...(crossSheetFramesTotal > 0
        ? {
            crossSheetFramesDeduped: crossSheetFramesTotal,
            crossSheetVramReclaimedBytes: crossSheetVramReclaimed,
            crossSheetPotTierDropped: crossSheetPotTierDropped,
          }
        : {}),
      // Trim-on-repack (round20, additive/optional): the count of UNtrimmed sprites tightened to their opaque
      // bounds across every repack this run + the MEASURED atlas px reclaimed (Σ frame − bbox). Every tightened
      // sprite renders identically in-engine from a smaller sheet (drop-in: name resolves; manifest carries
      // trimmed:true + sourceSize + spriteSourceSize). The VRAM win is ALREADY inside vramBytesBefore/After
      // (exact). 0 ⇒ omitted ⇒ receipt byte-identical to today (no shrinkable untrimmed sprite / no repack ran).
      ...(trimmedSpritesTotal > 0 ? { trimmedSprites: trimmedSpritesTotal, trimmedAreaReclaimed: trimmedAreaTotal } : {}),
      // Sheet-diff X-ray (round6-f1-sheet-diff.md, additive/optional): before/after FilmViewer pairs for the
      // first SHEET_DIFF_MAX composed sheets; sheetDiffsTotal counts ALL composed ("showing N of M"). Empty
      // ⇒ both omitted ⇒ receipt byte-identical to today.
      ...(sheetDiffs.length > 0 ? { sheetDiffs, sheetDiffsTotal } : {}),
      // PixiJS-v8 asset manifest (round8-pixi-manifest.md, additive/optional): present ONLY when the opt-in
      // ran with ≥1 recorded entry. Absent ⇒ no manifest emitted ⇒ receipt byte-identical to today.
      ...(pixiManifest ? { pixiManifest } : {}),
      // OPT-IN backend native ops (round12 §7 + round13, additive/optional). An ARRAY: one entry per op that
      // ran (uploaded>0) — ktx2 and/or pngquant. `host` is the gateway origin (no token, no bytes). ktx2 carries
      // the SEPARATE ktx2VramBytesWorstCase sibling (GPU win); pngquant carries bytesBefore/After (disk-only
      // "smaller download") and NO VRAM field (invariant 5). Empty ⇒ omitted ⇒ receipt byte-identical to today.
      ...(backendNative.length > 0 ? { backendNative } : {}),
      ...(ktx2VramBytesWorstCase > 0 ? { ktx2VramBytesWorstCase } : {}),
      // round15: ≥1 `.ktx2` page produced ⇒ flag it so the loader-migration snippet leads ONCE with
      // `import 'pixi.js/ktx2'` (the manifest lists the ktx2 candidate first; that src fails to resolve without
      // the loader registered). Gated ⇒ non-KTX2 runs omit it ⇒ receipt byte-identical to today.
      ...(ktx2Produced > 0 ? { ktx2Produced: true } : {}),
      // round19-fix-worker-memory-bounds.md (#1, descriptive/optional): the decoded-source working-set the LRU
      // bounded — peak simultaneous decoded pages + the byte budget. NOT a VRAM/saving number (invariant 5);
      // a CPU-side decode bound only. Gated on peakCount > 0 (a real decode happened) ⇒ a no-decode run omits
      // it ⇒ receipt byte-identical to today.
      ...(bmpBudget && bmpBudget.peakCount > 0
        ? {
            decodeWorkingSet: {
              decodedPages: bmpBudget.peakCount,
              budgetBytes: BITMAP_BUDGET_BYTES,
            },
          }
        : {}),
    };
    // Direct postMessage (not the `post` wrapper) so the sheet-diff + ktx2-probe byte buffers transfer
    // zero-copy. The transferred buffers are FRESH COPIES (captureSheetDiff + the ktx2 collection both
    // sliced), so the live source/emitted buffers already in `out`→zip stay intact. Empty ⇒ empty transfer
    // list + omitted ktx2Probe ⇒ identical to today.
    const transfer = [
      ...sheetDiffs.flatMap((d) => [d.beforeBytes, d.afterBytes]),
      ...ktx2Probe.flatMap((p) => [p.ktx2Bytes, p.rasterBytes]),
    ];
    if (cancelled) return; // superseded — suppress a fix-done that would race the terminate
    ctx.postMessage(
      {
        type: 'fix-done',
        receipt,
        zip,
        ...(ktx2Probe.length > 0 ? { ktx2Probe } : {}),
      } satisfies FixResponse,
      transfer,
    );
  } finally {
    // round19 (#1): close ALL remaining cached source bitmaps the instant this run ends — normal completion,
    // the `if (cancelled) return` exits above, OR a thrown error (which still propagates to the onmessage
    // catch). drain() ignores pins (they are eviction-advisory only), so a cancel mid-op frees everything,
    // including the in-flight op's pinned sources. Undefined in plan mode / a cancel before the decode loop
    // ⇒ no-op ⇒ byte-identical to today.
    bmpBudget?.drain();
  }
}

/** Format-audit encoder: measure a candidate format's byte size via native canvas (matches the
 *  diagnosis). Returns null when the codec isn't available (silent PNG fallback). */
function makeEncoder(bytesByRef: Map<string, ArrayBuffer>): EncodeSizer {
  return async (assetRef, _sourceMime, targetMime) => {
    const bytes = bytesByRef.get(assetRef);
    if (!bytes) return null;
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const c2d = canvas.getContext('2d');
      if (!c2d) return null;
      c2d.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await canvas.convertToBlob({ type: targetMime, quality: 0.9 });
      return blob.type === targetMime ? blob.size : null;
    } catch {
      return null;
    }
  };
}

interface EncodeOpts {
  /** 0..1 fraction (native convertToBlob semantics). @jsquash paths scale it ×100. */
  quality?: number;
  lossless?: boolean;
  /** Encoder effort 0(fast)..6(max). >0 routes WebP through @jsquash (method) even when lossy. */
  effort?: number;
  /** WebP near-lossless 0..100 (100 ⇒ off). <100 routes WebP through @jsquash near_lossless. */
  webpNearLossless?: number;
  /** AVIF alpha quality (qualityAlpha). Omit ⇒ -1 (track quality, @jsquash default behavior). */
  avifQualityAlpha?: number;
  /** AVIF chroma subsample integer (field wired; no UI toggle ships — kept hidden, §4d). */
  avifSubsample?: number;
  /** Lossless PNG recompress via @jsquash/oxipng level 0..6 (Task 10). Omit ⇒ off (no WASM loaded). */
  pngRecompressLevel?: number;
  /** When the target codec is unavailable: true → fall back to PNG, false → return null (honest skip). */
  allowPngFallback?: boolean;
  /** Opaque-alpha (round15): drop the (DEAD) alpha channel — the Pro fix for a `wasted-alpha` finding. The
   *  CALLER must have composed the source onto a genuinely opaque `{alpha:false}` surface (transcode() and
   *  the fan-out do this when set), so every pixel's alpha is 255. This flag then nudges the @jsquash codecs
   *  to actually OMIT the channel rather than store a constant plane: AVIF gets qualityAlpha:0 (the all-255
   *  plane is encoded at minimum cost), WebP lossy/lossless rely on the opaque canvas (native + @jsquash both
   *  see no transparency). HONESTY (invariant 5): DISK-only — the GPU still decodes to RGBA8888. The byte win
   *  is whatever is MEASURED downstream, never asserted. Absent/false ⇒ alpha preserved (today's behavior). */
  opaque?: boolean;
}

const clamp06 = (n: number): number => Math.max(0, Math.min(6, Math.round(n)));

// Lazy oxipng module handle (Task 10). Loaded ON FIRST USE ONLY — never imported in the diagnosis path,
// so the diagnosis bundle/payload (invariant 4, ≤10s) is untouched until a Pro fix actually opts in to
// PNG recompression. Cached so repeated PNG recompresses in one run share the single WASM init.
// @jsquash/oxipng re-exports its optimiser as the NAMED export `optimise` (index.js does
// `export { default as optimise } from './optimise.js'`), so the module shape is { optimise }, not { default }.
type OxipngMod = {
  optimise: (d: ImageData | ArrayBuffer, o?: { level?: number }) => Promise<ArrayBuffer>;
};
let oxipngMod: Promise<OxipngMod> | null = null;
const loadOxipng = (): Promise<OxipngMod> => {
  if (!oxipngMod) oxipngMod = import('@jsquash/oxipng') as Promise<OxipngMod>;
  return oxipngMod;
};

/** Encode an OffscreenCanvas. CONTRACT (design §4c): native `convertToBlob` stays the LOSSY fast-path
 *  (lossy WebP, lossy single image, canvas-composed sheets); @jsquash is used ONLY where canvas lacks the
 *  codec — AVIF (all), lossless WebP, near-lossless WebP, and when `effort` is explicitly raised. Lossy/
 *  composed encodes are NEVER routed through @jsquash. Feature-detects the silent PNG fallback so we never
 *  mislabel an output. */
async function encodeCanvas(
  canvas: OffscreenCanvas,
  c2d: OffscreenCanvasRenderingContext2D,
  target: ImageMime,
  opts: EncodeOpts,
): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
  const q = opts.quality ?? 0.85;
  const effort = clamp06(opts.effort ?? 0);
  if (target === 'image/avif') {
    // AVIF has no canvas encoder → always @jsquash. speed is inverse to effort (higher effort = slower/
    // better): effort 0→speed 10 (fast), effort 6→speed 6. subsample only when explicitly supplied.
    try {
      const data = c2d.getImageData(0, 0, canvas.width, canvas.height);
      const m = (await import('@jsquash/avif')) as {
        encode: (d: ImageData, o?: Record<string, number | boolean>) => Promise<ArrayBuffer>;
      };
      const buf = await m.encode(data, {
        quality: Math.round(q * 100),
        // Opaque-alpha (round15): a genuinely opaque source (alpha all-255) — encode the dead alpha plane at
        // minimum cost (qualityAlpha:0) instead of tracking quality, so the channel is near-free. DISK-only
        // (invariant 5). Otherwise honor the explicit knob or the @jsquash default (-1, tracks quality).
        qualityAlpha: opts.opaque ? 0 : (opts.avifQualityAlpha ?? -1),
        speed: 10 - Math.round((effort / 6) * 4),
        enableSharpYUV: true,
        ...(opts.avifSubsample != null ? { subsample: opts.avifSubsample } : {}),
      });
      if (buf && buf.byteLength > 0) return { bytes: new Uint8Array(buf), mime: 'image/avif' };
    } catch {
      /* fall through to WebP */
    }
    target = 'image/webp';
  }
  if (target === 'image/webp') {
    // @jsquash WebP ONLY where canvas can't do it: lossless, near-lossless (<100), or explicitly raised
    // effort. Plain lossy WebP (effort 0, no near-lossless) stays on the native fast-path below.
    const nearLossless = opts.webpNearLossless != null && opts.webpNearLossless < 100;
    if (opts.lossless || nearLossless || effort > 0) {
      try {
        const data = c2d.getImageData(0, 0, canvas.width, canvas.height);
        const m = (await import('@jsquash/webp')) as {
          encode: (d: ImageData, o?: Record<string, number>) => Promise<ArrayBuffer>;
        };
        const buf = await m.encode(data, {
          quality: Math.round(q * 100),
          lossless: opts.lossless ? 1 : 0,
          ...(nearLossless ? { near_lossless: opts.webpNearLossless! } : {}),
          method: effort,
          use_sharp_yuv: 1,
        });
        if (buf && buf.byteLength > 0) return { bytes: new Uint8Array(buf), mime: 'image/webp' };
      } catch {
        /* fall through to native */
      }
    }
  }
  const blob = await canvas.convertToBlob({ type: target, quality: q });
  if (blob.type === target) {
    // Lossless PNG recompress (Task 10): only when the native output is actually PNG and the user opted
    // in. oxipng is lazy-loaded on first use; on any failure we keep the native PNG (honest no-op).
    if (blob.type === 'image/png' && opts.pngRecompressLevel != null) {
      const optimized = await recompressPng(c2d, canvas, clamp06(opts.pngRecompressLevel));
      if (optimized) return { bytes: optimized, mime: 'image/png' };
    }
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type as ImageMime };
  }
  if (!opts.allowPngFallback) return null;
  const png = await canvas.convertToBlob({ type: 'image/png' });
  if (opts.pngRecompressLevel != null) {
    const optimized = await recompressPng(c2d, canvas, clamp06(opts.pngRecompressLevel));
    if (optimized) return { bytes: optimized, mime: 'image/png' };
  }
  return { bytes: new Uint8Array(await png.arrayBuffer()), mime: 'image/png' };
}

/** Lossless PNG recompress via lazy @jsquash/oxipng (Task 10). Returns null on any failure so the caller
 *  keeps the native PNG. ImageData → optimise({level}) → PNG ArrayBuffer; no resize, in determinism scope. */
async function recompressPng(
  c2d: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  level: number,
): Promise<Uint8Array | null> {
  try {
    const data = c2d.getImageData(0, 0, canvas.width, canvas.height);
    const m = await loadOxipng();
    const buf = await m.optimise(data, { level });
    return buf && buf.byteLength > 0 ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

/** Transcode raw image bytes (decode → canvas → encode). null = target codec unavailable (skip).
 *  No resize ⇒ this is in the determinism scope (§4c) for native/@jsquash in-place transcodes. */
async function transcode(
  bytes: ArrayBuffer,
  target: ImageMime,
  enc: EncodeOpts,
): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  // Opaque-alpha (round15): compose onto a genuinely opaque `{alpha:false}` surface so the encoder drops the
  // dead alpha channel (DISK-only, invariant 5 — the GPU still allocates RGBA8888). The strongest signal to
  // BOTH the native convertToBlob path and the @jsquash getImageData path. Absent ⇒ today's alpha-true canvas.
  const c2d = canvas.getContext('2d', enc.opaque ? { alpha: false } : undefined);
  if (!c2d) return null;
  c2d.drawImage(bmp, 0, 0);
  bmp.close();
  return encodeCanvas(canvas, c2d, target, { ...enc, allowPngFallback: false });
}

/** Locate the Spine skeleton (.skel, or a .json that parses as a skeleton — top-level skeleton+bones+slots,
 *  NOT a TexturePacker/Pixi manifest) that sits in the SAME directory as the page image. Mirrors ingest's
 *  spine-root detection (lexicographically-first marker, deterministic). Returns the file path or null —
 *  the tier loop emits one copy per tier under the suffixed name and drops the original (design §3c). */
function findSpineSkeletonPath(files: FixInputFile[], pageImagePath: string): string | null {
  const dir = pageImagePath.includes('/')
    ? pageImagePath.slice(0, pageImagePath.lastIndexOf('/'))
    : '';
  const inDir = (p: string): boolean =>
    (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') === dir;
  let best: string | null = null;
  const consider = (p: string): void => {
    if (best === null || p.localeCompare(best) < 0) best = p;
  };
  for (const f of files) {
    if (!inDir(f.path)) continue;
    if (/\.skel$/i.test(f.name)) {
      consider(f.path);
      continue;
    }
    if (!/\.json$/i.test(f.name)) continue;
    try {
      const o = JSON.parse(td.decode(f.bytes)) as Record<string, unknown>;
      if ('frames' in o || 'meta' in o) continue; // TexturePacker / Pixi, not a skeleton
      if (
        typeof o.skeleton === 'object' &&
        o.skeleton !== null &&
        o.bones != null &&
        o.slots != null
      )
        consider(f.path);
    } catch {
      /* not JSON */
    }
  }
  return best;
}

// ── Polygon mode: impure pixel read, PURE extraction ──────────────────────────────────────────────
// The worker's only pixel-reading job is the `getImageData` in `extractSprite` above; the actual mask /
// alpha-silhouette derivation (alpha-threshold + ACC_CELL grid + conservative dilation; integer
// downscale to the MESH_MAX_CELLS cap) now lives in the PURE `maskItemFromRGBA` / `alphaMaskFromRGBA`
// in packages/fix/src/mask.ts. That is the SINGLE Vitest-covered source of truth for the threshold/
// dilation/downscale logic, so no constant can drift between the worker and the pure pipeline.
//
// `scaleMeshToFrame` (the provably-conservative capped→full-res mesh scale-up) likewise lives in the
// PURE packages/fix/src/mesh.ts (see the scale>1 coverage test in polygon.test.ts). The worker imports
// all three above.

const MIME_BY_EXT: Record<string, ImageMime> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  avif: 'image/avif',
};
const mimeOf = (path: string): ImageMime =>
  MIME_BY_EXT[(path.split('.').pop() ?? '').toLowerCase()] ?? 'image/png';

/** Per-image features for aggressive dedup: SHA-256 content hash (exact) + dHash (near). Same as the
 *  analysis worker, so the dedup findings match the diagnosis. */
async function computeFeatures(bytesByRef: Map<string, ArrayBuffer>): Promise<ImageFeatures[]> {
  const out: ImageFeatures[] = [];
  for (const [assetRef, bytes] of bytesByRef) {
    const contentHash = await sha256Hex(bytes);
    const dHash = await dHashHex(bytes);
    out.push(dHash ? { assetRef, contentHash, dHash } : { assetRef, contentHash });
  }
  return out;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Frame-redundancy hashing + trim-margin bboxes in the fix path — the SAME pure-core split as
 *  analyze.worker.ts:224-261 (round19 hashes + round21 #0 bboxes): ONE full-resolution decode per atlas page,
 *  then the PURE extractFrameRegions does the caps/bounds/flat-guard/region-extraction off that single buffer
 *  (each surviving region's tightly-packed RGBA bytes are SHA-256'd here — crypto.subtle is async), and the
 *  PURE alphaBBox reads the SAME buffer for each UNtrimmed sprite's opaque bbox. BOTH arrays are index-aligned
 *  to `sprites` and computed off ONE shared decode (the trim bboxes piggyback on the `page` buffer — ZERO extra
 *  decode). A bbox is null for an already-trimmed sprite (skipped — the rule re-gates on Sprite.trimmed) or a
 *  fully-transparent untrimmed frame (alphaBBox finds no opaque pixel). Returns null (whole page skipped) when
 *  OffscreenCanvas is unavailable, the decode fails, the 2d context is unavailable, or the page exceeds the
 *  size/sprite caps — both rules simply never fire for that page. Identical magnitude to the composePageEncode
 *  source decode a repack already pays. Deterministic (stable SHA + deterministic flat threshold + integer bbox). */
async function hashAtlasFrames(
  pageBytes: ArrayBuffer,
  sprites: Sprite[],
): Promise<{ hashes: (string | null)[]; bboxes: (TrimRect | null)[] } | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    const bmp = await createImageBitmap(new Blob([pageBytes]));
    const { width, height } = bmp;
    if (width <= 0 || height <= 0) {
      bmp.close();
      return null;
    }
    const canvas = new OffscreenCanvas(width, height);
    const c2d = canvas.getContext('2d', { willReadFrequently: true });
    if (!c2d) {
      bmp.close();
      return null;
    }
    c2d.drawImage(bmp, 0, 0);
    bmp.close();
    const page = c2d.getImageData(0, 0, width, height).data; // one full-res read; both halves read this buffer
    const regions = extractFrameRegions(
      page,
      width,
      height,
      sprites.map((sp) => sp.frame),
    );
    if (!regions) return null; // whole page skipped (caps) — honest, BOTH rules never fire for it
    const hashes: (string | null)[] = [];
    for (const region of regions)
      hashes.push(region === null ? null : await sha256Hex(region.buffer as ArrayBuffer));
    // Trim bboxes off the SAME page buffer (no second decode). Only for UNtrimmed sprites; alphaBBox returns a
    // FRAME-RELATIVE top-left bbox (exactly what trimMarginFinding expects), or null for a fully transparent
    // frame. `regions` already cleared the caps, so this loop is bounded by the same ceilings.
    const src = { data: page, width };
    const bboxes: (TrimRect | null)[] = sprites.map((sp) =>
      sp.trimmed ? null : alphaBBox(src, { x: sp.frame.x, y: sp.frame.y, w: sp.frame.w, h: sp.frame.h }),
    );
    return { hashes, bboxes };
  } catch {
    return null;
  }
}

async function dHashHex(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const canvas = new OffscreenCanvas(9, 8);
    const c2d = canvas.getContext('2d');
    if (!c2d) return null;
    c2d.drawImage(bmp, 0, 0, 9, 8);
    bmp.close();
    const data = c2d.getImageData(0, 0, 9, 8).data;
    const gray: number[] = [];
    for (let p = 0; p < 72; p++) gray.push(luma(data, p * 4));
    if (isFlat(gray)) return null; // flat fills collapse to one hash → false near-dup matches
    return dHashFromGray(gray);
  } catch {
    return null;
  }
}
