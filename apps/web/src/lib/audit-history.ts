// P6 local audit history — store the LAST audit snapshot per folder NAME (localStorage, zero network:
// invariant 1 — the snapshot never leaves the device) and, on a re-audit under the same name, diff it
// against the fresh report via the SAME diff core the CLI ships (@asset-doctor/budget diffAudits) —
// measured deltas + added/resolved/changed by stable Finding.id, zero reinvention.
//
// HONESTY: the folder NAME is the only identity the browser gives us across sessions (no persistent
// path), so the strip's copy says "previous audit of a folder named X" — a hedge, never an asserted
// same-folder claim. The stored snapshot keeps ONLY what diffAudits reads (totals / assets / a trimmed
// finding set: id/rule/assetRef/severity/title); presentation payloads (detail/fix/overlay/perRef/
// params) are stripped — they are never diffed and never rendered from history. A size cap skips
// storing snapshots that would blow the localStorage quota (silent, fail-safe: next time there is
// simply no "previous audit" — we never store a truncated snapshot that would produce a WRONG diff).

import type { AnalysisReport, AssetMetrics, Finding, Rule, Severity } from '@asset-doctor/core';
import type { AuditDiff, AuditSnapshot, MetricDelta } from '@asset-doctor/budget';

export const HISTORY_KEY_PREFIX = 'ad.history.';
/** Serialized-entry byte budget. Above it we DON'T store (never truncate — a partial snapshot would
 *  diff wrong). ~2 MB leaves room beside the app's other localStorage slices in the ~5 MB quota. */
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;

/** The trimmed finding we persist — exactly the fields diffAudits/changeOf read. */
export interface StoredFinding {
  id: string;
  rule: Rule;
  assetRef: string;
  severity: Severity;
  title: string;
}

export interface StoredAudit {
  v: 1;
  /** The folder label (results-summary folderLabel) this snapshot was audited under. */
  label: string;
  /** Epoch ms of the audit — surfaced in the strip's "previous audit (date)" line. */
  at: number;
  totals: AnalysisReport['totals'];
  assets: AssetMetrics[];
  findings: StoredFinding[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): StorageLike | null => (typeof localStorage === 'undefined' ? null : localStorage);

/** Build the persistable snapshot from a fresh report (strips presentation payloads). */
export function buildStored(label: string, at: number, report: AnalysisReport): StoredAudit {
  return {
    v: 1,
    label,
    at,
    totals: report.totals,
    assets: report.assets,
    findings: report.findings.map((f) => ({ id: f.id, rule: f.rule, assetRef: f.assetRef, severity: f.severity, title: f.title })),
  };
}

/** The AuditSnapshot diffAudits consumes. The stripped `detail` is restored as '' — it is read by NO
 *  diff getter and never rendered from history (documented above); nothing fabricated surfaces. */
export function toSnapshot(s: StoredAudit): AuditSnapshot {
  return { totals: s.totals, assets: s.assets, findings: s.findings.map((f) => ({ ...f, detail: '' }) as Finding) };
}

/** Fail-closed load: anything missing/mistyped ⇒ null (never a NaN diff). */
export function loadHistory(label: string, store: StorageLike | null = defaultStore()): StoredAudit | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(HISTORY_KEY_PREFIX + label);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1 || typeof p.label !== 'string' || typeof p.at !== 'number' || !Number.isFinite(p.at)) return null;
  if (typeof p.totals !== 'object' || p.totals === null || !Array.isArray(p.assets) || !Array.isArray(p.findings)) return null;
  for (const f of p.findings as unknown[]) {
    if (typeof f !== 'object' || f === null) return null;
    const x = f as Record<string, unknown>;
    if (typeof x.id !== 'string' || typeof x.rule !== 'string' || typeof x.assetRef !== 'string' || typeof x.severity !== 'string' || typeof x.title !== 'string') return null;
  }
  return parsed as StoredAudit;
}

/** Persist (overwrite) the folder's snapshot. False when skipped (no storage / over the size cap /
 *  quota error) — fail-safe, never a partial write. */
export function saveHistory(stored: StoredAudit, store: StorageLike | null = defaultStore()): boolean {
  if (!store) return false;
  const raw = JSON.stringify(stored);
  if (raw.length > HISTORY_MAX_BYTES) return false;
  try {
    store.setItem(HISTORY_KEY_PREFIX + stored.label, raw);
    return true;
  } catch {
    return false; // quota — the previous snapshot (if any) stays intact
  }
}

/* ── strip view-model ────────────────────────────────────────────────────────────────────────────── */

/** Metric key → the strip's i18n label. ONLY the byte/count headline metrics — the findings.* deltas
 *  are deliberately NOT rows (the added/resolved/changed counts line already tells that story; two
 *  renderings of the same movement would double-shout). Drift-guarded in audit-history.test.ts. */
export const HISTORY_METRIC_LABEL: Record<string, string> = {
  'totals.diskBytes': 'history.metric.disk',
  'totals.vramBytes': 'history.metric.vram',
  'totals.loadedVramBytes': 'history.metric.loadedVram',
  'totals.potentialDiskSaved': 'history.metric.recoverable',
  drawCallsLowerBound: 'history.metric.drawFloor',
};

export interface HistoryRow {
  key: string;
  labelKey: string;
  /** bytes ⇒ fmtBytes rendering; count ⇒ plain integer. */
  bytes: boolean;
  before: number;
  after: number;
  delta: number;
}

/** The strip's metric rows: headline metrics only, NON-FLAT only (a wall of ±0 rows says nothing).
 *  Empty + zero counts ⇒ the strip renders its honest "no change" line instead. */
export function historyRows(diff: AuditDiff): HistoryRow[] {
  const out: HistoryRow[] = [];
  for (const m of diff.metrics as MetricDelta[]) {
    const labelKey = HISTORY_METRIC_LABEL[m.key];
    if (!labelKey || m.delta === 0) continue;
    out.push({ key: m.key, labelKey, bytes: m.unit === 'bytes', before: m.before, after: m.after, delta: m.delta });
  }
  return out;
}
