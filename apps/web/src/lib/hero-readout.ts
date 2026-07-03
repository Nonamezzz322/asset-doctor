// PURE honesty pin for the idle hero viewer (invariant 3). The redesigned Dropzone shows a signature demo
// viewer with a 4-cell readout strip (mirroring the landing mockup: VRAM / Empty / Draw / Size). Before the
// user drops a real folder there is NOTHING to measure, so every cell shows the absent-metric placeholder
// '—' — the exact convention SpecimenFilm/FilmViewer use. This module freezes that: zero fabricated numbers
// can ever appear in the pre-drop hero. The labels are literal technical mono captions (not translated),
// like the real FilmViewer readout acronyms — they carry no user data, just name the demo cells.

/** The absent-metric placeholder — the one value every hero readout cell shows before any real analysis. */
export const HERO_DEMO_VALUE = '—';

export interface HeroReadoutCell {
  /** Literal technical caption (rendered via .ad-label-sm). Not an i18n key — mirrors the FilmViewer
   *  readout-acronym convention (SpecimenFilm READOUT_CELLS are literals too). */
  readonly label: string;
  /** ALWAYS the honest absent-metric placeholder — never a number (invariant 3). */
  readonly value: typeof HERO_DEMO_VALUE;
}

/** The 4 demo readout cells, in mockup order. Frozen so nothing can mutate a '—' into a fabricated value. */
export const HERO_READOUT_CELLS: readonly HeroReadoutCell[] = Object.freeze([
  { label: 'VRAM', value: HERO_DEMO_VALUE },
  { label: 'EMPTY', value: HERO_DEMO_VALUE },
  { label: 'DRAW', value: HERO_DEMO_VALUE },
  { label: 'SIZE', value: HERO_DEMO_VALUE },
]);
