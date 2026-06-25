// @asset-doctor/analysis — the diagnostic core. Turns the normalized model into verdicts
// (occupancy, wasted regions, format audit, dimensions). Thresholds live here in config,
// never hardcoded inside rule logic. Rules land in Milestone 1 (see analysis-engineer).

import type { ThresholdConfig } from '@asset-doctor/core';

/** Default audit thresholds. Provisional — calibrate on fixtures (see the make-fixture skill). */
export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  occupancy: { warn: 0.85, crit: 0.6 }, // fraction of atlas area covered by frames
  oversizePx: { warn: 2048, crit: 4096 }, // longest texture edge, px
  formatSaving: { warn: 0.25 }, // fraction of disk bytes a better format could save
};
