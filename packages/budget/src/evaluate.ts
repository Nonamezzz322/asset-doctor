// Evaluate a report against a normalized BudgetConfig → GateResult. Emits one entry per configured
// (metric, level, check) — pass rows included — so the gate table shows the whole budget, not only
// regressions. Only `error`-level breaches drive a non-zero exit (the CLI decides via --fail-on).

import type { AnalysisReport, AssetMetrics } from '@asset-doctor/core';
import { fmtBytes } from '@asset-doctor/analysis';
import { ASSET_METRICS, CLI_CAPABILITIES, GLOBAL_METRICS } from './metrics';
import { globToRegExp } from './glob';
import type { BudgetConfig, GateEntry, GateResult, GateStatus, LevelSpec, MetricUnit } from './types';

export interface EvaluateOptions {
  baseline?: AnalysisReport;
  /** Per-asset pixel sizes (for the oversizePx metric), keyed by assetRef. Supplied by the CLI. */
  assetSizes?: Record<string, { w: number; h: number }>;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function formatValue(unit: MetricUnit, n: number): string {
  switch (unit) {
    case 'bytes': return fmtBytes(n);
    case 'ratio': return `${round1(n * 100)}%`;
    case 'px': return `${n}px`;
    case 'count': return String(n);
  }
}

interface Target { key: string; scope: 'global' | 'asset'; assetRef?: string; unit: MetricUnit; }

function evalLevel(out: GateEntry[], t: Target, level: 'warn' | 'error', spec: LevelSpec, value: number, baseValue?: number): void {
  const fv = (n: number): string => formatValue(t.unit, n);
  const ref = t.scope === 'asset' ? `${t.assetRef} ` : '';

  if (spec.max !== undefined) {
    const breach = value > spec.max;
    out.push({ key: t.key, scope: t.scope, ...(t.assetRef ? { assetRef: t.assetRef } : {}), unit: t.unit, level, check: 'max', budget: spec.max, value, ...(baseValue !== undefined ? { baseValue } : {}), status: breach ? level : 'pass', message: `${ref}${t.key} ${fv(value)} ${breach ? '>' : '≤'} ${fv(spec.max)} budget` });
  }
  if (spec.min !== undefined) {
    const breach = value < spec.min;
    out.push({ key: t.key, scope: t.scope, ...(t.assetRef ? { assetRef: t.assetRef } : {}), unit: t.unit, level, check: 'min', budget: spec.min, value, ...(baseValue !== undefined ? { baseValue } : {}), status: breach ? level : 'pass', message: `${ref}${t.key} ${fv(value)} ${breach ? '<' : '≥'} ${fv(spec.min)} floor` });
  }
  if (spec.maxDeltaPct !== undefined) {
    const baseFields = { key: t.key, scope: t.scope, ...(t.assetRef ? { assetRef: t.assetRef } : {}), unit: t.unit, level, check: 'maxDeltaPct' as const, budget: spec.maxDeltaPct, value };
    if (baseValue === undefined) {
      out.push({ ...baseFields, status: 'pass', message: `${ref}${t.key} Δ — baseline unavailable` });
    } else {
      const delta = baseValue > 0 ? ((value - baseValue) / baseValue) * 100 : value > 0 ? Infinity : 0;
      const breach = delta > spec.maxDeltaPct;
      out.push({ ...baseFields, baseValue, deltaPct: round1(delta), status: breach ? level : 'pass', message: `${ref}${t.key} ${fv(baseValue)} → ${fv(value)} (${delta >= 0 ? '+' : ''}${round1(delta)}% ${breach ? '>' : '≤'} ${spec.maxDeltaPct}%)` });
    }
  }
}

export function evaluateGate(report: AnalysisReport, config: BudgetConfig, opts: EvaluateOptions = {}): GateResult {
  const entries: GateEntry[] = [];

  // ── global metrics ──
  for (const [key, spec] of Object.entries(config.budgets)) {
    if (spec === 'off') continue;
    const def = GLOBAL_METRICS.get(key);
    if (!def) continue; // unreachable: parseBudgetConfig validated
    const t: Target = { key, scope: 'global', unit: def.unit };
    const value = def.get(report);
    const baseValue = opts.baseline ? def.get(opts.baseline) : undefined;
    if (spec.error) evalLevel(entries, t, 'error', spec.error, value, baseValue);
    if (spec.warn) evalLevel(entries, t, 'warn', spec.warn, value, baseValue);
  }

  // ── per-asset overrides ──
  if (config.assets && config.assets.length > 0) {
    const ignore = (config.ignore ?? []).map(globToRegExp);
    const overrides = config.assets.map((o) => ({ re: globToRegExp(o.match), budgets: o.budgets }));
    const baseByRef = new Map<string, AssetMetrics>((opts.baseline?.assets ?? []).map((m) => [m.assetRef, m]));
    for (const m of report.assets) {
      if (ignore.some((re) => re.test(m.assetRef))) continue;
      const hit = overrides.find((o) => o.re.test(m.assetRef));
      if (!hit) continue;
      const size = opts.assetSizes?.[m.assetRef];
      const baseM = baseByRef.get(m.assetRef);
      const baseSize = undefined; // per-asset oversize baseline not tracked (sizes are head-only)
      for (const [key, spec] of Object.entries(hit.budgets)) {
        if (spec === 'off') continue;
        const def = ASSET_METRICS.get(key);
        if (!def) continue;
        const value = def.get(m, size);
        if (value === undefined) continue; // metric N/A for this asset
        const baseValue = baseM ? def.get(baseM, baseSize) : undefined;
        const t: Target = { key, scope: 'asset', assetRef: m.assetRef, unit: def.unit };
        if (spec.error) evalLevel(entries, t, 'error', spec.error, value, baseValue);
        if (spec.warn) evalLevel(entries, t, 'warn', spec.warn, value, baseValue);
      }
    }
  }

  const errorCount = entries.filter((e) => e.status === 'error').length;
  const warnCount = entries.filter((e) => e.status === 'warn').length;
  const worst: GateStatus = errorCount > 0 ? 'error' : warnCount > 0 ? 'warn' : 'pass';
  return { entries, capabilities: CLI_CAPABILITIES, errorCount, warnCount, worst };
}
