// PURE tests for the durable BuildSettings persistence (settings-persist.ts). apps/web has NO React harness
// (vitest env=node), so the load-bearing behavior — round-trip through localStorage, fail-closed load, and
// the invariant that backend-op toggles are NEVER restored from storage — is asserted here. localStorage is
// stubbed exactly like view-prefs.test.ts / theme.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { settingsDefaults } from '../src/lib/build-settings';
import { BUILD_SETTINGS_STORAGE_KEY, loadBuildSettings, saveBuildSettings } from '../src/lib/settings-persist';

function installLocalStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  return m;
}
function installThrowingStorage(): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
}
afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('settings-persist — round-trip', () => {
  it('save then load restores the changed settings (formats/quality/packing survive a reload)', () => {
    installLocalStorage();
    const s = {
      ...settingsDefaults(),
      profileEnable: true,
      profileFormats: {
        ...settingsDefaults().profileFormats,
        'image/webp': { enabled: true, quality: 70, lossless: false, near: true },
      },
      defaultTarget: 'image/webp' as const,
      defaultQuality: 60,
      padding: 8,
      maxSize: 2048,
      packLoose: true,
      trimMargin: false,
      hashFilenames: true,
    };
    saveBuildSettings(s);
    const loaded = loadBuildSettings();
    expect(loaded.profileEnable).toBe(true);
    expect(loaded.profileFormats['image/webp']).toEqual({ enabled: true, quality: 70, lossless: false, near: true });
    expect(loaded.defaultTarget).toBe('image/webp');
    expect(loaded.defaultQuality).toBe(60);
    expect(loaded.padding).toBe(8);
    expect(loaded.maxSize).toBe(2048);
    expect(loaded.packLoose).toBe(true);
    expect(loaded.trimMargin).toBe(false);
    expect(loaded.hashFilenames).toBe(true);
  });

  it('persists under the ad.buildSettings key', () => {
    const m = installLocalStorage();
    saveBuildSettings(settingsDefaults());
    expect(m.has(BUILD_SETTINGS_STORAGE_KEY)).toBe(true);
  });

  it('no stored value ⇒ defaults', () => {
    installLocalStorage();
    expect(loadBuildSettings()).toEqual(settingsDefaults());
  });
});

describe('settings-persist — fail-closed', () => {
  it('corrupt JSON ⇒ defaults (never throws)', () => {
    const m = installLocalStorage();
    m.set(BUILD_SETTINGS_STORAGE_KEY, '{ not json');
    expect(loadBuildSettings()).toEqual(settingsDefaults());
  });
  it('throwing storage ⇒ load defaults, save does not throw', () => {
    installThrowingStorage();
    expect(loadBuildSettings()).toEqual(settingsDefaults());
    expect(() => saveBuildSettings(settingsDefaults())).not.toThrow();
  });
  it('missing localStorage ⇒ defaults, save no-throw', () => {
    expect(loadBuildSettings()).toEqual(settingsDefaults());
    expect(() => saveBuildSettings(settingsDefaults())).not.toThrow();
  });
});

describe('settings-persist — backend toggles NEVER restored (invariant 1/2, consent per-run)', () => {
  it('backend toggles set true are not written, and load returns them off', () => {
    installLocalStorage();
    saveBuildSettings({ ...settingsDefaults(), ktx2Enable: true, pngquantEnable: true, resampleEnable: true });
    const loaded = loadBuildSettings();
    expect(loaded.ktx2Enable).toBe(false);
    expect(loaded.pngquantEnable).toBe(false);
    expect(loaded.resampleEnable).toBe(false);
  });
  it('a tampered stored value injecting backend toggles is ignored on load', () => {
    const m = installLocalStorage();
    // hand-craft a valid config that (illegally) carries backend keys; pickSettings must ignore them.
    m.set(
      BUILD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ kind: 'asset-doctor/build-config', version: 2, ktx2Enable: true, pngquantEnable: true, resampleEnable: true }),
    );
    const loaded = loadBuildSettings();
    expect(loaded.ktx2Enable).toBe(false);
    expect(loaded.pngquantEnable).toBe(false);
    expect(loaded.resampleEnable).toBe(false);
  });
});
