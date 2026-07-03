// Scroll-reveal decision (pure). 'static' = content visible immediately (never attach observers);
// 'observe' = hide-then-reveal via IntersectionObserver. Reduced-motion wins over everything (the reveal
// is NOT attached at all under reduce — ruled), and a missing IntersectionObserver (old browsers / jsdom)
// degrades to visible-by-default. Extracted so the "never blank the page for no-JS / no-IO / reduce
// users" rule is Node-testable (apps/web has no React/CSS harness).
export type RevealMode = 'static' | 'observe';

export function revealMode(prefersReduce: boolean, hasIntersectionObserver: boolean): RevealMode {
  return !prefersReduce && hasIntersectionObserver ? 'observe' : 'static';
}
