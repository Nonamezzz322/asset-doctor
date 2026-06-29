# aria-live announcements for analysis progress, result-ready, result-count, and errors (PROCEED)

PROBLEM (verified, cited)
The <=10s instant-wow is invisible to assistive tech. Every state transition in the analysis path is a silent visual-only change:
- apps/web/src/App.tsx:458-462 — the analyzing/progress text is a bare <p className="font-mono text-sm text-[#9be7e7]"> with NO role/aria-live/aria-busy. A screen-reader user who clicks "open folder" hears nothing while analysis runs.
- apps/web/src/App.tsx:127 setPhase({t:'done'}) → render swap at App.tsx:301 (Dropzone unmounts) / :309 (results mount). The diagnosis-ready moment is a DOM swap with NO programmatic announcement. The payoff (auto-selected worst offender + glowing overlay) lands silently.
- apps/web/src/App.tsx:475 — the error <p className="...text-crit"> has NO role="alert"; a failed parse is silent.
- apps/web/src/components/TriageLedger.tsx:260-262 — "showing {n} of {m}" is a plain <div>; as the user types in search or toggles filter chips, the result count changes with no announcement.
- VERIFIED zero coverage: grep for aria-live | role="status" | role="alert" | aria-busy | sr-only | visually-hidden across apps/web/src returned NONE FOUND. index.css has no sr-only/visually-hidden utility (grep: NO SR-ONLY UTILITY).
Honest source numbers already exist on screen: TriageIndex.tally is Record<Severity,number> (crit/warn/info/ok) with cleanAssetCount (apps/web/src/lib/triage.ts:63-75); VerdictBar derives problemCount = tally.crit+tally.warn+tally.info (VerdictBar.tsx:32); the ledger shows rows.length / totalRows (countCandidates) (App.tsx:183,187-190). A 150ms search debounce already exists as a settle point (App.tsx:163 debouncedSearch).

V1 SCOPE
1. Progress text (App.tsx:458-462 wrapper <p>): add role="status" aria-live="polite" aria-atomic="true"; add aria-busy={analyzing} to the dropzone inner div (App.tsx:451). No copy/visual change — SR reads the already-localized t('dropzone.analyzing') + t('dropzone.progress',...).
2. Error text (App.tsx:475): add role="alert" (implicit aria-live="assertive"). Existing phase.message (localized for known errors like error.noFiles, raw worker message otherwise — unchanged, nothing fabricated).
3. ONE visually-hidden polite live region, mounted unconditionally INSIDE the results subtree owner. Place it as the FIRST child of <main> (App.tsx:300) so it persists across the Dropzone↔results swap (avoids the unmount/remount of the message text that can drop an announcement). It emits:
   (a) on analyzing→done: analysisReadyMessage(tally) → e.g. "Diagnosis ready. 7 problems found." or "Diagnosis ready. No problems found." — driven by a useEffect keyed on report identity (the same trigger as auto-select), reading index.tally.
   (b) on settled filter/search: resultCountMessage(shown, total) → reuses the EXISTING t('triage.showing',{n,m}) key — driven by a useEffect keyed on [rows.length, totalRows] which already only changes after debouncedSearch settles (App.tsx:163,183,187), so it is naturally debounced with zero new timers.
   The live region renders the LAST message string into a single <span className="ad-sr-only">. A monotonic "nudge" counter is appended invisibly only if needed to force re-announcement of an identical string (see DETERMINISM).

OUT-OF-SCOPE (explicitly)
- No new detectors/fixes/parsers/analysis (this is a11y/honesty wiring only).
- No announcements for the Pro FIX phase (planning/running/done — FixPhase, App.tsx:481-493) — separate surface, separate pick.
- No focus management / focus-trapping changes (announcements only; keyboard order untouched).
- No visual redesign of the progress/error text; no new colors; no copy rewrites of existing strings.
- No aria-live on the per-keystroke RAW search input (would be chatty) — only the settled count.

EXACT FILES / COMPONENTS / TOKEN CHANGES (all additive)
NEW: apps/web/src/lib/announce.ts — pure formatters (no React, Node-testable). Signatures:
  import type { TriageIndex } from './triage'; import type { T } from '@asset-doctor/i18n' (or the app's t type from lib/i18n).
  - export function analysisReadyMessage(tally: TriageIndex['tally'], t: T): string
      const problems = tally.crit + tally.warn + tally.info; // SAME formula as VerdictBar.tsx:32 (cite for parity)
      return t('a11y.diagnosisReady', { n: problems });  // plural key, see i18n below
  - export function resultCountMessage(shown: number, total: number, t: T): string
      return t('triage.showing', { n: shown, m: total });  // REUSE existing key (en.json:71 "showing {n} of {m}")
  Rationale for passing t in (not importing): keeps announce.ts pure + locale-agnostic and lets the unit test inject a fake t to assert the exact key+params chosen (no locale coupling in the test). This mirrors how triage.ts / film-selection.ts stay React-free.
NEW: apps/web/src/lib/announce.test.ts — Vitest (Node), precedent apps/web/src/lib/film-selection.test.ts.
NEW: a tiny LiveRegion component — co-locate as a function inside App.tsx (next to the existing Logo/Dropzone helpers) OR export from announce-region.tsx. Prefer inline in App.tsx to avoid a new tsx file the i18n-app-keys scan would need to learn about (it scans App.tsx already, App.tsx:28-29). It renders <span role="status" aria-live="polite" aria-atomic="true" className="ad-sr-only">{message}</span> (role on the persistent container per WAI-ARIA: container must exist before text is injected — satisfied by mounting it once at App.tsx:300).
EDIT: apps/web/src/App.tsx — three attribute additions (1,2 above) + the live-region mount + two useEffects.
EDIT: apps/web/src/index.css — add ONE token-free utility (additive). Place after .ad-reveal block (~line 131), before @media reduced-motion:
  .ad-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  Token justification: NONE needed — this utility sets no color/font/spacing token (it is purely the canonical screen-reader-only clip pattern). It introduces no brand surface. This is the "one-line token-free visually-hidden class" the pick calls for; it is obviously-correct from the code (standard pattern).
NO new @theme tokens. NO new colors/fonts. The visible progress/error text keeps its existing classes/tokens verbatim.

I18N (new keys — must land in ALL 9 catalogs or catalogs.test.ts:18 fails)
Add ONE new key (reuse triage.showing for the count message). a11y.diagnosisReady as a PLURAL entry (PluralForm supported, index.ts:37-46,117-119), $count="n", carrying {n} in both forms:
  en.json: "a11y.diagnosisReady": { "$count": "n", "one": "Diagnosis ready. {n} problem found.", "other": "Diagnosis ready. {n} problems found." }
  For n===0 Intl.PluralRules('en') selects "other" → "Diagnosis ready. 0 problems found." That is honest but clunky; OPTIONAL polish: add "zero": "Diagnosis ready. No problems found." (PluralForm.zero is supported; en/most locales won't select 'zero' via CLDR for 0, so to actually surface it, pass n and let the formatter branch — simpler: keep ONLY one/other and accept "0 problems found." which is unambiguous and honest). DECISION: ship one/other only (deterministic, no locale-specific zero-category surprises); "0 problems found." is acceptable and matches VerdictBar's allClear semantics without fabricating.
Each of the other 8 catalogs (de/es/fr/hi/it/pt/ru/zh) gets the SAME key as a plural object with at minimum {other} carrying {n} (ru/zh/etc. add their CLDR forms; the drift test only requires same keys + same placeholder token set + an "other" string — catalogs.test.ts:24-27). triage.showing already exists in all 9 (no change).
Guards that auto-catch this: apps/web/test/i18n-app-keys.test.ts staticKeys() scans App.tsx for t('a11y.diagnosisReady') (static literal) → asserts it exists in en (i18n-app-keys.test.ts:76,104). Because announce.ts is NOT in appSrc, the t('a11y.diagnosisReady') call MUST appear as a literal somewhere scanned — it will, since LiveRegion is inline in App.tsx and we pass the literal there OR add a one-line "// i18n: t('a11y.diagnosisReady')" is NOT enough (regex needs t('...')). MAINTENANCE NOTE: ensure the literal t('a11y.diagnosisReady') textually appears in App.tsx (it will, via the useEffect calling analysisReadyMessage — but that call passes the key indirectly through announce.ts). CORRECTION (load-bearing): since the actual t('a11y.diagnosisReady') call lives in announce.ts (NOT scanned), the i18n-app-keys guard would MISS it. Two honest options: (A) add announce.ts to appSrc in i18n-app-keys.test.ts (one-line edit, mirrors the FilmViewer/VerdictBar precedent at lines 31-49) — PREFERRED; or (B) also add the key to the explicit hard-coded list (i18n-app-keys.test.ts:108-134). Ship BOTH for belt-and-suspenders: add announce.ts to the scanned set AND add 'a11y.diagnosisReady' to a small new it() block. triage.showing is already pinned (i18n-app-keys.test.ts:126).

PURE UX LOGIC EXTRACTED (Node-testable)
- analysisReadyMessage(tally, t) — apps/web/src/lib/announce.ts. Asserts it calls t with key 'a11y.diagnosisReady' and {n: crit+warn+info}; asserts it does NOT count tally.ok / cleanAssetCount (honesty: clean is not a "problem"). Test with a fake t = (k,p)=>`${k}:${JSON.stringify(p)}`.
- resultCountMessage(shown, total, t) — same file. Asserts key 'triage.showing' and {n,m} passthrough; asserts no rounding/derivation (numbers passed straight through).
Both pure, deterministic, no Date/Math.random/DOM.

ARIA / KEYBOARD / REDUCED-MOTION / CONTRAST
- ARIA roles: progress <p> → role="status" aria-live="polite" aria-atomic="true" (atomic so partial progress updates read as one phrase, not just the changed number). Dropzone inner div (App.tsx:451) → aria-busy={analyzing}. Error <p> → role="alert" (assertive, interrupts — correct for a failure). The persistent live region <span> → role="status" aria-live="polite" aria-atomic="true". Use polite for ready/count (non-urgent), assertive only for error.
- The container-first rule: the live-region span is mounted ONCE at App.tsx:300 (top of <main>) and survives the Dropzone↔results swap, so text injected after the swap is reliably announced (mounting a region and its text in the same tick is unreliable in some SRs).
- Keyboard: zero change — no new focusable elements, no focus moves (announcements must not steal focus). The existing tab order (open button → language switcher → ledger controls) is untouched.
- Reduced-motion: live regions are non-visual; no animation involved. The existing @media (prefers-reduced-motion) block (index.css:148-158) is untouched. .ad-sr-only has no animation. Honors the existing reduced-motion contract by omission.
- Contrast: .ad-sr-only is invisible (clip) → no contrast obligation. The visible progress/error text colors are unchanged (existing tokens). Color is NOT the sole signal anywhere new — announcements are TEXT.

HONESTY / INSTANT-WOW / PERF-AT-SCALE
- HONESTY: announces ONLY numbers already on screen — problems = tally.crit+tally.warn+tally.info (identical to VerdictBar.tsx:32), shown/total = rows.length/totalRows (the exact ledger values, App.tsx:183,187). No disk↔VRAM conflation (VRAM is never announced). Error text is the existing phase.message (localized key or raw worker text), nothing fabricated. Clean count is deliberately NOT folded into "problems".
- INSTANT-WOW: announcements are additive attributes + two effects on ALREADY-SETTLED state. The analysis path (run()/runAnalysis/worker, App.tsx:113-138) gains zero work. The ready-announce effect runs once per report identity (same cadence as the existing auto-select at App.tsx:122-127). No new blocking, no new awaits.
- PERF-AT-SCALE (1000+ assets): the count effect keys on [rows.length, totalRows] — two integers that only change after the 150ms search debounce settles (App.tsx:163), so no per-keystroke churn. No iteration over rows. The ledger virtualization (useWindow, win.ref) is completely untouched. One DOM text node updated occasionally — negligible.

DETERMINISM
- Pure formatters: same inputs → same string (no Date/random). Tested directly.
- Identical-string re-announce: typing search that lands on the same shown/total (e.g. clearing then re-typing) yields an identical string; SRs may not re-announce an unchanged textContent. Use a deterministic monotonic counter appended as an aria-hidden zero-width suffix is brittle; INSTEAD store the live message in state as {text, seq} where seq increments each emit, and set key={seq} on the span’s text via a wrapping element is overkill. SIMPLEST deterministic fix: when the new text equals the current, append a single trailing NBSP toggle (alternate "" / " ") so textContent differs by one invisible char — deterministic given a boolean toggle in state. This is invisible (SR ignores trailing NBSP semantically; visually clipped anyway) and deterministic. Keep this logic OUT of the pure formatter (it is a region concern), so the formatters stay pure-string-equal-testable.

EDGE CASES
- 0 assets: report.assets.length===0 && index.rows.length===0 path (App.tsx:312-313) shows t('report.noAssets'); the ready effect still fires analysisReadyMessage(tally) → tally all 0 → "Diagnosis ready. 0 problems found." Honest. (Optionally suppress when there are literally no assets and instead announce report.noAssets — but simpler/honest to announce 0 problems; both acceptable, ship the 0-problems form for one code path.)
- 1 problem: plural "one" → "1 problem found." (singular grammar correct).
- 1000+ assets: only integers announced; no perf cost (see above).
- No selection / orphan reselect: the announcer does NOT depend on selection; the auto-reselect effect (App.tsx:243-249) is unrelated. No double-announce on probe re-set: the ready effect keys on report IDENTITY guarded like auto-select — but the probe re-set creates a NEW report object (App.tsx:137). MUST key the ready announce on the SAME guard pattern as autoSelectedFor (App.tsx:79,126) so the probe write-back does NOT re-announce "diagnosis ready". CORRECTION (load-bearing): key the ready effect on a ref mirroring autoSelectedFor — announce only when report changed AND it is a fresh analysis (not the probe re-set). Concretely: in the run() success path right after setPhase({t:'done'}) (App.tsx:127) is the cleanest single trigger point — emit the ready message imperatively there (it runs exactly once per analysis, never on the probe re-set), rather than via a report-keyed effect. This is more deterministic than a useEffect and avoids the probe double-fire entirely.
- Long i18n strings (de/ru/hi): the live region is visually clipped (.ad-sr-only) → zero layout impact regardless of length. The visible progress/error text already wraps (existing layout). No new width constraints.
- Error then recovery: role="alert" on the error <p> announces on appear; on a successful re-drop the error <p> unmounts (phase!=='error') and the persistent region announces ready — coherent sequence.
- aria-busy: set on the dropzone inner div only while analyzing; cleared when phase leaves 'analyzing'. (The whole Dropzone unmounts at done, App.tsx:301 — so aria-busy naturally goes away.)

TEST PLAN (real)
Pure unit (Vitest, Node) — apps/web/src/lib/announce.test.ts:
  1. analysisReadyMessage: tally {crit:2,warn:1,info:0,ok:99} → calls fakeT('a11y.diagnosisReady',{n:3}); assert n=3 (NOT 102) — proves ok/clean excluded (honesty).
  2. analysisReadyMessage: all-zero tally → {n:0}.
  3. analysisReadyMessage: single-problem tally {crit:1,warn:0,info:0,ok:0} → {n:1} (singular path exercised via real translate('en',...) in a second assertion → matches /1 problem found/ not /problems/).
  4. resultCountMessage(12,340) → fakeT('triage.showing',{n:12,m:340}); and real translate('en',...) → "showing 12 of 340" (no leftover braces).
  5. resultCountMessage(0,0) → "showing 0 of 0" (no-match honest).
i18n guards (existing, will catch drift automatically):
  6. packages/i18n/test/catalogs.test.ts — add 2 lines asserting translate(loc,'a11y.diagnosisReady',{n:1}) and {n:5} contain no '{' for all 9 locales (mirrors the readout.batched plural assertions at :39-40).
  7. apps/web/test/i18n-app-keys.test.ts — add announce.ts to the scanned appSrc (one line, precedent :31-49) AND a one-line it() pinning 'a11y.diagnosisReady' (precedent :108-134).
Unverifiable-by-test (no React harness — explicit reasoning): the ARIA attribute WIRING (role/aria-live/aria-busy presence on the right elements) and the .ad-sr-only CSS cannot be screenshot- or DOM-asserted here. Mitigation: (a) they are additive, obviously-correct attributes on existing elements; (b) the .ad-sr-only class is the verbatim canonical pattern; (c) manual SR smoke check (VoiceOver/NVDA) noted in the PR as the human verification step. The behavioral DECISIONS (which numbers, which keys, exclusion of clean) are 100% covered by the pure tests above.

ORDERED SMALL-COMMIT BREAKDOWN
1. feat(a11y): pure announce.ts formatters + announce.test.ts (analysisReadyMessage/resultCountMessage). No UI wiring yet. (Green on its own.)
2. i18n: add a11y.diagnosisReady plural to all 9 catalogs + catalogs.test.ts plural assertion + i18n-app-keys.test.ts pin (scan announce.ts + explicit key). (Green; guards prove key parity.)
3. style(a11y): add .ad-sr-only utility to index.css (one block, additive). (No behavior change.)
4. feat(a11y): wire ARIA — progress <p> role=status/aria-live/aria-atomic + aria-busy on dropzone inner div (App.tsx:451,458); error <p> role=alert (App.tsx:475). (Attribute-only.)
5. feat(a11y): mount persistent LiveRegion <span className="ad-sr-only"> at top of <main> (App.tsx:300); emit analysisReadyMessage imperatively right after setPhase({t:'done'}) (App.tsx:127, once-per-analysis, no probe double-fire); add count effect keyed on [rows.length,totalRows] emitting resultCountMessage; include the deterministic identical-string NBSP toggle in region state.
6. (optional) chore: PR note documenting the manual SR smoke-test as the human verification of the un-unit-testable ARIA wiring.

KEY FILE:LINE REFERENCES
apps/web/src/App.tsx:36-40 (Phase type), :112-127 (run() → analyzing→done, the imperative announce point), :163 (debouncedSearch settle), :183/:187-190 (rows/totalRows), :300 (main mount point), :451/:458-462 (progress + aria-busy target), :475 (error p). apps/web/src/components/TriageLedger.tsx:260-262 (showing div). apps/web/src/components/VerdictBar.tsx:32 (problemCount formula to mirror). apps/web/src/lib/triage.ts:63-75 (tally/cleanAssetCount). apps/web/src/index.css:131/148-158 (insert point + reduced-motion block). packages/i18n/src/catalogs/en.json:71 (triage.showing reuse), :57-58 (triage.verdict/allClear sibling area for the new a11y key). packages/i18n/src/index.ts:37-46,117-119 (PluralForm support). packages/i18n/test/catalogs.test.ts:18-29 (key/placeholder drift guard). apps/web/test/i18n-app-keys.test.ts:28-49,104,126 (scan set + pins).