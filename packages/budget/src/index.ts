// @asset-doctor/budget — the pure budget-gate contract. Maps the AnalysisReport to dotted metric
// keys, validates a JSON budget config (fail-closed on unknown/browser-only metrics), evaluates the
// gate (with optional baseline deltas), and serializes every surface (JSON / SARIF / job-summary /
// annotations / human tables). No IO — the CLI and the GitHub Action drive it.

export * from './types';
export { ConfigError } from './errors';
export { parseBudgetConfig, resolveThresholds } from './config';
export { evaluateGate, formatValue } from './evaluate';
export type { EvaluateOptions } from './evaluate';
export { CLI_CAPABILITIES, GLOBAL_METRICS, ASSET_METRICS } from './metrics';
export type { MetricDef, AssetMetricDef } from './metrics';
export { parseBytes } from './normalize';
export { globToRegExp } from './glob';
export {
  toJSON,
  toSARIF,
  toAnnotations,
  toSummaryMarkdown,
  renderReport,
  renderGate,
  sortedAssets,
  CAPABILITY_NOTE,
} from './serialize';
export {
  DIFF_METRIC_KEYS,
  findingKey,
  diffAudits,
  hasRegression,
  diffToJSON,
  renderDiff,
  diffToSummaryMarkdown,
} from './diff';
export type {
  AuditSnapshot,
  MetricDelta,
  FindingChange,
  SeverityChange,
  DiffCounts,
  AuditDiff,
} from './diff';
