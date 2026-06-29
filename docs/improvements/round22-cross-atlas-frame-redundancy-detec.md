Verification complete. I have everything needed to deliver the adversarial review. The premise is TRUE and the design is fundamentally sound, but I found several concrete blockers and majors that the draft either got wrong or glossed over.

---

# Adversarial Review + Final Revised Mini-Design: Cross-atlas frame-redundancy DETECTOR

## Verdict: PREMISE TRUE, design SALVAGEABLE with fixes. 2 BLOCKERS, 3 MAJORS, 2 MINORS.

### Premise verification (code-grounded)
- **CONFIRMED:** `analyze.ts:119-120` builds `frameHashByRef` over **all** atlases; `analyze.ts:174` consumes it only per-atlas (`frameHashByRef.get(atlas.name)`). Cross-atlas comparison data is computed and discarded. The defect is real.
- **CONFIRMED:** region hash = SHA-256 of raw RGBA bytes (`analyze.worker.ts:184`, `hashAtlasFrames`); cross-sheet byte-identical regions ⇒ identical SHA. Cross-atlas comparability is sound.
- **CONFIRMED:** flat-guard nulls featureless regions (`perceptual.ts:235`, `extractFrameRegions`); `null` never clusters. The draft's flat-guard claim is correct, though it cites line 234 — actual is 231/235 (two `out.push(null)` sites: oversize-skip + flat-skip). Minor citation drift, not load-bearing.
- **CONFIRMED:** `pack` IS exported from `@asset-doctor/fix` (`fix/src/index.ts:5`), so Option B is *mechanically* possible — but see BLOCKER 2.
- **CONFIRMED NOT-REDUNDANT:** `dedup-repoint.ts`/`dedup-exec.ts` repoint a whole consumer atlas manifest at an OWNER image (file-level identical-page dedup), NOT cross-sheet per-FRAME consolidation. No existing finding/rule references `cross-atlas`. The detector is genuinely new.

---

### BLOCKER 1 — `messageKey` ≠ catalog-key naming. The draft's i18n keys would silently fall back to baked English and the drift guard would NOT catch the rule.

The draft emits `messageKey: 'cross-atlas-redundancy'` (§5.8) and catalog keys `find.cross-atlas-redundancy.*` (§7). That part is internally consistent (`renderFinding` does `find.${f.messageKey}.title`, i18n/src/index.ts:138). **BUT** the draft's §5.8 finding object also says `id: 'folder:cross-atlas-redundancy'` AND `messageKey: 'cross-atlas-redundancy'` — fine. The real trap: the draft never states the messageKey must be a **distinct value from the within-atlas `'frame-redundancy'`**, and §7's title/detail copy reuses near-identical wording. If a copy/paste leaves `messageKey: 'frame-redundancy'`, the cross-atlas finding renders the within-atlas template (wrong `{sheets}` placeholder ⇒ empty interpolation) and **no test catches it** because `render.test.ts:83` keys on `messageKey` set membership — a duplicate key just collapses in the Set. **FIX:** pin `messageKey: 'cross-atlas-redundancy'` explicitly in the task list AND add an assertion in §10.A.1 that `finding.messageKey === 'cross-atlas-redundancy'` (not just `!== null`). Resolved in revised §5/§11.

### BLOCKER 2 — Option A's "inline POT-bin sizer" is NOT honest as written, and Option B (`pack()`) creates a real layering inversion. The honest-VRAM gate as drafted can OVER-claim.

The draft's Option A lower-bound (§5.6): smallest POT `w×h` with `w*h ≥ (Σ distinct areas − recoverableArea)` and `max(w,h) ≥ maxRectEdge`. This is an **area lower-bound**, so `mergedBinVram` is a *floor*. The gate fires `vramBytesSaved = curFootprint − mergedBinVram` when `mergedBinVram < curFootprint`. **The problem:** comparing a merged-bin *lower bound* against the *actual* current footprint and reporting the difference as `vramBytesSaved` claims a saving that the *smallest theoretically possible* bin would yield — NOT a saving any real packer achieves. A real MaxRects pack of the merged set will land on a LARGER bin than the area floor (packing waste), so the actual VRAM saved is **less** than the drafted number. This violates invariant 5 honesty (it asserts a VRAM win larger than a real merge delivers).

The within-atlas rule (`frameRedundancyFinding`, rules.ts:232) sidesteps this entirely: it reports `vramBytesSaved = recoverableArea × 4` — the **exact reclaimed region area**, never a bin-tier delta. That is the honest, defensible number and it requires NO packer at all.

**FIX (drop the POT-tier gate; mirror the shipped within-atlas honesty exactly):** report `vramBytesSaved = recoverableArea × 4` — the exact atlas px the cross-sheet duplicates pin, framed as "a merged de-duplicated repack reclaims." This is identical-precedent to rules.ts:232, needs no `pack()`, no inline sizer, no `@asset-doctor/fix` edge, no POT-tier conditional, and CANNOT over-claim (it's the literal duplicate-region area). The entire `vramClaimed` 0/1 branch, the `pack` import, and the Option A/B decision all **disappear**. This also kills the open coordination decision (no new package edge). Resolved in revised §5/§8.

### MAJOR 3 — `atlasMergeFinding` already reports a cross-atlas VRAM saving on the SAME under-filled set. Risk of double-counting the merge win in the user's mental model and (if ever aggregated) in totals.

`atlasMergeFinding` (folder.ts:138, wired analyze.ts:237) already fires on under-filled atlases and claims `vramBytesSaved` for merging them. A folder with under-filled sheets that ALSO share frames will surface BOTH findings, each claiming VRAM. Neither folds into `potentialDiskSaved` (atlas-merge's estimate is VRAM-only, and the new one is too), so **totals don't double-count** — good. But the two findings describe overlapping wins (merge reclaims empty space; cross-atlas-dedup reclaims duplicate frames — these are *additive* reclaimable areas, not the same px, so they're actually compatible). **FIX:** the copy must scope its claim to the DUPLICATE-frame area only (not "merge to reclaim VRAM" generically, which reads as the atlas-merge claim). Use "referencing one shared copy reclaims the duplicate-frame area" wording. Document in the rule JSDoc that this is ORTHOGONAL to atlas-merge (dup-frame px vs empty px). Resolved in revised §7 copy + §8.

### MAJOR 4 — `disk` estimate needs per-atlas `byteSize`, but the draft's `byteByRef` is built from a loop variable that does NOT exist where claimed, and the disk-estimate aggregation across atlases has a double-count hazard.

The draft (§6) says build `byteByRef` from `image.byteSize` "at line 159" — but line 159 is inside the per-asset `for` loop and is `vramBytes(atlas.size)`, not a byteSize map insert. The byteSize is `image.byteSize` (line 158). Buildable, but the draft mis-cites and never shows it actually being populated. **More importantly:** the disk estimate `Σ (atlasByteSize × thatAtlasRecoverableArea / thatAtlasAllFrameArea)` is fine PER atlas, but `thatAtlasRecoverableArea` must be the share of `recoverableArea` attributable to that atlas's *kept-from* copies — and a cluster spans atlases, so "which atlas's bytes does the recovered copy free" is ambiguous (you keep ONE representative cluster-wide; the freed copies live across N−1 atlases). The draft's per-atlas attribution is plausible but underspecified and easy to get wrong. **FIX:** since disk is an ESTIMATE never folded into totals anyway (invariant 5), and the within-atlas rule already accepts a single `imageByteSize`, simplify: attribute each freed copy's disk to ITS OWN atlas (the atlas where the redundant copy is packed), i.e. for each non-representative member, `diskEstimate += atlasByteSize[member.atlas] × memberRectArea / allFrameArea[member.atlas]`, guarded `allFrameArea > 0` per atlas. This is per-copy honest (each freed copy's bytes belong to the sheet it sat on), deterministic, and matches the area-proportional precedent. Pass `byteByRef: Map<string, number>` + a per-atlas `allFrameArea` (computable inside the rule from `atlases`). Resolved in revised §5/§6.

### MAJOR 5 — `assetRef` choice breaks the FilmViewer single-page overlay contract silently.

The draft sets `assetRef: atlasRefs[0]`. Every other folder finding does the same (`refs[0]`), so this is consistent. BUT the draft's §2 OUT correctly notes the FilmViewer overlay model is single-page and (correctly) emits NO `overlay`. **Confirm:** the within-atlas `frameRedundancyFinding` DOES emit `overlay` (rules.ts:226). A folder finding with `assetRef` pointing at one atlas but redundant rects spanning OTHER atlases must NOT emit an `overlay` keyed to `assetRef`'s page (it would draw atlas-B's rects on atlas-A's film). The draft gets this right (no overlay). **No fix needed — just flagging that the task list must NOT copy the within-atlas overlay block.** Confirmed correct in revised §5.

### MINOR 6 — `minDuplicates: 2` gate semantics differ from within-atlas, creating a calibration trap.

Within-atlas counts `distinctRects` per cluster and gates `distinctRects ≥ minDuplicates` (rules.ts:212), i.e. the gate is on **total distinct copies** (3 ⇒ at least 3 copies of the same frame). The draft's cross-atlas gate is on `distinctUnits` (Σ distinct rects across atlases) `≥ 2`. With 2 sheets each holding the frame once, `distinctUnits = 2` ⇒ fires. That's the intended "shared across 2 sheets" signal. **Consistent and defensible.** Keep `2`. But the JSDoc must state the gate counts cross-sheet copies (≥2 ⇒ on ≥2 sheets), NOT clusters, to avoid a future maintainer mis-reading it as "2 clusters." Resolved in revised JSDoc.

### MINOR 7 — `render.test.ts` Set-membership won't enforce the cross-atlas key's PLACEHOLDER set.

`render.test.ts:83` checks the messageKey Set; `catalogs.test.ts` checks key/placeholder/plural parity ACROSS locales but only for keys that EXIST. Neither verifies the en *template* placeholders match the *baked* string's interpolations for the NEW key unless the new finding is pushed into `realFindings()` AND its key added to the asserted Set (§10.B). The draft does both — correct. But it must also confirm the baked detail string in `folder.ts` is byte-identical to the en template (the drift guard compares rendered-en vs baked). **FIX:** explicit task-list line: "baked `folder.ts` cross-atlas detail/title/fix MUST be byte-identical to en.json template" (already in §7 note, promote to a §11 acceptance check). Resolved.

---

## FINAL REVISED MINI-DESIGN

### Scope (IN)
- New folder rule `crossAtlasRedundancyFinding(atlases, frameHashByRef, byteByRef, cfg)` in `packages/analysis/src/folder.ts`.
- Clusters region hashes across **≥2 distinct atlases**; per-atlas distinct-rect guard; counts cross-sheet duplicate copies + exact recoverable area.
- **VRAM = `recoverableArea × 4`, EXACT (identical precedent to rules.ts:232).** No POT-tier gate, no `pack()`, no inline sizer, no `vramClaimed` branch.
- **Disk = per-copy area-proportional ESTIMATE** attributed to each freed copy's own atlas; carried in finding only; NEVER folded into `potentialDiskSaved`.
- New `Rule` id `'cross-atlas-redundancy'`; new `crossAtlasRedundancy?: { minDuplicates }` config; new `find.cross-atlas-redundancy.*` keys in all 9 catalogs.
- NO `overlay` (folder finding, single-page overlay model — copy the relatedRefs pattern, NOT the within-atlas overlay block).

### Scope (OUT)
No fix/generation (inv 3). No CLI opt-in (browser-only, not in `resolveThresholds`). No multi-page overlay. No change to within-atlas rule or worker (worker already passes `frameHashes` for all atlases). **No `@asset-doctor/fix` package edge** (resolved by exact-area VRAM).

### Core contract (`packages/core/src/index.ts`)
- Append to `Rule` (after `'trim-margin'`): `| 'cross-atlas-redundancy'`.
- Add `crossAtlasRedundancy?: { minDuplicates: number }` to `ThresholdConfig` with JSDoc: gate counts **cross-sheet duplicate copies** (≥2 ⇒ frame recurs on ≥2 sheets); VRAM = exact duplicate-region area × 4; disk = per-copy area estimate never folded into totals (inv 5); browser-only, NOT in `resolveThresholds`; orthogonal to atlas-merge (dup-frame px vs empty px). No new finding/estimate/overlay shape.

### Config (`config.ts`)
`crossAtlasRedundancy: { minDuplicates: 2 }` — fires when a frame recurs on ≥2 sheets. Calibration comment: lower than within-atlas (cross-sheet recurrence has no in-sheet-aliasing excuse).

### Pure rule (`folder.ts`) — algorithm
1. `if (!cfg.crossAtlasRedundancy) return null;`
2. Build per-atlas `allFrameArea` (Σ frame areas) for atlases whose hash entry length === sprite count (length-mismatch ⇒ skip that atlas only). Flatten `{atlasName, spriteIndex, hash, rect}`, skipping `null` hashes.
3. Cluster by hash. Per cluster: require **≥2 distinct atlases** (single-atlas clusters skipped — within-atlas rule owns them). Per-atlas distinct-rect collapse (alias guard). `distinctUnits = Σ distinctRectsPerAtlas`. Gate `distinctUnits ≥ cfg.crossAtlasRedundancy.minDuplicates`. Keep ONE representative cluster-wide (lowest `(atlasName, spriteIndex)`); freed copies = all other distinct rects. `recoverableArea += Σ(freedRectArea)`; `dupes += (distinctUnits − 1)`. Collect member names → `refs`, atlas names → `atlasRefs`.
4. `if (dupes < 1) return null;`
5. Determinism: clusters processed by lowest `(atlasName, spriteIndex)`; `refs.sort()`; `atlasRefs.sort()`. Pure integer math; no Date/random; Map order not load-bearing (all outputs sorted).
6. **VRAM:** `estimate.vramBytesSaved = recoverableArea × 4` (exact).
7. **Disk:** for each freed copy, `diskEstimate += byteByRef.get(member.atlas) × memberRectArea / allFrameArea[member.atlas]` (guard each `allFrameArea > 0` and byteSize present, else skip that copy). `Math.round` the total.
8. Emit `{ id:'folder:cross-atlas-redundancy', rule:'cross-atlas-redundancy', severity:'warn', scope:'folder', assetRef: atlasRefs[0], relatedRefs: refs, messageKey:'cross-atlas-redundancy', params:{ dupes, groups, sheets: atlasRefs.length, refs: refs.join(', '), vram: recoverableArea*4, area: recoverableArea, disk: diskEstimate } }`. NO `overlay`.

Export from `analysis/src/index.ts`.

### `analyze.ts` wiring
After `atlasMergeFinding` (line 237-238): build `byteByRef` in the per-asset atlas branch (insert `byteByRef.set(atlas.name, image.byteSize)` near line 158 where `image.byteSize` is in scope), then:
```ts
const car = crossAtlasRedundancyFinding(atlases, frameHashByRef, byteByRef, cfg);
if (car) folder.push(car);
```
Import into the `./folder` block (line 39-47). `potentialDiskSaved` UNCHANGED (disk estimate not folded — inv 5).

### i18n (`en.json` source + 8 mirrors)
Three keys `find.cross-atlas-redundancy.{title,detail,fix}` after the trim-margin block. Plural `$count: "dupes"`. Detail discloses VRAM as the reclaimable **duplicate-frame** area (not generic "merge"), disk as "~{disk} (area estimate)". Baked `folder.ts` strings byte-identical to en template. `messageKey` MUST be `'cross-atlas-redundancy'` (distinct from within-atlas). Mirror into ru/de/es/pt/fr/it/zh/hi (identical placeholders + plural objects); `catalogs.test.ts` enforces 9-locale parity.

### Honesty/invariants
- **Inv 3:** measures the cross-sheet duplicate set + exact reclaimable area; emits no pixels.
- **Inv 5:** VRAM = exact area×4 (not a bin-tier delta — cannot over-claim); disk = estimate, never in totals.
- **Inv 1/2:** browser-only (no `resolveThresholds`); reuses already-computed `frameHashes` (zero new decode).
- **Inv 4:** O(total sprites) clustering off precomputed hashes; sub-ms.
- **Orthogonal to atlas-merge:** reclaims duplicate-frame px, not empty px (documented).
- **Honesty pin:** `dupes = Σ(distinctUnits − 1)` = the exact `framesAliased` a future cross-atlas fix would report (JSDoc'd).

### Edge cases
<2 atlases with hashes ⇒ null. Single-atlas cluster ⇒ skipped (no double-report). Per-atlas length-mismatch ⇒ that atlas excluded, others compared. All-null hashes ⇒ null. Pre-aliased rects ⇒ collapse per atlas. Loose refs with a stray hash entry ⇒ never matched (`atlases` holds only parsed atlases). Missing/zero `allFrameArea` or byteSize for an atlas ⇒ that copy's disk skipped, VRAM/area still reported.

### Test plan
**A. Pure unit (`analysis.test.ts`, new describe):** (1) two atlases share one hash on a distinct rect each ⇒ `dupes:1, groups:1, sheets:2`, exact `area`, sorted cross-sheet `relatedRefs`, **assert `!== null`, `severity:'warn'`, AND `messageKey === 'cross-atlas-redundancy'`** (BLOCKER 1 guard). (2) single-atlas cluster ⇒ null. (3) three atlases ⇒ `dupes:2, sheets:3`. (4) pre-aliased rect in one sheet ⇒ collapses. (5) <2 atlases / length-mismatch / all-null / no config ⇒ null. (6) **VRAM = recoverableArea×4 exactly** (assert the number, confirming no bin-tier inflation). (7) disk attributed per freed-copy atlas; guarded on missing byteSize.
**A-wiring (`analysis.test.ts`):** feed two atlas assets + cross-atlas `frameHashes` to `analyze()`; assert the folder finding appears AND `report.totals.potentialDiskSaved === baseline` (disk not folded). CONFIRM FIRES via `analyze()`.
**B. Drift guard (`render.test.ts`):** push `crossAtlasRedundancyFinding(...)!` into `realFindings()`, add `'cross-atlas-redundancy'` to the asserted key Set (line 83). Forces en byte-parity + ru brace-free render. `catalogs.test.ts` auto-covers 9 locales.
**C. Real-decode e2e (`perceptual.test.ts`):** new fixture `fixtures/sample-projects/cross-atlas-redundant/` (two TEXTURED sheets sheetA/sheetB + manifests + `expected.json`) where a textured (clears flat-guard) frame is byte-identical across both. Read both PNGs → run REAL `hashFrameRegions` (production `extractFrameRegions`→SHA) per sheet → build `frameHashByRef` + `byteByRef` → `parseAtlas` both → call the rule → **CONFIRM FIRES `warn` with expected `area`/`vramBytesSaved`**. Reproduces the defect through production decode. Use `make-fixture`; sheets MUST be textured (flat-guard trap, documented in within-atlas fixture README).

### Ordered task breakdown (small commits)
1. **core contract** — `Rule` += `'cross-atlas-redundancy'`; `ThresholdConfig.crossAtlasRedundancy?` + honesty JSDoc (gate = cross-sheet copies; exact-area VRAM; disk-estimate; browser-only; orthogonal to atlas-merge).
2. **config** — `crossAtlasRedundancy: { minDuplicates: 2 }` + calibration comment.
3. **pure rule** — `crossAtlasRedundancyFinding` in `folder.ts` (≥2-atlas guard; per-atlas distinct-rect collapse; **exact-area VRAM**; per-copy per-atlas disk estimate; NO overlay, NO `pack` import); export from index.
4. **pure unit tests** — §A(1–7); assert FIRES + `messageKey` value + exact VRAM.
5. **wire analyze** — `byteByRef` map (near line 158) + call beside `atlasMergeFinding`; A-wiring test (FIRES + `potentialDiskSaved` unchanged).
6. **i18n en** — three keys; extend `render.test.ts` drift guard; CONFIRM baked==en byte-parity.
7. **i18n 8 locales** — mirror keys (translated; placeholders+plural identical); `catalogs.test.ts` green ×9.
8. **fixture + e2e** — `cross-atlas-redundant/` two textured sheets (`make-fixture`) + `expected.json`; real-decode e2e in `perceptual.test.ts`; CONFIRM defect reproduces + FIRES through production code.
9. **docs** — `docs/CHANGELOG.md` + `docs/FEATURES.md`; note `detector.dupes === fix.framesAliased` honesty pin; note orthogonality to atlas-merge.

**No open coordination decision remains** — exact-area VRAM removes the `@asset-doctor/fix` dependency question entirely (BLOCKER 2 resolution). Layering stays clean (analysis depends only on core).

### Key files
`/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` (Rule block + `frameRedundancy` JSDoc precedent ~line 564; `AtlasFrameHashes` line 381), `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/folder.ts` (new rule beside `atlasMergeFinding`:138), `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/rules.ts` (`frameRedundancyFinding`:171-270 — the exact-area VRAM precedent at line 232), `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/analyze.ts` (`frameHashByRef`:119-120, `image.byteSize`:158, wire:237-238), `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/config.ts`, `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json` (template:105-126), `/home/nonamezzz/Рабочий стол/projects/packages/analysis/test/analysis.test.ts` (frame-redundancy describe:453), `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/render.test.ts` (drift guard:80-83), `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/perceptual.test.ts` + `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/perceptual.ts` (`hashFrameRegions`:245, `extractFrameRegions`:219), new fixture `/home/nonamezzz/Рабочий стол/projects/fixtures/sample-projects/cross-atlas-redundant/`.