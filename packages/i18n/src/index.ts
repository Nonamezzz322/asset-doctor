// @asset-doctor/i18n — framework-agnostic, zero-dependency localization shared by the web app and the
// browser extension. A flat key→template catalog per locale; templates interpolate `{name}` params
// with optional format hints (:bytes :mb :pct :sev) and select plural forms via Intl.PluralRules. The
// finding/correlation renderers turn the analysis/correlate `messageKey`+`params` into localized text;
// English is identical to the baked strings (a drift test guards this), and any missing key falls back
// to English, so a partially-translated locale degrades gracefully.

import type { Finding, FindingParams } from '@asset-doctor/core';
import type { CorrelatedFinding } from '@asset-doctor/correlate';

import en from './catalogs/en.json';
import ru from './catalogs/ru.json';
import de from './catalogs/de.json';
import es from './catalogs/es.json';
import pt from './catalogs/pt.json';
import fr from './catalogs/fr.json';
import it from './catalogs/it.json';
import zh from './catalogs/zh.json';
import hi from './catalogs/hi.json';

export const LOCALES = ['en', 'ru', 'de', 'es', 'pt', 'fr', 'it', 'zh', 'hi'] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language's name in its own script (constant across catalogs). */
export const NATIVE_NAME: Record<Locale, string> = {
  en: 'English',
  ru: 'Русский',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  fr: 'Français',
  it: 'Italiano',
  zh: '中文',
  hi: 'हिन्दी',
};

export interface PluralForm {
  /** Param name whose count selects the plural category. */
  $count: string;
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}
export type CatalogEntry = string | PluralForm;
export type Catalog = Record<string, CatalogEntry>;

const CATALOGS: Record<Locale, Catalog> = {
  en: en as Catalog,
  ru: ru as Catalog,
  de: de as Catalog,
  es: es as Catalog,
  pt: pt as Catalog,
  fr: fr as Catalog,
  it: it as Catalog,
  zh: zh as Catalog,
  hi: hi as Catalog,
};

export const isLocale = (s: string): s is Locale => (LOCALES as readonly string[]).includes(s);

/** Map a navigator-style language tag (e.g. "pt-BR", "zh-Hans-CN") to a supported locale, else 'en'. */
export function detectLocale(tags: readonly string[] = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []): Locale {
  for (const tag of tags) {
    const base = tag.toLowerCase().split('-')[0] ?? '';
    if (isLocale(base)) return base;
  }
  return 'en';
}

const isFinite = Number.isFinite;
function fmtBytes(n: number): string {
  if (!isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const fmtMB = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
const pct1 = (n: number): string => `${Math.round(n * 1000) / 10}%`;

const PLURAL_CACHE = new Map<Locale, Intl.PluralRules>();
function pluralRules(locale: Locale): Intl.PluralRules {
  let r = PLURAL_CACHE.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    PLURAL_CACHE.set(locale, r);
  }
  return r;
}

/** Resolve `{name}` / `{name:hint}` placeholders against params + catalog (for :sev). */
function interpolate(tmpl: string, params: FindingParams, locale: Locale): string {
  return tmpl.replace(/\{(\w+)(?::(\w+))?\}/g, (_m, name: string, hint?: string) => {
    const v = params[name];
    if (v === undefined) return '';
    if (hint === 'bytes') return fmtBytes(Number(v));
    if (hint === 'mb') return fmtMB(Number(v));
    if (hint === 'pct') return pct1(Number(v));
    if (hint === 'sev') return raw(CATALOGS[locale][`severity.${String(v)}`]) ?? raw(CATALOGS.en[`severity.${String(v)}`]) ?? String(v);
    return String(v);
  });
}

const raw = (e: CatalogEntry | undefined): string | undefined => (typeof e === 'string' ? e : undefined);

function resolve(locale: Locale, key: string): CatalogEntry | undefined {
  return CATALOGS[locale][key] ?? CATALOGS.en[key];
}

/** Translate a key with params. Falls back to English, then to the key itself. */
export function translate(locale: Locale, key: string, params: FindingParams = {}): string {
  const entry = resolve(locale, key);
  if (entry === undefined) return key;
  if (typeof entry === 'string') return interpolate(entry, params, locale);
  const cat = pluralRules(locale).select(Number(params[entry.$count] ?? 0));
  const tmpl = entry[cat as keyof PluralForm] ?? entry.other;
  return interpolate(typeof tmpl === 'string' ? tmpl : entry.other, params, locale);
}

/** A bound translator for a locale. */
export type T = (key: string, params?: FindingParams) => string;
export const makeT = (locale: Locale): T => (key, params) => translate(locale, key, params);

export interface RenderedFinding {
  title: string;
  detail: string;
  fix?: string;
}

/** Localize a static finding. Uses `find.<messageKey>.{title,detail,fix}`; falls back to baked English. */
export function renderFinding(f: Finding, locale: Locale): RenderedFinding {
  if (!f.messageKey || !(`find.${f.messageKey}.title` in CATALOGS.en)) {
    return { title: f.title, detail: f.detail, ...(f.fix !== undefined ? { fix: f.fix } : {}) };
  }
  const p = f.params ?? {};
  const k = `find.${f.messageKey}`;
  const hasFix = `${k}.fix` in CATALOGS.en || f.fix !== undefined;
  return {
    title: translate(locale, `${k}.title`, p),
    detail: `${k}.detail` in CATALOGS.en ? translate(locale, `${k}.detail`, p) : f.detail,
    ...(hasFix ? { fix: `${k}.fix` in CATALOGS.en ? translate(locale, `${k}.fix`, p) : f.fix } : {}),
  };
}

export interface RenderedCorrelated {
  title: string;
  staticEvidence: string;
  runtimeEvidence: string;
  diagnosis: string;
  fix: string;
}

/** Localize a correlated finding (extension overlay). `rule` is the message family; `params.variant`
 *  fields select branch templates; falls back to the baked English fields. */
export function renderCorrelated(f: CorrelatedFinding, locale: Locale): RenderedCorrelated {
  const p: FindingParams = f.params ?? {};
  const k = `corr.${f.rule}`;
  if (!(`${k}.title` in CATALOGS.en)) {
    return { title: f.title, staticEvidence: f.staticEvidence, runtimeEvidence: f.runtimeEvidence, diagnosis: f.diagnosis, fix: f.fix };
  }
  const has = (suffix: string): boolean => `${k}.${suffix}` in CATALOGS.en;
  const pick = (suffix: string, fallback: string): string => (has(suffix) ? translate(locale, `${k}.${suffix}`, p) : fallback);
  const sv = String(p.staticVariant ?? '');
  const subj = String(p.subjectVariant ?? '');
  const hitch = Number(p.hitchMs ?? 0) > 0;
  return {
    title: pick('title', f.title),
    staticEvidence: sv && has(`static_${sv}`) ? translate(locale, `${k}.static_${sv}`, p) : pick('static', f.staticEvidence),
    runtimeEvidence: hitch && has('runtime_hitch') ? translate(locale, `${k}.runtime_hitch`, p) : pick('runtime', f.runtimeEvidence),
    diagnosis: subj && has(`diag_${subj}`) ? translate(locale, `${k}.diag_${subj}`, p) : pick('diag', f.diagnosis),
    fix: subj && has(`fix_${subj}`) ? translate(locale, `${k}.fix_${subj}`, p) : pick('fix', f.fix),
  };
}

export { CATALOGS };
