I now have complete code-grounded verification. The premise is TRUE and the draft is substantially correct. I found several blockers/majors in the draft's i18n approach and one false claim about `renderCorrelated`'s existing variant handling. Here is my revised design.

---

# Mini-Design (REVISED): `correlateFix(receipt)` — measured before→after fix probe → one localized doctor's verdict

## Verdict on the draft

**Premise: TRUE and well-grounded.** Verified against real code:
- `packages/correlate/src/index.ts` exports only `correlate()`; its R1 emits a static guess `estimate.drawCallsAfter = idealDraws` (line 66). The CorrelatedFinding shape (lines 9-24), `params: FindingParams & { variant?: string }`, and `estimate.{drawCallsAfter,vramBytesSaved}` exist exactly as the draft claims.
- `SheetDiff.drawCallsBefore/After` + `decodedVramBefore/After` are populated by `attachSheetProbes` on the main thread (`sheet-probe-run.ts:87,103`) and live on `FixReceipt.sheetDiffs[]` (`fix-protocol.ts:277-285,363`).
- Layering is real: `correlate` deps are only `core`+`probe`; `FixReceipt` lives only in `apps/web`. The structural-input-type seam (§3) is the correct, minimal fix.
- `catalogs.test.ts` enforces all-9-locale key parity AND **per-key placeholder-token parity** (line 27, `tokens(lv)).toEqual(tokens(ev))`).

The draft is implementable. But it has **2 blockers and 3 majors** I'm fixing below, plus one **false claim** I'm correcting.

---

## BLOCKER 1 — The `renderCorrelated` "variant" branch the draft proposes does not match the renderer's real design

**False claim in draft §5:** "`renderCorrelated` already branches on `params.variant` indirectly via `staticVariant`/`subjectVariant`." It does **not**. Verified (`index.ts:165-173`): the renderer branches on `p.staticVariant`, `p.subjectVariant`, and `p.hitchMs` — there is **no** `params.variant` read anywhere. So the draft's "add a `mv = String(p.variant ?? '')`" is a genuinely new branch, not a piggyback. Not fatal, but the justification ("untouched live templates") must be earned by the structure, not assumed.

**Worse — the draft's per-field `_measured` suffix scheme (10 keys × `title/static/runtime/diag/fix`) is over-engineered and fights the placeholder-parity gate.** The existing renderer picks one of `title/static[_variant]/runtime[_hitch]/diag[_subj]/fix[_subj]`. The draft wants 5 `_measured` suffixes per rule. That's a lot of surface and every one must be mirrored × 9 with byte-identical placeholders.

**Decision — use the EXISTING `variant`-routing pattern with ONE new branch keyed on `p.variant === 'measured'`, applied uniformly.** Add a single helper that, when `mv` is set and `${k}.${suffix}_${mv}` exists, prefers it; else falls through to the current logic. This is **one** added line per rendered field (5 lines), and it generalizes the existing `static_${sv}` / `diag_${subj}` mechanism rather than inventing a parallel one:

```ts
const mv = String(p.variant ?? '');
const pickV = (suffix: string, base: string): string =>
  mv && has(`${suffix}_${mv}`) ? translate(locale, `${k}.${suffix}_${mv}`, p) : pick(suffix, base);
// then:
title:           mv && has(`title_${mv}`) ? translate(locale,`${k}.title_${mv}`,p) : pick('title', f.title),
staticEvidence:  sv && has(`static_${sv}`) ? … : pickV('static', f.staticEvidence),
runtimeEvidence: hitch && has('runtime_hitch') ? … : pickV('runtime', f.runtimeEvidence),
diagnosis:       subj && has(`diag_${subj}`) ? … : pickV('diag', f.diagnosis),
fix:             subj && has(`fix_${subj}`) ? … : pickV('fix', f.fix),
```
This **does not disturb** the live branches (`measured` findings carry no `staticVariant`/`subjectVariant`/`hitchMs`, so `sv`/`subj`/`hitch` are falsy ⇒ they skip straight to `pickV`; live findings have no `variant:'measured'` ⇒ `mv` is empty ⇒ `pickV` === `pick` === today). The renderCorrelated drift test (`render.test.ts:109-129`) keeps passing because those findings have no `variant`. **Verify this with a renderCorrelated regression: render every existing live finding and assert byte-identical output.**

## BLOCKER 2 — Placeholder-parity gate forces the EN templates' tokens to be reproducible across 9 locales; the draft's `corr.vram.title_measured` mixes `:mb` hinting that must be byte-identical everywhere

`catalogs.test.ts:27` requires `tokens(lv)).toEqual(tokens(ev))` — the **exact set of `{...}` tokens including the hint** (`tokens` greps `/\{[^}]+\}/g`, so `{decodedBefore:mb}` is one token and must appear verbatim in all 9 locales). This is fine, but it means:
- Every new `_measured` key's placeholder set must be **copy-pasted identically** into all 9 catalogs (translators may reorder text but not change `{x:hint}`).
- The draft's mixing of `{drawCalls}` (existing key) and `{drawCallsAfter}` (new) is OK — different keys, independent token sets.

**Action:** the commit that adds the 8 sibling-locale keys (commit 5) MUST keep the `{...:hint}` tokens byte-identical to EN. Add to the test plan an explicit assertion (already in §10.C) and run `pnpm --filter @asset-doctor/i18n test` as the gate before declaring done.

## MAJOR 1 — Reduce template surface: 5 keys per rule → drop the redundant ones

The draft proposes 10 new keys (5 per rule). `corr.batching.static_measured` ("the applied fix repacked {sheets} sheets") and `corr.vram.static_measured` are near-duplicates of `runtime_measured`, and `renderCorrelated`'s `staticEvidence`/`runtimeEvidence` both surface in the overlay. Keep all 5 fields populated (the `RenderedCorrelated` shape requires `staticEvidence`, `runtimeEvidence`, `diagnosis`, `fix`, `title` — all non-optional, verified `index.ts:147-153`), so we DO need a string for each. **Keep all 5 per rule (10 total)** — they're required by the return shape; just keep them short. No reduction possible without changing `RenderedCorrelated`. Draft's count stands; this is a NACK-with-justification.

## MAJOR 2 — `Σbefore === 0` AND the both-fields-required guard interact with a real receipt case the draft under-specifies: pack pages

Verified: a `pack` page has **no** `beforeFrames` (`fix-protocol.ts:266-268`, `sheet-probe-run.ts:81-82`), so `attachSheetProbes` fills only `drawCallsAfter`/`decodedVramAfter`, leaving `*Before` undefined. The draft's "both-required" guard correctly excludes these from the sum — good. But a fix run that **only** packs loose assets (a very common Pro path) yields **zero** sheets with both fields ⇒ `correlateFix` returns `[]`. That's honest (no measured before ⇒ no measured win) and matches §9, but the draft should state it plainly: **a pure-pack fix produces no `correlateFix` verdict — by design, because there is no honest before to compare.** Added to §9.

## MAJOR 3 — Severity thresholds are asserted to "match existing budget logic" but don't

Draft §4 claims `ratio <= 0.34` "matches the existing `idealDraws*3` budget logic in `correlate()`." It does not — `correlate()`'s `idealDraws*3` is a *trigger* threshold for firing R1 (`index.ts:48`), not a post-fix reduction ratio. There is no existing ratio-to-severity mapping to inherit. The `0.34/0.67` cutoffs are a **new editorial choice**; present them as such (reasonable: 3×+ reduction = crit, 1.5×+ = warn), not as inherited. Corrected in §4.

## MINOR — `decodedVram` is bytes; the `:mb` hint + the App.tsx precedent

Verified App.tsx renders per-sheet decoded VRAM with `fmtBytes` (line 2056), and the existing `corr.vram.title` uses `:mb` (en.json:139). For aggregated sums (tens of MB) `:mb` is the right hint and matches the live `corr.vram` family. Keep `:mb`. OK.

---

## 1. Problem & why
(unchanged from draft — verified accurate). `correlateFix` turns the **measured** `SheetDiff.drawCalls*/decodedVram*` into a severity-bearing, i18n'd verdict using the same `CorrelatedFinding`+`renderCorrelated` machinery, replacing the static guess (`correlate()` R1's `idealDraws`) for the post-fix path. Headless, pure, additive, S effort, low risk.

## 2. Scope (v1) — unchanged from draft except:
**In:** pure `correlateFix(receipt: FixProbeReceipt): CorrelatedFinding[]`; a `'batching'` finding when `Σ drawCallsAfter < Σ drawCallsBefore` over sheets with **both** measured draw-call fields; a `'vram'` finding from decoded-VRAM sums; `variant:'measured'` tag; EN templates + all-8-locale mirrors; pure unit tests; renderCorrelated `variant`-branch (one generalized helper).
**Out (v1.1):** App.tsx wiring (the receipt card at `App.tsx:1773-1774` / per-sheet strip at `2039-2064` is the surface); live-RuntimeReport end-to-end correlation; `correlate()` R1 untouched; KTX2 `probedKtx2VramBytes` correlation.

## 3. Type seam (load-bearing) — VERIFIED CORRECT, unchanged
Accept a narrow structural input in `correlate/src/index.ts`; `FixReceipt`/`SheetDiff` are structurally assignable (TS structural typing) ⇒ `apps/web` calls `correlateFix(receipt)` with no cast, no new dependency edge, no `core` bloat:
```ts
export interface MeasuredSheetDiff {
  name: string;
  drawCallsBefore?: number; drawCallsAfter?: number;
  decodedVramBefore?: number; decodedVramAfter?: number;
}
export interface FixProbeReceipt { sheetDiffs?: MeasuredSheetDiff[]; }
```
No change to `core`, `fix-protocol.ts`, or `FixReceipt`.

## 4. Pure module + signature (REVISED thresholds)
Appended to `packages/correlate/src/index.ts`:
```ts
export function correlateFix(receipt: FixProbeReceipt): CorrelatedFinding[]
```
**Algorithm (deterministic; no Date/Math.random/Intl):**
1. `const sheets = receipt.sheetDiffs ?? []`.
2. **Batching:** sum `drawCallsBefore`/`drawCallsAfter` over sheets where **both** are `Number.isFinite`. Enter only when `Σbefore > 0 && Σafter < Σbefore`. `ratio = Σafter/Σbefore`. Severity (NEW editorial cutoffs — a real measured reduction is graded by magnitude, NOT inherited from `correlate()`):
   - `crit` if `ratio <= 0.34` (≈3×+ fewer measured draws),
   - `warn` if `ratio <= 0.67` (≈1.5×+),
   - `info` otherwise.
   Push `{ id:'corrfix:batching', rule:'batching', severity, estimate:{ drawCallsAfter:Σafter }, params:{ drawCalls:Σbefore, drawCallsAfter:Σafter, sheets:n, variant:'measured' } }`.
3. **VRAM:** sum `decodedVramBefore`/`decodedVramAfter` over sheets where both are finite. Enter only when `Σbefore > 0 && Σafter < Σbefore`. Push `{ id:'corrfix:vram', rule:'vram', severity:'warn' (decoded-VRAM win is real but device-local — never crit), estimate:{ vramBytesSaved:Σbefore−Σafter }, params:{ decodedBefore:Σbefore, decodedAfter:Σafter, sheets:n, variant:'measured' } }`.
4. Return `[batching?, vram?]` in fixed order.

Constants beside `DRAW_CALL_BUDGET`:
```ts
const FIX_BATCH_CRIT_RATIO = 0.34;
const FIX_BATCH_WARN_RATIO = 0.67;
```
**Honesty/inv-5:** decoded-VRAM uses distinct params keys (`decodedBefore/decodedAfter`) + `variant:'measured'`; never folded into static `vramBytes`/`w·h·4`. `estimate.vramBytesSaved` here is a **measured decoded** delta — the `_measured` copy labels it as such.

## 5. i18n (REVISED renderer integration — see BLOCKER 1)
Add to `renderCorrelated` (after `const has = …`): `const mv = String(p.variant ?? '')` and a `pickV(suffix, base)` helper that prefers `${k}.${suffix}_${mv}` when `mv && has(...)`, else current `pick`. Wire `title`/`static`/`runtime`/`diag`/`fix` through `pickV` (one line each; live branches `sv`/`subj`/`hitch` still take precedence and are unaffected — measured findings carry none of those, live findings carry no `variant`).

**10 new EN keys** (mirror to all 8 others, placeholder tokens byte-identical):
```
"corr.batching.title_measured":   "{drawCalls} → {drawCallsAfter} draw calls — measured on this device",
"corr.batching.static_measured":  "the applied fix repacked {sheets} sheets",
"corr.batching.runtime_measured": "measured {drawCalls} → {drawCallsAfter} draw calls after the fix",
"corr.batching.diag_measured":    "Re-probing the repacked sheets on your GPU issued fewer draw calls — sprites now batch.",
"corr.batching.fix_measured":     "Ship the repacked sheets; this batching win is measured, not estimated.",
"corr.vram.title_measured":       "Decoded-texture VRAM {decodedBefore:mb} → {decodedAfter:mb} (measured, this device)",
"corr.vram.static_measured":      "the applied fix re-probed {sheets} sheets on your GPU",
"corr.vram.runtime_measured":     "measured decoded VRAM {decodedBefore:mb} → {decodedAfter:mb} after the fix",
"corr.vram.diag_measured":        "The repacked sheets decode to less GPU texture memory on this device — distinct from the w·h·4 disk-side estimate.",
"corr.vram.fix_measured":         "Ship the repacked sheets; this decoded-VRAM reading is device-local, not a cross-device guarantee.",
```
Copy explicitly names "measured / this device / distinct from w·h·4" (inv 3 & 5 honest).

## 6. Worker / UI / backend
Worker: none (fields already produced by `attachSheetProbes`). Backend: none. UI: none in v1; **v1.1** wires `correlateFix(receipt)` + `renderCorrelated(f, locale)` into `App.tsx`'s receipt card (`~1773`) beside the per-sheet measured strip (`2039-2064`) — an aggregate verdict above the per-sheet rows. `estimate`/`CorrelatedFinding` shapes unchanged.

## 7. Honesty & invariants — unchanged (verified); §9 adds the pure-pack noop case.

## 8. Determinism — unchanged: fixed array iteration, fixed finding order (batching then vram), integer/float sums, no `Date.now`/`Math.random`/locale formatting in the pure fn (formatting is in `renderCorrelated` via `Intl`). Stable ids `corrfix:batching`/`corrfix:vram`.

## 9. Edge cases (draft table + ADDED)
| Case | Behavior |
|---|---|
| `sheetDiffs` absent / `[]` | `[]` (byte-identical to today) |
| sheet has `*Before` but no `*After` (or vice-versa) | excluded (both-required) |
| **pure-pack fix (all sheets pack pages, no `*Before`)** | **`[]` — no honest before to compare (NEW, §MAJOR 2)** |
| `Σafter >= Σbefore` | no finding |
| `Σafter > Σbefore` (POT padding raised draws/VRAM) | no finding (no fake "win"; regression verdict out of v1) |
| `Σbefore === 0` | guarded (`Σbefore > 0 && Σafter < Σbefore`) ⇒ no NaN |
| `NaN`/non-finite field | `Number.isFinite` excludes |
| only one metric wins | emit only that finding |

## 10. Test plan
**A. `packages/correlate/test/correlate.test.ts`** (extend; synthetic-receipt builder):
- 120→30 draws ⇒ one `batching`, `severity:'crit'` (ratio 0.25), `estimate.drawCallsAfter===30`, `params.drawCalls===120`, `params.variant==='measured'`.
- 100→60 ⇒ `warn`; 100→90 ⇒ `info`.
- decoded 40MB→25MB ⇒ `vram`, `estimate.vramBytesSaved===15MB`, `params.decodedBefore/decodedAfter` set.
- both `Σafter>=Σbefore` ⇒ `[]`.
- `sheetDiffs` absent ⇒ `[]`; only-`*Before` ⇒ `[]`; **pure-pack (only `*After`) ⇒ `[]`**.
- both win ⇒ two findings, batching first (order).
- `Σbefore===0` ⇒ no finding, no NaN.

**B. `packages/i18n/test/render.test.ts`** (extend):
- Build the two `correlateFix` findings; render `'en'` and assert `_measured` templates resolve (title has "measured", `→`, summed numbers; no `{`).
- Render `'ru'` non-empty + brace-free for both.
- **ADDED (BLOCKER 1 regression):** render every EXISTING live correlate finding (the array already built at `render.test.ts:112-118`) and assert `renderCorrelated` output is byte-identical with the new `pickV` branch in place — proves the live path is untouched.

**C. `packages/i18n/test/catalogs.test.ts`** (the gate): after adding 10 EN keys, mirror to 8 locales (commit 5) or `Object.keys(c).sort()).toEqual(enKeys)` fails AND `tokens(lv)).toEqual(tokens(ev))` fails. Add brace-free render assertions for `corr.batching.title_measured` + `corr.vram.title_measured` across all locales.

**D. Go backend:** N/A.

Run: `pnpm --filter @asset-doctor/correlate test && pnpm --filter @asset-doctor/i18n test && pnpm typecheck`.

## 11. Ordered task breakdown (small commits) — KEPT, with BLOCKER fixes folded in
1. **`feat(correlate): correlateFix input types`** — `MeasuredSheetDiff` + `FixProbeReceipt` (exported). Typecheck.
2. **`feat(correlate): correlateFix(receipt) pure rule`** — function + two ratio constants + severity helper; batching+vram aggregation; deterministic order; all guards (both-fields, `Σbefore>0`, `Number.isFinite`). Export.
3. **`test(correlate): correlateFix findings + empty/pure-pack noop`** — extend `correlate.test.ts` with the synthetic-receipt builder + all §10.A cases (incl. the pure-pack `[]`).
4. **`feat(i18n): measured-fix correlate templates (en) + variant branch`** — add 10 `*_measured` EN keys; add the **single generalized `pickV` `variant`-branch** to `renderCorrelated` (BLOCKER 1).
5. **`feat(i18n): mirror measured-fix keys to 8 locales`** — same 10 keys translated, **placeholder tokens byte-identical** (keeps `catalogs.test.ts` green — BLOCKER 2).
6. **`test(i18n): measured branch + live-path regression + all-locale braces`** — extend `render.test.ts` (§10.B incl. the live-finding byte-identical regression) + add all-locale brace assertions to `catalogs.test.ts` (§10.C).
7. *(follow-on, separate PR — NOT v1)* **`feat(web): show correlateFix verdict beside the receipt`** — call `correlateFix` + `renderCorrelated` in the `App.tsx` receipt card (`~1773`, above the per-sheet strip at `2039`).

---

### Key file references
- Pure target: `/home/nonamezzz/Рабочий стол/projects/packages/correlate/src/index.ts` (add `correlateFix`, `MeasuredSheetDiff`, `FixProbeReceipt`; reuse `CorrelatedFinding` — lines 9-24, `correlate()` R1 guess at line 66).
- Pure tests: `/home/nonamezzz/Рабочий стол/projects/packages/correlate/test/correlate.test.ts`.
- Renderer (BLOCKER 1 site): `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/index.ts` — `renderCorrelated` lines **157-175** (real branch vars: `sv`/`subj`/`hitch`; **NO existing `variant` read** — the draft was wrong on this). EN `corr.*` block: `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json` lines **130-162**.
- i18n gates: `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/catalogs.test.ts` (key parity line 20 + **placeholder-token parity line 27**), `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/render.test.ts` (renderCorrelated drift, lines 109-129 — reuse its existing live-findings array for the regression).
- Measured source (read-only, do NOT import): `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` (`SheetDiff.drawCalls*/decodedVram*` 277-285; `FixReceipt.sheetDiffs` 363) and `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/sheet-probe-run.ts` (`attachSheetProbes` 69-126; pack pages get only `*After` — lines 81-99).
- Follow-on UI: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` (receipt card 1773-1774; per-sheet measured strip 2039-2064) + `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/fix-client.ts` (`attachSheetProbes` wired at line 45).

### Most important constraints found (verified)
- **Layering:** `correlate` → only `core`+`probe`; `i18n` → `core`+`correlate` (so `i18n` can render correlateFix findings — no new edge). Structural-input seam (§3) avoids any `apps/web` import.
- **i18n is a DOUBLE gate:** `catalogs.test.ts` enforces both all-9-locale **key parity** (line 20) AND per-key **placeholder-token parity incl. `:hint`** (line 27). Both must hold for the 10 new keys.
- **renderCorrelated has NO `variant` branch today** (draft's claim it does is false) — the new `pickV` branch must be proven non-disruptive via a byte-identical live-findings regression (§10.B / BLOCKER 1).
- **Pure-pack fixes yield no verdict** (no `*Before` on pack pages) — honest, must be tested (§MAJOR 2).
- **Severity cutoffs `0.34/0.67` are a new editorial choice**, NOT inherited from `correlate()`'s `idealDraws*3` trigger (draft mis-attributed this).
- Invariant 5: decoded-VRAM stays separate (distinct params keys + `variant:'measured'` + "distinct from w·h·4" copy), never folded into static `vramBytes`.