# Asset Doctor — changelog (per round)

Living log of the autonomous improvement loop. One entry per round; each round = a
design→skeptic→impl→adversarial-review→fix cycle, independently verified green and committed
small on branch `feat/asset-pipeline` (= local `main`). Newest first.
**Each new round MUST append its entry here.** `origin/main` is at `54c1a3a` (deploy blocked: no
GitHub creds — user pushes); commit hashes below are over that base.

> Convention: `commit` · what shipped · review verdict · gate. Designs live in `docs/improvements/round*.md`.

---

## Round 19 — selection (3 picks; #0 shipped) — 2026-06-29
Picks: **(a) frame-redundancy FIX** (shipped, #0 below); **(b) fix-worker memory bounds**; **(c) trim-margin
detector**. Designs for (b)/(c) pending.

- **#0 Frame-redundancy FIX** (`docs/improvements/round19-frame-redundancy-fix.md`) — turns the r18 detector
  into a Pro fix: alias N byte-identical animation frames within an atlas onto ONE packed region in the repack
  (one Blit per representative; every original name still resolves via the manifest), exact VRAM before→after
  (no estimate), drop-in by construction. Review verdict from the design's own skeptic: **SALVAGEABLE +
  BLOCKER B1 fixed** — a frame-redundant atlas is usually FULLY packed (its duplicates fill the sheet ⇒ no
  occupancy/wasted finding ⇒ no repack today), so the FINDING itself now emits its OWN `repack` op (reuses the
  `repack` OpKind ⇒ tally/manifest/selective-fix/receipt unchanged), and the WORKER pre-hashes qualifying merged
  atlas pages BEFORE `analyze()` (one decode/qualifying page, ≥minDuplicates pre-filter, respects cancel) so the
  finding actually fires. `repackAtlases` gained an optional `aliasMaps` arg: packs ONE representative per
  byte-identical cluster, emits a Sprite for each alias name at the shared rect copying the alias's OWN
  trim/pivot/sourceSize, with a DUAL occupancy accumulator (source=all sprites before, packed=reps after).
  Pure `packages/fix/src/alias.ts` mirrors the detector's distinct-rect guard byte-for-byte (pre-aliased rects
  never double-count; `aliasedFrames` === the finding's `dupes`). New `FixOptions.frameRedundancy`
  (default ON) + App toggle + `PlanOptions.frameRedundancy` + `RepackResult.aliasedFrames` +
  `FixReceipt.framesAliased` + receipt line + i18n ×9. Additive: absent/false ⇒ no hashing, no new op, no
  aliasing ⇒ byte-identical. Tests: pure `alias.test.ts` (8) + end-to-end on the fully-packed
  `frame-redundant` fixture (B1 op fires, all 8 names resolve, 4 idle share one rect, exact VRAM, honesty pin
  `aliasedFrames === dupes`) + a synthetic POT-tier VRAM-drop proof. Gate: typecheck + test (388 fix) + lint green.

- **#1 Fix-worker memory bounds** (`docs/improvements/round19-fix-worker-memory-bounds.md`) — bounds the
  fix-worker's decoded-source resident set so a multi-dozen-page Pro fix can't pile hundreds of MB of decoded
  ImageBitmaps resident and OOM the tab (the worst failure on the PAID path: `bitmapOf`'s old `bmpCache`
  never `.close()`d/evicted/drained, holding every decode for the whole run). New PURE Node-testable policy
  `apps/web/src/lib/bitmap-budget.ts`: `BitmapBudget<Closeable>` — an LRU keyed by ref, bounded by a
  documented byte budget (`BITMAP_BUDGET_BYTES` = 256 MB ≈ 16 full 2048² RGBA pages, Σ w·h·4), with a
  close-callback, a `pin`/`unpinAll` set for the in-flight op's source refs (the LRU NEVER evicts a pinned
  bitmap), and a `drain()` that close()s + clears everything. Over-budget insert close()+evicts the LRU
  UNPINNED entry (≠ the just-inserted ref) until under budget OR only pinned/this remain (a single page > the
  whole budget is admitted; all-pinned-over-budget is tolerated — correctness over the bound, surfaced via
  `peakCount`). Worker wiring: `bitmapOf` routes through it; `bmpBudget` is hoisted at the top of `runFix` and
  the whole body wrapped in `try { … } finally { bmpBudget?.drain() }` so a finished/superseded run (incl.
  every round18 cancel `return` and a thrown error) frees native memory immediately (composes with the
  abortable-workers cancel path; plan-mode / pre-decode cancel ⇒ `bmpBudget` undefined ⇒ drain no-op). A
  `teardownPrevOp()` at the TOP of each `plan.ops` iteration (and once after) unpins + drops the prior op's
  per-op `maskCache`/`meshCache`/`trimCache` entries — ONE site that fires regardless of the body's 20+
  `continue` exits. `pin(srcRefs)` early in the merge/polygon (group atlases) + pack (`group.regions`)
  branches stops a re-decode storm within one multi-source op. Optional descriptive receipt note
  `FixReceipt.decodeWorkingSet { decodedPages, budgetBytes }` (gated on `peakCount > 0`; NEVER a VRAM/saving
  number — invariant 5). CORRECTNESS: a miss re-decodes safely from the whole-run-retained `bytesByRef` (a
  wrongly-evicted entry costs CPU, never a wrong pixel); the LRU never evicts a ref the current op still needs.
  ADDITIVITY: under the byte budget nothing evicts ⇒ same decode set + order ⇒ output byte-identical to before.
  DETERMINISM: eviction only frees memory (recency = call order, ties by Map insertion order). Tests: PURE
  headless `apps/web/src/lib/bitmap-budget.test.ts` (13) — eviction-over-budget + close-fires +
  nothing-under-budget + recency-refresh + never-evict-the-pinned-ref (+ unpin makes it evictable, all-pinned
  tolerated) + single-oversized-admitted + drain-closes-once/idempotent + replace-frees-stale + peakCount +
  determinism. Additive: under budget ⇒ byte-identical. Gate: typecheck + test (web 389) + lint green.

- **#2 Per-atlas trim-margin detector** (`docs/improvements/round19-trim-margin-detector.md`) — DETECTION-only
  sibling of the r18 frame-redundancy detector: for each sprite NOT already trimmed (no `spriteSourceSize` —
  its `frame` IS the full untrimmed image), MEASURE the transparent margin it carries (frame area − opaque
  alpha bbox area) and report the summed recoverable area × 4 as EXACT VRAM (the atlas space the padding pins
  that a trimmed repack reclaims), plus an area-proportional DISK estimate (invariant 5 — carried separately,
  NEVER folded into `potentialDiskSaved`), and ONE `transparent` (yellow) overlay zone of per-side border
  strips in atlas px. INSTANT-WOW: the worker computes each opaque bbox via the pure `alphaBBox`
  (`@asset-doctor/fix`) off the SAME already-decoded page the frame-redundancy pass reads — `hashAtlasFrames`
  now returns `{ hashes, bboxes }` from ONE decode, so the trim feature adds ZERO extra decode and reuses the
  SAME px/sprite caps. HONESTY: gate on `Sprite.trimmed === false` (the `&& spriteSourceSize === undefined`
  conjunct kept only as a documented redundant-by-parser-construction guard); skip already-trimmed sprites;
  distinct-rect alias guard counts shared packed rects once; a `null` bbox on an untrimmed sprite =
  fully-transparent frame (whole frame recoverable). Rotation-invariant (area + per-side margin read over the
  placed region; strips drawn in placed-page space). New core `AtlasFrameTrims` contract + `'trim-margin'`
  Rule + `trimMargin` ThresholdConfig (`{minMarginPx:4, minRecoverablePct:0.05}`, browser-only — NOT in
  resolveThresholds); `trimMarginFinding` threaded into `analyze()` like `frameHashes` (absent ⇒ byte-identical
  ⇒ CLI/headless unaffected). i18n ×9 (copy says "reclaims **up to**" — uniform-cell padding is sometimes
  intentional) + render-drift guard. Golden fixture `untrimmed-padding/` (textured cores in transparent
  margins, one already-trimmed sprite the detector skips) via the generator. Tests: analysis unit + golden
  (skip-trimmed, null-bbox whole-frame, alias-once, below-floor/thin-margin/length-mismatch/no-config ⇒ null,
  disk-not-folded) + web e2e (fixture PNG → real `alphaBBox` → rule). Gate: typecheck + test + lint green.

## Round 18 — robustness + moat + analysis depth — 2026-06-29
- `4870cc1` **Abortable workers** — `AbortSignal` seam through analyze + fix workers + clients; cooperative cancel flag; a superseded drop aborts the prior run. Additive (no signal ⇒ byte-identical). Review SHIP.
- `1c6902d` **correlateFix(receipt)** — measured before→after fix probe → one localized doctor verdict (reuses `CorrelatedFinding` + variant-suffixed i18n; measured-only, honest). Review SHIP.
- `c3950ae` **Frame-redundancy detector** — duplicate frames within an atlas (per-region SHA, instant-wow caps + flat-guard; exact VRAM-area waste). Review FIX_THEN_SHIP — both MAJORs fixed (fixture now reproduces the defect through the real flat-guarded path; worker decode path tested).

## Round 17 — moat / parity / honesty — 2026-06-28
- `3be0d6a` **Render-probe the produced fix** — measured before→after draw calls + decoded VRAM per sheet (3rd probe sibling); honest badge kept separate from static numbers. Review SHIP.
- `01e5950` **Per-image measured best-format pick** — carry the diagnosis's measured smallest-encode winner into the fix plan (default OFF; precedence profile>override>bestMime>global). Review FIX_THEN_SHIP — MAJOR fixed (dedup owner-name prediction honors the per-op mime).
- `bb2fd38` **Opaque fan-out size-loss guard** — never ship a larger same-format opaque page. Review SHIP (zero findings).

## Round 16 — consolidation (round-15 MINORs) — 2026-06-28
- `2fe9828` — honesty double-count de-overlap (`potentialDiskSaved` MAX not SUM for format+wasted-alpha refs); keep-original-on-size-loss guard for opaque transcode; `ktx2-probe-collect` extracted+tested; gl-instrument 9-arg form; loader copy softened ×9. Review SHIP.

## Round 15 — selection (3 picks) — 2026-06-28
- `b297290` **Measure REAL KTX2 GPU VRAM on-device** — `compressedTexImage2D` instrument + `probeKtx2` + self-hosted transcoder (no CDN); shown beside the worst-case ceiling, device-local. Review FIX_THEN_SHIP.
- `84b8ea7` **KTX2 loader-migration snippet** — emit `import 'pixi.js/ktx2'` when a fix produced `.ktx2` (fixes the manifest-refs-`.ktx2`-but-loader-can't-decode bug; Phaser honest NOTE). Review SHIP.
- `21710a0` **Wasted-alpha detector + opaque-encode fix** — full-frame opaque pass (short-circuit/size-capped/worker = instant-wow safe); disk-only saving, never VRAM. Review SHIP.

## Round 14 — consolidation (round-11→13 MINORs) — 2026-06-28
- `b5c1405` — i18n-app-keys guard extended to the new components; highlightId debounced; shared `defaultSelectOpts`; `countCandidates` (no per-keystroke re-sort); consent upload count/preview; auto-pair the Pixi manifest when a backend op is on; gateway one-fewer body copy; suppress empty all-quality-floor entry. Review SHIP.

## Round 13 — native→backend #2 — 2026-06-28
- `a872dd0` **pngquant lossy-PNG** disk-only op on the sidecar (browser-impossible); zero VRAM field (decodes to RGBA); quality-floor decline kept-not-failed; Op propagated; `backendNative` array; PNG dup-key split. Review FIX_THEN_SHIP (MAJOR fixed: honest skip on tiered path).

## Round 12 — native→backend #1 (invariant 1/2 amendment) — 2026-06-28
- `25f7af0` **KTX2 GPU-texture sidecar** (`apps/encoder`, Go toktx) via `apps/api` entitlement-gated reverse proxy; opt-in, default OFF, explicit upload consent; honest VRAM ceiling; two-json-sidecar manifest; CLAUDE.md invariants 1&2 amended. Review FIX_THEN_SHIP (2 MAJORs fixed: manifest order + worker/client test coverage). Go: apps/api + apps/encoder build/vet/test green.

## Round 11 — UI/UX — 2026-06-28
- `6c17ffd` **Triage-first scalable results view** — pure `triage.ts` (O(assets+findings) index, kills the per-render O(N×F) scan) + zero-dep virtualization; VerdictBar + virtualized TriageLedger (search/sort/filter/group, honest rollups) replacing the chip wall; sticky film detail w/ debounced decode; collapsed the double ArrayBuffer copy. Fixes the many-images chaos. Review FIX_THEN_SHIP (MAJOR fixed: show-clean emits real clean rows).

## Round 10 — asset-builder parity — 2026-06-28
- `8af0247` **Per-folder/prefix export overrides** — `ExportProfile.overrides[]` (exact-or-prefix match) overlays formats/quality/lossless/AVIF-4:4:4 (fonts→4:4:4); pure `resolveProfileForRef`; default OFF ⇒ byte-identical. Review SHIP.

## Round 9 — AssetPack arc — 2026-06-28
- `8c478d4` **Content-hash cache-busting** (`hashFilenames`) — 8-hex content hash chained through atlas `meta.image`, Spine `.atlas` line, Pixi manifest, dedup consumer images, loader rows. Skeptic caught 3 blockers + 4 majors pre-code; reviewer caught 1 more (dedup→loose-owner 404) — all fixed.

## Round 8 — AssetPack arc — 2026-06-28
- `0727449` **PixiJS manifest.json emitter** — real v8 `{bundles}` (one alias-suffixed entry per tier; sheets→sidecar; no fabricated `data.resolution`); makes the variant fan-out loadable with one `Assets.init`. Review SHIP.

## Round 7 — asset-builder parity / AssetPack arc — 2026-06-28
- `f3b3cc9` **Config-driven export profile** — arbitrary resolutions × formats × per-format compression, replacing the fixed 3-tier ladder; first-class format fan-out; lossless genuinely threaded. Skeptic caught 3 real defects pre-code. Review FIX_THEN_SHIP.

## Backend ↔ frontend connection — 2026-06-28
- `e59916d` — wired the React app to the Go license backend (`:8088`): `.env.local` (gitignored) + `apps/api/tools/devmint` (dev-license) + `tools/verify/license-connect-run.mjs` (proves activate→sign→offline-verify vs the live backend). LICENSE_CONNECT PASS.

## Round 6 + fss fix — 2026-06-28
- `7eca731` **Round 6** — F1 before/after FilmViewer sheet-diff (visual proof), F2 solid-fill detector, F3 surface-unparsed-files + parser hardening.
- `7499fb7` **fss bug** — pack ALL spine regions (don't drop large ones via the static `maxSpriteEdgePx` filter).

## Earlier rounds (rounds 2–5, same branch) — 2026-06-26/27
- `e09c539` engine-aware loader-migration guide · `bd3d8e0` zip UTF-8 flag + occupancy clamp · `fb7fbc7` content-class format-suitability · `411b9de` per-texture VRAM/probe breakdown · `8074226` polygon-pack content-extent trim (no empty bottom) · `9411b44` probe-into-verdict (measured GPU footprint) · `a5f7864` selective fix · `ae51c15` atlas fragmentation score · `e9d18ca` dry-run plan preview · `416828f` edge-extrude (bleed).
- (Pre-branch foundations — Phase 1 diagnosis, render-probe, runtime profiler, MV3 extension, correlate, CLI + budget-gate, i18n, Phase-2 browser fix, polygon packer, Part B dedup, scale-tiers, Slice B Go billing — see `docs/` + git history.)
