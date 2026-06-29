// PURE a11y announcement formatters (no React, no DOM — Node-testable). The <=10s instant-wow and every
// analysis state transition are visual-only; these turn the SAME on-screen numbers into the strings a
// persistent aria-live region speaks. `t` is INJECTED (not imported) so this stays pure + locale-agnostic
// and the unit test can assert the exact KEY + PARAMS chosen with a fake translator — mirroring how
// triage.ts / film-selection.ts stay React-free.
//
// HONESTY (invariants 3 & 5 — load-bearing): announce ONLY numbers already rendered on screen. The problem
// count is crit+warn+info — IDENTICAL to VerdictBar's problemCount (VerdictBar.tsx) — and deliberately
// EXCLUDES tally.ok / cleanAssetCount (a clean asset has no problem footprint to claim, so folding it in
// would inflate the spoken count). shown/total are the ledger's rows.length / totalRows verbatim. VRAM is
// NEVER announced (disk weight ≠ GPU footprint must not be conflated in speech either).

import type { T } from '@asset-doctor/i18n';
import type { TriageIndex } from './triage';

/** "Diagnosis ready. N problems found." — N = crit+warn+info (same formula as VerdictBar). EXCLUDES ok/clean. */
export function analysisReadyMessage(tally: TriageIndex['tally'], t: T): string {
  const problems = tally.crit + tally.warn + tally.info;
  return t('a11y.diagnosisReady', { n: problems });
}

/** "showing N of M" — reuses the EXISTING ledger key; numbers pass straight through (no rounding/derivation). */
export function resultCountMessage(shown: number, total: number, t: T): string {
  return t('triage.showing', { n: shown, m: total });
}
