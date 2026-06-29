import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageExceedsScanBudget, scanSkipReason, ANALYZE_PAGE_MAX_PX } from '../src/lib/bitmap-budget';
import { FRAME_HASH_MAX_SPRITES } from '../src/lib/perceptual';

// Round 21 #2 — two control-flow assertions that cannot live in the pure bitmap-budget test:
//   (1) runAnalysis TRANSFERS the source bytes into the worker when every PickedFile carries a re-readable
//       `file`, and CLONES (empty transfer list) when one lacks it (so a legacy caller stays correct).
//   (2) the analyze worker's whole-page frame-hash skip MAPPING — the discriminated px-cap vs sprite-cap vs
//       ok/fail branch that decides what (if anything) lands in unparsed[]. The real worker needs
//       OffscreenCanvas (browser-only), so — exactly like pipeline.test.ts replicates the worker's
//       unparsed-merge — this replicates the worker's skip→reason mapping over the SAME shared predicates the
//       worker imports, asserting it fires SELECTIVELY (an under-cap page produces NO entry), surfaces the
//       TWO distinct reasons, and yields a deterministic SORTED order regardless of which page busted the cap.

// ── (1) Transfer-vs-clone decision (FakeWorker captures the postMessage transfer list) ────────────────
type Handler = ((e: { data: unknown }) => void) | null;
let last: FakeWorker | null = null;

class FakeWorker {
  onmessage: Handler = null;
  onerror: ((e: { message?: string }) => void) | null = null;
  postMessage = vi.fn<(m: unknown, transfer?: unknown[]) => void>();
  terminate = vi.fn<() => void>();
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    last = this;
  }
}

const { runAnalysis } = await import('../src/lib/worker-client');

beforeEach(() => {
  last = null;
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const fileShim = (): File => ({ arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as File;

describe('runAnalysis — transfer vs clone (Round 21 #2: kill the 2× source copy)', () => {
  it('TRANSFERS bytes (non-empty transfer list) when every PickedFile has a re-readable file', () => {
    const files = [
      { path: 'a.png', name: 'a.png', bytes: new ArrayBuffer(4), file: fileShim() },
      { path: 'b.png', name: 'b.png', bytes: new ArrayBuffer(4), file: fileShim() },
    ];
    void runAnalysis(files, () => {});
    const w = last!;
    const [msg, transfer] = w.postMessage.mock.calls[0]!;
    expect((msg as { type: string }).type).toBe('analyze');
    expect(transfer).toHaveLength(2); // both ArrayBuffers handed off (worker becomes the sole copy)
    expect((transfer as unknown[]).every((b) => b instanceof ArrayBuffer)).toBe(true);
  });

  it('CLONES (empty transfer list) when ANY PickedFile lacks a file (legacy producer stays correct)', () => {
    const files = [
      { path: 'a.png', name: 'a.png', bytes: new ArrayBuffer(4), file: fileShim() },
      { path: 'b.png', name: 'b.png', bytes: new ArrayBuffer(4) }, // no `file` ⇒ no re-read path
    ];
    void runAnalysis(files, () => {});
    const w = last!;
    const [, transfer] = w.postMessage.mock.calls[0]!;
    expect(transfer).toEqual([]); // empty ⇒ structured clone (today's behavior, no detach)
  });
});

// ── (2) The worker's whole-page frame-hash skip MAPPING, replicated over the shared predicates ─────────
// Mirrors analyze.worker.ts: sprite-count cap (no decode) ⇒ 'spriteskip'; px cap (post-decode) ⇒ 'sizeskip';
// else 'ok'; degenerate/failure ⇒ 'fail'. Returns the discriminated kind; the worker maps each non-ok kind
// to a DISTINCT unparsed reason (or nothing for 'fail').
type SkipKind =
  | { kind: 'ok' }
  | { kind: 'sizeskip'; w: number; h: number }
  | { kind: 'spriteskip'; n: number }
  | { kind: 'fail' };

function classifyPage(w: number, h: number, spriteCount: number): SkipKind {
  if (spriteCount > FRAME_HASH_MAX_SPRITES) return { kind: 'spriteskip', n: spriteCount };
  if (w <= 0 || h <= 0) return { kind: 'fail' };
  if (pageExceedsScanBudget(w, h)) return { kind: 'sizeskip', w, h };
  return { kind: 'ok' };
}

/** The worker's caller-side mapping from a classified page to its (optional) unparsed entry. */
function unparsedFor(ref: string, k: SkipKind): { ref: string; reason: string } | null {
  if (k.kind === 'sizeskip') return { ref, reason: scanSkipReason(k.w, k.h) };
  if (k.kind === 'spriteskip')
    return { ref, reason: `skipped for size: ${k.n} sprites exceeds ${FRAME_HASH_MAX_SPRITES} sprite scan cap` };
  return null; // 'ok' and 'fail' surface nothing
}

describe('analyze worker frame-hash skip mapping (Round 21 #2)', () => {
  it('fires SELECTIVELY: an oversize page yields one size-skip entry; an under-cap sibling yields none', () => {
    const big = classifyPage(8192, 8192, 10);
    const small = classifyPage(2048, 2048, 10);
    expect(big.kind).toBe('sizeskip');
    expect(small.kind).toBe('ok'); // the anti-"always skips" guard: under the cap nothing is skipped

    const entries = [unparsedFor('big.png', big), unparsedFor('small.png', small)].filter((e) => e !== null);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ref).toBe('big.png');
    expect(entries[0]!.reason.startsWith('skipped for size:')).toBe(true);
  });

  it('px cap and sprite cap are TWO DISTINCT reasons (never conflated)', () => {
    const sizeEntry = unparsedFor('s.png', classifyPage(8192, 8192, 10))!;
    const spriteEntry = unparsedFor('t.png', classifyPage(2048, 2048, FRAME_HASH_MAX_SPRITES + 1))!;
    expect(sizeEntry.reason).toContain('8192×8192');
    expect(sizeEntry.reason).toContain('MP scan budget');
    expect(spriteEntry.reason).toContain('sprites exceeds');
    expect(spriteEntry.reason).not.toContain('MP scan budget');
    expect(sizeEntry.reason).not.toEqual(spriteEntry.reason);
  });

  it('degenerate page ⇒ fail ⇒ no entry (behavior-preserving: was a silent null before)', () => {
    expect(classifyPage(0, 100, 10).kind).toBe('fail');
    expect(unparsedFor('z.png', classifyPage(0, 100, 10))).toBeNull();
  });

  it('unparsed order is deterministic after sorting regardless of which page busted the cap', () => {
    const mk = (refs: string[]): string[] => {
      const out: { ref: string; reason: string }[] = [];
      for (const r of refs) {
        const e = unparsedFor(r, classifyPage(8192, 8192, 10)); // all size-skip for the ordering check
        if (e) out.push(e);
      }
      out.sort((a, b) => a.ref.localeCompare(b.ref)); // the worker's single post-loop sort
      return out.map((e) => e.ref);
    };
    expect(mk(['c.png', 'a.png', 'b.png'])).toEqual(['a.png', 'b.png', 'c.png']);
    expect(mk(['b.png', 'c.png', 'a.png'])).toEqual(['a.png', 'b.png', 'c.png']); // order-independent
  });

  it('the px cap used here is the single-sourced ANALYZE_PAGE_MAX_PX (no fork)', () => {
    expect(pageExceedsScanBudget(Math.sqrt(ANALYZE_PAGE_MAX_PX) | 0, Math.sqrt(ANALYZE_PAGE_MAX_PX) | 0)).toBe(false);
  });
});
