# Texture-bleeding detector — light the dead teal overlay via pure integer frame-adjacency (PROCEED)

VERDICT: PROCEED. Every load-bearing premise verified against the real code.

== ADVERSARIAL VERIFICATION (all citations confirmed) ==
1. OverlayZone.kind includes 'bleeding' — packages/core/src/index.ts:322 (`kind: 'empty' | 'transparent' | 'bleeding' | 'duplicate-frame'`). CONFIRMED.
2. FilmViewer defines the teal bleeding style — apps/web/src/components/FilmViewer.tsx:10 (`bleeding: { stroke: '#0e8c8c', fill: 'rgba(14,140,140,0.14)' }`), keyed in ZONE_STYLE (line 7). CONFIRMED.
3. Dead path: grep `kind:'bleeding'` / `'bleeding'` across packages/ + apps/ returns ONLY core/index.ts:322 (the type) + FilmViewer.tsx:6,10 (the style/comment). NO emitter anywhere. The only other "bleed*" hits are the Pro edge-extrude FIX (packages/fix/src/pack.ts:30, mask.ts:37) and a probe/comment. So texture bleeding is NEVER diagnosed and the overlay kind is genuinely dead. CONFIRMED.
4. Detector→fix closure exists honestly: the edge-extrude FIX is real — packages/fix/src/extrude.ts exports effectiveExtrude/canExtrude/extrudePlan (index.ts:9), FixOp.repack.extrude + FixOp.pack.extrude (core/index.ts:681-727), PackOptions.gutter (pack.ts:32), docs/improvements/edge-extrude.md. So this detector points at an already-shipped remedy without itself generating anything (Inv3). CONFIRMED.
5. FilmViewer renders ANY zone kind generically: the overlay loop (FilmViewer.tsx:59-83) does `ZONE_STYLE[zone.kind]` then strokes/fills each rect. Emitting kind:'bleeding' lights the teal automatically — ZERO FilmViewer change needed. CONFIRMED (improves on the pick: no UI edit).
6. CLI byte-identical: resolveThresholds (packages/budget/src/config.ts:99-111) copies ONLY 7 keys (occupancy, oversizePx, formatSaving, npotPadding, duplicates, shouldAtlas, atlasMerge). It already drops frameRedundancy/trimMargin/solidFill/wastedAlpha/strippableMetadata. A new optional `bleeding?` is likewise never propagated ⇒ cfg.bleeding is undefined on the CLI ⇒ rule returns null ⇒ CLI byte-identical. CONFIRMED.
7. Atlas.sprites[].frame is Rect {x,y,w,h} integers as PLACED in the atlas (core/index.ts:51-65; comment line 25 "frame is the packed rect AS PLACED, w/h swapped when rotated"). Pure rect math, no decode. CONFIRMED.
8. i18n contract: catalogs are 9 JSON files (en/ru/de/es/pt/fr/it/zh/hi). Drift guard packages/i18n/test/render.test.ts:112 pins the EXACT SET of messageKeys exercised AND asserts renderFinding(f,'en') === baked title/detail/fix byte-for-byte (lines 116-118) + ru brace-free (121-123). catalogs.test.ts:18-29 asserts every locale has the SAME keys as en, plural objects keep `other`, and placeholder tokens match en exactly. ADDING a finding REQUIRES updating render.test.ts:112's set + adding 3 keys × 9 catalogs. CONFIRMED — this is the real, strict harness.

CORRECTION folded in: the pick says "not in DEFAULT_THRESHOLDS". That is WRONG for the browser. To fire in-browser by default (the desired behavior, matching frameRedundancy/trimMargin which ARE in DEFAULT_THRESHOLDS:28,33), I MUST add a `bleeding` default to config.ts. The "default-off-safe / byte-identical" guarantee is satisfied via resolveThresholds (CLI) + the `if (!cfg.bleeding) return null` guard (any hand-built/headless config without the key) — NOT via omitting it from DEFAULT_THRESHOLDS. Design reflects this.

== PROBLEM (verified) ==
Texture bleeding (1px color seams under bilinear filtering / mipmaps) happens when two atlas frames are packed with a 0px gutter on a shared edge: the GPU's linear sampler reaches across the frame boundary and pulls in the neighbor's outermost texels. AD already styled an overlay for this and already ships the FIX (edge-extrude), but never DIAGNOSES it. This is a pure geometry fact readable from frame rects with zero decode.

== HONEST FRAMING (the load-bearing constraint) ==
- Inv3 (objectivity): a MEASURED rect-adjacency fact (frames touch with 0 gap). We generate nothing; the edge-extrude fix is a separate, already-shipped piece.
- Inv5 (disk != VRAM): this is a CORRECTNESS finding, NOT a savings finding. It carries NO diskBytesSaved and NO vramBytesSaved — edge-extrude can GROW the sheet (it consumes gutter), so any saving claim would be a lie. estimate is omitted entirely (or {} ). Severity info/warn only, never crit.
- Conditional verdict (mirrors the NPOT 'IF your toolchain pads to POT' hedge at rules.ts:99-121): copy says "IF your sprites use linear/trilinear filtering or mipmaps, these touching frames can bleed 1px seams" — because nearest-neighbor pixel art is bleed-IMMUNE. We do not know the filter mode from static geometry, so we hedge honestly.
- Inv4: O(frames·k) bucketed integer math, zero decode, runs on the same per-atlas pass; off the 10s-critical path.
- Inv1/2: pure, worker-safe, no network, no backend.

== v1 SCOPE ==
A new pure rule `bleedingFinding(atlas, cfg): Finding | null` in packages/analysis/src/rules.ts. It scans Atlas.sprites[].frame for PAIRS that (a) share a vertical or horizontal edge with EXACTLY 0px gap AND (b) overlap on the perpendicular axis by >0px. Skips rotated and aliased frames. Gated by a meaningful adjacency count. Emits ONE Finding with severity info/warn, conditional copy, NO estimate, and ONE OverlayZone {kind:'bleeding', rects:[...]} highlighting the touching edges (thin 1px strips so the teal reads as a SEAM, not a fill). Wired into analyze.ts in the per-atlas block. Default added to DEFAULT_THRESHOLDS. 3 i18n keys × 9 catalogs + drift-guard set update. Tests in analysis.test.ts + render.test.ts.

== OUT OF SCOPE ==
- Rotated-frame adjacency (skipped — the placed rect is correct but the extrude fix is rectangle-only and the seam direction is ambiguous after rotation; surfaced as skip, not analyzed).
- Trimmed-frame transparent-margin nuance (a touching transparent edge does not bleed). v1 is conservative on the rect; refining to opaque-bbox adjacency would need the host trim bboxes (AtlasFrameTrims) — explicitly a future extension, NOT v1, to keep v1 zero-decode and pure.
- Any fix generation (edge-extrude already exists).
- Any disk/VRAM savings number.
- CLI opt-in (deliberately stays off via resolveThresholds).
- Probe/runtime correlation.

== ADDITIVE CONTRACT / TYPE CHANGES (packages/core/src/index.ts) ==
1. Rule union (line 259-285): add `| 'bleeding'` (place it near the per-atlas group rules, after 'trim-margin').
2. ThresholdConfig (line 542-631): add optional
   `bleeding?: { minPairs: number; warnPairs: number };`
   with a doc comment mirroring frameRedundancy/trimMargin: "Texture-bleeding gate (browser + headless). Atlas frame PAIRS sharing an edge with 0px gutter (host-free, pure rect math). `minPairs` — adjacent pairs before the info finding fires (a couple of touching frames is common and harmless under nearest-neighbor). `warnPairs` — at/above this the finding is `warn` (many zero-gutter edges = a sheet packed without bleed-safety). CORRECTNESS finding — carries NO diskBytesSaved/vramBytesSaved (edge-extrude can GROW the sheet; any saving claim would be a lie, invariant 5). Severity info/warn only. Optional/additive: absent ⇒ suppressed. Browser-only — NOT enumerated by resolveThresholds (CLI never opts in)."
   NO change to OverlayZone (kind 'bleeding' already exists), Finding, FindingEstimate, or FixOp.

== PURE MODULE + SIGNATURE (packages/analysis/src/rules.ts) ==
`export function bleedingFinding(atlas: Atlas, cfg: ThresholdConfig): Finding | null`

Algorithm (deterministic, integer-only, no decode):
- `if (!cfg.bleeding) return null;`
- Filter candidate sprites: skip `sp.rotated === true`. De-alias by distinct rectKey `${x},${y},${w},${h}` (two manifest names on the IDENTICAL packed rect are ONE region — they cannot bleed against each other and must not double-count; first/lowest-index wins, mirroring the frame-redundancy distinct-rect guard at rules.ts:182-211). Keep an ordered list of distinct rects (ascending by first sprite index for determinism).
- Build adjacency. To stay O(n·k) not O(n^2): bucket distinct rects by their RIGHT edge x (r.x+r.w) into a Map and by their BOTTOM edge y (r.y+r.h) into a Map. For each rect A, look up the bucket keyed by A's LEFT edge (A.x) among right-edges (a B whose right edge == A.x is horizontally touching on A's left), and require vertical overlap `max(A.y,B.y) < min(A.y+A.h, B.y+B.h)`. Symmetric for the vertical (top/bottom) axis using A.y vs bottom-edges. Each unordered touching pair counted ONCE (enforce B's first-index < A's, or use a Set of canonical pair keys `${min},${max}` over the distinct-rect indices).
- Collect, for each touching pair, the shared-edge strip rect in atlas px: vertical seam = `{ x: edgeX-? , ... }` — emit a 1px-wide strip along the shared edge spanning the overlap interval (`{x: A.x, y: overlapTop, w: 1, h: overlapH}` for a left-edge touch at x===A.x; analogous 1px-tall strip for horizontal touches). Strips are thin so the teal reads as a seam line, not a region fill. Deduplicate identical strip rects.
- Count = number of distinct touching pairs. `if (pairs < cfg.bleeding.minPairs) return null;`
- severity = `pairs >= cfg.bleeding.warnPairs ? 'warn' : 'info'`.
- Build relatedRefs = sorted unique sprite names participating in any touching pair (proof).
- Return Finding: id `${atlas.name}:bleeding`, rule 'bleeding', severity, assetRef atlas.name, relatedRefs, baked EN title/detail/fix (see copy below), overlay [{kind:'bleeding', rects: strips}], messageKey 'bleeding', params { pairs, frames: relatedRefs.length, refs: relatedRefs.join(', ') }. NO estimate field (omit entirely — Inv5).

Determinism: distinct-rect ordering by lowest sprite index; pair canonicalization by index; strip rects emitted in pair order then sorted by (y,x,h,w); integer arithmetic only; no Date.now/Math.random; commutative counts. Reproducible across runs and platforms.

BAKED EN COPY (must mirror catalog byte-for-byte — drift guard):
- title (plural on `pairs`): one → "1 zero-gutter frame pair — bleeding risk"; other → "{pairs} zero-gutter frame pairs — bleeding risk".
- detail (plural on `pairs`): "{pairs} frame pair(s) in this atlas touch with no gutter between them. IF your sprites use linear/trilinear filtering or mipmaps, the sampler can pull a neighbor's edge texels in and show 1px seams; nearest-neighbor pixel art is unaffected." (Use 'pair'/'pairs', 'touches'/'touch' agreement in the two plural forms — model exactly on trim-margin's two-form construction at en.json.)
- fix: "Repack with a 1–2px gutter and edge-extrude (bleed) so touching frames don't sample across the boundary — the Pro fix's extrude option does this."

== CONFIG (packages/analysis/src/config.ts) ==
Add to DEFAULT_THRESHOLDS:
`bleeding: { minPairs: 4, warnPairs: 16 },` with a CALIBRATE comment mirroring the surrounding entries: "CALIBRATE — texture-bleeding gate. Atlas frame PAIRS sharing an edge with 0px gutter (pure rect math, no decode). `minPairs` (4): adjacent pairs before the info finding fires (a few touching frames is common/harmless under nearest-neighbor). `warnPairs` (16): at/above ⇒ warn (a sheet broadly packed without gutters). CORRECTNESS finding — NO disk/VRAM saving (edge-extrude can GROW the sheet, invariant 5); info/warn only. Browser-only — NOT in resolveThresholds (the CLI never opts in)." Provisional defaults; calibrate against real exports (a TexturePacker sheet packed with padding>=1 produces ZERO pairs and must stay silent — this is the key calibration check).

== ANALYSIS INDEX (packages/analysis/src/index.ts) ==
Add `bleedingFinding` to the `export { ... } from './rules'` block (line 11-25 region).

== analyze.ts WIRING ==
In the per-atlas branch (analyze.ts:210-242), after dimensionFindings and alongside frameRedundancy/trimMargin (which need host data and are gated on fh/ft), add an UNCONDITIONAL call (no host dep — pure geometry):
`const bleed = bleedingFinding(atlas, cfg); if (bleed) findings.push(bleed);`
Place it right after `findings.push(...dimensionFindings(atlas.name, atlas.size, cfg));` (line 210). No estimate is emitted, so NOTHING flows into potentialDiskSaved/totals — zero risk of conflating disk/VRAM (Inv5). Comment: "Texture bleeding: frame pairs touching with 0px gutter (pure rect math off the placed frames — NO decode, NO host data). A CORRECTNESS finding: it carries no saving (edge-extrude can grow the sheet, invariant 5). Absent cfg.bleeding (CLI/headless) ⇒ no finding ⇒ byte-identical."

== WORKER / UI / BACKEND ==
- Worker (fix.worker.ts / analysis worker): NO change. The rule runs inside analyze(), which already runs in the worker. No new host feature, no new decode.
- UI: NO change. FilmViewer's generic overlay loop (FilmViewer.tsx:59-83) renders kind:'bleeding' via ZONE_STYLE['bleeding'] (already at line 10). The triage/finding list surfaces it like any other Finding (rule/severity-driven). Verify the triage list has no hard-coded exhaustive rule switch that would silently drop an unknown rule (it groups by severity/scope, not a rule whitelist — confirmed no rule-enum switch in the overlay path).
- Backend: NO change (Inv1/2 untouched).

== EDGE CASES ==
- Padded atlas (gutter>=1): no 0-gap pair ⇒ no finding (the silence calibration case).
- Aliased frames (same rect, multiple names): collapsed to one distinct rect; they cannot bleed against themselves ⇒ not counted.
- Rotated frames: skipped (excluded from candidate set), surfaced implicitly by not contributing pairs; not flagged (extrude fix is rect-only).
- Frames that merely share a CORNER (touch at a point, 0 perpendicular overlap): NOT counted (require strict `<` overlap, not `<=`).
- Loose (non-atlas) assets: never reach this rule (it's per-atlas).
- Sprites packed against the SHEET edge (x===0 etc.): only frame-to-frame adjacency is considered, not frame-to-border (border bleed is a clamp/wrap concern, out of scope).
- Single-sprite atlas / empty atlas: no pairs ⇒ null.
- Degenerate zero-area frame: skip (cannot form a meaningful seam).
- Performance: thousands of frames ⇒ bucketed lookup keeps it linear-ish; cap candidate scanning if needed (the existing rules don't cap, and frame counts are bounded by atlas px; acceptable).

== TEST PLAN (against the real harness) ==
packages/analysis/test/analysis.test.ts (mirroring the solid-fill/frame-redundancy describe blocks at lines 272-334):
1. "two frames touching with 0 gutter and vertical overlap ⇒ pair counted" — build a 2-sprite atlas with A={0,0,32,32}, B={32,0,32,32}; set cfg minPairs:1 ⇒ finding fires, overlay has a 1px vertical strip at x=32, NO estimate (assert finding.estimate is undefined — the Inv5 guard test, mirroring solid-fill's "NO diskBytesSaved" assertion at line 278).
2. "padded frames (1px gap) ⇒ null" — A={0,0,32,32}, B={33,0,32,32} ⇒ no pair ⇒ null (the silence case).
3. "corner-only touch ⇒ null" — A={0,0,32,32}, B={32,32,32,32} (share only the point) ⇒ null.
4. "below minPairs ⇒ null"; "at/above warnPairs ⇒ warn, else info".
5. "rotated frames excluded" — a touching pair where one is rotated:true ⇒ not counted.
6. "aliased frames (identical rect, 2 names) ⇒ not a bleeding pair" (distinct-rect guard).
7. "no bleeding config ⇒ null (CLI/budget configs that don't opt in)" — call with a cfg lacking .bleeding.
8. "analyze() emits bleeding for a zero-gutter atlas and NOTHING flows into totals.potentialDiskSaved" (Inv5 aggregate-honesty test, mirroring the frame-redundancy NOT-folded precedent).
9. Add a golden-fixture case: a make-fixture-generated tightly-packed (0-gutter) TexturePacker sheet with a documented N adjacent pairs; expected.json lists `{rule:'bleeding', severity:'info'|'warn'}`. (Use the make-fixture skill.) Also confirm the existing 3 ATLAS_CASES goldens still pass — pixi-packed-ok / tp-array-oversize must be re-checked: if they happen to have 0-gutter frames the new rule will add a finding and their expected.json `sig()` must be updated; if they have padding they stay silent. THIS IS A REQUIRED REGRESSION CHECK — run `pnpm --filter @asset-doctor/analysis test` and reconcile any golden diffs by inspecting whether the fixture truly has touching frames (legitimate) vs a false positive (bug).

packages/i18n/test/render.test.ts (the drift guard):
- Add a bleeding case to realFindings(): a 2-sprite atlas with touching frames, call bleedingFinding with a cfg whose minPairs:1, push the result.
- Add 'bleeding' to the messageKey set assertion at line 112.
- The existing loop (113-124) then auto-verifies en renders byte-identical + ru is brace-free.

packages/i18n/test/catalogs.test.ts: auto-passes once all 9 catalogs get find.bleeding.{title,detail,fix} with matching placeholder tokens and plural objects (title+detail are plural on {pairs}); add an explicit per-locale brace-free render assertion for find.bleeding.title (n=1 and n=5) in the "every locale renders a plural" test (line 32-48), matching the existing pattern.

Catalog edits: add find.bleeding.title (plural {pairs}), find.bleeding.detail (plural {pairs}, contains {pairs}), find.bleeding.fix (flat string) to en.json AND all 8 translations. Tokens must match across locales (catalogs.test.ts enforces). Run `pnpm --filter @asset-doctor/i18n test`.

Full gate: `pnpm typecheck && pnpm test && pnpm lint` (the Rule-union widening touches core consumers — typecheck catches any exhaustive switch I missed; I verified FilmViewer + triage are NOT exhaustive over Rule).

== ORDERED SMALL-COMMIT BREAKDOWN ==
1. feat(core): add 'bleeding' to Rule union + ThresholdConfig.bleeding? optional gate (additive; doc comment on Inv5 correctness-not-saving + browser-only). typecheck.
2. feat(analysis): bleedingFinding pure rule (rects.ts) + DEFAULT_THRESHOLDS.bleeding default + index export. Unit tests for the rule (analysis.test.ts cases 1-7) including the NO-estimate Inv5 assertion.
3. feat(analysis): wire bleedingFinding into analyze.ts per-atlas block; test case 8 (no flow into totals) + reconcile the 3 existing atlas goldens.
4. test(fixtures): make-fixture zero-gutter sheet + golden expected.json (case 9).
5. feat(i18n): find.bleeding.{title,detail,fix} across all 9 catalogs; update render.test.ts realFindings + messageKey set; catalogs.test brace-free assertion. Run i18n tests.
6. (no UI commit needed — FilmViewer already renders the teal generically; optionally a tiny commit removing the now-accurate "bleeding never emitted" mental note if any stale comment exists.)
Final: pnpm typecheck && pnpm test && pnpm lint; run check-invariants skill (zero-network, no generation, disk!=VRAM honesty) before merge.