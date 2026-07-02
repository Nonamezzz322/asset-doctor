// Settings-page routing (settings-page design §2/§5.1) — the PURE hash→view decision. apps/web has NO
// React test harness (vitest env=node), so the load-bearing rule — which location.hash shows the Settings
// page — lives here and is unit-tested; App.tsx only wires `viewOfHash(location.hash)` to a `hashchange`
// listener. ZERO DOM, ZERO React, no new deps (hash-based view, NOT react-router — repo convention).
//
// Contract (deliberately strict): EXACTLY '#settings' opens the Settings page; every other hash — '',
// '#', '#Settings' (case matters: it must round-trip the literal href we emit), '#settings/x', '#foo' —
// falls back to the main Dropzone/results view, so an unknown/stale deep-link can never strand the user
// on a blank route. The main tree stays MOUNTED (hidden) while 'settings' is shown, so analysis/fix state
// survives navigation — that wiring lives in App.tsx; this module only decides the view.

/** The two views the app can show. 'main' = Dropzone/results (default); 'settings' = the build-settings page. */
export type View = 'main' | 'settings';

/** The ONE hash that routes to the Settings page — shared by the header nav link, the optimize-entry
 *  deep-link anchor and the hashchange listener so source and target can never drift. */
export const SETTINGS_HASH = '#settings';

/** Map a location.hash string to the view to render. Total + deterministic: exactly SETTINGS_HASH ⇒
 *  'settings'; ANYTHING else (empty, '#', case-mismatch, extra segments, unknown) ⇒ 'main' (fail-open to
 *  the main view — a bad deep-link never blanks the app). */
export function viewOfHash(hash: string): View {
  return hash === SETTINGS_HASH ? 'settings' : 'main';
}
