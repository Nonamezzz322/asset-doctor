# Round-6 F2 — Solid-fill (single-color) loose-image detector

**Area:** NEW OBJECTIVE MEASUREMENT (dramatizes Invariant 5). **Effort:** medium. **needsKey:** no. Skeptic-verified.

## Verdict: PREMISE TRUE. Ship with fixes.

`decodeFeatures` decodes 72 RGBA quads (9×8) and DISCARDS RGB/alpha (`analyze.worker.ts:96-100`). No solid check exists; the gap is real (a 1024² solid PNG is POT, <2048, and `formatFinding` only fires on a ≥25% transcode delta). Reuse the discarded sample to detect single-color loose images — a 1024² solid pins 4 MB VRAM for one color.

### MAJOR — M-1 (false-premise the gate caught; MANDATORY fix)
The negative-control fixture must be **box-average-visible**. The golden cross-check reproduces the sample via `sample9x8` box-averaging; a 1px border occupies ~1.75% of an edge cell and **averages out** → would read `solid:true`, contradicting `expected.json`. **Fix:** use a **thick (64px) framed** control `framed.png` (solid center color B + 64px perimeter color A) → perimeter cells differ from interior by the full A↔B delta ⇒ `solid:false` deterministically. README notes sub-9×8-cell features are below sample resolution (documented limitation).

### MINOR
- m-2 — **drop the `sev` param** (title/detail don't interpolate it). Keep `params: { w, h, vram }`.
- m-3 — copy acknowledges fully-transparent in one phrase: detail "Every sampled pixel is the same color (or fully transparent) — no edges, gradient or detail."
- m-4 — `isSolidColor` unit cases + golden cross-check go in `apps/web/src/lib/perceptual.test.ts` ONLY (no `analysis.test.ts` mirror — that phantom doesn't exist). `solidFillFinding`+threading tests go in `analysis.test.ts`.
- m-5 — `vramBytesSaved = w*h*4 − 4` (the 1×1). Test asserts exact `−4`; copy may say "≈ full w×h×4".
- m-1 — add `solid-fill` to `render.test.ts` `realFindings()` + keys set so the byte-exact baked-EN===catalog-EN drift guard auto-covers it. `fmtBytes(1048576)="1.0 MB"`.

### Confirmations: `SOLID_STD=2` < `FLAT_STD=12` < dedup `minStdDev=6`; loose-only (atlas branch never fires); CLI/headless omit features+config ⇒ byte-identical; `Findings.tsx` renders generically (no per-rule branch); pure integer math (deterministic).

## ORDERED TASKS
| id | title | files | acceptance |
|----|-------|-------|-----------|
| T1 | Core: `Rule += 'solid-fill'`; `ImageFeatures.solid?`; `ThresholdConfig.solidFill?` | `packages/core/src/index.ts` | additive/optional; typecheck green |
| T2 | Config default `solidFill:{minEdgePx:256,warnEdgePx:1024}` (mark `calibrate`) | `packages/analysis/src/config.ts` | in DEFAULT_THRESHOLDS |
| T3 | Pure `isSolidColor` + `SOLID_STD=2` (per-channel R/G/B + gray + alpha stdDev over all 72; reuse `grayStdDev`) | `apps/web/src/lib/perceptual.ts` | T7 passes |
| T4 | Pure `solidFillFinding` + export; `params:{w,h,vram}` (no sev); copy covers transparent; `estimate.vramBytesSaved` only (no disk — 1×1 emission is fix-engine generation, Invariant 3) | `packages/analysis/src/rules.ts`, `index.ts` | null below gate/not-solid/no-config; warn≥warnEdgePx else info; `messageKey:'solid-fill'` |
| T5 | Wire into `analyze` loose-branch only; build `solidByRef` | `packages/analysis/src/analyze.ts` | loose solid⇒finding; atlas solid⇒none; absent features⇒none; `potentialDiskSaved` unchanged |
| T6 | Worker: compute `solid` in `decodeFeatures`; set `feat.solid` only when true | `apps/web/src/worker/analyze.worker.ts` | no extra getImageData/encode |
| T7 | `isSolidColor` unit cases in perceptual.test.ts only | `apps/web/src/lib/perceptual.test.ts` | uniform⇒true, transparent⇒true, corner-diff⇒false, chromatic-equal-luma⇒false, alpha-ramp⇒false, gradient⇒false, short⇒false |
| T8 | `solidFillFinding` + analyze threading + atlas-parity + absent-features | `packages/analysis/test/analysis.test.ts` | incl `vramBytesSaved===1024*1024*4−4`, `diskBytesSaved===undefined` |
| T9 | Golden fixture: `plate.png` (solid) + `framed.png` (64px frame, not-solid) | `fixtures/_generator/generate.mjs`, `fixtures/sample-projects/solid-fill/*` | generator runs; round numbers; README notes sub-cell limitation |
| T10 | Golden cross-check in perceptual.test.ts (box-average → isSolidColor matches golden) | `apps/web/src/lib/perceptual.test.ts` | plate⇒solid, framed⇒not solid, agree with expected.json |
| T11 | i18n `find.solid-fill.{title,detail,fix}` ×9; add solid-fill to `render.test.ts` realFindings()+keys | `packages/i18n/src/catalogs/*.json`, `test/render.test.ts` | completeness ×9 + drift guard green |
| T12 | Invariant + full green gate | — | check-invariants; pnpm test/typecheck/lint green |

**Commit grouping:** (T1)·(T2+T3+T4+T5)·(T6)·(T7+T8)·(T9+T10)·(T11). T12=gate.

**Locked:** `solid` on ImageFeatures; loose-only; `vramBytesSaved` only; per-channel+alpha over all 72; `SOLID_STD=2`; reuse `grayStdDev`+box-average `sample9x8` harness; negative control is a ≥64px frame (NOT 1px — averages out of the deterministic golden).
