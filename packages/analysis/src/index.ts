// @asset-doctor/analysis — the diagnostic core. Normalized model → verdicts (occupancy,
// wasted regions, format audit, dimensions). Thresholds live in config, never hardcoded.

export { DEFAULT_THRESHOLDS } from './config';
export { analyze } from './analyze';
export type { AnalyzeDeps } from './analyze';
export {
  vramBytes,
  occupancyValue,
  occupancyFinding,
  dimensionFindings,
  wastedRegions,
  formatFinding,
} from './rules';
export type { WebpSizer } from './rules';
export { defaultCell, buildCoverage, mergeEmptyRects } from './grid';
export type { Coverage } from './grid';
