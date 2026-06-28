// round18-abortable-workers: the ONE place the three worker clients (runAnalysis, runFix, planFix)
// single-source their abort wiring — settle/terminate/detach + the already-aborted immediate reject +
// the AbortError factory. Pure TS (no Pixi, no DOM lib beyond AbortSignal/DOMException) ⇒ unit-testable
// in the default node env.
//
// ADDITIVITY (load-bearing): with `signal` ABSENT, wireAbort attaches NO listener and never touches the
// worker ⇒ each client's promise behaves byte-identically to a hand-rolled `new Promise` (same handlers,
// same terminate points). `aborted()` stays false for the whole lifetime ⇒ the success-branch guards are
// dead `if`s. The ONLY new behavior fires on a real abort (a superseded run).

/** The exact rejection a superseded worker promise carries. Name === 'AbortError' so every existing
 *  `e instanceof DOMException && e.name === 'AbortError'` check (App.tsx openFolder + the new run()/fix
 *  catches) swallows it uniformly. */
export const ABORT_ERROR = (): DOMException => new DOMException('aborted', 'AbortError');

export interface AbortWiring {
  /** Detach the abort listener on a NORMAL settle (resolve OR reject) so an abort fired afterward is a
   *  no-op. Idempotent. */
  cleanup: () => void;
  /** True once abort has fired (or the signal was already aborted at call time). Guards a success branch
   *  so a terminal worker message that raced the terminate cannot resolve a promise the host abandoned. */
  aborted: () => boolean;
}

/** Wire an AbortSignal to a worker promise's reject.
 *
 *  CONTRACT: the caller checks `signal?.aborted` BEFORE constructing the worker; if set it rejects
 *  ABORT_ERROR() and returns WITHOUT `new Worker(...)`. So `wireAbort` is only ever reached with a
 *  not-yet-aborted-or-undefined signal in the construct path.
 *
 *  - signal undefined ⇒ NO listener attached; settle/terminate stay exactly the client's own logic.
 *  - signal present, on abort ⇒ postMessage({type:'cancel'}) → terminate() → reject(ABORT_ERROR()), ONCE
 *    (idempotent settle: terminate + reject fire at most once across abort/onerror/late-resolve races).
 *
 *  `worker` is structural ({terminate; postMessage}) so a test FakeWorker satisfies it with no DOM lib. */
export function wireAbort(
  worker: { terminate: () => void; postMessage: (m: unknown) => void },
  signal: AbortSignal | undefined,
  reject: (e: unknown) => void,
): AbortWiring {
  // Defensive: if a signal is somehow already aborted here (caller should have short-circuited), expose
  // aborted()===true and attach nothing — the caller's pre-construct guard owns the immediate reject.
  if (signal?.aborted) {
    return { cleanup: () => {}, aborted: () => true };
  }

  let settled = false; // guards terminate/reject so they fire at most once
  let didAbort = false;

  const onAbort = (): void => {
    didAbort = true;
    if (settled) return;
    settled = true;
    worker.postMessage({ type: 'cancel' });
    worker.terminate();
    reject(ABORT_ERROR());
  };

  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  return {
    cleanup: () => {
      settled = true; // a normal settle also closes the idempotent gate
      if (signal) signal.removeEventListener('abort', onAbort);
    },
    aborted: () => didAbort,
  };
}
