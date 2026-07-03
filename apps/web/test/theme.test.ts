// PURE tests for the display-theme preference (theme.ts). apps/web has NO React harness (vitest env=node), so
// the load-bearing decisions — the fail-closed parse, the round-trip, the localStorage-guarded load/save, and
// the applyTheme documentElement contract that the FOUC-free index.html inline script hand-mirrors — are
// exercised here. localStorage is stubbed exactly like view-prefs.test.ts / license.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import {
  THEMES,
  THEME_STORAGE_KEY,
  applyTheme,
  loadTheme,
  parseTheme,
  saveTheme,
  serializeTheme,
  type Theme,
} from '../src/lib/theme';

// A stubbed localStorage backed by an in-memory Map (precedent: view-prefs.test.ts:27). Returned so a test can
// inspect what was persisted.
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

// A localStorage whose every access throws (disabled / quota / privacy mode) — the guard must swallow it.
function installThrowingStorage(): void {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: () => {
      throw new Error('storage blocked');
    },
    setItem: () => {
      throw new Error('storage blocked');
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

// A minimal documentElement stub — applyTheme touches only `.dataset`.
function makeRoot(): { dataset: Record<string, string | undefined> } {
  return { dataset: {} };
}

describe('theme — registry + storage-key contract', () => {
  it('THEMES is exactly [auto, light, dark] (auto first = default)', () => {
    expect(THEMES).toEqual(['auto', 'light', 'dark']);
  });
  it('THEME_STORAGE_KEY is ad.theme (the inline-script contract)', () => {
    expect(THEME_STORAGE_KEY).toBe('ad.theme');
  });
});

describe('theme — parse (fail-closed) + serialize round-trip', () => {
  it('keeps the three known values', () => {
    expect(parseTheme('auto')).toBe('auto');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
  });
  it('maps anything unknown to auto', () => {
    for (const bad of [null, undefined, '', 'Dark', 'system', 'AUTO', 42, {}, ['dark'], NaN]) {
      expect(parseTheme(bad as unknown)).toBe('auto');
    }
  });
  it('parseTheme(serializeTheme(t)) === t for every theme', () => {
    for (const t of THEMES) expect(parseTheme(serializeTheme(t))).toBe(t as Theme);
  });
});

describe('theme — load/save (localStorage-guarded)', () => {
  it('save then load round-trips dark and persists the bare string under ad.theme', () => {
    const m = installLocalStorage();
    saveTheme('dark');
    expect(m.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(loadTheme()).toBe('dark');
  });
  it('no stored value ⇒ auto', () => {
    installLocalStorage();
    expect(loadTheme()).toBe('auto');
  });
  it('a foreign/corrupt stored value ⇒ auto (fail-closed)', () => {
    const m = installLocalStorage();
    m.set(THEME_STORAGE_KEY, 'purple');
    expect(loadTheme()).toBe('auto');
  });
  it('throwing storage ⇒ load is auto and save does not throw', () => {
    installThrowingStorage();
    expect(loadTheme()).toBe('auto');
    expect(() => saveTheme('dark')).not.toThrow();
  });
  it('missing localStorage ⇒ auto and save does not throw', () => {
    // no install ⇒ globalThis.localStorage is undefined
    expect(loadTheme()).toBe('auto');
    expect(() => saveTheme('light')).not.toThrow();
  });
});

describe('theme — applyTheme documentElement contract (mirrors the inline <head> script)', () => {
  it('light/dark set data-theme', () => {
    const root = makeRoot();
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
  });
  it('auto REMOVES data-theme (so the @media query drives) and is a no-op on a clean root', () => {
    const root = makeRoot();
    applyTheme('dark', root);
    applyTheme('auto', root);
    expect(root.dataset.theme).toBeUndefined();
    // idempotent on an already-clean root
    applyTheme('auto', root);
    expect(root.dataset.theme).toBeUndefined();
  });
});
