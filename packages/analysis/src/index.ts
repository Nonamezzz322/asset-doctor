// @asset-doctor/analysis — the diagnostic core. Normalized model → verdicts (per-asset:
// occupancy, wasted regions, format, dimensions; whole-folder: duplicates, should-atlas,
// atlas-merge, integrity, format aggregate). Thresholds live in config, never hardcoded.

export { DEFAULT_THRESHOLDS } from './config';
export { analyze } from './analyze';
export type { AnalyzeDeps } from './analyze';
export { mergeSharedAtlases } from './merge';
export { groupVariants, variantsFinding, stemOf } from './variants';
export type { VariantGroups } from './variants';
export {
  vramBytes,
  occupancyValue,
  occupancyFinding,
  dimensionFindings,
  wastedRegions,
  formatFinding,
  fmtBytes,
} from './rules';
export type { EncodeSizer } from './rules';
export {
  duplicateExactFindings,
  duplicateSimilarFindings,
  shouldAtlasFinding,
  atlasMergeFinding,
  integrityFindings,
  formatAggregateFinding,
} from './folder';
export { defaultCell, buildCoverage, mergeEmptyRects } from './grid';
export type { Coverage } from './grid';
