# Asset Doctor — changelog (per round)

Living log of the autonomous improvement loop. One entry per round; each round = a
design→skeptic→impl→adversarial-review→fix cycle, independently verified green and committed
small on branch `feat/asset-pipeline` (= local `main`). Newest first.
**Each new round MUST append its entry here.** `origin/main` is at `54c1a3a` (deploy blocked: no
GitHub creds — user pushes); commit hashes below are over that base.

> Convention: `commit` · what shipped · review verdict · gate. Designs live in `docs/improvements/round*.md`.

---

## Round 24 — selection (#0 shipped) — 2026-06-29
Pick: **(#0) libvips lanczos3 resample sidecar op + honest measured-quality receipt** — the scale-tier
DOWNSCALE path uses the browser canvas resampler, which can't be steered to a specific kernel. This adds an
OPT-IN backend `resample` op (libvips lanczos3) that downscales the full-res top tier with a high-quality
kernel and REPLACES the browser tile at the SAME dimensions/format. DISK/QUALITY-only (invariant 5: same
dims ⇒ no VRAM, no disk saving); the receipt carries ONLY a MEASURED high-frequency-energy retention delta
(invariant 3: a fact, never a "sharper/cleaner" verdict — lanczos3's extra HF energy includes ringing).

- **#0 libvips lanczos3 resample op (sidecar) + measured high-frequency-energy receipt**
  (`docs/improvements/round24-libvips-lanczos3-resample-op-sidec.md`)
  — **Sidecar** (`apps/encoder`): new `Resample` op + `vips-lanczos3` profile in the closed allowlists
  (`encode.go`), a mock-testable `ResampleEncoder` shelling to a pinned `vips` over `/dev/stdin`→`/dev/stdout`
  (no temp files; `thumbnail_source … --size force` for EXACT tier dims, `.png[strip]` deterministic;
  `resample.go`), Dispatcher arm + `VipsPath` config + `main.go` wiring, and a pinned `libvips-tools` apt
  package + stable `/usr/local/bin/vips` symlink in the Dockerfile. The op-agnostic gateway (`apps/api`)
  needed ZERO changes (verified). W/H ASYMMETRY: for resample they are the OUTPUT target the full-res source
  is downscaled TO (documented; tested). **Client**: `'resample'` in `NativeOpKind` + `profileForOp` +
  `RESAMPLE_PROFILE`; pure Node-tested HF-energy measure (mean |Laplacian| over luma → clamped retention
  delta, `resample-quality.ts`) + pure gated predicate (`resample-collect.ts`); a GATED worker tier post-pass
  that uploads the full-res top tier (PNG-re-encoded, M2), gets the vips tile, measures the delta, re-encodes
  to each tier format, and replaces the browser tile IN PLACE. **B1 (cache-busting integrity)**: chose the
  design-accepted simpler v1 — resample is GATED OFF when `hashFilenames` is on (an in-place replace under
  content-hash names would leave the hash describing the OLD bytes), with an honest tier-path skip note;
  never an unconditional in-place replace. **B2**: a SEPARATE new `fix.backend.resampleTierHint` key on the
  tier path only — `whyNoKernel` left UNTOUCHED (still true at its 2 non-tier sites). **M1**: the receipt
  field is `qualityHfEnergyDelta` ("retained N% more high-frequency content at the same file size"), clamped
  ≥0, ≤0 keeps the browser tile (delta 0, not failed); NO VRAM/disk field. ADDITIVE: backend off / op not
  selected / declined / hashFilenames on ⇒ the existing OffscreenCanvas tier downscale runs ⇒ byte-identical.
  SAFETY (round12/13 parity): opt-in, per-run consent, entitlement-gated, sidecar non-root/RO/stdin-stdout.
  Live e2e deferred (deploy creds-blocked); shipped behind a mock Encoder + pure helpers like toktx/pngquant.
  — **Tests**: sidecar `resample_test.go` (closed flags, op/profile/dims reject pre-exec, missing-binary
  no-byte-leak, `/bin/cat` stdin→stdout passthrough, empty-output fail, Dispatcher routing) + allowlist
  assertions + `server_test.go` (op-propagation success, op×profile 415, full-res caps 413/415); TS
  `resample-quality.test.ts` (sharp>blur, identical=0, ≤0 clamp, flat=0, determinism) +
  `resample-collect.test.ts` (opt-in gate + the B1 hashFilenames interaction) + i18n drift (6 new keys × 9
  catalogs; `whyNoKernel` asserted unchanged). Review verdict: SALVAGEABLE → all 2 blockers + 2 majors fixed.
  Gate: typecheck + vitest + lint + `go build/vet/test` (encoder + api) green.

## Round 23 — selection (#0 shipped) — 2026-06-29
Pick: **(#0) bitmap-font (.fnt BMFont) parser + ingest grouping + glyph-page audit** — AngelCode BMFont
glyph sheets were an unrecognized file type (silently dropped). A parsed `.fnt` page is structurally an
atlas, so this teaches the pipeline to ingest it and surfaces a font-specific readout BESIDE the generic
atlas findings it already trips.

- **#0 Bitmap-font (.fnt BMFont) parser + ingest + glyph-page readout**
  (`docs/improvements/round23-bitmap-font-fnt-bmfont-parser-inge.md`)
  — new pure `parseFntText(text) → FntPage[]` / `parseFntPage(page, image, opts) → ParseResult`
  (`packages/parsers/src/fnt.ts`), a faithful **mirror of the Spine `.atlas` module**: never throws,
  per-glyph recovery via `FntPage.malformedGlyphs` (read by the worker exactly like
  `SpinePage.malformedRegions`), NaN-preserving numeric reads (a non-finite required field drops the glyph,
  never coerced to 0), OOB/degenerate-rect recovery, quote-aware `face=`/`file=`. **TEXT format only**; XML
  (leading `<`) + binary (`BMF\x03`) `.fnt` → honest `unparsed[]`, never silent-dropped. **Multi-page is
  keyed by `char.page` id** (in BMFont TEXT every `char` line follows ALL `page` lines, so a "most-recent
  page" rule would dump every glyph on the last page — the skeptic-flagged correctness/determinism defect);
  pages emitted id-sorted. A whitespace glyph (`width=0 height=0`, e.g. id=32) is skipped, not an error.
  Each `char` → a `Sprite` (frame x,y,width,height; sourceSize from width/height; `trimmed:false` —
  xoffset/yoffset are layout offsets, NOT in-page trim, so occupancy stays the honest packed coverage).
  — ingest `groupFiles` recognizes `.fnt`, resolves each page image **dir-aware** (reusing
  `resolve`/`keyOf`/`atlasName`), routes it as `GroupedAtlas.kind: 'bmfont'`; XML/binary/empty `.fnt` →
  `unparsed[]` (`packages/ingest/src/index.ts`).
  — core: `AtlasSourceKind += 'bmfont'`, `Rule += 'font-glyph-page'`, `ThresholdConfig.fontGlyphPage?:
  { minChars, occupancyWarn }` (default `{ 16, 0.5 }`). new analysis `fontGlyphPageFinding`
  (`packages/analysis/src/font.ts`): glyph-page occupancy + glyph count + kerning-present, positive-guarded
  on `source.kind === 'bmfont'`; `analyze.ts` threads a new `AnalyzeDeps.fontPages` dep (face + kerning,
  keyed by atlas.name).
  — worker routes `a.kind === 'bmfont'` → `parseFntPage` + per-glyph `<page>#<id>` recovery + builds
  `fontPages` (`apps/web/src/worker/analyze.worker.ts`). i18n `find.font-glyph-page.{title,detail,fix}` in
  all 9 catalogs (drift-guarded + 9-locale parity). Golden fixture
  `fixtures/sample-projects/bmfont-sparse/` (a 16-glyph sparse `.fnt` + PNG, a whitespace glyph + an OOB
  recovery glyph) exercised through the **REAL path** (`groupFiles → parseFntPage → analyze` with
  `fontPages`) asserting the `font-glyph-page` finding **FIRES** (warn) alongside the generic occupancy
  (crit) + wasted-regions (info) findings.
  **DIAGNOSIS-ONLY** (invariant 3 — nothing generated). **Invariant 5 (no double-count):** the readout's
  `estimate` carries **only** `occupancyPct` — the generic occupancy/oversize findings own the VRAM (w·h·4)
  on the SAME page; NO fabricated disk/VRAM-saved. **Fix-path SAFE with ZERO change** (verified): the fix
  branches only on `opts.kind === 'spine'` and **emits** `source.kind`, never reads an incoming
  `AtlasSourceKind`, so a `'bmfont'` atlas needs no fix wiring. **Additive:** no `.fnt` present ⇒ all output
  byte-identical (CLI/headless unaffected — `fontGlyphPage` is NOT enumerated by `resolveThresholds`).
  **Skeptic fixes (load-bearing):** (1) multi-page glyph attachment keyed by `char.page`, NOT most-recent
  page; (2) the fabricated App.tsx source-kind label task was DROPPED (no such UI exists — `atlas.source` is
  never rendered).
  - Gate: `pnpm typecheck && pnpm test && pnpm lint` green.

- **#1 Re-sync the untrimmed-padding generator for idempotency (Case 20 repack block)**
  (`docs/improvements/round23-re-sync-the-untrimmed-padding-gene.md`)
  — `fixtures/_generator/generate.mjs` Case 20 (`untrimmed-padding`) built `regions`/`recoverableArea`/
  `vramBytesSaved` but **no longer emitted the r20 `repack` block** the committed
  `untrimmed-padding/expected.json` golden carries (`trimmedSprites`/`trimmedAreaReclaimed`/`perSprite`), so
  a plain `node generate.mjs` re-run **silently dropped** it — latent generator non-idempotence that would
  break the two `repack` readers (`packages/fix/test/fix.test.ts`, `apps/web/src/lib/perceptual.test.ts`
  trim-on-repack e2e).
  — Re-added the `repack` emission **DERIVED from the same `specs[]`** that build the regions:
  `trimmedSprites = untrimmedSpecs.length`, `trimmedAreaReclaimed = recoverableArea` (the already-computed
  Σ(frame−bbox) over untrimmed specs), `perSprite[].{packedSize=(bw,bh), sourceSize=(CELL,CELL),
  spriteSourceSize=(mx,my,bw,bh)}` — computed, **never hand-copied numbers**; `trimmed_0` excluded via
  `!s.trimmed`. Key order preserved (`repack` between `vramBytesSaved` and `findings`).
  — Regenerated the golden so generator output **=== committed golden**: the only byte-change is the
  `perSprite` block reformatting from hand-authored single-line to canonical `JSON.stringify(_,null,2)`
  multi-line (semantically identical — verified whitespace-stripped equal; all 6 readers `JSON.parse`).
  **GENERATOR/FIXTURE ONLY** — no source/behavior/contract change. **Idempotency VERIFIED:** after staging,
  `node fixtures/_generator/generate.mjs` produces ZERO further git diff across all fixtures (deterministic:
  static `specs[]`, `.filter/.reduce/.map` order-preserving, integer arithmetic, no randomness/time/FS-order).
  Trim-margin e2e stays green.
  - Gate: `pnpm typecheck && pnpm test && pnpm lint` green; `node fixtures/_generator/generate.mjs &&
    git status --short` → no fixture diff.

- **#2 `includeFileSizes` → `progressSize` in the PixiJS manifest (AssetPack parity)**
  (`docs/improvements/round23-includefilesizes-progresssize-in-t.md`)
  — OPT-IN, DEFAULT OFF. When enabled, every `src` candidate in the emitted PixiJS-v8 `manifest.json` becomes
  `{ src, progressSize }` instead of a bare string — the **REAL field AssetPack 1.7.0 emits**
  (`pixiManifest.js:139-142`, verified on disk by the design), so PixiJS shows accurate `Assets.load`
  progress over the transport. `progressSize` is the size in **KB to 2 decimal places**: AssetPack's
  `getFileSizeInKB` divides the byte length by 1024 in **both** branches (`utils.js:24-42`), so `'raw'` =
  uncompressed KB (`statBytes/1024`) and `'gzip'` = gzipped KB (`gzipBytes/1024`) — **both are KB**, never
  bytes-out.
  — PURE builder (`packages/fix/src/pixi-manifest.ts`): new `PixiSizedSrc { src; progressSize }`,
  `PixiUnresolvedAsset.src` widened to `string[] | PixiSizedSrc[]`, `BuildPixiManifestOptions.includeFileSizes?:
  false | 'raw' | 'gzip'` + `srcBytes?: ReadonlyMap<string, number>` (the FINAL emitted byte length per `src`,
  supplied by the worker). One branch in the per-tier loop maps each sorted `src` to `{ src, progressSize:
  kbOf(srcBytes.get(s) ?? 0) }`. **`EmittedVariant` unchanged** (no per-variant `bytes` — the size comes from
  the worker's post-replace byte map, not the push site). Re-exported `PixiSizedSrc` from `index.ts`.
  — Worker (`apps/web/src/worker/fix.worker.ts`): SINGLE edit at the manifest build site — builds
  `srcBytes` over **`dedupedOut`** (the FINAL shipped bytes, keyed by the exact paths the manifest `src`
  uses), so pngquant/KTX2 **in-place page replacement is reflected honestly** (no stale lossless size). New
  top-level `gzipLen()` via the standard Worker `CompressionStream('gzip')` (no network, no native lib —
  invariant 1) supplies the `'gzip'` byte source. The builder call is **spread-gated** so OFF ⇒ neither option
  reaches the builder.
  — `FixOptions.includeFileSizes?: 'raw' | 'gzip'` (`fix-protocol.ts`); App.tsx `includeFileSizes`
  state + a `<select>` (Off / Uncompressed KB / Gzip KB) **disabled unless the Pixi manifest is emitted**
  (`effectiveEmitManifest`), wired through `buildOptions` (UI values ARE the contract values — no remap).
  i18n: 5 new keys (`fix.includeFileSizes`, `…Hint`, `.off/.raw/.gzip`) across all 9 catalogs (drift-guarded).
  — **HONESTY (invariant 3):** both modes are MEASURED from the actually-shipped bytes; nothing estimated or
  fabricated. **ADDITIVITY:** absent/`'off'` ⇒ bare-string `src` ⇒ the manifest is **BYTE-IDENTICAL** to today
  (no `progressSize` field anywhere). **Invariant 5:** `progressSize` is disk/download size, never summed into
  VRAM or any saving. **DETERMINISM:** pure math for `'raw'`; gzip length is platform-stable (golden tests
  assert `'raw'` exactly, gzip only as a bound).
  — Tests (`packages/fix/test/pixi-manifest.test.ts`, T17-T24): off-path byte-identity (srcBytes ignored when
  the flag is absent), `'raw'` shape + KB values + format order, KB rounding parity (1536→1.5, 300→0.29,
  0→0), sheet ⇒ sidecar size (image not in src), determinism under shuffled input, missing-src ⇒ 0,
  field-name lock (`progressSize` present, `fileSize`/`size` absent), and a real-path multi-tier+atlas fixture
  proving it fires end-to-end.
  - Gate: `pnpm typecheck && pnpm test && pnpm lint` green.

---

## Round 22 — selection (#0 shipped) — 2026-06-29
Pick: **(#0) cross-atlas frame-redundancy DETECTOR** — the folder-scope sibling of within-atlas
frame-redundancy. The region hashes were already computed folder-wide in `analyze.ts` but consumed only
per-atlas, discarding the cross-atlas comparison; this clusters them across ALL sheets.

- **#0 Cross-atlas frame-redundancy detector** (`docs/improvements/round22-cross-atlas-frame-redundancy-detec.md`)
  — new folder-scope `crossAtlasRedundancyFinding(atlases, frameHashByRef, byteByRef, cfg)` (`packages/analysis/src/folder.ts`)
  clusters the SAME per-atlas region hashes the within-atlas rule consumes (built folder-wide at `analyze.ts`
  ~:119, previously only read per-atlas ~:174) and fires ONLY when a cluster spans ≥2 DISTINCT atlases
  (single-atlas clusters stay `frame-redundancy`'s job — no double-report). Reports the count of cross-sheet
  duplicate copies + **`vramBytesSaved = recoverableArea × 4` EXACT** — mirrors the shipped within-atlas
  `frameRedundancyFinding` precedent (rules.ts:232) with the SAME distinct-rect guard (a pre-aliased rect = one
  unit, applied per atlas). New `Rule` `'cross-atlas-redundancy'`; new `crossAtlasRedundancy?: { minDuplicates }`
  config (default 2 — a cross-sheet recurrence has no in-sheet-aliasing excuse); distinct `messageKey`
  `'cross-atlas-redundancy'` + `find.cross-atlas-redundancy.{title,detail,fix}` in all 9 catalogs (drift-guarded).
  Golden fixture `fixtures/sample-projects/cross-atlas-redundant/` (two sheets sharing a byte-identical textured
  frame) reproduced through the REAL decode path (decode → pure `extractFrameRegions` → SHA → finding) in
  `apps/web/src/lib/perceptual.test.ts`. **DIAGNOSIS-ONLY** (the cross-atlas FIX is a separate piece — invariant
  3, we generate nothing). **Additive:** carried in the finding only, NOT folded into `potentialDiskSaved`
  (invariant 5); absent hashes / no cross-sheet dupes ⇒ no finding ⇒ byte-identical to today.
  **Skeptic BLOCKERS (load-bearing):** (B2 honesty) NO POT-tier VRAM gate / packer — a real MaxRects pack of
  the merged set lands on a LARGER bin than the area floor, so a bin-tier delta would OVER-claim a saving no
  real merge delivers (invariant 5); VRAM is the EXACT duplicate-region px × 4, no `pack()` import, no inline
  sizer, no POT conditional. (B1) the `messageKey` is a DISTINCT value `'cross-atlas-redundancy'` (a wrong key
  silently renders the within-atlas template) — pinned + asserted in the unit + e2e tests. (M3) the copy scopes
  the claim to the DUPLICATE-FRAME area only and documents the orthogonality to atlas-merge (which reclaims
  EMPTY space — different px, additive not the same win). Disk = area-proportional ESTIMATE attributed per freed
  copy to its OWN atlas, never conflated with VRAM (invariant 5). Determinism: stable cluster representative
  (lowest `(atlasName, spriteIndex)`) + sorted ref/atlas lists. Honesty pin: `dupes = Σ(distinctUnits − 1)` =
  the exact `framesAliased` a future cross-atlas fix would report.

- **#1 Cross-atlas frame dedup during MERGE** (`docs/improvements/round22-cross-atlas-frame-dedup-during-mer.md`)
  — the Pro FIX for #0's detector: during an aggressive atlas-MERGE, dedup byte-identical frames that span
  MULTIPLE source sheets — pack ONE region per cross-sheet cluster and point every duplicate frame name (across
  ALL merged sheets) at that one region in the merged manifest. New pure `buildMergeAliasMap(group,
  frameHashByRef, minDistinctRects)` (`packages/fix/src/alias.ts`) — the WHOLE-GROUP analogue of the within-atlas
  `buildAtlasAliasMap`: clusters region hashes across the group in ONE flat `(atlasName, frameName)` keyspace.
  **B1 (load-bearing):** the distinct-rect guard is **ATLAS-QUALIFIED** (`${atlasName}|x,y,w,h`, mirroring the
  detector at `folder.ts:365`) — two byte-identical frames at coincidentally-equal coords on DIFFERENT sheets are
  two physically-distinct copies ⇒ two distinct rects (the bare within-atlas rectKey would wrongly collapse them
  to one and never fire); a pre-aliased rect WITHIN one atlas still collapses (no double-count). `repackAtlases`
  gains an optional flat `mergeAliasMap` arg (`packages/fix/src/repack.ts`): it packs ONE rep per cross-sheet
  cluster, emits a Sprite for EACH duplicate name at the rep's final rect (copying that name's OWN
  trim/pivot/sourceSize), one Blit per rep. **HONESTY:** `vramBytesBefore/After` are EXACT from the real
  `repackAtlases` of the merged group; new `RepackResult.vramReclaimedBytes` (= a no-alias BASELINE pack of the
  same group's full item set − the deduped bin) + `potTierDropped` isolate the merge's REAL measured VRAM delta —
  NOT the area-floor/POT-gate the DETECTOR (#0) avoided, because the merge actually produces the bin. When the
  dedup does NOT drop a POT tier the win is disk-only and reported as such (`crossSheetVramReclaimedBytes:0`,
  invariant 5). **B2 (worker):** `fix.worker.ts` lazily hashes any group sheet missing from `frameHashByRef` in
  the merge branch (the upfront `≥minDuplicates` pre-filter starves the headline many-small-sheets case) and
  caches it back, then builds the merge map on the cross-atlas `minDuplicates` gate (default 2) and threads it
  into both merge `repackAtlases` calls + the extrude no-gutter baseline (B3). New receipt fields
  `crossSheetFramesDeduped` / `crossSheetVramReclaimedBytes` / `crossSheetPotTierDropped` + `App.tsx` render
  (VRAM-tier vs disk-only copy) + 2 new i18n keys × 9 catalogs. **DROP-IN / NO DANGLING REF:** every original
  frame name from every merged sheet still resolves in the emitted TexturePacker JSON (round-trip tested); a
  frame whose sheet is dropped resolves to the merged region. **ADDITIVITY:** no merge / no cross-sheet dupes /
  aggressive-merge off / `mergeAliasMap` absent ⇒ byte-identical (the no-alias fields are omitted; a no-op map
  deep-equals `repackAtlases(group, opts)`). **DETERMINISM:** stable rep (lowest flat index) + sorted emit.
  Tests: `alias.test.ts` (T1 group clustering + per-atlas under-alias contrast, T1b atlas-qualified key, pre-
  aliased collapse, sub-gate carve-out, fail-safe missing hashes) + `fix.test.ts` (T2 one-region-every-name-
  resolves + one-Blit-per-rep + no-alias contrast, T2-roundtrip, T3 POT-tier-drop EXACT vram vs same-tier
  disk-only, T4 additivity deep-equal). Rides the existing aggressive atlas-merge path; rotated-mismatch +
  name-collision guards inherited from the merge path unchanged.

- **#2 Honest fix-simulation footprint preview on the Plan card** (`docs/improvements/round22-honest-fix-simulation-footprint-pr.md`)
  — the dry-run Plan card now surfaces a HONEST before→after footprint preview alongside the op counts, split into
  two stacked rows that never fabricate a total. New PURE `summarizeFixPlanFootprint(report, ops, excluded)`
  (`apps/web/src/lib/plan-footprint.ts`) aggregates ONLY the deltas knowable BEFORE compose, from the already-
  MEASURED finding geometry: **measured now** — DISK = `format`/`format-lossless` srcBytes−bestBytes for a ref with a
  SURVIVING transcode op (lossy q0.9 estimate ⇒ `estimated`, UI prefixes `~`) + `wasted-alpha` srcBytes−opaqueBytes
  for a SURVIVING opaque transcode (measured channel drop); VRAM = `dimensions-oversize` `params.vram` − to.w·h·4 for
  a SURVIVING resize (EXACT). **computed at execute** — `deferredOps` counts repack/merge/pack/dedup + the worker-
  folded scale-tier multiplier (sizes the encode/pack alone resolves) → "+N more computed at download". New optional
  `FixPlanFootprint` + `FixPlanSummary.footprint?` (`fix-protocol.ts`); the worker attaches it in the plan block over
  `countedOps`+`excluded` and folds `tierAssets` into `deferredOps` when tiering survives the mask. `PlanCard`
  (`App.tsx`) renders the two rows, disk vs VRAM VISUALLY DISTINCT (VRAM in its own teal token), each segment only
  when >0 (a VRAM-only plan never shows a fabricated "disk −0 B").
  **HONESTY (load-bearing, invariants 3/5):** the preview sums ONLY pre-compose-knowable numbers; disk and VRAM are
  kept DISTINCT (never a combined headline); a transcode never feeds VRAM and a resize never feeds disk; **npot/solid
  are EXCLUDED entirely** (planFix emits no op for them, and a resize achieves neither their POT-padding nor 1×1
  reclaim — different non-additive baselines, would fabricate a win the run never produces); an op that contributes
  nothing knowable is excluded and counted honestly as deferred. DIAGNOSIS objectivity preserved — this is a fix-PLAN
  preview (the plan exists; it generates nothing). **ADDITIVE:** nothing measurable ⇒ `undefined` ⇒ no footprint
  attached ⇒ the Plan card is byte-identical to today. **DETERMINISM:** stable Set/Map sums over the deterministically-
  ordered findings/ops, no Date/random. i18n: 3 new keys (`fix.plan.measuredNow` label + `measuredNowDisk`/
  `measuredNowVram` with `{disk:bytes}`/`{vram:bytes}` hints, split so a VRAM-only plan shows no disk row + `alsoRuns`
  plural `{n}`) × 9 catalogs (drift + plural-render guarded); `fix.plan.deferredNote` extended with the estimate vs
  exact + at-download caveat. Tests: PURE `apps/web/test/plan-footprint.test.ts` (correct buckets, disk≠VRAM,
  invariant-5 separation, op-gating, format∩wasted-alpha-once, mask zeroing, BLOCKER-1 npot/solid 0-VRAM regression,
  deferredOps, empty⇒undefined, negative-clamp, determinism) + `plan-worker.test.ts` (rewritten honesty assertion —
  optional top-level footprint with DISTINCT disk/VRAM, repack-is-deferred headline honesty, mask-all⇒undefined).

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

- **#1 Per-frame recovery for TexturePacker/Pixi atlases** (`docs/improvements/round21-per-frame-recovery-for-texturepack.md`)
  — `parseAtlasManifest` used to WHOLE-REJECT a sheet on the first unusable frame (`{ok:false}`), losing 499
  good frames for 1 corrupt one. Now it RECOVERS the good sprites and collects each dropped frame into
  `malformedFrames[] {name, reason}` — symmetric with the Spine per-region recovery already shipped. The
  array/hash frame loops and the out-of-bounds pass became per-frame partitions (skip + surface) instead of
  whole-manifest bails; the analyze worker fans `res.malformedFrames` into the existing `unparsed[]` channel
  as `<atlas>#<frame>` (deterministic, sorted). HONESTY (invariant 3): every dropped frame is reported with a
  reason — nothing silently dropped or clamped. ADDITIVITY: a fully-valid atlas parses byte-identically (same
  sprites, same order, no `malformedFrames` field); an EMPTY `frames` object still returns `{ok:true,
  sprites:[]}` (zero-survivor guard gated on `malformedFrames.length>0`); an ALL-bad manifest still
  wholesale-fails with today's first-failure error (preserves the F3 single-frame-sheet tests). STRUCTURAL
  failures (bad JSON / no frames object / no `meta.image`) still wholesale-fail at ingest/parse as before.
  Contract is additive only: optional `malformedFrames` on `AtlasParseResult`'s ok-branch + a local return
  widen on `parseAtlas` (no `@asset-doctor/core` / `ParseResult` change; all other callers destructure
  `{ok,asset}` and ignore the extra prop). New fixture `fixtures/sample-projects/atlas-frame-recovery/`
  (Hash with a degenerate `w:0` frame + Array with an OOB frame, reproduced through the REAL parse path) +
  golden `expected.json`. Tests: 5 parser units (Hash/Array recovery, zero-survivor still `{ok:false}`,
  empty-frames byte-identity, clean-sheet has no field) + 1 e2e worker-path `it` (group→parse→fan-out→analyze
  surfaces `sheet.png#bad.png` + `sheet.png#over.png` while the good frames stay diagnosed).
  **Gate:** `pnpm typecheck` + `pnpm test` (parsers 17→22, apps/web 407→408; all packages green) + `pnpm lint` clean.

- **#2 Bound the analyze (FREE-path) worker's resident bytes** (`docs/improvements/round21-bound-the-analyze-free-path-worker.md`)
  — kills the genuine ~2× source-byte copy on the free diagnosis path and makes the previously-SILENT oversize
  scan skips honest. **(a) Transfer + lazy re-read.** `runAnalysis` now TRANSFERS each `PickedFile.bytes` into
  the analyze worker (the worker becomes the SOLE resident copy) when EVERY file carries a re-readable `file`
  (additive `PickedFile.file?: File`, populated by all three ingest paths); else it CLONES (today's behavior) so
  legacy callers stay correct. The main thread no longer keeps an eager dir-aware byte `map` (which had captured
  `f.bytes` BEFORE the transfer ⇒ would have held DETACHED buffers — the sequencing BLOCKER) — it RE-READS from
  disk on demand via new pure `lib/source-bytes.ts` (`readSourceBytes` / `sourceReaders`, keyed by the SAME
  `keyOf`). The FilmViewer selection (async-resolved into state, cancel-guarded; null ⇒ honest "no image"
  branch, never a fabricated film), the render-probe (`attachProbeReadings` `bytesOf` widened to async + an
  extra post-re-read abort guard), and the fix path (FixCard re-sources fresh bytes before `planFix`/`runFix`;
  any null ⇒ honest refuse, never a corrupt zip) all read through it. **(b) Honest oversize skips + cap unify.**
  The worker's full-resolution `decodeFeatures` alpha scan and `hashAtlasFrames` page read are gated by the
  shared `pageExceedsScanBudget` / surfaced via `scanSkipReason` (new in `lib/bitmap-budget.ts` as the
  single-sourced `ANALYZE_PAGE_MAX_PX` — `perceptual.FRAME_HASH_MAX_PX` now re-exports it; the worker's inline
  `ALPHA_SCAN_MAX_PX` is deleted, ending the byte-identical-but-forked drift). An oversize page now lands a
  `{ref, reason}` in the existing `unparsed[]` (px-cap vs sprite-cap kept as TWO distinct reasons via a
  discriminated `hashAtlasFrames` result) instead of vanishing silently; the `unparsed.sort()` is hoisted to
  AFTER both push-loops so order is deterministic. **No `BitmapBudget` LRU instance in the analyze worker** — its
  decoded bitmaps are already `close()`d eagerly (no many-live working set, unlike the FIX worker), so an LRU
  here would be dead code; the honest, no-fork reuse of `bitmap-budget.ts` is its px-cap POLICY half (a
  documented working-set bound, Inv 5 — never a VRAM/saving number). HONESTY (Inv 3/5): re-read bytes are
  byte-identical to the original ⇒ identical findings/report/overlay; the cap value is unchanged ⇒ the same
  pages are scanned ⇒ no measured-number drift. ADDITIVITY: under the cap nothing is skipped and no `unparsed`
  entry is added; a legacy `PickedFile` (no `file`) still clones. Inv 1: transfer is intra-process, re-read is
  local disk — zero network. Inv 4: transfer is cheaper than clone and re-reads are lazy (selected/probed/fix)
  ⇒ off the ≤10s critical path. Tests: extended `bitmap-budget.test.ts` (the cap predicate boundary/degenerate,
  `scanSkipReason` determinism, the `perceptual.FRAME_HASH_MAX_PX === ANALYZE_PAGE_MAX_PX` drift-guard); new
  pure `source-bytes.test.ts` (exact bytes, null-on-missing-file, null-on-reject, dir-aware keys, laziness); new
  `analyze-transfer-skip.test.ts` (runAnalysis posts a non-empty transfer list when all files have `file`, empty
  when one lacks it; the worker's whole-page skip mapping fires SELECTIVELY, surfaces the two distinct reasons,
  and sorts deterministically).
  **Gate:** `pnpm typecheck` + `pnpm test` + `pnpm lint`.

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
