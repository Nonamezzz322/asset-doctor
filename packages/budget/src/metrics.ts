// The metric registry: the single place that maps a dotted budget key to a number off the
// AnalysisReport (or off a single AssetMetrics for per-asset budgets) plus its unit, direction, and
// whether THIS build can measure it. Adding a metric is additive here; the core is never touched.

import type { AnalysisReport, AssetMetrics, Rule } from '@asset-doctor/core';
import type { Capabilities, MetricUnit } from './types';

/** What the Node CLI can measure. VRAM (w×h×4) + exact dupes (SHA-256) are pure; transcode savings,
 *  near-dupes, and live draw calls need a canvas/WebGL and are off → budgeting them fails closed. */
export const CLI_CAPABILITIES: Capabilities = {
  vram: true,
  exactDuplicates: true,
  formatAudit: false,
  similarDuplicates: false,
  renderProbe: false,
};

export interface MetricDef {
  key: string;
  unit: MetricUnit;
  /** The direction a budget naturally caps (max for sizes/counts, min for occupancy). */
  direction: 'max' | 'min';
  /** True if this build measures the metric; false → fail-closed when budgeted. */
  available: (cap: Capabilities) => boolean;
  get: (r: AnalysisReport) => number;
  label: string;
}

const ALL_RULES: Rule[] = [
  'occupancy', 'wasted-regions', 'format', 'dimensions-npot', 'dimensions-oversize',
  'duplicate-exact', 'duplicate-similar', 'should-atlas', 'atlas-merge', 'integrity-missing-image', 'variants',
];
/** Rules that only fire with a browser-supplied input (encodeImage / dHash) — unmeasured in the CLI. */
const BROWSER_RULE_CAP: Partial<Record<Rule, keyof Capabilities>> = {
  format: 'formatAudit',
  'duplicate-similar': 'similarDuplicates',
};

const count = (r: AnalysisReport, pred: (rule: Rule, sev: string) => boolean): number =>
  r.findings.filter((f) => pred(f.rule, f.severity)).length;

export const GLOBAL_METRICS = new Map<string, MetricDef>();
const reg = (d: MetricDef): void => {
  GLOBAL_METRICS.set(d.key, d);
};

reg({ key: 'totals.diskBytes', unit: 'bytes', direction: 'max', available: () => true, get: (r) => r.totals.diskBytes, label: 'disk size' });
reg({ key: 'totals.vramBytes', unit: 'bytes', direction: 'max', available: () => true, get: (r) => r.totals.vramBytes, label: 'VRAM (summed)' });
reg({ key: 'totals.loadedVramBytes', unit: 'bytes', direction: 'max', available: () => true, get: (r) => r.totals.loadedVramBytes, label: 'VRAM (loaded)' });
reg({ key: 'totals.potentialDiskSaved', unit: 'bytes', direction: 'max', available: () => true, get: (r) => r.totals.potentialDiskSaved, label: 'potential disk saved' });

reg({ key: 'findings.crit', unit: 'count', direction: 'max', available: () => true, get: (r) => count(r, (_, s) => s === 'crit'), label: 'crit findings' });
reg({ key: 'findings.warn', unit: 'count', direction: 'max', available: () => true, get: (r) => count(r, (_, s) => s === 'warn'), label: 'warn findings' });
reg({ key: 'findings.info', unit: 'count', direction: 'max', available: () => true, get: (r) => count(r, (_, s) => s === 'info'), label: 'info findings' });
reg({ key: 'findings.total', unit: 'count', direction: 'max', available: () => true, get: (r) => r.findings.length, label: 'total findings' });

// Static lower bound on draw calls: each distinct texture (atlas page or loose image) needs ≥1 draw.
// A well-batched renderer does no FEWER than this; without atlasing the real count is higher.
reg({ key: 'drawCallsLowerBound', unit: 'count', direction: 'max', available: () => true, get: (r) => r.assets.length, label: 'draw calls (static lower bound)' });

for (const rule of ALL_RULES) {
  const capKey = BROWSER_RULE_CAP[rule];
  reg({
    key: `findings.${rule}`,
    unit: 'count',
    direction: 'max',
    available: (cap) => (capKey ? cap[capKey] : true),
    get: (r) => count(r, (ru) => ru === rule),
    label: `${rule} findings`,
  });
}

export interface AssetMetricDef {
  key: string;
  unit: MetricUnit;
  direction: 'max' | 'min';
  /** Returns the metric for one asset, or undefined when it does not apply (e.g. occupancy on a loose image). */
  get: (m: AssetMetrics, size?: { w: number; h: number }) => number | undefined;
  label: string;
}

export const ASSET_METRICS = new Map<string, AssetMetricDef>([
  ['vramBytes', { key: 'vramBytes', unit: 'bytes', direction: 'max', get: (m) => m.vramBytes, label: 'VRAM' }],
  ['diskBytes', { key: 'diskBytes', unit: 'bytes', direction: 'max', get: (m) => m.diskBytes, label: 'disk' }],
  ['occupancy', { key: 'occupancy', unit: 'ratio', direction: 'min', get: (m) => m.occupancy, label: 'occupancy' }],
  ['oversizePx', { key: 'oversizePx', unit: 'px', direction: 'max', get: (_m, size) => (size ? Math.max(size.w, size.h) : undefined), label: 'longest edge' }],
]);
