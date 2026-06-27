This is the decisive finding for the test plan. The worker's impure pixel path (`createImageBitmap`/`OffscreenCanvas`) **cannot run in Node**, so existing worker tests do NOT execute `fix.worker.ts` — they drive a **node-side re-implementation** of the worker's control flow over fixtures. This means the draft's **T5 ("Worker assembly test... a merge run produces changes[]")** as written — actually running the worker to capture `changes[]` — is **not feasible** in the test harness. The only way to test the worker's `pushChange` emissions is the same re-implementation pattern (which doesn't test the actual worker code) OR by extracting the change-collection into a pure helper that both the worker and the test call. This is a real effort/feasibility gap the draft under-estimates.

I now have everything needed. Writing the final revised design.

---

# Loader-Migration Guide — REVISED mini-design (post-skeptic)

## Premise verdict: TRUE, but the scope is materially WRONG and must be cut

The headline premise holds: `App.tsx:1052` is a bare prose banner (`fix.mergeWarn` = *"References changed — update your loader"*) with no file list and no code, and the worker does know the paths it rewrote. An engine-aware migration block is a real, honest, moat-relevant improvement. **However, three of the eight "reference-changing" sites the draft enumerates do NOT change the game's loader call, and surfacing them as migration steps would be actively dishonest (invariant 3).** The draft must be cut to the sites that genuinely change a load call. Details below; every blocker is grounded in the code I read.

---

## BLOCKERS (must fix)

### B1 — Dedup is NOT a loader-visible change. DROP it from the guide. (correctness + invariant 3)
Both dedup `operations.push` sites (worker `1254-1261` and `1281-1288`) **keep the consumer's manifest and rewrite it in place** (`out.push({ path: consumerManifest, … })`), dropping only the redundant *image* (`dropped.add(consumerPath)`). The game still calls `Assets.load('consumer.json')` exactly as before — AD re-emitted that `.json` with a patched `meta.image`. There is **no load-call change**. The draft's §4b row `pushChange(consumerPath, actual.image, 'dedup')` is wrong on its face: `consumerPath` is the dropped *image*, `actual.image` is the *owner's* image, and the loader references **neither directly** — it references the (rewritten, same-named) manifest. Telling a dev to repoint `consumer.png → owner.png` would make them break a manifest AD already fixed. **Resolution: dedup contributes ZERO change rows.** (The existing `referencesRewritten` receipt count + `fix.mergeWarn` banner already covers the "we rewrote internal references" story honestly.)

### B2 — Merge/pack fan-in target is per-page and unmapped. The single-`to` model is wrong. (determinism + honesty)
Merge emits `atlas-merged{-i}.json` per page (`836-839`); old atlases' sprites are **scattered across pages** and the worker keeps **no old-ref → page map**. The draft's §4b `pushChange(oldManifestPath, mergedManifestPath, 'merge')` invents a 1:1 target that does not exist. The honest, code-true statement is **N old manifests → the merged sheet set (M pages)**, not per-page arrows. Same for pack: `regions` fold into one sheet with `pl.atlases.length` pages (`1192-1195`); a region has no single page target. **Resolution:** model merge/pack as a **set→set** group: `from = [all old manifest paths]`, `to = [all new manifest paths]` (the page manifests we actually wrote). Change the `FixChange` shape to carry this honestly (see §2), or emit one row per old `from` with `to = <the new manifest set joined>` and let the snippet load **every** new manifest. The snippet then emits one `Assets.load` per **new** manifest (deduped) — which is exactly what the dev must do — and lists the old refs as `// was:` comments. This is the only model that is both true and load-correct.

### B3 — Tier change must point at the MANIFEST, not the image. (load-correctness)
For an atlas/Spine asset, the loader loads the **manifest** (`thing.json`/`thing.atlas`), and tiering renames the manifest (`tieredName(manifestPath, suffix)` at `1414`; `tieredName(spineInfo.path, suffix)` at `1407`). The draft's §4b `pushChange(imagePath, tieredName(imagePath, …), 'tier')` points at the *image*, which the atlas loader never names. Only for a **loose** tiered image is the image itself the load target. **Resolution:** tier `from`/`to` = the **manifest** path for atlas/Spine, the **image** path for loose; pick the same path the loader would have loaded. Also: tiering produces **multiple** targets (one per tier) from one source — model as `to = [all tier manifests]` (set), mirroring B2.

### B4 — T5 (worker assembly test) is not feasible as written. (effort under-estimate)
`fix.worker.ts` uses `createImageBitmap`/`OffscreenCanvas` (18 sites) and **cannot run in Node**; every existing `apps/web/test/*-worker.test.ts` drives a **node-side re-implementation** of the worker's control flow over fixtures (see `dedup-worker-phase-c.test.ts:1-13`), NOT the worker itself. So "a merge run produces `changes[]`" cannot be asserted by running the worker. **Resolution:** extract change-row *construction* into a **pure** helper in `loader-migration.ts` (e.g. `mergeChanges(oldRefs, newManifests)`, `packChanges(...)`, `tierChanges(...)`, `looseRenameChange(...)`) that BOTH the worker calls at each site AND the test calls directly with fixture inputs. This makes T5 a pure unit test (no worker run) and guarantees the worker and test share one source of truth — the same discipline `dedup-worker-phase-c.test.ts` already follows for `predictOwnerFinalNames`/`isOwnerAwareDrop`. This also shrinks the worker diff to one-line helper calls.

---

## MAJORS

### M1 — `OpKind` is the wrong axis for "loader-relevant". Use a 2-verb model.
After B1/B3, the surviving loader-changing events are exactly: **(a) a sheet/atlas you must now load instead of loose files or old sheets** (merge + pack + tier-manifest) and **(b) a single file renamed** (loose tier image + loose resize/transcode rename + bare drop = removal). The `OpKind` carried on each row is fine for *grouping/labelling*, but the draft's §4c contortion ("treat every captured change as loader-relevant because the worker only emits when a path moved") is now unnecessary: we only ever emit from the 4 surviving site-classes, all genuinely loader-relevant. Keep `kind` for display, drop the `REFERENCE_CHANGING`-reconciliation paragraph entirely.

### M2 — Loose resize/transcode rename: keep, it's the WHY's headline. (confirmed true)
`947`/`975`: `newPath = renamedTo(path, mime); if (newPath !== path) referencesChanged = true`. `logo.png → logo.webp` is a real loader-call change for a loosely-loaded image (`Assets.load('logo.png')` → `'logo.webp'`). **Keep**, kind `'transcode'`/`'resize'`. (`renamedTo(path, mime)` confirmed in `packages/fix/src/dedup-exec.ts:29`.)

### M3 — Bare drop (`990`) = removal, no load target. (confirmed)
`referencesChanged = true` because a file vanished. Render as `name (removed)`, contributes nothing to snippets. Keep, `to: null`. (But note bare-drop is the *legacy* dedup path — only fires for `op.ownerRef == null`; rare in aggressive runs which use Phase C. Still correct to surface.)

### M4 — `manifest.ts` / `core` untouched is correct; `FixChange` stays web-local. (rebuttal upheld)
The draft's claim that no `core` sign-off is needed is right: `op-manifest.ts` and the receipt's other additive fields are all web-app-local and `FixChange` parses/presents a worker format. No cross-package contract drift. ✔

### M5 — Snippets-as-code (not i18n) is correct and load-bearing. (rebuttal upheld)
The drift test (`catalogs.test.ts:20,27`) enforces key + placeholder parity across 9 locales, and the brace test (32-48) rejects leftover `{`. Generating snippet bodies verbatim from `loader-migration.ts` (identifiers, not `t()`) is the only way to avoid 9× translation cost and brace breakage. Keep. Only the 4 chrome keys translate.

---

## Final v1 scope (locked, honest)

Surface an engine-aware migration block below the `fix.mergeWarn` banner, driven by a new **`FixReceipt.changes[]`**, capturing **only genuinely loader-call-changing events**:

| event | from (old load call) | to (new load call) | kind |
|---|---|---|---|
| merge | each old atlas manifest | the merged manifest **set** (all pages) | merge |
| pack | each packed loose file | the new sheet/atlas manifest **set** | pack |
| tier (atlas/spine) | the source **manifest** | the tier manifest **set** | tier |
| tier (loose) | the source image | the tier image **set** | tier |
| loose resize/transcode rename | `logo.png` | `logo.webp` | resize/transcode |
| bare drop | the removed file | `null` (removed) | drop |

**Excluded (the skeptic cut):** dedup (B1 — manifest rewritten in place, no load-call change). The dedup story stays covered by `referencesRewritten` + the banner.

---

## 2. Contract changes — `apps/web/src/worker/fix-protocol.ts` (additive)

```ts
/** ONE loader-CALL change this fix performed (loader-migration guide). `from` = the path the game's loader
 *  called before; `to` = the path(s) it must call now (>1 for a multi-page sheet/atlas or a tier ladder),
 *  or null when the file was REMOVED. Captured ONLY for events that change a real load call — merge / pack /
 *  scale-tier / a loose rename / a bare drop. Dedup is EXCLUDED: it rewrites an AD-owned manifest in place,
 *  so the game's load call is unchanged. `kind` is for display/grouping only. Present ONLY for
 *  referencesChanged runs (drop-in/no-op runs omit `changes` ⇒ receipt byte-identical to today). */
export interface FixChange {
  from: string;
  to: string[];          // [] ⇒ removed; ≥1 ⇒ new load target(s)
  kind: OpKind;
}
```
In `FixReceipt`, alongside `referencesChanged`:
```ts
  /** Loader-migration guide (additive, optional): the loader-CALL rewrites this run made, so the UI can
   *  list concrete repointings + emit engine-aware loader snippets. Emitted ONLY when referencesChanged is
   *  true AND ≥1 real load-call change exists; deterministic (OP_KIND_ORDER then from). Absent ⇒ no guide. */
  changes?: FixChange[];
```
`to: string[]` (not `string | null`) is the B2/B3 fix: a multi-page merge or a tier ladder is genuinely set→set, and a removal is `[]`. No `core` change. `OpKind` already imported (`fix-protocol.ts:6`).

## 3. Pure module — `apps/web/src/lib/loader-migration.ts`

Sits beside `op-manifest.ts` (same web-local-presentation rationale). DOM/IO-free, deterministic.

```ts
export type Engine = 'pixi' | 'phaser';

/** Construct the change-rows for ONE merge/pack op: every old manifest fans into the full new manifest set. */
export function sheetChanges(oldRefs: readonly string[], newManifests: readonly string[], kind: 'merge' | 'pack'): FixChange[];
/** Construct the rows for ONE tiered asset: the source load-target → the full tier ladder of load-targets. */
export function tierChanges(sourceLoadPath: string, tierLoadPaths: readonly string[]): FixChange[];
/** ONE loose rename row (resize/transcode). */
export function looseRenameChange(from: string, to: string, kind: 'resize' | 'transcode'): FixChange;
/** ONE removal row. */
export function dropChange(from: string): FixChange;
/** Sort + dedup the accumulated rows (OP_KIND_ORDER, then from, then to.join). Pure. */
export function finalizeChanges(rows: readonly FixChange[]): FixChange[];

export interface RepointGroup { kind: OpKind; from: string[]; to: string[]; removed: boolean; }
/** Group changes[] for the displayed list (collapse by identical `to` set). Pure. */
export function groupChanges(changes: readonly FixChange[]): RepointGroup[];

export interface LoadTarget { kind: 'atlas' | 'image'; key: string; url: string; pageImage?: string; was: string[]; }
/** Distinct NEW load targets from changes[] (manifest .json/.atlas ⇒ atlas + its sibling page image for
 *  Phaser; image ⇒ image; removals contribute nothing; dedup by url; ordered by url). Pure. */
export function loadTargets(changes: readonly FixChange[]): LoadTarget[];

/** Verbatim copy-pasteable loader snippet (identifiers only, never i18n). Empty targets ⇒ ''. Pure. */
export function emitSnippet(engine: Engine, targets: readonly LoadTarget[]): string;
```

Snippet shapes (Pixi v8 `Assets.load`; Phaser 3 `this.load.atlas|image`), `// was:` comments carry old refs, key = sanitized basename-without-ext. Spine `.atlas` ⇒ `kind:'atlas'` with a `// requires @esotericsoftware/spine-{pixi,phaser}` honesty comment (no fabricated runtime). The worker imports these constructors and calls them at each site — so the worker diff is one helper-call per site, and the **same constructors are unit-tested directly** (B4).

## 4. Worker — `apps/web/src/worker/fix.worker.ts`

Accumulator near `467`: `const changeRows: FixChange[] = [];`. At each surviving site, push the helper's output (no inline path math):
- **merge** (after `870`): `changeRows.push(...sheetChanges(refs.map(r=>manifestPathOf(r)).filter(Boolean), newManifestPaths, 'merge'))` — collect the merged manifest paths emitted at `839`.
- **pack** (after `1195`): `changeRows.push(...sheetChanges(regions.map(r=>pathByRef.get(r.ref)).filter(Boolean), newManifestPaths, 'pack'))`.
- **tier** (after `1438`): `changeRows.push(...tierChanges(loaderTargetForAsset, tierManifestPathsOrImages))` — manifest paths for atlas/Spine (`1407`/`1414`), image paths for loose (`1397/1398`).
- **loose resize** (`947`, inside `if`): `changeRows.push(looseRenameChange(path, newPath, 'resize'))`.
- **transcode** (`975`, inside `if`): `changeRows.push(looseRenameChange(path, newPath, 'transcode'))`.
- **bare drop** (`990`): `changeRows.push(dropChange(path))`.
- **dedup**: nothing (B1).

Assembly (before `1474`): `const changes = finalizeChanges(changeRows);` then in the literal at `1483`: `...(referencesChanged && changes.length > 0 ? { changes } : {})`. No-op/drop-in ⇒ omitted ⇒ byte-identical receipt (matches `1488-1519` discipline).

## 5. UI — `apps/web/src/App.tsx`

New `LoaderMigration({ changes })` component placed after `OpManifest` (**line 1260**, not 1287). Collapsed `<details>` (instant-wow headline first): repointing list via `groupChanges` (warn coloring, `from.join(', ') → to.join(', ')` or `(removed)`), Pixi/Phaser toggle (product-name labels, untranslated), `<pre><code>` snippet + copy button with clipboard fallback. Wire at **`App.tsx:1052`**, keep the bare banner, add the block below it gated on `(receipt.changes?.length ?? 0) > 0`. Import `FixChange` into the existing `fix-protocol` type import (line 17).

## 6. i18n — 4 chrome keys × 9 locales

Add to `en.json` then mirror in the other 8 (drift test enforces): `fix.migrate.title`, `fix.migrate.removed`, `fix.migrate.note`, `fix.migrate.copy`. Engine labels + all snippet text are code, never catalog entries. Extend `catalogs.test.ts` brace block (42-48) with the 4 keys.

## 7. Determinism / honesty
Rows pushed in execution order, `finalizeChanges` sorts `(OP_KIND_ORDER, from, to.join)` and dedups → same input ⇒ deep-equal, byte-identical snippet. All pure fns: no `Date.now`/`Math.random`/Map-iteration reliance. Snippet reads only paths already written to the zip — no new asset, no new measurement, no byte/VRAM number. Invariant 3 untouched (fix engine surfacing its own rewrite, which it's permitted to do); dedup honestly excluded (no load-call changed).

## 8. Edge cases (revised)
1. No ref-change ⇒ `changes` omitted. ✔ 2. Loose rename only ⇒ one resize/transcode row (the WHY). ✔ 3. Bare drop ⇒ `to:[]`, removed, no snippet line. ✔ 4. Multi-page merge ⇒ set→set, snippet emits one load per **new** page manifest, old refs as `// was:`. ✔ 5. Spine `.atlas` ⇒ `kind:'atlas'`, plugin-gated comment. ✔ 6. dedup keep/diverge skips ⇒ never reached (and dedup emits nothing anyway). ✔ 7. Selective deselect ⇒ site loop skipped ⇒ no row. ✔ 8. All-removal ⇒ list renders, `loadTargets` empty ⇒ snippet hidden. ✔ 9. clipboard undefined ⇒ select-text fallback. ✔ 10. tiered loose image ⇒ image is the load target (correct per B3). ✔

## 9. Test plan (revised — pure, runs without the worker)
- **`loader-migration.test.ts`**: `sheetChanges`/`tierChanges`/`looseRenameChange`/`dropChange` row construction (set→set fan-in, tier ladder, removal); `finalizeChanges` ordering+dedup determinism; `groupChanges` collapse by `to`-set; `loadTargets` (.json/.atlas⇒atlas + Phaser page image; loose⇒image; removal⇒nothing; dedup by url); `emitSnippet('pixi'|'phaser')` exact goldens (merge multi-page / loose-rename / pack-spine / removal-only / empty); key sanitization (`ui-bar.json`→`ui_bar`); snippet brace-free of i18n tokens.
- **Worker-integration (existing harness pattern)**: extend a node-side re-implementation test (like `dedup-worker-phase-c.test.ts`) to assert the **constructors** are invoked with the right fixture paths at merge/pack/tier — single-source-of-truth, no worker pixel run. **Do NOT** claim to run `fix.worker.ts` in Node (B4).
- **i18n**: add 4 `fix.migrate.*` to the brace block; completeness loop auto-covers parity.
- **Green-must-stay**: `op-manifest.test.ts` (vocabulary unchanged — `REFERENCE_CHANGING` untouched per M1), `catalogs.test.ts`, any no-op receipt byte-identity test.

## 10. Ordered task breakdown (revised)

| id | title | files | tag | deps | acceptance |
|----|-------|-------|-----|------|-----------|
| **T1** | `FixChange` (`to: string[]`) + optional `receipt.changes` | `fix-protocol.ts` | contract | — | exported; typecheck green; no `core` touched |
| **T2** | Pure `loader-migration.ts`: row constructors + `finalizeChanges` + `groupChanges` + `loadTargets` + `emitSnippet` | `lib/loader-migration.ts` | pure | T1 | all fns exported, DOM/IO-free, deterministic; reuses `OP_KIND_ORDER`/`OpKind` |
| **T3** | Pure tests (constructors, grouping, targets, snippet goldens, determinism) | `lib/loader-migration.test.ts` | test | T2 | goldens pass incl. multi-page merge + tier ladder + spine + removal + empty |
| **T4** | Worker: accumulator + helper-call at 6 surviving sites (merge/pack/tier/resize/transcode/drop); **dedup excluded**; gated assembly | `fix.worker.ts` | worker | T2 | one helper call per site; `changes` gated on `referencesChanged && length>0`; drop-in run omits it; dedup pushes nothing |
| **T5** | Worker-integration via node re-impl harness (assert constructors get right paths) | extend `apps/web/test/*-worker.test.ts` | test | T4 | merge/pack/tier fixture rows match; no `fix.worker.ts` pixel run |
| **T6** | 4 `fix.migrate.*` keys in en.json + 8 translations | `i18n/src/catalogs/*.json` | i18n | — | drift+completeness green |
| **T7** | i18n brace-free assertions for the 4 keys | `i18n/test/catalogs.test.ts` | test | T6 | new keys `{`-free in all 9 |
| **T8** | `LoaderMigration` component (toggle + copy + fallback) | `App.tsx` (after 1260) | ui | T2,T6 | collapsed `<details>`; warn list; pixi/phaser; `<pre>` snippet |
| **T9** | Wire below `fix.mergeWarn` (gated on `changes?.length`) | `App.tsx` (1052) | ui | T8,T1 | renders only for ref-changing runs with rows; bare banner retained |
| **T10** | typecheck + lint + full test sweep | — | verify | T1-T9 | `pnpm typecheck && pnpm test && pnpm lint` green |

**Order:** T1 → (T2→T3) ∥ (T6→T7) → T4 → T5 → T8 → T9 → T10.

## Key files (absolute, verified)
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` — sites: merge push 870 (new manifests emitted 839), pack 1195, tier 1438 (manifests 1407/1414, loose image 1397/1398), loose resize 947, transcode 975, bare drop 990; **dedup 1261/1288 EXCLUDED (manifest rewritten in place — no load-call change)**; accumulator ~467; receipt 1474-1521.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` — `FixReceipt` 122-177, `referencesChanged` 132, additive spreads 1488-1519 model; `OpKind` import line 6. **T1 here.**
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/op-manifest.ts` — `OpKind` 19, `REFERENCE_CHANGING` 22 (**left unchanged**), `OP_KIND_ORDER` 25, `fixOpKind` 89 (reused).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` — `Receipt` 1028, bare banner **1052**, `OpManifest` **1260** (draft said 1287 — wrong), `fix-protocol` import line 17. **T8/T9 here.**
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/en.json` — fix keys from 141; `fix.mergeWarn` 179. **T6 source-of-truth (8 mirrors).**
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/catalogs.test.ts` — drift 16-30, brace block 42-48. **T7 here.**
- `/home/nonamezzz/Рабочий стол/projects/apps/web/test/dedup-worker-phase-c.test.ts` — proves worker tests use a **node re-implementation**, not the real worker (B4 driver for T5).
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/scale.ts:51` — `tieredName(path, suffix, mime?)`; `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/dedup-exec.ts:29` — `renamedTo(path, mime)`.
- New: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/loader-migration.ts` (+ `.test.ts`).

## Net assessment
**SALVAGEABLE and worth doing** — but the draft over-scoped by including dedup (dishonest — no load-call changes, B1) and mis-modeled merge/pack/tier as single-target 1:1 repointings (they are set→set, B2/B3), and it under-estimated the test effort (worker can't run in Node, B4). The revised scope is 6 honest site-classes, a `to: string[]` contract, pure constructors shared by worker + tests, and the same 4-key/snippet-as-code i18n discipline. One real judgement call remains and is now resolved cleanly: **dedup is excluded** because the loader call genuinely does not change.