I now have everything I need. Key confirmed findings:

1. **Leak is real and exactly as described** (`:999-1007`, never closes/evicts; consumers at `:1037`, `:1098`, `:1800`).
2. **`runFix` is `async function` with bare `return;` exits** at `:644-645, 1254, 2465, 2551, 2574, 2712` + implicit at `:2717` — a single `try/finally` wrapping the body covers them all. Errors propagate to the `:196` catch. ✓ Draft's task 3 is sound.
3. **The op-loop body is huge with 20+ `continue` exits per op** (`:1271…1820`). This is the draft's biggest gap: tasks 4 (unpin) and 5 (cache-drop) "at iteration end / before each continue" would require editing 20+ exit points or silently miss most of them. This is a MAJOR correctness/effort issue requiring a structural fix (do it at the **top of the next iteration**, not the bottom of the current).
4. **Merge re-reads sources across multiple `composePageEncode` calls** within one op (`:1474` merge path composes multiple pages, each re-reading group refs) — so pinning is justified for merge/polygon, but for sequential single-page ops the LRU is already safe within one bitmapOf call. The pin claim holds.
5. **Test harness convention confirmed** (`ktx2-probe-collect.ts` + `.test.ts`, pure Node-importable, worker imports verbatim, default vitest picks up both `src/lib/*.test.ts` and `test/*.test.ts`). ✓

Here is the revised design.

---

# Mini-Design (REVISED): Bound the fix-worker resident set — LRU-evict + close() decoded ImageBitmaps under a byte budget

## Verdict on the draft

**Premise TRUE, design sound, ship it — with two corrections (one MAJOR, one minor) and one rebuttal of an over-claim.** The leak is real and exactly as described; the `try/finally` exit strategy is correct because `runFix` is an `async function` whose every exit (bare `return;` at `:644, 645, 1254, 2465, 2551, 2574, 2712` and the implicit return at `:2717`) passes through a body-wrapping finally, and thrown errors propagate to the existing `:196` catch. The pure-module + Node-test convention is correctly identified.

What the draft gets **wrong or under-specifies**:

- **[MAJOR — placement of tasks 4 & 5]** The op-loop body (`:1253`–`~:1497` for repack/merge alone) has **20+ `continue;` exits per op** (verified: `:1271, 1280, 1289, 1321, 1328, 1364, 1382, 1388, 1470, 1504, 1519, 1582, 1633, 1652, 1667, 1683, 1695, 1773, 1785, 1792, 1798, 1820, 1828, 1829, …`). "Call `unpinAll()` / drop caches at the end of each iteration before `continue`/loop-end" is **not a single edit** — it would either touch 20+ sites (huge, error-prone diff) or silently no-op on almost every exit path. **Fix: do the unpin + cache-drop at the TOP of the next iteration (and once after the loop), keyed off "previous op", not at the bottom of the current one.** This makes both tasks a single insertion at `:1253`-top regardless of how the current iteration exits.
- **[MINOR — import line]** The sibling import is `import { collectKtx2Probe, KTX2_PROBE_MAX } from '../lib/ktx2-probe-collect';` (`:124`), not `buildKtx2ProbeInput`. Cosmetic; the "add a new `../lib/*` import alongside it" instruction stands.
- **[REBUTTAL — pin necessity]** The draft pins "around the compose section." Verified justified **only for merge (`:1474`, multi-page, each page re-reads group source refs) and polygon (`:1348` extract loop over every sprite of every group atlas)** — these interleave many `bitmapOf` calls over the same N sources across many awaits, so without pinning a large group could evict a source it still needs this op (costing a re-decode storm, never wrong pixels since `bytesByRef` is retained). For a **single-atlas repack** or a **resize** op there is at most one live source per `bitmapOf` await chain, so pinning is a no-op there. **Keep pin/unpin, but scope the pin set to the op's actual source refs and accept that single-source ops pin trivially** — the unpin-at-top-of-next-iteration structure makes this free to apply uniformly.

Everything else in the draft is correct and retained verbatim in intent (budget constant, drain finally, additivity = byte-identical output, honesty re invariant 5, determinism, optional receipt note deferred).

## 1. Problem (verified)

`fix.worker.ts:999-1007` — `bitmapOf` only ever inserts into `bmpCache`, never `.close()`, never evicts, no end-of-run drain. Each entry is a decoded RGBA surface (`w·h·4`; a 2048² page = 16 MB). Consumers: `composePageEncode` (`:1037`), `extractSprite` (`:1098`, polygon), pack-trim probe (`:1800`). The 14 standalone `.close()` calls (`:1508-2945`) are all on never-cached resize/transcode locals. A multi-dozen-page fix holds hundreds of MB resident → tab OOM on the **paid** path.

## 2. Scope

**In:** (a) LRU + byte-budget `bitmapOf`; (b) drain-on-exit `finally`; (c) per-op `maskCache`/`meshCache`/`trimCache` drop. (a)+(b) are the OOM fix; (c) is a smaller follow-on.

**Out (unchanged):** standalone resize/transcode locals (already closed eagerly); downscale-on-decode; any change to compose/encode pixels, packing geometry, or emitted bytes; a UI-/`FixOptions`-exposed budget (it's a documented constant); the receipt note is optional + gated (§5).

## 3. Honesty & invariants

- **Inv 1:** decoded-bitmap lifetime only; no network, no new I/O.
- **Inv 5:** the budget is a **working-set bound on decoded SOURCE bitmaps held DURING fixing** — NOT a VRAM saving, NEVER folded into `vramBytesAfter`/`vramSaved`. The optional receipt note (§5) is descriptive only, carries no saving number.
- **Correctness:** re-decode on a miss is always safe (`bytesByRef` retained whole-run) ⇒ a wrongly-evicted entry costs a re-decode, never a wrong pixel. Pinning the in-flight op's sources prevents a re-decode storm within one merge/polygon op.
- **Output identity:** eviction changes only *when* a bitmap is decoded; `createImageBitmap` of the same bytes is deterministic for our raster inputs ⇒ emitted bytes unchanged. **On under-budget folders nothing evicts ⇒ byte-identical to today.**

## 4. Determinism

LRU recency = `bitmapOf` call order = deterministic (fixed `plan.ops` order, fixed blit order); no `Date.now`/`Math.random`/timers. Eviction picks the LRU **unpinned** entry; ties broken by `Map` insertion order (deterministic). Frozen budget constant ⇒ identical eviction sequence across runs ⇒ identical emitted bytes.

## 5. Contract / type changes

**None required for v1.** No `core`, no `fix-protocol.ts` wire change. Optional last commit: one additive optional `FixReceipt.decodeWorkingSet?: { decodedPages: number; budgetBytes: number }` (descriptive, gated on `peakCount > 0`, honesty comment = working-set bound never a VRAM claim). Absent ⇒ byte-identical receipt. **Defer to the final commit so the hardening lands contract-free.**

## 6. Pure module (the Node-testable seam)

New `apps/web/src/lib/bitmap-budget.ts` — generic LRU-by-byte over a closeable handle (bitmap injected so the module is Node-pure; mirrors the `ktx2-probe-collect.ts` convention the worker imports verbatim).

```ts
/** Anything with byte-cost dims + close() — ImageBitmap satisfies this structurally. Generic so the
 *  cache is Node-testable with a fake. */
export interface Closeable { readonly width: number; readonly height: number; close(): void; }

/** Decoded-source working-set bound (documented constant, mirrors SHEET_DIFF_MAX style). 256 MB ≈ 16 full
 *  2048² RGBA pages resident — generous for a normal fix, far under a tab OOM. A single page larger than
 *  the budget is always admitted (one in-flight page is non-negotiable). */
export const BITMAP_BUDGET_BYTES = 256 * 1024 * 1024;

export const bitmapBytes = (b: Closeable): number => b.width * b.height * 4;

/** LRU cache of decoded source bitmaps keyed by ref, bounded by Σ width*height*4. Over-budget insert
 *  closes() the LRU UNPINNED entry, repeating until under budget OR only pinned/this entry remain (then
 *  over-budget is tolerated — correctness over the bound, surfaced via peakCount). ADDITIVE: under budget
 *  nothing evicts. Re-decode on a miss is always safe (the caller retains the source bytes). */
export class BitmapBudget<T extends Closeable> {
  constructor(budgetBytes?: number);
  get(ref: string): T | undefined;          // hit → moved to MRU; miss → caller decodes + insert()s
  insert(ref: string, value: T): T;          // evicts LRU unpinned until under budget; returns value
  pin(refs: Iterable<string>): void;         // refs the in-flight op needs live (never evicted while pinned)
  unpinAll(): void;
  drain(): void;                             // close() every handle + clear; idempotent
  get size(): number;
  get liveBytes(): number;
  get peakCount(): number;
}
```

**`insert` algorithm:** add new entry to MRU; while `liveBytes > budget`, scan from LRU end for the first **unpinned** ref ≠ the just-inserted ref, `close()` + delete + subtract its bytes; if none evictable, stop (tolerated). A single page > budget is admitted (loop finds nothing, stops).

## 7. Worker changes (`fix.worker.ts`)

1. **Import** `BitmapBudget, BITMAP_BUDGET_BYTES` from `'../lib/bitmap-budget'` (alongside the `:124` `ktx2-probe-collect` import).

2. **Replace `:999-1007`:**
   ```ts
   const bmpBudget = new BitmapBudget<ImageBitmap>(BITMAP_BUDGET_BYTES);
   const bitmapOf = async (ref: string): Promise<ImageBitmap | null> => {
     const hit = bmpBudget.get(ref);
     if (hit) return hit;
     const b = bytesByRef.get(ref);
     if (!b) return null;
     return bmpBudget.insert(ref, await createImageBitmap(new Blob([b])));
   };
   ```
   *(Same await shape as today: each `bitmapOf` is awaited sequentially in every loop, so the long-standing double-decode race can't fire — no regression, no new single-flight complexity.)*

3. **[CORRECTED] Pin + per-op cache drop at the TOP of each iteration, not the bottom.** Because the op body has 20+ `continue` exits, do per-op teardown for the *previous* op at the start of the loop and once after it. Add a tiny pre-iteration hook keyed off "what the previous op pinned/cached":

   ```ts
   const snapKeys = (m: Map<string, unknown>) => new Set(m.keys());
   let preMask = snapKeys(maskCache), preMesh = snapKeys(meshCache), preTrim = snapKeys(trimCache);
   const teardownPrevOp = () => {
     bmpBudget.unpinAll();
     for (const k of maskCache.keys()) if (!preMask.has(k)) maskCache.delete(k);
     for (const k of meshCache.keys()) if (!preMesh.has(k)) meshCache.delete(k);
     for (const k of trimCache.keys()) if (!preTrim.has(k)) trimCache.delete(k);
     preMask = snapKeys(maskCache); preMesh = snapKeys(meshCache); preTrim = snapKeys(trimCache);
   };
   for (const op of plan.ops) {
     if (cancelled) return;            // drain() in the runFix finally frees everything incl. pins
     teardownPrevOp();                 // unpin + drop the PRIOR op's extraction caches (no-op on op 0)
     if (!runs(op)) continue;
     if (op.kind === 'drop' && op.ownerRef != null) continue;
     // … per op-kind branch, EARLY in each branch that does multi-source compose: bmpBudget.pin(srcRefs)
   }
   teardownPrevOp();                   // final op's caches/pins released before encode/zip
   ```
   Pin the op's source refs **once, early in the branch**, before the compose/extract loops: repack/merge → `refs` (`:1324`); polygon → the same `group` atlas names (`:1348`); pack → `group.regions.map(r => r.ref)` (`:1782`). `teardownPrevOp` at top-of-next-iteration covers every `continue` exit for free — no need to touch the 20+ continue sites. (These caches are keyed by dir-aware id and each id belongs to exactly one op, so cross-op drop is safe; trimCache regions likewise live in one pack group.)

4. **[CONFIRMED] Drain finally.** Wrap the `runFix` body (`:204`→`:2717`) in `try { … } finally { bmpBudget.drain(); }`. Every exit — the bare `return;` at `:644/645/1254/2465/2551/2574/2712` and the implicit return at `:2717` — passes through it; a thrown error still propagates to the `:196` catch. `bmpBudget` must be declared before the `try` (or the finally captures it via closure since it's defined at `:999`, inside the body — so the `try` must start at/above `:999`; simplest is to open `try` right after the `bmpBudget`/`bitmapOf` definition or hoist `bmpBudget`'s declaration above the `try`). **Decision: declare `bmpBudget` at the existing `:999` site and start the `try` immediately after it (the only code below `:999` that matters for cleanup), so the finally references it in scope.** Plan-mode returns at `:644` *before* `:999`, so it never constructs `bmpBudget` — keep that path outside the try (or guard the finally with `bmpBudget?.drain()`). **Cleanest: hoist `let bmpBudget: BitmapBudget<ImageBitmap> | undefined;` to the top of `runFix`, assign at `:999`, `try` wraps `:204`→end, `finally { bmpBudget?.drain(); }`** — covers plan-mode (undefined ⇒ no-op) and every execute exit.

5. **[optional, last commit] Receipt note.** `...(bmpBudget?.peakCount ? { decodeWorkingSet: { decodedPages: bmpBudget.peakCount, budgetBytes: BITMAP_BUDGET_BYTES } } : {})` in the receipt (`:2706` object). Gated ⇒ byte-identical when off.

## 8. UI / backend changes

**None.** No `FixOptions`, no `buildOptions`, no React, no Go. If the receipt note ships, the existing renderer can show or ignore it (additive); not required for v1.

## 9. Edge cases

- **Single page > budget:** admitted (nothing evictable); `peakCount` reflects it.
- **All live entries pinned & over budget** (huge merge group): no eviction (all needed this op); tolerated, drained at op-teardown/run-end. Documented in the class.
- **Miss after eviction:** re-decode from retained `bytesByRef`; byte-identical; only CPU cost; pinning prevents this within an op.
- **`bytesByRef` miss:** `bitmapOf` returns `null` as today (no insert).
- **Cancel mid-op:** the `runFix` finally `drain()`s everything incl. pinned (pins are advisory for eviction only; drain ignores them).
- **`drain()` idempotency:** clears the map; double-drain is a no-op; double-`.close()` on a bitmap is a benign browser no-op anyway.
- **Plan mode (`:644`):** returns before `:999` ⇒ `bmpBudget` undefined ⇒ `bmpBudget?.drain()` no-op ⇒ byte-identical.
- **Under-budget folder:** nothing evicts ⇒ identical decode set ⇒ byte-identical output (the additivity guarantee).
- **0×0 bitmap:** `bitmapBytes`=0; can't push over budget; harmless (parsers reject degenerate frames upstream, `:1097`).

## 10. Test plan (Node, Vitest)

New `apps/web/src/lib/bitmap-budget.test.ts` (mirrors `ktx2-probe-collect.test.ts`; default vitest glob picks up `src/lib/*.test.ts`). `FakeBitmap implements Closeable` records `close()` calls:

- **Under budget ⇒ no eviction, no close()** (additivity = the core honesty claim).
- **Over budget ⇒ evict + close() the LRU unpinned**, `liveBytes ≤ budget`, survivors intact.
- **Recency:** `get()` on an old ref → MRU; next over-budget insert evicts a *different* ref.
- **Pinning:** pin A; flood over budget; A never closed even as LRU candidate; `unpinAll()` then makes A evictable.
- **Single oversized entry:** budget 10, insert 1000-byte; admitted (not closed); following small insert may leave over-budget without crash.
- **drain():** every handle closed exactly once, `size===0`, second drain no-op.
- **peakCount:** insert 5, evict to 2 ⇒ `peakCount===5`, `size===2`.
- **Determinism:** same insert/get/evict script twice ⇒ identical close() sequence.

These exercise the SAME class the worker imports verbatim. **Regression:** `pnpm --filter @asset-doctor/web test && pnpm typecheck && pnpm lint` green after every commit (the existing worker-pipeline tests re-drive the pure pipeline, unaffected by the cache wrapper).

## 11. Ordered task breakdown (small commits)

1. **`feat(fix): pure BitmapBudget LRU-by-byte module`** — `apps/web/src/lib/bitmap-budget.ts` (`Closeable`, `BITMAP_BUDGET_BYTES`, `bitmapBytes`, `BitmapBudget` get/insert/pin/unpinAll/drain/size/liveBytes/peakCount). Pure, no worker wiring.
2. **`test(fix): BitmapBudget eviction + close + pin + drain + determinism`** — `bitmap-budget.test.ts` (§10). Green before any worker change.
3. **`fix(fix): bound fix-worker bitmaps — LRU bitmapOf + drain finally`** — hoist `let bmpBudget`, wire it into `bitmapOf` (`:999`), wrap the `runFix` body in `try { … } finally { bmpBudget?.drain(); }`. The OOM fix; covers all exits incl. cancel + plan-mode.
4. **`fix(fix): pin in-flight op sources + drop per-op caches (top-of-iteration teardown)`** — add `teardownPrevOp()` at the top of the `plan.ops` loop (`:1253`) + once after it; `bmpBudget.pin(srcRefs)` early in the repack/merge (`:1324`), polygon (`:1348`), pack (`:1782`) branches. **Combines the draft's tasks 4 & 5** because the corrected top-of-iteration structure does both unpin and cache-drop at one site — splitting them would mean two passes over the same edit. (If preferred as two commits: 4a adds `pin`/`unpinAll` calls + the teardown skeleton; 4b adds the cache-key drops to `teardownPrevOp`.)
5. *(optional)* **`feat(fix): descriptive decodeWorkingSet receipt note`** — additive `FixReceipt.decodeWorkingSet` (`fix-protocol.ts`) + gated emit (`:2706`, `peakCount > 0`) + honesty comment. Defer so the hardening lands contract-free.

Run `pnpm --filter @asset-doctor/web test && pnpm typecheck && pnpm lint` after commits 2–5.

### Key file references
- Leak: `fix.worker.ts:999-1007` (`bmpCache`/`bitmapOf`); consumers `:1037` (compose), `:1098` (extractSprite), `:1800` (pack-trim).
- Op loop top (teardown + pin site): `:1253`; in-flight source refs `:1324` (repack/merge `refs`), `:1348` (polygon `group`), `:1782` (pack `group.regions`). **20+ `continue` exits per op** (`:1271…:1829`) — the reason teardown must be top-of-next-iteration, not bottom-of-current.
- Extraction caches to drop: `maskCache` `:1084`, `meshCache` `:1085`, `trimCache` `:1089`.
- `runFix` start/body/end + bare returns: `:203/204` start, `:644/645` (plan-mode, before `bmpBudget`), `:1254/2465/2551/2574/2712` (cancel), `:2717` end; outer try/catch `:191-200` (`:196` catch) — unchanged.
- Existing standalone `.close()` (out of scope): `:1508, 1517, 1523, 1580, 1586, 1649, 1655, 2298, 2358, 2363, 2478, 2731, 2874, 2945`.
- Convention to mirror: `apps/web/src/lib/ktx2-probe-collect.ts` + `.test.ts` (pure extract → Node test → worker imports verbatim; import site `:124`).
- Optional receipt field: `fix-protocol.ts` `FixReceipt`; gated emit at the receipt object `:2706`.
- New files: `apps/web/src/lib/bitmap-budget.ts`, `apps/web/src/lib/bitmap-budget.test.ts`.