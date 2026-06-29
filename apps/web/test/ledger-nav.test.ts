import { describe, expect, it } from 'vitest';
import { nextActiveIndex, scrollToActive, type NavKey } from '../src/lib/ledger-nav';
import { windowSlice } from '../src/lib/useWindow';

const ALL_KEYS: NavKey[] = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

describe('nextActiveIndex', () => {
  it('ArrowDown walks +1 and clamps at total-1 (no wrap)', () => {
    const total = 5;
    let i = 0;
    for (let step = 0; step < 10; step++) i = nextActiveIndex(i, 'ArrowDown', total, 3);
    expect(i).toBe(total - 1); // clamped, never wraps to 0
    expect(nextActiveIndex(0, 'ArrowDown', total, 3)).toBe(1);
    expect(nextActiveIndex(total - 1, 'ArrowDown', total, 3)).toBe(total - 1);
  });

  it('ArrowUp walks -1 from last and clamps at 0 (no wrap)', () => {
    const total = 5;
    let i = total - 1;
    for (let step = 0; step < 10; step++) i = nextActiveIndex(i, 'ArrowUp', total, 3);
    expect(i).toBe(0); // clamped, never wraps to last
    expect(nextActiveIndex(3, 'ArrowUp', total, 3)).toBe(2);
    expect(nextActiveIndex(0, 'ArrowUp', total, 3)).toBe(0);
  });

  it('Home ⇒ 0 and End ⇒ total-1', () => {
    expect(nextActiveIndex(7, 'Home', 20, 5)).toBe(0);
    expect(nextActiveIndex(7, 'End', 20, 5)).toBe(19);
  });

  it('PageDown / PageUp move by pageRows and clamp', () => {
    expect(nextActiveIndex(0, 'PageDown', 100, 10)).toBe(10);
    expect(nextActiveIndex(95, 'PageDown', 100, 10)).toBe(99); // clamps at last
    expect(nextActiveIndex(50, 'PageUp', 100, 10)).toBe(40);
    expect(nextActiveIndex(3, 'PageUp', 100, 10)).toBe(0); // clamps at 0
  });

  it('pageRows <= 0 is treated as 1 (a degenerate page still steps one row)', () => {
    expect(nextActiveIndex(5, 'PageDown', 100, 0)).toBe(6);
    expect(nextActiveIndex(5, 'PageDown', 100, -4)).toBe(6);
    expect(nextActiveIndex(5, 'PageUp', 100, 0)).toBe(4);
    expect(nextActiveIndex(5, 'PageUp', 100, -4)).toBe(4);
  });

  it('current = -1 (nothing active): ArrowDown/Home ⇒ 0, ArrowUp/End ⇒ last', () => {
    const total = 8;
    expect(nextActiveIndex(-1, 'ArrowDown', total, 4)).toBe(0);
    expect(nextActiveIndex(-1, 'Home', total, 4)).toBe(0);
    expect(nextActiveIndex(-1, 'ArrowUp', total, 4)).toBe(total - 1);
    expect(nextActiveIndex(-1, 'End', total, 4)).toBe(total - 1);
    // Page keys from -1: PageDown lands near the first page bottom, PageUp at the top.
    expect(nextActiveIndex(-1, 'PageDown', total, 4)).toBe(3);
    expect(nextActiveIndex(-1, 'PageUp', total, 4)).toBe(0);
  });

  it('total = 0 ⇒ -1 for every key', () => {
    for (const k of ALL_KEYS) expect(nextActiveIndex(0, k, 0, 5)).toBe(-1);
    for (const k of ALL_KEYS) expect(nextActiveIndex(-1, k, 0, 5)).toBe(-1);
  });

  it('total = 1 ⇒ every key resolves to 0', () => {
    for (const k of ALL_KEYS) {
      expect(nextActiveIndex(0, k, 1, 5)).toBe(0);
      expect(nextActiveIndex(-1, k, 1, 5)).toBe(0);
    }
  });

  it('exhaustive: every NavKey from every starting index returns an index in [0,total)', () => {
    const total = 37;
    for (let cur = -1; cur < total; cur++) {
      for (const k of ALL_KEYS) {
        const r = nextActiveIndex(cur, k, total, 9);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(total);
      }
    }
  });
});

describe('scrollToActive', () => {
  const rowH = 52;
  const viewH = 520; // ~10 rows visible

  it('target already inside the visible band ⇒ returns currentScrollTop unchanged (no jump)', () => {
    // scrolled to row 20 (1040px); rows 20..30 visible. target 25 is inside.
    const cur = 20 * rowH;
    expect(scrollToActive(25, rowH, viewH, cur, 1000)).toBe(cur);
  });

  it('target above the band ⇒ aligns to top (target*rowH), clamped to >= 0', () => {
    const cur = 50 * rowH;
    expect(scrollToActive(10, rowH, viewH, cur, 1000)).toBe(10 * rowH);
    // first row from a scrolled position aligns to 0.
    expect(scrollToActive(0, rowH, viewH, cur, 1000)).toBe(0);
  });

  it('target below the band ⇒ aligns to bottom (target*rowH - viewH + rowH), clamped to maxScroll', () => {
    const cur = 0;
    // target 30 below the initial band ⇒ bottom-align.
    expect(scrollToActive(30, rowH, viewH, cur, 1000)).toBe(30 * rowH - viewH + rowH);
  });

  it('never exceeds maxScroll = max(0, total*rowH - viewH) and never goes negative', () => {
    const total = 1000;
    const maxScroll = total * rowH - viewH;
    // End-style jump to the last row clamps to maxScroll.
    expect(scrollToActive(total - 1, rowH, viewH, 0, total)).toBe(maxScroll);
    // A target before the top can never produce a negative scrollTop.
    expect(scrollToActive(0, rowH, viewH, 999 * rowH, total)).toBeGreaterThanOrEqual(0);
    // Exhaustive bound check across every target.
    for (let target = 0; target < total; target++) {
      const out = scrollToActive(target, rowH, viewH, target * rowH, total);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(maxScroll);
    }
  });

  it('degrade-safe: rowH <= 0 / total <= 0 / target < 0 ⇒ clamped currentScrollTop, no NaN', () => {
    expect(scrollToActive(5, 0, viewH, 0, 1000)).toBe(0);
    expect(scrollToActive(5, -10, viewH, 0, 1000)).toBe(0);
    expect(scrollToActive(5, rowH, viewH, 100, 0)).toBe(0); // total<=0 ⇒ maxScroll 0 ⇒ clamp(100)=0
    expect(scrollToActive(-1, rowH, viewH, 5 * rowH, 1000)).toBe(5 * rowH); // negative target, keep current
    expect(Number.isNaN(scrollToActive(5, 0, viewH, 0, 1000))).toBe(false);
  });

  it('CONSISTENCY: scrollToActive output fed into windowSlice mounts the target (target ∈ [start,end))', () => {
    // This is the load-bearing adversarial test: it proves the two pure modules agree at the windowing
    // boundary, i.e. the active row WILL be mounted after the caller sets scrollTop. Mirrors the real
    // wiring: ROW_H=52, overscan=8 (TriageLedger), a 70vh-ish viewport.
    const total = 1000;
    const overscan = 8;
    for (const vH of [0, 260, 520, 731]) {
      for (let cur = 0; cur < total; cur += 13) {
        const curTop = cur * rowH;
        for (const target of [0, 1, 17, 250, 499, 500, 873, total - 2, total - 1]) {
          const out = scrollToActive(target, rowH, vH, curTop, total);
          const slice = windowSlice(total, rowH, out, vH, overscan);
          expect(
            target >= slice.start && target < slice.end,
            `target ${target} not in [${slice.start},${slice.end}) at viewH=${vH} cur=${cur} scrollTop=${out}`,
          ).toBe(true);
        }
      }
    }
  });
});
