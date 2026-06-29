# Determinate progress bar for the analyzing state (reduced-motion-safe indeterminate fallback) (PROCEED)

PREMISE — VERIFIED AGAINST REAL CODE (PROCEED)

Every claim in the brief checks out against the source:
- The worker emits a REAL determinate Progress. `interface Progress { done; total; label }` at apps/web/src/lib/worker-client.ts:6-10; populated from genuine worker `progress` messages at worker-client.ts:35-37 (not a fabricated timer).
- It is plumbed into the phase as `{ t: 'analyzing'; progress?: Progress }` (App.tsx:43) via `setPhase({ t: 'analyzing', progress: p })` (App.tsx:135).
- It renders ONLY as text — the `<p role="status" aria-live="polite">` at App.tsx:566-569 interpolates `dropzone.progress` and nothing else. No bar.
- `grep` for `progressbar|aria-valuenow|aria-valuemin|aria-valuemax` over apps/web/src returns NOTHING — confirmed no progressbar role anywhere.
- The sole motion is `.ad-scanline` (App.tsx:560), defined at index.css:148-159 and forced `display:none !important` under `prefers-reduced-motion: reduce` (index.css:184-186). So reduced-motion users currently get ZERO visual progress cue — only the SR text. Sighted-reduced-motion users (vestibular sensitivity, common) are unserved. Real gap.
- `dropzone.progress` = `"{done}/{total} · {label}"` exists in ALL 9 catalogs (en.json:47, plus ru/de/es/pt/fr/it/zh/hi at line 32). The `label` is reusable for the bar — NO new i18n key required.
- Tokens exist in @theme: `--color-teal` #0e8c8c (index.css:10), `--color-cta` #15a06a (index.css:11), `--color-film-border` #1b2530 (index.css:18). Track/fill can be built additively from these — no new color token.

PROBLEM (cited)
Real progress data exists but is invisible as a bar: sighted users get a text count, SR users get a live region, and reduced-motion users get neither a moving scanline nor a meaningful position indicator. The accessibility tree has no machine-readable progress (`role=progressbar`), so AT can't expose a position slider/percentage. A thin determinate bar fixes all three at once and is reduced-motion-safe BY CONSTRUCTION (a static fill width is not an animation).

V1 SCOPE
1. New PURE module apps/web/src/lib/progress-view.ts:
   `export interface ProgressView { determinate: boolean; pct: number; valueNow?: number; valueMax?: number; }`
   `export function progressView(p?: { done: number; total: number }): ProgressView`
   Semantics (deterministic, total-ordered branch logic):
   - `undefined` p, OR `total <= 0`, OR non-finite done/total → `{ determinate: false, pct: 0 }` (indeterminate; no valueNow/valueMax — AT exposes a busy/indeterminate progressbar).
   - valid: `done` clamped to `[0, total]` (handles done>total and done<0); `pct = round100(clampedDone / total * 100)` where round100 clamps to integer 0..100; `{ determinate: true, pct, valueNow: clampedDone, valueMax: total }`.
   - `pct` is always finite 0..100 even in indeterminate (returns 0) so the renderer can blindly set width.
2. Render inside the existing `analyzing` branch (App.tsx:562-569), ABOVE or BELOW the existing `<p>` (keep the `<p>` exactly as-is — it stays the visible+SR text and the aria-live region). Add a thin bar:
   - Outer track: `<div className="ad-progress-track" role="progressbar" aria-valuemin={0} aria-label={t('dropzone.analyzing')} {...(view.determinate ? { 'aria-valuenow': view.valueNow, 'aria-valuemax': view.valueMax } : {})}>`. (Omitting valuenow/valuemax is the standard ARIA signal for an indeterminate progressbar.)
   - Inner fill: `<div className="ad-progress-fill" style={{ width: view.pct + '%' }} aria-hidden="true" />` for the determinate case.
   - Indeterminate (`!view.determinate`): render the track with class `ad-progress-track ad-progress-indet` and NO inline-width fill — CSS draws a static dashed track; any sweep animation is gated behind a non-reduced-motion media query exactly like the scanline.
   - `view` computed via `const view = progressView(phase.progress)` in the Dropzone component body (phase is already in scope at App.tsx:521,527).
3. CSS in index.css (additive, token-driven):
   - `.ad-progress-track { position: relative; height: 4px; width: 100%; max-width: 220px; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, var(--color-film-border) 70%, transparent); }` (the film-border track on the dark dropzone film surface). 4px ≈ existing 3px scanline weight; calm.
   - `.ad-progress-fill { height: 100%; background: linear-gradient(90deg, var(--color-teal), var(--color-cta)); border-radius: 999px; transition: width 180ms ease; }` — width transition is a layout-property transition, not a keyframe loop; gate it off under reduced-motion to be strict (see below) so the fill snaps.
   - `.ad-progress-indet { background: repeating-linear-gradient(90deg, var(--color-film-border) 0 6px, transparent 6px 12px); }` — STATIC dashed track (the brief's required non-animated fallback).
   - Optional indeterminate sweep `.ad-progress-indet::after { ... animation: ad-progress-sweep 1.4s linear infinite; }` placed ENTIRELY inside a `@media (prefers-reduced-motion: no-preference)` block (or added to the existing reduce-block with `animation:none`), mirroring the scanline gating at index.css:177-187. Under reduce: no sweep, just the static dash.
   - Add to the reduce media block: `.ad-progress-fill { transition: none !important; }` and `.ad-progress-indet::after { animation: none !important; }`.

OUT OF SCOPE
- The Pro/fix progress (FixPhase 'running', App.tsx:2032-2033) — different phase, separate follow-up; do not touch.
- Any percentage TEXT (the existing `{done}/{total}` text already carries the count; adding "%" would be a new string in 9 catalogs and duplicate info). No copy change.
- Changing/removing the scanline, the aria-live `<p>`, or `aria-busy` (App.tsx:555).
- Estimated-time / ETA (would require fabricating a rate — violates honesty).
- Worker protocol or any analysis-path change (instant-wow protected — this is render-only).

PURE FUNCTION (Node-testable)
`progressView(p?: { done; total }) : ProgressView` in apps/web/src/lib/progress-view.ts. Pure, no DOM, no React — same shape as totals-rows.ts / ledger-nav.ts / focus-ring.ts. The component only maps its output to className/style/ARIA attrs.

ARIA / KEYBOARD / REDUCED-MOTION / CONTRAST / COLOR-NOT-SOLE-SIGNAL
- ARIA: `role="progressbar"` + `aria-valuemin=0`; determinate adds `aria-valuenow`/`aria-valuemax` (omitted when indeterminate — canonical busy signal). `aria-label` = localized `dropzone.analyzing` so the bar is self-describing; the bar lives inside the region already marked `aria-busy` (App.tsx:555). The fill is `aria-hidden` (decorative; the progressbar role + values are the truth).
- Keyboard: progress is non-interactive — no tab stop, no focus, no keyboard handlers. Does not enter the tab order; useWindow/ledger keyboard nav untouched.
- Color-not-sole-signal: progress is NOT conveyed by color alone — the existing numeric `{done}/{total}` text remains the primary cue; the bar + ARIA valuenow are redundant encodings.
- Reduced-motion: determinate fill is a STATIC width (correct by construction). Width `transition` and the optional indeterminate sweep are BOTH disabled under `prefers-reduced-motion: reduce`, mirroring the scanline pattern at index.css:177-187. Reduced-motion users now get a meaningful static bar — strictly better than today's nothing.
- Contrast: teal→cta fill on a film-border/dark track is the same palette as the heavily-used film viewer; bar is decorative redundancy so WCAG non-text-contrast 3:1 is comfortably met by teal #0e8c8c / cta #15a06a against the dark track.

HONESTY / INSTANT-WOW / PERF-AT-SCALE / DETERMINISM
- Honesty: width reflects the worker's REAL done/total only; indeterminate when total is unknown (never a fake crawl). No disk/VRAM data involved — orthogonal to the disk≠VRAM invariant.
- Instant-wow: render-only inside an already-rendering branch; zero added work on the analysis path; the bar appears the instant the first progress message arrives (App.tsx:135). No <=10s regression.
- Perf-at-scale: the bar is ONE div in the Dropzone, which UNMOUNTS at phase 'done' (App.tsx:359 — Dropzone only renders when `phase.t !== 'done'`). It never coexists with the TriageLedger/useWindow virtualization. Zero impact on 1000+ asset rendering.
- Determinism: `progressView` is a pure function of its input — same input → same output; fully unit-testable.

EDGE CASES
- 0 assets / total<=0: indeterminate fallback (static dashed track, no valuenow). 
- 1 asset: total=1, done 0→1 → pct 0 then 100; bar fills once. Fine.
- 1000+ assets: pct is integer-rounded so width updates are coarse/cheap; React re-renders are driven by the same progress messages that already setPhase today (no new render cadence).
- done>total (late/duplicate message): clamped to total → pct 100, never overflows the track (overflow:hidden also guards visually).
- No-selection / idle / error phases: Dropzone shows the open button or error `<p>` — the bar only exists under `analyzing`, so untouched.
- Long i18n labels: the `{label}` lives in the existing `<p>` (already wraps/handles long strings today); the bar has fixed height + `max-width:220px` and `width:100%` so it never stretches with text. RTL-neutral (centered, percentage width).

TEST PLAN
PURE UNIT (apps/web/src/lib/progress-view.test.ts — Vitest/Node, the totals-rows precedent):
- undefined → { determinate:false, pct:0, valueNow undefined, valueMax undefined }
- { done:0, total:0 } → indeterminate (total<=0)
- { done:-5, total:0 } / { done:1, total:-1 } → indeterminate
- { done:0, total:100 } → { determinate:true, pct:0, valueNow:0, valueMax:100 }
- { done:50, total:100 } → pct:50
- { done:100, total:100 } → pct:100
- { done:1, total:3 } → pct:33 (rounding pinned)
- { done:200, total:100 } → clamped pct:100, valueNow:100 (done>total)
- { done:-3, total:100 } → clamped pct:0, valueNow:0
- NaN/Infinity in done or total → indeterminate (finiteness guard)
- pct is ALWAYS integer 0..100 across all branches (property-style loop).
i18n-CONTRACT: extend apps/web/test/i18n-app-keys.test.ts pattern only if a new key were added — it is NOT, so just assert `dropzone.analyzing` (used as aria-label) and `dropzone.progress` remain present (already covered by existing catalog-key tests).
UNVERIFIABLE-BY-UNIT (explicit reasoning): the JSX wiring (className strings, role/aria attribute names, style.width, the reduce-media gating) cannot be asserted — apps/web has NO React component harness (Vitest=Node), confirmed: tests are Node-only and there's no jsdom render setup. Mitigation per precedent (focus-ring/totals-rows): keep ALL branchable logic in the pure fn (fully tested), keep the JSX a thin obvious map, and verify the visual/ARIA result manually via `pnpm dev` with (a) DevTools accessibility tree showing role=progressbar + aria-valuenow advancing, (b) emulated prefers-reduced-motion confirming static fill + dashed indeterminate, (c) axe/Lighthouse a11y pass. Note this manual step explicitly in the PR.

TOKEN CHANGES
None new. Reuse --color-teal, --color-cta, --color-film-border via color-mix/gradient. (Justification for NO new token: a progress accent is a derived/decorative use of the existing brand teal→cta gradient already established by the FilmViewer; introducing a token would be premature and violate the additive/reuse constraint.)

ORDERED SMALL-COMMIT TASK BREAKDOWN
1. feat(web): add pure progressView() in apps/web/src/lib/progress-view.ts (no consumers yet).
2. test(web): apps/web/src/lib/progress-view.test.ts — full edge-case table above. `pnpm --filter web test` green.
3. feat(web): index.css — additive .ad-progress-track/.ad-progress-fill/.ad-progress-indet + (optional) ad-progress-sweep keyframe gated under no-preference; extend the existing reduce media block (index.css:177-187) with the transition/animation kills.
4. feat(web): render the bar in App.tsx analyzing branch (App.tsx:562-569) using progressView(phase.progress) with role=progressbar + conditional aria-valuenow/valuemax + aria-label; keep the existing <p> live region byte-for-byte.
5. chore: `pnpm typecheck` + `pnpm lint`; manual a11y verification (reduced-motion + accessibility tree + axe) noted in PR body.

ADVERSARIAL CORRECTIONS FOLDED IN
- Made the indeterminate fallback a STATIC dashed track (not merely a hidden animation) so reduced-motion users see a real cue, and gated any sweep behind no-preference — exactly the scanline precedent, satisfying the brief's hard requirement.
- Omitted aria-valuenow/valuemax (rather than setting 0) in the indeterminate case, which is the spec-correct way to expose an indeterminate progressbar to AT.
- Clamped BOTH directions (done<0 and done>total) and added a finiteness guard, since worker messages are external input.
- Disabled the width transition under reduced-motion too (strict), so the determinate fill is provably non-animated.
- No new i18n string (reuse dropzone.progress label + dropzone.analyzing for aria-label), avoiding a 9-catalog edit and keeping the change minimal.
- Confirmed the bar can never coexist with useWindow (Dropzone unmounts at phase 'done', App.tsx:359), so perf-at-scale is structurally guaranteed, not just asserted.