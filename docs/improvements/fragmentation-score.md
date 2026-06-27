All clear:
- `wastedRegions`/`occupancyFinding` have no external callers beyond `analyze.ts` — refactoring their signatures is safe (no extension/web direct usage).
- No exhaustive `AssetMetrics` construction that a new optional field would break.
- `summarizeEmpty`, `fragmentation` (as a field), `EmptySpace` don't pre-exist — no name collision. (The word "fragmentation" appears once in a correlate comment, unrelated.)

I have everything. Writing the adversarial review and revised design.

---

# Adversarial Review + Revised Mini-Design: Atlas Fragmentation Score

## Verdict on the premise: TRUE, with corrections

The improvement is real and the core premise holds against the code. `mergeEmptyRects` (grid.ts:56-81) genuinely computes the full disjoint `Rect[]`; `wastedRegions` (rules.ts:113-127) genuinely reduces it to `{n, pct}` and discards the per-rect geometry. Occupancy alone cannot distinguish one-clean-block from shredded. The fix is pure geometry over rects already in hand — no decode, Invariant-3/4 safe. **Proceed — not DROP.**

But the draft has **3 blockers, 4 majors, and several inaccuracies** that would bite an implementer. The biggest: the draft's "always-embed the clause" i18n approach silently produces malformed sentences in a real, reachable edge case it claims is impossible.

---

## BLOCKERS

### B1 — `frag` can be `undefined` while `occupancyFinding` STILL fires (draft's "always-present" param assumption is false)
The draft (§3c, §5) hinges on: *whenever occupancy fires, `wastedRegions` produced a `frag`*. **False.** Both gates fire iff `occ < warn` (verified: rules.ts:41 returns null on 'ok' = `occ ≥ warn`; rules.ts:111 gates `occ ≥ warn → null` — aligned). BUT `wastedRegions` has a *second* exit: `rects.length === 0 → null` (rules.ts:114). A degenerate atlas whose frames rasterize to cover every grid cell (tiny atlas, `defaultCell` floor of 8px, frames straddling all cells) yields `occ < warn` (occupancy is sub-pixel-exact area, not grid-rasterized) yet **zero empty rects**. Then `occupancyFinding` fires with `frag === undefined`, and the draft's unconditional `{frag:pct}`/`{reclaimGainPct:pct}` interpolate to `''` (i18n/index.ts:96-97 returns `''` for missing params) → *"The empty space is  consolidated, so a repack reclaims ~ of the sheet"*. Shipped-honest violation.
**Fix (mandatory):** `occupancyFinding` must DEFAULT the params when `frag === undefined`: set `frag = 1`, `reclaimGainPct = wasted` (i.e. fall back to today's "full reclaim" claim, which is correct when no fragmentation signal exists). Never emit empty interpolation. Same defaulting for `atlas-merge` (an `under` atlas above-warn-occupancy can't even be in `under`, but a zero-rect atlas can — default there too).

### B2 — Changing `find.occupancy.detail` / `find.wasted-regions.detail` token sets forces an all-9-locale edit OR the build goes red, and the draft under-budgets this
`catalogs.test.ts:27` asserts `tokens(lv) === tokens(ev)` — the **exact `{token}` set** (hint included: `{frag:pct}` ≠ `{frag}`) must match across all 9 catalogs. Adding `{frag:pct}`, `{reclaimGainPct:pct}`, `{largestPct:pct}` to en makes **8 locales instantly fail** until propagated. The draft acknowledges this but buries it as "the main i18n cost" — it's a hard build-break, not a cost. **Also:** `find.atlas-merge.detail` is a **plural object** (`$count: merged`, `one`/`other`) — `tokens()` unions across plural branches (test line 8-12), so the new tokens must appear in BOTH `one` and `other` of all 9.
**Mitigation (de-risks):** good news the review surfaces — **no render test asserts these three `detail` strings' content** (render.test.ts:126 only checks `find.occupancy.*title*`). So you may add the tokens to all 9 with *machine-rough* translated text; only the token SET is enforced. Still 9-file mechanical edits — keep F9 as its own commit and run `pnpm --filter @asset-doctor/i18n test` before moving on.

### B3 — Reordering `analyze.ts` to call `wastedRegions` before metrics changes nothing unless metrics is built AFTER (draft's snippet is right; the "Key facts" line is misleading)
Draft §3d snippet is correct, but the "Key facts for implementer" says *"reorder so frag is available; output order re-sorted at :126 so reordering is safe."* The **findings**-order re-sort is irrelevant to the bug; what matters is that `metrics.push(...)` (analyze.ts:76-82) currently runs BEFORE `wastedRegions` is ever called (line 85). To set `metrics.fragmentation`, you must call `wastedRegions` **before** `metrics.push`, then read `waste?.params?.frag`. Reading a number off `params` and storing it as a typed `number` field is fine, but **`FindingParams` values are `string | number`** (core:184) — `waste.params.frag` is typed `string | number`, so the `typeof === 'number'` guard in the draft snippet is **load-bearing, not optional**. Keep it.

---

## MAJORS

### M1 — `reclaimGainPct = frag*(1-occ)` is dimensionally wrong as a "realistic post-repack" claim
Draft §3c/§4 defines `reclaimPct = occ + frag*(1-occ)` (post-repack packed fraction) in one place and `reclaimGainPct = frag*(1-occ)` (fraction of whole sheet reclaimed) in another, and the FilmViewer §4 uses neither. `frag*(1-occ)` is **not** how much a repack reclaims — `frag` (largestEmptyRect / totalEmpty) is a *dispersion ratio*, not a *reclaimable fraction*. A repack with MaxRects can reclaim ALL empty space regardless of dispersion (it re-places sprites freely); fragmentation predicts how much a *cheap in-place defrag* (not a full repack) could reclaim, OR how much the **single largest contiguous hole** could absorb a new sprite. Claiming "a repack reclaims ~`frag*(1-occ)`" is itself a **new dishonesty** — it under-claims MaxRects repack.
**Fix:** Reframe the honest copy. Fragmentation answers *"is the waste one block or shredded?"*, not *"how much repack saves"*. The honest occupancy sentence: append only when shredded — *"…the empty space is split across {n} regions (largest {largestPct} of the sheet), so the win needs a full repack, not a trim."* Do NOT invent a `reclaimGainPct`. This **removes** two of the three new occupancy tokens (keep `{frag:pct}` or `{largestPct:pct}`, drop `reclaimGainPct`), shrinking B2's blast radius.

### M2 — `summarizeEmpty` should take a `Size` to compute `largestPct`, or `largestPct` lives in the caller
Draft puts `fragmentation` in `summarizeEmpty(rects)` but `largestPct` (= largestArea / atlasPx) needs the atlas size, which `summarizeEmpty(rects: Rect[])` doesn't have. Either pass `atlasPx`/`Size` into the helper or compute `largestPct` in `rules.ts` from `empty.largestArea / atlasPx`. **Decision: keep helper rects-only (pure, reusable); compute `largestPct` in the caller** (it already has `atlasPx`, rules.ts:116). Cleaner separation.

### M3 — `fragmentation` field doc must state it's a *dispersion* metric, not a savings metric (Invariant 3)
Given M1, the JSDoc the draft proposes ("how reclaimable") is itself a soft over-claim. Reword: *"Dispersion of empty space: largestEmptyRectArea / totalEmptyArea. 1 = one contiguous hole; →0 = many scattered gaps. Describes the SHAPE of waste, not the recoverable amount (MaxRects repack recovers waste regardless). Computed over the conservatively-merged grid rects, so it inherits the coverage map's under-claim."*

### M4 — Config default `fragmentation: { warn: 0.4 }` is uncalibrated and the draft admits the threshold barely does anything
After M1 the `cfg.fragmentation.warn` threshold's only job is gating the "shredded — needs a full repack" sentence. Draft §8 says absence "only means no extra emphasis" — so the threshold is nearly decorative. **Decision:** Keep it (additive, suppressible, lets a future standalone finding hook in) but mark the default `0.4` explicitly **PROVISIONAL — display/copy gate only, not a savings gate** in the config comment, mirroring the existing provisional note (config.ts:3). Don't pretend it's calibrated on real exports like occupancy is.

---

## MINORS / corrections

- The budget registry export is **`ASSET_METRICS`** (metrics.ts:82), not `PER_ASSET_METRICS` as the draft repeatedly calls it. The draft's conclusion is right (a new *unregistered* optional field is invisible — confirmed: `ASSET_METRICS` is a hand-written `Map`, no auto-enumeration of `AssetMetrics` fields), just the name is wrong.
- `wastedRegions`/`occupancyFinding` have **zero external callers** (verified across `apps/` + `packages/`) — signature changes are fully safe. The draft's caution about touching `occupancyFinding`'s arity is over-cautious; go ahead.
- No exhaustive `AssetMetrics` constructor exists outside `analyze.ts` — optional field is safe.
- `summarizeEmpty`/`fragmentation`/`EmptySpace` don't pre-exist — no collision.
- FilmViewer: SIZE *is* duplicated (top bar line 94 + strip line 107). The 4-col swap (drop SIZE from strip) is sound. `occColor` mirror (0.6/0.8) confirmed at line 83; FRAG buckets 0.4/0.7 are fine as presentational literals.
- Test baseline: analysis has 17 + 19 (dedup) `it`s; i18n 3 + 7. "88 tests" is the repo-wide pnpm count — don't assert "88" in any single file; assert ≥ baseline green.

---

## Revised key decisions (delta from draft)

1. **No `reclaimGainPct` token** (M1). Occupancy copy gains at most `{frag:pct}` + `{largestPct:pct}`; wasted-regions gains `{largestPct:pct}`; atlas-merge gains `{frag:pct}`. Fewer tokens = smaller 9-locale edit.
2. **`occupancyFinding` defaults `frag→1` when undefined** (B1) so the always-rendered clause is always truthful.
3. **`summarizeEmpty(rects)` stays Size-free**; `largestPct` computed in callers (M2).
4. **Honest framing:** dispersion/shape, never "savings" (M1/M3).
5. Everything else in the draft (gate reuse, single `mergeEmptyRects` call, no new `Rule`, additive core field, 4-col FilmViewer swap, literal FRAG label) **stands — verified correct against code.**

---

## ORDERED TASK BREAKDOWN (revised)

| id | title | files | tag | deps | acceptance |
|---|---|---|---|---|---|
| **F1** | Core: add `AssetMetrics.fragmentation?` (dispersion JSDoc per M3) + `ThresholdConfig.fragmentation?: { warn }` | `packages/core/src/index.ts` | core | — | Optional fields + honest dispersion JSDoc. `pnpm typecheck` green; no consumer breaks. |
| **F2** | `summarizeEmpty(rects): EmptySpace` pure helper (`{rects,totalArea,largestArea,fragmentation?}`; `undefined` when `totalArea===0`) + export | `grid.ts`, `analysis/src/index.ts` | analysis-pure | F1 | One-pass; Size-free; exported. Unit tests 1–2 pass. |
| **F3** | `wastedRegions`: reuse rects via `summarizeEmpty`, add `frag` + `largestPct` params; baked detail states largest-block % | `rules.ts` | analysis-pure | F2 | No 2nd `mergeEmptyRects`; params carry `frag`(number)+`largestPct`; existing overlay test (analysis.test.ts:78) green. |
| **F4** | `occupancyFinding(atlas,cfg,opts?:{fragmentation?})`: add `frag`+`largestPct` params, **default frag→1 / largestPct→wasted when undefined** (B1); honest dispersion clause (M1, no reclaimGainPct) | `rules.ts` | analysis-pure | F3 | 3rd optional arg; no empty interpolation possible; copy truthful at frag≈1 and when shredded; occupancy tests green. |
| **F5** | `atlasMergeFinding`: thread min-`frag` of `under` atlases (default 1 when none mappable) + dispersion caveat | `folder.ts` | analysis-pure | F3 | `frag`+`largestPct` params in BOTH plural branches' template; baked caveat present; atlas-merge test green. |
| **F6** | `analyze.ts`: call `wastedRegions` BEFORE `metrics.push`; set `metrics.fragmentation` from `typeof waste?.params?.frag==='number' ? … : undefined` (B3); pass into `occupancyFinding` | `analyze.ts` | analysis | F3,F4 | Single `wastedRegions` call; `metrics[i].fragmentation` set; guard retained. Integration tests 5–6 pass. |
| **F7** | Config: `fragmentation: { warn: 0.4 }` marked **PROVISIONAL — copy/display gate only** (M4) | `config.ts` | analysis | F1 | Added to `DEFAULT_THRESHOLDS` with provisional comment. |
| **F8** | FilmViewer FRAG cell (4-col: VRAM·DISK·OCC·FRAG; drop duplicate SIZE from strip, stays in top bar); buckets 0.4/0.7; `—` when undefined | `apps/web/src/components/FilmViewer.tsx` | ui | F1,F6 | FRAG shows `%` or `—`; color mirrors OCC pattern; `pnpm typecheck` green. |
| **F9** | i18n: add `{frag:pct}`+`{largestPct:pct}` (occupancy), `{largestPct:pct}` (wasted-regions), `{frag:pct}`+`{largestPct:pct}` (atlas-merge BOTH plural branches) to **all 9** catalogs (B2) | `i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json` | i18n | F3,F4,F5 | en first; identical token sets across 9; `pnpm --filter @asset-doctor/i18n test` green. |
| **F10** | Tests: `summarizeEmpty` units (incl. `[]`→undefined); clean-vs-shredded parity; analyze integration (frag defined `<warn`, undefined `≥warn`); zero-rect occupancy renders no empty `{}` (B1 regression) | `packages/analysis/test/analysis.test.ts` | test | F2–F7 | Tests 1–6 + B1 regression green; `pnpm test` ≥ baseline; `pnpm lint`. |

**Commit slicing (1 meaning each):** F1+F2 (geometry contract); F3+F4+F5+F6+F7+F10 (analysis wiring + tests, per repo "core with tests" convention); F8 (UI); F9 (i18n).

**B1 regression test is mandatory** (new vs draft): construct a tiny atlas where `occ < warn` but `mergeEmptyRects` returns `[]` (frames straddling every cell), assert `renderFinding(occ, 'en').detail` contains no `{` and no double-space artifact.

### Load-bearing facts for the implementer
- rules.ts:113 builds `rects`; :115-116 compute `emptyPx`/`atlasPx` — **reuse, don't re-merge**.
- Both gates fire iff `occ < warn` (rules.ts:41 'ok'-return ≡ rules.ts:111 gate). BUT `wastedRegions` ALSO returns null on `rects.length===0` (rules.ts:114) — this is the B1 hole; `occupancyFinding` must default frag.
- `FindingParams` values are `string|number` (core:184) — keep the `typeof==='number'` guard when reading `waste.params.frag`.
- Budget registry is **`ASSET_METRICS`** Map (metrics.ts:82), hand-written — unregistered optional field is invisible; do NOT register `fragmentation` in v1.
- `catalogs.test.ts:27` enforces identical `{token}` sets (hint-inclusive) across 9 locales; `tokens()` unions plural branches → atlas-merge needs new tokens in `one` AND `other`. No render test checks these three `detail` strings' text, so translations may be machine-rough.
- `wastedRegions`/`occupancyFinding` have zero callers outside `analyze.ts` — signature changes safe.