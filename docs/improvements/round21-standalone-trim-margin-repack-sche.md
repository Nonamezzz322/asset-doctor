All the App.tsx / fix-protocol / i18n mirror points the draft cites are accurate (frameRedundancy at App.tsx:535-536, 552-553, 596-598, 1278, 1498, 1643; fix-protocol:127; en.json:431-432). Those parts of the draft are correct.

Now I have everything. The draft has one BLOCKER (the missing frameTrims plumbing in the fix worker — the feature is a production no-op without it) plus a few minor corrections. The feature is salvageable: the fix is well-bounded (the analyze worker already has the exact code). Let me write the revised mini-design.

---

# Mini-Design (REVISED): Standalone trim-margin → repack scheduling

**Verdict:** Premise is **partially false as drafted** — the headline defect is real, but the draft's "zero new worker code" claim is **wrong** and hides a **BLOCKER** that makes the feature a **production no-op**. Salvageable with one added worker change. Revised below; the ordered task breakdown is preserved and amended.

---

## BLOCKERS

### B0 — The `trim-margin` finding NEVER reaches `planFix` inside the fix worker (feature is a no-op as drafted)

The draft's entire premise — "schedule a repack on the existing `trim-margin` finding" — assumes `report.findings` inside the **fix** worker contains a `trim-margin` finding. **It does not.** There are two distinct workers with two distinct `hashAtlasFrames`:

- **`analyze.worker.ts`** (FREE diagnosis) — its `hashAtlasFrames` returns `{ hashes, bboxes }` (analyze.worker.ts:224-261) and feeds `frameTrims` into `analyze()` (line 143). Trim-margin fires here. **This is why the detector + fixture tests pass.**
- **`fix.worker.ts`** (Pro fix) — re-runs `analyze()` itself (fix.worker.ts:416-421) but its **separate** `hashAtlasFrames` (fix.worker.ts:4038-4073) returns **only `(string|null)[]` — no bboxes** — and the `analyze()` call passes `frameHashes` only, **never `frameTrims`**. So `frameTrimByRef` is empty (analyze.ts:125-126), `analyze.ts:183` skips `trimMarginFinding`, and **no `trim-margin` finding exists in the report `planFix` consumes.**

Consequence: the draft's new `else if (f.rule === 'trim-margin')` branch matches **nothing** in production. The toggle would be ON, the checkbox visible, the unit tests green (they inject `frameTrims` by hand) — and the downloaded fix would be **byte-identical to today**. This is precisely the "fixture reproduces a defect the real path can't exercise" honesty trap the review charter targets. The draft's §1 claim "Worker already builds trim arrays unconditionally — zero new pixel/compose/zip code" **conflates execute-time `buildTrimArrays` (fix.worker.ts:1404, runs during the repack loop) with diagnosis-time bbox computation (which the fix worker does NOT do).** They are different code paths; the former is downstream of an op that, as drafted, never gets emitted.

**FIX (mandatory, NEW task — see §5b):** make the fix worker compute trim bboxes in its diagnosis pass and feed them into `analyze()`, mirroring the analyze worker. The code already exists verbatim in analyze.worker.ts:224-261; the fix is to port the `{hashes,bboxes}` return + build a `frameTrims: AtlasFrameTrims[]` and pass it into the `analyze()` call. Bounded, additive, no new pure code (`alphaBBox`/`extractFrameRegions` already imported in the fix worker — fix.worker.ts:130, used at 1434/2543).

### B1 — bbox computation must run when `trimMargin` is ON even if `frameRedundancy` is OFF

The fix worker's bbox source today (the `hashAtlasFrames` loop) is gated entirely behind `if (frameRedundancyOn)` (fix.worker.ts:396). If we naively reuse that loop's output, then `frameRedundancy:false` + `trimMargin:true` would silently fire **no** trim repack (the finding wouldn't exist) — a second hidden no-op. The diagnosis pass that yields `frameTrims` must run when **`frameRedundancyOn || trimMarginOn`**, and `frameTrims` must be collected independently of whether hashes are kept. (The page decode is shared, so this is one decode either way — no extra cost when both are on.)

---

## MAJORS

### M1 — `analyze` 3rd-arg key is `bboxes`, not `frameTrims` (draft test A1 is wrong)

`AtlasFrameTrims` is `{ atlasRef, bboxes }` (core/index.ts:396-399; consumed at analyze.ts:126 `ft.bboxes`). The draft's test sketch A1 writes `frameTrims: [{ atlasRef, frameTrims: <bboxes> }]` — **wrong inner key**; it must be `frameTrims: [{ atlasRef, bboxes: [...] }]`. (The draft flagged this as "one thing to verify"; pinned here as a correction, not left open.)

### M2 — draft's "report order" double-emit justification is based on a false claim (conclusion still holds)

Draft §4b asserts "Findings iterate in report order. analyze.ts pushes occupancy (:165) … trim-margin (:186)." But `analyze.ts:251` **sorts** findings by `severity` then `id` before returning — so `planFix` iterates **sorted** order, not push order. The push-order argument is void. **The conclusion is nonetheless correct**: the shared `repacked` Set makes double-emit impossible regardless of order. Keep the Set-based guard; drop the false push-order rationale from the comment/jsdoc.

---

## MINORS / confirmations

- **Detector gate holds through the real parse.** atlas.ts:101 `trimmed = body.trimmed === true`; atlas.ts:104 `if (trimmed && sss)` — so the fixture's padded sprites (raw JSON carries a redundant `spriteSourceSize`, but `trimmed:false`) parse to `trimmed:false, spriteSourceSize:undefined`, passing both the rules.ts:317 gate and `resolveTrim`. Confirmed.
- **No-competing-repack premise holds.** A fully-packed sheet yields no occupancy/wasted finding (plan.ts:293) ⇒ no existing repack. Confirmed.
- **Execute path is real once the op is emitted.** Single-atlas repack calls `buildTrimArrays([atlas])` (fix.worker.ts:1771) → `trimOpt` → `repackAtlases({trim})`, accumulating `trimmedSpritesTotal` (2020) and surfacing it in the receipt (3718). Confirmed — so once B0/B1 emit the op, the trim genuinely realizes.
- **All App.tsx / fix-protocol / i18n mirror points are accurate** (App.tsx:535-536, 552-553, 596-598, 1278, 1498, 1643; fix-protocol.ts:127; en.json:431-432). The §6/§3b plan is correct as written.
- **Honesty/invariants:** unchanged from draft — trim is measured off the real decode (`alphaBBox`); `vramSaved` is exact `before−after` from `repackAtlases`; disk number stays an estimate, never summed (invariant 5); zero network (invariant 1/2); the plan generates nothing, the worker measures then trims (invariant 3). All hold **once B0 is fixed.**

---

## 1. Defect confirmation (corrected)

- **FREE diagnosis path:** `trim-margin` fires today (analyze.worker.ts feeds `frameTrims`). Users SEE the verdict.
- **Pro fix path:** `trim-margin` does **NOT** fire (fix.worker.ts never computes/feeds `frameTrims`), so the shipped trim-on-repack fix is doubly capped: (a) no standalone repack op is scheduled (the draft's target), AND (b) **the finding it would key on doesn't exist in the fix worker's report**. This feature must fix BOTH, or it ships a dead toggle.

---

## 2. V1 scope (amended)

**In (draft's scope) +:**
- **NEW:** fix worker computes per-atlas opaque bboxes in its diagnosis pass and feeds `frameTrims` into `analyze()` (port analyze.worker.ts:224-261's `{hashes,bboxes}` shape; gate the decode pass on `frameRedundancyOn || trimMarginOn`). **Without this the feature is a no-op (B0/B1).**
- plan.ts branch + `PlanOptions.trimMargin` (draft §3a/§4 — correct as written).
- `FixOptions.trimMargin` + worker `planFix` forward (draft §3b/§5).
- App.tsx toggle + i18n in all 9 catalogs (draft §6 — correct).

**Out:** unchanged from draft (no standalone trim without repack; no new OpKind/manifest/receipt; no pure pixel/compose/zip code — `alphaBBox`/`repackAtlases` already exist).

---

## 3. Contract / type changes

Unchanged from draft §3a (`PlanOptions.trimMargin`) and §3b (`FixOptions.trimMargin`). **Trim the jsdoc** to drop the false push-order claim (M2). No `@asset-doctor/core` change — `AtlasFrameTrims` already exists (core/index.ts:396).

---

## 4. Pure module changes — `packages/fix/src/plan.ts`

**4a. Tiering pre-exclusion** — exactly the draft's `isTrimRepack` addition (plan.ts:280-281). Correct.

**4b. New pass-1 branch** — exactly the draft's branch, inserted after the `frame-redundancy` branch (after plan.ts:324, before :325). Correct. **Edit the comment** to remove the push-order rationale; keep "the shared `repacked` set is order-free (findings are SORTED at analyze.ts:251)."

**4c. jsdoc** — add the trim-margin paragraph mirroring frame-redundancy (plan.ts:71-80), with the corrected order note.

---

## 5. Worker changes — `apps/web/src/worker/fix.worker.ts`

**5a. (draft §5)** `const trimMarginOn = opts.trimMargin !== false;` near line 393; add `trimMargin: trimMarginOn,` to the `planFix` call after line 566. Correct as drafted.

**5b. (NEW — the B0/B1 fix, MANDATORY)** In the fix worker's diagnosis pass (the `hashAtlasFrames` loop, fix.worker.ts:395-421):
- Change the gate from `if (frameRedundancyOn)` to `if (frameRedundancyOn || trimMarginOn)`.
- Change the local `hashAtlasFrames` (fix.worker.ts:4038) to return `{ hashes, bboxes }` and compute `bboxes` via the imported `alphaBBox` exactly as analyze.worker.ts:257-260 does (`sp.trimmed ? null : alphaBBox(...)`).
- Collect `const frameTrims: AtlasFrameTrims[] = []` alongside `frameHashes`; push `{ atlasRef: a.atlas.name, bboxes: res.bboxes }` when present.
- Only keep `frameHashes` when `frameRedundancyOn`; only keep `frameTrims` when `trimMarginOn` (so each toggle independently controls its finding — a `frameRedundancy:false, trimMargin:true` run still gets trim bboxes; a `trimMargin:false` run is byte-identical to today).
- Pass `...(frameTrims.length ? { frameTrims } : {})` into the `analyze()` call (line 416-421), mirroring analyze.worker.ts:143.
- Import `AtlasFrameTrims` type if not already imported in the fix worker.

**No execute-path change** beyond this — once the op is emitted, the existing `buildTrimArrays`→`repackAtlases({trim})` path (single/merge/Spine) realizes the trim (confirmed fix.worker.ts:1771/2020/3718).

---

## 6. UI change — `apps/web/src/App.tsx`

Unchanged from draft §6 (state at ~1278, `buildOptions` at ~1498 `trimMargin: trimMargin ? undefined : false`, dep array at 1643, settings checkbox mirroring 596-598, i18n keys `fix.settings.trimMargin`/`trimMarginHint` in all 9 catalogs). All mirror points verified accurate.

---

## 7. Honesty / invariants / determinism / edge cases

As in the draft §7-§9 — all hold **once B0/B1 land**. Add one edge case:

| Case | Behavior |
|---|---|
| `frameRedundancy:false` + `trimMargin:true` | Diagnosis pass still runs (B1 gate `||`); only `frameTrims` is kept; trim-margin finding fires; one trim repack op; no aliasing. |
| `trimMargin:false` (any frameRedundancy) | No `frameTrims` collected ⇒ no trim-margin finding in the fix report ⇒ no new op ⇒ byte-identical to today. |
| OffscreenCanvas unavailable / page decode capped | `hashAtlasFrames` returns null ⇒ no bboxes ⇒ no trim-margin finding ⇒ honest no-op (same as frame-redundancy). |

---

## 8. Test plan (amended)

- **A (plan, `packages/fix/test/fix.test.ts`):** as draft A1-A4, with the **corrected** analyze 3rd-arg shape: `analyze([...], undefined, { frameTrims: [{ atlasRef, bboxes: [...] }] })` (M1). A1: trim-margin fires, no occupancy ⇒ exactly one repack op. A2: `trimMargin:false` ⇒ no repack op. A3: occupancy + trim same ref ⇒ one op. A4: feed the bboxes into `repackAtlases({trim})` ⇒ `trimmedSprites===3, trimmedAreaReclaimed===7200` (matches `expected.json.repack`).
- **B (NEW — guards B0):** a fix-worker-path test (or, if the worker is hard to drive headless, an explicit assertion in the worker's analyze-wiring test) proving the fix worker's `analyze()` is called **with `frameTrims`** when `trimMargin` is on — i.e. the trim-margin finding is present in the report that `planFix` consumes. Without this test, B0 can silently regress (unit tests inject `frameTrims` and would stay green). At minimum, extend `perceptual.test.ts` (line 540) to assert the **fix** path (not just diagnosis) reaches one repack op for the real-decoded fixture.
- **C (i18n guard):** add `fix.settings.trimMargin*` to all 9 catalogs; `pnpm test` to satisfy the drift/app-keys guard.

**Run:** `pnpm --filter @asset-doctor/fix test` · `pnpm --filter web test` · `pnpm typecheck` · `pnpm lint`.

---

## 9. Ordered task breakdown (amended — B0/B1 added as task 2)

1. **`feat(fix): trimMargin PlanOption + standalone trim-margin→repack branch`** — plan.ts: `PlanOptions.trimMargin`, the pass-1 branch (4b), tiering pre-exclusion (4a), jsdoc (4c, corrected order note). + planFix tests A1-A4 (with corrected `bboxes` key). *(Pure, fully testable here — but NOTE: not yet user-visible without task 2.)*
2. **`feat(web): fix worker computes + feeds frameTrims (uncaps trim-margin in the FIX path)`** — **THE B0/B1 FIX.** fix.worker.ts: `{hashes,bboxes}` return on the local `hashAtlasFrames`; gate the diagnosis decode on `frameRedundancyOn || trimMarginOn`; collect `frameTrims: AtlasFrameTrims[]`; pass into `analyze()`; import `AtlasFrameTrims`. + the §5a `trimMarginOn` local + `planFix` forward. + test B (proves the fix path now produces a trim-margin finding ⇒ one repack op). **fix-protocol.ts `FixOptions.trimMargin`.**
3. **`feat(web): trim-margin Pro toggle (default ON) + i18n`** — App.tsx state/buildOptions/dep-array/checkbox; `fix.settings.trimMargin`/`trimMarginHint` in all 9 catalogs; verify i18n guard green.
4. **`docs: CHANGELOG/FEATURES — standalone trim-margin repack scheduling`** — note it uncaps the r20#0 fix **in the fix worker** (the finding was diagnosis-only there).

**Key file paths:**
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/plan.ts` (80, 277-282, 311-324, 325)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` (**393, 396, 416-421, 546-575, 4038-4073** — B0/B1), 1771
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/analyze.worker.ts` (224-261, 143 — **the reference implementation to port**)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` (127)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` (535-536, 552-553, 596-598, 1278, 1498, 1643)
- `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` (396-399 — `AtlasFrameTrims = {atlasRef, bboxes}`)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/test/fix.test.ts` · `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/perceptual.test.ts` (540)
- Fixture (reuse): `/home/nonamezzz/Рабочий стол/projects/fixtures/sample-projects/untrimmed-padding/`

---

**Summary of the review:** The feature is real and worth doing, but the draft would have **shipped a dead toggle**. Its load-bearing false premise — "the worker already builds trim arrays unconditionally, zero new worker code" — conflated **execute-time** `buildTrimArrays` (fix.worker.ts:1404) with **diagnosis-time** bbox computation, which the fix worker does NOT perform. The `trim-margin` finding fires in the FREE diagnosis worker but **never in the fix worker's internal `analyze()`** (its `hashAtlasFrames` returns hashes only and `frameTrims` is never passed). Added mandatory **task 2 (B0/B1)** to port the analyze worker's `{hashes,bboxes}` pass into the fix worker, gated on `frameRedundancyOn || trimMarginOn`. Also corrected the test's `analyze` 3rd-arg key (`bboxes`, not `frameTrims` — M1) and removed the false "report order = push order" justification (findings are sorted at analyze.ts:251 — M2; the Set guard still makes double-emit impossible). All other parts of the draft (plan.ts branch, App.tsx/fix-protocol/i18n mirror points, honesty/invariant analysis) verified accurate.