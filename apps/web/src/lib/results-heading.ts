// PURE results-outline heading formatter (no React, no DOM — Node-testable). The results view unmounts the
// Dropzone (and its <h1>) at phase==='done', so without this the SR heading outline opens at <h2> (VerdictBar)
// with no document-level top — a WCAG 1.3.1 heading-order defect. This turns the SAME measured problem count
// into the document <h1>'s text. `t` is INJECTED (not imported) so this stays pure + locale-agnostic and the
// unit test can assert the exact KEY + PARAMS with a fake translator — mirroring announce.ts.
//
// HONESTY (invariants 3 & 5 — load-bearing): the heading announces ONLY the problem count, which is
// crit+warn+info — IDENTICAL to VerdictBar's problemCount AND announce.ts/analysisReadyMessage — so the
// spoken outline never disagrees with the live region. It deliberately EXCLUDES tally.ok / clean (a clean
// asset has no problem to claim) and NEVER mentions VRAM or disk (disk weight ≠ GPU footprint must not be
// conflated in the heading either). tally is the measured index — no fabricated numbers.

import type { T } from '@asset-doctor/i18n';
import type { TriageIndex } from './triage';

/** "Asset audit results — N problems found." — N = crit+warn+info (same formula as VerdictBar). EXCLUDES ok/clean. */
export function resultsHeading(tally: TriageIndex['tally'], t: T): string {
  const problems = tally.crit + tally.warn + tally.info;
  return t('a11y.resultsHeading', { n: problems });
}
