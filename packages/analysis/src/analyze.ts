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
  Severity,
  ThresholdConfig,
} from '@asset-doctor/core';
import { DEFAULT_THRESHOLDS } from './config';
import {
  dimensionFindings,
  formatFinding,
  occupancyFinding,
  occupancyValue,
  vramBytes,
  wastedRegions,
  type EncodeSizer,
} from './rules';
import {
  atlasMergeFinding,
  duplicateExactFindings,
  duplicateSimilarFindings,
  formatAggregateFinding,
  integrityFindings,
  shouldAtlasFinding,
} from './folder';

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
      metrics.push({
        assetRef: atlas.name,
        diskBytes: image.byteSize,
        vramBytes: vramBytes(atlas.size),
        occupancy: occupancyValue(atlas),
      });
      const occ = occupancyFinding(atlas, cfg);
      if (occ) findings.push(occ);
      const waste = wastedRegions(atlas, cfg);
      if (waste) findings.push(waste);
      findings.push(...dimensionFindings(atlas.name, atlas.size, cfg));
      await addFormat(atlas.name, image);
    } else {
      const { image } = asset;
      metrics.push({
        assetRef: image.name,
        diskBytes: image.byteSize,
        vramBytes: vramBytes(image.size),
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
  findings.push(...folder);

  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id));

  return {
    assets: metrics,
    findings,
    totals: {
      diskBytes: metrics.reduce((s, m) => s + m.diskBytes, 0),
      vramBytes: metrics.reduce((s, m) => s + m.vramBytes, 0),
      potentialDiskSaved,
    },
    thresholds: cfg,
  };
}
