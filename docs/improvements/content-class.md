I now have complete verification. The premise is TRUE and most of the design is sound, but I found several concrete blockers and majors the draft missed or mis-stated. Here is the adversarial review and the revised design.

---

# REVIEW VERDICT: Premise TRUE — design largely sound, but ships with 4 BLOCKERS and 5 MAJORS the draft missed or mis-claimed

The core premise holds against the code. `dHashHex` (analyze.worker.ts:88-91) does decode 9×8 gray and discard it; `isFlat` returns null for flat images (no feature at all). `makeEncoder` (both workers) hard-codes `quality: 0.9` lossy for every image (analyze.worker.ts:110, fix.worker.ts:1537). The fix engine's `encodeCanvas` already honors `opts.lossless` via @jsquash (fix.worker.ts:1608-1619). `FixOp.transcode.lossless` and `plan.ts:263` already plumb the blanket flag. This is a genuine Invariant-3 measurement. **Do not DROP.** But several "byte-identical / no change needed" claims are false.

## BLOCKERS

**B1 — The render.test.ts drift guard hard-asserts the EXACT set of messageKeys, so `messageKey:'format-lossless'` will FAIL CI immediately.** The draft (§6) chose `messageKey: 'format-lossless'` precisely to avoid a renderer change and "keep the drift guard happy." But `render.test.ts:60` does `expect(keys).toEqual(new Set([...,'format',...]))` — a closed-set equality over every key the rules emit. The moment `formatFinding` can emit `format-lossless`, this test's `realFindings()` either (a) never exercises it → set still lacks it → fine, OR (b) if a flat case is added → set mismatch → fail. More importantly the draft's own T8b adds a flat `formatFinding` case; if that case feeds `realFindings` the assert breaks, and even if it doesn't, the new `find.format-lossless.*` keys are now in `en.json` but **untested by the drift guard**, which violates the project's drift-parity convention. **Fix: T7 MUST update `render.test.ts:60`'s expected set to include `'format-lossless'`, and `realFindings()` MUST push one flat-class `formatFinding` so the new key family is drift-checked exactly like every other.** The draft marked render.test.ts as "no change" — wrong.

**B2 — `formatFinding`'s `messageKey` is typed; `renderFinding` keys off `find.<messageKey>` but `messageKey` is a free `string`, OK — however `Rule` is a CLOSED union and the draft is silent on whether `rule` stays `'format'`.** Confirmed `messageKey` is `string` (core:205), so `'format-lossless'` is type-legal WITHOUT touching `Rule`. BUT: `plan.ts:262` filters `f.rule === 'format'`, and the aggregate (`formatAggregateFinding`, analyze.ts:135) collects `formatFindings[]`. If the flat finding keeps `rule:'format'` (correct — only `messageKey` changes), then plan.ts still catches it AND `params.contentClass` is readable. The draft's §5c reads `f.params?.contentClass` but plan.ts:262 gates on `f.rule === 'format'` — **so the flat finding MUST keep `rule: 'format'` and only switch `messageKey`.** The draft never states this explicitly and §10's test says "assert a finding with `messageKey: 'format-lossless'`" without pinning `rule:'format'`. If an implementer also flips `rule`, plan.ts silently drops the transcode op and the aggregate undercounts. **Fix: pin `rule:'format'` invariant in T3 acceptance + test it.**

**B3 — `formatAggregateFinding` consumes the lossless findings' `estimate.diskBytesSaved` and `potentialDiskSaved` sums them — the draft never checks the aggregate stays honest with mixed lossy+lossless savings.** analyze.ts:74 does `potentialDiskSaved += fmt.estimate?.diskBytesSaved`. For flat findings the saving is now the lossless delta. That's fine and honest, but `formatAggregateFinding` (analyze.ts:135) builds a folder finding whose copy may say "transcode to AVIF/WebP would cut N" — mixing lossy-photographic and lossless-flat savings under one "transcode" verdict. Need to verify the aggregate copy doesn't imply a single uniform action. **Fix: T3/T4 must read `formatAggregateFinding` and confirm its copy is action-neutral (it sums bytes, doesn't prescribe lossy); add an assertion. Likely fine but UNVERIFIED in the draft — promote to a must-check.**

**B4 — Lazy @jsquash in the ANALYSIS worker breaks the ≤10s instant-wow guarantee for any folder containing flat/alpha art, and the draft's mitigation is hand-wavy.** §5a says "lazy-load @jsquash only when lossless requested → photographic-only folders never pay it." But a real game folder is mostly UI/flat/alpha art — so in practice EVERY analysis now pays a wasm init + per-flat-image @jsquash WebP lossless encode at FULL resolution, on the diagnosis path. @jsquash lossless WebP at 2048² is materially slower than native lossy q0.9. This is a direct Invariant-4 risk on the exact asset class the feature targets. The draft hides this behind "lazy load." **Fix (decision required, see revised §5a): do NOT do a full-res lossless encode for the SIZE PROBE on the diagnosis path. Either (a) probe lossless on a downscaled proxy and scale the byte estimate (dishonest — rejected), or (b) keep the analysis-path savings number as today's lossy estimate but CHANGE ONLY THE VERDICT COPY for flat/alpha-art (recommend lossless, mark the number as "lossy estimate; lossless will differ"), deferring the true lossless byte measurement to the FIX engine where the user already opted into a slower run.** Option (b) keeps Invariant-4 intact AND stays honest (the copy stops recommending lossy), at the cost of the analysis savings number not being the exact lossless delta. This is the right tradeoff and the draft got it wrong by insisting the analysis number be the lossless delta.

## MAJORS

**M1 — Atlas classification claim is FALSE as written.** §5a asserts "atlases already get the 9×8 read via the same loop — no extra sample needed." Verified: analyze.worker.ts:55 iterates `imageBytes` which DOES include atlas sheets (line 38), and `dHashHex` runs on them. So `decodeFeatures` will classify atlases too — TRUE. BUT `formatFinding` runs on atlases (analyze.ts:100, `addFormat(atlas.name, image)`), and a whole-sheet 9×8 average of a packed atlas is meaningless (mixed content → almost always reads "photographic" by stdDev, or random alpha → "alpha-art"). Recommending lossless for an entire repacked sheet based on a 72-pixel average of a collage is not honest measurement. **Fix: gate `contentClass` consumption in `formatFinding` to LOOSE images only (skip the class branch when the asset is an atlas — atlases keep today's lossy estimate). Set the field for atlases is harmless, but DON'T drive the verdict from it.** The draft's edge-case #8 waves this away as "honest as a coarse hint" — it is not; suppress it.

**M2 — `FLAT_STD = 12` is asserted, not calibrated, and conflicts with the dedup `isFlat` band in a way that will misclassify gradients.** A smooth gradient (UI background) has LOW stdDev only if the gradient is shallow; a full-range vertical gradient over 8 rows has stdDev ~70+. So "flat fills / gradients" will frequently read photographic. The draft claims gradients compress better lossless — true for banded UI, false for smooth photographic-like gradients (lossy wins there). The single stdDev band cannot separate "flat UI gradient" from "smooth photo gradient." **Fix: keep V1 honest by NOT claiming gradient coverage. Scope `flat` to genuinely low-variance fills (stdDev < FLAT_STD) and let mid/high-variance gradients fall to photographic (today's lossy). Document that gradients are explicitly out of V1's confident set. Calibrate FLAT_STD on the two fixtures + the real slot-game folder before merge (T9 acceptance).**

**M3 — `hasHardAlpha` on a 9×8 DOWNSAMPLE will rarely fire, because `drawImage(...,9,8)` bilinearly resamples alpha → hard edges become soft gradients.** This is the killer for the alpha-art class. A crisp icon downscaled to 9×8 with smoothing turns its hard cutout into a ramp of intermediate alphas → no adjacent opaque/clear pair → `hasHardAlpha` returns false → misclassified as flat or photographic. The draft built `hasHardAlpha` on the SAME smoothed 9×8 sample it uses for dHash, which defeats the test. **Fix (decision required): for the alpha test, set `imageSmoothingEnabled = false` on a SEPARATE tiny nearest-neighbor sample, OR detect hard alpha from a coarse histogram of the alpha channel on the (already-decoded, pre-resample) bitmap. Simplest: in `decodeFeatures`, take the 9×8 with smoothing OFF for the alpha read (nearest-neighbor preserves a representative hard edge far better) — but note this changes the dHash sample if shared. Cleanest: keep dHash's smoothed gray sample, and compute `hasHardAlpha` from a histogram bimodality test on the alpha channel of the SAME 72 samples (count of α≥250 and α≤8 each as a fraction of total; bimodal-with-both-poles ⇒ hard alpha) rather than adjacency.** Adjacency on a smoothed 8-row sample is unreliable; a pole-occupancy histogram is robust to resampling. Revise `hasHardAlpha` to the histogram form.

**M4 — `EncodeSizer` 4th-arg change is NOT purely additive for the fix worker's encoder and the diagnosis-path makeEncoder; both must implement lossless or silently mis-size.** §5b says fix.worker `makeEncoder` "gets the same 4th-arg signature update." Verified fix.worker.ts:1526-1543 `makeEncoder` ignores everything and does native lossy q0.9 — it does NOT call `encodeCanvas` (the lossless-capable path at 1582). So adding a `lossless` param to its signature does nothing unless it's rewired to route through `encodeCanvas` for lossless. Same for analyze.worker.ts:98. The draft's T6 acceptance ("4-arg signature parity") would pass typecheck while STILL sizing lossy — a silent honesty bug (savings number claims lossless, encoder returns lossy bytes). **Fix: if §5a Option (b) is adopted (no lossless probe on diagnosis path), then the `EncodeSizer` 4th arg is UNNECESSARY for analysis — drop it entirely from T3/T5, keeping `EncodeSizer` byte-identical.** This SIMPLIFIES the design: no signature change, no fix.worker encoder rewrite, no lazy-wasm-on-diagnosis. The lossless flag lives ONLY where it already exists — plan.ts → FixOp.transcode → encodeCanvas. This collapses B4+M4 together.

**M5 — `i18n` token-parity test requires the `_flat`/`format-lossless` templates to carry IDENTICAL placeholder sets across all 9 locales, and the draft's two template variants have DIFFERENT tokens than `find.format.detail`.** catalogs.test.ts:27 enforces per-key token equality across locales (not vs. the base key — per key). So the new key family just needs internal consistency across locales, which is fine. But render.test.ts:65 asserts the EN render is byte-identical to the baked `f.detail`. The draft's flat detail copy ("Flat / alpha art — prefer lossless...") must be reproduced EXACTLY by `formatFinding`'s baked `detail` string after interpolation, or render.test fails. **Fix: T3 must bake the flat detail/title/fix strings to match `find.format-lossless.*` after interpolation, and T7 must add that finding to `realFindings()`. Tie T3↔T7 explicitly (the draft lists them as independent).**

## MINORS

- §10/T8c references `packages/fix/test/plan.test.ts` — **this file does not exist.** planFix is tested inside `fix.test.ts`, `dedup-exec.test.ts`, etc. T8c must target `packages/fix/test/fix.test.ts` (or add a new `plan-lossless.test.ts`).
- The draft's "9 baked catalogs" — there are 8 non-English baked locales + en source = 9 total. Wording in T7 is fine; the count "8 baked" is correct (ru/de/es/pt/fr/it/zh/hi).
- `params.lossless` boolean: `FindingParams` is `Record<string, string|number>` (core:184) — a `boolean` is NOT assignable. The draft proposes `params.lossless: true`. **Use `params.classBranch:'flat'` (string) or omit; read `params.contentClass` (string) in plan.ts, not a boolean param.** plan.ts §5c already reads `params.contentClass` — good; drop the proposed `params.lossless`.

---

# FINAL REVISED MINI-DESIGN: Content-Class Format-Suitability Verdict

**Status:** implementation-ready (revised) · **Branch:** `feat/asset-pipeline` · **Effort:** S–M (smaller than draft after collapsing B4+M4) · **Invariants:** 1,2,3,4,5 upheld — with the key correction that the **analysis path performs NO lossless encode** (Invariant 4 preserved), and the true lossless byte measurement stays in the fix engine.

## 1. Premise (verified)
Confirmed true against `analyze.worker.ts:79-96`, `rules.ts:166-198`, `perceptual.ts:33-44`, `fix.worker.ts:1582-1624`, `plan.ts:261-264`, `core/index.ts:184,205,214-220`. The gray sample is decoded-then-discarded; lossy q0.9 is applied uniformly; the lossless transcode path already exists in the fix engine. New objective measurement → analysis; generation stays in fix. **Salvageable and worth building.**

## 2. V1 Scope (revised)
**IN:**
1. `core`: additive `ContentClass` union + `ImageFeatures.contentClass?`.
2. `perceptual.ts`: pure `classifyContent(gray, rgba)` + **histogram-based** `hasHardAlpha(rgba)` (robust to 9×8 resampling — M3).
3. `analyze.worker.ts`: refactor `dHashHex` → `decodeFeatures()` (ONE decode → `{dHash, contentClass}`, zero new getImageData). **No encoder change, no lazy wasm on the diagnosis path** (B4/M4 collapse).
4. `analysis/rules.ts`: `formatFinding` gains `contentClass` param. For LOOSE flat/alpha-art it switches to `messageKey:'format-lossless'` and class-specific copy — **keeping `rule:'format'`** (B2) and **keeping today's lossy SIZE estimate** (the copy marks it "lossy estimate; lossless differs in the fix"). Atlases ignore the class (M1). Photographic/unknown byte-identical.
5. `analysis/analyze.ts`: build `classByRef` from `deps.features`, thread to `addFormat`→`formatFinding`. `EncodeSizer` UNCHANGED.
6. `plan.ts`: per-op `lossless = opts.lossless || (params.contentClass ∈ {flat,alpha-art})` (string read — minor) so the Pro fix produces real lossless bytes for flat art. **This is where the honest lossless byte delta materializes (fix engine, opted-in run).**
7. `i18n`: `find.format-lossless.{title,detail,fix}` in en + 8 locales; **update render.test.ts expected key-set + realFindings()** (B1, M5).
8. Fixtures: flat + photographic + alpha-art samples with golden `contentClass`.

**OUT:** lossless encode on the diagnosis path (Invariant 4); `EncodeSizer` 4th arg; fix.worker `makeEncoder` rewrite; atlas-driven class verdicts; gradient confidence; `params.lossless` boolean; severity changes; per-sprite atlas classification; UI redesign.

## 3. Core contract (`packages/core/src/index.ts`)
After `ImageMime` (line 79):
```ts
/** Coarse visual content class for format-suitability, measured from a 9×8 RGBA sample
 *  (grayStdDev band + alpha-pole histogram). Drives the lossy-vs-lossless VERDICT in analysis and
 *  the Pro transcode lossless flag in the fix engine. 'unknown' ⇒ undecoded ⇒ today's lossy path. */
export type ContentClass = 'flat' | 'alpha-art' | 'photographic' | 'unknown';
```
Extend `ImageFeatures` (214-220) additively with `contentClass?: ContentClass`. `ContentClass` lives ONLY here; analysis/fix/worker import it. This is the single agreed coordination point; everything else additive.

## 4. Pure modules (`perceptual.ts`)
```ts
import type { ContentClass } from '@asset-doctor/core';

/** Hard alpha present iff BOTH alpha poles are populated in the sample: a meaningful fraction of
 *  pixels are near-opaque (α ≥ OPAQUE) AND a meaningful fraction near-clear (α ≤ CLEAR), with few in
 *  between. Histogram form (NOT adjacency) — robust to the 9×8 bilinear resample that smears hard
 *  edges into ramps (M3). Soft vignettes have most α in the mid band ⇒ false. */
export function hasHardAlpha(
  rgba: Uint8ClampedArray | number[],
  opaque = 250, clear = 8, minPole = 0.12,
): boolean;

/** Classify a 9×8 sample. Order: alpha-art first (a flat icon WITH a hard cutout is alpha-art).
 *   hasHardAlpha → 'alpha-art' · grayStdDev < FLAT_STD → 'flat' · else 'photographic'.
 *   empty/short → 'unknown'. */
export function classifyContent(gray: number[], rgba: Uint8ClampedArray | number[]): ContentClass;
```
Named consts (calibrate on fixtures + real slot folder before merge): `FLAT_STD = 12` (band above dedup's `minStdDev=6`), `OPAQUE=250`, `CLEAR=8`, `minPole=0.12`. **Gradients explicitly out of the confident set (M2): mid/high-variance gradients fall to photographic.**

## 5. analysis + worker

**`rules.ts` `formatFinding`** — add `contentClass: ContentClass = 'unknown'` (5th param, defaulted ⇒ existing 4-arg callers unchanged). `EncodeSizer` UNCHANGED (M4). Logic:
- Compute `best` exactly as today (lossy q0.9 sizes — the diagnosis path never encodes lossless; Invariant 4).
- `isLoose` guard: the class branch applies only to loose images. (Atlas detection: `formatFinding` receives an `ImageAsset`; the caller passes class as `'unknown'` for atlases — see analyze.ts below — so no signature noise. M1.)
- `wantsLossless = contentClass==='flat' || contentClass==='alpha-art'`.
- If `wantsLossless` and saving past threshold: `rule:'format'` (B2), `messageKey:'format-lossless'`, copy: *"Flat / alpha art — prefer lossless {target}; lossy q0.9 would degrade hard edges. Lossy estimate −{saved:bytes}; the Pro fix encodes lossless (bytes differ)."* Emit `params.contentClass`.
- Below threshold ⇒ `null` (no degrade-for-nothing).
- Else photographic/unknown ⇒ **byte-identical to today** (`messageKey:'format'`).

**`analyze.ts`:** `classByRef` from `deps.features`. In `addFormat`, pass the class ONLY for loose assets; for atlas assets pass `'unknown'` (M1):
```ts
const classByRef = new Map<string, ContentClass>();
for (const f of deps.features ?? []) if (f.contentClass) classByRef.set(f.assetRef, f.contentClass);
// loose: addFormat(image.name, image, classByRef.get(image.name) ?? 'unknown')
// atlas: addFormat(atlas.name, image, 'unknown')
```
Absent `features` ⇒ empty map ⇒ every call `'unknown'` ⇒ byte-identical (CLI unaffected).

**`analyze.worker.ts`:** refactor `dHashHex`→`decodeFeatures(bytes): Promise<{dHash:string|null; contentClass:ContentClass}>` — ONE `createImageBitmap` + ONE `getImageData(0,0,9,8)`, computes `gray[]` once, returns `dHash = isFlat(gray)?null:dHashFromGray(gray)` and `contentClass = classifyContent(gray, data)`. Loop (55-59) sets `contentClass` on each feature. **No `makeEncoder` change, no @jsquash on the diagnosis path** (B4/M4). `catch` ⇒ `{dHash:null, contentClass:'unknown'}`.

## 6. fix engine (the honest lossless delta lives here)
**`plan.ts` pass 2 (262-263):**
```ts
const wantsLossless = f.params?.contentClass === 'flat' || f.params?.contentClass === 'alpha-art';
ops.push({ kind:'transcode', assetRef:f.assetRef, targetMime:opts.targetMime,
           quality:opts.quality, lossless: opts.lossless || wantsLossless });
```
`f.rule==='format'` still gates this (B2), and the flat finding kept `rule:'format'`, so it's caught. `encodeCanvas` (fix.worker.ts:1608) already honors `lossless` → the Pro fix now produces real lossless bytes for flat/alpha art. **No FixOp change, no fix.worker `makeEncoder` change** (it's the size-probe encoder, not the executor; M4).

## 7. i18n
Add `find.format-lossless.{title,detail,fix}` to `en.json` + 8 locales (identical placeholder tokens per key — catalogs.test.ts:27). Baked EN strings in `formatFinding` MUST equal the templates after interpolation (render.test.ts:65). **Update `render.test.ts:60` expected set to include `'format-lossless'` and push one flat `formatFinding` into `realFindings()`** (B1).

## 8. Honesty + Invariants
- **Inv 3:** `contentClass` is measured (stdDev band + alpha histogram); the verdict is a readout. The analysis savings number stays today's lossy estimate, now HONESTLY LABELED as lossy with lossless deferred to the fix — no faked lossless number. Generation stays in the fix engine.
- **Inv 4:** ZERO new encode on the diagnosis path; `decodeFeatures` reuses the dHash decode (no new getImageData); no @jsquash loaded during analysis. ≤10s preserved even for all-flat folders (B4 resolved).
- **Inv 1/2/5:** unchanged.

## 9. Edge cases (revised)
1. Undecodable ⇒ `'unknown'` ⇒ today's lossy estimate.
2. `isFlat`-rejected-for-dedup flat ⇒ still classified (dHash null, class set); two independent bands (6 vs 12) documented.
3. Opaque flat fill ⇒ `'flat'`.
4. Flat icon + hard cutout ⇒ alpha checked first ⇒ `'alpha-art'`.
5. Soft vignette ⇒ alpha mostly mid-band ⇒ `hasHardAlpha` false ⇒ stdDev high ⇒ `'photographic'`.
6. Gradient (smooth, high-variance) ⇒ `'photographic'` (M2 — out of confident set, lossy stays).
7. AVIF source ⇒ `formatFinding` early-returns; class irrelevant.
8. Lossless-eligible but below threshold ⇒ `null`.
9. **Atlas ⇒ class forced `'unknown'` by caller ⇒ today's lossy path** (M1).
10. `deps.features` absent (CLI) ⇒ all `'unknown'` ⇒ byte-identical.

## 10. Test plan (revised)
- **`apps/web` perceptual:** `classifyContent` flat/alpha-art/photographic/unknown + order (flat+cutout→alpha-art); `hasHardAlpha` histogram: both poles populated→true, soft-ramp→false, opaque-only→false. Build samples that survive the resample assumption (the test feeds raw 72-px arrays directly — no canvas).
- **`packages/analysis`:** `formatFinding` flat ⇒ `rule:'format'` (B2), `messageKey:'format-lossless'`, `params.contentClass:'flat'`, saving = today's lossy delta (NOT lossless — Inv 4). Photographic ⇒ byte-identical (regression-lock `analysis.test.ts:150-163`). `analyze`: atlas asset never gets a lossless verdict (M1); `classByRef` threading; absent features ⇒ identical. Confirm `formatAggregateFinding` copy stays action-neutral (B3).
- **`packages/fix`:** in **`fix.test.ts`** (NOT a nonexistent plan.test.ts — minor), a `format` finding with `params.contentClass:'flat'` ⇒ transcode op `lossless:true` even when `opts.lossless:false`; photographic ⇒ `lossless:opts.lossless`.
- **`packages/i18n`:** catalogs.test.ts auto-covers new keys; render.test.ts updated set + flat finding (B1); no-brace render assertion per locale.
- **Fixtures:** `format-classes/` with flat-fill PNG, photographic PNG, alpha-art icon PNG + `expected.json` golden `contentClass`; generator hand-authors class (ground-truth cross-check). Canvas-dependent leg guarded for OffscreenCanvas; pure leg asserts `classifyContent` on a hand-built sample.

## 11. Ordered task breakdown (revised — collapses B4+M4, fixes B1/B2/M1/M3/minors)

| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|------------|
| T1 | `ContentClass` + `ImageFeatures.contentClass?` | `core/src/index.ts` | core | — | typecheck green; optional; no existing test changes |
| T2 | Pure `classifyContent` + **histogram** `hasHardAlpha` + named consts | `apps/web/src/lib/perceptual.ts` | analysis | T1 | T8a passes; resample-robust alpha test; gradients NOT claimed flat |
| T3 | `formatFinding` class-aware: **keep `rule:'format'`**, switch `messageKey:'format-lossless'` for LOOSE flat/alpha-art, **keep today's lossy size**, label copy as lossy-estimate; `params.contentClass`. `EncodeSizer` UNCHANGED | `analysis/src/rules.ts` | analysis | T1 | photographic byte-identical; flat ⇒ new key, `rule:'format'`, lossy saving; atlas path untouched |
| T4 | `analyze` `classByRef`; pass class for LOOSE only, `'unknown'` for atlas (M1) | `analysis/src/analyze.ts` | analysis | T3 | absent features ⇒ identical; atlas never lossless-verdict; aggregate action-neutral |
| T5 | Worker `decodeFeatures` (one decode → dHash+class); **no encoder/wasm change** | `apps/web/src/worker/analyze.worker.ts` | web | T2,T4 | zero new getImageData; no @jsquash on diagnosis; ≤10s preserved |
| T6 | planFix derives `lossless` from `params.contentClass` (string read) | `packages/fix/src/plan.ts` | fix | T1,T3 | flat ⇒ transcode `lossless:true` over `opts.lossless:false`; photographic ⇒ `opts.lossless`; T8c green |
| T7 | i18n: add `find.format-lossless.*` (en+8); **update render.test.ts expected set + realFindings()** | `i18n/src/catalogs/*.json`, `i18n/test/render.test.ts` | i18n | T3 | catalogs.test + render drift-guard green incl. new family |
| T8a | Tests: `classifyContent`/`hasHardAlpha` | `apps/web/src/lib/perceptual.test.ts` (new) | test | T2 | all classes + order + resample-robust alpha |
| T8b | Tests: `formatFinding` flat vs photographic (regression-lock); `analyze` atlas-suppression + threading | `analysis/test/analysis.test.ts` | test | T3,T4 | flat lossy-saving + `rule:'format'`; photographic byte-identical; atlas unknown |
| T8c | Tests: planFix lossless-from-class | **`packages/fix/test/fix.test.ts`** | test | T6 | flat ⇒ `lossless:true` over `opts.lossless:false` |
| T9 | Fixture `format-classes/` (flat+photo+alpha-art + golden `contentClass`); calibrate FLAT_STD | `fixtures/_generator/generate.mjs`, `fixtures/sample-projects/format-classes/*` | fixture | T2 | deterministic; golden cross-checks `classifyContent`; consts calibrated on real slot folder |

**Commit order:** T1 → T2 → T3 → T4 → T5 → T6 → T7 → (T8a/T8b/T8c) → T9.

## 12. Net change vs draft
- **B4+M4 collapsed:** analysis path does NO lossless encode and `EncodeSizer` is unchanged → smaller, safer, Invariant-4-clean. The honest lossless byte delta is produced by the fix engine (where the user opted into a slower run), not faked or estimated on the diagnosis path.
- **B1/M5:** `render.test.ts` MUST be updated (draft wrongly said "no change").
- **B2:** flat finding keeps `rule:'format'` (only `messageKey` changes) — required for plan.ts:262 + aggregate.
- **M1:** atlases never drive a lossless verdict.
- **M3:** `hasHardAlpha` is a histogram pole-occupancy test, not adjacency (resample-robust).
- **M2:** gradients explicitly out of V1's confident set.
- **Minors:** T8c targets `fix.test.ts` (no plan.test.ts exists); drop `params.lossless` boolean (not assignable to `FindingParams`) — read `params.contentClass` string.