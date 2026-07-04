// PURE tests for the gate-honest Pro-view model. Beyond the truth tables, this PINS every i18n key the
// helpers return against CATALOGS.en — the i18n-app-keys scanner cannot see helper-returned keys (they are
// not t('literal') calls), so this test is what guarantees they exist in the authoritative catalog.

import { describe, expect, it } from 'vitest';
import { CATALOGS } from '@asset-doctor/i18n';
import { planActionKey, planValueKey, proPanel, proSubtitleKey, type ProPanel } from './pro-view';

const PANELS: ProPanel[] = ['beta', 'activate', 'active'];
const en = CATALOGS.en as Record<string, unknown>;

describe('proPanel — gate/entitlement truth table', () => {
  it('gate OFF ⇒ beta regardless of unlocked', () => {
    expect(proPanel(false, false)).toBe('beta');
    expect(proPanel(false, true)).toBe('beta');
  });
  it('gate ON ⇒ activate when locked, active when unlocked', () => {
    expect(proPanel(true, false)).toBe('activate');
    expect(proPanel(true, true)).toBe('active');
  });
  it('is total (only the three known panels)', () => {
    for (const g of [true, false]) for (const u of [true, false]) expect(PANELS).toContain(proPanel(g, u));
  });
});

describe('proSubtitleKey — gate-disciplined (never claims the fix is free while gated)', () => {
  it('gate OFF ⇒ beta subtitle, gate ON ⇒ gated subtitle (distinct)', () => {
    expect(proSubtitleKey(false)).toBe('pro.screen.subBeta');
    expect(proSubtitleKey(true)).toBe('pro.screen.subGated');
    expect(proSubtitleKey(false)).not.toBe(proSubtitleKey(true));
  });
});

describe('planValueKey / planActionKey — exhaustive + honest per panel', () => {
  it('value keys per panel', () => {
    expect(planValueKey('beta')).toBe('pro.plan.value.beta');
    expect(planValueKey('activate')).toBe('pro.plan.value.free');
    expect(planValueKey('active')).toBe('pro.plan.value.pro');
  });
  it('action keys per panel', () => {
    expect(planActionKey('beta')).toBe('pro.plan.action.about');
    expect(planActionKey('activate')).toBe('pro.plan.action.upgrade');
    expect(planActionKey('active')).toBe('pro.plan.action.manage');
  });
});

describe('every helper-returned key exists in CATALOGS.en (the app-keys scanner cannot see these)', () => {
  it('subtitle + plan value/action keys are all present', () => {
    const keys = new Set<string>();
    for (const g of [true, false]) keys.add(proSubtitleKey(g));
    for (const p of PANELS) {
      keys.add(planValueKey(p));
      keys.add(planActionKey(p));
    }
    for (const k of keys) expect(en, `missing key ${k}`).toHaveProperty(k);
  });
});
