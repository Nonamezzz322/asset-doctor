import type { ThresholdConfig } from '@asset-doctor/core';

/** Default audit thresholds. Provisional — calibrate on fixtures, then on real assets.
 *  Kept here as the single source so rule logic never hardcodes magic numbers. */
export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  occupancy: { warn: 0.8, crit: 0.6, minWastedBytes: 262_144 }, // fraction of atlas area covered by frames
  // (calibrated on real packed exports: median 0.92). minWastedBytes (CALIBRATE): absolute floor on the
  // wasted bytes (1−occ)·w·h·4 below which the fractional severity demotes to 'info' — severity was purely
  // fractional, so a 256² sheet wasting ≲250 KB outranked megabytes of conditional mip cost (mipmap.warn
  // below needs 4 MB for a mere info). 256 KB = one full 256² RGBA page. The 3 surviving real-corpus warns
  // (docs/calibration.md: ~998px sheets at occ≈0.78 ⇒ ≥~876 KB waste) clear the floor 3.3×; strict `<` in
  // the rule so waste === floor keeps the fractional severity. The finding never disappears — the waste
  // stays reported with identical copy/params, it just stops being headline-grade.
  oversizePx: { warn: 2048, crit: 2730 }, // longest texture edge, px (budget-Android GL_MAX often 2048; crit = mid-device danger line)
  formatSaving: { warn: 0.25, minBytes: 4096 }, // CALIBRATE — fraction of disk bytes a better format
  // could save (warn) + absolute floor on the MEASURED saved bytes (minBytes). A tiny icon "saving 35%"
  // is a few hundred bytes of noise — same rationale as strippableMetadata.minBytes below (a tiny tIME
  // chunk is noise). Real transcode wins on game art clear 4 KB easily. Strict `<` in the rule, so
  // saved === 4096 fires. Suppression also shrinks potentialDiskSaved (analyze.ts bumpBest) and the
  // folder format-aggregate for free — both consume only surviving findings.
  npotPadding: { warn: 0.25 }, // POT-padding waste before an NPOT finding fires (NPOT alone is fine on WebGL2/Pixi)
  duplicates: { similarHammingMax: 6, maxMeanColorDelta: 24 }, // dHash bits that may differ for "near-identical".
  // maxMeanColorDelta (CALIBRATE): max per-channel |Δ| of the alpha-weighted 9×8 mean color before two
  // dHash-close images are refused as a near-dup pair — dHash is luma-sign-only (color-blind), so a red gem
  // and its blue tint-recolor hash identically. A re-export/recompression shifts channel means ≲8 (lossy DC
  // averages are preserved closely); a saturated hue swap moves ≥1 channel ≳60 (e.g. 200,40,40→40,40,200 is
  // Δ160). 24 splits the two regimes with margin. Verify on the real slot corpus: genuine re-export clusters
  // must survive, recolored symbol sets must split. Guard self-skips when either side lacks meanColor
  // (CLI/headless features carry none ⇒ CLI findings byte-identical).
  shouldAtlas: { minLooseImages: 8, maxSpriteEdgePx: 512, dominatedFraction: 0.5 }, // loose sprites worth packing.
  // dominatedFraction (0.5 — PROVISIONAL, calibrate): BROWSER-ONLY presentation gate (primary-card prominence +
  // collapse-default). Fraction of ALL assets (big loose + every atlas in the denominator) that must be packable
  // loose sprites before the folder reads as loose-dominated — so a background/atlas-heavy folder (8 loose beside
  // 500 atlases) scores LOW and is NOT promoted/collapsed. NO rule reads it (shouldAtlasFinding is unchanged), so
  // it passes through resolveThresholds inertly and CLI/budget output stays byte-identical.
  atlasMerge: { occupancyBelow: 0.5, minAtlases: 2, packEfficiency: 0.8 }, // under-filled atlases worth merging.
  // packEfficiency: realistic packing density we credit a merged repack with. The merged-sheet count (and
  // thus the reclaimed VRAM) is derived from sprite AREA; a naive area/capacity ratio assumes a perfect 100%
  // pack, over-stating the saving (invariant 3/5 — estimates must be conservative TRUE lower bounds). We
  // DISCOUNT usable capacity by this factor (usable = capacity × packEfficiency, folder.ts) so the sheet
  // count rounds UP toward a realistic repack. 0.8 == occupancy.warn:
  // we credit the merge with reaching at most the density we ourselves call "well-packed", never better. Real
  // MaxRects/TexturePacker exports land ~0.80-0.92, so 0.8 is the conservative (under-claiming) end. Raising
  // minAtlases also lets the "no clear win" guard suppress marginal merges. NOT a rigorous adversarial bound
  // (a few un-co-tileable large rects can still exceed any area formula — out of scope); it removes the
  // systematic best-case over-claim.
  mipmap: { warn: 4_194_304 }, // total conditional mip overhead (bytes) before the aggregate info fires.
  // One 2048² atlas alone is +5.59 MB and trips it; small UI-only sets (a 1024² page is only +1.33 MB) stay quiet.
  fragmentation: { warn: 0.4 }, // empty-space dispersion (largest hole / total empty) at/below which the
  // waste reads as shredded. The honest copy is dispersion-AWARE (scales the "full repack, not a trim"
  // wording with the measured frag at any value); it does NOT switch on this threshold today — the
  // value is the calibration hook for a future standalone fragmentation finding. PROVISIONAL — a
  // display/copy gate ONLY, NOT a savings gate (a MaxRects repack reclaims waste at any dispersion).
  solidFill: { minEdgePx: 256, warnEdgePx: 1024 }, // CALIBRATE — single-color loose image gate.
  // Both edges ≥ minEdgePx before flagging (a tiny swatch is harmless); ≥ warnEdgePx ⇒ warn (a 1024²
  // solid pins 4 MB VRAM for one color), else info. Loose-only; atlases never trip it.
  effectiveResolution: { minEdgePx: 256, warnEdgePx: 1024 }, // CALIBRATE — provable-upscale (upscaled-source)
  // report gate. The upscale is a PROOF (blockUpscaleDepth ≥ 1), so these numbers only suppress trivially
  // small savings: longest edge ≥ minEdgePx before flagging; ≥ warnEdgePx ⇒ warn, else info. Loose-only.
  wastedAlpha: { minEdgePx: 64, minDiskSaving: 0.05 }, // CALIBRATE — fully-opaque-with-alpha-channel gate.
  // A loose PNG/WebP whose alpha is 255 everywhere carries a dead channel. Both edges ≥ minEdgePx before
  // flagging; the measured opaque re-encode (same format) must save ≥ minDiskSaving of disk bytes before
  // the finding fires. DISK-only (invariant 5: the GPU still allocates RGBA8888). Loose-only; atlases
  // never trip it. Browser-only — NOT in resolveThresholds (the CLI/budget gate never opts in).
  frameRedundancy: { minDuplicates: 3 }, // CALIBRATE — within-atlas duplicate-frame gate. A cluster of
  // byte-identical sprite REGIONS this large (counted by DISTINCT packed rect) before the finding fires:
  // a stray dupe pair is often a deliberate shared region, a redundant animation set is many. Recoverable
  // atlas AREA → VRAM; the disk number is an area-proportional ESTIMATE (invariant 5). Browser-only — NOT
  // in resolveThresholds (the worker hashes regions off the already-decoded page; the CLI never opts in).
  trimMargin: { minMarginPx: 4, minRecoverablePct: 0.05 }, // CALIBRATE — untrimmed-sprite transparent-padding
  // gate. `minMarginPx`: the largest single-side transparent border a sprite must carry before it counts (a
  // 1–2px border is noise / deliberate bleed). `minRecoverablePct`: the summed reclaimable margin must reach
  // this fraction of the WHOLE atlas before firing (baked-in uniform-cell padding is common and sometimes
  // intentional, so the floor keeps it quiet). Recoverable atlas AREA → VRAM (exact); the disk number is an
  // area-proportional ESTIMATE (invariant 5). Browser-only — NOT in resolveThresholds (the worker computes
  // opaque bboxes off the already-decoded page, the SAME pass as frameRedundancy; the CLI never opts in).
  crossAtlasRedundancy: { minDuplicates: 2 }, // CALIBRATE — cross-atlas duplicate-frame gate. The number of
  // DISTINCT SHEETS a frame must recur on before firing (each atlas contributes one unit; an atlas's own
  // intra-atlas dupes are frameRedundancy's reclaim, not counted here). Lower than the within-atlas
  // frameRedundancy gate (3): a frame recurring across SEPARATE sheets has no in-sheet-aliasing excuse —
  // 2 copies on 2 sheets is already a genuine cross-atlas redundancy. Recoverable duplicate-region AREA → VRAM (exact, ×4); the disk number is
  // an area-proportional ESTIMATE never folded into totals (invariant 5). ORTHOGONAL to atlasMerge (empty px
  // vs duplicate-frame px). Browser-only — NOT in resolveThresholds (clusters the SAME region hashes the
  // worker already computes off the decoded page; the CLI never opts in).
  fontGlyphPage: { minChars: 16, occupancyWarn: 0.5 }, // CALIBRATE — bitmap-font glyph-page gate. A parsed
  // BMFont `.fnt` page IS an atlas; this surfaces a font-specific readout (glyph-page occupancy + glyph
  // count + kerning-present) ALONGSIDE the generic atlas findings. `minChars`: a page must expose ≥ this
  // many glyphs before the readout fires (a handful of glyphs is not a real font sheet). `occupancyWarn`:
  // glyph-page occupancy at/below which the readout is `warn`, else `info`. The estimate carries ONLY
  // occupancyPct — the generic occupancy/oversize findings own the VRAM (w·h·4) on the SAME page; this rule
  // never double-counts (invariant 5). Browser-only — NOT in resolveThresholds (the CLI never opts in).
  bleeding: { minPairs: 4, warnPairs: 16 }, // CALIBRATE — texture-bleeding gate. Atlas frame PAIRS sharing
  // an edge with 0px gutter (pure rect math, no decode). `minPairs` (4): adjacent pairs before the info
  // finding fires (a few touching frames is common/harmless under nearest-neighbor). `warnPairs` (16): at/above
  // ⇒ warn (a sheet broadly packed without gutters). CORRECTNESS finding — NO disk/VRAM saving (edge-extrude
  // can GROW the sheet, invariant 5); info/warn only. Browser-only — NOT in resolveThresholds (the CLI never
  // opts in). Provisional defaults; calibrate against real exports (a TexturePacker sheet packed with
  // padding>=1 produces ZERO pairs and must stay silent — the key calibration check).
  dimensionMismatch: { tolerancePx: 2 }, // CALIBRATE — declared(meta.size)-vs-real(image pixels) gate. Fires
  // only when |declared − real| > 2px on either axis. WHY 2px: a 0–2px difference is benign rounding (an
  // odd-trimmed export, a 1px content-extent shave) and must stay SILENT; a real stale/downscaled/POT-rounded
  // manifest diverges by ≥ a meaningful margin (typ. 24/48/whole-power-of-two px). Healthy trimmed atlases do
  // NOT diverge at all (TexturePacker writes meta.size == the trimmed sheet == the real image). Absolute px
  // (not %): the dangerous physics is absolute (a frame sampling 24px past the real edge is a torn sprite; a
  // % gate would false-positive a 1px overrun on a huge sheet and miss a 24px overrun on a small one).
  // CORRECTNESS finding — NO disk/VRAM saving (invariant 5). Fires on CLI audit/init (DEFAULT_THRESHOLDS)
  // honestly; a budget config that omits the key suppresses it (mirrors bleeding).
  strippableMetadata: { minBytes: 4096, warnBytes: 65536 }, // CALIBRATE — strippable ancillary-metadata gate.
  // A loose/atlas-page image carrying ICC/EXIF/XMP + non-essential chunks the GPU never uses. `minBytes`: the
  // metadata must reach ≥ this (4 KB) before flagging (a tiny tIME chunk is noise). `warnBytes`: at/above this
  // (64 KB — a fat embedded ICC profile) the finding is `warn`, else `info`. The estimate carries ONLY
  // diskBytesSaved (EXACT, header-measured) — DISK/DOWNLOAD only (invariant 5: the GPU still allocates
  // RGBA8888). Browser-only — NOT in resolveThresholds (the CLI never opts in; mirrors wastedAlpha).
  premultipliedAlpha: { minEdgePixels: 24, fringeFrac: 0.75, minSprites: 2 }, // CALIBRATE — premultiplied-
  // shaped-edges disclosure gate (SYNTHETIC-calibrated; real-corpus calibration pending — the FOLDER-level
  // surface keeps noise bounded regardless: one info finding per folder, never a per-sprite flood).
  // `minEdgePixels` (24): a sprite must expose ≥ this many TRUE anti-aliasing transition pixels (adjacent to
  // a bright near-opaque pixel with a real luma·(1−α) gap) before its edge shape is even classified — a
  // handful of edge pixels is statistically meaningless. `fringeFrac` (0.5): ≥ half of those must be
  // dark-fringing (implied matte collapses toward black) before the sprite is flagged — a correct straight-
  // alpha sprite measures ~0, a premultiplied/black-matted one ~1, so 0.5 splits the regimes with margin.
  // CORPUS-CALIBRATED (2026-07-11, 138 real slot PNGs): fringeFrac p50 = 0.16 (straight-shaped art), but a
  // 0.5 floor flagged 11% of sprites across a 0.5–0.7 continuum with NO clean trough — real ornate frames/
  // splashes hover there. 0.75 keeps every synthetic bug (≈1.0) flagged while dropping the ambiguous band;
  // on the corpus only the near-certain members remain (logo 0.94, splash 0.79).
  // `minSprites` (2): ≥ 2 flagged LOOSE images before the ONE folder disclosure fires (a single odd sprite
  // is often deliberate art; a pipeline-wide export setting marks many). CONDITIONAL DISCLOSURE (invariant
  // 3): always `info`, NO estimate — we measure the pixel shape, never the loader's blend mode. Browser-only
  // — NOT in resolveThresholds (needs the full-res decode the CLI never performs; mirrors wastedAlpha).
  interiorTransparency: { minBboxPx: 16384, minRatio: 0.6 }, // CALIBRATE — interior-transparency (fill-rate)
  // disclosure gate. `minBboxPx` (16384 = a 128×128-equivalent opaque bbox): below this the sprite is too
  // small for fill-rate/overdraw to matter regardless of shape. `minRatio` (0.6): CORPUS-CALIBRATED
  // (2026-07-11, 134 real slot sprites): the MEDIAN sprite measures 0.42 interior transparency and p90 =
  // 0.58 — real slot art is naturally irregular, so the synthetic 0.35 floor sat BELOW the median and would
  // have flagged 71% of the folder (noise). 0.6 flags the top decile — genuinely ring-like art only. MARGINS outside the bbox never count (trim-margin territory). Always `info`, NO estimate
  // (fill-rate is not byte-measurable — the win lives in the shipped polygon packer). Loose-only.
  // Browser-only — NOT in resolveThresholds (needs the full-res alphaShape scan the CLI never performs).
  binaryAlpha: { minEdgePx: 128 }, // CALIBRATE — binary-alpha (1-bit alpha in an 8-bit channel) disclosure
  // CORPUS-VERIFIED (2026-07-11): 6/138 flagged — all *_background exports across tiers, a coherent
  // pipeline signal, zero noise ⇒ default confirmed.
  // gate: tiny icons' alpha depth is irrelevant, so the longest edge must reach ≥ 128 before the disclosure
  // fires. The FACT itself is exact (every alpha byte is 0 or 255, host-proven); the gate only suppresses
  // trivially-small images. Fully-opaque is wasted-alpha's case (de-overlapped in the rule); fully-transparent
  // yields no alphaShape at all. Always `info`, NO estimate (a 1-bit re-encode is not measurable in-browser —
  // canvas emits 8-bit only). Loose-only. Browser-only — NOT in resolveThresholds (mirrors interiorTransparency).
  gpuCompression: { minTextures: 2 }, // CALIBRATE — GPU block-compression alignment disclosure gate: ONE
  // odd-sized texture is usually deliberate; ≥ 2 suggests the pipeline never considered 4×4-block alignment
  // (the KTX2 → BC/ASTC transcode path). The FACT is exact and header-only (width % 4 / height % 4 — zero
  // decode); the gate only decides whether it is worth a folder line. Always `info`, NO estimate (transcode
  // targets vary per device; the on-device KTX2 probe measures real footprints, we never predict them).
  // Loose AND atlas pages both count. CLI note: the budget path drops this key (resolveThresholds
  // partial-merge), but plain audit/init run FULL defaults ⇒ the finding CAN fire in CLI audit JSON too.
  gutter: { minGaps: 4, minMedianPx: 8 }, // CALIBRATE — excessive-gutter (over-padded packing) disclosure
  // CORPUS-VERIFIED (2026-07-11): 153 real TP atlases + 369 Spine pages — ZERO flagged (tight real exports
  // never trip it); the sparse-bmfont fixtures remain the true-positive proof ⇒ default confirmed.
  // CLI note: the budget path drops this key (resolveThresholds partial-merge), but plain audit/init run
  // FULL defaults ⇒ the finding CAN fire in CLI audit JSON (additive, like bleeding/wasted-regions).
  // gate. `minGaps` (4): at least this many nearest-neighbour gaps must be measurable before a median means
  // anything (a 2-frame strip is not a packing pattern). `minMedianPx` (8): ~2px padding + edge-extrude is
  // the accepted bleed-safe gutter; a MEDIAN of ≥ 8px means HALF the frames sit that far apart — systematic
  // over-padding, not a single decorative margin. Touching frames contribute 0 and pull the median DOWN, so
  // tight sheets never fire. Always `info`, NO estimate (reclaim depends on the repacked layout — the Pro
  // repack receipt measures it). Browser-only — NOT in resolveThresholds (CLI stays byte-identical).
};
