# UX-4 Design: Orientation skeleton — named landmarks + skip link + focus moves on view swaps

**VERDICT: PROCEED.**
Premise independently re-verified at HEAD (`4512c48`), all claims confirmed, zero contradictions.
Slug: `landmarks-skip-focus-skeleton` · Lens: navigation · Merge of candidates 7+6.

---

## 1. Verified premise (re-checked at HEAD, file:line citations)

All paths relative to repo root `/home/nonamezzz/Рабочий стол/projects`. The working tree is
mid-edit ONLY in `apps/web/src/lib/{build-config,optimize-entry,build-settings,route}*` and
`packages/fix/` — **`App.tsx`, `index.css`, `index.html`, and all components are clean at HEAD**,
so HEAD == tree for every surface this design touches.

1. **Zero landmark structure beyond banner+main.** Repo-wide grep of `apps/web/src` +
   `apps/web/index.html`: zero `<nav>`, zero `<footer>`, zero `contentinfo`, zero skip-link
   (every "skip" hit is `fix.skipped.*` copy). `apps/web/index.html` body is a bare
   `<div id="root">`. The AOM exposes exactly two landmarks: `<header>` (banner) at
   `apps/web/src/App.tsx:320` and `<main>` at `App.tsx:350`.
2. **Three unnamed sectioning elements.** The results triage `<section>` at `App.tsx:398`
   (`grid items-start gap-6 lg:grid-cols-[1fr_minmax(320px,420px)]`), the detail `<aside>` at
   `App.tsx:416` (`space-y-3 lg:sticky lg:top-20`), and the Dropzone `<section>` at `App.tsx:540`
   (`mx-auto max-w-3xl`) — none has an accessible name; none surfaces in a SR landmark/region list.
3. **Zero programmatic focus management.** `grep '\.focus(' apps/web/src` → 0 hits. `grep tabIndex`
   → 0 hits in any `.tsx`. The sole programmatic navigation is `scrollIntoView` at `App.tsx:435`
   (optimize-entry anchor). Every phase swap unmounts the focused control:
   - Dropzone renders only while `phase.t !== 'done'` (`App.tsx:361`); results only at
     `phase.t === 'done'` (`App.tsx:369`).
   - The CTA "open folder" button lives in the `analyzing ? … : <button>` ternary
     (`App.tsx:573-603`) — it unmounts the instant analysis starts.
   - "Analyze another" (`App.tsx:442-448`) sets `phase {t:'idle'}` and thereby unmounts itself.
   - Result: keyboard/SR focus is dropped to `<body>` at the exact ≤10s payoff moment (invariant 4's
     audience minus keyboard users).
4. **The sr-only results `<h1>`** (`App.tsx:377`, class `ad-sr-only`) has no `id`, no `tabIndex`,
   no ref. `.ad-sr-only` is `position:absolute` + 1px clip at `apps/web/src/index.css:208-218` —
   focusing it scrolls to the top of its container (desired).
5. **Focus-ring tokens exist** (`index.css:47-55`): global `:focus-visible` teal ring; film-soft
   override inside `.ad-grid`/`.bg-film`. No `scroll-behavior: smooth` anywhere in `index.css`
   ⇒ programmatic focus scrolling is an instant jump (reduced-motion safe by construction).
6. **The prev-tracking guard precedent** exists: `autoSelectedFor` ref at `App.tsx:90` (stamped at
   `App.tsx:150`) prevents the async probe re-set (new report object, same findings,
   `attachProbeReadings`) from re-running one-shot per-analysis logic.
7. **Contrast fact (measured, WCAG relative-luminance formula):** teal `#0E8C8C` on panel `#FFF` =
   **4.08:1 — below 4.5:1 AA** for normal text. Ink `#16202A` on panel = 16.48:1. ⇒ the skip-link
   pill must be ink-on-panel (teal only as border/ring), not teal text. (Same AA discipline as UX-3.)
8. **Existing per-widget labels are fine and untouched:** the ledger listbox already carries
   `role="listbox"` + `aria-label={t('triage.listLabel')}` (`components/TriageLedger.tsx:369-370`);
   search/sort/language controls all have `aria-label`. The gap is exclusively the LANDMARK level.
9. **In-flight settings page** (uncommitted `apps/web/src/lib/route.ts` + scratchpad
   `settings-page-design.md`): hash router `viewOfHash(hash): 'main'|'settings'`, exact-match
   `'#settings'`, fail-open to `'main'`; main tree stays MOUNTED but `hidden` (UA `display:none`)
   while settings shows; SettingsPage plans its own `h1 tabIndex={-1}` mount-focus effect
   (settings-page-design.md:405) and a header nav `<a href={SETTINGS_HASH}>` (:391). See §10.

**Conclusion:** premise CONFIRMED in full. PROCEED.

---

## 2. v1 scope (what ships)

One structural a11y pass, three deliverables, all in `apps/web` + 2 i18n keys ×9 locales:

- **(A) Skip-to-content link** — the app's first tab stop, visually hidden until keyboard focus,
  revealed as an ink-on-panel pill top-left above the sticky header. Focuses `<main id="ad-main"
  tabIndex={-1}>` WITHOUT touching `location.hash` (hash belongs to the in-flight router).
- **(B) Named landmarks** — the Dropzone section and the results grid section become named regions
  via `aria-labelledby` pointing at their own (existing) headings — zero new strings, names can
  never drift from visible copy. The detail `<aside>` (which is the film-viewer HERO, not
  complementary content) becomes `<section aria-label={t('region.filmDetail')}>` — 1 new key ×9.
- **(C) Focus moves on view swaps** — pure `lib/focus-move.ts` decides
  `(prev, next) → anchor-id | null` for phase AND (forward-compatible) hash-view swaps; one
  `useEffect` in App wires it. `analyzing→done` ⇒ focus the results h1 (which also anchors the
  labelled region); `done→idle` ⇒ focus the Dropzone h1. Probe re-set can never re-fire
  (structurally — see §5). Node tests for every rule.

## 3. Out of scope (explicitly)

- `<nav>` around the header links and the `<footer>`/contentinfo landmark — **owned by the landing
  design** (`landing-design.md`); this design reserves their slot in the landmark map (§6) but does
  not add them, to avoid colliding with the in-flight settings header edit.
- Focus management for `→analyzing` and `→error` transitions. Both already announce (polite
  `role="status"` at `App.tsx:578`; `role="alert"` at `App.tsx:610`); moving focus onto a
  progressbar or an alert is non-standard. Documented decision; revisit with backlog pick (a)
  (first-class error state).
- FixCard-internal swaps (plan→receipt etc.) — those happen inside a persistently mounted card
  whose trigger buttons do not unmount; not a view swap.
- Any change to the aria-live announce flow (`lib/announce.ts`, `emitLive`) — announcements stay
  additive to focus, byte-identical.
- The ledger listbox, useWindow, virtualization — untouched.

---

## 4. Exact files and edits

### 4.1 NEW `apps/web/src/lib/focus-move.ts` (pure, zero DOM, zero React)

```ts
// PURE view-swap focus-target decision (no React, no DOM — Node-testable, precedent:
// progress-view.ts / results-heading.ts). Every phase/view swap in App unmounts (or display:none-s)
// the focused control, dropping keyboard/SR focus to <body> at the exact payoff moment. This module
// owns the ONE rule table: which anchor (if any) receives focus after a swap. App.tsx only does
// `getElementById(target)?.focus()`.
//
// View type: import type { View } from './route' once the settings page lands (its contract:
// 'main' | 'settings', fail-open to 'main'). Until then, inline the union — see integration note I1.

export type PhaseT = 'idle' | 'analyzing' | 'done' | 'error';
export interface SwapState {
  view: 'main' | 'settings';
  phase: PhaseT;
}

/** Frozen DOM anchor ids (repo convention: 'ad-' prefix, cf. PROFILE_PANEL_ANCHOR='ad-export-profile').
 *  These are a CONTRACT with App.tsx markup — the test freezes them. */
export const FOCUS_ANCHORS = {
  results: 'ad-results-h1',   // the sr-only results <h1> (App.tsx:377)
  dropzone: 'ad-dropzone-h1', // the Dropzone <h1> (App.tsx:546)
  settings: 'ad-settings-h1', // SettingsPage <h1> (in-flight; unused until it lands)
} as const;
export type FocusAnchor = (typeof FOCUS_ANCHORS)[keyof typeof FOCUS_ANCHORS];

/** Decide the focus target after a state swap. Total + deterministic; null = do not move focus.
 *  RULES (ordered):
 *  1. view changed ⇒ full context change: settings ⇒ its h1; main ⇒ results h1 when a diagnosis
 *     is showing, else the dropzone h1. (Covers the settings→main return, which SettingsPage's own
 *     mount effect can never handle — it is unmounted by then.)
 *  2. view unchanged but 'settings' ⇒ null: the main tree is display:none (hidden wrapper) — its
 *     anchors are unfocusable; a phase flip mid-settings (analysis finishing in the worker) must
 *     not steal focus from the settings page. The live region (outside the wrapper) still speaks.
 *  3. →'done' ⇒ results h1 (the ≤10s payoff lands under the user's cursor, not on <body>).
 *  4. 'done'→'idle' ⇒ dropzone h1 ("analyze another" unmounts itself).
 *  5. everything else (→analyzing, →error, no-op pairs) ⇒ null — those transitions keep an
 *     announcing surface mounted (role=status / role=alert) and moving focus there is non-standard.
 */
export function focusTargetAfterSwap(prev: SwapState, next: SwapState): FocusAnchor | null {
  if (prev.view !== next.view) {
    if (next.view === 'settings') return FOCUS_ANCHORS.settings;
    return next.phase === 'done' ? FOCUS_ANCHORS.results : FOCUS_ANCHORS.dropzone;
  }
  if (next.view === 'settings') return null;
  if (prev.phase === next.phase) return null;
  if (next.phase === 'done') return FOCUS_ANCHORS.results;
  if (prev.phase === 'done' && next.phase === 'idle') return FOCUS_ANCHORS.dropzone;
  return null;
}
```

### 4.2 NEW `apps/web/src/lib/focus-move.test.ts` — see §9.1.

### 4.3 `apps/web/src/App.tsx` — seven surgical edits

1. **Skip link** — FIRST child of the root `<div className="min-h-full bg-bg text-ink">`
   (i.e. inserted at line ~319, BEFORE `<header>` at :320), so it is the first tab stop on every
   view and every phase:

   ```tsx
   {/* a11y: skip-to-content (WCAG 2.4.1) — FIRST tab stop, revealed on keyboard focus (.ad-skip-link).
       preventDefault keeps location.hash untouched: the hash namespace belongs to the settings router
       (lib/route.ts, exact-match '#settings'); a native '#ad-main' jump would clobber a '#settings'
       deep-link and pollute history. Programmatic focus() replaces the native anchor jump. */}
   <a
     href="#ad-main"
     className="ad-skip-link"
     onClick={(e) => {
       e.preventDefault();
       document.getElementById('ad-main')?.focus();
     }}
   >
     {t('a11y.skipToContent')}
   </a>
   ```

   Keep the `href` (it is what makes an `<a>` a focusable link with correct semantics); the
   handler suppresses only the hash mutation. Enter fires `click` on anchors — keyboard-complete.

2. **`<main>` (App.tsx:350)** becomes the skip target:
   `<main id="ad-main" tabIndex={-1} className="ad-focus-anchor mx-auto max-w-6xl px-6 py-10">`.
   Works in BOTH views forever: the settings design renders SettingsPage inside this same `<main>`
   (settings-page-design.md:401-402), so "skip to content" is honest on every screen.

3. **Results h1 (App.tsx:377)**:
   `<h1 id="ad-results-h1" tabIndex={-1} className="ad-sr-only ad-focus-anchor">…</h1>`.
   Triple duty: focus-move target + `aria-labelledby` source for the results region + (unchanged)
   the UX-3 heading-outline anchor. `.ad-sr-only` is `position:absolute` ⇒ still zero layout box.

4. **Results grid section (App.tsx:398)**: add `aria-labelledby="ad-results-h1"`. A `<section>`
   with an accessible name maps to a named `region` landmark; the name is `resultsHeading(...)` =
   "Asset audit results — N problems found" — the SAME honest crit+warn+info count as
   VerdictBar/announce.ts (invariants 3+5 hold in the landmark name for free, and it can never
   drift from the heading). `aria-labelledby` may reference a sibling — the h1 is outside the
   section; that is valid and intended.

5. **Detail aside → section (App.tsx:416)**:
   `<aside className="space-y-3 lg:sticky lg:top-20">` becomes
   `<section aria-label={t('region.filmDetail')} className="space-y-3 lg:sticky lg:top-20">`.
   Rationale: `<aside>` = complementary ("supporting, separable") — dishonest for the film-viewer
   HERO column (CLAUDE.md: "Герой — film-viewer"). Classes verbatim ⇒ `lg:sticky lg:top-20` and
   grid placement (by child order) untouched; children untouched. Verified: no `aside` element
   selector exists in `index.css` (all styling is class-based) — the tag swap is style-inert.

6. **Dropzone h1 (App.tsx:546)**: add `id="ad-dropzone-h1" tabIndex={-1}` and prepend
   `ad-focus-anchor` to its className.
   **Dropzone section (App.tsx:540)**: add `aria-labelledby="ad-dropzone-h1"` — named region
   "Drop an asset folder to diagnose" from the existing visible h1; zero new strings.

7. **Focus-move effect** — next to the other App effects, using the same prev-ref discipline as
   `autoSelectedFor` (App.tsx:90):

   ```tsx
   // a11y: move focus on view swaps (lib/focus-move.ts — pure, tested). Deps are ONLY the swap
   // coordinates (phase.t [+ view once the settings router lands]) — `report` is deliberately NOT a
   // dep, so the async probe re-set (new report object, same phase, attachProbeReadings) can
   // STRUCTURALLY never re-fire this (stronger than the autoSelectedFor guard it mirrors). focus()
   // on the sr-only results h1 scrolls to the results top (position:absolute anchor — desired);
   // the jump is instant (no scroll-behavior:smooth anywhere) ⇒ reduced-motion safe.
   const prevSwap = useRef<SwapState>({ view: 'main', phase: phase.t });
   useEffect(() => {
     const next: SwapState = { view: 'main', phase: phase.t }; // view: literal until #settings lands (I1)
     const target = focusTargetAfterSwap(prevSwap.current, next);
     prevSwap.current = next;
     if (target) document.getElementById(target)?.focus();
   }, [phase.t]);
   ```

   Ordering guarantees: `run()` calls `setReport(rep)` before `setPhase({t:'done'})` in one batch
   (App.tsx:130-152), so the results tree (and `#ad-results-h1`) is committed by the time the
   effect runs. Same for `done→idle`: Dropzone mounts in the same commit. Initial mount: prev is
   initialized to the current state ⇒ rule 5 returns null ⇒ no focus steal on page load (critical:
   the first Tab must land on the skip link, and SRs must start at document top).

### 4.4 `apps/web/src/index.css` — two additions (after the `.ad-sr-only` block, ~line 218)

```css
/* a11y: skip-to-content pill (WCAG 2.4.1) — hidden with the off-screen-transform pattern (NOT
   display:none — it must stay in the tab order), revealed instantly on focus (no transition ⇒
   reduced-motion safe). ink-on-panel = 16.5:1 (AA); teal is border-only here — teal text on panel
   is 4.08:1 and would fail AA (UX-3 discipline). The global :focus-visible teal ring (above)
   supplies the 2.4.7 indicator on the revealed pill. */
.ad-skip-link {
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 100; /* above the sticky header (z-50, App.tsx:320) */
  transform: translateY(calc(-100% - 16px));
  background: var(--color-panel);
  color: var(--color-ink);
  border: 1px solid var(--color-teal);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
}
.ad-skip-link:focus {
  transform: none;
}

/* a11y: programmatic-focus anchors (<main> + the view h1s, all tabIndex=-1). They are NOT
   sequentially focusable, so 2.4.7 does not demand a ring; suppressing it avoids a phantom teal
   outline around the entire <main> after skip-link use / around the hero h1 after a view swap.
   Specificity (0,2,0) beats the global :focus-visible (0,1,0). */
.ad-focus-anchor:focus {
  outline: none;
}
```

**Token changes: NONE.** Both classes reuse existing tokens (`--color-panel/ink/teal`,
`--font-mono`). One new z-index value (100) above the header's z-50, documented inline. No new
colors, no new fonts, no Tailwind theme edits.

### 4.5 `packages/i18n/src/catalogs/*.json` — 2 new keys × 9 locales

| key | en | ru |
|---|---|---|
| `a11y.skipToContent` | `Skip to content` | `Перейти к содержимому` |
| `region.filmDetail` | `Asset detail` | `Детали ассета` |

Remaining 7 (implementer: cross-check each catalog's existing rendering of "asset" and reuse it —
e.g. if `de.json` says "Asset" elsewhere, keep "Asset-Details"):
de `Zum Inhalt springen` / `Asset-Details` · es `Saltar al contenido` / `Detalle del asset` ·
pt `Ir para o conteúdo` / `Detalhe do asset` · fr `Aller au contenu` / `Détail de l'asset` ·
it `Vai al contenuto` / `Dettaglio dell'asset` · zh `跳到内容` / `资源详情` ·
hi `सामग्री पर जाएँ` / `एसेट विवरण`.

No plural forms, no params ⇒ no PluralForm objects, plain strings; the parity/drift test in
`packages/i18n` covers them automatically.

---

## 5. Determinism

- `focusTargetAfterSwap` is a total pure function over two finite enums — no Date, no random, no
  locale, no DOM. Same inputs ⇒ same output, table-tested.
- Anchor ids are frozen exported constants (contract test pins them).
- The probe re-set no-op is **structural**: the effect's dependency array contains only `phase.t`
  (and later `view`) — `report` identity changes cannot re-run it. This is stronger than the
  `autoSelectedFor` ref-guard pattern the pick suggested; the ref here tracks only prev state.
- Round18 abortable workers: an aborted run never reaches `setPhase({t:'done'})`, so focus fires
  exactly once per COMPLETED analysis, never for a superseded one.

## 6. Resulting landmark map (and where the landing plugs in)

```
banner  <header>                          (existing, App.tsx:320)
main    <main id="ad-main">               (existing + id/tabIndex)
├─ idle:  region "Drop an asset folder to diagnose"   (Dropzone section, labelledby its h1)
│         [LANDING: sibling sections below — how-it-works / features / privacy / FAQ —
│          each a named region; footer=contentinfo; header gains <nav>. Owned by landing-design.md]
└─ done:  region "Asset audit results — N problems found"  (grid section, labelledby sr-only h1)
          └─ region "Asset detail"        (former aside → section aria-label)
[settings view (in-flight): same banner+main; SettingsPage h1 inside main]
```

Deliberately sparse — over-landmarking is its own anti-pattern; the ledger's inner `listbox`
label (`triage.listLabel`) already covers the left column.

## 7. ARIA / keyboard / reduced-motion / contrast

- **ARIA:** named regions via `aria-labelledby` (self-syncing with visible/outline headings) and
  one `aria-label` (i18n ×9). No role overrides; `<section>`+name → `region`, `<header>` → banner.
  The aria-live announce flow is UNTOUCHED: `emitLive`/`analysisReadyMessage` still speak the
  diagnosis-ready moment; focus landing on the results h1 additionally speaks
  `resultsHeading(...)` — additive, both short, standard SPA pattern (announce = event,
  focus = position).
- **Keyboard:** Tab #1 = skip link (every view/phase); Enter ⇒ focus `<main>`; next Tab ⇒ first
  interactive element of the current view (idle: CTA button; done: ledger search box). After
  `analyzing→done`, next Tab from the focused results h1 ⇒ search box (no more restart-from-
  document-top). After "analyze another", next Tab from the Dropzone h1 ⇒ CTA. During `analyzing`
  focus intentionally stays put (§3); the polite status region narrates.
- **Reduced motion:** skip-link reveal is transform-swap with NO transition; programmatic
  `focus()` scrolling is an instant jump (verified: no `scroll-behavior: smooth` in the app).
  Nothing animates ⇒ nothing to gate behind `prefers-reduced-motion`.
- **Contrast (measured):** pill = ink #16202A on panel #FFF = 16.48:1 (AA+++); teal border is
  non-text (3:1 not required for decorative border; the ring satisfies 1.4.11 at 4.08:1 vs panel
  and 3.05:1 vs bg — same values UX-1 shipped). Teal-as-text on panel (4.08:1) is explicitly
  avoided. `.ad-focus-anchor` outline suppression applies ONLY to tabIndex=-1 anchors — every
  sequentially focusable control keeps the global ring (no 2.4.7 regression).

## 8. Honesty / instant-wow / perf-at-scale

- **Honesty:** zero new numbers; the results region name reuses `resultsHeading`'s
  crit+warn+info formula (excludes ok/clean, never VRAM/disk). "Asset detail" describes what the
  column IS; dropping the semantically false `complementary` role is itself an honesty fix.
- **Instant-wow (invariant 4):** the ≤10s payoff finally lands for keyboard/SR users — focus
  arrives ON the diagnosis instead of `<body>`. Zero added work in the analysis path.
- **Perf at scale:** skip link = 1 static node; landmarks = attributes; the effect runs O(1)
  DOM work per phase swap (getElementById + focus). Nothing per-row, nothing per-asset;
  useWindow/virtualization untouched. 0, 1, or 1000 assets — identical cost.

## 9. Edge cases

- **0 files dropped** → `phase 'error'`, Dropzone stays mounted, `role=alert` speaks, no focus
  move (rule 5). CTA remains reachable.
- **0 parsed assets** → `report.noAssets` branch (App.tsx:394): grid section absent, but the
  results h1 (:377) still renders outside the ternary ⇒ `ad-results-h1` exists ⇒ focus lands,
  reads "…0 problems found", Tab reaches "analyze another". No dangling `aria-labelledby`
  (the section that references it is absent too).
- **1 asset / 1000 assets** — identical behavior (see §8).
- **All-clean report** — h1/region name honestly says "0 problems"; focus still orients.
- **Probe re-set mid-reading** — user typing in search when `attachProbeReadings` lands a new
  report object: focus NOT stolen (deps exclude `report`). This was the pick's hard requirement.
- **Rapid re-drop (aborted run)** — superseded run never reaches 'done'; single focus move.
- **9-locale long strings** — pill auto-sizes (`white-space: nowrap`, no fixed width); longest
  candidates (ru "Перейти к содержимому", de "Zum Inhalt springen") ≈ 22 chars ×12px mono ≈
  180px — fits any viewport ≥320px. Region labels are SR-only (no layout). Locale switch while
  focused: text re-renders, focus position unaffected.
- **RTL** — none of the 9 locales is RTL (hi is LTR Devanagari); fixed `left:12px` is safe. If an
  RTL locale is ever added, switch to `inset-inline-start` (one-line note for the future).
- **Skip link pressed while on #settings** (post-integration) — hash untouched (preventDefault),
  view stays settings, focus → `<main>` start = the settings content. Honest on every view.
- **Analysis finishes while user is on #settings** (post-integration) — rule 2 ⇒ null; no focus
  steal, no attempt to focus a display:none subtree (which would silently no-op anyway — we
  make it an explicit rule, not an accident). On return to main, rule 1 targets the results h1.

## 10. INTEGRATION NOTES vs the in-flight settings page (uncommitted route.ts / SettingsPage)

- **I1 — View type & sequencing.** Implementation is scheduled after the settings tree lands
  (per brief). Then: `import type { View } from './route'` in focus-move.ts, App passes the real
  `view` state, and the effect deps become `[view, phase.t]`; `prevSwap` init uses the initial
  `viewOfHash(location.hash)`. If this pick somehow lands FIRST, keep the inlined
  `'main'|'settings'` union and the `view:'main'` literal (as written in §4.3.7) — the pure
  function and tests need zero changes later.
- **I2 — ONE focus owner.** settings-page-design.md:405 gives SettingsPage a mount effect focusing
  its own h1. Two owners double-fire on main→settings. Resolution: focus-move owns ALL swaps
  (it is the only mechanism that can handle settings→main — SettingsPage is unmounted then);
  at integration, delete SettingsPage's mount-focus effect and give its h1
  `id="ad-settings-h1"` (the constant already reserved in FOCUS_ANCHORS) + `ad-focus-anchor`
  class. Direction main→settings behaves identically to their design; direction settings→main
  becomes handled instead of dropped.
- **I3 — Hidden wrapper.** Their `<div hidden={view==='settings'}>` around Dropzone+results
  (settings-page-design.md:396) is exactly why rule 2 exists. The live region stays OUTSIDE the
  wrapper (their design) — announce flow unaffected by this pick either way.
- **I4 — Header nav link.** Their `<a href={SETTINGS_HASH}>` lands before `<LanguageSwitcher/>`
  (:391). The skip link must stay the FIRST tab stop — it is inserted before `<header>` entirely,
  so their edit cannot displace it. Wrapping the header links in `<nav aria-label>` is the
  landing design's commit (§3), slotting into the §6 map.
- **I5 — Skip link vs hash router.** `viewOfHash` is exact-match fail-open, so a native `#ad-main`
  jump would not blank the app — but it WOULD navigate settings→main and pollute history. The
  preventDefault in §4.3.1 is therefore load-bearing; keep it even though the router "survives".
- **I6 — optimize-entry anchor → navigation.** Their design turns the App.tsx:429-441 anchor into
  `<a href={SETTINGS_HASH}>` ("the anchor just navigates"). With I2, arrival focuses the settings
  h1 — consistent with their final rule (no scroll chasing); no extra work here.
- **I7 — In-flight tree files.** `route.ts`/`route.test.ts`/`build-settings.*` are uncommitted in
  the working tree; this design cites their CONTRACT (from their design doc + tree file) but
  designs against HEAD markup. If their App.tsx rewrite lands first, the line numbers in §4.3
  shift — re-anchor by the quoted JSX, which their design keeps verbatim ("Dropzone/results tree
  verbatim", settings-page-design.md:396).

## 11. Test plan

### 11.1 Pure Node tests (`apps/web/src/lib/focus-move.test.ts`, vitest env=node)

Table-driven over `focusTargetAfterSwap`:
1. Frozen contract: `FOCUS_ANCHORS` equals `{results:'ad-results-h1', dropzone:'ad-dropzone-h1',
   settings:'ad-settings-h1'}` (ids are markup contract).
2. Initial mount semantics: every identity pair `(s,s)` ⇒ null (idle/analyzing/done/error ×
   main/settings).
3. `analyzing→done` (main) ⇒ results; `error→…` chain: `error→analyzing` ⇒ null,
   then `analyzing→done` ⇒ results.
4. `done→idle` (main) ⇒ dropzone ("analyze another").
5. `idle→analyzing` ⇒ null; `analyzing→error` ⇒ null; `done→analyzing` ⇒ null (unreachable today,
   function stays total).
6. View swaps: `main→settings` ⇒ settings (any phase); `settings→main` with phase done ⇒ results;
   with phase idle/analyzing/error ⇒ dropzone.
7. Phase flips while view=settings ⇒ null (`analyzing→done`, `done→idle` both).
8. Exhaustive determinism sweep: all 4×4×2×2 = 64 (prev,next) pairs return a value in
   `{null} ∪ FOCUS_ANCHORS` and repeat-calls are identical.

i18n: the existing catalog parity/drift tests in `packages/i18n` pick up the 2 new keys with no
new test code (they enumerate keys).

### 11.2 Honestly NOT unit-testable (no React harness) — manual gates, noted in each PR

- Skip link: fresh load → Tab reveals the pill top-left above the header; Enter → reading/tab
  position enters `<main>`; hash bar shows NO `#ad-main`; on `#settings` (post-integration) the
  view does not flip. Gate: manual keyboard pass, Chromium + Firefox.
- Focus actually lands: analyze a fixture (`fixtures/sample-projects`) → at done, `document.activeElement`
  is `#ad-results-h1` (devtools check) and NVDA/VoiceOver reads "Asset audit results — N problems
  found"; "analyze another" → activeElement is the Dropzone h1. Gate: SR smoke (VoiceOver or NVDA).
- Landmark rotor: banner / main / region "Drop an asset folder…" (idle) vs region "Asset audit
  results…" + region "Asset detail" (done); NO "complementary" entry remains. Gate: SR rotor.
- axe DevTools: zero new violations; heading outline still h1→h2→h2→h3 (UX-3 regression gate).
- Visual: `lg:sticky` detail column unaffected by aside→section (scroll a long ledger); focused
  h1s and `<main>` show NO outline; every button/input/select keeps the teal/film-soft ring.
- prefers-reduced-motion emulation: skip-link reveal instant; done-swap scroll is a jump.
- Locale sweep: all 9 — pill fits, no clipping at 320px width.

## 12. Ordered small-commit breakdown (1 meaning each)

1. `feat(web,a11y): pure focus-move decision table (lib/focus-move.ts + Node tests)` —
   §4.1 + §11.1; no UI change, green in isolation.
2. `feat(web,i18n): a11y.skipToContent + region.filmDetail keys x9` — catalogs only; parity
   tests cover.
3. `feat(web,a11y): skip-to-content link + focusable main (WCAG 2.4.1)` — index.css
   `.ad-skip-link`/`.ad-focus-anchor` + App.tsx edits §4.3.1-2.
4. `feat(web,a11y): named landmarks — dropzone/results regions, detail aside→section` —
   App.tsx edits §4.3.4-6 (ids on both h1s land here; labelledby wiring; tag swap).
5. `feat(web,a11y): focus moves on phase swaps (analyzing→done, done→idle)` — App.tsx effect
   §4.3.7 + `tabIndex={-1}`/`ad-focus-anchor` on the two h1s (if not already in 4 — keep
   tabIndex in THIS commit so each commit is behavior-complete).
6. `docs: FEATURES — UX-round 4 (orientation skeleton: landmarks, skip link, focus moves)`.

Post-settings integration (separate commit, whichever workflow goes second):
7. `feat(web,a11y): route view through focus-move (settings swaps, one focus owner)` — I1+I2.
