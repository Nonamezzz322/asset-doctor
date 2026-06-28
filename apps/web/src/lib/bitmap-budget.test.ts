import { describe, expect, it } from 'vitest';
import { BITMAP_BUDGET_BYTES, BitmapBudget, bitmapBytes, type Closeable } from './bitmap-budget';

/** A fake decoded bitmap that records close() calls — lets the LRU/budget POLICY be tested headless in Node
 *  (the worker's real ImageBitmap needs a browser). `bytes` = w·h·4, so a square edge of √(n/4) sets a
 *  target byte cost; we just pass w/h directly here. */
class FakeBitmap implements Closeable {
  closed = 0;
  constructor(
    readonly id: string,
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed++;
  }
}

/** A bitmap whose w·h·4 == `bytes` (h=1, w=bytes/4) so tests can reason in exact byte budgets. */
const ofBytes = (id: string, bytes: number): FakeBitmap => new FakeBitmap(id, bytes / 4, 1);

describe('bitmapBytes', () => {
  it('is w·h·4 (the RGBA resident model)', () => {
    expect(bitmapBytes(new FakeBitmap('a', 2048, 2048))).toBe(2048 * 2048 * 4);
    expect(bitmapBytes(ofBytes('b', 400))).toBe(400);
  });
});

describe('BitmapBudget — additivity (under budget ⇒ no eviction, no close)', () => {
  it('admits everything under budget and closes nothing (byte-identical guarantee)', () => {
    const c = new BitmapBudget<FakeBitmap>(1000);
    const a = ofBytes('a', 200);
    const b = ofBytes('b', 300);
    const d = ofBytes('d', 400);
    c.insert('a', a);
    c.insert('b', b);
    c.insert('d', d);
    expect(c.size).toBe(3);
    expect(c.liveBytes).toBe(900);
    expect(c.liveBytes).toBeLessThanOrEqual(1000);
    expect(a.closed).toBe(0);
    expect(b.closed).toBe(0);
    expect(d.closed).toBe(0);
    // hits return the same handle, never re-decode
    expect(c.get('a')).toBe(a);
    expect(c.get('b')).toBe(b);
    expect(c.get('missing')).toBeUndefined();
  });
});

describe('BitmapBudget — eviction over budget', () => {
  it('evicts + closes the LRU on an over-budget insert; liveBytes stays ≤ budget; survivors intact', () => {
    const c = new BitmapBudget<FakeBitmap>(1000);
    const a = ofBytes('a', 400);
    const b = ofBytes('b', 400);
    const d = ofBytes('d', 400); // inserting d would be 1200 > 1000 ⇒ evict the LRU (a)
    c.insert('a', a);
    c.insert('b', b);
    c.insert('d', d);
    expect(a.closed).toBe(1); // LRU closed
    expect(b.closed).toBe(0);
    expect(d.closed).toBe(0);
    expect(c.size).toBe(2);
    expect(c.liveBytes).toBe(800);
    expect(c.liveBytes).toBeLessThanOrEqual(1000);
    expect(c.get('a')).toBeUndefined(); // evicted ⇒ miss ⇒ caller would re-decode (safe)
    expect(c.get('b')).toBe(b);
    expect(c.get('d')).toBe(d);
  });

  it('evicts MULTIPLE LRU entries when one big insert needs the room', () => {
    const c = new BitmapBudget<FakeBitmap>(1000);
    const a = ofBytes('a', 300);
    const b = ofBytes('b', 300);
    const d = ofBytes('d', 300);
    const big = ofBytes('big', 800); // needs a+b evicted (300+300+300+800=1700 → drop a,b → 1100 still>1000 → drop d → 800)
    c.insert('a', a);
    c.insert('b', b);
    c.insert('d', d);
    c.insert('big', big);
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
    expect(d.closed).toBe(1);
    expect(big.closed).toBe(0);
    expect(c.size).toBe(1);
    expect(c.liveBytes).toBe(800);
  });
});

describe('BitmapBudget — recency (get refreshes LRU)', () => {
  it('a get() on an old ref makes a DIFFERENT ref the next eviction victim', () => {
    const c = new BitmapBudget<FakeBitmap>(1000);
    const a = ofBytes('a', 400);
    const b = ofBytes('b', 400);
    c.insert('a', a);
    c.insert('b', b);
    c.get('a'); // a is now MRU; b is LRU
    const d = ofBytes('d', 400);
    c.insert('d', d); // over budget ⇒ evict the LRU, which is now b (NOT a)
    expect(b.closed).toBe(1);
    expect(a.closed).toBe(0);
    expect(c.get('a')).toBe(a);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('d')).toBe(d);
  });
});

describe('BitmapBudget — pinning (NEVER evict the in-flight op refs)', () => {
  it('a pinned ref is never closed even as the LRU candidate; unpinAll then makes it evictable', () => {
    const c = new BitmapBudget<FakeBitmap>(1000);
    const a = ofBytes('a', 400);
    c.insert('a', a);
    c.pin(['a']); // the in-flight op needs `a`
    // Flood well over budget — `a` is the LRU but pinned, so it must survive while every unpinned entry goes.
    const others: FakeBitmap[] = [];
    for (let i = 0; i < 5; i++) {
      const f = ofBytes(`x${i}`, 400);
      others.push(f);
      c.insert(`x${i}`, f);
    }
    expect(a.closed).toBe(0); // pinned ⇒ never evicted
    expect(c.get('a')).toBe(a); // still live for the op
    // Now the op finishes: unpin, then a fresh over-budget insert CAN evict `a`.
    c.unpinAll();
    // `a` is currently MRU (the get above refreshed it); push two more to make it the LRU and force eviction.
    c.insert('y0', ofBytes('y0', 400));
    c.insert('y1', ofBytes('y1', 400)); // 'a' is now LRU and unpinned ⇒ evictable on the next over-budget insert
    c.insert('y2', ofBytes('y2', 400));
    expect(a.closed).toBe(1); // after unpinAll it became an ordinary LRU victim
  });

  it('over budget with ALL live entries pinned ⇒ no eviction (tolerated), nothing closed', () => {
    const c = new BitmapBudget<FakeBitmap>(1000);
    const a = ofBytes('a', 600);
    const b = ofBytes('b', 600);
    c.insert('a', a);
    c.pin(['a', 'b']);
    c.insert('b', b); // 1200 > 1000 but both pinned ⇒ tolerate over-budget
    expect(a.closed).toBe(0);
    expect(b.closed).toBe(0);
    expect(c.size).toBe(2);
    expect(c.liveBytes).toBe(1200); // over budget, correctness over the bound
  });
});

describe('BitmapBudget — single oversized entry', () => {
  it('admits a single entry larger than the whole budget (one in-flight page is non-negotiable)', () => {
    const c = new BitmapBudget<FakeBitmap>(10);
    const huge = ofBytes('huge', 1000);
    c.insert('huge', huge);
    expect(huge.closed).toBe(0);
    expect(c.size).toBe(1);
    expect(c.get('huge')).toBe(huge);
    // A following small insert finds the over-budget condition but can only evict the OTHER entry, not crash.
    const small = ofBytes('small', 8);
    c.insert('small', small);
    expect(huge.closed).toBe(1); // huge is the LRU, evictable, closed to make room
    expect(small.closed).toBe(0);
  });
});

describe('BitmapBudget — drain (the OOM-fix: free native memory on run-end/cancel)', () => {
  it('closes every live handle exactly once, zeroes the cache, and is idempotent', () => {
    const c = new BitmapBudget<FakeBitmap>(1_000_000);
    const a = ofBytes('a', 400);
    const b = ofBytes('b', 400);
    c.insert('a', a);
    c.insert('b', b);
    c.pin(['a']); // drain must close pinned bitmaps too (cancel mid-op)
    c.drain();
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
    expect(c.size).toBe(0);
    expect(c.liveBytes).toBe(0);
    c.drain(); // second drain is a no-op
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
    expect(c.size).toBe(0);
  });
});

describe('BitmapBudget — replace same ref', () => {
  it('replacing a ref closes the stale surface and updates liveBytes (never leaks the old decode)', () => {
    const c = new BitmapBudget<FakeBitmap>(1_000_000);
    const v1 = ofBytes('a', 400);
    const v2 = ofBytes('a', 800);
    c.insert('a', v1);
    c.insert('a', v2);
    expect(v1.closed).toBe(1); // stale surface freed
    expect(v2.closed).toBe(0);
    expect(c.size).toBe(1);
    expect(c.liveBytes).toBe(800);
    expect(c.get('a')).toBe(v2);
  });
});

describe('BitmapBudget — peakCount', () => {
  it('reports the high-water count of live decodes even after eviction shrinks size', () => {
    const c = new BitmapBudget<FakeBitmap>(1000);
    for (let i = 0; i < 5; i++) c.insert(`r${i}`, ofBytes(`r${i}`, 400)); // peaks at 3 live, evicts down to 2
    expect(c.peakCount).toBe(3);
    expect(c.size).toBe(2);
  });
});

describe('BitmapBudget — determinism', () => {
  it('an identical insert/get script twice yields an identical close() sequence', () => {
    const run = (): string[] => {
      const closeLog: string[] = [];
      const c = new BitmapBudget<Closeable>(1000);
      const mk = (id: string, bytes: number): Closeable => ({
        width: bytes / 4,
        height: 1,
        close: () => closeLog.push(id),
      });
      c.insert('a', mk('a', 400));
      c.insert('b', mk('b', 400));
      c.get('a');
      c.insert('d', mk('d', 400)); // evicts b
      c.insert('e', mk('e', 400)); // evicts a (oldest after d's insert refreshed nothing)
      c.drain();
      return closeLog;
    };
    expect(run()).toEqual(run());
  });
});

describe('BITMAP_BUDGET_BYTES', () => {
  it('is the documented 256 MB working-set bound', () => {
    expect(BITMAP_BUDGET_BYTES).toBe(256 * 1024 * 1024);
  });
});
