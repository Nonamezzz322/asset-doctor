// PURE test for the idle-hero readout honesty pin. apps/web has no React harness (vitest env=node), so the
// invariant-3 guarantee — the pre-drop hero shows ONLY '—', never a fabricated number — is asserted here.

import { describe, expect, it } from 'vitest';
import { HERO_DEMO_VALUE, HERO_READOUT_CELLS } from '../src/lib/hero-readout';

describe('hero-readout — honest demo readout (invariant 3)', () => {
  it('the placeholder is the em-dash absent-metric convention', () => {
    expect(HERO_DEMO_VALUE).toBe('—');
  });

  it('labels are exactly the 4 mockup cells in order', () => {
    expect(HERO_READOUT_CELLS.map((c) => c.label)).toEqual(['VRAM', 'EMPTY', 'DRAW', 'SIZE']);
  });

  it('EVERY cell value is the absent-metric placeholder — zero fabricated numbers', () => {
    for (const c of HERO_READOUT_CELLS) expect(c.value).toBe(HERO_DEMO_VALUE);
    // no cell value is numeric or number-like
    for (const c of HERO_READOUT_CELLS) expect(/\d/.test(c.value)).toBe(false);
  });

  it('the cell list is frozen (a fabricated value cannot be written in later)', () => {
    expect(Object.isFrozen(HERO_READOUT_CELLS)).toBe(true);
  });
});
