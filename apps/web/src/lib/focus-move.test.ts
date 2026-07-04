// PURE-decision lock for the view-swap focus manager. apps/web has NO React test harness (vitest env=node),
// so the load-bearing rule — which anchor (if any) receives focus after each phase/view swap — is asserted
// here; App.tsx only wires `getElementById(target)?.focus()`. The DOM/effect wiring itself is manual-gated
// (keyboard + SR smoke, noted in the PR).

import { describe, it, expect } from 'vitest';
import { focusTargetAfterSwap, FOCUS_ANCHORS, type SwapState, type PhaseT } from './focus-move';
import type { View } from './route';

const PHASES: PhaseT[] = ['idle', 'analyzing', 'done', 'error'];
const VIEWS: View[] = ['main', 'settings', 'pro'];
const s = (view: View, phase: PhaseT): SwapState => ({ view, phase });

describe('FOCUS_ANCHORS — frozen markup contract', () => {
  it('pins the exact anchor ids App.tsx / SettingsPage render', () => {
    expect(FOCUS_ANCHORS).toEqual({
      results: 'ad-results-h1',
      dropzone: 'ad-dropzone-h1',
      settings: 'ad-settings-h1',
      pro: 'ad-pro-h1',
    });
  });
});

describe('focusTargetAfterSwap — phase swaps (view stays main)', () => {
  it('analyzing→done ⇒ results h1 (the ≤10s payoff lands on the diagnosis, not <body>)', () => {
    expect(focusTargetAfterSwap(s('main', 'analyzing'), s('main', 'done'))).toBe(FOCUS_ANCHORS.results);
  });

  it('done→idle ⇒ dropzone h1 ("analyze another" unmounts itself)', () => {
    expect(focusTargetAfterSwap(s('main', 'done'), s('main', 'idle'))).toBe(FOCUS_ANCHORS.dropzone);
  });

  it('idle→analyzing ⇒ null (the polite status region narrates; no focus steal)', () => {
    expect(focusTargetAfterSwap(s('main', 'idle'), s('main', 'analyzing'))).toBeNull();
  });

  it('analyzing→error ⇒ null (role=alert announces; focusing an alert is non-standard)', () => {
    expect(focusTargetAfterSwap(s('main', 'analyzing'), s('main', 'error'))).toBeNull();
  });

  it('error→analyzing→done chain ⇒ null then results (a retry after a failed drop still lands)', () => {
    expect(focusTargetAfterSwap(s('main', 'error'), s('main', 'analyzing'))).toBeNull();
    expect(focusTargetAfterSwap(s('main', 'analyzing'), s('main', 'done'))).toBe(FOCUS_ANCHORS.results);
  });

  it('done→analyzing ⇒ null (unreachable today via re-drop, but the function stays total)', () => {
    expect(focusTargetAfterSwap(s('main', 'done'), s('main', 'analyzing'))).toBeNull();
  });
});

describe('focusTargetAfterSwap — initial mount / no-op pairs never steal focus', () => {
  it('every identity pair (s,s) ⇒ null (first render seeds prev=current ⇒ first Tab reaches the skip link)', () => {
    for (const v of VIEWS) for (const p of PHASES) expect(focusTargetAfterSwap(s(v, p), s(v, p))).toBeNull();
  });
});

describe('focusTargetAfterSwap — view swaps (settings router; ONE focus owner, I2)', () => {
  it('main→settings ⇒ settings h1 regardless of phase', () => {
    for (const p of PHASES) expect(focusTargetAfterSwap(s('main', p), s('settings', p))).toBe(FOCUS_ANCHORS.settings);
  });

  it('settings→main with phase done ⇒ results h1 (return handled here — SettingsPage is unmounted by now)', () => {
    expect(focusTargetAfterSwap(s('settings', 'done'), s('main', 'done'))).toBe(FOCUS_ANCHORS.results);
  });

  it('settings→main with phase idle/analyzing/error ⇒ dropzone h1', () => {
    for (const p of ['idle', 'analyzing', 'error'] as PhaseT[])
      expect(focusTargetAfterSwap(s('settings', p), s('main', p))).toBe(FOCUS_ANCHORS.dropzone);
  });

  it('phase flip while view=settings ⇒ null (never focus a display:none subtree)', () => {
    expect(focusTargetAfterSwap(s('settings', 'analyzing'), s('settings', 'done'))).toBeNull();
    expect(focusTargetAfterSwap(s('settings', 'done'), s('settings', 'idle'))).toBeNull();
  });
});

describe('focusTargetAfterSwap — Pro view swaps (app-screen Phase 4)', () => {
  it('main→pro ⇒ pro h1 regardless of phase', () => {
    for (const p of PHASES) expect(focusTargetAfterSwap(s('main', p), s('pro', p))).toBe(FOCUS_ANCHORS.pro);
  });

  it('settings↔pro ⇒ the target page h1 (both are display:none siblings of main)', () => {
    for (const p of PHASES) {
      expect(focusTargetAfterSwap(s('settings', p), s('pro', p))).toBe(FOCUS_ANCHORS.pro);
      expect(focusTargetAfterSwap(s('pro', p), s('settings', p))).toBe(FOCUS_ANCHORS.settings);
    }
  });

  it('pro→main with phase done ⇒ results h1, else ⇒ dropzone h1', () => {
    expect(focusTargetAfterSwap(s('pro', 'done'), s('main', 'done'))).toBe(FOCUS_ANCHORS.results);
    for (const p of ['idle', 'analyzing', 'error'] as PhaseT[])
      expect(focusTargetAfterSwap(s('pro', p), s('main', p))).toBe(FOCUS_ANCHORS.dropzone);
  });

  it('phase flip while view=pro ⇒ null (never focus a display:none subtree)', () => {
    expect(focusTargetAfterSwap(s('pro', 'analyzing'), s('pro', 'done'))).toBeNull();
    expect(focusTargetAfterSwap(s('pro', 'done'), s('pro', 'idle'))).toBeNull();
  });
});

describe('focusTargetAfterSwap — exhaustive determinism sweep', () => {
  it('all 144 (prev,next) pairs return null or a known anchor, and repeat calls are identical', () => {
    const known = new Set<string | null>([null, ...Object.values(FOCUS_ANCHORS)]);
    for (const pv of VIEWS)
      for (const pp of PHASES)
        for (const nv of VIEWS)
          for (const np of PHASES) {
            const a = focusTargetAfterSwap(s(pv, pp), s(nv, np));
            const b = focusTargetAfterSwap(s(pv, pp), s(nv, np));
            expect(known.has(a)).toBe(true);
            expect(a).toBe(b);
          }
  });
});
