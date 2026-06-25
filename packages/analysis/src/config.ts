import type { ThresholdConfig } from '@asset-doctor/core';

/** Default audit thresholds. Provisional — calibrate on fixtures, then on real assets.
 *  Kept here as the single source so rule logic never hardcodes magic numbers. */
export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  occupancy: { warn: 0.85, crit: 0.6 }, // fraction of atlas area covered by frames
  oversizePx: { warn: 2048, crit: 4096 }, // longest texture edge, px
  formatSaving: { warn: 0.25 }, // fraction of disk bytes a better format could save
  duplicates: { similarHammingMax: 6 }, // dHash bits that may differ for "near-identical"
  shouldAtlas: { minLooseImages: 8, maxSpriteEdgePx: 512 }, // loose sprites worth packing
  atlasMerge: { occupancyBelow: 0.5, minAtlases: 2 }, // under-filled atlases worth merging
};
