# DESIGN: "Build a spritesheet first" + honest spam-collapse — IMPLEMENTATION SPEC

**VERDICT: PROCEED** (narrowed exactly per the judge ruling). Read-only design; all line numbers verified against HEAD (feat/asset-pipeline).

This spec is written so implementation agents need not re-derive any decision. Every mechanism below was checked against the live code; the two dangerous sub-mechanisms the judge killed (a core-contract cluster field; any `bumpBest`/`potentialDiskSaved` revert) are NOT present here.

---

## 0. One critical plumbing correction (read first)

The judge's ruling assumed the presentation layer could compute format-sibling redundancy from the report. **It cannot.** Verified: the presentation layer (`apps/web/src/lib/triage.ts`, `App.tsx`) receives only `AnalysisReport`, whose `assets: AssetMetrics[]` carry `assetRef/diskBytes/vramBytes/occupancy` — **no `mime`, no separate `w`/`h`** (only `vramBytes = w·h·4`, which cannot distinguish 100×200 from 200×100, so the "EXACT w==w && h==h" test is impossible there). The raw `Asset[]` with mime+size lives only in the worker/analysis.

**Consequence, decided:** format-sibling detection (`formatSiblingGroups`) runs in **analysis** (where `Asset[]` exists), and the *redundancy decision* is surfaced to the presentation via a **`params` marker on the already-emitted format finding** — `finding.params.redundantSibling = 1`. This:
- needs **no core-contract change** (`FindingParams = Record<string, string|number>` already accepts arbitrary keys — verified core/src/index.ts:352),
- needs **no change to `formatFinding`** (the marker is set by a new post-pass in `analyze.ts`, not inside the rule),
- does **not** touch `bumpBest`/`potentialDiskSaved`/`estimate` (the marker is presentation-only metadata; the finding, its severity, its counted saving all stay),
- is **never set on the CLI** (format findings require `deps.encodeImage`, which the CLI never passes — verified analyze.ts:311 comment + formatFinding rules.ts:771 early-return), so CLI/SARIF output is byte-identical.

The presentation then reads `finding.params.redundantSibling` to fold the row. This is the single bridge; everything else is additive helpers + presentation.

---

## 1. HONESTY — how the collapse stays inside invariant 3 (this section FIRST, by mandate)

Invariant 3: *we MEASURE and surface verdicts by thresholds; we never generate, hide, or fabricate.* "Don't spam" = **aggregate / re-prioritize the PRESENTATION**, never delete a measured finding or change an honest count.

### 1.1 What NEVER folds (hard guards, tested allowlist)
A row is eligible to fold **only** when ALL hold:
- `finding.scope !== 'folder'` (every folder finding — should-atlas, atlas-merge, duplicate-*, variants, integrity, cross-atlas-redundancy, mipmap-cost — stays visible), AND
- `finding.severity !== 'crit'` (hard guard — no crit ever folds), AND
- **either** the *loose* condition (§1.3a) **or** the *format-sibling* condition (§1.3b).

The *loose* condition additionally restricts to an **explicit allowlist of rules** `FOLDABLE_RULES = { 'dimensions-npot', 'format' }`. Therefore the following are **NEVER folded**, because packing does not change those pixels/alpha and folding them would bury a real warning under a recommendation that does not fix it:
`dimensions-oversize`, `solid-fill`, `wasted-alpha`, `strippable-metadata`, every folder finding, `duplicate-exact/similar`, `integrity-missing-image`, and anything on a `>512px`/atlas asset (those aren't in `should-atlas.relatedRefs`, which is size-gated ≤512px — folder.ts:117).

### 1.2 Tally is untouched — the load-bearing data flow
- `buildIndex(report)` computes `tally = {crit,warn,info,ok}` by iterating **ALL** `report.findings` (triage.ts:127-152) **before** any selection or fold. `VerdictBar` renders `index.tally` verbatim. **The fold NEVER runs before `buildIndex`, so the chip counts are the full, honest counts.** `VerdictBar` is therefore *unchanged* (see §3) — deliberately, so the authoritative counts stay put.
- The document-level results `<h1>` (`resultsHeading(index.tally,…)`, App.tsx:394) also reads `index.tally` — unchanged.
- `potentialDiskSaved` and every `estimate` are computed in `analyze.ts` and are **not** touched by any presentation code. The png→avif saving of a *demoted* format finding stays counted (judge's CRITICAL HONESTY PIN — reverting it would *understate* a real recoverable saving; verified it already under-counts vs the drop-the-redundant-copy optimum).

### 1.3 What folds, and to where
The fold is a **pure filter over the SELECTED rows**, computed as a `Set<findingId>` (`foldableFindingIds(report)` in triage.ts). A finding id is in the set iff (scope≠folder ∧ sev≠crit) AND:

**(a) loose-fold** — `looseDominated(report)` is true AND `rule ∈ FOLDABLE_RULES` AND `assetRef ∈ should-atlas.relatedRefs`. Driven off the **single** should-atlas finding — its `relatedRefs` ARE the fold set; no parallel re-derivation (Candidate 18 respected).

**(b) format-sibling demotion** — `rule === 'format'` AND `finding.params.redundantSibling === 1` (a MEASURED fact: a better-format copy of this exact image, same stem + exact dims + no resolution token, already ships on disk in the format the finding recommends). Applies regardless of domination.

Folded rows are **removed from the visible list only while collapsed**. They remain in `index.rows` (nothing deleted) and are revealed in **ONE click** of the "show K folded" toggle. When expanded they re-appear inline in their normal sorted position.

### 1.4 Nothing appears to vanish — the reconciliation
- The ledger's **"showing N of M"** keeps `M = totalRows = countCandidates(index, selectOpts)` (unchanged — search- and fold-independent; triage.ts:288). `N = visibleRows.length`.
- A dedicated **"show K folded"** affordance states `K` exactly (`K` = count of foldable rows within the current post-search `rows`). With no search active, `N + K = M` (reconciles perfectly); with a search active the remainder is the ordinary search-hidden set, identical to today's search semantics.
- The live-region announcement (`resultCountMessage`, announce.ts) reads the SAME `visibleRows.length` — it announces what is visible, never a fabricated number.

### 1.5 Why the primary card invents nothing
The card shows `n` **verbatim** from `should-atlas.params.n` and reuses should-atlas's honest wording ("each is its own texture bind + draw call … packing batches the draws"). **No** fabricated "M draw calls → 1" (draw calls depend on the on-screen/batched set — unmeasurable statically; killed). **No** fabricated byte headline. It links to the existing pack flow; it generates nothing.

**Net honesty statement:** no finding is deleted, no count is changed, no number is invented; the tally and all estimates are computed over the full finding set before any fold; every folded row is reachable in one click and its exact count is shown.

---

## 2. Pure, Node-testable logic (the whole load-bearing surface)

apps/web has **no React test harness** (vitest env=node), so ALL decision logic lives in pure modules with Vitest coverage. Three new pure surfaces + one analysis post-pass.

### 2.1 `packages/analysis/src/variants.ts` — additive pure helpers (NEW exports)

```ts
import type { Asset, ImageMime } from '@asset-doctor/core';
import type { Finding } from '@asset-doctor/core';

export interface FormatSiblingGroup {
  stem: string;                       // dir-aware, via existing stemOf
  members: { ref: string; mime: ImageMime }[];  // sorted by ref (determinism)
}

/** Format-ONLY variant clusters: same dir-aware stem (existing stemOf), hasResolutionToken=false for
 *  ALL members, EXACT w==w && h==h for ALL members, and >=2 DISTINCT image mimes. Pure, worker-safe,
 *  zero finding/estimate side effects. Carries each member's mime (needed by the demotion guard). */
export function formatSiblingGroups(assets: Asset[]): FormatSiblingGroup[];

/** The refs whose per-file `format` finding is REDUNDANT because a sibling in the SAME format-only
 *  cluster already ships in the format the finding recommends (finding.params.bestMime). Pure; consumes
 *  the format findings so it can read each one's measured bestMime. Returns a Set<assetRef>. */
export function redundantFormatRefs(assets: Asset[], formatFindings: Finding[]): Set<string>;
```

**Clustering key** (reuse existing internals — do NOT fork): map each asset to `{ ref, mime: image.mime, size }` exactly as `groupVariants` does (atlas → `atlas.name`+`atlas.size`+`image.mime`; loose → `image.name`+`image.size`+`image.mime`, verified variants.ts:62-63). A member is eligible only if `hasResolutionToken(ref) === false` (variants.ts:47). Bucket by `stemOf(ref)` (variants.ts:23). Within a stem bucket, sub-bucket by exact `w,h`. A `FormatSiblingGroup` is emitted for each (stem, w×h) sub-bucket whose members expose **≥2 distinct `mime`** values. Members sorted by `ref.localeCompare`.

**`redundantFormatRefs`:** build `mimesByRef: Map<ref, Set<mime>>` from the cluster containing each ref (the full cluster's mime set). For each format finding `f` with `typeof f.params.bestMime === 'string'`, if `mimesByRef.get(f.assetRef)?.has(f.params.bestMime)`, add `f.assetRef`. Pure; deterministic; no Date/random.

**Vitest (`packages/analysis/test/format-siblings.test.ts`):**
| case | assets | expect |
|---|---|---|
| suppress | `icon.png`+`icon.avif` same dims; format finding on icon.png bestMime=avif | group formed; `redundantFormatRefs` = {icon.png} |
| keep (res tiers) | `hero_540p.png`+`hero_1080p.png` (res token) | NO group (hasResolutionToken=true both) |
| keep (no better sibling) | `icon.png`+`icon.webp`; icon.png format bestMime=avif | group formed (2 mimes) but avif∉{png,webp} ⇒ `redundantFormatRefs`=∅ (stays first-class) |
| keep (webp target present) | `icon.png`+`icon.webp`; icon.png bestMime=webp | redundant={icon.png} |
| false-cluster | `icon_blue.png`+`icon_red.png` | NO group (distinct stems — stemOf peels only fmt/res tokens, verified TOKEN variants.ts:12) |
| different dims | `a.png` 100×50 + `a.webp` 50×100 (same stem, no res token) | NO group (exact-dims sub-bucket splits them) — tightening over aspectBucket, exactly as ruled |
| ≥3 formats | `x.png`+`x.webp`+`x.avif`; x.png bestMime=avif | redundant={x.png} (and x.webp's finding, if any, bestMime=avif ⇒ also redundant) |

### 2.2 `packages/analysis/src/config.ts` + `packages/core/src/index.ts` — one threshold field

**core (`ThresholdConfig`, index.ts:568):** widen the existing `shouldAtlas` group with an OPTIONAL field (keeps every existing `{minLooseImages,maxSpriteEdgePx}` literal type-valid):
```ts
shouldAtlas: { minLooseImages: number; maxSpriteEdgePx: number; dominatedFraction?: number };
```
Doc-comment: *browser-only presentation gate (card prominence + collapse-default); fraction of ALL assets that are packable loose sprites. NOT read by any rule — `shouldAtlasFinding` is unchanged. Passes through resolveThresholds harmlessly (no rule consumes it), so CLI/budget findings stay byte-identical.*

**config.ts (`DEFAULT_THRESHOLDS`:11):**
```ts
shouldAtlas: { minLooseImages: 8, maxSpriteEdgePx: 512, dominatedFraction: 0.5 },
```
`0.5` PROVISIONAL — calibrate. Denominator = **all** assets (big loose + all atlases included), so a background/atlas-heavy folder scores LOW and is not promoted/collapsed (the judge's 8-loose-beside-500-atlases fix). Keep `minLooseImages = 8` as the absolute floor (inherited: should-atlas doesn't fire below it, so `looseRecommendation` returns null). **Not** added to `resolveThresholds`'s explicit enumeration — but note `resolveThresholds` does `{ ...base.shouldAtlas, ...partial.shouldAtlas }` (budget/config.ts:108), so it inherits the default from `base = DEFAULT_THRESHOLDS`; harmless because no rule reads it and the CLI never calls `looseRecommendation`.

### 2.3 `apps/web/src/lib/triage.ts` — pure presentation predicates (co-located, per ruling)

```ts
import type { AnalysisReport, Rule } from '@asset-doctor/core';

/** The single source for BOTH the primary card (n) and the loose fold set (refs). null unless the folder
 *  is loose-dominated. Reads the ONE should-atlas finding + report.thresholds — invents nothing. */
export interface LooseRecommendation { n: number; refs: string[]; }
export function looseRecommendation(report: AnalysisReport): LooseRecommendation | null;

/** True iff loose-dominated (card + collapse-default gate). Thin wrapper: looseRecommendation(report) !== null. */
export function looseDominated(report: AnalysisReport): boolean;

/** Rules eligible for the loose-fold (explicit tested allowlist — NEVER widen without a test). */
export const FOLDABLE_RULES: ReadonlySet<Rule>; // = new Set(['dimensions-npot', 'format'])

/** The set of finding IDs that MAY fold (loose-fold ∪ format-sibling demotion). Pure over the full report;
 *  computed BEFORE any selection so it can never influence the tally. */
export function foldableFindingIds(report: AnalysisReport): Set<string>;
```

**`looseRecommendation`:**
```
sa = report.findings.find(f => f.rule === 'should-atlas')       // the single source
if (!sa) return null
frac = report.thresholds.shouldAtlas.dominatedFraction
if (frac === undefined) return null                             // fail-closed (no card, no fold)
total = report.assets.length
if (total <= 0) return null
refs = sa.relatedRefs ?? []
if (refs.length < report.thresholds.shouldAtlas.minLooseImages) return null   // floor (belt-and-braces)
if (refs.length / total < frac) return null                    // domination gate
n = typeof sa.params?.n === 'number' ? sa.params.n : refs.length   // verbatim n
return { n, refs }
```

**`foldableFindingIds`:**
```
rec = looseRecommendation(report); looseRefs = rec ? new Set(rec.refs) : new Set()
out = new Set<string>()
for (f of report.findings):
  if (f.scope === 'folder' || f.severity === 'crit') continue          // hard guards
  looseFold  = rec !== null && FOLDABLE_RULES.has(f.rule) && looseRefs.has(f.assetRef)
  siblingFold = f.rule === 'format' && f.params?.redundantSibling === 1
  if (looseFold || siblingFold) out.add(f.id)
return out
```
Deterministic (iterates the already-sorted `report.findings`, analyze.ts:350; Set of ids).

**Vitest (`apps/web/test/triage-fold.test.ts`):** matrix
- `looseRecommendation`: 0 / 1 / 8 / 1000 loose; mixed (8 loose + 500 atlases ⇒ null; 8 loose + 4 atlases ⇒ present); 200 big backgrounds only (no should-atlas ⇒ null); already-spritesheets (all atlases ⇒ null); missing `dominatedFraction` ⇒ null; `total===0` ⇒ null.
- `foldableFindingIds`: crit on a loose sprite ⇒ NOT folded (hard guard); `dimensions-oversize`/`solid-fill`/`wasted-alpha` on a loose sprite ⇒ NOT folded (not in allowlist); `format`+`dimensions-npot` on a should-atlas ref, dominated ⇒ folded; same NOT dominated ⇒ NOT folded (loose branch); `format` with `params.redundantSibling===1` ⇒ folded even when NOT dominated; folder findings never folded.

### 2.4 `packages/analysis/src/analyze.ts` — the redundancy marker post-pass (ONLY change)

After the per-asset loop, where `formatFindings` is already collected (analyze.ts:99,337), and **guarded on there being format findings** (so the CLI, which produces none, is byte-identical):
```ts
// Presentation-only DEMOTION marker (invariant 3): a per-file `format` suggestion is REDUNDANT when a
// sibling in the SAME format-only cluster (same stem, exact dims, no resolution token) already ships in
// the recommended target format. We MEASURE that and mark the finding; we do NOT change its estimate,
// severity, or potentialDiskSaved (the png→avif saving stays counted — reverting it would UNDER-state a
// real recoverable saving). Never set on the CLI (no encodeImage ⇒ no format findings). Additive.
if (formatFindings.length > 0) {
  const redundant = redundantFormatRefs(assets, formatFindings);
  for (const f of formatFindings) if (redundant.has(f.assetRef)) (f.params as FindingParams).redundantSibling = 1;
}
```
Placed BEFORE `findings.sort(...)` (line 350) is irrelevant to order (it mutates params only). **Not** near `bumpBest`/`potentialDiskSaved` (those are untouched — the judge's kill respected).

**Vitest (extend `packages/analysis/test/analyze.test.ts` or a new `analyze-redundant.test.ts`):** feed two same-stem same-dim assets `icon.png`+`icon.avif` with a stub `encodeImage` that makes avif smaller ⇒ assert the `icon.png` format finding has `params.redundantSibling === 1` and its `estimate.diskBytesSaved` is UNCHANGED and `report.totals.potentialDiskSaved` is UNCHANGED vs the same run without the sibling present for that ref (byte-identity of the saving). Feed a res-tier pair ⇒ assert NO marker.

---

## 3. Exact file list (new + modified)

### NEW
| file | purpose |
|---|---|
| `apps/web/src/components/PrimaryRecommendation.tsx` | the primary "Build a spritesheet" card (§4) |
| `packages/analysis/test/format-siblings.test.ts` | §2.1 unit tests |
| `apps/web/test/triage-fold.test.ts` | §2.3 unit tests |

### MODIFIED
| file | change |
|---|---|
| `packages/core/src/index.ts` | `shouldAtlas` gains optional `dominatedFraction?: number` (§2.2). No other contract change. |
| `packages/analysis/src/config.ts` | `DEFAULT_THRESHOLDS.shouldAtlas.dominatedFraction = 0.5` (§2.2) |
| `packages/analysis/src/variants.ts` | + `formatSiblingGroups`, `redundantFormatRefs`, `FormatSiblingGroup` (§2.1). `groupVariants`/`variantsFinding` UNCHANGED. |
| `packages/analysis/src/index.ts` | re-export the two new helpers |
| `packages/analysis/src/analyze.ts` | the marker post-pass (§2.4) + import the helper. `bumpBest`/`potentialDiskSaved`/`shouldAtlasFinding`/`variantsFinding`/`groupVariants` UNCHANGED. |
| `apps/web/src/lib/triage.ts` | + `looseRecommendation`, `looseDominated`, `FOLDABLE_RULES`, `foldableFindingIds` (§2.3). `buildIndex`/`selectRows`/`countCandidates`/`LedgerRow` UNCHANGED. |
| `apps/web/src/App.tsx` | render the card between h1 and VerdictBar; compute `foldIds`/`rec`/`visibleRows`/`foldedCount`; `buildNonce`; reset `foldOpen` on new report; pass fold props to `TriageLedger` + `buildNonce` to `FixCard` (§4, §5) |
| `apps/web/src/components/TriageLedger.tsx` | + "show/hide K folded" toggle button OUTSIDE `role=listbox` (mirrors showClean); accept `visibleRows` as `rows` (prop unchanged) + new `foldedCount/foldOpen/setFoldOpen` props (§5) |
| `apps/web/src/App.tsx` (FixCard, same file) | `buildNonce` prop + effect → `preview()` when it increments (§4.3) |
| `apps/web/src/components/SettingsPage.tsx` | add `id={PACK_PANEL_ANCHOR}` to the Packing `<Card>` (optional deep-link target, §4.2) |
| `apps/web/src/lib/optimize-entry.ts` | export `PACK_PANEL_ANCHOR = 'ad-pack-panel'` (optional, §4.2) |
| `packages/i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json` | new UI keys (§6) — all 9 |
| `apps/web/test/i18n-app-keys.test.ts` | add `comp('PrimaryRecommendation.tsx')` to `appSrc` scan (so its `t()` keys are guarded) |

**`VerdictBar.tsx` — reviewed, NO change.** It renders `index.tally` (the full honest count) and must continue to; the fold never reaches it. Listed here only to record that leaving it untouched is the honest, deliberate choice.

**Core contract `Finding`/`AnalysisReport` — NO shape change.** `params.redundantSibling` uses the existing open `FindingParams` map (Candidate 5 stays killed).

---

## 4. The primary "Build spritesheet(s)" recommendation

### 4.1 Component tree
```
App (results tree, under BuildSettingsProvider)
 └─ <div hidden={view==='settings'}>  (App.tsx:377)
     └─ report && phase==='done' block (App.tsx:386)
         ├─ <h1 class="ad-sr-only">{resultsHeading(tally)}</h1>           (:394, unchanged)
         ├─ {rec && <PrimaryRecommendation                                 (NEW — only when dominated)
         │      n={rec.n}
         │      packLoose={settings.packLoose}
         │      onBuild={() => { patch({ packLoose: true }); setBuildNonce(x=>x+1); }}
         │      configureHref={SETTINGS_HASH} />}
         ├─ <VerdictBar tally={index.tally} …/>                            (:395, unchanged)
         └─ …ledger/aside…
```
`PrimaryRecommendation` internals:
```
<section aria-labelledby="ad-pack-rec-h" class="rounded-xl border border-line bg-panel p-4 …">
  <h2 id="ad-pack-rec-h" class="font-display …">{t('recommend.pack.title')}</h2>   // "Build a spritesheet"
  <p class="font-mono text-[13px] …">{t('recommend.pack.body', { n })}</p>          // reuses should-atlas wording, verbatim n
  <div class="mt-3 flex flex-wrap gap-2">
    <button type="button" onClick={onBuild} class="…CTA-green…">{t('recommend.pack.build')}</button>
    <a href={configureHref} class="…teal…">{t('recommend.pack.configure')}</a>
  </div>
</section>
```
No metric badge, no fabricated draw-call/byte figure. `n` is `should-atlas.params.n` (via `rec.n`).

Reduced-motion: the card uses only static styling / the existing `transition` utility on the button (already reduced-motion-safe per index.css:220 global reduce block); no bespoke animation.

### 4.2 [Configure] → #settings pack section
- Minimal (matches the shipped optimize-entry precedent exactly): `<a href={SETTINGS_HASH}>` opens the Settings page (route.ts `viewOfHash` is exact-match `'#settings'`). Formats is the first card; the user scrolls to Packing (3rd card).
- Nicer (optional, cheap): add `id={PACK_PANEL_ANCHOR}` to the Packing `<Card>` (SettingsPage.tsx:352) mirroring `PROFILE_PANEL_ANCHOR` on Formats (:131). Because the route is exact-match, a `#pack` fragment would NOT open Settings — so a true scroll-to-pack needs an intent flag (App sets a `scrollTo='pack'` that SettingsPage `scrollIntoView`s on mount, `behavior:'auto'` for reduced-motion). **Recommendation: ship the minimal `href={SETTINGS_HASH}` in v1** (zero new wiring, identical to the existing profile deep-link), and file the anchor+intent as a follow-up. The `packLoose` CheckRow the user then toggles is SettingsPage.tsx:375.

### 4.3 [Build] → pack flow flipping packLoose per-run (verified wiring)
`packLoose` lives in the shared `BuildSettings` context (`useBuildSettings`, settings-ctx.tsx), default `false` (build-settings.ts:138). The FixCard already reads `settings` and builds options via `buildFixOptions(settings, perRun)` (App.tsx:880) and previews via `preview()`→`planFix` (App.tsx:962, a cheap dry-run "plan" — no compose/encode/zip).

Mechanism (a monotonic nonce — the standard React "imperative signal"):
1. App owns `const [buildNonce, setBuildNonce] = useState(0)`.
2. `PrimaryRecommendation.onBuild` calls `patch({ packLoose: true })` **and** `setBuildNonce(x => x+1)` in one handler. React batches both → one commit: the context re-renders with `packLoose:true`, App re-renders with the new nonce.
3. `FixCard` receives `buildNonce` as a prop and runs `useEffect(() => { if (buildNonce > 0) void preview(); }, [buildNonce])`. Because the effect fires **after** the commit that already updated `settings`, the `preview()` closure it calls reads `packLoose:true` — the plan includes the pack ops. The Plan card appears; the user confirms with the existing "Run fix". (Instant-wow: the recommendation is visible immediately; one click shows a concrete plan ≤10s; a second confirms the build. No auto-run of a heavy fix without the plan.)
4. On [Build], `scrollIntoView` the FixCard (`behavior:'auto'`) so the plan is seen.

Notes: `patch` always yields a fresh settings object (settings-ctx.tsx:34), so even if `packLoose` was already true, the FixCard stale-plan invalidation fires and the nonce re-previews. The Pro gate is unchanged — `preview`/run stay gated exactly as today (free in beta, `VITE_PRO_GATE` off). No pack-engine change (Phase 2 engine + `groupLooseForPacking` already exist).

**Size-gate divergence note (verified openConcern):** `should-atlas.relatedRefs` is size-gated `max(w,h)≤512` (folder.ts:117), but the ingest pack candidate filter also admits Spine-root images of ANY size (`rootOf(ref)!==null || max≤512`, ingest/index.ts:363). So the card's `n` may NOT equal the exact count the pack flow packs. **The card copy MUST say "N loose sprites detected" (a detection count), NEVER "will pack exactly N".** The `recommend.pack.body` string below honors this.

---

## 5. The collapse mechanism, concretely

### 5.1 App.tsx (verified anchors: `rows` memo :219, `totalRows` :223, ledger props :414-431)
```ts
const rec       = useMemo(() => (report ? looseRecommendation(report) : null), [report]);
const foldIds   = useMemo(() => (report ? foldableFindingIds(report) : EMPTY_SET), [report]);
const [foldOpen, setFoldOpen] = useState(false);            // false = collapsed (default)
useEffect(() => { setFoldOpen(false); }, [report]);         // each new analysis starts collapsed
const foldedCount = useMemo(() => rows.reduce((k,r)=>k+(foldIds.has(r.id)?1:0),0), [rows, foldIds]);
const visibleRows = useMemo(() => (foldOpen || foldedCount===0 ? rows : rows.filter(r=>!foldIds.has(r.id))), [rows, foldIds, foldOpen, foldedCount]);
```
Pass `rows={visibleRows}` (prop name unchanged) and add `foldedCount`, `foldOpen`, `setFoldOpen` to `<TriageLedger>`. `totalRows` (M) stays `countCandidates(...)` — **unchanged**.

**Default-collapse rule (reconciliation of ruling items 3 & 4, documented):** `foldOpen` defaults `false` (collapsed) universally. When there is nothing to fold (`foldedCount===0` ⇒ no dominated loose sprites AND no redundant siblings), `visibleRows === rows` and the toggle is hidden ⇒ **zero visible effect** ⇒ byte-identical to today. When dominated, the loose rows fold by default (ruling 3). When NOT dominated but redundant format siblings exist, those demote by default (ruling 4). `looseDominated` still gates *card prominence* exactly as the judge required; the collapse-default is the union of the two approved behaviors. This divergence from the literal "collapse-default gated on looseDominated" is PRO-honesty-neutral (all §1 guarantees hold) and satisfies item 4 in the non-dominated case; no finding is hidden, K is stated, everything is one click away.

### 5.2 TriageLedger.tsx — the toggle (OUTSIDE role=listbox)
Add, in the controls row beside `showClean` (TriageLedger.tsx:341-356, which is above the `role=listbox` div at :366 — verified it sits outside the listbox, preserving the single-active `aria-activedescendant` model + virtualization):
```tsx
{foldedCount > 0 ? (
  <button type="button" aria-pressed={foldOpen}
    onClick={() => setFoldOpen(!foldOpen)}
    className={`rounded-lg border px-2.5 py-1 font-mono text-xs transition ${foldOpen ? 'border-teal text-ink' : 'border-line text-ink-soft hover:border-ink-soft'}`}>
    {foldOpen ? t('triage.foldHide', { n: foldedCount }) : t('triage.foldShow', { n: foldedCount })}
  </button>
) : null}
```
Everything else in TriageLedger operates on the `rows` prop (=`visibleRows`) unchanged — the windower, the `aria-activedescendant` nav (`optionItemIndexes`), the "showing N of M" line (`rows.length`/`totalRows`). No change to `useWindow`/`ledger-nav`.

**Selection edge:** if the worst-offender auto-select (App.tsx:152) or a prior click landed on a now-folded asset, while collapsed that row is absent ⇒ `activeOption` resolves to `-1` (TriageLedger:247-254) and `aria-activedescendant` is unset; `selectedAsset` still persists so the FilmViewer keeps showing it. Acceptable (no crash, no orphan). Optional polish: bias the initial auto-select toward a non-folded row — NOT required for v1.

---

## 6. i18n — new keys (ALL 9 catalogs: en ru de es pt fr it zh hi)

These are **UI keys, not finding messageKeys** — they do NOT touch `renderFinding`'s baked-vs-en drift guard (no finding copy changes in v1). They MUST pass `catalogs.test.ts` (same keys + same `{…}` tokens in every locale) and `i18n-app-keys.test.ts` (component added to `appSrc`).

| key | en value | notes |
|---|---|---|
| `recommend.pack.title` | `Build a spritesheet` | static; card `<h2>` |
| `recommend.pack.body` | plural `{n}`: one `"{n} loose sprite detected. Each is its own texture bind and draw call at runtime; packing them into an atlas batches the draws."` / other same with "loose sprites" | reuses should-atlas wording; "detected" NOT "will pack" (§4.3) |
| `recommend.pack.build` | `Build spritesheet` | static; CTA-green button |
| `recommend.pack.configure` | `Configure packing` | static; teal link to #settings |
| `triage.foldShow` | plural `{n}`: one `"show {n} folded note"` / other `"show {n} folded notes"` | collapsed toggle |
| `triage.foldHide` | plural `{n}`: one `"hide {n} folded note"` / other `"hide {n} folded notes"` | expanded toggle |

Plural objects use the `{ "$count": "n", "one": "…", "other": "…" }` shape (matches existing `triage.showClean`). The regex in `i18n-app-keys.test.ts` `staticKeys` captures `t('recommend.pack.title'` / `t('triage.foldShow'` (verified it matches `t(` + quote + dotted-key + quote), so **no dynamic-branch addition is needed** — only add `comp('PrimaryRecommendation.tsx')` to `appSrc` (TriageLedger.tsx is already scanned). Add the same six keys to the `catalogs.test` no-leftover-brace smoke set for `recommend.pack.body`/`triage.foldShow`/`triage.foldHide` (n=1 and n=5).

---

## 7. a11y plan

- **Heading / landmark:** card is a `<section aria-labelledby>` with an `<h2>`. Outline stays monotonic: `h1` (results, :394) → `h2` (card) → `h2` (VerdictBar "Diagnosis") → `h2` (findings aside) → `h3`. When not dominated the card is absent ⇒ outline unchanged (h1→h2→h2…). No regression to the shipped UX-3 heading order.
- **Keyboard expand/collapse:** the fold toggle is a single native `<button>` with `aria-pressed`, in the Tab order, **outside** `role=listbox` (so the listbox's sole-tab-stop + `aria-activedescendant` single-active model is untouched — verified showClean does exactly this). One focusable control; Enter/Space toggle.
- **Reduced-motion:** no bespoke animation. The reveal is a plain re-render (rows appear); `scrollIntoView` on [Build] uses `behavior:'auto'`. Honors the global `prefers-reduced-motion: reduce` block (index.css:220).
- **Contrast:** card CTA reuses CTA-green `#15A06A` (AA-verified token) and teal link `#0E8C8C`; body text uses `text-ink`/`text-ink-soft` (raised to AA in UX-3, per recent commits). Fold toggle reuses the exact showClean chip classes (already AA).
- **Live region:** unchanged — `resultCountMessage(visibleRows.length, totalRows)` announces the visible/total honestly; the fold toggle's `aria-pressed` communicates state to SRs.

---

## 8. Edge cases

| scenario | behavior |
|---|---|
| **0 loose** | no should-atlas ⇒ `rec=null` ⇒ no card; `foldIds` may still hold redundant-format siblings (demote), else empty ⇒ byte-identical |
| **1 loose** | should-atlas needs ≥8 ⇒ no finding ⇒ `rec=null` ⇒ no card/loose-fold |
| **8 loose (exactly floor), few atlases** | should-atlas fires; if `8/total ≥ 0.5` ⇒ card + loose-fold; else no card |
| **1000 loose** | should-atlas fires, fraction≈1 ⇒ card (`n`=1000 verbatim); hundreds of format/npot rows fold under one "show K folded"; ledger stays responsive (windower untouched, operates on `visibleRows`) |
| **mixed atlas+loose (8 loose + 500 atlases)** | `8/508=0.016 < 0.5` ⇒ NOT dominated ⇒ NO card, NO loose-fold (the judge's core fix); should-atlas warn still shows in the ledger + tally |
| **already-spritesheets (all atlases, 0 loose)** | no should-atlas ⇒ `rec=null` ⇒ no card, no nag; only atlas findings show |
| **format variants WITHOUT loose-domination** (e.g. 4 hero atlases each png+avif) | no card; the redundant png format findings demote (fold, reachable) via `redundantSibling`; tally unchanged |
| **oversized loose (2048² solid PNGs)** | `dimensions-oversize`/`solid-fill` are NOT in `FOLDABLE_RULES` and (for oversize) the ref isn't in should-atlas.relatedRefs (>512px) ⇒ NEVER folded — a genuine warn stays first-class even in a dominated folder |
| **crit on a loose sprite** | hard guard `severity!=='crit'` ⇒ never folds |
| **selected asset gets folded** | activeOption→-1, `selectedAsset` persists, FilmViewer keeps it (§5.2); one click reveals |
| **redundant-sibling with no better format** (`icon.png`+`icon.webp`, best=avif) | NOT marked ⇒ stays first-class (genuine suggestion) |

---

## 9. Determinism & byte-identity / no-regression

- **Determinism:** all new logic is pure integer/string; `formatSiblingGroups` sorts members by `localeCompare`; `foldableFindingIds` iterates the already-sorted `report.findings`; `looseRecommendation` reads a single finding; no Date/random/network. `foldOpen` is UI state (not a data value). The probe re-set feeds no fold input (fold reads findings, not probe numbers), so async probe resolution never reorders the fold.
- **Byte-identity when NOT loose-dominated AND no redundant siblings:** `rec=null` ⇒ no card; `foldIds` empty ⇒ `visibleRows===rows` ⇒ ledger/VerdictBar/tally/announce all identical; the toggle is hidden; `report` identical (no format finding is marked without a sibling). **The results view is pixel- and DOM-identical to today.**
- **CLI/budget byte-identity:** `dominatedFraction` is read by no rule; format findings never fire on the CLI (no `encodeImage`) ⇒ marker never set ⇒ report/SARIF byte-identical. `resolveThresholds` passing the field through is inert.
- **Default fix run byte-identity:** `packLoose` default stays `false` (build-settings.ts:138); only the explicit [Build] click flips it per-run (via `patch`, not persisted — build-config whitelist unchanged).

---

## 10. Integration notes (in-flight work all touches App.tsx / analysis / i18n)

- **Just-shipped Settings page (`route.ts`, `SettingsPage.tsx`, `settings-ctx.tsx`, `build-settings.ts`):** we REUSE it (no rewrite) — `[Build]` flips the existing `packLoose` via the existing context `patch`; `[Configure]` links via the existing `SETTINGS_HASH`. The only SettingsPage edit is the optional `id={PACK_PANEL_ANCHOR}` on the Packing Card. If a concurrent tick renames the Packing card / pack keys, our anchor+link still resolve (they key on `SETTINGS_HASH`, not the card copy).
- **UX-4 picks + landing (docs/improvements/ux4-*.md, landing-design.md):** design AGAINST HEAD. The card inserts at App.tsx:394-395; if UX-4 also inserts between h1 and VerdictBar, coordinate ordering (card first, then any UX-4 banner, then VerdictBar) to keep the monotonic h1→h2→h2 outline. Our new i18n keys are namespaced `recommend.pack.*` and `triage.fold*` — no collision with `find.*`/`fix.*`/`settings.*`/`a11y.*`. Add them in the SAME catalog edit pass to avoid a parity-test race (a half-added key breaks `catalogs.test` for all 9).
- **04:00 tick (UX-4/landing impl):** may also edit App.tsx/analyze.ts/i18n. Our analyze.ts change is a single self-contained post-pass block (§2.4) — merge-friendly. Our App.tsx changes are localized (one card render + a fold memo cluster + one FixCard prop) — keep them in the small commits below so a rebase is mechanical.

---

## 11. Ordered small-commit breakdown (1 meaning each)

1. **core+config:** add optional `shouldAtlas.dominatedFraction` to `ThresholdConfig` + `DEFAULT_THRESHOLDS=0.5` (doc-comment: browser-only, denominator=all assets). Typecheck only — no behavior change.
2. **analysis helpers:** `formatSiblingGroups` + `redundantFormatRefs` + `FormatSiblingGroup` in variants.ts; re-export from index.ts; + `format-siblings.test.ts` (§2.1 matrix). Pure, no wiring.
3. **analysis marker:** the `redundantSibling` post-pass in analyze.ts (§2.4) + test asserting the marker fires and `potentialDiskSaved`/`estimate` are unchanged.
4. **triage predicates:** `looseRecommendation`/`looseDominated`/`FOLDABLE_RULES`/`foldableFindingIds` in triage.ts + `triage-fold.test.ts` (§2.3 matrix). No component change yet.
5. **i18n:** the six keys (§6) in all 9 catalogs; add `PrimaryRecommendation.tsx` to `i18n-app-keys` `appSrc`; extend `catalogs.test` smoke set. (Component doesn't exist yet — create a stub file with the `t()` calls, or land this together with commit 6; prefer merging 5+6 if the app-keys test would otherwise fail on a missing file.)
6. **card:** `PrimaryRecommendation.tsx` + render it in App.tsx between h1 and VerdictBar, gated on `rec`. No fold yet (card alone is honest and shippable).
7. **[Build] wiring:** `buildNonce` in App + FixCard effect→`preview()` + scrollIntoView; `[Configure]` link (+ optional `PACK_PANEL_ANCHOR`).
8. **collapse:** App `foldIds/visibleRows/foldedCount/foldOpen` + reset-on-report effect; TriageLedger show/hide-K toggle (outside listbox). This is the honesty-critical commit — land with the §1 guarantees called out in the message.

Each commit ends with the co-author trailer. Gate for the impl phase (NOT this workflow): `export PATH="$HOME/.local/bin:$PATH" && pnpm typecheck && pnpm test && pnpm lint`.

---

## 12. Test plan — pure unit vs honestly-not-unit-testable

**Pure Vitest (Node):**
- `format-siblings.test.ts` — §2.1 matrix (clustering + redundancy decision).
- `analyze-redundant.test.ts` (or extend analyze.test) — marker fires; `estimate.diskBytesSaved` and `totals.potentialDiskSaved` byte-identical; res-tier pair ⇒ no marker; CLI-shaped run (no `encodeImage`) ⇒ no marker.
- `triage-fold.test.ts` — `looseRecommendation` (0/1/8/1000/mixed/backgrounds/all-atlases/missing-fraction/total=0); `foldableFindingIds` (allowlist, crit guard, folder guard, dominated vs not, sibling branch); determinism (stable Set membership over a fixed report).
- `catalogs.test` / `i18n-app-keys.test` — parity of the six keys across 9 locales + presence in `appSrc` scan.
- `budget`/CLI regression suite — unchanged output (proves `dominatedFraction` is inert on the CLI).
- Existing `triage.test` / `build-settings.test` must stay green (we don't touch `buildIndex/selectRows/countCandidates/settingsDefaults`).

**Honestly NOT unit-testable (apps/web has no React harness) — MANUAL GATE (run `pnpm dev`, load a fixture):**
- A loose-dominated folder (`fixtures/sample-projects/*` with ≥8 loose ≤512px sprites, mostly loose): the card renders with the correct verbatim `n`; the ledger auto-collapses format/npot rows; "show K folded" reveals them in one click; VerdictBar chip counts equal the FULL finding counts (crit/warn/info) whether folded or not; "showing N of M" keeps M constant; `N+K=M` with no search.
- `[Build]` flips packLoose and opens a Plan card that includes pack ops; `[Configure]` opens Settings.
- A NOT-dominated folder (mostly atlases + a few loose): NO card; ledger identical to today; should-atlas warn still listed.
- A format-variant folder (png+avif pairs) that is not loose-dominated: no card; redundant png format rows are demoted (fold), reachable; tally unchanged.
- Keyboard: Tab reaches the fold toggle; Enter toggles; listbox nav still works; SR reads h1→h2(card)→h2(diagnosis)…; `prefers-reduced-motion` shows no animation and `behavior:'auto'` scroll.
- Verify NO horizontal page scroll and the card is responsive (wide `n`/copy wraps).

This manual gate is the honest substitute for a component test; it exercises exactly the invariant-3 guarantees (tally untouched, everything reachable, nothing invented) that no pure unit test can observe end-to-end.
