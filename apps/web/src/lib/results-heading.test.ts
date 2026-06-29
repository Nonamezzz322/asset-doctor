// PURE-formatter lock for the document-level results <h1> outline anchor. apps/web has NO React test harness
// (vitest env=node), so the load-bearing DECISIONS — which numbers the heading speaks, which i18n key, and the
// HONESTY exclusion of ok/clean from "problems" — are extracted into a pure formatter and asserted here (same
// discipline as announce.test.ts). The <h1>/sr-only DOM placement itself is additive-markup-only and verified
// by manual SR rotor smoke-test (h1→h2→h2→h3 monotonic) + axe, noted in the PR.

import { describe, it, expect } from 'vitest';
import { translate, type T } from '@asset-doctor/i18n';
import { resultsHeading } from './results-heading';
import type { TriageIndex } from './triage';

// A fake translator that echoes the exact key + params chosen, so we assert the CHOICE not the locale copy.
const fakeT: T = (key, params) => `${key}:${JSON.stringify(params)}`;
// The real EN translator, to prove the chosen key + params render a clean, correctly-pluralized sentence.
const enT: T = (key, params) => translate('en', key, params);

const tally = (t: Partial<TriageIndex['tally']>): TriageIndex['tally'] => ({ crit: 0, warn: 0, info: 0, ok: 0, ...t });

describe('resultsHeading — anchors the SR outline with the SAME honest problem count as VerdictBar', () => {
  it('counts crit+warn+info and EXCLUDES ok/clean (n=3, not 102)', () => {
    expect(resultsHeading(tally({ crit: 2, warn: 1, info: 0, ok: 99 }), fakeT)).toBe('a11y.resultsHeading:{"n":3}');
  });

  it('all-zero tally ⇒ n=0 (the heading still anchors the outline even when all-clear)', () => {
    expect(resultsHeading(tally({}), fakeT)).toBe('a11y.resultsHeading:{"n":0}');
  });

  it('single problem ⇒ n=1, and EN renders the singular grammar with no leftover braces', () => {
    expect(resultsHeading(tally({ crit: 1 }), fakeT)).toBe('a11y.resultsHeading:{"n":1}');
    const en = resultsHeading(tally({ crit: 1 }), enT);
    expect(en).toMatch(/1 problem found/);
    expect(en).not.toMatch(/problems/);
    expect(en).not.toContain('{');
  });

  it('multiple problems ⇒ EN renders the plural grammar', () => {
    const en = resultsHeading(tally({ crit: 2, warn: 3 }), enT);
    expect(en).toMatch(/5 problems found/);
    expect(en).not.toContain('{');
  });
});
