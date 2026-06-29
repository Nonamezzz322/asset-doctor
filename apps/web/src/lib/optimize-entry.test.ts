// AB-R2 — pure-unit lock for the first-class "optimize this folder" affordance. apps/web has NO React
// harness (vitest env=node), so the load-bearing decisions live in optimize-entry.ts and are asserted
// here: the gate (when to show the deep-link anchor), the frozen copy keys (present in all 9 catalogs,
// static ⇒ no placeholder tokens), and the shared DOM anchor id. The JSX is a thin wiring of a boolean
// to a native <details open> + a one-line scrollIntoView (the one visual-only seam, smoke-tested via dev).

import { describe, it, expect } from 'vitest';
import { CATALOGS, LOCALES, translate } from '@asset-doctor/i18n';
import { OPTIMIZE_ENTRY, optimizeEntryEnabled, PROFILE_PANEL_ANCHOR } from './optimize-entry';

describe('optimizeEntryEnabled — show the optimize anchor only when there is something to optimize', () => {
  it('0 files ⇒ false (the deep-link is inert with no files — same emptiness guard as run/preview)', () => {
    expect(optimizeEntryEnabled(0, true)).toBe(false);
  });

  it('>0 files ⇒ true', () => {
    expect(optimizeEntryEnabled(3, true)).toBe(true);
  });

  it('profileSupported is reserved and does NOT gate today — (3,false) still true (pins a future capability gate as a deliberate change)', () => {
    expect(optimizeEntryEnabled(3, false)).toBe(true);
  });
});

describe('OPTIMIZE_ENTRY — frozen copy-key contract present in every catalog', () => {
  it('exposes the three expected keys', () => {
    expect(OPTIMIZE_ENTRY).toEqual({
      titleKey: 'optimize.title',
      subKey: 'optimize.sub',
      anchorKey: 'optimize.anchor',
    });
  });

  const keys = [OPTIMIZE_ENTRY.titleKey, OPTIMIZE_ENTRY.subKey, OPTIMIZE_ENTRY.anchorKey];

  for (const loc of LOCALES) {
    it(`${loc}: all three keys are non-empty static strings (no leftover braces)`, () => {
      for (const key of keys) {
        const v = CATALOGS[loc][key];
        expect(typeof v === 'string' && v.length > 0, `${loc} "${key}" must be a non-empty string`).toBe(true);
        // Static copy ⇒ no {tokens} ⇒ trivially placeholder-parity; pin it so a future edit can't sneak one in.
        expect(translate(loc, key)).not.toContain('{');
      }
    });
  }
});

describe('PROFILE_PANEL_ANCHOR — the shared deep-link DOM id (anchor scroll target === panel id)', () => {
  it('is a stable non-empty string', () => {
    expect(typeof PROFILE_PANEL_ANCHOR).toBe('string');
    expect(PROFILE_PANEL_ANCHOR.length).toBeGreaterThan(0);
    expect(PROFILE_PANEL_ANCHOR).toBe('ad-export-profile');
  });
});
