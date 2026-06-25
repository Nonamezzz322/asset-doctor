import type { ThresholdConfig } from '@asset-doctor/core';

/** Default audit thresholds. Provisional — calibrate on fixtures, then on real assets.
 *  Kept here as the single source so rule logic never hardcodes magic numbers. */
export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  occupancy: { warn: 0.85, crit: 0.6 }, // fraction of atlas area covered by frames
  oversizePx: { warn: 2048, crit: 4096 }, // longest texture edge, px
  formatSaving: { warn: 0.25 }, // fraction of disk bytes a better format could save
};
