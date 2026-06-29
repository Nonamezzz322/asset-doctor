The i18n-app-keys test statically scans App.tsx for `t('...')` literal calls (line 73). So adding `t('fix.plan.measuredNow')` and `t('fix.plan.alsoRuns', {n})` as static literal keys in PlanCard will be auto-covered — confirming the draft's §7d/§9.E claim.

I now have everything verified. The premise is TRUE, the data exists, scope variables are all present, and the draft is largely sound. But I found several blockers/majors that the draft gets wrong or under-specifies. Here is the final revised design.

---

# Honest fix-simulation footprint preview on the Plan card — REVISED

Mini-design (implementation-ready). Verified against the real code. All paths absolute.

## Verdict on the draft

**Premise CONFIRMED TRUE.** Every load-bearing claim checked against source:
- `FixPlanSummary` is counts-only (`fix-protocol.ts:505-521`); the honesty test forbids byte/VRAM keys (`plan-worker.test.ts:369-378`). ✓
- `format`/`format-lossless` findings carry MEASURED `params.srcBytes`/`bestBytes`/`saved`/`bestMime` (`rules.ts:545,563`); `wasted-alpha` carries `srcBytes`/`opaqueBytes`/`saved` (`rules.ts:449`). ✓
- `dimensions-oversize` carries `params.w`/`h`/`vram` (`rules.ts:96`); the resize op carries the exact target `to: Size` (`plan.ts:334`, FixOp `index.ts:649`). ✓
- The live worker plan path **passes a real encoder** (`fix.worker.ts:437` `encodeImage: makeEncoder`), so `format`/`wasted-alpha` findings DO fire in production — only the Node test mirror omits the encoder. ✓
- `report`, `countedOps`, `excluded` (`Set<OpKind>`, line 633), `tierAssets`, `fixOpKind`, `OpKind` are all in scope at the plan block (724-874). The draft's worker signature is wireable. ✓
- Op-gating guards (`plan.ts:373-417`, `:331`) and the format∩wasted-alpha single-op guard (`plan.ts:184-187,414`) work exactly as the draft describes. ✓

**Two BLOCKERS and three MAJORS found.** All fixed below; the ordered task breakdown is preserved.

---

## BLOCKER 1 — npot/solid contribute NO honest VRAM in this plan; DROP them entirely

The draft (§2, §6 "VRAM, npot/solid") sums `dimensions-npot`/`solid-fill` `estimate.vramBytesSaved` "whose ref gets a resize op." **This is dishonest and must be dropped.** Code grounds:

1. **`planFix` emits NO op for `solid-fill` or `dimensions-npot`** — verified: `grep solid-fill|dimensions-npot packages/fix/src/*.ts` returns nothing; the only branches in `planFix` (`plan.ts:317-430`) are occupancy/wasted-regions/oversize/frame-redundancy/trim-margin/dupe/format/opaque. So there is no op to gate on.
2. Even when a `dimensions-oversize` ref ALSO happens to be NPOT and gets a `resize` op, the resize achieves the **oversize** reclaim (w·h·4 → smaller·4) — NOT the npot **POT-padding** reclaim (`vramBytes({potW,potH}) − vramBytes(size)`, `rules.ts:117`), and NOT the solid **1×1** reclaim (`vram − 4`, `rules.ts:150`). These are *different, non-additive* savings against *different baselines*. The npot estimate is even conditional ("IF your toolchain pads to POT", `rules.ts:114`) — folding it onto a resize the worker actually performs would fabricate a win the run never produces. **Invariant 3/5 violation.**

**FIX:** VRAM row counts **only `dimensions-oversize` × surviving `resize` op**. Remove npot/solid from scope entirely (they stay receipt-only, as they are today). This also simplifies §6 and removes the contorted "shares a ref with an oversize resize" guard.

## BLOCKER 2 — resize VRAM must be computed from the finding's measured `vram`, not recomputed `w·h·4`

The draft (§6 "VRAM, resize") computes `before = num(f.params.w) * num(f.params.h) * 4`. The finding **already carries the exact pre-resize VRAM** as `params.vram = vramBytes(size)` (`rules.ts:96`). Recomputing risks drift if `vramBytes` ever changes its formula (e.g. mipmap +33%, which CLAUDE.md invariant 5 explicitly mentions). **FIX:** use `before = num(f.params.vram)`; `after = to.w * to.h * 4`. Keep `max(0, before − after)`. (`after` must use the same `*4` the op's target implies; there is no per-op vram field, so computing `to.w*to.h*4` is the only option for `after` — acceptable since `to` is integer and the formula is the canonical base w·h·4.)

> NOTE: if mipmap-adjusted VRAM is ever introduced, `after` would also need the +33%. For v1, base w·h·4 on both sides is internally consistent (the diagnosis `vram` is base w·h·4 too — `rules.ts` `vramBytes`). Leave a code comment flagging this so the two sides stay in lockstep.

## MAJOR 1 — use `{disk:bytes}`/`{vram:bytes}` i18n hints, NOT app-side `fmtBytes`

The draft §7d/§7b formats via the app's `fmtBytes` and passes plain `{disk}`/`{vram}` tokens. The i18n layer already has a `:bytes` format hint (`packages/i18n/src/index.ts:98`) used by `frame-redundancy`/`trim-margin` (`{vram:bytes}`, en.json:112,123). **FIX:** catalog strings use `{disk:bytes}`/`{vram:bytes}`; pass raw numbers to `t()`. This is localized (German/Hindi number formatting), consistent with sibling strings, and the catalogs token-parity test (`catalogs.test.ts:6-7,27`) captures `{disk:bytes}` as one token and enforces byte-exact parity across all 9 — so the hint must be identical in every locale. The `~`/`·`/`−` punctuation lives in the string (translatable), only `{disk:bytes}`/`{vram:bytes}`/`{n}` are tokens.

## MAJOR 2 — the honesty test's EXACT-keys assertion WILL break; rewrite is mandatory and load-bearing

`plan-worker.test.ts:372` asserts `Object.keys(summary).sort()` equals a fixed 5-key array AND `:376` scans every key against `/(byte|vram|saved|saving|kb|mb|disk)/i`. Adding `footprint` (and its `diskBytesSaved`/`vramBytesSaved` sub-keys, which DO match the forbidden regex) breaks both. The draft's §9.D acknowledges this but the *new* assertion it proposes is what actually encodes the honesty invariant — so it must be written precisely:
- Allow top-level keys to be the 5 existing **plus optional `footprint`**.
- Assert `footprint` (when present) has **distinct** `diskBytesSaved` and `vramBytesSaved` numeric fields (never a combined "saved"/"total" headline) — this is the invariant-5 separation guard.
- Assert (in the pure unit test, where we control inputs) that **no transcode/format ref feeds `vramBytesSaved`** and **no resize feeds `diskBytesSaved`** — the strongest honesty assertion; do it in §9.A where refs are controllable, not here.

## MAJOR 3 — the test mirror has no encoder AND tier-source has no oversize asset ⇒ a new fixture is REQUIRED, not optional

Verified: the Node mirror analyzes without an encoder (`plan-worker.test.ts:6-7`), so `format`/`wasted-alpha` never fire there → disk row can't fire. And `tier-source/expected.json` shows banner.png is 100×50 (not oversize), no asset > any maxEdge → `dimensions-oversize` never fires there → VRAM row can't fire. The draft floats "(if needed)" for the fixture in §10.3 — **it IS needed**: neither row can be reproduced through the existing mirror on the existing fixture. Either (a) drive the **pure aggregator** (§9.A) with hand-built findings + a real `planFix` (no encoder needed — we author the findings directly), which fully covers both rows deterministically, AND (b) add a small fixture with one oversize loose PNG to fire the VRAM row through the real `planFix` in the mirror. The disk row through the *real worker* is only reachable in a DOM/canvas e2e — out of scope; the pure unit test (§9.A) is the honest substitute and is sufficient for v1.

---

## Final scope (v1)

**In:** pure `summarizeFixPlanFootprint(report, ops, excluded)` summing ONLY measured, op-gated, mask-aware, pre-compose-knowable deltas:
- **disk**: `format`/`format-lossless` ref with a surviving `transcode` op → `srcBytes − bestBytes` (clamp ≥0; sets `estimated`). `wasted-alpha` ref with a surviving `opaque:true` transcode → `srcBytes − opaqueBytes` (NOT estimated). Same-ref dedup via a `disced` set (count format only).
- **VRAM**: `dimensions-oversize` ref with a surviving `resize` op → `params.vram − to.w·to.h·4` (clamp ≥0).
- **deferredOps**: count of surviving repack/merge/pack/dedup ops + (worker-folded) `tierAssets` when tier not excluded.

Two stacked rows on `PlanCard`: Row 1 "measured now: disk ~X · VRAM −Y" (omit if both 0), Row 2 "also runs: N ops (sized at download)" (omit if 0). Returns `undefined` ⇒ counts-only fallback (byte-identical to today). Rides the existing re-preview on every toggle.

**Out:** npot/solid VRAM (BLOCKER 1); any disk for repack/merge/pack/dedup/tier; any VRAM for transcode/opaque (invariant 5); lossless byte correction (surfaced as `~` estimate + extended `deferredNote`); backend/KTX2/scale-tier ladder; no new encoding/analysis pass.

---

## Contract change — `apps/web/src/worker/fix-protocol.ts`

Additive optional field on `FixPlanSummary` + new exported interface (same as draft §4, with the disclaimer that npot/solid are excluded):

```ts
footprint?: FixPlanFootprint;
```
```ts
export interface FixPlanFootprint {
  /** Σ measured DISK bytes the surviving transcode/opaque ops save (srcBytes−best/opaque). ≥0. */
  diskBytesSaved: number;
  /** Σ EXACT VRAM the surviving resize×oversize ops reclaim (params.vram − to.w·to.h·4). ≥0.
   *  npot/solid are EXCLUDED — planFix emits no op for them, and a resize achieves neither
   *  their POT-padding nor 1×1 reclaim (different baselines, non-additive). */
  vramBytesSaved: number;
  /** True iff ≥1 disk delta is the lossy q0.9 canvas estimate (format finding) ⇒ UI shows "~". */
  estimated: boolean;
  /** Count of NON-summable ops that ALSO run (repack/merge/pack/dedup/tier). NEVER folded into disk/vram. */
  deferredOps: number;
}
```
No `PlanOpCounts`/`PlanGateInputs`/`FixReceipt`/core changes.

## Pure module — `apps/web/src/lib/plan-footprint.ts`

```ts
import type { AnalysisReport, FixOp, ImageMime } from '@asset-doctor/core';
import type { FixPlanFootprint } from '../worker/fix-protocol';
import { fixOpKind, type OpKind } from './op-manifest';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function summarizeFixPlanFootprint(
  report: AnalysisReport,
  ops: readonly FixOp[],
  excluded: ReadonlySet<OpKind>,
): FixPlanFootprint | undefined { /* §algorithm */ }
```

**Algorithm:**

Pass A — surviving-op index (skip `excluded.has(fixOpKind(op))`):
- `transcodeRefs: Set<string>` ← `op.kind==='transcode'` → `op.assetRef`.
- `opaqueRefs: Set<string>` ← `op.kind==='transcode' && op.opaque===true` → `op.assetRef`.
- `resizeTo: Map<string, {w,h}>` ← `op.kind==='resize'` → `op.assetRef → op.to`.
- `deferredOps` ← count ops where `fixOpKind(op) ∈ {repack, merge, pack, dedup}`.

Pass B — sum measured deltas (keyed off the SURVIVING ops, `if (f.scope==='folder') continue`):
- `disced = new Set<string>()`.
- `format`/`format-lossless` (`f.rule==='format'`) & `transcodeRefs.has(ref)` → `disk += max(0, num(srcBytes) − num(bestBytes))`; `estimated = true`; `disced.add(ref)`.
- `wasted-alpha` & `opaqueRefs.has(ref)` & `!disced.has(ref)` → `disk += max(0, num(srcBytes) − num(opaqueBytes))`.
- `dimensions-oversize` & `resizeTo.has(ref)` → `before = num(f.params.vram)` (the measured w·h·4, `rules.ts:96`); `to = resizeTo.get(ref)`; `after = to.w * to.h * 4`; `vram += max(0, before − after)`.
  - *Code comment*: `after` uses base w·h·4 to match `before` (`vramBytes`); if mipmap-adjusted VRAM is ever added, adjust both sides in lockstep.

`if (disk===0 && vram===0 && deferredOps===0) return undefined;` else return the four fields. Pure (Set/Map + numeric sum over the deterministically-ordered `report.findings` and `ops`; no `Date`/`Math.random`). `excluded` is consumed by Pass A only (redundant with a pre-filtered `countedOps` for FixOps, but documents intent + guards the tier fold).

## Worker — `apps/web/src/worker/fix.worker.ts` (~line 867, before `post({type:'fix-plan'…})`)

```ts
const footprint = summarizeFixPlanFootprint(report, countedOps, excluded);
// tier is a worker-side multiplier (not a FixOp); fold its upper-bound into the "sized at download"
// line when tiering survives the mask (invariant 5: tier contributes 0 to disk/vram).
if (footprint && tierAssets > 0 && !tierExcluded) footprint.deferredOps += tierAssets;
post({ type: 'fix-plan', summary: { ...summarizePlan(gate), ...(footprint ? { footprint } : {}) } });
```
`countedOps` (mask + keep-consumer filtered, line 814) is already the right input. Import from `../lib/plan-footprint`. Absent footprint ⇒ summary byte-identical to today.

## UI — `apps/web/src/App.tsx` PlanCard (insert between the opCounts `<div>` ~:2319 and the referencesChanged banner :2322)

```tsx
{summary.footprint && (summary.footprint.diskBytesSaved > 0 || summary.footprint.vramBytesSaved > 0) ? (
  <p className="font-mono text-[11px]">
    {summary.footprint.estimated ? '~' : ''}
    {t('fix.plan.measuredNow', { disk: summary.footprint.diskBytesSaved, vram: summary.footprint.vramBytesSaved })}
  </p>
) : null}
{summary.footprint && summary.footprint.deferredOps > 0 ? (
  <p className="font-mono text-[10px] text-ink-soft">{t('fix.plan.alsoRuns', { n: summary.footprint.deferredOps })}</p>
) : null}
```
Disk vs VRAM made visually distinct via the catalog string layout (e.g. disk segment then VRAM segment); keep VRAM in a distinct color token if desired (invariant 5 — visibly separate). `summary.footprint` already flows via the typed prop; no new import. Re-preview path (`togglePlanKind`→`preview(next)`, App.tsx ~1688) reposts the summary so both rows update live — no extra wiring. Extend `fix.plan.deferredNote` copy to add the q0.9-vs-lossless caveat (no new token).

**Backend:** none (invariant 2).

## i18n — `packages/i18n/src/catalogs/*.json` (all 9)

- `fix.plan.measuredNow`: `"Measured now: disk −{disk:bytes} · VRAM −{vram:bytes}"` (the leading `~` for estimates is prepended by the UI; the `−` is in-string). Tokens: `{disk:bytes}`, `{vram:bytes}` — identical in all 9 (parity test). Note: when disk is 0 the string still renders "disk −0 B" — acceptable, but if cleaner copy is wanted, split into two keys (`measuredNowDisk`/`measuredNowVram`) rendered conditionally. **Recommend the split** so a VRAM-only plan doesn't show "disk −0 B" (honesty: don't imply a disk win that isn't there). Two keys, each one token.
- `fix.plan.alsoRuns`: plural — `{ "$count":"n", "one":"Also runs: {n} op (sized at download)", "other":"Also runs: {n} ops (sized at download)" }`. Token `{n}`.
- Extend `fix.plan.deferredNote`: append the lossy-q0.9-vs-lossless caveat.

(With the split, render `measuredNowDisk` only when `diskBytesSaved>0`, `measuredNowVram` only when `vramBytesSaved>0`.)

## Edge cases (revised)

- Nothing measurable (only repack/dedup) → Row 1 omitted, Row 2 count, footprint defined. ✓
- All ops deselected → `countedOps` empty → `undefined` → no rows (existing `allDeselected` note). ✓
- format∩wasted-alpha same ref → single opaque transcode (`plan.ts:414`); counted once via `disced`. ✓
- format ref repacked/packed/tiered/dropped → no transcode op (`plan.ts:388` guards) → not in `transcodeRefs` → 0. ✓
- resize-to-larger impossible (`plan.ts:331` only when `longest>maxEdge`); clamp anyway. ✓
- atlas oversize resize: `dimensions-oversize` fires on atlases too (`analyze.ts:167`); resize-atlas scales the page (`fix.worker.ts:2084`) → w·h·4 delta valid. ✓
- Missing/NaN params (headless/no-encoder) → `num()`→0 → contributes 0 (honest). The real worker always has an encoder (`fix.worker.ts:437`). ✓
- `opaqueAlpha` off → no `opaque:true` op → no opaque disk. ✓
- tier excluded → fold skipped. ✓
- `bestFormatPerImage` routes `op.targetMime` but `bestBytes` is the measured smallest (`rules.ts:545`) → disk delta unchanged. ✓

## Test plan (revised)

**A. Pure unit — `apps/web/test/plan-footprint.test.ts`** (new; PRIMARY coverage, encoder-free). Hand-build `AnalysisReport.findings` (real `Finding` shapes: `format` with `srcBytes/bestBytes/bestMime`, `wasted-alpha` with `srcBytes/opaqueBytes`, `dimensions-oversize` with `params.vram/w/h`) + real `planFix(report, opts)` output. Assert:
- disk = `srcBytes−bestBytes` for a format ref with a transcode op; `estimated===true`.
- VRAM = `params.vram − to.w·to.h·4` for an oversize ref with a resize op.
- **invariant-5 separation**: transcode never feeds `vramBytesSaved`; resize never feeds `diskBytesSaved` (the strongest honesty assertion — possible here because inputs are controlled).
- **op-gated**: a format ref ALSO occupancy-repacked → no transcode op → contributes 0.
- format∩wasted-alpha same ref → counted once.
- mask: `excluded={'transcode'}` zeroes disk; `{'resize'}` zeroes VRAM.
- npot/solid finding present but no resize op → contributes 0 VRAM (BLOCKER-1 regression).
- deferredOps counts repack/merge/pack/dedup.
- counts-only plan → `undefined`.

**B. Real worker-path integration — extend `apps/web/test/plan-worker.test.ts`** (mirror over `tier-source` + the new fixture from C):
- `footprint.deferredOps >= 1` from the under-filled sheet's repack (test:312-315); assert the repack payoff appears in NEITHER disk NOR vram (headline-honesty).
- With the §C oversize fixture: `vramBytesSaved === params.vram − to.w·to.h·4` (recomputed independently, mirroring `recount` at test:289).
- Mask honesty through the real assembly: `excludeKinds:['resize']` → vram 0.

**C. Fixture — `make-fixture` skill (REQUIRED, per MAJOR 3):** add one oversize loose PNG (longest edge > maxEdge) to fire `dimensions-oversize`→resize→VRAM row in the mirror (the mirror has no encoder, so the disk row stays in §A). Golden `expected.json` documents the VRAM delta.

**D. Honesty regression — REWRITE `plan-worker.test.ts:369-378`** (per MAJOR 2): allow optional top-level `footprint`; assert distinct numeric `diskBytesSaved`/`vramBytesSaved` (no combined headline). Keep the spirit (no faked/combined number).

**E. i18n — `i18n-app-keys.test.ts`** auto-covers the new static `t()` keys (scans App.tsx literals, line 73). Add the `fix.plan.alsoRuns` plural-render check (n=1, n=2, no leftover `{`) to `catalogs.test.ts` (~:32). `catalogs.test.ts:27` auto-enforces `{disk:bytes}`/`{vram:bytes}`/`{n}` parity.

**F.** `pnpm typecheck && pnpm lint && pnpm test` green.

## Ordered task breakdown (preserved, small commits)

1. **contract**: add `FixPlanFootprint` + optional `footprint` to `FixPlanSummary` (`fix-protocol.ts`).
2. **pure aggregator**: `apps/web/src/lib/plan-footprint.ts` + unit test (§A). Commit pure + green.
3. **fixture (REQUIRED)**: oversize loose PNG via `make-fixture` (§C) — VRAM row reaches the real mirror.
4. **worker wiring**: call aggregator in the plan block (`fix.worker.ts:~867`), fold `tierAssets`, attach `footprint`; extend `plan-worker.test.ts` (§B) + rewrite the honesty assertion (§D).
5. **i18n**: add `fix.plan.measuredNowDisk` + `measuredNowVram` (split, MAJOR-1/honesty) + `alsoRuns` (plural) to all 9 with `:bytes` hints; extend `deferredNote`; add the plural-render check (§E).
6. **UI**: render the two rows in PlanCard (`App.tsx:~2319`), `~` for `estimated`, disk/VRAM visually distinct.
7. **verify**: `pnpm typecheck && pnpm lint && pnpm test`; `pnpm dev` smoke (toggle re-preview updates rows live).

## Summary of changes vs draft
- **BLOCKER 1 (DROP npot/solid VRAM)**: they have no op and a resize doesn't achieve their reclaim — dishonest. VRAM = oversize×resize only.
- **BLOCKER 2 (use measured `params.vram`)**: don't recompute `w·h·4`; the finding carries the exact value.
- **MAJOR 1 (`:bytes` i18n hint)**: localized, consistent with sibling strings; recommend disk/VRAM split keys so a VRAM-only plan never shows "disk −0 B".
- **MAJOR 2 (rewrite honesty test)**: mandatory; the new assertion encodes invariant-5 separation.
- **MAJOR 3 (fixture REQUIRED, not optional)**: neither row can fire through the existing mirror/fixture.
- Everything else in the draft (op-gating, `disced` dedup, mask honesty, tier fold, scope variables, re-preview ride) is **confirmed correct against source** and kept.