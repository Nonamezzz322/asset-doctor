import { describe, expect, it } from 'vitest';
import {
  AA_NORMAL,
  INK_SOFT,
  SURFACE,
  accessibleInkSoftAlpha,
  compositeAlpha,
  contrastRatio,
  inkSoftPassesAA,
  relLuminance,
} from '../src/lib/contrast';

// This test is the Node-testable proof that the App.tsx remap clears WCAG AA: full ink-soft passes
// 4.5:1 on both surfaces, and the previously-shipped faded readable classes (/70, /80) do NOT. It is
// the regression guard — it FAILS if anyone re-introduces a sub-1 alpha as "AA-safe" for readable
// secondary text.

describe('contrast — WCAG ratio sanity', () => {
  it('ratio(#000,#fff) ≈ 21 (the maximum)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('ratio(x,x) === 1 (a color against itself)', () => {
    expect(contrastRatio(INK_SOFT, INK_SOFT)).toBe(1);
    expect(contrastRatio(SURFACE.bg, SURFACE.bg)).toBe(1);
  });

  it('relLuminance is monotone: black < ink-soft < panel-white', () => {
    expect(relLuminance('#000000')).toBeLessThan(relLuminance(INK_SOFT));
    expect(relLuminance(INK_SOFT)).toBeLessThan(relLuminance('#ffffff'));
  });
});

describe('contrast — premise numbers (guards the math itself)', () => {
  it('faded ink-soft FAILS AA over bg: /70 ≈ 2.84, /80 ≈ 3.44', () => {
    expect(contrastRatio(compositeAlpha(INK_SOFT, SURFACE.bg, 0.7), SURFACE.bg)).toBeCloseTo(2.84, 2);
    expect(contrastRatio(compositeAlpha(INK_SOFT, SURFACE.bg, 0.8), SURFACE.bg)).toBeCloseTo(3.44, 2);
  });

  it('full ink-soft PASSES AA: bg ≈ 5.10, panel ≈ 6.07', () => {
    expect(contrastRatio(INK_SOFT, SURFACE.bg)).toBeCloseTo(5.1, 2);
    expect(contrastRatio(INK_SOFT, SURFACE.panel)).toBeCloseTo(6.07, 2);
  });
});

describe('contrast — the remap decision (regression guard)', () => {
  it('a faded readable ink-soft alpha does NOT pass AA on bg', () => {
    expect(inkSoftPassesAA(0.7, 'bg')).toBe(false);
    expect(inkSoftPassesAA(0.8, 'bg')).toBe(false);
  });

  it('full-strength ink-soft passes AA on BOTH surfaces', () => {
    expect(inkSoftPassesAA(accessibleInkSoftAlpha(), 'bg')).toBe(true);
    expect(inkSoftPassesAA(accessibleInkSoftAlpha(), 'panel')).toBe(true);
  });

  it('the accessible alpha for a readable note is full strength (1)', () => {
    expect(accessibleInkSoftAlpha()).toBe(1);
  });
});

describe('contrast — threshold lock', () => {
  it('AA_NORMAL is the normal-text 4.5:1 minimum (not the 3:1 large-text one)', () => {
    expect(AA_NORMAL).toBe(4.5);
  });
});
