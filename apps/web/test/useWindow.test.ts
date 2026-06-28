import { describe, expect, it } from 'vitest';
import { windowSlice } from '../src/lib/useWindow';

describe('windowSlice', () => {
  it('at scrollTop 0 renders the top band plus overscan, clamped to [0, total]', () => {
    // 1000 rows × 20px, 200px viewport ⇒ 10 visible; overscan 6 ⇒ start clamps to 0, end = 10+6.
    const s = windowSlice(1000, 20, 0, 200, 6);
    expect(s.start).toBe(0);
    expect(s.end).toBe(16);
    expect(s.padTop).toBe(0);
    expect(s.totalH).toBe(20000);
  });

  it('mid-scroll: window slides with scrollTop, padTop = start × rowH', () => {
    // scrolled 400px ⇒ first visible row 20; minus overscan 6 ⇒ start 14.
    const s = windowSlice(1000, 20, 400, 200, 6);
    expect(s.start).toBe(14);
    // visible rows 20..30 (=ceil(600/20)=30); +6 overscan ⇒ end 36.
    expect(s.end).toBe(36);
    expect(s.padTop).toBe(14 * 20);
    expect(s.totalH).toBe(20000);
  });

  it('near the bottom: end clamps to total, never overshoots', () => {
    // 50 rows × 20px = 1000px list; scrolled to 800 with a 200px viewport ⇒ bottom in view.
    const s = windowSlice(50, 20, 800, 200, 6);
    expect(s.end).toBe(50);
    expect(s.start).toBe(34); // floor(800/20)=40, minus 6 overscan
    expect(s.start).toBeLessThanOrEqual(s.end);
  });

  it('over-scroll past the list height yields an empty slice (start clamped to end), never start > end', () => {
    const s = windowSlice(50, 20, 19000, 200, 6);
    expect(s.end).toBe(50);
    expect(s.start).toBe(50); // clamped to end ⇒ empty window
    expect(s.start).toBeLessThanOrEqual(s.end);
  });

  it('renders far fewer than the total (the whole point of windowing)', () => {
    const s = windowSlice(5000, 24, 12000, 600, 6);
    expect(s.end - s.start).toBeLessThan(60);
  });

  it('empty list ⇒ empty window', () => {
    expect(windowSlice(0, 20, 0, 200)).toEqual({ start: 0, end: 0, padTop: 0, totalH: 0 });
  });

  it('degrades safely on a non-positive rowH (render everything, no NaN)', () => {
    const s = windowSlice(10, 0, 0, 200);
    expect(s).toEqual({ start: 0, end: 10, padTop: 0, totalH: 0 });
  });

  it('zero-height viewport still renders the overscan band, never negative indices', () => {
    const s = windowSlice(100, 20, 0, 0, 6);
    expect(s.start).toBe(0);
    expect(s.end).toBe(6);
  });

  it('negative scrollTop is clamped to the top', () => {
    const s = windowSlice(100, 20, -50, 200, 6);
    expect(s.start).toBe(0);
    expect(s.padTop).toBe(0);
  });
});
