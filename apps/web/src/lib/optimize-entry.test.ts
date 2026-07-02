// AB-R2 (+ settings-page design §2) — pure-unit lock for the first-class "optimize this folder"
// affordance. apps/web has NO React harness (vitest env=node), so the load-bearing decisions live in
// optimize-entry.ts and are asserted here: the gate (when to show the deep-link anchor), the frozen copy
// keys (present in all 9 catalogs, static ⇒ no placeholder tokens), and the shared DOM anchor id. The JSX
// is now a plain navigation link — `<a href={SETTINGS_HASH}>` to the Settings page, whose FIRST card
// (Formats) carries PROFILE_PANEL_ANCHOR as its id (the one visual-only seam, smoke-tested via dev).

import { describe, it, expect } from 'vitest';
import { CATALOGS, LOCALES, translate } from '@asset-doctor/i18n';
import { SETTINGS_HASH, viewOfHash } from './route';
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

describe('PROFILE_PANEL_ANCHOR — the shared deep-link DOM id (now the Settings-page Formats card id)', () => {
  it('is a stable non-empty string (value UNCHANGED across the settings-page move — old links keep working)', () => {
    expect(typeof PROFILE_PANEL_ANCHOR).toBe('string');
    expect(PROFILE_PANEL_ANCHOR.length).toBeGreaterThan(0);
    expect(PROFILE_PANEL_ANCHOR).toBe('ad-export-profile');
  });

  it('the anchor navigates via the routed settings hash (deep-link source and route cannot drift)', () => {
    // The optimize-entry anchor is `<a href={SETTINGS_HASH}>`; pin that the hash it emits actually routes
    // to the settings view where the PROFILE_PANEL_ANCHOR card lives.
    expect(viewOfHash(SETTINGS_HASH)).toBe('settings');
  });
});
