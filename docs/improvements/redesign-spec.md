# Asset Doctor redesign — unified phased spec (from design workflow wr9bi2gta)

All claims are now grounded. The earlier empty greps were the known Cyrillic-cwd grep breakage (Track C warned of it); the Read tool confirms `TriageLedger.tsx:529` really does carry decorative `text-teal`, and the engine chip at `App.tsx:2018` is the only `bg-teal-text text-white` in the tree. Every dark-palette AA number reproduces exactly under the repo's WCAG formula, and the film-elevation order holds. Here is the unified spec.

---

# Asset Doctor redesign — unified, phased, buildable spec

## Grounding verdict (what survived, what I killed)

I independently reproduced every load-bearing number and line reference:

- **Dark palette AA** — recomputed with the repo's exact WCAG formula (`contrast.ts`). All five dark text tokens clear ≥4.5 on **both** dark surfaces (ink 14.71/12.38, ink-soft 7.77/6.54, teal-text 8.50/7.16, cta-text 8.19/6.90, crit-text 7.65/6.44); all four severity dots clear ≥3; decorative teal ring 4.25/3.58 ≥3; engine-chip panel-on-teal-text passes both themes (5.43 light / 7.16 dark) while the **old** white-on-dark-teal is 2.04 (the real bug). Film elevation is strictly ordered: film2 .0042 < film .0054 < **bg .0106 < panel .0220** — so Track B's hexes already satisfy Track C's C.1.a constraint.
- **Single break site** — `bg-teal-text text-white` occurs at exactly one place, `App.tsx:2018`. Confirmed.
- **`TriageLedger.tsx:529`** — really is decorative `text-teal` used as label text (Read-confirmed; grep failed under the Cyrillic cwd).
- 10 catalogs present (`en,ru,de,es,pt,fr,it,zh,hi,uk`); `catalogs.test.ts` enforces key + placeholder parity; `i18n-app-keys.test.ts` statically scans **App.tsx, SettingsPage.tsx, Landing.tsx, FilmViewer/VerdictBar/TriageLedger/Findings/LicensePanel/PrimaryRecommendation + several lib files**; `label-tokens.guard.test.ts` scans only App.tsx/FilmViewer/Findings/SettingsPage and bans micro-size+`uppercase`+`tracking` co-located on one line.
- `focus-move.ts` targets `ad-dropzone-h1`/`ad-settings-h1`/`ad-results-h1`; `LANDING_OPEN_FOLDER_ID='ad-open-folder'`; `h2IdOf('how-it-works')` = `'how-it-works-h2'` (so Track A's hardcoded string is coincidentally correct — but import `h2IdOf` instead, for drift-safety); `view-prefs.ts` and `i18n.tsx` are the exact precedents Track B mirrors.

### Conflicts resolved

1. **Two ThemeCards / two i18n namespaces (B vs C).** KILL Track C's separate `<ThemeSwitcher/>` component and its `theme.*` namespace. A new component file would **not** be in the `i18n-app-keys` scan list, so its `t('theme.*')` calls would be invisible to the guard — a real drift hole. Adopt **Track B's self-contained inline-radio `ThemeCard`** whose `t()` literals live in the already-scanned `SettingsPage.tsx`. Unify the copy under the `settings.*` namespace (matches existing `settings.diagnosis.*`).
2. **Engine-chip fix (B vs C).** Adopt **Track B's `text-white → text-panel`** (one word, byte-identical in light because panel=#FFF there, proven AA in dark). Drop Track C's `border-teal bg-panel text-ink` rewrite — it changes the light appearance for no AA/honesty gain.
3. **Palette hexes (B vs C).** Adopt **Track B's** `bg #141b24 / panel #1e2a36 / line #33424f`; they satisfy Track C's `film < bg < panel` ordering with more film separation than C's suggested `#10161d/#161d26`. Keep C's ordering as an acceptance criterion.

### Killed / deferred (honesty & scope)

- **Any waitlist / "notify me" / email / render-probe live numbers / "−43%/40%/84→210"** — never adopted (invariant 3/4).
- **Track A §5 real severity-dot finding cards** — DEFER; coloring generic capability cards by severity fabricates per-type data. A neutral teal accent dot is the only honest polish now.
- **Track A §6 render-probe dark readout card** — DEFER; keep the existing honest privacy strip.
- **Track A optional `dropzone.eyebrow`** — DROP; keep reusing `header.xray` (avoids 10 cosmetic translations).
- **Raw severity-hue-as-text light-AA gaps** (SettingsPage `⚠`/`✕`, some FilmViewer/receipt sites) — OUT OF SCOPE; pre-existing light-mode misses that dark does **not** regress. Separate a11y follow-up.

No phase adds a dependency, network call, external font/image, or a raw micro-label stack in a guarded file; every phase keeps the one-h1 / skip-link / live-region / focus-move / reduced-motion / AA bar.

---

## PHASE 1 — Dark-theme infrastructure (self-contained, testable, ship first)

After this phase dark theme works end-to-end: auto-follows the OS, is switchable in Settings, is FOUC-free, AA-proven in both themes, and has zero regressions. All logic is Node-tested pure `lib/*.ts`.

### Files touched

| File | Change |
| --- | --- |
| `apps/web/src/index.css` | Append dark token-override + `color-scheme` block after `@theme` closes (line 33) |
| `apps/web/index.html` | Add one classic inline `<head>` script (FOUC bootstrap) |
| `apps/web/src/lib/theme.ts` | **NEW** pure slice (mirrors `view-prefs.ts`) |
| `apps/web/test/theme.test.ts` | **NEW** Node test |
| `apps/web/src/components/SettingsPage.tsx` | Add self-contained `ThemeCard`, render **first** in the card stack |
| `apps/web/src/App.tsx` (line 2018) | `text-white` → `text-panel` (required dark AA fix) |
| `apps/web/src/components/TriageLedger.tsx` (line 529) | `text-teal` → `text-teal-text` (pre-existing light-AA miss + dark-safety) |
| `apps/web/src/lib/contrast.ts` + `apps/web/test/contrast.test.ts` | Dark AA proof constants + tests |
| `packages/i18n/src/catalogs/*.json` (all 10) | 6 new keys |

### 1. `index.css` — append after line 33 (plain unlayered rules)

`@theme` stays the light default. Tailwind v4 compiles `bg-bg`/`text-ink`/`border-line`/… to `var(--color-*)`, so overriding the custom properties flips every utility with zero component churn. Specificity `:root[data-theme]`/`:root:not(...)` = (0,2,0) beats `@theme`'s `:root` (0,1,0), and unlayered CSS outranks Tailwind's layered output. **Block A and Block B must stay byte-identical.**

```css
/* ── Dark theme. @theme above is the LIGHT default; these OVERRIDE the same custom properties.
   (A) auto: follow OS, but a forced "light" choice must win even under a dark OS → :not([data-theme='light']).
   (B) forced dark wins regardless of OS. (C) forced light needs no palette (defaults are light); only pin color-scheme.
   Film tokens, the CTA FILL, and the severity DOT hues are DELIBERATELY unchanged (already dark / theme-independent).
   Only the accent-TEXT tokens flip to LIGHTER hues; each is proven ≥4.5:1 on BOTH dark surfaces in contrast.test.ts.
   Elevation order held: film #0C1116 < bg #141b24 < panel #1e2a36 (so the always-dark FilmViewer reads as an inset well). */
:root { color-scheme: light; }
:root[data-theme='light'] { color-scheme: light; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --color-bg: #141b24;
    --color-panel: #1e2a36;
    --color-line: #33424f;
    --color-ink: #e8edf2;
    --color-ink-soft: #9fb0bd;
    --color-teal-text: #4cc7c7;
    --color-cta-text: #45c892;
    --color-crit-text: #ff8a8d;
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --color-bg: #141b24;
  --color-panel: #1e2a36;
  --color-line: #33424f;
  --color-ink: #e8edf2;
  --color-ink-soft: #9fb0bd;
  --color-teal-text: #4cc7c7;
  --color-cta-text: #45c892;
  --color-crit-text: #ff8a8d;
}
```

Nothing else in `index.css` changes. Verified-safe decoratives that stay put: `.ad-clip::before` `#cdd6df` notch = 11.78:1 on dark bg; `.ad-scanline`/`::selection` teal are on the always-dark film; `.ad-skip-link`/`.ad-progress-*`/`.ad-grid`/focus ring all reference tokens and flip or stay correct automatically.

### 2. `index.html` — FOUC-free bootstrap (classic script, before the module bundle)

Insert between line 6 (`<title>`) and line 7 (`</head>`). Must be a classic (non-module) script so it runs synchronously before first paint; it hand-mirrors `applyTheme(loadTheme())` (a classic script can't `import` ESM pre-paint). `theme.test.ts` pins the shared contract.

```html
    <script>
      // FOUC-free theme bootstrap (contract mirror of src/lib/theme.ts, pinned by theme.test.ts).
      // Fail-closed: only 'light'/'dark' set the attribute; auto/missing/garbage/blocked storage leave it unset
      // ⇒ the CSS @media(prefers-color-scheme) drives with zero JS. On-device only; no network (invariant 1).
      (function () {
        try {
          var t = localStorage.getItem('ad.theme');
          if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
        } catch (e) {}
      })();
    </script>
```

### 3. NEW `apps/web/src/lib/theme.ts` (mirrors `view-prefs.ts` guards + `i18n.tsx` bare-string pref)

```ts
export type Theme = 'auto' | 'light' | 'dark';
export const THEMES: readonly Theme[] = ['auto', 'light', 'dark'];
export const THEME_STORAGE_KEY = 'ad.theme';

/** FAIL-CLOSED: only the three known strings survive; anything else ⇒ 'auto' (follow the OS). */
export function parseTheme(raw: unknown): Theme {
  return raw === 'light' || raw === 'dark' || raw === 'auto' ? raw : 'auto';
}
export function serializeTheme(t: Theme): string { return t; }

/** Read the durable pref. localStorage-guarded AND fail-closed. Worst case ⇒ 'auto'. */
export function loadTheme(): Theme {
  try { return parseTheme(localStorage.getItem(THEME_STORAGE_KEY)); } catch { return 'auto'; }
}
/** Persist (best-effort; a throwing/absent storage is swallowed, like i18n.tsx's setLocale). */
export function saveTheme(t: Theme): void {
  try { localStorage.setItem(THEME_STORAGE_KEY, serializeTheme(t)); } catch { /* ignore */ }
}
/** 'light'/'dark' ⇒ set data-theme (outranks the media query); 'auto' ⇒ REMOVE it (CSS @media drives, reacts
 *  live to OS with zero JS). `root` injected so this is Node-testable with a stub. Idempotent. */
export function applyTheme(t: Theme, root: { dataset: DOMStringMap }): void {
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;
}
```

**`apps/web/test/theme.test.ts`** — reuse the `installLocalStorage` / `installThrowingStorage` / `afterEach` stubs from `view-prefs.test.ts`. Node test asserting:
- `THEMES` is exactly `['auto','light','dark']`; `THEME_STORAGE_KEY === 'ad.theme'` (the inline-script contract).
- `parseTheme` keeps the 3 known values; maps `null/undefined/''/'Dark'/'system'/42/{}/['dark']` → `'auto'`.
- `parseTheme(serializeTheme(t)) === t` for every theme.
- save→load round-trips `'dark'`; persists the bare string under `ad.theme`; no value ⇒ `'auto'`; foreign value ⇒ `'auto'`; throwing storage ⇒ `load='auto'` and `save` no-throw; missing `localStorage` ⇒ `'auto'`, `save` no-throw.
- `applyTheme('dark'|'light', root)` sets `root.dataset.theme`; `applyTheme('auto', root)` deletes it and is a no-op on a clean root.

Note `applyTheme(loadTheme(), document.documentElement)` must be called once at React startup (in `main.tsx` or the `I18nProvider` sibling) so a stored `'auto'` after a previous forced choice clears the attribute; the inline script only handles `light`/`dark`.

### 4. `SettingsPage.tsx` — self-contained `ThemeCard`, rendered first

Add the import and the card fn (alongside the other card fns); it owns local state because the theme lives on `documentElement`, outside React. Reuse the file's `Card` chrome and the `<fieldset>/<legend>` + native-radio pattern already used by `DiagnosisCard`. **Option labels are static literal `t()` calls** so the `i18n-app-keys` scanner covers them.

```tsx
import { applyTheme, loadTheme, saveTheme, type Theme } from '../lib/theme';

// ── Card: Appearance — durable DISPLAY preference (localStorage, applies immediately); sibling to the
//    diagnosis view-filter, NOT part of BuildSettings/build-config. Self-contained: theme lives on
//    documentElement. a11y: native radiogroup (<fieldset>/<legend> + radios), keyboard-navigable. ──
function ThemeCard() {
  const { t } = useI18n();
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());
  const choose = (next: Theme): void => {
    applyTheme(next, document.documentElement);
    saveTheme(next);
    setThemeState(next);
  };
  const options: { v: Theme; label: string }[] = [
    { v: 'auto', label: t('settings.theme.auto') },
    { v: 'light', label: t('settings.theme.light') },
    { v: 'dark', label: t('settings.theme.dark') },
  ];
  return (
    <Card title={t('settings.section.appearance')}>
      <p className="font-mono text-[10px] leading-relaxed text-ink-soft">{t('settings.theme.intro')}</p>
      <fieldset className="rounded border border-line/70 p-2">
        <legend className="px-1 ad-label text-ink-soft">{t('settings.theme.legend')}</legend>
        <div className="mt-1 space-y-1">
          {options.map(({ v, label }) => (
            <label key={v} className="flex items-center gap-1.5 font-mono text-[10px] text-ink-soft">
              <input type="radio" name="ad-theme" value={v} checked={theme === v} onChange={() => choose(v)} className="accent-teal" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    </Card>
  );
}
```

Render it first in the card list (line 738 area), before `<DiagnosisCard>`:

```tsx
      <div className="space-y-4">
        <ThemeCard />
        <DiagnosisCard hidden={hiddenRules} onChange={onChangeHiddenRules} />
        {/* …rest unchanged… */}
```

### 5. Required dark-AA className fixes

- **`App.tsx:2018`** — in the engine toggle, `text-white` → `text-panel`. Both tokens flip together, so the label always contrasts the `bg-teal-text` fill: light 5.43:1, dark 7.16:1 (vs the old white-on-dark-teal 2.04:1). Byte-identical in light (panel=#FFF).
- **`TriageLedger.tsx:529`** — the folder-group header `<span>`: `text-teal` → `text-teal-text`. This is decorative teal used as readable label text on `bg-bg` (pre-existing light-AA miss ~3.6:1). `teal-text` is AA on light bg (4.567) and dark bg (8.50). (Leave the rest of that className stack; `TriageLedger` is not in the label-guard's scan set.)

### 6. `contrast.ts` — dark AA proof (mirror `index.css` as SoT, after line 159)

```ts
export const DARK = { bg: '#141B24', panel: '#1E2A36' } as const;
export const DARK_INK = '#E8EDF2';
export const DARK_INK_SOFT = '#9FB0BD';
export const DARK_TEAL_TEXT = '#4CC7C7';
export const DARK_CTA_TEXT = '#45C892';
export const DARK_CRIT_TEXT = '#FF8A8D';

export function darkTextPassesAA(hex: string, surface: keyof typeof DARK): boolean {
  return contrastRatio(hex, DARK[surface]) >= AA_NORMAL;
}
/** Engine-chip label = panel-on-teal-text-fill must clear AA in BOTH themes (fill + label both flip). */
export function chipLabelPassesAABothThemes(): boolean {
  return contrastRatio(SURFACE.panel, TEAL_TEXT) >= AA_NORMAL && contrastRatio(DARK.panel, DARK_TEAL_TEXT) >= AA_NORMAL;
}
/** A severity DOT clears the non-text 1.4.11 floor (3:1) on a dark surface. */
export function severityDotDarkPasses(sev: keyof typeof SEVERITY_HEX, surface: keyof typeof DARK): boolean {
  return contrastRatio(SEVERITY_HEX[sev], DARK[surface]) >= AA_LARGE;
}
```

**`contrast.test.ts`** — extend imports and add a `describe('contrast — dark theme AA')` block asserting:
- every dark text token ≥4.5 on dark **bg AND panel** (`darkTextPassesAA` loop);
- the premise numbers hold (`toBeCloseTo`: ink 14.709/12.383, ink-soft 7.772/6.543, teal-text 8.5/7.155, cta-text 8.193/6.897, crit-text 7.65/6.44);
- the prevented bug: `contrastRatio(WHITE, DARK_TEAL_TEXT)` ≈ 2.039 and `< AA_NORMAL`;
- `chipLabelPassesAABothThemes()` true and `contrastRatio(DARK.panel, DARK_TEAL_TEXT)` ≈ 7.155;
- CTA fill white-on stays 4.585 (unchanged token, theme-independent);
- decorative teal (`TEAL_DECOR #0E8C8C`) ≥ `AA_LARGE` on both dark surfaces (4.248 / 3.576);
- every severity dot ≥3 on both dark surfaces (`severityDotDarkPasses` loop).

All numbers above are independently reproduced under the repo formula.

### 7. New i18n keys (all 10 catalogs; English is source of truth)

None carry `{placeholders}` ⇒ trivial `catalogs.test` parity. All are static `t()` literals in the scanned `SettingsPage.tsx` ⇒ covered by `i18n-app-keys` with no test edit.

| Key | English source |
| --- | --- |
| `settings.section.appearance` | `Appearance` |
| `settings.theme.intro` | `Match your browser, or force light or dark. Applies instantly; the choice is stored on this device only.` |
| `settings.theme.legend` | `Color theme` |
| `settings.theme.auto` | `Auto (match browser)` |
| `settings.theme.light` | `Light` |
| `settings.theme.dark` | `Dark` |

The other 9 locales must be **genuinely translated** (parity only checks keys+tokens; do not leave EN strings masquerading as translations). Suggested `settings.section.appearance`: ru `Оформление`, de `Darstellung`, es `Apariencia`, pt `Aparência`, fr `Apparence`, it `Aspetto`, zh `外观`, hi `रूप`, uk `Оформлення`.

### Phase 1 manual visual gate

1. `pnpm --filter @asset-doctor/web test` (theme.test + dark contrast block + i18n-app-keys + catalogs green), `pnpm typecheck`, `pnpm lint` clean.
2. `pnpm --filter web build`, serve `dist/`; DevTools set `<html data-theme="dark">` and confirm `bg-bg`/`text-ink`/`border-line` recompute to the dark hexes (unlayered override actually wins). Grep the two dark blocks are byte-identical.
3. FOUC: dark OS + no stored pref → hard reload (cache off) → first paint is dark. Set `localStorage['ad.theme']='light'` under dark OS → first paint light.
4. Auto follows OS live: pref=Auto, flip OS dark↔light with the tab open → whole app (chrome, cards, film cards, native `<select>`/scrollbars via `color-scheme`) flips, no reload, zero JS.
5. Settings → Appearance: radiogroup is Tab-reachable, arrow-key navigable, reflects the stored pref; Light/Dark flip instantly and survive reload; Auto removes the attribute and returns to OS-following.
6. Both themes, both views: idle/landing, results (VerdictBar, TriageLedger incl. the folder-group header label, FilmViewer readouts, FixCard, the engine chip in the migration `<details>`), Settings. No washed-out text; film cards read as the deepest inset wells; CTA stays green/white; focus ring visible on dark.
7. a11y unchanged: skip link first tab stop → `#ad-main`; one `<h1>` per view; `role=status` still announces; reduced-motion still kills scanline/reveals (theme is orthogonal to motion).

---

## PHASE 2 — Idle/landing hero redesign

Two-column hero replacing the single-column `Dropzone` **in place** (no new `t()`-bearing component, so the `i18n-app-keys` contract is unchanged). Right column reuses the already-honest specimen geometry as the illustrative demo **and** the real drop target. Because Phase 1 shipped the dark tokens, the hero is automatically dark-safe.

### Files touched

| File | Change |
| --- | --- |
| `apps/web/src/lib/hero-readout.ts` | **NEW** pure module (4 honest `'—'` readout cells) |
| `apps/web/test/hero-readout.test.ts` | **NEW** Node test (pins cell set + `'—'` honesty + frozen) |
| `apps/web/src/App.tsx` | Rewrite `Dropzone` body (822–901) into the two-column hero; import `landing-specimen`, `film-legend-style`, `hero-readout`, `h2IdOf`; 3 new `t()` keys |
| `packages/i18n/src/catalogs/*.json` (all 10) | 3 new keys |

No `index.css` change (reuses `.ad-grid`/`.ad-clip`/`.ad-viewer-shadow`/`.ad-scanline`/`.ad-pulse-dot`/`.ad-progress-*`/`.ad-label-sm`).

### 1. NEW `apps/web/src/lib/hero-readout.ts`

Machine-checks invariant 3: the pre-drop hero asserts **zero** fabricated user metrics.

```ts
export const HERO_DEMO_VALUE = '—';
export interface HeroReadoutCell {
  readonly label: string;                    // literal technical mono caption (rendered via .ad-label-sm), not translated
  readonly value: typeof HERO_DEMO_VALUE;    // always the honest absent-metric placeholder
}
export const HERO_READOUT_CELLS: readonly HeroReadoutCell[] = Object.freeze([
  { label: 'VRAM', value: HERO_DEMO_VALUE },
  { label: 'EMPTY', value: HERO_DEMO_VALUE },
  { label: 'DRAW', value: HERO_DEMO_VALUE },
  { label: 'SIZE', value: HERO_DEMO_VALUE },
]);
```

**`apps/web/test/hero-readout.test.ts`** — Node test: labels equal `['VRAM','EMPTY','DRAW','SIZE']` in order; `HERO_DEMO_VALUE==='—'` and every cell value is `'—'` (invariant 3, no fabricated numbers); `Object.isFrozen(HERO_READOUT_CELLS)` is true.

(The `VRAM/EMPTY/DRAW/SIZE` labels are literal technical mono captions matching the FilmViewer/SpecimenFilm untranslated readout convention — no i18n key, like the existing readout cells.)

### 2. `App.tsx` — the `Dropzone` rewrite

New imports:
```ts
import { SPECIMEN_FRAMES, SPECIMEN_ZONES, SPECIMEN_VIEWBOX } from './lib/landing-specimen';
import { ZONE_STYLE } from './lib/film-legend-style';
import { HERO_READOUT_CELLS } from './lib/hero-readout';
import { h2IdOf } from './lib/landing-nav';   // instead of hardcoding 'how-it-works-h2'
```

Replace the returned `<section>` (822–901). Structure (full JSX per Track A §3, adopted with the `h2IdOf` correction):

- **LEFT column** (`text-center lg:text-left`): mono eyebrow (`text-xs uppercase tracking-[0.06em] text-teal-text` + `.ad-pulse-dot bg-cta` — `text-xs` is not a bracket size, so the label guard is not triggered); the **single** `h1#ad-dropzone-h1` (keeps `tabIndex={-1}` + `ad-focus-anchor`; `focusTargetAfterSwap` still resolves); `landing.tagline` (ink); `dropzone.subtitle` (ink-soft); a CTA row with the green **Open folder** button (`id={LANDING_OPEN_FOLDER_ID}`, reused by `landing-nav.scanFolder`) + a secondary "See how it works" link (`href="#how-it-works"`, `onClick={scrollToHow}`); a shield privacy line (`dropzone.privacy`, mono ink-soft, `stroke="var(--color-ok)"`); `{phase.t==='error' && <ErrorNotice mt="mt-6" />}`; the `landing.mobileNote` line (`sm:hidden`).
- **RIGHT column** — the signature viewer, which is also the drop target:
  - Wrapper carries `onDragOver/onDragLeave/onDrop` (calls `onDrop(dataTransfer.items)`) + `onClick={onOpen}` + `className="ad-grid ad-clip ad-viewer-shadow ... cursor-copy"`.
  - **`aria-hidden={analyzing ? undefined : true}`** — the fabricated demo chrome (filename/PNG badge/`'—'`) is hidden from SR when idle; while analyzing the wrapper is un-hidden so the inner `role=status` progress **is** announced. (aria-hidden on a non-focusable clickable div is acceptable: the real keyboard/SR control is the labeled Open-folder button; drag-drop is mouse-only.)
  - Top bar: `symbols.png` (mono, film-soft) + a `PNG` badge (`bg-info text-film`).
  - Stage (`aspect-square`): when `analyzing`, render the existing analyzing block verbatim (scanline + `Logo` + `role=status aria-live` progress text using `dropzone.analyzing`/`dropzone.progress` + the `ad-progress-track`/`ad-progress-fill` progressbar from `progressView`); otherwise render the specimen SVG (`SPECIMEN_FRAMES`/`SPECIMEN_ZONES`/`SPECIMEN_VIEWBOX` + `ZONE_STYLE[z.kind]`, `strokeDasharray` on empty zones) + `.ad-scanline` + a `dragging` "Drop to diagnose" overlay (`dropzone.dropPrompt`).
  - 4-cell readout strip from `HERO_READOUT_CELLS` (labels via `.ad-label-sm`, values `'—'`).
  - **Honesty caption OUTSIDE the aria-hidden wrapper** (so SR reads it): `dropzone.demoCaption` (mono, ink-soft = AA on light and dark).

`dragging`, `analyzing`, `view` are already declared in `Dropzone` (818–821) — reused verbatim. `ErrorNotice` already accepts `mt`. `scrollToHow` mirrors `Landing.onAnchorClick`: `getElementById(h2IdOf('how-it-works')).focus({preventScroll:true})` + `scrollIntoView({behavior: reduce()?'auto':'smooth'})` + `history.replaceState(null,'','#how-it-works')` (reduced-motion-gated; `#how-it-works` never matches the settings router). **Drop `dropzone.footnote`** from the hero (its disk≠VRAM content is carried by Phase 3's §2 bar); the key stays catalogued for `LandingFooter`, so no catalog change.

Honesty: every readout value is `'—'`; the viewer is captioned as an illustrative demo; the only number anywhere is the `w×h×4=16 MB` formula in §2. No waitlist/email/percentages.

### 3. New i18n keys (all 10 catalogs; no placeholders)

| Key | English source |
| --- | --- |
| `dropzone.privacy` | `100% in-browser analysis. Your assets never touch a server.` |
| `dropzone.demoCaption` | `Illustrative demo — drop your own atlas to run a real diagnosis.` |
| `dropzone.dropPrompt` | `Drop to diagnose` |

Reused unchanged (do **not** rename): `dropzone.{title,subtitle,open,analyzing,progress}`, `landing.{tagline,scrollHint,mobileNote}`, `header.xray`. Translate all 3 new keys into the other 9 locales.

### Phase 2 manual visual gate

1. Tests green (hero-readout + i18n-app-keys + label-tokens + catalogs); typecheck/lint clean.
2. Idle hero: pitch left, signature viewer right; scanline sweeps once; readout shows `VRAM — / EMPTY — / DRAW — / SIZE —`; caption reads "Illustrative demo — …". No fabricated numbers anywhere.
3. Keyboard: Tab → skip link → green **Open folder** button → "See how it works". Enter on the button opens the picker; Enter on the link smooth-scrolls to How-it-works and moves focus to its h2.
4. Drag a folder over the viewer → dashed "Drop to diagnose"; drop → analyzing progress fills the stage (`role=status` announced) → results replace the whole hero (real FilmViewer).
5. SR: the demo chrome is **not** announced (aria-hidden); the honesty caption **is**; during analyzing "analyzing… N/M" is spoken.
6. Reduced-motion ON: no scanline, no pulse; viewer still legible.
7. Resize <lg: hero stacks, text centers, viewer scales; at 320px the 4 readout cells + both CTAs stay readable/tappable.
8. Locale sweep (de longest, then zh/hi): eyebrow, CTAs, shield line, caption don't clip.
9. Dark + light both correct (Phase 1 tokens): left-column text and caption AA on both; viewer identical (film is always dark).

---

## PHASE 3 — Landing-sections polish + results/settings re-skin

The results view and Settings are **already** the mockup's design language and are 100% token-driven, so Phase 1's overrides flip them automatically. Phase 3 is (a) the bolder disk≠VRAM bar, (b) a small honest capability-card polish, and (c) a verification pass — no further required code beyond Phase 1's two className fixes.

### Files touched

| File | Change |
| --- | --- |
| `apps/web/src/components/landing/Landing.tsx` | §2 disk≠VRAM 2-column card with a dark VRAM meter (179–210); §3 neutral teal accent dot on capability cards (218–223) |

No new i18n keys (all reused). No `index.css` change. No results-component code change (Phase 1 already did the two required fixes).

### 1. Landing §2 — bolder disk≠VRAM bar (all keys reused, honest)

Replace §2's figure block (179–210) with a 2-column card: prose left, a dark `ad-grid` VRAM meter right (`role="img"` carrying `landing.vram.figureAlt`; inner labels `aria-hidden`). A short green **disk** bar (`bg-ok`, static `width:'8%'`) over a full **VRAM** bar (`bg-gradient-to-r from-warn to-crit`, static `width:'100%'`) on a `bg-film-line` track, plus the honest `landing.vram.math` anchor (`2048 × 2048 px × 4 bytes = 16 MB`), then the existing `landing.vram.mip` / `landing.vram.note` lines below. Bar widths are static inline (no width transition) ⇒ reduced-motion-safe by construction. The 8%-vs-100% split is a **qualitative** illustration; the quantitative anchor is the real formula — no fabricated 84→210.

AA: on the `.ad-grid` bg, value text uses `text-ok` (5.59:1) / `text-crit` (4.95:1) — both pass; bar fills are non-text (1.4.11 ≥3:1); this holds in dark too (film tokens are theme-independent).

### 2. Landing §3 — neutral teal accent dot (honest)

Add `<span aria-hidden="true" className="mb-3 block h-2 w-2 rounded-full bg-teal" />` above each capability card's `<h3>`. A **neutral** teal dot, not crit/warn/info — the caps grid lists capabilities, not finding severities; coloring them by severity would fabricate data. No new keys. (This is optional polish — safe to defer.)

### 3. Results/settings re-skin — verification only

Everything else flips with zero code change because it is token-driven. The two required dark-AA fixes already landed in Phase 1 (engine chip `text-panel`, ledger folder header `text-teal-text`). **Deferred cosmetic polish (recommend not doing):** unifying card radius to `rounded-2xl`, roomier section spacing, mockup pulsing dots (the results chips use static dots deliberately for compositor perf at 1000+ rows — keep static).

### Phase 3 manual visual gate

1. Dark, results view (drop a folder with findings): FilmViewer reads as a distinct inset well against the page (film < bg elevation); VerdictBar chips, TriageLedger (search/sort/group controls, selected-row tint, **folder-group header label legible** via C.3), Findings, PrimaryRecommendation (green CTA white-on-green intact), FixCard incl. the migration `<details>` engine toggle **legible** (C.2) — all AA, none white-on-accent.
2. Dark, Settings: all cards + the Appearance card render on dark; native `<select>`/inputs use dark chrome (`color-scheme`); `accent-teal` checkboxes show a teal check on a dark box.
3. §2: prose left / dark meter right; short green disk bar, full warn→crit VRAM bar; math anchor "2048 × 2048 px × 4 bytes = 16 MB" visible; `role=img` announces `landing.vram.figureAlt`. §3: neutral teal dots, no severity coloring.
4. Light regression: entire surface byte-identical to today except the engine toggle (now `text-panel`, indistinguishable in light) and the ledger folder-header label (now `teal-text`). No other drift.
5. Reduced-motion: theme flip is an instant repaint; §2 bars render at final width instantly; no new animation.

---

## DROPPED OR DEFERRED

- **Track C's separate `<ThemeSwitcher/>` component + `theme.*` namespace** — DROPPED. A new component file is outside the `i18n-app-keys` scan set; its `t()` keys would be an uncaught drift hole. Replaced by Track B's self-contained inline-radio `ThemeCard` in the already-scanned `SettingsPage.tsx`, under the `settings.*` namespace.
- **Track C's engine-chip rewrite (`border-teal bg-panel text-ink`)** — DEFERRED in favor of `text-white → text-panel` (one word, zero light regression, AA-proven both themes).
- **Track C's suggested palette (#10161d/#161d26)** — SUPERSEDED by Track B's #141b24/#1e2a36 (satisfies the same film<bg<panel ordering with more film separation; both empirically ordered).
- **Real severity-dot "what it catches" finding cards** (mockup §5) — DEFERRED. Honest only if a new section maps each finding type to its real severity (new copy); mapping severities onto the generic capability grid fabricates per-type data (invariant 3). Neutral teal dot is the only honest polish now.
- **Render-probe live-readout dark card** (mockup §6) — DEFERRED. Keep the existing honest privacy strip; a demo readout must use `'—'` values + an illustrative caption, which adds markup/complexity for no diagnostic value pre-drop.
- **`dropzone.eyebrow` upgrade** — DROPPED. Keep reusing `header.xray` to avoid 10 cosmetic translations.
- **`dropzone.footnote` in the hero** — REMOVED from the hero (content moves to §2's bar); key stays catalogued for `LandingFooter`, so no catalog change.
- **Raw severity-hue-as-text light-AA gaps** (`SettingsPage` `⚠`/`✕`, some FilmViewer/receipt sites) and the raw micro-label stack at `TriageLedger.tsx:529` (that file isn't in the label-guard set) — OUT OF SCOPE. Pre-existing light-mode issues that dark does **not** regress (dark actually improves the orange/red ones). Route through AA-safe `*-text` tokens / `.ad-label` in a separate theme-agnostic a11y follow-up.
- **Waitlist / "Notify me" / email / illustrative percentages / render-probe live numbers** — never adopted (invariants 3/4).
- **Cosmetic results polish** (radius unification, looser spacing, pulsing result-chip dots) — DEFERRED; taste-only and the pulsing dots would regress the deliberate static-dot compositor-perf choice at scale.