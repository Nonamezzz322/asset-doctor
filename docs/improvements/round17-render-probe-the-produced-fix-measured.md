All premises verified. The host already consumes `diff.beforeBytes` / `diff.afterBytes` from `done.receipt.sheetDiffs[]` in the FilmViewer (App.tsx L1994/1998), proving the transferred buffers arrive intact and readable on the main thread. The draft is sound. I found three issues to correct: (1) the draft mis-cites several line numbers, (2) a real **buffer-detachment ordering** subtlety the draft glossed, and (3) the `extentOf`/`size` arg is essential, not optional. Here is the revised mini-design.

---

# Mini-Design: Render-probe the produced fix — MEASURED before→after draw calls + decoded VRAM per sheet

**Status:** implementation-ready (verified against code). **Branch:** `feat/asset-pipeline`. **Surface:** `apps/web` only (web fix host + receipt UI) + `packages/i18n` (one key × 9 locales). No backend, no parser, no analysis, no worker GL.

## 0. Verdict on the draft

**Premise TRUE and the design is sound.** Every load-bearing claim checks out against the code:
- Static-only today: `vramBefore = beforeDims.w*beforeDims.h*4`, `vramAfter = afterAtlas.size.w*afterAtlas.size.h*4` (`fix.worker.ts` captureSheetDiff, verified at L658-660), and `vramBytesAfter` is pure arithmetic in the receipt assembly.
- The real probe exists: `probeAtlas(source, frames, size?) → ProbeReading{ drawCalls, vramBytes, … }` (`packages/probe/src/probe.ts` L36-83), already host-run on the **audit** via `attachProbeReadings` (`probe-run.ts`) and on the **fix output** for KTX2 via `attachKtx2Probe` (`ktx2-probe-run.ts`). This feature is a third sibling of the same host seam — correctly identified.
- `Sprite.frame` IS `Rect` "as placed in the atlas image" (`core/src/index.ts` L54 + the fidelity comment L25) — exactly `probeAtlas`'s `frames` argument, same as `report.atlasFrames`.
- The host already reads `diff.beforeBytes`/`diff.afterBytes` off `done.receipt.sheetDiffs[]` for the FilmViewers (`App.tsx` L1994/1998) — **proving the transferred buffers arrive intact and decodable on the main thread**, which is the entire feasibility crux.

Corrections folded in below. Line numbers in the draft were stale-ish but close; I re-anchored the load-bearing ones. **No blockers downgrade the scope** — but three items were under-specified and one was an outright omission (BLOCKER-A).

### BLOCKER-A (omission in the draft): buffer-detachment ordering — DECODE BEFORE DETACH

The draft never states the failure mode it must avoid. `captureSheetDiff` copies `beforeBytes: before.slice(0)` and `afterBytes: afterBytes.slice().buffer`, and these **same ArrayBuffers are in the worker's `transfer` list** (`fix.worker.ts` L2649). After `postMessage`, they are detached **in the worker** but arrive **live on the host** inside `done.receipt.sheetDiffs[]`. So far so good — but on the host, **`createImageBitmap(new Blob([bytes]))` does NOT detach** the ArrayBuffer (Blob copies), so probing does not interfere with the FilmViewer's later reads of the same buffers. ✔ No conflict. **The design is safe precisely because we decode via Blob-copy, never via a transfer.** This must be stated in the file header so a future refactor to a transferable decode path doesn't silently detach the bytes the FilmViewer still needs. (Asserted indirectly: the test's `createImageBitmap` stub must be a copy-semantics mock — the existing `stubBrowser` already is.)

### MAJOR-B (under-specified): `extentOf` is REQUIRED, not nice-to-have

`probeAtlas` defaults its canvas to **256²** when `size` is omitted (`probe.ts` L42-43), and off-canvas sprites are NOT culled in v8 (`cullable=false`) — so omitting `size` would still upload textures (vramBytes correct) but the draw call is the same single batched draw regardless of canvas size, since culling is force-disabled. **Re-checked:** `probeAtlas` force-disables culling (`stage.cullableChildren=false`, `sprite.cullable=false`, L60-66), so drawCalls is correct even at 256². **However** `attachProbeReadings` STILL passes the extent (`sizeOf`, L120-132) and its test asserts it (BLOCKER2, `probe-run.test.ts` L112-119). To stay a faithful sibling and be robust against any future culling-plugin, `extentOf` is **kept** and passed. It is cheap and the test mirrors the existing BLOCKER2 assertion. Keep it.

### MAJOR-C (correctness): pack-page `vramBefore` is non-zero but `beforeFrames` is absent — keep them decoupled

For a `pack` page, `beforeAtlas` is `undefined` ⇒ no `beforeFrames` ⇒ no measured "before" (honest). But note the static `vramBefore` for a pack page is **still computed** from `beforeDims` (the synthetic source dims) and IS shown in the existing strip. The measured line therefore shows **after-only** while the static strip shows a before→after VRAM pair — this asymmetry is correct and honest (the static "before" is a declared dimension, the measured "before" would require a source atlas that does not exist). The UI gate must key off `drawCallsBefore != null` / `decodedVramBefore != null` independently per metric (the draft does this correctly).

## 1. V1 scope (unchanged from draft, confirmed)

1. `SheetDiff` carries `beforeFrames?`/`afterFrames?` (frame rects copied at capture) + four measured fields filled on the host.
2. New `lib/sheet-probe-run.ts` → `attachSheetProbes(receipt, signal?)`: `webglAvailable()` gate, decode each sheet's bytes via `createImageBitmap`, `probeAtlas` before+after, attach measured fields; sequential, abortable, per-sheet-swallow, **same-reference no-op** on no-WebGL / no-sheetDiffs / abort / zero-successes; non-destructive.
3. Chain it after `attachKtx2Probe` in `fix-client.runFix`.
4. Receipt UI: a separate "measured on your GPU this run" line under each FilmViewer pair, kept distinct from the static `→` strip (invariant 5).
5. Cap: reuse existing `SHEET_DIFF_MAX` (=6) — frames ride only on already-capped `sheetDiffs[]`. No new cap.
6. Tests: Vitest harness mirroring `ktx2-probe-run.test.ts`.

### Out of scope (v1) — confirmed
Audit-side probe (shipped); KTX2 probe (parallel sibling); live-runtime correlate (separate, larger); loose-image before/after (no `SheetDiff`); folding measured numbers into `vramBytesAfter`/`vramSaved` (**forbidden**, invariant 5); synthetic "before" for pack pages.

## 2. Additive contract changes — `apps/web/src/worker/fix-protocol.ts`

Add `Rect` to the existing type-only core import (currently L1: `ExportProfile, ImageMime, LazyMarking, OverlayZone, ScaleTier, SkinGuard` → add `Rect`).

Append to `SheetDiff` (verified interface at L237-251; all-optional ⇒ absent ⇒ byte-identical to today):

```ts
export interface SheetDiff {
  // ... existing fields unchanged ...

  /** Packed frame rects of the SOURCE sheet (beforeAtlas.sprites[].frame), copied at capture so the
   *  MAIN thread can replay them through real offscreen WebGL. ABSENT for a `pack` page (loose has no
   *  source atlas ⇒ no honest "before", mirrors occBefore=0). Plain integer rects (structured-clone, NOT
   *  transferable). Absent ⇒ no before-probe ⇒ SheetDiff byte-identical to today. */
  beforeFrames?: Rect[];
  /** Packed frame rects of the EMITTED sheet (afterAtlas.sprites[].frame), copied at capture. Drives the
   *  measured AFTER reading. Always present once frames are wired (afterAtlas always exists at capture). */
  afterFrames?: Rect[];

  // ── Filled AFTER the worker finishes by attachSheetProbes (MAIN thread; the worker has no WebGL). ──
  /** MEASURED issued GL draw calls for the SOURCE sheet's frames on THE USER'S GPU this run. Absent ⇒ no
   *  probe ran (no WebGL / no beforeFrames / per-sheet failure). DEVICE-LOCAL; never cross-device; never
   *  folded into any saving (invariant 5). */
  drawCallsBefore?: number;
  /** MEASURED issued GL draw calls for the EMITTED sheet — the honest "after" beside drawCallsBefore. */
  drawCallsAfter?: number;
  /** MEASURED decoded texture VRAM (ProbeReading.vramBytes = Σ w·h·4 over uploaded textures) of the SOURCE
   *  sheet — the REAL GPU footprint, a DIFFERENT quantity from the static `vramBefore` (declared w·h·4).
   *  NEVER merged with vramBefore/After/vramBytesAfter. */
  decodedVramBefore?: number;
  /** MEASURED decoded texture VRAM of the EMITTED sheet — beside decodedVramBefore, never folded. */
  decodedVramAfter?: number;
}
```

**No new wire message.** Frames ride inside `sheetDiffs[]` on `fix-done`; measured fields fill on the host (mirrors `probedKtx2*`). `FixResponse` union unchanged.

## 3. Worker capture — `apps/web/src/worker/fix.worker.ts` captureSheetDiff (verified L634-663)

In the `sheetDiffs.push({...})` object, add (after `afterZones: proof.zones,`):

```ts
      afterZones: proof.zones,
      // NEW (additive): packed frame rects the MAIN-thread render-probe replays. beforeFrames absent for a
      // pack page (no source atlas ⇒ no honest "before"); afterFrames always present. Plain integer Rect
      // objects ⇒ structured-cloned, NOT added to the transfer list (they are not ArrayBuffers).
      ...(beforeAtlas ? { beforeFrames: beforeAtlas.sprites.map((s) => s.frame) } : {}),
      afterFrames: afterAtlas.sprites.map((s) => s.frame),
```

`Sprite.frame` is `Rect` (core L54). **No transfer-list change** (frames are not ArrayBuffers; transfer list at L2649 stays exactly `[...sheetDiffs.flatMap(d => [d.beforeBytes, d.afterBytes]), ...ktx2Probe...]`). No worker GL — invariants 1/2 hold; the worker only copies integer arrays.

## 4. Host module — new `apps/web/src/lib/sheet-probe-run.ts`

Structural copy of `ktx2-probe-run.ts`, retargeted to `probeAtlas` + `SheetDiff[]`. Reuse `webglAvailable` from `probe-run.ts`. **No transcoder paths** (raster decode only — simpler than the KTX2 sibling).

```ts
import type { FixReceipt, SheetDiff } from '../worker/fix-protocol';
import type { Rect } from '@asset-doctor/core';
import { probeAtlas } from '@asset-doctor/probe';
import { webglAvailable } from './probe-run';

/** Decode raster bytes → ImageBitmap via Blob (Blob COPIES ⇒ the ArrayBuffer is NOT detached, so the
 *  FilmViewer's later reads of the SAME diff.before/afterBytes are unaffected — BLOCKER-A). null on
 *  failure: one bad sheet never aborts the pass. */
async function decode(bytes: ArrayBuffer): Promise<ImageBitmap | null> {
  try { return await createImageBitmap(new Blob([bytes])); } catch { return null; }
}

/** Max frame extent (w = max x+w, h = max y+h) so probeAtlas sizes its canvas to fit every frame
 *  (BLOCKER2 / MAJOR-B — mirrors probe-run.sizeOf). undefined ⇒ probeAtlas falls back to 256². */
function extentOf(frames: Rect[]): { w: number; h: number } | undefined {
  let w = 0, h = 0;
  for (const f of frames) { w = Math.max(w, f.x + f.w); h = Math.max(h, f.y + f.h); }
  return w > 0 && h > 0 ? { w, h } : undefined;
}

/**
 * Replay each capped SheetDiff's before+after frames through real offscreen WebGL and return a NEW
 * receipt whose sheetDiffs carry the MEASURED draw-calls / decoded-VRAM fields. Returns the SAME
 * receipt reference (byte-identical to today) when: no WebGL, OR no sheetDiffs, OR already aborted, OR
 * zero sheets produced ANY measured field. Non-destructive: input receipt + SheetDiffs never mutated.
 */
export async function attachSheetProbes(receipt: FixReceipt, signal?: AbortSignal): Promise<FixReceipt>;
```

**Behavior (mirrors `attachKtx2Probe` exactly):**
- Guard: `if (!receipt.sheetDiffs?.length || !webglAvailable() || signal?.aborted) return receipt;`
- A parallel `measured: Array<Partial<Pick<SheetDiff,'drawCallsBefore'|'drawCallsAfter'|'decodedVramBefore'|'decodedVramAfter'>>> = []` indexed alongside `sheetDiffs`; `let any = false`.
- Sequential `for (const d of receipt.sheetDiffs)` (await-in-loop — each `probeAtlas` destroys its Pixi app, freeing the GL context; parallel would hit the live-context cap; documented in `probe-run.ts` and `ktx2-probe-run.ts`). `if (signal?.aborted) break;`
- Per sheet, build `const m = {}`. If `d.beforeFrames?.length`: `decode(d.beforeBytes)` → in try, `probeAtlas(bmp, d.beforeFrames, extentOf(d.beforeFrames))` → `m.drawCallsBefore = r.drawCalls; m.decodedVramBefore = r.vramBytes; any = true;` `finally bmp.close()`. Same for `d.afterFrames` → `m.drawCallsAfter`/`m.decodedVramAfter`. Each side independent + swallowed (try/catch per `probeAtlas`). Push `m`.
- `if (!any || signal?.aborted) return receipt;`
- `return { ...receipt, sheetDiffs: receipt.sheetDiffs.map((d, i) => ({ ...d, ...measured[i] })) };`

**File-header honesty block** (mirror `ktx2-probe-run.ts` L7-16): device-local; the four measured fields are NEVER folded into `vramBefore/After`, `vramBytesAfter`, or `vramSaved` (invariant 5); decode via Blob-copy ⇒ no detachment of the FilmViewer's bytes (BLOCKER-A); additive same-reference off path; browser-only feature-detected; per-sheet integer readouts (no cross-sheet aggregation ⇒ order-independent ⇒ deterministic).

## 5. Client seam — `apps/web/src/lib/fix-client.ts` runFix (verified L24-44)

Chain after the existing KTX2 probe (the `.catch(() => done.receipt)` already wraps the whole chain — a probe hiccup never breaks the download):

```ts
} else if (m.type === 'fix-done') {
  const done = m;
  // Chain BOTH device-local GPU probes. Each returns the SAME receipt ref when its inputs/WebGL are
  // absent ⇒ byte-identical to today. Sequential: each probe destroys its Pixi app (frees the GL ctx).
  const probe = (done.ktx2Probe?.length
    ? attachKtx2Probe(done.receipt, done.ktx2Probe)
    : Promise.resolve(done.receipt)
  ).then((r) => attachSheetProbes(r));
  probe
    .catch(() => done.receipt)   // a probe hiccup must never break the download
    .then((receipt) => {
      resolve({ receipt, zip: done.zip });
      worker.terminate();
    });
}
```

Add `import { attachSheetProbes } from './sheet-probe-run';`. No signal needed (`runFix` is one-shot per worker — no stale-run overwrite). `planFix` path untouched (it never emits `fix-done`).

## 6. UI — `apps/web/src/App.tsx` SheetDiffView (verified L1969-2011)

Add a **separate** measured line **after** the existing static `OCC … VRAM …` `<p>` (do NOT touch that strip — invariant 5 keeps the receipt VRAM ReceiptRow as the sole saving claim). Gate per-metric independently:

```tsx
{/* MEASURED on the user's GPU this run (render-probe of the produced sheet). DEVICE-LOCAL, kept SEPARATE
    from the static VRAM strip above — a DIFFERENT quantity (real decoded footprint + real draw calls),
    NEVER a saving, NEVER folded into vramBytes* (invariant 5). Rendered only when the probe filled fields. */}
{diff.drawCallsAfter != null || diff.decodedVramAfter != null ? (
  <p className="break-all px-1 font-mono text-[10px] leading-relaxed text-teal/90">
    <span className="uppercase tracking-[0.08em]">{t('fix.sheetDiff.measuredBadge')}</span>{' · '}
    {diff.drawCallsBefore != null && diff.drawCallsAfter != null ? (
      <><span className="text-ink-soft">DRAWS</span> {diff.drawCallsBefore} → {diff.drawCallsAfter}{' · '}</>
    ) : diff.drawCallsAfter != null ? (
      <><span className="text-ink-soft">DRAWS</span> {diff.drawCallsAfter}{' · '}</>
    ) : null}
    {diff.decodedVramBefore != null && diff.decodedVramAfter != null ? (
      <><span className="text-ink-soft">DECODED VRAM</span> {fmtBytes(diff.decodedVramBefore)} → {fmtBytes(diff.decodedVramAfter)}</>
    ) : diff.decodedVramAfter != null ? (
      <><span className="text-ink-soft">DECODED VRAM</span> {fmtBytes(diff.decodedVramAfter)}</>
    ) : null}
  </p>
) : null}
```

Pack page (no `beforeFrames`): after-only — honest, mirrors the `OCC 0% →` already shown. `fmtBytes` is imported (L18).

## 7. i18n — one key × all 9 locales (`packages/i18n/src/catalogs/*.json`)

The drift test (`catalogs.test.ts` L20-30) asserts **every locale has exactly `en`'s keys with matching `{tokens}`**. Add ONE key with **no placeholders** (token-equality trivially satisfied) to **all 9** (en/ru/de/es/pt/fr/it/zh/hi). En is source of truth; precedent device-local wording is `fix.backend.receiptVramMeasured` (en L378) — match its "on your GPU … this device only" tone. Place beside the other `fix.sheetDiff.*` keys (en L290-298):

```json
"fix.sheetDiff.measuredBadge": "measured on your GPU this run"
```

Faithful translations for the other 8. Verification = running `pnpm --filter @asset-doctor/i18n test`.

## 8. Honesty + invariant compliance

- **Invariant 5 (disk≠VRAM):** `decodedVram*` = real decoded footprint (`ProbeReading.vramBytes`), a different quantity from static `vram*` (declared w·h·4), on a separate line, never merged into any saving. Exactly mirrors how the audit keeps `AssetMetrics.probe.vramBytes` separate from `AssetMetrics.vramBytes` (`probe-run.ts` header L12-13).
- **Invariant 1/2 (browser-vs-backend):** measuring on the main thread (worker has no WebGL); zero network (`probeAtlas` needs no transcoder — unlike `probeKtx2` it has no CDN risk). Worker only copies integer arrays. No asset leaves the device.
- **Invariant 3 (objectivity):** numbers measured, not generated; device-local — badge says "this run / your GPU", never cross-device (mirrors `probedKtx2*`).
- **Additivity:** absent frames ⇒ no probe ⇒ same receipt reference ⇒ byte-identical to today. Same-reference no-op on no-WebGL / no-sheetDiffs / abort / zero-successes.
- **Determinism:** per-sheet integer rects; `probeAtlas` one-shot render (`autoStart:false`, no mipmaps); per-sheet readouts (no cross-sheet sum) ⇒ iteration order non-load-bearing.
- **BLOCKER-A:** decode via `new Blob([bytes])` COPIES ⇒ never detaches `diff.before/afterBytes` ⇒ the FilmViewer's later reads of the same buffers are safe.

## 9. Edge cases

1. **Pack page** (`beforeAtlas` absent): `beforeFrames` omitted ⇒ after-only readout. Honest.
2. **No WebGL** (CI/privacy/WebGPU-only): `webglAvailable()` false ⇒ same receipt ref ⇒ download + receipt unchanged.
3. **Decode failure** of a sheet's bytes: `decode` returns null ⇒ that side skipped; the other side still attaches. Per-sheet `probeAtlas` throw swallowed ⇒ field stays absent.
4. **All sheets fail / no fields:** `any` stays false ⇒ same receipt ref (mirrors `ktx2-probe-run.ts` zero-successes return).
5. **Oversized sheet:** `probeAtlas` clamps to `MAX_PROBE_DIM=2048` (`probe.ts` L25,42-43); `extentOf` feeds the bounding box; frames beyond 2048 are clamped — same honest clamp the audit uses (drawCalls correct because culling is force-disabled, vramBytes viewport-independent).
6. **Cap:** only the first `SHEET_DIFF_MAX=6` sheets carry frames ⇒ probe naturally bounded; no new cap; `sheetDiffsTotal` unaffected.
7. **Abort:** `runFix` is single-shot ⇒ v1 passes no signal; helper still accepts one (symmetry + future live-correlate reuse).
8. **Mutation safety:** worker `slice()`s bytes; frames are fresh `.map()` arrays; host builds NEW receipt + NEW SheetDiff objects via spread ⇒ input never mutated (asserted in test).

## 10. Test plan

### 10.1 `apps/web/src/lib/sheet-probe-run.test.ts` (NEW) — mirror `ktx2-probe-run.test.ts`
`vi.mock('@asset-doctor/probe', () => ({ probeAtlas: ... }))`; copy `stubBrowser(hasWebgl)` verbatim (its `createImageBitmap` stub already has copy semantics ⇒ BLOCKER-A coverage). A `sheetDiff(over)` factory + a `reading(over)` factory (`{ drawCalls, vramBytes, liveTextures:1, textureUploads:1, shaderCompiles:0 }`). Cases:
- **No sheetDiffs ⇒ same receipt ref**, `probeAtlas` never called.
- **No WebGL ⇒ same receipt ref** (no document stub), never called. ← the explicitly-required mirror.
- **Already-aborted signal ⇒ same receipt ref**, never called.
- **Both-sides sheet** (`beforeFrames` + `afterFrames`): asserts all four measured fields set from the mocked readings; `out !== receipt`; **static `vramBefore/After` untouched** (never merged); **input not mutated** (`receipt.sheetDiffs[0].drawCallsAfter` undefined).
- **Pack page** (only `afterFrames`): `drawCallsBefore`/`decodedVramBefore` stay absent; after fields set; `probeAtlas` called once for that sheet.
- **Per-sheet swallow:** `probeAtlas.mockRejectedValueOnce(...).mockResolvedValue(reading())` ⇒ first sheet's affected side has no field, others attach.
- **Zero successes ⇒ same receipt ref** (`probeAtlas.mockRejectedValue`).
- **`extentOf` passes the max-frame-extent size** as `probeAtlas`'s third arg (mirror `probe-run.test.ts` L112-119 BLOCKER2 assertion).

### 10.2 i18n drift test — passes once the key is in all 9 locales (no new test; running the suite verifies).

### 10.3 Worker `captureSheetDiff` — the change is a pure field copy. If a `sheet-diff.test.ts` covers `canKeepSheetDiff`/`sheetGeometryProof` (it does — imported from `./sheet-diff`, L118), it tests the PURE helpers, not the push object; the field copy is trivially correct and needs no new worker test. (Optional: extend if a captureSheetDiff-shape test exists — grep showed none.)

### 10.4 `pnpm typecheck && pnpm lint && pnpm test`.

## 11. Ordered task breakdown (small commits)

1. **`feat(fix-protocol): SheetDiff carries before/after frame rects + measured probe fields`** — `fix-protocol.ts`: add `Rect` to the core type-import; add `beforeFrames?`/`afterFrames?`/`drawCallsBefore?`/`drawCallsAfter?`/`decodedVramBefore?`/`decodedVramAfter?` with honesty doc-comments. Typecheck only.
2. **`feat(fix.worker): copy packed frames into each SheetDiff at capture`** — `fix.worker.ts` captureSheetDiff: add `afterFrames` (always) + `beforeFrames` (when `beforeAtlas`). No transfer-list change. Typecheck.
3. **`feat(web): sheet-probe-run — main-thread render-probe of the produced sheets`** — new `lib/sheet-probe-run.ts` (`attachSheetProbes` + `decode` + `extentOf`), mirroring `ktx2-probe-run.ts`, reusing `webglAvailable`. Header honesty + BLOCKER-A note.
4. **`test(web): sheet-probe-run host orchestration (additivity, swallow, abort, extent, no-mutate)`** — new `lib/sheet-probe-run.test.ts` per §10.1. `pnpm --filter web test sheet-probe-run`.
5. **`feat(web): chain the sheet probe after fix-done (beside the KTX2 probe)`** — `fix-client.ts` runFix: import + `.then(attachSheetProbes)`. Verify `planFix` untouched.
6. **`feat(web): measured GPU draw-calls/decoded-VRAM line in the sheet-diff receipt`** — `App.tsx` SheetDiffView: separate measured line (§6), per-metric gated, distinct from the static strip.
7. **`feat(i18n): fix.sheetDiff.measuredBadge across all 9 locales`** — add the key to en + 8 translations. `pnpm --filter @asset-doctor/i18n test`.
8. **`chore: typecheck + lint + full test`** — `pnpm typecheck && pnpm lint && pnpm test`. Fast-forward `main` locally; do not push (no creds).

---

### Key file references (re-anchored against the real code)
- Contract: `apps/web/src/worker/fix-protocol.ts` — `SheetDiff` L237-251, `FixReceipt` L254-…, `Ktx2ProbeInput` + `FixResponse` precedent (the `probedKtx2*` doc-comments are the honesty template to copy).
- Worker capture: `apps/web/src/worker/fix.worker.ts` — `captureSheetDiff` L634-663 (push object L649-662); receipt assembly + transfer list L2649 (NOT touched — frames aren't ArrayBuffers).
- Host pattern to mirror: `apps/web/src/lib/ktx2-probe-run.ts` (full — esp. the `probed===0 ⇒ return receipt` and per-page swallow), `apps/web/src/lib/probe-run.ts` (`webglAvailable` L22-37, `decode` L42-49, `sizeOf` L120-132, await-in-loop rationale L70-72).
- Probe core: `packages/probe/src/probe.ts` — `probeAtlas(source, frames, size?)` L36-83, `MAX_PROBE_DIM=2048` L25, culling force-disabled L60-66; `ProbeReading{drawCalls,vramBytes,…}` `packages/core/src/index.ts` L434-447; `Rect` L17, `Sprite.frame:Rect` L54.
- Client seam: `apps/web/src/lib/fix-client.ts` `runFix` L24-44 (the `fix-done` branch + `.catch(()=>done.receipt)`).
- UI: `apps/web/src/App.tsx` — `SheetDiffView` L1969-2011 (static strip L2004-2010 is the line to add AFTER, never edit), `SheetDiffs` L1942-1958, `fmtBytes` import L18.
- Tests to mirror: `apps/web/src/lib/ktx2-probe-run.test.ts` (full), `apps/web/src/lib/probe-run.test.ts` L112-119 (BLOCKER2 size assertion).
- i18n: `packages/i18n/src/catalogs/en.json` (`fix.sheetDiff.*` L290-298, device-local precedent `fix.backend.receiptVramMeasured` L378); drift test `packages/i18n/test/catalogs.test.ts` L20-30.