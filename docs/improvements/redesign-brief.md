# Redesign brief — mockup-aligned starting page, other pages in the same style, dark theme

The user provided a polished HTML mockup (`docs/improvements/redesign-mockup-landing.html`, also at the
scratchpad path `mockup-landing.html`) and asked for three things, verbatim:

1. **"это должна быть стартовая страница"** — this mockup is the STARTING (idle/landing) page. Make the
   app's idle screen match its layout and polish.
2. **"остальные страницы разработай в том же стиле"** — redesign the OTHER pages (results view, settings
   page) in the same visual style.
3. **"добавь тёмную тему (темы будут автоматически подстраиваться под тему браузера), с переключателем
   (авто/светлая/тёмная) в настройках"** — add a DARK THEME that auto-follows the browser
   (`prefers-color-scheme`), plus an auto/light/dark switcher in Settings.

Earlier feedback that motivated this: the current verstka looks "смазанно и сумбурно" (blurry/chaotic).
The mockup is a sharper, more confident version of the SAME design language the app already uses.

---

## 0. The bar that must not regress (non-negotiable)

- **5 invariants** (CLAUDE.md): assets never leave the device; thin backend; objectivity (measure, never
  fabricate); instant-wow (first value ≤10s, no signup); disk ≠ VRAM (always show VRAM = w×h×4 alongside
  disk, never conflate).
- **Honesty (invariant 3 / 4)**: the mockup is a PRE-LAUNCH MARKETING page — it has a waitlist, "Notify
  me", "Join the waitlist", and illustrative numbers ("ships ~40% it does not need", "−43% on a typical
  build", "84 MB → 210 MB", "42% empty · 16 MB VRAM", render-probe "128 draw calls / 210.4 MB / 9.2 ms").
  The real app is FUNCTIONAL. We adopt the mockup LOOK, never its dishonesty:
  - NO waitlist / email capture / "notify me" anywhere (invariant 4: no signup gate; invariant 1: no
    network). The one real conversion is Open-folder / drag-drop.
  - Any example number shown before the user drops a folder must be visibly an EXAMPLE/DEMO, never framed
    as the user's build. `w×h×4 = 16 MB` is REAL honest math and may stay (it is a formula, not a
    fabricated user result). Percentages like "−43%" / "40%" must be dropped or clearly generic.
  - The hero viewer demo (glyphs + heat zones + readout) is acceptable ONLY as a labeled demo that runs
    REAL analysis on drop (the mockup already does this: "live demo · drop your own atlas to run a real
    diagnosis"). It must not assert a specific user result.
- **a11y** (shipped, do not break): skip-to-content link is the first tab stop; exactly ONE `<h1>` per
  view; monotonic heading outline (h1→h2→h3); the persistent `role=status` live region as first child of
  `<main>`; `focus-move` on view/phase swaps (`lib/focus-move.ts`); reduced-motion gating of every
  animation/scroll/reveal; determinate progressbar; WCAG AA contrast (4.5:1 normal text) proven in
  `lib/contrast.ts` + `test/contrast.test.ts`; `.ad-label`/`.ad-label-sm` micro-label tokens (guarded by
  `test/label-tokens.guard.test.ts` — do not reintroduce raw uppercase-mono stacks).
- **i18n**: ALL user-facing copy goes through `t()`; new keys must be added to ALL 10 catalogs
  (en/ru/de/es/pt/fr/it/zh/hi/uk) with placeholder + plural parity (en is source of truth,
  `packages/i18n/test/catalogs.test.ts`). App-file `t()` keys are scanned by
  `apps/web/test/i18n-app-keys.test.ts` — any new key referenced from a scanned file must exist.
- **No new runtime deps, no external fonts/images/CDN** (invariant 1 + first-paint budget). Inline SVG +
  CSS from `@theme` tokens only. Fonts are already self-hosted/system-fallback via `@theme`.
- **apps/web has NO React test harness** (Vitest runs in Node). All logic must live in pure,
  Node-tested `lib/*.ts` modules (precedents: `ledger-empty.ts`, `progress-view.ts`, `contrast.ts`,
  `view-prefs.ts`). Visual composition is verified by a documented manual gate, not a DOM test.

---

## 1. The mockup, decoded

Shared palette with the app already (bg #E7ECF1, panel #FFF, line #DCE3EA, ink #16202A/#566472, teal
#0E8C8C, cta #15A06A, film #0C1116/#0A0E12/#121A22/#1B2530/#9FB0BD/#8593A0, severity crit #E5484D / warn
#D98A00 / ok #1F9D63 / info #2B8FC9; Space Grotesk / IBM Plex Sans / IBM Plex Mono). max-width 1180px
(app uses max-w-6xl = 1152px — keep the app value).

Sections, top to bottom:
1. **Sticky nav header** — logo (teal circle+cross SVG) + "Asset Doctor" wordmark; right side a green CTA
   pill. Blurred translucent bg (`bg-bg/80 backdrop-blur`). The app header already matches this closely;
   it additionally carries the settings link + language switcher + (on results) the metrics strip.
2. **HERO — the big change.** Two columns (`minmax(0,1fr) minmax(0,1.18fr)`, gap 56px, centered):
   - LEFT: mono eyebrow with a pulsing dot ("Asset audit for HTML5 games · runs in your browser"), a big
     Space Grotesk h1 (54px), an 18px subtitle, two CTAs (green primary + white/bordered secondary), and
     a shield-icon privacy line ("100% in-browser analysis. Your assets never touch a server.").
   - RIGHT: the **signature viewer** — a dark #0C1116 rounded card with the film-clip notch, a top bar
     (filename + format badge + "drag a PNG atlas in →"), the x-ray STAGE (dark grid, canvas demo glyphs,
     scanline, red/yellow heat zones with labels, a teal signature tooltip, a drop prompt), and a 4-cell
     READOUT STRIP (VRAM / Empty / Draw calls / Size) with colored values. Caption below: "live demo ·
     drop your own atlas to run a real diagnosis". This whole card is ALSO the drop target and runs real
     analysis on drop.
   - The app's current idle screen (`Dropzone` in App.tsx) is a SINGLE centered column: eyebrow, h1,
     tagline, subtitle, then the viewer (drop button only, no readout strip, no demo glyphs). The redesign
     brings it to the two-column hero with the readout-strip viewer + labeled demo.
3. **"Disk size lies"** — white card, 2 columns: prose left; a dark VRAM-meter right with a DISK bar
   (green, small) and a VRAM bar (orange→red, full) + "disk 84 MB → VRAM 210 MB". The app has a compact
   disk≠VRAM section (`Landing.tsx` §2) using a token figure (small-file box vs 16 MB grid box) — honest
   already. The redesign can adopt the bolder bar treatment BUT must keep the numbers honest/generic (the
   "84→210" is illustrative; keep the honest w×h×4 framing, label any example as an example).
4. **"How it works"** — 3 numbered steps (01/02/03). App has this (`Landing.tsx` §1). Step 3 in the
   mockup claims "−43% on a typical build" — drop that specific number (honesty).
5. **"What it catches"** — 3×2 grid of finding-type cards each with a severity dot (crit/warn/info) +
   one "coming" dashed card. App has an 8-card capabilities grid (`Landing.tsx` §3). The mockup adds the
   severity-dot styling. These finding types are REAL (honest).
6. **"Why it is different"** — dark #0C1116 card, 2 columns: prose about loading the atlas into a real
   WebGL context; right a render-probe live readout (draw calls / texture uploads / live VRAM / gpu frame
   budget). App has a dark PRIVACY strip (`Landing.tsx` §4). The render-probe example numbers must be
   labeled illustrative (not the user's live data).
7. **Pricing** — 3 cards (Free / Pro / Studio). App has a 2-card Free/Pro block gated by
   `PRO_GATE_ENABLED` (`Landing.tsx` §5) — honest about the beta gate. Keep the gate discipline; the
   mockup 3-card layout is optional polish. "Notify me" buttons must become real actions or be dropped.
8. **Waitlist** — DROP entirely (invariant 4).
9. **Footer** — app has `LandingFooter`.

---

## 2. Honest mapping: mockup element → app treatment

| Mockup element | App treatment (honest) |
| --- | --- |
| "Run a free scan" header CTA | Real: focuses/opens the folder picker (reuse `scanFolder` → `LANDING_OPEN_FOLDER_ID`). Keep the app header's settings link + language switcher. |
| Hero h1 "X-ray your game's assets." | Reuse `dropzone.title` copy (already "X-ray"-style). Keep ONE h1. |
| Hero right viewer with readout strip | The real `Dropzone` viewer, upgraded: keep it the drop target; add the 4-cell readout strip showing a DEMO/illustration state (clearly labeled) until a real analysis fills it. Reuse `.ad-grid`/`.ad-clip`/`.ad-viewer-shadow`/`.ad-scanline`. |
| Demo glyphs + heat zones + "42% empty · 16 MB VRAM" | Optional. If shown, label as a demo/example (caption). Prefer reusing the existing honest `SpecimenFilm` illustration rather than a fabricated canvas. w×h×4 math is fine. |
| "ships ~40% it does not need" / "−43% on a typical build" | Drop the fabricated percentages. |
| Disk/VRAM bars "84 MB → 210 MB" | Keep the disk≠VRAM figure; the bar treatment is fine but numbers must read as an EXAMPLE, and the w×h×4 rule stays the honest anchor. |
| Render-probe readout (128 / 210.4 MB / 9.2 ms) | Describe the real moat; any numbers labeled as an illustrative example, not live user data. |
| Pricing "Notify me" / Waitlist / email form | Remove all email/waitlist. Keep the gate-honest Free/Pro block. |

---

## 3. Current-app file map

- `apps/web/src/App.tsx` (2082 lines) — `App()` at 71; header 474-512 (Logo, wordmark, `app.tag`,
  HeaderMetric strip when `report`, settings link `SETTINGS_HASH`, `LanguageSwitcher`); `<main id="ad-main">`
  at 518 with the persistent live region (525) and the `hidden={view==='settings'}` wrapper (533);
  idle/analyzing/error branch renders `<Dropzone>` (536) + `<Landing phaseT>` (545); results branch
  (`report && phase.t==='done'`, 549) has the sr-only results h1 (557), PrimaryRecommendation,
  VerdictBar, the sub-md MobileTotal strip, and the 2-col `TriageLedger` + film-detail `<section>`;
  `SettingsPage` at 659; `LandingFooter` at 668. `Dropzone` fn at 808-903 (eyebrow, h1, tagline+subtitle,
  the grid viewer with scanline + Logo + open button / analyzing progressbar, footnote). `LanguageSwitcher`
  679, `HeaderMetric` 700, `MobileTotal` 729, `ErrorNotice` 786.
- `apps/web/src/index.css` — `@theme` LIGHT tokens (4-33); `.ad-label`/`.ad-label-sm`; `:focus-visible`
  ring; `.ad-grid`/`.ad-viewer-shadow`/`.ad-clip`; keyframes (reveal/scan/pulse/blink); `.ad-scanline`;
  `.ad-progress-*`; `.ad-sr-only`; `.ad-skip-link`; `.ad-focus-anchor`; `.ad-bleed` + `html{overflow-x:clip}`;
  `.ad-reveal-wait`; the reduced-motion block. THIS is where dark tokens + the switch mechanism go.
- `apps/web/src/components/landing/Landing.tsx` (311) — nav TOC + 6 sections; all copy via `t()`; reveal
  via `revealMode`/IntersectionObserver; `SpecimenFilm`. `LandingFooter.tsx` (34), `SpecimenFilm.tsx` (98).
- `apps/web/src/components/SettingsPage.tsx` — the #settings page (builder-style cards: view-filter,
  formats, resolutions, packing, mipmaps, rules, output, backend, config). The theme switcher goes here.
- `apps/web/src/lib/view-prefs.ts` — PURE durable view-pref slice (localStorage-guarded, fail-closed,
  Node-tested). The theme preference should follow this exact pattern (new slice or same file).
- `apps/web/src/lib/i18n.tsx` — sets `documentElement.lang`; the precedent for applying an attribute to
  `documentElement` (theme → `data-theme` + `color-scheme`).
- `apps/web/index.html` — plain Vite shell, `<html lang="en">`, NO theme bootstrap yet. FOUC-free theming
  needs a tiny SYNCHRONOUS inline script in `<head>` that reads the stored pref and sets `data-theme`
  before first paint. (No external anything; a few lines of vanilla JS.)
- `apps/web/src/lib/contrast.ts` + `test/contrast.test.ts` — the AA proof. Any dark accent-text token must
  be added here with a proven ratio against the dark surfaces, and the test extended.
- `apps/web/src/main.tsx` — React entry.

---

## 4. Dark-theme architecture (the crux — design this precisely)

Requirements: auto-follows `prefers-color-scheme` by DEFAULT; a 3-way switch (auto/light/dark) in Settings
overrides it; the choice persists (localStorage, view-prefs pattern); NO flash of the wrong theme on load;
WCAG AA preserved in BOTH themes; native controls (scrollbars, the `<select>`) match via `color-scheme`.

Design decisions to resolve and specify exactly:

1. **Token override strategy.** `@theme { ... }` stays the LIGHT default (Tailwind v4 emits the utilities
   from these `--color-*` custom properties on `:root`). Dark is an OVERRIDE of the same variables:
   - Auto (follow browser): `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { <dark values> } }`
   - Forced dark: `:root[data-theme="dark"] { <dark values> }`
   - Forced light: needs no block (defaults are light); the `:not([data-theme="light"])` guard makes the
     "light" choice win even under a dark browser. Verify Tailwind v4 does not strip a plain override block
     (it should not — these are ordinary CSS custom-property declarations; specificity `:root[attr]` (0,2,0)
     and `:root:not()` (0,2,0) both beat `@theme`'s `:root` (0,1,0)). Confirm empirically in the build.
   - Also set `color-scheme: light dark` on `:root` and force it per mode (`:root[data-theme="dark"]{color-scheme:dark}`)
     so form controls/scrollbars follow.
2. **The dark palette (derive + PROVE AA).** The app IS an x-ray room; dark mode should extend the film
   aesthetic to the whole chrome. Propose concrete hex values for the dark overrides of: `--color-bg`,
   `--color-panel`, `--color-line`, `--color-ink`, `--color-ink-soft`, and dark-appropriate accent TEXT
   colors for `--color-teal-text`, `--color-cta-text`, `--color-crit-text` (the light AA-safe values are
   DARK hues that FAIL on a dark bg — dark mode needs LIGHTER accents). Decide whether the film-* tokens
   (already dark) and the CTA FILL (`--color-cta`) stay put (white-on-cta should still pass). For EVERY
   text token in dark mode, compute the contrast ratio against the dark `--color-bg` AND dark `--color-panel`
   and confirm ≥ 4.5:1 (large display text may use 3:1 but prefer 4.5). The severity dots are non-text
   (3:1 for 1.4.11). Deliverable: a table token → dark hex → ratio on dark-bg → ratio on dark-panel → pass.
   Keep the `.ad-scanline`/`.ad-clip` hardcoded colors sane in dark (they are on the always-dark film card;
   likely unchanged).
3. **FOUC-free application + the switch.** Specify: the inline `<head>` script (reads `localStorage['ad.theme']`,
   validates against {auto,light,dark} fail-closed to auto, sets `document.documentElement.dataset.theme`
   — only for light/dark; auto ⇒ no attribute so the media query drives it); a pure `lib/theme.ts` slice
   (parse/serialize/load/save + the apply function, Node-tested like view-prefs.ts) reused by BOTH the
   inline script contract and the React switcher; the Settings switcher UI (a labeled radio/segmented
   control, keyboard-accessible, i18n copy). Applying on change updates `documentElement` immediately AND
   persists. `auto` must react live to OS changes (a `matchMedia('(prefers-color-scheme: dark)')` listener
   is NOT needed if we rely on the CSS media query for auto — the CSS handles it with zero JS; confirm).
4. **i18n.** New keys for the switcher (section title + auto/light/dark option labels + an aria-label) in
   all 10 catalogs. List them.
5. **Scope of dark restyle.** Because everything already uses `bg-bg`/`bg-panel`/`text-ink`/`border-line`
   etc. (token utilities), overriding the tokens flips the WHOLE app automatically. Flag any HARDCODED
   colors that will NOT flip: e.g. `text-white` on the CTA (fine — CTA fill stays), `text-[#9be7e7]` in
   the analyzing state (on the always-dark viewer — fine), the `Logo` hardcoded `#0E8C8C` (fine, teal is
   theme-independent), `.ad-clip` `#cdd6df` notch (on dark film — check it reads in dark chrome), any
   `bg-white`/raw hex in components. Produce a grep list of hardcoded colors to audit.

---

## 5. Three design tracks (each agent produces a concrete, buildable spec grounded in the real files)

**Track A — Idle/landing redesign.** The two-column hero (pitch left, signature viewer + readout strip
right, labeled demo) replacing the single-column `Dropzone`; keep it the real drop target + the ONE h1 +
the live region + focus-move + reduced-motion; specify exact Tailwind classes reusing existing tokens/motifs;
adapt the Landing sections toward the mockup polish (bar treatment for disk≠VRAM, severity-dot finding
cards, render-probe dark card) WITHOUT losing honesty or a11y; list every new/changed i18n key. Responsive:
the hero stacks below `lg`; on mobile the viewer stays usable. Do NOT regress the label-token guard.

**Track B — Dark theme.** Everything in §4: the override CSS, the proven dark palette table, the FOUC-free
inline script + `lib/theme.ts` pure slice + Settings switcher + persistence + i18n keys + the hardcoded-color
audit + how `contrast.test.ts` extends to prove the dark AA. This is the highest-risk track — be exact.

**Track C — Results + settings re-skin.** How to bring the results view (VerdictBar, TriageLedger,
FilmViewer, Findings, FixCard) + the SettingsPage to the mockup polish and full dark-theme compatibility,
with the LIGHTEST touch that does not risk the functional/a11y/i18n bar (these screens are already on-brand;
mostly this is dark-theme compat + spacing/card-treatment polish + placing the theme switcher). Identify
any hardcoded color or contrast risk that dark mode exposes here.

**Skeptic-synthesizer.** Independently GROUND all three tracks against the actual code (App.tsx, index.css,
Landing.tsx, SettingsPage.tsx, view-prefs.ts, contrast.ts, index.html, i18n) and the §0 bar. KILL any pick
that is dishonest (invariant 3/4), breaks a11y, fails AA, adds a dep/network/font, reintroduces a raw
micro-label stack, or cannot actually be built as described. Resolve conflicts. Output ONE unified, phased,
buildable spec: Phase 1 = dark-theme infrastructure (self-contained, testable, high value); Phase 2 =
idle/landing hero redesign; Phase 3 = landing-sections polish + results/settings re-skin. For each phase:
exact files, exact token/class changes, new i18n keys (all 10 locales), new pure lib modules + their tests,
and the manual visual-gate checklist. Flag anything that should be dropped or deferred.
