// Regression lock for the FilmViewer keep-last-frame fix (Round 24 reviewer-MINOR). apps/web has NO React
// test harness (vitest env=node, no jsdom/testing-library), so the load-bearing swap decision is extracted to
// a pure helper and asserted here — the same discipline as transcode-guard.test.ts.

import { describe, it, expect } from 'vitest';
import { filmSelectionAction } from './film-selection';

describe('filmSelectionAction — keep the prior film while a live re-selection re-reads', () => {
  it('no selection ⇒ clear (genuine empty state)', () => {
    expect(filmSelectionAction(false, false)).toBe('clear');
  });

  it('selection but NO reader ⇒ clear (honest no-image: folder moved / legacy producer)', () => {
    expect(filmSelectionAction(true, false)).toBe('clear');
  });

  it('selection + reader ⇒ read — the LOAD-BEARING case: a live re-selection NEVER clears, so the success path never blanks', () => {
    expect(filmSelectionAction(true, true)).toBe('read');
  });

  it('no selection but a reader is somehow present ⇒ still clear (selection gates first)', () => {
    expect(filmSelectionAction(false, true)).toBe('clear');
  });
});
