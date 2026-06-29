// apps/web has NO React/CSS test harness (vitest env=node), so the surface→token choice that the global
// :focus-visible rule (index.css) encodes is extracted to a pure helper and locked here — the same
// discipline as film-selection.test.ts. These tests pin the contract the CSS selector list (.ad-grid /
// .bg-film ⇒ film) must keep in sync: change one without the other and the documented spec diverges.

import { describe, it, expect } from 'vitest';
import { focusRingToken, classifyFocusSurface } from './focus-ring';

describe('focusRingToken — surface picks the @theme token (mirrors index.css :focus-visible)', () => {
  it('light chrome ⇒ teal', () => {
    expect(focusRingToken('light')).toBe('--color-teal');
  });

  it('dark x-ray card ⇒ film-soft', () => {
    expect(focusRingToken('film')).toBe('--color-film-soft');
  });
});

describe('classifyFocusSurface — ancestor class tokens decide the surface', () => {
  it("'ad-grid' present ⇒ film", () => {
    expect(classifyFocusSurface(['ad-grid', 'ad-clip'])).toBe('film');
  });

  it("'bg-film' present ⇒ film", () => {
    expect(classifyFocusSurface(['bg-film', 'p-3'])).toBe('film');
  });

  it('no film marker ⇒ light', () => {
    expect(classifyFocusSurface(['rounded-lg', 'bg-panel'])).toBe('light');
  });

  it('empty ancestor list ⇒ light (the default chrome)', () => {
    expect(classifyFocusSurface([])).toBe('light');
  });
});

describe('round-trip — classify then resolve matches the CSS selector list', () => {
  it("'ad-grid' ⇒ film-soft", () => {
    expect(focusRingToken(classifyFocusSurface(['ad-grid']))).toBe('--color-film-soft');
  });
});
