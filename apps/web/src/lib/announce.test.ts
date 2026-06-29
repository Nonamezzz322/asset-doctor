// PURE-formatter lock for the aria-live announcements. apps/web has NO React test harness (vitest env=node),
// so the load-bearing DECISIONS — which numbers we speak, which i18n keys, and the HONESTY exclusion of
// ok/clean from "problems" — are extracted into pure formatters and asserted here (same discipline as
// film-selection.test.ts). The ARIA wiring itself (role/aria-live/aria-busy) is additive-attribute-only and
// verified by manual SR smoke-test, noted in the PR.

import { describe, it, expect } from 'vitest';
import { translate, type T } from '@asset-doctor/i18n';
import { analysisReadyMessage, resultCountMessage } from './announce';
import type { TriageIndex } from './triage';

// A fake translator that echoes the exact key + params chosen, so we assert the CHOICE not the locale copy.
const fakeT: T = (key, params) => `${key}:${JSON.stringify(params)}`;
// The real EN translator, to prove the chosen key + params render a clean, correctly-pluralized sentence.
const enT: T = (key, params) => translate('en', key, params);

const tally = (t: Partial<TriageIndex['tally']>): TriageIndex['tally'] => ({ crit: 0, warn: 0, info: 0, ok: 0, ...t });

describe('analysisReadyMessage — speaks only crit+warn+info (honest problem count)', () => {
  it('counts crit+warn+info and EXCLUDES ok/clean (n=3, not 102)', () => {
    expect(analysisReadyMessage(tally({ crit: 2, warn: 1, info: 0, ok: 99 }), fakeT)).toBe('a11y.diagnosisReady:{"n":3}');
  });

  it('all-zero tally ⇒ n=0', () => {
    expect(analysisReadyMessage(tally({}), fakeT)).toBe('a11y.diagnosisReady:{"n":0}');
  });

  it('single problem ⇒ n=1, and EN renders the singular grammar', () => {
    expect(analysisReadyMessage(tally({ crit: 1 }), fakeT)).toBe('a11y.diagnosisReady:{"n":1}');
    const en = analysisReadyMessage(tally({ crit: 1 }), enT);
    expect(en).toMatch(/1 problem found/);
    expect(en).not.toMatch(/problems/);
    expect(en).not.toContain('{');
  });

  it('multiple problems ⇒ EN renders the plural grammar', () => {
    const en = analysisReadyMessage(tally({ crit: 2, warn: 3 }), enT);
    expect(en).toMatch(/5 problems found/);
    expect(en).not.toContain('{');
  });
});

describe('resultCountMessage — reuses triage.showing, numbers pass straight through', () => {
  it('passes shown/total through as {n,m} with no rounding/derivation', () => {
    expect(resultCountMessage(12, 340, fakeT)).toBe('triage.showing:{"n":12,"m":340}');
  });

  it('EN renders "showing 12 of 340" with no leftover braces', () => {
    expect(resultCountMessage(12, 340, enT)).toBe('showing 12 of 340');
  });

  it('zero matches stays honest: "showing 0 of 0"', () => {
    expect(resultCountMessage(0, 0, enT)).toBe('showing 0 of 0');
  });
});
