// Orchestrator: normalized assets + thresholds → AnalysisReport. The one impure dependency
// (WebP encoding, which needs a canvas) is injected via deps so the core stays headless-testable.

import type {
  AnalysisReport,
  Asset,
  AssetMetrics,
  Finding,
  ImageAsset,
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
  type WebpSizer,
} from './rules';

export interface AnalyzeDeps {
  /** Encode an asset's image to WebP and return its byte size (or null). Browser/worker
   *  supplies this via canvas.toBlob('image/webp'); headless tests mock it. */
  encodeWebp?: WebpSizer;
}

const RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2, ok: 3 };

export async function analyze(
  assets: Asset[],
  cfg: ThresholdConfig = DEFAULT_THRESHOLDS,
  deps: AnalyzeDeps = {},
): Promise<AnalysisReport> {
  const findings: Finding[] = [];
  const metrics: AssetMetrics[] = [];
  let potentialDiskSaved = 0;

  const addFormat = async (ref: string, image: ImageAsset) => {
    const fmt = await formatFinding(ref, image, cfg, deps.encodeWebp);
    if (fmt) {
      findings.push(fmt);
      potentialDiskSaved += fmt.estimate?.diskBytesSaved ?? 0;
    }
  };

  for (const asset of assets) {
    if (asset.kind === 'atlas') {
      const { atlas, image } = asset;
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
