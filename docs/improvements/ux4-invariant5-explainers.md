# UX-4 design — Invariant-5 honesty explainers off `title=`-only divs

**VERDICT: PROCEED**

Cheapest pick in the pool confirmed at HEAD: all three load-bearing honesty strings are written,
translated into all 9 locales, and delivered EXCLUSIVELY through `title=` on non-interactive `div`s —
nonexistent for keyboard, screen-reader and touch users. Only the delivery changes; no new honesty
copy is authored (one trigger-label string ×9 is the entire new-content cost).

---

## 1. Premise — re-verified at HEAD (tree == HEAD for every premise file)

Working tree is mid-edit ONLY in `build-config.*`, `optimize-entry.*`, `fix-protocol.ts`,
`fix.worker.ts`, `packages/fix` (+ new untracked `build-settings.*`, `route.*`, `sheetTarget.*`).
`FilmViewer.tsx`, `App.tsx`, `totals-rows.ts`, `contrast.ts`, `index.css`, all 9 catalogs are clean —
verified against `git status`; design baseline is therefore the tree itself.

| Claim | Evidence |
|---|---|
| `readout.measuredTooltip` ships only as `title=` | `apps/web/src/components/FilmViewer.tsx:188` (`title={t('readout.measuredTooltip')}` on `ReadCell`) |
| `readout.mipCeilingTooltip` same | `FilmViewer.tsx:219` |
| `readout.deltaTooltip` same | `FilmViewer.tsx:259` |
| `ReadCell` puts `title` on a plain div | `FilmViewer.tsx:285` — `<div className="bg-film px-3 py-2.5" title={title}>`; not focusable, no role |
| Header measured aggregate — same pattern | `apps/web/src/App.tsx:339` (`title={t('readout.measuredTooltip')}`) → `HeaderMetric` plain div `App.tsx:485` (`<div className="bg-panel px-3 py-1.5" title={title}>`) |
| Mobile totals strip — same pattern | `App.tsx:388` → `MobileTotal` plain div `App.tsx:498` (`<div className="flex flex-col" title={title}>`), fed by `apps/web/src/lib/totals-rows.ts:61` (`title: t('readout.measuredTooltip')`) |
| All 3 strings present ×9 | `grep -c "measuredTooltip\|mipCeilingTooltip\|deltaTooltip"` = **3** in every one of `packages/i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json` |
| Rider premise (killed visual candidate 16) | `FilmViewer.tsx:123` `text-ink-soft` (sizeStr) and `:286` `text-ink-soft` (ReadCell label) both sit on the `bg-film` card (root div `:116`). Computed with the exact `contrast.ts` formula: **ink-soft #566472 on film #0C1116 = 3.13:1 (AA fail)**; **film-soft #9FB0BD on film = 8.51:1 (pass)**. Token exists: `--color-film-soft: #9fb0bd` at `apps/web/src/index.css:19` |
| Gating facts used by the design | `FilmViewer.tsx:106` `showMip = m !== undefined && m.vramBytesMipmapped > m.vramBytes`; measured strip + delta row gated on `probe` (`:182`, `:253`); diff-view films pass partial `{ occupancy, vramBytes } as AssetMetrics` (`App.tsx:2554-2555`) ⇒ `vramBytesMipmapped` is `undefined` ⇒ `showMip` false ⇒ no breakdown there today |
| Focus ring on film already solved | `index.css:52-55` — `.bg-film :focus-visible { outline-color: var(--color-film-soft) }` |
| `ad-sr-only` utility exists | `index.css:208` |
| Pure-lib + key-existence-test precedent | `film-legend.ts` (injected `t`, fixed-order table) and `film-legend.test.ts:127` (`CATALOGS.en[k]` existence guard); `CATALOGS`/`LOCALES` exported from `packages/i18n/src/index.ts` |

Premise verdict: **CONFIRMED verbatim**, including the exact line numbers from the pick.

---

## 2. v1 scope

1. **One disclosure per film card** (WAI-ARIA disclosure pattern): a single quiet trigger button at
   the bottom of the FilmViewer card — "What do these readings mean?" — toggling a static definitions
   panel (`<dl>`) that re-delivers the exact existing strings (`readout.measuredTooltip`,
   `readout.mipCeilingTooltip`, `readout.deltaTooltip`), each under its existing on-card term label
   (`readout.measured`, `readout.mipCeiling`, `readout.declaredVsMeasured`). One trigger, not
   per-cell buttons — the film card stays calm.
2. **Pure extraction**: term→explainer mapping and its gating into
   `apps/web/src/lib/readout-explainers.ts` (Node-tested), same discipline as `film-legend.ts` /
   `totals-rows.ts`. FilmViewer JSX becomes a thin renderer over it.
3. **Aggregate chips (header + mobile strip)**: `HeaderMetric` / `MobileTotal` gain an sr-only text
   copy of the explainer inside the chip (prop renamed `title` → `explainer`, rendered as BOTH
   `title=` and an `ad-sr-only` span). Rationale vs the pick's `aria-describedby` sketch in §5.3.
4. **Exactly one new string ×9**: `readout.explainTrigger` (drafts for all 9 in §6).
5. **Severable rider** (last commit, droppable): `FilmViewer.tsx:123` and `:286`
   `text-ink-soft` → `text-film-soft` (3.13:1 → 8.51:1) + FILM-surface proof added to
   `lib/contrast.ts` and its test — continues the shipped AA discipline.

### Out of scope (explicitly)

- **No OCC/FRAG explainer content** (killed candidate 11) — but the pattern MUST accept it later
  without rework; §4.2 shows the exact extension point (add a row to the fixed table + a flag).
- No tooltip-on-hover component/library, no floating popovers, no portal.
- No change to the honesty strings themselves (they are vetted invariant-5 wording; ×9 translated).
- No change to `totals-rows.ts` logic or its test (its `title` field keeps feeding the chip).
- No header layout change (md-width is tight and the in-flight settings nav link makes it tighter —
  this design adds ZERO visible header width; sr-only is position:absolute/clip).
- No Esc-to-close, no focus trap — this is a disclosure, not a dialog (APG pattern).
- No animation of the panel (static show/hide; nothing to gate on `prefers-reduced-motion`).
- Existing `title=` attributes are **kept** (mouse users keep in-place hover next to the number —
  faster than opening the panel; same i18n keys so zero drift; removal would be a mouse-UX
  regression with no a11y gain).

---

## 3. Files touched

| File | Change |
|---|---|
| `apps/web/src/lib/readout-explainers.ts` | NEW — pure mapping + gating (§4) |
| `apps/web/src/lib/readout-explainers.test.ts` | NEW — Node tests (§10) |
| `packages/i18n/src/catalogs/*.json` (×9) | +1 key `readout.explainTrigger`, placed adjacent to the `readout.*` block (en.json lines ~10-27) to minimize merge conflicts with the in-flight catalog edits |
| `apps/web/src/components/FilmViewer.tsx` | disclosure trigger + panel (§5.1); rider recolors `:123`/`:286` |
| `apps/web/src/App.tsx` | `HeaderMetric` (:483) + `MobileTotal` (:496): `title` prop → `explainer`, rendered as `title=` + sr-only span; call sites `:336-341` and `:388` renamed accordingly |
| `apps/web/src/lib/contrast.ts` | rider: FILM surface + FILM_SOFT mirror + proof fn |
| `apps/web/src/lib/contrast.test.ts` (existing test for contrast.ts) | rider: two assertions |

No new dependencies. No `core`/`analysis`/worker changes. Virtualization (TriageLedger) untouched.

---

## 4. Pure logic — `apps/web/src/lib/readout-explainers.ts`

```ts
// PURE, Node-testable registry for the film-card readings disclosure. apps/web has NO React test
// harness, so which explainer rows exist, in what order, under which gates — the load-bearing
// invariant-5 delivery logic — lives here (precedent: film-legend.ts, totals-rows.ts). The
// FilmViewer JSX is a thin renderer over this.
//
// HONESTY: bodyKey values are the three EXISTING vetted invariant-5 strings (never re-worded here);
// termKey values are the EXISTING on-card cell labels, so the panel's terms can never drift from
// what the cells print. Nothing in this module states a saving.

export interface ExplainerRow {
  /** Stable row id (React key + future extension point). */
  key: 'measured' | 'mipCeiling' | 'delta';
  /** i18n key of the on-card term — IDENTICAL key the ReadCell label uses. */
  termKey: string;
  /** i18n key of the explainer body — the existing tooltip string. */
  bodyKey: string;
}

/** Gates mirror the card's own render gates 1:1 (FilmViewer: `probe` strips, `showMip` row). */
export interface ExplainerFlags {
  probe: boolean;
  mip: boolean;
}

/** Canonical fixed order = the visual order of the readings on the card (measured strip →
 *  breakdown mip row → breakdown delta row). We filter THIS literal array — never build from a
 *  Set/object iteration — so output order is deterministic. Future OCC/FRAG rows (killed
 *  candidate 11) are added HERE with their own gate flag; the panel, trigger and tests pick them
 *  up with zero structural rework. */
const REGISTRY: { row: ExplainerRow; when: (f: ExplainerFlags) => boolean }[] = [
  { row: { key: 'measured',   termKey: 'readout.measured',           bodyKey: 'readout.measuredTooltip' },   when: (f) => f.probe },
  { row: { key: 'mipCeiling', termKey: 'readout.mipCeiling',         bodyKey: 'readout.mipCeilingTooltip' }, when: (f) => f.mip },
  { row: { key: 'delta',      termKey: 'readout.declaredVsMeasured', bodyKey: 'readout.deltaTooltip' },      when: (f) => f.probe },
];

/** Rows for the current card state. `[]` ⇒ the trigger itself must not render (diff-view films,
 *  metrics-less cards) — the card stays byte-identical to today there. */
export function explainerRows(flags: ExplainerFlags): ExplainerRow[] {
  return REGISTRY.filter((e) => e.when(flags)).map((e) => e.row);
}
```

Notes:
- `explainerRows({probe:false, mip:true})` → `[mipCeiling]`; `{probe:true, mip:false}` →
  `[measured, delta]`; `{probe:true, mip:true}` → all three in visual order; `{false,false}` → `[]`.
- The trigger-visibility rule is simply `rows.length > 0` — no separate exported gate to drift.
- **Extensibility contract (binding for candidate 11)**: an OCC row later is
  `{ row: { key: 'occ', termKey: 'readout.occ…', bodyKey: 'readout.occTooltip' }, when: (f) => f.occ }`
  plus one flag; the `ExplainerRow['key']` union widens; JSX and tests need no structural change.
  This satisfies the constraint "extensible to OCC/FRAG without rework — same strip, future keys".

---

## 5. Render glue (not unit-testable — kept thin)

### 5.1 FilmViewer.tsx — the disclosure

State/ids (component top, near the existing `useId` at `:39`):

```tsx
const [explainOpen, setExplainOpen] = useState(false);
const explainPanelId = useId();
```

Compute rows next to the existing gates (`:100-106`), reusing them verbatim — the panel can never
disagree with the cells:

```tsx
const explainers = explainerRows({ probe: probe !== undefined, mip: showMip });
```

New block as the LAST child of the card root div (after the breakdown block `:205-264` closes), so
the DOM/visual order is: readings first, meta-help last:

```tsx
{explainers.length > 0 ? (
  <div className="mt-2.5 px-1">
    <button
      type="button"
      aria-expanded={explainOpen}
      aria-controls={explainPanelId}
      onClick={() => setExplainOpen((v) => !v)}
      className="flex min-h-6 items-center gap-1.5 font-mono text-[10px] text-film-soft underline-offset-2 hover:underline"
    >
      <span
        aria-hidden="true"
        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-film-soft text-[9px] leading-none"
      >
        i
      </span>
      {t('readout.explainTrigger')}
    </button>
    <dl id={explainPanelId} hidden={!explainOpen} className="mt-1.5 space-y-2 rounded-lg border border-film-border bg-film-2 px-3 py-2.5">
      {explainers.map((row) => (
        <div key={row.key}>
          <dt className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-film-soft">{t(row.termKey)}</dt>
          <dd className="mt-0.5 text-[11px] leading-relaxed text-film-soft">{t(row.bodyKey)}</dd>
        </div>
      ))}
    </dl>
  </div>
) : null}
```

Decisions baked in:
- **`hidden={!explainOpen}` instead of conditional render**: the panel element always exists, so
  `aria-controls` never points at a missing id, and toggling is a pure attribute flip (no
  mount/unmount churn per click).
- **`<dl>` with dt = existing term keys**: the panel prints EXACTLY the labels the cells print
  (`readout.measured`, `readout.mipCeiling`, `readout.declaredVsMeasured`) — a sighted user maps
  panel row → cell by string identity in every locale; no new term strings.
- **Marker is a drawn badge** (bordered span + letter "i"), not a `ⓘ` glyph — IBM Plex Mono glyph
  coverage for U+24D8 is not guaranteed across the 9 locales' fallback stacks; a drawn badge is
  deterministic. `aria-hidden` — the visible label carries the name.
- **`min-h-6`** (24px) on the trigger ⇒ meets WCAG 2.5.8 minimum touch-target height even though the
  text is 10px.
- **Open state persists across asset switches** (component is not keyed/remounted at `App.tsx:418`):
  a user comparing atlases keeps the definitions open while scrubbing the ledger. Rows re-gate per
  asset automatically; if rows become `[]` the whole block (trigger+panel) unmounts — reopening on
  the next explainable asset starts from the persisted `explainOpen`, which is fine (the panel is
  informational, never stale: keys re-resolve per render).
- Trigger sits AFTER the breakdown block: it explains the strips above it, and in SR reading order
  the measured facts come before the meta-explanation (honesty first, help second).

### 5.2 Diff-view films stay byte-identical

`SheetDiffView` passes `{ occupancy, vramBytes } as AssetMetrics` (`App.tsx:2554-2555`):
`vramBytesMipmapped` is `undefined` ⇒ `showMip` false; no `probe` ⇒ `explainerRows` = `[]` ⇒ no
trigger. The before/after comparison panes gain zero chrome. (Same for `metrics === undefined`.)

### 5.3 Header + mobile aggregate chips — sr-only note, not `aria-describedby`

The pick sketched "header may reuse the film-card disclosure content via describedby". Rejected
after inspection, with reasons:
- `aria-describedby` on a **generic non-focusable div** (`HeaderMetric` `App.tsx:485`, `MobileTotal`
  `:498`) has unreliable SR support — descriptions are dependably announced on focusable/named
  elements; on a plain div in browse mode many SR/browser pairs skip them.
- Cross-component id coupling (App header → a node inside FilmViewer) dangles whenever no film is
  selected (`App.tsx:417-421` `selectedBytes` guard) and inverts ownership.

Chosen instead: plain sr-only text INSIDE the chip — plain text content is read by every SR in
browse mode, no id plumbing, zero visual width (`ad-sr-only` is clipped absolute, `index.css:208`),
zero header md-width impact (matters: the in-flight settings change adds a header nav link).

```tsx
function HeaderMetric({ label, value, accent, explainer }: { label: string; value: string; accent?: boolean; explainer?: string }) {
  return (
    <div className="bg-panel px-3 py-1.5" title={explainer}>
      <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft">{label}</div>
      <div className={`font-mono text-xs font-semibold ${accent ? 'text-cta' : 'text-ink'}`}>{value}</div>
      {explainer ? <span className="ad-sr-only">{explainer}</span> : null}
    </div>
  );
}
```

`MobileTotal` gets the identical treatment (prop `title` → `explainer`, `title=` kept + sr-only
span appended after the value). Call sites: `App.tsx:339` (`title={…}` → `explainer={…}`) and
`:388` (`title={r.title}` → `explainer={r.title}` — `totals-rows.ts` and its test unchanged).

Honest residual gap (documented, accepted): a **sighted** keyboard/touch user reading the HEADER
aggregate gets the text from the film-card panel (same `readout.measuredTooltip` string, same key),
not from the chip itself. In the one corner where the header shows a measured aggregate while the
selected asset is an un-probed loose file, the film-card panel omits the measured row (its own strip
is absent — correct per-card honesty); selecting any probed atlas surfaces it. Fixing that corner
would need a header-level trigger, which the tight md-width (plus the in-flight nav link) argues
against — deferred, and the sr-only note still covers SR users everywhere.

The scope's "aria-describedby wiring where an interactive element exists" is satisfied where the
interactive element actually exists: the trigger button ↔ panel via `aria-controls`/`aria-expanded`;
no other interactive element carries these strings today.

---

## 6. New i18n key — all 9 locales (impl copies verbatim)

Key: `readout.explainTrigger` (static, no placeholders ⇒ parity test's token check is trivially
satisfied).

| locale | value |
|---|---|
| en | `What do these readings mean?` |
| ru | `Что значат эти показания?` |
| de | `Was bedeuten diese Messwerte?` |
| es | `¿Qué significan estas lecturas?` |
| pt | `O que significam estas leituras?` |
| fr | `Que signifient ces relevés ?` |
| it | `Cosa significano queste letture?` |
| zh | `这些读数是什么意思？` |
| hi | `इन रीडिंग का क्या मतलब है?` |

Placement: inside the existing `readout.*` block (en.json:10-27 region) in every catalog — keeps the
diff local and minimizes conflicts with the in-flight settings-strings catalog edits.

---

## 7. Token usage + severable rider (candidate-16 micro-commit)

New UI uses ONLY existing tokens: `text-film-soft`, `border-film-border`, `border-film-soft`
(badge), `bg-film-2` (panel inset — matches the x-ray stage surface, `index.css:16`), mono font.
No new `@theme` tokens. No hex in JSX.

**Rider (own commit, droppable without touching the disclosure):**
- `FilmViewer.tsx:123` — `text-ink-soft` → `text-film-soft` (top-bar sizeStr on `bg-film`).
- `FilmViewer.tsx:286` — `text-ink-soft` → `text-film-soft` (ReadCell label on `bg-film`; also makes
  the cell labels and the panel `<dt>` terms literally the same color+key pairing).
- `lib/contrast.ts` — extend the proof (mirrors `index.css:15` and `:19`):
  ```ts
  export const SURFACE = { bg: '#E7ECF1', panel: '#FFFFFF', film: '#0C1116' } as const;
  export const FILM_SOFT = '#9FB0BD';
  /** The film-surface remap decision: secondary text on bg-film must be film-soft, never ink-soft. */
  export function filmSoftPassesAA(): boolean {
    return contrastRatio(FILM_SOFT, SURFACE.film) >= AA_NORMAL;
  }
  ```
  `inkSoftPassesAA` needs no signature change — `keyof typeof SURFACE` now includes `'film'`, so the
  test can pin the DEFECT too: `inkSoftPassesAA(1, 'film') === false` (3.13:1) alongside
  `filmSoftPassesAA() === true` (8.51:1). Both ratios verified numerically with the module's own
  formula during this design.
- Audit note for impl: `:123` and `:286` are the only two `ink-soft`-on-film occurrences inside
  FilmViewer; `App.tsx:2565/:2574` ink-soft strips sit on light panel surfaces (5.1:1+, fine).

---

## 8. A11y section

- **Pattern**: WAI-ARIA APG "disclosure" — native `<button type="button">` with visible text name,
  `aria-expanded`, `aria-controls`; panel is plain content, `hidden` when closed. Enter/Space native;
  focus stays on the trigger after toggle (no focus move, per APG); no Esc handling (not a dialog).
- **Keyboard path**: Tab reaches the trigger in card DOM order (after the strips); the global
  focus-visible ring applies with the film-surface color already defined (`index.css:52-55`,
  `.bg-film :focus-visible` → film-soft outline) — zero new focus CSS.
- **Touch**: trigger is a real button, `min-h-6` (24px) target (WCAG 2.5.8); tap toggles. This is
  the first-ever touch delivery of all three strings.
- **SR**: trigger announces name + expanded state; panel is a `<dl>` (term/definition semantics);
  canvas alt-text, legend list, live region (`App.tsx:357`) untouched. Aggregate chips gain in-chip
  sr-only text (browse-mode readable everywhere, §5.3).
- **Reduced motion**: static attribute toggle, no transition/animation added anywhere ⇒ nothing to
  gate; existing scanline/pulse untouched.
- **Contrast (all on `bg-film`/`bg-film-2`)**: trigger text + panel dt/dd `text-film-soft` =
  8.51:1 on film, 8.69:1 on film-2 — both ≥ 4.5 AA for the 9.5–11px normal-size text; badge border
  film-soft ≥ 3:1 non-text (8.5:1 actual). Rider lifts the two remaining 3.13:1 film-surface texts
  to 8.51:1. No `ink-soft/NN` alpha introduced anywhere (UX-3 rule preserved).
- **Heading outline**: the panel adds no heading ⇒ the UX-3 monotonic h1→h2→h3 outline is untouched.

## 9. Honesty · instant-wow · perf-at-scale

- **Honesty (invariant 5)**: zero new claim text. The panel re-delivers the three vetted strings that
  exist precisely to prevent misreading measured-vs-declared as savings; terms reuse the cell label
  keys so panel and card can never diverge. Nothing computes or phrases a delta as a saving. The
  trigger label asks a question; it asserts nothing.
- **Instant-wow (invariant 4)**: idle/analyzing path untouched — the block exists only inside the
  results-state film card; zero work before first result.
- **Perf at scale**: O(1) per card render (fixed 3-entry registry filter); one card mounted at a
  time (`App.tsx:418`); TriageLedger virtualization untouched; no listeners beyond one onClick; the
  `hidden` panel costs one static subtree. 1000-asset runs are unaffected.

## 10. Determinism

`explainerRows` filters a literal fixed-order array with boolean flags — same flags ⇒ identical
array (order pinned by test). No Date/random/locale-dependent branching; locale affects only string
lookup. `useId` values are render-stable (React 18 contract, same as the legend's `:39`).

## 11. Edge cases

| Case | Behavior |
|---|---|
| 0 assets | No FilmViewer, no header metrics (`report` null) — nothing changes. |
| 1 loose PNG (no manifest) | Metrics exist, no probe: `showMip` true for any nonzero image ⇒ trigger renders with the mip row only. First time this string is reachable at all without a mouse. |
| 1000 assets | One mounted card; O(1) logic; virtualization untouched. |
| Un-probed selected + probed totals | Header shows measured aggregate (sr-only note covers SR); film panel honestly omits the measured row for THIS card (§5.3 residual gap, documented). |
| Diff-view before/after films | `explainerRows` = `[]` ⇒ byte-identical panes (§5.2). |
| `metrics === undefined` | `[]` ⇒ no trigger. |
| 9-locale long strings | Longest bodies (de ≈ 240 chars, ru ≈ 220) wrap in the `<dl>` at the card's 320–420px column ⇒ ~5–7 lines each, `leading-relaxed`; dt/dd are stacked (never a two-column grid) so long de/ru terms can't truncate. Trigger label wraps as a flex row with `items-center`; zh/hi short. A tall open panel makes the `lg:sticky top-20` aside taller than the viewport in the worst case — sticky simply stops pinning and scrolls; acceptable, noted for the manual pass. |
| Rapid ledger scrubbing | Rows recompute per debounced selection (`App.tsx:228`); open state persists; no decode/paint coupling (panel is outside the canvas effect). |

## 12. Test plan

**Pure Node (vitest, `apps/web/src/lib/readout-explainers.test.ts`):**
1. Gating truth table: all four `{probe,mip}` combos → exact row arrays (ids and order pinned:
   `measured, mipCeiling, delta`).
2. Determinism: repeated calls deep-equal; order derived from the literal registry (not object/Set
   iteration).
3. Key existence drift guard (precedent `film-legend.test.ts:127`): every `termKey`/`bodyKey` of
   every registry row exists in `CATALOGS.en`, PLUS `readout.explainTrigger` exists — via
   `import { CATALOGS } from '@asset-doctor/i18n'`.
4. Honesty pin: no `bodyKey` resolves (in en) to a string containing `%` savings phrasing — assert
   the three bodies are exactly the existing `readout.*Tooltip` keys (registry can't be silently
   repointed at new unvetted copy).

**Pure Node (rider, extend the existing contrast test):**
5. `filmSoftPassesAA() === true` (8.51:1) and `inkSoftPassesAA(1, 'film') === false` (3.13:1) — the
   remap's why, pinned.

**i18n package**: existing parity test (`packages/i18n/test/catalogs.test.ts`) automatically covers
the new key across all 9 catalogs (same keys + no placeholder tokens). No new test needed there.

**Honestly NOT unit-testable (no React harness) — manual gate before merge:**
- Keyboard-only: Tab from ledger → trigger, Enter/Space toggles, `aria-expanded` flips (inspect in
  devtools a11y tree), ring visible (film-soft) on the dark card.
- SR smoke (one of NVDA/VoiceOver): trigger reads "…button, collapsed/expanded"; panel dt/dd read in
  order; header measured chip reads the sr-only note in browse mode.
- Touch (devtools emulation minimum): tap target ≥24px, toggle works, no hover dependency left.
- Visual pass ×9 locales at 320px/375px/1280px: trigger wrap, panel wrap, no horizontal overflow,
  diff view unchanged, header md row width unchanged (sr-only adds zero px).
- `prefers-reduced-motion: reduce`: identical behavior (nothing animated — confirm no regression).

## 13. Ordered commit breakdown (small, 1 meaning each)

1. `feat(web): pure readout-explainers registry (lib + tests)` — new lib + test, no UI change.
2. `i18n: readout.explainTrigger across all 9 catalogs` — parity test green; no consumer yet.
3. `feat(web,a11y): film-card readings disclosure (UX-4)` — FilmViewer trigger+panel wired to the
   lib; the three honesty strings become keyboard/touch/SR-reachable.
4. `feat(web,a11y): sr-only measured explainer on header + mobile totals chips (UX-4)` — App.tsx
   `HeaderMetric`/`MobileTotal` prop `title`→`explainer` + sr-only span; call sites updated.
5. `fix(web,a11y): film-surface secondary text to AA (film-soft) + contrast proof` — SEVERABLE
   rider; FilmViewer `:123`/`:286` recolor + contrast.ts/test additions.

Each commit independently green (`pnpm test`, `pnpm typecheck`, `pnpm lint`).

## 14. INTEGRATION NOTES vs the in-flight settings-page workflow

The parallel workflow is rewriting App.tsx (settings page at `#settings`, header nav link, settings
context, FixCard slimmed) plus catalogs and the fix worker. This design was verified against files
that are currently clean in the tree, but implementation lands AFTER that tree does:

1. **App.tsx collisions are line-local, not structural**: this design touches (a) the header
   measured `HeaderMetric` call (`:336-341` today), (b) the mobile strip call (`:388`), (c) the two
   chip components near `:483-503`. If the settings change moves/renames these, re-anchor by symbol
   name (`HeaderMetric`, `MobileTotal`, `buildTotalsRows` call) — the design does not depend on line
   positions or on FixCard at all.
2. **Header width budget**: the settings nav link consumes header md-width. This design deliberately
   adds ZERO visible header width (sr-only only). If the settings change compresses/hides the header
   metrics block at md, the chips' `explainer` prop travels with the chip wherever it renders — no
   redesign needed; re-verify only that a `title`→`explainer` rename didn't race a chip rewrite.
3. **Catalog merge**: the settings workflow adds its own keys to all 9 catalogs. `readout.explainTrigger`
   goes inside the existing `readout.*` block, far from settings keys — a clean textual merge; the
   i18n parity test is the arbiter after merge.
4. **FilmViewer / totals-rows / contrast**: untouched by the in-flight change (not in its stated
   scope and clean in the tree) — commits 1, 3, 5 should rebase with no conflicts.
5. **New `lib/route.ts` (untracked, in-flight)**: no interaction — the disclosure is component-local
   state, never hash/route state; opening the panel must NOT write `location.hash`.
6. **Sequencing**: implement after the settings tree lands (per brief). If the settings change
   converts FixCard hint `title=`s (`App.tsx:746+`) to another pattern, do NOT unify in this pick —
   those are fix-settings hints, not invariant-5 honesty strings; out of scope here.
