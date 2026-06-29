// apps/web has NO React/CSS test harness (vitest env=node), so the analyzing-bar's branchable logic is
// extracted to progressView() and pinned here (same discipline as focus-ring.test.ts). These lock the
// honesty contract: indeterminate (no valueNow/valueMax) when total is unknown/invalid, a real clamped
// pct otherwise, and pct ALWAYS a finite integer 0..100 so the renderer can blindly set the fill width.

import { describe, it, expect } from 'vitest';
import { progressView } from './progress-view';

describe('progressView — determinate vs. indeterminate progressbar spec', () => {
  it('undefined ⇒ indeterminate, no valueNow/valueMax', () => {
    const v = progressView(undefined);
    expect(v).toEqual({ determinate: false, pct: 0 });
    expect(v.valueNow).toBeUndefined();
    expect(v.valueMax).toBeUndefined();
  });

  it('total === 0 ⇒ indeterminate', () => {
    expect(progressView({ done: 0, total: 0 })).toEqual({ determinate: false, pct: 0 });
  });

  it('negative total ⇒ indeterminate', () => {
    expect(progressView({ done: 1, total: -1 })).toEqual({ determinate: false, pct: 0 });
    expect(progressView({ done: -5, total: 0 })).toEqual({ determinate: false, pct: 0 });
  });

  it('done 0 / total 100 ⇒ pct 0', () => {
    expect(progressView({ done: 0, total: 100 })).toEqual({ determinate: true, pct: 0, valueNow: 0, valueMax: 100 });
  });

  it('done 50 / total 100 ⇒ pct 50', () => {
    expect(progressView({ done: 50, total: 100 })).toEqual({ determinate: true, pct: 50, valueNow: 50, valueMax: 100 });
  });

  it('done 100 / total 100 ⇒ pct 100', () => {
    expect(progressView({ done: 100, total: 100 })).toEqual({ determinate: true, pct: 100, valueNow: 100, valueMax: 100 });
  });

  it('done 1 / total 3 ⇒ pct 33 (rounding pinned)', () => {
    expect(progressView({ done: 1, total: 3 })).toEqual({ determinate: true, pct: 33, valueNow: 1, valueMax: 3 });
  });

  it('done > total ⇒ clamped to total, pct 100', () => {
    expect(progressView({ done: 200, total: 100 })).toEqual({ determinate: true, pct: 100, valueNow: 100, valueMax: 100 });
  });

  it('done < 0 ⇒ clamped to 0, pct 0', () => {
    expect(progressView({ done: -3, total: 100 })).toEqual({ determinate: true, pct: 0, valueNow: 0, valueMax: 100 });
  });

  it('NaN/Infinity in done or total ⇒ indeterminate (finiteness guard)', () => {
    expect(progressView({ done: NaN, total: 100 })).toEqual({ determinate: false, pct: 0 });
    expect(progressView({ done: 5, total: NaN })).toEqual({ determinate: false, pct: 0 });
    expect(progressView({ done: Infinity, total: 100 })).toEqual({ determinate: false, pct: 0 });
    expect(progressView({ done: 5, total: Infinity })).toEqual({ determinate: false, pct: 0 });
    expect(progressView({ done: -Infinity, total: 100 })).toEqual({ determinate: false, pct: 0 });
  });

  it('pct is ALWAYS a finite integer 0..100 across every branch', () => {
    const inputs: (undefined | { done: number; total: number })[] = [
      undefined,
      { done: 0, total: 0 },
      { done: -1, total: -1 },
      { done: NaN, total: NaN },
      { done: Infinity, total: 5 },
      { done: -3, total: 100 },
      { done: 200, total: 100 },
    ];
    for (let total = 1; total <= 17; total++) {
      for (let done = -2; done <= total + 2; done++) {
        inputs.push({ done, total });
      }
    }
    for (const p of inputs) {
      const { pct } = progressView(p);
      expect(Number.isInteger(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });
});
