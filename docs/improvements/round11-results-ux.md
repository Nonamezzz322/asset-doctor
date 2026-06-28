All facts verified. The `useI18n()` hook returns `{ t, renderFinding, locale, setLocale }`. FixCard lives inside App.tsx (line 1003), takes `files`. The draft's claims about `FolderReport.tsx:34-46` relatedRefs, `FilmViewer` decode effect deps `[bytes, findings, highlightId]`, the double ArrayBuffer copy (App.tsx:61-65 + 88-89), the per-chip O(assets×findings) worst() (App.tsx:344-347), `AssetSelector` (334-364), and auto-select (App.tsx:82) all check out against the real code.

One discrepancy: the draft says the existing grid is `lg:grid-cols-[1fr_minmax(320px,420px)]` (App.tsx:178) but its proposed layout writes `minmax(360px,440px)` — minor, intentional widening. Also `metric.loaded` exists (unused in header) and the header already shows disk/vram/vram-measured/saveable. I now have everything to deliver the revised, code-grounded design.

---

# Asset Doctor — Results-View Redesign (Adversarially Verified + Revised)

## Part 0 — Verification verdict (what the draft got right / wrong)

I read the actual code. The draft's spine is **sound and ship-correct**. Findings:

**Confirmed accurate against code:**
- ✅ `FilmViewer` takes `{ bytes: ArrayBuffer, findings: Finding[], highlightId?, name, metrics?, frameCount? }` (FilmViewer.tsx:21-36). It does **not** take bytes-as-number; decode effect is keyed `[bytes, findings, highlightId]` (line 85). Contract untouched by this redesign. ✅
- ✅ Double ArrayBuffer copy is real: `fileMap` (App.tsx:61-65) **and** `bytesByRef` (App.tsx:88-89), both `Map<key, ArrayBuffer>` built from the same `keyOf`. Collapsible.
- ✅ `AssetSelector` chip wall at App.tsx:334-364 with per-chip `worst(ref)` doing `report.findings.filter(...)` — O(assets × findings) every render (line 344-347). Real perf bug at scale.
- ✅ Auto-select is `setSelectedAsset(rep.assets[0]?.assetRef)` (App.tsx:82) — picks **array-order-first**, not worst. Replacing it with worst-offender is a genuine improvement.
- ✅ `FolderReport` rendered at top (App.tsx:165-173); `relatedRefs` chip-bomb at FolderReport.tsx:34-46 (unbounded buttons). Real.
- ✅ Findings map to assets via `assetFindings = report.findings.filter(f => f.scope !== 'folder' && f.assetRef === selectedAsset)` (App.tsx:115). Folder findings via `scope === 'folder'` (App.tsx:114). `Finding.scope` is `'asset' | 'folder'` optional (core:289), default asset.
- ✅ Metrics exist exactly as claimed: `AssetMetrics { diskBytes, vramBytes, vramBytesMipmapped, occupancy?, fragmentation?, probe? }` (core:406-431). `FindingEstimate { diskBytesSaved?, vramBytesSaved?, occupancyPct? }` — **all optional/sparse** (core:274-278). `probe` is sparse/async.
- ✅ i18n: `useI18n()` returns `{ t, renderFinding, locale, setLocale }` (i18n.tsx:25,59). `renderFinding(f)` is already locale-aware. Drift test (catalogs.test.ts:21,27) asserts **identical key set** AND **identical `{…}` placeholder token sets** per key across all 9 locales; plural objects need `$count` + `one`/`other`. Confirmed.
- ✅ No virtualization dependency present; project convention requires sign-off before adding a lib; house style is zero-dep. Hand-rolled windower is the right call.

**Corrections the draft needs (folded into Part 2):**

1. **BLOCKER — `buildIndex(report)` keyed on identity recomputes on the probe re-set, and that's fine, BUT the draft's auto-select logic must not re-run on the probe re-set.** The probe lands via `setReport(probed)` (App.tsx:95) creating a *new report object*. The draft says "after first index build, select rows[0]" and *also* "re-select rows[0] whenever filters would leave the current selection out." If auto-select keys naively on `index` identity, **the probe re-set will yank the user's selection back to row 0** mid-session. Must gate first-auto-select on a "have we selected yet for this analysis run" ref, not on index identity. Fixed below (§2.4).

2. **MAJOR — folder findings have NO `occupancy`/`vram` of their own and their `assetRef` is "the primary one" (core:290).** The draft's `LedgerRow.metric.vram` reads "asset's declared vramBytes (always present)" — but for a **folder-scoped** row, `assetRef` points at one representative asset; using *its* vram as the row's sort metric silently misrepresents a folder finding as if it were that one asset's VRAM. Fix: folder rows sort by `estimate?.diskBytesSaved` only; their VRAM/OCC badges show `—` (a folder finding is not one asset's footprint). Made explicit below.

3. **MAJOR — sort by `vram` / `occupancy` over a *Finding-row* ledger is semantically muddy.** Two findings on the same asset would both carry that asset's identical VRAM, producing duplicate-valued rows and a confusing "sort by VRAM" that lists the same number twice. Resolution: VRAM/OCC sorts are **asset-axis** sorts; when active, the ledger **collapses to one row per asset** (its worst finding as the visible row, others reachable in the detail pane — which already lists all `assetFindings`). Severity and wastedDisk sorts stay **per-finding**. This is a real correctness/clarity fix, documented in §2.3.

4. **MINOR — the draft's `metric.loaded` / existing header.** Header already renders disk + vram + (vram measured) + saveable (App.tsx:133-147). The new `VerdictHeader` must **not duplicate** those four; it adds the **severity tally chips** and may repeat *only* saveable as the demoted secondary, or better: leave totals in the app header (unchanged) and have VerdictHeader carry **only** the verdict word + severity chips. Avoids two saveable numbers. Adjusted §2.2.

5. **MINOR — `header.xray` key is `"x-ray room"`, `app.tag` is `"phase 1 · milestone 1"`.** Reuse, don't re-key.

6. **NIT — existing grid is `minmax(320px,420px)` (App.tsx:178).** Keep that; no reason to widen to 360/440 (it'd squeeze the film hero on 1280px laptops). Use the existing token.

Everything else in the draft (zero-dep windower, single-decode debounce, static dots on virtualized rows, declared-only rollups, deterministic tiebreak, i18n process) is correct and adopted.

---

## Part 1 — Scorecard (re-judged against code)

The three sub-proposals (A0 problem-ledger / A1 light-table / A2 contact-sheet) are correctly summarized by the draft. My code-grounded ranking matches: **A0 spine + A1 controls + A2 grouping/rollup-honesty.** No change to the verdict — but with the corrections above, the synthesis is now honest about the finding-vs-asset axis tension (correction #3) that the draft glossed.

| Criterion | A0 ledger | A1 table | A2 sheet |
|---|---|---|---|
| Triage value | **5** | 3 | 3 |
| Perf @1000+ | **5** | 5 | 4 |
| Instant-wow ≤10s | **5** | 4 | 3 |
| X-ray brand fit | **5** | 4 | **5** |
| v1 effort | 4 | 3 | 2 |
| Honesty/determinism | low* | low–med | med |

*A0's honesty risk is the finding-vs-asset metric axis (correction #3), now mitigated by per-axis row collapsing.

**Verdict: A0 spine, grafting A1 asset-axis controls + A2 grouping/rollup discipline + zero-dep windower.** Unchanged.

---

## Part 2 — Synthesized Design (implementation-ready, corrected)

### 2.1 Big idea

An **x-ray triage board**. The app header stays exactly as-is (totals strip + language). Below it, a thin **verdict bar** (verdict word + severity-tally filter chips), then a two-column body: a **virtualized triage ledger** (left `1fr`) driving a **sticky film detail** pane (right `minmax(320px,420px)` — the existing token). The ledger's default unit is the **problem (Finding)**, severity-sorted, worst at row 0 and pre-loaded on the film so the ≤10s payoff lands on a glowing overlay. Clean assets are hidden behind an honest "show N clean" toggle. The film snapshot stays the hero; no big savings number is introduced (saveable stays demoted in the existing header). Optional **group-by-folder** (off by default) and **asset-axis sorts** (VRAM/OCC, which collapse to one row per asset) are graft-ons.

### 2.2 View structure

```
┌─ App <header> (App.tsx:124-152) — UNCHANGED ───────────────────────────────┐
│  Logo · totals strip (disk/vram/[measured]/saveable) · language            │
└────────────────────────────────────────────────────────────────────────────┘
┌─ VerdictBar (NEW) — verdict word + severity tally as FILTER CHIPS ─────────┐
│  "Diagnosis"   [● N crit] [● N warn] [● N info]    (chips toggle filter)    │
└────────────────────────────────────────────────────────────────────────────┘
┌─ section grid lg:grid-cols-[1fr_minmax(320px,420px)] gap-6 ────────────────┐
│ ┌ TriageLedger (left, 1fr) ─────────┐ ┌ FilmDetail aside (right, sticky) ─┐ │
│ │ LedgerControls (sticky col-top):  │ │ FilmViewer  (props UNCHANGED)     │ │
│ │  [search] [sort▾] [Group▢]        │ │ Findings (selected asset's)       │ │
│ │  [Problems only ✓ | show N clean] │ │ FixCard (files)                   │ │
│ │  "showing N of M"                 │ │ analyze-another button            │ │
│ ├───────────────────────────────────┤ └───────────────────────────────────┘ │
│ │ VirtualList (the only scroller):  │   sticky top-[calc(headerH+barH)]      │
│ │  [●] title · ref(mid-trunc) ·     │   on <lg: stacks; row tap opens detail │
│ │      [scope] [metric badge]       │   inline below the ledger              │
│ └───────────────────────────────────┘                                        │
└────────────────────────────────────────────────────────────────────────────┘
UnparsedNotice  → kept, moved to a footer <details> under the section
```

**Removed/folded:**
- `AssetSelector` (App.tsx:334-364) — **deleted**, replaced by `TriageLedger`.
- `FolderReport` top usage (App.tsx:165-173) — folder findings flow into the ledger (pinned "Cabinet issues" group when grouped; interleaved by severity when flat). The `relatedRefs` chip-bomb → lazy `+N assets` disclosure inside the row's detail, capped/virtualized-safe.
- `FilmViewer`, `Findings`, `FixCard`, analyze-another, `UnparsedNotice` — **unchanged contracts**, re-homed.

### 2.3 Row model — `apps/web/src/lib/triage.ts` (NEW, pure, tested)

```ts
import type { AnalysisReport, AssetMetrics, Finding, Severity } from '@asset-doctor/core';

export type SortKey = 'severity' | 'wastedDisk' | 'vram' | 'occupancy';
/** severity + wastedDisk are FINDING-axis (row per finding); vram + occupancy are ASSET-axis
 *  (row per asset — its worst finding shown) because a per-asset metric repeated across that
 *  asset's findings would list one number many times (correction #3). */
const ASSET_AXIS: ReadonlySet<SortKey> = new Set(['vram', 'occupancy']);

const SEV_RANK: Record<Severity, number> = { crit: 0, warn: 1, info: 2, ok: 3 };

export interface LedgerRow {
  id: string;              // Finding.id — React key + selection key
  assetRef: string;        // dir-aware keyOf ref → resolves bytes (fileMap) + metrics
  severity: Severity;
  scope: 'asset' | 'folder';
  folder: string;          // assetRef before last '/'; '' = root. Drives optional grouping.
  relatedRefs: string[];   // folder findings only; [] otherwise. Lazy-expanded in detail.
  /** Pre-resolved sort metrics — NONE invented; read straight off existing fields. */
  metric: {
    wastedDisk?: number;   // finding.estimate?.diskBytesSaved (SPARSE — undefined ≠ 0)
    vram?: number;         // ASSET-scope only: metricsByRef.vramBytes. undefined for folder rows.
    occupancy?: number;    // ASSET-scope, atlas only: metricsByRef.occupancy. undefined otherwise.
  };
}

export interface TriageIndex {
  rows: LedgerRow[];                        // ALL finding rows, unsorted/unfiltered
  metricsByRef: Map<string, AssetMetrics>;  // O(1) lookup (no .find() scans)
  tally: Record<Severity, number>;          // chip counts over findings
  cleanAssetCount: number;                  // assets with NO non-ok finding
}

/** ONE O(assets + findings) pass. Replaces per-chip O(assets×findings) worst() (App.tsx:344). */
export function buildIndex(report: AnalysisReport): TriageIndex;

/** Pure sort+filter+search over the index. ASSET-AXIS sorts collapse to worst-finding-per-asset. */
export function selectRows(
  index: TriageIndex,
  opts: { sort: SortKey; search: string; severities: Set<Severity>; problemsOnly: boolean },
): LedgerRow[];
```

**Honesty (Invariants 3 & 5) — load-bearing:**
- Ledger computes **no new numbers**; only ranks/filters/searches existing `AssetMetrics` / `FindingEstimate` fields.
- Metric badges are **labelled** (`DISK` / `VRAM` / `OCC`) so disk≠VRAM stays explicit; each shows the existing value, never a derived "saving" — except `wastedDisk` which IS a measured `estimate.diskBytesSaved`.
- `wastedDisk`, `vram`, `occupancy` are **sparse**; absent → badge renders `—`, never `0` (matches FilmViewer.tsx:131-132 `occ === undefined ? '—'`).
- **Folder rows never show a VRAM/OCC badge** (correction #2) — a folder finding is not one asset's footprint; it shows its `wastedDisk` (if estimable) or `—`.
- Grouped-mode folder rollups sum **declared `vramBytes` only**, labelled "declared", `—` when no estimable saving; measured VRAM stays on the FilmViewer (per A2). VRAM sort uses **declared** `vramBytes`, never sparse async `probe.vramBytes`.

**Determinism (load-bearing — survives the probe re-set):**
```
compare = bySortKey  THEN  SEV_RANK  THEN  assetRef.localeCompare  THEN  findingId.localeCompare
```
Missing metric values sort **last** within their severity bucket (sentinel `+Infinity` for ascending-best metrics, handled so `—` is always last, never `0`-as-real). `selectRows` is pure → Vitest snapshots reproducible; the post-probe `setReport` only fills `probe` numbers, so the sort order is **stable** across the re-set (probe doesn't feed any sort key).

### 2.4 State (App.tsx) — corrections #1 and #4 applied

```ts
const [sort, setSort]                 = useState<SortKey>('severity');
const [search, setSearch]             = useState('');                       // raw input
const debouncedSearch                 = useDebounced(search, 150);          // memo dep
const [severities, setSeverities]     = useState<Set<Severity>>(new Set(['crit','warn','info']));
const [problemsOnly, setProblemsOnly] = useState(true);
const [groupByFolder, setGroupByFolder] = useState(false);
const debouncedSelected               = useDebounced(selectedAsset, 120);   // decode debounce

const index = useMemo(() => buildIndex(report!), [report]);                 // once per report identity
const rows  = useMemo(
  () => selectRows(index, { sort, search: debouncedSearch, severities, problemsOnly }),
  [index, sort, debouncedSearch, severities, problemsOnly],
);
```

**Auto-select worst offender (correction #1 — must NOT fire on the probe re-set):** keep a ref tracking which analysis run we've auto-selected for. `run()` already calls `setSelectedAsset` at App.tsx:82 — change *that* line (it runs once per analysis, before the probe) to select the worst offender from `buildIndex(rep)`'s default-severity ordering:

```ts
// App.tsx run(), replacing line 82:
const firstRows = selectRows(buildIndex(rep), { sort:'severity', search:'', severities:new Set(['crit','warn','info']), problemsOnly:true });
setSelectedAsset((firstRows[0] ?? rep.assets[0])?.assetRef);    // worst problem, else first asset
setSelectedFinding(firstRows[0]?.scope === 'asset' ? firstRows[0]?.id : undefined);
```
This runs in `run()` (before the probe write-back at App.tsx:92-95), so the probe re-set **never** re-selects. A separate small effect re-selects `rows[0]` **only when the current `selectedAsset` is not present in the visible `rows`** (filter change orphaned it) — guarded so it can't fire from the probe re-set (the probe doesn't change `rows` membership, only numbers). Selecting a row sets **both** keys so the clicked finding's overlay highlights via the existing `highlightId` path (FilmViewer.tsx:60):
```ts
onRowClick(row) {
  setSelectedAsset(row.assetRef);
  setSelectedFinding(row.scope === 'asset' ? row.id : undefined); // folder ⇒ no single-asset overlay
}
```

`Esc` clears search. The FilmViewer receives `debouncedSelected`-derived bytes so arrow-key/scroll scrubbing fires one decode after settling (the `cancelled` flag at FilmViewer.tsx:42,83 already prevents tearing on rapid changes).

### 2.5 Perf

| Lever | Mechanism | Bug it fixes |
|---|---|---|
| Virtualize ledger | Zero-dep `useWindow` (fixed-height rows, scroll container, slice by `scrollTop` + ~6 overscan). ~25-35 DOM rows regardless of count. | Multi-thousand chip wall (App.tsx:349); 1000 mounted nodes. |
| One precompute | `buildIndex` = O(assets+findings) once per report identity; `selectRows` = one sort per control change. | Per-chip O(assets×findings) re-scan (App.tsx:344-347). |
| One decode, debounced | FilmViewer decodes only the selected asset (FilmViewer.tsx:47). 120ms debounce on `selectedAsset`. | Decode-per-row when scrubbing. |
| Bound animations | Virtualization caps `ad-pulse-dot` (infinite, index.css:132) to on-screen rows. **Ledger rows use STATIC dots** (omit `ad-pulse-dot`, omit `ad-reveal` — they mount/unmount on scroll). Pulse reserved for film scanline + the selected/crit detail card (`Findings` keeps its existing `ad-pulse-dot`/`ad-reveal`, it's a short list). | N perpetual compositor layers + reveal-jank on every scroll tick. Honors `prefers-reduced-motion` (index.css:148). |
| Halve memory | Collapse `fileMap` (App.tsx:61-65) + `bytesByRef` (App.tsx:88-89) into **one** map; pass `(ref) => fileMap.get(ref)` to `attachProbeReadings`. **Ordering check:** `fileMap` is `useMemo([files])`; `setFiles(picked)` (App.tsx:74) is a state setter — `fileMap` is NOT yet updated inside the same `run()` tick. So in `run()`, pass `(ref) => map.get(ref)` where `map` is built **once locally from `picked`** and is the same object the memo will produce; or build it imperatively from `picked` and reuse. Net: one ArrayBuffer map, not two. | ~2× resident memory for the folder. |

**Hand-rolled, not `@tanstack/react-virtual`:** fixed-height rows ⇒ windowing is ~50 lines and trivially correct; project requires sign-off before adding a lib; house style is zero-dep. `@tanstack/react-virtual` is the sanctioned fallback only if variable-height rows ever appear. **IntersectionObserver: not in v1** — only needed for a thumbnail/cards density mode (out of scope; reintroduces a decode storm + LRU subsystem).

```ts
// apps/web/src/lib/useWindow.ts (NEW)
export function useWindow(total: number, rowH: number, overscan = 6) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el); setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / rowH) + overscan);
  return { ref, start, end, padTop: start * rowH, totalH: total * rowH,
           onScroll: (e: React.UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop) };
}
```
Render: scroll container (`ref`, `onScroll`, fixed height, `overflow-auto`) → inner spacer of `totalH` → translated slice with `transform: translateY(padTop)`. (ResizeObserver is a Web API, not a dep.)

### 2.6 Exact component changes in apps/web

**New files:**
- `apps/web/src/lib/triage.ts` — `buildIndex`, `selectRows`, types (pure; `triage.test.ts`).
- `apps/web/src/lib/useWindow.ts` — windowing hook (+ slice-math unit test).
- `apps/web/src/lib/useDebounced.ts` — `useDebounced(value, ms)`.
- `apps/web/src/components/VerdictBar.tsx` — verdict word + severity-tally filter chips. Reuses `SEVERITY_TEXT` (format.ts:22), `DOT`/`TXT` (Findings.tsx:4-5).
- `apps/web/src/components/TriageLedger.tsx` — controls + `useWindow` list; renders `LedgerRow`s; folder-row `+N assets` disclosure; optional grouping. Reuses `renderFinding` (from `useI18n()`), `DOT`/`TXT`, `fmtBytes`.
- `apps/web/src/components/LedgerRow.tsx` (optional split) — static dot, `renderFinding(f).title`, **middle-truncated** assetRef with full value in `title=` (never hide the disambiguating folder — the `keyOf` dir-aware keying invariant, ingest), scope tag, metric badge.

**Edited files:**
- `apps/web/src/App.tsx` — collapse the double map (§2.5); worst-offender auto-select in `run()` (§2.4, replacing line 82); replace the render block App.tsx:163-210 (`FolderReport` + `AssetSelector` + section) with `VerdictBar` + the `lg:grid-cols-[1fr_minmax(320px,420px)]` section (left `TriageLedger`, right the unchanged `FilmViewer`/`Findings`/`FixCard`/analyze-another in a `sticky` aside); move `UnparsedNotice` to a footer `<details>`; **delete** `AssetSelector` (334-364); add the new state + `index`/`rows` memos + the orphan-reselect effect. Memoize `assetFindings` (App.tsx:115) with `useMemo([report, selectedAsset])` so unrelated re-renders don't re-trigger the FilmViewer decode (deps `[bytes, findings, highlightId]`, FilmViewer.tsx:85 — `findings` identity matters).
- `apps/web/src/components/FilmViewer.tsx` — **no contract change.** (Optional latent nicety only: the `assetFindings` memo above.)
- `apps/web/src/components/FolderReport.tsx` — **removed from the tree** (folder findings flow through the ledger). Delete the file or stop rendering it; its `renderFinding` + `+N assets` logic moves into `TriageLedger`/`LedgerRow`.
- `apps/web/src/index.css` — no new keyframes. Ledger rows simply omit `ad-pulse-dot`/`ad-reveal`. Sticky aside uses Tailwind `sticky top-[…]`; compute the offset from app-header height + VerdictBar height.

### 2.7 i18n keys (namespace `triage.*`, en source, all 9 locales or drift test fails)

Reuse existing: `severity.*`, `metric.saveable`, `header.xray`, `renderFinding` titles. Do **not** re-key those. New (plural objects need `$count` + `one`/`other`; placeholder token sets must be byte-identical across locales per catalogs.test.ts:27):

```jsonc
"triage.verdict":         "Diagnosis",
"triage.allClear":        "no issues found",
"triage.filter.crit":     { "$count": "n", "one": "{n} crit",  "other": "{n} crit" },
"triage.filter.warn":     { "$count": "n", "one": "{n} warn",  "other": "{n} warn" },
"triage.filter.info":     { "$count": "n", "one": "{n} info",  "other": "{n} info" },
"triage.search":          "Search assets",
"triage.sort.label":      "Sort",
"triage.sort.severity":   "Worst first",
"triage.sort.wastedDisk": "Wasted disk",
"triage.sort.vram":       "VRAM (declared)",
"triage.sort.occupancy":  "Occupancy",
"triage.group":           "Group by folder",
"triage.problemsOnly":    "Problems only",
"triage.showClean":       { "$count": "n", "one": "show {n} clean asset", "other": "show {n} clean assets" },
"triage.showing":         "showing {n} of {m}",
"triage.relatedRefs":     { "$count": "n", "one": "+{n} asset", "other": "+{n} assets" },
"triage.scope.asset":     "asset",
"triage.scope.folder":    "folder",
"triage.cabinetIssues":   "Cabinet issues",
"triage.noMatch":         "no assets match these filters"
```
Note: badge labels reuse the existing literal `VRAM`/`DISK`/`OCC` strings already used un-keyed in FilmViewer.tsx:127-132 — keep them as the same display literals for consistency (they are not catalog keys today). `triage.showing` carries `{n}` AND `{m}` — both tokens must appear in all 9 translations. Process: add to `en.json` → `pnpm --filter @asset-doctor/i18n test` → fill `ru/de/es/pt/fr/it/zh/hi` → green before merge. CLI stays EN.

### 2.8 Honesty & determinism checklist (must hold)
- No invented numbers — every figure is an existing `AssetMetrics`/`FindingEstimate` field, only ranked/filtered/formatted (Invariant 3).
- disk≠VRAM explicit — labelled badges; FilmViewer's declared-vs-measured strip untouched (Invariant 5).
- Sparse estimates → `—`, never `0`; declared rollups labelled "declared"; measured stays on the film.
- Folder rows show no per-asset VRAM/OCC (correction #2); asset-axis sorts collapse to one row/asset (correction #3).
- Honest hiding — "showing N of M" + "show N clean" always visible; nothing silently dropped.
- Deterministic order — full tiebreak (sortKey → severity → assetRef → findingId); missing metrics last; probe re-set never reshuffles (probe feeds no sort key) and never re-selects (correction #1).
- Mid-truncate refs but keep both ends + full value in `title` (never hide the folder — `keyOf` keying invariant).
- A11y basics: chips/rows are real `<button>`s (keyboard + focus default), `aria-pressed` on filter chips, search is a labelled `<input>`, sort is a labelled `<select>` (mirrors existing `aria-label` precedent, App.tsx:225/418). Arrow-key row nav + `/`-focuses-search as progressive enhancement (optional, deferrable to v1.1).

### 2.9 Ordered task breakdown (small commits — spine works after step 4, improves monotonically)

1. **`perf(web): collapse double ArrayBuffer copy to one shared byte map`** — remove `bytesByRef` (App.tsx:88-89); build one local map from `picked` in `run()` and pass `(ref) => map.get(ref)` to `attachProbeReadings`; reuse it for `fileMap`. No UI change. *Existing probe-run test still green.*
2. **`feat(web): pure triage index + row selection (triage.ts)`** — `buildIndex` + `selectRows` + types, no React. *`triage.test.ts`: O(assets+findings) tally, metricsByRef, deterministic sort/tiebreak, sparse-metric-last (`—` not `0`), folder-row VRAM/OCC undefined (#2), asset-axis collapse to worst-per-asset (#3), search substring, problems-only, cleanAssetCount.*
3. **`feat(web): zero-dep windowing + useDebounced`** — `useWindow` (slice-math unit test) + `useDebounced`.
4. **`feat(web): VerdictBar + TriageLedger (flat, virtualized) replacing AssetSelector`** — wire `index`/`rows`; severity chips (`aria-pressed`); search/sort/problems-only/show-clean; "showing N of M"; row click sets both selection keys; **worst-offender auto-select in run()** (#1) + orphan-reselect effect; fold folder findings in with `+N assets`; delete `AssetSelector` + top `FolderReport`. *en keys added; drift test green for en.*
5. **`feat(web): sticky film detail + 120ms decode debounce + static ledger dots`** — two-col sticky layout (`minmax(320px,420px)`); debounce `selectedAsset` → FilmViewer; memoize `assetFindings`; drop `ad-pulse-dot`/`ad-reveal` on ledger rows. Visual/perf only.
6. **`feat(web): optional group-by-folder with declared-only rollups`** — group by `assetRef` last-`/`; pinned "Cabinet issues" (folder findings); sticky group headers; declared-only VRAM rollup, `—` when no estimable saving; flatten into the same windowed list. *Test rollup honesty.*
7. **`i18n(triage): fill ru/de/es/pt/fr/it/zh/hi`** — *catalogs + render drift green.*
8. **`chore(web): tidy — remove dead FolderReport, re-home UnparsedNotice, a11y pass`** — arrow-key nav + `/`-focus-search (optional; deferrable to v1.1).

**Out of v1 (note, don't build):** thumbnail/cards density mode (IntersectionObserver + bounded LRU — decode storm); variant-cluster grouping; saved filter presets; CSV/JSON export; multi-select/bulk actions; column config. All additive later without touching `core`.

---

**Key file references (absolute):** `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` (render 163-210, AssetSelector 334-364, fileMap 61-65, probe re-set 88-96, auto-select 82, assetFindings 115, FixCard 1003), `…/apps/web/src/components/FilmViewer.tsx` (props 21-36, decode effect 41-85, deps 85), `…/apps/web/src/components/FolderReport.tsx` (relatedRefs 34-46), `…/apps/web/src/components/Findings.tsx` (DOT/TXT 4-5, ad-reveal/ad-pulse-dot rows), `…/apps/web/src/lib/format.ts` (fmtBytes 4, SEVERITY_TEXT 22), `…/apps/web/src/lib/i18n.tsx` (useI18n 67, renderFinding 25/59), `…/apps/web/src/lib/group.ts` (re-exports keyOf from ingest), `…/apps/web/src/index.css` (ad-reveal 129, ad-pulse-dot 132, reduced-motion 148), `…/packages/core/src/index.ts` (FindingEstimate 274-278, Finding 284-309, AssetMetrics 406-431, AnalysisReport 462-501), `…/packages/i18n/src/catalogs/en.json` (source), `…/packages/i18n/test/catalogs.test.ts` (drift: identical keys 21 + identical placeholder tokens 27).

**Net change from the draft:** 6 corrections folded in — the probe-re-set-must-not-reselect blocker (#1), folder rows have no per-asset VRAM/OCC (#2), asset-axis sorts collapse per-asset (#3), no duplicate saveable number (#4), reuse existing keys/literals (#5), keep the existing `minmax(320px,420px)` token (#6). Everything else verified against real code and adopted.