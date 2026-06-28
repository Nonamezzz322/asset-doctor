# Round-6 F1 — Before/after FilmViewer diff of repacked/merged/packed sheets (+ occupancy overlay)

**Area:** FIX TRUST/UX. **Effort:** medium. **needsKey:** no. Skeptic-verified against `feat/asset-pipeline`.

## Verdict: PREMISE TRUE. Ship — with corrections (none a blocker).

The Pro fix value prop is currently taken on faith — `fix.worker.ts` posts only `{receipt,zip}` (numbers), yet `FilmViewer` already takes `bytes:ArrayBuffer` and the before/after page bytes are already in scope at compose time. This attaches a per-sheet before/after X-ray to the receipt.

### MAJOR corrections folded in
- **M1 — no `packages/analysis` change.** Grid primitives are ALREADY exported: `analysis/index.ts:13` (`occupancyValue`), `:29` (`defaultCell, buildCoverage, mergeEmptyRects, summarizeEmpty`). SD1 is verify-only; do NOT edit `index.ts`.
- **M2 — `afterZones: OverlayZone[]`** (core type at `core/src/index.ts:176`, `Rect={x,y,w,h}`), feeds `Finding.overlay` (FilmViewer.tsx:58-79) with **no cast**. Do not invent a bespoke shape.
- **M3 — per-sheet VRAM/OCC/dims strip uses `→`, NEVER a `pct()`/"saved %".** The receipt's existing `vramBytesAfter` ReceiptRow is the SOLE saving claim (Invariant 5). The per-sheet pair is two MEASURED states.

### MINOR (confirmed)
- m4 — **copy both buffers** (`before.slice(0)`, `enc.bytes.slice().buffer`): both source (`bytesByRef`/pass-through) and emitted (`out`→zip) buffers stay live; do not "optimize away" the copy. `Uint8Array.slice().buffer` is a fresh exact-length buffer, safe to transfer.
- m5 — `occBefore=0` for `pack` (loose has no source atlas; honest "0% packed"); for `merge` use `group[0]` as representative, label "1 of N".
- m6 — headless test drives the PURE pipeline (`parseAtlas→repackAtlases`) + pure helpers only (no OffscreenCanvas in Node); actual pixel capture is a DEFERRED Playwright follow-up.
- m7 — `App.tsx` must add `type Finding, AssetMetrics, OverlayZone` from `@asset-doctor/core` + `type SheetDiff` from fix-protocol.

### Non-issues (rebutted): FilmViewer needs zero edits (all `metrics` reads optional-guarded); transfer doesn't break the zip given copies; AVIF/WebP after-bytes decode via `createImageBitmap`.

## Files
`apps/web/src/worker/fix.worker.ts`, `apps/web/src/worker/fix-protocol.ts`, `apps/web/src/App.tsx`, `packages/i18n/src/catalogs/*.json` (×9), `apps/web/test/sheet-diff-worker.test.ts`. **No `packages/analysis` change.**

## Scope (v1)
Capture per `repack`/`merge`/`pack`-page/Spine-repack op that successfully composes a `SheetDiff` (before+after encoded bytes, dims, occupancy, base VRAM). Render a collapsed `<details>` receipt section: two side-by-side FilmViewers (before = source bytes no findings; after = emitted bytes + one synthetic `wasted-regions` finding so empty space glows) + a compact `OCC / dims / VRAM` `→` strip (measurements, no pct). Cap: first **N=6** composed sheets; **skip any pair where before OR after > 8 MB**; surface "showing N of M" via `sheetDiffsTotal`. Out of scope: resize/transcode/tier/dedup-only ops. Empty `sheetDiffs` ⇒ receipt byte-identical (spread-omit).

## Contract — `fix-protocol.ts`
```ts
import type { OverlayZone } from '@asset-doctor/core';
export interface SheetDiff {
  name: string;
  beforeBytes: ArrayBuffer; afterBytes: ArrayBuffer;
  beforeWxH: { w: number; h: number }; afterWxH: { w: number; h: number };
  occBefore: number; occAfter: number;     // 0..1 (occBefore=0 for pack)
  vramBefore: number; vramAfter: number;   // bytes w·h·4
  afterZones: OverlayZone[];               // [] or one { kind:'empty', rects }
}
```
Add to `FixReceipt` (additive optional, spread-omitted when empty): `sheetDiffs?: SheetDiff[]; sheetDiffsTotal?: number;`. `FixResponse` shape unchanged; `fix-client.ts:31` needs no change.

## Pure helper — in `fix.worker.ts`
```ts
import { occupancyValue, buildCoverage, defaultCell, mergeEmptyRects } from '@asset-doctor/analysis';
import type { OverlayZone } from '@asset-doctor/core';
function sheetGeometryProof(atlas: Atlas): { occ: number; zones: OverlayZone[] } {
  const occ = occupancyValue(atlas);
  const rects = mergeEmptyRects(buildCoverage(atlas, defaultCell(atlas.size)), atlas.size);
  return { occ, zones: rects.length > 0 ? [{ kind: 'empty', rects }] : [] };
}
```

## Accumulator + capped capture
```ts
const SHEET_DIFF_MAX = 6; const SHEET_DIFF_MAX_BYTES = 8 * 1024 * 1024;
const sheetDiffs: SheetDiff[] = []; let sheetDiffsTotal = 0;
function captureSheetDiff(beforeRef, beforeDims, afterAtlas, afterBytes, afterName, beforeAtlas?) {
  sheetDiffsTotal++;
  if (sheetDiffs.length >= SHEET_DIFF_MAX) return;
  const before = bytesByRef.get(beforeRef); if (!before) return;
  if (before.byteLength > SHEET_DIFF_MAX_BYTES || afterBytes.byteLength > SHEET_DIFF_MAX_BYTES) return;
  const proof = sheetGeometryProof(afterAtlas);
  sheetDiffs.push({ name: afterName, beforeBytes: before.slice(0), afterBytes: afterBytes.slice().buffer,
    beforeWxH:{w:beforeDims.w,h:beforeDims.h}, afterWxH:{w:afterAtlas.size.w,h:afterAtlas.size.h},
    occBefore: beforeAtlas ? occupancyValue(beforeAtlas) : 0, occAfter: proof.occ,
    vramBefore: beforeDims.w*beforeDims.h*4, vramAfter: afterAtlas.size.w*afterAtlas.size.h*4,
    afterZones: proof.zones });
}
```

## Call sites (4, anchored to live code; verify exact lines at impl time)
1. Spine single-page repack — after `out.push({path:imagePath,bytes:enc.bytes})`: `captureSheetDiff(ref, atlas.size, na, enc.bytes, basename(pathByRef.get(ref)!), atlas)`.
2. Atlas single repack — after `out.push(... bytes:sheet!.bytes)` in `!merge` branch: `captureSheetDiff(refs[0]!, group[0]!.size, na, sheet!.bytes, basename(na.imageRef), group[0])`.
3. Atlas merge (per emitted page) — after merge `out.push`: same call as #2, label "1 of N".
4. Pack (per emitted STATIC page only, `!isSpine`) — after `emitted.push(...)`: `captureSheetDiff(regions[0]!.ref, sizeByRef.get(regions[0]!.ref) ?? na.size, na, enc.bytes, basename(na.imageRef))` (no beforeAtlas ⇒ occBefore=0).

## Receipt assembly + transferable post
```ts
...(sheetDiffs.length > 0 ? { sheetDiffs, sheetDiffsTotal } : {}),  // inside receipt literal
const transfer = sheetDiffs.flatMap((d) => [d.beforeBytes, d.afterBytes]);
ctx.postMessage({ type: 'fix-done', receipt, zip }, transfer);  // direct postMessage (post() can't carry transferables)
```

## UI — App.tsx
`SheetDiffView`: two FilmViewers (before `findings={[]}`; after one synthetic finding with `overlay = diff.afterZones`, no cast), each `metrics={{occupancy, vramBytes} as AssetMetrics}`; a 3-col `OCC X%→Y% · WxH→WxH · VRAM fmtBytes→fmtBytes` strip with **no pct()**. Collapsed `<details>` after the VRAM ReceiptRow, title `t('fix.sheetDiff.title',{n})`, "showing N of M" when `sheetDiffsTotal>sheetDiffs.length`. Gated on `(receipt.sheetDiffs?.length ?? 0) > 0`.

## i18n — 9 catalogs (en source; tokens enforced)
```json
"fix.sheetDiff.title":     { "$count":"n", "one":"{n} sheet — visual proof", "other":"{n} sheets — visual proof" },
"fix.sheetDiff.showing":   "showing {shown} of {total}",
"fix.sheetDiff.proofNote": "Before/after X-ray of each repacked sheet. The after-film glows red where space is still empty. OCC/VRAM/dims are two measured states, not a saving.",
"fix.sheetDiff.before":    "before",
"fix.sheetDiff.after":     "after"
```

## ORDERED TASKS
- **SD1** verify analysis-root imports resolve (zero diff to analysis).
- **SD2** `SheetDiff` type + `FixReceipt.sheetDiffs?/sheetDiffsTotal?` (fix-protocol.ts).
- **SD3** worker `sheetGeometryProof` + accumulator + caps + analysis imports.
- **SD4** worker `captureSheetDiff` (copy both buffers; occBefore conditional; always ++total).
- **SD5** wire 4 call sites; resize/transcode/tier/dedup NEVER capture; no double-capture.
- **SD6** receipt spread-omit + direct `ctx.postMessage` with transfer of COPIES.
- **SD7** i18n 5 keys ×9 catalogs.
- **SD8** UI `SheetDiffView` + `<details>` + "showing N of M" + core type imports; no FilmViewer prop changes; no pct on per-sheet strip.
- **SD9** headless test: `sheetGeometryProof` == analysis primitives; cap arithmetic (extract pure-testable); loose-only ⇒ no diffs; deterministic. Playwright pixel-capture deferred.
- **SD10** gates: `pnpm typecheck && pnpm lint && pnpm test` incl i18n parity; empty-diff runs unchanged.
