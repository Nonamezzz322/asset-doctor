All structural premises confirmed. Let me verify the one remaining merge-multi-page hazard: when a cross-sheet cluster's rep is in sheet B but the merge spills into multiple output pages, does the rep's blit land on the same output page as its aliases? The aliases emit Sprites at the rep's final rect (so same page by construction in `repack.ts:253` — aliases are emitted within the rep's `bin.placements.forEach`), and the blit filter at `:1906` is `naNames.has(b.name)` where `naNames` is that page's sprite names. The rep's blit has `b.name === rep.name`, and the rep Sprite is on its own page. Aliases are added to the **same** `sprites` array as the rep (`repack.ts:258`), so they're on the rep's page too. The rep's single Blit is filtered in by the rep's name. **This is sound — no compose change needed.** The draft is correct here.

I now have a complete, code-grounded picture. Let me write the revised mini-design.

---

# Mini-Design (REVISED): Cross-Atlas Frame Dedup During Merge — POT-tier-honest VRAM

## Verdict: SALVAGEABLE with 3 blockers fixed. Premise is REAL but the draft has 2 correctness bugs and 1 false honesty claim.

The core defect is real and verified: `repackAtlases` keys aliasing per-`Atlas.name` (`repack.ts:174`, `repId` at `:206` is local to `a.sprites`), so in the merge path (`fix.worker.ts:1859`) a frame byte-identical between sheet A and sheet B is packed twice. The compose plumbing genuinely needs zero change (verified: `Blit.from.atlasRef` consumed per-blit at `:1285`; aliases emit no Blit and are added to the rep's page `sprites` at `repack.ts:253-258`; page filter `naNames.has(b.name)` at `:1906` includes the rep's single blit). But the draft ships three defects.

---

## BLOCKERS (must fix)

### B1 — `rectKey` collapse is WRONG across sheets (correctness, under-count / wrong rep)
The draft reuses the detector's `rectKey(frame) = "${x},${y},${w},${h}"` for the cross-group distinct-rect guard (§4a, "reusing the **exact** distinct-rect guard"). Within one atlas this is correct: identical (x,y,w,h) literally means two manifest names pointing at the SAME on-sheet pixels (a pre-aliased rect = one GPU region). **Across sheets it is false** — frame `(0,0,64,64)` in sheet A and frame `(0,0,64,64)` in sheet B are two physically distinct copies on two textures, but byte-identical content. The draft's `byRect` would collapse them to ONE distinct rect, so a cross-sheet cluster of {A@(0,0), B@(0,0)} yields `distinctRects=1 < minDistinctRects` → **no alias fires**, or worse, mis-counts reclaim.
**Fix:** the cross-group distinct-rect key MUST be atlas-qualified: `mergeRectKey = "${atlasName}|${x},${y},${w},${h}"`. Two byte-identical frames on different sheets are then two distinct rects (correct: each pins its own sheet area). The within-atlas pre-alias collapse still works (same atlas + same coords ⇒ one key). The draft's claim "reuse the exact guard" is the bug; reuse the *clustering*, atlas-qualify the *rect key*.

### B2 — worker pre-filter starves the headline case (integration dead-on-arrival)
`fix.worker.ts:411`: `const wantHashes = frameRedundancyOn && a.atlas.sprites.length >= minDuplicates` (minDuplicates=3, `config.ts:28`). A sheet is absent from `frameHashByRef` unless it ALONE has ≥3 sprites. The draft's `buildMergeAliasMap` bails to identity if **any** group atlas is missing its hashes (§4a, correctly fail-safe). **Net: the exact value case — folding many small sheets, e.g. 2-in-A + 1-in-B — never gets hashes for B, so the merge map always bails.** The draft's own headline example (T1: B=[idle0@B], one sprite) cannot fire through the real worker.
**Fix (task 4):** when a merge op exists, compute hashes for EVERY atlas in any multi-sheet merge group regardless of its own sprite count. Concretely, after the plan is built, collect `mergeGroupRefs = Set(refs of every op with atlasRefs.length>1)` and relax the gate: `wantHashes = frameRedundancyOn && (a.atlas.sprites.length >= minDuplicates || mergeGroupRefs.has(a.atlas.name))`. This is the ONLY change that makes the feature deliver its stated value. The plan is available before the decode pass? **Verify ordering:** `analyze()` (which produces the plan via findings) runs at `:435`, AFTER the decode pass at `:404-420`. So `mergeGroupRefs` is NOT known at decode time. Two honest options:
- (a) **Two-pass:** run the cheap merge-grouping heuristic (the same dup-exact/should-merge logic the plan uses) before the hash pass — heavy, duplicates plan logic, rejected.
- (b) **PREFERRED — lazy hash-on-demand in the merge branch:** drop the upfront gate dependency entirely for cross-atlas. In the merge branch (`:1773`, where `group` is known), for any group atlas missing from `frameHashByRef`, compute its hashes THEN via the same `hashAtlasFrames(bytesByRef.get(a.name), a.sprites)` call (the bytes are pinned at `:1784`). Cache back into `frameHashByRef` so a later op reuses it. This pays the decode only for sheets that actually enter a merge group and is the minimum honest cost. The within-atlas upfront pass at `:404` is unchanged.

### B3 — "equals the detector's `dupes`" is FALSE for cross-atlas (honesty / diagnosis gap)
`frameRedundancyFinding` is per-atlas only (`analyze.ts:176`, inside the per-atlas loop; no cross-atlas variant exists — grep-confirmed). For a cross-sheet cluster there is **NO finding**, so `aliasedFrames` cannot "equal the detector's dupes" (§1, §7, §10 task 2 all assert this). More importantly: **the free diagnosis never reports cross-atlas duplicates, but the Pro fix would silently dedup them.** That is a "fix delivers a win the audit never surfaced" honesty gap (invariant 4: instant-wow is the diagnosis; the Pro receipt should not be the first place a user learns a duplicate existed).
**Fix:** drop every "equals the detector's `dupes`" claim for the cross-atlas count — it's unanchored. The honest framing: `framesAliased` (existing field) becomes "byte-identical frame names aliased onto a shared region" with NO claim of detector-parity for the cross-sheet portion. AND (recommended, additive, cheap): emit a cross-atlas duplicate **finding** in the merge op's receipt path — OR at minimum, the operations string and receipt must make clear these are *merge-discovered* duplicates. Minimum to ship: revise the doc comments + the i18n copy so neither claims the audit reported them. Stretch (separate, out of scope here): a real cross-atlas frame-redundancy detector in the free layer (that's the "PARITY" candidate, not this fix).

---

## MAJORS

### M1 — `framesAliased` double-count risk across the run total
`framesAliasedTotal += r.aliasedFrames` fires at BOTH `:1759` (Spine), `:1741`-area (single), AND `:2041` (merge). With the merge map adding `mergeAliasMap.aliasedFrames` once per merge op (correct), the run total stays a clean sum. BUT the single-atlas branches still pass `aliasMaps` (per-atlas) — confirm a sheet that is BOTH in a merge group and (hypothetically) repacked single doesn't double-count. It can't: a merged ref is `dropped` (`:2021`) and never independently repacked in the same plan. Acceptable — but the design must state it (the merge op consumes its refs exclusively).

### M2 — POT-tier baseline second-pack: spell out the item set
§4's "re-run the pack over `items ∪ {one PackItem per aliased member at its own w×h}`" is right but underspecified. The baseline pack must use the EXACT same `PackItem` list the no-alias path would produce: every sprite (rep AND aliased) at its packed extent — i.e. with trim applied identically (a trimmed rep's aliases pack at the rep's bbox extent in the real path; in the baseline they pack at their OWN bbox extent if measured, else frame). Simplest honest baseline: pack ALL group sprites at the extent the trim-resolved real path would use, with NO aliasing. Run `pack()` once, sum `vram(bin.w,bin.h)` → `vramBaseline`. `vramReclaimedBytes = max(0, vramBaseline − vramBytesAfter)`, `potTierDropped = vramBytesAfter < vramBaseline`. Bounded by group size, only on merge-with-aliases. `pack` signature confirmed (`pack.ts:8/26`, takes `PackItem[]` + `{maxSize,allowRotation,padding,gutter}`).

### M3 — rotated carve-out: keep, and it interacts with B1
§8's rotated-mismatch skip is correct and necessary (a rep's rect reused by a differently-`rotated` alias would render wrong). Keep it. Note it composes cleanly with B1's atlas-qualified key (rotation is a per-sprite attr, checked within the content-hash cluster). Honest under-report stands.

---

## Confirmed-correct in the draft (no change)
- Compose plumbing: zero change. Rep blit + aliases land on the same output page; `from.atlasRef` per-blit (`:1285`); alias emits no Blit (`repack.ts:253-258`). Multi-page spill safe (aliases are emitted inside the rep's `bin.placements` iteration ⇒ rep's page).
- Drop-in / no-op: identity map when no cross-sheet dupes ⇒ byte-identical (verified path).
- `trimOf` keyed by rep id, aliases inherit via `aliasesOf.get(p.id)` — works for cross-sheet rep (`repack.ts:234,253`).
- sprite-name collision guard at `:1881` still fires (cross-sheet aliasing doesn't change merged name set).
- Single-atlas + Spine paths keep per-atlas `aliasMaps` (`:1697`, `:1754`) — `mergeAliasMap` undefined there.
- Extrude baseline at `:2055` must receive the same `mergeAliasMap` (draft §5.2 correct).
- Additive RepackResult/FixReceipt fields; App.tsx branch at 1940-1943; i18n drift test enforces 9-catalog coverage. All verified.

---

## Revised contract / signatures (deltas from draft)

`buildMergeAliasMap` unchanged signature, but: distinct-rect key is **atlas-qualified** (B1); doc comment drops "equals the detector's dupes" (B3), says "byte-identical frames across the group; aliasedFrames = Σ(distinctRects−1) over qualifying GROUP clusters."

`repackAtlases(atlases, opts, aliasMaps?, mergeAliasMap?)` — as draft, with M2's baseline-pack item set spelled out. The flat-index resolver (`flatId: string[]` built in the same first pass) is required (draft §4b correct).

i18n: `fix.framesAliasedDiskOnly` ("Aliased {n} duplicate frames across sheets onto a shared region — same VRAM tier, disk only (all names resolve)"). Note "across sheets" — do NOT imply the diagnosis flagged them.

---

## Ordered task breakdown (REVISED — keeps draft's order, fixes blockers in place)

1. **`feat(core): RepackResult.vramReclaimedBytes + potTierDropped`** — additive fields + docs. Typecheck. *(unchanged from draft)*
2. **`feat(fix): buildMergeAliasMap (global group keyspace, ATLAS-QUALIFIED rect key)`** — pure fn in `alias.ts` + export. **B1: distinct-rect key = `${atlasName}|${rectKey}`.** **B3: doc drops detector-dupes parity claim.** Tests T1 + T1b (atlas-qualified: two byte-identical frames at coincidentally-equal coords on different sheets DO count as 2 distinct rects) + T5 (rotated carve-out).
3. **`feat(fix): repackAtlases merge-alias consumption + POT-tier honesty`** — flat `mergeAliasMap` arg, flat-index repOf + `flatId` resolver, **M2: no-alias baseline pack over the full group item set** → `vramReclaimedBytes`/`potTierDropped`. Tests T2/T3/T4.
4. **`feat(web): thread merge-alias map + lazy cross-group hashing`** — **B2: in the merge branch, hash any group atlas missing from `frameHashByRef` on demand via `hashAtlasFrames` (bytes pinned at `:1784`), cache back; build `mergeAliasMap = buildMergeAliasMap(group, frameHashByRef, aliasMinDistinct)`.** Thread into both merge `repackAtlases` calls (`:1836`, `:1859`) and the extrude baseline (`:2055`); accumulate `vramReclaimedTotal`/`potTierDroppedAny`. Single-atlas/Spine pass `mergeAliasMap=undefined`. (Async hashing in the merge branch is fine — it's already `async`.)
5. **`feat(web): honest cross-atlas dedup receipt (FixReceipt fields + UI branch)`** — fix-protocol fields, `App.tsx` `potTierDropped` branch; operations string appends `(across sheets, same tier, disk only)` when `aliasedFrames>0 && !potTierDropped`.
6. **`i18n: fix.framesAliasedDiskOnly across 9 catalogs`** — en source + bake 8; render/drift test green.

---

## Test plan (REVISED — must FIRE on the real path)

- **T1** — `alias.test.ts` global keyspace clustering across sheets (hand-supplied hashes). aliasedFrames/repOf in flat space. **REVISED: drop the "per-atlas returns 0 = the literal defect" negative as a *detector*-dupes claim; keep it only as proof the per-atlas map under-aliases (the within-sheet count differs from the group count).**
- **T1b (NEW, B1)** — two byte-identical frames at identical (x,y,w,h) on DIFFERENT sheets ⇒ `aliasedFrames===1` (atlas-qualified key keeps them distinct). With the draft's un-qualified key this would (wrongly) be 0. Proves the B1 fix.
- **T2** — real `repackAtlases(group, opts, undefined, mergeAliasMap)` dedups cross-sheet: `r.blits.length === totalSprites−1`, every name present, alias shares rep rect. Contrast `mergeAliasMap=undefined` → `totalSprites` blits.
- **T3** — POT-tier honesty: tier-drop group (`potTierDropped===true`, `vramReclaimedBytes>0`) vs same-tier group (`false`, `0`, `aliasedFrames>0`).
- **T4** — drop-in no-op (no cross-sheet dupes ⇒ identity ⇒ deep-equal to `repackAtlases(group, opts)`).
- **T5** — rotated-mismatch carve-out.
- **T6** — i18n drift/render (9 catalogs, `{n}` plural en+ru).
- **T7 (NEW, B2 — integration smoke, fix.test.ts or a worker-adjacent harness)** — assert the lazy-hash gate: a 2-sheet group where one sheet has 1 sprite still produces a non-identity merge map (i.e. the pre-filter no longer starves it). If a full worker harness is impractical, at minimum a comment-pinned unit test on the relaxed-gate helper.

---

## Key file references (verified line numbers)
- `packages/fix/src/alias.ts` — per-atlas keying 103-116; `rectKey` 31; add `buildMergeAliasMap` (atlas-qualified key).
- `packages/fix/src/repack.ts` — `am = aliasMaps?.get(a.name)` 174; `repId` 206; alias emit 253-259; trim inherit 234/253; VRAM 172/225; add `mergeAliasMap` + flat path + baseline pack.
- `packages/fix/src/pack.ts` — `pack`/`PackItem`/`PackOptions` 8/26 (baseline pack).
- `packages/core/src/index.ts` — `RepackResult` 700-722 (add 2 fields).
- `apps/web/src/worker/fix.worker.ts` — decode/`wantHashes` gate **411** (B2 relax / lazy-hash); `frameHashByRef` 402; `aliasMaps` build 613; merge branch 1773-2069; merge `repackAtlases` 1836/1859; pin 1784; extrude baseline 2055; receipt 3737; run-total vram 3633-3634.
- `apps/web/src/worker/fix-protocol.ts` — `FixReceipt.framesAliased` 402; run-total `vramBytesBefore/After` 330-331 (NOTE: these are RUN totals — the new fields must NOT reuse them).
- `apps/web/src/App.tsx` — `fix.framesAliased` render 1940-1943.
- `packages/analysis/src/rules.ts` — detector distinct-rect guard 202-227 (mirror clustering; atlas-qualify key); `analyze.ts:176` (per-atlas only ⇒ B3).
- `packages/analysis/src/config.ts:28` — `minDuplicates:3`.
- `packages/fix/test/{alias,fix}.test.ts`; `packages/i18n/src/catalogs/*.json` (9) + `i18n/test/render.test.ts`.

## Load-bearing facts (corrected)
- **Compose: zero change** — verified (`from.atlasRef` per-blit `:1285`; alias no-Blit; rep+aliases same page).
- **The pre-filter at `:411` (`sprites.length >= minDuplicates`) starves the headline many-small-sheets case** — B2 lazy-hash in the merge branch is mandatory or the feature is dead-on-arrival.
- **The cross-sheet distinct-rect key MUST be atlas-qualified** — the within-atlas `rectKey` collapses real cross-sheet copies (B1).
- **There is NO cross-atlas detector** (`analyze.ts:176` per-atlas) — `aliasedFrames` does NOT equal any detector `dupes` for cross-sheet clusters; drop that claim and ensure the copy says "across sheets" (B3).
- The new `vramReclaimedBytes`/`potTierDropped` are the honest isolation of the merge-alias VRAM win; the existing `fix.framesAliased` line already (loosely) attributes RUN-total vram to aliasing — do not reuse run totals for the new exact fields.