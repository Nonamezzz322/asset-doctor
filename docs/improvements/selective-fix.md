All claims verified against the actual code. The draft is unusually accurate — line numbers, the critical Phase A cross-dependency, the `summarizeOpCounts` split logic, `buildOptions` as single source of truth, the honesty guard, and the mirror-test pattern all check out. I found a few real issues the draft missed or under-specified. Here is the final review.

---

# Selective Fix — Final Review + Revised Mini-Design

## Verdict: PREMISE TRUE. Ship it. Draft is implementation-accurate.

I verified every load-bearing claim against the code on `feat/asset-pipeline` (the active branch — the CONTEXT's "repo on branch feat/asset-pipeline" is correct; `main` is Part A only):

- `summarizeOpCounts` (op-manifest.ts:87-104) contains the repack/merge + drop/dedup split exactly as described — extracting `fixOpKind` is sound and the existing tests (`op-manifest.test.ts`) pin the behavior so the refactor is safe.
- The **critical cross-dependency is REAL and exactly located**: `fix.worker.ts:490` `const transcoded = op?.kind === 'transcode';` feeds `predictOwnerFinalNames`; the keep-on-divergence is at `1167` (`actual.image !== predicted.image`). Excluding `transcode` while keeping `dedup` WILL silently degrade dedup to keep-consumer unless `transcoded` is masked. The §4d fix (`&& runs(op)`) is correct and necessary.
- `buildOptions()` (App.tsx:786) is genuinely the single source for both `mode:'plan'` and `mode:'execute'` — forwarding `excludeKinds` there is sufficient.
- The honesty guard (`op-manifest.test.ts:178`, `plan-worker.test.ts:356`) pins summary keys to exactly `['hasDeferredChecks','opCounts','referencesChanged','skipped','totalOps']`. Adding no new summary field keeps both green. Confirmed.
- `planFix` terminates its worker on resolve (fix-client.ts:59) — the rapid-toggle path is leak-free.

But the draft has **real gaps**. Blockers/majors below.

---

## BLOCKERS

### B1. Re-preview effect collides with the stale-plan reset — the proposed wiring will infinite-flicker or reset out of `plan`.
The draft (§5c) adds `useEffect(() => { if (phase.t === 'plan') void preview(); }, [excludeKinds])`. But `preview()` calls `setPhase({t:'planning'})` then `{t:'plan'}`. The existing stale-plan effect (App.tsx:846-848) fires `setPhase({t:'idle'})` whenever its deps change AND `sawPlan.current` is true. `excludeKinds` is **not** in that dep array (good), so it won't directly trip it — but the `sawPlan` ref (line 850) is set from `phase.t==='plan'`. Sequence on a toggle: effect sees `phase.t==='plan'` → `preview()` → `setPhase('planning')` (sawPlan ref still true from prior render) → `setPhase('plan')`. No reset is triggered by `excludeKinds` itself, so this is survivable — BUT the draft's effect has `phase.t` read inside while omitting it from deps with an eslint-disable. That's fragile: after `preview()` flips to `'planning'` then back to `'plan'`, the effect does NOT re-run (deps unchanged), so it's stable. **However**, if the user toggles a checkbox while `phase.t==='planning'` (mid-flight), the guard `phase.t==='plan'` is false and the toggle is silently dropped — the displayed plan then mismatches the selection until the next toggle.
**Resolution (REQUIRED):** drive the re-preview off an explicit handler, not a `phase`-guarded effect. In `togglePlanKind`, compute the next set and call `preview(nextExclude)` directly (pass the set as an argument so it doesn't depend on async state batching). Make `preview(over?: Set<OpKind>)` accept an override and have `buildOptions(over)` read it. This removes the effect, the eslint-disable, and the mid-flight-drop bug. Concretely:
```ts
function togglePlanKind(kind: OpKind) {
  setExcludeKinds((prev) => {
    const next = new Set(prev); next.has(kind) ? next.delete(kind) : next.add(kind);
    void preview(next);   // re-preview with the explicit next set — no batching dependency
    return next;
  });
}
// buildOptions(over?: Set<OpKind>) uses (over ?? excludeKinds); preview(over) forwards it.
```
This also fixes §9.8's race more cleanly: each toggle starts exactly one `planFix`; a stale resolve still calls `setPhase({t:'plan'})` last-write-wins, acceptable. (Optional 150ms debounce stays optional.)

### B2. The plan mirror (`plan-worker.test.ts`) is a HAND-MAINTAINED reimplementation, not auto-tracking — T3 must edit it, and the design must say so explicitly.
The draft's §4b changes the *worker* plan block to filter `planRun`/`countedOps`. But `assemblePlanGate` (plan-worker.test.ts:147-268) is a verbatim hand-copy of that block. If S4 edits the worker but S9's T3 only "adds `excludeKinds` to the mirror," the two can silently diverge and the test passes against a stale mirror. **Resolution:** T3's acceptance MUST be "the mirror gains the IDENTICAL `runs`/`tierExcluded`/`planRun`/`countedOps` edits AND a new assertion that, for `excludeKinds=undefined`, `assemblePlanGate` output is byte-identical to pre-change (regression-pins the additive default)." Add that no-mask regression case explicitly — it's the cheapest guard that the refactor didn't perturb today's path.

---

## MAJORS

### M1. Progress counter drifts when ops are excluded (cosmetic, but visible). 
`total = plan.ops.length + 1` (fix.worker.ts:634) is computed BEFORE the exclusion filter; the draft inserts `if (!runs(op)) continue;` at line 648 *before* `done++` at 650. Result: a run that excludes N ops shows progress maxing at `(total-1-N)/total` then jumps to `total-1/total` at the zip step — the bar visibly never fills mid-run. **Resolution:** compute `total = plan.ops.filter(runs).length + 1` (and gate the tier multiplier's contribution if you count tier in total — currently tier isn't in `total`, so just the filtered ops + 1). One-line fix; do it in S5.

### M2. `excludeKinds` MUST be added to the stale-plan reset dep array — or it's stale across the Back→options→re-preview cycle.
The draft (§5a) says "extend its dependency array to include nothing new (selection is intra-plan)" and resets selection on a fresh plan via `setExcludeKinds(new Set())` in `preview()`. But `preview()` runs on the INITIAL preview too, so every fresh preview correctly clears selection — good. The risk: if the user is in `plan` with a selection, hits **Back** (→`idle`), changes an option, and re-previews, `preview()` clears the set (line in §5a) — fine. So M2 is actually a NON-issue *provided* the `setExcludeKinds(new Set())` is placed in `preview()` and runs on every entry. **Confirm it is unconditional in `preview()`, not only on the first preview.** (Draft §5a places it at "the `phase.t==='plan'` transition in `preview()`" — correct. Keep it there; do not also reset inside `togglePlanKind`.)

### M3. The "deselected-kind skip" push is duplicated verbatim in TWO places (plan block §4b + execute §4c.4) — extract it.
Both the plan short-circuit and the execute path push the same `OP_KIND_ORDER`-ordered `(deselected)` notes with identical `wouldRunByKind` logic. Copy-paste of a 6-line loop across a 1000-line gap WILL drift (one of the prior op-manifest comments literally exists to prevent exactly this class of drift). **Resolution:** add a tiny pure helper in `op-manifest.ts`:
```ts
/** Honest skip notes for kinds the user deselected that WOULD have run. Deterministic (OP_KIND_ORDER). */
export function deselectedSkips(excluded: ReadonlySet<OpKind>, wouldRunByKind: ReadonlySet<OpKind>):
  { assetRef: string; reason: string }[] {
  const out = [];
  for (const k of OP_KIND_ORDER)
    if (excluded.has(k) && wouldRunByKind.has(k)) out.push({ assetRef: '(deselected)', reason: `${k} skipped: deselected in plan` });
  return out;
}
```
Caller builds `wouldRunByKind` (including the `tier` special-case: `tieringOn && !folderAlreadyTiered`). Now plan and receipt provably share the skip text. Pure, testable (folds into T1/T2).

### M4. Reset-to-`idle` on toggle is the WRONG model — but the draft never reconciles it with re-preview. 
Today, ANY option change → `idle` (you must click Preview again). The draft's feature instead re-previews IN PLACE on toggle. That's the right UX, but it means checkboxes are the ONE option-like control that does NOT reset to idle. The design must state this exception clearly so the implementer doesn't "helpfully" add `excludeKinds` to line 848's dep array (which would reset to idle on every toggle and break the feature). **Resolution:** add an explicit one-line invariant to §5: "`excludeKinds` is deliberately ABSENT from the stale-plan reset deps (848); it re-previews in place via `togglePlanKind`, it does not invalidate the plan."

---

## MINORS / NITS

- **N1.** Type-only cycle (`fix-protocol` ↔ `op-manifest`): the draft's analysis is correct (both `import type` ⇒ erased ⇒ no runtime cycle). But `verbatimModuleSyntax`/`isolatedModules` (common in Vite TS) can still warn on type-only re-exports. Lowest-risk path = the draft's fallback (move `OpKind`/`REFERENCE_CHANGING`/`OP_KIND_ORDER` into `fix-protocol.ts`, re-export from `op-manifest.ts`). Given `op-manifest.ts` is the documented owner of the vocabulary, I'd KEEP it there and accept the type-only import — but run `pnpm typecheck` in S2 as the gate (already in acceptance). Fine as-is.
- **N2.** §5d "all deselected → byte-identical pass-through": confirm the worker doesn't crash on an empty `out[]` when everything is excluded. The execute path still emits pass-through files (un-transformed inputs are copied), so a zero-op run yields the original folder zipped — verify the zip step tolerates zero `replaced`/`dropped`. Add to S5 acceptance: "all-excluded ⇒ valid zip == input." 
- **N3.** Optional `fix.plan.selectHint` caption — if added, all 9 catalogs or `catalogs.test.ts` fails. Keep it OPTIONAL/deferred to avoid a 9-file diff for v1; the checkboxes are self-explanatory.
- **N4.** Struck-through deselected counts (§5c) are good, but ensure the `referencesChanged` banner and skip `<details>` reflect the RE-PREVIEWED summary (they will, since they read `phase.summary` which re-preview replaces). No action — just don't compute any count client-side (the draft correctly rejected the client-recompute alternative).

---

## What I did NOT find (rebuttals to potential concerns)
- No other op reads another op's kind besides Phase A's transcode lookup — verified by grep; `pack` reads `op.group`, `tier` reads the post-run `tierTransformed`/`dropped`/`replaced` sets. The draft's claim holds.
- `tier` forcing `referencesChanged`: line 410 gates on `tierAssets > 0`, so excluding tier (→ `tierAssets=0`) correctly drops the refs-flag. Verified.
- Determinism: `excludeKinds`→`Set`, `fixOpKind` total/pure, skip notes in `OP_KIND_ORDER`. Sound.

---

## REVISED ORDERED TASK BREAKDOWN

| id | title | files | tag | deps | acceptance |
|---|---|---|---|---|---|
| **S1** | Extract `fixOpKind` + `deselectedSkips` pure helpers; route `summarizeOpCounts` through `fixOpKind` (M3) | `apps/web/src/lib/op-manifest.ts` | core/pure | — | `fixOpKind` total/exported; `deselectedSkips` deterministic (OP_KIND_ORDER); `summarizeOpCounts` output unchanged; **T1** green; existing op-manifest tests green. |
| **S2** | Add `excludeKinds?: OpKind[]` to `FixOptions`; import `OpKind` (type-only); document additive-default | `apps/web/src/worker/fix-protocol.ts` | contract | S1 | `pnpm typecheck` green (no `verbatimModuleSyntax` error); field absent ⇒ byte-identical contract. |
| **S3** | Worker: define `excluded`/`runs`/`tierExcluded` after `plan`; **mask Phase-A `transcoded` with `runs(op)`** (the B-class cross-dep, line 490) | `apps/web/src/worker/fix.worker.ts` | worker | S1,S2 | `transcoded = op?.kind==='transcode' && runs(op)`; **T4** green (dedup keeps working when transcode excluded — no diverged-keep). |
| **S4** | Worker plan short-circuit: filter `planRun`/`countedOps`, gate tier count with `!tierExcluded`, append `deselectedSkips(...)` | `apps/web/src/worker/fix.worker.ts` | worker | S3 | re-preview masked `opCounts`/`referencesChanged`/`skipped`; honesty keys unchanged (**T5**); **T3** green. |
| **S5** | Worker execute: `if(!runs(op)) continue` (main loop); filter `dedupDrops` with `.filter(runs)`; gate tier loop `!tierExcluded`; **`total = plan.ops.filter(runs).length+1` (M1)**; append `deselectedSkips`; verify all-excluded ⇒ valid pass-through zip (N2) | `apps/web/src/worker/fix.worker.ts` | worker | S3 | excluded kinds never compose/encode; progress fills to 100%; `excludeKinds` absent ⇒ byte-identical (existing tier/dedup/extrude worker tests green). |
| **S6** | UI: `excludeKinds` state; reset unconditionally in `preview()` (M2); `buildOptions(over?)` + `preview(over?)` forward the set; **`excludeKinds` NOT in stale-plan deps (M4)** | `apps/web/src/App.tsx` | ui | S2 | toggling does not reset to idle; Run sends the same mask `buildOptions()` previewed. |
| **S7** | UI: `PlanCard` checkboxes (default on; ref-changing warn color; struck-through deselected counts); `togglePlanKind` calls `preview(next)` directly — NO `phase`-guarded effect (B1) | `apps/web/src/App.tsx` | ui | S6 | each `opCounts` row is a checkbox; toggle re-previews in place (counts/refs/skips update); mid-flight toggle not dropped; Run commits the subset. |
| **S8** | Tests: T1–T5 + no-mask regression pin (B2) + determinism | `apps/web/src/lib/op-manifest.test.ts`, `apps/web/test/plan-worker.test.ts` (+ `runs`/`tierExcluded`/`deselectedSkips` mirror edits), `apps/web/test/selective-worker.test.ts` (NEW) | test | S1–S5 | mirror edited IDENTICALLY to worker; `excludeKinds:undefined` ⇒ `assemblePlanGate` output equals pre-change; `pnpm test`+`typecheck`+`lint` green. |
| **S9** | (optional, deferred) i18n `fix.plan.selectHint` across all 9 catalogs (N3) | `packages/i18n/src/catalogs/*.json` | i18n | S7 | **T6/T7** green token-free, all 9 locales — OR skip (no caption). |

**Load-bearing facts for the implementer (verified against code):**
1. The op→kind split lives ONLY in `summarizeOpCounts` (op-manifest.ts:90-99); extract `fixOpKind` so the filter and tally can't drift.
2. The ONE cross-op dependency is Phase A's transcode prediction at **fix.worker.ts:490** — mask it with `runs(op)` or `dedup` silently degrades when `transcode` is unchecked (keep at 1167).
3. `buildOptions()` (App.tsx:786) feeds BOTH plan and execute — forward `excludeKinds` there once.
4. The plan mirror `assemblePlanGate` (plan-worker.test.ts:147) is a hand-copy of the worker plan block (fix.worker.ts:314-414); any worker edit MUST be mirrored or the test guards nothing.
5. `total` (fix.worker.ts:634) is pre-filter — recompute it post-filter so the progress bar fills.
6. `tier` is a worker multiplier, never a `FixOp` (core/index.ts:332-366 has no `tier` kind) — gate via `tierExcluded`, never `runs`.
7. Do NOT add `excludeKinds` to the stale-plan reset deps (App.tsx:848) — it re-previews in place.