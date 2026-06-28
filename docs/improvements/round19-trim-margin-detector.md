I now have everything needed. Let me consolidate the analysis. The premise is **largely sound** — the gap is real, the architecture mirror is accurate, the honesty framing is correct. But there are a few genuine issues to fix, and one premise overstatement to correct.

Let me verify the one remaining concern: whether `extractFrameRegions` already nulls flat regions, which interacts with the trim detector's "fully transparent frame" handling, and the worker's two-decode cost claim.

The worker calls `hashAtlasFrames` which uses `extractFrameRegions`. The trim detector wants the bbox of EACH sprite, including ones the flat-guard nulls. A fully-transparent or single-textured-core sprite region that box-averages flat would get `null` from `extractFrameRegions`. But `alphaBBox` is a separate computation — the design proposes a *separate* `alphaBBox` loop over the same `page` buffer, not reusing `extractFrameRegions`'s output. That's correct and consistent. Good.

I have enough to write the revised design.

---

# ARCHITECT (REVISED) — Per-atlas trim-margin detector

## Verdict: PREMISE LARGELY TRUE — proceed, with corrections

I verified every load-bearing claim against the real code. The gap is real, the architecture mirror is accurate, and the honesty framing is sound. But the draft contains **one false premise** (the "load-bearing correctness gate" is redundant, not two-pronged), **two majors** (rotated-sprite bbox math is wrong as stated; the worker decode is NOT zero-cost — it's a real second decode), and **several minors**. All are fixed below. Scope holds; the ordered task breakdown is kept.

---

## VERIFIED claims (rebuttals to my own skepticism)

- **The gap is real.** `repack.ts:96` and `:159` copy `frame: { x: p.x, y: p.y, w: p.w, h: p.h }` from the *placed* dims and copy `trimmed`/`sourceSize`/`spriteSourceSize` verbatim. An `trimmed:false` sprite's transparent padding survives a repack. CONFIRMED.
- **`alphaBBox` is exactly as described** — pure, integer-only, threshold `POLY_ALPHA_THRESHOLD`=1, returns `null` for a fully-transparent region, top-left origin (`trim.ts:27-44`). Exported from `@asset-doctor/fix` index. CONFIRMED.
- **`apps/web` already depends on `@asset-doctor/fix`** (the fix worker imports it; it's pure/worker-safe). Adding the import to `analyze.worker.ts` is fine. CONFIRMED.
- **The contract-threading mirror is accurate.** `frameHashes` flow exactly as described: computed in-worker, passed to `analyze()` via deps, NOT across the postMessage protocol. `analyze.ts:111-112` and `:160-164` match the draft. CONFIRMED — `protocol.ts` needs no change.
- **`OverlayZone` kind `'transparent'` exists and FilmViewer paints it yellow** with a `rects` loop (`FilmViewer.tsx:9, 73`). No FilmViewer change. CONFIRMED.
- **Disk-not-folded honesty has direct precedent** (`analyze.ts:160-164` deliberately omits frame-redundancy's disk estimate from `potentialDiskSaved`). CONFIRMED.

---

## BLOCKER — none. The feature is buildable and honest.

## MAJOR 1 — Rotated-sprite bbox math is WRONG as written (honesty/correctness)

The draft's §7 claims "no special-casing" for rotated sprites because "`alphaBBox` runs over the placed (rotated) region the host reads, so the bbox is in placed-rect space — area math is correct regardless of rotation." **The area sum is correct, but the OVERLAY rects are wrong, and the per-side margin gate is subtly wrong.**

When `sp.rotated === true`, the on-page region IS the rotated pixels, so `alphaBBox` over `{x:frame.x, y:frame.y, w:frame.w, h:frame.h}` gives a bbox in placed (rotated) space. Recoverable **area** = `frame.w*frame.h − bbox.w*bbox.h` is invariant under 90° rotation, so VRAM is honest. **But:**
- The 4 border-strip overlay rects computed in placed space and translated by `frame.x/frame.y` ARE correct (they're drawn on the placed page) — so overlay is actually fine.
- The risk is the *gate* `margin = max(b.x, b.y, frame.w-(b.x+b.w), frame.h-(b.y+b.h))`: this is a per-side reading in placed space, which is fine as a "largest single-side border" heuristic regardless of rotation.

**Re-verdict: the math holds; the draft's *justification* is sloppy but the conclusion is correct. DOWNGRADE to a doc-comment fix.** Add a one-line comment: "area + per-side margin are rotation-invariant; overlay strips are in placed-page space, drawn correctly." No code special-casing. This is a rebuttal — keep the no-special-case approach but state WHY precisely.

## MAJOR 2 — The worker decode is NOT zero-cost; the draft oversells inv-4

The draft repeatedly says "**zero extra decode cost**" / "runs off that SAME page buffer." This is **TRUE only if the trim bboxes are computed inside `hashAtlasFrames`'s existing decode**, reusing the SAME `page = c2d.getImageData(...)` buffer (`analyze.worker.ts:232`). The draft's §8 option (A) does propose this — good — but the prose elsewhere ("zero extra decode") is only honored if you take option (A) AND share the buffer.

**Hard requirement (not optional):** trim bboxes MUST be computed in the SAME loop, off the SAME `page` ImageData, as the frame hashes. A second `createImageBitmap` + `getImageData` per page would DOUBLE the heaviest cost in the worker and threaten inv-4 (≤10s) on large folders. The decode is already "a NEW decode — owned cost, same magnitude as the main-thread FilmViewer decode" (worker comment line 119-121); piggybacking on it is genuinely free, a fresh decode is not.

**Concrete fix:** refactor `hashAtlasFrames` to return `{ hashes: (string|null)[]; bboxes: (TrimRect|null)[] } | null`. After `const page = c2d.getImageData(...)` (line 232), run BOTH `extractFrameRegions` (existing) AND a new bbox loop over `page` via `alphaBBox`. Caps: the bbox loop reuses the SAME `FRAME_HASH_MAX_PX`/`FRAME_HASH_MAX_SPRITES` early-out (`extractFrameRegions` returns `null` ⇒ skip the whole page for BOTH).

## MAJOR 3 — Two contracts (`AtlasFrameHashes` + `AtlasFrameTrims`) for the SAME page is wasteful; merge consideration

Since the bboxes are computed in the SAME loop, keyed by the SAME `atlasRef`, index-aligned to the SAME sprite list, threaded through the SAME `analyze` deps — emitting them as a **separate** `AtlasFrameTrims[]` array duplicates the per-atlas keying. **However**, keeping them separate is defensible: (a) it mirrors the established `frameHashes`/`features` separation, (b) headless callers may supply one without the other, (c) merging would force the frame-redundancy rule to depend on trim data it doesn't use. **Re-verdict: keep separate (the draft's choice), but the worker MUST build both from one decode pass.** This is a rebuttal — the draft's contract split is fine; only the decode must be shared. Documented as such.

## MAJOR 4 (was the draft's "critical correctness gate") — the gate is REDUNDANT, not two-pronged (false premise)

The draft calls `sp.trimmed === false && sp.spriteSourceSize === undefined` "the load-bearing correctness gate" and presents the two conjuncts as independent safety. **They are equivalent by parser construction:**
- `atlas.ts:101-104`: `trimmed = body.trimmed === true`; `spriteSourceSize` set ONLY `if (trimmed && sss)`. So `trimmed===false ⇒ spriteSourceSize===undefined`, and a present `spriteSourceSize ⇒ trimmed===true`.
- `spine-atlas.ts:98-101`: `trimmed = sourceSize.w!==w || sourceSize.h!==h`; `spriteSourceSize` set ONLY `if (trimmed)`. Same equivalence.

**So `sp.trimmed === false` ALONE is the gate; the second conjunct is always true when the first is.** Keeping both is harmless belt-and-braces for hand-built headless callers (the rule re-checks), but the design must NOT claim it's a two-signal correctness net — that's a false premise. **Fix:** gate on `sp.trimmed === false` as the primary; keep `&& sp.spriteSourceSize === undefined` ONLY as a defensive guard against a malformed hand-supplied sprite, documented as redundant-by-parser-construction, NOT as independent safety.

**Deeper correctness point this exposes:** an `trimmed:false` sprite has `sourceSize === {frame.w, frame.h}` (parser default at `atlas.ts:100` / spine `:97`). So the frame IS the full untrimmed image. `alphaBBox < frame` ⟺ there is genuine transparent padding. The gate is therefore *exactly* "untrimmed sprite with reclaimable padding" — correct.

## MINOR 1 — `imageByteSize` plumbing already exists; confirm the call site

The draft's `trimMarginFinding(atlas, cfg, frameTrims, imageByteSize)` needs `image.byteSize`, available at `analyze.ts:134` (`const { atlas, image } = asset`). The frame-redundancy sibling already passes `image.byteSize` (`:162`). No new plumbing. CONFIRMED — fine.

## MINOR 2 — Severity tier: `warn` is defensible but VERIFY against frame-redundancy precedent

The draft picks `warn`. Frame-redundancy is `warn` (`rules.ts:247`); both are real reclaimable VRAM via a Pro repack. Consistent. Keep `warn`. One caveat: unlike frame-redundancy (whole duplicate frames — usually a real defect), baked-in padding is *common* in hand-authored sheets and may be intentional (e.g. uniform-cell animation grids where every frame is deliberately the same box). The `minRecoverablePct` gate (0.05) is what keeps this from being noisy. **Keep `warn` but calibrate `minRecoverablePct` conservatively** (start at 0.05; the fixture must clear it comfortably).

## MINOR 3 — Uniform-cell animation grids: a HONESTY caveat the copy must carry

A sprite-sheet of fixed 64×64 cells where each frame's art is centered with margin is a DELIBERATE layout (engines index by cell). Trimming would break cell-index addressing. We MEASURE the padding honestly (it IS wasted VRAM), but the `fix` copy must say "**a trimmed repack reclaims up to** …" (already in the draft) AND the fix string must not imply the trim is always safe. The draft's fix string "Repack with trim enabled so each frame is tightened to its opaque bounds" is acceptable because trim + a re-emitted manifest preserves name-based addressing (TP/Pixi reference by name, not cell index). Keep, but the detail copy stays "up to" (upper-bound honest).

## MINOR 4 — i18n: `{vram}` and `{disk}` use the `:bytes` formatter; `{area}` and `{sprites}` are raw

Verified against `find.frame-redundancy.detail` (`en.json:112`): bytes placeholders are `{vram:bytes}`/`{disk:bytes}`, raw counts are `{dupes}`/`{groups}`/`{area}`. The draft's catalog block uses `{vram:bytes}`/`{disk:bytes}`/`{area}`/`{sprites}` — correct. The `catalogs.test.ts` parity guard requires the SAME placeholder set across all 9 locales; the `render.test.ts` drift guard requires baked EN === catalog EN byte-for-byte AND requires adding `'trim-margin'` to the `messageKey` set at `render.test.ts:75` and a `trimMarginFinding(...)` call in `realFindings()` (~line 51). CONFIRMED — must do both or the suite fails.

## MINOR 5 — Overlay: 1–4 border strips per sprite is fine, but cap the rect count

For N qualifying sprites, emitting up to 4 strips each = up to 4N rects in one `OverlayZone`. With `FRAME_HASH_MAX_SPRITES`=4096 that's a 16384-rect worst case the FilmViewer loops. Acceptable (it's bounded and only the qualifying subset), but the draft should emit **one `OverlayZone{kind:'transparent', rects:[…]}` for the whole finding** (all strips flattened) rather than one zone per sprite — simpler, and FilmViewer's per-zone hue-rotate only matters for `duplicate-frame`. Keep a single transparent zone.

## MINOR 6 — `null` bbox (fully transparent frame) overlaps `solid-fill`/`wasted-alpha` semantics — but only for LOOSE; here it's a packed sprite, so OK

The draft's §3 handles this. Confirmed `solid-fill`/`wasted-alpha` are LOOSE-only (`analyze.ts:180, 188` gate on the non-atlas branch). A fully-transparent PACKED sprite is genuine atlas waste with no overlap. Count it. But: a fully-transparent frame with `trimmed:false` is pathological (why pack an empty rect?) — rare but real. Keep counting; the `minMarginPx` gate is bypassed for null-bbox (whole frame is margin), which is correct.

---

## FINAL DESIGN (corrections folded in)

### Scope
DETECTION only. New pure `trimMarginFinding` in `packages/analysis/src/rules.ts`; `trimMargin` threshold in `config.ts` + `ThresholdConfig` (core); new `AtlasFrameTrims` contract (core); worker computes bboxes **in the same decode pass as the frame hashes** via `alphaBBox`; `analyze.ts` wiring (disk NOT folded into `potentialDiskSaved`); single `transparent` overlay zone; i18n (9 langs) + both drift guards; a textured fixture + golden + e2e decode test.

**Out:** the trim-on-repack FIX (plan.ts wiring); CLI/budget opt-in (browser-only, like frameRedundancy).

### Core contract (additive, gated-absent ⇒ byte-identical)
```ts
export interface AtlasFrameTrims {
  atlasRef: string;                 // === Atlas.name (post-merge)
  bboxes: (TrimRect | null)[];      // index-aligned to merged sprites; null = fully-transparent OR host-skipped (caps/read-fail)
}
```
Add `'trim-margin'` to `Rule`. Add to `ThresholdConfig`:
```ts
trimMargin?: { minMarginPx: number; minRecoverablePct: number };
```

### Pure rule
```ts
export function trimMarginFinding(
  atlas: Atlas, cfg: ThresholdConfig, frameTrims: (TrimRect | null)[], imageByteSize: number,
): Finding | null
```
Logic:
1. `if (!cfg.trimMargin) return null; if (frameTrims.length !== atlas.sprites.length) return null;`
2. Qualify a sprite iff **`sp.trimmed === false`** (primary gate; `&& sp.spriteSourceSize === undefined` kept ONLY as a defensive guard for hand-built callers — **redundant by parser construction**, documented as such, NOT as independent safety).
3. Per-DISTINCT-rect dedup by `rectKey(sp.frame)` (first/lowest-index wins; aliased Spine/TP names contribute once).
4. For a qualifying distinct rect with bbox `b`:
   - `b===null` ⇒ whole frame dead: `recoverable += frame.w*frame.h`; bypass `minMarginPx`.
   - else `margin = max(b.x, b.y, frame.w-(b.x+b.w), frame.h-(b.y+b.h))`; if `margin < cfg.trimMargin.minMarginPx` skip; else `recoverable += frame.w*frame.h − b.w*b.h`.
   - collect up to 4 border-strip rects (or whole frame for null) in ATLAS px (translate by `frame.x/frame.y`). **Rotation note (doc comment):** area + per-side margin are rotation-invariant; strips are in placed-page space and draw correctly — no special-casing.
5. Gate: `recoverableArea / (atlas.size.w*atlas.size.h) >= cfg.trimMargin.minRecoverablePct` else null.
6. Severity `warn`. `vram = recoverableArea*4`. `diskEstimate = allFrameArea>0 ? round(imageByteSize*recoverableArea/allFrameArea) : 0`.
7. ONE `OverlayZone{kind:'transparent', rects:[…all strips…]}`.
8. `id: '${atlas.name}:trim-margin'`, `rule:'trim-margin'`, `messageKey:'trim-margin'`, `relatedRefs` = sorted qualifying sprite names, `estimate:{vramBytesSaved:vram, ...(disk>0?{diskBytesSaved:disk}:{})}`, `params:{ sprites, vram, area, disk }`. `sprites` = count of qualifying distinct rects (drives plural). Baked EN strings === catalog byte-for-byte.

Export from `packages/analysis/src/index.ts`.

### Config default
```ts
trimMargin: { minMarginPx: 4, minRecoverablePct: 0.05 }, // CALIBRATE. Browser-only — NOT in resolveThresholds.
```

### Worker (`analyze.worker.ts`) — single shared decode (MAJOR 2)
Refactor `hashAtlasFrames(pageBytes, sprites)` → returns `{ hashes, bboxes } | null`. After `const page = c2d.getImageData(0,0,width,height).data` (line 232), in addition to `extractFrameRegions`, loop sprites and call `alphaBBox({ data: page, width }, { x:frame.x, y:frame.y, w:frame.w, h:frame.h })` — but ONLY for `!sp.trimmed` sprites (skip the read for already-trimmed ones; a `null` then means transparent/skipped, a bbox means a measured untrimmed sprite). Reuse the SAME caps (`extractFrameRegions`→null ⇒ return null for the whole page, both halves skipped). Push `{ atlasRef, bboxes }` to a `frameTrims: AtlasFrameTrims[]`; thread `...(frameTrims.length ? { frameTrims } : {})` into the `analyze()` deps (line 137-ish). Import `alphaBBox` from `@asset-doctor/fix`. **No protocol.ts change.**

### Orchestrator (`analyze.ts`)
Add `frameTrims?: AtlasFrameTrims[]` to `AnalyzeDeps`. Build `frameTrimByRef`. In the atlas branch, after the frame-redundancy block (line 164):
```ts
const ft = frameTrimByRef.get(atlas.name);
if (ft) { const tm = trimMarginFinding(atlas, cfg, ft, image.byteSize); if (tm) findings.push(tm); }
// disk estimate DELIBERATELY NOT folded into potentialDiskSaved (mirrors frame-redundancy)
```

### i18n (all 9 catalogs) + drift guards
Add `find.trim-margin.{title,detail,fix}` mirroring frame-redundancy's plural shape (`$count: "sprites"`), placeholders `{sprites}`/`{vram:bytes}`/`{area}`/`{disk:bytes}`. Copy must say "**a trimmed repack reclaims up to** …" (upper bound). **Must** add `trimMarginFinding(...)` to `render.test.ts` `realFindings()` AND add `'trim-margin'` to the `messageKey` set at `render.test.ts:75`, or the suite fails. `catalogs.test.ts` passes once all 9 carry matching keys/placeholders.

### UI
No FilmViewer change (`transparent` styled, `:9`/`:73`). Grep `Findings.tsx`/`VerdictBar`/`TriageLedger` for a closed rule-literal list; add `trim-margin` only if a switch exists.

### Fixture
`make-fixture` → `fixtures/sample-projects/untrimmed-padding/`: TP-or-Pixi JSON + PNG, N sprites each a TEXTURED opaque core (clears the flat-guard — note: the trim detector uses `alphaBBox`, NOT the flat-guard, so a flat core is fine for bbox, BUT the fixture should be textured anyway for realism) inside a wide transparent margin, `trimmed:false`, NO `spriteSourceSize`. Margin ≥ `minMarginPx`; Σ padding ≥ `minRecoverablePct` of atlas. Golden `expected.json` documents `recoverableArea`, `vramBytesSaved (=area×4)`, qualifying names, `findings:[{rule:'trim-margin',severity:'warn'}]` + README.

### Tests
- `analysis.test.ts`: fires `warn` (hand-supplied bboxes); skips already-trimmed (`trimmed:true` ⇒ null); aliased rects once; null cfg / length mismatch / below `minRecoverablePct` ⇒ null; `bbox===null` whole-frame counts; LOOSE asset never fires; `analyze` does NOT fold disk into `totals.potentialDiskSaved` (assert unchanged vs baseline) but the finding carries `estimate.diskBytesSaved`. Golden by sprite NAME (parser-order-robust).
- `perceptual.test.ts` (or sibling e2e): pngjs-decode the fixture → build `RGBASource`/`Region` per sprite → `alphaBBox` → `trimMarginFinding` → assert `warn` matching `expected.json`.
- `pnpm typecheck && pnpm test`; run `check-invariants`.

---

## ORDERED TASK BREAKDOWN (kept; corrections folded in)

1. **core:** add `AtlasFrameTrims`, `'trim-margin'` Rule, `trimMargin` ThresholdConfig. `pnpm typecheck`. — `feat(core): trim-margin contract`
2. **analysis:** `trimMarginFinding` in rules.ts (+ export) — gate on `sp.trimmed===false` (redundant `spriteSourceSize` guard documented), per-distinct-rect dedup, null-bbox whole-frame, single transparent zone, rotation doc-comment; `trimMargin` default in config.ts. — `feat(analysis): trim-margin detector (pure rule)`
3. **analysis:** wire `frameTrims` into `analyze.ts` (AnalyzeDeps + atlas branch; disk NOT folded). — `feat(analysis): thread frameTrims into analyze`
4. **analysis tests:** unit + golden in analysis.test.ts (mirror the frame-redundancy block; stub bboxes by name). — `test(analysis): trim-margin rule + analyze wiring`
5. **i18n:** en.json + 8 translations (copy says "reclaims up to"); add to `render.test.ts` `realFindings()` + the `messageKey` set; run i18n tests. — `feat(i18n): trim-margin catalog (9 langs) + drift guard`
6. **worker:** refactor `hashAtlasFrames` → `{hashes, bboxes}` computed in ONE decode pass; `alphaBBox` only for `!sp.trimmed`; reuse caps; thread `frameTrims` to analyze; import from `@asset-doctor/fix`. **No protocol change.** — `feat(web): host-decoded trim bboxes (shared page decode) → trim-margin`
7. **fixture:** `make-fixture` → `untrimmed-padding/` PNG + manifest + expected.json + README. — `test(fixtures): untrimmed-padding atlas`
8. **e2e:** decode fixture → alphaBBox → rule → expected.json (perceptual.test.ts sibling). — `test(web): trim-margin end-to-end through real decode`
9. **UI sanity:** grep Findings.tsx/VerdictBar/TriageLedger for closed rule lists; add case only if a gap exists. — (commit only if needed)
10. **`pnpm typecheck && pnpm test` green; run `check-invariants`.** — (fixups)

---

## SUMMARY OF CHANGES vs DRAFT
- **False premise corrected:** the `trimmed===false && spriteSourceSize===undefined` gate is REDUNDANT (equivalent by parser construction, atlas.ts:101-104 / spine-atlas.ts:98-101), not a two-signal correctness net. Gate primarily on `sp.trimmed===false`; keep the second conjunct only as a documented defensive guard for hand-built callers.
- **MAJOR (inv-4):** "zero extra decode" is only true if bboxes are computed in the SAME `hashAtlasFrames` decode pass off the SAME `page` buffer. Made this a HARD requirement (refactor to `{hashes, bboxes}`), not an optional "option A."
- **MAJOR (rotation):** the draft's justification was sloppy; the conclusion (no special-casing) is correct — area + per-side margin are rotation-invariant, overlay strips live in placed-page space. Kept as a precise doc comment.
- **Overlay:** emit ONE `transparent` zone for the whole finding (flattened strips), not one per sprite.
- **Honesty caveat added:** uniform-cell animation grids make baked padding sometimes intentional; copy stays "reclaims **up to**", `minRecoverablePct` gates noise.
- **Verified & kept unchanged:** the contract-split (separate `AtlasFrameTrims`), `warn` severity, disk-not-folded, FilmViewer needs no change, both i18n guards, the imageByteSize plumbing, fixture model.

Everything else in the draft holds against the code. The feature is buildable, additive (gated-absent ⇒ byte-identical), honest (exact VRAM, estimated disk never folded), and deterministic.