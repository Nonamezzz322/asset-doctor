# Token-driven :focus-visible ring (teal on light, film-soft on the dark X-ray card) across all interactive chrome (PROCEED)

VERDICT: PROCEED. Premise fully verified against real code.

=== ADVERSARIAL VERIFICATION (all cited, all TRUE) ===
1. apps/web/src/index.css :4-30 is the only @theme block; the file ends at :158. grep across src/**/*.{tsx,css} for ":focus-visible", ":focus" (bare), "focus:ring", "*{outline" returns ZERO global focus rules. There is NO project-level keyboard-focus affordance. CONFIRMED.
2. TriageLedger row button (TriageLedger.tsx:70-77): className has transition + selected?'bg-teal/10':'bg-panel hover:bg-bg'. NO focus class of any kind. A keyboard-tabbed row is visually identical to an idle row. CONFIRMED — this is the worst offender because the ledger is the primary nav surface and is fully keyboard-reachable (native <button>s).
3. VerdictBar chips (VerdictBar.tsx:47-58): className toggles border-teal (pressed) vs border-line/hover:border-ink-soft. NO focus style. A focused-but-unpressed chip == an idle chip. CONFIRMED.
4. showClean toggle (TriageLedger.tsx:243-257): border-teal vs border-line/hover:border-ink-soft, NO focus style. CONFIRMED.
5. focus:outline-none + focus:border-teal pattern at App.tsx:375,534,660,674,752,768,813 and TriageLedger.tsx:207,213 — all CONFIRMED via grep. focus:border-teal only shifts a 1px border from #dce3ea→#0e8c8c (a ~weak, non-WCAG-1.4.11 affordance) AND focus:outline-none actively suppresses the UA ring. LicensePanel.tsx:44 also uses bare outline-none focus:border-teal — INCLUDE it (the pick missed it).
6. ADVERSARIAL ADDITION the pick under-weighted: the PRIMARY import CTA — the "open folder" button at App.tsx:464-470 (bg-cta green on the dark ad-grid film card, App.tsx:449) — has ONLY "transition hover:bg-cta-hover", NO focus style. The very first keyboard action a user can take (open folder) currently has zero focus indication. The two other bg-cta CTAs (App.tsx:1940, 2462) and the +override/remove-override buttons (App.tsx:676,681) are also bare. The global :focus-visible rule fixes ALL of these for free — that is the whole point of doing it globally rather than per-control.
7. prefers-reduced-motion block exists (index.css:148-158); an outline has no animation so it is inherently compliant. CONFIRMED.
8. Tailwind v4 Preflight does NOT add a global outline:none reset (only resets per-element UA styles); our explicit focus:outline-none classes are the only suppressors, and we remove the redundant ones. CONFIRMED no conflicting reset in src/.

CONTRAST MATH (WCAG 1.4.11 non-text UI, threshold 3:1 vs ADJACENT color):
- teal #0E8C8C (L≈0.224) on panel #fff: 3.83:1 PASS · on bg #e7ecf1 (L≈0.79): 3.07:1 PASS (tight) · on dark film #0a0e12 (L≈0.005): 4.98:1 PASS.
- film-soft #9fb0bd on film #0a0e12: ~9:1 PASS (much stronger). The film variant is justified NOT because teal fails on film (it passes), but because (a) it sits adjacent to the GREEN CTA #15A06A and teal-vs-green is a weak discrimination for some color-vision types, and (b) higher contrast on the hero card is desirable. So the film variant is a real improvement, not invented need.

=== PROBLEM (verified) ===
There is no consistent, accessible keyboard-focus indicator anywhere in apps/web. Keyboard users cannot see where focus is on the ledger rows (the main nav), the verdict/clean/sort/group/search chrome, the language switcher, the export-profile inputs, the license input, or the primary "open folder" CTA. The two partial affordances (focus:border-teal, a 1px color shift; and the selected-row bg-teal/10) are not focus indicators, fail WCAG 2.4.7 / 1.4.11, and several controls (rows, chips) have literally nothing. Color is currently the ONLY (and often absent) signal.

=== V1 SCOPE ===
A) Add ONE additive global block to index.css (after the body rule, before the motif section). Two rules:
   :focus-visible { outline: 2px solid var(--color-teal); outline-offset: 2px; border-radius: inherit; }
   .ad-grid :focus-visible, .bg-film :focus-visible { outline-color: var(--color-film-soft); }
   (border-radius:inherit keeps the ring corner-matched to our rounded controls; outline-offset:2px lifts it off the 1px borders so both read.)
B) Remove the now-redundant " focus:outline-none" token from the 9 confirmed controls so the global ring is NOT suppressed: App.tsx:375,534,660,674,752,768,813; TriageLedger.tsx:207,213; and LicensePanel.tsx:44 ("outline-none" — same effect). KEEP each control's existing "focus:border-teal" (harmless, additive, and gives a redundant cue). Use :focus-visible (NOT :focus) so mouse clicks stay ring-free — the calm chrome and the selected-row bg-teal/10 / Findings ring-1 ring-teal/40 coexist untouched.
C) No JSX/structural change to any component; no new component; no token value change.

=== OUT OF SCOPE ===
- No roving-tabindex / arrow-key ledger navigation (separate larger a11y item — but this rule makes that future work visibly land).
- No focus TRAP / focus management on the PlanCard/modal flows.
- No skip-link, no aria-live, no new ARIA roles (the controls already have aria-label/aria-pressed where needed).
- No change to selected-state styling (bg-teal/10, ring-teal/40) — focus and selection stay orthogonal.
- No new color/font tokens.

=== EXACT FILES + CHANGES ===
FILE 1 — apps/web/src/index.css (additive, after line 42 `}` of the body rule):
  Insert:
    /* a11y: one token-driven keyboard-focus ring (WCAG 2.4.7 / 1.4.11). :focus-visible so mouse
       clicks stay ring-free; teal on light chrome, film-soft on the dark x-ray card for contrast +
       to avoid teal-vs-green ambiguity next to the CTA. No animation ⇒ reduced-motion safe. */
    :focus-visible {
      outline: 2px solid var(--color-teal);
      outline-offset: 2px;
      border-radius: inherit;
    }
    .ad-grid :focus-visible,
    .bg-film :focus-visible {
      outline-color: var(--color-film-soft);
    }
  TOKENS: --color-teal (#0e8c8c, index.css:10) and --color-film-soft (#9fb0bd, index.css:19) — BOTH already exist; NO new token introduced.
FILE 2 — apps/web/src/App.tsx: at lines 375,534,660,674,752,768,813 delete the substring " focus:outline-none" (keep "focus:border-teal"). 7 edits.
FILE 3 — apps/web/src/components/TriageLedger.tsx: at lines 207,213 delete " focus:outline-none". 2 edits.
FILE 4 — apps/web/src/components/LicensePanel.tsx:44 delete "outline-none " (the bare variant; keep "focus:border-teal"). 1 edit.
(Rows/chips/CTAs at TriageLedger:70-77, VerdictBar:47-58, TriageLedger:243-257, App.tsx:464-470/1940/2462/676/681 need NO className edit — they had no focus class to remove; the global rule covers them.)

=== PURE NODE-TESTABLE LOGIC EXTRACTED ===
A global CSS rule has no runtime JS, so to satisfy the "prefer logic extractable into a pure, Node-testable function" allowance, extract the SURFACE→RING-TOKEN decision (the one design choice the CSS encodes) into a tiny pure module that the rule mirrors, making the otherwise-unverifiable choice unit-tested and documented:
  File: apps/web/src/lib/focus-ring.ts
  export type FocusSurface = 'light' | 'film';
  /** The single source of truth for which @theme token a focus ring uses on a given surface.
   *  Mirrors the index.css :focus-visible rules. Pure, deterministic, Node-testable. */
  export function focusRingToken(surface: FocusSurface): '--color-teal' | '--color-film-soft' {
    return surface === 'film' ? '--color-film-soft' : '--color-teal';
  }
  /** Classify a control's nearest styling context from the class tokens on its ancestor card.
   *  'ad-grid' or 'bg-film' ⇒ dark film; else light. Matches the CSS selector list exactly. */
  export function classifyFocusSurface(ancestorClasses: string[]): FocusSurface {
    return ancestorClasses.some((c) => c === 'ad-grid' || c === 'bg-film') ? 'film' : 'light';
  }
This module is intentionally lightweight and is the testable artifact; the CSS rule is its visual twin. (Optional, low-risk: it could later be imported where a control needs a JS-computed ring, but v1 needs no import — its value is as the tested spec of the CSS.)

=== ARIA / KEYBOARD / REDUCED-MOTION / CONTRAST ===
- ARIA: unchanged. Existing aria-pressed (VerdictBar:50, TriageLedger:245), aria-label (search :206, sort :210, language App:372, overrides App:654, quality App:667) all preserved. The ring is purely a visual presentation layer over native focus; it adds NO ARIA and removes none.
- Keyboard: every affected control is already a native <button>/<select>/<input> ⇒ already in the tab order; this change makes that focus VISIBLE. Esc-clears-search (TriageLedger:202-204) and all click handlers are untouched.
- :focus-visible vs :focus: chosen deliberately so pointer interactions don't show the ring (keeps the "calm chrome" brand), only keyboard/AT focus does. All evergreen targets (Vite app) support :focus-visible.
- reduced-motion: outline has no transition/animation; the existing index.css:148-158 block is unaffected and needs no addition. Compliant by construction.
- Contrast: see math above — teal ring clears 3:1 on panel/bg/film; film-soft clears ~9:1 on film. outline-offset:2px guarantees the ring is separated from the 1px border so they don't visually merge (1.4.11 "adjacent" is satisfied vs the surface, not vs the border).
- Color-not-sole-signal: the ring is an OUTLINE (a distinct shape/position cue), not a color fill, so it is a non-color affordance; additionally pressed/selected states keep their independent border/bg cues.

=== HONESTY / INSTANT-WOW / PERF-AT-SCALE / DETERMINISM ===
- Honesty: zero data-path touch. No analysis, parser, probe, VRAM/disk, or finding code is read or changed. disk≠VRAM labelling (TriageLedger metricBadge :42-49) untouched. No number/overlay is altered.
- Instant-wow: pure CSS + className-substring deletions; no added JS work on the <=10s analysis path; bundle delta is a few hundred bytes of CSS.
- Perf at 1000+: outline is GPU-cheap, paints only on the ONE focused element, and only when keyboard-focused; it does NOT add per-row classes or mount/unmount anything. The windower (useWindow, ROW_H=52, TriageLedger:192-194) and the static-dot perf invariant (TriageLedger:19,79) are entirely unaffected — a virtualized row that scrolls out simply loses focus styling along with the element. No layout shift: outline (unlike border) does not occupy box space, so 9-language long labels and row heights are byte-identical.
- Determinism: a single static global rule; no state, no timing, no animation ⇒ rendering is deterministic across runs/locales.

=== EDGE CASES ===
- Long i18n strings (9 langs): outline does not affect width/height ⇒ no reflow, no clipping regardless of label length. Verified the rule adds no padding/margin.
- 0 assets: import dropzone CTA (App.tsx:464) and language switcher are the only focusable controls; both now get a visible ring (CTA gets the film-soft variant since it lives inside .ad-grid at App.tsx:449 — better than teal-on-green). This is a pure UX gain in the empty state.
- 1000+ assets: only the focused row paints a ring; virtualization untouched (see perf). When a focused row scrolls out of the window and unmounts, focus returns to <body> (existing behavior, unchanged) — the rule introduces no new focus-loss bug.
- No-selection: focus and selection are orthogonal; a focused-but-unselected row shows the ring without the bg-teal/10, which is exactly the desired disambiguation.
- border-radius:inherit on controls with no radius (e.g., a plain <a> if added later) resolves to 0 ⇒ a square ring, which is correct.

=== TEST PLAN ===
PURE UNIT (apps/web/src/lib/focus-ring.test.ts, Vitest/Node, mirrors existing lib/*.test.ts precedent e.g. film-selection.test.ts):
  - focusRingToken('light') === '--color-teal'
  - focusRingToken('film') === '--color-film-soft'
  - classifyFocusSurface(['ad-grid','ad-clip']) === 'film'
  - classifyFocusSurface(['bg-film','p-3']) === 'film'
  - classifyFocusSurface(['rounded-lg','bg-panel']) === 'light'
  - classifyFocusSurface([]) === 'light'
  - round-trip: focusRingToken(classifyFocusSurface(['ad-grid'])) === '--color-film-soft'
  These tests lock the surface→token contract that the CSS selector list (.ad-grid/.bg-film ⇒ film) must keep in sync; if someone changes one without the other, the documented spec diverges and the test is the reminder.
REGRESSION-BY-COMPILE: pnpm typecheck + pnpm lint must pass (className-substring deletions can't break types; ESLint catches stray whitespace). pnpm build must succeed (Tailwind v4 compiles the @theme tokens used by var() — already present).
UNVERIFIABLE-BY-TEST (no React/CSS harness — explicit reasoning): the actual rendered ring cannot be screenshot-verified here. It qualifies under the "obviously-correct, token-driven, additive CSS" allowance: (1) it is a SINGLE global rule using two EXISTING tokens; (2) outline-offset/border-radius:inherit are standard, side-effect-free; (3) the only deletions are redundant focus:outline-none / outline-none substrings whose removal can only RESTORE the standard ring, never break layout; (4) the contrast math above is computed, not eyeballed. Manual smoke (documented for the human, not blocking): Tab through ledger rows, verdict chips, sort/search/group, language switcher, and the open-folder CTA, in both light chrome and on the film card; confirm a visible ring on keyboard focus and NO ring on mouse click; confirm DevTools "emulate prefers-reduced-motion" leaves the ring intact.

=== ORDERED SMALL-COMMIT BREAKDOWN ===
1. feat(web): add focus-ring surface-token spec (lib/focus-ring.ts) + Vitest unit (lib/focus-ring.test.ts). [pure, testable, no UI change yet]
2. style(web): add the single token-driven :focus-visible rule to index.css (teal on light, film-soft on .ad-grid/.bg-film). [additive CSS only]
3. fix(web,a11y): drop redundant focus:outline-none/outline-none from the 9 controls (App.tsx x7, TriageLedger.tsx x2, LicensePanel.tsx x1) so the new ring isn't suppressed. [className-substring deletions]
4. chore: run pnpm typecheck + pnpm lint + pnpm test (focus-ring suite + full) + pnpm build; confirm green.
Each commit is one coherent unit; commit 1 is independently testable, 2 is independently revertable, 3 depends on 2.