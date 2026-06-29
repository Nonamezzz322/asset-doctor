# De-overlap exact-duplicate dropped copies against their own format/alpha/strippable savings in potentialDiskSaved (PROCEED)

# Mini-design: cap each exact-dup group's combined disk contribution

## Premise — VERIFIED against the real code (file:line)

Every load-bearing claim checks out. Evidence:

1. **dup charge is a separate summed term.** `analyze.ts:285-287`:
   `const exact = duplicateExactFindings(...); folder.push(...exact); potentialDiskSaved += exact.reduce((s,f)=>s+(f.estimate?.diskBytesSaved ?? 0),0);`
   And `folder.ts:69-71` sets `diskBytesSaved: perDisk*(refs.length-1)` (perDisk = `imgs.get(refs[0]).byteSize`, `folder.ts:54-55`).

2. **format/alpha/strippable run for EVERY loose image, dup copies NOT excluded.** Loose branch `analyze.ts:249-279`: `addFormat` (262) → `bumpBest` (172); `wastedAlphaFinding` (266-275) → `bumpBest` (273); `addStrippable` (278) → `bumpBest` (184). The loop iterates `assets` unconditionally; nothing consults the dup grouping. Atlas pages ALSO call `addFormat`/`addStrippable` (`analyze.ts:211-214`).

3. **`bumpBest` is strictly per-ref** (`analyze.ts:159-165`): each dup copy gets its own `bestSavedByRef` entry and its own `potentialDiskSaved +=`. So N byte-identical AVIF-transcodable copies contribute N format savings, not 1.

4. **The inflated number is the headline.** `App.tsx:292` `HeaderMetric label={t('metric.saveable')} value={fmtBytes(totals?.potentialDiskSaved ?? 0)}...`; `App.tsx:158` derives `savedPct` from the same field. It is shown FIRST.

5. **Test gap confirmed.** `analysis.test.ts` covers three-way format+alpha+strip MAX in isolation (510-522) and folder-aggregate non-double-count (537-543); `dedup.test.ts` covers dup grouping but with features carrying ONLY `contentHash` (e.g. 242-244) and never passes `encodeImage`/`encodeOpaque`. No test exercises a shared-`contentHash` group whose members ALSO have format/alpha/strip findings. So the over-claim is currently untested and unguarded.

6. **VRAM is never summed.** `potentialDiskSaved` only ever receives disk terms (grep of `analyze.ts:104,156-163,287` — every contribution is a `diskBytesSaved`). Dup `vramBytesSaved` (`folder.ts:71`) is display-only. Invariant 5 already respected on the VRAM axis; the bug is purely a DISK over-claim. Premise holds → PROCEED.

### Adversarial correction folded in (grouping subtlety)
The pick says "extend the per-ref running-max de-overlap so dropped copies do not contribute". The cap MUST be computed against the SAME grouping that charges the disk term — i.e. `duplicateExactFindings`'s plain `contentHash` grouping (`folder.ts:44-49`, keep `refs[0]` after `refs.sort()`, drop `refs[1..]`), NOT the richer `buildDedupGroups` (pool/skinGroup/bundle-isolation) engine, which `analyze.ts` does NOT use for this total. Using the wrong grouping would mis-cap. Also: `refs[0]` (kept) and `refs[1..]` (dropped) may each be loose OR atlas-page refs (features cover both — `analyze.worker.ts:128` iterates all `imageBytes`); both populate `bestSavedByRef`, so the cap generalizes without a loose/atlas branch.

## Problem (one line)
A folder of 2 byte-identical AVIF-transcodable PNGs counts dup(10k)+format-b(4k phantom)+format-a(4k real)=18k, but post-dedup b won't exist, so the achievable max is dup(10k)+format-of-kept(4k)=14k. The 4k charged to the dropped copy is phantom.

## v1 scope
- In `analyze.ts`, AFTER the asset loop (so `bestSavedByRef` is fully populated) and at the point the exact-dup term is added (replacing the `reduce` at line 287), subtract, for each exact-dup group, the `bestSavedByRef` contributions of the DROPPED copies (`refs[1..]`) that are already in `potentialDiskSaved`. Net group disk contribution becomes:
  `perDisk*(n-1)` (the dedup saving, unchanged) **minus** `Σ bestSavedByRef[droppedRef]` over `refs[1..]`.
  Equivalently: the kept copy `refs[0]` retains its full format/alpha/strip MAX contribution; every dropped copy's format/alpha/strip contribution is reverted (it vanishes with the file). The dedup term itself is never reduced.
- Implement by reusing the exact-dup grouping. Because `duplicateExactFindings` returns one finding per group with `relatedRefs = refs` (sorted, `folder.ts:63`) and `assetRef = refs[0]` (kept, `folder.ts:62`), I derive dropped copies as `f.relatedRefs.filter(r => r !== f.assetRef)` — no re-grouping, no new traversal, fully aligned with the disk charge.

## Out of scope (do NOT touch)
- Per-finding estimates: dup finding keeps `perDisk*(n-1)` and `vramBytes*(n-1)`; format/alpha/strip findings keep their isolated `diskBytesSaved`. Each finding stays honest standalone (the format/alpha MAX precedent — `analysis.test.ts:537-543` shows this is the house rule).
- VRAM totals, `loadedVramBytes`, mipmap totals — untouched.
- `duplicateSimilarFindings` (carries no `diskBytesSaved`, never summed), frame-redundancy / trim-margin / cross-atlas (area ESTIMATES, deliberately excluded `analyze.ts:218,228,297`).
- `buildDedupGroups` / the fix engine's real dedup ownership — that's the fix-plan path, not the headline total.
- i18n strings, overlays, `messageKey`/`params`.
- CLI/headless behavior: with no `features` dep the dup block at `analyze.ts:284` is skipped entirely → byte-identical.

## Additive contract / type changes
**None.** No `core` changes, no new `Finding`/`estimate` fields, no new `AnalyzeDeps`. Pure internal arithmetic in `analyze.ts`. (Inv on `core` as single source of truth — nothing drifts.)

## Pure modules + signatures
All inside `analyze.ts`; no new exported symbol required. Replace the line-287 `reduce` with a small local helper computed inline. Suggested local:

```ts
// Cap each exact-dup group: the dedup saving stays, but the format/alpha/strippable saving already
// credited to the DROPPED copies (refs[1..]) is reverted — those files vanish on dedup, so their
// per-ref bumps were phantom. The KEPT copy (refs[0] === finding.assetRef) retains its full MAX
// contribution. Subtraction is clamped at 0 per group (a group can never give back more than it took).
let exactDisk = 0;
for (const f of exact) {
  const groupDedup = f.estimate?.diskBytesSaved ?? 0;          // perDisk*(n-1), unchanged
  let droppedBumps = 0;
  for (const ref of f.relatedRefs ?? []) {
    if (ref === f.assetRef) continue;                          // keep refs[0]'s contribution
    droppedBumps += bestSavedByRef.get(ref) ?? 0;              // already in potentialDiskSaved
  }
  exactDisk += groupDedup;
  potentialDiskSaved -= droppedBumps;                          // revert phantom per-ref bumps
}
potentialDiskSaved += exactDisk;
```

Notes on correctness:
- `bestSavedByRef.get(ref) ?? 0` is exactly the amount that was added to `potentialDiskSaved` for that ref during the loop (the running-max invariant — final map value == total contributed for that ref). Subtracting it is exact, not an estimate.
- Subtracting per dropped ref can never go negative overall because each `bestSavedByRef[ref]` was genuinely added earlier; the group dedup term is added separately and independently. No clamp needed mathematically, but a defensive `Math.max(0, ...)` on the FINAL `potentialDiskSaved` is unnecessary (would mask a bug) — leave it exact.

## Worker / UI / backend changes
- **Worker:** none. `analyze.worker.ts` passes `features` (incl. opaque/contentClass) exactly as today; the cap is downstream in pure `analyze`.
- **UI:** none structurally. `App.tsx:292`/`:158` automatically show the corrected (lower, honest) number — that's the whole point. No copy change needed; "save N" is now accurate.
- **Backend:** none. Pure client/CLI core.

## Honesty + invariant compliance
- **Inv 3 (objective, generate nothing):** pure aggregation arithmetic over existing measured findings. No new measurement, no synthesis. The de-overlap is subtraction of already-computed values.
- **Inv 5 (disk ≠ VRAM, never over-claim/conflate):** this REMOVES a real disk over-claim from the headline. VRAM is untouched (never summed here; dup `vramBytesSaved` stays display-only). Disk and VRAM remain separate axes. The corrected total is a strict lower-or-equal number — we only ever stop over-claiming, never inflate.
- **Inv 4 (instant-wow):** zero added decode/IO; O(total refs across dup groups) map lookups, negligible.
- The kept-copy keeps its saving because after dedup that file STILL exists and IS still transcodable — so crediting its format/alpha/strip MAX is honest, not phantom.

## Determinism
Fully deterministic. `duplicateExactFindings` sorts `refs` (`folder.ts:53`) so `assetRef`/`relatedRefs` ordering is stable; iteration over `exact` (already deterministically ordered) and over `relatedRefs` is order-independent for a sum. `bestSavedByRef` is fully populated before this block (asset loop completes at `analyze.ts:280`, dup block at 284). No floats beyond integer byte counts already in use. Same inputs → same total, run to run.

## Edge cases
1. **Dup group with NO format/alpha/strip findings on any member** → every `bestSavedByRef.get(ref)` is `0` (or undefined→0) → `droppedBumps=0` → total byte-identical to today. (This is the required regression test.)
2. **Dup group where only the KEPT copy `refs[0]` has a format finding** → dropped copies contribute 0 bumps → no subtraction → kept's saving retained. Correct (the file stays, saving stays).
3. **Dup group where only a DROPPED copy has a format finding** (possible: identical bytes ⇒ identical format-saving, but a member could be the only one the encoder probed — in practice identical bytes give identical findings, but handle generally) → that dropped copy's bump is reverted; if the kept copy also has the (equal) saving it's retained via its own ref. Net: exactly one copy's worth of format saving survives. Correct.
4. **n=2 identical, both AVIF-transcodable 4k each, dup=10k** → today 18k; after: 10k + bestSavedByRef[refs0](4k) retained, bestSavedByRef[refs1](4k) reverted → 14k. Matches the achievable max in the pick.
5. **n=3 identical, each 4k format** → today 12k(dup) + 12k(3×4k format) = 24k; after: 12k + 4k (one kept) = 16k. (perDisk*(n-1)=8k? — careful: perDisk*(n-1) for n=3 with perDisk=10k disk file is 20k; the 4k here is the format MAX, independent. Total = 20k dedup + 4k kept-format = 24k... example numbers depend on perDisk; the arithmetic is: subtract the 2 dropped copies' 4k each = revert 8k.) The formula handles any n.
6. **Atlas-page dup** (two identical atlas pages, both transcodable): same path — atlas refs are in `bestSavedByRef` (`analyze.ts:211-214`). Dropped page's saving reverted. Correct, no special-casing.
7. **Three-way MAX kept copy** (kept copy has format=4k, alpha=6k, strip=5k → `bestSavedByRef`=6k): kept retains 6k (its MAX), dropped copies revert their own 6k each. Composes cleanly with the existing MAX de-overlap.
8. **A dropped ref absent from `bestSavedByRef`** (no findings) → `?? 0`, no-op. Safe.
9. **Empty/<2 groups** → `duplicateExactFindings` skips (`folder.ts:52`), `exact` empty → loop no-op → identical to today.

## Test plan (against the real Vitest harness, `packages/analysis/test/analysis.test.ts`)
Add a `describe('exact-dup de-overlap vs format/alpha (potentialDiskSaved cap)')`. Use the existing pattern of passing `assets` + `{ encodeImage, encodeOpaque, features }` to `analyze` (mirrors `analysis.test.ts:407-415`). Construct two byte-identical loose PNGs via a local `dupImg(name)` (`size 512×512`, `mime image/png`, `byteSize 10000`) so they clear format/alpha gates.

**Required new test (the gap):** two refs sharing `contentHash:'h'` PLUS `encodeImage` so each is AVIF-transcodable.
```ts
const report = await analyze([dupImg('a.png'), dupImg('b.png')], undefined, {
  encodeImage: async () => 6000, // each format-saving = 10000-6000 = 4000
  features: [
    { assetRef: 'a.png', contentHash: 'h', contentClass: 'photographic' },
    { assetRef: 'b.png', contentHash: 'h', contentClass: 'photographic' },
  ],
});
// dup saving = perDisk*(n-1) = 10000; kept (a.png) keeps its 4000 format; b.png's 4000 reverted.
expect(report.totals.potentialDiskSaved).toBe(14000); // NOT 18000
// Per-finding honesty preserved:
const fmtB = report.findings.find(f => f.assetRef === 'b.png' && f.rule === 'format');
expect(fmtB?.estimate?.diskBytesSaved).toBe(4000); // dropped copy's finding still 4000 standalone
const dup = report.findings.find(f => f.rule === 'duplicate-exact');
expect(dup?.estimate?.diskBytesSaved).toBe(10000); // dedup term unchanged
```

**Required regression test (no over-reach):** dup group with NO format findings stays byte-identical.
```ts
const report = await analyze([dupImg('a.png'), dupImg('b.png')], undefined, {
  features: [
    { assetRef: 'a.png', contentHash: 'h' },
    { assetRef: 'b.png', contentHash: 'h' },
  ],
}); // no encodeImage/encodeOpaque
expect(report.totals.potentialDiskSaved).toBe(10000); // == today: only the dedup term
```

**Three-way + dup composition test:** kept copy has format+alpha+strip (assert kept retains its MAX 6000, dropped reverted).
```ts
// a.png & b.png identical, both opaque+strippable+transcodable
// encodeImage→6000 (fmt 4000), encodeOpaque→4000 (alpha 6000); strippableBytes 5000
// expect: dup 10000 + kept MAX 6000 = 16000  (NOT 10000 + 2×6000)
```

**Non-dup sanity (guard against accidental subtraction when refs differ):** two DIFFERENT contentHashes, both transcodable → no dup finding → total = 2×4000 = 8000 (unchanged), proving the cap only fires on real dup groups.

**Atlas-page dup test (optional but recommended):** two identical atlas assets with transcodable pages → assert dropped page's format saving reverted, dedup term kept. (Build via the existing `animAsset` helper pattern, `analysis.test.ts:567`.)

Run: `pnpm --filter @asset-doctor/analysis test` (Vitest). All 88+ existing tests must stay green — especially `dedup.test.ts` (it passes features WITHOUT encoders, so its `potentialDiskSaved` paths hit edge-case 1 → unchanged) and `analysis.test.ts:537-554` (no dup groups → unchanged).

## Ordered small-commit task breakdown
1. **test(analysis): failing tests for exact-dup disk over-claim** — add the required new test (asserts 14000) + the regression test (asserts 10000) + three-way composition + non-dup sanity to `analysis.test.ts`. Run; confirm the 14000/16000 cases FAIL at 18000/22000 today (locks the bug). (1 commit, tests only.)
2. **fix(analysis): cap exact-dup group disk contribution at perDisk*(n-1) + kept-copy MAX** — replace the `reduce` at `analyze.ts:287` with the group loop above; update the surrounding comment (currently `analyze.ts:282-287`) to state the de-overlap. Run; all new + existing tests green. (1 commit, the fix.)
3. **docs(changelog): note the headline disk de-overlap** — one line in `docs/CHANGELOG.md` (newest round) + a sentence in `docs/FEATURES.md` honesty section if it enumerates the MAX-de-overlap guarantees, framing it as Inv5 over-claim removal. (1 commit, docs.)

Keep commits in this order so the regression coverage exists before the behavior change, matching the repo's small-commit / tested-core convention.