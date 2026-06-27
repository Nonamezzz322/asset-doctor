`cmp` is exported from `./dedup` (re-exported via index). The draft's reference to `cmp` "from analysis" is valid. I now have a complete and verified picture. All load-bearing claims check out, with a few real gaps the draft missed. Here is the final adversarial review.

---

# Wire `probeAtlas` into the Production Verdict — MEASURED VRAM/Draw-Call Line (REVISED)

## Verdict on the premise: TRUE, and the design is largely sound — but it ships a quietly DISHONEST VRAM comparison and an under-estimated edge case. Fixed below.

**Premise verified against code:** `probeAtlas` is genuinely orphaned in production — the only consumers are `apps/web/src/probe-harness.ts` (dev-only, served at `/probe.html`) and the decision doc. `correlate.html`/`probe.html` are explicitly *not* in the production build (only `index.html` is). The header strip (`App.tsx:108-114`) shows three estimated metrics; FilmViewer (`FilmViewer.tsx:104-109`) shows a `grid-cols-4` readout with a static `VRAM` cell. No draw-call line exists in the verdict. The improvement is real and unclaimed. **GO** on the premise.

But the draft has **2 BLOCKERS** and **4 MAJORS** that, left unaddressed, would violate invariant 5 (the very invariant this feature exists to dramatize) or break determinism/the test suite.

---

## BLOCKER 1 — The `est X / meas Y` VRAM comparison is measuring TWO DIFFERENT THINGS and will routinely show a confusing/false delta.

The draft proposes FilmViewer renders `est <metrics.vramBytes> / meas <probe.vramBytes>` side by side as if they're the same quantity measured two ways. **They are not, and the code proves it:**

- **Static** `metrics.vramBytes = vramBytes(atlas.size)` (`analyze.ts:79`) = `atlas.size.w × atlas.size.h × 4` — the *declared atlas canvas dimensions from the manifest*.
- **Measured** `probe.vramBytes` (`gl-instrument.ts:140-148`) = `Σ` over live textures of `base.source.width × base.source.height × 4` — the *actual decoded image dimensions*, taken from `texImage2D` on the bitmap Pixi uploaded.

These diverge whenever the manifest's `meta.size` ≠ the PNG's real pixel size (extremely common: trimmed atlases, manifests authored at a different scale, `meta.size` rounded to POT while the image isn't, or a manifest that lies). When they diverge the UI shows `est 1MB / meas 0.77MB` and the user concludes the tool is buggy or one number is wrong — when in fact **the measured one is the truth and the static one was always an approximation**. That is the *opposite* of the honesty this feature is supposed to deliver.

Worse: for the **happy path the decision doc itself documents**, the harness atlas is `512×512` and `probe.vramBytes = 1048576 = 512×512×4`, which equals the static estimate *only because the harness canvas was authored to match*. Real dropped folders won't be so tidy.

**Required fix:** The measured line must be framed as **"what the GPU actually allocates for this image"**, NOT as a second opinion on the same number. Concretely:
- Label the static cell **"VRAM (declared)"** or keep it as the atlas-geometry estimate, and label the probe cell **"VRAM (measured)"** with a one-line tooltip: *"actual decoded texture footprint — differs from the estimate when the manifest size ≠ the image's real pixels."*
- When `probe.vramBytes !== metrics.vramBytes`, this divergence is a *feature to surface*, not a bug to hide — it means the manifest disagrees with the image. Do **not** compute or show a "savings" or "−%" between them (there is none; they're different measurements). The draft never claimed a %, good — but it must add the tooltip so the divergence reads as informative, not broken.

This is the single most important correction: the headline draw-calls line is honest and great; the VRAM line as drafted risks *manufacturing* a fake discrepancy, which is an invariant-5 violation in the feature meant to showcase invariant 5.

## BLOCKER 2 — The probe renders into a fixed `256×256` Pixi `Application` but draws sprites at full atlas frame coordinates — frames outside 256px are off-canvas, and (more importantly) this is fine for VRAM/texture counting but **the draw-call count can be 0 if every sprite is culled**.

`probe.ts:27` inits `{ width: 256, height: 256 }`. The frames in a real atlas (e.g. a sprite at `{x: 2000, y: 1800}`) land entirely outside the 256×256 viewport. Pixi v8's batcher still uploads the base texture (so `vramBytes`/`liveTextures` are correct — texture upload happens at `Texture.from`, independent of visibility), **but a fully off-screen sprite may be culled before the draw**, yielding `drawCalls: 0` for a real multi-thousand-pixel atlas. The decision-doc happy number (`drawCalls: 1`) worked only because the harness frames all fit in 512² and Pixi rendered into a context large enough / culling didn't trigger.

The draft's edge-case table (#5 "Huge atlas 4096²: one texture upload + one render; fine") is **wrong on draw calls** — it conflates texture upload (fine) with draw issuance (viewport-dependent).

**Required fix (one line):** size the probe `Application` to the atlas, or disable culling, or render the sprites translated into view. Simplest robust option: init the probe `Application` with `width/height` = the atlas size (clamped to a sane max, e.g. `min(size, 2048)`), OR set `cullable = false` / render via `renderer.render(stage)` with an explicit large render texture. Since `probeAtlas` currently takes only `(source, frames)`, **add an optional `size?: Size` param** (additive, defaulted) and have `attachProbeReadings` pass `atlas.size`. This must be in T2/T5, and the manual-verify step (T10) must assert `drawCalls === 1` on a *real* fixture, not just the 512² harness.

> Note: this is a change to `probe.ts` behavior, so the draft's claim "probeAtlas unchanged" (T2) is **false** — it needs the size param. Reclassify T2 as a behavior change with its own assertion.

---

## MAJOR 1 — Moving `ProbeReading` into core is unnecessary churn and risks the `instrument.ts` import. Prefer a structural type in core that probe's `ProbeReading` is assignable to, OR just attach the existing type.

The draft moves `ProbeReading` from `probe` to `core` so `AssetMetrics.probe` can reference it without core depending on probe. Verified: core has **zero deps** (`core/package.json`), probe depends on core — so the *direction* is right (core can't import probe). The move works. **But** `gl-instrument.ts` already imports `MIP_OVERHEAD` from core and defines its own `GlStats` (a superset of `ProbeReading`). Two cheaper options:

- **(preferred)** Define `ProbeReading` in core (as drafted) — fine — but **keep `probe.ts`'s `probeAtlas` return type as core's `ProbeReading`** and delete the duplicate interface, re-exporting from `index.ts`. The draft does this. The only real risk is the back-compat re-export: `probe/src/index.ts:7` is `export type { ProbeReading } from './probe'`. After the move, `probe.ts` does `export type { ProbeReading }` (re-export from core), so `index.ts`'s `from './probe'` still resolves. ✓ Verified the only external consumers are within probe itself (`probe.ts`, `index.ts`) — `probe-harness.ts` imports only `probeAtlas`, not the type. So the move is **safe**, low-blast-radius. Accept the draft's approach, but the design must note `gl-instrument.GlStats` stays independent (it's a superset; do not couple it).

No change to the plan beyond this confirmation, but T1/T2 acceptance should add: "`grep ProbeReading` shows no broken import; `GlStats` untouched."

## MAJOR 2 — `atlasFrames` is keyed by `atlas.name`, but `fileMap`/`selectedAsset` are keyed by the **dir-aware `keyOf` ref**. The draft conflates them.

The draft says `atlasFrames[atlas.name] = ...` and later `report.atlasFrames?.[selectedAsset]` and `fileBytes` lookup by `ref`. But:
- `AssetMetrics.assetRef = atlas.name` (`analyze.ts:77`) — and `atlas.name` is the parser-assigned name.
- `fileMap` is keyed by `keyOf(f)` (`App.tsx:56-60`), the dir-aware ingest key.
- `selectedAsset` is set to `rep.assets[0].assetRef` (`App.tsx:74`) and used to look up `fileMap.get(selectedAsset)` (`App.tsx:95`).

The existing FilmViewer already works (`selectedBytes = fileMap.get(selectedAsset)` succeeds), which **proves `atlas.name === keyOf` for atlases in this codebase** (ingest sets the atlas name to the dir-aware key). So keying `atlasFrames` by `atlas.name` *is* consistent with `fileMap` — **but the design must state this invariant explicitly** rather than treating "atlas.name" and "ref" as interchangeable by luck. Add to T3 acceptance: "key === `AssetMetrics.assetRef` === the `fileMap` key; assert `fileMap.get(ref)` resolves for every `atlasFrames` key in a fixture." Otherwise a future ingest change silently breaks the probe lookup with no test catching it.

## MAJOR 3 — Determinism claim about `cmp` is right but the source is mis-cited; and aggregation order doesn't actually affect the sums.

The draft (Determinism §) says iteration "sorts keys with the existing codepoint comparator (`cmp` from analysis)". Verified: `cmp` is exported from `@asset-doctor/analysis` (re-exported from `./dedup`), and App.tsx already imports it. Fine. **But** `totals.probe` is pure integer summation (`drawCalls`, `vramBytes`, `atlasesProbed`) — addition is commutative, so sort order does **not** change the totals. Sorting is therefore *not required for determinism of the sums*; it's only needed if any per-atlas order were observable downstream (it isn't). Keep the sort if you want stable iteration for future use, but the design should not claim it's load-bearing for determinism — that's a false rationale. **Real determinism risk is elsewhere:** `probe.vramBytes` depends on the GL driver's reported texture size, which is deterministic for a given decode, AND on whether Pixi generated mipmaps (it doesn't by default for a one-shot render). Confirm in T10 that repeated runs on the same fixture yield identical `vramBytes` (the instrument is deterministic; Pixi's default mipmap behavior must be too — note it).

## MAJOR 4 — i18n: the `{n}` plural for `readout.batched` must use the existing `:` hint convention, and the bytes label needs no new formatter — but the draft missed that `metric.vramMeasured` value is rendered via `fmtBytes` in App, not i18n.

Verified the catalog uses `{token:bytes}` hints (`i18n/src/index.ts:98`) and plural objects `{one, other}` (e.g. `en.json:19-20`). The `catalogs.test.ts` (`:25`, `:27`) asserts (a) every plural value is an object with `.other`, and (b) placeholder *token sets* match en exactly via `grab(/\{[^}]+\}/g)`. So:
- `readout.batched` as `{ one: "{n} sprite batched", other: "{n} sprites batched" }` ✓ passes the structure + token assertions (token `{n}` present in both, matches across all 9).
- `metric.vramMeasured`, `readout.estimate`, `readout.measured`, `readout.drawCalls` are plain strings (no tokens) ✓ — but they MUST be added to **all 9** catalogs or the "same keys as en" assertion (`:18`) fails. The draft says this; good.
- **Correction:** the draft's `metric.vramMeasured` example value `"vram (measured)"` is a label only; the *number* is formatted by `fmtBytes` in App.tsx (consistent with `metric.vram` at App.tsx:111). No `:bytes` hint needed on a label key. Fine — just don't put a `{bytes}` token in the label.
- Add `readout.batched` to the existing "renders a plural without leftover braces" test (`catalogs.test.ts:32-34`) per the draft — good, keep it.

---

## MINORS (accept as-is / quick notes)
- **Sequential probing (edge #5):** correct and necessary — each `probeAtlas` does `app.destroy()` (`probe.ts:48`), so contexts are freed between runs; parallel would risk context-limit loss. Keep `await`-in-loop.
- **Non-blocking after `setReport` (T8):** correct for invariant 4. The AbortController guard is necessary because `run()` doesn't currently abort anything; verified there's no existing controller. Add it.
- **No worker/protocol change:** confirmed — `protocol.ts` carries `report: AnalysisReport` verbatim; new optional fields ride along under structured clone. ✓
- **Empty-atlas (#6) → `drawCalls: 0`:** honest, keep. But note this *also* surfaces if BLOCKER 2 isn't fixed (off-screen culling), so they're distinguishable only once the viewport fix lands.
- **`createImageBitmap` reuse:** FilmViewer creates+closes its own bitmap (`FilmViewer.tsx:42,46`); the draft's "centralize one decode" is aspirational — in practice the probe will decode its own bitmap from `fileMap`. That's fine (one extra decode per atlas, off the critical path). Don't over-engineer bitmap sharing across the component boundary; the draft's `bitmapFor` hook is YAGNI — **cut it** (the signature already made it optional/nullable; just drop it and always decode in the helper).

---

## Honesty / invariant compliance (re-checked)

| Invariant | Status |
|---|---|
| 1 — assets never leave | ✓ probe runs on in-memory bytes, main-thread WebGL, Pixi already bundled (`apps/web` deps pixi.js ^8). Zero network. |
| 2 — thin backend | ✓ untouched. |
| 3 — measure don't generate | ✓ a measurement surfaced as a readout, no new finding/threshold. |
| 4 — instant-wow ≤10s | ✓ **only if** probe runs strictly after `setReport` (T8) and never blocks. Confirmed feasible. |
| 5 — disk≠VRAM, honest | ⚠ **FIXED via BLOCKER 1**: measured-vs-declared must be labelled as different quantities with a tooltip, never as a fake delta. Draw-call line ("N sprites = 1 draw") is the literal thesis. ✓ once relabelled. |

---

## REVISED ORDERED TASK BREAKDOWN

| id | title | files | tag | deps | acceptance (revised) |
|----|-------|-------|-----|------|------------|
| **T1** | Add `ProbeReading` to core; add `AssetMetrics.probe?`, `totals.probe?`, `AnalysisReport.atlasFrames?` (key === `assetRef`) | `packages/core/src/index.ts` | core | — | Optional fields compile; no existing field changed; `grep ProbeReading` clean. |
| **T2** | Point `probe.ts`/`index.ts` at core's `ProbeReading`; **add `size?: Size` param to `probeAtlas`** sizing the Application to the atlas (clamped ≤2048) so off-screen sprites still issue draws | `packages/probe/src/probe.ts`, `index.ts` | core+behavior | T1 | `import {ProbeReading} from '@asset-doctor/probe'` resolves; `GlStats` untouched; **with `size`, a real >256px-frame atlas yields `drawCalls:1`, not 0**; `instrument.test.ts` green. |
| **T3** | Populate `atlasFrames` in `analyze()` keyed by `atlas.name` (= `assetRef` = `fileMap` key) | `packages/analysis/src/analyze.ts` | pure | T1 | Carries frames per atlas, `undefined` when none; deterministic order. |
| **T4** | Test: `atlasFrames` correct + **every key resolves in a `fileMap`-style key set**; `undefined` for loose-only | `packages/analysis/test/analysis.test.ts` | test | T3 | New asserts pass; 88 existing green. |
| **T5** | Host helper `attachProbeReadings` + `webglAvailable` (feature-detect, per-atlas try/catch, **pass `atlas.size`**, sequential, abort-aware, aggregate `totals.probe`); **cut the `bitmapFor` hook** (always decode from `fileMap`) | `apps/web/src/lib/probe-run.ts` (NEW) | host | T1,T2,T3 | Unchanged report on no-WebGL/no-atlases (same reference); attaches per-atlas `probe` + `totals.probe`; never throws. |
| **T6** | Test: no-WebGL identity, mocked-probe attach/aggregate, swallowed per-atlas error, already-aborted signal | `apps/web/src/lib/probe-run.test.ts` (NEW) | test | T5 | All cases green under jsdom. |
| **T7** | i18n: `metric.vramMeasured` (label, no token), `readout.declared`/`readout.measured`/`readout.drawCalls`, `readout.batched` (`{one,other}` with `{n}`), **+ `readout.measuredTooltip`** (the divergence explainer) in all 9 + drift test | `packages/i18n/src/catalogs/*.json`, `test/catalogs.test.ts` | i18n | — | `catalogs.test.ts` green; `readout.batched` plural renders no leftover braces. |
| **T8** | App: AbortController in a ref (abort at top of `run()`); run probe non-blocking AFTER `setReport`; measured-VRAM `HeaderMetric` gated on `totals.probe` | `apps/web/src/App.tsx` | ui | T5,T7 | Static result renders first; measured header appears only when probed; re-analyze aborts stale probe. |
| **T9** | FilmViewer: relabel static cell **"VRAM (declared)"**, add **"VRAM (measured)" + tooltip** (never a delta/%), add draw-calls cell `${drawCalls} (${frameCount} sprites batched)`; all gated on `metrics.probe` so loose/no-WebGL = today's 4 cells | `apps/web/src/components/FilmViewer.tsx`, `App.tsx` (pass `frameCount`) | ui | T7,T8 | Probed atlas shows declared + measured (with tooltip) + draw-calls; **no fake %**; loose image unchanged. |
| **T10** | Verify: typecheck + full suite + live on a **real >256px fixture** (not just the 512² harness): assert `drawCalls===1`, repeated runs give identical `vramBytes`, and a manifest-size≠image-size fixture shows the divergence reads as informative | repo-wide | test | T1–T9 | `pnpm typecheck` + `pnpm test` green; live draw-call + measured-VRAM confirmed; divergence labelled, not a fake delta. |

---

### Key files (absolute)
- `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` — `ProbeReading`, `AssetMetrics.probe`, `totals.probe`, `AnalysisReport.atlasFrames`
- `/home/nonamezzz/Рабочий стол/projects/packages/probe/src/probe.ts` + `index.ts` — re-export `ProbeReading`; **add `size?` param (BLOCKER 2)**
- `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/analyze.ts` — emit `atlasFrames` (key === `assetRef`)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/probe-run.ts` (NEW) — `attachProbeReadings`, `webglAvailable`
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` — AbortController + non-blocking probe + measured header
- `/home/nonamezzz/Рабочил стол/projects/apps/web/src/components/FilmViewer.tsx` — **declared vs measured (labelled, tooltip, no delta)** + draw-calls cell
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/*.json` (all 9) + `test/catalogs.test.ts`

### Load-bearing findings (verified against source)
- **Premise TRUE:** `probeAtlas` consumers are only `probe-harness.ts` (dev `/probe.html`, not in prod build) + `index.ts` re-export. Orphaned in production. ✓
- **BLOCKER 1 (honesty):** static `vramBytes(atlas.size)` (`analyze.ts:79`) = declared manifest dims; probe `vramBytes` (`gl-instrument.ts:140-148`) = real decoded dims. They are different quantities — must be labelled "declared" vs "measured" with a tooltip, never shown as a delta. The decision-doc `1MB == 1MB` match is an artifact of the harness canvas being authored to match.
- **BLOCKER 2 (correctness):** `probe.ts:27` fixes the Application to 256×256; real atlas frames fall off-canvas → sprites can be culled → `drawCalls:0`. Needs a `size` param. The draft's edge-case #5 ("huge atlas… fine") is wrong on draw calls (conflates upload with draw).
- **Main-thread WebGL confirmed:** `probe-harness.ts` and `correlate-harness.ts` are top-level `<script type=module>` page scripts (`probe.html:9`, `correlate.html:9`) — main thread, real WebGL, Pixi v8. `apps/web` deps `pixi.js ^8` (`package.json:28`). No new dep, no worker-WebGL risk. ✓
- **Keying:** `AssetMetrics.assetRef = atlas.name` (`analyze.ts:77`); `fileMap` keyed by `keyOf` (`App.tsx:56`); existing `fileMap.get(selectedAsset)` works (`App.tsx:95`) ⇒ for atlases `atlas.name === keyOf`. Key `atlasFrames` by `atlas.name`; assert the equality in T4 so a future ingest change can't silently break the lookup.
- **Type move is safe:** core has zero deps; probe→core direction is correct; no external consumer imports the `ProbeReading` *type* (only `probeAtlas`). `GlStats` is an independent superset — leave it.
- **i18n:** catalog uses `{token:bytes}` hints (`index.ts:98`) and `{one,other}` plural objects; `catalogs.test.ts:18,25,27` enforces same-keys + plural-object + identical placeholder token sets across all 9. `readout.batched` must be a plural object carrying `{n}`. Label keys (no token) just need to exist in all 9.
- **Determinism:** `totals.probe` sums are integer addition (commutative) — the draft's "sort for determinism" rationale is false (harmless but not load-bearing). Real determinism: confirm repeated probe runs give identical `vramBytes` (instrument is deterministic; Pixi makes no mipmaps for a one-shot render).
- **No worker/protocol change:** `protocol.ts` passes `report` verbatim; new optional fields ride structured clone. ✓
- **Cut YAGNI:** drop the `bitmapFor` hook from `attachProbeReadings`; always decode from `fileMap` (one off-critical-path decode per atlas).