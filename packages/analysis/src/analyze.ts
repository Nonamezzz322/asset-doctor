// Orchestrator: normalized assets + thresholds → AnalysisReport. Produces per-asset findings
// AND whole-folder findings (scope: 'folder'). The two impure dependencies — WebP/AVIF encoding
// (canvas) and per-image features (hash/dHash) — are injected via deps so the core stays
// headless-testable.

import type {
  AnalysisReport,
  Asset,
  AssetMetrics,
  Atlas,
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
  vramBytes,
  vramBytesMipmapped,
  wastedRegions,
  type EncodeSizer,
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
  /** Per-image features (content hash + dHash) for folder-level duplicate detection. */
  features?: ImageFeatures[];
  /** Manifests whose referenced image is missing from the folder. */
  missingImages?: { manifest: string; image: string }[];
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

  const addFormat = async (ref: string, image: ImageAsset) => {
    const fmt = await formatFinding(ref, image, cfg, deps.encodeImage);
    if (fmt) {
      findings.push(fmt);
      formatFindings.push(fmt);
      potentialDiskSaved += fmt.estimate?.diskBytesSaved ?? 0;
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
      await addFormat(atlas.name, image);
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
      await addFormat(image.name, image);
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
  };
}
