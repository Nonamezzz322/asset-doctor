No existing region-hash code. The skill order matches the design's task breakdown exactly. I now have full coverage to write the adversarial verdict.

The premise is **partially false**: the central "enabling architectural fact" (worker already decodes the page, so per-frame hashing is free) does NOT hold for the analyze worker — it never full-decodes atlas pages. The feature is still salvageable because one decode per atlas page is bounded and acceptable (FilmViewer already does it on the main thread anyway), but the design's instant-wow justification, the flat-guard mechanics, and several effort claims must be corrected. Here is the revised design.

---

# REVISED Design: Animation-Frame Redundancy Detector (`frame-redundancy`)

Verdict: **PROCEED, scope-corrected.** The premise's load-bearing claim is false (see Blocker 1), but the feature survives with an honest "one new decode per atlas page" cost model. All contract/test/i18n claims verified against real code. Line numbers in the draft were wrong throughout; corrected references below.

## Blockers found & resolutions

**B1 — FALSE PREMISE (central). "The worker already decodes every atlas page."**
Verified: `apps/web/src/worker/analyze.worker.ts` does NOT full-decode atlas pages. It does (a) `sha256Hex` over raw file bytes (no decode), (b) a 9×8 downscaled decode in `decodeFeatures` (`:125`), and (c) a full-res decode ONLY for loose PNG/WebP opaque scan — atlases are explicitly excluded (`scanAlpha`, `:81`). The full-page decode lives on the **main thread** (`FilmViewer.tsx:47`, `probe-run.ts:39`), not the worker, and the worker even calls `bmp.close()` (`:152`) right after the 9×8 read. **Resolution:** frame hashing adds ONE genuinely-new `createImageBitmap` + full-res `getImageData` per atlas page in the worker. This is real cost, but bounded (one decode/page, same magnitude as the main-thread FilmViewer decode that already runs), so instant-wow holds *with the size cap*. The honesty/effort framing must drop "free/no decode storm" and own the new decode. Keep the feature.

**B2 — Flat-guard mechanics are underspecified and mis-described.** `isFlat`/`isSolidColor` (`perceptual.ts:59,82`) operate on a **9×8 `gray[]` + interleaved `rgba`** sample, not a raw region. A per-region read must (a) `getImageData` the full region for the SHA, AND (b) separately downscale that region to 9×8 (or sample its luma) to run the existing guards — these are two different buffers. The draft's "hash the raw region RGBA" + "reuse isFlat" glosses this. **Resolution:** worker draws the region once into a region-sized canvas → `getImageData` (raw bytes for SHA) AND a 9×8 canvas → `getImageData` (for `isFlat`/`isSolidColor`). Both off the same already-decoded page bitmap.

**B3 — `messageKey` vs catalog-key vs rule-id drift.** Catalog keys are `find.<x>.title` (`en.json:78`); the drift test (`render.test.ts:65`) hardcodes the bare `messageKey` SET and will fail until `'frame-redundancy'` is added there. The rule id, `messageKey`, and catalog suffix must all be `frame-redundancy`. **Resolution:** explicit in tasks 1/3/6.

**B4 — `:bytes`/`:pct` hints confirmed (`i18n/src/*.ts:98-100`)** but the draft's detail template uses `~{vram:bytes}` / `~{saved:bytes}` — fine. However the draft's title plural uses `$count: "frames"` referencing a `{frames}` param; verify the param key matches the `$count` field name exactly (the existing plural keys use the count param directly). Minor, called out in task 6.

## Majors

**M1 — Determinism of cross-page merge.** `mergeSharedAtlases` (`merge.ts:9`) unions sprites **by name**, appending non-duplicate names to the FIRST atlas's list. Hashing MUST run on the post-merge list (draft says this — correct). But note merge keys by `a.atlas.name` and keeps the first atlas's name, while the worker keys `imageBytes` by `res.asset.atlas.name` — these align, so `imageBytes.get(merged.atlas.name)` resolves. Confirmed safe. The required worker refactor (hoist `const merged = mergeSharedAtlases(assets)` out of the `analyze(...)` call) is one line.

**M2 — Distinct-rect guard correctness.** The anti-double-count guard (count distinct `frame` rects, not frame entries) is sound and necessary for pre-aliased Spine sheets. But the rule must define "distinct rect" by `(x,y,w,h)` tuple equality, and the worker hashing must be over the **region pixels** — two manifest names pointing at the identical rect produce the identical SHA naturally, so they cluster; the guard then collapses them to one recoverable unit. Verified the model supports this (`Sprite.frame: Rect`, `core:54`). Keep.

**M3 — `potentialDiskSaved` no-fold decision is correct and matches existing de-overlap precedent** (`analyze.ts:169-175` takes MAX, not SUM, to avoid double-count). The draft's choice to NOT fold frame-redundancy disk into the aggregate is the safe, honest call given the disk number is an area-proportional ESTIMATE. Endorsed; document inline as the draft says.

## Minors
- Draft line numbers are all wrong (core is 701 lines; `Rule` is `:252`, `OverlayZone` `:304-307`, `ThresholdConfig` `:498-532`, `ImageFeatures` `:347`). Corrected here; use these.
- Disk estimate `round(image.byteSize * recoverableArea / Σ(allFrameAreas))` — guard `Σ(allFrameAreas) > 0` (an atlas with zero-area frames ⇒ skip disk estimate, emit VRAM only).
- FilmViewer per-cluster hue rotation is genuinely nice-to-have; keep it out of the contract (emit one `OverlayZone` per cluster, all `kind:'duplicate-frame'`; FilmViewer rotates hue by zone index). No core change beyond the kind.

## Contract changes (verified additive)
1. `Rule` union (`core:252-268`) += `'frame-redundancy'` (per-asset group).
2. `OverlayZone.kind` (`core:305`) += `'duplicate-frame'`.
3. New `AtlasFrameHashes { atlasRef: string; frameHashes: (string|null)[] }` near `ImageFeatures` (`core:347`); `null` = host-skipped (flat or decode/read failure), never clustered.
4. `ThresholdConfig` (`core:532`) += `frameRedundancy?: { minDuplicates: number }` — optional, browser-only, NOT enumerated by `resolveThresholds` (mirrors `solidFill`/`wastedAlpha`).
No change to `Finding`/`FindingEstimate`/`AssetMetrics`/`AnalysisReport`.

## Honesty / invariants (re-checked)
- Inv 1/2: all hashing in worker, no network, no backend. ✓
- Inv 3: detector only; `estimate` carries recoverable numbers; no frame emitted/encoded. ✓
- Inv 4 (≤10s): **NEW decode per atlas page** (corrected from draft) — bounded by a size cap mirroring `ALPHA_SCAN_MAX_PX` (`worker:114`); one decode/page, each region read once off it. Honest now. ✓
- Inv 5: VRAM = recoverable distinct-rect area ×4, framed **repack-recoverable** (like occupancy `en.json:79` "the VRAM it pins"); disk is an explicit **area-proportional estimate** (no per-region disk bytes exist). Two numbers, never conflated. ✓

## ORDERED TASK BREAKDOWN (small commits, 1 meaning each)
1. **core:** add `'frame-redundancy'` to `Rule`, `'duplicate-frame'` to `OverlayZone.kind`, `AtlasFrameHashes` interface, `ThresholdConfig.frameRedundancy?`. Type-only, additive. (`packages/core/src/index.ts`)
2. **analysis/config:** `frameRedundancy: { minDuplicates: 3 }` `// calibrate`. (`config.ts`)
3. **analysis/rules:** pure `frameRedundancyFinding(atlas, cfg, frameHashes, imageByteSize) => Finding|null` + export. Clustering (Map<hash, indices[]>, skip null), distinct-rect guard, recoverable area/VRAM, area-proportional disk estimate (guard Σar{a}>0), severity `warn`, one `OverlayZone` per cluster (`kind:'duplicate-frame'`), sorted refs/rects by sprite index, `messageKey:'frame-redundancy'`, baked EN strings matching catalog templates byte-for-byte. (`rules.ts`, `index.ts`)
4. **analysis/orchestrator:** `AnalyzeDeps.frameHashes?: AtlasFrameHashes[]`; build `frameHashByRef` map beside `classByRef`/`solidByRef`/`opaqueByRef` (`analyze.ts:86-99`); call in atlas branch after `addFormat` (`analyze.ts:141`) only when dep present; **do NOT fold into `potentialDiskSaved`** (inline comment citing the MAX-de-overlap precedent at `:169`). (`analyze.ts`)
5. **analysis/tests:** pure-rule unit tests (inject `frameHashes`, no canvas): cluster≥min ⇒ warn + correct VRAM/refs/overlay-count; below min ⇒ null; null hashes never cluster; pre-aliased (same rect) ⇒ null; no `cfg.frameRedundancy` ⇒ null; length mismatch ⇒ null; `analyze()` threads dep + asserts `potentialDiskSaved` UNCHANGED; loose asset never fires. (`test/analysis.test.ts`)
6. **i18n:** `find.frame-redundancy.{title(plural),detail,fix}` in all 9 catalogs (matching `{tokens}` + plural structure — `catalogs.test.ts:16` enforces parity); add `'frame-redundancy'` to the hardcoded `messageKey` set in `render.test.ts:65` and exercise it in `realFindings()`; verify EN drift reproduction + RU brace-free. (`catalogs/*.json`, `test/render.test.ts`)
7. **fixture:** `fixtures/sample-projects/frame-redundant/` via make-fixture skill — atlas PNG (e.g. 256×256, 8 frames, 4 byte-identical at distinct positions) + TP-hash manifest + `expected.json` + README; generator entry in `fixtures/_generator/generate.mjs`. Golden test **hand-supplies the known frame hashes** (deterministic colored rects) to stay canvas-free; assert `frame-redundancy:warn`. Existing atlas goldens stay green (they call `analyze([asset])` with no `frameHashes`, `analysis.test.ts:46`). (`fixtures/*`, `test/analysis.test.ts`)
8. **worker:** hoist `const merged = mergeSharedAtlases(assets)`; add `hashAtlasFrames(pageBytes, sprites)` — ONE `createImageBitmap` per page (NEW decode — own the cost), per region: draw region → `getImageData` (raw bytes → `sha256Hex`, reuse `worker:104`) AND draw region→9×8 → `getImageData` → `isFlat`/`isSolidColor` (push `null` if flat/fail); size cap mirroring `ALPHA_SCAN_MAX_PX`; build `AtlasFrameHashes[]` keyed by `merged atlas.name`; thread `frameHashes` into `analyze(merged, …)`. (`apps/web/src/worker/analyze.worker.ts`)
9. **UI:** add `'duplicate-frame': { stroke:'#0E8C8C', fill:'rgba(14,140,140,0.18)' }` to `ZONE_STYLE` (`FilmViewer.tsx:7`); rotate hue by overlay-zone index in the existing `for (const zone of f.overlay)` loop (`:58-79`). No App.tsx change (findings list is rule-agnostic). (`FilmViewer.tsx`)
10. **verify:** `pnpm typecheck` + `pnpm test` green; confirm atlas goldens unchanged (rule dormant without `frameHashes`); run `check-invariants` skill on the worker decode path.

## Corrected key references
- `packages/core/src/index.ts`: `Rule` :252-268 · `OverlayZone` :304-307 · `Finding` :319-344 · `ImageFeatures` :347-368 · `ThresholdConfig` :498-532.
- `packages/analysis/src/rules.ts`: `solidFillFinding` :131 · `wastedAlphaFinding` :173 (closest analogues).
- `packages/analysis/src/analyze.ts`: `AnalyzeDeps` :45-62 · feature maps :86-99 · atlas branch :119-147 · MAX de-overlap precedent :169-175.
- `packages/analysis/src/merge.ts`: `mergeSharedAtlases` :9 (unions by name).
- `apps/web/src/worker/analyze.worker.ts`: `sha256Hex` :104 · `ALPHA_SCAN_MAX_PX` :114 · `decodeFeatures` :125 (9×8; **does NOT full-decode atlases**).
- `apps/web/src/lib/perceptual.ts`: `isFlat` :59 (9×8 gray) · `isSolidColor` :82 (9×8 gray+rgba) · `SOLID_STD` :22.
- `apps/web/src/lib/probe-run.ts:39` · `apps/web/src/components/FilmViewer.tsx:47` — where pages are ACTUALLY decoded (main thread).
- Tests: `packages/analysis/test/analysis.test.ts:35,46` (goldens run without deps) · `packages/i18n/test/render.test.ts:65` (hardcoded messageKey set) · `packages/i18n/test/catalogs.test.ts:16` (9-locale parity) · `fixtures/_generator/generate.mjs`.

**Corrected enabling fact:** the page is NOT decoded in the analyze worker today (only a 9×8 sample + raw-byte SHA). Frame hashing adds ONE full-resolution `createImageBitmap` per atlas page in the worker — a real, size-capped cost (one decode/page, each region read once off it), honestly the same magnitude as the main-thread FilmViewer decode that already runs. The pure clustering core takes injected hashes exactly like `ImageFeatures`, keeping analysis headless-testable and the diagnosis path zero-network.