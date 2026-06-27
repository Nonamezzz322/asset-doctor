Confirmed: default `padding: 2`. With the asymmetric model, padding=2 means a 2px gutter on right+bottom of each sprite, and the left/top "gutter" of a sprite is the right/bottom reservation of its left/top neighbor — **shared, not owned**, and **absent at bin edges**.

Now I have the full picture. The draft's core geometry premise is wrong, but the underlying defect (no extrude → seams) is real. Here's my adversarial review and revised design.

---

# Adversarial Review + Revised Mini-Design: Edge-Extrude (Bleed)

## Verdict: Premise TRUE (real defect), but the draft's central geometry model is FALSE and must be reworked

The defect is real: `composePageEncode` (fix.worker.ts:378–406) does a bare `drawImage` per blit with zero edge replication; the gutter stays transparent → bilinear/mipmap seams in every repack/merge/pack/Spine output. Worth fixing, quality-tier. **But the draft is built on a wrong understanding of the packer's padding, and that error propagates into the clamp helpers, the "own gutter" determinism argument, and the worker call sites. Shipping it as-drafted would draw extrude pixels OVER neighboring sprites.**

---

### BLOCKER 1 — The padding gutter is asymmetric (right+bottom only), not symmetric. The entire "padding >= 2*extrude" / "own gutter on every side" model is wrong.

`pack.ts:71-73,104-107`: each item is inflated by `pad` **once** (`iw = it.w + pad`), placed at `(best.x, best.y)` at size `it.w × it.h`, and reserves a `(it.w+pad) × (it.h+pad)` block. So the free gutter exists **only to the right and below** a sprite. There is **no dedicated left/top gutter** — a sprite's left edge sits `pad` px from its left neighbor's right edge, and that band is the **neighbor's** reservation, not its own. Worse, a sprite placed at `x=0` (top-left of the bin, which the MaxRects free-list seeds at `{0,0,W,H}`) has **zero left/top gutter at all**.

Consequences that break the draft:
- **`paddingForExtrude = max(padding, 2*extrude)` is wrong.** Because the gutter is one-sided, the requirement for `extrude` px on the right/bottom is `padding >= extrude` (not `2*extrude`). For the left/top, no amount of padding bump helps a given sprite — its left gutter is owned by the neighbor. To get symmetric extrude room you would need each sprite inflated by `2*pad` (pad on *both* sides), which is a **packer change**, exactly what the draft tried to avoid to "keep pack.ts golden tests untouched."
- **"Extrude writes into the sprite's OWN reserved gutter ⇒ order-independent" is false.** Sprite A's right-gutter is the band immediately left of sprite B. If A extrudes `e` px rightward and B was placed `pad` px to A's right with `e <= pad`, A's right-extrude lands in the band before B — *but B's left edge is at `A.x+A.w+pad`, and B has no left reservation*, so A's extrude is fine only if `e <= pad`. Conversely B cannot extrude **leftward** into that same band without overwriting A's right-extrude (or A's content if `e` large). The draft's symmetric per-side extrude **will draw B's left strip on top of A's right-extrude / A's pixels.** The "order is irrelevant" determinism claim collapses.
- **Sheet-edge / bin-origin sprites:** the top-left sprite at `(0,0)` has no left/top gutter; the draft's clamp-to-bin "drops zero-area rects" handles not crashing, but it means those sprites silently get **no left/top extrude** — the seam persists exactly where sprites touch the sheet edge (UV clamp usually saves the sheet edge, but NOT interior abutments at x=0 column boundaries).

This is not a tuning detail; it's the load-bearing geometry. The draft's §1.2, §4.1 (`paddingForExtrude`/`effectiveExtrude`), §6 determinism proof, and §7 edge-case 2 are all built on the false symmetric model.

**Two honest fixes, pick one:**

- **(A) Packer gains symmetric gutter (correct, slightly more work).** Add an explicit `gutter` to `pack.ts`: inflate each item by `2*gutter` and place the sprite at `(best.x + gutter, best.y + gutter)`. Now every sprite owns `gutter` px on **all four sides**, the "own gutter ⇒ order-independent" proof becomes *true*, and `extrude <= gutter` is the only constraint. This **does** change `pack.ts` placements (a +gutter offset) — its golden tests must be updated, but only when `gutter>0`; with `gutter=0` (today's default path) placements are byte-identical. This is the technically correct option and removes the bin-edge seam too. Cost: ~1 day incl. updating pack golden tests for the gutter>0 case.

- **(B) One-sided extrude only (cheap, honest, smaller win).** Keep the packer as-is. Extrude **only right + bottom** (the directions that have reserved gutter), clamp `extrude <= padding`, and skip left/top. This kills ~half the seams with zero packer change. Honest, but a partial fix — and you must say so in the receipt/skip note ("edge-extrude: right/bottom only in v1"). I'd reject this as the headline feature because a half-extruded sprite still seams on its left/top edges, which is a confusing quality result.

**Recommendation: option (A).** It is the only version that actually delivers "kills bilinear/mipmap seams." The draft's whole pitch is correctness-of-quality; a half-gutter extrude undermines it. The packer change is small and gated on `gutter>0`.

### BLOCKER 2 — Extrude must NOT shrink usable area silently / must be honest about the packing cost.

Inflating each item by `2*gutter` (option A) **increases packed area** → can push a sheet to the next POT → **more VRAM**. The draft asserts "VRAM unchanged" (invariant 5) — that's only true under the false one-sided-no-extra-space model. Under a correct symmetric gutter, turning on extrude **can** grow the sheet. This must be measured and surfaced honestly: if the gutter bump grows a bin, either (a) report the VRAM delta truthfully in the receipt, or (b) keep extrude within the *existing* padding budget and accept option-B-style one-sided coverage. You cannot both claim "all-four-side extrude" AND "VRAM never changes" — that's an honesty (invariant 5) violation. Resolve explicitly.

### MAJOR 3 — `Rect`/`Blit` field names unverified in draft; confirmed here, but draft used `blit.from.rotated` AND `blit.rotate90` — both exist (good), and `blit.clip?: Vec2[]` exists (good). `canExtrude` guarding both is correct. No change needed, but the draft should not have hand-waved "guard anyway"; `blit.from.rotated` is a real, populated field. Keep the guard.

### MAJOR 4 — Spine `.atlas` round-trip claim needs a caveat. Draft §7.8 says extrude lives in dead gutter so `.atlas` round-trips identically. True for the *region rects*, but if option (A) grows the Spine sheet to the next POT, the emitted `.atlas` `size:` line **changes** and the PNG dimensions change. Still correct (non-destructive: regions unchanged), but "round-trips identically" is wrong if the bin grows. Reword.

### MINOR 5 — Default OFF: agreed and correct. With option (A), default-on would also change VRAM for existing outputs — another reason for default OFF. Good call in the draft; keep it.

### MINOR 6 — Test layer (no canvas polyfill): the draft's deferral of real-pixel assertion to Playwright matches repo convention (verified: `extractSprite` uses `OffscreenCanvas`+`getImageData`, unavailable in Vitest; existing worker tests skip encode). Correct. Keep pure-geometry golden tests in Vitest.

### NIT 7 — `effectiveExtrude(2,4)→2` etc. examples are wrong under the corrected model and must be rewritten for the chosen option (A: `effectiveExtrude(e,gutter)=min(e,gutter)`; the `2*` factor disappears).

---

## REVISED MINI-DESIGN (incorporating option A)

### Scope
Add a **symmetric** packing gutter to the rectangle packer and replicate each rectangle sprite's edge pixels into that gutter during compose, to kill bilinear/mipmap seams. Default OFF; `gutter=0` ⇒ byte-identical to today. Rectangle blits only (meshed `blit.clip` skipped + surfaced honestly). VRAM impact (possible POT growth) measured and reported honestly.

### Contract additions (additive, all optional/0)
- `core` `FixOp`: `extrude?: number` on `repack` and `pack` variants only.
- `PackOptions.gutter?: number` (NEW — drives symmetric inflation+offset). `RepackOptions.gutter?`, `PolygonRepackOptions` inherits (polygon ignores — meshed never extruded). `PackLooseOptions.gutter?`.
- `PlanOptions.extrude?`. `FixOptions.extrude?` (UI knob, 0/1/2). `FixReceipt`: `extrudePx?`, `extrudedBlits?`, `extrudeSkipped?` (descriptive) **plus** honest `vramBytesBefore/After` already exist — if gutter grows a bin, the existing VRAM accounting captures it (no separate claim).

### pack.ts change (the correct core)
Inflate each item by `2*gutter`; place sprite at `(best.x + gutter, best.y + gutter)` with size `it.w × it.h`; reserved block `(it.w + 2*gutter) × (it.h + 2*gutter)`. `gutter` defaults 0 ⇒ today's placements **exactly**. `fitOneBin` area/maxDim use the `+2*gutter` inflated dims. Keep `padding` as a deprecated alias mapped to `gutter` to avoid a wide call-site churn (or migrate all callers to `gutter`; decide in T3). Update pack golden tests to cover `gutter>0`.

### Pure extrude module (`packages/fix/src/extrude.ts`)
- `effectiveExtrude(extrude, gutter) = Math.max(0, Math.min(Math.floor(extrude), gutter))`.
- `canExtrude(blit): boolean` — `!blit.clip?.length && !blit.from.rotated && !blit.rotate90`.
- `extrudePlan(blit, extrude, binW, binH): ExtrudeRect[]` — 4 edge strips (1px source slice → `extrude`-wide gutter band) + 4 corners, clamped to `[0,binW]×[0,binH]`, zero-area dropped, **deterministic fixed order** (top,bottom,left,right,TL,TR,BL,BR). Now CORRECT because each sprite owns symmetric gutter on all sides (no overwrite of neighbors). `extrude<=0`/meshed/rotated ⇒ `[]`.

### plan.ts
`const extrude = max(0, floor(opts.extrude ?? 0))`. When `extrude>0`, set the op's `gutter = max(existingPadding/gutter, extrude)` (one-sided requirement is just `>= extrude` now that gutter is symmetric) and stamp `extrude`. resize/drop unchanged. extrude=0 ⇒ ops identical.

### worker (fix.worker.ts)
`composePageEncode(..., extrude=0)`: after each **non-clip** blit's main draw, run `extrudePlan` rects via `drawImage`. Clip blits: `if(extrude>0) skip + surface once/op`. Pass `effectiveExtrude(op.extrude??0, op.gutter)` at all 3 call sites (566 repack/merge, 482 Spine, 840 pack). Accumulate counters; set receipt fields conditionally. VRAM saved already reflects any bin growth via `r.vramBytesBefore/After` — no faked numbers.

### UI: 0/1/2 toggle, default OFF; i18n en key; drift test stays green.

### Honesty/invariants
Inv 1 ✅ (OffscreenCanvas only). Inv 2 ✅. Inv 3 ✅ (fix engine only). Inv 4 ✅ (Pro path, ≤8 draws/sprite). **Inv 5: extrude CAN grow a bin (symmetric gutter) → VRAM change is captured truthfully by existing `vramBytes*` accounting; receipt never claims "free." This is the corrected honest position — the draft's "VRAM unchanged" was only true under the broken model.**

---

## ORDERED TASK BREAKDOWN (revised)

| id | title | files | tag | deps | acceptance |
|---|---|---|---|---|---|
| **T1** | Symmetric gutter in packer | `packages/fix/src/pack.ts` | fix-pure | — | `gutter?` field; item inflated `+2*gutter`, sprite placed at `(x+gutter,y+gutter)`; `gutter=0` ⇒ placements byte-identical to today; `fitOneBin` dims use inflated size |
| **T2** | Update pack golden tests for gutter>0 | `packages/fix/test/` (pack coverage in `fix.test.ts`/new) | test | T1 | gutter=0 snapshot unchanged; gutter=g ⇒ every placement offset by g, no two reserved blocks overlap. Green |
| **T3** | Pure extrude module + corrected helpers | `packages/fix/src/extrude.ts`, `index.ts` | fix-pure | T1 | `effectiveExtrude=min(e,gutter)`; `extrudePlan` symmetric 4 strips+4 corners, clamped, ordered, total; `canExtrude` guards clip+from.rotated+rotate90; empty for e=0/meshed/rotated |
| **T4** | Golden geometry tests | `packages/fix/test/extrude.test.ts` | test | T3 | 2×2 quad with gutter≥extrude: 8 ordered rects/interior sprite; each strip src=correct 1px slice; **no dest overlaps any sprite `to` rect**; bin-edge clamps; empty cases. Green |
| **T5** | Additive contract fields | `packages/core/src/index.ts`, `repack.ts`, `packLoose.ts` | core/contract | T1,T3 | `extrude?` on FixOp repack/pack; `gutter?` on Repack/PackLoose options; typecheck green; no behavior change at gutter/extrude=0 |
| **T6** | Plan threads extrude + sets gutter | `packages/fix/src/plan.ts` | fix-pure | T3,T5 | `PlanOptions.extrude?`; repack/pack ops get `gutter=max(pad,extrude)`+`extrude`; resize/drop unchanged; extrude=0 ⇒ ops identical |
| **T7** | Plan tests | `packages/fix/test/fix.test.ts` | test | T6 | extrude>0 ⇒ gutter set + stamped on repack/pack only; extrude=0 ⇒ op-equality with today. Green |
| **T8** | Protocol + receipt fields | `apps/web/src/worker/fix-protocol.ts` | contract | T5 | `FixOptions.extrude?`; `FixReceipt.extrudePx?/extrudedBlits?/extrudeSkipped?`; typecheck green |
| **T9** | Worker compose extrude + honest VRAM | `apps/web/src/worker/fix.worker.ts` | worker | T3,T6,T8 | `composePageEncode` applies `extrudePlan` to rect blits; 3 sites pass `effectiveExtrude(op.extrude,op.gutter)`; forwards opts.extrude→planFix; meshed skip once/op; existing `vramBytes*` reflects any bin growth (no faked saving); extrude unset ⇒ byte-identical output |
| **T10** | Headless worker control-flow test | `apps/web/test/extrude-worker.test.ts` | test | T9 | pure `extrudePlan` over real `repackAtlases`(gutter>0) placements on `tp-hash-symbols`: interior non-empty; no dest∩`to`; meshed ⇒ empty+skip-eligible. Green (encode skipped per repo convention) |
| **T11** | UI toggle + i18n | `apps/web/src/App.tsx`, en catalog | ui | T8 | Pro 0/1/2 extrude toggle default OFF; forwards extrude to run(); en key; drift test green |
| **T12** | Deferred Playwright pixel test | (e2e, deferred) | test-deferred | T9 | 2×2 quad → Pro fix extrude:1 → decoded gutter texel == adjacent sprite edge color (not transparent). Browser-only (no Node canvas polyfill) |

**Critical path:** T1 → T3 → T6 → T9. T2/T4/T7/T10 alongside producers; T11/T12 last.

**Load-bearing facts the implementer must not re-decide (corrected from draft):**
- The packer gutter is **right+bottom-only today** (`pack.ts:72,104-107`). Symmetric extrude REQUIRES the T1 packer change (item `+2*gutter`, place at `(x+gutter,y+gutter)`). The draft's `padding >= 2*extrude` / "own gutter every side" was **WRONG** against this code.
- `effectiveExtrude = min(extrude, gutter)` (NOT the draft's `2*` factor).
- Extrude with symmetric gutter **CAN grow a bin to the next POT ⇒ VRAM may rise**; this is captured by existing `vramBytes*` and must be reported honestly, NOT claimed "free" (corrects draft's invariant-5 claim).
- Rectangle blits only; meshed (`blit.clip`) skipped + surfaced; `canExtrude` also guards `from.rotated`/`rotate90` (both real fields).
- OffscreenCanvas unavailable in Vitest ⇒ real-pixel assertion deferred to Playwright (T12); Vitest tests pure plan geometry (T4/T10). Default OFF.

If the symmetric-gutter packer change (T1) is judged out of budget, the only honest fallback is **option B (right/bottom-only extrude, no packer change, `extrude<=padding`)**, explicitly labeled a partial seam-fix in the receipt — but that is a materially weaker feature and I'd recommend deferring the whole item rather than shipping a half-extrude as if it killed seams.