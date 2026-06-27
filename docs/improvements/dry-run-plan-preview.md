Confirmed: the drift test enforces (a) identical key sets across all 9 locales, (b) plural objects must have `other`, (c) placeholder-token equality per key. The draft's i18n discipline is correct.

I have verified every load-bearing claim against source. Here is the adversarial review and revised design.

---

# Adversarial Review + Revised Mini-Design: Dry-Run Plan Preview Before Commit

## Verdict: premise is TRUE, design is SOUND, ship it — with corrections

The premise holds. There is genuinely no plan/preview/mode concept today (`FixRequest = { type, files, options }`, fix-protocol.ts:79; FixCard jumps straight from `pro.cta` button → `run()` → execute + auto-download, App.tsx:838-845/735). The user-value is real (a reference-changing destructive fix with no preview is a UX hazard) and it sits squarely on a prior-round runner-up. Effort is **modest** because — verified — every input the plan needs is already computed before the pixel loop. This is a high-value/low-effort win. Proceed.

But the draft has **3 factual errors** and **2 honesty gaps** that must be fixed, plus its line numbers are stale (correct ones below). None are fatal; all are addressed in the revision.

### Blockers (must fix)

**B1 — Fabricated stale-invalidation dependency list (§8.3/§9).** The draft's `useEffect` deps include `tierForce`, `skinGuard`, `packForced`, `skinGuard` rows. **Verified false:** `skinGuard` is a `const = {}` (App.tsx:675), and `tierForce`/`packForced` are not FixCard state at all. Using them would not compile. The **actual** live state set (App.tsx:666-696) is exactly: `aggressive, polygon, marking, effort, scaleAwareQ, webpNearLossless, pngRecompress, overrides, packLoose, packMode, packGranularity, packTrim, tierEnable, tierSuffixes`. Also `overrides` is typed `{match,quality}[]`, not `FixOverride[]`.

**B2 — "summarizePlan consumes only web-local types" is wrong (§3).** `FixOp`/`FixPlan` live in `packages/core` (core/index.ts:332/362), not web-local. This does not break the *placement decision* (op-manifest.ts is still the right home, since it owns the `OpKind` vocabulary and the function also folds in worker-side gate facts) — but the justification "depends on web-app-local types" is false. Correct rationale: it depends on a **core type (`FixOp`) plus worker-side gate facts**, and shares the `OpKind` vocab already in op-manifest.ts. Keep the placement; fix the reasoning.

**B3 — "groupOps groups FixOp[]" is wrong (§3/§9).** `groupOps` parses **free-text operation strings** (`operations: readonly string[]`, op-manifest.ts:40), classifying by leading token. The plan, however, has the structured `FixOp[]` — it does NOT have the rendered op strings yet (those are built inside the execute pixel loop). So `summarizePlan` must tally **structured `FixOp[]`**, and the separate `PlanCounts` component (the draft's own decision) is therefore correct and *necessary* — there is no way to feed plan ops through `groupOps`. Reframe: the Plan card reuses the `OpKind` *vocabulary* and the `fix.op.<kind>` i18n labels, not the `groupOps` string parser.

### Majors

**M1 — i18n key set is partly redundant; reuse existing op labels.** Verified: `fix.op.repack/merge/pack/dedup/resize/transcode/drop/tier` and `fix.skipped.title` already exist (en.json:128-141). `PlanCounts` should render `t('fix.op.<kind>')` for the per-kind labels — do NOT add new per-kind plan keys. Only these are genuinely new: `fix.plan.cta`, `fix.plan.run`, `fix.plan.back`, `fix.plan.title`, `fix.plan.empty`, `fix.plan.deferredNote`. The draft's `fix.plan.skipped` is also redundant — reuse `fix.skipped.title`. Net new keys: **6**.

**M2 — `referencesChanged` PNG-fallback over-claim needs a louder honesty note (§5).** The conservative-true is correct (better to warn "may change" than to under-claim), but the deferred note must explicitly say the references flag is a *prediction* that can resolve drop-in. Folded into `fix.plan.deferredNote`.

**M3 — `tierAssets` is an upper-bound floor, and the card must not present it as exact.** Verified: the tier loop has execute-only exits AFTER the pixel-free gates — `composeFailed` (pixel) and the `replaced.has/dropped.has` guard (execute state, line 1058). So `countTierEligible` can over-count vs what actually emits. The draft says "cannot over-count" — **that is wrong** for the compose-failure case. Mitigation: keep it, but the tier line in the plan must read as "up to N" and be covered by the deferred-checks note (it already implies tiering may be refused at pixel time). Honest framing, not a faked number.

### Minors (accept as-is)
- The `aggressive ⇒ run computeFeatures in plan mode` decision is honest and bounded (it is pre-loop cost the execute path already pays, lines 172/180). Accept.
- Determinism analysis is correct.
- Separate `planFixRun` client fn over a union return: accept (keeps `runFix` outcome clean).

### Corrected line numbers (use these)
`planFix` call: fix.worker.ts **236–253** (plan resolved by 253). Pixel loop: **457**. Pixel-free gates all set before 457: `computeFeatures` **172**, `buildDedupGroups` **180**, `packCollisionSkips` populated by **201**, `folderAlreadyTiered` **216**, `tierRefusal` **222**, `tierEligible` **234**. Insert the early return **after 253** (post-`planFix`), before line 255. App.tsx: `FixPhase` **311-315**; FixCard state **665-702**; hardcoded base options inline in `run()` **741-745**; Pro CTA **838-845**; `Receipt` **854**; `OpManifest` **976**; skipped `<details>` **951-964**; mergeWarn banner **878**.

---

## Revised V1 Scope (unchanged intent, corrected facts)

**In:** `mode?: 'plan'|'execute'` on `FixRequest` (default execute, byte-identical). Plan mode runs parse+analyze+planFix + pixel-free gates + (aggressive only) `computeFeatures`/`buildDedupGroups`, posts a new `fix-plan` response, STOPS before line 457. Payload: op counts by kind, pixel-free would-be-skips, `referencesChanged` prediction, `hasDeferredChecks: true`. New Plan card with a `PlanCounts` component (reuses `fix.op.<kind>` labels + `REFERENCE_CHANGING` coloring) and a prominent "Run fix" button re-posting `mode:'execute'` with identical options. 6 new i18n keys × 9 locales.

**Out (honest):** no byte/VRAM numbers in plan (counts only — invariant 5); no pixel-dependent skips predicted (polygon-no-win, transparent-decoy, dHash near-dup, codec-unavailable, sheet-unavailable, name-collision-after-pack, tier compose-fail) — disclosed in `fix.plan.deferredNote`; no selective fix / no before-after diff / no loader-migration. `tierAssets` is an **upper-bound** ("up to N"), not exact.

## Contract additions (additive, no core change)
`fix-protocol.ts`: add `FixMode`, `mode?: FixMode` to `FixRequest`, `PlanOpCounts`, `FixPlanSummary` (no disk/VRAM field — honesty guard), and `{ type:'fix-plan'; summary }` to `FixResponse`. Counting rules tally **structured `FixOp[]`**: `repack` with `atlasRefs.length===1` → repack, `>1` → merge; `drop` with `ownerRef!=null` → dedup, else drop; `resize/transcode/pack` literal; `tier` is not a FixOp → `counts.tier = tierAssets`; omit zero keys; `totalOps = Σ`.

## Pure module
`summarizePlan(g: PlanGateInputs): FixPlanSummary` in **op-manifest.ts** (rationale corrected per B2): consumes a core `FixOp[]` + worker gate facts (`dedupConsumers`, `tierAssets`, `skipped`, `referencesChanged`); shares the `OpKind`/`REFERENCE_CHANGING` vocab; pure, same-input⇒deep-equal. NOT in `packages/fix` (depends on worker gate facts, not just the plan).

## Worker
Thread `mode` through `onmessage` (`e.data.mode ?? 'execute'`) and `runFix(files, opts, mode)`. After line 253, before 255: if `mode==='plan'`, assemble `collectPlanSkips()` (folder-already-tiered, dedup×tier, per-`merged` `tierRefusal`, `packCollisionSkips` — all pixel-free, fixed deterministic order), `countTierEligible()` (upper-bound: `tierRefusal===null` ∧ not in plan-predicted-transformed ∧ not plan-dropped/replaced — derived from plan ops, no pixels), `predictReferencesChanged(...)`, `dedupConsumers = Σ dedupGroups[].consumers.length`, then `post({type:'fix-plan', summary})` and `return`. Execute path (default) untouched ⇒ regression-covered by tier-worker.test.ts / dedup-worker-phase-c.test.ts.

## `referencesChanged` prediction (honest, conservative-true)
True if any plan op is merge / pack / dedup(ownerRef) / legacy drop; OR tiering on with `tierAssets>0`; OR any resize/transcode on a LOOSE image whose emitted ext (`renamedTo(path, EXT[targetMime])`) differs from source. PNG-fallback may make it drop-in after all → this is a **prediction**, disclosed in `fix.plan.deferredNote`. Atlas repack keeping format+name → not reference-changing.

## UI (`App.tsx` FixCard)
Extend `FixPhase` (line 311): `+ { t:'planning' } | { t:'plan'; summary }`. Extract the inline base options (741-745) + all toggles into one `buildOptions()` so preview and execute share ONE source. The `pro.cta` button (844) becomes `t('fix.plan.cta')` ("Preview plan") → `preview()` → `planFixRun(files, buildOptions())` → `{t:'plan',summary}`. Plan card: `t('fix.plan.title',{n:totalOps})` headline; `PlanCounts` iterating `OP_KIND_ORDER`+tier, `t('fix.op.<kind>') · count` per non-zero kind, ref-changing kinds in `text-warn`; reuse the mergeWarn banner (878) when `referencesChanged`; reuse the skipped `<details>` block (951-964) for pixel-free skips; `t('fix.plan.deferredNote')` note; CTA-green **"Run fix"** (`fix.plan.run`) → existing `run()` (auto-downloads on `fix-done`); secondary "Back" (`fix.plan.back`) → `{t:'idle'}`.

**Stale-plan invalidation (CORRECTED deps):**
```ts
useEffect(() => { if (phase.t === 'plan') setPhase({ t: 'idle' }); },
  [aggressive, polygon, marking, effort, scaleAwareQ, webpNearLossless,
   pngRecompress, overrides, packLoose, packMode, packGranularity, packTrim,
   tierEnable, tierSuffixes]);
```
(Exactly the live FixCard state — no `tierForce`/`skinGuard`/`packForced`, which don't exist as state.)

## Client
`planFixRun(files, options): Promise<FixPlanSummary>` in fix-client.ts — same Worker spawn as `runFix`, `postMessage({type:'fix', files, options, mode:'plan'})`, resolves on `fix-plan`, rejects on `fix-error`, terminates. `runFix` unchanged.

## i18n (6 NEW keys × 9 locales; reuse existing `fix.op.*` + `fix.skipped.title`)
`fix.plan.cta`, `fix.plan.run`, `fix.plan.back`, `fix.plan.empty`, `fix.plan.deferredNote`, and plural `fix.plan.title` (`{ $count:"n", one:"{n} operation planned", other:"{n} operations planned" }`). Drift test (catalogs.test.ts:20/25/27) enforces identical keys + plural-`other` + token equality across all 9.

## Honesty / invariants
Inv 1: plan does strictly less, bytes never leave (stronger). Inv 3: plan generates nothing — reports the already-computed plan. Inv 4: plan is faster than execute (no compose/encode/zip). Inv 5: **zero byte/VRAM numbers** — counts only, the central guarantee. Deferred disclosure: `hasDeferredChecks:true` + note covers pixel-dependent skips, the refs-flag prediction caveat, AND the tier "up to N" upper-bound.

## Edge cases (additions vs draft)
Empty plan → `fix.plan.empty` + any pixel-free skips; Run still works (pass-through zip). Compose-failure tier over-count → covered by "up to N" + deferred note (M3). Toggle change after preview → invalidation effect resets to options view. Plan-mode worker error → reuse `{t:'error'}`.

## Test plan
T1 `summarizePlan` tally over **structured FixOp[]** (repack/merge split by `atlasRefs.length`, drop/dedup by `ownerRef`, zero-keys omitted, `totalOps=Σ`, deterministic) — extend op-manifest.test.ts. T2 refs/skips/`tierAssets`→`counts.tier` passthrough. T3 new `apps/web/test/plan-worker.test.ts` mirroring tier-worker harness: drive pure pipeline over a fixture, build the gate inputs the worker would, `summarizePlan`, assert counts == ops the execute path would run; assert NO pixel-dependent skip in plan skips. T4 `predictReferencesChanged` (merge/pack/dedup/tier⇒true; pure same-format atlas repack⇒false; loose png→webp⇒true conservative). T5 honesty guard: no disk/VRAM numeric field on `FixPlanSummary` (type + runtime). T6 catalogs drift (auto, 9 locales). T7 i18n-app-keys (auto). T8 execute unchanged (existing tier-worker / dedup-phase-c). + `pnpm typecheck && lint`.

---

## Ordered Task Breakdown (revised)

| id | title | files | deps | acceptance |
|---|---|---|---|---|
| **T-1** | Add `FixMode`, `mode?` on `FixRequest`, `PlanOpCounts`, `FixPlanSummary` (no disk/VRAM field), `fix-plan` response | fix-protocol.ts | — | compiles; `mode` optional⇒execute; no core change |
| **T-2** | Pure `summarizePlan(PlanGateInputs)` tallying **structured FixOp[]** (repack/merge & drop/dedup splits; tier=tierAssets; omit-zero) | op-manifest.ts | T-1 | splits correct; deterministic |
| **T-3** | `summarizePlan` unit tests (T1/T2/T5) | op-manifest.test.ts | T-2 | green |
| **T-4** | Worker: thread `mode`; `collectPlanSkips`/`countTierEligible`(upper-bound)/`predictReferencesChanged`; early `fix-plan` return after line 253 | fix.worker.ts | T-1,T-2 | plan posts `fix-plan` & STOPS (no encode/zip); execute byte-identical; reuses existing gates |
| **T-5** | Client `planFixRun(files, options): Promise<FixPlanSummary>` | fix-client.ts | T-1 | resolves on `fix-plan`, rejects on error, terminates |
| **T-6** | Node plan-mode test (mirror tier-worker harness; assert counts==would-run ops; no pixel-skip in plan) | apps/web/test/plan-worker.test.ts | T-4,T-2 | T3/T4 green |
| **T-7** | i18n: 6 new `fix.plan.*` keys → en + 8 locales (reuse `fix.op.*`/`fix.skipped.title`) | catalogs/*.json | T-1 | drift test green ×9 |
| **T-8** | FixCard: `buildOptions()` extract (incl. inline base 741-745); `preview()`; `FixPhase`+= planning/plan; Plan card (`PlanCounts` + reused mergeWarn/skipped blocks + deferredNote); Run/Back; **corrected** stale-plan effect | App.tsx | T-5,T-7,T-2 | preview→plan→Run executes identical options + auto-download; toggle change resets to options; app-keys test green |
| **T-9** | Verify `pnpm typecheck && lint && test`; smoke preview-then-run on a fixture | — | T-1…T-8 | all green; plan = real counts, zero byte/VRAM numbers; execute unchanged |

## Key files (absolute)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` (FixRequest:79, FixResponse:128)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` (insert after planFix at 253, before pixel loop 457; gates 172/180/201/216/222/234)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/op-manifest.ts` (OpKind/REFERENCE_CHANGING/OP_KIND_ORDER:7-13; add summarizePlan)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/fix-client.ts` (runFix:20; add planFixRun)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` (FixPhase:311; FixCard state 665-702; run() base opts 741-745; CTA 844; Receipt 854; OpManifest 976; skipped 951-964; mergeWarn 878)
- `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` (FixOp:332, FixPlan:362 — the structured type summarizePlan tallies)
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json` (existing fix.op.* :133-141)
- Harnesses to mirror: `/home/nonamezzz/Рабочий стол/projects/apps/web/test/tier-worker.test.ts`, `.../dedup-worker-phase-c.test.ts`, `.../i18n-app-keys.test.ts`, `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/catalogs.test.ts`

**Net assessment:** premise true, design ships. The corrected facts (B1 dep list, B2 core-type rationale, B3 groupOps-parses-strings, M1 reuse existing op labels → 6 new keys not 7+, M3 tierAssets upper-bound) are folded in. No invariant violations, no core contract change, no determinism risk, no faked savings.