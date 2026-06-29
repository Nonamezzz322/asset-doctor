# R25 #1 — BMFont XML + Binary (.fnt) Parsers — TEXT-Format Parity Completion

## 1. Problem and Goal
packages/ingest/src/index.ts:124-153 detects XML (less-than-led) and binary (BMF + 0x03) .fnt by magic and routes BOTH to unparsed[] with the reason "BMFont .fnt not in TEXT format (XML/binary unsupported in v1)". These carry the SAME font + glyph data as the supported TEXT format. Binary is the DEFAULT BMFont.exe/libGDX output, so the common case currently shows unsupported.

Goal: add parseFntXml(text) + parseFntBinary(bytes) to packages/parsers/src/fnt.ts, both producing BYTE-IDENTICAL FntPage[] to parseFntText, dispatched from ingest by magic. Entire downstream (parseFntPage, worker analyze.worker.ts:56-102, font-glyph-page readout, per-glyph malformedGlyphs recovery) reused VERBATIM.

## 2. v1 Scope
- parseFntXml(text): FntPage[] — dep-free attribute scan of info/common/page/char/kerning -> same NaN-preserving reads, same recovery rules.
- parseFntBinary(bytes): FntPage[] — bounds-checked walk of documented BMF v3 blocks; NEVER throws.
- Ingest: replace the XML/binary unparsed early-return with dispatch; fall to unparsed[] only on empty result (pages.length===0) or thrown error (try/catch backstop, mirroring .atlas/TEXT branches).
- Refactor the shared core of parseFntText (page-assembly + glyph-routing + recovery, lines ~96-211) into buildFntPages(raw: RawFnt) so all three front-ends share ONE recovery implementation — byte-identity by construction.
- Fixtures + tests (see section 11), emitted from the EXISTING generator.

## 3. Out of Scope
BMFont binary v1/v2 (only v3 magic dispatched; v1/v2 stay unparsed). Rotation/mesh/kerning-geometry (BMFont has none). Multi-channel/chnl/x-y-offset/xadvance semantics (ignored in TEXT too — layout metrics, not in-page geometry). XML namespaces/DTD/full entity expansion (BMFont emits none; scan is attribute-string-level, same spirit as tokenize). No core / worker / readout / UI change.

## 4. Contract / Type Changes
Additive, parsers-package-only, NO core change (internal to parsers; ingest already imports from it).
- fnt.ts: two new exports parseFntXml(text: string): FntPage[] and parseFntBinary(bytes: Uint8Array): FntPage[]
- index.ts: extend the existing export line to include parseFntXml, parseFntBinary
FntPage, parseFntPage, ParseResult: UNCHANGED.

## 5. Pure Modules + Signatures (fnt.ts internals)

### 5a. Extract buildFntPages (behavior-preserving refactor)
RawFnt interface:
- face?: string
- lineHeight?: number (finite only)
- commonSize?: Size (both finite and > 0)
- pages: { id: number; image: string }[] (id may be NaN, skipped by builder, mirrors current :117)
- chars: { idStr: string; id: number; pageId: number; x: number; y: number; w: number; h: number }[] (numeric fields NaN-preserving)
- kerningCount: number

buildFntPages(raw: RawFnt): FntPage[] = the current parseFntText body (lines ~96-211), verbatim, reading from RawFnt instead of re-tokenizing. Single source of truth for the recovery contract. Pure; never throws.

parseFntText, parseFntXml, parseFntBinary each become a thin front-end building a RawFnt. num/fin (lines ~84-85) stay in the string front-ends (TEXT/XML); the binary front-end emits already-numeric values, substituting NaN for out-of-bounds reads so the same recovery fires.

Determinism: RawFnt.chars preserves source order, RawFnt.pages preserves declaration order -> identical malformedGlyphs push order to today for TEXT -> all 8 TEXT unit tests + the bmfont-sparse fixture stay green unchanged. id-min first-page fallback (line ~135) and id-sorted emit (line ~210) preserved.

### 5b. parseFntXml
Dep-free attribute scanner (no DOM, worker-safe):
1. Regex-iterate info, common, page, char, kerning tags (self-closing or not — attributes only).
2. attrs(tagBody): scan key="value" / key='value' (quote-aware, like tokenize quoted branch); values NOT comma-split. Minimal entity decode on string-valued attrs used downstream (face, file): amp lt gt quot apos.
3. Map with the SAME num/fin discipline: info.face->face; common.lineHeight(fin)+scaleW/scaleH(fin and >0)->commonSize; page.id(num)+page.file(empty fallback)->pages; char.id/page/x/y/width/height(num, NaN-preserving)->chars; each kerning -> kerningCount++.
4. return buildFntPages(raw).
Char attr names are IDENTICAL to TEXT (id, x, y, width, height, page) — only the key="v" vs key=v wrapper differs.

### 5c. parseFntBinary (offsets confirmed vs AngelCode spec via WebFetch)
- Require >=4 bytes; bytes 0..2 = BMF (66,77,70); byte 3 === 3. Else return [].
- Walk from offset 4: block = 1B type + 4B LE uint size (size excludes type+size). Bounds-check type byte present, size field present, off+5+size <= length. Any violation -> STOP, buildFntPages on what is collected. NEVER throw / read OOB.
- Block 1 (info): fontName = null-terminated string at body offset 14 -> face (NUL scan bounded to block; TextDecoder utf-8).
- Block 2 (common): lineHeight u16@0, scaleW u16@4, scaleH u16@6 (require blockSize >= 8 to read through @7). lineHeight->raw.lineHeight; (scaleW,scaleH)->commonSize when both >0 (always finite from u16).
- Block 3 (pages): uniform-stride null-terminated names. n = (first NUL index)+1; count = blockSize / n. raw.pages = [{ id: i, image: name_i }] (ids are IMPLICIT indices 0..p-1 — matches TEXT, which writes page id=N in index order). Guard: n===0 -> 0 pages -> []; non-dividing -> floor, stop at body end.
- Block 4 (chars): 20B records, count floor(blockSize/20). id u32@0, x u16@4, y u16@6, width u16@8, height u16@10, page u8@18. Push { idStr:String(id), id, pageId:page, x, y, w:width, h:height }. Whitespace (w===0 and h===0) preserved as a record — buildFntPages owns the skip (no special-casing here).
- Block 5 (kerning): 10B records -> kerningCount += floor(blockSize/10).
- Unknown type: skip body via blockSize, continue (forward-compat, mirrors TEXT unknown-tag ignore).
All multi-byte via getUint16(off,true)/getUint32(off,true) (LE), bounds-checked before each read.

## 6. Worker / UI / Backend
NONE. Worker (analyze.worker.ts:56-102) consumes a.manifest as FntPage, malformedGlyphs, fontPages readout, kerningCount — XML/binary FntPages are indistinguishable from TEXT. UI keys off FntPage/bmfont kind — format-agnostic. Backend untouched (pure in-browser; invariants 1-2 intact).

## 7. Ingest Dispatch Change (index.ts:124-153)
Replace the XML/binary unparsed early-return with dispatch (structure mirrors the TEXT/.atlas branch):
- if .fnt: u8 = new Uint8Array(f.bytes); isBinaryBmf = u8.length >= 4 && u8[0]===0x42 && u8[1]===0x4d && u8[2]===0x46 && u8[3]===3.
- try: if isBinaryBmf pages = parseFntBinary(u8); else { text = new TextDecoder().decode(f.bytes); pages = text.trimStart().startsWith(less-than) ? parseFntXml(text) : parseFntText(text); }
- catch e: unparsed.push({ ref: baseName(f.name), reason: BMFont .fnt parse failed: msg(e) }); continue;
- if pages.length === 0: unparsed.push({ ref: baseName(f.name), reason: "BMFont .fnt has no page/char lines" }); continue;
- for page of pages { resolve/missing/atlases — UNCHANGED from current :144-152 }; continue;
Add parseFntXml, parseFntBinary to the import at :7. Update doc comments at :5-6 (fnt.ts header), :34-35 and :121-123 (ingest) — unparsed reason now means parsed empty / unrecognized, not XML/binary unsupported. Magic check made bounds-safe (u8.length >= 4) vs todays charCodeAt(3).

Honesty preserved: XML/binary that genuinely yield no pages (empty/thrown) still surface in unparsed[] — never silent-dropped. The two ingest tests at group-fnt.test.ts:63-83 currently assert XML/binary->unparsed with the unsupported reason; they MUST be rewritten to assert XML/binary->bmfont atlas (section 11b).

## 8. Honesty and Invariant Compliance
- Inv 1/2: binary/XML parse is pure in-browser TS, zero network/backend.
- Inv 3: only extract identical glyph rects; no generation.
- Inv 5: XML/binary page -> identical Atlas; existing occupancy + readout own VRAM exactly as TEXT; readout estimate carries ONLY occupancyPct (analysis.test.ts:1378-1381 confirms vramBytesSaved/diskBytesSaved undefined) — no double-count.
- Never-throw: every binary read bounds-checked; walk stops on short read; ingest try/catch is the backstop. Corrupt binary -> [] -> honest unparsed.
- Per-glyph recovery: SHARED buildFntPages -> a malformed XML/binary glyph surfaces identically (same page#id ref, same reason strings).

## 9. Determinism
buildFntPages deterministic (id-sorted emit, source-order glyphs, id-min fallback). Binary reader offset-driven, order-preserving; page stride n derived deterministically (first NUL+1). XML reader iterates tags in document order. No Date.now/Math.random/Map-iteration-order in output (Map re-sorted before emit, as today line ~210).

## 10. Edge Cases
- Binary <4B / wrong magic / version!=3 -> return [] -> ingest "no page/char lines" (v1/v2 honestly unsupported)
- Truncated block (size/body past EOF) -> stop walking; buildFntPages on collected; nothing -> []
- Mis-dividing block size (chars %20, kerning %10, pages stride) -> floor count; stop at body end; never OOB
- Pages stride n===0 -> guard -> 0 pages -> [] -> honest unparsed
- Binary char page id beyond declared pages -> TEXT recovery: references missing page N via builder
- Binary whitespace glyph (id=32, 0x0) -> preserved as record; builder skips (not an error)
- Binary OOB glyph (x+w > scaleW) -> builder drops + surfaces extends past page WxH
- XML single-quoted attrs / amp in face / self-closing vs open-close char -> quote-aware scan + minimal entity decode; attributes only
- .fnt neither less-than-led nor BMF-magic -> parseFntText (todays behavior) -> [] if junk -> honest unparsed
- UTF-8 face in binary info -> TextDecoder utf-8 on the null-terminated bytes

## 11. Test Plan (real harness)

Confirmed real: AngelCode v3 binary layout verified via WebFetch (header BMF+v3; block 1B type+4B LE size; common lineHeight@0/scaleW@4/scaleH@6/pages@8; char 20B id u32@0, x/y/w/h u16@4-10, page u8@18; kerning 10B; pages uniform-stride; fontName@14). Downstream consumes FntPage[] verbatim (analyze.worker.ts:56-102, parseFntPage). The op that fires is the same font-glyph-page + occupancy/wasted-regions the TEXT fixture asserts.

### 11a. Parser unit tests (packages/parsers/test/parsers.test.ts)
New describe parseFntXml / parseFntBinary — parity. BYTE-IDENTITY is asserted HERE (cheap, exact) — toEqual on the full FntPage[]:
1. XML parity — XML form of the existing FNT const -> expect(parseFntXml(xml)).toEqual(parseFntText(FNT)).
2. Binary parity — encodeBmfBinary(...) helper builds the same font blocks -> expect(parseFntBinary(bin)).toEqual(parseFntText(FNT)). Confirms whitespace skip (id=32 0x0), the real glyphs, kerningCount.
3. Binary recovery fires — encode an OOB glyph (x+w > scaleW) -> asserts it lands in malformedGlyphs with the identical reason TEXT produces (glyph id=N extends past page WxH).
4. XML quote/entity — face='My amp Co' (single-quoted, amp entity) -> face === My & Co.
5. Binary defensive — chars block size not /20 + body cut short -> returns glyphs read so far, never throws; BMF\x02 -> [].
6. XML defensive — font with no page/char tags -> [].

### 11b. Ingest tests (packages/ingest/test/group-fnt.test.ts)
Rewrite the two tests at :63-83:
1. XML .fnt -> bmfont atlas — groupFiles([xml.fnt, font.png]) -> atlases[0].kind===bmfont, images empty, unparsed empty.
2. Binary .fnt -> bmfont atlas — minimal binary font (via the shared encodeBmfBinary helper, exported from the parser test util OR duplicated minimal inline) referencing font.png -> bmfont atlas, PNG referenced.
3. Binary, no resolvable page image -> missing (symmetric with .atlas/TEXT).
4. Keep the empty/junk-.fnt -> unparsed "no page/char lines" — now also assert a junk binary (BMF\x03 + nothing) hits it.
5. Keep the "no .fnt => byte-identical grouping" regression.

### 11c. Fixtures — emitted from the EXISTING generator (fixtures/_generator/generate.mjs Case 12)
Do NOT add an ad-hoc bmfont-sparse-bin/build.mjs. Extend Case 12 (lines ~2009-2108): it already computes glyphs/size/occupancy/fontPng/expected.json. Add two sibling writeCase calls reusing the SAME data:
- bmfont-sparse-xml/ — font.fnt = XML serialization of the identical glyphs + whitespace + OOB + kerning (built from the same glyphs array + charLine-equivalent XML emitter); reuse the same fontPng + the same expected.json.
- bmfont-sparse-bin/ — font.fnt = v3 binary bytes via an encodeBmfBinary(glyphs, size, face, kerningCount) helper in the generator; same fontPng + same expected.json.
The binary blob is thus committed AND reproducibly regenerable by node fixtures/_generator/generate.mjs (the established convention), ground-truth authored independently of @asset-doctor/analysis.

### 11d. Analysis fixture test (analysis.test.ts:1328-1402)
The existing bmfont test is a hand-written single-fixture block reading bmfont-sparse/font.fnt (NOT currently parameterized). Lift its body (the first it, :1345-1386) into a small loop over [bmfont-sparse, bmfont-sparse-xml, bmfont-sparse-bin], each asserting the IDENTICAL expected.json verdicts through the REAL groupFiles -> parseFntPage -> analyze path. This reproduces the original defect (XML/binary->unsupported) through the real pipeline and proves font-glyph-page fires for all three serializations. The second it (gate-OFF proof, :1388-1402) stays single-fixture (TEXT).

## 12. Ordered Task Breakdown (small commits — but final delivery is ONE commit by the orchestrator)
1. refactor(parsers): extract buildFntPages(RawFnt) from parseFntText — behavior-preserving; parseFntText becomes a thin tokenize->RawFnt->build front-end. All 8 TEXT unit tests + the bmfont-sparse fixture green unchanged.
2. feat(parsers): add parseFntXml — attribute scanner -> RawFnt -> buildFntPages; export from index.ts. Unit tests 11a.1, 11a.4, 11a.6.
3. feat(parsers): add parseFntBinary — bounds-checked v3 walker -> RawFnt -> buildFntPages; export; add the encodeBmfBinary test helper. Unit tests 11a.2, 11a.3, 11a.5.
4. feat(ingest): dispatch XML/binary .fnt — replace index.ts:124-153; update imports :7 + doc comments :5-6 (fnt.ts), :34-35/:121-123 (ingest). Rewrite group-fnt.test.ts XML/binary tests (11b).
5. test(fixtures): emit bmfont-sparse-xml + bmfont-sparse-bin from generator Case 12 (11c) + parameterize the analysis fixture test over the three dirs (11d). Regenerate via node fixtures/_generator/generate.mjs.
6. docs: CHANGELOG.md + FEATURES.md.

Key files (all verified present):
- packages/parsers/src/fnt.ts (new parsers + buildFntPages refactor, current body lines ~93-211)
- packages/parsers/src/index.ts (exports)
- packages/ingest/src/index.ts:124-153 (dispatch)
- packages/parsers/test/parsers.test.ts:176-293 + packages/ingest/test/group-fnt.test.ts:63-83 (tests to add/rewrite)
- fixtures/_generator/generate.mjs:2009-2108 (Case 12 — the canonical fixture generator to extend)
- packages/analysis/test/analysis.test.ts:1328-1402 (single-fixture bmfont test to parameterize)

NOTE: line numbers are from the design snapshot and may have drifted slightly; locate code by surrounding text/context, not by absolute line number.
