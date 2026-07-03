// PURE triage core for the scalable results view (no React, worker-safe). Turns an AnalysisReport into
// a precomputed index + an ordered/filtered row list for the virtualized ledger. The whole point is to
// kill the per-render O(assets × findings) worst() scan (old App.tsx AssetSelector) with ONE
// O(assets + findings) precompute (buildIndex) plus a single sort per control change (selectRows).
//
// HONESTY (invariants 3 & 5 — load-bearing):
//   • Invents NO numbers. Every metric here is read straight off an existing AssetMetrics /
//     FindingEstimate field — only ranked / filtered / searched, never derived into a fake "saving".
//   • Sparse metrics stay sparse: absent ⇒ `undefined`, surfaced by the UI as "—", NEVER as a real `0`.
//   • Folder-scoped rows carry NO per-asset VRAM/OCC — a folder finding spans many assets and is not one
//     asset's footprint (a folder finding's assetRef is only its "primary" representative). They sort by
//     their estimable wastedDisk alone.
//   • Synthesized clean rows (the "show N clean" toggle) carry NO metric at all — a clean asset has no
//     problem footprint to claim, so it never inflates a grouped VRAM rollup. They exist ONLY because
//     analysis emits no ok-severity finding; without synthesis the toggle would be inert (a dead control).
// DETERMINISM (load-bearing — survives the async probe re-set):
//   compare = bySortKey → SEV_RANK → assetRef.localeCompare → findingId.localeCompare. Missing metric
//   values sort LAST within their bucket. The probe re-set fills only `probe` numbers (it feeds NO sort
//   key — VRAM sort uses DECLARED vramBytes, never the sparse async probe.vramBytes), so order is stable.

import type { AnalysisReport, AssetMetrics, Rule, Severity } from '@asset-doctor/core';

export type SortKey = 'severity' | 'wastedDisk' | 'vram' | 'occupancy';

/** severity + wastedDisk are FINDING-axis (a row per finding); vram + occupancy are ASSET-axis (a row
 *  per asset — its worst finding shown) because a per-asset metric repeated across that asset's findings
 *  would list the same number many times (round11 correction #3). */
const ASSET_AXIS: ReadonlySet<SortKey> = new Set<SortKey>(['vram', 'occupancy']);
export const isAssetAxis = (sort: SortKey): boolean => ASSET_AXIS.has(sort);

/** Worst → best. The single ranking used for the default sort, every tiebreak, and "worst finding per asset". */
export const SEV_RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2, ok: 3 };

export interface LedgerRow {
  /** Finding.id — React key + selection key. Unique per finding. Synthetic clean rows use `ok:<assetRef>`
   *  (no real finding id collides — real ids are `<ref>:<rule>`), so findingById.get() misses by design
   *  and the UI renders a localized "no issues" title instead of a finding title. */
  id: string;
  /** Dir-aware keyOf ref → resolves bytes (fileMap) + metrics (metricsByRef). Never a basename. */
  assetRef: string;
  severity: Severity;
  scope: 'asset' | 'folder';
  /** The finding's TYPE (Finding.rule) — the axis the user's finding-type filter keys on (view-prefs.ts).
   *  Set for every REAL finding row; undefined ONLY on a synthesized clean row (no backing finding), so a
   *  clean row can never be type-hidden (it has no finding type to hide). */
  rule?: Rule;
  /** True for a SYNTHESIZED clean-asset row (severity 'ok', no backing finding). The honest "show N
   *  clean" path surfaces one such row per clean asset; it carries NO metric badge / VRAM / OCC (a clean
   *  asset has no problem footprint to claim) so grouped rollups never inflate. false for every real finding. */
  clean?: boolean;
  /** assetRef before the last '/'; '' for a root-level asset. Drives optional group-by-folder. */
  folder: string;
  /** Folder findings only: every asset the finding spans (dup group, merge candidates…). [] otherwise.
   *  Lazy-expanded in the detail pane; its length is the row's "+N assets" disclosure count. */
  relatedRefs: string[];
  /** Pre-resolved sort metrics — NONE invented; read straight off existing fields. All sparse ⇒ "—". */
  metric: {
    /** finding.estimate?.diskBytesSaved — a MEASURED saving. Sparse (undefined ≠ 0). */
    wastedDisk?: number;
    /** ASSET-scope only: the asset's DECLARED vramBytes. undefined for folder rows (correction #2). */
    vram?: number;
    /** ASSET-scope, atlas only: the asset's occupancy (0..1). undefined otherwise. */
    occupancy?: number;
  };
}

export interface TriageIndex {
  /** ALL finding rows, in report order (unsorted / unfiltered). selectRows() is the only orderer. */
  rows: LedgerRow[];
  /** O(1) assetRef → metrics lookup (no .find() scans). */
  metricsByRef: Map<string, AssetMetrics>;
  /** Chip counts over FINDINGS (not assets). */
  tally: Record<Severity, number>;
  /** Assets with NO non-ok finding — the honest "show N clean" count (== cleanAssets.length). */
  cleanAssetCount: number;
  /** The dir-aware refs of every clean asset, in report order (deterministic). selectRows synthesizes one
   *  `ok` row per entry when includeClean is on — so the "show N clean" toggle surfaces exactly these N. */
  cleanAssets: string[];
}

export interface SelectOpts {
  sort: SortKey;
  /** Raw substring (case-insensitive) matched against assetRef. '' ⇒ no search filter. */
  search: string;
  /** Severities to KEEP (the filter chips). A finding whose severity is absent is hidden. */
  severityFilter: Set<Severity>;
  /** Finding TYPES the USER has chosen to HIDE (view-prefs.ts). A row whose rule is in this set is dropped
   *  from the ledger — a visible, one-click-reversible user filter, NEVER silent suppression (invariant 3).
   *  Optional + absent/empty ⇒ a no-op (show every type), so an untouched run is byte-identical (the whole
   *  pre-existing suite is the pin). Synthesized clean rows (rule undefined) are never hidden by it. */
  hiddenRules?: ReadonlySet<Rule>;
  /** Hide `ok` rows (the synthesized clean rows). With NO clean rows present this is inert, so the
   *  honest clean toggle drives `includeClean` instead — `problemsOnly` only matters once clean rows exist. */
  problemsOnly: boolean;
  /** Synthesize one `ok` row per CLEAN asset (no non-ok finding) so the "show N clean" toggle actually
   *  reveals those N assets. Analysis emits no ok-severity finding, so without this the toggle is inert. */
  includeClean: boolean;
  /** Group rows by folder (folder-scoped findings pinned first as their own group). Deterministic order. */
  groupByFolder: boolean;
}

/** The ONE canonical default ledger view. SINGLE SOURCE OF TRUTH so the App's initial control state, the
 *  run()-time worst-offender auto-select, and the ledger's opening opts can never drift apart (round11 #3).
 *  Worst-first, all severities kept, problems-only, no clean rows, ungrouped — the ≤10s instant-wow view.
 *  `severityFilter` is built per-caller (a fresh mutable Set) so toggling never aliases this constant. */
export const DEFAULT_SORT: SortKey = 'severity';
export const DEFAULT_SEVERITIES: readonly Severity[] = ['crit', 'warn', 'info'];

/** The canonical empty hidden-rules set — "show every type". Shared (ReadonlySet-typed ⇒ never mutated) so
 *  typeHiddenCount's cleared-filter pass and the default view never allocate a throwaway set. */
const NO_HIDDEN_RULES: ReadonlySet<Rule> = new Set();

export function defaultSelectOpts(): SelectOpts {
  return {
    sort: DEFAULT_SORT,
    search: '',
    severityFilter: new Set<Severity>(DEFAULT_SEVERITIES),
    problemsOnly: true,
    includeClean: false,
    groupByFolder: false,
    // Default = show every finding type ⇒ the type filter is a no-op ⇒ byte-identical to today.
    hiddenRules: NO_HIDDEN_RULES,
  };
}

/** TYPE-visibility predicate (the user's explicit finding-type filter — invariant 3, NEVER silent app-side
 *  suppression). A row is dropped IFF the user has hidden its rule. Synthesized clean rows (rule undefined)
 *  are NEVER hidden — a clean asset has no finding TYPE to hide. Absent/empty hidden set ⇒ always true, so
 *  the whole filter is a byte-identical no-op when the user has touched nothing. */
function typeVisible(row: LedgerRow, hidden: ReadonlySet<Rule> | undefined): boolean {
  if (hidden === undefined || hidden.size === 0) return true;
  return row.rule === undefined || !hidden.has(row.rule);
}

const folderOf = (ref: string): string => {
  const i = ref.lastIndexOf('/');
  return i < 0 ? '' : ref.slice(0, i);
};

/** ONE O(assets + findings) pass. Builds the metrics lookup, the per-asset worst severity (for the clean
 *  count), the finding tally, and the unordered row list. Replaces the per-chip O(assets × findings)
 *  worst() the old AssetSelector ran on every render. */
export function buildIndex(report: AnalysisReport): TriageIndex {
  const metricsByRef = new Map<string, AssetMetrics>();
  for (const a of report.assets) metricsByRef.set(a.assetRef, a);

  const tally: Record<Severity, number> = { crit: 0, warn: 0, info: 0, ok: 0 };
  // Worst non-ok severity seen per asset — an asset with none is "clean". Keyed by the dir-aware assetRef.
  const worstByAsset = new Map<string, Severity>();

  const rows: LedgerRow[] = [];
  for (const f of report.findings) {
    tally[f.severity] += 1;
    const scope: 'asset' | 'folder' = f.scope === 'folder' ? 'folder' : 'asset';
    const m = scope === 'asset' ? metricsByRef.get(f.assetRef) : undefined;
    rows.push({
      id: f.id,
      assetRef: f.assetRef,
      severity: f.severity,
      scope,
      rule: f.rule,
      folder: folderOf(f.assetRef),
      relatedRefs: scope === 'folder' ? f.relatedRefs ?? [] : [],
      metric: {
        wastedDisk: f.estimate?.diskBytesSaved,
        // Per-asset footprint metrics are ONLY meaningful for an asset-scoped finding (correction #2).
        vram: scope === 'asset' ? m?.vramBytes : undefined,
        occupancy: scope === 'asset' ? m?.occupancy : undefined,
      },
    });

    // Track the per-asset worst severity for the clean count. Folder findings DO mark their primary
    // asset as non-clean (the asset is implicated), matching the old worst()-by-assetRef behavior.
    if (f.severity !== 'ok') {
      const prev = worstByAsset.get(f.assetRef);
      if (prev === undefined || SEV_RANK[f.severity] < SEV_RANK[prev]) worstByAsset.set(f.assetRef, f.severity);
    }
  }

  // Clean = no non-ok finding. Collected in report order (deterministic) so synthesized rows are stable.
  const cleanAssets: string[] = [];
  for (const a of report.assets) if (!worstByAsset.has(a.assetRef)) cleanAssets.push(a.assetRef);

  return { rows, metricsByRef, tally, cleanAssetCount: cleanAssets.length, cleanAssets };
}

/** A synthesized `ok` row for a clean asset (no backing finding). Carries NO metric — a clean asset has
 *  no problem footprint to claim, so it never contributes to a grouped VRAM rollup (invariants 3 & 5).
 *  Keyed by the dir-aware assetRef; id prefixed `ok:` so it can't collide with a real `<ref>:<rule>` id. */
function cleanRow(assetRef: string): LedgerRow {
  return {
    id: `ok:${assetRef}`,
    assetRef,
    severity: 'ok',
    scope: 'asset',
    folder: folderOf(assetRef),
    relatedRefs: [],
    clean: true,
    metric: {},
  };
}

/** A numeric sort value + a "missing" flag for a row under the active sort key. Missing always sorts
 *  last (within the severity bucket). For "more is worse" metrics we want descending; for occupancy
 *  lower = more waste = worse, so ascending — encoded by `desc`. */
interface SortVal {
  /** The comparable number; meaningless when `missing`. */
  v: number;
  /** True when the row has no value for this sort key (renders "—", sorts last). */
  missing: boolean;
  /** Descending (largest first) when true; ascending when false. */
  desc: boolean;
}

function sortVal(row: LedgerRow, sort: SortKey): SortVal {
  switch (sort) {
    case 'severity':
      // Severity rank is never missing; smaller rank (crit) first ⇒ ascending.
      return { v: SEV_RANK[row.severity], missing: false, desc: false };
    case 'wastedDisk': {
      const w = row.metric.wastedDisk;
      return { v: w ?? 0, missing: w === undefined, desc: true };
    }
    case 'vram': {
      const v = row.metric.vram;
      return { v: v ?? 0, missing: v === undefined, desc: true };
    }
    case 'occupancy': {
      const o = row.metric.occupancy;
      return { v: o ?? 0, missing: o === undefined, desc: false };
    }
  }
}

/** Full deterministic comparator: bySortKey (missing last) → severity → assetRef → findingId. */
function makeCompare(sort: SortKey): (a: LedgerRow, b: LedgerRow) => number {
  return (a, b) => {
    const sa = sortVal(a, sort);
    const sb = sortVal(b, sort);
    if (sa.missing !== sb.missing) return sa.missing ? 1 : -1; // present before missing, always
    if (!sa.missing && sa.v !== sb.v) return sa.desc ? sb.v - sa.v : sa.v - sb.v;
    if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) return SEV_RANK[a.severity] - SEV_RANK[b.severity];
    const byRef = a.assetRef.localeCompare(b.assetRef);
    if (byRef !== 0) return byRef;
    return a.id.localeCompare(b.id);
  };
}

/** Collapse to the worst finding per asset (ASSET-axis sorts only — correction #3). Determinism: the
 *  representative is the finding that sorts first for that asset under the FULL comparator, so the
 *  collapsed set is independent of input order. */
function collapsePerAsset(rows: LedgerRow[], compare: (a: LedgerRow, b: LedgerRow) => number): LedgerRow[] {
  const best = new Map<string, LedgerRow>();
  for (const r of rows) {
    const cur = best.get(r.assetRef);
    if (cur === undefined || compare(r, cur) < 0) best.set(r.assetRef, r);
  }
  return [...best.values()];
}

/** Pure filter + (optional per-asset collapse) + sort + (optional folder grouping) over the index.
 *  Returns a flat, ordered row list ready to window. Group-by-folder yields a flat list whose order is
 *  group-by-group (folder findings pinned first), each group internally sorted by the same comparator —
 *  so the windower stays a plain slice and group headers can be inferred from row.folder boundaries. */
export function selectRows(index: TriageIndex, opts: SelectOpts): LedgerRow[] {
  const needle = opts.search.trim().toLowerCase();
  const compare = makeCompare(opts.sort);

  // Synthesize one `ok` row per clean asset when asked — analysis emits no ok-severity finding, so this
  // is the ONLY way the "show N clean" toggle can actually surface those N assets. They then flow through
  // the same severity filter / search / comparator / grouping as every real row (no special-casing below).
  const candidates: LedgerRow[] = opts.includeClean
    ? [...index.rows, ...index.cleanAssets.map(cleanRow)]
    : index.rows;

  let rows = candidates.filter((r) => {
    if (opts.problemsOnly && r.severity === 'ok') return false;
    if (!opts.severityFilter.has(r.severity)) return false;
    if (!typeVisible(r, opts.hiddenRules)) return false; // the user's finding-type filter (invariant 3)
    if (needle && !r.assetRef.toLowerCase().includes(needle)) return false;
    return true;
  });

  // ASSET-axis sorts list one number per asset, so collapse to the worst finding per asset first
  // (folder rows have no per-asset metric, so they collapse on their own assetRef too and simply sort last).
  if (isAssetAxis(opts.sort)) rows = collapsePerAsset(rows, compare);

  if (!opts.groupByFolder) return rows.sort(compare);

  // Grouped: folder-scoped findings form a pinned "Cabinet issues" group (sentinel folder key), then
  // real folders in deterministic (localeCompare) order; each group internally sorted by `compare`.
  const CABINET = ' cabinet'; // sorts before any real folder; never collides with a real path.
  const groups = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const key = r.scope === 'folder' ? CABINET : r.folder;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    if (a === CABINET) return b === CABINET ? 0 : -1;
    if (b === CABINET) return 1;
    return a.localeCompare(b);
  });
  const out: LedgerRow[] = [];
  for (const k of orderedKeys) out.push(...groups.get(k)!.sort(compare));
  return out;
}

/** COUNT of rows selectRows would return under `opts` IGNORING search — the stable "of M" denominator for
 *  the ledger's "showing N of M" (round11 #4). Avoids a SECOND full selectRows sort+group per keystroke:
 *  neither sort nor grouping changes the row COUNT, so this does the filter-only pass (plus the SAME
 *  per-asset collapse on asset-axis sorts, via a distinct-assetRef count) and returns the length. Matches
 *  `selectRows(index, { ...opts, search: '' }).length` exactly, by construction. Pure, deterministic. */
export function countCandidates(index: TriageIndex, opts: SelectOpts): number {
  const candidates: LedgerRow[] = opts.includeClean
    ? [...index.rows, ...index.cleanAssets.map(cleanRow)]
    : index.rows;
  // Severity/type/clean filter only — search is deliberately excluded (it's the numerator N's job to narrow).
  const filtered = candidates.filter((r) => {
    if (opts.problemsOnly && r.severity === 'ok') return false;
    if (!opts.severityFilter.has(r.severity)) return false;
    return typeVisible(r, opts.hiddenRules); // same type filter as selectRows ⇒ M stays consistent with N
  });
  // ASSET-axis sorts collapse to one row per asset (collapsePerAsset keys on assetRef), so the count is the
  // number of DISTINCT assetRefs, not the raw finding count. Finding-axis keeps every row.
  if (!isAssetAxis(opts.sort)) return filtered.length;
  const refs = new Set<string>();
  for (const r of filtered) refs.add(r.assetRef);
  return refs.size;
}

/** How many MORE candidate rows the CURRENT view would show if the user cleared their finding-type filter —
 *  the honest "H hidden by your type filter" count (design §1.3). Defined as the SAME candidate pool with
 *  the type filter cleared minus the pool with it applied, on the SAME axis/units as countCandidates (== the
 *  "of M" denominator), so H can never contradict M/N: `countCandidates(withType) + typeHiddenCount ===
 *  countCandidates(noType)` by construction, and H ≥ 0 (monotonic — a filter can only shrink the pool).
 *  Returns 0 whenever hiddenRules is absent/empty (early-out ⇒ no second pass, no H-line, byte-identical). */
export function typeHiddenCount(index: TriageIndex, opts: SelectOpts): number {
  if (opts.hiddenRules === undefined || opts.hiddenRules.size === 0) return 0;
  const withType = countCandidates(index, opts);
  const noType = countCandidates(index, { ...opts, hiddenRules: NO_HIDDEN_RULES });
  return noType - withType;
}

/* ── Spritesheet-first presentation predicates (PRESENTATION ONLY — invariant 3) ──────────────────
 * These drive the primary "build a spritesheet" card AND the honest spam-collapse. They INVENT nothing:
 * every value is read straight off the MEASURED report (the single should-atlas finding + the analysis
 * redundantSibling marker + report.thresholds). Nothing here deletes a finding, changes a count, or is
 * ever consulted BEFORE buildIndex computes the authoritative tally (App wires these AFTER the tally). */

/** The single source for BOTH the primary card (`n`, verbatim) and the loose fold set (`refs`, = the
 *  should-atlas finding's relatedRefs). null unless the folder is loose-dominated. */
export interface LooseRecommendation {
  n: number;
  refs: string[];
}

/** Reads the ONE should-atlas finding + report.thresholds — invents nothing. null (fail-closed) unless
 *  the folder is loose-dominated: should-atlas fired, `dominatedFraction` is set, there is at least one
 *  asset, the relatedRefs clear the minLooseImages floor, AND they are ≥ dominatedFraction of ALL assets
 *  (big loose + every atlas in the denominator, so an atlas-heavy folder scores low and is not promoted). */
export function looseRecommendation(report: AnalysisReport): LooseRecommendation | null {
  const sa = report.findings.find((f) => f.rule === 'should-atlas'); // the single source
  if (!sa) return null;
  const frac = report.thresholds.shouldAtlas.dominatedFraction;
  if (frac === undefined) return null; // fail-closed (no card, no fold)
  const total = report.assets.length;
  if (total <= 0) return null;
  const refs = sa.relatedRefs ?? [];
  if (refs.length < report.thresholds.shouldAtlas.minLooseImages) return null; // floor (belt-and-braces)
  if (refs.length / total < frac) return null; // domination gate
  const n = typeof sa.params?.n === 'number' ? sa.params.n : refs.length; // verbatim n
  return { n, refs };
}

/** True iff loose-dominated (card + collapse-default gate). Thin wrapper over looseRecommendation. */
export function looseDominated(report: AnalysisReport): boolean {
  return looseRecommendation(report) !== null;
}

/** Rules eligible for the LOOSE fold (explicit tested allowlist — NEVER widen without a test). Packing a
 *  loose sprite fixes its NPOT padding + lets a better format apply, so demoting these under the one
 *  should-atlas card is honest; every other rule (oversize, solid-fill, wasted-alpha, folder findings…)
 *  stays first-class because packing does NOT change those pixels/alpha. */
export const FOLDABLE_RULES: ReadonlySet<Rule> = new Set<Rule>(['dimensions-npot', 'format']);

/** The set of finding IDs that MAY fold (loose-fold ∪ format-sibling demotion). Pure over the FULL report;
 *  computed BEFORE any selection so it can never influence the tally. Hard guards: a folder-scoped finding
 *  or a crit NEVER folds. Deterministic (iterates the already-sorted report.findings; returns a Set of ids). */
export function foldableFindingIds(report: AnalysisReport): Set<string> {
  const rec = looseRecommendation(report);
  const looseRefs = rec ? new Set(rec.refs) : new Set<string>();
  const out = new Set<string>();
  for (const f of report.findings) {
    if (f.scope === 'folder' || f.severity === 'crit') continue; // hard guards
    const looseFold = rec !== null && FOLDABLE_RULES.has(f.rule) && looseRefs.has(f.assetRef);
    const siblingFold = f.rule === 'format' && f.params?.redundantSibling === 1;
    if (looseFold || siblingFold) out.add(f.id);
  }
  return out;
}
