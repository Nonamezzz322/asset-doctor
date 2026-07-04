# App-screen re-skin — unified phased spec (design workflow wkq91mvp9)

I now have full grounding. Every load-bearing claim across all four tracks is verified against the real files. Here is the unified spec.

---

# Asset Doctor — APP-SCREEN re-skin: unified, phased, buildable spec

## Grounding verdict (what I verified, what I killed, what I resolved)

I independently checked every load-bearing claim against the real tree. Summary:

**Verified true** (safe to build on): `route.ts` (`View='main'|'settings'`, `viewOfHash`), `focus-move.ts` (`FOCUS_ANCHORS`, `focusTargetAfterSwap` logic), `license.ts` (`PRO_GATE_ENABLED`, `isProUnlocked`, `currentEntitlement`, `maybeRefresh`), `LicensePanel.tsx` (`ActivatePanel`/`ProBadge`, `CHECKOUT_URL`-gated buy link, `text-crit` line 53, `text-ok`+`bg-ok` dot 74-75), `landing-nav.ts` (`pricingLineKey`), `import.ts` (FS-Access `pickFolder` uses empty prefix → root files are bare-name; `<input>` uses `webkitRelativePath`; drag strips leading `/`), `App.tsx` (header 477-515, `HeaderMetric` block 485-506, settings link 509, live region 528, hidden wrapper 536, sr-only results h1 560, `MobileTotal` strip 586-592, settings render 662, `savedPct` 253, count-guard 415, `FixCard` 1115 / unlocked 1122 / effect 1186 / gate branch 1405 / both roots `rounded-xl border-2 border-teal/70 bg-panel p-4` w/ `ref={cardRef}` 1407+1415, `bg-teal-text text-panel` precedent 2086), `Findings.tsx` (`DOT` **is** exported, `Record<Severity,string>`), `core` (`atlasFrames: Record<string,Rect[]>`, `totals.{diskBytes,loadedVramBytes,potentialDiskSaved,probe.{drawCalls,vramBytes,declaredVramBytes,atlasesProbed}}`), `results-heading.ts` (problems = crit+warn+info), `TriageLedger.tsx` (`ROW_H=52` L33, `metricBadge` 76-83, `LedgerRowView` 85, `rounded-xl` 487/515, `text-ink-soft/80` 555), `SettingsPage.tsx` (`Card` = `rounded-xl border border-line bg-panel p-4` L50-52, `NumberRow`/`CheckRow` `title={hint}`, `text-warn` 432/494, `text-crit` 358/361/387/618), `contrast.test.ts` helpers (`contrastRatio`, `AA_LARGE/NORMAL`, `chipLabelPassesAABothThemes`, `inkSoftPassesAA`, `DARK_*`), `i18n-app-keys.test.ts` (`comp('X.tsx')` appSrc pattern), 10 catalogs present, all reused keys present in `en.json`, plural keys use `$count`/`one`/`other` in **every** locale (ru/uk included — no few/many required).

> Note: `TriageLedger.tsx` contains 2 stray NUL bytes (makes plain `grep` skip it; `grep -a` works). Pre-existing, out of scope, but flag it — anyone editing that file should strip them.

**KILLED / upheld-as-killed (dishonest or AA-failing):**
1. **Fake payment surface** — monthly/annual toggle, Pro $19 / Studio $49 tiers, card-number/expiry/CVC form, "Pay $N", "Encrypted · cancel anytime". No client-side charging exists (only `activate/refresh/deactivate` in `license.ts`); prices are pure invention (invariant 2/3/4). → Replaced by the real `LicensePanel` surface + gate-honest info.
2. **Fabricated "0.9s" analysis timing** — `run()` records no wall-clock. Omit entirely (never invent).
3. **`/160`, `/90` budget bars** — no user budget exists. Deferred to a later phase; never render a budget bar without a real user budget.
4. **Fabricated viewer overlay "42% empty · 16 MB VRAM"** — an illustrative label baked onto the stage. `FilmViewer` already paints honest rectangles + legend + readout. Do not add it; `FilmViewer` gets **no** structural change.
5. **Raw `#0E8C8C` + white active fills** (mockup nav + mockup segmented) — ≈4.04 / ≈3.9:1, fail AA for 14px text. → Use the AA-proven `bg-teal-text text-panel` pair (light 5.428 / dark 7.155, `contrast.test.ts:208-212`, live precedent `App.tsx:2086`).
6. **`div + onClick` nav / controls** — replaced by real `<nav aria-label>` + `<a aria-current>`, `role="switch"`, `role="radiogroup"` native radios.

**Conflicts resolved:**
- **Metric strip ownership (Track A §4e vs Track B §2b).** Both delete `HeaderMetric`+`MobileTotal`. Phase 1 removes the top header (which *contains* `HeaderMetric`) and must stay honest on invariant 5 by itself → Phase 1 relocates totals to **one unconditional `buildTotalsRows` strip** (reuse the existing tested `MobileTotal` render, drop `md:hidden`). Phase 2 then **supersedes** that interim strip with the 4-card budget strip and retires `buildTotalsRows`/`MobileTotal`/`savedPct`.
- **Pro surface duplicated (Track A vs Track D).** Both add `PRO_HASH` + `ad-pro-h1` + a `ProPage` + a pure module, with different key names. → **All Pro surface ships together in Phase 4** (route `'pro'`, focus anchor, one component `ProPage.tsx`, sidebar Pro nav + plan card, one merged pure module `pro-view.ts`, one `pro.*`/`nav.pro` key set). Phase 1's sidebar carries **only Scan + Settings** (exact parity with today's header, which only has `settings.nav`) so Phase 1 has no dangling route.
- **ProPage inline (A) vs separate file (D).** → Separate `components/ProPage.tsx` (matches `LicensePanel` convention), registered in the i18n scanner's `appSrc`.
- **Contrast-debt sweep scope (Track C §5).** Localized fixes using **existing** AA tokens on the surfaces actually re-skinned ship in Phase 3. The pervasive `FixCard`/Receipt `text-warn`/`text-crit`/`text-ok`-as-text sweep + a **new `--color-warn-text` token** are **deferred** (pre-existing debt, needs its own contrast proof + review; not caused by the re-skin).
- **Radius.** Standardize on `rounded-2xl` in Phase 3 across the whole board including the Phase-2 budget cards (which ship as `rounded-xl` in Phase 2 to match the then-current board, and get bumped with everything else in Phase 3 — no transient seam).

---

# PHASE 1 — the persistent sidebar SHELL (foundation, a11y-preserving)

**Goal:** replace the top `<header>` (App.tsx:477-515) with a persistent left sidebar shell; keep the entire a11y bar byte-intact; relocate the header metrics into one honest results-totals strip so invariant 5 never regresses. **No Pro nav, no route change, no new color token.**

### Files
- `apps/web/src/App.tsx`
- `apps/web/src/index.css`
- `packages/i18n/src/catalogs/*.json` (2 new keys × 10)

### App.tsx changes

**1. Remove the top `<header>` (477-515)** and replace the outer structure with the shell row. Keep every a11y element in place:
- Skip-link stays the **first DOM child** of the outer div (`position:fixed`, first tab stop → `#ad-main`).
- Live region (`role=status`) stays the **first child of `<main>`**, outside the `hidden` wrapper.
- `LandingFooter` stays a top-level sibling after the shell row.

```tsx
<BuildSettingsProvider>
  <div className="flex min-h-full flex-col bg-bg text-ink">
    <a href="#ad-main" className="ad-skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('ad-main')?.focus(); }}>
      {t('a11y.skipToContent')}
    </a>
    <div className="flex-1 lg:flex">
      <Sidebar view={view} />
      <main id="ad-main" tabIndex={-1} className="ad-focus-anchor min-w-0 flex-1">
        <span role="status" aria-live="polite" aria-atomic="true" className="ad-sr-only">{live.text}{live.nudge ? ' ' : ''}</span>
        <div className="ad-main-pad mx-auto max-w-6xl px-6 py-8 lg:px-8">
          <div hidden={view === 'settings'}>
            {/* …unchanged Dropzone/Landing + results branch, EXCEPT the metric relocation below… */}
          </div>
          {view === 'settings' ? (<SettingsPage hasResults={!!report} hiddenRules={hiddenRules} onChangeHiddenRules={setHiddenRulesPersisted} />) : null}
        </div>
      </main>
    </div>
    {view === 'main' && phase.t !== 'done' && <LandingFooter switcher={<LanguageSwitcher />} />}
    <input ref={inputRef} type="file" multiple hidden onChange={/* unchanged */} />
  </div>
</BuildSettingsProvider>
```
The `hidden={view === 'settings'}` gate is **unchanged** in Phase 1 (no `pro` view yet). `.ad-main-pad` carries a CSS var only for the bleed fix.

**2. New inline `Sidebar` component** (inline in App.tsx like `Dropzone`/`LanguageSwitcher`, so `t('…')` literals are auto-scanned by `i18n-app-keys`). Root `<header>` = the single banner landmark; contains a real `<nav aria-label>`; **no heading** inside (no h1 conflict). Two nav items only (Scan, Settings).

```tsx
function NavIcon({ d }: { d: 'scan' | 'settings' }) { /* inline SVG, stroke="currentColor", aria-hidden */ }
function NavItem({ href, active, icon, label }: {href:string;active:boolean;icon:React.ReactNode;label:string}) {
  return (
    <a href={href} aria-current={active ? 'page' : undefined}
       className={`flex items-center gap-2.5 rounded-lg px-3 py-2 font-sans text-sm font-medium transition ${
         active ? 'bg-teal-text text-panel' : 'text-ink-soft hover:bg-bg hover:text-ink'}`}>
      {icon}{label}
    </a>
  );
}
function Sidebar({ view }: { view: View }) {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-50 flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5
                       lg:h-screen lg:w-[236px] lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-0 lg:border-b-0 lg:border-r lg:p-0">
      <a href="#" className="flex items-center gap-2.5 lg:border-b lg:border-line lg:px-5 lg:py-5">
        <Logo /><span className="font-display text-[16px] font-semibold tracking-tight text-ink">Asset Doctor</span>
      </a>
      <nav aria-label={t('nav.label')} className="flex flex-row gap-1 lg:mt-0 lg:flex-1 lg:flex-col lg:gap-0.5 lg:p-3">
        <NavItem href="#"          active={view === 'main'}     icon={<NavIcon d="scan" />}     label={t('nav.scan')} />
        <NavItem href={SETTINGS_HASH} active={view === 'settings'} icon={<NavIcon d="settings" />} label={t('settings.nav')} />
      </nav>
      <div className="ml-auto lg:ml-0 lg:border-t lg:border-line lg:p-3.5"><LanguageSwitcher /></div>
    </header>
  );
}
```
Active fill = **`bg-teal-text text-panel`** (AA-proven both themes). Inactive `text-ink-soft` (AA on panel 6.07/6.543) + `hover:bg-bg` (bg sits below panel in the dark elevation order → reads as a hover well). Below `lg`: a sticky top bar (`flex-wrap` → wraps on 320px, no drawer/JS/focus-trap). At `lg+`: 236px full-height sticky column; the **page** scrolls (existing in-results `lg:sticky lg:top-20` keeps working).

**3. Metric relocation (invariant 5 — mandatory consequence of removing the header):**
- Delete the desktop `HeaderMetric` block (485-506) and the `HeaderMetric` fn.
- Change the sub-md `MobileTotal` strip wrapper (587): drop `md:hidden` → it becomes the single unconditional totals strip (`buildTotalsRows`-driven: declared VRAM, probe-gated measured chip, disk, saveable+`savedPct`) shown above `VerdictBar` at all widths.
- Keep `buildTotalsRows`, `MobileTotal`, `savedPct`, `totals` (all reused this phase; retired in Phase 2).

### index.css change (the one required CSS edit — the `.ad-bleed` conflict)
The landing dark privacy strip (`Landing.tsx`) uses `.ad-bleed` = `margin-inline: calc(50% - 50vw)` (viewport bleed). With a 236px sidebar, `main` no longer starts at the viewport edge → a viewport bleed overflows right. Fix: keep true viewport bleed on mobile (sidebar absent), switch to content-column bleed on `lg`:
```css
.ad-bleed { margin-inline: calc(50% - 50vw); }        /* mobile: sidebar absent → viewport bleed */
@media (min-width: 1024px) {
  .ad-bleed { margin-inline: -2rem; }                 /* lg: cancel the px-8 content column padding */
}
```
`html { overflow-x: clip }` stays. Dark-safe (`bg-film` unchanged). Visual delta on `lg`: the privacy band spans the `max-w-6xl` content column instead of the full viewport (intentional, sidebar-consistent). `.ad-skip-link`, `.ad-sr-only`, `.ad-focus-anchor` untouched.

### New i18n keys (2, all 10 catalogs)
| Key | English source | Coverage |
| --- | --- | --- |
| `nav.label` | `Primary` | aria-label, literal in App.tsx → scanned |
| `nav.scan` | `Scan & results` | literal → scanned |
Reused: `settings.nav`, `a11y.skipToContent`.

Translations (order: ru · uk · de · es · pt · fr · it · zh · hi):
- `nav.label`: Основное · Основне · Primär · Principal · Principal · Principal · Principale · 主导航 · मुख्य
- `nav.scan`: Скан и отчёт · Скан і звіт · Scan & Ergebnisse · Escaneo y resultados · Verificação e resultados · Analyse et résultats · Scansione e risultati · 扫描与结果 · स्कैन और परिणाम

### Pure modules / Node tests
None new this phase. Shell wiring (sidebar sticky, `aria-current`, skip-link focus, `hidden` swap) is verified by the manual gate, exactly as the current header/route seams are.

### Manual visual gate (light + dark via Settings → Appearance; ≥1280px and ≤420px)
1. Tab from fresh load → **first** focus is the skip-link; Enter lands focus in `<main>` (ring-suppressed), bypassing the sidebar nav.
2. Sidebar on all states (idle landing, results, settings); active item has teal fill + `aria-current="page"`; both links keyboard-reachable; navigating Settings moves focus to `ad-settings-h1`.
3. Exactly one h1 per screen (dropzone/results sr-only h1, settings h1); no heading inside the sidebar.
4. Results totals strip (declared/measured/saveable) visible at desktop **and** mobile; disk≠VRAM labels intact; measured chip only when probed.
5. Landing privacy strip: centered + bounded to the content column on desktop, edge-to-edge on mobile; **no horizontal page scroll** in either theme.
6. Below `lg`: sidebar is a sticky top bar (brand · nav · language), wraps not overflows at 320px; footer (contentinfo) spans full width under the shell.
7. `#settings` deep-link + stale `#foo` resolve without blanking; report/film/fix state survives navigation.

---

# PHASE 2 — results header + real-metric budget strip (no over-budget comparison)

**Goal:** adopt the mockup's chart-header (green-dot eyebrow + folder h1 + counts + recoverable stat + "Download the fix") and the 4-card budget strip, filled **only** with real report data. Supersedes the Phase-1 interim totals strip. **No user budgets, no budget bars, no timing string.**

### Files
- `apps/web/src/App.tsx`
- `apps/web/src/lib/results-summary.ts` (new) + `apps/web/src/lib/results-summary.test.ts` (new)
- `packages/i18n/src/catalogs/*.json` (15 new keys × 10)

### New pure module `lib/results-summary.ts` (Node-tested; precedent: `totals-rows.ts`, `results-heading.ts` — pure, `t`-free, no DOM)
```ts
import type { AnalysisReport } from '@asset-doctor/core';
import type { TriageIndex } from './triage';

/** Folder label from the picked files' common leading DIRECTORY segment. Returns the first segment IFF
 *  every path shares it AND every path has a '/' after it (a real dir, not a bare root-level filename).
 *  null ⇒ FS-Access root-level files / mixed roots / empty → caller falls back honestly. */
export function folderLabel(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const root = paths[0]!.split('/')[0]!;
  if (root === '' || paths[0]!.indexOf('/') < 0) return null;
  for (const p of paths) if (p.indexOf('/') < 0 || p.split('/')[0] !== root) return null;
  return root;
}

export interface AssetCounts { atlases: number; sprites: number; looseImages: number; }
export function assetCounts(report: AnalysisReport): AssetCounts {
  const frames = report.atlasFrames ?? {};
  const keys = Object.keys(frames);
  const sprites = keys.reduce((n, k) => n + frames[k]!.length, 0);
  return { atlases: keys.length, sprites, looseImages: Math.max(0, report.assets.length - keys.length) };
}

export interface SevSegment { sev: 'crit' | 'warn' | 'info'; count: number; }
export interface BudgetModel {
  vram: { loaded: number; measured: { vram: number; declared: number; atlasesProbed: number } | null };
  draw: { calls: number | null; atlasesProbed: number | null };
  disk: { total: number; saved: number; after: number; savedPct: number };
  findings: { problems: number; crit: number; warn: number; info: number; segments: SevSegment[] };
}
export function budgetModel(totals: AnalysisReport['totals'], tally: TriageIndex['tally']): BudgetModel {
  const savedPct = totals.diskBytes > 0 ? Math.round((totals.potentialDiskSaved / totals.diskBytes) * 100) : 0;
  const after = Math.max(0, totals.diskBytes - totals.potentialDiskSaved);
  const p = totals.probe;
  const segments = ([['crit', tally.crit], ['warn', tally.warn], ['info', tally.info]] as const)
    .filter(([, n]) => n > 0).map(([sev, count]) => ({ sev, count }));
  return {
    vram: { loaded: totals.loadedVramBytes, measured: p ? { vram: p.vramBytes, declared: p.declaredVramBytes, atlasesProbed: p.atlasesProbed } : null },
    draw: { calls: p ? p.drawCalls : null, atlasesProbed: p ? p.atlasesProbed : null },
    disk: { total: totals.diskBytes, saved: totals.potentialDiskSaved, after, savedPct },
    findings: { problems: tally.crit + tally.warn + tally.info, crit: tally.crit, warn: tally.warn, info: tally.info, segments },
  };
}
```

**Test `lib/results-summary.test.ts`** (Vitest/Node):
- `folderLabel`: `['a/x.png','a/y.png']→'a'`; nested `['a/b/x.png','a/z.png']→'a'`; single `['a/x.png']→'a'`; mixed `['a/x.png','b/y.png']→null`; bare-root `['x.png','y.png']→null`; empty `[]→null`; leading-slash `['/a/x.png',…]` first segment `''`→`null`.
- `assetCounts`: atlases=keys, sprites=Σ, loose=assets−atlases; `atlasFrames` absent → `{0,0,assets.length}`; loose clamped ≥0.
- `budgetModel`: `diskBytes:0 → savedPct 0, after 0` (no NaN); `after=total−saved` clamped ≥0; probe absent → `vram.measured null`, `draw.calls null`; probe present → fields wired; segments drop zero-count severities, preserve crit→warn→info order; `problems` excludes `ok`.

### App.tsx changes
**Imports:** `import { folderLabel, assetCounts, budgetModel } from './lib/results-summary';` · `import { Findings, DOT } from './components/Findings';` (DOT is already exported) · add `const FIX_CARD_ID = 'ad-fix-card';`.

**Retire the Phase-1 interim strip:** remove the unconditional `MobileTotal` strip, the `MobileTotal` fn, the `buildTotalsRows` import, and the `savedPct` const (253 — now from `budgetModel`). Keep `totals`. If `grep` confirms no other consumer, delete `lib/totals-rows.ts` + its test in the same commit (optional; harmless to leave — still tested).

**Derive values** just after the results guard opens (552):
```tsx
const bm = budgetModel(report.totals, index.tally);
const counts = assetCounts(report);
const subject = folderLabel(files.map((f) => f.path)) ?? t('results.subject.fallback');
const countsSuffix = counts.atlases > 0
  ? [t('results.counts.atlases', { n: counts.atlases }), t('results.counts.sprites', { n: counts.sprites }),
     ...(counts.looseImages > 0 ? [t('results.counts.loose', { n: counts.looseImages })] : [])].join(' · ')
  : counts.looseImages > 0 ? t('results.counts.loose', { n: counts.looseImages }) : '';
```

**Replace the sr-only h1 (560) with the visible header.** The id `ad-results-h1` is **preserved verbatim** → `focus-move.ts` and `aria-labelledby="ad-results-h1"` keep working (no focus-move change). Outline stays h1 → h2(PrimaryRec) → h2(VerdictBar) → h2(findings.title).
```tsx
<div className="flex flex-wrap items-start justify-between gap-4">
  <div className="min-w-0">
    <div className="mb-1.5 flex flex-wrap items-center gap-2 font-mono text-xs">
      <span className="flex items-center gap-1.5 text-cta-text">
        <span className="h-[7px] w-[7px] rounded-full bg-ok" aria-hidden="true" />{t('results.eyebrow.complete')}
      </span>
      <span className="text-ink-soft">· {t('results.eyebrow.inBrowser')}</span>
    </div>
    <h1 id="ad-results-h1" tabIndex={-1} className="ad-focus-anchor font-display text-2xl font-semibold tracking-tight text-ink">
      {subject}
      {countsSuffix ? <span className="ml-1.5 font-mono text-sm font-normal text-ink-soft">· {countsSuffix}</span> : null}
      <span className="ad-sr-only"> — {resultsHeading(index.tally, t)}</span>
    </h1>
  </div>
  {report.assets.length > 0 ? (
    <div className="flex items-center gap-3">
      {bm.disk.saved > 0 ? (
        <div className="text-right">
          <div className="ad-label text-ink-soft">{t('results.recoverable.label')}</div>
          <div className="font-mono text-2xl font-semibold text-cta-text">−{bm.disk.savedPct}%</div>
        </div>
      ) : null}
      <button type="button" onClick={jumpToFix}
        className="rounded-lg bg-cta px-4 py-2.5 font-sans text-sm font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover">
        {t('results.download')}
      </button>
    </div>
  ) : null}
</div>
```
Honesty: eyebrow = "Diagnosis complete · in-browser" (both true), **no timing**. Recoverable `−{savedPct}%` is the real ratio, hidden when `saved===0`. The sr-only companion keeps the honest problem-count for the rotor.

**Budget strip** (immediately after the header, before `PrimaryRecommendation`). `rounded-xl` cards this phase (bumped to `rounded-2xl` in Phase 3). Big numbers use **`text-ink` only** (severity hues fail AA as text, `contrast.test.ts:110-113`); severity color lives on decorative `aria-hidden` dots/segments, redundant with the numbers + VerdictBar chips.
- **VRAM footprint:** `fmtBytes(bm.vram.loaded)`; when probed, a measured subline (`metric.vramMeasured` + `readout.measuredScope` + the `readout.measuredAggregateTooltip` title).
- **Draw calls (probe-gated):** `bm.draw.calls` when non-null (+ `budget.measured` · scope), else `—` + `budget.draw.notMeasured`.
- **Disk size:** `fmtBytes(bm.disk.total)` → `fmtBytes(bm.disk.after)` `budget.disk.afterTag` when saved>0; an `aria-hidden` recoverable-fraction fill `bg-cta` width `savedPct%` (honest ratio, **not** a budget bar).
- **Findings:** `bm.findings.problems` + (allClear | top-severity chip); `aria-hidden` proportional severity segments `${DOT[s.sev]}` with `flexGrow:s.count`.

(Exact JSX per Track B §2d — token-only, dark-safe, no new tokens.)

**Jump handler** (near `jumpToUnparsed`, mirrors its reduced-motion gate):
```tsx
const jumpToFix = () => {
  const el = typeof document !== 'undefined' ? document.getElementById(FIX_CARD_ID) : null;
  const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  el?.querySelector<HTMLElement>('button, a, input')?.focus({ preventScroll: true });
};
```
**FixCard anchor:** add `id={FIX_CARD_ID}` to **both** FixCard root divs (1407 gated + 1415 main). Resolves "Download the fix" in either gate state (locked → lands on the activation input; beta/unlocked → the preview button). No fake charge.

### New i18n keys (15, all 10 catalogs)
`en.json` source (plural keys use `$count`/`one`/`other` in every locale, mirroring `triage.filter.*`):
```jsonc
"results.eyebrow.complete": "Diagnosis complete",
"results.eyebrow.inBrowser": "in-browser",
"results.subject.fallback": "Asset audit",
"results.counts.atlases": { "$count": "n", "one": "{n} atlas",       "other": "{n} atlases" },
"results.counts.sprites": { "$count": "n", "one": "{n} sprite",      "other": "{n} sprites" },
"results.counts.loose":   { "$count": "n", "one": "{n} loose image", "other": "{n} loose images" },
"results.recoverable.label": "recoverable",
"results.download": "Download the fix",
"budget.vram.label": "VRAM footprint",
"budget.draw.label": "Draw calls",
"budget.draw.notMeasured": "not measured",
"budget.measured": "measured",
"budget.disk.label": "Disk size",
"budget.disk.afterTag": "after fix",
"budget.findings.label": "Findings"
```
Reused (no new copy): `metric.vramMeasured`, `readout.measuredScope`, `readout.measuredAggregateTooltip`, `triage.filter.crit|warn|info`, `triage.allClear`, `a11y.resultsHeading`. All new keys are `t('…')` literals in App.tsx (already in `appSrc`) → auto-scanned. Translations follow the same 9-locale pattern; count keys keep `$count`/`one`/`other` and translate the noun (e.g. ru `{n} атлас` / `{n} атласа` acceptable at other-form parity; convention across the repo is one/other only).

### Tokens
No new tokens (surfaces: `bg-panel`/`border-line`/`bg-line`/`bg-bg`; text `text-ink`/`text-ink-soft`/`text-cta-text`; decorative `bg-ok`/`bg-cta`/`DOT[sev]`; `ad-label`). `contrast.test.ts` needs **no** change.

### Manual visual gate
1. Drop a folder via **drag** and via **`<input webkitdirectory>`** → h1 = folder name + "· N atlases · M sprites" (+ "· K loose images" when present).
2. **FS-Access `showDirectoryPicker`** (Chrome) → h1 = "Asset audit · …counts…" (folderLabel null), never a fabricated name.
3. Loose-only folder → "…· K loose images", no "0 atlases".
4. Eyebrow "Diagnosis complete · in-browser" + green dot; **no timing string**.
5. Recoverable % matches the old header saveable; hidden when saved==0.
6. "Download the fix" scrolls to + focuses the FixCard; with `VITE_PRO_GATE=true` (locked) lands on ActivatePanel; no card form.
7. Budget strip: VRAM=declared; after probe settles, measured subline appears + Draw calls flips "—/not measured" → N; numbers cross-check `report.totals`/`totals.probe`.
8. Disk fill width == savedPct; Findings number == crit+warn+info == VerdictBar chip sum; segments only for nonzero severities.
9. No duplicate metrics; SR rotor reads h1→h2→h2→h2 monotonic; axe 0 contrast violations in both themes.
10. `pnpm --filter @asset-doctor/web test`, `typecheck`, `lint`, `pnpm --filter @asset-doctor/i18n test` green.

---

# PHASE 3 — viewer/findings + settings card re-skin

**Goal:** adopt the mockup element style over the **existing** TriageLedger + Findings + SettingsPage (keep all functionality); real accessible `switch`/`segmented` controls; standardize on `rounded-2xl`; fix the localized contrast debt on the re-skinned surfaces with **existing** tokens. **FilmViewer: no change** (already the dark lightbox). **No new i18n keys.**

### Files
- `apps/web/src/components/TriageLedger.tsx`
- `apps/web/src/lib/ledger-badge.ts` (new) + `apps/web/test/ledger-badge.test.ts` (new)
- `apps/web/src/components/SettingsPage.tsx`
- `apps/web/src/components/Findings.tsx`, `PrimaryRecommendation.tsx`, `LicensePanel.tsx`
- `apps/web/src/App.tsx` (budget strip + FixCard root radius bump)
- `apps/web/src/lib/contrast.ts` + `apps/web/test/contrast.test.ts`

### New pure module `lib/ledger-badge.ts` (extract `metricBadge` + add `role`)
```ts
import type { LedgerRow, SortKey } from './triage';
import { fmtBytes } from './format';
export type BadgeRole = 'saving' | 'measure';
export interface MetricBadge { label: string; value: string; role: BadgeRole; }
/** Only wasted-disk is a recoverable SAVING (green); VRAM/OCC are neutral MEASUREMENTS (ink). */
export function metricBadge(row: LedgerRow, sort: SortKey): MetricBadge | null {
  if (sort === 'vram') return { label: 'VRAM', value: row.metric.vram === undefined ? '—' : fmtBytes(row.metric.vram), role: 'measure' };
  if (sort === 'occupancy') return { label: 'OCC', value: row.metric.occupancy === undefined ? '—' : `${Math.round(row.metric.occupancy * 100)}%`, role: 'measure' };
  if (row.metric.wastedDisk !== undefined) return { label: 'DISK', value: fmtBytes(row.metric.wastedDisk), role: 'saving' };
  return null;
}
```
TriageLedger imports it, deletes its local copy (76-83). **Test `test/ledger-badge.test.ts`:** `vram`+16MB→`{VRAM,measure}`, `vram`+undefined→`'—',measure`; `occupancy`→`OCC`,%,measure, undefined→`'—'`; `severity`+wastedDisk→`{DISK,saving}`; `severity`+none→`null`. Labels are literals → no i18n impact.

### TriageLedger row reflow (keep `ROW_H=52`, no virtualization/keyboard touch)
Reorder `LedgerRowView`'s inner block (130-133): line 1 = severity word (`severityLabelClass` — AA-safe ink, hue on the dot) + mid-truncated file; line 2 = bold title. Badge cluster (143-148): `badge.role === 'saving' ? 'text-cta-text' : 'text-ink'` (DISK saving reads green, VRAM/OCC neutral — honest). `severity.${sev}`/`severity.ok` are existing catalogued keys (already scanned + dynamic-expanded). No new key. Use `ad-label-sm` for the badge label (retire the raw `text-[8.5px]` stack — satisfies `label-tokens.guard`).

### Radius / token polish (one-class edits, all → `rounded-2xl`)
`TriageLedger.tsx:515` + `:487`; `Findings.tsx` detail item + empty state; `PrimaryRecommendation.tsx`; `App.tsx` FixCard roots 1407+1415 (`rounded-xl border-2 border-teal/70` → `rounded-2xl border-2 border-teal/70`, keep the decorative teal border ≥3:1); **and the Phase-2 budget-strip cards → `rounded-2xl`** (whole board aligns in one phase). `VerdictBar` stays a bottom-bordered bar (not re-carded). `TriageLedger.tsx:555` `text-ink-soft/80` → `text-ink-soft` (full-strength AA).

### SettingsPage re-skin (real accessible controls over the EXISTING knobs)
Local presentational components (no `t()` of their own → labels passed as props from the already-scanned SettingsPage → **no new i18n**):
- **`Switch`** — native `<button role="switch" aria-checked aria-labelledby>` (Space/Enter for free, SR announces on/off); knob position encodes state (color-independent, WCAG 1.4.1); `on ? 'bg-cta' : 'bg-film-mute'`; `motion-reduce:transition-none` on track + knob. Replaces `CheckRow` for boolean on/off knobs.
- **`Segmented`** — `role="radiogroup"` of native radios sharing `name` (arrow-key nav + Space for free); active pill = **`peer-checked:bg-teal-text peer-checked:text-panel`** (AA-proven, **not** mockup teal+white); track `bg-bg`; `peer-focus-visible:outline` puts the ring on the visible segment. Replaces enum `<select>`.
- **`SettingRow`** — promotes each knob's mouse-only `title={hint}` to **visible** hint text (an a11y win, reuses existing hint keys).
- Control mapping (per Track C §2c): Theme/Formats defaultTarget/Mipmaps extrude/Packing spinePageFormat+packMode/Output includeFileSizes → **Segmented**; profileEnable/tierEnable/polygon/packLoose/packTrim/aggressive/scaleAwareQ/webpNearLossless/opaqueAlpha/bestFormatPerImage/frameRedundancy/trimMargin/emitPixiManifest/hashFilenames/ktx2Enable/pngquantEnable/resampleEnable → **Switch**. **Keep as checkboxes:** DiagnosisCard per-rule fieldsets + tri-state group headers (a switch cannot be `indeterminate`; multi-select filter), per-format sub-checkboxes, per-tier suffix multi-select, AVIF-subsample `<select>`, effort slider, pngRecompressLevel `<select>`, per-folder overrides. `Card` chrome → `rounded-2xl border border-line bg-panel p-6`, keep `ad-label text-teal-text` eyebrow.

### Localized contrast fixes (existing AA tokens, on re-skinned surfaces only)
- `SettingsPage.tsx:432,494` — warn ⚠ paragraphs: keep the `⚠` glyph as the signal, word → `text-ink` (no new token).
- `SettingsPage.tsx:358,361,387,618` — `text-crit`/`hover:text-crit` → `text-crit-text`/`hover:text-crit-text` (existing AA token, index.css:25/63).
- `LicensePanel.tsx:53` — `text-crit` → `text-crit-text`; `:74` — `text-ok` word → `text-ink` (the `bg-ok` dot at :75 carries the hue); `:89` — `hover:text-crit` → `hover:text-crit-text`.
- `TriageLedger.tsx:555` — done above.

The pervasive `FixCard`/Receipt `text-warn`/`text-crit`/`text-ok`-as-text sweep + a new `--color-warn-text` token are **DEFERRED** (see below).

### contrast.ts / contrast.test.ts additions (prove the two new interactive surfaces, both themes)
```ts
export const SWITCH_OFF = '#8593A0';  // = --color-film-mute (theme-independent)
export const KNOB = '#FFFFFF';
export function switchKnobPasses(track: string): boolean { return contrastRatio(KNOB, track) >= AA_LARGE; }
```
Tests: `switchKnobPasses(CTA)`→true (~4.585), `switchKnobPasses(SWITCH_OFF)`→true (~3.16); `contrastRatio(KNOB,SWITCH_OFF)` `toBeCloseTo(3.16,1)` and `>= AA_LARGE` (if <3.0, darken the off-track token e.g. `#808d99`); segmented active reuses the shipped `chipLabelPassesAABothThemes()` proof; segmented inactive reuses `inkSoftPassesAA(1,'bg')`; regression guard `contrastRatio(WHITE, TEAL_DECOR) < AA_NORMAL` (documents why active is `text-panel on teal-text`, never white on decorative teal). Both `bg-cta` and `film-mute` are theme-independent → the proofs cover both themes.

### FilmViewer
**No change.** Already `bg-film` + `ad-clip` + `ad-viewer-shadow`, dark in both themes (film tokens are outside the dark override block); honest painted overlays + legend + readout. Do **not** add the fabricated "42% empty" label.

### Manual visual gate
1. Board cards uniform `rounded-2xl`; FilmViewer stays dark in both themes; no 14/16px seam.
2. Ledger row: severity word (readable ink) + file line 1, bold title line 2, DISK saving green / VRAM/OCC ink; row height unchanged; 1000+ rows still virtualize; **arrow-keys still move selection + film follows**.
3. Switches: click + Space + Enter toggle; SR announces on/off; knob visible both states both themes; reduced-motion → knob jumps.
4. Segmented: arrow-keys move; active pill teal-text/panel readable both themes; focus ring on the visible segment.
5. Hints visible under each label (no longer tooltip-only).
6. Contrast spot-check the fixed items readable both themes; skip-link first tab stop; one h1 per screen; live region still first child of `<main>`; no new heading in the ledger (outline unchanged).

---

# PHASE 4 — honest Pro / License screen

**Goal:** the third nav destination is a **Pro screen** = the real `LicensePanel` surface + gate-honest beta-free messaging + landing pricing copy reused as **information** (no $ figures, no card form, no "Pay"). Ships the full Pro surface: route `'pro'`, focus anchor, `ProPage.tsx`, sidebar Pro nav item + current-plan card, one pure module.

### Files
- `apps/web/src/lib/route.ts` + `route.test.ts`
- `apps/web/src/lib/focus-move.ts` + `focus-move.test.ts`
- `apps/web/src/lib/pro-view.ts` (new) + `pro-view.test.ts` (new)
- `apps/web/src/components/ProPage.tsx` (new)
- `apps/web/src/App.tsx` (route wiring + Sidebar Pro nav + plan card + view-gate widen + count-guard widen)
- `apps/web/test/i18n-app-keys.test.ts` (register `ProPage.tsx`)
- `packages/i18n/src/catalogs/*.json` (14 new keys × 10)

### route.ts (+ test)
```ts
export type View = 'main' | 'settings' | 'pro';
export const SETTINGS_HASH = '#settings';
export const PRO_HASH = '#pro';
export function viewOfHash(hash: string): View {
  if (hash === SETTINGS_HASH) return 'settings';
  if (hash === PRO_HASH) return 'pro';
  return 'main';
}
```
Test: `#pro`→`pro`; `PRO_HASH==='#pro'`; `viewOfHash(PRO_HASH)==='pro'`; fallbacks `#Pro`/`#pro/x`/`#prox`/`#pro `→`main`; totality `views` array → `['main','settings','pro']`.

### focus-move.ts (+ test)
Add `pro: 'ad-pro-h1'` to `FOCUS_ANCHORS`. Body:
```ts
export function focusTargetAfterSwap(prev: SwapState, next: SwapState): FocusAnchor | null {
  if (prev.view !== next.view) {
    if (next.view === 'settings') return FOCUS_ANCHORS.settings;
    if (next.view === 'pro') return FOCUS_ANCHORS.pro;
    return next.phase === 'done' ? FOCUS_ANCHORS.results : FOCUS_ANCHORS.dropzone;
  }
  if (next.view !== 'main') return null; // settings OR pro: main tree is display:none
  if (prev.phase === next.phase) return null;
  if (next.phase === 'done') return FOCUS_ANCHORS.results;
  if (prev.phase === 'done' && next.phase === 'idle') return FOCUS_ANCHORS.dropzone;
  return null;
}
```
Strict generalization (`next.view === 'settings'` → `next.view !== 'main'`). Test: `VIEWS`→`['main','settings','pro']` (144-pair sweep), `FOCUS_ANCHORS.pro==='ad-pro-h1'`, `main→pro`⇒pro (every phase), `settings↔pro`, `pro→main` done⇒results / else⇒dropzone, phase-flip-while-pro⇒null.

### New pure module `lib/pro-view.ts` (merges Track A `pro-status` + Track D `pro-view`)
```ts
// PURE gate-honest Pro view model. Gate OFF (free beta) ⇒ activation does not exist, the fix is free.
export type ProPanel = 'beta' | 'activate' | 'active';
export function proPanel(gateEnabled: boolean, unlocked: boolean): ProPanel {
  if (!gateEnabled) return 'beta';
  return unlocked ? 'active' : 'activate';
}
/** Gate-disciplined — must NOT claim the fix is free while gated. */
export function proSubtitleKey(gateEnabled: boolean): string {
  return gateEnabled ? 'pro.screen.subGated' : 'pro.screen.subBeta';
}
/** Sidebar plan-card value: honest per state. */
export function planValueKey(p: ProPanel): string {
  return p === 'active' ? 'pro.plan.value.pro' : p === 'activate' ? 'pro.plan.value.free' : 'pro.plan.value.beta';
}
/** Sidebar plan-card action (always routes to PRO_HASH). */
export function planActionKey(p: ProPanel): string {
  return p === 'active' ? 'pro.plan.action.manage' : p === 'activate' ? 'pro.plan.action.upgrade' : 'pro.plan.action.about';
}
```
**Test `lib/pro-view.test.ts`** (mirror `landing-nav.test.ts`): `proPanel` truth table (`(false,*)→beta`, `(true,false)→activate`, `(true,true)→active`) + totality; `proSubtitleKey(false)!=('true')`; `planValueKey`/`planActionKey` exhaustive over the 3 panels; import `CATALOGS` and assert **every** returned key ∈ `CATALOGS.en` (pins the helper-returned keys the app-keys scanner cannot see).

### New component `components/ProPage.tsx` (honest — no fake card form)
Mirrors FixCard's unlocked-probe pattern; token-only classes; monotonic h1→h2→h3. Reuses `ActivatePanel`/`ProBadge` + landing pricing copy as information.
```tsx
export function ProPage() {
  const { t } = useI18n();
  const [unlocked, setUnlocked] = useState(!PRO_GATE_ENABLED);
  useEffect(() => {
    if (!PRO_GATE_ENABLED) return;
    let alive = true;
    void (async () => { await maybeRefresh(); const ok = await isProUnlocked(); if (alive) setUnlocked(ok); })();
    return () => { alive = false; };
  }, []);
  const panel = proPanel(PRO_GATE_ENABLED, unlocked);
  return (
    <section aria-labelledby="ad-pro-h1" className="mx-auto max-w-4xl">
      <h1 id="ad-pro-h1" tabIndex={-1} className="ad-focus-anchor font-display text-3xl font-semibold tracking-tight">{t('pro.screen.title')}</h1>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">{t(proSubtitleKey(PRO_GATE_ENABLED))}</p>

      <h2 className="ad-label mt-8 text-teal-text">{t('pro.screen.plans')}</h2>
      <div className="mt-3 grid gap-5 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-panel p-6">
          <h3 className="font-display text-[15px] font-semibold">{t('landing.pricing.diag.title')}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{t('landing.pricing.diag.body')}</p>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-6">
          <h3 className="font-display text-[15px] font-semibold">{t('landing.pricing.fix.title')}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{t('landing.pricing.fix.body')}</p>
          <span className="mt-3 inline-block rounded-full border border-teal px-2.5 py-0.5 font-mono text-[11px] text-ink">{t(pricingLineKey(PRO_GATE_ENABLED))}</span>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-line bg-panel p-6 text-center">
        {panel === 'beta' ? (
          <p className="mx-auto max-w-md font-mono text-xs leading-relaxed text-ink-soft">{t('pro.screen.betaNote')}</p>
        ) : panel === 'active' ? (
          <><p className="font-mono text-xs text-ink-soft">{t('pro.screen.activeTitle')}</p><ProBadge onDeactivated={() => setUnlocked(false)} /></>
        ) : (
          <><p className="font-mono text-xs text-ink-soft">{t('pro.note')}</p><ActivatePanel onUnlocked={() => setUnlocked(true)} /></>
        )}
      </div>
    </section>
  );
}
```
Honesty gates satisfied: no waitlist/email, no card/expiry/CVC, no "Pay", no fabricated prices, no monthly/annual toggle. The only conversion is the real ed25519-offline `ActivatePanel` (gate-on) or informational copy (beta). A real Stripe link appears only if `VITE_CHECKOUT_URL` is set (already handled inside `ActivatePanel`).

### App.tsx wiring
- Imports: add `PRO_HASH` to the route import; `import { ProPage } from './components/ProPage';` (near LicensePanel import); `import { proPanel, planValueKey, planActionKey } from './lib/pro-view';`.
- **Lift app-level entitlement** for the sidebar plan card (mirrors FixCard 1122/1186):
```tsx
const [proUnlocked, setProUnlocked] = useState(!PRO_GATE_ENABLED);
useEffect(() => {
  if (!PRO_GATE_ENABLED) return;
  let alive = true;
  void (async () => { await maybeRefresh(); const ok = await isProUnlocked(); if (alive) setProUnlocked(ok); })();
  return () => { alive = false; };
}, []);
const plan = proPanel(PRO_GATE_ENABLED, proUnlocked);
```
(Deps of focus-move stay `[view, phase.t]` — this async re-set never feeds focus-move.)
- **Widen the main-tree gate:** `hidden={view === 'settings'}` → `hidden={view !== 'main'}` (report/film/fix state survives navigation to both settings and pro; keeps exactly one h1).
- **Widen the count-guard (415):** `view === 'settings'` → `view !== 'main'` (no "Showing N of M" spoken while Pro shows).
- **Render:** add `{view === 'pro' ? <ProPage /> : null}` beside the settings render. `LandingFooter` (`view === 'main'` only) needs no change.
- **Sidebar** gains a third `NavItem` (`href={PRO_HASH}`, `active={view==='pro'}`, icon `pro`, `label={t('nav.pro')}`) and, on `lg` only, the current-plan card (no heading):
```tsx
<div className="hidden lg:block lg:border-t lg:border-line lg:p-3.5">
  <div className="rounded-xl border border-line bg-bg p-3">
    <div className="ad-label-sm text-ink-soft">{t('pro.plan.label')}</div>
    <div className="mt-1 flex items-center justify-between gap-2">
      <span className="font-display text-[15px] font-semibold text-ink">{t(planValueKey(plan))}</span>
      <a href={PRO_HASH} className="font-mono text-[11px] text-teal-text underline-offset-2 hover:underline">{t(planActionKey(plan))} →</a>
    </div>
  </div>
</div>
```
Sidebar signature becomes `Sidebar({ view, plan })`; add a `NavIcon d="pro"` arm.

### i18n-app-keys scanner
Append `comp('ProPage.tsx')` to `appSrc`. ProPage's only helper-returned keys are `proSubtitleKey(...)`/`pricingLineKey(...)` (not template literals) — pinned by `pro-view.test.ts` + `landing-nav.test.ts` + catalog parity; the plan-card keys are `t(planValueKey(...))`/`t(planActionKey(...))` literals-via-helper, likewise pinned by `pro-view.test.ts`. No new dynamic-prefix branch needed.

### New i18n keys (14, all 10 catalogs)
| Key | English source |
| --- | --- |
| `nav.pro` | `Pro` |
| `pro.screen.title` | `Pro` |
| `pro.screen.subBeta` | `Diagnosis is always free. While Asset Doctor is in beta, the fix is free too — no license needed, nothing uploaded.` |
| `pro.screen.subGated` | `Diagnosis is always free. Activate a license key on this device to download the fix.` |
| `pro.screen.plans` | `What you get` |
| `pro.screen.betaNote` | `No license needed during the beta. Open the Scan screen, drop a folder, and download the optimized copy — the fix runs entirely in your browser.` |
| `pro.screen.activeTitle` | `Pro is active on this device.` |
| `pro.plan.label` | `Current plan` |
| `pro.plan.value.beta` | `Free · beta` |
| `pro.plan.value.free` | `Free` |
| `pro.plan.value.pro` | `Pro` |
| `pro.plan.action.about` | `About Pro` |
| `pro.plan.action.upgrade` | `Upgrade` |
| `pro.plan.action.manage` | `Manage` |
Reused: `nav.label`, `nav.scan`, `settings.nav`, `pro.note`, `landing.pricing.diag.title/body`, `landing.pricing.fix.title/body`, `landing.pricing.beta/gated`, all `license.*`. No plurals/placeholders → parity is pure key-presence. "Asset Doctor"/"Pro" stay verbatim; action strings keep the trailing `→` glyph pattern. Translations (ru/uk/de/es/pt/fr/it/zh/hi) per Track A §7 / Track D §7 wording, adapted to these key names.

### Manual visual gate (light + dark)
1. `#pro` (or the sidebar Pro nav) shows the Pro screen; the main tree + settings are gone from the a11y tree; exactly one h1 (`ad-pro-h1`); outline h1→h2→h3.
2. Focus lands on `ad-pro-h1` on entry; no spurious "Showing N of M".
3. Plan card (desktop lg): gate OFF ⇒ "Free · beta" + "About Pro →"; gate ON unactivated ⇒ "Free" + "Upgrade →"; activated ⇒ "Pro" + "Manage →". Pro page mirrors (beta note / ActivatePanel / ProBadge); **no card-number field anywhere**.
4. Gate ON + `VITE_CHECKOUT_URL` set → the real "Get a license →" link appears in ActivatePanel; without it, no link.
5. All 10 locales render no raw dotted keys; deep-links `#Pro`/`#pro/x`/`#pro ` fall back to main; below `md` the two info cards stack; no horizontal scroll; cards AA-legible both themes.

---

# DEFERRED — user budgets + budget bars (a later phase, after Phase 4)

VRAM-budget (MB) + Draw-call-budget inputs on the Settings page, persisted via the `view-prefs.ts` pattern (guarded localStorage, pure, Node-tested). Only then add the mockup's colored `value / budget` progress bars on the VRAM + Draw cards. `packages/budget` already has the gate core to reuse for evaluation. **Never render a budget bar without a real user budget.** Kept out of Phases 2-4 because it is net-new product surface, not a re-skin.

---

# DROPPED or DEFERRED (with reasons)

| Item | Disposition | Reason |
| --- | --- | --- |
| Card-number / expiry / CVC form, "Pay $N", Pro $19 / Studio $49 tiers, monthly/annual toggle, "Encrypted · cancel anytime" | **DROPPED** | No client-side charging exists; prices are invented. Invariant 2/3/4. Replaced by real `LicensePanel` + info. |
| "Diagnosis complete · **0.9s**" timing | **DROPPED** | `run()` records no wall-clock. Never invent (invariant 3). Optional honest re-add via `performance.now()` is a separate later enhancement. |
| Budget-comparison bars ("/160", "/90") | **DEFERRED** (own phase) | No user budget exists. Never show a budget bar without a real budget. |
| Fabricated viewer overlay label "42% empty · 16 MB VRAM" | **DROPPED** | Illustrative fake number baked onto the stage. FilmViewer already shows honest overlays + legend + readout. |
| Raw `#0E8C8C` + white active fills (mockup nav + segmented) | **DROPPED** | ≈4.04 / ≈3.9:1 fail AA. Use `bg-teal-text text-panel` (proven). |
| `<aside>` sidebar + `div onClick` nav / controls | **DROPPED** | A primary nav is not complementary; div-soup isn't keyboard-operable. Use `<header>`>`<nav aria-label>` + `<a aria-current>`, `role="switch"`, `role="radiogroup"`. |
| Mockup "Findings, ranked by impact" ledger card header | **DROPPED** | Adds a heading that breaks the monotonic outline; the toolbar + "showing N of M" caption already frame the list. |
| Radius 14px (mockup) | **CHANGED** to `rounded-2xl` (16px) | Matches the shipped FilmViewer; avoids a 14-vs-16 seam. |
| Pervasive FixCard/Receipt `text-warn`/`text-crit`/`text-ok`-as-text sweep + new `--color-warn-text` token | **DEFERRED** | Pre-existing contrast debt, not caused by the re-skin; introducing a color token needs its own both-theme proof + review. Phase 3 fixes only the re-skinned surfaces with existing tokens. |
| FS-Access `showDirectoryPicker` real folder name | **DEFERRED** | Would require threading `dir.name` / prefixing `path`, which shifts `assetRef`/`keyOf` namespaces (probe/dedup). The `null → "Asset audit"` fallback is the honest interim. |
| `totals-rows.ts` deletion | **OPTIONAL** in Phase 2 | Becomes unused once the budget strip lands; delete only after `grep` confirms no other consumer, else leave (still tested, harmless). |
| Sidebar current-plan card on mobile | **DROPPED** (`hidden lg:block`) | Mobile reaches plan state via the Pro nav item; avoids crowding the wrapped top bar. |
| Landing/idle screen keeping the old top-header layout | **N/A** | The sidebar replaces the always-present app header (which today shows on idle too); the landing's own section-nav is a separate `<nav>` and is unaffected. One banner (`<header>`) preserved. |

**Global guarantees held across all phases:** no new runtime deps, no network, no external fonts/images; skip-link stays the first tab stop → `#ad-main`; exactly one `<h1>` per view; persistent `role=status` live region stays the first child of `<main>`; `focus-move` extended + Node-tested; reduced-motion inert (only color/bg transitions added, plus `motion-reduce:` on the switch/segment); WCAG AA in both themes (only pre-proven tokens; the one new interactive surface — the switch off-track — gets a fresh both-theme proof in Phase 3); every new key in all 10 catalogs; every load-bearing decision in a pure, Node-tested `lib/*` module.