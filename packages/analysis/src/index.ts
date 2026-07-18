// @asset-doctor/analysis — the diagnostic core. Normalized model → verdicts (per-asset:
// occupancy, wasted regions, format, dimensions; whole-folder: duplicates, should-atlas,
// atlas-merge, integrity, format aggregate). Thresholds live in config, never hardcoded.

export { DEFAULT_THRESHOLDS } from './config';
export { analyze } from './analyze';
export type { AnalyzeDeps } from './analyze';
export { mergeSharedAtlases } from './merge';
export { groupVariants, variantsFinding, stemOf, hasResolutionToken, formatSiblingGroups, redundantFormatRefs } from './variants';
export type { VariantGroups, FormatSiblingGroup } from './variants';
export {
  vramBytes,
  occupancyValue,
  occupancyFinding,
  dimensionFindings,
  solidFillFinding,
  upscaledSourceFinding,
  frameRedundancyFinding,
  trimMarginFinding,
  bleedingFinding,
  gutterFinding,
  spineUnreferencedRegionsFindings,
  dimensionMismatchFinding,
  wastedAlphaFinding,
  strippableMetadataFinding,
  iccNonSrgbFinding,
  interiorTransparencyFinding,
  binaryAlphaFinding,
  wastedRegions,
  formatFinding,
  fmtBytes,
  repackOpportunityFinding,
} from './rules';
export type { EncodeSizer, OpaqueEncodeSizer, RepackSim } from './rules';
export {
  duplicateExactFindings,
  duplicateSimilarFindings,
  shouldAtlasFinding,
  atlasMergeFinding,
  crossAtlasRedundancyFinding,
  integrityFindings,
  formatAggregateFinding,
  strippableMetadataAggregateFinding,
  gpuCompressionAlignmentFinding,
  premultipliedAlphaFinding,
  looseInAtlasFindings,
} from './folder';
export { fontGlyphPageFinding } from './font';
export { defaultCell, buildCoverage, mergeEmptyRects, summarizeEmpty } from './grid';
export type { Coverage, EmptySpace } from './grid';
export {
  buildDedupGroups,
  cmp,
  bundleOf,
  baseNoExt,
  skinGroupOf,
  dominates,
  LAZY_MAY_CONSUME_EAGER,
} from './dedup';
