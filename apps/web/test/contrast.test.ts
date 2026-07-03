import { describe, expect, it } from 'vitest';
import {
  AA_LARGE,
  AA_NORMAL,
  CTA,
  CTA_HOVER,
  CTA_TEXT,
  FILM_SOFT,
  INK,
  INK_SOFT,
  SEVERITY_HEX,
  SURFACE,
  TEAL_DECOR,
  TEAL_TEXT,
  WHITE,
  accessibleInkSoftAlpha,
  compositeAlpha,
  contrastRatio,
  ctaHoverPassesAA,
  ctaTextPassesAA,
  ctaWhitePassesAA,
  filmSoftPassesAA,
  inkPassesAA,
  inkSoftPassesAA,
  linkTealTextPassesAA,
  relLuminance,
  severityHuePassesAA,
  tealDecorLargePassesAA,
  tealTextWhiteBgPassesAA,
} from '../src/lib/contrast';
import { severityLabelClass } from '../src/lib/severity-style';

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

describe('contrast — film-surface remap (UX-4 rider): secondary text on bg-film must be film-soft', () => {
  it('ink-soft on the film surface FAILS AA (3.13:1) — the defect the recolor removes', () => {
    expect(contrastRatio(INK_SOFT, SURFACE.film)).toBeCloseTo(3.13, 2);
    expect(inkSoftPassesAA(1, 'film')).toBe(false);
  });

  it('film-soft on the film surface PASSES AA (8.51:1)', () => {
    expect(contrastRatio(FILM_SOFT, SURFACE.film)).toBeCloseTo(8.51, 2);
    expect(filmSoftPassesAA()).toBe(true);
  });
});

describe('contrast — severity-label decolorize (round5): hues fail AA as label text, ink passes', () => {
  it('every severity hue FAILS AA on BOTH light surfaces (the defect)', () => {
    for (const sev of ['crit', 'warn', 'ok', 'info'] as const)
      for (const s of ['bg', 'panel'] as const) expect(severityHuePassesAA(sev, s)).toBe(false);
  });
  it('premise numbers hold on panel: crit 3.91 / warn 2.77 / ok 3.465 / info 3.57', () => {
    expect(contrastRatio(SEVERITY_HEX.crit, SURFACE.panel)).toBeCloseTo(3.91, 2);
    expect(contrastRatio(SEVERITY_HEX.warn, SURFACE.panel)).toBeCloseTo(2.77, 2);
    expect(contrastRatio(SEVERITY_HEX.ok, SURFACE.panel)).toBeCloseTo(3.465, 2); // 3.4646 — the §1 table value; 3.47 over-rounds past the ±0.005 band
    expect(contrastRatio(SEVERITY_HEX.info, SURFACE.panel)).toBeCloseTo(3.57, 2);
  });
  it('ink label text PASSES AA on both surfaces (fix target: 16.48 panel / 13.87 bg)', () => {
    expect(inkPassesAA('panel')).toBe(true);
    expect(inkPassesAA('bg')).toBe(true);
    expect(contrastRatio(INK, SURFACE.panel)).toBeCloseTo(16.48, 1);
    expect(contrastRatio(INK, SURFACE.bg)).toBeCloseTo(13.87, 1);
  });
  it('the label class is bound to the AA-proven ink token, never a hue', () => {
    expect(severityLabelClass()).toBe('text-ink'); // ties the class string → INK hex → the passing proof
    expect(severityLabelClass('warn')).toBe('text-ink'); // even the worst hue (2.77:1) is not emitted
  });
});

describe('contrast — threshold lock', () => {
  it('AA_NORMAL is the normal-text 4.5:1 minimum (not the 3:1 large-text one)', () => {
    expect(AA_NORMAL).toBe(4.5);
  });
});

describe('contrast — round5 CTA/teal role-split (regression guard)', () => {
  // NEW roles PASS
  it('darkened CTA fill clears AA for white text (4.585)', () => {
    expect(contrastRatio(WHITE, CTA)).toBeCloseTo(4.585, 2);
    expect(ctaWhitePassesAA()).toBe(true);
  });
  it('CTA hover is darker than base AND clears AA (6.118)', () => {
    expect(relLuminance(CTA_HOVER)).toBeLessThan(relLuminance(CTA));
    expect(contrastRatio(WHITE, CTA_HOVER)).toBeCloseTo(6.118, 2);
    expect(ctaHoverPassesAA()).toBe(true);
  });
  it('green accent text clears AA on BOTH surfaces (bg 5.024 / panel 5.972)', () => {
    expect(contrastRatio(CTA_TEXT, SURFACE.bg)).toBeCloseTo(5.024, 2);
    expect(contrastRatio(CTA_TEXT, SURFACE.panel)).toBeCloseTo(5.972, 2);
    expect(ctaTextPassesAA('bg')).toBe(true);
    expect(ctaTextPassesAA('panel')).toBe(true);
  });
  it('teal text clears AA on BOTH surfaces (bg 4.567 / panel 5.428) + white-on-it (5.428)', () => {
    expect(contrastRatio(TEAL_TEXT, SURFACE.bg)).toBeCloseTo(4.567, 2);
    expect(contrastRatio(TEAL_TEXT, SURFACE.panel)).toBeCloseTo(5.428, 2);
    expect(linkTealTextPassesAA('bg')).toBe(true);
    expect(linkTealTextPassesAA('panel')).toBe(true);
    expect(tealTextWhiteBgPassesAA()).toBe(true);
  });

  // OLD values / wrong roles FAIL (these guards fail the build if someone reverts a role)
  it('the OLD CTA #15A06A did NOT pass AA for white text (3.350) — the defect this removes', () => {
    expect(contrastRatio(WHITE, '#15A06A')).toBeCloseTo(3.35, 2);
    expect(3.35 < AA_NORMAL).toBe(true);
  });
  it('darkened CTA-fill green would STILL FAIL as accent text on bg (3.857) — why cta-text is separate', () => {
    expect(contrastRatio(CTA, SURFACE.bg)).toBeCloseTo(3.857, 2);
    expect(contrastRatio(CTA, SURFACE.bg) < AA_NORMAL).toBe(true);
  });
  it('decorative teal FAILS normal-text AA (panel 4.079) — so readable teal MUST use TEAL_TEXT', () => {
    expect(contrastRatio(TEAL_DECOR, SURFACE.panel)).toBeCloseTo(4.079, 2);
    expect(contrastRatio(TEAL_DECOR, SURFACE.panel) < AA_NORMAL).toBe(true);
  });
  it('teal-text @0.9 alpha FAILS (bg 3.854 / panel 4.460) — justifies the /90 drop at App:1714', () => {
    expect(contrastRatio(compositeAlpha(TEAL_TEXT, SURFACE.bg, 0.9), SURFACE.bg)).toBeLessThan(AA_NORMAL);
    expect(contrastRatio(compositeAlpha(TEAL_TEXT, SURFACE.panel, 0.9), SURFACE.panel)).toBeLessThan(AA_NORMAL);
  });

  // Decorative teal RETENTION is justified (large text / non-text 1.4.11 ≥ 3:1)
  it('decorative teal clears the 3:1 large-text / non-text floor on both surfaces (landing 30px + focus ring)', () => {
    expect(AA_LARGE).toBe(3.0);
    expect(tealDecorLargePassesAA('bg')).toBe(true);
    expect(tealDecorLargePassesAA('panel')).toBe(true);
  });
});
