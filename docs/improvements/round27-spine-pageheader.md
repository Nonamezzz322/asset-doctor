# Spine multi-page .atlas: trim the page-boundary lookahead so an indented page `size:` header on page 2+ is not swallowed (silent page loss) (PROCEED)

VERDICT: PROCEED. Every load-bearing claim verified against the real code and reproduced live.

== PREMISE VERIFICATION (cited) ==
1. The bug exists exactly as described. packages/parsers/src/spine-atlas.ts:154 reads `const pageStart = !page || /^size\s*:/.test(j < lines.length ? lines[j]! : '');` — it tests the RAW un-trimmed `lines[j]`. Every other classification in the same loop uses the trimmed `t` (line 139: `const t = raw.trim();`, line 140 regex on `t`). The line-151 comment even says "the next non-empty line is a (non-indented) page `size:` header" — i.e. indentation is an unhandled gap, not a deliberate restriction.
2. First-page short-circuit masks it: at the very first bare line `!page` is true, so page 1 is always created regardless of header indentation. For page 2+, `page` is non-null, so detection falls to the regex — which fails on a leading-whitespace `  size:`/`\tsize:`.
3. Live repro (ran the actual parser via tsx on a modern indented multi-page atlas: page1.png/\tsize:64,64/regionA... / page2.png/\tsize:64,64/regionB...): CURRENT output = PAGES:1, page1.sprites=[regionA, page2.png(0,0,64,64), regionB]. The page-2 image line is misclassified as a degenerate full-page region named "page2.png" on page 1 (it survives the OOB check because 0+64 > 64 is false — exactly at the edge), and regionB is misattributed to page 1. The entire second texture page + its regions are silently lost. With the proposed fix applied in place: PAGES:2, page1.sprites=[regionA], page2.sprites=[regionB], correct sizes — verified live.
4. Honesty/objectivity break (invariant 3) confirmed downstream at packages/ingest/src/index.ts:116-123: pages drive `referenced.add(keyOf(image))` and `atlases.push(...)`. A lost page is never referenced, so (a) the real page-2 image file gets falsely flagged as an unreferenced/orphan asset even though it IS referenced, and (b) the phantom full-page "page2.png" sprite inflates page-1 occupancy and corrupts wasted-region analysis. Neither is surfaced in unparsed[]/missing[]/malformedRegions — a silent measurement lie.
5. Safety / no-op-on-goldens confirmed: scanned all 527 .atlas files in the repo — ZERO use indented page-size headers (all legacy column-0). The 4 spine fixtures (spine_multi.atlas headers at col-0 lines 2&14; spine_single, spine-basic/sheet, raw-multifolder-dupes/{a,b}/frame) have indented `size:` lines ONLY at region level (always after a name line, so the bare-line lookahead never even runs on them). Verified by running the FULL suites against an in-place patch: parsers 46/46, ingest+analysis 222/222, fix+cli+web-spine+tier 441/441 — all green, zero golden drift. Patch reverted; git status clean.

== PROBLEM (verified) ==
The Spine/libGDX .atlas page-boundary lookahead tests the un-trimmed line, so on page 2+ an indented page `size:` header (emitted by the modern Spine 4.x runtime, which the parser's own header comment at spine-atlas.ts:4 claims to support — "the modern one (bounds/offsets)") is not recognized. The second (and later) texture page is silently dropped, a phantom full-page sprite poisons the first page's analysis, and the real page image is mis-flagged as orphaned. This breaks invariant 3 (objective measurement, no fabrication) and the global honesty contract that nothing is silently dropped.

== V1 SCOPE ==
One-character-class fix at spine-atlas.ts:154 — trim the looked-ahead line before the regex:
`const pageStart = !page || /^size\s*:/.test((lines[j] ?? '').trim());`
This mirrors the existing trim-then-classify discipline used everywhere else in the loop, and is bounds-safe via `?? ''` (replacing the existing `j < lines.length ? lines[j]! : ''` ternary, which the trim form subsumes). No type changes, no contract changes, no new exports.
Plus: one new self-contained inline-string parser test (modern indented multi-page) and ideally one ingest-level test asserting the page-2 image is referenced (not orphaned).

== OUT OF SCOPE ==
- No new SpinePage/Atlas fields; the existing malformedRegions/unparsed channels are untouched.
- No change to region-level `size:` handling (regions always follow a name line, so an indented region `size:` is never reachable by the bare-line lookahead — confirmed: the lookahead only runs inside `if (!m)`, and a region's size: produces a key-match `m`, so it goes through line 146, never line 150).
- No mixed-indentation / tabs-vs-spaces normalization beyond `.trim()` (trim already covers leading tabs AND spaces — confirmed in repro with tab-indented input).
- No fix-engine / emitter changes: packages/fix/src/manifest.ts emitSpineAtlasText already writes column-0 page headers (round-trip stays lossless because parse now yields the correct page set on input; re-emit format is unchanged).
- No i18n work (see below).

== ADDITIVE CONTRACT / TYPE CHANGES ==
None. parseSpineAtlasText's signature and SpinePage shape are unchanged. Pure behavioral correction.

== PURE MODULES + SIGNATURES ==
packages/parsers/src/spine-atlas.ts — `export function parseSpineAtlasText(text: string): SpinePage[]` (unchanged signature). Only the body line 154 changes. Pure, worker-safe, never-throws contract preserved (the trim cannot throw; `?? ''` guards the out-of-range index).

== WORKER / UI / BACKEND CHANGES ==
None. All consumers (apps/web/src/worker/analyze.worker.ts:66-88, fix.worker.ts:331/370, apps/cli/src/pipeline.ts:53, apps/extension/src/inject.ts:144) call the same function and iterate the returned pages; they automatically get the now-correct page count. No backend involvement (this is the diagnosis path, invariants 1-2 untouched). The UI simply now shows N pages instead of N-1, and the previously-phantom sprite and false-orphan disappear.

== HONESTY + INVARIANT COMPLIANCE ==
- Invariant 3 (objectivity): the fix REMOVES a fabrication (phantom full-page sprite) and a false negative (lost page) and a false positive (orphan image). Strictly more honest; generates nothing.
- Invariant 5 (disk != VRAM): the recovered page's VRAM/occupancy is now measured from its real size rather than being silently omitted or folded into page 1 — no conflation, no over-claim; we report exactly what the atlas declares.
- Invariants 1, 2, 4: untouched (pure client parser, no network, no perf change — same single O(n) pass).

== DETERMINISM ==
Fully deterministic and order-preserving. The lookahead is over the same already-split `lines` array; `.trim()` is pure. No Map/Set iteration, no Date/random. Output ordering of pages/sprites is unchanged for all legacy inputs and now correct for indented inputs.

== EDGE CASES (verified or reasoned) ==
- First page with indented header: still works (`!page` short-circuit) — unchanged.
- Legacy column-0 multi-page: still works — verified live (PAGES:2 on /tmp/legacy_multi.atlas).
- Trailing bare line at EOF (no following line): `lines[j] ?? ''` → `''.trim()` → regex false → treated as a region (matches today's behavior); if no region context exists it is flushed harmlessly.
- Indented region `size:` after a name line: NOT reachable by the lookahead (it is a key-match, handled at line 146) — so it can never be misread as a page boundary. Confirmed by code path.
- `size :` with space before colon, CRLF, blank lines between image and header: `.trim()` + the existing blank-skip `while` loop + `\s*:` in the regex all handle these.
- A bare line whose next non-empty line is a region key other than size (e.g. modern atlases that put `format:` before `size:` — rare but legal): unchanged behavior (still classified as region). Not a regression vs today; if a real modern variant orders non-size page keys first, that is a SEPARATE, currently-also-broken case and explicitly out of scope (do not over-reach). Note in the test comment.

== TEST PLAN (against the real harness) ==
Harness fact (verified): existing spine parser tests in packages/parsers/test/parsers.test.ts use INLINE atlas strings (lines 657-707), assert directly on SpinePage — NO external fixture files, NO make-fixture goldens, NO i18n catalogs touched. So:
1. New parser unit test in the existing `describe` block (near line 657): inline modern indented multi-page atlas (tab- and space-indented variant) → assert `pages.length === 2`, `pages.map(p=>p.image) === ['page1.png','page2.png']`, page1.sprites === ['regionA'], page2.sprites === ['regionB'], and `malformedRegions` undefined on both (proves no phantom sprite). Add a comment documenting the bug it locks.
2. Regression-guard test: the same content with COLUMN-0 headers → still 2 pages (proves legacy path unchanged).
3. Optional but recommended ingest-level test (packages/ingest/test): feed a modern indented 2-page .atlas + both page images → assert both images land in `referenced`/`atlases` and neither appears in the unreferenced/orphan output (locks the honesty fix at the integration boundary). Reuse the existing ingest test setup pattern.
4. Full-suite reconciliation (run, expect zero drift — already pre-verified): `npx vitest run packages/parsers packages/ingest packages/analysis packages/fix apps/cli apps/web` — pre-run on the in-place patch gave 46+222+441 green with no golden changes. Re-confirm after the real edit. No i18n drift test is implicated (findings/messageKeys unchanged).
5. typecheck + lint: `pnpm typecheck && pnpm lint` (no type/contract change, expected clean).

== ORDERED SMALL-COMMIT TASK BREAKDOWN ==
1. fix(parsers): trim spine page-boundary lookahead so indented page headers on page 2+ aren't swallowed — single edit at spine-atlas.ts:154 to `/^size\s*:/.test((lines[j] ?? '').trim())`; update the line-151 comment to drop "(non-indented)" since indentation is now tolerated.
2. test(parsers): add inline modern-indented multi-page test + a column-0 regression-guard test in parsers.test.ts (locks 2 pages, correct attribution, no phantom sprite).
3. test(ingest): add a 2-page modern-indented .atlas integration test asserting both page images are referenced and neither is mis-flagged as orphan (locks the invariant-3 honesty fix end-to-end). [Optional if time-boxed; commits 1-2 fully cover the parser-level guarantee.]
4. chore: run full vitest + typecheck + lint, confirm zero golden drift.

Relevant files (absolute):
- /home/nonamezzz/Рабочий стол/projects/packages/parsers/src/spine-atlas.ts (line 154 — the fix; line 151 — comment)
- /home/nonamezzz/Рабочий стол/projects/packages/ingest/src/index.ts (lines 116-123 — downstream honesty consumer; optional test target)
- /home/nonamezzz/Рабочий стол/projects/packages/parsers/test/parsers.test.ts (lines 657-707 — inline-string spine test block to extend)