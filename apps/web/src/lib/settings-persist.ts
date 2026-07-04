// Durable persistence for the full BuildSettings surface (localStorage). Without it the settings live only in
// React state and reset on every reload — so a knob the user changed silently reverts to its default on the
// next visit ("settings not applied / lost after a refresh"). This mirrors the other durable browser-only
// prefs (view-prefs.ts hiddenRules, theme.ts, the i18n locale): a guarded, fail-closed localStorage slice, no
// React, Node-testable.
//
// It REUSES the build-config serialization (serializeBuildConfig / pickSettings) so the stored shape is the
// SAME versioned, whitelisted config as the explicit file export/import — which means the backend-op toggles
// (ktx2 / pngquant / resample) and consent are STRUCTURALLY excluded and can never be restored from storage
// (consent must stay per-run — invariant 1/2), and nothing here writes asset bytes, only the numbers/strings/
// booleans the user already chose (invariant 1). Loading is deliberately LENIENT (pickSettings coerces field
// by field, backfilling anything missing/invalid) so a partially-stale stored value still restores its valid
// fields rather than being thrown away wholesale — the right posture for silent auto-persist.

import { pickSettings, serializeBuildConfig } from './build-config';
import { settingsDefaults, type BuildSettings } from './build-settings';

/** localStorage key for the durable build settings. Namespaced `ad.*` like `ad.locale` / `ad.theme` /
 *  `ad.hiddenRules`. */
export const BUILD_SETTINGS_STORAGE_KEY = 'ad.buildSettings';

/** Read the durable settings. localStorage-guarded (SSR / disabled storage / quota) AND fail-closed: a
 *  JSON.parse throw, a corrupt/tampered value, or a version drift all degrade to a field-by-field coerced
 *  result (pickSettings backfills missing/invalid fields from settingsDefaults); worst case ⇒ full defaults.
 *  Never throws. Backend-op toggles always come back at their defaults (pickSettings never restores them). */
export function loadBuildSettings(): BuildSettings {
  try {
    const raw = localStorage.getItem(BUILD_SETTINGS_STORAGE_KEY);
    if (raw === null) return settingsDefaults();
    return pickSettings(JSON.parse(raw) as unknown);
  } catch {
    return settingsDefaults();
  }
}

/** Persist the settings (best-effort; a throwing/absent storage is swallowed — the in-memory state is the
 *  source of truth, only persistence is skipped, exactly like i18n.tsx's setLocale / view-prefs's save).
 *  Serialized via the SAME whitelisted, versioned build-config format ⇒ backend toggles are never written. */
export function saveBuildSettings(s: BuildSettings): void {
  try {
    localStorage.setItem(BUILD_SETTINGS_STORAGE_KEY, serializeBuildConfig(s));
  } catch {
    /* ignore — persistence is best-effort */
  }
}
