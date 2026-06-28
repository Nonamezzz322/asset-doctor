I now have the complete, code-grounded picture. Every anchor in the draft is verified, but I found three things the draft materially underplays. The most important: the KTX2 transcoder defaults to a **jsdelivr CDN fetch** — a real network call — but Pixi ships `libktx.js`/`libktx.wasm` locally and exposes `setKTXTranscoderPath`, so this is fixable and must be made an explicit task (not a footnote). The seam is also cleaner than the draft's "wire into App.tsx after fix-done" — it should land in `fix-client.ts:runFix` where `FixOutcome` is assembled, before the worker terminates. Here is the final revised design.

---

# Design (REVISED): Measure real KTX2 GPU VRAM (compressed-texture residency on this device) — probe + fix-receipt

## 0. Premise verdict — TRUE, with one material correction

The premise holds and is well-grounded. Verified against the real code:

- **The asymmetry is real.** `gl-instrument.ts` patches `texImage2D` (L108) and `texSubImage2D` (L81) but **never** `compressedTexImage2D` — `vram()` (L140) only sums `w·h·4·(mip?MIP_OVERHEAD:1)`. So raster VRAM is *measured* while the KTX2 win is only the *estimate* `ktx2VramBytesWorstCase` (`vram-ceiling.ts` → `COMPRESSED_BYTES_PER_PX_CEILING` × px). Confirmed.
- **The bytes exist where the draft says.** In the KTX2 loop (`fix.worker.ts:2356-2412`) `c.pageBytes`/`c.pageMime`/`c.w`/`c.h` are the live raster source (the baseline) and `res.bytes` is the produced `.ktx2`. `ktx2VramBytesWorstCase` is set at L2411; `fix-done` + `transfer` at L2594-2595. Confirmed.
- **The probe pattern is reusable.** `probeAtlas` (L33) + `MAX_PROBE_DIM` (L22) and `attachProbeReadings`/`webglAvailable` (`probe-run.ts`) are exactly the offscreen+abort+sequential pattern to mirror. Confirmed.
- **The Pixi subpath is real.** `pixi.js/package.json` exports `"./ktx2"` → `lib/compressed-textures/ktx2/init.mjs` (registers `loadKTX2`); `loadKTX2.mjs` calls `getSupportedTextureFormats()` and `loadKTX2onWorker`. Confirmed.

**The one material correction (CORRECTION-1, blocker-level for honesty):** the draft says "Pixi's KTX2 loader pulls its transcoder per its own config (documented browser run; if unavailable the probe returns fallback, never throws)." That is misleadingly soft. The real default (`setKTXTranscoderPath.mjs`) is:
```
jsUrl:  "https://cdn.jsdelivr.net/npm/pixi.js/transcoders/ktx/libktx.js"
wasmUrl:"https://cdn.jsdelivr.net/npm/pixi.js/transcoders/ktx/libktx.wasm"
```
**The default code path makes a third-party CDN network request.** This is NOT invariant-1-fatal (invariant 1 = *assets never leave the device* during the *free diagnosis*; this is the Pro fix-receipt path, and the assets already left via the opt-in backend that produced the `.ktx2`). But shipping a silent jsdelivr fetch is a privacy/honesty regression and an offline-breakage. **It must be neutralized, not hand-waved:** Pixi ships `transcoders/ktx/libktx.{js,wasm}` *inside the package* (verified present, 216 KB + 714 KB), so we self-host/bundle them and call `setKTXTranscoderPath({ jsUrl, wasmUrl })` to local URLs **before** the first probe. This becomes an explicit task (T4a), not a footnote.

**Two smaller corrections:**
- **CORRECTION-2 (seam, downgrades blast radius):** the draft proposes a new `apps/web/src/lib/ktx2-probe-run.ts` wired into `App.tsx` "after fix-done." But `fix-done` is consumed in `fix-client.ts:runFix` (L30-33), which assembles `FixOutcome {receipt, zip}` and **terminates the worker**. App.tsx only ever sees `phase.out.receipt`. The clean seam is to do the probe inside `runFix`, between receiving `fix-done` and `resolve(...)`, replacing the receipt with the augmented one. This keeps `App.tsx` untouched except the new UI line (T8) and means there is no separate orchestration entry point to wire — `attachKtx2Probe` is *called by* `runFix`. (App.tsx wiring in the draft was redundant; removed.)
- **CORRECTION-3 (determinism honesty):** the transcoder runs on a Pixi-internal worker and `getSupportedTextureFormats` memoizes a module-global. The "deterministic code path" claim stays true, but `compressedBytes` is **doubly device-dependent** (GPU-chosen format *and* whether the transcoder loaded at all) — the design already labels it device-local; just make the doc note say "device + transcoder-availability dependent," same status tier as render-probe.

Everything else in the draft survives. Scope, additivity, and the instrument extension are correct. **Recommendation: BUILD**, with T4a inserted and the seam moved into `fix-client.ts`.

## 1. Goal (unchanged)

Close the measured-vs-estimated asymmetry. Add `compressedTexImage2D`/`compressedTexSubImage2D` to the instrument (headless-unit-testable now), add `probeKtx2()` that transcodes the produced `.ktx2` via Pixi's KTX2 loader (with a **self-hosted** transcoder) and reads resident compressed bytes (incl. baked mips, each level its own `compressedTexImage2D` call ⇒ summed `byteLength` = exact residency), and surface a new **measured** `probedKtx2VramBytes` on `FixReceipt` *beside* the existing ceiling — never folded into `vramBytesAfter`.

## 2. V1 scope

**In:**
1. Instrument: `compressedTexImage2D` + `compressedTexSubImage2D` wrappers accumulating real `byteLength` per texture; new `GlStats.compressedBytes`; a compressed texture contributes its measured compressed total (not `w·h·4`) to `vramBytes`. Headless-tested against the existing mock-GL harness.
2. Pure `compressedDataByteLength(name, args)` extractor (mirrors `recordTexImage`) — unit-testable independent of GL.
3. `probeKtx2(ktx2Bytes, rasterSource)` in `probe.ts`: lazy `import 'pixi.js/ktx2'`, **self-hosted transcoder via `setKTXTranscoderPath`**, offscreen render (mirrors `probeAtlas`), measures compressed residency + a raster RGBA8888 baseline from the same page; honest `fallback` flag.
4. New `ProbeKtx2Reading` in `@asset-doctor/core` (zero-dep, additive).
5. New measured `probedKtx2VramBytes?` / `probedKtx2RasterBaselineBytes?` / `probedKtx2Fallback?` on `FixReceipt`.
6. **Seam in `fix-client.ts:runFix`** (CORRECTION-2): after `fix-done`, before `resolve`, probe the produced `.ktx2` pages (transferred from the worker) and replace `receipt` with the augmented one.
7. UI line in `App.tsx` beside the ceiling: "measured X on your GPU (BCn/ASTC), ceiling ≤ Y — this device only" + a fallback note.
8. i18n keys `fix.backend.receiptVramMeasured` + `fix.backend.receiptVramFallback` across 9 catalogs (en source; drift-test).
9. **Self-host the Pixi KTX2 transcoder assets** (`libktx.js`/`libktx.wasm`) into the web app's served assets (T4a) so the probe never hits jsdelivr.

**Out (explicit):**
- No change to `vramBytesAfter` (invariant 5) and no cross-device claim.
- No removal of `ktx2VramBytesWorstCase` — the ceiling stays as the cross-device upper bound; measurement is additive beside it.
- No Go / `apps/encoder` / `apps/api` change. The 30 Go tests stay green by construction.
- No CLI port (no WebGL in Node; same status as `probeAtlas`).
- No WebGPU path; probe forces `preference:'webgl'` exactly as `probeAtlas`, falls back honestly on a WebGPU-only context.
- No new `ktx2-probe-run.ts` *entry wiring in App.tsx* (CORRECTION-2 folds the call into `runFix`). The aggregation helper still exists as a pure, testable function.

## 3. Additive contract / type changes

### 3a. `packages/core/src/index.ts` — `ProbeKtx2Reading` (zero-dep, additive)
```ts
/** MEASURED resident GPU bytes of a transcoded .ktx2 page on THE PROBING DEVICE ONLY — read from a real
 *  offscreen-WebGL render via compressedTexImage2D byteLengths (incl. baked mips, each level its own call).
 *  NOT a cross-device claim, NOT a ceiling. `rasterBaselineBytes` = the same page measured RGBA8888 (w·h·4,
 *  the "before"). `fallback:true` ⇒ this GPU has NO block-compression support (or the transcoder failed to
 *  load) and the loader produced a raster texture ⇒ compressedBytes === rasterBaselineBytes and it is NOT a
 *  win on this device (reported honestly). Additive: a caller that never runs the probe simply omits it. */
export interface ProbeKtx2Reading {
  compressedBytes: number;      // Σ compressedTexImage2D byteLengths over the transcoded texture (all mips)
  rasterBaselineBytes: number;  // the same page as RGBA8888 (w·h·4) — the honest "before"
  fallback: boolean;            // GPU/transcoder gave raster ⇒ no win here
}
```

### 3b. `packages/probe/src/gl-instrument.ts` — `GlStats.compressedBytes`
```ts
export interface GlStats {
  // …existing…
  /** Σ compressedTexImage2D/compressedTexSubImage2D data byteLengths over live textures (real resident
   *  compressed footprint incl. mip levels). 0 unless a compressed upload was observed. Device-measured. */
  compressedBytes: number;
}
```
`vramBytes` for raster textures is unchanged; a texture that received a compressed upload contributes its measured `compressedBytes` (not `w·h·4`, and **no synthetic `MIP_OVERHEAD`** — mips are real separate calls already summed). `compressedBytes` is also exposed standalone for the probe.

### 3c. `apps/web/src/worker/fix-protocol.ts` — three measured fields on `FixReceipt` + `fix-done` side-channel
```ts
  /** MEASURED resident GPU VRAM (bytes) of the produced .ktx2 pages on THE USER'S GPU this run — Σ
   *  ProbeKtx2Reading.compressedBytes. The headline turned into a FACT, shown beside ktx2VramBytesWorstCase
   *  ("measured X on your GPU (BCn/ASTC), ceiling ≤ Y"). DEVICE-LOCAL ONLY, NEVER folded into vramBytesAfter
   *  (inv. 5). Filled in fix-client.runFix AFTER fix-done (the worker has no WebGL); absent ⇒ no probe ran
   *  (no WebGL / no ktx2 produced / transcoder unavailable) ⇒ receipt byte-identical to today. */
  probedKtx2VramBytes?: number;
  /** Raster (RGBA8888 w·h·4) baseline from the SAME probe pass — the honest "before". Absent with the above. */
  probedKtx2RasterBaselineBytes?: number;
  /** True ⇒ ≥1 probed page fell back to raster (no block-compression support / transcoder failed) — disclosed
   *  so the measured number is never mis-sold as a win on a non-supporting device. */
  probedKtx2Fallback?: boolean;
```
And on `FixResponse.'fix-done'`:
```ts
  | { type: 'fix-done'; receipt: FixReceipt; zip: Blob; ktx2Probe?: Ktx2ProbeInput[] };
```
```ts
export interface Ktx2ProbeInput { ktx2Bytes: ArrayBuffer; rasterBytes: ArrayBuffer; rasterMime: string; }
```
**Additivity guarantee:** every field optional; the worker still produces a byte-identical zip; `ktx2Probe` populated only when `ktx2Produced > 0`. No-backend / no-ktx2 / no-WebGL ⇒ receipt and zip byte-identical to today.

## 4. Pure modules + signatures

### 4a. `gl-instrument.ts` — pure accounting (headless-testable core)
Pure extractor (mirrors `recordTexImage` at L119):
```ts
/** Real resident byte length of a compressed upload's data argument.
 *  compressedTexImage2D(target, level, internalformat, w, h, border, data)            ⇒ view at index 6
 *  compressedTexImage2D(target, level, internalformat, w, h, border, imageSize, off)  ⇒ number at index 6 (PBO)
 *  compressedTexSubImage2D(target, level, x, y, w, h, format, data)                   ⇒ view at index 7
 *  Returns ArrayBufferView.byteLength (or the explicit imageSize number for the PBO form), else 0. */
function compressedDataByteLength(name: string, a: unknown[]): number
```
`TexRecord` gains `compressed: number` (default 0). New patches, symmetric to L108/L81:
```ts
patch('compressedTexImage2D', (orig) => (...a) => {
  counters.textureUploads++;
  recordCompressed('compressedTexImage2D', a);   // level-0 sets w/h like recordTexImage; add byteLength
  return orig(...a);
});
patch('compressedTexSubImage2D', (orig) => (...a) => {
  counters.textureUploads++;
  recordCompressed('compressedTexSubImage2D', a); // add byteLength; do NOT reset w/h
  return orig(...a);
});
```
`recordCompressed` adds `compressedDataByteLength(name, a)` to the bound texture's `compressed` and (for `compressedTexImage2D` level 0) records `w/h`. `vram()` change: per texture, `if (t.compressed > 0) total += t.compressed; else if (t.w>0&&t.h>0) total += t.w*t.h*4*(t.mip?MIP_OVERHEAD:1);`. `stats().compressedBytes = Σ t.compressed`. `reset()` does **not** clear `compressed` (residency state, like `textures`/`boundByTarget`). `restore()` already unpatches everything in `originals`.

### 4b. `probe.ts` — `probeKtx2`
```ts
export async function probeKtx2(
  ktx2Bytes: ArrayBuffer,
  rasterSource: ImageBitmap | HTMLImageElement | HTMLCanvasElement, // for the w·h·4 baseline
): Promise<ProbeKtx2Reading>
```
Implementation (mirrors `probeAtlas`):
1. **One-time setup (memoized):** `const { setKTXTranscoderPath } = await import('pixi.js'); setKTXTranscoderPath({ jsUrl: LOCAL_KTX_JS, wasmUrl: LOCAL_KTX_WASM });` then `await import('pixi.js/ktx2')` (registers `loadKTX2`). `LOCAL_KTX_*` resolve to the self-hosted assets (T4a) — **never jsdelivr** (CORRECTION-1).
2. `new Application(); await app.init({ width, height, preference:'webgl', backgroundAlpha:0, autoStart:false })`; get `gl`; absent ⇒ throw (caller swallows).
3. `const probe = instrument(gl)`.
4. **Raster baseline:** `Texture.from(rasterSource)`, render one sprite, read `probe.stats().vramBytes` as `rasterBaselineBytes` (the true w·h·4). Then `probe.reset()` + free the raster texture.
5. **Compressed measure:** `const url = URL.createObjectURL(new Blob([ktx2Bytes], {type:'image/ktx2'}))` → `await Assets.load({ src:url, loadParser:'loadKTX2' })` → draw one sprite → render → read `stats().compressedBytes`. `URL.revokeObjectURL` + `Assets.unload` in `finally`.
6. **Fallback detection:** if `getSupportedTextureFormats()` reports no compressed format, OR the compressed load rejected (transcoder failed), OR `compressedBytes === 0` after a successful render ⇒ `fallback:true`, `compressedBytes = rasterBaselineBytes` (honest: no win on this device).
7. `probe.restore(); app.destroy()`. Return `{ compressedBytes, rasterBaselineBytes, fallback }`.

Canvas sized via `MAX_PROBE_DIM` clamp (upload accounting is viewport-independent — same note as `probeAtlas`). One-shot render, no `Date.now`/`Math.random`. Doc note (T4): "device + transcoder-availability dependent; same status tier as render-probe" (CORRECTION-3).

### 4c. `packages/probe/src/index.ts`
```ts
export { probeAtlas, probeKtx2 } from './probe';
export type { ProbeReading, ProbeKtx2Reading } from './probe'; // both re-exported from core
```

### 4d. `apps/web/src/lib/ktx2-probe-run.ts` (NEW — pure aggregation, called by `runFix`)
The worker holds the `.ktx2` bytes but has no WebGL, so it **transfers** `Ktx2ProbeInput[]` on `fix-done`. (Option A — re-reading the zip — is rejected: we ship only a store-only zip *writer*, no reader.)
```ts
export async function attachKtx2Probe(
  receipt: FixReceipt,
  inputs: Ktx2ProbeInput[],
  signal?: AbortSignal,
): Promise<FixReceipt>
```
Reuses `webglAvailable` (from `probe-run.ts`); on `false` / empty inputs / abort returns the **same receipt reference**. Otherwise decodes each `rasterBytes`→`ImageBitmap`, calls `probeKtx2`, sums `compressedBytes`/`rasterBaselineBytes`, ORs `fallback`, returns a **new** receipt with the three fields attached. Sequential await-in-loop (same GL-context-cap reasoning as `attachProbeReadings`). Per-page failure swallowed (probe never load-bearing).

**Seam (CORRECTION-2)** — in `fix-client.ts:runFix`, the `fix-done` branch becomes:
```ts
} else if (m.type === 'fix-done') {
  const receipt = m.ktx2Probe?.length ? await attachKtx2Probe(m.receipt, m.ktx2Probe) : m.receipt;
  resolve({ receipt, zip: m.zip });
  worker.terminate();
}
```
No change to `App.tsx`'s phase handling; the probe is awaited inside the existing `runFix` promise (already async, already off the ≤10s diagnosis path — this is the Pro fix path). `App.tsx` changes are UI-only (T8).

### 4e. `fix.worker.ts` — collect `Ktx2ProbeInput[]` on the KTX2 pass
In the loop (after L2393 `out.push({ path: ktx2Path, bytes: res.bytes })`), when `ktx2Produced` increments, push `{ ktx2Bytes: sliceOf(res.bytes), rasterBytes: sliceOf(c.pageBytes), rasterMime: c.pageMime }` to a `ktx2Probe` array — **fresh slices** so the zip/`out` buffers stay intact (same discipline as `captureSheetDiff`). Cap to the first `KTX2_PROBE_MAX` (mirror `SHEET_DIFF_MAX = 6`) to bound transfer; the rest contribute `ktx2VramBytesWorstCase` only ("measured N of M"). Extend the transfer list (L2594): `const transfer = [...sheetDiffs.flatMap(...), ...ktx2Probe.flatMap(p => [p.ktx2Bytes, p.rasterBytes])]`. Populate the `fix-done` message's `ktx2Probe` only when non-empty.

### 4f. UI — `App.tsx` (~L1782, in the `bn.op === 'ktx2'` block)
Beside the existing `receiptVram` line, when `receipt.probedKtx2VramBytes != null`, render `t('fix.backend.receiptVramMeasured', { measured, ceiling, baseline })` e.g. *"Measured 1.9 MB on your GPU (BC7/ASTC) — down from 16 MB raster; ceiling ≤ 2.1 MB. This device only."* When `probedKtx2Fallback`, render `t('fix.backend.receiptVramFallback')`: *"Your GPU has no block-compression support — KTX2 fell back to raster here (no VRAM win on this device)."* The existing ceiling line (L1783) stays.

## 5. Honesty & invariant compliance

- **disk ≠ VRAM (inv. 5):** measured GPU residency shown only beside the ceiling + raster baseline as two measured states (before→after), never as a delta folded into `vramBytesAfter` (untouched). Compressed total **includes measured mips** (no synthetic ×4/3 on compressed textures).
- **Cross-device honesty (inv. 3):** labelled "on your GPU / this device only." `ktx2VramBytesWorstCase` remains the cross-device upper bound. `fallback:true` disclosed.
- **Zero-network for the free path (inv. 1):** the free diagnosis path is entirely untouched. This is the Pro fix-receipt path; the `.ktx2` already left via the opt-in backend. **CORRECTION-1:** the transcoder is self-hosted via `setKTXTranscoderPath` (T4a) ⇒ **no jsdelivr fetch** ⇒ no silent third-party network call, works offline. (Without T4a this design would ship a silent CDN request — explicitly rejected.)
- **Browser-vs-backend (inv. 1–2):** zero backend change. Pure browser WebGL, same status as `render-probe`.
- **Additivity (off ⇒ byte-identical):** all receipt fields optional + set only on a real measurement; `fix-done.ktx2Probe` only when `ktx2Produced > 0`; worker zip bytes unchanged; `GlStats.compressedBytes` is `0` and `vramBytes` identical when no compressed upload is seen (so `probeAtlas` is unchanged for raster atlases).
- **Objectivity (inv. 3):** we measure; generate nothing (the `.ktx2` already exists).

## 6. Determinism
- `gl-instrument` accounting is pure integer sums; `compressedDataByteLength` is a pure arg reader, deterministic, headless-verifiable.
- `probeKtx2` does one-shot render, no time/random; the transcoded byte count is a deterministic function of (ktx2 bytes, GPU format, transcoder availability) — **device + transcoder-availability dependent** (CORRECTION-3), reproducible on a device, exactly the render-probe caveat tier. Documented, not a bug.
- Main-thread aggregation: commutative integer sums; iteration order not load-bearing.

## 7. Edge cases
1. **No block-compression support OR transcoder failed to load** → loader gives raster ⇒ `fallback:true`, `compressedBytes = rasterBaselineBytes`; UI shows the fallback note. (Covers both the missing-GPU-support case and the offline/self-host-misconfigured case honestly.)
2. **WebGPU-only / no WebGL** → `app.init({preference:'webgl'})` yields no `gl` ⇒ throw ⇒ swallowed ⇒ no fields attached (byte-identical).
3. **KTX2 transcoder asset 404 (self-host path wrong)** → load rejects ⇒ per-page swallowed ⇒ `fallback` or absent; never throws to the user.
4. **PBO 8-arg form** of `compressedTexImage2D` → use the explicit `imageSize` number (Pixi's GL path doesn't use it, but the instrument stays correct for the runtime profiler against real games).
5. **`compressedTexSubImage2D`** → adds byteLength, no w/h reset. Pixi uploads full levels via `compressedTexImage2D` (confirmed: `glUploadCompressedTextureResource` per-level); the sub variant is covered for runtime-profiler completeness + symmetry with the existing `texSubImage2D` patch.
6. **Multiple `.ktx2` pages** → summed; `fallback` OR'd across pages; capped to `KTX2_PROBE_MAX` ("measured N of M").
7. **Probe canvas size** → `MAX_PROBE_DIM` clamp; upload accounting viewport-independent.
8. **Big page transfer** → `ktx2Probe` buffers transferred zero-copy (fresh slices); capped (mirror `SHEET_DIFF_MAX`).
9. **Stale probe** → `attachKtx2Probe` takes an optional `AbortSignal`; a new fix run can abort the stale probe (same pattern as `attachProbeReadings`). (In `runFix` the worker is terminated on the next run anyway; signal is for symmetry/future use.)

## 8. Test plan (real harness — no browser e2e exists)

**`packages/probe/test/instrument.test.ts` (extend mock-GL harness):**
- Add `compressedTexImage2D`/`compressedTexSubImage2D` to `fakeGl()`.
- `it`: bind a tex, `compressedTexImage2D(TEXTURE_2D, 0, fmt, 256, 256, 0, new Uint8Array(65536))` + 3 shrinking mip levels ⇒ assert `stats().compressedBytes === 65536 + Σ mip byteLengths` and `vramBytes === compressedBytes` (NOT `256·256·4`). A sibling raster tex in the same context still contributes `w·h·4` (mixed-context correctness).
- `it`: `reset()` keeps `compressedBytes`; `restore()` unpatches the compressed methods.
- `it`: PBO 8-arg form uses the explicit `imageSize`; sub-image adds without resetting dims.
- `it`: drive `compressedDataByteLength` arg shapes directly (the pure extractor).

**`probe.ts` `probeKtx2`:** no headless GL ⇒ the live transcode read is a documented browser/GPU run (gated by `webglAvailable`, same status as `probeAtlas`). Unit-test the pure seams it composes (the extractor + instrument accounting above). Add a one-line note in `docs/render-probe-decision.md` recording the KTX2-probe browser-run status + the self-hosted-transcoder requirement (parallel to the render-probe entry).

**`apps/web` seam:** assert additivity is dead when off — a fix run with `backend` absent (or `ktx2Produced === 0`) yields `fix-done` with `ktx2Probe` undefined and the three receipt fields absent (worker is Node-testable via the existing fix.worker harness; `Ktx2ProbeInput` collection is pure array building). `attachKtx2Probe` returns the same receipt reference when `webglAvailable()` is false / inputs empty (unit-testable by stubbing `webglAvailable`). `runFix` resolves with the unmodified receipt when `ktx2Probe` is absent.

**Go:** no change; state in the PR that `apps/encoder`/`apps/api` are untouched (30 Go tests green by construction).

**i18n:** add `fix.backend.receiptVramMeasured` + `fix.backend.receiptVramFallback` to `en.json` (source, beside the existing L369-373 `fix.backend.receipt*` keys) + the other 8 catalogs; the drift-test enforces baked parity.

## 9. Ordered task breakdown (small commits)

| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|-----------|
| **T1** | core: `ProbeKtx2Reading` | `packages/core/src/index.ts` | core | — | type exported; `--filter @asset-doctor/core typecheck` green; no runtime change |
| **T2** | instrument: `compressedBytes` + compressed-upload wrappers + pure `compressedDataByteLength` | `packages/probe/src/gl-instrument.ts` | probe | — | `GlStats.compressedBytes` present; compressed tex charges measured bytes incl. mips; raster unchanged |
| **T3** | instrument tests: compressed upload, mixed context, reset/restore, PBO/sub forms, extractor | `packages/probe/test/instrument.test.ts` | test | T2 | `--filter @asset-doctor/probe test` green; raster tests unchanged |
| **T4a** | **self-host the Pixi KTX2 transcoder** (`libktx.js`/`libktx.wasm`) + resolve `LOCAL_KTX_*` URLs | `apps/web/public/transcoders/ktx/*` (or Vite asset import), `packages/probe/src/probe.ts` const | web/probe | — | transcoder served from same origin; NO jsdelivr in the bundle (grep clean); offline-safe |
| **T4** | probe: `probeKtx2()` (lazy `import 'pixi.js/ktx2'`, `setKTXTranscoderPath`→local, offscreen, raster baseline + compressed measure + fallback) | `packages/probe/src/probe.ts`, `packages/probe/src/index.ts` | probe | T1,T2,T4a | typechecks+builds; returns `ProbeKtx2Reading`; throws→swallowable on no-WebGL; doc note in `docs/render-probe-decision.md` |
| **T5** | protocol: 3 measured `FixReceipt` fields + `fix-done.ktx2Probe` + `Ktx2ProbeInput` | `apps/web/src/worker/fix-protocol.ts` | web | T1 | additive optional fields; typecheck green; off-path unaffected |
| **T6** | worker: collect `Ktx2ProbeInput[]` (fresh slices, cap N) on the KTX2 pass, attach to `fix-done`, extend transfer | `apps/web/src/worker/fix.worker.ts` | web | T5 | `ktx2Produced>0` ⇒ populated+transferred; `===0`/no-backend ⇒ absent ⇒ zip byte-identical; worker test asserts dead-off |
| **T7** | host: `attachKtx2Probe` (pure, WebGL-gated, AbortSignal) + call it inside `fix-client.runFix` `fix-done` branch | `apps/web/src/lib/ktx2-probe-run.ts` (new), `apps/web/src/lib/fix-client.ts` | web | T4,T6 | receipt gains measured fields when WebGL+ktx2 present; same-reference return on no-WebGL/empty; runFix unchanged when `ktx2Probe` absent |
| **T8** | UI: measured-vs-ceiling line + fallback note | `apps/web/src/App.tsx` | web | T7 | shows "measured X (BCn/ASTC), ceiling ≤ Y; this device only"; ceiling line retained; absent fields render as today |
| **T9** | i18n: `receiptVramMeasured` + `receiptVramFallback` across 9 catalogs | `packages/i18n/src/catalogs/*.json` | i18n | T8 | drift-test green; en is source |

Commit order is dependency-respecting. **T1–T3 are independently shippable and fully green headless** (the buildable+testable-now core — the genuine value even before any browser run). **T4a is the new blocker-mitigation** and must land before T4 (so the probe never ships a CDN fetch). T4 is buildable/typechecked with the live read as a documented browser run. T5–T9 wire the receipt + UI additively, off ⇒ byte-identical.

---

**Anchors verified (absolute paths):**
- `/home/nonamezzz/Рабочий стол/projects/packages/probe/src/gl-instrument.ts` — `texSubImage2D` L81, `texImage2D` L108, `recordTexImage` L119, `vram()` L140, `reset()` L165, `restore()` L176. Confirmed: no `compressedTexImage2D` patch.
- `/home/nonamezzz/Рабочий стол/projects/packages/probe/src/probe.ts` — `probeAtlas` L33, `MAX_PROBE_DIM` L22, `preference:'webgl'` L43, `gl` extraction L45.
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/vram-ceiling.ts` — `vramCeilingOfPage`; `COMPRESSED_BYTES_PER_PX_CEILING`/`MIP_OVERHEAD` from core.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts:2356-2412` — KTX2 loop; `c.pageBytes`/`c.pageMime`/`c.w`/`c.h` live; `res.bytes` = produced `.ktx2` (L2393); `ktx2VramBytesWorstCase` L2411; `recordKtx2Candidate` sites L1350/1378/1542/1611; `transfer`/`fix-done` L2594-2595.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts:344-360` — `backendNative` + `ktx2VramBytesWorstCase`; `FixResponse.'fix-done'` L396.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/fix-client.ts:23-46` — `runFix`, `fix-done` handler L30-33, `FixOutcome` L9-12 — **the real seam** (CORRECTION-2).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/probe-run.ts` — `webglAvailable` L22, `attachProbeReadings` L59 (abort+sequential pattern).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx:1761-1783` — `backendNative.map` block; `receiptVram` line L1783 (add the measured sibling beside).
- `node_modules/.pnpm/pixi.js@8.19.0/.../pixi.js/package.json:303` — `"./ktx2"` → `lib/compressed-textures/ktx2/init.mjs`.
- `.../ktx2/loadKTX2.mjs` — `getSupportedTextureFormats()` + `loadKTX2onWorker`; `.../ktx2/worker/loadKTX2onWorker.mjs` — uses `ktxTranscoderUrls`.
- `.../ktx2/utils/setKTXTranscoderPath.mjs` — **default `jsUrl`/`wasmUrl` = `https://cdn.jsdelivr.net/...`** (CORRECTION-1) + `setKTXTranscoderPath` to override.
- `.../pixi.js/transcoders/ktx/libktx.js` (216 KB) + `libktx.wasm` (714 KB) — **present in the package**, self-hostable (T4a).
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json:369-373` — existing `fix.backend.receipt*` keys (source for the two new keys).

**Bottom line:** premise TRUE and high value (turns the one estimated headline into a measured fact). BUILD. One blocker added — **T4a: self-host the KTX2 transcoder** (the default is a silent jsdelivr fetch; Pixi ships the assets locally) — and the orchestration seam moved from `App.tsx` into `fix-client.runFix` (CORRECTION-2). T1–T3 are green-headless and shippable immediately.