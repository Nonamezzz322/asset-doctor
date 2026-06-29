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
  ImageAsset,
  ImageFeatures,
  Rect,
  Severity,
  ThresholdConfig,
  TrimRect,
} from '@asset-doctor/core';
import { MIP_OVERHEAD } from '@asset-doctor/core';
import { DEFAULT_THRESHOLDS } from './config';
import {
  dimensionFindings,
  formatFinding,
  frameRedundancyFinding,
  occupancyFinding,
  occupancyValue,
  solidFillFinding,
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
  shouldAtlasFinding,
  strippableMetadataAggregateFinding,
} from './folder';
import { groupVariants, variantsFinding } from './variants';
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

  // Fully-opaque marking from the host's FULL-FRAME alpha scan (a fully-opaque image still carrying an
  // alpha channel wastes DISK bytes). Loose images only (atlases never trip it). Absent ⇒ empty ⇒ no
  // wasted-alpha finding ⇒ byte-identical to today (CLI / headless tests unaffected).
  const opaqueByRef = new Set<string>();
  for (const f of deps.features ?? []) if (f.opaque) opaqueByRef.add(f.assetRef);

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
      await addFormat(atlas.name, image, 'unknown'); // M1: atlases keep today's lossy verdict
      // Strippable ancillary metadata on the atlas PAGE image (the manifest JSON is never scanned). De-overlapped
      // with the page's format saving via bumpBest (one re-encode transcodes AND strips the metadata).
      addStrippable(atlas.name, image);
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
      // THIS atlas (absent ⇒ no finding ⇒ byte-identical). Like frame-redundancy, the recoverable disk number
      // is an area-proportional ESTIMATE, so it is DELIBERATELY NOT folded into potentialDiskSaved (invariant 5).
      const ft = frameTrimByRef.get(atlas.name);
      if (ft) {
        const tm = trimMarginFinding(atlas, cfg, ft, image.byteSize);
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
    }
  }

  // ── whole-folder findings ──────────────────────────────────────────────
  const folder: Finding[] = [];
  if (deps.features && deps.features.length > 0) {
    const exact = duplicateExactFindings(assets, deps.features);
    folder.push(...exact);
    potentialDiskSaved += exact.reduce((s, f) => s + (f.estimate?.diskBytesSaved ?? 0), 0);
    folder.push(...duplicateSimilarFindings(deps.features, cfg));
  }
  const sa = shouldAtlasFinding(assets, cfg);
  if (sa) folder.push(sa);
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
