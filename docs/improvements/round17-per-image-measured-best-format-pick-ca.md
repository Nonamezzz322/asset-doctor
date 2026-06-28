I have a complete, code-grounded picture. Note the existing format test mock `async () => 4000` returns a constant for **both** targets — so AVIF (iterated first) always wins under the current mock (tie/equal keeps first). The draft's test plan correctly calls for an encoder that differentiates AVIF vs WebP to assert `bestMime`. All premises verified. Producing the revised design.

---

# Per-image MEASURED best-format pick — Mini-Design (REVISED, adversarially verified)

## 0. Verdict on the premise: TRUE and shippable

Every load-bearing claim in the draft checks out against the source. The two facts that make this feature non-fake:

1. **`formatFinding` already measures both candidates** (`rules.ts` L264–270) and discards the winning mime — only the `FORMAT_LABEL[best.mime]` string survives (L295/L310). Adding `bestMime: best.mime` records what was already computed. No new encode.
2. **The fix worker re-runs `analyze` with its own encoder** (`fix.worker.ts` L276: `analyze(merged, ..., { encodeImage: makeEncoder(bytesByRef) })`) and feeds that fresh `report` into `planFix` (L383). The fix-time `makeEncoder` (L2654) is **byte-for-byte identical** to the diagnosis one (`analyze.worker.ts` L162): same `createImageBitmap → OffscreenCanvas → convertToBlob({quality:0.9})`, same `blob.type === targetMime ? size : null` codec-fallback rejection. So the winner the plan reads at fix time **is the same measurement** shown at diagnosis. The premise's "the win was already measured" is literally true on the same code path.

The draft's load-bearing caveat — the worker does **not** read `op.targetMime` (it recomputes `effectiveFor(ref,1)` at L1610) — is confirmed. The seam must be threaded through `resolveOptions`, not assumed direct.

**No blocker found that kills the feature.** Several majors/minors below sharpen scope, correct two factual slips in the draft, and fix the test plan, which as written cannot pass on the existing harness.

---

## 1. Corrections to the draft (blockers/majors)

### M1 — `bestMime === source` is NOT impossible (draft §7.3 is wrong, but harmless)
The draft claims a no-op pick is impossible. **Counter-evidence:** `FORMAT_TARGETS = ['image/avif','image/webp']`; the loop **skips `target === image.mime`** (L266). For a WebP source, the only candidate is AVIF; for a PNG/JPEG source, both. So `best.mime` can never equal `image.mime` **for that reason** — the draft's conclusion holds, but the *stated* reason (the AVIF early-return at L263) is only half of it. The real guarantee is **L266's `continue`** plus the AVIF early-return. This is a comment-accuracy nit, not a behavior bug. **Resolution:** state the correct reason in the plan comment; no code consequence. `isImageMime` guard makes even a hypothetical equal-mime fall through to a real (re-)encode that the worker's own size accounting handles.

### M2 — The export-profile gate claim needs one more clause (draft §3c)
Draft says "when `profileOn`, the handler `continue`s at L1575 before reaching L1610." Confirmed at L1575: `if (profileOn && !profileOwned.has(ref) && !atlasByRef.has(ref)) { … continue; }`. **But** an **atlas ref** (`atlasByRef.has(ref)`) under `profileOn` does NOT take the fan-out — it falls through to L1610. That's fine because **atlases never carry `bestMime`** (caller passes `'unknown'`; and atlas format findings are folder-scoped / absent per the M1 atlas test), so `perImageMime` falls back to `opts.targetMime` ⇒ identical to today. **Resolution:** the gate is correct, but document it as "non-fanned-out transcode ops only; atlases reach the seam but have no `bestMime` ⇒ fallback." No extra guard needed.

### M3 — Test plan is BROKEN on the existing worker harness (draft §8, major)
`plan-worker.test.ts` (and `tier-worker`) **analyze WITHOUT an encoder** by design (file header L5–6: "This Node mirror analyzes WITHOUT an encoder"). With no encoder, `formatFinding` returns `null` (L263 `!encode`) ⇒ **zero format findings ⇒ zero `bestMime`** ⇒ the worker-seam assertion the draft proposes there can never fire. **Resolution:** test the worker seam where it is actually pure and cheap — `resolveOptions`/`effectiveForTranscode` in `packages/fix/test/settings.test.ts` is the wrong layer (the helper lives in the worker). Instead:
   - Unit-test the **plan routing** (the real decision point) in `packages/fix/test/plan.test.ts` with a hand-built report carrying `params.bestMime` — no encoder needed, fully pure.
   - Add a **focused worker test** (`apps/web/test/best-format-worker.test.ts`, NEW) that mirrors `plan-worker`'s in-process pattern but **supplies a differentiating encoder mock** (`async (_ref,_src,target) => target === 'image/avif' ? 6000 : 7000`) so `formatFinding` actually fires, then asserts that the worker's `effectiveForTranscode(ref, op.targetMime)` resolves `eff.targetMime` to the per-image winner and that a per-folder override still wins. This is the only place the seam is genuinely exercised.

### M4 — The existing constant-encoder mock would make a per-image test vacuous (minor→major for analysis test)
`analysis.test.ts` format mocks return a **constant** (`async () => 4000`) for both targets. Under the strict-smaller pick (`bytes < best.bytes`), a tie keeps the **first iterated = AVIF**. So the *new* analysis tests MUST use a **differentiating** mock or they only ever prove `bestMime === 'image/avif'` and never exercise the WebP-wins branch. **Resolution:** the §8 analysis tests below take an explicit `(_ref,_src,target) => …` mock.

---

## 2. V1 Scope / Out-of-scope (unchanged from draft, re-confirmed)

**In scope:** (1) `formatFinding` records `bestMime` on both branches; (2) `plan.ts` `bestFormatPerImage` opt routes the **pass-2 LOOSE format transcode** to `f.params.bestMime` (guarded), default OFF; (3) worker honors per-op mime via a `resolveOptions`-base helper; (4) one `App.tsx` checkbox; (5) tests.

**Out of scope (verified each is correctly excluded):**
- **Profile fan-out** (`emitLooseProfileFanout`, L1575–1607) — deliberate multi-format superset; per-image single-best is meaningless. Worker-gated by construction (M2).
- **resize op** (worker L1515–1565, plan L269–281) — `bestMime` was measured on the **full-size** source at q0.9; a downscaled re-encode is a different measurement. Keeps `opts.targetMime`. Confirmed: resize op has no `bestMime` plumbing and the plan guard only touches the `f.rule === 'format'` branch.
- **Atlas / repack / pack / merge** — no per-sheet format measurement (`formatFinding` early-returns for atlases via `'unknown'`; atlas refs aren't loose). `bestMime`-absent fallback covers them free.
- **opaque-alpha interplay** — orthogonal: per-image changes only `targetMime`, never `opaque`/`lossless` (L313 untouched).
- No UI redesign beyond one checkbox; no backend.

---

## 3. Contract / type changes (additive only)

### 3a. `packages/core` — NO change
`FindingParams = Record<string, string | number>` (L317) already admits a string; `ImageMime` ⊆ `string`. `bestMime` rides as a string param exactly like the existing `target`/`contentClass`. Do **not** widen to an interface (broader than this feature; mirrors established convention).

### 3b. `PlanOptions` (`plan.ts`) — one additive optional field
```ts
/** Per-image MEASURED best-format pick (user-value parity). formatFinding ALREADY measured every
 *  candidate (FORMAT_TARGETS) and now records the winner in params.bestMime. When ON, the pass-2 LOOSE
 *  `format` transcode op targets that measured winner instead of the single global opts.targetMime;
 *  absent/invalid bestMime (atlas / no measurement / OFF) ⇒ opts.targetMime. The plan does NO encoding.
 *  Export-profile fan-out is untouched (worker-gated). DEFAULT OFF ⇒ every op carries opts.targetMime
 *  ⇒ byte-identical to today. */
bestFormatPerImage?: boolean;
```

### 3c. `FixOp.transcode` — NO shape change
Already carries `targetMime: ImageMime` (core L589). The flag only changes *which* mime is stamped.

### 3d. `FixOptions` (`apps/web/src/worker/fix-protocol.ts`) — one additive field
Add `bestFormatPerImage?: boolean;` beside `opaqueAlpha?` (L47). (Note: the option bag is `FixOptions`, not "FixRequest" — draft naming slip.)

---

## 4. Pure-module impl

### 4a. `rules.ts formatFinding` — add `bestMime` to both `params`
- L295 (lossless): `…, contentClass, bestMime: best.mime }`
- L310 (lossy): `…, saved, bestMime: best.mime }`

Deterministic (mirrors `bestBytes`); no new encode; no new branch.

### 4b. `plan.ts` — pass-2 format branch routing + guard
Top of file (after imports):
```ts
const VALID_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/avif']);
const isImageMime = (v: unknown): v is ImageMime => typeof v === 'string' && VALID_MIMES.has(v);
```
In the L296–315 branch, before `ops.push`:
```ts
// Per-image MEASURED best-format pick. formatFinding ALREADY measured every candidate and recorded the
// winner in params.bestMime (never source-mime: the candidate loop skips target===image.mime). Honor it
// instead of the single global opts.targetMime when the opt is on AND the param is a valid ImageMime.
// Absent (atlas / no encoder) or malformed or OFF ⇒ opts.targetMime ⇒ byte-identical. NO encoding here —
// the plan routes the op to the format diagnosis already proved smaller.
const perImageMime =
  opts.bestFormatPerImage && isImageMime(f.params?.bestMime) ? (f.params.bestMime as ImageMime) : opts.targetMime;
```
then `targetMime: perImageMime` in the pushed op (replacing `opts.targetMime` **only** in this branch). Pass-0/0a/0b/1/2b untouched.

### 4c. Worker seam (`fix.worker.ts`) — honor per-op mime via resolve base
Next to `effectiveFor` (L453):
```ts
/** Effective options for a transcode op, honoring its per-image targetMime as the resolve BASE — so a
 *  user's per-folder/type override still WINS over it, but the plan's measured per-image pick replaces
 *  the global default. op.targetMime === opts.targetMime for every legacy op ⇒ identical to
 *  effectiveFor(ref,1) (scale 1 ⇒ scaleAwareQuality no-op) ⇒ byte-identical when bestFormatPerImage is OFF. */
const effectiveForTranscode = (ref: string, opMime: ImageMime): EffectiveOptions =>
  resolveOptions(ref, kindOf(ref), { ...baseEffective, targetMime: opMime }, opts.overrides);
```
At L1610: `const eff = effectiveForTranscode(ref, op.targetMime);` (replacing `effectiveFor(ref, 1)`). Everything downstream (`transcode`, size-loss guard, rename, owner bookkeeping) is unchanged — only the mime differs, and it's the already-measured winner. **Override precedence is honest**: explicit user per-folder `targetMime` > auto-measured per-image default (resolveOptions later-wins, base is the per-image pick).

### 4d. Wiring
- Worker `planFix` call (L383–407): add `bestFormatPerImage: opts.bestFormatPerImage,` beside `opaqueAlpha` (L395).
- `fix-protocol.ts`: §3d field.

---

## 5. UI

One checkbox in the Pro fix panel (`App.tsx`), cloning the `opaqueAlpha` toggle pattern exactly (state at L1235 `useState(false)`, prop at L520/533, `<input type="checkbox">` at L564–566). Default unchecked. i18n keys `fix.settings.bestFormat` / `fix.settings.bestFormatHint` added to the en catalog (source) + the 8 other locales (the i18n drift-test requires all-langs; en is the source). Honest copy: "Per-image best format (measured)" / "Transcode each image to the format our audit measured smallest (WebP vs AVIF), instead of one format for all." No new finding/overlay.

---

## 6. Honesty + invariants (re-verified)

- **Inv 3 (measure, don't generate):** we stop *overriding* a real measurement with a fixed ladder; `bestMime` is the `EncodeSizer`-measured winner. Nothing invented.
- **Inv 4 (OFF ⇒ byte-identical):** flag default OFF ⇒ `perImageMime === opts.targetMime` for every op (guard short-circuits on `opts.bestFormatPerImage` before touching `f.params`); `effectiveForTranscode(ref, opts.targetMime)` === `effectiveFor(ref,1)` (same base, same overrides, scale 1 no-op). CLI/headless never set the flag ⇒ unaffected. **Verified the constant: the only field changed is `targetMime`, and at OFF it equals the old value.**
- **Inv 5 (disk ≠ VRAM):** WebP/AVIF both decode to RGBA8888 — smaller *file* is a download win only. The receipt's measured before/after byte delta is the truth; no VRAM number attributed (matches L306 honest framing). The existing transcode size-loss accounting (L1629, opaque-scoped) and dedup/Phase-C accounting handle a non-shrinking general re-encode as today.
- **Inv 1–2 (browser/thin backend):** 100% browser, fix-side. No backend change. Bytes already in hand from the fix-worker's own analyze pass.

---

## 7. Determinism

- `formatFinding` iterates fixed `FORMAT_TARGETS`, strict-smaller pick ⇒ ties keep AVIF (first); `bestMime` inherits this. Same input ⇒ same winner.
- `plan.ts` routing is a pure Set-guarded param read; same report+opts ⇒ same op array.
- `resolveOptions` is pure, ordered-fold, no Date/random (settings.ts L75–96). Fix worker's `makeEncoder` is deterministic modulo the browser codec (same as diagnosis — already trusted).

---

## 8. Edge cases (corrected)

1. **`bestMime` absent** (atlas, no-encoder Node/CLI mirror, old cached report) → guard → `opts.targetMime`.
2. **Malformed `bestMime`** → guard rejects → `opts.targetMime`. Fail-safe.
3. **`bestMime === source mime`** — cannot occur: candidate loop `continue`s on `target === image.mime` (L266) **and** AVIF source early-returns (L263). (Draft's reason was incomplete — see M1.)
4. **Per-folder/type override sets a different `targetMime`** → override wins (layered on the per-image base). Intentional, honest precedence.
5. **Flat/alpha-art lossless** → `lossless` still forced (`opts.lossless || wantsLossless`, L302/309 unchanged); only `targetMime` changes. Winner was measured at lossy q0.9, so real lossless bytes differ — but the finding copy already discloses this (L291). The *choice* (WebP vs AVIF) stays measured.
6. **`opaque` + per-image** → both apply (independent fields). Worker opaque size-loss guard (L1629) still protects.
7. **Per-image winner's codec unavailable at fix time** → `transcode()` returns null → honest skip (L1615), as today. The fix-worker encoder == diagnosis encoder, so this is unlikely, but covered.
8. **profileOn** → fan-out branch first (L1575); seam reached only by atlas refs, which have no `bestMime` ⇒ fallback (M2). Profile path byte-identical.

---

## 9. Ordered task breakdown (small commits)

1. **`feat(analysis): record measured bestMime on format finding`** — add `bestMime: best.mime` to both `params` (rules.ts L295, L310). Extend `analysis.test.ts` format block with a **differentiating** encoder mock (AVIF=6000/WebP=7000 ⇒ `bestMime==='image/avif'`; AVIF=7000/WebP=6000 ⇒ `'image/webp'`; lossless branch present+correct). Pure, diagnosis-only.
2. **`feat(fix): plan opt bestFormatPerImage — route loose transcode to measured winner`** — add `bestFormatPerImage?` to `PlanOptions` + `isImageMime` guard + `perImageMime` routing (plan.ts). Default OFF. **New `packages/fix/test/plan.test.ts`** (or extend `fix.test.ts`): two loose format findings (`logo.png` bestMime=webp, `bg.png` bestMime=avif), opts.targetMime=webp → ON: ops carry webp & avif respectively; a third finding with no `bestMime` → opts.targetMime; OFF (default) → every op carries opts.targetMime and the op array deep-equals the pre-change baseline; atlas/resize findings under ON → still opts.targetMime; malformed bestMime → fallback. All pure, **no encoder needed**.
3. **`feat(fix-worker): honor per-op targetMime via resolveOptions base`** — add `effectiveForTranscode`; swap in at L1610; wire `bestFormatPerImage` into the `planFix` call (L395-adjacent) + `fix-protocol.ts` `FixOptions`. **New `apps/web/test/best-format-worker.test.ts`** mirroring `plan-worker`'s in-process pattern **with a differentiating encoder mock** (so `formatFinding` actually fires) asserting `effectiveForTranscode(ref, op.targetMime)` resolves the per-image winner AND a per-folder override still wins over it. (M3: this is where the seam is genuinely exercised — `plan-worker.test.ts` cannot, it runs encoder-free.)
4. **`feat(web): per-image best-format checkbox in Pro fix panel`** — clone the `opaqueAlpha` toggle in `App.tsx` (state L1235, prop L520/533, input L564), wire to fix request; add i18n keys to en + 8 locales (drift-test). Default off.
5. **`test: byte-identity regression`** — `pnpm test` green across analysis + fix + apps/web worker suites; spot-check OFF op arrays deep-equal baseline. Specifically re-run `export-profile-fanout.test.ts`, `settings.test.ts`, `plan-worker`/`tier-worker`/`selective-worker`/`dedup-worker-phase-c` (all OFF ⇒ unchanged).

---

## Key file references (all absolute, line-verified)
- `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/rules.ts` — `formatFinding` L255–312 (winner measured L264–270; candidate-skip L266; AVIF early-return L263; labels L295/L310).
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/plan.ts` — `PlanOptions` L10–55 (add field); `ImageMime` already imported L8; pass-2 format branch L296–316.
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/settings.ts` — `EffectiveOptions` L53; `resolveOptions` L75–96 (later-wins fold).
- `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` — `FindingParams` L317; `FixOp.transcode.targetMime` ~L589.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` — fix-time `analyze` L276; `planFix` call L383–407 (`opaqueAlpha` L395); `baseEffective` L436–444; `effectiveFor` L453–456; transcode handler L1567–1660 (seam L1610/1614); `profileOn` fan-out gate L1575–1607; fix-time `makeEncoder` L2654–2671 (== diagnosis encoder).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/analyze.worker.ts` — diagnosis `makeEncoder` L162–181 (the byte-identical twin).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` — `FixOptions` L14 (add `bestFormatPerImage` near `opaqueAlpha` L47).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` — `opaqueAlpha` toggle to clone: state L1235, prop L520/533, input L564–566.
- Tests: `/home/nonamezzz/Рабочий стол/projects/packages/analysis/test/analysis.test.ts` (format block L149–230 — **use a differentiating mock, not the constant `async()=>4000`**); `/home/nonamezzz/Рабочий стол/projects/packages/fix/test/plan.test.ts` (NEW); `/home/nonamezzz/Рабочий стол/projects/apps/web/test/best-format-worker.test.ts` (NEW — the only place the worker seam fires, requires an encoder mock); `/home/nonamezzz/Рабочий стол/projects/apps/web/test/plan-worker.test.ts` (analyzes encoder-FREE — header L5–6 — so it CANNOT test bestMime; keep as a byte-identity-OFF regression only).

**Load-bearing caveats (verified):** (a) the worker ignores `op.targetMime` today and recomputes `effectiveFor(ref,1)` at L1610 — the per-op mime must thread through `resolveOptions` as the base, the one part that's "more than a one-liner," but it adds **no new encode**. (b) The fix worker's `makeEncoder` is identical to diagnosis's, so the per-image winner read at fix time is the same one shown at diagnosis — the feature is honest end-to-end. (c) The proposed worker-seam test **cannot** live in `plan-worker.test.ts` (encoder-free by design); it needs its own file with a differentiating encoder mock.