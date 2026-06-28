Throwaway removed, working tree clean. I have everything I need. The premise is verified true; the three clients, both workers, both protocols, App.tsx wiring, and all key line numbers match the draft, with two corrections needed (the App.tsx controller-creation ordering, and the overstated "proven" framing of test feasibility — which I have now actually proven by execution). Here is the final revised design.

---

# Abortable Workers — Implementation-Ready Mini-Design (revised)

## 0. Adversarial verdict

**Premise: TRUE and code-grounded.** Every file, handler, loop, and line reference in the draft was verified against source. Two issues found and fixed below; no blockers; scope is sound and additive. The draft's "Go mockable seam" dismissal is correct (feature is 100% client). The one feasibility area the draft *asserted* without proof — FakeWorker under node, fix-client's Pixi import failure — I **proved by execution** (see §10.5). Net: ship as revised.

**Corrections folded in:**
- **MAJOR-1 (false detail in §8.1):** The draft says `probeAbort` controller is "created early" but implies it already exists pre-`runAnalysis`. In real source the controller is created at `App.tsx:117`, *after* `runAnalysis` resolves at `:100`. Passing `ctrl.signal` to `runAnalysis` **requires moving the `new AbortController()` to before line 100** and is not a no-op reorder — see §8.1 for the exact, verified rewrite and why the probe's `ctrl.signal.aborted` guard at `:122` stays correct.
- **MINOR-1 (overstated proof):** "feasibility proven above / confirmed by throwaway probes" had no artifact in-repo. Now actually executed (§10.5): worker-client imports clean in node; fix-client throws `navigator is not defined` at import; `vi.stubGlobal('Worker', FakeWorker)` + `new URL(..., import.meta.url)` runs under the default node env (there is **no** `test:{environment}` block in `apps/web/vite.config.ts` ⇒ default node).
- **MINOR-2 (test-convention honesty):** §10.2's FakeWorker harness is **net-new machinery with zero precedent** — every existing `*-worker.test.ts` re-implements control flow and never instantiates a `Worker`. Kept (it's the only way to lock the client wrapper, which no current test covers), but labeled honestly rather than as "the existing convention."

---

## 1. Problem (verified in source)

Three client functions each construct a `Worker` **inside** `new Promise`, expose no handle, and `terminate()` only on resolve/reject:
- `runAnalysis` — `apps/web/src/lib/worker-client.ts:18` (terminate 27/30/35). ✔
- `runFix` — `apps/web/src/lib/fix-client.ts:27`; terminate-on-done at `:51` fires **after** the main-thread ktx2/sheet probe chain settles (`.then` at `:47-52`). ✔
- `planFix` — `apps/web/src/lib/fix-client.ts:78` (terminate 83/86/93). ✔

`App.tsx` holds one `AbortController` in `probeAbort` (`:76`), aborted at `run()` start (`:88`), but wired **only** to the WebGL probe (`attachProbeReadings(..., ctrl.signal)`, `:119`) — never to the analysis worker. Re-dropping calls `run()` again; the prior analysis worker runs to completion. `FixCard` (`:1226`, single mount at `:300`) has `preview()` (`:1545`) / `run()` (`:1575`) / `togglePlanKind` (`:1565`) with `previewSeq` (`:1537`) that drops only *stale resolves* — the superseded worker still runs.

Worker loops have no cancellation check: `analyze.worker.ts` parse/feature loops (`:35`,`:57`,`:76`); `fix.worker.ts` op loop (`:1238`), ktx2 loop (`:2448`), pngquant loop (`:2533`).

---

## 2. V1 Scope

**In:**
1. Optional `signal?: AbortSignal` on `runAnalysis`, `runFix`, `planFix`. On abort: post `{type:'cancel'}`, `worker.terminate()`, `reject(DOMException('aborted','AbortError'))`, detach handlers + listener; idempotent settle (terminate/reject fire once).
2. Already-aborted signal at call time ⇒ **never construct the worker**; reject `AbortError` immediately.
3. Cooperative `cancelled` flag in both workers, set on `{type:'cancel'}`, checked at the top of each per-asset/per-op loop and before each terminal post — suppresses a late `done`/`fix-done`/`fix-plan` racing the terminate, and stops heavy pixel/decode work in the microtask gap before termination lands.
4. `App.tsx`: extend `probeAbort` to also abort the analysis worker (move controller creation before `runAnalysis`); add a `fixAbort` controller in `FixCard` so a new `run()`/`preview()` aborts the prior fix/plan worker.

**Out (explicit):** no streaming/memory-release, no parser fuzz, no decode-storm budget; no user-facing "Cancel" button (abort fires on supersession only — trivial follow-up); no backend/Go change; no protocol change beyond the additive `cancel` host→worker member; `backend-client.encodeRemote`'s in-flight `fetch` is **not** abortable in v1 — `terminate()` kills the worker context; the orphan fetch is already-uploaded, consented bytes (harmless, documented).

---

## 3. Honesty / Invariant Compliance

- **Inv 1:** abort *reduces* work, adds no network. The orphan `encodeRemote` fetch is already-uploaded consented bytes — abort leaks nothing new.
- **Inv 4:** strictly improves responsiveness (a superseded run stops competing for CPU).
- **Inv 5:** no metric math touched.
- **Additivity (the load-bearing claim):** with `signal` absent and `cancel` never posted, every path is byte-identical — same construction, handlers, terminate points; `cancelled` stays `false` for a non-aborted run's whole lifetime, so each loop guard is a dead `if`. Verified: the existing `if (msg.type !== 'analyze') return;` (`analyze.worker.ts:19`) and `if (e.data.type !== 'fix') return;` (`fix.worker.ts:178`) already ignore unknown messages — we replace the early-return with a `cancel` branch + the same fall-through, so a no-cancel run is unchanged.

---

## 4. Determinism

The `cancel` message is the only new nondeterminism source and is sent **only** on a superseded run whose partial output is discarded (promise rejects `AbortError`; callers swallow it, §8). A non-aborted run is byte-identical and fully deterministic. No `Date.now`/`Math.random`; guards read a boolean and do not alter iteration order.

---

## 5. Additive Contract / Type Changes (verified shapes)

### 5.1 `apps/web/src/worker/protocol.ts` (current: single-member `WorkerRequest` at `:9`)
```ts
export type WorkerRequest =
  | { type: 'analyze'; files: InputFile[] }
  | { type: 'cancel' };
```
No change to `WorkerResponse`.

### 5.2 `apps/web/src/worker/fix-protocol.ts` (current: single-member `FixRequest` at `:207`)
```ts
export type FixRequest =
  | { type: 'fix'; files: FixInputFile[]; options: FixOptions; mode?: FixMode }
  | { type: 'cancel' };
```
No change to `FixResponse`. No `@asset-doctor/core` change. No Go change.

---

## 6. Pure client wrapper — `apps/web/src/lib/worker-abort.ts`

Single-sources the settle/terminate/detach logic for all three clients.
```ts
export const ABORT_ERROR = (): DOMException => new DOMException('aborted', 'AbortError');

export interface AbortWiring {
  cleanup: () => void;   // remove the abort listener on a normal settle (resolve OR reject)
  aborted: () => boolean; // true once abort fired (or signal was already aborted) — guards a late resolve
}

/** Wire an AbortSignal to a worker promise. If `signal` is already aborted, returns wiring with
 *  aborted()===true and DOES NOT attach a listener (caller rejects ABORT_ERROR() and never builds the
 *  worker). Otherwise, on abort: postMessage({type:'cancel'}) → terminate() → reject(ABORT_ERROR()),
 *  once (idempotent settle). Absent signal ⇒ no listener ⇒ byte-identical to a hand-rolled promise. */
export function wireAbort(
  worker: { terminate: () => void; postMessage: (m: unknown) => void },
  signal: AbortSignal | undefined,
  reject: (e: unknown) => void,
): AbortWiring;
```
Structural `worker` param (`{terminate; postMessage}`) so the FakeWorker satisfies it with no DOM lib. Pure TS, no Pixi ⇒ unit-testable in node. Each client: `const wiring = wireAbort(worker, signal, reject)`, call `wiring.cleanup()` in every settle branch, guard success branches with `if (wiring.aborted()) return;`.

**Already-aborted contract (precise):** the caller checks `signal?.aborted` **before** `new Worker(...)`; if set, reject `ABORT_ERROR()` and return without constructing — so `wireAbort` is only ever called with a non-aborted-or-undefined signal in the construct path. (This matches the proven test: FakeWorker ctor must not be called for an already-aborted signal.)

---

## 7. Worker Changes

### 7.1 `analyze.worker.ts`
- Module scope: `let cancelled = false;`.
- Handler (`:17-19`):
```ts
ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') { cancelled = true; return; }
  if (msg.type !== 'analyze') return;
  cancelled = false;                 // defensive reset (clients build a fresh worker per run today)
  ...
};
```
- `if (cancelled) return;` at the top of the atlas loop (`:35`), image loop (`:57`), feature loop (`:76`), and before the terminal `post({type:'done', report})` (`:98`).

### 7.2 `fix.worker.ts`
- Module scope: `let cancelled = false;`.
- Handler (`:177-187`) — the existing `try { await runFix(...) } catch { post fix-error }` becomes:
```ts
ctx.onmessage = async (e) => {
  if (e.data.type === 'cancel') { cancelled = true; return; }
  if (e.data.type !== 'fix') return;
  cancelled = false;
  try { await runFix(e.data.files, e.data.options, e.data.mode ?? 'execute'); }
  catch (err) { if (!cancelled) post({ type: 'fix-error', error: err instanceof Error ? err.message : String(err) }); }
};
```
  (The `if (!cancelled)` guard on the catch prevents a cancelled run that threw mid-teardown from posting a spurious `fix-error` after the host already rejected with `AbortError`.)
- `if (cancelled) return;` at the top of: op loop (`:1238`), ktx2 loop (`:2448`), pngquant loop (`:2533`); and before: the plan-mode post `post({type:'fix-plan'...})` (`:629`), the `'zipping'` progress + `makeZip` (the post at `:2556`, the `makeZip` at `:2582`), and the final `ctx.postMessage({type:'fix-done'...}, transfer)` (`:2693`). The zip guard saves the (potentially large) zip cost on a cancelled run.
- Cancelled `runFix` early-returns void with nothing posted — correct: the host already terminated + rejected. Inner pack/tier loops are **not** individually guarded in v1 (one op is bounded; op-level guard + `terminate()` suffice) — documented.

---

## 8. UI Changes (`App.tsx`)

### 8.1 Analysis path — reuse `probeAbort`, **reorder controller creation** (MAJOR-1)
Current `run()` (`:82-127`): `probeAbort.current?.abort()` at `:88`; `runAnalysis(...)` at `:100`; `new AbortController()` at `:117`; probe at `:119` reading `ctrl.signal.aborted` at `:122`.

Revised:
```ts
async function run(picked) {
  if (picked.length === 0) { setPhase({ t:'error', message: t('error.noFiles') }); return; }
  probeAbort.current?.abort();                 // :88 — abort prior probe AND prior analysis worker
  const ctrl = new AbortController();           // MOVED up from :117 — one controller for worker + probe
  probeAbort.current = ctrl;
  const map = new Map(...); setFiles(...); setFileMap(...); setReport(null); setSelectedFinding(undefined);
  setPhase({ t:'analyzing' });
  try {
    const rep = await runAnalysis(picked, onProgress, ctrl.signal);   // NEW signal arg
    setReport(rep); ...; setPhase({ t:'done' });
    void attachProbeReadings(rep, (ref) => map.get(ref), ctrl.signal) // SAME ctrl (was a 2nd controller)
      .then((probed) => { if (!ctrl.signal.aborted && probed !== rep) setReport(probed); });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return; // superseded — newer run owns the UI
    setPhase({ t:'error', message: e instanceof Error ? e.message : String(e) });
  }
}
```
**Why the reorder is safe (verified):** the probe only starts *after* `runAnalysis` resolves, so a probe never runs against a not-yet-aborted controller; the `ctrl.signal.aborted` guard at the write-back (`:122`) is preserved and still correct — if a re-drop aborts `ctrl` while analysis is in flight, `runAnalysis` rejects `AbortError` (caught + swallowed) and the probe `.then` never even attaches. The ref may keep the name `probeAbort` (minimal churn) or rename to `runAbort` (clearer; it now governs worker + probe) — one ref either way. **The existing `openFolder` catch (`:134`) already uses `e.name === 'AbortError'`** — the new catch mirrors that exact contract, so the `DOMException('aborted','AbortError')` name in §6 is load-bearing for uniformity.

### 8.2 Fix path — new `fixAbort` controller in `FixCard`
Add `const fixAbort = useRef<AbortController|null>(null);` (near `previewSeq` at `:1537`).
- `preview()` (`:1545`) and `run()` (`:1575`): at the top, `fixAbort.current?.abort(); const ctrl = new AbortController(); fixAbort.current = ctrl;` then pass `ctrl.signal` to `planFix(files, buildOptions(over), ctrl.signal)` / `runFix(files, buildOptions(), onProgress, ctrl.signal)`.
- Both catches: swallow `AbortError` (`if (e instanceof DOMException && e.name === 'AbortError') return;`) before painting the error phase. `preview()` keeps `previewSeq` (it guards *ordering of legit completing overlapping previews*; abort additionally stops the discarded one's CPU — they are complementary, not redundant). Note the `previewSeq` guard at `:1552`/`:1555` returns *before* `setPhase`, so the AbortError-swallow in the catch must sit before the seq check or be unreachable for the aborted promise — order it first.
- `togglePlanKind` (`:1565`) → `preview(next)` inherits the abort automatically. Single mount (`:300`) ⇒ no cross-instance coupling.

---

## 9. Edge Cases

1. **Already-aborted at call time** → reject `AbortError`, no `new Worker`. Test asserts the FakeWorker ctor is never called.
2. **Abort after a terminal response already resolved** → `wiring.cleanup()` detached the listener ⇒ no-op; idempotent settle blocks double-settle.
3. **`runFix` abort during the main-thread ktx2/sheet probe chain** (`fix-client.ts:47`) → worker terminated; the probe `.then` (`:49-52`) resolves into nothing because `resolve` is guarded by `wiring.aborted()`. Probe is short + side-effect-free. Documented v1 limitation.
4. **`onerror` after abort** → same settle flag ⇒ no double reject.
5. **No signal** → no listener attached; identical to today.
6. **`cancel` arriving after the worker finished/terminated** → worker gone (dropped) or flag set with no loop left to read it — harmless.
7. **Re-drop spam (N drops)** → each `run()` aborts the prior; `probeAbort.current` points at the newest only.
8. **AbortError name contract** → exactly `DOMException('aborted','AbortError')` so all `e.name === 'AbortError'` checks (mirroring `App.tsx:134`) work uniformly.

---

## 10. Test Plan (Vitest — default node env, **proven**)

No browser e2e; Go N/A. Two new web test files.

### 10.1 `apps/web/src/lib/worker-abort.test.ts` (pure helper)
- already-aborted signal → `aborted()===true`, **no listener attached** (abort-after has no effect), no terminate.
- abort fires → `terminate()` once, `postMessage({type:'cancel'})` once, `reject` once with a `DOMException` whose `.name==='AbortError'`.
- `cleanup()` detaches → abort-after-cleanup is a no-op.
- no signal → no listener, no terminate, no cancel post.

### 10.2 `apps/web/test/worker-client-abort.test.ts` (the three clients) — net-new FakeWorker harness
Honest framing: this is **new test machinery** (no existing test instantiates a `Worker`); it is justified because the client wrappers are otherwise *uncovered* (current `*-worker.test.ts` files test the pure pipeline, not the client). Mock global `Worker` with a `FakeWorker` (`vi.stubGlobal('Worker', FakeWorker)`); for `fix-client`, `vi.mock('../src/lib/ktx2-probe-run')` and `'../src/lib/sheet-probe-run')` (**required** — they import Pixi → `navigator is not defined` at module load, proven §10.5). Per client (`runAnalysis`, `runFix`, `planFix`):
1. **terminate-on-abort:** fresh controller → `abort()` → rejects `AbortError`; `FakeWorker.prototype.terminate` called; `{type:'cancel'}` posted.
2. **already-aborted:** pass `AbortSignal.abort()` → rejects `AbortError`, **FakeWorker ctor not called**.
3. **no-signal byte-identity:** omit `signal` → FakeWorker drives `onmessage` (`progress` then `done`/`fix-done`/`fix-plan`) → resolves with the payload; terminate once on done; **no `cancel` ever posted**.
4. **late-resolve-after-abort swallowed:** abort, then FakeWorker posts `done` → still rejects `AbortError` (settle guard), no double-settle.

For `runFix`, FakeWorker posts `fix-done` with **no** `ktx2Probe` so the mocked probe chain resolves; assert resolve returns `{receipt, zip}`.

### 10.3 Worker cooperative-flag coverage
Worker files can't run in node (`self`/OffscreenCanvas), consistent with `plan-worker.test.ts`/`sheet-diff-worker.test.ts` re-implementing control flow rather than importing the worker. The `cancelled` guard is a trivial structural change; its *contract* (cancel posted on abort) is locked by §10.2. A full in-worker flag test is **out of scope** (matches existing convention). Skip in v1.

### 10.4 Regression
- `corepack pnpm --filter web exec vitest run` stays green — the no-signal path is byte-identical.
- `corepack pnpm typecheck` — additive union members + optional params must not break existing no-signal callers.

### 10.5 Feasibility facts — **verified by execution** (not asserted)
Ran a throwaway vitest in `apps/web` (then removed it; tree clean):
- `worker-client.ts` imports cleanly in node — `runAnalysis` is a function. ✔
- `fix-client.ts` throws **`navigator is not defined`** at import (Pixi via probe-run) ⇒ fix-client tests **must** mock `ktx2-probe-run` + `sheet-probe-run`. ✔
- `vi.stubGlobal('Worker', FakeWorker)` + `new URL('http://...')` runs under the **default node env** (confirmed: `apps/web/vite.config.ts` has **no** `test:{environment}` block ⇒ vitest default node). ✔

---

## 11. Ordered Task Breakdown (small commits)

1. **`feat(web): additive cancel message in worker protocols`** — `{type:'cancel'}` into `WorkerRequest` (`protocol.ts:9`) + `FixRequest` (`fix-protocol.ts:207`). Typecheck-only; no behavior.
2. **`feat(web): pure worker-abort wrapper`** — `apps/web/src/lib/worker-abort.ts` (`wireAbort`+`ABORT_ERROR`) + `worker-abort.test.ts` (§10.1). Self-contained.
3. **`feat(web): signal param on runAnalysis`** — wire `wireAbort` into `worker-client.ts`; optional `signal`; already-aborted fast-path (no `new Worker`); `cleanup()` on every settle. No-signal path unchanged.
4. **`feat(web): signal param on runFix/planFix`** — same wiring in `fix-client.ts` (both); guard success branches with `wiring.aborted()`; keep the ktx2/sheet probe chain behind the aborted guard.
5. **`test(web): worker-client abort harness`** — `apps/web/test/worker-client-abort.test.ts` with FakeWorker + the two probe-run mocks; four assertions per client (§10.2).
6. **`feat(web): cooperative cancel flag in analyze.worker`** — flag, handler branch, loop + done-post guards (§7.1).
7. **`feat(web): cooperative cancel flag in fix.worker`** — flag, handler branch (incl. the `if (!cancelled)` catch guard), op/ktx2/pngquant/zip/fix-done/plan-post guards (§7.2).
8. **`feat(web): abort the analysis worker on re-drop`** — `App.tsx run()`: **move `new AbortController()` above `runAnalysis`** (MAJOR-1), pass `signal`, reuse one `ctrl` for worker+probe, swallow `AbortError` in catch (mirror `:134`). Optionally rename `probeAbort`→`runAbort`.
9. **`feat(web): abort the fix/preview worker on supersession`** — `FixCard`: `fixAbort` ref; abort + fresh controller + pass `signal` in `run()` and `preview()`; swallow `AbortError` first in both catches (before the `previewSeq` guard).
10. **`docs: note worker cancellation + encodeRemote orphan-fetch v1 limitation`** — short note (fold into commit 9's body if the repo prefers no standalone doc).

Commits 1-7 are dormant additive seams (no caller passes a signal ⇒ byte-identical); 8-9 activate the wiring; 5 locks the client contract. Each commit independently green.

### Key file references (line-verified)
- `apps/web/src/lib/worker-client.ts:18` (runAnalysis) · `apps/web/src/lib/fix-client.ts:27` (runFix), `:78` (planFix), probe-chain `:47-52`
- `apps/web/src/worker/analyze.worker.ts` (handler `:17/:19`, loops `:35/:57/:76`, done-post `:98`) · `apps/web/src/worker/fix.worker.ts` (handler `:177-187`, plan-post `:629`, op-loop `:1238`, ktx2 `:2448`, pngquant `:2533`, zipping-post `:2556`, makeZip `:2582`, fix-done `:2693`)
- `apps/web/src/worker/protocol.ts:9` · `apps/web/src/worker/fix-protocol.ts:207`
- `apps/web/src/App.tsx` (probeAbort `:76`, run `:82/:88/:100/:117/:119/:122`, openFolder AbortError `:134`, FixCard `:1226`, mount `:300`, previewSeq `:1537`, preview `:1545`, togglePlanKind `:1565`, run `:1575`)
- Model: `apps/web/src/lib/probe-run.ts:59` (`signal` param) + `:65/:71` (`signal?.aborted` guards) · `apps/web/src/lib/probe-run.test.ts:104` (already-aborted test).