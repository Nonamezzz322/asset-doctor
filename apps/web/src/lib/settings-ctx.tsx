// Thin React context over the pure BuildSettings model (settings-page design §3.1) — App() holds the ONE
// useState<BuildSettings> and hands the live value + a `patch`/`replace` pair down to both the Settings page
// (which edits every field) and the FixCard (which reads them to build the run's FixOptions). ALL the
// load-bearing logic lives in ./build-settings (settingsDefaults / patchSettings / buildFixOptions) — pure,
// Node-tested — so this file is deliberately trivial: it only owns the useState + delegates. Mirrors the
// existing lib/i18n.tsx context pattern (createContext + a throwing hook), the sole React-context precedent.
//
// INVARIANTS: no IO, no network here; the settings never leave the browser. `patch` ALWAYS produces a fresh
// object (patchSettings spreads) — load-bearing for the FixCard stale-plan effect, which keys on `settings`
// object identity so any page edit (even while the FixCard is hidden) invalidates a pending plan ("settings
// apply to the NEXT run"). `replace` is the atomic whole-object apply the config-load path uses (all-or-
// nothing, the same discipline as the old all-setters apply). Backend-op toggles live in BuildSettings as
// LIVE UI state only — they are never serialized (build-config.ts whitelist) and consent is never here.

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { patchSettings, settingsDefaults, type BuildSettings } from './build-settings';

export interface BuildSettingsValue {
  /** The live settings the next fix run will use. */
  settings: BuildSettings;
  /** Immutable shallow patch — always a fresh top-level object (drives the stale-plan invalidation). */
  patch: (p: Partial<BuildSettings>) => void;
  /** Atomic whole-object apply (config load) — replaces the entire settings object in one setState. */
  replace: (s: BuildSettings) => void;
}

const BuildSettingsContext = createContext<BuildSettingsValue | null>(null);

export function BuildSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<BuildSettings>(settingsDefaults);
  const value = useMemo<BuildSettingsValue>(
    () => ({
      settings,
      patch: (p) => setSettings((s) => patchSettings(s, p)),
      replace: (s) => setSettings(s),
    }),
    [settings],
  );
  return <BuildSettingsContext.Provider value={value}>{children}</BuildSettingsContext.Provider>;
}

export function useBuildSettings(): BuildSettingsValue {
  const ctx = useContext(BuildSettingsContext);
  if (!ctx) throw new Error('useBuildSettings must be used within <BuildSettingsProvider>');
  return ctx;
}
