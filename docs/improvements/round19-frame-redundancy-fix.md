I have everything needed. Key confirmed facts:

1. **Worker `analyze()` call (line 290) does NOT pass `frameHashes`** → frame-redundancy finding never fires in the fix path today. Draft correct on this.
2. **The repack op is emitted ONLY for `occupancy`/`wasted-regions`** (plan.ts:280). A `frame-redundancy` finding emits NO op. **The frame-redundant fixture is 100%-packed → no occupancy finding → no repack → zero aliasing under the draft's design.** This is the load-bearing BLOCKER the draft missed.
3. `repackAtlases` uses a SINGLE `coveredArea` for both occupancies — draft's dual-accumulator fix is correct.
4. `extractRegion` reads the placed rect → rotation/orientation differences yield different hashes → E7 holds without extra guard. Confirmed.
5. `frameRedundancy` config default IS set (`minDuplicates: 3`) and survives into `report.thresholds`, so in the browser the gate is effectively always present (the draft's `?? Infinity` is dead in the worker, alive only headless).
6. `planFix` returns `{ ops, thresholds: report.thresholds }` and consumes `report.findings` — the finding's `relatedRefs` is a flat sorted list (rules.ts:230), so plan-side cluster reconstruction is impossible. Draft correct to put alias derivation in repack.ts from raw hashes.

Now I'll write the revised design.

---

# Frame-redundancy FIX — alias byte-identical frames to ONE packed region (REVISED)

## Verdict: SALVAGEABLE, but the draft has ONE load-bearing BLOCKER that inverts the feature's value, plus 3 majors. Revised below; ordered task breakdown preserved and corrected.

---

## BLOCKER B1 — The draft's "ride the existing repack" premise is FALSE for the target case

**Evidence.** `planFix` emits a `repack` op ONLY from `occupancy` or `wasted-regions` findings (`packages/fix/src/plan.ts:280-284`). `occupancyFinding` returns `null` once occupancy ≥ `cfg.occupancy.warn` (0.8) (`rules.ts:51`, `:331`). A frame-redundant atlas is, by construction, *tightly packed* — its duplicate frames FILL the sheet (the shipped fixture `fixtures/sample-projects/frame-redundant/anim.json` is a 256×32 strip, 8×(32×32) = **100% occupancy**). So it triggers **no occupancy finding, no wasted-regions finding, and therefore NO repack op** — and the draft's aliasing, which only runs inside an existing `repackAtlases` call, **never fires on the very fixture and the very class of atlas the feature exists to fix.**

The draft asserts twice ("the plan already emits the `repack` op for the under-filled/redundant atlas", §2 and §1) — this is wrong. Under-fill and frame-redundancy are *independent and usually anti-correlated*: duplicates raise occupancy, suppressing the only finding that would have produced a repack.

**FIX (mandatory).** The `frame-redundancy` finding must ITSELF emit a `repack` op (reusing the existing `repack` OpKind — `op-manifest.ts:19` — so the dry-run tally, change-manifest, selective-fix mask, and receipt grouping all work unchanged). New plan branch in **pass 1** (`plan.ts:279`), guarded against double-emit:

```ts
} else if (f.rule === 'frame-redundancy' && opts.frameRedundancy !== false) {
  // A frame-redundant atlas is usually FULLY packed (duplicates fill the sheet ⇒ no occupancy/wasted
  // finding ⇒ no repack). Emit our OWN repack so the worker can alias the byte-identical frames onto one
  // region. Reuse the 'repack' OpKind (tally/manifest/selective-fix unchanged). Guard: skip if this atlas
  // is ALREADY a repack target (occupancy path already scheduled it — that repack will alias too).
  if (protectedOwners.has(f.assetRef) || repacked.has(f.assetRef)) continue;
  repacked.add(f.assetRef);
  ops.push({ kind: 'repack', atlasRefs: [f.assetRef], targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize, ...extrudeField });
}
```

Consequences this forces (all additive, all guarded):
- **`opts.frameRedundancy?: boolean` belongs on `PlanOptions` too**, not only `FixOptions` — the plan must gate the new op. Default ON. When `false`, no new repack op ⇒ byte-identical to today.
- **The finding must actually FIRE in the fix path.** Today the worker's `analyze()` call (`fix.worker.ts:290`) omits `frameHashes`, so `frame-redundancy` never appears in `report.findings` and the plan branch above is dead. The worker MUST compute `frameHashByRef` and pass `{ frameHashes }` into `analyze()` **before** `planFix` runs (draft §4a deferred this to "optional, nice-to-have" — it is now **load-bearing**). This also means the hash pass can no longer be gated on "would any repack run?" (the draft's §4a optimization) — the repack only runs *because* the finding fired, which needs the hashes first. See M1.

---

## MAJOR M1 — Hash-gating is circular; must hash all atlas pages with a repack-CANDIDATE, then plan

**Draft §4a** says: "Gate it behind 'would any repack run?' — only hash atlases that appear in a `repack` op." With B1's fix this is circular: the repack op for a frame-redundant atlas only *exists because* the finding fired, which needs the hash. 

**FIX.** Hash every merged atlas page that (a) has ≥ `minDuplicates` sprites (cheap pre-filter — a sheet with < 3 sprites can never reach the gate) AND (b) is NOT a single-row/already-tiny sheet below a px floor — same caps as `hashAtlasFrames`. This is **one extra full-res decode per atlas page**, identical magnitude to the existing `composePageEncode` source decode the repack pays anyway. Bound it exactly like `analyze.worker.ts:123-130` (respect `cancelled` between pages; skip pages over `FRAME_HASH_MAX_PX` / `FRAME_HASH_MAX_SPRITES` via `extractFrameRegions`'s own caps). Honesty (Inv 4): an atlas with no duplicates pays one decode and produces no finding/op — acceptable, same cost profile as the diagnosis worker already ships. Atlases that the occupancy path WOULD repack anyway get hashed too, so their repack also aliases (free win).

Order in the worker (corrected):
1. `merged = mergeSharedAtlases(assets)` (line 270, unchanged).
2. Build `frameHashByRef: Map<atlasName, (string|null)[]>` by decoding each qualifying merged atlas page (new pass, mirrors `analyze.worker.ts:hashAtlasFrames`; respect `cancelled`).
3. `analyze(merged, undefined, { …, ...(frameHashByRef.size ? { frameHashes: [...] } : {}) })` — feed the hashes so `frame-redundancy` findings appear.
4. `planFix(report, …, { frameRedundancy: opts.frameRedundancy !== false })` — now emits repack ops for redundant atlases.
5. In the repack op block, build the per-atlas `AtlasAliasMap` from `frameHashByRef` and thread into `repackAtlases`.

---

## MAJOR M2 — `repackAtlases` occupancy honesty: draft's dual-accumulator is correct; pin it as a REQUIREMENT

**Evidence.** `repackAtlases` (`repack.ts:62,70,73,105`) uses **one** `coveredArea` for both `occupancyBefore` (over `areaBefore`) and `occupancyAfter` (over `areaAfter`). If aliasing drops alias `PackItem`s, a naive single accumulator makes `occupancyBefore` read *lower* than the true source fill (the source genuinely had those redundant rects). The draft (§3b) correctly mandates two accumulators. **Confirmed correct and required:**
- `coveredAreaSource` = Σ over ALL sprites (every alias included) → `occupancyBefore = coveredAreaSource / areaBefore`. Truthful: "the source sheet was N% full (duplicates and all)."
- `coveredAreaPacked` = Σ over representatives only → `occupancyAfter = coveredAreaPacked / areaAfter`. Truthful: "the de-duplicated sheet is M% full."

This is the honest before/after pair. No change to `vramBytesBefore/After` (already exact w×h×4 of the POT bins; aliasing simply yields fewer/smaller bins).

---

## MAJOR M3 — Merge-path aliasing + the collision guard need explicit ordering; alias maps keyed by `Atlas.name`

**Evidence.** `srcOf` is keyed `${a.name} ${s.name}` (`repack.ts:67`), and the merge collision guard counts `r.atlases.flatMap(a => a.sprites.map(s => s.name))` (`fix.worker.ts:1385`). Aliasing adds alias `Sprite`s but each is a *distinct original name*, so within one atlas no new collision arises (manifest keys are unique). Across merged atlases the guard already rejects name collisions *before* compose. **But** the draft keys `aliasMaps` by `Atlas.name` (correct) and scopes clusters within a single source atlas (E5, correct) — so the merge guard must run on the **post-alias** sprite list. Since aliasing happens *inside* `repackAtlases`, `r.atlases` already contains alias sprites when the guard at `:1385` runs. ✔ No new collision, guard unchanged. **Requirement:** add a test (draft test D-merge) that an aliased single-atlas-within-merge passes `:1386`.

One correction to the draft's E5: keying per `Atlas.name` is right, but note `mergeSharedAtlases` can *union shared-page regions by name into the first atlas* (`analyze.worker.ts:113-116` comment). After merge, two source files sharing a page become ONE `Atlas` with ONE name — so "within-atlas" correctly already spans those unioned regions, and the alias map is built on the post-merge sprite list (index-aligned to the same list the hashes were computed on). This is *more* correct than the draft implied and needs the hash pass to run on `merged` (it does, per M1).

---

## Confirmed-correct draft claims (rebuttals to my own skepticism, code-grounded)

- **E7 (rotation):** `extractRegion` (`perceptual.ts:190-199`) reads the rect *as placed* (`rect.w/rect.h`, row-major from `rect.x/rect.y`). A sprite with `rotated:true` has different placed bytes than its `rotated:false` twin ⇒ different SHA ⇒ different cluster ⇒ never aliased. **No extra guard needed; assert in a test.** ✔ Draft correct.
- **Distinct-rect guard:** `rules.ts:204-211` keys by `${x},${y},${w},${h}` and collapses pre-aliased same-rect names to one unit. `buildAtlasAliasMap` must mirror this byte-for-byte so the fix realizes exactly `finding.params.dupes`. ✔ The honesty-alignment test (draft C) is load-bearing — keep it.
- **Alias derivation lives in `repack.ts`, not `plan.ts`:** confirmed — the finding's `relatedRefs` is `dupRefs.sort()` (`rules.ts:230`), a flat cross-cluster list; clusters are unrecoverable from it. Raw `AtlasFrameHashes` is the only source of truth. ✔ Draft correct.
- **Manifest emitters alias-safe:** `emitTexturePackerJson` (`manifest.ts:9`) and `emitSpineAtlasText` (`manifest.ts:42`) both sort by name and write one block per sprite — N alias sprites at one rect emit N manifest entries / N `.atlas` regions. ✔ Drop-in resolves every name.
- **Config gate present in browser:** `DEFAULT_THRESHOLDS.frameRedundancy = { minDuplicates: 3 }` (`config.ts:28`) flows into `report.thresholds` (`analyze.ts:241`). The draft's `?? Infinity` is correct as a *headless* safety but is effectively always-present in the worker. Keep it (harmless, honest fallback).

---

## Minor corrections to the draft

- **Mn1 — Test B-7 blit count:** the draft's own text wavers ("exactly 4 Blits… (5: idle rep + 4 walks) — 5 blits"). The fixture has 4 idle (1 cluster) + 4 distinct walks. Representatives = 1 (idle) + 4 (walks) = **5 PackItems, 5 Blits, 5 packed rects; 8 Sprites total; `aliasedFrames === 3`.** Pin this exact arithmetic.
- **Mn2 — Plan dry-run (draft §4d):** with B1, the dry-run NOW emits a repack op for redundant atlases (it must, for tally parity with the committed run). So plan-mode op COUNT changes by +1 per redundant atlas — this is correct and required (the draft said "no change to plan-mode," which is now wrong since the op didn't exist before). Still no byte/alias-count prediction in dry-run (consistent with polygon-no-win etc.). The dry-run must run the SAME `frameHashByRef` pass? **No** — dry-run deliberately skips pixel work. **Decision:** dry-run cannot know which atlases are redundant without hashing. Two honest options: (a) dry-run also runs the bounded hash pass (one decode/qualifying-page — the dry-run already isn't free of all work); or (b) dry-run does NOT predict frame-redundancy repacks and the committed run surfaces them. **Pick (b)** — matches how dry-run omits all pixel-dependent ops (near-dup dHash, polygon, codec availability). Document that the committed run may show one extra repack per redundant atlas vs. the dry-run preview, exactly as it already may differ on polygon/dedup outcomes.
- **Mn3 — `operations` string + receipt:** `vramSaved += r.vramBytesBefore - r.vramBytesAfter` already runs at `fix.worker.ts:1486` (merge/rect) and `:1314` (Spine). Accumulate `framesAliasedTotal += r.aliasedFrames ?? 0` at both sites. Append `(N frames aliased)` to the `operations.push` at `:1320` (Spine), `:1465` (single), and the merge string at `:1482`.
- **Mn4 — i18n:** add ONE key `fix.framesAliased` to **all 9** `packages/i18n/src/catalogs/*.json` (en source), pass the render-drift test (`packages/i18n/test/render.test.ts`). The fix keys live under `fix.*` (`en.json:194-211`).

---

## Final type changes (unchanged from draft, confirmed additive)

- `core`: `RepackResult.aliasedFrames?: number` (`index.ts:673`). ✔
- `fix-protocol`: `FixReceipt.framesAliased?: number` (`fix-protocol.ts:294`); `FixOptions.frameRedundancy?: boolean` (default ON). ✔
- **NEW:** `PlanOptions.frameRedundancy?: boolean` (default ON) — required by B1 to gate the new repack op.
- No change to `Sprite`/`Blit`/`Atlas`/`FixOp` (reuses `repack` OpKind) /`AtlasFrameHashes`. ✔

`packages/fix/src/alias.ts` — `buildAtlasAliasMap(sprites, frameHashes, minDistinctRects): AtlasAliasMap` with `repOf: number[]` — unchanged from draft §3a, mirrors `rules.ts:182-228` exactly.

---

## Determinism (confirmed)

`buildAtlasAliasMap`: clusters by hash (ascending-index insertion), distinct rects by lowest index, rep = first distinct rect's lowest index — pure integer math, no time/RNG. `repackAtlases`: representatives feed `pack()` in source order, alias sprites appended ascending, final `sprites.sort(byName)` (`repack.ts:101`) + `emitTexturePackerJson`'s own sort ⇒ byte-stable JSON. ✔

---

## REVISED ORDERED TASK BREAKDOWN (small commits)

1. **`core`: add `RepackResult.aliasedFrames?`** (additive doc'd field). `pnpm typecheck`.
2. **`fix`: new pure `alias.ts` — `buildAtlasAliasMap` + `AtlasAliasMap`**, export from `packages/fix/src/index.ts`. Commit with **test A** (`alias.test.ts`: identical+distinct clustering, `minDistinctRects` gate, distinct-rect-guard collapse, null skip, length-mismatch identity, determinism).
3. **`fix`: `repackAtlases` accepts `aliasMaps?: Map<string, AtlasAliasMap>`** — representatives-only `PackItem`s, **dual occupancy accumulators (M2)**, emit alias `Sprite`s (copy `rotated/trimmed/sourceSize/spriteSourceSize/pivot` from each alias's OWN source), set `aliasedFrames`. Commit with **test B-7..11** + the **absent-map regression** (output byte-identical to today). `repackAtlasesPolygon` untouched.
4. **`fix`: Spine symmetry + detector-alignment tests** — B-12 (`emitSpineAtlasText` round-trips aliased names at the shared `xy/size`) + **C** (`aliasedFrames === frameRedundancyFinding(...).params.dupes` on the same inputs — the load-bearing honesty pin).
5. **`core`/`fix-protocol`: add `FixOptions.frameRedundancy?` + `FixReceipt.framesAliased?` + `PlanOptions.frameRedundancy?`** (all additive, default ON). `pnpm typecheck`.
6. **`fix`: plan branch (BLOCKER B1)** — `frame-redundancy` finding → `repack` op (reuse `repack` OpKind), guarded against double-emit with the occupancy `repacked` set, gated on `opts.frameRedundancy !== false`. Commit with a plan-test on the `frame-redundant` fixture's report: a `repack` op appears for `anim.json`; with `frameRedundancy:false`, none.
7. **worker: frame-hash pass in the fix path (M1)** — import `extractFrameRegions`, decode each qualifying merged atlas page (≥`minDuplicates` sprites, within `extractFrameRegions` caps), SHA regions → `frameHashByRef`, respect `cancelled`. Pass `{ frameHashes }` into the `analyze()` call (`fix.worker.ts:290`) so `frame-redundancy` findings fire and the new plan op is emitted.
8. **worker: build alias maps + thread into `repackAtlases`** at the single-atlas (`:1377`), merge (`:1368` rect path / fallback), and Spine (`:1277`) sites; **NOT** polygon (`:1366`, signature unchanged — fallback `rect` still aliases). Accumulate `framesAliasedTotal` at `:1486`/`:1314`; set `receipt.framesAliased`; append `(N frames aliased)` to `operations` at `:1320`/`:1465`/`:1482`. Verify the merge collision guard (`:1386`) passes on an aliased atlas (M3 test).
9. **UI + i18n:** receipt line "Aliased N duplicate frames (smaller sheet, all frame names still resolve)" sourced from `receipt.framesAliased`; add `fix.framesAliased` to all 9 catalogs (en source); optional Pro toggle wired to `FixOptions.frameRedundancy` (default ON). Run the i18n render-drift test.
10. **Full green:** `pnpm typecheck && pnpm lint && pnpm test`; manual `verify` on `fixtures/sample-projects/frame-redundant` — confirm the downloaded zip's `anim.png` shrank from 256×32 to ~160×32 (5 frames), all 8 names resolve in the emitted `anim.json`, the 4 `idle_*` share one `{x,y,w,h}`, and `receipt.framesAliased === 3`.

---

### Net assessment
The feature is sound and high-value, but the draft would have **shipped a no-op on its own target fixture** because it assumed an occupancy-driven repack that a (by-definition packed) redundant atlas never produces. The single non-negotiable change is **B1: the `frame-redundancy` finding must emit its own `repack` op**, which cascades into M1 (hash before plan, not after) and adds `PlanOptions.frameRedundancy`. M2 (dual occupancy accumulators) and M3 (merge guard ordering) are correctly anticipated by the draft and are pinned here as requirements. E7 and the distinct-rect-guard reuse are verified correct as drafted. With these, the design is implementation-ready and honest under all 5 invariants.