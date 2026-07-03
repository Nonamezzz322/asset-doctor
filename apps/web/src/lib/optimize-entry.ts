// AB-R2 (+ settings-page design §2) — pure decision module for the first-class "optimize this folder"
// affordance on the results screen. apps/web has NO React test harness (vitest env=node), so the
// load-bearing decisions — which copy keys exist and when the deep-link anchor is shown — are extracted
// here and unit-tested, mirroring the FORMAT_KEYS / OVERRIDE_MODE_KEYS constant pattern. ZERO React,
// ZERO DOM.
//
// This is presentation discoverability only: the engine, worker, plan/execute, zip and the
// structure-preserving ExportProfile fan-out are entirely untouched. The constants below merely name a
// capability the engine already has and give the deep-link source + target a single shared DOM id so
// they cannot drift. No new ops, no new defaults, no over-claim (the copy says EXACTLY what the fix
// engine does).
//
// SETTINGS-PAGE UPDATE: the anchor is now a NAVIGATION link — `<a href={SETTINGS_HASH}>` (lib/route.ts)
// — to the dedicated Settings page. The Formats card ("Форматы вывода", the moved ExportProfilePanel)
// carries PROFILE_PANEL_ANCHOR as a stable DOM id. (The diagnosis view-filter card is placed first on the
// page, so the link lands at the settings top rather than directly on Formats — no scroll bookkeeping.)
// The gate (optimizeEntryEnabled) and the copy keys are unchanged.

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

/** DOM id of the deep-link TARGET — the Formats card (the moved ExportProfilePanel content) on the
 *  Settings page (now the second card, after the diagnosis view-filter card). The anchor itself navigates
 *  via href={SETTINGS_HASH} (lib/route.ts); sharing this id keeps the deep-link source and target from ever
 *  drifting apart. (Pre-settings-page this was the FixCard ExportProfilePanel <details> id — value unchanged.) */
export const PROFILE_PANEL_ANCHOR = 'ad-export-profile';
