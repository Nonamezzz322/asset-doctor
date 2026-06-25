// Thin React layer over @asset-doctor/i18n: a context exposing the current locale, a setter (persisted
// + detected from the browser), the bound translator t(), and a finding renderer. Catalogs/templates
// live in the shared package so the extension reuses the exact same translations.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Finding } from '@asset-doctor/core';
import {
  detectLocale,
  isLocale,
  LOCALES,
  makeT,
  NATIVE_NAME,
  renderFinding as renderFindingI18n,
  type Locale,
  type RenderedFinding,
  type T,
} from '@asset-doctor/i18n';

const STORAGE_KEY = 'ad.locale';

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: T;
  renderFinding: (f: Finding) => RenderedFinding;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && isLocale(saved)) return saved;
  } catch {
    /* ignore */
  }
  return detectLocale();
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale: (l) => {
        try {
          localStorage.setItem(STORAGE_KEY, l);
        } catch {
          /* ignore */
        }
        setLocaleState(l);
      },
      t: makeT(locale),
      renderFinding: (f) => renderFindingI18n(f, locale),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}

export { LOCALES, NATIVE_NAME };
export type { Locale };
