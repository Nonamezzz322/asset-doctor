# cross-atlas-redundancy: collapse each atlas to ONE representative unit per cluster (stop re-counting an atlas's intra-atlas dupes as cross-sheet freed copies) (PROCEED)

## PREMISE VERIFICATION (every load-bearing claim checked against real code)

VERIFIED TRUE — the double-count is real and reproduces exactly as the pick describes.

**The overlap (confirmed by tracing both functions):** Take Atlas A with 3 byte-identical 'z' frames at 3 DISTINCT packed rects + Atlas B with 1 'z' frame.
- `frameRedundancyFinding` (packages/analysis/src/rules.ts:202-219): keys `byRect` by `rectKey(frame)` → A's 3 distinct rects → `distinctRects=3` → `recoverableArea += (3-1)×rectArea` and `totalDuplicates += 2`. Within-atlas honestly reports dupes=2 / area=2×rectArea for A's intra-atlas dupes.
- `crossAtlasRedundancyFinding` (packages/analysis/src/folder.ts:389-404): keys `byAtlasRect` by `` `${u.atlas}|${rectKey(u.rect)}` `` → A's 3 distinct rects → 3 entries `A|r1,A|r2,A|r3`, plus `B|r4` → `distinctUnits.length=4` → `freed = distinctUnits.slice(1)` = 3 → `dupes=3`, `recoverableArea=3×rectArea`.
- **A's 2 intra-atlas dupes are counted in BOTH findings.** The honest cross-sheet reclaim is 1 (only B's single copy can reference A's shared copy; A's 2 internal dupes are within-atlas reclaim, owned by `frameRedundancyFinding`). Today's cross-atlas finding over-claims by 2.

**Honesty/invariant violation confirmed in the code's OWN assertions:**
- folder.ts:306-307 docstring asserts cross-atlas reclaim is "different pixels … additive reclaimable areas, NOT the same win" vs within-atlas — FALSE in the overlap case (the 2 px sets are identical, double-counted).
- folder.ts:308-309 HONESTY PIN: `dupes` = "exactly the `framesAliased` a future cross-atlas FIX would report" — FALSE: a real cross-sheet fix aliases B→A's shared copy = 1 frame, not 3. The 2 within-A dupes are an intra-atlas dedup the cross-atlas fix does not perform.
- This violates invariant 3 (objective — measure honestly, the reported count must equal what a fix delivers) and invariant 5 (never over-claim reclaimable footprint; the VRAM/disk/area all inflate by 2×rectArea here).

**Regression-guard claims VERIFIED:**
- "three atlases share a frame ⇒ dupes:2" (analysis.test.ts:921-933): A,B,C each have exactly ONE rect → per-atlas collapse is a no-op (each atlas already one distinct rect) → still dupes=2, area=2×cell, vram=2×cell×4. GREEN.
- "pre-aliased rect collapses to one unit per atlas" (analysis.test.ts:935-952): A has 2 aliases on the SAME rect + B has 1. Old `atlas|rect`: A→1, B→1. New `atlas`: A→1, B→1. Identical → dupes=1, sheets=2, area=cell. GREEN.
- Disk test (analysis.test.ts:990-1004): A(rep)+B(freed), B's rep rect=32×32=1024, byteByRef['B.png']=8000, allFrameArea['B.png']=1024 → disk=8000. Under new keying `freed` still = [B-rep], area still 1024 → disk still 8000. GREEN.
- "two atlases share ONE frame" (analysis.test.ts:871-896): each atlas one shared rect → no-op → dupes=1. GREEN.

**Default path byte-identical VERIFIED:** any atlas contributing ≤1 distinct rect per cluster (the overwhelmingly common case — a frame appears at most once per sheet) is unaffected, since `atlas|rect` and `atlas` keying produce the same single entry. Only atlases that ALSO have intra-atlas dupes of the same hash change — and those are exactly the over-counted cases.

VERDICT: PROCEED. The bug is real, contained, and the fix restores the code's own stated contract.

---

## PROBLEM (verified)
`crossAtlasRedundancyFinding` keys its per-cluster distinct-unit guard by `atlas|rect`, so an atlas with N intra-atlas duplicates of a frame that ALSO appears on another sheet contributes N units (one per packed rect) to `distinctUnits` instead of 1. Those N−1 internal dupes are then re-counted as cross-sheet "freed copies" — already fully claimed by `frameRedundancyFinding` (rules.ts) which reclaims them per-rect within the atlas. Result: the two findings double-count the same pixels; cross-atlas's `dupes`/`recoverableArea`/`vram`/`diskEstimate` over-claim, and the docstring's orthogonality + HONESTY-PIN assertions are violated.

## V1 SCOPE
Change the per-atlas distinct-unit guard in `crossAtlasRedundancyFinding` so each atlas contributes EXACTLY ONE representative unit per cluster: key `byAtlasRect` (rename → `byAtlas`) by `u.atlas` ALONE, keeping the lowest-(atlas,index) member as that atlas's representative. Then `distinctUnits = one cell per atlas in the cluster`, `freed = distinctUnits.slice(1)` = (distinct-atlases − 1) representative copies = the honest cross-sheet reclaim. `recoverableArea`/`vram`/`dupes`/`diskEstimate` all follow. Intra-atlas dupes are left entirely to `frameRedundancyFinding` → the two findings partition the duplicate set with zero overlap.

## OUT OF SCOPE
- No change to `frameRedundancyFinding` (rules.ts) — it is already correct and per-rect.
- No new config keys, no new finding, no new core types.
- No packer/bin-tier logic — exact area arithmetic stays.
- No change to disk-into-aggregate behavior (still finding-local, never folded into `potentialDiskSaved`).
- No change to the worker hashing path or `byteByRef`/`frameHashByRef` wiring in analyze.ts.

## ADDITIVE CONTRACT / TYPE CHANGES
None. Same `Finding` shape, same `messageKey: 'cross-atlas-redundancy'`, same params keys (`dupes, groups, sheets, refs, atlases, vram, area, disk`). Only the NUMERIC VALUES for the (rare) overlap case change. No core/parsers/i18n schema change.

## PURE MODULES + SIGNATURES
Single pure function, signature unchanged:
`crossAtlasRedundancyFinding(atlases: Atlas[], frameHashByRef: Map<string,(string|null)[]>, byteByRef: Map<string,number>, cfg: ThresholdConfig): Finding | null`

Edit body at folder.ts:387-404. Replace the `atlas|rect` keying with atlas-only keying:
```
// DISTINCT-UNIT GUARD, per atlas: each atlas contributes ONE representative unit per cluster (the lowest-
// (atlas,index) member). An atlas's OWN intra-atlas dupes of this frame are frameRedundancy's reclaim
// (rules.ts, per-rect); counting them here would double-claim the same pixels (invariant 3/5). Cross-sheet
// reclaim = aliasing one shared copy across the DISTINCT sheets = (distinct atlases − 1) copies.
const byAtlas = new Map<string, Unit>();
for (const u of cluster) {
  const prev = byAtlas.get(u.atlas);
  if (!prev || u.index < prev.index) byAtlas.set(u.atlas, u); // lowest-index rep per atlas (determinism)
}
const distinctUnits = [...byAtlas.values()];
if (distinctUnits.length < cfg.crossAtlasRedundancy.minDuplicates) continue;
```
Keep the existing `distinctUnits.sort((a,b) => a.atlas.localeCompare(b.atlas) || a.index - b.index)` and `freed = distinctUnits.slice(1)` (lines 401-402) verbatim — they already produce the deterministic cluster-wide representative. `rectKey` helper at folder.ts:321 becomes unused in this function (the cluster-spanning `atlasesInCluster` set at 384 still uses `u.atlas`); remove `rectKey` only if no other reference remains (grep confirms it is used solely here in folder.ts → remove it to avoid an unused-var lint error).

**Disk loop (folder.ts:406-417) — unchanged logic, but note:** it iterates `for (const f of freed)` and uses `f.rect.w*f.rect.h`. Under the new keying each `f` is an atlas representative; its rect area equals the canonical cluster area (uniform within a hash cluster), so `recoverableArea`/`diskEstimate` are computed identically to before for the rep, and the disk test (8000) is preserved. The `refs`/`atlasSet` loop at 406-409 iterates the FULL `cluster` (all member names) — leave it: keeping every aliased name in `relatedRefs` as proof is the same convention as within-atlas (rules.ts:221) and does not affect the headline counts.

## GATE SEMANTICS (must update comments — flagged adversarially)
After the change, `distinctUnits.length === atlasesInCluster.size` (one unit per atlas). The cluster already passed `atlasesInCluster.size >= 2` at folder.ts:385, so the gate at 397 with default `minDuplicates: 2` is now a no-op (always passes once 385 passes), and for `minDuplicates: N` it cleanly means "frame recurs on ≥N distinct sheets." This is MORE honest, but the prose now describes a different quantity. Update:
- folder.ts:302-305 docstring: `minDuplicates` now counts DISTINCT SHEETS the frame recurs on (≥2 ⇒ on ≥2 sheets), not "cross-sheet duplicate copies" / not "by distinct packed rect per atlas."
- folder.ts:308-309 HONESTY PIN: `dupes` = Σ(distinct-atlases − 1) per cluster = exactly the frames a cross-atlas FIX aliases. (Now TRUE.)
- folder.ts:306-307 orthogonality claim: now actually holds — keep but it is now accurate.
- config.ts:40-43 comment: change "counted by DISTINCT packed rect per atlas (a pre-aliased rect = one unit)" → "counted by DISTINCT SHEET (each atlas contributes one unit; an atlas's own intra-atlas dupes are frameRedundancy's reclaim)."
- packages/core/src/index.ts:607 doc comment for `crossAtlasRedundancy.minDuplicates`: same wording fix.

## WORKER / UI / BACKEND CHANGES
None. The worker (apps/web/src/worker/fix.worker.ts:645) reads `crossAtlasRedundancy?.minDuplicates` only as a gate threshold for its own cross-atlas dedup pass — the meaning ("≥N sheets") is unchanged for the default value and the fix engine's behavior is unaffected (it dedups by hash regardless). No UI surface reads the changed numbers other than rendering the finding string, which is i18n-driven and structurally identical.

## HONESTY + INVARIANT COMPLIANCE
- Invariant 3 (objective, generate nothing): unchanged — still pure measurement; the reported `dupes` now EQUALS what a cross-sheet alias fix delivers (previously over-stated). Strengthens objectivity.
- Invariant 5 (disk≠VRAM, never over-claim): `vram = recoverableArea×4` is now the honest cross-sheet area; disk stays an area-proportional ESTIMATE, finding-local, never folded into the aggregate (analyze.ts unchanged; test 1006-1024 still passes). The two findings now PARTITION the duplicate set — additive without overlap, exactly as the docstrings claim.
- Invariants 1,2,4: untouched (pure analysis, client-side, no new cost).

## DETERMINISM
Preserved. Per-atlas rep selection uses lowest `index` (deterministic); cluster-wide rep uses `localeCompare(atlas) || index` (folder.ts:401, unchanged, matches manifest.ts collation); all output sets (`sortedRefs`, `sortedAtlases`) keep localeCompare (folder.ts:428-429). No Date/random. ICU-stable for a fixed build (same caveat as existing code).

## EDGE CASES
- Atlas with intra-atlas dupes of a frame that does NOT appear on another sheet → single-atlas cluster, filtered at line 385 (unchanged), owned by frameRedundancy. ✓
- Pre-aliased rect (two names, same rect) within one atlas → collapses to one atlas unit under both old and new keying. ✓
- An atlas with the frame at multiple distinct rects AND it appears cross-sheet → THIS is the fixed case: atlas now contributes 1 (not N). ✓
- Cluster spans ≥2 atlases where one atlas has the frame twice (distinct rects) and the other once → old dupes=2, new dupes=1 (the one freed cross-sheet copy). The within-atlas finding separately reports the 1 intra-dupe. Partition holds.
- length-mismatch / all-null / <2 atlases / no-config → unchanged early returns (tests 954-988 GREEN).
- Zero-area frames → cannot reach gate (rectArea 0 ⇒ but cluster still gated by atlas count; disk guard `atlasArea>0` unchanged). ✓

## I18N / GOLDEN RECONCILIATION
The en catalog template (packages/i18n/src/catalogs/en.json:138-148) and the baked English in folder.ts:444-449 are STRUCTURALLY unchanged (same placeholders, same plural on `dupes`). The drift guard (packages/i18n/test/render.test.ts) constructs its cross-atlas fixture at render.test.ts:89-99 with ONE shared frame per atlas on a distinct rect each → per-atlas collapse is a no-op → baked string byte-identical → drift test GREEN with NO catalog edit. **No catalog or 9-locale edit required** (the headline strings for the changed overlap case still match the templates byte-for-byte; only the substituted numbers differ, which is data, not template). Run the i18n drift test to confirm the baked-English↔en byte match still holds.

## TEST PLAN (against the real harness)
Add to the existing `describe('cross-atlas-redundancy …')` block in packages/analysis/test/analysis.test.ts:
1. **NEW regression (the bug):** Atlas A with frames at 3 DISTINCT rects all hash 'z' + Atlas B with 1 'z' frame. Inject `hashes = {'A.png': ['z','z','z'], 'B.png': ['z']}` with A's 3 sprites at distinct x (0,32,64) and B's at x:0. Assert `dupes===1`, `sheets===2`, `area===cell.w*cell.h`, `vram===cell.w*cell.h*4`. (Pre-fix this asserts dupes=3 → proves the fix.)
2. **NEW partition proof:** With the SAME atlases, call `frameRedundancyFinding(A, cfg, ['z','z','z'], 8000)` (note within-atlas gate is minDuplicates:3 → 3 distinct rects → fires, dupes=2). Assert within-atlas dupes=2 + cross-atlas dupes=1, and assert the two areas are disjoint reclaim (within=2×cell, cross=1×cell, no shared px). Documents the partition.
3. **Re-run existing tests unchanged** — confirm GREEN: lines 871, 921, 935, 990, 1006 (all traced GREEN above).
4. **i18n drift:** `pnpm --filter @asset-doctor/i18n test` → render.test.ts baked-vs-catalog byte match.
5. Full suite: `pnpm test` + `pnpm typecheck` (catches the removed-`rectKey` unused-var if any reference remains).

## ORDERED SMALL-COMMIT TASK BREAKDOWN
1. `test(analysis): add failing cross-atlas overlap regression (atlas with intra-atlas dupes over-counted as cross-sheet freed)` — add tests #1 and #2; confirm #1 fails on current code (dupes=3).
2. `fix(analysis): collapse each atlas to ONE representative unit per cross-atlas cluster` — folder.ts:389-404 atlas-only keying, remove now-unused `rectKey` if no other ref; test #1 turns GREEN, all existing GREEN.
3. `docs(analysis): correct cross-atlas minDuplicates/HONESTY-PIN/orthogonality prose to match per-sheet semantics` — folder.ts:302-309, config.ts:40-43, core/src/index.ts:607 comment updates (comments only; no behavior).
4. Verify: `pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @asset-doctor/i18n test`.

## RELEVANT FILES (absolute)
- /home/nonamezzz/Рабочий стол/projects/packages/analysis/src/folder.ts (lines 287-466, edit 387-404 + docstring 302-309)
- /home/nonamezzz/Рабочий стол/projects/packages/analysis/src/rules.ts (lines 156-269, reference only — the correct per-rect sibling)
- /home/nonamezzz/Рабочий стол/projects/packages/analysis/src/config.ts (line 40-43 comment)
- /home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts (line 607 doc comment)
- /home/nonamezzz/Рабочий стол/projects/packages/analysis/test/analysis.test.ts (describe block at line 853; add tests, regression at 921/935/990/1006 must stay green)
- /home/nonamezzz/Рабочий стол/projects/packages/i18n/test/render.test.ts (lines 89-99, 120 — drift guard, no edit expected)
- /home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json (lines 138-148 — no edit expected)