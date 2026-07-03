// PURE display-theme preference (no React; a guarded localStorage + a documentElement stub — Node-testable).
// Precedents: view-prefs.ts (fail-closed localStorage-guarded slice) and i18n.tsx (a durable bare-string UI
// pref applied to documentElement). Storing 'auto'|'light'|'dark' never puts asset bytes on disk or a wire —
// invariant 1 intact.
//
// The theme lives on <html data-theme> (outside React) so it can be applied FOUC-free by a tiny classic
// <head> script in index.html BEFORE first paint. That inline script hand-mirrors this module (a classic
// script cannot import ESM pre-paint); test/theme.test.ts pins the shared contract (THEME_STORAGE_KEY + the
// light/dark→attribute, auto→no-attribute mapping) so the two can never drift.

export type Theme = 'auto' | 'light' | 'dark';

/** The three known values, in display order (auto first — the default). */
export const THEMES: readonly Theme[] = ['auto', 'light', 'dark'];

/** localStorage key for the durable theme pref. Namespaced `ad.*` like `ad.locale` / `ad.hiddenRules`. */
export const THEME_STORAGE_KEY = 'ad.theme';

/** FAIL-CLOSED parse: only the three known strings survive; anything else (missing, garbage, wrong case,
 *  non-string) ⇒ 'auto' (follow the OS). A corrupt or hostile stored value can only ever degrade to the
 *  browser-following default — never crash, never force a surprising theme. */
export function parseTheme(raw: unknown): Theme {
  return raw === 'light' || raw === 'dark' || raw === 'auto' ? raw : 'auto';
}

/** Serialize to the bare string (round-trips through parseTheme). */
export function serializeTheme(t: Theme): string {
  return t;
}

/** Read the durable pref. localStorage-guarded (SSR / disabled storage / quota) AND fail-closed. Worst case
 *  ⇒ 'auto'. */
export function loadTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

/** Persist the pref. localStorage-guarded — a throwing/absent storage is swallowed (the in-memory UI state is
 *  the source of truth, only persistence is skipped, exactly like i18n.tsx's setLocale). */
export function saveTheme(t: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, serializeTheme(t));
  } catch {
    /* ignore — persistence is best-effort */
  }
}

/** Apply a theme to the document root. 'light'/'dark' set data-theme (specificity outranks the media query
 *  ⇒ forces that theme); 'auto' REMOVES the attribute so the CSS @media(prefers-color-scheme) drives, reacting
 *  live to OS changes with zero JS. `root` is injected (not `document`) so this is Node-testable with a stub.
 *  Idempotent. Must be called once at startup with document.documentElement so a stored 'auto' after a previous
 *  forced choice clears the attribute the inline <head> script never sets. */
export function applyTheme(t: Theme, root: { dataset: DOMStringMap }): void {
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;
}
