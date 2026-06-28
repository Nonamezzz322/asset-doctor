Confirmed: the `<LoaderMigration>` call site (line 1794) is inside `Receipt({ receipt })` (line 1712), so `receipt.ktx2Produced` is directly in scope — T4 is a one-line prop pass, exactly as the draft says.

I now have everything verified. The draft's premise is TRUE and well-grounded, with line numbers off and two under-specifications I'll correct. Let me write the final revised design.

# KTX2 Loader-Migration Snippet — FINAL Mini-Design (adversarially verified)

## Verdict: premise TRUE, ship it. Two corrections, one factual upgrade.

I verified every load-bearing claim against the real tree. The premise holds:

- **The gap is real.** `apps/web/src/lib/loader-migration.ts` `pixiSnippet` (line 204) emits only `import { Assets } from "pixi.js";` — zero KTX2 awareness. The worker's KTX2 post-pass (`fix.worker.ts` lines 2356–2412) does `out.push` + `recordVariant` only; it **never** touches `changeRows`. Confirmed by grep: no `.ktx2`/`.ktx2.json` path is ever passed to any `*Changes` builder, and `ktx2` is **not** an `OpKind` (`op-manifest.ts:19`). So `changes[]` is genuinely raster-only and the snippet cannot detect KTX2 from existing rows — an explicit boolean is the correct mechanism.
- **The breakage is real.** Verified `node_modules/.pnpm/pixi.js@8.19.0`: `package.json` exports `"./ktx2" → lib/compressed-textures/ktx2/init.mjs`, whose body is `extensions.add(loadKTX2); extensions.add(resolveCompressedTextureUrl); extensions.add(detectCompressed);`. Without that side-effect import the ktx2-first `src` candidate (recorded with `FORMAT_RANK['.ktx2'] = -1`) fails to resolve. The copy-paste snippet is silently broken on KTX2 runs today.
- **The prompt's comment text is WRONG; the draft's correction is verified-RIGHT.** `setKTXTranscoderPath.mjs` defaults `ktxTranscoderUrls` to `https://cdn.jsdelivr.net/npm/pixi.js/transcoders/ktx/libktx.{js,wasm}`. The WASM loads from the Pixi CDN **by default** — you do NOT "must bundle the WASM." Stating otherwise would fabricate a requirement (invariant 3). Keep the draft's corrected comment.
- **Off ⇒ byte-identical is provable.** Ran the suite: 26 loader-migration + 9 ktx2-worker assertions green (296 total). Every existing `migrationSnippet(changes, engine)` two-arg call is unaffected by an optional third arg.

### Corrections to the draft

**C1 (MAJOR — test plan under-specified).** The draft asserts "the worker isn't Node-runnable, so [`ktx2Produced`] stays covered by the pure helper golden + a type check." **False.** `apps/web/test/ktx2-worker.test.ts` already exists (9 tests) and mirrors the post-pass control flow in Node, explicitly asserting claim (e) "the emitted manifest lists the ktx2 candidate FIRST," with a `produced` counter in scope. T3 (`ktx2Produced`) **must** add an assertion there, not punt to a type check. This closes the worker-side determinism gap the draft left open.

**C2 (MINOR — wrong line numbers / counts).** The draft's line refs are stale (file is 235 lines; `pixiSnippet` is 204 not "204"… most refs in the prose like "en.json:373", "2516", "2114" were partially off). Corrected throughout below. Existing assertion count is **26**, not "~30."

**U1 (factual upgrade — `.ktx2.json` collision, draft glossed it).** `ATLAS_EXT = /\.json$/i` would match a `.ktx2.json` path as an atlas target if one ever entered `changes[]`. It never does (verified above), so this is not a live bug — but the design must STATE the invariant ("no `.ktx2`/`.ktx2.json` row is added to `changes[]`; if a future change adds one, `loadTargets` would misclassify the sidecar") and a guard test asserts the snippet never contains a `.ktx2` *load call*, only the leading import.

Everything else in the draft is sound and kept verbatim in spirit.

---

## 1. Scope

**In:** thread one `ktx2` boolean into `migrationSnippet`; Pixi snippet leads ONCE with `import 'pixi.js/ktx2';` + one honest transcoder comment; Phaser emits a one-time honest no-loader comment block (no fabricated call); off ⇒ byte-identical; pure golden tests + the worker `ktx2Produced` assertion (C1).

**Out:** adding `.ktx2`/`.ktx2.json` rows to `changes[]` (U1 — would misclassify); `.basis`; emitting a concrete `setKTXTranscoderPath` path; DDS/mipmap snippets; any Go/backend change (KTX2 production already ships); changing the from→to list (stays raster-only — the loader resolves `.ktx2` via the manifest `src`, never calls it directly).

## 2. Contract (additive only — no `core`, no `FixChange`, no new i18n key)

### 2a. `loader-migration.ts` — optional opts
```ts
export function migrationSnippet(
  changes: readonly FixChange[],
  engine: Engine,
  opts?: { ktx2?: boolean },   // omitted ⇒ false ⇒ byte-identical to today
): string
```
Optional object (not positional) for forward-extensibility; a positional `ktx2 = false` is equally acceptable.

### 2b. `fix-protocol.ts` `FixReceipt` — additive optional field (after `ktx2VramBytesWorstCase`, line 360)
```ts
/** True iff this run produced ≥1 .ktx2 file, so the loader-migration snippet leads with
 *  `import 'pixi.js/ktx2'`. Set only when ktx2Produced > 0 (gated ⇒ non-KTX2 runs omit it ⇒
 *  receipt byte-identical). The .ktx2/.ktx2.json paths live in `out`/manifest variants, NOT in
 *  changes[] (the loader resolves them via the entry's `src`), so this boolean is the only seam. */
ktx2Produced?: boolean;
```
Preferred over deriving from `backendNative` so the fact is computed once in the worker and is independently testable. Both are honest; the field keeps the UI dumb.

## 3. Pure module changes (`loader-migration.ts`)

```ts
export function migrationSnippet(changes, engine, opts?: { ktx2?: boolean }): string  // CHANGED
function pixiSnippet(targets, ktx2: boolean): string    // CHANGED
function phaserSnippet(targets, ktx2: boolean): string  // CHANGED
```

**`pixiSnippet` head (verbatim CODE, never i18n)** — replace line 207's array init:
```ts
const lines: string[] = ['import { Assets } from "pixi.js";'];
if (ktx2) {
  lines.push(
    "import 'pixi.js/ktx2'; // registers the KTX2 loader (side-effect import)",
    '// the libktx transcoder WASM loads from the Pixi CDN by default; call setKTXTranscoderPath() to self-host',
  );
}
lines.push('');
// …existing per-target loop unchanged…
```
Both literals verified against Pixi 8.19.0 (§ verdict). The `lines.pop()` trailing-blank logic (line 214) is unaffected — it operates on the per-target tail, which still ends in `''`.

**`phaserSnippet`** — after `'function preload() {'` (line 221), when `ktx2`:
```ts
if (ktx2) lines.push(
  '  // NOTE: this fix also produced .ktx2 GPU-compressed pages, but Phaser 3 has no built-in KTX2 loader.',
  '  // Load .ktx2 via a compressed-texture plugin (e.g. a custom loader) or ship the raster pages below.',
);
```
Honest absence statement — no fabricated `this.load.ktx2(...)` (that API does not exist). Raster `this.load.atlas/image` calls below stay the working drop-in.

Pattern precedent: the existing per-target `t.spine` "flagged, not faked" comment (lines 210/225) — the KTX2 import follows the same discipline but is file-level, emitted ONCE at the head.

## 4. Worker / UI changes

- **Worker** (`fix.worker.ts`, receipt object ~line 2589, beside `ktx2VramBytesWorstCase`): add `...(ktx2Produced > 0 ? { ktx2Produced: true } : {})`. `ktx2Produced` counter already exists (line 2353/2394). Gated ⇒ non-KTX2 runs omit it ⇒ byte-identical receipt. **No `changeRows` change.**
- **UI** (`App.tsx`): `Receipt({ receipt })` (line 1712) already has `receipt` in scope. `LoaderMigration` (line 2114) gains a `ktx2: boolean` prop; `useMemo` (line 2119) → `migrationSnippet(changes, engine, { ktx2 })`; the single call site (line 2794 region, `<LoaderMigration changes={…} />` at line 1794) passes `ktx2={receipt.ktx2Produced ?? false}`. **No new `t()` call** ⇒ `i18n-app-keys.test.ts` stays green (verified it statically scans `t('…')` usages).
- **Backend:** none.

## 5. Invariants

- **1/2:** zero backend change; snippet generated in-browser from the receipt.
- **3 (objectivity):** `pixi.js/ktx2` is a verified real export; the transcoder-CDN comment is factually correct (CDN-default verified); Phaser comment states absence, never invents a call; from→to list unchanged.
- **5 (disk≠VRAM):** snippet carries no byte/VRAM numbers; KTX2's ceiling stays in `ktx2VramBytesWorstCase` / `fix.backend.receiptVram`.
- **Additivity:** `opts.ktx2` defaults false; `ktx2Produced` omitted on non-KTX2 runs; new lines gated by `if (ktx2)` ⇒ every existing test passes unchanged (proven: 296 green).
- **CODE-not-i18n (M5):** import + comments are verbatim code, never `t()`.

## 6. Determinism

`(changes, engine, ktx2)` ⇒ byte-identical string: the new lines are constant literals at a fixed position before the already-url-sorted `loadTargets()` loop. `ktx2Produced` derives from the deterministic `ktx2Produced` counter. The no-i18n-brace guard (`/\{[a-zA-Z]/`) is safe: `setKTXTranscoderPath()` has parens, no `{letter`.

## 7. Edge cases

1. No KTX2 (`ktx2 === false`/omitted) ⇒ byte-identical (every existing test).
2. KTX2 + raster-only changes ⇒ import leads; raster `Assets.load` follows (Pixi resolves `.ktx2` via `src`). Correct.
3. Empty `changes` + `ktx2 === true` ⇒ `migrationSnippet` early-returns `''` (line 196, before `pixiSnippet`) ⇒ import never emitted with nothing to load. Receipt `receiptLoader` prose still discloses the requirement. Test it.
4. Removal-only + KTX2 ⇒ zero targets ⇒ `''` (same path).
5. **(U1)** No `.ktx2`/`.ktx2.json` is ever a load TARGET — guard test: snippet must NOT contain a `.ktx2` load call (`not.toContain('.ktx2"')` on the per-target lines), only the leading `import 'pixi.js/ktx2'`.
6. Phaser + KTX2 ⇒ comment block once after `preload() {`; `not.toMatch(/load\.ktx2/)`.

## 8. Tests (`apps/web/test/loader-migration.test.ts` + `ktx2-worker.test.ts`)

| Case | Assert |
|---|---|
| Pixi `{ktx2:true}` merge | first lines after `import { Assets }` are `import 'pixi.js/ktx2'; …` + transcoder comment; rest matches existing merge golden verbatim |
| Pixi `{ktx2:false}` and omitted | byte-identical to existing merge golden (additivity) |
| Pixi `{ktx2:true}` empty changes | `''` (edge 3) |
| Phaser `{ktx2:true}` | one-time `// NOTE: …Phaser 3 has no built-in KTX2 loader` after `preload() {`; `not.toMatch(/load\.ktx2/)`; raster calls verbatim |
| Phaser `{ktx2:false}` | byte-identical to existing Phaser golden |
| **(U1) guard** | snippet `not.toContain('.ktx2"')` (no `.ktx2` load call); Pixi `toContain("import 'pixi.js/ktx2'")` |
| determinism both engines | `migrationSnippet(c,e,{ktx2:true}) === migrationSnippet(c,e,{ktx2:true})` |
| no-i18n-brace | re-run with `{ktx2:true}` input — still no `/\{[a-zA-Z]/` |
| **(C1) ktx2-worker.test.ts** | extend the existing "encodeRemote 200 ⇒ adds .ktx2" case to also assert `ktx2Produced > 0 ⇒ receipt.ktx2Produced === true`; and the additivity case (backend off) asserts `receipt.ktx2Produced` is **absent** |

All 26 existing loader-migration + 9 ktx2-worker assertions stay green (two-arg calls unchanged).

## 9. ORDERED TASK BREAKDOWN

| id | title | files | tag | deps | acceptance |
|---|---|---|---|---|---|
| **T1** | Thread `ktx2` into `migrationSnippet` + `pixiSnippet`/`phaserSnippet` | `apps/web/src/lib/loader-migration.ts` | feat(fix) | — | Pixi `{ktx2:true}` leads with `import 'pixi.js/ktx2';` + transcoder comment; Phaser emits the one-time no-loader block, no `this.load.ktx2`; omitted/`false` ⇒ byte-identical; pure; `pnpm typecheck` green |
| **T2** | Golden + guard tests (both engines, additivity, edges, U1 guard) | `apps/web/test/loader-migration.test.ts` | test(fix) | T1 | §8 rows 1–8 pass; ALL 26 existing assertions green |
| **T3** | Worker: set `receipt.ktx2Produced` when `ktx2Produced > 0`; assert it | `apps/web/src/worker/fix.worker.ts`, `apps/web/src/worker/fix-protocol.ts` (add `ktx2Produced?: boolean` after line 360), `apps/web/test/ktx2-worker.test.ts` | feat(fix) | T1 | field set only when KTX2 produced (gated); **ktx2-worker.test.ts asserts present-when-produced / absent-when-off** (C1); `pnpm typecheck` + web test green |
| **T4** | UI: pass `ktx2` from receipt into `LoaderMigration` → `migrationSnippet` | `apps/web/src/App.tsx` | feat(fix) | T3 | `LoaderMigration` takes `ktx2: boolean`; call site passes `receipt.ktx2Produced ?? false`; `useMemo` → `migrationSnippet(changes, engine, { ktx2 })`; no new `t()` ⇒ `i18n-app-keys.test.ts` green; `pnpm typecheck` + `pnpm lint` green |
| **T5** *(optional)* | Tighten `fix.backend.receiptLoader` CDN wording across 9 catalogs | `packages/i18n/src/catalogs/*.json` | docs/i18n | — | en prose says transcoder loads from CDN by default (not "must bundle"); `catalogs.test.ts` 9-lang key+token parity green (no key/token change ⇒ safe); non-blocking |

**Commit discipline:** T1+T2 are the pure core (ship together). T3+T4 wire receipt→UI. T5 is independent. Each task green on `pnpm typecheck`/`test`.

## Key file references (corrected)
- `apps/web/src/lib/loader-migration.ts` — `migrationSnippet` (194), `pixiSnippet` (204), `phaserSnippet` (218); `t.spine` flagged-not-faked precedent (210/225); `ATLAS_EXT = /\.json$/i` (140) — the `.ktx2.json` collision-avoidance invariant (U1).
- `apps/web/test/loader-migration.test.ts` — 26 golden assertions (extend).
- `apps/web/test/ktx2-worker.test.ts` — 9 Node-side post-pass assertions incl. ktx2-first manifest order; **add the `ktx2Produced` assertion here (C1).**
- `apps/web/src/worker/fix.worker.ts` — KTX2 post-pass (2356–2412), `ktx2Produced` counter (2353/2394), receipt object (~2589, beside `ktx2VramBytesWorstCase`); `changeRows` raster-only (verified: no `.ktx2`).
- `apps/web/src/worker/fix-protocol.ts` — `FixChange` (208), `FixReceipt` (246), `ktx2VramBytesWorstCase` (360, add `ktx2Produced?` after).
- `apps/web/src/App.tsx` — `Receipt` (1712, has `receipt` in scope), `<LoaderMigration>` call site (1794), `LoaderMigration` (2114), `useMemo` (2119); `receiptLoader` prose render (1786).
- `packages/i18n/src/catalogs/en.json` — `fix.backend.receiptLoader` (line 373), `fix.backend.costLoader` (363) already name `import 'pixi.js/ktx2'`.
- `packages/fix/src/pixi-manifest.ts` — `FORMAT_RANK['.ktx2'] = -1` + `.ktx2.json` rank special-case — the *reason* the import is mandatory (ktx2-first `src`).
- `apps/web/test/i18n-app-keys.test.ts` / `packages/i18n/test/catalogs.test.ts` — guard that T4 adds no `t()` and T5 adds no key/token (both stay green).

**Externally verified:** Pixi 8.19.0 exports `./ktx2` as a side-effect init (`extensions.add(loadKTX2/resolveCompressedTextureUrl/detectCompressed)`); `ktxTranscoderUrls` defaults to the jsDelivr Pixi CDN, so the WASM is NOT required in-bundle — the snippet's honesty comment is the corrected "CDN by default; setKTXTranscoderPath to self-host," NOT the prompt's "requires the WASM in your bundle." Baseline suite: 296 passed / 1 skipped before any change.