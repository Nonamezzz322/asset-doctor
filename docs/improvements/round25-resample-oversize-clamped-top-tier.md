# R25 #2 — Resample the oversize-clamped TOP tier (effectiveScale<1) — close the r24#0 gap

## Premise (VERIFIED against apps/web/src/worker/fix.worker.ts, branch feat/asset-pipeline)

- 3114–3119 `clampToMaxEdge`: shrinks the longest edge when > opts.maxEdge, else identity (fresh copy).
- 3172 `top = clampToMaxEdge(srcSize)`; 3168–3170 `srcBmp = await createImageBitmap(...)`, `srcW = srcBmp.width`, `srcH = srcBmp.height`.
- 3195 `effectiveScale = (top.w / srcSize.w) * tier.scale`.
- 3197–3199 `dst` = `scaleAtlas(atlas, effectiveScale).size` (atlas) or `scaleLoose(top, tier.scale)` (loose). `scaleLoose` (packages/fix/src/scale.ts:38) returns identity for scale >= 1, so the loose top tier dst = top = the clamped (smaller-than-src) size.
- 3211 `c2d.drawImage(srcBmp, 0,0, srcW,srcH, 0,0, dst.w,dst.h)` with imageSmoothingQuality high — the browser already pays this downscale on the clamped top tier (tier.scale===1, dst < src).

The `tier.scale < 1` data-flow guards are EXACTLY TWO (3251/3290 are comments, 551 is the unrelated profileHasLowerTier gate):
- 3292 `if (resampleEnabled && tier.scale < 1)` -> pushes into resampleTierTargets.
- 3409 `if (resampleHashSkipPending && tier.scale < 1 && ...)` -> honest hash-skip note.

CORRECTION to the original draft (MAJOR — site inventory incomplete, NOT a logic error): there is a THIRD resample-collection site at 3395 — `if (resampleEnabled && resampleTierTargets.length > 0) recordResampleCandidate(...)`. It is NOT a tier.scale<1 site; it is gated on resampleTierTargets.length > 0, and that array is populated ONLY at 3292. Therefore fixing 3292 transitively enables 3395 for the top tier with NO edit at 3395. The implementer MUST understand 3395 is the actual recordResampleCandidate and verify it inherits the fix (it does, because resampleTierTargets is now non-empty on the clamped top tier). Do NOT redundantly edit 3395; add a one-line comment noting the transitive inheritance.

The bug is genuine: on the oversize-clamped top tier effectiveScale<1, dst<src, the browser runs the worse-kernel downscale, yet the lanczos3 candidate is skipped and (under hashFilenames) no honest note is emitted — invisible.

## V1 SCOPE

In scope. Compute one per-tier local `tierIsDownscale = dst.w < srcW || dst.h < srcH` after dst is assigned (after 3199). Replace the `tier.scale < 1` guard at 3292 and 3409. Site 3395 is left textually unchanged and verified to inherit the fix (its resampleTierTargets.length > 0 gate is now satisfied on the clamped top tier). The entire downstream post-pass (3766–, the candidate loop: full-res PNG re-encode -> encodeRemote resample targetW targetH -> hfEnergy gate at 3848 -> byte-stable in-place replace at 3858) is tier-identity-agnostic (it reads only targetW/H/srcBytes/browserTile/targets) and handles the top-tier candidate unchanged. Extend apps/web/test/tier-worker.test.ts to model the candidate signal and prove the op fires on the clamped top tier and does not over-fire when un-oversized.

Out of scope (unchanged from r24). No new kernels; the three non-tier downscale sites (format-only fanout 3484, etc.) keep the browser resampler; no gateway/sidecar/protocol change; no new i18n (skip reasons are raw strings in skipped[], no catalog touch); resample stays fully opt-in (resampleOn gate: backend+consent+ops.includes resample +host/token+hashFilenames OFF) so the DEFAULT PATH IS BYTE-IDENTICAL; the hashFilenames-ON branch keeps the existing honest skip (now extended to the top tier).

## The downscale signal (the only real decision)

Decision: `tierIsDownscale = dst.w < srcW || dst.h < srcH` computed once after line 3199.

Rationale: srcW/srcH are the decoded srcBmp dims (3169–3170) — the literal drawImage source rectangle (3211). dst is the literal destination. So the comparison is the EXACT truth condition for the browser ran a downscale on this drawImage. effectiveScale < 1 is a correct alias in all well-formed cases, but effectiveScale mixes srcSize (parsed-analysis dims) with top, whereas dst<srcBmp measures the operation that actually happened — robust if a malformed manifest srcSize ever diverges from the real PNG. The rejected `dst < top` form is the bug class (top-tier dst==top => never fires on the clamped top tier).

Comment to add at the signal site (no apostrophes/backticks in your committed comment is fine, normal code comment):
- round24 r24#0 follow-up: the browser drawImage at :3211 downscales whenever dst < the DECODED source rect (srcW/srcH = srcBmp dims). This fires on the OVERSIZE-CLAMPED top tier too — tier.scale===1 yet effectiveScale<1 from clampToMaxEdge => dst<src — exactly where high-quality downscale matters MOST and the old tier.scale<1 guard silently fell back to the browser kernel.

- 3292: `if (resampleEnabled && tierIsDownscale)`
- 3409: `if (resampleHashSkipPending && tierIsDownscale && emittedThisTier.size > 0 && !resampleHashSkipNoted.has(ref))`
- 3395: UNCHANGED (resampleEnabled && resampleTierTargets.length > 0) — inherits the fix; add a one-line comment.

## Contract / type changes
NONE. No core / fix-protocol / wire change. ResampleTarget/ResampleCandidate (worker-local 1128–1140), FixReceipt, backendNative[].op resample, encodeRemote resample all identical. The candidate set gains a top-tier member (same shape) when the source was oversize-clamped.

## Pure modules / signatures
NONE changed. resampleOn/resampleSkippedByHashFilenames (resample-collect.ts) and hfEnergy/aggregateHfEnergyDelta (resample-quality.ts) untouched — eligibility gates; the new signal is per-tier applicability in the impure tier loop (needs dst/srcW). No drift to the Node-tested predicates.

## Worker / UI / backend changes
- Worker: one new local tierIsDownscale + two guard swaps (3292, 3409). Fix the now-false comments at 3251 (the tile.scale<1 guard ... skips the top tier scale 1 no downscale) and 3290 (only for a real downscale — tier.scale<1) to describe the dst<src signal and explicitly state it fires on the clamped top tier. Optionally add a one-line note at the 3389 comment block that its resampleTierTargets.length>0 gate now admits the clamped top tier.
- UI: none. App.tsx op resample arm renders qualityHfEnergyDelta regardless of source tier.
- Backend: none. encodeRemote resample c.targetW c.targetH already receives the clamped top-tier dims as the output box; sidecar is op-agnostic on tier identity (r24#0 resample_test.go/server_test.go already cover the op).

## Honesty / invariant compliance
- Inv 5 (disk!=VRAM): unchanged — resample is dims/format/path-stable; the post-pass replaces the browser tile in place at the same dst, carries only qualityHfEnergyDelta, never touches vramSaved (the 0-vramSaved tier invariant, T13, is untouched).
- Inv 3 (measure, no verdict): the hfEnergy Laplacian-retention delta (3846–3848) is unchanged MEASURED quality; <=0 delta => keep browser tile with an honest skipped[] note (3852). The clamped top tier now gets that same honest treatment instead of a silent worse-kernel downscale.
- Inv 1 and 2 (opt-in, thin backend): resampleEnabled still requires the full gate; default path byte-identical (resampleEnabled=false => recordResampleCandidate is a no-op (1143) => post-pass resampleCandidates.length>0 false => never runs). The new signal only widens which tiers are candidates when already opted in.
- The fix CLOSES dishonesty: today the opted-in user gets the worse kernel on the most-impactful (oversized) page with neither a candidate nor a skip note. After: resampled, or honestly noted (including the hashFilenames-ON case, a second hole the 3409 swap closes).

## Determinism
Preserved. tierIsDownscale is integer comparison of two deterministically-derived dims (scaleLoose/scaleAtlas golden-tested pure; srcW/H from createImageBitmap of fixed bytes). Candidate push order unchanged (tier-iteration order). No Date.now/Math.random. The 3409 Set-dedupe-per-ref stays order-stable.

## Edge cases (re-verified against the real helpers)
1. Oversized loose top tier, tier.scale===1 (target): top=clampToMaxEdge(src)<src, dst=scaleLoose(top,1)=top (identity at scale>=1), dst<srcW => tierIsDownscale=true => one candidate. gap closed.
2. Non-oversized top tier: top=srcSize, dst=scaleLoose(top,1)=top=src => tierIsDownscale=false => no candidate. no spurious upload.
3. Lower tiers (tier.scale<1): always a real downscale => true => unchanged.
4. Atlas top tier oversized: dst=scaleAtlas(atlas, effectiveScale).size, effectiveScale<1 shrinks the sheet => dst<src => candidate; any-axis || fires even if 1px-floor rounding pins one axis.
5. hashFilenames ON + oversized top tier: previously NO note (silent); now tierIsDownscale => existing honest 3409 note fires for the clamped top tier. second hole closed.
6. Spine page top tier (PNG, oversized): clamped top tier is a real PNG downscale => candidate => post-pass re-encodes to PNG (Spine-stays-PNG enforced in the encode list).
7. Non-square oversize (e.g. longest=h): clampToMaxEdge scales both axes => both shrink => fires on both.
8. Site-3395 propagation: with 3292 fixed, resampleTierTargets is non-empty on the clamped top tier => 3395 recordResampleCandidate fires => post-pass picks it up. (the load-bearing transitive correctness.)

## Test plan (real harness; defect reproduced through the REAL clamp path; CONFIRM the op FIRES)

runTierLoop (124–218) currently models NO resample. Extension:
1. Model the candidate signal in runTierLoop. Add resampleCandidates: { ref; targetW; targetH }[] to TierResult and compute tierIsDownscale = dst.w < srcW || dst.h < srcH with srcW = srcSize.w, srcH = srcSize.h (the honest Node stand-in for srcBmp dims — the exact dims a well-formed source carries). Push a candidate whenever resampleEnabled && tierIsDownscale (add a resampleEnabled param defaulting false so the off-path is proven empty).
2. Drive the clamp. Parameterize the hard-coded maxEdge = 1 << 20 (line 139). Fixture dims confirmed: banner.png = 100x50 (loose, cleanest subject), sheet.png = 128x128 (largest), meshed=128x64, spine pages=64x64. Set maxEdge = Math.floor(Math.max(banner.w, banner.h) * 0.6) from sizeByRef => 60 — self-calibrating, no magic number, clamps banner top via the REAL clampToMaxEdge (already mirrored 154–159) to {60,30}. Note: maxEdge=60 also clamps sheet (128->60) etc.; the tests assert per-ref on banner only (filter candidates by banner clamped dims), so the cross-asset clamp is harmless. Reproduces r24#0 through the real clamp: banner top tier tier.scale===1, dst={60,30} < src={100,50}.
3. T14 — top-tier clamp produces a top-tier candidate (CONFIRM the op FIRES). maxEdge=60, resampleEnabled=true: compute clampedTop = clampToMaxEdge(banner) and assert res.resampleCandidates.some(c => c.targetW === clampedTop.w && c.targetH === clampedTop.h) === true — the scale-1 / _1080p tier dims. This is the assertion the old tier.scale<1 model FAILS (no top-tier candidate) and the fix passes. Also assert banner candidate count === 3 (top clamped + two lower tiers all downscale).
4. T15 — no top-tier candidate when NOT oversized (over-fire guard). maxEdge=1<<20, resampleEnabled=true: for banner, assert NO candidate has targetW===banner.w && targetH===banner.h (the un-clamped top tier), while the two lower tiers DO produce candidates (count===2 for banner). Proves edge case 2.
5. T16 — gate-off byte-identical. resampleEnabled=false => res.resampleCandidates.length === 0 for any maxEdge. Proves the default path is untouched.
6. Equivalence assertion (documents the WHY). For banner clamped top tier in the test, assert BOTH (clampedTop.w/banner.w)*1 < 1 AND clampedTop.w < banner.w || clampedTop.h < banner.h are true.
7. No new backend surface to confirm: the vips resample op + encodeRemote resample w h are shipped/tested (r24#0). Zero backend surface added.

Run: pnpm --filter @asset-doctor/web test tier-worker + pnpm typecheck + full pnpm test.

## ORDERED TASK BREAKDOWN (small commits — but final delivery is ONE commit by the orchestrator)
1. test(fix): tier-worker — model the resample downscale signal + parameterize maxEdge (RED). In runTierLoop: add resampleCandidates to TierResult + a resampleEnabled param (default false) + compute tierIsDownscale = dst.w < srcW || dst.h < srcH with srcW=srcSize.w, srcH=srcSize.h; parameterize maxEdge (default 1<<20). Add T14/T15/T16 + the effectiveScale<->dst equivalence assertion, using maxEdge = floor(max(banner.w,banner.h)*0.6)=60 from sizeByRef (banner confirmed 100x50). T14 must FAIL against a model of the old tier.scale<1 guard, then flip the model alongside the worker fix.
2. fix(fix): resample the oversize-clamped top tier — replace tier.scale<1 with dst<src (r24#0). In fix.worker.ts: add const tierIsDownscale = dst.w < srcW || dst.h < srcH; after line 3199; swap the guard at 3292 and 3409 (tier.scale < 1 -> tierIsDownscale); leave 3395 unchanged and verify its resampleTierTargets.length>0 gate now admits the clamped top tier (add a one-line comment). Correct the now-false comments at 3251 and 3290. Flip the task-1 test model to tierIsDownscale (GREEN).
3. docs: CHANGELOG/FEATURES.

No deploy, no i18n, no contract migration. Verification: pnpm test (esp. tier-worker) + pnpm typecheck green; the two existing resample test files unchanged.

Key load-bearing files (absolute):
- /home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts — signal local after :3199; guards at :3292 and :3409; the recordResampleCandidate site at :3395 (transitively fixed, verify); stale comments at :3251, :3290; tier-agnostic post-pass at :3766–.
- /home/nonamezzz/Рабочий стол/projects/apps/web/test/tier-worker.test.ts — runTierLoop (:137–218, maxEdge :139, clampToMaxEdge :154–159), new T14–T16.
- /home/nonamezzz/Рабочий стол/projects/packages/fix/src/scale.ts — scaleLoose :38 (identity at scale>=1). UNCHANGED.
- /home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/resample-collect.ts — gate predicates. UNCHANGED.
- /home/nonamezzz/Рабочий стол/projects/fixtures/sample-projects/tier-source/banner.png — 100x50 oversize subject (clamped via maxEdge=60).

NOTE: line numbers are from the design snapshot and may have drifted slightly; locate the guards by the `tier.scale < 1` text + surrounding context, not by absolute line number.
