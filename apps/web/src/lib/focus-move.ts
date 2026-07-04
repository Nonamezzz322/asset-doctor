// PURE view-swap focus-target decision (no React, no DOM — Node-testable; precedent: progress-view.ts /
// results-heading.ts). Every phase/view swap in App unmounts (or display:none-s, via the settings `hidden`
// wrapper) the focused control, dropping keyboard/SR focus to <body> at the exact ≤10s payoff moment. This
// module owns the ONE rule table: which anchor (if any) receives focus after a swap. App.tsx only does
// `getElementById(target)?.focus()`.

import type { View } from './route';

export type PhaseT = 'idle' | 'analyzing' | 'done' | 'error';
export interface SwapState {
  view: View;
  phase: PhaseT;
}

/** Frozen DOM anchor ids (repo convention: 'ad-' prefix, cf. PROFILE_PANEL_ANCHOR='ad-export-profile').
 *  These are a CONTRACT with App.tsx / SettingsPage markup — the test freezes them. */
export const FOCUS_ANCHORS = {
  results: 'ad-results-h1', // the results <h1> (App.tsx)
  dropzone: 'ad-dropzone-h1', // the Dropzone <h1> (App.tsx)
  settings: 'ad-settings-h1', // SettingsPage <h1>
  pro: 'ad-pro-h1', // ProPage <h1> (app-screen re-skin Phase 4)
} as const;
export type FocusAnchor = (typeof FOCUS_ANCHORS)[keyof typeof FOCUS_ANCHORS];

/** Decide the focus target after a state swap. Total + deterministic; null = do not move focus.
 *  RULES (ordered):
 *  1. view changed ⇒ full context change: settings ⇒ its h1; main ⇒ results h1 when a diagnosis is showing,
 *     else the dropzone h1. (Covers the settings→main return, which SettingsPage's own mount effect can
 *     never handle — it is unmounted by then; this is the ONE focus owner, integration note I2.)
 *  2. view unchanged but 'settings' ⇒ null: the main tree is display:none (hidden wrapper) — its anchors are
 *     unfocusable; a phase flip mid-settings (analysis finishing in the worker) must not steal focus from the
 *     settings page. The live region (outside the wrapper) still speaks.
 *  3. →'done' ⇒ results h1 (the ≤10s payoff lands under the user's cursor, not on <body>).
 *  4. 'done'→'idle' ⇒ dropzone h1 ("analyze another" unmounts itself).
 *  5. everything else (→analyzing, →error, no-op pairs) ⇒ null — those transitions keep an announcing
 *     surface mounted (role=status / role=alert) and moving focus there is non-standard.
 */
export function focusTargetAfterSwap(prev: SwapState, next: SwapState): FocusAnchor | null {
  if (prev.view !== next.view) {
    if (next.view === 'settings') return FOCUS_ANCHORS.settings;
    if (next.view === 'pro') return FOCUS_ANCHORS.pro;
    return next.phase === 'done' ? FOCUS_ANCHORS.results : FOCUS_ANCHORS.dropzone;
  }
  if (next.view !== 'main') return null; // settings OR pro: the main tree is display:none — its anchors are unfocusable.
  if (prev.phase === next.phase) return null;
  if (next.phase === 'done') return FOCUS_ANCHORS.results;
  if (prev.phase === 'done' && next.phase === 'idle') return FOCUS_ANCHORS.dropzone;
  return null;
}
