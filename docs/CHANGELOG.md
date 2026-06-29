# Asset Doctor — changelog (per round)

Living log of the autonomous improvement loop. One entry per round; each round = a
design→skeptic→impl→adversarial-review→fix cycle, independently verified green and committed
small on branch `feat/asset-pipeline` (= local `main`). Newest first.
**Each new round MUST append its entry here.** `origin/main` is at `54c1a3a` (deploy blocked: no
GitHub creds — user pushes); commit hashes below are over that base.

> Convention: `commit` · what shipped · review verdict · gate. Designs live in `docs/improvements/round*.md`.

---

## Round 21 — selection (#0 shipped) — 2026-06-29
Pick: **(#0) standalone trim-margin → repack scheduling** — uncaps the r20 trim-on-repack FIX so it fires
even when no occupancy/frame-redundancy/merge repack is already scheduled.

- **#0 Standalone trim-margin → repack scheduling** (`docs/improvements/round21-standalone-trim-margin-repack-sche.md`)
  — a `trim-margin` finding now emits its OWN pass-1 `repack` op (`PlanOptions.trimMargin`, default ON), so a
  padded-but-FULLY-PACKED atlas (no occupancy/wasted finding ⇒ no repack today) finally gets trimmed. Reuses
  the r20 trim-on-repack execute path (`buildTrimArrays` → `repackAtlases({trim})`): exact `vramSaved`
  before−after, the disk number stays an estimate (invariant 5), `trimmedSprites` surfaces in the receipt.
  Guarded against double-emit with the occupancy AND frame-redundancy paths via the shared `repacked` set
  (order-free — findings are SORTED), and pre-excluded from tiering like the other repack-driving findings.
  **Skeptic BLOCKER B0/B1 (load-bearing):** the FIX worker re-runs `analyze()` itself, but its local
  `hashAtlasFrames` returned ONLY hashes (no bboxes) and NEVER passed `frameTrims`, so the trim-margin finding
  fired in the FREE diagnosis worker but **never** in the fix worker → the feature would have been a no-op (a
  dead toggle). Fixed by porting the analyze worker's `{hashes,bboxes}` shape into the fix worker and feeding
  `frameTrims` (key `bboxes`) into its `analyze()` call; the diagnosis decode pass now runs when
  `frameRedundancyOn || trimMarginOn` (shared page decode — one decode either way) and keeps each array
  independently (a `frameRedundancy:false, trimMargin:true` run still gets trim bboxes; `trimMargin:false` ⇒
  byte-identical). `FixOptions.trimMargin` + App toggle (default ON) + i18n ×9. Tests exercise the REAL
  analyze→plan path (synthetic decoded RGBA → real `alphaBBox` → `frameTrims` → `analyze` → `planFix`): a
  fully-packed padded atlas ⇒ exactly one repack op + `trimmedSprites > 0` realized; no double-emit when
  occupancy also fires; additive (off ⇒ byte-identical). ADDITIVE — default-on but absent-field ⇒ no plan/byte
  change when nothing qualifies.

## Round 20 — selection (#0 shipped) — 2026-06-29
Pick: **(#0) trim-on-repack FIX** (shipped below) — turns the r19 trim-margin DETECTOR into a Pro fix.

- **#0 Trim-on-repack FIX** (`docs/improvements/round20-trim-on-repack-fix-auto-trim-untri.md`) — when a repack
  runs, every UNtrimmed sprite carrying reclaimable transparent padding is now tightened to its opaque bounds.
  Rides the EXISTING repack op (free-rider boundary — occupancy/frame-redundancy/merge-scheduled repacks also
  trim; no separate trim-margin→repack scheduling in v1). `repackAtlases` gained `RepackOptions.trim?`
  (per-atlas, index-aligned frame-relative bboxes from `alphaBBox`) + `trimAsSpineOffset?`: a shrinkable
  untrimmed sprite is packed at the TIGHTER `{bbox.w,bbox.h}`, the Blit reads the INSET source sub-region, and
  the emitted Sprite carries `trimmed:true` + `sourceSize`(full) + `spriteSourceSize`/offset (TP top-left or
  Spine bottom-left Y-flip via `spineOffsetFrom`) — a correct NON-destructive shrink (renders identically
  in-engine from a smaller sheet). Three skeptic BLOCKERS folded in: **B1** no `minMarginPx` gate in the fix
  (trimming any shrinkable sprite is always correct) and the receipt reports the MEASURED reclaim ("reclaimed N
  px"), never the detector's "up to" promise; **B2** an UNtrimmed ALIAS of a trimmed representative INHERITS the
  rep's trim (byte-identical pixels ⇒ same bbox) — emitting a tight rect with the alias still marked untrimmed
  would be a BROKEN manifest; **B3** the no-gutter `extrudeVramDelta` baseline repack calls (Spine + rect/merge)
  receive the IDENTICAL trim so the delta isolates ONLY the gutter (else the sign flips). Worker `buildTrimArrays`
  decodes each atlas page once (LRU-cached/pinned) and computes the bbox per untrimmed frame via the SAME pure
  `alphaBBox` the analyze pass uses; fed into all 5 `repackAtlases` calls. New `RepackResult.trimmedSprites`/
  `trimmedAreaReclaimed` + `FixReceipt` fields + App receipt line + `fix.trimmedOnRepack` i18n ×9 (mirrors
  `framesAliased`). Additive: no shrinkable untrimmed sprite / trim absent ⇒ byte-identical. Tests: pure
  `fix.test.ts` (TP tighter-pack + emitted metadata, Spine Y-flip, B2 alias-inherits-trim, null/full/already-
  trimmed verbatim, additivity pin, fixture golden) + E2E `perceptual.test.ts` (decode→alphaBBox→repack realizes
  the defect: reclaimed ≥ recoverableArea, exact per-sprite packedSize===bbox, parser+pixel round-trip) + worker
  control-flow `trim-on-repack-worker.test.ts`; fixture `untrimmed-padding/expected.json` extended with the
  additive `repack` golden. Gate: typecheck + test + lint green.

- **#1 Prebuilt-atlas passthrough transcode — closes a DANGLING-REFERENCE bug**
  (`docs/improvements/round20-prebuilt-atlas-passthrough-transco.md`) — `analyze.ts` sizes ATLAS PAGES too
  (`addFormat(atlas.name, image)`), so a WELL-PACKED (high-occupancy) + correctly-sized (POT, not oversize)
  prebuilt sheet whose page transcodes smaller earns a `format` finding on its PAGE → a standalone `transcode`
  op with NO repack/resize. The old worker treated that op as a LOOSE image: it renamed `sheet.png` →
  `sheet.webp` but NEVER repointed the sidecar — `sheet.json` `meta.image` / the Spine `.atlas` texture line
  still said `sheet.png` ⇒ the loader resolved a file that no longer exists (**dangling reference / broken
  drop-in**). NEW atlas-aware branch in `fix.worker.ts` (after the profile-fanout block; the loose path is now
  reached ONLY for non-atlas refs): re-encode the existing page VERBATIM (no recompose — frame/trim/pivot/mesh
  untouched), repoint the sidecar's `meta.image` (TP) / Spine texture line at the new page via the new PURE
  `repointAtlasImage` (`packages/fix/src/atlas-transcode.ts`, the proven `relativeImageRef` inverse → resolves
  back through `@asset-doctor/parsers`), re-emit the sidecar deterministically, and DROP the old page
  (`replaced.add`). Skeptic blockers folded in: **B1** the KTX2 candidate is recorded for TexturePacker ONLY
  (the post-pass hardcodes `.json`→`.ktx2.json` + `emitTexturePackerJson`, so a Spine `.atlas` would ship a
  malformed `.ktx2.json`); **B2** a general size-loss guard (`enc >= src` PLUS the opaque `transcodeIsSizeLoss`
  parity) KEEPS the original page + original sidecar when the re-encode isn't smaller — the fix that fixes
  dangling refs never CREATES one by shipping a worse page; **M1** `recordVariant`/`repackChanges`/
  `referencesChanged` fire UNCONDITIONALLY (a transcode ALWAYS renames the page by extension — NOT the
  `hashOn`-gated stable-name drop-in resize-atlas uses); **M3** a transcoded atlas page that is a retained dedup
  OWNER updates `ownerActualName`/`ownerActualUnhashed` so Phase-C repoints CONSUMERS at the real page. Fail-safe
  honest skips: missing sidecar, multi-page Spine (`emitSpineAtlasText` writes ONE page), encode-unavailable.
  HONESTY (invariant 5): identical pixel dims ⇒ identical RGBA8888 VRAM ⇒ NO `vramSaved` increment (disk-only).
  Dry-run preview updated to predict `referencesChanged` for an atlas transcode (matches execute). ADDITIVITY:
  off / no-atlas-target ⇒ byte-identical (the loose path is untouched; a non-atlas ref never enters the block).
  Tests: pure `packages/fix/test/atlas-transcode.test.ts` (TP/Spine repoint round-trip through `parseAtlasManifest`
  / `parseSpineAtlasText` + `resolveImageRef` incl. same-dir / cross-dir / cache-busted; no-dangling-ref
  membership; frame-verbatim) + worker-seam `apps/web/test/atlas-transcode-worker.test.ts` (Harness A: the real
  analyze→plan path yields exactly one transcode op on the atlas page with no repack/resize; Harness B: emit→
  parse→resolve leaves no dangling ref; Harness C: B2 size-loss / multi-page Spine / sidecar-unavailable / B1
  Spine-no-KTX2 / M3 dedup-owner decision predicates; additivity: a loose transcode emits no sidecar). Gate:
  typecheck + test + lint green.

- **#2 Close the i18n-app-keys guard's dynamic-key blind spots** (test-only hardening,
  `docs/improvements/round20-close-the-i18n-app-keys-guard-s-dy.md`) — the `apps/web/test/i18n-app-keys.test.ts`
  guard scanned only `App.tsx + FilmViewer + VerdictBar + TriageLedger` and expanded only the
  `fix.pack.{mode,grouping}.*` + `triage.{filter,sort,scope}.*` dynamic templates, so **four** other
  `t(`prefix.${…}`)` classes rendered raw dotted keys on a future rename, undetected by the catalog drift test:
  `severity.${f.severity}` (App.tsx + the previously-unscanned Findings.tsx), `license.err.${…}` (the unscanned
  LicensePanel.tsx), and `fix.lazy.${s}` + `fix.op.${…}` (both ALREADY inside the scanned App.tsx but with no
  expansion branch). NOW: Findings.tsx + LicensePanel.tsx added to `appSrc`; four new `expandedDynamicKeys`
  branches — `fix.op.*` import-backed by the live `OP_KIND_ORDER` verb set (+`'other'` UI bucket) so it
  self-maintains, `severity.*`/`license.err.*`/`fix.lazy.*` mirror a type-only union / private `KNOWN_CODES` Set,
  each pinned by a per-class drift-guard `it()` block asserting every suffix resolves in `CATALOGS.en`. All
  referenced keys already exist in en (and all 9 locales) ⇒ pure regression-hardening, NO catalog change, NO app
  behavior change; the guard is now red on any future rename of these keys. Gate: typecheck + test + lint green.

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
