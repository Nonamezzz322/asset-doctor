// Parse + validate a raw budget config (JSON object already read from disk) into a normalized
// BudgetConfig. Validation is fail-closed: unknown metric keys, browser-only metrics, and bad units
// all throw ConfigError (→ CLI exit 2). Also resolves a Partial<ThresholdConfig> over the core
// DEFAULT_THRESHOLDS so the CLI and the web app share one threshold source of truth.

import type { ThresholdConfig } from '@asset-doctor/core';
import { DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { ConfigError } from './errors';
import { ASSET_METRICS, CLI_CAPABILITIES, GLOBAL_METRICS } from './metrics';
import { coerceLevel } from './normalize';
import type { AssetOverride, BudgetConfig, Capabilities, LevelSpec, MetricBudget, MetricUnit } from './types';

function normalizeBudget(spec: unknown, unit: MetricUnit, where: string): MetricBudget {
  if (spec === 'off') return 'off';
  if (typeof spec !== 'object' || spec === null) throw new ConfigError('budget must be "off" or an object with warn/error', where);
  const o = spec as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'warn' && k !== 'error') throw new ConfigError(`unknown level "${k}" (allowed: warn, error)`, where);
  const out: { warn?: LevelSpec; error?: LevelSpec } = {};
  if (o.warn !== undefined) out.warn = coerceLevel(o.warn, unit, `${where}.warn`);
  if (o.error !== undefined) out.error = coerceLevel(o.error, unit, `${where}.error`);
  if (!out.warn && !out.error) throw new ConfigError('budget needs a warn and/or error level', where);
  return out;
}

function validateGlobalBudgets(raw: unknown, cap: Capabilities): Record<string, MetricBudget> {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('"budgets" must be an object', 'budgets');
  const out: Record<string, MetricBudget> = {};
  for (const [key, spec] of Object.entries(raw as Record<string, unknown>)) {
    const def = GLOBAL_METRICS.get(key);
    if (!def) throw new ConfigError(`unknown metric "${key}". Known: ${[...GLOBAL_METRICS.keys()].join(', ')}`, `budgets.${key}`);
    if (!def.available(cap))
      throw new ConfigError(`metric "${key}" needs a capability this CLI can't measure (browser-only). Remove it or run the browser audit.`, `budgets.${key}`);
    out[key] = normalizeBudget(spec, def.unit, `budgets.${key}`);
  }
  return out;
}

function validateAssetOverrides(raw: unknown): AssetOverride[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ConfigError('"assets" must be an array', 'assets');
  return raw.map((item, i) => {
    if (typeof item !== 'object' || item === null) throw new ConfigError('asset override must be an object', `assets[${i}]`);
    const o = item as Record<string, unknown>;
    if (typeof o.match !== 'string') throw new ConfigError('asset override needs a "match" glob string', `assets[${i}].match`);
    if (typeof o.budgets !== 'object' || o.budgets === null) throw new ConfigError('asset override needs a "budgets" object', `assets[${i}].budgets`);
    const budgets: Record<string, MetricBudget> = {};
    for (const [key, spec] of Object.entries(o.budgets as Record<string, unknown>)) {
      const def = ASSET_METRICS.get(key);
      if (!def) throw new ConfigError(`unknown per-asset metric "${key}". Known: ${[...ASSET_METRICS.keys()].join(', ')}`, `assets[${i}].budgets.${key}`);
      budgets[key] = normalizeBudget(spec, def.unit, `assets[${i}].budgets.${key}`);
    }
    return { match: o.match, budgets };
  });
}

const THRESHOLD_GROUPS = Object.keys(DEFAULT_THRESHOLDS) as (keyof ThresholdConfig)[];

function validateThresholds(raw: unknown): Partial<ThresholdConfig> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('"thresholds" must be an object', 'thresholds');
  const o = raw as Record<string, unknown>;
  for (const [group, val] of Object.entries(o)) {
    if (!THRESHOLD_GROUPS.includes(group as keyof ThresholdConfig)) throw new ConfigError(`unknown threshold group "${group}". Known: ${THRESHOLD_GROUPS.join(', ')}`, `thresholds.${group}`);
    if (typeof val !== 'object' || val === null) throw new ConfigError(`threshold group "${group}" must be an object`, `thresholds.${group}`);
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ConfigError(`threshold ${group}.${k} must be a number`, `thresholds.${group}.${k}`);
    }
  }
  return o as Partial<ThresholdConfig>;
}

function validateIgnore(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) throw new ConfigError('"ignore" must be an array of glob strings', 'ignore');
  return raw as string[];
}

export function parseBudgetConfig(raw: unknown, capabilities: Capabilities = CLI_CAPABILITIES): BudgetConfig {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('budget config must be a JSON object');
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new ConfigError(`unsupported config version ${JSON.stringify(o.version)} (expected 1)`, 'version');
  const knownTop = ['version', 'thresholds', 'budgets', 'assets', 'ignore', '$schema'];
  for (const k of Object.keys(o)) if (!knownTop.includes(k)) throw new ConfigError(`unknown top-level key "${k}"`, k);
  if (o.budgets === undefined) throw new ConfigError('config needs a "budgets" object', 'budgets');

  const thresholds = validateThresholds(o.thresholds);
  const assets = validateAssetOverrides(o.assets);
  const ignore = validateIgnore(o.ignore);
  return {
    version: 1,
    budgets: validateGlobalBudgets(o.budgets, capabilities),
    ...(thresholds ? { thresholds } : {}),
    ...(assets ? { assets } : {}),
    ...(ignore ? { ignore } : {}),
  };
}

/** Deep-merge a Partial<ThresholdConfig> over DEFAULT_THRESHOLDS (group-wise), to pass into analyze(). */
export function resolveThresholds(partial?: Partial<ThresholdConfig>): ThresholdConfig {
  const base = DEFAULT_THRESHOLDS;
  if (!partial) return base;
  return {
    occupancy: { ...base.occupancy, ...partial.occupancy },
    oversizePx: { ...base.oversizePx, ...partial.oversizePx },
    formatSaving: { ...base.formatSaving, ...partial.formatSaving },
    npotPadding: { ...base.npotPadding, ...partial.npotPadding },
    duplicates: { ...base.duplicates, ...partial.duplicates },
    shouldAtlas: { ...base.shouldAtlas, ...partial.shouldAtlas },
    atlasMerge: { ...base.atlasMerge, ...partial.atlasMerge },
  };
}
