Critical severity-flip confirmed. `tp-array-oversize` at exact-occ 0.8575 is already ≥ warn (0.8), so occupancy is `ok` (no finding) — grid 0.9366 stays `ok`, no flip there. But the real danger is the **direction of the error**: the grid systematically OVER-claims occupancy (0.8575→0.9366, 0.906→0.9375, 0.1884→0.2031). This means an atlas that genuinely needs repacking will read as *more packed than it is*, pushing it toward `ok` and **suppressing the very finding this tool exists to emit**. The draft markets the grid as "the honest source of truth" — but for the dominant non-aliased case it's *less* honest than the exact sum, not more.

I have full grounding. Here is the adversarial review and revised design.

---

# ADVERSARIAL REVIEW — `occupancyValue` clamp / overlap-correctness

## Premise: TRUE (partially) — but the proposed cure is worse than the disease for the common case

The bug is real and verified exactly as drafted:
- `rules.ts:32-36` — naive Σ(frame area), no clamp.
- `rules.ts:47` — `wasted = 1 - occ` goes negative.
- `folder.ts:141-144` — independent naive sum in `atlasMergeFinding`.
- `buildCoverage` (`grid.ts:20-35`) is overlap-correct by construction.

So **the clamp (the brief's actual ask) is sound and load-bearing.** But the draft's *expansion* into grid-derived `coveredArea` as the new occupancy source is a **BLOCKER** — I ran the numbers against the real fixtures and the draft's central determinism claim is false.

---

## BLOCKERS

### B1 — "No behavior change for normal atlases" is FALSE. 5 of 6 goldens shift, by large margins, in the wrong direction.

The draft (§7) frames the golden risk as *"sub-cell edge rounding… update that single number if it shifts."* I computed the actual grid-vs-sum divergence for every occupancy fixture:

| fixture | size | cell | exact occ (golden) | grid occ (proposed) | Δpp |
|---|---|---|---|---|---|
| tp-hash-symbols | 512² | 8 | 0.1884 | **0.2031** | +1.5 |
| tp-array-oversize | 4100×1024 | 64 | 0.8575 | **0.9366** | **+7.9** |
| pixi-packed-ok | 1024² | 16 | 0.906 | **0.9375** | +3.2 |
| spine-basic | 256² | 8 | 0.1587 | **0.1738** | +1.5 |
| poly-concave | 512² | 8 | 0.5 | 0.5 | 0 |

Five of six shift; `tp-array-oversize` moves **+7.9 percentage points**. This is not "sub-cell rounding" — it's systematic over-claim: every frame's partial right/bottom edge cell rounds *up* to a full cell, and with many frames the over-claim compounds. The grid is conservative for *emptiness* (its documented purpose, `grid.ts:1-4`) precisely because it **over-claims coverage** — which is exactly wrong for an occupancy/packed metric.

### B2 — Honesty inversion (Invariant 3). The grid makes occupancy LESS honest for the dominant non-aliased case.

The tool exists to flag under-packed atlases. `occupancy.warn = 0.8`. The grid systematically inflates occupancy toward 1.0, so a genuinely loose atlas reads *more packed than it is* → drifts toward `ok` → **the occupancy finding gets suppressed.** The draft sells the grid as "the honest source of truth"; in reality, for every atlas without aliasing (i.e. ~all of them), the exact frame-area sum is the *more* accurate number and the grid is a coarsened over-estimate. We'd be trading a rare, visible false-positive (130% on aliased sheets) for a common, *invisible* false-negative (missed under-packing). That's a net honesty regression and an Invariant-3 violation by the draft's own standard.

### B3 — The aliasing premise is unquantified and likely near-zero in the fixture corpus. The expensive half of the design may be solving a non-problem.

The draft asserts TexturePacker aliasing and shared Spine regions cause occ>1, but provides **no fixture that actually exhibits occ>1** (T7 proposes to *create* one). None of the 6 existing goldens alias — all read <1 with the exact sum. The >1 case is real in principle but the draft hasn't shown it occurs in any real export the tool has been calibrated on. Building `coveredArea`, rewiring `atlasMergeFinding.usedArea`, and reconciling 5 goldens is heavy machinery for an unquantified edge case — **when a one-line clamp fully satisfies the brief and fixes every verified impossibility.**

---

## MAJORS

### M1 — `atlasMergeFinding.usedArea` via grid (T4) actively breaks merge detection.
`minAtlases = ceil(usedArea/capacity)` (folder.ts:147). The grid *inflates* `usedArea` (+7.9pp seen above) → inflates `minAtlases` → makes `minAtlases >= under.length` more likely → **suppresses more legitimate merges.** The draft claims this makes `minAtlases` "honest"; the data shows it makes it *larger*, which is the opposite of the fix's goal. Today's naive sum is the *correct* basis here (it's the true packed pixel demand for non-aliased atlases). The only real defect in `atlasMergeFinding` is the missing clamp on the *filter* (line 139), already covered by clamping `occupancyValue`.

### M2 — i18n drift guard interaction (under-analyzed, but survives).
`render.test.ts:38` calls `occupancyFinding(atlas('sheet',1,200), cfg)` live and asserts baked title === en-catalog render (line 67). Because the title is *derived* from `occ` (rules.ts:61, `pct1(occ)`) and both baked + catalog receive the same finding, a shifted `occ` keeps line 67 green (they move together). **Verified safe** — but the draft never identified that this test runs occupancy live; it only checked the literal-param assertion at line 129. With the clamp-only approach this is a non-issue entirely.

### M3 — Effort under-estimate. T5 is not "update one number," it's reconcile 5 goldens + re-justify calibration.
The draft's T5 acceptance says "any changed golden `occupancy` value is the corrected one." But `tp-array-oversize` going 0.86→0.94 isn't *more* correct — it's the grid coarsening. Committing it as "the corrected value" is misleading and pollutes the calibration baseline (`occupancy.warn` was "calibrated on real packed exports: median 0.92", config.ts:6 — the grid would shift that median up). This is a calibration change masquerading as a determinism fix.

---

## What survives

The **clamp + the two guards** are correct, minimal, and fully discharge the brief:
- `Math.min(1, Σframe/total)` in `occupancyValue` — kills every >1 / impossible verdict.
- `Math.max(0, 1-occ)` in `occupancyFinding` — kills negative wasted.
- `occupancyValue` clamp automatically fixes the `atlasMergeFinding` filter (line 139) and `atlasDispersion` (folder.ts:17 already guards).
- Goldens stay **byte-identical** (clamp is a no-op for all values ≤1, which is all 6). i18n drift guard stays green. Budget tests (hand-built fixture, occupancy:0.4) unaffected.

The grid-`coveredArea` rewrite, the `atlasMergeFinding.usedArea` change, and golden reconciliation are **DROPPED** as net-negative.

---

# REVISED MINI-DESIGN — Clamp `occupancyValue` to ≤ 100% (minimal, honest, zero-golden-churn)

## 1. Scope
1. Clamp `occupancyValue` to `[0,1]` — the brief's literal ask; eliminates every verified impossibility (130% packed, negative wasted feeding it).
2. Guard `occupancyFinding`: `wasted = Math.max(0, 1-occ)` — belt-and-suspenders for hand-built atlases in tests.
3. Add unit tests proving aliased frames can't push occ>1 and wasted can't go negative.
4. **No** grid/`coveredArea` rewrite. **No** `atlasMergeFinding.usedArea` change. **No** golden edits (clamp is a no-op for all current values).

Out of scope (with justification, not silent): grid-derived occupancy (B1/B2 — coarser & less honest for non-aliased atlases, breaks 5 goldens, shifts calibration baseline); `usedArea` rewrite (M1 — inflates `minAtlases`, suppresses merges).

## 2. Contract / type additions
**None.** `AssetMetrics.occupancy` is already typed/documented "0..1" (core/index.ts:319-320). We make the implementation honor the existing contract. No `core`, catalog, or protocol change → no cross-package sign-off needed.

## 3. Implementation

**3a. `packages/analysis/src/rules.ts:32-36`:**
```ts
export function occupancyValue(atlas: Atlas): number {
  const total = atlas.size.w * atlas.size.h;
  if (total <= 0) return 0;
  const sum = atlas.sprites.reduce((s, sp) => s + sp.frame.w * sp.frame.h, 0);
  return Math.min(1, sum / total); // clamp: aliased frames / shared Spine regions double-count Σ; cap at 100%
}
```
Keeps the exact frame-area sum (the most accurate measure for the non-aliased common case) and only caps the pathological aliased over-count. For an aliased sheet this reads 1.0 ("fully packed") — honest *enough* (it IS densely packed) and never impossible.

**3b. `packages/analysis/src/rules.ts:47`:**
```ts
const wasted = Math.max(0, 1 - occ);
```
No-op now that occ≤1; robust to any future hand-built caller.

## 4. Worker / UI / i18n
**None.** FilmViewer (FilmViewer.tsx:87) gets honest [0,1]; render path params unchanged and now in-range; drift guard (render.test.ts:67) stays green (clamp no-op on its 200/1024 atlas which is <1).

## 5. Determinism
Pure integer arithmetic + `Math.min/max`. **All 6 goldens byte-identical** (every current value ≤1 → clamp inert), confirmed by computation above. Finding signatures unchanged.

## 6. Invariant compliance
- Inv. 3: still pure measurement; clamping a double-count is *more* honest, generates nothing. (Critically, we do NOT adopt the grid, which would *reduce* honesty per B2.)
- Inv. 1/2/4/5: pure CPU, no deps, no network, negligible cost, VRAM untouched.

## 7. Test plan (`packages/analysis/test/analysis.test.ts`, reuse `atlasOf` at line 420)
1. `occupancyValue: two identical aliased 20×20 frames in 40×40 → === 1` (Σ=800/1600=0.5 → wait: two 20×20 = 800/1600=0.5; for >1 use frames that sum past total). **Corrected:** two identical 30×30 frames in 40×40 → Σ=1800/1600=1.125 → asserts `=== 1` (clamp fires).
2. `occupancyValue: non-aliased single 20×20 in 40×40 → === 0.25` (no regression; clamp inert).
3. `occupancyValue: degenerate size 0 → 0`.
4. `occupancyFinding: wasted never negative` — pass a hand-built occ>1-style atlas (frames summing past total); assert `params.wasted >= 0` and title contains no `-`.
5. **Golden guard:** assert the 6 existing fixtures' occupancy values are unchanged (implicitly covered by the existing golden suite staying green — explicitly note it in the commit).

## 8. Edge cases
| case | behavior |
|---|---|
| size 0 | `return 0` (unchanged guard) |
| empty sprites | Σ=0 → 0 |
| aliased frames summing >total | `Math.min(1,…)` → 1.0 |
| partial overlap summing >total | clamped to 1.0 (slight over-read, never impossible — acceptable; the exact union would need the grid, which B1/B2 reject) |
| hand-built >1 atlas in `occupancyFinding` | `Math.max(0,…)` → wasted ≥ 0 |

**Known residual (disclosed, not hidden):** a *partially*-overlapping aliased sheet whose Σ exceeds total but whose true union is <1 will read 1.0 (slightly high) instead of its exact union fill. This is strictly better than today (>1 impossible) and avoids the grid's *systematic* over-claim on every normal atlas. If a real export ever shows this matters, revisit with a shared-grid refactor (would touch analyze.ts plumbing — separate, larger change, not justified by current evidence).

## 9. ORDERED TASK BREAKDOWN

| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|------------|
| **T1** | Clamp `occupancyValue` to ≤1 | `packages/analysis/src/rules.ts:32-36` | pure/analysis | — | `Math.min(1, Σ/total)`; aliased-over-sum atlas → `=== 1`; non-aliased `0.25` case unchanged; size 0 → 0. |
| **T2** | Guard `wasted` ≥ 0 in `occupancyFinding` | `packages/analysis/src/rules.ts:47` | pure/analysis | — (do with T1) | `Math.max(0, 1-occ)`; hand-built >1 atlas → `params.wasted ≥ 0`, title has no `-`. |
| **T3** | Unit tests (clamp + guard) | `packages/analysis/test/analysis.test.ts` (reuse `atlasOf:420`) | test | T1,T2 | Plan #1-#4 green. |
| **T4** | Confirm zero golden churn + drift guard | run `pnpm --filter @asset-doctor/analysis test` + `@asset-doctor/i18n test` | verify | T1,T2 | All 6 goldens byte-identical (no expected.json edits); i18n render.test green; note "occupancy goldens unchanged (clamp inert)" in commit. |
| **T5** | `check-invariants` + full `pnpm test`/`typecheck`/`lint` | — | verify | T1-T4 | All invariant checks pass; no deps; suite green. |

**Suggested commit (one meaning):** `fix(analysis): clamp occupancyValue ≤ 100% + guard non-negative wasted (aliased frames double-count Σ)`.

**Key paths:** `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/rules.ts` (occupancyValue:32-36, wasted:47); `/home/nonamezzz/Рабочий стол/projects/packages/analysis/test/analysis.test.ts` (atlasOf:420, golden assertion:49); `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` (AssetMetrics.occupancy:319-320, no change); `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/render.test.ts` (drift guard:38,67 — survives unchanged); `/home/nonamezzz/Рабочий стол/projects/packages/budget/test/fixture.ts` (hand-built occupancy:0.4, unaffected).

**Verdict:** Premise TRUE; the brief's clamp is correct and shipped above. The draft's grid-`coveredArea` expansion is REJECTED — empirically it shifts 5/6 goldens by up to +7.9pp, systematically over-claims occupancy (suppressing the under-pack findings the tool exists to emit), and inflates `minAtlases` (suppressing merges). Ship the 2-line clamp+guard; drop T4(grid)/T7 of the draft.