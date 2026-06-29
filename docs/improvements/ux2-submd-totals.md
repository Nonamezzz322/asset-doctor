# Sub-md totals strip: declared vs measured VRAM + disk + saveable, visible below 768px (PROCEED)

## Problem (verified, cited)

The four headline totals render ONLY inside the header block `apps/web/src/App.tsx:319`, classed `"hidden items-stretch gap-px overflow-hidden rounded-lg border border-line bg-line md:flex"`. The `hidden ... md:flex` pair means: on any viewport <768px the entire totals block is `display:none`. The metrics inside it are:
- disk — `App.tsx:320` `fmtBytes(totals?.diskBytes ?? 0)`, label `metric.disk`
- declared vram — `App.tsx:321` `fmtBytes(totals?.loadedVramBytes ?? 0)`, label `metric.vram`
- measured vram — `App.tsx:325-331`, gated on `totals?.probe`, value `fmtBytes(totals.probe.vramBytes)`, label `metric.vramMeasured`, title `readout.measuredTooltip`
- saveable — `App.tsx:332` `` `${fmtBytes(totals?.potentialDiskSaved ?? 0)} · ${savedPct}%` ``, label `metric.saveable`, `accent` (text-cta)

Below md, a finished analysis (`App.tsx:359` `report && phase.t === 'done'`) renders only `VerdictBar` (`App.tsx:361`) + the ledger. `VerdictBar.tsx:13` documents that it deliberately does NOT repeat the saveable number, and it never shows disk/vram at all. So on phones/small tablets: the disk≠VRAM honesty pin (invariant 5) and the saveable payoff (instant-wow) are 100% invisible exactly where screen space is tightest. Premise CONFIRMED TRUE.

Tokens confirmed in `apps/web/src/index.css`: `--color-ink`, `--color-ink-soft`, `--color-cta`, `--color-line` all exist (index.css:7-11). No new token needed.

i18n keys confirmed in `packages/i18n/src/catalogs/en.json`: `metric.disk` (:5), `metric.vram` (:6), `metric.saveable` (:7), `metric.vramMeasured` (:9), `readout.declared`="vram (declared)" (:10), `readout.measuredTooltip` (:18). All present in 9 catalogs (per CLAUDE.md i18n contract; verify in test step).

## Adversarial correction folded in (honesty)

In the desktop header, the DECLARED chip uses the bare label `metric.vram` ("vram") and relies on visual adjacency to the `metric.vramMeasured` ("vram (measured)") chip to disambiguate declared vs measured. On the mobile strip the measured chip is CONDITIONAL (`totals.probe` gate, same as header). When the probe hasn't run, a bare "vram" chip standing alone risks being read as "the vram" — eroding the disk≠VRAM honesty exactly where we're trying to restore it. Fix: on the mobile strip, label the declared chip with the existing self-disambiguating key `readout.declared` ("vram (declared)") instead of `metric.vram`. This keeps DECLARED and MEASURED textually distinct regardless of whether the measured chip is present, with zero new strings. The header desktop block is left untouched (its adjacency works; out of scope).

## v1 scope

Add a compact, wrap-friendly totals strip shown ONLY below md, inside the results column, placed directly under `<VerdictBar>` (between `App.tsx:361` and the `report.assets.length === 0` ternary at :362). It is `flex md:hidden` — the exact inverse of the header block, so the two never co-exist (no duplication on any viewport). It reuses the EXACT existing values (`fmtBytes(totals.diskBytes)`, `fmtBytes(totals.loadedVramBytes)`, `fmtBytes(totals.probe.vramBytes)`, `potentialDiskSaved`+`savedPct` from `App.tsx:177-178`) and existing i18n keys. New component `MobileTotalsStrip` lives in App.tsx next to `HeaderMetric` (App.tsx:436).

Markup (token-driven only):
```
{totals ? (
  <div className="flex flex-wrap gap-x-5 gap-y-1.5 border-b border-line pb-4 md:hidden">
    <MobileTotal label={t('metric.disk')} value={fmtBytes(totals.diskBytes)} />
    <MobileTotal label={t('readout.declared')} value={fmtBytes(totals.loadedVramBytes)} />
    {totals.probe ? (
      <MobileTotal label={t('metric.vramMeasured')} value={fmtBytes(totals.probe.vramBytes)} title={t('readout.measuredTooltip')} />
    ) : null}
    <MobileTotal label={t('metric.saveable')} value={`${fmtBytes(totals.potentialDiskSaved)} · ${savedPct}%`} accent />
  </div>
) : null}
```
`MobileTotal` mirrors `HeaderMetric` but inline-wrap-friendly:
```
function MobileTotal({ label, value, accent, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  return (
    <div className="flex flex-col" title={title}>
      <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft">{label}</span>
      <span className={`font-mono text-xs font-semibold ${accent ? 'text-cta' : 'text-ink'}`}>{value}</span>
    </div>
  );
}
```
No border/bg per-cell (unlike header's `bg-line` divider grid) — it's a wrapping label/value list under the verdict bar, matching VerdictBar's own `flex flex-wrap ... border-b border-line pb-4` chrome (VerdictBar.tsx:35) so the two read as one stacked summary band.

## Out of scope
- Desktop header block (App.tsx:319-333) — untouched.
- VerdictBar — untouched (it keeps deliberately omitting saveable; the strip is a sibling, not a VerdictBar change).
- Any data path, totals computation, probe gating logic, virtualization (`useWindow`), ledger.
- No new i18n strings, no new tokens, no new colors/fonts.
- Drag/analyze/loading states (the strip is gated on `report && phase.t === 'done'` by its placement inside the results block at App.tsx:359; while analyzing only Dropzone shows — no regression).

## Exact files + components + tokens
- `apps/web/src/App.tsx`: insert the `md:hidden` strip after `<VerdictBar .../>` (line 361); add `MobileTotal` + (optional) `MobileTotalsStrip` wrapper near `HeaderMetric` (line 436). The `totals` and `savedPct` consts (App.tsx:177-178) are already in scope in the render.
- Tokens used (all existing @theme): `text-ink`, `text-ink-soft`, `text-cta`, `border-line`. NO additions.

## Pure Node-testable UX logic

The render glue (`md:hidden` swap, JSX) is not Node-testable (no React harness — apps/web Vitest is Node), but the value/label assembly IS extractable and is the part most worth pinning (the probe gate + honesty labelling + savedPct edge cases). Extract a pure builder:

`buildTotalsRows(totals, t, fmtBytes)` → `TotalRow[]` where `TotalRow = { key: string; label: string; value: string; accent?: boolean; title?: string }`.

- Signature: `buildTotalsRows(totals: AnalysisReport['totals'] | undefined, t: (k: string, p?: Record<string,unknown>) => string, fmtBytes: (n: number) => string): TotalRow[]`
- Location: NEW `apps/web/src/lib/totals-rows.ts` (precedent: focus-ring.ts/film-legend.ts/triage.ts pure libs). Both the mobile strip AND, optionally later, the header could consume it — but v1 only wires the mobile strip to avoid touching working desktop chrome.
- Logic (deterministic, ordering fixed): returns `[disk, declared(readout.declared), measured?(only if totals.probe), saveable(accent)]`. `savedPct = totals.diskBytes > 0 ? Math.round(potentialDiskSaved/diskBytes*100) : 0` (identical to App.tsx:178 — share the formula; the pure fn computes it internally so the 0-disk branch is tested). Returns `[]` when `totals` is undefined.
- This makes the honesty contract testable: assert declared uses `readout.declared`, measured is absent without probe, measured value is `probe.vramBytes` (never a delta), saveable carries `accent:true`, and the `· N%` formatting.

The component then maps `buildTotalsRows(...)` over `MobileTotal`. App.tsx just imports the fn.

## ARIA / keyboard / reduced-motion / contrast
- The strip is non-interactive read-only text (mirrors header HeaderMetric — also non-interactive). No new tab stops, no keyboard handling needed; full keyboard operability is preserved (no focusable elements added). This deliberately does NOT add the deferred ledger keyboard-nav (separate, larger item).
- The measured chip's `title` (`readout.measuredTooltip`) matches the header (App.tsx:329). Title tooltips are not keyboard-reachable, but this is parity with existing behavior — not a regression; the honest text is also conveyed by the distinct visible label.
- Color-not-sole-signal: declared vs measured are distinguished by TEXT labels ("vram (declared)" vs "vram (measured)"), not color. Saveable's accent (text-cta) is reinforced by its distinct label + `· N%`. No information is color-only.
- Contrast: text-ink (#16202a) and text-ink-soft (#566472) on bg (#e7ecf1) — same as everywhere else in chrome, AA-compliant; text-cta (#15a06a) on bg is the same accent already shipped in the header.
- Reduced-motion: the strip has NO animation/transition (no `ad-pulse-dot`, no `transition`), so it's inert under `prefers-reduced-motion` by construction.
- Live-region: NOT added — the existing aria-live (App.tsx:347, lib/announce.ts) already announces the diagnosis-ready moment and counts; the strip is supplementary visible text, so announcing it again would be redundant chatter.

## Honesty / instant-wow / perf
- Honesty: declared (`loadedVramBytes`) and measured (`probe.vramBytes`) stay separate quantities with distinct labels; measured is never a savings delta (it's read straight from `totals.probe.vramBytes`); saveable stays labelled with `metric.saveable` and is the disk-only %/bytes — identical to the header. The wrap (`flex-wrap gap-x-5`) keeps each label glued to its own value (flex-col cells), so wrapping never blurs declared/measured/saveable.
- Instant-wow: restores headline metrics on mobile where they were 100% absent — strictly improves first-glance payoff. No analysis-path code touched ⇒ no <10s regression.
- Perf at scale: zero virtualization contact; the strip renders 3-4 static cells regardless of asset count. `useWindow`/`TriageLedger` untouched. The pure builder is O(1).

## Determinism
`buildTotalsRows` order is a fixed literal array; the probe branch is a single boolean gate on `totals.probe` presence; savedPct is integer `Math.round`. Same inputs → identical output. fmtBytes is the existing deterministic formatter.

## Edge cases
- totals undefined (report null) → strip not rendered (`totals ? ... : null`); builder returns `[]`.
- No probe → measured cell omitted (same gate as header); the strip still shows disk + declared + saveable, and declared is self-disambiguated by `readout.declared` (the correction above).
- diskBytes === 0 → savedPct = 0 (guarded, no NaN), saveable shows "0 B · 0%".
- 0 / 1 / 1000+ rows → strip is independent of row count (it reads totals, not rows); virtualization unaffected.
- No selection → irrelevant (strip is selection-independent).
- Long localized labels (e.g. de "vram (gemessen)", ru "vram (измерено)") → `flex-wrap` + per-cell `flex-col` lets cells wrap to new lines; values never collide. zh/hi short labels fit trivially.

## Test plan
PURE unit tests (Vitest Node) for `apps/web/src/lib/totals-rows.ts` (new `totals-rows.test.ts`):
1. Returns `[]` for undefined totals.
2. With totals, no probe → 3 rows in order disk/declared/saveable; declared row label === `readout.declared` (NOT `metric.vram`) — pins the honesty correction.
3. With totals + probe → 4 rows; measured row inserted at index 2; measured value === `fmtBytes(probe.vramBytes)`; measured row has the `readout.measuredTooltip` title; measured is NOT equal to saveable/any delta.
4. saveable row: `accent === true`, label === `metric.saveable`, value contains `· {pct}%`.
5. savedPct: diskBytes=0 → "0%"; diskBytes=1000, saved=250 → "25%"; rounding (saved=333,disk=1000 → 33%).
6. Use a stub `t` that echoes the key, asserting the EXACT keys requested (disk/readout.declared/metric.vramMeasured/metric.saveable) — this is the i18n-contract guard.
i18n catalog test (extend existing drift/catalog test): assert all 9 catalogs contain `readout.declared` (already used? confirm) so no missing-key fallback on mobile.
Unverifiable-by-unit (explicit reasoning): the `md:hidden`/`md:flex` mutual-exclusion and DOM placement are visual/wiring — verified by reasoning (inverse Tailwind breakpoint classes are mutually exclusive by definition) + manual check at 375px and 1280px widths (must show strip below md, header block at/above md, never both). Note in PR description.

## Ordered small-commit task breakdown
1. `feat(web): pure buildTotalsRows builder (declared≠measured, probe-gated, savedPct)` — add `apps/web/src/lib/totals-rows.ts` + `totals-rows.test.ts`. No UI wiring yet. Green tests.
2. `feat(web): mobile totals strip below md (disk/declared/measured/saveable)` — add `MobileTotal` + the `md:hidden` strip under VerdictBar in App.tsx consuming `buildTotalsRows`; token-driven, additive.
3. `test(i18n): assert readout.declared present in all 9 catalogs` (if not already covered by the existing drift test) — guard the honesty label.
4. (manual, in PR body) breakpoint check at 375/767/768/1280px: strip vs header mutual exclusion; long-label wrap in de/ru.