import { describe, expect, it, vi } from 'vitest';
import { ABORT_ERROR, wireAbort } from './worker-abort';

// Pure-helper coverage (round18-abortable-workers): the single-sourced settle/terminate/detach + the
// already-aborted contract + the AbortError factory. Runs in the default node env (no DOM lib needed —
// AbortController/AbortSignal/DOMException are node globals; the worker param is structural).

function fakeWorker() {
  return { terminate: vi.fn(), postMessage: vi.fn() };
}

describe('ABORT_ERROR', () => {
  it('is a DOMException named AbortError (the swallow contract)', () => {
    const e = ABORT_ERROR();
    expect(e).toBeInstanceOf(DOMException);
    expect(e.name).toBe('AbortError');
  });
});

describe('wireAbort', () => {
  it('no signal ⇒ no listener, never terminates / posts cancel / rejects', () => {
    const w = fakeWorker();
    const reject = vi.fn();
    const wiring = wireAbort(w, undefined, reject);
    expect(wiring.aborted()).toBe(false);
    expect(w.terminate).not.toHaveBeenCalled();
    expect(w.postMessage).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it('already-aborted signal ⇒ aborted()===true, attaches nothing, never terminates', () => {
    const w = fakeWorker();
    const reject = vi.fn();
    const wiring = wireAbort(w, AbortSignal.abort(), reject);
    expect(wiring.aborted()).toBe(true);
    expect(w.terminate).not.toHaveBeenCalled();
    expect(w.postMessage).not.toHaveBeenCalled();
    // The caller owns the immediate reject (pre-construct guard); wireAbort itself does not reject here.
    expect(reject).not.toHaveBeenCalled();
  });

  it('abort fires ⇒ posts {type:cancel} once, terminates once, rejects AbortError once', () => {
    const w = fakeWorker();
    const reject = vi.fn();
    const ctrl = new AbortController();
    const wiring = wireAbort(w, ctrl.signal, reject);
    expect(wiring.aborted()).toBe(false);

    ctrl.abort();

    expect(wiring.aborted()).toBe(true);
    expect(w.postMessage).toHaveBeenCalledTimes(1);
    expect(w.postMessage).toHaveBeenCalledWith({ type: 'cancel' });
    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledTimes(1);
    const err = reject.mock.calls[0]![0] as DOMException;
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe('AbortError');
  });

  it('cleanup() detaches ⇒ a later abort is a no-op', () => {
    const w = fakeWorker();
    const reject = vi.fn();
    const ctrl = new AbortController();
    const wiring = wireAbort(w, ctrl.signal, reject);
    wiring.cleanup(); // normal settle (resolve/reject) detaches the listener
    ctrl.abort();
    expect(wiring.aborted()).toBe(false);
    expect(w.terminate).not.toHaveBeenCalled();
    expect(w.postMessage).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it('idempotent settle: a double-abort terminates/rejects at most once', () => {
    const w = fakeWorker();
    const reject = vi.fn();
    const ctrl = new AbortController();
    wireAbort(w, ctrl.signal, reject);
    ctrl.abort();
    ctrl.abort(); // the listener is {once:true}; even if re-entered the settled guard blocks a second fire
    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledTimes(1);
  });
});
