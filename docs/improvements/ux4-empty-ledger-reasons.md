# UX-4 DESIGN — Honest results states: cause-aware empty-ledger cards + visible partial-parse chip

**VERDICT: PROCEED** (premise re-verified at HEAD `4512c48`; one premise UPGRADE found and folded in — see §1.3)

Slug: `empty-ledger-reasons-and-unparsed-chip` · Lens: states · Merge of states-candidates 1+4.

---

## 1. Verified premise (re-checked at HEAD, file:line)

### 1.1 Half A — the empty ledger is cause-blind and contradicts the verdict. CONFIRMED.

- `apps/web/src/components/VerdictBar.tsx:37-40` — at `problemCount === 0` (crit+warn+info, line 32)
  the bar ALREADY renders a green ok-dot + `t('triage.allClear')` ("no issues found",
  `packages/i18n/src/catalogs/en.json:86`). The original candidate's "no clean-bill state" was
  overstated; the pick's correction stands.
- `apps/web/src/components/TriageLedger.tsx:359-361` — `triage.showing` ("showing {n} of {m}",
  en.json:100) renders UNCONDITIONALLY, so a clean report prints **"showing 0 of 0"** directly under
  the green all-clear.
- `apps/web/src/components/TriageLedger.tsx:363-364` — the ONLY empty state is one cause-blind
  `<p>{t('triage.noMatch')}</p>` ("no assets match these filters", en.json:105). For a clean report
  this sentence is FALSE (no filter mismatch exists — there is nothing to match) and directly
  contradicts the all-clear verdict two lines above it.
- `apps/web/src/App.tsx:83` — `problemsOnly` defaults `true`, and a clean report has zero findings ⇒
  `index.rows = []` ⇒ `rows = []`, `totalRows = 0` (verified empirically, §1.3 script): **every clean
  report hits the contradiction**. Not a corner case.
- The same single `noMatch` string also renders for two OTHER causes it does not distinguish:
  - severity-filter-out (user un-presses all chips carrying findings; `totalRows === 0` via
    `countCandidates`, `apps/web/src/lib/triage.ts:288-303`),
  - search-miss (`rows.length === 0` while `totalRows > 0`; search is excluded from the denominator
    by design, `triage.ts:292`).
- Neither the clean nor the filtered case points at the existing escapes: the "show N clean" toggle
  (`TriageLedger.tsx:341-356`) or a severity reset (no reset control exists at all — chips must be
  re-pressed one by one, `VerdictBar.tsx:47-59`).

### 1.2 Half B — the unparsed notice is buried. FULLY CONFIRMED, and it is the real-failure cohort.

- `apps/web/src/App.tsx:452` — `UnparsedNotice` is the LAST child of the results `<div>`, below the
  entire triage board (ledger + film + findings + FixCard).
- `apps/web/src/App.tsx:507-523` — it renders as a default-collapsed `<details>` whose summary is
  10px mono ink-soft. Zero above-the-fold signal that anything was skipped.
- The cohort that lands there is the **common real-world failure mode**, not an exotic one:
  - `packages/ingest/src/index.ts:113` (Spine .atlas parse failed), `:146` (BMFont parse failed),
    `:150` (no page/char lines), `:171` (**manifest JSON parse failed**), `:177` (frames but no
    meta.image);
  - `apps/web/src/worker/analyze.worker.ts:81-118` (per-frame TP/Pixi recovery `:81`, whole-atlas
    parse failure `:84`, per-region Spine `:89`, per-glyph BMFont `:97`, unrecognized image `:118`)
    plus alpha-scan size-skips `:145,170,173`.
  - i.e. malformed manifests do NOT reach the error phase (`App.tsx:169-174` catches only thrown
    worker errors) — they are silently folded into `unparsed[]` and the run reports "done", possibly
    with a green all-clear. `report.unparsed` is optional on `AnalysisReport`
    (`packages/core/src/index.ts:705`) and the worker attaches it only when non-empty
    (`analyze.worker.ts:192`).
- Worst case verified: **assets = 0 + unparsed = N** (every file failed to parse). `App.tsx:392`
  renders the `report.noAssets` paragraph, `VerdictBar` above it still shows the green "no issues
  found" (tally is all-zero), and the only truth-teller is the collapsed 10px details at the very
  bottom. The chip fixes exactly this: VerdictBar renders in ALL done-phase report states
  (`App.tsx:378` is above the `:392` branch), so a chip mounted there is visible in the
  no-assets case too.

### 1.3 PREMISE UPGRADE (new, found during this verification): the "show N clean" escape is a dead control at HEAD.

The clean-report card's primary action is "point to the existing show-N-clean escape" — but that
escape **does nothing today**:

- `App.tsx:82` — `severityFilter` state is `new Set(DEFAULT_SEVERITIES)` =
  `{crit, warn, info}` (`triage.ts:98`); `'ok'` is never added anywhere (`toggleSeverity`,
  `App.tsx:306-312`, only flips what chips exist, and chips are only crit/warn/info,
  `VerdictBar.tsx:17`).
- `App.tsx:199-212` — `selectOpts` passes that severityFilter verbatim with
  `includeClean: showClean`.
- `triage.ts:252` — `selectRows` drops every row whose severity is not in the filter — INCLUDING the
  synthesized `ok` clean rows. The lib-level test even pins this filtering as correct lib behavior
  ("synthesized but filtered ⇒ no fake reveal", `apps/web/test/triage.test.ts:331-336`); the bug is
  the App wiring, which never admits `'ok'` when `showClean` is on.
- **Empirically proven** (scratchpad `showclean-check.mjs`, run against the real esbuild-transpiled
  `triage.ts` with the exact App wiring): `cleanAssetCount = 2`, toggling showClean:
  `delta = 0 rows`, `totalRows` unchanged. The button advertises "show 2 clean assets" and reveals
  nothing.

The clean card cannot honestly point at a dead control, so the one-line wiring fix (an extracted,
Node-tested `effectiveSeverityFilter`) is folded into v1 scope as a prerequisite commit. This is a
scope CORRECTION, not creep: without it the card's action is a lie, violating invariant 3 in UI form.

### 1.4 Signature correction vs the approved pick

The pick names `emptyLedgerReason(tally, totalRows, cleanAssetCount, search, severityFilter)`.
`severityFilter` is dropped: classification is fully determined by
`(problems, totalRows, rowCount)` — `totalRows === 0` with `problems > 0` can ONLY be caused by the
severity filter (problemsOnly hides only `ok` rows, which exist only under includeClean, and
`effectiveProblemsOnly` is forced off whenever showClean is on, `App.tsx:198`). Passing the Set adds
no signal and would force Set-identity fixtures into every test. `rowCount` is ADDED so the function
is total (callable every render; returns `null` when rows exist). `search` is kept — it must be the
**debounced** `opts.search` (the one that produced the rows), not the raw box value (`App.tsx:81,193`;
`TriageLedger` receives both — raw `search` prop and `opts.search`).

---

## 2. v1 scope

Two severable sub-scopes, one results-screen honesty pass:

**A. Cause-aware empty-ledger cards** (replaces `TriageLedger.tsx:363-364`):
1. Pure `apps/web/src/lib/ledger-empty.ts` (precedent: `results-heading.ts`, `announce.ts`):
   classification + card model (i18n key + params chosen purely) + `effectiveSeverityFilter`.
2. The App wiring fix that makes "show N clean" real (§1.3).
3. Three distinct localized cards: clean-bill / filtered-out (+ one-click severity reset) /
   search-miss (+ one-click clear-search). The `showing 0 of 0` line is suppressed when
   `totalRows === 0` (it carries zero information there and visually fights the verdict).
4. Post-action focus handling (the card unmounts when its action succeeds — focus must not drop to
   `<body>`).

**B. Skipped-files chip** near the verdict:
5. Pure `apps/web/src/lib/skipped-chip.ts` (label model + anchor id constants).
6. Warn-toned, NOT-a-severity chip in `VerdictBar` (right-aligned, dashed border), rendered whenever
   `report.unparsed` is non-empty — including when rows exist AND in the `noAssets` branch.
7. Click: opens the (now controlled) `UnparsedNotice` `<details>`, anchor-scrolls to it
   (reduced-motion-gated, `App.tsx:434` pattern, `scroll-mt` under the sticky header), moves focus
   to its summary.
8. Small hardening of `UnparsedNotice`: `max-h` + `overflow-y-auto` on the list (1000-entry case).

**i18n**: 9 new keys × 9 locales (parity-enforced, `packages/i18n/test/catalogs.test.ts:16-30`).
Unparsed `reason` strings stay English (parser-string precedent, comment at `App.tsx:505-506`).

## 3. Out of scope (explicit)

- The error phase (`phase.t === 'error'`) redesign — the other half of backlog item (a).
- Landmarks / skip-to-results — backlog item (b).
- Localizing parser `reason` strings (established English precedent, same as `fix.skipped`).
- Virtualizing the unparsed list (capped scroll instead; the list exists unvirtualized at HEAD).
- Moving `UnparsedNotice` up the tree (chip + anchor solves discoverability without reflowing the
  board or stealing hero space from the film-viewer).
- Changing `problemsOnly` / `DEFAULT_SEVERITIES` defaults, `useWindow`, or the listbox nav.
- Any live-region / announce.ts change (see §7 — the count announcement already covers these
  transitions; the cards are visual causality, not new speech).
- New color tokens (§6 — zero `index.css` changes).

---

## 4. Design

### 4.1 Pure module: `apps/web/src/lib/ledger-empty.ts` (NEW)

```ts
// PURE empty-ledger classification + card model (no React, no DOM — Node-testable; precedent:
// results-heading.ts / announce.ts). HONESTY: problems = crit+warn+info — IDENTICAL to
// VerdictBar.tsx:32 / announce.ts:18 / results-heading.ts:18 — never tally.ok / cleanAssetCount.

import type { Severity } from '@asset-doctor/core';
import type { T } from '@asset-doctor/i18n';
import type { TriageIndex } from './triage';

export type EmptyLedgerReason =
  | { kind: 'clean'; cleanCount: number }        // zero problems in the report
  | { kind: 'filtered'; hiddenCount: number }    // problems exist; severity filter hides all
  | { kind: 'search'; query: string };           // candidates exist; search hides all

export function emptyLedgerReason(
  tally: TriageIndex['tally'],
  rowCount: number,
  totalRows: number,
  cleanAssetCount: number,
  search: string,            // MUST be opts.search (debounced) — the value that produced rowCount
): EmptyLedgerReason | null {
  if (rowCount > 0) return null;
  const problems = tally.crit + tally.warn + tally.info;   // same formula as VerdictBar/announce
  if (totalRows === 0) {
    return problems === 0
      ? { kind: 'clean', cleanCount: cleanAssetCount }
      : { kind: 'filtered', hiddenCount: problems };       // totalRows===0 ⇒ ALL problems hidden
  }
  // rowCount===0 && totalRows>0 ⇒ search non-empty BY CONSTRUCTION: countCandidates ≡
  // selectRows(...,{search:''}).length (triage.ts:283-287, pinned by triage.test.ts:373-390), and
  // selectRows trims the needle — a blank search cannot produce this state. No defensive branch.
  return { kind: 'search', query: search.trim() };
}

/** i18n key+params chosen PURELY so the choice is Node-testable with a fake translator. Literal key
 *  strings (a switch, no template interpolation) so i18n-app-keys' staticKeys regex scans them. */
export interface EmptyLedgerCard {
  kind: EmptyLedgerReason['kind'];
  title: string;
  body?: string;
  /** Label for the single action button; undefined ⇒ no button (clean card with 0 clean assets). */
  action?: string;
  /** true ⇒ suppress the "showing N of M" line (totalRows===0 ⇒ "showing 0 of 0" is pure noise). */
  hideCounts: boolean;
}

export function emptyLedgerCard(r: EmptyLedgerReason, t: T): EmptyLedgerCard {
  switch (r.kind) {
    case 'clean':
      return {
        kind: 'clean',
        title: t('triage.empty.clean.title'),
        body: t('triage.empty.clean.body', { n: r.cleanCount }),
        // Reuses the toolbar toggle's EXACT label — same action, same accessible name (consistency,
        // not duplication). No button when cleanCount===0 (defensive; unreachable via App.tsx:392).
        ...(r.cleanCount > 0 ? { action: t('triage.showClean', { n: r.cleanCount }) } : {}),
        hideCounts: true,
      };
    case 'filtered':
      return {
        kind: 'filtered',
        title: t('triage.empty.filtered.title'),
        body: t('triage.empty.filtered.body', { n: r.hiddenCount }),
        action: t('triage.empty.filtered.action'),
        hideCounts: true,
      };
    case 'search':
      return {
        kind: 'search',
        title: t('triage.empty.search.title', { q: r.query }),
        action: t('triage.empty.search.action'),
        hideCounts: false, // "showing 0 of M" is INFORMATIVE here — keep it
      };
  }
}

/** The showClean wiring fix (§1.3): the severity set selectRows actually receives. Never mutates
 *  the input; adds 'ok' ONLY while showClean is on, so clean rows survive triage.ts:252. */
export function effectiveSeverityFilter(severityFilter: ReadonlySet<Severity>, showClean: boolean): Set<Severity> {
  const s = new Set(severityFilter);
  if (showClean) s.add('ok');
  return s;
}
```

### 4.2 App wiring fix (makes the escape real) — `apps/web/src/App.tsx`

In the `selectOpts` memo (`App.tsx:199-212`), replace `severityFilter,` with
`severityFilter: effectiveSeverityFilter(severityFilter, showClean),` (dep array unchanged — both
inputs already listed). Effects, all verified against lib tests' semantics:
- showClean ON now surfaces exactly `cleanAssetCount` extra rows (matches the button's advertised N,
  `triage.test.ts:304-313`), and `totalRows`/`countCandidates` grows by the same N (same opts object).
- VerdictBar chips read the RAW `severityFilter` state (`App.tsx:378`) — pressed states unchanged.
- The count announcement (`App.tsx:288-299`) speaks the new "showing N of M" for free.
- Probe re-set unaffected (changes metric numbers only, never opts).

### 4.3 Cards in `TriageLedger` — replace `TriageLedger.tsx:363-364`

New props: `resetSeverities: () => void` (App passes
`() => setSeverityFilter(new Set(DEFAULT_SEVERITIES))` — reuses the ONE canonical default,
`triage.ts:98`). All other needed callbacks (`setSearch`, `setShowClean`, `setProblemsOnly`) already
exist as props (`TriageLedger.tsx:196-201`).

Render logic (component-side, thin):

```tsx
const empty = rows.length === 0
  ? emptyLedgerCard(
      emptyLedgerReason(index.tally, rows.length, totalRows, index.cleanAssetCount, opts.search)!,
      t,
    )
  : null;
```

- Counts line (`:359-361`) becomes `{empty?.hideCounts ? null : <div…showing…>}`.
- Empty branch renders ONE card `<div>` instead of the `noMatch` `<p>`:

```
┌ clean ────────────────────────────────────────────┐
│ ● (ok dot)  Clean bill of health          (h3)    │
│ All 128 analyzed assets passed every check.       │
│ [ show 128 clean assets ]                         │
└───────────────────────────────────────────────────┘  border-ok/40, bg-panel
┌ filtered ─────────────────────────────────────────┐
│ All problems are filtered out             (h3)    │
│ 37 problems are hidden by the severity filter.    │
│ [ Reset severity filters ]                        │
└───────────────────────────────────────────────────┘  border-teal/40 (teal = filter-interaction color)
┌ search ───────────────────────────────────────────┐
│ No assets match “hero_gl…”                (h3)    │
│ [ Clear search ]                                  │
└───────────────────────────────────────────────────┘  border-line (neutral)
```

Card markup spec:
- Container: `rounded-xl border bg-panel p-4 space-y-2` + per-kind border class
  (`border-ok/40` / `border-teal/40` / `border-line`). NO `ad-reveal`/`ad-pulse-dot` (calm chrome,
  reduced-motion inert; pulse stays reserved for film + detail card per `VerdictBar.tsx:10-12`).
- Title: `<h3 className="flex items-center gap-2 font-display text-sm font-semibold text-ink">`;
  clean card prefixes a static `<span className="h-2 w-2 rounded-full bg-ok" aria-hidden />` — the
  SAME ok token/shape as VerdictBar's all-clear dot (`VerdictBar.tsx:39`), visual agreement instead
  of contradiction. h3 keeps the outline monotonic: sr-only h1 (`App.tsx:377`) → h2 Verdict
  (`VerdictBar.tsx:36`) → h3 card → h2 Findings (`App.tsx:422`) — no level skipped downward.
- Body: `text-[13px] leading-relaxed text-ink-soft` (AA: #566472 on #FFF ≈ 6.07:1). `text-pretty`;
  search-title's `{q}` gets `break-words` (long queries wrap, never overflow).
- Action `<button type="button">`: pressed-chip visual language —
  `rounded-lg border border-teal bg-panel px-2.5 py-1 font-mono text-xs text-ink transition
  hover:bg-bg` (matches `VerdictBar.tsx:52-53` pressed state; text-ink for AA — NOT text-teal,
  which is 4.08:1 and fails normal-text AA).
- Actions:
  - clean → same handler as the toolbar toggle (`TriageLedger.tsx:345-349`): extract it to a local
    `revealClean()` used by both (`setShowClean(true); setProblemsOnly(false)`).
  - filtered → `resetSeverities()`.
  - search → `setSearch('')`.

**Post-action focus** (the card unmounts on success — WCAG 2.4.3): a local
`pendingFocus = useRef(false)`; each card action sets it; one `useEffect` keyed on
`[rows.length]`: if `pendingFocus.current` — clear it and focus `win.ref.current` (the always-single
listbox tab stop, `TriageLedger.tsx:367-373`) when `rows.length > 0`, else focus the search input
(always mounted, needs a local `ref`). The listbox's `aria-activedescendant` already points at the
worst row via orphan-reselect (`App.tsx:273-279`), so SR context lands on real content. Instant
(`focus()` only, no scroll — the ledger is already in view).

### 4.4 Pure module: `apps/web/src/lib/skipped-chip.ts` (NEW)

```ts
// PURE skipped-files chip model + the anchor contract (no React/DOM). The chip is "could not
// analyze" — NOT a severity: it must never join the tally chips or claim a finding count.
import type { T } from '@asset-doctor/i18n';

/** Anchor id on the UnparsedNotice <details>; SUMMARY_ID on its <summary> (the focus target).
 *  Exported constants so chip (source) and notice (target) can never drift — same discipline as
 *  route.ts SETTINGS_HASH. */
export const UNPARSED_DETAILS_ID = 'unparsed-notice';
export const UNPARSED_SUMMARY_ID = 'unparsed-notice-summary';

export interface SkippedChip { label: string; hint: string }

/** null when nothing was skipped (chip unmounted — 0 must render NOTHING, not "0 files skipped"). */
export function skippedChipModel(unparsedCount: number, t: T): SkippedChip | null {
  if (unparsedCount <= 0) return null;
  return {
    label: t('report.skippedChip', { n: unparsedCount }),
    hint: t('report.skippedChip.hint'),
  };
}
```

### 4.5 Chip in `VerdictBar` + controlled `UnparsedNotice`

**VerdictBar** (`apps/web/src/components/VerdictBar.tsx`) — new optional props
`skippedCount?: number; onSkippedJump?: () => void`. After the tally-chips/allClear block (inside
the same flex-wrap row, `:35`), when `skippedChipModel(skippedCount ?? 0, t)` is non-null and
`onSkippedJump` present:

```tsx
<button
  type="button"
  onClick={onSkippedJump}
  className="ml-auto flex items-center gap-1.5 rounded-lg border border-dashed border-warn/50
             bg-warn/5 px-2.5 py-1 font-mono text-xs text-ink transition hover:border-warn"
>
  <span className="h-2 w-2 rounded-full bg-warn" aria-hidden />
  {chip.label}
  <span className="ad-sr-only"> — {chip.hint}</span>
</button>
```

- `ml-auto` right-aligns it in the bar (flex-wrap drops it to its own line on narrow widths — the
  existing `gap-y-2` handles the wrap); visually separated from the tally group.
- DISTINCT from severity chips by design: **dashed** border (reads "incomplete/skipped"), no
  `aria-pressed` (it is a jump command, not a filter toggle), never counted into `problemCount`,
  label says "files skipped" not a severity word. Text is `text-ink` (AA), warn arrives via the
  decorative dot + border/bg tint only (`text-warn` #D98A00 on #FFF ≈ 2.6:1 — must NOT carry text).
- Accessible name = visible label + sr-only hint suffix ("3 files skipped — jump to the
  skipped-files list") — visible text is a prefix of the name (WCAG 2.5.3 safe); no `title=`
  (keyboard-inaccessible, per brief).
- Mounted in ALL done-phase report states because VerdictBar is (`App.tsx:378` renders above the
  `:392` noAssets branch) — including the assets=0+unparsed=N case (§1.2), where "no issues found"
  + "12 files skipped" side by side is exactly the honest story.

**App wiring**:
- New state `const [unparsedOpen, setUnparsedOpen] = useState(false)`; reset `setUnparsedOpen(false)`
  in `run()` alongside `setReport(null)` (`App.tsx:133`) so a re-drop starts collapsed.
- `<VerdictBar … skippedCount={report.unparsed?.length ?? 0} onSkippedJump={jumpToUnparsed} />`.
- `jumpToUnparsed` (in App, mirrors the `:432-436` pattern exactly):

```ts
const jumpToUnparsed = () => {
  setUnparsedOpen(true);
  const el = document.getElementById(UNPARSED_DETAILS_ID);       // already mounted (App.tsx:452)
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  document.getElementById(UNPARSED_SUMMARY_ID)?.focus({ preventScroll: true }); // summary is natively focusable
};
```

**UnparsedNotice** (`App.tsx:507-523`) becomes controlled:

```tsx
function UnparsedNotice({ items, open, onToggle }: { items: …; open: boolean; onToggle: (open: boolean) => void }) {
  …
  <details id={UNPARSED_DETAILS_ID} open={open}
           onToggle={(e) => onToggle(e.currentTarget.open)}      // user can still close it natively
           className="scroll-mt-20 rounded-md border border-line bg-bg p-2 text-left open:pb-2.5">
    <summary id={UNPARSED_SUMMARY_ID} className={…unchanged…}>…</summary>
    <ul className="mt-1.5 max-h-72 space-y-1 overflow-y-auto">…unchanged li…</ul>
  </details>
}
```

- `scroll-mt-20` (5rem) clears the sticky header (`App.tsx:320` `sticky top-0`; 5rem is the existing
  clearance token — the results aside uses `lg:top-20`, `App.tsx:416`). Applies to BOTH the
  scrollIntoView and the focus-driven scroll (browsers honor scroll-margin for both).
- `max-h-72 overflow-y-auto` caps the 1000-entry case to one screen of scroll instead of a
  9000px-tall page append (entries are ~10px lines; existing `break-all` at `:517` keeps long refs
  contained).
- `onToggle` keeps React state in sync when the user closes it by clicking the summary (native
  details behavior preserved; no `preventDefault` anywhere).

### 4.6 i18n — 9 new keys (all 9 locales in the same commit; parity test fails otherwise)

EN (`packages/i18n/src/catalogs/en.json`, appended as one contiguous block after `triage.noMatch`
to minimize merge surface — §11):

```json
"triage.empty.clean.title": "Clean bill of health",
"triage.empty.clean.body": { "$count": "n", "one": "The {n} analyzed asset passed every check.", "other": "All {n} analyzed assets passed every check." },
"triage.empty.filtered.title": "All problems are filtered out",
"triage.empty.filtered.body": { "$count": "n", "one": "{n} problem is hidden by the severity filter.", "other": "{n} problems are hidden by the severity filter." },
"triage.empty.filtered.action": "Reset severity filters",
"triage.empty.search.title": "No assets match “{q}”",
"triage.empty.search.action": "Clear search",
"report.skippedChip": { "$count": "n", "one": "{n} file skipped", "other": "{n} files skipped" },
"report.skippedChip.hint": "jump to the skipped-files list"
```

RU (ru.json; note ru gets one/few/many — richer than the existing `report.unparsed.title` ru entry
(one/other only, ru.json:45-49); the parity test checks key sets + placeholder tokens, not category
sets, so this is allowed and grammatically better):

```json
"triage.empty.clean.title": "Проблем не найдено",
"triage.empty.clean.body": { "$count": "n", "one": "{n} проанализированный ассет прошёл все проверки.", "few": "Все {n} проанализированных ассета прошли все проверки.", "many": "Все {n} проанализированных ассетов прошли все проверки.", "other": "Все {n} проанализированных ассетов прошли все проверки." },
"triage.empty.filtered.title": "Все проблемы скрыты фильтрами",
"triage.empty.filtered.body": { "$count": "n", "one": "{n} проблема скрыта фильтром серьёзности.", "few": "{n} проблемы скрыты фильтром серьёзности.", "many": "{n} проблем скрыто фильтром серьёзности.", "other": "{n} проблем скрыто фильтром серьёзности." },
"triage.empty.filtered.action": "Сбросить фильтры серьёзности",
"triage.empty.search.title": "Нет ассетов по запросу «{q}»",
"triage.empty.search.action": "Очистить поиск",
"report.skippedChip": { "$count": "n", "one": "{n} файл пропущен", "few": "{n} файла пропущено", "many": "{n} файлов пропущено", "other": "{n} файлов пропущено" },
"report.skippedChip.hint": "перейти к списку пропущенных файлов"
```

de/es/pt/fr/it/zh/hi: translate at impl time following each catalog's existing register
(`report.unparsed.title` is the closest sibling in every catalog); zh/hi need `other` only, the
Romance/Germanic locales one+other. Plural objects MUST keep `{n}`/`{q}` tokens in every form
(placeholder-parity assertion, `catalogs.test.ts:27`).

The clean card's action reuses the EXISTING `triage.showClean` (already in all 9 catalogs) — no new
key, and identical accessible name to the toolbar toggle it mirrors (deliberate: same action, same
name).

Also note: `triage.noMatch` (en.json:105) becomes UNREFERENCED after this change. Remove it from all
9 catalogs in the same commit (the i18n-app-keys guard only checks referenced→present, not
present→referenced, but dead keys violate the "no drift" spirit and the parity test would carry them
forever).

---

## 5. Exact files touched

| File | Change |
|---|---|
| `apps/web/src/lib/ledger-empty.ts` | NEW — pure classification + card model + effectiveSeverityFilter |
| `apps/web/src/lib/ledger-empty.test.ts` | NEW — Node tests (§9) |
| `apps/web/src/lib/skipped-chip.ts` | NEW — pure chip model + anchor id constants |
| `apps/web/src/lib/skipped-chip.test.ts` | NEW — Node tests |
| `apps/web/src/App.tsx` | selectOpts uses effectiveSeverityFilter; `unparsedOpen` state (+reset in run()); `jumpToUnparsed`; VerdictBar props; controlled UnparsedNotice (+ids, scroll-mt-20, max-h list); `resetSeverities` prop to TriageLedger |
| `apps/web/src/components/TriageLedger.tsx` | cards replace `:363-364`; counts-line suppression; `revealClean()` extraction; `resetSeverities` prop; pendingFocus effect; search-input ref |
| `apps/web/src/components/VerdictBar.tsx` | optional `skippedCount`/`onSkippedJump` props + dashed warn chip |
| `packages/i18n/src/catalogs/*.json` (×9) | +9 keys, −`triage.noMatch` |
| `packages/i18n/test/catalogs.test.ts` | brace-free renders for the new keys (n=1/5, q param) |
| `apps/web/test/i18n-app-keys.test.ts` | add `lib('ledger-empty.ts')` + `lib('skipped-chip.ts')` to appSrc (maintenance contract, header `:1-15`); VerdictBar/TriageLedger already scanned (`:40-55`) |
| `docs/FEATURES.md` | UX-round 4 entry (docs commit, repo convention) |

**Token changes: NONE.** Zero `index.css` edits. Only existing tokens with Tailwind opacity
modifiers (`border-ok/40`, `border-teal/40`, `border-warn/50`, `bg-warn/5`) — same precedent as
`bg-teal/10` (`TriageLedger.tsx:113`). No new fonts, no new animation classes.

---

## 6. ARIA / keyboard / reduced-motion / contrast

- **Headings**: cards use `<h3>` — outline stays monotonic (sr-only h1 → h2 Diagnosis → h3 card →
  h2 Findings). No heading inside the chip.
- **Live region**: NO new announcements. The existing count effect (`App.tsx:288-299`) already
  speaks "showing N of M" on every control change, including card-action clicks (reset/clear change
  `rows.length`/`totalRows` → effect fires). The cards are the visual explanation of the same
  numbers. The spoken "showing 0 of 0" remains for SR users even where the visual line is hidden —
  honest, and changing announce.ts is out of scope.
- **Keyboard**: card action buttons are native `<button>`s in natural tab order after the toolbar;
  focus-visible ring is global (`index.css:48`). Post-action focus lands on the listbox (single tab
  stop, active option already set) or the search input — never dropped to body (§4.3). Chip is a
  native button; Enter/Space free. After chip activation, focus moves to the details `<summary>`
  (natively focusable) — SR context lands ON the disclosure it just opened; Enter there toggles it,
  Escape does nothing special (no trap).
- **Reduced motion**: chip scroll is `behavior: reduce ? 'auto' : 'smooth'` — exact `App.tsx:434-435`
  pattern. Cards/chip have NO animation classes (no ad-pulse-dot/ad-reveal); `<details>` opening is
  instant. `focus({ preventScroll: true })` guarantees exactly ONE programmatic scroll.
- **Contrast (AA)**: card titles `text-ink` (#16202A ≈ 14.9:1); bodies `text-ink-soft`
  (#566472 ≈ 6.07:1 ✓); action/chip labels `text-ink` — deliberately NOT `text-teal` (4.08:1 ✗
  normal-text) or `text-warn` (2.63:1 ✗); warn/ok arrive only via decorative dots (`aria-hidden`)
  and border/bg tints. No `ink-soft/70`/`/80` anywhere (UX-3 bar).
- **ARIA specifics**: chip's sr-only hint is INSIDE the button text (name computed from contents —
  visible label is a prefix, WCAG 2.5.3). Cards are plain divs (no role) — content is
  read-on-navigation, which is correct for a state explanation; `role=alert` would be wrong
  (not urgent, and it co-occurs with the polite count announcement).

## 7. Honesty / instant-wow / perf-at-scale

- **Honesty (invariant 3)**: every number shown is measured and already on screen elsewhere:
  `cleanCount` = `index.cleanAssetCount` (buildIndex, `triage.ts:154-158`), `hiddenCount` =
  crit+warn+info (the VerdictBar/announce/resultsHeading formula — never `tally.ok`/clean, so
  ok-severity is never double-claimed as a problem), chip `n` = `report.unparsed.length` verbatim.
  The chip says "skipped", never a severity, never a finding count. The clean card says "analyzed
  assets" — precise wording that does NOT claim skipped files passed (the chip right above covers
  those). VRAM/disk appear in none of the new strings (invariant 5 untouched).
- **Fixes an anti-honesty state at HEAD**: green "no issues found" above "no assets match these
  filters" + "showing 0 of 0" (§1.1), a dead "show N clean" control (§1.3), and an invisible
  failure cohort (§1.2).
- **Instant wow (invariant 4)**: nothing new on the analysis critical path. Cards/chip render in the
  same done-phase pass; zero network; zero new workers.
- **Perf at 1000+ assets**: `emptyLedgerReason` is O(1) over four integers + one string; it runs only
  when `rows.length === 0` renders anyway. Chip model O(1). Virtualization (`useWindow`), listbox
  nav, and the debounce cadence are UNTOUCHED. The one O(n) addition — `effectiveSeverityFilter` —
  copies a ≤4-element Set inside the existing memo (negligible). `max-h-72` caps unparsed-list paint.

## 8. Determinism

All new functions are pure over scalars: no Date/random/locale branching (`t` injected — announce.ts
discipline). Classification depends only on `(tally, rowCount, totalRows, cleanAssetCount, search)`
— all deterministic products of `buildIndex`/`selectRows`/`countCandidates` (already pinned
deterministic, `triage.ts:16-19`). The probe re-set changes metric numbers only, never row counts ⇒
a card can never flicker mid-session. `effectiveSeverityFilter` returns a fresh Set (never aliases
state). Anchor ids are exported constants (source/target can't drift — route.ts SETTINGS_HASH
discipline).

## 9. Edge cases

| Case | Behavior |
|---|---|
| 0 assets, 0 findings, 0 unparsed | `report.noAssets` branch (`App.tsx:392`) — no card, no chip (unchanged) |
| 0 assets, N unparsed | allClear verdict + **chip "N files skipped"** + noAssets paragraph — the honesty gap §1.2 closed; ledger (and cards) never mount |
| 1 asset, clean | clean card, singular body ("The 1 analyzed asset…"), action "show 1 clean asset" → 1 ok row |
| 1000 assets, all clean | clean card O(1); action reveals 1000 virtualized rows (useWindow mounts ~30) |
| clean + unparsed combined | clean card ("analyzed assets" wording) + warn chip in the same viewport — complementary, not contradictory |
| problems exist, all chips un-pressed | filtered card, hiddenCount = problemCount; reset restores DEFAULT_SEVERITIES |
| filtered + search both active | filtered card first (totalRows===0 dominates); after reset, search card appears if the search still misses — progressive, honest at each step |
| search miss, showClean ON | totalRows = N clean ⇒ search card, "showing 0 of N" kept |
| whitespace-only search | needle trims to '' ⇒ rows === totalRows ⇒ unreachable as 'search' (§4.1 invariant) |
| 1-char/500-char query | `break-words` on the h3; q interpolated as text by React (no injection) |
| 0 unparsed | chip model returns null — nothing renders (never "0 files skipped") |
| 1 unparsed | singular chip + singular details summary (existing `report.unparsed.title` one-form) |
| 1000 unparsed | chip "1000 files skipped"; details opens into a `max-h-72` scroll, not a 9000px append; refs `break-all` (existing) |
| long refs in `<atlas>#<frame>` form | existing `break-all` (`App.tsx:517`) unchanged |
| 9 locales, long strings | cards wrap (`flex`-free stacked layout, `leading-relaxed`); chip wraps to its own row via the bar's existing `flex-wrap gap-y-2`; de/ru longest strings gate manually (§10) |
| ru plurals n=2/5/21 | few/many/one forms provided (§4.6); zh/hi `other`-only |
| re-drop mid-session | `unparsedOpen` reset in run(); cards derive from fresh index — no stale state |
| probe re-set after done | row counts unchanged ⇒ card/chip stable (§8) |

## 10. Test plan

**Pure Node (vitest — the ONLY kind apps/web supports; no React harness):**

1. `ledger-empty.test.ts`
   - Classification matrix: (rowCount>0 ⇒ null) · (0,0,problems=0 ⇒ clean with cleanCount) ·
     (0,0,problems>0 ⇒ filtered with hiddenCount=crit+warn+info, EXCLUDES ok — the announce.ts
     formula lock, fake tally `{crit:2,warn:1,info:0,ok:99}` ⇒ hiddenCount 3 not 102) ·
     (0,totalRows>0 ⇒ search with trimmed query).
   - Card model with fakeT (announce.test.ts:13 pattern): exact key+params per kind; clean action
     present iff cleanCount>0 and uses `triage.showClean` with `{n}`; hideCounts true/true/false.
   - EN render (enT): singular/plural grammar n=1/n=5; search title contains the query verbatim;
     no leftover braces.
   - `effectiveSeverityFilter`: adds 'ok' iff showClean; NEVER mutates input; result is a fresh Set;
     idempotent when 'ok' already present.
   - Integration-shaped lib test (the §1.3 regression lock, using real buildIndex/selectRows/
     countCandidates like triage.test.ts): with App's exact wiring
     (`severityFilter: effectiveSeverityFilter(new Set(DEFAULT_SEVERITIES), true)`,
     `includeClean: true`, `problemsOnly: false`) toggling showClean changes row count by EXACTLY
     `cleanAssetCount` — the assertion that fails at HEAD's wiring.
2. `skipped-chip.test.ts` — null at 0 and negatives; key+params via fakeT; EN singular n=1, plural
   n=1000; constants exported and distinct.
3. `catalogs.test.ts` additions — every locale renders the 9 new keys brace-free (n=1/n=5;
   `triage.empty.search.title` with `{q:'hero.png'}` contains 'hero.png'); `triage.noMatch` removed
   from all 9 (key-set parity re-proves itself).
4. `i18n-app-keys.test.ts` — appSrc additions make the guard cover the new t() sites automatically
   (all keys are LITERAL strings in the pure modules — no new dynamic-prefix branch needed).

**Honestly NOT unit-testable (no React/DOM harness) — manual gates, one browser pass:**

- Cards render/replace correctly for the three causes (drop clean fixture → clean card; un-press all
  chips on a dirty fixture → filtered card; type garbage in search → search card). Fixtures:
  `fixtures/sample-projects`.
- "show N clean" from the CARD actually reveals N rows (the §1.3 fix, end-to-end).
- Post-action focus: activate each card action with keyboard only — focus lands on listbox (or
  search input), visible ring present, arrows navigate immediately.
- Chip: visible with rows present AND in the assets=0 case; click scrolls under the sticky header
  (summary not occluded — scroll-mt-20), details opens, focus on summary; second click while open
  just re-scrolls.
- `prefers-reduced-motion: reduce` (OS toggle): chip scroll is instant, nothing else moves.
- SR smoke (NVDA or VoiceOver): outline h1→h2→h3; chip reads "N files skipped — jump to the
  skipped-files list, button"; count re-announcement after reset/clear.
- Locale overflow spot-check: de + ru at 360px viewport width — cards wrap, chip wraps to own row,
  no horizontal scroll.

## 11. Ordered small-commit breakdown

1. `feat(web): pure ledger-empty module — empty-ledger classification, card model, effectiveSeverityFilter (UX-4)`
   — `ledger-empty.ts` + full test file. No UI change; gate green.
2. `fix(web): showClean admits ok rows through the severity filter — "show N clean" was a dead control`
   — one-line App selectOpts change + the regression-lock lib test (10.1 last bullet). Cites §1.3.
3. `feat(web,i18n): cause-aware empty-ledger cards (clean / filtered / search) + 7 triage.empty.* keys ×9`
   — TriageLedger cards + counts-line suppression + resetSeverities prop + focus effect; catalog
   keys (−triage.noMatch); catalogs.test + i18n-app-keys additions.
4. `feat(web): pure skipped-chip module + anchor id contract (UX-4)`
   — `skipped-chip.ts` + tests + 2 report.skippedChip* keys ×9 + catalogs.test additions.
5. `feat(web,a11y): skipped-files chip in VerdictBar + anchored, controlled UnparsedNotice`
   — VerdictBar props/chip; App unparsedOpen/jumpToUnparsed; UnparsedNotice controlled + scroll-mt-20
   + max-h list.
6. `docs: FEATURES — UX-round 4 (honest results states: empty-ledger cards + skipped chip)`.

Commits 1-3 (sub-scope A) and 4-5 (sub-scope B) are independently shippable in either order; 2 must
precede 3 (the clean card's action depends on it).

## 12. INTEGRATION NOTES vs the in-flight settings-page workflow

Working tree at design time: modified `build-config.ts/.test`, `optimize-entry.ts/.test`,
`packages/fix/src/index.ts`; NEW `build-settings.ts/.test`, `route.ts/.test`,
`packages/fix/src/sheetTarget.ts`. Everything THIS design touches (App.tsx, TriageLedger.tsx,
VerdictBar.tsx, catalogs, ledger tests) is clean at HEAD — designed against HEAD, no mid-edit code
consumed.

1. **App.tsx will be rewritten** (settings page at `#settings`, header nav link, settings context,
   FixCard slimmed to run/plan/receipt). Implement THIS design only AFTER that tree lands. Our five
   App touchpoints are all in the RESULTS subtree, which per `route.ts:8-10` stays MOUNTED (hidden)
   during `view==='settings'` — re-apply them onto the new tree: (a) selectOpts memo →
   `effectiveSeverityFilter`; (b) VerdictBar call site props; (c) UnparsedNotice controlled props +
   ids; (d) `unparsedOpen` state + reset in run(); (e) `jumpToUnparsed` + `resetSeverities` handlers.
   None depend on FixCard/settings state — no semantic conflict, only textual merge.
2. **Hidden-tree interplay**: while `#settings` is shown the results subtree is hidden ⇒ the chip is
   not visible/clickable ⇒ `jumpToUnparsed`'s `getElementById` can never run against a hidden tree.
   No guard needed. If the settings implementation chooses UNMOUNT instead of hide, still fine — the
   chip unmounts with it.
3. **Header**: the settings nav link lives in the `<header>`; the chip deliberately does NOT (it sits
   in VerdictBar's results-flow band) — no collision.
4. **i18n catalogs ×9**: both workflows append keys to the same JSONs — guaranteed textual conflicts,
   trivial resolution. Namespaces disjoint (`triage.empty.*`/`report.skippedChip*` vs the settings
   page's keys). Add ours as ONE contiguous block right after the (removed) `triage.noMatch`
   position.
5. **`i18n-app-keys.test.ts`**: the settings workflow will likely add its new components to `appSrc`
   (maintenance contract in the test header) — same-region merge conflict; keep both additions.
6. **`optimize-entry.ts` is mid-edit in the tree** — we do NOT touch it; it is referenced here only
   as the precedent for the anchor/scroll pattern (`App.tsx:429-441`). If the settings change moves
   the optimize deep-link out of the results aside, our `jumpToUnparsed` pattern is unaffected (own
   constants, own target).
7. **FixCard**: untouched by this design (cards/chip live in TriageLedger/VerdictBar/UnparsedNotice).
   The slimmed FixCard changes nothing we depend on.
