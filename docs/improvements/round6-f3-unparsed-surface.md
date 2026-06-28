# Round-6 F3 — Surface unparsed/errored files in diagnosis + harden frame/Spine parsers

**Area:** ROBUSTNESS / HONESTY (Invariant 3). **Effort:** medium. **needsKey:** no. Skeptic-verified.

## Verdict: PREMISE TRUE, implementation-ready.

Diagnosis silently drops unparseable assets: `analyze.worker.ts:37-40/:48-51` have `if (res.ok …)` with **no else**; ingest continues on every parse failure (`ingest/index.ts:95,115,120`); `AnalysisReport` has no unparsed field. The fix engine already honors `skipped[]` — make the diagnosis symmetric.

### Corrections vs draft
- **C1 — T0 deleted.** `apps/web/src/lib/group.ts` is verbatim `export * from '@asset-doctor/ingest'` (re-export, NOT a fork) → `Grouped.unparsed` reaches the worker with zero extra work.
- **C2 — probe write-back needs NO code change.** `probe-run.ts:111-118` is `{...report, assets, totals}` (top-level spread) → `unparsed` rides through; `App.tsx:95` only `setReport` on a new ref. Keep a 1-line assertion only.
- **C3 — atlas OOB rotation reasoning pinned:** TP stores `frame.w/h` as-placed (no swap in `bodyToSprite`), Spine `toSprite:72` swaps → the `x+w>size.w` in-page test is correct for BOTH; don't double-swap.
- **C4 — `readRect` gate is safe** for `spriteSourceSize` (trim offsets ≥0, w/h>0) and mesh round-trip (mesh uses separate readers `readMesh`/`readVec2Pairs`, not `readRect`).

**Honesty calls (keep):** surface ONLY the 3 "looks like an asset manifest but unusable" cases (`.atlas` threw / `.json` failed JSON.parse / manifest with frames but no `meta.image`). `:111` (`!/\.json$/`) and `:118` (`!looksLikeManifest`) stay SILENT — a README/.skel/.json-config is legitimately not an asset; flagging it is its own dishonesty. Spine = per-region recovery (page keeps good regions); atlas TP-JSON = whole-reject (existing one-bad-frame-fails behavior).

## Core contract (additive) — `core/src/index.ts` (after `atlasFrames?`)
```ts
/** Would-be assets the diagnosis could NOT parse — surfaced honestly instead of silently dropped
 *  (symmetric with the fix engine's skipped[]). NEVER benign non-asset files. `ref` = dir-aware key /
 *  basename / "<page>#<region>". Additive & order-stable (sorted by ref): absent/empty ⇒ byte-identical. */
unparsed?: { ref: string; reason: string }[];
```

## Pure hardening
- **`atlas.ts` `readRect`:** after the undefined check, `if (w<=0||h<=0||x<0||y<0) return null;` → existing `invalid frame "${name}"` surfaces it.
- **`atlas.ts` `parseAtlasManifest`:** post-loop OOB pass (after `size` resolved, before building): `if (s.frame.x+s.frame.w>size.w || s.frame.y+s.frame.h>size.h) return {ok:false,error:`frame "${s.name}" extends past atlas ${size.w}×${size.h}`};`
- **`image-size.ts`:** `const MAX_DIM=32768; const validDims=(s)=> s && s.w>0 && s.h>0 && s.w<=MAX_DIM && s.h<=MAX_DIM ? s : null;` wrap the return of all 4 readers (png/webp/jpeg/avif).
- **`spine-atlas.ts`:** replace `ints()` (`.filter(Number.isFinite)` shifts coords — `'xy: , 100'`→`[100]`→`{x:100,y:0}`) with fixed-arity NaN-preserving `const numsRaw=(v)=>v.split(',').map(s=>parseInt(s.trim(),10));`. `RegionAcc` gains `malformed?:string`; `applyRegionKey` flags non-finite REQUIRED field (`xy`/`size`/`orig`/`bounds`) → `r.malformed ??= ...`; `offset`/`offsets` stay tolerant (default 0). `SpinePage` gains `malformedRegions?: {name,reason}[]`. `flushRegion`: if `region.malformed` → push to `page.malformedRegions` and do NOT push a sprite; plus a per-region OOB check when `page.size` known. **Spine = per-region recovery** (page keeps good regions); `parseSpinePage` signature unchanged.
- **`ingest/index.ts`:** `Grouped.unparsed: {ref,reason}[]`; `const msg=(e)=>e instanceof Error?e.message:String(e)`; push at `:95` (`Spine .atlas parse failed: ${msg}`), `:115` (`manifest JSON parse failed: ${msg}`), `:120` (`manifest has frames but no meta.image`); `ref`=basename; sort by ref before return. `:111`/`:118` stay silent.
- **`analysis/analyze.ts`:** `AnalyzeDeps.unparsed?`; in returned object alongside `atlasFrames` spread: `...(deps.unparsed?.length ? { unparsed: deps.unparsed } : {})`. Pure pass-through, no re-sort.

## Worker — `analyze.worker.ts`
```ts
const unparsed = [...grouped.unparsed];
// atlas loop: else if (!res.ok) unparsed.push({ ref: a.name, reason: res.error });
//   + if (a.kind==='spine') for (const mr of (a.manifest as SpinePage).malformedRegions ?? []) unparsed.push({ ref:`${a.name}#${mr.name}`, reason: mr.reason });
// image loop: else if (!res.ok) unparsed.push({ ref, reason: res.error });
unparsed.sort((a,b)=>a.ref.localeCompare(b.ref));
const report = await analyze(..., { ..., ...(unparsed.length ? { unparsed } : {}) });
```
No `protocol.ts` change (rides inside `AnalysisReport`).

## UI — `App.tsx`
Render after `<FolderReport>`, before the `report.assets.length===0` ternary: `{report.unparsed?.length ? <UnparsedNotice items={report.unparsed}/> : null}`. `UnparsedNotice` is a `<details>` reusing the `fix.skipped` styling (App.tsx:1143-1156): `t('report.unparsed.title',{n})` summary + `<ul>` of `ref — reason`.

## i18n — 9 catalogs + test
```json
"report.unparsed.title": { "$count":"n", "one":"{n} file could not be analyzed", "other":"{n} files could not be analyzed" }
```
Reasons stay English (parser strings, same precedent as `fix.skipped`). Add a no-leftover-braces assertion in `catalogs.test.ts`.

## ORDERED TASKS
| id | title | files | deps |
|---|---|---|---|
| T1 | Core `AnalysisReport.unparsed?` | core/src/index.ts | — |
| T2 | Ingest surfaces 3 skip-points (sorted) | ingest/src/index.ts | — |
| T3 | Harden `readRect` + atlas OOB | parsers/src/atlas.ts | — |
| T4 | Harden `image-size` dims (validDims ×4) | parsers/src/image-size.ts | — |
| T5 | Spine fixed-arity NaN parse + malformedRegions (per-region recovery) | parsers/src/spine-atlas.ts | — |
| T6 | Analysis pass-through dep | analysis/src/analyze.ts | T1 |
| T7 | Worker else-branches + merge + Spine malformed + sort | analyze.worker.ts | T1,T2,T5,T6 |
| T8 | UI notice + i18n ×9 | App.tsx, catalogs/*.json (9), catalogs.test.ts | T1,T7 |
| T9 | Fixtures + tests | fixtures/sample-projects/unparsed-corrupt/*, parsers/ingest/analysis tests | T2-T6 |
| T10 | Defense-in-depth `extractSprite` early-return on `frame.w<=0||h<=0` | fix.worker.ts:660 | T3 |

**Commit grouping:** T1 · T3+T4 · T5 · T2 · T6 · T7+T10 · T8 · T9.

## Edge cases
All-corrupt folder → notice ABOVE "No assets". Frame exactly at edge (`x+w===size.w`) allowed (`>` not `>=`). `xy: ,100`→`[NaN,100]`→malformed. Truncated PNG (<24 bytes) already null; now 0×0/absurd also null. `.json` without frames stays silent. Probe write-back spread preserves `unparsed`.
