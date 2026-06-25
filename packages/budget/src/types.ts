// The cross-tool contract for the budget gate. The CLI and the GitHub Action both speak these
// shapes. Thresholds reuse @asset-doctor/core's ThresholdConfig verbatim (single source of truth).

import type { ThresholdConfig } from '@asset-doctor/core';

export type MetricUnit = 'bytes' | 'count' | 'ratio' | 'px';

/** One severity level's checks for a metric. All numbers are NORMALIZED (bytes resolved, etc.). */
export interface LevelSpec {
  /** Fail if value > max. */
  max?: number;
  /** Fail if value < min. */
  min?: number;
  /** Fail if value grew more than this percent vs the baseline (needs --baseline). */
  maxDeltaPct?: number;
}

/** 'off' disables a metric explicitly; otherwise warn/error level checks. Only `error` flips exit 1. */
export type MetricBudget = 'off' | { warn?: LevelSpec; error?: LevelSpec };

export interface AssetOverride {
  /** Glob matched against the asset ref (path-ish name). First matching override wins. */
  match: string;
  budgets: Record<string, MetricBudget>;
}

export interface BudgetConfig {
  version: 1;
  /** Partial threshold overrides, deep-merged over DEFAULT_THRESHOLDS and passed to analyze(). */
  thresholds?: Partial<ThresholdConfig>;
  /** Global metric budgets, keyed by dotted metric id (see metrics registry). */
  budgets: Record<string, MetricBudget>;
  /** Per-asset glob budgets. */
  assets?: AssetOverride[];
  /** Globs excluded from every per-asset budget. */
  ignore?: string[];
}

/** What this build can actually measure. The CLI is Node-pure: VRAM + exact-dupes yes; anything that
 *  needs a canvas/WebGL (transcode savings, near-dupes, live draw calls) is off and fails closed. */
export interface Capabilities {
  vram: boolean;
  exactDuplicates: boolean;
  formatAudit: boolean;
  similarDuplicates: boolean;
  renderProbe: boolean;
}

export type GateStatus = 'pass' | 'warn' | 'error';

export interface GateEntry {
  key: string;
  scope: 'global' | 'asset';
  assetRef?: string;
  unit: MetricUnit;
  level: 'warn' | 'error';
  check: 'max' | 'min' | 'maxDeltaPct';
  budget: number;
  value: number;
  baseValue?: number;
  deltaPct?: number;
  status: GateStatus;
  message: string;
}

export interface GateResult {
  entries: GateEntry[];
  capabilities: Capabilities;
  errorCount: number;
  warnCount: number;
  worst: GateStatus;
}
