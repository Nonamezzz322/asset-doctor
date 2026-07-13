// PURE view-model for the V4 runtime A/B compare surface (design: docs/improvements/
// v4-runtime-ab-compare.md). apps/web has NO React harness, so ALL decision logic — which rows render,
// which carry a delta verdict vs raw-values-only, which are hidden outright, and every i18n key — lives
// here, Node-tested; the JSX will be a thin renderer (results-summary/budget-verdicts precedent).
//
// HONESTY (invariant 3): the comparison core (packages/correlate compareRuntimeReports) already refuses
// delta verdicts per class/gate; this layer NEVER re-enables one. Device (timing) rows are not merely
// "incomparable" without the same-device attestation — they are WITHHELD entirely (a cross-device fps
// side-by-side invites exactly the causal misreading the design forbids). Everything else renders both
// raw values even when incomparable — we hide nothing, we only refuse the verdict.

import type { CompareRow, RuntimeComparison } from '@asset-doctor/correlate';

/** One renderable row: the metric's i18n label key, both raw values, and EITHER a delta verdict
 *  (comparable) or a hedge key explaining why only raw values are shown. */
export interface CompareViewRow {
  key: string;
  /** i18n key for the metric label (compare.metric.*). */
  labelKey: string;
  before: number;
  after: number;
  /** Present ONLY when the core judged the row comparable — the delta + optional pct. */
  delta?: { value: number; pct?: number };
  /** Present ONLY when the row is shown WITHOUT a verdict: the class-specific hedge i18n key. */
  hedgeKey?: string;
  /** Bytes-formatted metric (vramBytes) — the JSX picks fmtBytes vs plain number by this. */
  bytes: boolean;
}

export interface CompareView {
  /** Overall verdict banner i18n key (compare.verdict.*). */
  verdictKey: string;
  /** Session facts for the header (frames/duration both sides + measured skew %). */
  frames: { before: number; after: number };
  durationMs: { before: number; after: number };
  durationSkewPct: number;
  rows: CompareViewRow[];
  hitches: { before: number; after: number };
  /** True when timing rows were withheld (no same-device attestation) — the JSX renders one quiet
   *  compare.timingWithheld line instead of the rows. */
  timingWithheld: boolean;
}

/** Metric key → label i18n key. Exhaustive over the core's fixed row set (asserted in tests so a core
 *  row addition cannot silently render unlabeled). */
export const COMPARE_METRIC_LABEL: Record<string, string> = {
  'drawCalls.avg': 'compare.metric.drawAvg',
  'drawCalls.max': 'compare.metric.drawMax',
  'textureBinds.avg': 'compare.metric.bindsAvg',
  liveTextures: 'compare.metric.liveTextures',
  vramBytes: 'compare.metric.vram',
  redundantBinds: 'compare.metric.redundantBinds',
  uploadsDuringGameplay: 'compare.metric.uploads',
  shaderCompilesDuringGameplay: 'compare.metric.compiles',
  'timing.fps': 'compare.metric.fps',
  'timing.frameTimeMsAvg': 'compare.metric.frameAvg',
  'timing.frameTimeMsP95': 'compare.metric.frameP95',
};

/** Class → hedge key shown when a row renders raw-values-only. per-frame rows are ALWAYS hedged with the
 *  scene wording (even when "comparable" — scene equality is the user's attestation, not our measurement);
 *  see rowView. Exported so the i18n drift-guard test can assert every hedge key is catalogued (the JSX
 *  reads these via `t(r.hedgeKey)` — a bare variable the static app-keys scanner cannot see). */
export const CLASS_HEDGE: Record<CompareRow['metricClass'], string> = {
  'per-frame': 'compare.hedge.scene',
  state: 'compare.hedge.gate',
  'session-total': 'compare.hedge.duration',
  device: 'compare.hedge.device',
};

function rowView(r: CompareRow): CompareViewRow {
  const base: CompareViewRow = {
    key: r.key,
    labelKey: COMPARE_METRIC_LABEL[r.key] ?? r.key,
    before: r.before,
    after: r.after,
    bytes: r.key === 'vramBytes',
  };
  if (r.comparable) {
    return { ...base, delta: { value: r.delta, ...(r.pct !== undefined ? { pct: r.pct } : {}) } };
  }
  return { ...base, hedgeKey: CLASS_HEDGE[r.metricClass] };
}

/** Build the renderable view. `sameDevice` mirrors what the caller passed to compareRuntimeReports as
 *  the attestation — WITHOUT it the device rows are withheld entirely (not just hedged). */
export function compareView(c: RuntimeComparison, attest: { sameDevice?: boolean } = {}): CompareView {
  const deviceWithheld = attest.sameDevice !== true;
  const rows = c.rows.filter((r) => !(deviceWithheld && r.metricClass === 'device')).map(rowView);
  return {
    verdictKey: `compare.verdict.${c.verdict}`,
    frames: c.frames,
    durationMs: c.durationMs,
    durationSkewPct: c.durationSkewPct,
    rows,
    hitches: c.hitches,
    timingWithheld: deviceWithheld,
  };
}
