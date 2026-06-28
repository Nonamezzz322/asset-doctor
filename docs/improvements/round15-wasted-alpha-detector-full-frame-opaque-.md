Confirmed: plan.ts works purely off `f.assetRef` and `f.params`; it has NO access to the source `ImageAsset.mime`. The existing transcode emits `targetMime: opts.targetMime` (the user's chosen global target), never the source mime. The draft's "preserve source mime" instruction is **not implementable as written** in plan.ts and also contradicts the existing model. This is a real correctness gap.

I now have everything needed. Let me write the revised design.

---

# Wasted-Alpha Detector — REVISED Mini-Design (adversarially verified)

## Verdict: PREMISE TRUE — design SALVAGEABLE with 4 corrections

I verified every cited line. The core premise holds:

- **The gap is real.** `decodeFeatures` (`apps/web/src/worker/analyze.worker.ts:105-124`) decodes a 9×8 downsample only (`OffscreenCanvas(9,8)`, `getImageData(0,0,9,8)` line 116). `hasHardAlpha` (`perceptual.ts:99-115`) requires BOTH alpha poles ≥ `minPole`; an all-255 image populates only the opaque pole ⇒ `false` ⇒ falls to `flat`/`photographic` with no alpha verdict. `classifyContent` never emits an "opaque RGBA wastes a channel" class. `formatFinding` (`rules.ts:201-258`) only fires on a ≥25% cross-format delta — it never asks "drop the dead alpha channel." **Confirmed: a fully-opaque RGBA is invisible today.**
- **The honesty split is correct.** Disk saving is measurable now via the injected `EncodeSizer`; VRAM is conditional on the runtime's internalFormat (invariant 5). Matches the dedup/KTX2 prose-only VRAM precedent.
- **CLI suppression is correct by construction.** `resolveThresholds` (`packages/budget/src/config.ts:99-111`) *enumerates* groups explicitly (occupancy/oversize/formatSaving/npot/duplicates/shouldAtlas/atlasMerge). It already drops `solidFill`, `mipmap`, `fragmentation`. A new `wastedAlpha?` is dropped the same way — **no edit needed to suppress it**, just don't add it. ✓
- **`Findings.tsx` generic rendering** — accepted as stated (not re-verified, low risk: every other rule surfaces generically).

But the draft has **four defects** that must be fixed before it's implementation-ready.

---

## BLOCKER 1 — `targetMime` in the plan is self-contradictory and not implementable as written

The draft's plan.ts instruction says emit `{ kind:'transcode', targetMime: <source mime, preserved> }` and "must keep the RUNTIME format." **This cannot be done in `plan.ts`** and contradicts the existing model:

- `planFix` pass-2 (`plan.ts:261-269`) works purely off `f.assetRef` + `f.params`. It has **no access to the source `ImageAsset.mime`** — `report.findings` carry no source mime, and the plan never receives the asset list.
- The existing transcode op emits `targetMime: opts.targetMime` (the user's chosen global delivery target — typically WebP/AVIF), NOT the source mime. There is no "preserve source format" anywhere in the current transcode path.

**Resolution (locked):** Drop "preserve source mime" entirely. A `wasted-alpha` finding emits a transcode to **`opts.targetMime`** (exactly like the `format` op) with `opaque: true`. This is *better* anyway: a fully-opaque PNG re-encoded to opaque WebP/AVIF drops the channel AND gets format compression — a strictly larger, honest disk win, all measured in the receipt. If the user's target equals the source mime (PNG→PNG opaque), it still works (recompresses; channel-drop caveat per Edge Cases). The finding's `params.srcLabel` is for copy only, not for op routing.

This also dissolves the draft's awkward dedupe rule (see BLOCKER 2).

## BLOCKER 2 — the "dedupe with the format op" rule is under-specified for finding *ordering*

The draft says "if a `transcode` op for the ref already exists from the `format` pass, set `opaque:true` on it." But pass-2 (`plan.ts:261-269`) iterates `report.findings` and **emits a transcode the moment it sees a `format` finding**. A `wasted-alpha` finding for the same ref may appear *before or after* the format finding in sort order (findings are severity-then-id sorted, `analyze.ts:167`). "Set opaque on the existing op" only works if format is always processed first — not guaranteed.

**Resolution (locked):** Single pass-2 loop, dedupe by a `Set<string> opaqueRefs` built *first*:
1. Before the pass-2 loop, build `opaqueRefs = new Set(findings.filter(f => f.rule==='wasted-alpha' && f.scope!=='folder').map(f=>f.assetRef))`.
2. In the existing `format` branch, when emitting the transcode, add `...(opaqueRefs.has(f.assetRef) ? { opaque: true } : {})`.
3. After the `format` branch, add a *new* branch: a `wasted-alpha` finding whose ref is NOT already handled by a format transcode (and not resized/dropped/packed/tiered) emits its OWN `{ kind:'transcode', targetMime: opts.targetMime, quality, lossless, opaque:true }`. Guard with a local `Set transcoded` (refs that already got a transcode op this pass) so a ref with BOTH findings yields exactly ONE op carrying `opaque:true`.

Deterministic (Set membership is order-free; emission order follows finding order). This is the proven `packed`/`tiered`/`resized` guard pattern already in pass-2.

## MAJOR 3 — the worker has a SECOND transcode path the draft ignores: the profile fan-out

`fix.worker.ts:1560-1589` — when `profileOn` (round7 export profile active), a loose transcode does NOT call the `transcode()` helper at all; it decodes to a canvas and calls `emitLooseProfileFanout(...)`, emitting one variant per profile format. The draft only threads `opaque` through the `transcode()` helper (line 1592) and the `EncodeOpts`. **In profile mode the opaque flag would be silently dropped** → no channel drop, the finding promises a saving the fix doesn't deliver (honesty violation under a real config).

**Resolution (locked):** Thread `op.opaque` into BOTH paths:
- **Standard path (1592):** `transcode(bytes, eff.targetMime, { ...encOptsFor(eff,false), opaque: op.opaque })`. The `transcode()` helper (2733) composes onto an opaque canvas when `enc.opaque` (fill `#000` + drawImage, or `getContext('2d',{alpha:false})`).
- **Fan-out path (1560):** when `op.opaque`, the decode-to-canvas at 1566-1576 must compose opaque BEFORE `emitLooseProfileFanout` — simplest: after `c2d` is obtained, if `op.opaque` set `c2d.fillStyle='#000'; c2d.fillRect(0,0,w,h)` is wrong order (drawImage would overwrite). Correct: fill THEN drawImage. Restructure to fill-before-draw, or build the canvas via `{ alpha:false }`. The per-format `EncodeOpts` inside the fan-out (`feToEncodeOpts`) must also carry `opaque` so the @jsquash getImageData path (below) sees 255 alpha.

If threading through the fan-out is judged too invasive for v1, the **honest fallback** is: in profile mode, do NOT set `opaque` (emit a plain transcode), and the analysis finding must NOT have fired — but the finding fires from analysis regardless of fix mode, so this fallback would over-promise. Therefore **fan-out threading is v1-REQUIRED, not optional.** (Effort bump: this is why effort is medium-HIGH, not medium — see below.)

## MAJOR 4 — `{ alpha:false }` / opaque-canvas does NOT guarantee the @jsquash encoders drop alpha

The draft notes this for native PNG but understates it for the primary targets. `encodeCanvas` (2656-2716) routes AVIF (always) and lossless WebP through `@jsquash`, which encode from `c2d.getImageData(...).data` — a Uint8ClampedArray whose **4th byte is still present**. An opaque canvas yields alpha=255 bytes; `getImageData` returns them; `@jsquash/avif` and `@jsquash/webp` are *called with those 255s*. Whether the channel is actually omitted depends on the codec:
- `@jsquash/avif` with `qualityAlpha:-1` (current default, line 2667) tracks `quality`; an all-255 alpha plane costs near-zero but the channel may still be encoded. Real saving ≈ recompression + trivial alpha, NOT a guaranteed full channel-drop.
- Native `convertToBlob({type:'image/webp'})` from an opaque canvas DOES drop alpha (the browser knows the canvas is opaque only if created with `{alpha:false}`; a black-filled `{alpha:true}` canvas may keep it).

**Resolution (locked):** Compose via `getContext('2d', { alpha: false })` (a genuinely opaque canvas, the strongest signal to both native and getImageData paths), NOT a black-fill on an alpha canvas. The DISK saving is whatever is **measured** — the receipt's `diskBytesAfter` is real (`fix.worker.ts:1603-1604` hashes the actual emitted bytes). Honesty holds because the FREE finding's `estimate.diskBytesSaved` comes from the analysis-side `encodeOpaque` sizer using the **same opaque-canvas technique**, so the estimate and the fix use the identical encode path ⇒ the estimate is an honest prediction of the same operation. Document in copy: "removes the dead alpha channel where the format supports it; PNG keeps a constant (near-free) channel." No false saving is ever claimed (gated by `minDiskSaving`, and the receipt measures reality).

> **Determinism note added:** because the estimate (analysis `encodeOpaque`) and the fix both use `{alpha:false}` + the same target mime + same quality, they are the same deterministic encode. The test seam mocks `encodeOpaque` to fixed bytes (no real codec), preserving the existing determinism scope.

---

## MINOR / accepted as-is
- **Single full pass, no early-exit** for `alphaStats` — accepted. The draft already self-corrected to this; exact fractions need a full count and it's strictly cheaper than the existing `makeEncoder` full decode+encode. ✓
- **`alphaStats` lives in `perceptual.ts`** — accepted (next to `isSolidColor`, unit-testable headless, matches the "pure math here" convention at the file header).
- **VRAM omitted from the finding** — accepted. `estimate.diskBytesSaved` only; VRAM in prose. Matches `solidFillFinding` (which does the inverse: VRAM-only, no disk). ✓
- **Atlas/JPEG guards, fully-transparent → solid-fill ownership, no overlap** — accepted, all verified against the loose-only `solidByRef` pattern (`analyze.ts:135-138`).
- **`makeOpaqueEncoder` as a second injected `EncodeSizer`** — accepted; keeps the `EncodeSizer` signature stable for the CLI caller (which passes neither ⇒ no fire). The opaque encoder must use `{alpha:false}` per MAJOR 4.

## Effort re-estimate: **medium → medium-HIGH**
The draft said "medium." The profile fan-out threading (MAJOR 3) + the two-path opaque compose + the `{alpha:false}` correctness work (MAJOR 4) push this above a clean medium. Still a single bounded feature, no new op kind, no backend — but T8 is meatier than the draft implies.

---

## EXACT ADDITIVE CONTRACT CHANGES (`packages/core/src/index.ts`) — unchanged from draft except FixOp comment

1. `Rule` union (`:84` neighborhood) — add `| 'wasted-alpha'`.
2. `ImageFeatures` (`:346-360`) — add optional `alphaMin?`, `fractionOpaque?`, `fractionClear?` (only `fractionOpaque` drives v1; other two recorded for a future rule).
3. `ThresholdConfig` (`:468-494`) — add optional `wastedAlpha?: { opaqueFrac: number; minDiskSaving: number }` after `solidFill?`. Browser-only (NOT added to `resolveThresholds`).
4. `FixOp.transcode` (`:551`) — add additive `opaque?: boolean`. Corrected comment: "Compose onto an OPAQUE `{alpha:false}` canvas before encode to `targetMime`, dropping the dead alpha channel where the format supports it (DISK-only; runtime owns GPU internalFormat — invariant 5). Absent/false ⇒ today's alpha-preserving transcode."

All absent ⇒ byte-identical.

---

## ORDERED TASK BREAKDOWN (small commits — corrections folded in)

| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|-----------|
| T1 | Core contracts: `Rule += 'wasted-alpha'`; `ImageFeatures.{alphaMin,fractionOpaque,fractionClear}?`; `ThresholdConfig.wastedAlpha?`; `FixOp.transcode.opaque?` (corrected comment) | `packages/core/src/index.ts` | core | — | all additive/optional; `pnpm typecheck` green |
| T2 | Config default `wastedAlpha:{opaqueFrac:0.999, minDiskSaving:0.05}` (mark CALIBRATE); **verify** `resolveThresholds` enumeration still omits it (no edit) | `packages/analysis/src/config.ts` | analysis | T1 | in DEFAULT_THRESHOLDS; CLI still suppresses (no resolveThresholds change) |
| T3 | Pure `alphaStats(rgba): {alphaMin,fractionOpaque,fractionClear}\|null` (single pass, n===0 ⇒ null) | `apps/web/src/lib/perceptual.ts` | analysis | T1 | exported; unit-testable |
| T4 | Pure `wastedAlphaFinding` (estimate.diskBytesSaved ONLY; `messageKey:'wasted-alpha'`; mime/threshold/minDiskSaving/no-encoder guards) + export | `packages/analysis/src/rules.ts`, `index.ts` | analysis | T1,T2 | null below gates / jpeg / no-encoder; warn when fires |
| T5 | Wire into `analyze` LOOSE branch (after addFormat); `AnalyzeDeps.encodeOpaque?`; build `opaqueFracByRef`; bump `potentialDiskSaved` | `packages/analysis/src/analyze.ts` | analysis | T4 | loose opaque ⇒ finding; atlas ⇒ none; absent deps ⇒ byte-identical |
| T6 | Worker analysis: `fullFrameAlpha` via `alphaStats` (loose alpha-mime only, `{alpha:false}` not needed for read — keep alpha-true decode to MEASURE alpha); set feature fields; `makeOpaqueEncoder` using `getContext('2d',{alpha:false})`; pass `encodeOpaque` to `analyze` | `apps/web/src/worker/analyze.worker.ts` | web | T3,T5 | no atlas decode; one extra full decode budgeted; ≤10s |
| T7 | **Plan (corrected B1+B2):** build `opaqueRefs` set; `format` transcode gains `opaque:true` when ref∈opaqueRefs; NEW branch emits a standalone `opaque` transcode (to `opts.targetMime`, NOT source mime) for wasted-alpha-only refs; local `transcoded` set ⇒ exactly one op/ref; honor resized/dropped/packed/tiered guards | `packages/fix/src/plan.ts` | fix | T1 | one transcode op/ref carrying opaque:true; never emits to source mime |
| T8 | **Fix worker (corrected M3+M4):** `EncodeOpts.opaque?`; opaque compose via `{alpha:false}` in the `transcode()` helper AND the standard transcode handler (1592); thread `opaque` into the profile fan-out path (1560 decode + `feToEncodeOpts`); op label `(opaque)`; honest measured delta; encode-fail ⇒ existing skip | `apps/web/src/worker/fix.worker.ts` | web | T1,T7 | opaque file emitted in BOTH plain & profile modes; no fake VRAM |
| T9 | Tests: `wastedAlphaFinding` + `analyze` threading + atlas-parity + absent-deps; `alphaStats` units; `planFix` op + **B2 dedupe** (format+wasted-alpha ⇒ one op, opaque:true; targetMime===opts.targetMime) | `packages/analysis/test/analysis.test.ts`, `apps/web/src/lib/perceptual.test.ts`, `packages/fix/test/plan*.test.ts` | test | T4-T8 | `diskBytesSaved` exact; `vramBytesSaved===undefined`; dedupe + targetMime asserted |
| T10 | i18n `find.wasted-alpha.{title,detail,fix}` ×9 (VRAM angle in detail PROSE); add `'wasted-alpha'` to `render.test.ts` `realFindings()` + keys `Set` (`:65`) | `packages/i18n/src/catalogs/*.json`, `test/render.test.ts` | i18n | T4 | completeness ×9 + drift guard green |
| T11 | Design doc `docs/improvements/round14-wasted-alpha.md` (locked decisions incl. the 4 corrections) | `docs/improvements/round14-wasted-alpha.md` | docs | — | committed |
| T12 | Invariant + full green gate (`check-invariants`; `pnpm test/typecheck/lint`) | — | gate | all | green |

**Commit grouping:** (T1) · (T2+T3+T4+T5) · (T6) · (T7) · (T8) · (T9) · (T10) · (T11). T12 = gate.

**Locked decisions (corrected):**
1. Loose-only; atlas never fires (verified `solidByRef` loose-only precedent).
2. `fractionOpaque` drives v1; `alphaMin`/`fractionClear` recorded only.
3. `estimate.diskBytesSaved` ONLY; VRAM is prose (invariant 5).
4. REUSE `transcode` FixOp + additive `opaque?` (no new op kind).
5. **Transcode emits to `opts.targetMime`, NEVER source mime** (B1 — plan has no source mime; matches existing format-op model).
6. **Dedupe via pre-built `opaqueRefs` set + local `transcoded` set** — order-independent (B2).
7. Opaque compose via **`getContext('2d',{alpha:false})`** in BOTH the standard transcode path AND the profile fan-out path (M3+M4); same technique in `makeOpaqueEncoder` so estimate==fix encode.
8. Full single pass on alpha-mime loose images only (deterministic, no early-exit).
9. `wastedAlpha` browser-only (NOT in `resolveThresholds` — already omitted by its explicit enumeration).

**Key file references (verified):** `apps/web/src/worker/analyze.worker.ts:105-124` (9×8 gap), `:126-145` (makeEncoder → mirror for makeOpaqueEncoder with `{alpha:false}`); `apps/web/src/lib/perceptual.ts:99-115` (hasHardAlpha — both-poles requirement = why opaque is invisible), `:82-92` (isSolidColor — alphaStats sibling); `packages/analysis/src/rules.ts:131-154` (solidFillFinding VRAM-only precedent), `:201-258` (formatFinding EncodeSizer); `packages/analysis/src/analyze.ts:85-95` (solidByRef + addFormat), `:135-139` (loose branch); `packages/analysis/src/config.ts:20-22` (solidFill default); `packages/budget/src/config.ts:102-110` (resolveThresholds explicit enumeration — auto-omits wastedAlpha); `packages/fix/src/plan.ts:255-270` (pass-2 transcode — emits `opts.targetMime`, no source mime); `apps/web/src/worker/fix.worker.ts:1552-1625` (transcode handler — TWO paths: fan-out 1560-1589 + standard 1592), `:2619-2741` (EncodeOpts/encodeCanvas/transcode — @jsquash getImageData paths); `packages/core/src/index.ts:346-360` (ImageFeatures), `:468-494` (ThresholdConfig), `:551` (FixOp.transcode); `packages/i18n/src/catalogs/en.json:87-101` (solid-fill/format precedent); `packages/i18n/test/render.test.ts:36-65` (realFindings + keys Set drift guard); `docs/improvements/round6-f2-solid-fill.md` (sibling template).