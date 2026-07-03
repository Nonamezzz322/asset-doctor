// PURE skipped-files chip model + the anchor contract (no React/DOM — Node-testable). The chip is a
// "could not analyze" jump command — NOT a severity: it must never join the tally chips, claim a finding
// count, or be counted into problemCount. `n` is report.unparsed.length verbatim (invariant 3 — measured).

import type { T } from '@asset-doctor/i18n';

/** Anchor id on the UnparsedNotice <details>; SUMMARY_ID on its <summary> (the focus target). Exported
 *  constants so the chip (source) and the notice (target) can never drift — same discipline as route.ts's
 *  SETTINGS_HASH. */
export const UNPARSED_DETAILS_ID = 'unparsed-notice';
export const UNPARSED_SUMMARY_ID = 'unparsed-notice-summary';

export interface SkippedChip {
  label: string;
  hint: string;
}

/** null when nothing was skipped (chip unmounted — 0 must render NOTHING, never "0 files skipped"). */
export function skippedChipModel(unparsedCount: number, t: T): SkippedChip | null {
  if (unparsedCount <= 0) return null;
  return {
    label: t('report.skippedChip', { n: unparsedCount }),
    hint: t('report.skippedChip.hint'),
  };
}
