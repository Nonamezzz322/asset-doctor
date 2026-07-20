// PURE "biggest wins" model — the impact-first summary that ranks the findings which reclaim the MOST, so a
// user sees "start here" at a glance instead of having to know to change the ledger's sort control (invariant 4:
// the first valuable answer is "сколько веса срезать и с чего начать"). It lives in @asset-doctor/budget (the
// Node-reachable package) so ONE ranking serves both surfaces with zero drift: the in-app BiggestWins.tsx panel
// AND the shared report export (report-export.ts / `asset-doctor audit --html`) — "biggest win" means the same
// thing everywhere. Node-unit-tested (packages/budget/test/biggest-wins.test.ts).
//
// HONESTY (invariants 3 & 5 — load-bearing):
//   • Invents NO numbers. Every row's `bytes` is read straight off an existing `finding.estimate` field —
//     only ranked and truncated, never derived into a new "saving".
//   • disk and VRAM are ranked in TWO SEPARATE lists, each in its OWN unit (invariant 5 — never a combined
//     score; a byte on disk and a byte of VRAM are different quantities).
//   • A finding enters an axis's list ONLY when its saving on THAT axis is a POSITIVE measured number.
//     Sparse/absent ⇒ excluded, never a fabricated 0. Disclosure findings (no estimate) never appear.
//   • NEVER sums. Each list is a ranking of INDEPENDENT opportunities that may overlap (two findings on
//     related assets each claim their own reclaim); the honest dedup-aware TOTAL stays in the budget strip's
//     `potentialDiskSaved`. This is why the panel shows no total — the per-item wins must not be read as a sum.
// DETERMINISM: compare = bytes DESC → SEV_RANK → assetRef.localeCompare → id.localeCompare (mirrors triage).

import type { AnalysisReport, Finding, Severity } from '@asset-doctor/core';

/** Worst → best, the same ranking triage uses for every tiebreak. */
const SEV_RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2, ok: 3 };

export interface WinRow {
  /** Finding.id — the jump/selection key (same key onRowClick uses) + React key. */
  id: string;
  /** Dir-aware assetRef to select (drives the film); the primary ref for a folder finding. */
  assetRef: string;
  /** Finding.rule — lets the renderer pick an icon/label if it wants; not required for the honest row. */
  rule: string;
  severity: Severity;
  scope: 'asset' | 'folder';
  /** The MEASURED saving on THIS axis, in bytes. Positive by construction (the filter drops ≤0/absent). */
  bytes: number;
  /** Folder findings: how many OTHER assets the finding spans (a "+N" context hint). 0 for asset scope. */
  relatedCount: number;
}

export interface BiggestWins {
  /** Top findings by estimate.diskBytesSaved, DESC. Empty ⇒ the disk section is not rendered. */
  disk: WinRow[];
  /** Top findings by estimate.vramBytesSaved, DESC. Empty ⇒ the VRAM section is not rendered. */
  vram: WinRow[];
}

function toRow(f: Finding, bytes: number): WinRow {
  return {
    id: f.id,
    assetRef: f.assetRef,
    rule: f.rule,
    severity: f.severity,
    scope: f.scope === 'folder' ? 'folder' : 'asset',
    bytes,
    relatedCount: f.scope === 'folder' ? (f.relatedRefs?.length ?? 0) : 0,
  };
}

function rankBy(
  findings: readonly Finding[],
  pick: (f: Finding) => number | undefined,
  limit: number,
): WinRow[] {
  return findings
    .map((f) => ({ f, bytes: pick(f) ?? 0 }))
    .filter((x) => x.bytes > 0) // positive measured saving only — sparse/absent/0 excluded (never fabricated)
    .map((x) => toRow(x.f, x.bytes))
    .sort(
      (a, b) =>
        b.bytes - a.bytes ||
        SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
        a.assetRef.localeCompare(b.assetRef) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

/** Rank the report's findings into the top-`limit` disk wins and top-`limit` VRAM wins (two independent
 *  single-unit lists). Both empty ⇒ the caller renders nothing (DOM-identical to a report with no
 *  estimate-bearing finding). Default limit 3 keeps it a "start here" nudge, not an accounting table. */
export function biggestWins(report: AnalysisReport, limit = 3): BiggestWins {
  const fs = report.findings ?? [];
  return {
    disk: rankBy(fs, (f) => f.estimate?.diskBytesSaved, limit),
    vram: rankBy(fs, (f) => f.estimate?.vramBytesSaved, limit),
  };
}

/** True when at least one axis has a rankable win ⇒ the panel is worth rendering. */
export function hasWins(w: BiggestWins): boolean {
  return w.disk.length > 0 || w.vram.length > 0;
}
