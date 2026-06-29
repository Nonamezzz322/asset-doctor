// The surface→focus-ring-token decision, extracted as a pure, Node-testable spec. A global CSS rule
// (:focus-visible in index.css) has no runtime JS, so the one DESIGN CHOICE it encodes — which @theme
// token a focus ring uses on a given surface — lives here as the documented, unit-tested source of truth.
// The CSS rule is this module's visual twin: light chrome ⇒ teal; the dark x-ray card (.ad-grid/.bg-film)
// ⇒ film-soft (higher contrast on film + avoids teal-vs-green ambiguity next to the CTA). If the CSS
// selector list and this module ever diverge, focus-ring.test.ts is the reminder that the spec drifted.

export type FocusSurface = 'light' | 'film';

/** The single source of truth for which @theme token a focus ring uses on a given surface.
 *  Mirrors the index.css :focus-visible rules. Pure, deterministic, Node-testable. */
export function focusRingToken(surface: FocusSurface): '--color-teal' | '--color-film-soft' {
  return surface === 'film' ? '--color-film-soft' : '--color-teal';
}

/** Classify a control's nearest styling context from the class tokens on its ancestor card.
 *  'ad-grid' or 'bg-film' ⇒ dark film; else light. Matches the CSS selector list exactly. */
export function classifyFocusSurface(ancestorClasses: string[]): FocusSurface {
  return ancestorClasses.some((c) => c === 'ad-grid' || c === 'bg-film') ? 'film' : 'light';
}
