# Full keyboard navigation of the virtualized TriageLedger (listbox + aria-activedescendant + scroll-into-window across the useWindow boundary) (PROCEED)

VERDICT: PROCEED. Premise verified true against real code.

=== PREMISE VERIFICATION (cited) ===
1. ZERO keyboard primitives in apps/web/src. Grep for tabIndex / tabindex / onKeyDown / onKeyUp / keydown / aria-activedescendant / role="listbox" / role="option" / aria-selected / aria-current / scrollIntoView / .focus() returned NONE in components. The ONLY ARIA-role hit is FilmViewer.tsx:130 role="img" (the canvas x-ray). The ledger search box has an onKeyDown for Escape-clears-search only (TriageLedger.tsx:202-204) — unrelated to row nav.
2. Rows outside the window are physically absent from the DOM. TriageLedger.tsx:192 `const win = useWindow(items.length, ROW_H, 8)`; :193 `const slice = items.slice(win.start, win.end)`; only `slice` is mapped to DOM at :276-300. ROW_H=52 (:30), maxHeight 70vh (:271), overscan 8 ⇒ ~25-35 mounted rows. A keyboard/SR user cannot reach the other ~965 rows of a 1000-row report.
3. The focus ring shipped in UX-1 exists and is token-driven: index.css:47-55 (:focus-visible ⇒ teal on light chrome, film-soft on .ad-grid/.bg-film). So moved focus / the active-descendant outline will be VISIBLE. The deferred item is genuinely unblocked.
4. The container is the natural single tab stop: TriageLedger.tsx:267-272 the scroll <div ref={win.ref} onScroll={win.onScroll}> currently has no role/tabIndex.
5. Selection already flows through onRowClick (TriageLedger.tsx:296 → App.tsx:291-295 onRowClick → setSelectedAsset + setSelectedFinding), which moves the film X-ray. Navigation must reuse this exact path, NOT a parallel one.
6. The two guards we must not regress are real: worst-offender auto-select App.tsx:135-140 (runs once per report, stamps autoSelectedFor.current) and the orphan-reselect effect App.tsx:263-269 (falls back to rows[0] when selectedAsset leaves the visible set). Both key on `selectedAsset` (the assetRef), not an index.
7. Test precedent confirmed: apps/web/test/ has 29 Node (Vitest) test files; useWindow.test.ts tests the PURE windowSlice with no DOM; triage.test.ts (20KB) tests buildIndex/selectRows. No React render harness exists. So new LOGIC must be pure functions tested like windowSlice.
8. i18n gating is real and strict: apps/web/test/i18n-app-keys.test.ts statically scans App.tsx + announce.ts + FilmViewer/VerdictBar/Findings/LicensePanel/TriageLedger for t('…') and asserts each key exists in CATALOGS.en. Any NEW t() key I add to TriageLedger MUST be added to all 9 catalogs (en/ru/de/es/pt/fr/it/zh/hi) or this test (and the packages/i18n drift test) fail.

=== PROBLEM (one sentence) ===
A keyboard-only or screen-reader user can select and inspect only the ~25-35 ledger rows that happen to be inside useWindow's mounted slice; every other row in a 1000-asset report is absent from the DOM and unreachable, so the core triage interaction (move the film X-ray to the next worst offender) is keyboard-inoperable (WCAG 2.1.1 fail).

=== V1 SCOPE ===
A) NEW pure Node-testable module apps/web/src/lib/ledger-nav.ts with TWO functions (signatures below), unit-tested in apps/web/test/ledger-nav.test.ts (mirroring useWindow.test.ts / triage.test.ts).
B) Make the TriageLedger scroll container a role="listbox" with aria-label, tabIndex={0}, aria-activedescendant pointing at the active option's id, and a SINGLE onKeyDown on the container.
C) Rows become role="option" + aria-selected + a stable id; group HEADERS become role="presentation" (truthful: not options) and are SKIPPED by the index math.
D) Thin React glue inside TriageLedger: an `active` index state → keydown calls nextActiveIndex(...) → if the new active row is outside [win.start, win.end), call scrollToActive(...) and imperatively set the container's scrollTop so useWindow re-slices and mounts it → drive the existing onRowClick(active row) so selection + film move together. Enter/Space confirm (re-fire onRowClick; mostly a no-op since arrow already selected).
E) Sync `active` to `selectedAsset` (incoming) so the worst-offender auto-select and orphan-reselect already land the active option correctly.

=== OUT OF SCOPE ===
- No change to useWindow.ts (the windower stays a plain slice over ONE scrollTop — invariant 4).
- No change to triage.ts selectRows / buildIndex / the comparator (no re-ordering).
- No per-row tabIndex / per-row .focus() (would force DOM-focus juggling across remounts and defeat virtualization). We use aria-activedescendant; the container is the ONLY tab stop.
- No type-ahead, no multi-select, no drag — pure single-active listbox nav.
- No change to the toolbar controls (search/sort/group/problemsOnly/showClean) — they remain their own native tab stops, already keyboard-operable.
- No change to App.tsx selection state shape (still keyed by assetRef).
- No new detectors/fixes/parsers/analysis (this is UX, per the loop theme).

=== EXACT FILES + COMPONENTS + TOKENS ===
NEW: apps/web/src/lib/ledger-nav.ts (pure)
NEW: apps/web/test/ledger-nav.test.ts (Vitest)
EDIT: apps/web/src/components/TriageLedger.tsx (container roles + onKeyDown + active state + option ids/roles + scroll glue)
EDIT (i18n, 9 files): packages/i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json — ONE new key:
  "triage.listLabel": "Triage results" (en; localized per catalog). aria-label for the listbox. (Reuse-check: no existing key is a clean "results list" label — triage.verdict="Diagnosis", triage.showing is a count phrase. One short new key x9 is justified and is the minimal addition.)
EDIT: apps/web/test/i18n-app-keys.test.ts — nothing structural needed; TriageLedger.tsx is ALREADY scanned (i18n-app-keys.test.ts appends comp('TriageLedger.tsx')), and triage.listLabel is a STATIC t('triage.listLabel') call so staticKeys() picks it up automatically once it's in en.json. (Confirm by running the test.)

TOKEN CHANGES: NONE new. The active-option highlight REUSES the EXISTING selected style already on rows: TriageLedger.tsx:76 `selected ? 'bg-teal/10' : ...`. Because `active` index drives `selectedAsset` (via onRowClick), the active row IS the selected row, so the existing bg-teal/10 already marks it — no second highlight token needed. The focus-visible ring is already token-driven (index.css:47-55) and will outline the listbox container on tab-in; aria-activedescendant moves the SR's virtual focus without moving DOM focus, so the container keeps the ring. (Optional, additive, only if visual review wants a distinct active-vs-mouse-selected marker: an outline on the active option via `outline outline-1 outline-teal -outline-offset-1` Tailwind utilities — still the teal token, no new @theme entry. Recommend DEFER unless review flags it, to keep the change additive and obviously-correct.)

=== UX LOGIC EXTRACTED INTO PURE NODE-TESTABLE FUNCTIONS (apps/web/src/lib/ledger-nav.ts) ===

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

/** PURE reducer: given the current active index, a nav key, the total option count, and how many rows
 *  fit a page, return the next active index clamped to [0, total). total<=0 ⇒ -1 (no active). A current
 *  of -1 (nothing active) treats ArrowDown/Home as "go to 0" and ArrowUp/End as "go to last". Exhaustive
 *  over NavKey. Deterministic, no DOM. */
export function nextActiveIndex(current: number, key: NavKey, total: number, pageRows: number): number;
  // semantics:
  //   total<=0 -> -1
  //   clamp helper c(i)=max(0,min(total-1,i))
  //   start = current<0 ? (Down/Home? -1 : End/Up? total : current) ... (see edge handling) — concretely:
  //   ArrowDown:  current<0 ? 0 : c(current+1)
  //   ArrowUp:    current<0 ? total-1 : c(current-1)
  //   Home:       0
  //   End:        total-1
  //   PageDown:   c(current<0 ? pageRows-1 : current + max(1,pageRows))
  //   PageUp:     c(current<0 ? 0 : current - max(1,pageRows))
  // Arrow nav does NOT wrap (predictable + matches APG listbox); clamps at the ends.

/** PURE: the scrollTop needed so option `target` is inside the mounted window. Mirrors windowSlice math
 *  (no DOM): if target already within the visible band (accounting for overscan margin) return the
 *  CURRENT scrollTop unchanged (no jump on in-window moves); else align target to the top (scroll up) or
 *  bottom (scroll down) edge of the viewport. Clamped to [0, max(0,total*rowH - viewH)]. rowH<=0 or
 *  total<=0 ⇒ 0. Reduced-motion is irrelevant here (this returns a number; the CALLER sets scrollTop
 *  instantly — never smooth). */
export function scrollToActive(target: number, rowH: number, viewH: number, currentScrollTop: number, total: number): number;
  // semantics:
  //   if rowH<=0 || total<=0 || target<0 -> return clamp(currentScrollTop) [0..maxScroll]
  //   maxScroll = max(0, total*rowH - viewH)
  //   visTop = floor(currentScrollTop / rowH); visBottomExclusive = ceil((currentScrollTop+viewH)/rowH)
  //   if target in [visTop, visBottomExclusive) -> return clamp(currentScrollTop)  // already visible, no jump
  //   if target < visTop  -> return clamp(target*rowH)                              // align to top
  //   else                -> return clamp(target*rowH - viewH + rowH)               // align to bottom
  //   all results clamped to [0, maxScroll]

WHY THESE TWO: nextActiveIndex is the full key map; scrollToActive is the bridge that makes useWindow re-mount the target by feeding it the SAME single scrollTop the windower already consumes (useWindow.ts:50-71 untouched). Both are pure arithmetic — exactly the windowSlice.test / triage.test precedent.

=== ARIA / KEYBOARD / FOCUS MODEL (the careful part) ===
CHOICE: aria-activedescendant listbox pattern (NOT roving tabindex). Rationale — with virtualization, a roving-tabindex active row can UNMOUNT on scroll, orphaning DOM focus (browser drops focus to <body>, SR loses place). aria-activedescendant keeps DOM focus permanently on the stable container; the "active option" is a pure ARIA pointer (an id string), so when a row scrolls out of the window and unmounts, NO DOM focus is lost. When the target re-mounts (after our scrollToActive), its id matches aria-activedescendant and the SR announces it. This is the standard APG technique for virtualized/large listboxes and is precisely why the prompt's "aria-activedescendant over per-row roving" call is correct.

CONTAINER (TriageLedger.tsx:267 div):
  role="listbox"
  aria-label={t('triage.listLabel')}
  tabIndex={0}
  aria-activedescendant={activeId ?? undefined}   // activeId = the active row's option id, or undefined when none
  onKeyDown={onKeyDown}
  (keeps ref={win.ref} onScroll={win.onScroll} overflow-auto maxHeight 70vh exactly as today)

OPTION ROWS (LedgerRowView, TriageLedger.tsx:70 button → keep as <button> for click, ADD):
  id={optionId(it.row.id)}            // stable, derived from row.id (already React key at :292)
  role="option"
  aria-selected={isActive}            // true ONLY for the active option (single-select listbox)
  (the existing onClick stays — mouse path unchanged; selected? bg-teal/10 stays)
  NOTE: a role="option" should not itself be a tab stop. The button default tabIndex is 0; set tabIndex={-1} on option rows so Tab doesn't stop on each mounted row (only the container is the tab stop). This is required for the listbox pattern.

GROUP HEADERS (TriageLedger.tsx:278 div):
  role="presentation"   // truthful: a header is NOT a selectable option
  (no id needed; index math skips them — see below)

KEY MAP (onKeyDown on container; preventDefault on all handled keys so the page doesn't scroll):
  ArrowDown / ArrowUp  -> next/prev option (skipping headers — see index mapping)
  Home / End           -> first / last option
  PageDown / PageUp    -> +/- pageRows (pageRows = Math.max(1, Math.floor(viewH / ROW_H)) computed from win)
  Enter / ' ' (Space)  -> confirm: onRowClick(activeRow) (idempotent; selection already followed arrows)
  (Escape is NOT bound here — the search box owns Escape; the listbox lets it bubble.)
  Any other key: do nothing (let it bubble — e.g. type-into-search is not our concern; container has no text).

HEADER-SKIP INDEX MAPPING (truthful option semantics):
  buildItems (TriageLedger.tsx:112-150) yields a flat `items[]` of {kind:'row'} | {kind:'header'}. Options are ONLY the row items. nextActiveIndex operates over the OPTION space (count = number of row items), NOT the items[] space. Maintain a derived `optionItemIndexes: number[]` (memoized) mapping optionIndex -> items[] index, and its inverse. So:
    - total passed to nextActiveIndex = optionItemIndexes.length
    - active option `a` -> itemsIndex = optionItemIndexes[a] -> used for scrollToActive(itemsIndex, ROW_H, viewH, scrollTop, items.length) because the SCROLL space is items[] (headers occupy ROW_H too, :280). KEY SUBTLETY: index math for NAV is option-space; index math for SCROLL is items-space. The mapping array bridges them. This keeps headers visually present but never "active", and the scroll target accounts for header height (no offset drift — items are uniform ROW_H, the invariant buildItems already guarantees at :22-23,30).
  This header/option split is itself pure and testable: extract `optionIndexMap(items): {toItem:number[]}` OR simpler — since headers only exist in grouped mode and rows carry .scope, compute the map in the component from `items` (cheap, memoized on [items]); the NAV math (nextActiveIndex) needs only the COUNT, which is pure-tested. The scroll math (scrollToActive) is pure-tested on raw indices. The glue that maps option->item index is thin and covered by the "grouped" wiring reasoning (see test plan).

FOCUS-RESTORE-ACROSS-VIRTUALIZATION: there is nothing to "restore" — DOM focus never leaves the container. The active pointer is an id string in component state; on re-slice the matching id re-appears and aria-activedescendant resolves. This is the entire reason for the activedescendant choice. The one imperative line is setting container.scrollTop (via win.ref.current) when scrollToActive returns a changed value; React then re-slices on the resulting onScroll. (We set scrollTop imperatively rather than via state because useWindow owns scrollTop internally as state set from onScroll; assigning el.scrollTop triggers onScroll → setScrollTop, so we stay consistent with useWindow.ts:69 without touching it.)

REDUCED-MOTION: scrollTop is assigned INSTANTLY (el.scrollTop = n), never el.scrollTo({behavior:'smooth'}). So there is no motion to reduce — automatically prefers-reduced-motion safe. (No CSS animation added.)

CONTRAST / COLOR-NOT-SOLE-SIGNAL: the active row reuses bg-teal/10 (already AA-compatible per shipped design) AND carries aria-selected=true (programmatic signal) AND the severity is conveyed by the dot + the uppercase scope TXT label (TriageLedger.tsx:91-93) — so color is not the sole signal, consistent with UX-1's legend work. The focus-visible ring on the container is the 2px token outline (index.css:48).

=== HONESTY / INSTANT-WOW / PERF-AT-SCALE PRESERVED ===
HONESTY: zero new numbers, zero metric changes. Navigation only moves which existing row is active/selected; the film + readouts render the same measured data. disk≠VRAM untouched (no metric code touched). No fabricated rows.
INSTANT-WOW: analysis path (App.tsx run() :103-165) is not touched. The worst-offender auto-select still fires (App.tsx:135-140); we ADD a derivation of `active` FROM selectedAsset so on first paint the active option = the auto-selected worst row (the ≤10s payoff already lands; keyboard just makes it traversable). No new work on the analysis critical path.
PERF AT 1000+: nextActiveIndex/scrollToActive are O(1). The optionIndexMap is O(items) but memoized on [items] (rebuilt only when rows/group change, same cadence as buildItems at :190). We NEVER mount extra rows: keydown changes ONE number (scrollTop) that the EXISTING windower consumes; the mounted set stays ~25-35 (useWindow unchanged). No per-row listeners (one container onKeyDown — explicitly required so virtualization isn't defeated). The active highlight is the existing static class, no new animated nodes (consistent with TriageLedger.tsx:18-19 "STATIC dots, no pulse at scale").

=== DETERMINISM ===
nextActiveIndex and scrollToActive are pure functions of their args (no Date/random/DOM). Same inputs ⇒ same outputs, so the unit tests are exact-equality like windowSlice.test. The option order is selectRows' deterministic order (triage.ts:209-220 comparator), unaffected.

=== EDGE CASES ===
- 0 rows: TriageLedger.tsx:264 already short-circuits to the "no match" <p> (no listbox rendered) ⇒ no nav surface, nothing to do. nextActiveIndex(total=0) ⇒ -1 guard (defensive; container not even mounted).
- 1 row: ArrowDown/Up clamp to 0; Home/End ⇒ 0; PageDn/Up clamp to 0. active=0 selected. Fine.
- 1000+ rows: PageDown jumps pageRows; scrollToActive aligns to bottom edge and clamps to maxScroll; useWindow re-slices to mount it. End ⇒ scrollToActive(last) clamps to maxScroll, last row visible.
- No selection yet (selectedAsset undefined, e.g. a report with assets but the user navigated to a filtered empty-of-selection state): active derives to -1; first ArrowDown ⇒ 0 (top/worst). The orphan-reselect effect (App.tsx:263-269) normally prevents undefined-with-rows, so this is the defensive path.
- Active row scrolls out then user presses Arrow: active is recomputed from the STORED active index (component state), not from what's mounted, so nav continues correctly even when the active option is unmounted (the whole point — its id stays in aria-activedescendant; on the resulting scroll it re-mounts).
- Group-by-folder ON: headers are role=presentation and skipped by optionIndexMap; Arrow moves option-to-option ACROSS folder boundaries (skipping the header row visually scrolled into view via the items-space scroll math). aria-activedescendant only ever points at a real option.
- Filter/sort/search change shrinks rows: the existing orphan-reselect (App.tsx:263-269) moves selectedAsset to rows[0]; our active-from-selectedAsset sync follows it to option 0. No stale active index pointing past the new length (we re-derive on rows change; also clamp defensively).
- Long i18n strings: triage.listLabel is an aria-label (not rendered visually) ⇒ no layout risk. Row layout unchanged (we add attributes only, no new visible text). zh/hi/de long sort labels already tolerated by today's flex-wrap toolbar (:197).
- probe re-set (App.tsx:154-158 new report object, same findings): changes metric NUMBERS only, not row order/identity; selectedAsset is stable (autoSelectedFor guard), so active stays put. We key active-sync on selectedAsset (the assetRef string), NOT on report identity, so the probe re-set does not yank active.

=== TEST PLAN ===
PURE UNIT TESTS — apps/web/test/ledger-nav.test.ts (Vitest, no DOM; mirror useWindow.test.ts):
nextActiveIndex:
  - ArrowDown from 0..total walks +1 and clamps at total-1 (no wrap).
  - ArrowUp from last walks -1 and clamps at 0.
  - Home ⇒ 0; End ⇒ total-1.
  - PageDown/PageUp move by pageRows and clamp; pageRows<=0 treated as 1.
  - current=-1: ArrowDown/Home ⇒ 0, ArrowUp/End ⇒ total-1.
  - total=0 ⇒ -1 for every key.
  - total=1 ⇒ every key resolves to 0.
  - exhaustive: every NavKey returns an index in [0,total) (or -1 only when total=0).
scrollToActive:
  - target already inside the visible band ⇒ returns currentScrollTop unchanged (no jump).
  - target above the band ⇒ aligns to top (target*rowH), clamped to >=0.
  - target below the band ⇒ aligns to bottom (target*rowH - viewH + rowH), clamped to maxScroll.
  - never exceeds maxScroll = max(0, total*rowH - viewH); never negative.
  - rowH<=0 / total<=0 / target<0 ⇒ returns clamped currentScrollTop (safe, no NaN). (Mirrors windowSlice's degrade-safe tests.)
  - CONSISTENCY test: feed scrollToActive's output into windowSlice(total, rowH, out, viewH, overscan) and assert target ∈ [start,end) — proves the two pure modules agree at the windowing boundary (the load-bearing invariant). This is the key adversarial test: it guarantees the active row will be mounted.
I18N: existing i18n-app-keys.test.ts + packages/i18n catalogs.test.ts will FAIL until triage.listLabel is in all 9 catalogs ⇒ they ARE the regression guard for the new key (run pnpm test to confirm green).
EXISTING GUARDS (must stay green): useWindow.test.ts (we don't touch useWindow), triage.test.ts (we don't touch triage). Run full `pnpm test` + `pnpm typecheck` + `pnpm lint`.

UNVERIFIABLE-BY-UNIT-TEST (no React harness) — explicit reasoning + manual checks:
  - The container roles/ids/onKeyDown wiring and the imperative scrollTop set cannot be Vitest-asserted (no DOM render harness; precedent: focus-ring.ts ships the LOGIC pure and the CSS rule is its visual twin). Mitigation: (a) the option->item index mapping and both nav/scroll computations ARE pure-tested; the React glue is a thin pass-through of those tested outputs; (b) MANUAL verification via the existing /verify or /run skill: load a 1000-asset fixture (fixtures/sample-projects), Tab to the listbox, Arrow/Home/End/PageDown/PageUp, confirm the film X-ray moves and an out-of-window row scrolls into view and gets selected; verify with a screen reader (VoiceOver/Orca) that the active option is announced after it re-mounts; verify Tab still reaches search/sort/group; verify mouse click still works and doesn't double-fire; verify reduced-motion (no smooth scroll). (c) An optional future Playwright e2e (deferred — Playwright is "later" per CLAUDE.md) would cover the wiring; out of scope for this round.

=== ORDERED SMALL-COMMIT TASK BREAKDOWN ===
1. feat(web): add pure ledger-nav module (nextActiveIndex + scrollToActive) — new file lib/ledger-nav.ts only, no wiring. [no behavior change]
2. test(web): unit tests for ledger-nav (key map exhaustive + scroll/window consistency). [proves the math]
3. i18n: add triage.listLabel to all 9 catalogs (en source first, then ru/de/es/pt/fr/it/zh/hi). [unblocks the aria-label; keep catalogs.test green]
4. feat(web): TriageLedger container becomes role=listbox (aria-label, tabIndex=0) + rows role=option/aria-selected/id/tabIndex=-1 + headers role=presentation — ARIA semantics ONLY, no keydown yet. [SR can now perceive structure of mounted rows]
5. feat(web): add `active` state derived from selectedAsset + onKeyDown handler wiring nextActiveIndex → onRowClick → scrollToActive (imperative el.scrollTop), with the option<->item index map for grouped mode. [keyboard nav lands; aria-activedescendant set]
6. chore(web): run pnpm typecheck + lint + test; manual a11y pass (verify skill) on a 1000-asset fixture + screen reader; note results.

ADVERSARIAL CORRECTIONS FOLDED IN:
- NAV index space (options) vs SCROLL index space (items, headers included) are DIFFERENT — added the optionIndexMap bridge so the scroll target accounts for header rows' ROW_H, preventing offset drift.
- scrollToActive returns CURRENT scrollTop when already visible (no jarring jump on in-window arrow moves) — verified by the consistency test.
- active is keyed on selectedAsset (assetRef string), not report identity or items index, so neither the probe re-set (App.tsx:154-158) nor a re-slice can desync it.
- option rows need tabIndex={-1} (buttons default to 0) so the container stays the SOLE tab stop — easy to miss; it's required for the listbox pattern.
- Escape deliberately NOT bound on the listbox (search owns it, TriageLedger.tsx:203).
- No new @theme token; active highlight rides the existing selected bg-teal/10 because active drives selection.

KEY FILE:LINE ANCHORS FOR THE IMPLEMENTER:
  TriageLedger.tsx:30 ROW_H; :112-150 buildItems; :190-193 items/win/slice; :267-272 container div (→ listbox); :276-300 slice.map (headers :278 → presentation; rows :291-298 → option); :70-101 LedgerRowView button (→ id/role/aria-selected/tabIndex).
  useWindow.ts:23-38 windowSlice (the scroll math to mirror), :50-71 useWindow (untouched; scrollTop set via el.scrollTop → onScroll:69).
  App.tsx:135-140 auto-select; :263-269 orphan-reselect; :291-295 onRowClick — all keyed on assetRef, compatible.