/// <reference lib="webworker" />
// The Phase-2 fix executor (impure half). Reuses the analysis pipeline to diagnose, plans the fix
// (@asset-doctor/fix, pure), then does the pixel work: repack atlases (crop each sprite from the source
// sheet → compose a tighter POT sheet → re-emit a deterministic manifest), transcode loose images
// (native WebP, or AVIF via @jsquash with honest fallback), drop exact duplicates, and zip a drop-in
// optimized folder. Assets never leave the device. Every fix the browser can't do lands in skipped[].

import type { Asset, Atlas, Blit, FixOp, FormatTarget, ImageMime, ImageFeatures, PackGroup, Rect, ScaleTier, Size, TrimRect } from '@asset-doctor/core';
import { groupFiles, groupLooseForPacking, keyOf, type LooseImage, type RawFile } from '@asset-doctor/ingest';
import { parseAtlas, parseImage, parseSpineAtlasText, parseSpinePage, type SpinePage } from '@asset-doctor/parsers';
import { analyze, buildDedupGroups, hasResolutionToken, mergeSharedAtlases, occupancyValue, type EncodeSizer } from '@asset-doctor/analysis';
import {
  emitSpineAtlasText,
  emitTexturePackerJson,
  planFix,
  polygonWins,
  repackAtlases,
  repackAtlasesPolygon,
  scaleAtlas,
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
  // PURE owner-aware dedup repoint path math (design §3d) — SINGLE source of truth, Vitest-covered in
  // packages/fix, so the meta.image repoint resolves back through @asset-doctor/parsers and can't drift.
  dirOf,
  resolveImageRef,
  relativeImageRef,
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
} from '@asset-doctor/fix';
import { dHashFromGray, isFlat, luma } from '../lib/perceptual';
import { makeZip, type ZipEntry } from './zip';
// PURE dry-run plan summary (docs/improvements/dry-run-plan-preview.md): tallies the STRUCTURED FixOp[]
// the execute path would run + the worker-side tier multiplier into the receipt's OpKind vocabulary. No
// byte/VRAM number (honesty, invariant 5). The worker only assembles the pixel-free gate facts.
import { dedupKeepConsumerSkip, deselectedSkips, fixOpKind, summarizePlan, type OpKind, type PlanGateInputs } from '../lib/op-manifest';
// PURE loader-migration row builders (docs/improvements/loader-migration.md). The worker captures only
// GENUINE loader-CALL changes (merge/pack/tier/loose-rename/bare-drop — NOT dedup, which rewrites the
// consumer manifest in place) as one-line builder calls; finalizeChanges sorts+dedups deterministically.
// SAME constructors the unit test drives directly (the worker can't run in Node — createImageBitmap).
import { dropChange, finalizeChanges, looseRenameChange, mergeChanges, packChanges, tierChanges } from '../lib/loader-migration';
import { canKeepSheetDiff, sheetGeometryProof } from './sheet-diff';
import type { FixChange, FixInputFile, FixMode, FixOptions, FixReceipt, FixRequest, FixResponse, SheetDiff } from './fix-protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FixResponse): void => ctx.postMessage(m);
const basename = (p: string): string => p.split('/').pop() ?? p;

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

ctx.onmessage = async (e: MessageEvent<FixRequest>): Promise<void> => {
  if (e.data.type !== 'fix') return;
  try {
    // Dry-run preview vs commit (docs/improvements/dry-run-plan-preview.md). Absent/'execute' ⇒
    // byte-identical to today's one-click path; 'plan' ⇒ the worker posts a `fix-plan` summary and STOPS
    // before the pixel loop (no compose/encode/zip).
    await runFix(e.data.files, e.data.options, e.data.mode ?? 'execute');
  } catch (err) {
    post({ type: 'fix-error', error: err instanceof Error ? err.message : String(err) });
  }
};

async function runFix(files: FixInputFile[], opts: FixOptions, mode: FixMode): Promise<void> {
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
      if (typeof j.meta?.image === 'string') manifestPathByImage.set(resolveImageRef(f.path, j.meta.image), f.path);
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
      for (const pg of pages) spineAtlasInfo.set(resolveImageRef(f.path, pg.image), { path: f.path, pages: pages.length });
    } catch {
      /* not a spine atlas */
    }
  }
  const manifestPathOf = (ref: string): string | undefined => manifestPathByImage.get(pathByRef.get(ref) ?? '');
  const spineInfoOf = (ref: string): { path: string; pages: number } | undefined => spineAtlasInfo.get(pathByRef.get(ref) ?? '');

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
  // measure format savings (native WebP) so format findings → transcode ops appear
  const report = await analyze(merged, undefined, { missingImages: grouped.missing, encodeImage: makeEncoder(bytesByRef), ...(features ? { features } : {}) });

  // Owner/consumer dedup (Feature 1, aggressive only): decide which exact-dup copy is the OWNER (kept,
  // references repointed) and which are CONSUMERS (dropped). Pure + load-order-safe; takes spineRefs
  // (pool separation), the UI lazy/bundle marking, and the skin guard. Plan turns each consumer into an
  // owner-aware `drop` (repointManifest:true for atlas pairs); owners become protected (never targets).
  const dedupGroups = opts.aggressive && features ? buildDedupGroups(features, spineRefs, opts.marking ?? {}, opts.skinGuard ?? {}) : undefined;

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
    for (const a of merged) if (a.kind === 'image') looseImages.push({ ref: a.image.name, size: a.image.size });
    const grouped2 = groupLooseForPacking(looseImages, raw, {
      thresholds: report.thresholds,
      mode: opts.packMode ?? 'auto',
      granularity: opts.packGranularity ?? 'per-leaf-folder',
      forced: opts.packForced ?? false,
    });
    packGroups = grouped2.groups;
    for (const c of grouped2.collisions) packCollisionSkips.push({ assetRef: c.refs.join(' | '), reason: `pack skipped: two files map to one region name '${c.name}' — kept the first` });
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
  const profileSkips: { assetRef: string; reason: string }[] = [];
  if (opts.exportProfile) {
    const v = validateProfile(opts.exportProfile);
    if (!v.ok) {
      for (const e of v.errors) profileSkips.push({ assetRef: '(profile)', reason: `export profile rejected: ${e}` });
    } else {
      profileFormats = v.formats;
      profileTiers = v.tiers;
      profileMulti = v.formats.length > 1;
      profileOn = true;
    }
  }
  // The profile's global encode knobs (effort/scaleAwareQuality/avif*/pngRecompress) — folded into every
  // formatEncode below. Read from the profile (NOT the legacy top-level opts) when profileOn so the panel's
  // knobs govern the fan-out; falls through harmlessly when profile absent (profileFormats is empty).
  const profileGlobal = {
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
  const tiers = profileHasLowerTier ? profileTiers : tierValidation?.ok ? tierValidation.tiers : [];
  const tieringOn = tiers.length > 0;
  // Whole-folder already-tiered: if any cluster already differs by a resolution token, the folder ships
  // tiers — skip tiering globally (design §8). A png+webp same-size folder does NOT trip this (format
  // tokens are excluded from hasResolutionToken). tierForce (mirrors packForced) bypasses the skip.
  const folderAlreadyTiered = tieringOn && !opts.tierForce && merged.some((a) => hasResolutionToken(a.kind === 'atlas' ? a.atlas.name : a.image.name));
  /** Refuse-tiering reason for a ref, or null when it is eligible. Data-driven gates only (design §8/§10):
   *  already-tiered (resolution token in the name), atlases carrying a source mesh (scaleAtlas drops mesh),
   *  and multi-page Spine (per-page emit would clobber one info.path). Loose/single-page-atlas/single-page
   *  Spine are eligible. The result is shared by planFix (excludes eligible refs from resize/transcode) and
   *  the tier loop (a refused ref is surfaced in skipped[] and never tiered). */
  const tierRefusal = (ref: string): string | null => {
    if (!opts.tierForce && hasResolutionToken(ref)) return 'tier skipped: asset is already a resolution tier';
    const atlas = atlasByRef.get(ref);
    if (atlas) {
      if (atlas.sprites.some((s) => s.mesh)) return 'tier skipped: meshed atlas not supported (scaleAtlas drops mesh)';
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
  const kindOf = (ref: string): FixAssetKind => (spineRefs.has(ref) ? 'spine' : atlasByRef.has(ref) ? 'pixi' : 'loose');
  /** Effective encode options for a loose-image op at `ref`, optionally downscaled by `scale` (1 = none). */
  const effectiveFor = (ref: string, scale: number): EffectiveOptions => {
    const e = resolveOptions(ref, kindOf(ref), baseEffective, opts.overrides);
    return { ...e, quality: scaleAwareQuality(e.quality, scale, opts.scaleAwareQuality ?? false) };
  };
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
          if (path && renamedTo(path, effectiveFor(op.assetRef, 1).targetMime) !== path) predictRefsChanged = true;
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
      if (info && info.pages > 1) planSkips.push({ assetRef: ref, reason: 'multi-page Spine repack not supported in v1' });
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
      planSkips.push({ assetRef: '(folder)', reason: 'tier skipped: folder already ships resolution tiers' });
    }
    if (tieringOn && !tierExcluded && !folderAlreadyTiered && opts.aggressive && dedupGroups && dedupGroups.length > 0) {
      planSkips.push({ assetRef: '(dedup)', reason: 'dedup repoint disabled: scale tiering renames owners (kept duplicate consumers)' });
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
          planSkips.push({ assetRef: ref, reason: 'tier skipped: asset was repacked/merged/packed (its sheet is not tiered in v1)' });
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

    const gate: PlanGateInputs = { ops: countedOps, tierAssets, skipped: planSkips, referencesChanged: predictRefsChanged };
    post({ type: 'fix-plan', summary: summarizePlan(gate) });
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
    });
  };
  // Input file paths — the collision pre-check (Feature 4, design §6 step 1) asserts a synthesized
  // sheet/page/JSON/.atlas path never overwrites an existing input or an already-emitted output.
  const inputPaths = new Set(files.map((f) => f.path));
  const replaced = new Set<string>();
  const dropped = new Set<string>();
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
    return {
      imagePath: pathByRef.get(ref),
      manifestPath: manifestPathOf(ref),
      transcoded,
      targetMime: transcoded ? effectiveFor(ref, 1).targetMime : opts.targetMime,
    };
  });
  // Owner ACTUAL emitted name, filled during Phase B. Defaults to the original emitted paths; transform
  // handlers below overwrite the image entry when they rename an owner. Phase C reconciles against the
  // plan prediction and skips (keeps) any consumer whose owner diverged.
  const ownerActualName = new Map<string, OwnerFinalName>();
  for (const [ref, fn] of ownerFinalName) ownerActualName.set(ref, { ...fn });
  // Owner-aware drops are DEFERRED to Phase C (executed after all transforms settle the owner names).
  // Selective fix: a deselected `dedup` kind drops NONE of these (filtered out here ⇒ no repoint/drop work
  // in Phase C); the honest skip is surfaced once via deselectedSkips below (not per consumer). When dedup
  // is NOT excluded `runs` is always true here ⇒ today's `plan.ops.filter(isOwnerAwareDrop)` exactly.
  const dedupDrops = plan.ops.filter(isOwnerAwareDrop).filter(runs);

  const bmpCache = new Map<string, ImageBitmap>();
  const bitmapOf = async (ref: string): Promise<ImageBitmap | null> => {
    if (bmpCache.has(ref)) return bmpCache.get(ref)!;
    const b = bytesByRef.get(ref);
    if (!b) return null;
    const bmp = await createImageBitmap(new Blob([b]));
    bmpCache.set(ref, bmp);
    return bmp;
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
        c2d.drawImage(bmp, blit.from.rect.x, blit.from.rect.y, blit.from.rect.w, blit.from.rect.h, blit.to.x, blit.to.y, blit.to.w, blit.to.h);
        c2d.restore();
        // Meshed/clip blit + extrude requested: NO bleed in v1 (no polygon-edge extrude). Surface honestly.
        if (extrude > 0) noteExtrudeSkip(blit);
      } else {
        c2d.drawImage(bmp, blit.from.rect.x, blit.from.rect.y, blit.from.rect.w, blit.from.rect.h, blit.to.x, blit.to.y, blit.to.w, blit.to.h);
        if (extrude > 0) {
          // extrudePlan internally gates via canExtrude → [] for a rotated blit (skip note below) or
          // when clamped extrude is 0; non-empty ⇒ this rectangle blit got a real bleed.
          const rects: ExtrudeRect[] = extrudePlan(blit, extrude, binW, binH);
          if (rects.length > 0) {
            for (const r of rects) c2d.drawImage(bmp, r.src.x, r.src.y, r.src.w, r.src.h, r.dst.x, r.dst.y, r.dst.w, r.dst.h);
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
    const why = blit.clip && blit.clip.length > 0 ? 'meshed (clip polygon)' : blit.from.rotated || blit.rotate90 ? 'rotated' : 'degenerate';
    skipped.push({ assetRef: id, reason: `edge-extrude skipped: ${why} blit — no polygon-edge/rotated extrude in v1` });
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
  const extractSprite = async (id: string, atlasRef: string, frame: Rect, rotated: boolean): Promise<MaskItem | null> => {
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
    const raw = traceMesh(alpha, { tolerance2: POLY_TOLERANCE2, maxVerts: POLY_MAX_VERTS, hullAreaRatioMax: HULL_AREA_RATIO_MAX });
    meshCache.set(id, raw ? scaleMeshToFrame(raw, scale, frame.w, frame.h) : null);
    return mask;
  };

  let vramSaved = 0;
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
  const extrudeOf = (op: { extrude?: number; padding: number }): { gutter: number; eff: number } => {
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
  ): Promise<{ ownerImage: string; referencesChanged: boolean }> => {
    profileOwned.add(ref);
    profileAssets++;
    const emittedThis = new Set<string>();
    let ownerImage = srcPath; // falls back to the source if every format fails (caller leaves it un-renamed)
    let firstEmitted = false;
    let refsChanged = false;
    for (const f of profileFormats) {
      const fe = formatEncode(f, scale, profileGlobal);
      const enc = await encodeCanvas(canvas, c2d, fe.targetMime, feToEncodeOpts(fe));
      if (!enc) {
        skipped.push({ assetRef: ref, reason: `variant ${f.format} skipped: encode to ${fe.targetMime} unavailable` });
        continue;
      }
      const variantPath = renamedTo(srcPath, enc.mime);
      if (emittedThis.has(variantPath)) {
        skipped.push({ assetRef: ref, reason: `${f.format} fell back to ${enc.mime} and collides with another variant — skipped` });
        continue;
      }
      emittedThis.add(variantPath);
      out.push({ path: variantPath, bytes: enc.bytes });
      profileFilesEmitted++;
      if (!firstEmitted) {
        // The FIRST emitted variant is the canonical rename (today's single-transcode behavior) — replaced
        // + the loader row + the dedup owner image all point here, so dedup-repoint resolves to a real file.
        firstEmitted = true;
        ownerImage = variantPath;
        replaced.add(srcPath);
        if (variantPath !== srcPath) {
          refsChanged = true;
          changeRows.push(looseRenameChange(srcPath, variantPath, kind));
        }
      } else if (variantPath !== srcPath) {
        // Additional formats are extra load targets (the loader picks by name) — a reference change too.
        refsChanged = true;
        changeRows.push(looseRenameChange(srcPath, variantPath, kind));
      }
    }
    return { ownerImage, referencesChanged: refsChanged };
  };

  for (const op of plan.ops) {
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
          skipped.push({ assetRef: ref, reason: info && info.pages > 1 ? 'multi-page Spine repack not supported in v1' : 'Spine atlas not found' });
          continue;
        }
        // Polygon mode has no mesh slot in the Spine `.atlas` format → rectangle repack, surfaced honestly.
        if (opts.polygon) skipped.push({ assetRef: ref, reason: 'polygon mode not supported for Spine (no mesh slot in .atlas)' });
        // Edge-extrude: reserve a symmetric gutter so the bleed has room. gutter=0 ⇒ today's repack exactly.
        const { gutter, eff } = extrudeOf(op);
        const r = repackAtlases([atlas], { allowRotation: false, padding: op.padding, maxSize: op.maxSize, ...(gutter ? { gutter } : {}) });
        if (r.atlases.length !== 1) {
          skipped.push({ assetRef: ref, reason: 'Spine repack spilled into multiple sheets' });
          continue;
        }
        const na = r.atlases[0]!;
        // Compose + encode via the shared helper (Spine pages stay PNG, runtime-safe). encodeCanvas for PNG
        // with no recompress level returns the native PNG bytes — same result as the prior convertToBlob.
        // eff>0 ⇒ each rectangle blit's edge pixels are replicated into the reserved gutter (seam fix).
        const enc = await composePageEncode(r.blits, na.size.w, na.size.h, 'image/png', { allowPngFallback: true }, eff);
        if (!enc) {
          skipped.push({ assetRef: ref, reason: 'source sheet unavailable' });
          continue;
        }
        const imagePath = pathByRef.get(ref)!;
        out.push({ path: imagePath, bytes: enc.bytes });
        out.push({ path: info.path, bytes: te.encode(emitSpineAtlasText(na)) });
        captureSheetDiff(ref, atlas.size, na, enc.bytes, basename(imagePath), atlas);
        replaced.add(imagePath);
        replaced.add(info.path);
        vramSaved += r.vramBytesBefore - r.vramBytesAfter;
        // HONESTY (invariant 5): if the gutter grew this sheet's POT, the .atlas `size:` line + PNG dims
        // changed — surface the VRAM growth (no "identical round-trip" claim when the bin grew). The delta
        // is the gutter pack's footprint minus the SAME pack with no gutter.
        if (gutter > 0) extrudeVramDelta += r.vramBytesAfter - repackAtlases([atlas], { allowRotation: false, padding: op.padding, maxSize: op.maxSize }).vramBytesAfter;
        if (tieringOn) tierTransformed.add(ref); // repacked → tier loop surfaces an honest skip (§7 v1 scope)
        operations.push(`repack ${basename(ref)} (spine) → ${na.size.w}×${na.size.h}`);
        continue;
      }
      for (const rf of op.atlasRefs) if (spineRefs.has(rf)) skipped.push({ assetRef: rf, reason: 'Spine atlas not mergeable in v1' });
      const refs = op.atlasRefs.filter((rf) => !spineRefs.has(rf));
      const group = refs.map((rf) => atlasByRef.get(rf)).filter((a): a is Atlas => !!a);
      if (group.length === 0) {
        if (refs[0]) skipped.push({ assetRef: refs[0], reason: 'atlas not found' });
        continue;
      }
      const merge = group.length > 1; // multi-atlas op = the non-drop-in "merge atlases" mode

      // Edge-extrude (bleed): reserve a symmetric gutter for the RECTANGLE repack path. Polygon mode emits
      // meshed blits that are never extruded (the design's rectangle-only scope), so its nester takes no
      // gutter; `eff` is only fed to compose when the selected result is the rectangle path (below).
      const { gutter, eff } = extrudeOf(op);

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
          for (const rf of refs) skipped.push({ assetRef: rf, reason: 'source sheet unavailable' });
          continue;
        }
        const poly = repackAtlasesPolygon(group, masks, meshById, { allowRotation: false, padding: 0, maxSize: op.maxSize, emitMesh: true });
        // The rectangle fallback owns the gutter (only it composes with extrude); the polygon nester never does.
        const rect = repackAtlases(group, { allowRotation: false, padding: op.padding, maxSize: op.maxSize, ...(gutter ? { gutter } : {}) });
        if (polygonWins(poly, rect)) {
          r = poly;
          polySelected = true; // receipt stats are accrued only AFTER this op composes (below), never on a later skip
        } else {
          r = rect;
          for (const rf of refs) skipped.push({ assetRef: rf, reason: 'polygon mode: no measurable VRAM win, used rectangle packing' });
        }
      } else {
        r = repackAtlases(group, { allowRotation: false, padding: op.padding, maxSize: op.maxSize, ...(gutter ? { gutter } : {}) });
      }

      if (!merge && r.atlases.length !== 1) {
        skipped.push({ assetRef: refs[0]!, reason: 'repack spilled into multiple sheets (v1 keeps single-sheet atlases)' });
        continue;
      }
      // merging atlases with a shared sprite name would clobber manifest keys — skip honestly
      const names = r.atlases.flatMap((a) => a.sprites.map((s) => s.name));
      if (merge && new Set(names).size !== names.length) {
        for (const rf of refs) skipped.push({ assetRef: rf, reason: 'merge skipped: sprite-name collision across atlases' });
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
        const sheet = await composePageEncode(r.blits.filter((b) => naNames.has(b.name)), na.size.w, na.size.h, 'image/webp', { lossless: true, allowPngFallback: true }, composeExtrude);
        if (!sheet) {
          composeOk = false;
          break;
        }
        const ext = EXT[sheet!.mime] ?? '.png';
        if (merge) {
          const stem = `atlas-merged${r.atlases.length > 1 ? `-${i}` : ''}`;
          na.imageRef = `${stem}${ext}`;
          out.push({ path: `${baseDir}${stem}${ext}`, bytes: sheet!.bytes });
          out.push({ path: `${baseDir}${stem}.json`, bytes: te.encode(emitTexturePackerJson(na)) });
          mergedManifestPaths.push(`${baseDir}${stem}.json`); // loader-migration: a NEW manifest to load
          mergedPageImages.push(`${baseDir}${stem}${ext}`); // ...and its REAL page image (na.imageRef on disk)
          // Sheet-diff: group[0] is the representative source page ("1 of N" — merge folds many into few).
          captureSheetDiff(refs[0]!, group[0]!.size, na, sheet!.bytes, `${stem}${ext} (1 of ${refs.length})`, group[0]);
        } else {
          const ref = refs[0]!;
          const origPath = pathByRef.get(ref)!;
          const imagePath = sheet!.mime === 'image/webp' ? origPath.replace(/\.[a-z0-9]+$/i, '.webp') : origPath;
          if (sheet!.mime === 'image/webp') na.imageRef = na.imageRef.replace(/\.[a-z0-9]+$/i, '.webp');
          out.push({ path: imagePath, bytes: sheet!.bytes });
          captureSheetDiff(ref, group[0]!.size, na, sheet!.bytes, basename(na.imageRef), group[0]);
          replaced.add(origPath);
          replaced.add(imagePath);
          const mPath = manifestPathOf(ref);
          if (mPath) {
            out.push({ path: mPath, bytes: te.encode(emitTexturePackerJson(na)) });
            replaced.add(mPath);
          }
          operations.push(`repack ${basename(ref)}${polySelected ? ' (polygon)' : ''} → ${na.size.w}×${na.size.h} ${sheet!.mime.replace('image/', '')}`);
        }
      }
      if (!composeOk) {
        for (const rf of refs) skipped.push({ assetRef: rf, reason: 'source sheet unavailable' });
        continue;
      }
      // repacked/merged refs → tier loop surfaces an honest skip rather than a silent no-op (§7 v1 scope).
      if (tieringOn) for (const rf of refs) tierTransformed.add(rf);
      if (merge) {
        for (const rf of refs) {
          const ip = pathByRef.get(rf);
          if (ip) dropped.add(ip);
          const mp = manifestPathOf(rf);
          if (mp) dropped.add(mp);
        }
        referencesChanged = true;
        operations.push(`merge ${refs.length} atlases → ${r.atlases.length} sheet${r.atlases.length === 1 ? '' : 's'}`);
        // Loader-migration (SET→SET): each OLD atlas manifest the game loaded → the merged manifest set.
        changeRows.push(...mergeChanges(refs.map((rf) => manifestPathOf(rf)).filter((m): m is string => !!m), mergedManifestPaths, mergedPageImages));
      }
      vramSaved += r.vramBytesBefore - r.vramBytesAfter;
      // HONESTY (invariant 5): a symmetric gutter CAN grow a sheet to the next POT ⇒ MORE VRAM. When the
      // rectangle path shipped WITH a gutter, surface the truthful delta (gutter pack footprint − the SAME
      // pack with no gutter). The growth is ALSO already inside vramSaved/vramBytes* — never claimed free.
      if (composeExtrude > 0 && gutter > 0) extrudeVramDelta += r.vramBytesAfter - repackAtlases(group, { allowRotation: false, padding: op.padding, maxSize: op.maxSize }).vramBytesAfter;
      // Accrue polygon receipt stats only now that the op has fully composed (skips above never reach here),
      // so meshSprites / polygonAreaSavedPct reflect ONLY sheets that actually shipped.
      if (polySelected) {
        meshSpritesTotal += r.atlases.reduce((n, a) => n + a.sprites.filter((s) => s.mesh).length, 0);
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
        out.push({ path, bytes: new Uint8Array(await blob.arrayBuffer()) });
        replaced.add(path);
        if (spineRefs.has(ref)) {
          const info = spineInfoOf(ref);
          if (info) {
            out.push({ path: info.path, bytes: te.encode(emitSpineAtlasText(scaled)) });
            replaced.add(info.path);
          }
        } else {
          const mPath = manifestPathOf(ref);
          if (mPath) {
            out.push({ path: mPath, bytes: te.encode(emitTexturePackerJson(scaled)) });
            replaced.add(mPath);
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
          if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = r.ownerImage;
          if (r.referencesChanged) referencesChanged = true;
          vramSaved += Math.max(0, (origPx - op.to.w * op.to.h) * 4);
          operations.push(`resize ${basename(path)} → ${op.to.w}×${op.to.h} (${profileFormats.length} format${profileFormats.length === 1 ? '' : 's'})`);
        } else {
          // Effective per-asset options (folder/type overrides + scale-aware quality on the downscale).
          const eff = effectiveFor(ref, scale);
          const enc = await encodeCanvas(canvas, c2d, eff.targetMime, encOptsFor(eff, true));
          const newPath = renamedTo(path, enc!.mime); // same rename the owner-final-name prediction uses
          out.push({ path: newPath, bytes: enc!.bytes });
          replaced.add(path);
          if (newPath !== path) {
            referencesChanged = true; // a loose-image rename is NOT drop-in
            changeRows.push(looseRenameChange(path, newPath, 'resize')); // loader-migration: logo.png → logo.webp
          }
          vramSaved += Math.max(0, (origPx - op.to.w * op.to.h) * 4);
          operations.push(`resize ${basename(path)} → ${op.to.w}×${op.to.h} ${enc!.mime.replace('image/', '')}`);
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
        const c2d = canvas.getContext('2d');
        if (!c2d) {
          bmp.close();
          skipped.push({ assetRef: ref, reason: 'no 2D context' });
          if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = path;
          continue;
        }
        c2d.drawImage(bmp, 0, 0);
        bmp.close();
        const r = await emitLooseProfileFanout(ref, path, 1, canvas, c2d, 'transcode');
        if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = r.ownerImage;
        if (r.referencesChanged) referencesChanged = true;
        operations.push(`transcode ${basename(path)} → ${profileFormats.length} format${profileFormats.length === 1 ? '' : 's'}`);
        continue;
      }
      // Effective per-asset options (folder/type overrides; no downscale ⇒ scale 1 ⇒ quality unchanged).
      const eff = effectiveFor(ref, 1);
      const enc = await transcode(bytes, eff.targetMime, encOptsFor(eff, false));
      if (!enc) {
        skipped.push({ assetRef: ref, reason: `transcode to ${eff.targetMime} unavailable` });
        // Owner transcode skipped ⇒ the owner keeps its ORIGINAL image; correct the actual name so Phase
        // C detects the divergence from its (renamed) prediction and KEEPS the consumer.
        if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = path;
        continue;
      }
      const newPath = renamedTo(path, enc.mime); // same rename the owner-final-name prediction uses
      out.push({ path: newPath, bytes: enc.bytes });
      replaced.add(path);
      // Phase B bookkeeping: if this transcoded image is a retained dedup OWNER, record its ACTUAL final
      // image path so Phase C points consumers at the real (possibly PNG-fallback) name, not the guess.
      if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = newPath;
      if (newPath !== path) {
        referencesChanged = true; // a loose-image rename is NOT drop-in
        changeRows.push(looseRenameChange(path, newPath, 'transcode')); // loader-migration: logo.png → logo.webp
      }
      operations.push(`transcode ${basename(path)} → ${enc.mime.replace('image/', '')}`);
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

      // (1) Collision pre-check — synthesize every page/JSON/.atlas path this op would write and assert
      // none overwrites an input file or an already-emitted output. On collision, disambiguate the stem to
      // `${stem}.packed`; if THAT still collides, skip the whole group + surface (never overwrite).
      const used = new Set<string>([...inputPaths, ...out.map((o) => o.path)]);
      // The max number of pages we might emit (one page per region is the worst case) — used only to
      // synthesize candidate paths for the collision probe; the real page count comes from packLoose.
      // Probe with the REQUESTED target ext (a later AVIF→WebP/PNG fallback only narrows the real set, so
      // probing the requested ext is a superset — safe). Worst case = one page per region (the real page
      // count from packLoose is ≤ this); we probe every candidate page name + its manifest.
      const probeExt = isSpine ? '.png' : (EXT[resolveOptions(group.outDir, 'loose', baseEffective, opts.overrides).targetMime] ?? '.png');
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
          skipped.push({ assetRef: group.id, reason: `pack skipped: sheet name '${group.stem}' collides with an existing file` });
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
              skipped.push({ assetRef: r.ref, reason: 'pack skipped: fully-transparent region (Spine decoy)' });
              continue;
            }
            regions.push({ ref: r.ref, name: r.name, sourceSize: r.sourceSize, trim: { x: 0, y: 0, w: 1, h: 1 } });
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
        const bbox = alphaBBox({ data: imageData.data, width: imageData.width }, { x: 0, y: 0, w: bmp.width, h: bmp.height });
        trimCache.set(r.ref, bbox);
        if (bbox === null) {
          if (isSpine) {
            skipped.push({ assetRef: r.ref, reason: 'pack skipped: fully-transparent region (Spine decoy)' });
            continue;
          }
          // static: 1×1 sentinel so the frame stays resolvable (trimmed, sourceSize = original).
          regions.push({ ref: r.ref, name: r.name, sourceSize: r.sourceSize, trim: { x: 0, y: 0, w: 1, h: 1 } });
        } else {
          regions.push({ ref: r.ref, name: r.name, sourceSize: r.sourceSize, trim: bbox });
        }
      }
      if (bitmapMissing) continue; // a source image was unavailable — surfaced above, skip the group
      if (regions.length === 0) continue; // every region was a transparent decoy — nothing to pack

      // (3) Pack (pure). Spine sheets default to PNG (runtime-safe); static uses the effective target.
      const effTarget = isSpine ? 'image/png' : resolveOptions(group.outDir, 'loose', baseEffective, opts.overrides).targetMime;
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
      const eff = resolveOptions(group.outDir, isSpine ? 'spine' : 'loose', baseEffective, opts.overrides);
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
        const enc = await composePageEncode(pl.blits.filter((b) => naNames.has(b.name)), na.size.w, na.size.h, effTarget, encOpts, extEff);
        if (!enc) {
          composeOk = false;
          break;
        }
        const ext = EXT[enc.mime] ?? '.png';
        // packLoose synthesized imageRef from the *requested* target ext; re-point it at the ACTUAL emitted
        // mime (e.g. AVIF→WebP/PNG fallback) so meta.image / the page header name matches the real file.
        const pageBase = i === 0 ? stem : `${stem}_${i}`;
        na.imageRef = `${pageBase}${ext}`;
        emitted.push({ path: join(group.outDir, `${pageBase}${ext}`), bytes: enc.bytes });
        if (isSpine) {
          spineBlocks.push(emitSpineAtlasText(na));
        } else {
          emitted.push({ path: join(group.outDir, `${pageBase}.json`), bytes: te.encode(emitTexturePackerJson(na)) });
          packManifestPaths.push(join(group.outDir, `${pageBase}.json`)); // loader-migration: a NEW sheet manifest
          packPageImages.push(join(group.outDir, `${pageBase}${ext}`)); // ...and its REAL page image (na.imageRef on disk)
          // Sheet-diff (STATIC pages only): loose has no source atlas ⇒ occBefore=0 (honest "0% packed").
          // The representative "before" is the first packed loose region's source image (its full dims).
          const beforeRef = regions[0]!.ref;
          captureSheetDiff(beforeRef, sizeByRef.get(beforeRef) ?? na.size, na, enc.bytes, basename(na.imageRef));
        }
      }
      if (!composeOk) {
        skipped.push({ assetRef: group.id, reason: 'pack skipped: source image unavailable during compose' });
        continue;
      }
      if (isSpine) {
        // ONE `.atlas` = the per-page blocks concatenated (blank line between), each region already under
        // ITS page header (per-bin atlases). The skeleton .json/.skel is passed through untouched below.
        emitted.push({ path: join(group.outDir, `${stem}.atlas`), bytes: te.encode(spineBlocks.join('\n')) });
        packManifestPaths.push(join(group.outDir, `${stem}.atlas`)); // loader-migration: the NEW Spine .atlas
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
          skipped.push({ assetRef: group.id, reason: 'pack: skeleton paths not verified (no skeleton file found for this spine group)' });
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
          const v = verifySpineSkeleton(skelJson, new Set(pl.atlases.flatMap((a) => a.sprites.map((s) => s.name))));
          if (v.unverified) {
            packUnverified++;
            skipped.push({ assetRef: group.skeletonRef, reason: 'pack: skeleton paths not verified (.skel binary or unrecognized skins shape)' });
          } else {
            packVerified += v.verified;
            packUnmatched += v.unmatched.length;
            for (const u of v.unmatched) skipped.push({ assetRef: group.id, reason: `pack: attachment '${u.attachment}' path '${u.region}' has no matching region` });
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
      changeRows.push(...packChanges(regions.map((r) => pathByRef.get(r.ref)).filter((p): p is string => !!p), packManifestPaths, packPageImages));
      packedGroups++;
      packedSheetCount += pl.atlases.length;
      packedRegionCount += regions.length;
      // VRAM honesty (invariant 5 / §6.8): track the pack delta SEPARATELY — never fold it into the
      // headline vramSaved. delta = new-sheet footprint − summed loose footprint; positive ⇒ packing RAISED
      // VRAM (POT padding), which is the common case for NPOT loose images. Surfaced as its own receipt row.
      packVramDelta += pl.vramBytesAfter - regions.reduce((s, r) => s + (vramByRef.get(r.ref) ?? 0), 0);
      // HONESTY (invariant 5): the extrude gutter alone may have pushed this sheet to a larger POT. Surface
      // ONLY the gutter-attributable growth (gutter pack footprint − the SAME pack with no gutter), kept
      // distinct from packVramDelta (the pack-vs-loose delta). Never claimed free; also inside packVramDelta.
      if (extGutter > 0) {
        const base = packLoose(regions, { kind: group.kind, imageBase: stem, targetMime: effTarget, trim: op.trim, padding: op.padding, maxSize: op.maxSize, allowRotation: false, ...(isSpine ? { format: 'RGBA8888' } : {}) });
        extrudeVramDelta += pl.vramBytesAfter - base.vramBytesAfter;
      }
      operations.push(`pack ${regions.length} loose → ${isSpine ? `${stem}.atlas` : `${stem} sheet`} (${pl.atlases.length} page${pl.atlases.length === 1 ? '' : 's'})`);
    }
  }

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
      skipped.push({ assetRef: consumerRef, reason: `dedup skipped: owner ${basename(ownerRef)} renamed by scale tiering — kept duplicate` });
      continue;
    }
    if (!predicted || !actual || actual.image !== predicted.image) {
      looseRepathSkipped++;
      skipped.push({ assetRef: consumerRef, reason: `dedup skipped: owner ${basename(ownerRef)} final name diverged — kept duplicate` });
      continue;
    }
    const consumerVram = vramByRef.get(consumerRef) ?? 0;
    const consumerDisk = bytesByRef.get(consumerRef)?.byteLength ?? 0;

    // Spine consumer (checked BEFORE the repointManifest branch — a Spine ref is an atlas in atlasByRef,
    // so isAtlasRef set repointManifest, but a .atlas page has NO portable cross-page redirect and must
    // never be re-emitted as TexturePacker JSON). Never silently delete a Spine page — KEEP + surface.
    if (spineRefs.has(consumerRef)) {
      looseRepathSkipped++;
      skipped.push({ assetRef: consumerRef, reason: 'dedup skipped: Spine cross-page dedup not drop-in — kept duplicate' });
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
        skipped.push({ assetRef: consumerRef, reason: 'dedup skipped: atlas consumer manifest unavailable — kept duplicate' });
        continue;
      }
      // meta.image must be relative to the consumer manifest's own directory (the owner image may sit in
      // another folder), reusing dirOf/normalize so it resolves the same way the parser does.
      const repointed: Atlas = { ...consumerAtlas, imageRef: relativeImageRef(dirOf(consumerManifest), actual.image) };
      out.push({ path: consumerManifest, bytes: te.encode(emitTexturePackerJson(repointed)) });
      replaced.add(consumerManifest);
      dropped.add(consumerPath); // drop only the redundant image; manifest is kept (rewritten above)
      referencesChanged = true;
      referencesRewritten++;
      dedupDiskBytesSaved += consumerDisk;
      dedupVramBytesSavedUpperBound += consumerVram;
      operations.push(`dedup ${basename(consumerRef)} → ${basename(ownerRef)} (repoint meta.image)`);
      continue;
    }

    // Whole-file (loose) consumer: drop + rewrite ONLY where AD itself emits the referencing manifest;
    // otherwise the reference may live in game code → KEEP + surface (fail-safe, the one place dedup
    // could silently break a build).
    const referencingManifest = manifestPathOf(consumerRef);
    if (!referencingManifest) {
      looseRepathSkipped++;
      skipped.push({ assetRef: consumerRef, reason: 'dedup skipped: loose duplicate reference may live in game code — kept duplicate' });
      continue;
    }
    const referencingAtlas = atlasByRef.get(consumerRef);
    if (!referencingAtlas) {
      looseRepathSkipped++;
      skipped.push({ assetRef: consumerRef, reason: 'dedup skipped: referencing manifest unavailable — kept duplicate' });
      continue;
    }
    const repointed: Atlas = { ...referencingAtlas, imageRef: relativeImageRef(dirOf(referencingManifest), actual.image) };
    out.push({ path: referencingManifest, bytes: te.encode(emitTexturePackerJson(repointed)) });
    replaced.add(referencingManifest);
    dropped.add(consumerPath);
    referencesChanged = true;
    referencesRewritten++;
    dedupDiskBytesSaved += consumerDisk;
    dedupVramBytesSavedUpperBound += consumerVram;
    operations.push(`dedup ${basename(consumerRef)} → ${basename(ownerRef)} (repoint meta.image)`);
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
    skipped.push({ assetRef: '(folder)', reason: 'tier skipped: folder already ships resolution tiers' });
  }
  // Dedup × tiering (design correction 8): when both are on, plan.ts disables owner-aware repoint (tiering
  // renames owners, so a repoint would target a name that no longer exists). Surface it once, honestly.
  if (tieringOn && !tierExcluded && !folderAlreadyTiered && opts.aggressive && dedupGroups && dedupGroups.length > 0) {
    skipped.push({ assetRef: '(dedup)', reason: 'dedup repoint disabled: scale tiering renames owners (kept duplicate consumers)' });
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
        skipped.push({ assetRef: ref, reason: 'tier skipped: asset was repacked/merged/packed (its sheet is not tiered in v1)' });
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
      // ROUND7 T9: Spine pages STAY PNG (runtime-safe) — a multi-format profile can't fan a Spine page out
      // across webp/avif, so it degrades to a single PNG per tier. Surface ONE honest note per Spine asset
      // (never a silent single-format result for a multi-format profile request). Single-format ⇒ no note.
      if (profileOn && profileMulti && isSpine) {
        skipped.push({ assetRef: ref, reason: 'export profile: Spine pages stay PNG — emitted PNG only (no webp/avif fan-out)' });
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
        const dst: Size = scaled ? { w: scaled.size.w, h: scaled.size.h } : scaleLoose(top, tier.scale);
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
        const tierEncodes: { mime: ImageMime; encOpts: EncodeOpts; fmtLabel: string }[] = profileOn
          ? profileFormats.map((f) => {
              const fe = formatEncode(f, tier.scale, profileGlobal);
              return { mime: isSpine ? 'image/png' : fe.targetMime, encOpts: feToEncodeOpts(fe), fmtLabel: f.format };
            })
          : [{ mime: isSpine ? 'image/png' : eff.targetMime, encOpts: encOptsFor(eff, true), fmtLabel: eff.targetMime }];
        // B4 collision guard (round7-export-profile.md §5b/§9): two formats can resolve to the SAME actual
        // mime post-encode via the AVIF→WebP→PNG / WebP→PNG fallbacks; emit the FIRST, SKIP the later (honest
        // note) — never overwrite. Keyed on the actual emitted image path (which carries the post-encode ext).
        const emittedThisTier = new Set<string>();
        for (const te0 of tierEncodes) {
          const enc = await encodeCanvas(canvas, c2d, te0.mime, te0.encOpts);
          if (!enc) {
            skipped.push({ assetRef: ref, reason: `tier skipped: encode to ${te0.mime} unavailable` });
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
            // B4: a later format fell back to a mime an earlier variant already emitted at this tier.
            skipped.push({ assetRef: ref, reason: `${te0.fmtLabel} fell back to ${enc.mime} and collides with another variant — skipped` });
            continue;
          }
          emittedThisTier.add(tierImagePath);
          out.push({ path: tierImagePath, bytes: enc.bytes });
          tierFilesEmitted++;
          if (profileOn) profileFilesEmitted++;

          if (scaled) {
            // Repoint imageRef at THIS tier+format's own image + stamp the exact ladder scale, so the
            // per-tier manifest's meta.image/meta.scale describe THIS emit (emitTexturePackerJson / Spine).
            // Single-format ⇒ variantManifestName produces the LEGACY `_suffix.json` name (byte-identical);
            // multi-format ⇒ the format token (`.webp`/`.avif`) disambiguates so the manifests never clobber.
            scaled.scale = tier.scale;
            scaled.imageRef = basename(tierImagePath);
            if (isSpine && spineInfo) {
              out.push({ path: variantManifestName(spineInfo.path, tier.suffix, enc.mime, profileMulti), bytes: te.encode(emitSpineAtlasText(scaled)) });
              tierFilesEmitted++;
              if (profileOn) profileFilesEmitted++;
              if (skelBytes && skelPath) {
                out.push({ path: variantManifestName(skelPath, tier.suffix, enc.mime, profileMulti), bytes: new Uint8Array(skelBytes) });
                tierFilesEmitted++;
                if (profileOn) profileFilesEmitted++;
              }
            } else if (manifestPath) {
              out.push({ path: variantManifestName(manifestPath, tier.suffix, enc.mime, profileMulti), bytes: te.encode(emitTexturePackerJson(scaled)) });
              tierFilesEmitted++;
              if (profileOn) profileFilesEmitted++;
            }
          }

          // Loader-migration: this variant's NEW load target — mirror the source (suffixed+tokened MANIFEST
          // for an atlas/Spine asset, suffixed+tokened IMAGE for a loose one), so it matches the loader call.
          tierTargetPaths.push(
            scaled && isSpine && spineInfo
              ? variantManifestName(spineInfo.path, tier.suffix, enc.mime, profileMulti)
              : scaled && manifestPath
                ? variantManifestName(manifestPath, tier.suffix, enc.mime, profileMulti)
                : tierImagePath,
          );
          emittedAny = true;
        }
        if (composeFailed) break;
        // VRAM ladder rung: ONE footprint per tier (the loaded tier's pixel area), regardless of how many
        // FORMATS were emitted — the runtime loads ONE format at this tier, so format fan-out adds DISK
        // only, never VRAM (invariant 5). Recorded once per tier, after the format loop.
        if (emittedThisTier.size > 0) tierVramBytes[ti] = (tierVramBytes[ti] ?? 0) + dst.w * dst.h * 4;
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
      operations.push(`tier ${basename(ref)} → ${tiers.length} resolution${tiers.length === 1 ? '' : 's'}`);
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
      if (ownerActualName.has(ref)) ownerActualName.get(ref)!.image = r.ownerImage;
      if (r.referencesChanged) referencesChanged = true;
      operations.push(`export profile ${basename(imagePath)} → ${profileFormats.length} format${profileFormats.length === 1 ? '' : 's'}`);
    }
  }

  // A VALID profile that fanned out NOTHING (e.g. an atlas-only folder, or every loose image was already
  // dropped/repacked/owned) — surface an honest `(profile)` skip so the user sees WHY their explicit
  // request produced no variants (finding [0]: surfaced-never-silent). The receipt still carries
  // exportProfile with assets=0 (above), so the two together are fully honest. profileOff ⇒ no note.
  if (profileOn && profileAssets === 0) {
    skipped.push({ assetRef: '(profile)', reason: 'export profile: no eligible loose images to emit (atlas-only folder or all claimed by another fix)' });
  }

  // ── SELECTIVE FIX honest skips (docs/improvements/selective-fix.md) ───────────────────────────────
  // For every op KIND the dev DESELECTED in the Plan card that WOULD have run, surface ONE honest skipped[]
  // note ("<kind> skipped: deselected in plan"), in OP_KIND_ORDER. No pixel work ran for these (the loops
  // above already `continue`d/gated past them), so the receipt now reflects exactly what executed — a
  // deselected op is SURFACED, never silently dropped (no faked savings). excludeKinds empty ⇒ this is a
  // no-op ⇒ skipped[] / receipt byte-identical to today.
  for (const s of deselectedSkips(excluded, wouldRunByKind)) skipped.push(s);

  // ── pass-through untouched files → drop-in optimized folder ──
  for (const f of files) {
    if (replaced.has(f.path) || dropped.has(f.path)) continue;
    out.push({ path: f.path, bytes: new Uint8Array(f.bytes) });
  }

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
  const entries: ZipEntry[] = dedupedOut.map((e) => ({ name: e.path, bytes: e.bytes }));
  const zip = makeZip(entries);

  const diskBefore = files.reduce((s, f) => s + f.bytes.byteLength, 0);
  const diskAfter = dedupedOut.reduce((s, e) => s + e.bytes.byteLength, 0);
  const vramBefore = report.totals.vramBytes;
  // Loader-migration guide (docs/improvements/loader-migration.md): the genuine loader-CALL changes this
  // run made, sorted+deduped deterministically. DEDUP contributed ZERO rows (B1). Attached ONLY when
  // referencesChanged AND ≥1 real row exists — drop-in / no-op runs omit it ⇒ receipt byte-identical.
  const changes = finalizeChanges(changeRows);
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
    ...(polyVramBefore > 0 ? { polygonAreaSavedPct: (polyVramBefore - polyVramAfter) / polyVramBefore } : {}),
    // Feature 4 (pack loose, additive, optional): packedSheets = packs performed / page images emitted /
    // loose files folded in (now dropped). packVerification = Spine path-verification (verified matched /
    // unmatched / unverified). Absent in non-pack runs ⇒ receipt byte-identical to today.
    ...(packedGroups > 0 ? { packedSheets: { groups: packedGroups, sheets: packedSheetCount, regions: packedRegionCount } } : {}),
    ...(packVerified > 0 || packUnmatched > 0 || packUnverified > 0 ? { packVerification: { verified: packVerified, unmatched: packUnmatched, unverified: packUnverified } } : {}),
    // Pack VRAM delta (invariant 5): present SEPARATELY, never folded into vramBytesAfter. Emitted only on
    // an actual pack run with a non-zero delta — a positive value means packing RAISED VRAM (POT padding).
    ...(packedGroups > 0 && packVramDelta !== 0 ? { packVramDelta } : {}),
    // Scale-tier export (additive, optional — absent in non-tier runs ⇒ receipt byte-identical to today).
    // Counts ONLY assets actually tiered (refused/skipped excluded). tierVram exposes the per-tier loaded
    // footprint ladder; it is NEVER folded into vramBytesAfter (invariant 5) and tiering adds 0 to vramSaved
    // (the top tier == the source footprint — tiers are alternatives, the runtime loads exactly one).
    ...(tieredAssets > 0 ? { scaleTiered: { tiers: tiers.length, filesEmitted: tierFilesEmitted, assets: tieredAssets } } : {}),
    ...(tieredAssets > 0 ? { tierVram: tiers.map((t, i) => ({ suffix: t.suffix, scale: t.scale, vramBytes: tierVramBytes[i]! })) } : {}),
    // Config-driven export profile (round7-export-profile.md §3/§9, T9 — additive, optional). `formats`/
    // `tiers` = the VALIDATED counts; `assets` = assets fanned out; `filesEmitted` = total variant files (Σ
    // image + manifest/skeleton across formats × tiers). DISK-only — the runtime loads ONE format × ONE tier,
    // so this contributes 0 to vramBytesAfter (the per-tier VRAM ladder stays `tierVram`; invariant 5).
    // Surfaced whenever the profile was VALID (profileOn) — finding [0]: an explicit profile request must
    // ALWAYS report what it produced, INCLUDING assets=0 (an honest "nothing to fan out" — never silent).
    // `tiers` uses profileTiers.length (the validated profile ladder: a format-only profile carries a single
    // scale-1 top tier even though the legacy `tiers` array is empty for it). Absent only when no valid
    // profile ran ⇒ receipt byte-identical to today.
    ...(profileOn ? { exportProfile: { formats: profileFormats.length, tiers: profileTiers.length, assets: profileAssets, filesEmitted: profileFilesEmitted } } : {}),
    // Edge-extrude (bleed, design OPTION A — additive, optional). extrudePx = the requested bleed width;
    // extrudedBlits = rectangle blits that got a real bleed; extrudeSkipped = blits where extrude was
    // REQUESTED but skipped (meshed clip / rotated — no polygon-edge/rotated extrude in v1). extrudeVramDelta
    // = HONEST VRAM growth from the symmetric gutter pushing a sheet to a larger POT (invariant 5: a gutter
    // CAN grow a bin ⇒ MORE VRAM — never claimed free; the growth is ALSO already inside vramBytes*). All
    // absent unless extrude>0 actually ran ⇒ receipt byte-identical to today (default OFF).
    ...(extrudedBlits > 0 ? { extrudePx: extrudePxApplied, extrudedBlits } : {}),
    ...(extrudeSkippedCount > 0 ? { extrudeSkipped: extrudeSkippedCount } : {}),
    ...(extrudeVramDelta !== 0 ? { extrudeVramDelta } : {}),
    // Sheet-diff X-ray (round6-f1-sheet-diff.md, additive/optional): before/after FilmViewer pairs for the
    // first SHEET_DIFF_MAX composed sheets; sheetDiffsTotal counts ALL composed ("showing N of M"). Empty
    // ⇒ both omitted ⇒ receipt byte-identical to today.
    ...(sheetDiffs.length > 0 ? { sheetDiffs, sheetDiffsTotal } : {}),
  };
  // Direct postMessage (not the `post` wrapper) so the sheet-diff byte buffers transfer zero-copy. The
  // transferred buffers are FRESH COPIES (captureSheetDiff sliced both), so the live source/emitted buffers
  // already in `out`→zip stay intact. Empty sheetDiffs ⇒ empty transfer list ⇒ identical to today.
  const transfer = sheetDiffs.flatMap((d) => [d.beforeBytes, d.afterBytes]);
  ctx.postMessage({ type: 'fix-done', receipt, zip } satisfies FixResponse, transfer);
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
}

const clamp06 = (n: number): number => Math.max(0, Math.min(6, Math.round(n)));

// Lazy oxipng module handle (Task 10). Loaded ON FIRST USE ONLY — never imported in the diagnosis path,
// so the diagnosis bundle/payload (invariant 4, ≤10s) is untouched until a Pro fix actually opts in to
// PNG recompression. Cached so repeated PNG recompresses in one run share the single WASM init.
// @jsquash/oxipng re-exports its optimiser as the NAMED export `optimise` (index.js does
// `export { default as optimise } from './optimise.js'`), so the module shape is { optimise }, not { default }.
type OxipngMod = { optimise: (d: ImageData | ArrayBuffer, o?: { level?: number }) => Promise<ArrayBuffer> };
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
async function encodeCanvas(canvas: OffscreenCanvas, c2d: OffscreenCanvasRenderingContext2D, target: ImageMime, opts: EncodeOpts): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
  const q = opts.quality ?? 0.85;
  const effort = clamp06(opts.effort ?? 0);
  if (target === 'image/avif') {
    // AVIF has no canvas encoder → always @jsquash. speed is inverse to effort (higher effort = slower/
    // better): effort 0→speed 10 (fast), effort 6→speed 6. subsample only when explicitly supplied.
    try {
      const data = c2d.getImageData(0, 0, canvas.width, canvas.height);
      const m = (await import('@jsquash/avif')) as { encode: (d: ImageData, o?: Record<string, number | boolean>) => Promise<ArrayBuffer> };
      const buf = await m.encode(data, {
        quality: Math.round(q * 100),
        qualityAlpha: opts.avifQualityAlpha ?? -1,
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
        const m = (await import('@jsquash/webp')) as { encode: (d: ImageData, o?: Record<string, number>) => Promise<ArrayBuffer> };
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
async function recompressPng(c2d: OffscreenCanvasRenderingContext2D, canvas: OffscreenCanvas, level: number): Promise<Uint8Array | null> {
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
async function transcode(bytes: ArrayBuffer, target: ImageMime, enc: EncodeOpts): Promise<{ bytes: Uint8Array; mime: ImageMime } | null> {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const c2d = canvas.getContext('2d');
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
  const dir = pageImagePath.includes('/') ? pageImagePath.slice(0, pageImagePath.lastIndexOf('/')) : '';
  const inDir = (p: string): boolean => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') === dir;
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
      if (typeof o.skeleton === 'object' && o.skeleton !== null && o.bones != null && o.slots != null) consider(f.path);
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

const MIME_BY_EXT: Record<string, ImageMime> = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', avif: 'image/avif' };
const mimeOf = (path: string): ImageMime => MIME_BY_EXT[(path.split('.').pop() ?? '').toLowerCase()] ?? 'image/png';

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
