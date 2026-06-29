// AB-R2 — pure decision module for the first-class "optimize this folder" affordance on the results
// screen. apps/web has NO React test harness (vitest env=node), so the load-bearing decisions —
// which copy keys exist and when the deep-link anchor is shown — are extracted here and unit-tested,
// mirroring the FORMAT_KEYS / OVERRIDE_MODE_KEYS constant pattern in App.tsx. ZERO React, ZERO DOM.
//
// This is presentation discoverability only: the engine, worker, plan/execute, zip and the
// structure-preserving ExportProfile fan-out are entirely untouched. The constants below merely name a
// capability the engine already has and give the anchor + panel a single shared DOM id so they cannot
// drift. No new ops, no new defaults, no over-claim (the copy says EXACTLY what the fix engine does).

/** The three copy keys for the optimize affordance — single source of truth so a test can assert they
 *  exist in all 9 i18n catalogs (the same drift-guard discipline as the catalog completeness test). */
export interface OptimizeEntryCopy {
  titleKey: string;
  subKey: string;
  anchorKey: string;
}

export const OPTIMIZE_ENTRY: OptimizeEntryCopy = {
  titleKey: 'optimize.title',
  subKey: 'optimize.sub',
  anchorKey: 'optimize.anchor',
};

/** Show the "optimize whole folder" anchor/deep-link? It is inert with no files, so it is gated on
 *  fileCount > 0 (same emptiness guard as the FixCard run/preview buttons). `profileSupported` is
 *  reserved for a future capability check (pass true today) — encoding it now means a future capability
 *  gate is a deliberate, test-visible change rather than a silent JSX edit. PURE ⇒ Node-testable. */
export function optimizeEntryEnabled(fileCount: number, profileSupported: boolean): boolean {
  void profileSupported; // reserved for a future capability gate; does NOT gate today (pinned by the test).
  return fileCount > 0;
}

/** DOM id shared by the anchor button's scrollIntoView target and the ExportProfilePanel's <details>
 *  id attribute, so the deep-link target and the deep-link source can never drift apart. */
export const PROFILE_PANEL_ANCHOR = 'ad-export-profile';
