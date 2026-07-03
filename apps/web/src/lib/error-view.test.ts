// PURE-decision lock for the localized error card. apps/web has NO React harness (vitest env=node), so the
// load-bearing DECISIONS — the title KEY per context, the raw-message passthrough into a demoted <details>,
// and noFiles carrying NO detail — are asserted with a fake translator (ledger-empty.test.ts discipline).
// The card MARKUP + role=alert are additive JSX, verified by the manual browser gate noted in the PR.
import { describe, it, expect } from 'vitest';
import { translate, type T } from '@asset-doctor/i18n';
import { errorCard, errDetail } from './error-view';

const fakeT: T = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);
const enT: T = (key, params) => translate('en', key, params);

describe('errorCard — localized title + demoted raw detail', () => {
  it('noFiles → the localized noFiles title, NO detail (nothing to demote)', () => {
    expect(errorCard({ kind: 'noFiles' }, fakeT)).toEqual({ title: 'error.noFiles' });
  });
  it('failed (analyze ctx, default) → analysis title + raw message in a demoted detail', () => {
    const raw = 'Unexpected token < in JSON at position 0';
    expect(errorCard({ kind: 'failed', detail: raw }, fakeT)).toEqual({
      title: 'error.analysisFailed',
      detail: { label: 'error.detailsLabel', body: raw },
    });
  });
  it('failed (fix ctx) → the FIX-failure title, same demoted raw detail', () => {
    expect(errorCard({ kind: 'failed', detail: 'boom' }, fakeT, 'fix')).toEqual({
      title: 'error.fixFailed',
      detail: { label: 'error.detailsLabel', body: 'boom' },
    });
  });
  it('HONESTY: a raw message that LOOKS like a key is passed through VERBATIM, never re-translated', () => {
    // enT would turn a real key into copy; body must stay the literal string.
    expect(errorCard({ kind: 'failed', detail: 'error.analysisFailed' }, enT).detail?.body).toBe('error.analysisFailed');
  });
  it('real EN copy renders with no leftover braces (both titles + label)', () => {
    for (const c of [errorCard({ kind: 'noFiles' }, enT), errorCard({ kind: 'failed', detail: 'x' }, enT), errorCard({ kind: 'failed', detail: 'x' }, enT, 'fix')]) {
      expect(c.title).not.toContain('{');
    }
    expect(errorCard({ kind: 'failed', detail: 'x' }, enT).detail?.label).not.toContain('{');
  });
  it('errDetail normalizes Error vs non-Error', () => {
    expect(errDetail(new Error('nope'))).toBe('nope');
    expect(errDetail('plain')).toBe('plain');
    expect(errDetail(42)).toBe('42');
  });
});
