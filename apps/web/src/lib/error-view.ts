// PURE error-state → card model (no React, no DOM — Node-testable; precedent: ledger-empty.ts /
// results-heading.ts). apps/web has no React harness, so the load-bearing DECISIONS — the failure title KEY
// per surface, and the demotion of the RAW (untranslated) worker message into a collapsed detail — are
// extracted here and asserted with a fake translator. HONESTY (invariant 3): the raw worker string is passed
// through VERBATIM as detail.body — never translated, never fabricated; only the human TITLE + the disclosure
// LABEL are localized. Pure UI/i18n, zero network (invariants 1–3 intact).
import type { T } from '@asset-doctor/i18n';

/** A failed run. Replaces the old {t:'error';message:string} phase variant, which conflated a pre-translated
 *  noFiles sentence with a raw thrown message. noFiles has its own localized sentence; `failed` carries the
 *  raw (untranslated) worker string to demote. */
export type ErrorState = { kind: 'noFiles' } | { kind: 'failed'; detail: string };

/** Which surface raised it — selects the failure title (analysis dropzone vs. paid fix run). */
export type ErrorContext = 'analyze' | 'fix';

export interface ErrorCard {
  /** Localized human title. role=alert speaks THIS (not the raw body). */
  title: string;
  /** Present ONLY for a raw thrown error: the collapsed disclosure. `label` localized; `body` the VERBATIM
   *  worker message. noFiles → undefined (its title is already the whole message; nothing to demote). */
  detail?: { label: string; body: string };
}

export function errorCard(state: ErrorState, t: T, ctx: ErrorContext = 'analyze'): ErrorCard {
  if (state.kind === 'noFiles') return { title: t('error.noFiles') };
  // Two SEPARATE literal t() calls (not t(cond?'a':'b')) so the i18n-app-keys static scan resolves both keys.
  const title = ctx === 'fix' ? t('error.fixFailed') : t('error.analysisFailed');
  return { title, detail: { label: t('error.detailsLabel'), body: state.detail } };
}

/** Normalize a thrown value to a raw display string (dedups the old inline `e instanceof Error ? …` at the
 *  4 catch sites). Pure. */
export const errDetail = (e: unknown): string => (e instanceof Error ? e.message : String(e));
