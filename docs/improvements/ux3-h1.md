# Add a document-level results <h1> + fix the heading hierarchy on the primary path (PROCEED)

VERDICT: PROCEED. Premise adversarially verified true and unhandled.

== PROBLEM (verified, cited) ==
On the primary path there is NO document-level <h1> in the results state — a real WCAG 1.3.1 / heading-hierarchy defect for SR heading navigation.
- The ONLY <h1> lives inside the Dropzone (apps/web/src/App.tsx:535) and the entire Dropzone unmounts when phase.t==='done' (App.tsx:359: `{phase.t !== 'done' && (<Dropzone .../>) }`).
- The results region then opens at <h2>: VerdictBar.tsx:36 (`t('triage.verdict')`), a second <h2> at App.tsx:413 (`t('findings.title')`), with <h3>s below at App.tsx:2027 (optimize-entry title) and Findings.tsx:42 (`r.title`). Full inventory confirmed via grep — no other h1.
- The brand wordmark is a plain `<span>` (App.tsx:322), not a heading, so it cannot anchor the outline.
Net: when the user has results (the main use of the app), an SR's heading list starts at level 2 with no h1 — a missing top of the outline. Confirmed there is no existing `role="heading"` anywhere either.

== V1 SCOPE ==
Insert exactly ONE results-level <h1> as the FIRST child of the results container `<div className="space-y-5">` (App.tsx:368, immediately before `<VerdictBar/>` at App.tsx:369). Its text comes from a NEW pure, Node-testable formatter that returns a {key, params} via the injected `t` (announce.ts precedent). Render it visually-hidden with the existing `.ad-sr-only` utility (index.css:165) for ZERO visual diff. Leave VerdictBar/Findings/FixCard/optimize-entry at h2/h3 so the outline stays monotonic (h1 → h2 → h3). Add ONE new key under the existing `a11y.*` namespace to all 9 catalogs.

WHY sr-only (not a visible title), folding in the placement correction: the parent `<div className="space-y-5">` lays children out in normal flow with vertical margins between them. A `.ad-sr-only` element is `position:absolute` (index.css:166) so it is removed from flow and adds NO `space-y-5` gap and NO box — provably zero visual diff while still being first in DOM/AOM order, so the SR outline opens with the h1 before VerdictBar's h2. (Both options keep the outline correct; sr-only is chosen for zero-risk, zero-pixel landing.)

== OUT OF SCOPE ==
- No change to VerdictBar/Findings/FixCard heading levels (they remain h2/h3 — already monotonic under a new h1).
- The Dropzone <h1> (App.tsx:535) stays as-is (it's the document h1 in the pre-results state; the two states never co-exist — Dropzone unmounts at done).
- The brand `<span>` (App.tsx:322) stays a span — promoting it to a heading would put a persistent h1 in the sticky header competing with both the Dropzone h1 and the results h1; out of scope and undesirable.
- No analysis-path, token, layout, color, font, or motion change. No new detector/fix/parser.
- The aria-live `<span role="status">` (App.tsx:355) is untouched — it is a status region, not a heading, and serves a different purpose.

== EXACT FILES + COMPONENTS ==
1. apps/web/src/lib/results-heading.ts (NEW pure module, mirrors announce.ts):
   - `import type { T } from '@asset-doctor/i18n';`
   - `import type { TriageIndex } from './triage';`
   - Signature: `export function resultsHeading(tally: TriageIndex['tally'], t: T): string`
   - Body: `const problems = tally.crit + tally.warn + tally.info; return t('a11y.resultsHeading', { n: problems });`
   - Rationale: identical problem formula to announce.ts/analysisReadyMessage (crit+warn+info, EXCLUDES ok/clean) so the spoken outline and the live region never disagree. `t` injected, no React/DOM → Node-testable with a fake translator.
2. apps/web/src/App.tsx — add import `import { resultsHeading } from './lib/results-heading';` and insert as FIRST child of the results div (between line 368's `<div className="space-y-5">` and line 369's `<VerdictBar.../>`):
   `<h1 className="ad-sr-only">{resultsHeading(index.tally, t)}</h1>`
   `index` and `index.tally` are confirmed in scope at this point (App.tsx:367 guard `report && phase.t === 'done' && index && selectOpts`; VerdictBar already reads `index.tally` at App.tsx:369).
3. packages/i18n/src/catalogs/en.json — add key `a11y.resultsHeading` as a plural object next to `a11y.diagnosisReady` (en.json:75-79). Suggested copy:
   `"a11y.resultsHeading": { "$count": "n", "one": "Asset audit results — {n} problem found", "other": "Asset audit results — {n} problems found" }`
   Then add the SAME key (locale-appropriate translation, same `{n}` placeholder, plural object with `other`) to the other 8 catalogs: ru, de, es, pt, fr, it, zh, hi. (zh/hi/ja-style locales: `other` only is fine; the plural object must still carry `other`.)

== TOKEN CHANGES ==
None. Reuse `.ad-sr-only` (index.css:165, token-free visually-hidden geometry). No new @theme token — explicitly justified: the element is invisible, sets no color/font/spacing/brand surface.

== UX LOGIC EXTRACTED (pure, Node-testable) ==
`resultsHeading(tally, t): string` in apps/web/src/lib/results-heading.ts. Pure, no DOM, `t` injected; returns the key+params string. Tested exactly like announce.test.ts with a fake translator that echoes `key:JSON.stringify(params)`.

== ARIA / KEYBOARD / REDUCED-MOTION / CONTRAST ==
- ARIA: a real `<h1>` participates natively in the accessibility tree as heading level 1 — no `role`/`aria-level` needed. It becomes the document's top heading in the results state, fixing the outline. It is inside `<main>` (App.tsx:348), a landmark, so it anchors that region.
- Keyboard: the h1 is non-interactive, adds no tab stop, no focus change, does not touch TriageLedger keyboard nav (ledger-nav.ts) or useWindow virtualization.
- Reduced-motion: `.ad-sr-only` has no animation (index.css comment 163-164 confirms reduced-motion-safe). No change.
- Contrast: element is visually hidden → not rendered → no contrast concern. (If a future iteration surfaces it as a visible title, it must use existing ink token on bg/panel — but v1 is sr-only.)
- Color-not-sole-signal: text-only; no color used as signal.

== HONESTY / INSTANT-WOW / PERF-AT-SCALE ==
- Honesty: the heading announces the SAME crit+warn+info problem count as VerdictBar's problemCount (VerdictBar.tsx:32) and announce.ts (announce.ts:18). It NEVER mentions VRAM or disk and NEVER conflates them — disk≠VRAM stays out of the heading entirely. No fabricated numbers (tally is the measured index).
- Instant-wow: zero work added to the analysis/worker path; the formatter is one integer add + one `t()` call at render. No <=10s regression.
- Perf-at-scale: O(1) — reads three already-computed tally integers (TriageIndex tally is computed once by buildIndex). Does NOT iterate rows, does NOT touch useWindow virtualization. At 0/1/1000+ assets identical cost.

== DETERMINISM ==
Pure function of `(tally, t)` → deterministic string. Same report → same heading. No timers, no randomness, no Date.

== EDGE CASES ==
- 0 problems (all-clear): n=0 → renders `other` plural in en ("0 problems"); the heading still exists and anchors the outline even when VerdictBar shows "no issues found" (VerdictBar.tsx:37-40). Honest: 0 is the true problem count.
- 1 problem: n=1 → `one` plural. Verified by the catalogs brace-free test pattern (catalogs.test.ts:42-43 precedent).
- 1000+ assets: O(1), no perf impact (see above).
- No-selection / no-image: the h1 is gated only on `report && phase.t==='done' && index` (App.tsx:367) — it is present whenever the results view is, independent of `selectedAsset`/film state. The `report.assets.length===0 && index.rows.length===0` branch (App.tsx:383) renders the "no assets" `<p>`; the h1 sits ABOVE that branch (it is the first child of the `space-y-5` div, before the conditional), so even the empty-results view gets the h1 — correct, the outline still needs a top.
- Long i18n strings: sr-only (`white-space:nowrap` + clipped) → never affects layout regardless of length; visible-title variant (not v1) would need `text-balance` — noted but out of scope.

== TEST PLAN ==
PURE unit tests (Vitest, Node — the real testable surface):
1. apps/web/src/lib/results-heading.test.ts (mirror announce.test.ts):
   - fake `t = (k, p) => `${k}:${JSON.stringify(p)}`` typed as T.
   - `resultsHeading(tally({crit:2,warn:1,info:0,ok:99}), fakeT)` === `'a11y.resultsHeading:{"n":3}'` (proves ok/clean EXCLUDED).
   - `resultsHeading(tally({}), fakeT)` === `'a11y.resultsHeading:{"n":0}'`.
   - `resultsHeading(tally({crit:1}), fakeT)` === `'a11y.resultsHeading:{"n":1}'`.
   - reuse the existing `tally()` helper shape from announce.test.ts.
2. packages/i18n/test/catalogs.test.ts:
   - Key parity is AUTO-enforced (catalogs.test.ts:20 `Object.keys(c).sort()).toEqual(enKeys)`) — adding the key only to en.json without the other 8 FAILS the suite (this is the drift guard).
   - Add brace-free assertions in the existing "renders a plural without leftover braces" test (alongside lines 42-43): `expect(translate(loc,'a11y.resultsHeading',{n:1})).not.toContain('{')` and `{n:5}` for every locale; assert `one`/`other` structure is enforced by the existing object-plural check (catalogs.test.ts:24-25).
UNVERIFIABLE-BY-UNIT (explicit reasoning — apps/web has NO React component harness; Vitest=Node):
   - That the <h1> actually renders first in DOM and is hidden: NOT unit-testable here. Mitigations: (a) `.ad-sr-only` is the SAME class already proven zero-visual-diff for the existing aria-live span (App.tsx:355) and totals strip precedents; (b) one-time manual check with VoiceOver/NVDA rotor heading-list showing h1→h2→h2→h3 monotonic, plus `axe`/Lighthouse "page does not contain a level-one heading" warning clearing on the results view; (c) confirm via DevTools that the results view box metrics are pixel-identical before/after (absolute positioning → no `space-y-5` gap added). Document this in the commit body.

== ORDERED SMALL-COMMIT BREAKDOWN ==
1. feat(a11y): pure resultsHeading formatter + unit test — add apps/web/src/lib/results-heading.ts and results-heading.test.ts (red→green in Node, no UI wiring yet).
2. i18n(a11y): add a11y.resultsHeading to all 9 catalogs + brace-free assertions — en.json plural object + 8 locale translations; extend catalogs.test.ts plural-render test. (Parity test now passes.)
3. feat(a11y): render document-level results <h1> (sr-only) at top of results region — wire resultsHeading into App.tsx as `<h1 className="ad-sr-only">` first child of the `space-y-5` div (App.tsx:368), import added. Commit body documents the manual SR/axe verification step and the zero-visual-diff reasoning.

Each commit is independently green (pnpm test + pnpm typecheck). No analysis-path, token, or layout change anywhere.