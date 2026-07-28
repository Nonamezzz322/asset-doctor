// Pure audit-diff core: compares TWO audit snapshots (a live AnalysisReport OR a parsed audit JSON —
// both satisfy AuditSnapshot) and emits an HONEST delta. Two independent readouts:
//   1. per-metric before→after deltas — MEASURED (GLOBAL_METRICS.get(after) − get(before)), never a
//      threshold. Disk and every VRAM metric are SEPARATE rows with their own unit; the serializers
//      NEVER sum disk+VRAM into one footprint number (invariant 5).
//   2. findings ADDED / RESOLVED / CHANGED, matched by the stable Finding.id — the same id analysis
//      builds deterministically from rule + assetRef + params. A finding whose severity changed is
//      reported CHANGED, never double-counted as added+resolved.
// No IO, no network, no thresholds: this module only measures and partitions. Gating (opt-in
// --fail-on-new) is a pure predicate over the result; the CLI bin decides the exit code.

import type { AnalysisReport, Finding, Rule, Severity } from '@asset-doctor/core';
import { fmtBytes } from '@asset-doctor/analysis';
import { biggestWins, hasWins, type WinRow } from './biggest-wins';
import { formatValue } from './evaluate';
import { GLOBAL_METRICS } from './metrics';
import type { MetricUnit } from './types';

/** The audit surface diff needs — satisfied BOTH by a live analyze() report AND by a parsed audit
 *  JSON (toJSON emits totals/assets/findings verbatim). The DIFF_METRIC_KEYS getters read only these
 *  three fields, so a parsed JSON works without reconstructing the full report. */
export type AuditSnapshot = Pick<AnalysisReport, 'totals' | 'assets' | 'findings'>;

export interface MetricDelta {
  key: string;
  label: string;
  unit: MetricUnit;
  /** MEASURED value of the metric on the BEFORE snapshot. */
  before: number;
  /** MEASURED value on the AFTER snapshot. */
  after: number;
  /** after − before. Positive = the metric grew. Never fabricated. */
  delta: number;
  /** Percent change vs before, rounded to 1 dp. OMITTED when before === 0 (no ∞, no divide-by-zero). */
  pct?: number;
  direction: 'up' | 'down' | 'flat';
}

/** A finding that appeared only in AFTER (added) or only in BEFORE (resolved). */
export interface FindingChange {
  /** Finding.id — the match key. */
  key: string;
  rule: Rule;
  assetRef: string;
  severity: Severity;
  title: string;
}

/** A finding present on BOTH sides whose severity changed. Reported CHANGED, never added+resolved. */
export interface SeverityChange {
  /** Finding.id — same id on both sides. */
  key: string;
  rule: Rule;
  assetRef: string;
  from: Severity;
  to: Severity;
  /** True when `to` is more severe than `from` (drives the --fail-on-new regression check). */
  worsened: boolean;
  title: string;
}

export interface DiffCounts {
  added: number;
  resolved: number;
  changed: number;
  addedCrit: number;
  addedWarn: number;
  addedInfo: number;
  /** Findings whose severity changed UP to crit (from a lower severity). */
  worsenedToCrit: number;
  /** Findings whose severity changed UP to crit OR warn. */
  worsenedToWarnOrCrit: number;
}

export interface AuditDiff {
  metrics: MetricDelta[];
  added: FindingChange[];
  resolved: FindingChange[];
  changed: SeverityChange[];
  counts: DiffCounts;
}

/** The curated metric subset diff reports, in a FIXED display order. Each key already exists in
 *  GLOBAL_METRICS with a unit + label + getter reading r.totals.* / r.findings / r.assets.length, so a
 *  parsed audit JSON evaluates verbatim. Disk and each VRAM metric are DISTINCT keys (invariant 5). */
export const DIFF_METRIC_KEYS: readonly string[] = [
  'totals.diskBytes',
  'totals.vramBytes',
  'totals.loadedVramBytes',
  'totals.potentialDiskSaved',
  'drawCallsLowerBound',
  'findings.crit',
  'findings.warn',
  'findings.info',
  'findings.total',
];

/** The match key for a finding across two audits: its stable id. Documented so callers don't guess. */
export function findingKey(f: Finding): string {
  return f.id;
}

const SEV_RANK: Record<Severity, number> = { ok: 0, info: 1, warn: 2, crit: 3 };
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The getters only read totals/findings/assets, all present on AuditSnapshot. The cast narrows the
 *  registry's AnalysisReport param to the fields it actually touches — no fabricated data. */
const metricValue = (snap: AuditSnapshot, key: string): number =>
  GLOBAL_METRICS.get(key)!.get(snap as AnalysisReport);

function metricDelta(key: string, before: AuditSnapshot, after: AuditSnapshot): MetricDelta {
  const def = GLOBAL_METRICS.get(key)!;
  const b = metricValue(before, key);
  const a = metricValue(after, key);
  const delta = a - b;
  const direction: MetricDelta['direction'] = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  // pct only when the base is non-zero: 0 → n is honestly a NEW value, not "+∞%".
  return {
    key,
    label: def.label,
    unit: def.unit,
    before: b,
    after: a,
    delta,
    ...(b !== 0 ? { pct: round1((delta / b) * 100) } : {}),
    direction,
  };
}

const changeOf = (f: Finding): FindingChange => ({
  key: f.id,
  rule: f.rule,
  assetRef: f.assetRef,
  severity: f.severity,
  title: f.title,
});

/** Deterministic order for finding lists: most-severe first, then by id. */
const bySeverityThenId = (a: { severity: Severity; key: string }, b: { severity: Severity; key: string }): number =>
  SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.key.localeCompare(b.key);

/** Deterministic order for severity changes: worsened first, then by target severity, then by id. */
const changedOrder = (a: SeverityChange, b: SeverityChange): number =>
  Number(b.worsened) - Number(a.worsened) || SEV_RANK[b.to] - SEV_RANK[a.to] || a.key.localeCompare(b.key);

/** Diff two audit snapshots. Deltas are MEASURED (after − before); findings partitioned by stable id
 *  into added (after-only), resolved (before-only), changed (both, severity differs). A finding can
 *  appear in AT MOST one partition — same-id-same-severity findings appear in none. */
export function diffAudits(before: AuditSnapshot, after: AuditSnapshot): AuditDiff {
  const beforeById = new Map<string, Finding>();
  for (const f of before.findings) beforeById.set(f.id, f);
  const afterById = new Map<string, Finding>();
  for (const f of after.findings) afterById.set(f.id, f);

  const added: FindingChange[] = [];
  const resolved: FindingChange[] = [];
  const changed: SeverityChange[] = [];

  for (const f of after.findings) {
    if (!beforeById.has(f.id)) added.push(changeOf(f));
  }
  for (const f of before.findings) {
    const now = afterById.get(f.id);
    if (!now) {
      resolved.push(changeOf(f));
    } else if (now.severity !== f.severity) {
      changed.push({
        key: f.id,
        rule: now.rule,
        assetRef: now.assetRef,
        from: f.severity,
        to: now.severity,
        worsened: SEV_RANK[now.severity] > SEV_RANK[f.severity],
        title: now.title,
      });
    }
  }

  added.sort(bySeverityThenId);
  resolved.sort(bySeverityThenId);
  changed.sort(changedOrder);

  const counts: DiffCounts = {
    added: added.length,
    resolved: resolved.length,
    changed: changed.length,
    addedCrit: added.filter((c) => c.severity === 'crit').length,
    addedWarn: added.filter((c) => c.severity === 'warn').length,
    addedInfo: added.filter((c) => c.severity === 'info').length,
    worsenedToCrit: changed.filter((c) => c.worsened && c.to === 'crit').length,
    worsenedToWarnOrCrit: changed.filter((c) => c.worsened && (c.to === 'crit' || c.to === 'warn')).length,
  };

  return {
    metrics: DIFF_METRIC_KEYS.map((k) => metricDelta(k, before, after)),
    added,
    resolved,
    changed,
    counts,
  };
}

/** Findings-only, threshold-free regression predicate for opt-in gating. An IMPROVEMENT (resolved
 *  finding, lowered severity) NEVER counts. Metric-heaviness is NOT gated here — that stays
 *  `budget --baseline maxDeltaPct`'s job, so diff never duplicates budgeting. */
export function hasRegression(diff: AuditDiff, level: 'crit' | 'warn' | 'any'): boolean {
  const c = diff.counts;
  switch (level) {
    case 'crit':
      return c.addedCrit > 0 || c.worsenedToCrit > 0;
    case 'warn':
      return c.addedCrit + c.addedWarn > 0 || c.worsenedToWarnOrCrit > 0;
    case 'any':
      return c.added > 0 || diff.changed.some((ch) => ch.worsened);
  }
}

/* ── machine output ──────────────────────────────────────────────────── */

/** Deterministic JSON: metrics in DIFF_METRIC_KEYS order, findings pre-sorted. No summed disk+VRAM. */
export function diffToJSON(diff: AuditDiff): unknown {
  return {
    version: 1,
    metrics: diff.metrics.map((m) => ({
      key: m.key,
      label: m.label,
      unit: m.unit,
      before: m.before,
      after: m.after,
      delta: m.delta,
      ...(m.pct !== undefined ? { pct: m.pct } : {}),
      direction: m.direction,
    })),
    findings: {
      added: diff.added,
      resolved: diff.resolved,
      changed: diff.changed,
    },
    counts: diff.counts,
  };
}

/* ── human / markdown output (reuse formatValue; disk & VRAM stay separate rows) ─────────────────── */

const CODES = { reset: 0, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 } as const;
type Colour = keyof Omit<typeof CODES, 'reset'>;
const paint = (color: boolean) => (c: Colour, s: string): string => (color ? `\x1b[${CODES[c]}m${s}\x1b[0m` : s);
const SEV_COLOUR: Record<Severity, Colour> = { crit: 'red', warn: 'yellow', ok: 'green', info: 'cyan' };
const escMd = (s: string | number): string => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Signed, unit-aware rendering of a delta (e.g. "+1.2 MB", "-3", "±0"). Uses formatValue on the
 *  absolute magnitude so byte deltas read in KB/MB, never as a raw negative byte count. */
function signedDelta(unit: MetricUnit, delta: number): string {
  if (delta === 0) return `±${formatValue(unit, 0)}`;
  return (delta > 0 ? '+' : '-') + formatValue(unit, Math.abs(delta));
}
const pctText = (m: MetricDelta): string => (m.pct === undefined ? '' : ` (${m.pct >= 0 ? '+' : ''}${m.pct}%)`);
const ARROW: Record<MetricDelta['direction'], string> = { up: '▲', down: '▼', flat: '=' };

/** Human terminal readout: before→after per metric (disk & every VRAM metric on their OWN line, never
 *  combined), then added / resolved / changed finding sections. */
export function renderDiff(diff: AuditDiff, opts: { color?: boolean } = {}): string {
  const c = paint(opts.color ?? false);
  const out: string[] = [];
  out.push(c('cyan', '▣ Asset Doctor — diff') + c('gray', '  (after − before, measured)'));
  out.push('');
  out.push(c('gray', '  metrics (before → after):'));
  const wLabel = Math.max(...diff.metrics.map((m) => m.label.length));
  for (const m of diff.metrics) {
    const arrowColour: Colour = m.direction === 'flat' ? 'gray' : m.direction === 'up' ? 'yellow' : 'green';
    const change =
      m.direction === 'flat'
        ? c('gray', 'no change')
        : `${signedDelta(m.unit, m.delta)}${pctText(m)}`;
    out.push(
      `    ${c(arrowColour, ARROW[m.direction])} ${m.label.padEnd(wLabel)}  ` +
        `${formatValue(m.unit, m.before)} → ${formatValue(m.unit, m.after)}  ${change}`,
    );
  }
  out.push('');
  out.push(
    `  findings: ${c('red', `+${diff.counts.added} added`)} · ` +
      `${c('green', `-${diff.counts.resolved} resolved`)} · ` +
      `${c('yellow', `~${diff.counts.changed} changed`)}`,
  );
  for (const f of diff.added) out.push(`    ${c('red', '+')} ${c(SEV_COLOUR[f.severity], `[${f.severity}]`.padEnd(6))} ${f.title}  ${c('gray', f.assetRef)}`);
  for (const f of diff.resolved) out.push(`    ${c('green', '-')} ${c(SEV_COLOUR[f.severity], `[${f.severity}]`.padEnd(6))} ${f.title}  ${c('gray', f.assetRef)}`);
  for (const ch of diff.changed) {
    const tag = c(ch.worsened ? 'red' : 'green', `[${ch.from}→${ch.to}]`);
    out.push(`    ${c('yellow', '~')} ${tag} ${ch.title}  ${c('gray', ch.assetRef)}`);
  }
  return out.join('\n');
}

/** PR-comment / job-summary markdown. Separate metric rows (disk & VRAM never combined). */
export function diffToSummaryMarkdown(diff: AuditDiff, opts: { title?: string; after?: AuditSnapshot } = {}): string {
  const lines: string[] = [];
  const cc = diff.counts;
  lines.push(`### Asset Doctor — diff`);
  if (opts.title) lines.push(`\`${escMd(opts.title)}\``);
  lines.push(
    `**+${cc.added} added · -${cc.resolved} resolved · ~${cc.changed} changed** ` +
      `(added: ${cc.addedCrit} crit · ${cc.addedWarn} warn · ${cc.addedInfo} info)`,
  );
  lines.push('');
  lines.push(`| | Metric | Before | After | Δ | %|`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const m of diff.metrics) {
    const icon = m.direction === 'flat' ? '·' : m.direction === 'up' ? '▲' : '▼';
    const pct = m.pct === undefined ? '—' : `${m.pct >= 0 ? '+' : ''}${m.pct}%`;
    lines.push(
      `| ${icon} | \`${escMd(m.key)}\` | ${escMd(formatValue(m.unit, m.before))} | ${escMd(formatValue(m.unit, m.after))} | ${escMd(signedDelta(m.unit, m.delta))} | ${escMd(pct)} |`,
    );
  }
  lines.push('');
  if (diff.added.length + diff.resolved.length + diff.changed.length === 0) {
    lines.push('_No findings changed._');
  } else {
    for (const f of diff.added) lines.push(`- ➕ **added** \`${escMd(f.severity)}\` ${escMd(f.title)} — \`${escMd(f.assetRef)}\``);
    for (const f of diff.resolved) lines.push(`- ✅ **resolved** \`${escMd(f.severity)}\` ${escMd(f.title)} — \`${escMd(f.assetRef)}\``);
    for (const ch of diff.changed) lines.push(`- ${ch.worsened ? '⚠️' : '🔽'} **changed** \`${escMd(ch.from)}\`→\`${escMd(ch.to)}\` ${escMd(ch.title)} — \`${escMd(ch.assetRef)}\``);
  }
  // Impact-first footer — the AFTER state's biggest remaining opportunities (the SAME ranking every other
  // surface uses, biggest-wins.ts). TWO separate single-unit lists (disk / VRAM), NEVER summed (invariant 5);
  // a finding appears only when its measured saving on that axis is > 0; no total. This turns the PR comment
  // from a pure regression check into a "start here next" guide. Omitted when `after` is absent or carries no
  // estimate-bearing finding ⇒ byte-identical to the prior summary.
  if (opts.after) {
    const w = biggestWins(opts.after);
    if (hasWins(w)) {
      const mdList = (rows: WinRow[]): string[] =>
        rows.map((row) => `- ${fmtBytes(row.bytes)} — \`${escMd(row.assetRef)}\`${row.relatedCount > 0 ? ` (${row.relatedCount} files)` : ''}`);
      lines.push('', '#### ◆ Biggest remaining wins — start here');
      if (w.disk.length > 0) lines.push('', '**Reclaim the most disk:**', ...mdList(w.disk));
      if (w.vram.length > 0) lines.push('', '**Reclaim the most VRAM:**', ...mdList(w.vram));
    }
  }
  return lines.join('\n');
}
