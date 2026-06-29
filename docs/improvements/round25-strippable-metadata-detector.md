# R25 #0 — Strippable-metadata detector (ICC / EXIF / XMP / ancillary chunks)

Adversarial review verdict: PREMISE TRUE, DESIGN SOUND. Ship with 3 corrections (folded in below).

## Confirmed against code (no rebuttal needed)
- readImageInfo returns {mime, size} only — image-size.ts:122. No ancillary measurement exists.
- Format finding gates at frac < cfg.formatSaving.warn (0.25) and only targets AVIF/WebP — rules.ts:490,516. A sub-25% metadata-bloated PNG gets no verdict.
- The Pro fix genuinely strips metadata — transcode() (fix.worker.ts:4343) and recompressPng() (:4326) BOTH route through createImageBitmap/getImageData->canvas->encode. There is NO raw-byte passthrough anywhere — even the prebuilt-atlas PASSTHROUGH transcode (:2403) calls transcode(bytes, ...) (:2453), i.e. it re-decodes. So canvas discards all ancillary chunks. The honesty gap (free diagnosis doesnt measure/credit it) is real.
- De-overlap discipline at analyze.ts:243-249 is MAX-not-SUM via formatSavedByRef, and the existing wasted-alpha branch contributes alphaSaved minus fmtSaved.
- resolveThresholds (budget/src/config.ts:99-111) returns a HARDCODED 7-key subset — wastedAlpha/frameRedundancy/etc. are NOT passed through. A new strippableMetadata gate is auto-dropped from CLI => byte-identical CLI for free.
- render.test.ts:103 is an exact toEqual over the messageKey set, and catalogs.test.ts:20,27 enforce key-set + placeholder-token parity across all 9 locales. New keys MUST be added to both, in all 9 files.
- spine-atlas.ts:184 / fnt.ts:231 build ImageAsset literals via readImageInfo — the parity plumb is trivial.
- {x:bytes} formatter exists (i18n/src/index.ts:98); catalog key shape is find.KEY.{title,detail,fix}.
- UI surfaces findings generically — no rule=== switch in the ledger.

## Corrections folded in
- CORRECTION 1 (MAJOR): make-fixture skill CANNOT produce a metadata-bearing PNG (the defect is not an atlas defect). Task 7 must HAND-AUTHOR the PNG bytes (append a known-length tEXt/iCCP chunk to a minimal valid PNG, exactly as parsers.test.ts:88-119 builds inline headers) and write expected.json + README by hand. NOT a make-fixture invocation. The inline-byte-array technique (Test A) is the load-bearing proof; the on-disk golden fixture is corroborating.
- CORRECTION 2 (MAJOR): the allow-set is a runtime claim. Test D is BLOCKING (not optional): before finalizing the counted chunk set, encode one metadata-bearing PNG through the worker transcode/recompressPng path and diff input vs output chunks; pin the validated drop-set in the fixture README. Any chunk the fix PRESERVES must be removed from the count (no over-claim). Keep the conservative allow-set as a true lower bound.
- CORRECTION 3 (MINOR): plumb strippableBytes through Spine/bmfont ImageAsset literals too (parity), not only parseImage/parseAtlas — otherwise Spine pages silently report undefined while loose PNGs report it.

## 1. Problem (verified)
- readImageInfo (image-size.ts:122) measures only mime+dims. No ancillary byte measurement exists.
- formatFinding (rules.ts:498) targets only AVIF/WebP and gates at frac >= 0.25, so metadata-only bloat on an otherwise-efficient file earns no verdict.
- The Pro fix (transcode/recompressPng) already strips all ancillary chunks via canvas decode — uncredited in the free diagnosis. Real honesty hole.

## 2. V1 scope
- A pure, header-only byte-walk (packages/parsers) returning EXACT strippable ancillary bytes for PNG / JPEG / WebP. No decode (invariant 1).
- A per-asset strippable-metadata rule (loose + atlas page), config-gated (default >=4 KB), info/warn by magnitude, estimate.diskBytesSaved = EXACT only, never VRAM (invariant 5).
- Names the EXISTING oxipng/canvas-re-encode fix (invariant 3 — generate nothing).
- MAX-not-SUM de-overlap vs format and wasted-alpha, via a single bestSavedByRef running max.
- Folder rollup mirroring formatAggregateFinding.

## Out of scope
- AVIF/ISOBMFF ancillary measurement -> return 0 (box-tree walk too risky header-only; AVIF is already the format target).
- Emitting stripped files (Pro fix job).
- Any FixOp/worker change.
- New overlay (metadata has no spatial extent).

## 3. Additive contract (packages/core/src/index.ts) — absent => byte-identical
1. Rule union: add | strippable-metadata after wasted-alpha (end of per-asset block).
2. ImageAsset: add strippableBytes?: number with the disk-only/invariant-5 doc-comment (PNG: sum allow-set chunk len+12; JPEG: sum APP1..APP15+COM 2+len; WebP: sum EXIF/XMP/ICCP size+8; 0/absent => none; AVIF/headless => 0).
3. ThresholdConfig: add strippableMetadata?: { minBytes: number; warnBytes: number } — disk-only, optional/additive, browser-only (NOT in resolveThresholds).
4. FindingEstimate unchanged. No new overlay kind.

## 4. Pure modules

### 4a. image-size.ts — export function strippableMetadataBytes(bytes: Uint8Array): number
Three private helpers, reusing existing startsWith/u32be/u16be/u16le/u24le and PNG_SIG. Never throws; defensive bounds on every read; bail to accumulated partial on any OOB length.
- PNG (pngStrippable): verify sig, walk [len:u32be][type:4][data][crc:4] from offset 8. Count ONLY the conservative allow-set {iCCP, eXIf, tEXt, iTXt, zTXt, tIME} -> len + 12. Do NOT count tRNS (functional transparency), pHYs/gAMA/cHRM/sRGB/bKGD/sBIT (may alter rendering). Stop at IEND. The allow-set is provisional until Test D (BLOCKING) validates it against recompressPng output.
- JPEG (jpegStrippable): walk markers exactly like readJpeg loop (:60-88). For 0xE1..0xEF (APP1..APP15) and 0xFE (COM): add 2 + len. EXCLUDE APP0 (0xE0, JFIF — encoder-kept). Stop at SOS (0xDA) / EOI (0xD9).
- WebP (webpStrippable): verify RIFF/WEBP; only VP8X carries ancillary chunks. Walk [fourcc:4][size:u32le][payload(+even-pad)] from offset 12; add size + 8 for EXIF/XMP(trailing space)/ICCP. Skip VP8 /VP8L/VP8X/ALPH/ANIM/ANMF.
- AVIF / unrecognized -> 0.
Re-export from parsers/src/index.ts.

### 4b. atlas.ts / spine-atlas.ts / fnt.ts — plumb like byteSize
In each ImageAsset literal (atlas.ts:238,256; spine-atlas.ts:184; fnt.ts:231), spread ...(s > 0 ? { strippableBytes: s } : {}) where s = strippableMetadataBytes(the page/image bytes) (omit-when-zero convention). Import the helper.

### 4c. rules.ts — strippableMetadataFinding(ref, image, cfg): Finding | null
Guard: if (!cfg.strippableMetadata) return null; const s = image.strippableBytes ?? 0; if (s < cfg.strippableMetadata.minBytes) return null; severity = s >= cfg.strippableMetadata.warnBytes ? warn : info. estimate: { diskBytesSaved: s } ONLY. messageKey strippable-metadata, rule strippable-metadata, id = ref:strippable-metadata, params { label: FORMAT_LABEL[image.mime], bytes: s }. Baked strings mirror the en catalog byte-for-byte. Export from analysis/src/index.ts.

### 4d. folder.ts — strippableMetadataAggregateFinding(metaFindings): Finding | null
Pattern-identical to formatAggregateFinding (:200): < 2 => null; sum diskBytesSaved; <=0 => null; sorted relatedRefs; rule strippable-metadata, scope folder, messageKey strippable-metadata-aggregate. Display-only (not folded into totals).

## 5. analyze.ts wiring + de-overlap refactor (the one contained refactor)
Replace the two ad-hoc if (x > fmtSaved) potentialDiskSaved += x minus fmtSaved sites with a single per-ref bestSavedByRef running max:
- addFormat seeds bestSavedByRef.set(ref, saved) and potentialDiskSaved += saved (unchanged net for format-only).
- A helper bumpBest(ref, candidate): const prev = bestSavedByRef.get(ref) ?? 0; if (candidate > prev) { potentialDiskSaved += candidate minus prev; bestSavedByRef.set(ref, candidate); }.
- wasted-alpha branch calls bumpBest(image.name, alphaSaved) (replaces :247-249).
- NEW: in BOTH branches, after the format call, compute meta = strippableMetadataFinding(ref, image, cfg); if present, findings.push(meta); metaFindings.push(meta); bumpBest(ref, metaSaved).
- Folder: const sma = strippableMetadataAggregateFinding(metaFindings); if (sma) folder.push(sma);
- Must keep analysis.test.ts:400,415,427 green (format-only and format+alpha cases; the running-max generalization preserves all three: format-only path is addFormat seed; format+alpha is max(fmt,alpha)).
- AnalyzeDeps unchanged (rides on Asset.image). CLI byte-identical (gate auto-dropped by resolveThresholds).

THREE-WAY MAX worked example (must hold): a ref with fmt=4000, alpha=6000, strip=5000 yields potentialDiskSaved contribution === 6000 (the honest MAX), NOT 4000 + (6000-4000) + (5000-4000) = 7000.

## 6. Worker / UI / backend — NO CHANGE
Pure parser plumbs strippableBytes inside parseImage/parseAtlas/parseSpinePage/parseFntPage (all worker-called). UI surfaces via renderFinding. No FixOp, no backend.

## 7. Honesty + invariants
Inv 1 (no decode/network), Inv 3 (measure only — fix already strips), Inv 5 (diskBytesSaved only; copy says DOWNLOAD only — VRAM unchanged), conservative allow-set = true lower bound, MAX de-overlap (now three-way correct).

## 8. Determinism
Pure integer arithmetic, bounded loops, no Date/random. Drift guard pins baked === catalog.

## 9. Edge cases
Truncated header -> bail to partial. No ancillary chunks -> 0 -> no finding. JPEG stops at SOS; APP0 excluded. WebP simple -> 0. AVIF/unknown -> 0. < minBytes or absent -> null. Atlas: page image only (manifest JSON not scanned). Zero-byte -> 0 -> null.

## 10. Test plan
- A (parsers.test.ts): inline byte arrays (style of :88-119) — PNG with tEXt/iCCP (assert len+12), tRNS (assert NOT counted), truncated-length (assert partial). JPEG APP1 counted + APP0 excluded + stop-at-SOS. WebP VP8X+EXIF (size+8); simple VP8 -> 0. AVIF -> 0. Plus parseImage(name, bytesWithMetadata).image.strippableBytes === expected (proves the plumb). Same commit as 4a.
- B (analysis.test.ts): rule fires warn/info, diskBytesSaved set, vramBytesSaved undefined (assert). Below minBytes/absent/no-config -> null. Fires through analyze and bumps potentialDiskSaved. Three-way MAX: format=4000 + alpha=6000 + strip=5000 => potentialDiskSaved === 6000 (guards the Task-5 refactor). Folder rollup >=2 => summed.
- C (i18n render.test.ts): add both keys to realFindings() and the :103 messageKey toEqual set; assert ru renders brace-free. catalogs.test.ts auto-checks parity.
- D — BLOCKING (was optional): before finalizing the allow-set, encode one metadata-bearing PNG through the worker transcode/recompressPng path and diff input vs output chunks; pin the validated drop-set in the fixture README. Any chunk the fix preserves MUST be removed from the count.

## 11. i18n (all 9 locales)
find.strippable-metadata.{title,detail,fix} + find.strippable-metadata-aggregate.{title,detail,fix} (added to en source + 8 locales with identical placeholders). en baked-mirrored:
- title: {label} carries {bytes:bytes} of strippable metadata
- detail: This {label} stores {bytes:bytes} of ancillary metadata (ICC/EXIF/XMP + non-essential chunks) the GPU never uses. Stripping it (re-encode / oxipng) cuts ~{bytes:bytes} of DOWNLOAD. DISK only — the GPU decodes to RGBA8888, so VRAM is unchanged.
- fix: Strip metadata on export (oxipng / re-encode) — the Pro fix already does this.
- aggregate title/detail mirror format-aggregate ({n}, {saved:bytes}, disk-only).

## 12. Ordered task breakdown (small commits — but final delivery is ONE commit by the orchestrator)
1. core: strippable-metadata -> Rule; strippableBytes? -> ImageAsset; strippableMetadata? -> ThresholdConfig.
2. parsers: strippableMetadataBytes + export; plumb into parseImage/parseAtlas/spine-atlas/fnt; ship with Test A (same commit).
3. Test D (blocking gate): validate the allow-set against recompressPng/transcode output; finalize the counted chunk set; record the result. (Do this before 4c bakes copy that names specific savings.)
4. config: strippableMetadata: { minBytes: 4096, warnBytes: 65536 } in DEFAULT_THRESHOLDS with the CALIBRATE/browser-only comment (confirm NOT in resolveThresholds).
5. analysis rule: strippableMetadataFinding + strippableMetadataAggregateFinding + index exports + Test B (pure-rule half).
6. analyze wiring + bestSavedByRef refactor: replace the two > fmtSaved sites with one running-max helper; add both-branch strippable calls + folder rollup; Test B (de-overlap + three-way MAX + report-level firing); assert analysis.test.ts:400/415/427 still green.
7. fixture: hand-author fixtures/sample-projects/strippable-metadata/ (real PNG + injected chunk + expected.json + README pinning the Test-D drop-set) — NOT via make-fixture; golden test through parse->analyze.
8. i18n: keys to en + 8 locales; extend render.test.ts realFindings() + the :103 set; run catalogs.test.ts.
9. verify: pnpm typecheck && pnpm test; check-invariants spot-check (no network, disk-only estimate, three-way MAX).

Files touched: packages/core/src/index.ts; packages/parsers/src/{image-size.ts,atlas.ts,spine-atlas.ts,fnt.ts,index.ts}; packages/parsers/test/parsers.test.ts; packages/analysis/src/{config.ts,rules.ts,folder.ts,analyze.ts,index.ts}; packages/analysis/test/analysis.test.ts; packages/i18n/src/catalogs/*.json (9); packages/i18n/test/render.test.ts; fixtures/sample-projects/strippable-metadata/*. No worker/UI/backend changes.

NOTE: line numbers are from the design snapshot and may have drifted slightly; locate code by surrounding text/context, not by absolute line number. IMPORTANT: this pick TOUCHES packages/parsers/src/{fnt.ts,index.ts} which R25 #1 (BMFont) also touches — if #1 already landed, integrate with the buildFntPages refactor and the new exports rather than reverting them.
