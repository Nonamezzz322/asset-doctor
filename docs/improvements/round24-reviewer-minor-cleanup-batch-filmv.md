Confirmed: FilmViewer redraws atomically inside the `createImageBitmap().then` (clearRect then drawImage in one tick, cancel-flag guarded, lines 48-84). It never blanks itself. The flicker is genuinely the parent's `setSelectedBytes(null)` at line 227 unmounting FilmViewer (render gate 334 → `noImage`). The draft's root-cause for (5) is correct.

I have verified every load-bearing claim. Summary of findings:

- **(5) FilmViewer:** root cause confirmed accurate (eager `setSelectedBytes(null)` at App.tsx:227; FilmViewer redraws atomically). **But the test plan is a false premise** — apps/web has NO React test harness (no jsdom/happy-dom, no @testing-library, env=node, zero component tests). Must drop to either a pure extracted-helper test or no test.
- **(6) folder.ts:** confirmed exactly — lines 397/398 bare `.sort()`, lines 345/375 already `localeCompare`. Anchor/detail/refs sites (411-429) confirmed. The mixed-case regression test is feasible against the real pure path (describe at 609). One refinement: the existing golden at line 649/650 asserts `'A.png'`/`'B.png'` ordering — both code-unit AND localeCompare agree there, so it won't move. Good.
- **(7) gzipLen:** confirmed — module-private inside a non-importable worker (ctx.onmessage:274, ctx=self:221), call site 3677 exact. Extraction precedent (transcode-guard) confirmed. `CompressionStream` IS a Node-20 global (verified `typeof === 'function'`). Test is fully feasible.

Now I'll write the revised mini-design.

---

# Mini-Design (REVISED) — Reviewer-MINOR cleanup batch (5)(6)(7)

FilmViewer keep-last-frame · cross-atlas comparator unification · `gzipLen` 0-byte guard + worker-path test. One low-risk commit-set, zero deploy dependency, verifiable now.

**Verdict: ACCEPT with one BLOCKER fix.** All three root-causes are code-accurate and confirmed byte-for-byte. (6) and (7) are clean as drafted. **(5)'s implementation is correct but its TEST PLAN rests on a false premise** and is revised below.

## BLOCKER (fixed in this revision) — (5) has no test harness

The draft proposes a "component-level test" / "simulate the re-read effect's lifecycle" / "full React-render test (if too heavy…)". **Verified false premise:** `apps/web` has **no React test infrastructure** — `vite.config.ts` has no `test` block, no separate vitest config exists, so the env defaults to `node`; `jsdom`/`happy-dom`/`@testing-library/react` are **not in devDependencies**; the only `render(` in the whole app is `main.tsx`'s `createRoot`; all 11 existing web tests are pure-logic/lib tests (mocked WebGL). A render-test would require pulling in a jsdom + testing-library dep set — which violates the draft's own "no new dep / out-of-scope" claim and the convention gate (lib choice needs prior agreement).

**Resolution (chosen): extract the swap decision to a pure helper and unit-test THAT** — the same discipline (5)/(6)/(7) already rely on (transcode-guard, sheet-diff). The effect's branch logic becomes a pure function returning one of three actions; the React effect becomes a thin dispatcher. This makes the load-bearing assertion ("success path never blanks; clear only on no-selection/no-reader") testable in the existing `node` env with zero new deps.

New file `apps/web/src/lib/film-selection.ts`:
```ts
/** Decision for the re-read effect (App.tsx). PURE so the "never blank on a live re-selection" rule is
 *  Node-testable (apps/web has no React test harness — env=node, no jsdom/testing-library). The effect is a
 *  thin dispatcher over this. 'clear' ⇒ honest no-image (no selection / no reader); 'read' ⇒ keep the prior
 *  film mounted and swap when the new bytes resolve (no flicker). Round-NN reviewer-MINOR (5). */
export function filmSelectionAction(
  hasSelection: boolean,
  hasReader: boolean,
): 'clear' | 'read' {
  if (!hasSelection) return 'clear'; // no selection → genuine empty state
  if (!hasReader) return 'clear';    // no reader (folder moved / legacy producer) → honest no-image
  return 'read';                     // keep prior film, swap on resolve — never blank between two valid films
}
```

Revised effect in `App.tsx` (216-234) dispatches over it — the success path no longer clears:
```ts
useEffect(() => {
  const action = filmSelectionAction(!!debouncedSelected, debouncedSelected ? readers.has(debouncedSelected) : false);
  if (action === 'clear') {
    setSelectedBytes(null);
    return;
  }
  let cancelled = false;
  const reader = readers.get(debouncedSelected!)!; // action==='read' ⇒ reader present (filmSelectionAction)
  // Keep the prior film mounted while the new ref re-reads — no blank flash on row click / arrow-scrub.
  // The cancel flag still guarantees a rapid re-selection never lands stale bytes on a newer film.
  void reader().then((b) => {
    if (!cancelled) setSelectedBytes(b);
  });
  return () => { cancelled = true; };
}, [debouncedSelected, readers]);
```
Render gate at App.tsx:334 unchanged — it simply never sees a transient `null` between two valid selections. FilmViewer (48-89, verified) redraws atomically inside `createImageBitmap().then` (clearRect→drawImage in one tick, cancel-guarded) and never self-blanks, so holding the prior `bytes` shows the previous real atlas for ~one re-read, then the new real one.

**Test** `apps/web/src/lib/film-selection.test.ts` (pure, node env, mirrors transcode-guard.test.ts):
- `filmSelectionAction(false, false) === 'clear'` (no selection).
- `filmSelectionAction(true, false) === 'clear'` (selection, no reader → honest no-image).
- `filmSelectionAction(true, true) === 'read'` — **the load-bearing case: a live re-selection never returns 'clear', so the success path never blanks.** This is the regression lock for the flicker.

## V1 scope (confirmed against real code)

- **(5)** FilmViewer flicker — root cause = App.tsx:227 eager `setSelectedBytes(null)` on the success path; render gate 334 then renders `report.noImage`. FilmViewer itself is atomic (48-89). Fix in parent only, via the pure helper above.
- **(6)** `crossAtlasRedundancyFinding` (folder.ts) — lines 345/375 already `localeCompare`; output sets at **397/398 use bare `.sort()`**. `sortedAtlases[0]` is `assetRef` (411) + detail join + `params.atlases` (415-416,429); `sortedRefs` is `relatedRefs` + `params.refs` (412,428). Unify 397/398 on `localeCompare`.
- **(7)** `gzipLen` (fix.worker.ts:4174-4179) — add `bytes.length===0 ⇒ 0` guard; extract to a co-located pure module so it's testable (the worker is non-importable: top-level `ctx=self` at 221, `ctx.onmessage` at 274). Call site 3677 unchanged.

## Out of scope (unchanged)
within-merge within-atlas dedup threshold · format∩wasted-alpha footprint dedup order · stale TriageLedger i18n-scan prune · broad gzip-mode end-to-end worker test (worker non-importable). No behavioral change to compression level, manifest schema, overlay rendering, or any finding's numbers on ASCII inputs.

## Contract / type changes
**None.** Two new internal web-app-private modules (`apps/web/src/lib/film-selection.ts`, `apps/web/src/worker/gzip-len.ts`) — neither crosses a package boundary, so no `@asset-doctor/core` coordination per the convention gate. No new third-party dependency (this is what kills the original (5) render-test plan).

## Pure modules + signatures

`apps/web/src/worker/gzip-len.ts` (pure, no `self`/`ctx` at top level — mirrors transcode-guard.ts):
```ts
/** Gzip-compressed byte length of `bytes` via the Worker CompressionStream primitive (round23 #2,
 *  includeFileSizes='gzip'). NO network, NO native lib, NO backend (invariant 1). Returns the REAL
 *  compressed length; the manifest's progressSize = this /1024. Empty input ⇒ 0 (the manifest's
 *  missing⇒0 rule; an empty file has no transported bytes — never the ~20-byte gzip frame overhead).
 *  Deterministic for identical input (fixed zlib level/dictionary); tests assert raw bound, gzip as a
 *  bound (>0, ≤ raw for compressible input), not a pinned length. */
export async function gzipLen(bytes: Uint8Array): Promise<number> {
  if (bytes.length === 0) return 0; // honest 0, not the gzip frame overhead (same class as missing⇒0)
  const cs = new CompressionStream('gzip');
  const compressed = await new Response(new Response(bytes.slice()).body!.pipeThrough(cs)).arrayBuffer();
  return compressed.byteLength;
}
```
fix.worker.ts imports it (`import { gzipLen } from './gzip-len';`); the inline `async function gzipLen` (4174-4179) is deleted; call site 3677 byte-identical.

`apps/web/src/lib/film-selection.ts` — `filmSelectionAction` as above (replaces the draft's "no new pure functions for (5)"; required to make (5) testable without a render harness).

(6) needs no new module — two one-line comparator changes in the existing pure function.

## Worker / UI changes
- **UI (5):** App.tsx 216-234 effect → dispatch over `filmSelectionAction`; drop the success-path clear (227). Import the helper.
- **Worker (6):** folder.ts 397-398 `.sort()` → `.sort((a, b) => a.localeCompare(b))`. Update the inline comment to note all four ordering sites (345/375/397/398) now share one collation (matching manifest.ts).
- **Worker (7):** extract `gzipLen`, add empty guard, delete inline copy.
- **Backend:** none.

## Honesty + invariant compliance
- **Inv 1:** `gzipLen` stays a Worker `CompressionStream` primitive — no native lib, no backend, no network; extraction is a file move, byte path identical.
- **Inv 3:** (5) the re-read is byte-identical to the original (App.tsx comment 214) — holding the last frame shows the *previous real* atlas for ~one re-read, then the new real one; the honest no-image branch still fires whenever there's truly no reader/selection (the `'clear'` action). (6) is a pure ordering change; measured numbers untouched. (7) reporting `0` for an empty file is *more* honest than the ~20-byte frame overhead.
- **Inv 5:** untouched; `gzipLen` feeds only disk-side `progressSize`, never VRAM.
- **check-invariants:** no new network call, analysis still in-worker, backend still thin, nothing generated.

## Determinism
- **(6)** `localeCompare` (no locale arg) is deterministic for a fixed ICU build (Node/V8 + browser both ship ICU; folder.ts already relies on it at 345/375, manifest.ts too). On pure-ASCII inputs `localeCompare` and code-unit `.sort()` agree → existing goldens unaffected unless a mixed-case/non-ASCII name is present. This removes an inconsistency, adds no new dependency.
- **(7)** deterministic for identical input; the guard makes the empty case deterministically `0`. Tests assert raw bound, not a pinned gzip length.
- **(5)** state-mount timing only; no data determinism involved. `filmSelectionAction` is a pure total function over two booleans.

## Edge cases
- **(5)** First selection (no prior bytes): `selectedBytes` starts `null` → noImage until first read resolves (unchanged). Reader missing: `'clear'` (correct). Rapid A→B→A: cancel flag drops stale reads; canvas holds the most-recent *resolved* frame until the newest resolves; newest always wins via `cancelled` — never stale-locks. Selection cleared (`debouncedSelected` undefined): `'clear'`. The "~one re-read stale" window is the intended trade.
- **(6)** Atlases differing only by case/diacritic (`a.png` vs `A.png`, `é` vs `e`): anchor, detail join, `params.atlases`, `relatedRefs` now all order under `localeCompare`, matching cluster determinism. Empty `atlasSet`/`refs` can't reach (dupes<1 ⇒ null at 394); single qualifying atlas can't reach (≥2-distinct-atlas gate at 359).
- **(7)** Empty `bytes` ⇒ `0` (guard). Incompressible bytes: gzip can exceed raw by a few frame bytes — test asserts `>0` and `≤ raw` **for compressible input only** (random/incompressible not asserted ≤ raw). `.slice()` copy (SharedArrayBuffer safety) preserved.

## Test plan (real harness; node env confirmed; no new deps)
- **(7) `apps/web/src/worker/gzip-len.test.ts`** (co-located, node env — `typeof CompressionStream === 'function'` VERIFIED in Node 20.20.2): `gzipLen(empty)===0` after the guard (the defect: pre-guard returned the ~20-byte frame); `gzipLen(te.encode('a'.repeat(2000))) > 0 && ≤ raw.length` (real `CompressionStream` byte path — previously untested branch); single-byte `> 0` (no false-zero). Real API, not mocked.
- **(6) extend `analysis.test.ts` cross-atlas describe (609-765), real pure path:** add a case where code-unit and locale collation DISAGREE. NOTE — the existing goldens use `'A.png'`/`'B.png'` where both collations agree (verified line 649-650), so they won't move. New case e.g. `'B.png'` + `'a.png'` (code-unit: `'B'` 0x42 < `'a'` 0x61; localeCompare: `'a'` < `'B'`), shared hash across both. CONFIRM `f` not null, then assert `f.assetRef==='a.png'`, `f.params.atlases` and `f.relatedRefs` follow `localeCompare`. Re-run existing ASCII goldens (expected: none move).
- **(5) `apps/web/src/lib/film-selection.test.ts`** (pure, node env — REPLACES the unbuildable render-test): three cases on `filmSelectionAction`; the load-bearing one is `(true, true) === 'read'` (live re-selection never blanks). Plus a one-line code check that App.tsx's `'read'` branch no longer calls `setSelectedBytes(null)`.
- **Full suites:** `pnpm --filter @asset-doctor/analysis test` · `pnpm --filter @asset-doctor/web test` · `pnpm typecheck` · `pnpm lint`.

## Ordered task breakdown (small commits)
1. **`fix(fix): gzipLen 0-byte guard + extract to testable module`** — create `apps/web/src/worker/gzip-len.ts` with the empty guard; replace inline `gzipLen` in fix.worker.ts with the import; delete the old def (4174-4179). Call site 3677 unchanged.
2. **`test(fix): gzipLen worker CompressionStream path + empty guard`** — add `gzip-len.test.ts` (empty⇒0; compressible >0 and ≤ raw; tiny >0). Real `CompressionStream` (node global confirmed).
3. **`fix(analysis): unify crossAtlasRedundancy comparator on localeCompare`** — folder.ts 397-398 `.sort()` → `.sort((a,b)=>a.localeCompare(b))`; comment notes all four sites (345/375/397/398) share collation (matching manifest.ts).
4. **`test(analysis): cross-atlas collation regression (mixed-case anchor)`** — add the `'B.png'`/`'a.png'` case to analysis.test.ts; re-run goldens (expected: none shift on ASCII).
5. **`fix(web): FilmViewer keep-last-frame on re-selection (no flicker)`** — add `apps/web/src/lib/film-selection.ts` (`filmSelectionAction`); rewire App.tsx 216-234 to dispatch over it, dropping the success-path eager clear; add `film-selection.test.ts` (the `(true,true)==='read'` regression lock).

Each commit is independently green and one semantic change.

## Key revisions vs draft
1. **BLOCKER fixed:** (5)'s test plan assumed a React render harness that does not exist in apps/web (env=node, no jsdom/testing-library, zero component tests — verified). Replaced with a pure extracted `filmSelectionAction` helper + node-env unit test — same discipline as transcode-guard, zero new deps. The App.tsx fix itself is correct as drafted; only the test mechanism changed.
2. **MINOR:** noted the existing cross-atlas goldens (649-650) already agree under both collations, so the draft's "expected: none move" is verified, not merely hoped.

Everything else in the draft is code-accurate and stands.

Relevant files: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` (re-read effect 216-234, render gate 334) · `/home/nonamezzz/Рабочий стол/projects/apps/web/src/components/FilmViewer.tsx` (atomic redraw 42-89) · `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/folder.ts` (345/375 ref, 397/398 fix, anchor/detail/refs 411-429) · `/home/nonamezzz/Рабочий стол/projects/packages/analysis/test/analysis.test.ts` (cross-atlas describe 609-765; goldens 649-650 agree under both collations) · `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` (gzipLen 4174-4179, call site 3677, ctx=self 221, onmessage 274) · `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/transcode-guard.ts` + `transcode-guard.test.ts` (extraction precedent) · `/home/nonamezzz/Рабочий стол/projects/apps/web/vite.config.ts` (no test block → node env, no jsdom) · new: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/gzip-len.ts` + `gzip-len.test.ts`, `/home/nonamezzz/Рабочий стол/projects/apps/web/src/lib/film-selection.ts` + `film-selection.test.ts`.