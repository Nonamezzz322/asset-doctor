This confirms the §8 scheduling gap precisely: `plan.ts` emits a `repack` op only for `occupancy`, `wasted-regions`, `frame-redundancy`, and `atlas-merge` findings. There is **no `trim-margin → repack` branch**. The draft's §8a (free-rider) is therefore correct as a v1 boundary, and §8b is the real value-uncapping follow-on.

I now have all the evidence needed. Let me do two final verifications: (1) that `framesAliased` precedent for the `framesAliased` flow through i18n `t()` confirms my plan for the new key works the same way, and (2) the precise behavior at the merge path's `composePageEncode` filter — since blits are filtered by `naNames.has(b.name)`, and `to`/`from.rect` carry the trim — to confirm trim composes correctly in merge. The compose at line 1795 uses `r.blits.filter((b) => naNames.has(b.name))` and `composePageEncode` does `drawImage(bmp, from.rect.x/y/w/h, to.x/y/w/h)` — fully general, so an inset `from.rect` composes correctly. Confirmed by reading lines 1273-1283.

I have enough to write the revised design.

---

# Trim-on-repack FIX — Revised Mini-Design (adversarially verified)

## Verdict: PREMISE TRUE, design SOUND with corrections. Ship it.

Every load-bearing claim verified against code. The fix is real: `repack.ts:105/137/141-142` copies frames verbatim (a repack reclaims **zero** of the trim-margin detector's promised area), the detector is detection-only (`rules.ts:291`, no `trim-margin → repack` branch in `plan.ts`), and the fixture's 7200px recoverable area is arithmetic-confirmed (3072+2336+1792). Below are the blockers/majors I found, each with a code-grounded fix folded into the revised spec. The ordered task breakdown is preserved.

---

## BLOCKERS (must fix before coding)

### B1 — `resolveTrim` does NOT replicate the detector's `minMarginPx` gate ⇒ honesty drift between detector and fix
`trimMarginFinding` (`rules.ts:346`) **skips** a sprite whose largest single-side margin `< cfg.trimMargin.minMarginPx` (default 4). The draft's `resolveTrim` eligibility is only `bbox strictly smaller than frame`. Consequence: the fix would trim sprites the detector **did not** count, so `trimmedAreaReclaimed` can **exceed** the detector's promised `recoverableArea`, and §9.2 step 5 (`after.trimmedAreaReclaimed === expected.recoverableArea === 7200`) **will fail** if any non-qualifying-but-shrinkable sprite exists. (In *this* fixture all three padded sprites clear minMarginPx=4, so 7200 happens to match — but the assertion is asserting an accidental equality, not an invariant.)

**Decision (honest + simple):** trimming a 1px margin is still a *correct, non-destructive* shrink — it is not dishonest to trim more than the detector advertised (the detector says "up to", `rules.ts:374` copy). But the **receipt's** `trimmedAreaReclaimed` then is NOT the detector's number. Two correct options:
- **B1a (chosen):** trim ANY shrinkable untrimmed sprite (no minMarginPx gate in the fix) — maximal honest win — and **change the §9.2 assertion** to `after.trimmedAreaReclaimed >= expected.recoverableArea` (the fix reclaims *at least* what the detector promised) AND add an exact per-sprite assertion (`packedSize === bbox` for each padded sprite). The receipt copy must say "reclaimed N px" (measured), never "the detector's N".
- **B1b:** mirror `minMarginPx` in `resolveTrim` so fix === detector exactly. Rejected: it leaves real reclaimable margin on the table for no honesty gain (trimming is always correct).

Either way, **the draft's claim "`trimmedAreaReclaimed === expected.recoverableArea` proves the detector's number is realized" is only valid when every shrinkable sprite also clears minMarginPx.** Spec the assertion as `>=` + exact per-sprite golden.

### B2 — Alias interaction is UNDERSPECIFIED and the draft's reasoning is partly WRONG for the within-atlas alias guard
The draft asserts "byte-identical frames have identical opaque bounds, so the rep's tight rect is the alias's tight rect." **True for pixels.** BUT: in `repackAtlases`, a non-representative alias is NOT pushed into `items` (`repack.ts:107-113`) and its sprite is emitted from the **alias's own** `frame`-derived metadata at the rep's final rect (`repack.ts:148-153`). The alias keeps its own `sourceSize`/`spriteSourceSize`. If the alias is itself **untrimmed** (`spriteSourceSize===undefined`, `trimmed===false`) and we trim the **rep**, then:
- The rep's packed rect is now `bbox.w × bbox.h` (tight).
- The alias sprite is emitted at that tight rect (`p`) but with `trimmed:false`, `sourceSize: alias.sourceSize` (the FULL frame), and **no** `spriteSourceSize`. **This is a BROKEN manifest**: a sprite declared untrimmed (`spriteSourceSize` absent ⇒ engine assumes frame === full source) whose `frame` is now smaller than `sourceSize`. The engine renders the alias at the wrong size/offset.

**Fix (mandatory):** when the rep is trimmed, **every alias sharing that rep's rect must inherit the rep's trim metadata** (`trimmed:true`, `sourceSize:` the rep's full size, `spriteSourceSize:`/offset via the rep's bbox). Because the pixels are byte-identical, the rep's bbox IS the alias's correct trim. This requires `repack.ts` to apply `tr` (the resolved trim) to the **alias emit branch** (`repack.ts:148-153`), not only the representative branch. The draft's §3.1 "we do NOT recompute alias trims; aliases keep verbatim" is **incorrect** and produces an invalid manifest. Spec: alias inherits the rep's `tr` when `tr.trimmed`.

### B3 — The `extrudeVramDelta` baseline calls MUST receive `trim` — the draft says so but the consequence is sharper than stated
At `:1655` (Spine) and `:1938` (rect/merge), the no-gutter baseline re-packs to isolate the gutter's VRAM growth. If the **main** pack ships with `trim` but the baseline omits it, the baseline sheet is LARGER (untrimmed), so `r.vramBytesAfter − baseline.vramBytesAfter` goes **negative** (trim shrank the main pack below the untrimmed baseline) ⇒ `extrudeVramDelta` is wrong-signed and the honesty readout lies. The draft flags this in §7 but buries it; it is a **blocker**: both baseline calls MUST pass the identical `trim`/`trimAsSpineOffset` so the delta isolates ONLY the gutter. (Confirmed: `:1655` and `:1938` both currently re-call `repackAtlases(..., {no gutter}, aliasMaps)`.)

---

## MAJORS

### M1 — Spine `sourceSize` field for an untrimmed Spine region: verify `orig` semantics
`emitSpineAtlasText:46` writes `orig: ${s.sourceSize.w}, ${s.sourceSize.h}` and `offset: ${s.spriteSourceSize?.x ?? 0}, ${s.spriteSourceSize?.y ?? 0}`. For a trimmed Spine region the emitter writes `size:` as the (rotated) **frame** extent (`:44-45`) and `orig` as `sourceSize`. So after trim: `frame = bbox` (tight), `sourceSize = full`, `spriteSourceSize.x/y = spineOffsetFrom(...)`. The draft's `resolveTrim` for the Spine branch builds `spriteSourceSize` as `{...spineOffsetFrom(sourceSize,bbox), w:bbox.w, h:bbox.h}` — but `emitSpineAtlasText` only reads `.x/.y` of `spriteSourceSize` (`:46`), never `.w/.h`. Fine — the `w/h` are inert for Spine emit but **must still be set** because `manifest.ts` (TP) path and any re-parse read them. Confirmed harmless. Keep as drafted. (Note for implementer: do NOT also flip in the emitter — `trim.ts:57-66` is the single flip site; emitter writes verbatim.)

### M2 — The bbox cache is computed by `OffscreenCanvas` per-frame; the detector computes it off the WHOLE page. Convention match is correct but the FIX recomputes work the analyze pass already did
`analyze.worker.ts:258` already computed `bboxes` for the diagnosis (`alphaBBox(src, {x:frame.x,...})` over the full-page buffer). The fix worker (`fix.worker.ts`) is a **separate worker** with no access to that array (the FixPlan carries findings, not raw bboxes — confirmed `analyze.ts:122` keys them per-atlas but they're not threaded into the plan). So the draft's `extractFrameBBox` (re-decode per frame in the fix worker) is **necessary**, not redundant. BUT: the draft draws each frame to its own `frame.w×frame.h` canvas (`alphaBBox` over `{0,0,frame.w,frame.h}`), whereas analyze draws the whole page once and slices. Both yield **frame-relative top-left** bboxes — conventions match (verified). Acceptable. Minor efficiency note: prefer extracting all frames from ONE page decode (mirror `hashAtlasFrames`) to avoid N canvases per atlas; not a blocker.

### M3 — `:bytes` / raw-int formatter for the new i18n key
The new `fix.trimmedOnRepack` uses `{area}` (raw int) + `{before:bytes}`/`{after:bytes}`. Confirmed `:bytes` is a supported hint (`i18n/src/index.ts:3`). `{area}` with no hint interpolates the raw number via the default path — matches `frame-redundancy`'s `{area}` usage in the detector params. OK. The drift test bakes `en` as source; all 9 catalogs must add the key with identical `{...}` tokens or the drift test fails. The i18n-app-keys guard (`i18n-app-keys.test.ts:44`) scans `App.tsx` for `t('fix.trimmedOnRepack'`) — the new App.tsx line satisfies it. OK as drafted.

### M4 — `params.sprites` vs `qualifying`: fixture golden naming
The detector emits `params.sprites` (`rules.ts:395`), and the existing E2E asserts `finding.params?.sprites` (`perceptual.test.ts:578`). The draft's §9.2 step 6 reads `expected.qualifying.length` from `expected.json` (the array `["padded_0","padded_1","padded_2"]`, length 3) — that's a fixture field, fine. No conflict. Keep the new `repack` golden section additive; do NOT touch existing keys (the detector test at `:543-582` must stay green).

---

## CONFIRMED-CORRECT premises (no action)
- `composePageEncode` (`:1273-1283`) does a fully-general `drawImage(bmp, from.rect.x/y/w/h, to.x/y/w/h)` ⇒ an inset `from.rect` composes correctly with **no worker compose change**. ✓
- Merge path filters blits by name (`:1796`) then composes ⇒ trim survives merge. ✓
- `polygonWins` (`:260-261`) compares `vramBytesAfter`; feeding `trim` to the rect baseline (`:1728`) makes the gate honest (polygon must beat a *trimmed* rect). ✓ — and if poly loses, the trimmed rect ships. ✓
- Parser sets `spriteSourceSize` only when trimmed (`atlas.ts:104`, `spine-atlas.ts:101`) ⇒ the `s.trimmed===false && !s.spriteSourceSize` gate is sound. ✓
- `aliasMaps` built at `:584-591`, threaded into all 5 repack calls. The new `trim` arg is index-aligned to `atlas.sprites` (same indexing aliasMaps' `repOf` uses) ⇒ they compose. ✓ (modulo B2)
- Null bbox ⇒ verbatim on the repack path (never 1×1 sentinel) is correct: the loose-pack path can sentinel a fully-transparent loose image, but repack must preserve every existing region's geometry. ✓
- Determinism: `alphaBBox` integer-only (`trim.ts`), `POLY_ALPHA_THRESHOLD=1` single compare, pack sort unchanged, no Date/random. ✓

---

## POST-REVIEW carve-outs to the `>= recoverableArea` claim (round20 adversarial review, RESOLVED in code)

Two reachable cases make the fix's MEASURED `trimmedAreaReclaimed` STRICTLY LESS than the detector's promised `recoverableArea`. Both are resolved by documenting an explicit carve-out (option (a)) — simplest, deterministic, and the production code stays honest (it reports the measured number, never asserts `>=`). The E2E `>=` assertion holds on the `untrimmed-padding` fixture because that fixture has NO rotated and NO fully-transparent untrimmed frames.

- **[0] Rotated untrimmed sprite — FIXED in `repack.ts` (`resolveTrim` bails on `s.rotated`).** A `rotated:true` sprite's on-page `frame` holds ROTATED pixels (w/h swapped) while `sourceSize` is the UNrotated source size. `alphaBBox` measures over the rotated frame ⇒ `bbox` is in rotated coords, but `spriteSourceSizeFrom`/`spineOffsetFrom` (Spine offset = `sourceSize.h − (bbox.y+bbox.h)`) treat it as unrotated source coords ⇒ a BROKEN manifest (wrong inset/offset, sprite renders at the wrong size/position). v1 keeps source orientation (rotate90 always false) and packs rotated sprites verbatim, so trimming them is out of v1 scope. `resolveTrim` now returns null for rotated sprites; the receipt honestly reports the smaller reclaim. The DETECTOR (`rules.ts`) keeps counting rotated untrimmed sprites — its VRAM/disk figures are pure area arithmetic and rotation-INVARIANT (a genuine reclaimable measurement that a future rotation-aware fix could realize), so it stays an honest "up to" upper bound; this v1 fix simply realizes less of it for rotated sprites. (Uncommon: TP normally rotates only ALREADY-trimmed sprites, which `resolveTrim`'s first guard already excludes.)
- **[1] Fully-transparent untrimmed frame — DOCUMENTED carve-out in `repack.ts` (`resolveTrim` null-bbox branch).** `bbox===null` (no opaque pixel) ⇒ pack VERBATIM at the full frame (repack must keep every region resolvable; a 1×1 sentinel would change geometry / break drop-in). The detector counts such a frame as `recoverableArea += FULL frameArea` (per-side gate bypassed). So for an atlas whose trim-margin finding includes a fully-transparent untrimmed frame, MEASURED reclaim < detector's number for that frame. This is a documented carve-out, not a dishonest claim: the receipt reports only the measured reclaim. (Degenerate case: zero visible art.)

---

## REVISED contract deltas (only the corrected bits; rest as drafted)

`packages/fix/src/repack.ts`:
- `RepackOptions.trim?: ((TrimRect|null)[])[]` + `trimAsSpineOffset?: boolean` — as drafted.
- `resolveTrim` — as drafted, **B1a:** no `minMarginPx` gate (trim any shrinkable untrimmed sprite). Eligibility `s.trimmed===false && s.spriteSourceSize===undefined && bbox!=null && bbox.w>0 && bbox.h>0 && (bbox.w<frame.w || bbox.h<frame.h || bbox.x>0 || bbox.y>0)`.
- **B2:** apply `tr` to BOTH the representative emit (`:135-144`) AND the alias emit (`:148-153`). The alias inherits `tr.trimmed/sourceSize/spriteSourceSize` (rep's bbox = alias's bbox by byte-identity). The alias's `frame` is already the rep's tight `p` rect. No second Blit (pixels written once by the rep, which already blits the inset sub-region).
- `RepackResult.trimmedSprites?` / `trimmedAreaReclaimed?` — as drafted (count + Σ(frameArea − bboxArea), increment only when `tr.trimmed && !s.trimmed`; count each aliased name that inherits a trim? **No** — count DISTINCT trimmed packed rects (representatives) to mirror the detector's distinct-rect guard; aliases inherit but are not re-counted).

`fix.worker.ts`: as drafted PLUS **B3** — pass `trim`(+`trimAsSpineOffset`) to the no-gutter baseline calls at `:1655` and `:1938`.

`fix-protocol.ts` / `App.tsx` / i18n: as drafted (M3 OK).

---

## ORDERED TASK BREAKDOWN (preserved, with corrections inlined)

1. **core contract** — `RepackResult.trimmedSprites?` + `trimmedAreaReclaimed?` (`packages/core/src/index.ts`). Typecheck only. _(feat(fix): RepackResult carries trim-on-repack counts)_
2. **repack.ts trim** — `RepackOptions.trim?`+`trimAsSpineOffset?`; import `TrimRect`/`spriteSourceSizeFrom`/`spineOffsetFrom`; `resolveTrim` (B1a, no minMargin gate); wire packed-size/inset-blit/emitted-metadata/accumulators in `repackAtlases` for BOTH representative AND **alias** emit (B2); count distinct trimmed reps. Polygon untouched. _(feat(fix): trim-on-repack — tighter pack + inset blit + spriteSourceSize/offset, alias-correct)_
3. **pure tests** — `repack.test.ts`: TP trim, Spine-offset (assert Y-flip), **alias rep+untrimmed-alias inherits rep trim** (B2 regression — assert alias emits `trimmed:true`+correct `spriteSourceSize`, NOT broken untrimmed-with-smaller-frame), null/full-frame/already-trimmed verbatim, `trim` absent ⇒ byte-identical (regression pin). _(test(fix): pure trim-on-repack coverage incl. alias inheritance)_
4. **fixture golden** — extend `untrimmed-padding/expected.json` with additive `repack: { trimmedSprites:3, trimmedAreaReclaimed:7200, perSprite:[{name,packedSize,spriteSourceSize}] }`; leave detector keys untouched. _(test(fix): golden repack expectations)_
5. **E2E real decode/pack** — new `describe` in `perceptual.test.ts`: decode PNG → `alphaBBox` per frame → `repackAtlases({trim})`; assert **`after.trimmedAreaReclaimed >= expected.recoverableArea`** (B1a) AND exact per-sprite `packedSize===bbox`; `after.vramBytesAfter < before.vramBytesAfter`; **parser round-trip** (`emitTexturePackerJson`→`parseAtlas`→`spriteSourceSize===spriteSourceSizeFrom`, `sourceSize===full`); **pixel round-trip** (blit inset over the decoded buffer, re-read region === original opaque core). _(test(fix): trim-on-repack reproduces+realizes the defect E2E)_
6. **worker wiring** — `extractFrameBBox` + `buildTrimArrays` (skip already-trimmed → null without decode; M2 single-page-decode preferred); feed `trim`(+`trimAsSpineOffset`) into the 3 rect call-sites (`:1595`,`:1728` rect-baseline,`:1750`) AND the 2 no-gutter `extrudeVramDelta` baselines (`:1655`,`:1938`, **B3**); accumulate `trimmedSpritesTotal`/`trimmedAreaTotal`; extend operations strings (`:1665`,`:1898`,`:1917`); add receipt fields (`:3493` block). _(feat(fix): worker computes per-sprite bboxes + feeds repack trim, gutter-baseline-correct)_
7. **protocol + UI** — `FixReceipt.trimmedSprites/trimmedAreaReclaimed`; `App.tsx` receipt line after the `framesAliased` block (`:1854`). _(feat(web): surface trim-on-repack in the receipt)_
8. **i18n** — `fix.trimmedOnRepack` (en source + 8 locales, identical tokens); drift + app-keys guards green. Receipt copy says "reclaimed {area} px" (MEASURED, never "the detector's"). _(feat(i18n): trim-on-repack receipt line, 9 langs)_
9. **worker test + docs** — `fix.test.ts`: construct a `kind:'repack'` FixOp directly over the untrimmed atlas (plan.ts won't schedule one — §8a confirmed), assert receipt carries `trimmedSprites/trimmedAreaReclaimed` and emitted frames tightened; `docs/CHANGELOG.md` + `docs/FEATURES.md`; `pnpm test`/`typecheck`/`lint`. _(test+docs: trim-on-repack)_

---

## §8 scheduling gap — CONFIRMED, decision stands
`plan.ts` emits `repack` ONLY for `occupancy`/`wasted-regions`/`frame-redundancy`/`atlas-merge` (verified `:262`,`:297`,`:324`; no `trim-margin` branch). A fully-packed atlas whose ONLY finding is `trim-margin` gets **no repack op** ⇒ **no fix** in v1. Ship **8a (free rider)** per the brief's "in the worker repack op" scope; the §9.3 worker test MUST construct the FixOp directly (it cannot rely on the plan). File **8b** (`trim-margin → repack` branch in `plan.ts`, gated on `recoverableArea` threshold) as the immediate follow-on — without it the realized value is capped to atlases that already repack for another reason. Flag this to the team explicitly; it is the single biggest value lever and is genuinely out of the stated v1 scope.

---

## Net
Premise true, fix is real and honest. Three blockers (B1 assertion-soundness/no-minMargin-gate, **B2 alias-trim-inheritance — the one that produces a BROKEN manifest if missed**, B3 gutter-baseline sign), four majors handled. The corrected E2E (`>=` + exact per-sprite + parser/pixel round-trip) is the load-bearing proof that the detector's promise is realized through the real decode→pack→compose path. Proceed with the revised breakdown.