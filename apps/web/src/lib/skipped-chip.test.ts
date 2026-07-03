// PURE-decision lock for the skipped-files chip. apps/web has NO React test harness (vitest env=node), so the
// decisions — null at 0 (render nothing), the label/hint i18n key+params, and the exported anchor contract —
// are asserted with a fake translator (announce.test.ts discipline). The chip MARKUP + the scroll/focus jump
// are additive JSX/DOM, verified by the manual browser gate noted in the PR.

import { describe, it, expect } from 'vitest';
import { translate, type T } from '@asset-doctor/i18n';
import { skippedChipModel, UNPARSED_DETAILS_ID, UNPARSED_SUMMARY_ID } from './skipped-chip';

const fakeT: T = (key, params) => `${key}:${JSON.stringify(params)}`;
const enT: T = (key, params) => translate('en', key, params);

describe('skippedChipModel — null unless files were skipped', () => {
  it('0 skipped ⇒ null (renders nothing, never "0 files skipped")', () => {
    expect(skippedChipModel(0, fakeT)).toBeNull();
  });

  it('negative (defensive) ⇒ null', () => {
    expect(skippedChipModel(-3, fakeT)).toBeNull();
  });

  it('non-zero ⇒ label + hint via the chosen keys', () => {
    const c = skippedChipModel(3, fakeT);
    expect(c).toEqual({ label: 'report.skippedChip:{"n":3}', hint: 'report.skippedChip.hint:undefined' });
  });

  it('EN renders singular n=1 and plural n=1000 with no leftover braces', () => {
    const one = skippedChipModel(1, enT)!;
    expect(one.label).toMatch(/1 file skipped/);
    expect(one.label).not.toContain('{');
    const many = skippedChipModel(1000, enT)!;
    expect(many.label).toMatch(/1000 files skipped/);
    expect(many.label).not.toContain('{');
    expect(many.hint).not.toContain('{');
  });
});

describe('anchor contract — exported ids are stable and distinct', () => {
  it('the details id and the summary id differ (source ↔ target cannot alias)', () => {
    expect(UNPARSED_DETAILS_ID).toBe('unparsed-notice');
    expect(UNPARSED_SUMMARY_ID).toBe('unparsed-notice-summary');
    expect(UNPARSED_DETAILS_ID).not.toBe(UNPARSED_SUMMARY_ID);
  });
});
