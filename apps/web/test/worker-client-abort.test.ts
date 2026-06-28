import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// round18-abortable-workers — the three worker CLIENTS (runAnalysis, runFix, planFix). This is NET-NEW
// test machinery: no existing test instantiates a `Worker` (the *-worker.test.ts files exercise the pure
// pipeline). It is justified because the client wrappers are otherwise UNCOVERED. We stub the global
// `Worker` with a controllable FakeWorker and assert: terminate-on-abort + AbortError reject + cancel
// posted; already-aborted ⇒ no worker constructed; no-signal byte-identity (no cancel ever posted,
// resolve as today); late-resolve-after-abort swallowed.
//
// fix-client imports Pixi (via ktx2-probe-run / sheet-probe-run), which throws `navigator is not defined`
// at module load under node — so those two modules MUST be mocked before importing fix-client.
vi.mock('../src/lib/ktx2-probe-run', () => ({
  attachKtx2Probe: vi.fn(async (receipt: unknown) => receipt),
}));
vi.mock('../src/lib/sheet-probe-run', () => ({
  attachSheetProbes: vi.fn(async (receipt: unknown) => receipt),
}));

const { runAnalysis } = await import('../src/lib/worker-client');
const { runFix, planFix } = await import('../src/lib/fix-client');

// ── Controllable FakeWorker ──────────────────────────────────────────────────────────────────────
// Tests drive it by reaching the latest instance and synchronously invoking its onmessage with a crafted
// response. terminate/postMessage are spies. The ctor count proves the already-aborted fast-path never
// builds a worker.
type Handler = ((e: { data: unknown }) => void) | null;
const ctorCalls: { url: unknown }[] = [];
let last: FakeWorker | null = null;

class FakeWorker {
  onmessage: Handler = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  postMessage = vi.fn<(m: unknown) => void>();
  terminate = vi.fn<() => void>();
  posted: unknown[] = [];
  constructor(url: unknown) {
    ctorCalls.push({ url });
    // The harness needs the just-built instance to drive its onmessage/spies — that capture IS the point
    // of a FakeWorker (the client constructs the worker internally, so we can't intercept otherwise).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    last = this;
  }
  // helper: deliver a worker→host message
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

beforeEach(() => {
  ctorCalls.length = 0;
  last = null;
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const FILES = [{ path: 'a.png', name: 'a.png', bytes: new ArrayBuffer(4) }] as never;
const OPTS = {} as never;

function expectAbortError(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => {
      throw new Error('expected rejection, got resolve');
    },
    (e) => {
      expect(e).toBeInstanceOf(DOMException);
      expect((e as DOMException).name).toBe('AbortError');
    },
  );
}

// All `cancel` posts collected on a worker (so we can assert "no cancel ever posted" in the no-signal case).
function cancelPosts(w: FakeWorker): unknown[] {
  return w.postMessage.mock.calls.map((c) => c[0]).filter((m) => (m as { type?: string })?.type === 'cancel');
}

describe.each([
  {
    name: 'runAnalysis',
    call: (signal?: AbortSignal) => runAnalysis(FILES, () => {}, signal),
    doneMsg: { type: 'done', report: { ok: true } },
    resolvesTo: (r: unknown) => expect(r).toEqual({ ok: true }),
  },
  {
    name: 'planFix',
    call: (signal?: AbortSignal) => planFix(FILES, OPTS, signal),
    doneMsg: { type: 'fix-plan', summary: { opCounts: {}, totalOps: 0, skipped: [], referencesChanged: false, hasDeferredChecks: false } },
    resolvesTo: (r: unknown) => expect((r as { totalOps: number }).totalOps).toBe(0),
  },
  {
    name: 'runFix',
    call: (signal?: AbortSignal) => runFix(FILES, OPTS, () => {}, signal),
    // no ktx2Probe ⇒ the mocked probe chain resolves immediately with the same receipt.
    doneMsg: { type: 'fix-done', receipt: { fileCount: 1 }, zip: new Blob(['z']) },
    resolvesTo: (r: unknown) => {
      const o = r as { receipt: { fileCount: number }; zip: Blob };
      expect(o.receipt.fileCount).toBe(1);
      expect(o.zip).toBeInstanceOf(Blob);
    },
  },
])('$name', ({ call, doneMsg, resolvesTo }) => {
  it('no-signal byte-identity: resolves on done, terminates once, NEVER posts cancel', async () => {
    const p = call(undefined);
    const w = last!;
    expect(ctorCalls.length).toBe(1);
    w.emit(doneMsg);
    const r = await p;
    resolvesTo(r);
    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(cancelPosts(w)).toEqual([]);
  });

  it('already-aborted signal ⇒ rejects AbortError, NEVER constructs a worker', async () => {
    const p = call(AbortSignal.abort());
    await expectAbortError(p);
    expect(ctorCalls.length).toBe(0);
  });

  it('abort fires ⇒ rejects AbortError, terminates, posts {type:cancel}', async () => {
    const ctrl = new AbortController();
    const p = call(ctrl.signal);
    const w = last!;
    expect(ctorCalls.length).toBe(1);
    ctrl.abort();
    await expectAbortError(p);
    expect(w.terminate).toHaveBeenCalled();
    expect(cancelPosts(w)).toEqual([{ type: 'cancel' }]);
  });

  it('late-resolve-after-abort is swallowed (still AbortError, no double-settle)', async () => {
    const ctrl = new AbortController();
    const p = call(ctrl.signal);
    const w = last!;
    ctrl.abort();
    // A done racing the terminate: the success branch is guarded by wiring.aborted() ⇒ ignored.
    w.emit(doneMsg);
    await expectAbortError(p);
  });
});
