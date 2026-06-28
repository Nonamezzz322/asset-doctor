// Orchestrator: normalized assets + thresholds → AnalysisReport. Produces per-asset findings
// AND whole-folder findings (scope: 'folder'). The two impure dependencies — WebP/AVIF encoding
// (canvas) and per-image features (hash/dHash) — are injected via deps so the core stays
// headless-testable.

import type {
  AnalysisReport,
  Asset,
  AssetMetrics,
  Atlas,
  ContentClass,
  Finding,
  ImageAsset,
  ImageFeatures,
  Rect,
  Severity,
  ThresholdConfig,
} from '@asset-doctor/core';
import { MIP_OVERHEAD } from '@asset-doctor/core';
import { DEFAULT_THRESHOLDS } from './config';
import {
  dimensionFindings,
  formatFinding,
  occupancyFinding,
  occupancyValue,
  solidFillFinding,
  vramBytes,
  vramBytesMipmapped,
  wastedAlphaFinding,
  wastedRegions,
  type EncodeSizer,
  type OpaqueEncodeSizer,
} from './rules';
import {
  atlasMergeFinding,
  duplicateExactFindings,
  duplicateSimilarFindings,
  formatAggregateFinding,
  integrityFindings,
  mipmapCostFinding,
  shouldAtlasFinding,
} from './folder';
import { groupVariants, variantsFinding } from './variants';

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
  /** Manifests whose referenced image is missing from the folder. */
  missingImages?: { manifest: string; image: string }[];
  /** Would-be assets the host could NOT parse (ingest skip-points + worker parse failures) — surfaced
   *  honestly instead of silently dropped. Pure pass-through: the host has already sorted by ref; this
   *  layer never re-sorts or filters. Absent/empty ⇒ byte-identical to today. */
  unparsed?: { ref: string; reason: string }[];
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

  // Per-loose-ref disk saving already counted by the FORMAT finding (transcode to AVIF/WebP). The
  // wasted-alpha finding for the SAME ref overlaps it (re-encoding the format ALSO drops the dead alpha
  // plane — most of the alpha saving is already inside the transcode estimate), so summing both would
  // OVERSTATE the aggregate. We de-overlap below by contributing the MAX of the two per-ref savings, not
  // their sum. Keyed by ref; cleared implicitly per-folder (one report = one map).
  const formatSavedByRef = new Map<string, number>();

  const addFormat = async (ref: string, image: ImageAsset, contentClass: ContentClass = 'unknown') => {
    const fmt = await formatFinding(ref, image, cfg, deps.encodeImage, contentClass);
    if (fmt) {
      findings.push(fmt);
      formatFindings.push(fmt);
      const saved = fmt.estimate?.diskBytesSaved ?? 0;
      formatSavedByRef.set(ref, saved);
      potentialDiskSaved += saved;
    }
  };

  for (const asset of assets) {
    if (asset.kind === 'atlas') {
      const { atlas, image } = asset;
      atlases.push(atlas);
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
          // De-overlap: the format finding (if any) for this ref already counted a transcode disk
          // saving that SUBSUMES most of the dead-alpha drop (re-encoding the format also drops the
          // alpha plane). Contribute only the EXCESS of the larger estimate so the aggregate never
          // double-counts the same ref's overlapping savings — take MAX, not SUM.
          const alphaSaved = wa.estimate?.diskBytesSaved ?? 0;
          const fmtSaved = formatSavedByRef.get(image.name) ?? 0;
          if (alphaSaved > fmtSaved) potentialDiskSaved += alphaSaved - fmtSaved;
        }
      }
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
  if (deps.missingImages && deps.missingImages.length > 0) {
    folder.push(...integrityFindings(deps.missingImages));
  }
  const fa = formatAggregateFinding(formatFindings);
  if (fa) folder.push(fa);
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
