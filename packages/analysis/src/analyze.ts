// Orchestrator: normalized assets + thresholds → AnalysisReport. Produces per-asset findings
// AND whole-folder findings (scope: 'folder'). The two impure dependencies — WebP/AVIF encoding
// (canvas) and per-image features (hash/dHash) — are injected via deps so the core stays
// headless-testable.

import type {
  AnalysisReport,
  Asset,
  AssetMetrics,
  Atlas,
  AtlasFrameHashes,
  AtlasFrameTrims,
  ContentClass,
  Finding,
  FindingParams,
  ImageAsset,
  ImageFeatures,
  Rect,
  Severity,
  SpineSkeletonBinding,
  ThresholdConfig,
  TrimRect,
} from '@asset-doctor/core';
import { MIP_OVERHEAD } from '@asset-doctor/core';
import { DEFAULT_THRESHOLDS } from './config';
import {
  binaryAlphaFinding,
  bleedingFinding,
  dimensionFindings,
  dimensionMismatchFinding,
  formatFinding,
  frameRedundancyFinding,
  gutterFinding,
  spineUnreferencedRegionsFindings,
  iccNonSrgbFinding,
  interiorTransparencyFinding,
  occupancyFinding,
  occupancyValue,
  solidFillFinding,
  upscaledSourceFinding,
  strippableMetadataFinding,
  trimMarginFinding,
  vramBytes,
  vramBytesMipmapped,
  wastedAlphaFinding,
  wastedRegions,
  type EncodeSizer,
  type OpaqueEncodeSizer,
} from './rules';
import {
  atlasMergeFinding,
  crossAtlasRedundancyFinding,
  duplicateExactFindings,
  duplicateSimilarFindings,
  formatAggregateFinding,
  integrityFindings,
  mipmapCostFinding,
  gpuCompressionAlignmentFinding,
  premultipliedAlphaFinding,
  shouldAtlasFinding,
  strippableMetadataAggregateFinding,
} from './folder';
import { groupVariants, redundantFormatRefs, variantsFinding } from './variants';
import { fontGlyphPageFinding } from './font';

export interface AnalyzeDeps {
  /** Encode an asset's image to a target format → byte size (or null). Browser/worker supplies
   *  this via canvas.convertToBlob; headless tests mock it. */
  encodeImage?: EncodeSizer;
  /** Re-encode an asset's image OPAQUE (drop the dead alpha channel) to its SAME format → byte size (or
   *  null). MEASURES the honest disk cost of a fully-opaque image's unused alpha channel (the wasted-alpha
   *  finding). Browser/worker supplies it via an `{alpha:false}` OffscreenCanvas; headless/CLI omits it ⇒
   *  the finding never fires (byte-identical to today). */
  encodeOpaque?: OpaqueEncodeSizer;
  /** Per-image features (content hash + dHash) for folder-level duplicate detection. */
  features?: ImageFeatures[];
  /** Per-atlas sprite-region hashes (keyed by post-merge atlas.name, index-aligned to the merged sprite
   *  list) for the within-atlas frame-redundancy check. The worker computes these from the ALREADY-DECODED
   *  atlas page (one decode/page, bounded); headless/CLI omits them ⇒ the finding never fires (additive,
   *  byte-identical — gated exactly like the dHash features). */
  frameHashes?: AtlasFrameHashes[];
  /** Per-atlas sprite OPAQUE bounding boxes (keyed by post-merge atlas.name, index-aligned to the merged
   *  sprite list) for the within-atlas trim-margin check. The worker computes these in the SAME decode pass
   *  as `frameHashes` (off the already-decoded atlas page — no second decode); headless/CLI omits them ⇒ the
   *  finding never fires (additive, byte-identical — gated exactly like the frame hashes). */
  frameTrims?: AtlasFrameTrims[];
  /** Manifests whose referenced image is missing from the folder. */
  missingImages?: { manifest: string; image: string }[];
  /** Would-be assets the host could NOT parse (ingest skip-points + worker parse failures) — surfaced
   *  honestly instead of silently dropped. Pure pass-through: the host has already sorted by ref; this
   *  layer never re-sorts or filters. Absent/empty ⇒ byte-identical to today. */
  unparsed?: { ref: string; reason: string }[];
  /** Per-bmfont-page font metadata (face name + kerning count) read off the parsed FntPage by the host,
   *  keyed by atlas.name. Drives the font-glyph-page readout for `source.kind === 'bmfont'` atlases.
   *  Absent ⇒ the readout falls back to kerning 0 / no face (still fires if the page clears minChars);
   *  additive — a folder with no bmfont page is byte-identical to today (gated like frameHashes). */
  fontPages?: { atlasRef: string; faceName?: string; kerningCount: number }[];
  /** Host-paired Spine skeleton bindings (same-dir .atlas ↔ skeleton .json union; .skel suppresses) for
   *  the spine-unreferenced-regions disclosure. Absent (CLI/headless — unwired in v1, or no paired
   *  skeleton) ⇒ the rule never fires ⇒ byte-identical (gated exactly like frameHashes). */
  spineBindings?: SpineSkeletonBinding[];
}

const RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2, ok: 3 };

export async function analyze(
  assets: Asset[],
  cfg: ThresholdConfig = DEFAULT_THRESHOLDS,
  deps: AnalyzeDeps = {},
): Promise<AnalysisReport> {
  const findings: Finding[] = [];
  const metrics: AssetMetrics[] = [];
  const formatFindings: Finding[] = [];
  const atlases: Atlas[] = [];
  // Per-atlas packed frame rects for the host render-probe (which sprites to draw) — keyed by
  // atlas.name, the SAME value used for AssetMetrics.assetRef (below) and the fileMap keyOf ref in the
  // web app. That equality is an invariant (asserted in tests), not interchangeable by luck. Stays
  // undefined when no atlas has frames so a loose-only folder is byte-identical to today.
  const atlasFrames: Record<string, Rect[]> = {};
  let potentialDiskSaved = 0;

  // Content-class verdict drives lossy-vs-lossless ONLY for LOOSE images (design M1: a 72-px average
  // of a packed atlas collage is meaningless, so atlases pass 'unknown' below and keep today's lossy
  // verdict). Built from the host-supplied features; absent ⇒ empty ⇒ every call 'unknown' ⇒
  // byte-identical to today (CLI / headless tests unaffected).
  const classByRef = new Map<string, ContentClass>();
  for (const f of deps.features ?? []) if (f.contentClass) classByRef.set(f.assetRef, f.contentClass);

  // Single-color (solid) marking from the SAME 9×8 sample the worker already decodes for dHash. Loose
  // images only (atlases never trip it — a collage average is meaningless). Absent ⇒ empty ⇒ no
  // solid-fill finding ⇒ byte-identical to today (CLI / headless tests unaffected).
  const solidByRef = new Set<string>();
  for (const f of deps.features ?? []) if (f.solid) solidByRef.add(f.assetRef);
  // ref → proven nearest-2× upscale depth (upscaled-source). Absent ⇒ never fires (byte-identical to today).
  const upscaleDepthByRef = new Map<string, number>();
  for (const f of deps.features ?? []) if (f.blockUpscaleDepth) upscaleDepthByRef.set(f.assetRef, f.blockUpscaleDepth);

  // Fully-opaque marking from the host's FULL-FRAME alpha scan (a fully-opaque image still carrying an
  // alpha channel wastes DISK bytes). Loose images only (atlases never trip it). Absent ⇒ empty ⇒ no
  // wasted-alpha finding ⇒ byte-identical to today (CLI / headless tests unaffected).
  const opaqueByRef = new Set<string>();
  for (const f of deps.features ?? []) if (f.opaque) opaqueByRef.add(f.assetRef);

  // Alpha-shape readout (bbox of alpha>0 + interior-transparent count + binary-alpha flag) from the host's
  // ONE full-res scan — the same fullData pass as the opaque scan. Drives the loose-only
  // interior-transparency + binary-alpha disclosures (both info, NO estimate — nothing here ever touches
  // potentialDiskSaved/totals). Absent ⇒ empty ⇒ neither fires ⇒ byte-identical to today (CLI / headless).
  const shapeByRef = new Map<string, NonNullable<ImageFeatures['alphaShape']>>();
  for (const f of deps.features ?? []) if (f.alphaShape) shapeByRef.set(f.assetRef, f.alphaShape);

  // Per-atlas sprite-region hashes (within-atlas frame-redundancy), keyed by post-merge atlas.name. The
  // host hashes regions off the already-decoded page; absent ⇒ empty ⇒ no frame-redundancy finding ⇒
  // byte-identical to today (CLI / headless tests unaffected).
  const frameHashByRef = new Map<string, (string | null)[]>();
  for (const fh of deps.frameHashes ?? []) frameHashByRef.set(fh.atlasRef, fh.frameHashes);

  // Per-bmfont-page font metadata (face + kerning count), keyed by atlas.name. The host reads it off the
  // parsed FntPage; absent ⇒ empty ⇒ the font-glyph-page readout falls back to no-face / kerning 0 (still
  // fires on a bmfont page that clears minChars), and a non-bmfont folder is byte-identical to today.
  const fontByRef = new Map<string, { faceName?: string; kerningCount: number }>();
  for (const fp of deps.fontPages ?? []) fontByRef.set(fp.atlasRef, { faceName: fp.faceName, kerningCount: fp.kerningCount });

  // Per-atlas image byteSize, keyed by atlas.name — feeds the CROSS-ATLAS-redundancy disk estimate (each
  // freed cross-sheet copy's bytes are area-proportionally attributed to its OWN atlas). Populated in the
  // atlas branch below; empty for a loose-only folder ⇒ the disk estimate is simply 0 (VRAM still exact).
  const byteByRef = new Map<string, number>();

  // Per-atlas sprite opaque bboxes (within-atlas trim-margin), keyed by post-merge atlas.name. The host
  // computes them in the SAME decode pass as the frame hashes; absent ⇒ empty ⇒ no trim-margin finding ⇒
  // byte-identical to today (CLI / headless tests unaffected).
  const frameTrimByRef = new Map<string, (TrimRect | null)[]>();
  for (const ft of deps.frameTrims ?? []) frameTrimByRef.set(ft.atlasRef, ft.bboxes);

  // Per-ref MAX-de-overlap of the disk savings that target the SAME bytes. The FORMAT finding (transcode to
  // AVIF/WebP), the WASTED-ALPHA finding (re-encode opaque) and the STRIPPABLE-METADATA finding (re-encode /
  // oxipng) all overlap on one ref: a single re-encode drops the dead alpha plane AND the ancillary metadata
  // while transcoding, so SUMMING them would OVERSTATE the aggregate. We contribute the per-ref RUNNING MAX
  // (not the sum) via `bumpBest`: addFormat seeds the best, and each later candidate adds only the EXCESS over
  // the current best. Keyed by ref; one report = one map. `metaFindings` collects the per-asset strippable
  // findings for the folder rollup. Frame-redundancy/trim-margin/cross-atlas disk numbers are AREA ESTIMATES
  // and stay OUT of this entirely (invariant 5 — never summed onto measured savings).
  const bestSavedByRef = new Map<string, number>();
  const metaFindings: Finding[] = [];

  const bumpBest = (ref: string, candidate: number): void => {
    const prev = bestSavedByRef.get(ref) ?? 0;
    if (candidate > prev) {
      potentialDiskSaved += candidate - prev;
      bestSavedByRef.set(ref, candidate);
    }
  };

  const addFormat = async (ref: string, image: ImageAsset, contentClass: ContentClass = 'unknown') => {
    const fmt = await formatFinding(ref, image, cfg, deps.encodeImage, contentClass);
    if (fmt) {
      findings.push(fmt);
      formatFindings.push(fmt);
      bumpBest(ref, fmt.estimate?.diskBytesSaved ?? 0);
    }
  };

  // Strippable ancillary metadata (ICC/EXIF/XMP + non-essential chunks) — fires for LOOSE images AND atlas
  // page images (both carry `image.strippableBytes` from the parser). EXACT disk saving; de-overlapped with
  // format/wasted-alpha via bumpBest (a re-encode that transcodes/drops-alpha ALSO strips this metadata).
  const addStrippable = (ref: string, image: ImageAsset): void => {
    const meta = strippableMetadataFinding(ref, image, cfg);
    if (meta) {
      findings.push(meta);
      metaFindings.push(meta);
      bumpBest(ref, meta.estimate?.diskBytesSaved ?? 0);
    }
  };

  // Non-sRGB ICC disclosure — fires whenever the parser kept an ICC profile it could not prove is sRGB
  // (image.icc && !provableSrgb). A CORRECTNESS/disclosure finding: NO estimate, so it NEVER touches
  // potentialDiskSaved/bumpBest (invariant 3/5). Absent icc (no profile / legacy) ⇒ never fires ⇒
  // byte-identical to today. Loose images AND atlas page images both carry image.icc from the parser.
  const addIcc = (ref: string, image: ImageAsset): void => {
    const f = iccNonSrgbFinding(ref, image);
    if (f) findings.push(f);
  };

  for (const asset of assets) {
    if (asset.kind === 'atlas') {
      const { atlas, image } = asset;
      atlases.push(atlas);
      byteByRef.set(atlas.name, image.byteSize); // for the cross-atlas-redundancy disk estimate (folder scope)
      // B3: call wastedRegions BEFORE metrics.push so the dispersion (frag/largestPct) it computes is
      // available both to AssetMetrics.fragmentation and to occupancyFinding's honest copy.
      const waste = wastedRegions(atlas, cfg);
      const wasteFrag = waste && typeof waste.params?.frag === 'number' ? waste.params.frag : undefined;
      const wasteLargestPct =
        waste && typeof waste.params?.largestPct === 'number' ? waste.params.largestPct : undefined;
      metrics.push({
        assetRef: atlas.name,
        diskBytes: image.byteSize,
        vramBytes: vramBytes(atlas.size),
        vramBytesMipmapped: vramBytesMipmapped(atlas.size),
        occupancy: occupancyValue(atlas),
        ...(wasteFrag !== undefined ? { fragmentation: wasteFrag } : {}),
      });
      const occ = occupancyFinding(atlas, cfg, { fragmentation: wasteFrag, largestPct: wasteLargestPct });
      if (occ) findings.push(occ);
      if (waste) findings.push(waste);
      findings.push(...dimensionFindings(atlas.name, atlas.size, cfg));
      // Texture bleeding: frame pairs touching with 0px gutter (pure rect math off the placed frames — NO
      // decode, NO host data). A CORRECTNESS finding: it carries no saving (edge-extrude can grow the sheet,
      // invariant 5), so NOTHING flows into potentialDiskSaved/totals. Absent cfg.bleeding (CLI/headless) ⇒
      // no finding ⇒ byte-identical.
      const bleed = bleedingFinding(atlas, cfg);
      if (bleed) findings.push(bleed);
      // Excessive gutter — the inverse packing disclosure (median nearest-neighbour gap systematically wide).
      // Pure integer geometry, always info, NO estimate ⇒ nothing flows into totals. CLI note (verified):
      // the BUDGET path resolves thresholds from a partial (resolveThresholds enumerates 7 groups ⇒ no
      // cfg.gutter ⇒ null there), but plain `audit`/`init` run FULL DEFAULT_THRESHOLDS, so this finding CAN
      // fire in CLI audit JSON — additive only, the same shape bleeding/wasted-regions already emit there.
      const gut = gutterFinding(atlas, cfg);
      if (gut) findings.push(gut);
      // Declared (atlas.size = manifest meta.size / Spine page size:) vs REAL (image.size = decoded pixel
      // header) atlas dimensions. A pure integer compare of two values the parser already holds — the
      // always-on static sibling of the optional render-probe's declared-vs-measured label. A CORRECTNESS
      // finding: NO saving (it states two measurements, invariant 5), so NOTHING flows into
      // potentialDiskSaved/totals. Absent cfg.dimensionMismatch (a budget config that omits it) ⇒ no finding
      // ⇒ byte-identical; DEFAULT_THRESHOLDS keeps it on for browser + CLI audit/init.
      const dm = dimensionMismatchFinding(atlas, image, cfg);
      if (dm) findings.push(dm);
      await addFormat(atlas.name, image, 'unknown'); // M1: atlases keep today's lossy verdict
      // Strippable ancillary metadata on the atlas PAGE image (the manifest JSON is never scanned). De-overlapped
      // with the page's format saving via bumpBest (one re-encode transcodes AND strips the metadata).
      addStrippable(atlas.name, image);
      // A non-sRGB ICC profile on the page image (disclosure only; no estimate — see addIcc).
      addIcc(atlas.name, image);
      // Within-atlas frame redundancy: frames whose pixel REGIONS are byte-identical (host-hashed off the
      // already-decoded page). Only when the host supplied region hashes for THIS atlas (absent ⇒ no
      // finding ⇒ byte-identical). The recoverable disk number is an area-proportional ESTIMATE, so it is
      // DELIBERATELY NOT folded into potentialDiskSaved — same MAX-de-overlap honesty precedent as the
      // wasted-alpha/format aggregate below (we never sum an estimate onto measured savings, invariant 5).
      const fh = frameHashByRef.get(atlas.name);
      if (fh) {
        const fr = frameRedundancyFinding(atlas, cfg, fh, image.byteSize);
        if (fr) findings.push(fr);
      }
      // Within-atlas trim-margin: untrimmed sprites carrying reclaimable transparent padding (host-measured
      // opaque bboxes off the SAME decoded page as the frame hashes). Only when the host supplied bboxes for
      // THIS atlas (absent ⇒ no finding ⇒ byte-identical). Reports EXACT VRAM only — no disk estimate: the
      // recoverable area is transparent padding (alpha=0), so an area-proportional byte number would over-state
      // 10x+ (see rules.ts); nothing is folded into potentialDiskSaved (invariant 5).
      const ft = frameTrimByRef.get(atlas.name);
      if (ft) {
        const tm = trimMarginFinding(atlas, cfg, ft);
        if (tm) findings.push(tm);
      }
      // BMFont glyph-page readout: a parsed `.fnt` page IS an atlas, so it already tripped the generic
      // findings above; this adds a font-specific informational readout BESIDE them (positive-guarded on
      // source.kind === 'bmfont' inside the rule). The estimate carries ONLY occupancyPct — the generic
      // occupancy/oversize findings own the VRAM on this same page (invariant 5; no double-count).
      if (atlas.source.kind === 'bmfont') {
        const fp = fontByRef.get(atlas.name) ?? { kerningCount: 0 };
        const gp = fontGlyphPageFinding(atlas, cfg, fp);
        if (gp) findings.push(gp);
      }
      // The packed rects the host render-probe replays as sprites. Keyed by atlas.name === the
      // assetRef pushed above. `frame` is the rect AS PLACED in the atlas image (already w/h-swapped
      // when rotated), which is exactly what probeAtlas wants.
      if (atlas.sprites.length > 0) {
        atlasFrames[atlas.name] = atlas.sprites.map((s) => ({ ...s.frame }));
      }
    } else {
      const { image } = asset;
      metrics.push({
        assetRef: image.name,
        diskBytes: image.byteSize,
        vramBytes: vramBytes(image.size),
        vramBytesMipmapped: vramBytesMipmapped(image.size),
      });
      findings.push(...dimensionFindings(image.name, image.size, cfg));
      if (solidByRef.has(image.name)) {
        const solid = solidFillFinding(image.name, image.size, cfg);
        if (solid) findings.push(solid);
      } else {
        // Provable nearest-2× upscale — de-overlapped with solid-fill (a solid image is solid-fill's, and its
        // blocks are all constant, so it would otherwise trip both). NO estimate is contributed to any total.
        const up = upscaledSourceFinding(image.name, image.size, cfg, upscaleDepthByRef.get(image.name));
        if (up) findings.push(up);
      }
      // Interior-transparency + binary-alpha — TWO disclosures off the host's ONE alphaShape scan (both
      // info, NO estimate ⇒ nothing flows into potentialDiskSaved/totals). De-overlap mirrors the block
      // above: a solid image is solid-fill's (skip both); a fully-opaque image is wasted-alpha's (skip
      // binary-alpha — interior-transparency cannot fire there anyway: zero transparent pixels). Absent
      // shape/config ⇒ the rules return null ⇒ byte-identical to today.
      if (!solidByRef.has(image.name)) {
        const shape = shapeByRef.get(image.name);
        const interior = interiorTransparencyFinding(image.name, image.size, cfg, shape);
        if (interior) findings.push(interior);
        if (!opaqueByRef.has(image.name)) {
          const binary = binaryAlphaFinding(image.name, image.size, cfg, shape);
          if (binary) findings.push(binary);
        }
      }
      await addFormat(image.name, image, classByRef.get(image.name) ?? 'unknown');
      // Wasted alpha: a fully-opaque loose image still carrying an alpha channel. Loose-only, gated on the
      // host's full-frame opaque scan; the MEASURED disk saving (opaque re-encode, same format) is real and
      // DISK-only (invariant 5). Absent feature / no encodeOpaque dep ⇒ never fires ⇒ byte-identical.
      if (opaqueByRef.has(image.name)) {
        const wa = await wastedAlphaFinding(image.name, image, cfg, deps.encodeOpaque);
        if (wa) {
          findings.push(wa);
          // De-overlap: the format finding (if any) for this ref already counted a transcode disk saving that
          // SUBSUMES most of the dead-alpha drop (re-encoding the format also drops the alpha plane). bumpBest
          // contributes only the EXCESS over the running max so the aggregate never double-counts.
          bumpBest(image.name, wa.estimate?.diskBytesSaved ?? 0);
        }
      }
      // Strippable ancillary metadata on the loose image. De-overlapped with format/wasted-alpha via bumpBest
      // (one re-encode transcodes / drops-alpha AND strips this metadata — three-way MAX, never the sum).
      addStrippable(image.name, image);
      // A non-sRGB ICC profile on the loose image (disclosure only; no estimate — see addIcc).
      addIcc(image.name, image);
    }
  }

  // Presentation-only DEMOTION marker (invariant 3): a per-file `format` suggestion is REDUNDANT when a
  // sibling in the SAME format-only cluster (same stem, exact dims, no resolution token) already ships in
  // the recommended target format. We MEASURE that and mark the finding; we do NOT change its estimate,
  // severity, or potentialDiskSaved (the png→avif saving stays counted — reverting it would UNDER-state a
  // real recoverable saving). Guarded on there being format findings, so the CLI (which produces none —
  // no encodeImage ⇒ no format findings) is byte-identical. Additive metadata; consumed only by the browser.
  if (formatFindings.length > 0) {
    const redundant = redundantFormatRefs(assets, formatFindings);
    for (const f of formatFindings) {
      if (redundant.has(f.assetRef)) (f.params as FindingParams).redundantSibling = 1;
    }
  }

  // ── whole-folder findings ──────────────────────────────────────────────
  const folder: Finding[] = [];
  if (deps.features && deps.features.length > 0) {
    const exact = duplicateExactFindings(assets, deps.features);
    folder.push(...exact);
    // De-overlap each exact-dup group against its own format/alpha/strippable savings. The dedup term
    // (perDisk*(n-1)) stays — but the DROPPED copies (relatedRefs ≠ assetRef) VANISH on dedup, so the
    // per-ref MAX bumps they already contributed to potentialDiskSaved via bumpBest are PHANTOM and must
    // be reverted. The KEPT copy (refs[0] === f.assetRef) STILL exists post-dedup and is still
    // transcodable, so its full contribution is retained. Net group disk = perDisk*(n-1) − Σ
    // bestSavedByRef[droppedRef]. The subtraction is EXACT: the running-max final value == the total
    // contributed for that ref. Invariant 5: removes a real DISK over-claim from the headline; VRAM
    // untouched. (CLI/headless DOES pass features with contentHash, so this block RUNS there too — it is
    // not skipped. The CLI just passes no encodeImage/encodeOpaque, so format/wasted-alpha never bump;
    // the only revertable per-ref saving on the CLI path is strippable-metadata, which addStrippable bumps
    // unconditionally. So a dropped exact-dup copy carrying strippable metadata correctly reverts its
    // phantom bump on the CLI too — byte-identical only when no dropped copy has any revertable bump.)
    for (const f of exact) {
      potentialDiskSaved += f.estimate?.diskBytesSaved ?? 0; // dedup term, unchanged
      for (const ref of f.relatedRefs ?? []) {
        if (ref === f.assetRef) continue; // keep the kept copy's (refs[0]) MAX contribution
        potentialDiskSaved -= bestSavedByRef.get(ref) ?? 0; // revert the dropped copy's phantom bumps
      }
    }
    folder.push(...duplicateSimilarFindings(deps.features, cfg));
    // Premultiplied-shaped-edges DISCLOSURE (folder scope, loose-only). Fires only off host-measured
    // `premultipliedEdge` features (the worker's full-res scan) — CLI/headless features never carry it ⇒
    // never fires ⇒ byte-identical. Severity info, NO estimate (conditional disclosure — the pixels cannot
    // reveal the loader's blend mode, invariant 3), so NOTHING flows into potentialDiskSaved/totals.
    const pma = premultipliedAlphaFinding(assets, deps.features, cfg);
    if (pma) folder.push(pma);
  }
  const sa = shouldAtlasFinding(assets, cfg);
  if (sa) folder.push(sa);
  // GPU block-compression alignment — HEADER-ONLY (parsed sizes, zero decode, zero features), so it lives
  // OUTSIDE the features-gated block. Always info, NO estimate ⇒ nothing flows into totals. Browser-only in
  // practice: the CLI's resolveThresholds never carries cfg.gpuCompression ⇒ null there (byte-identical).
  const gca = gpuCompressionAlignmentFinding(assets, cfg);
  if (gca) folder.push(gca);
  // Spine unreferenced-regions — per-PAGE disclosures off the host's skeleton pairing (deps-gated: absent
  // bindings ⇒ nothing, CLI/headless byte-identical). Always info, NO estimate ⇒ totals untouched.
  findings.push(...spineUnreferencedRegionsFindings(atlases, deps.spineBindings ?? [], cfg));
  const am = atlasMergeFinding(atlases, cfg);
  if (am) folder.push(am);
  // Cross-atlas frame redundancy: frames whose pixel REGIONS are byte-identical ACROSS ≥2 atlases. Clusters
  // the SAME region hashes the within-atlas rule consumes per-atlas (here folder-wide); absent hashes / no
  // cross-sheet dupes ⇒ no finding ⇒ byte-identical to today. The disk number is an area-proportional ESTIMATE
  // and is DELIBERATELY NOT folded into potentialDiskSaved (invariant 5) — same precedent as frame-redundancy.
  const car = crossAtlasRedundancyFinding(atlases, frameHashByRef, byteByRef, cfg);
  if (car) folder.push(car);
  if (deps.missingImages && deps.missingImages.length > 0) {
    folder.push(...integrityFindings(deps.missingImages));
  }
  const fa = formatAggregateFinding(formatFindings);
  if (fa) folder.push(fa);
  // Folder rollup of the per-asset strippable-metadata findings (≥2). DISPLAY-ONLY — like format-aggregate it
  // is NOT folded into potentialDiskSaved (the per-asset findings already bumped it via bumpBest).
  const sma = strippableMetadataAggregateFinding(metaFindings);
  if (sma) folder.push(sma);
  const variants = groupVariants(assets);
  const vf = variantsFinding(variants);
  if (vf) folder.push(vf);
  const mip = mipmapCostFinding(metrics, cfg);
  if (mip) folder.push(mip);
  findings.push(...folder);

  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id));

  return {
    assets: metrics,
    findings,
    totals: {
      diskBytes: metrics.reduce((s, m) => s + m.diskBytes, 0),
      vramBytes: metrics.reduce((s, m) => s + m.vramBytes, 0),
      vramBytesMipmapped: metrics.reduce((s, m) => s + m.vramBytesMipmapped, 0),
      loadedVramBytes: variants.loadedVramMax,
      loadedVramBytesMipmapped: Math.ceil(variants.loadedVramMax * MIP_OVERHEAD),
      // STRUCTURAL draw-call FLOOR — distinct loaded GPU textures over the SAME loaded set as
      // loadedVramBytes (groupVariants: one variant per logical asset), summing each loaded variant's
      // texture-page count (loose=1, atlas=1 page in the one-Atlas-per-page model). A LOWER BOUND on draw
      // calls; NOT the measured probe.drawCalls and NOT VRAM bytes (invariants 3 & 5).
      loadedTextures: variants.loadedTextures,
      potentialDiskSaved,
    },
    thresholds: cfg,
    // Additive: omit entirely when no atlas had frames (loose-only folder) so the report is
    // byte-identical to today. The host probe reads this; absent ⇒ nothing to probe.
    ...(Object.keys(atlasFrames).length > 0 ? { atlasFrames } : {}),
    // Pure pass-through of the host's already-sorted unparsed surface. Omit when empty ⇒ byte-identical.
    ...(deps.unparsed?.length ? { unparsed: deps.unparsed } : {}),
  };
}
