// Guard: every i18n key REFERENCED by App.tsx must exist in the authoritative en catalog. The catalogs
// drift test (packages/i18n) only proves the 9 locales share the SAME keys + tokens as en — it cannot
// catch a key that is USED in the app but MISSING from every catalog (the Feature 4 pack panel shipped
// `fix.pack.enable` / `mode.label` / `grouping.label` / `receipt` / `verified` referenced but uncatalogued,
// rendering raw dotted keys in all 9 languages). This statically scans App.tsx for t('…') / t(`…`) calls
// and asserts each resolved key is present in CATALOGS.en. Dynamic `fix.pack.{mode,grouping}.${k}` keys are
// expanded against the same suffix maps App.tsx uses so the per-option labels are covered too.
//
// DYNAMIC-KEY BLIND SPOTS (Round 20 #2): a `t(`prefix.${…}`)` template only renders raw dotted keys on a
// future rename if (a) the component holding it is in `appSrc` AND (b) its prefix has an expansion branch
// below. Four dynamic classes were silently dropped before this round: `severity.${f.severity}` (App.tsx +
// Findings.tsx), `license.err.${…}` (LicensePanel.tsx), `fix.lazy.${s}` and `fix.op.${…}` (both already in
// App.tsx). Findings.tsx + LicensePanel.tsx are now scanned; all four prefixes are expanded; `fix.op.*` is
// import-backed by the live `OP_KIND_ORDER` verb set (self-maintaining), the other three mirror a type-only
// union / private Set and are pinned by per-class drift-guard `it()` blocks below. MAINTENANCE CONTRACT: any
// new `t(`prefix.${…}`)` site must have its component in `appSrc` AND register a branch in
// `expandedDynamicKeys`; mirrored suffix lists must track their underlying union/Set or the drift guards fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGS } from '@asset-doctor/i18n';
import { OP_KIND_ORDER } from '../src/lib/op-manifest';
import { ALL_RULES, GROUP_ORDER } from '../src/lib/view-prefs';

const here = dirname(fileURLToPath(import.meta.url));
const comp = (name: string): string => readFileSync(join(here, '..', 'src', 'components', name), 'utf8');
const lib = (name: string): string => readFileSync(join(here, '..', 'src', 'lib', name), 'utf8');
const appSrc =
  readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8') +
  '\n' +
  // announce.ts owns the t('a11y.diagnosisReady') call (the aria-live diagnosis-ready announcement) and the
  // t('triage.showing') reuse for the live result-count. App.tsx invokes the formatters but never names those
  // keys as literals, so without scanning announce.ts a renamed a11y.* key would silently render a raw key.
  lib('announce.ts') +
  '\n' +
  // Also scan FilmViewer.tsx — it owns probe/readout t() keys (readout.declared/measured/drawCalls/batched)
  // that App.tsx never references, so without this a future key rename there would silently render raw keys.
  comp('FilmViewer.tsx') +
  '\n' +
  // The triage results view: VerdictBar owns triage.verdict/allClear + the triage.filter.* severity chips;
  // TriageLedger owns triage.sort.*/scope.*/search/group/showClean/showing/etc. App.tsx never references
  // these, so without scanning them a renamed triage.* key would silently render a raw dotted key.
  comp('VerdictBar.tsx') +
  '\n' +
  // Findings.tsx owns findings.none + t(`severity.${f.severity}`). App.tsx:2055 ALSO references severity.*;
  // both are covered by the `severity.` branch below, but Findings must still be scanned for findings.none,
  // which nothing else references.
  comp('Findings.tsx') +
  '\n' +
  // LicensePanel.tsx owns the license.* static keys + t(`license.err.${…}`) (Pro activation UI), referenced
  // nowhere else; without scanning it a renamed license.* key would silently render a raw dotted key.
  comp('LicensePanel.tsx') +
  '\n' +
  // SettingsPage.tsx owns the moved fix.* panel keys + the new settings.* keys (the whole build-config UI
  // moved off the FixCard onto the dedicated page). App.tsx only references settings.nav/settings.open, so
  // without scanning SettingsPage a renamed moved key would silently render a raw dotted key.
  comp('SettingsPage.tsx') +
  '\n' +
  comp('TriageLedger.tsx') +
  '\n' +
  // PrimaryRecommendation.tsx owns the recommend.pack.* keys (title/body/build/configure), referenced
  // nowhere else; without scanning it a renamed recommend.pack.* key would silently render a raw dotted key.
  comp('PrimaryRecommendation.tsx') +
  '\n' +
  // ledger-empty.ts owns the triage.empty.* card keys + reuses triage.showClean (the t() literals live in the
  // PURE module's emptyLedgerCard switch, not in TriageLedger.tsx), so it must be scanned or a renamed
  // empty-card key would silently render a raw dotted key. skipped-chip.ts likewise owns report.skippedChip*.
  lib('ledger-empty.ts') +
  '\n' +
  lib('skipped-chip.ts') +
  '\n' +
  // Landing.tsx owns every landing.* t() literal (the whole idle-screen landing below the Dropzone). Its
  // nav labels + the pricing-status line resolve through registry/gate constants (landing-nav.ts, pinned by
  // landing-nav.test.ts + the i18n parity test), but the section copy is static t('landing.*') and must
  // resolve; without scanning it a renamed landing key would silently render a raw dotted key.
  comp('landing/Landing.tsx') +
  '\n' +
  // LandingFooter.tsx owns landing.footer.* (+ reuses dropzone.footnote), referenced nowhere else.
  comp('landing/LandingFooter.tsx');

// Suffix maps mirrored from App.tsx (modeKey / granKey) so dynamic option keys resolve to concrete keys.
const MODE_SUFFIXES = ['auto', 'static', 'spine'];
const GRAN_SUFFIXES = ['folder', 'one', 'bundle'];
// Triage suffix maps mirrored from VerdictBar (CHIP_SEVERITIES → triage.filter.${sev}) and TriageLedger
// (SORT_KEYS → triage.sort.${k}, row.scope → triage.scope.${scope}) so each template t(`triage.x.${k}`)
// resolves to the concrete per-option keys (never leaks a `${...}` literal into the assertion).
const TRIAGE_FILTER_SUFFIXES = ['crit', 'warn', 'info'];
const TRIAGE_SORT_SUFFIXES = ['severity', 'wastedDisk', 'vram', 'occupancy'];
const TRIAGE_SCOPE_SUFFIXES = ['asset', 'folder'];
// fix.op.${kind} (App.tsx:2210,2287) — OP_KIND_ORDER is the live verb set (op-manifest.ts); the UI adds an
// 'other' bucket for the null/unknown group (App.tsx:2287 `g.kind ?? 'other'`). Imported ⇒ cannot drift.
const FIX_OP_SUFFIXES = [...OP_KIND_ORDER, 'other'];
// severity.${f.severity} (Findings.tsx:40, App.tsx:2055) — mirrors core's TYPE-ONLY Severity union; no
// runtime values array exists, so mirror + assert-all-exist (drift-guard block below).
const SEVERITY_SUFFIXES = ['crit', 'warn', 'ok', 'info'];
// license.err.${…} (LicensePanel.tsx:29) — mirrors LicensePanel KNOWN_CODES (private Set) + the 'generic'
// fallback (the ternary's else branch). Mirror + assert-all-exist (drift-guard block below).
const LICENSE_ERR_SUFFIXES = ['unknown_key', 'inactive', 'seats_exceeded', 'reactivate', 'network', 'rate_limited', 'generic'];
// fix.lazy.${s} (App.tsx:505) — mirrors core's TYPE-ONLY BundleAvailability ('eager'|'lazy'|'isolated').
// (fix.lazy.note is a STATIC t('fix.lazy.note') call → caught by staticKeys, not emitted here.)
const LAZY_SUFFIXES = ['eager', 'lazy', 'isolated'];
// rule.${r} (SettingsPage DiagnosisCard, the finding-type checkboxes) and settings.diagnosis.group.${g}
// (the group <legend>s) — IMPORTED from view-prefs (ALL_RULES / GROUP_ORDER, the single source of truth),
// so a new rule added to core (⇒ RULE_GROUP ⇒ ALL_RULES) automatically demands a `rule.*` catalog key here.
// Cannot drift: the mirror IS the live constant, not a copied list.
const RULE_SUFFIXES = [...ALL_RULES];
const DIAGNOSIS_GROUP_SUFFIXES = [...GROUP_ORDER];

/** Static literal keys: t('a.b.c') or t(`a.b.c`) with NO interpolation. */
function staticKeys(src: string): Set<string> {
  const keys = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*['"`]([a-zA-Z0-9._]+)['"`]/g)) keys.add(m[1]!);
  return keys;
}

/** Template keys with an interpolation, e.g. t(`fix.pack.mode.${modeKey[m]}`) → expand the known prefix. */
function expandedDynamicKeys(src: string): Set<string> {
  const keys = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*`([^`]*\$\{[^`]*)`/g)) {
    const tmpl = m[1]!;
    if (tmpl.startsWith('fix.pack.mode.')) MODE_SUFFIXES.forEach((s) => keys.add(`fix.pack.mode.${s}`));
    else if (tmpl.startsWith('fix.pack.grouping.')) GRAN_SUFFIXES.forEach((s) => keys.add(`fix.pack.grouping.${s}`));
    else if (tmpl.startsWith('triage.filter.')) TRIAGE_FILTER_SUFFIXES.forEach((s) => keys.add(`triage.filter.${s}`));
    else if (tmpl.startsWith('triage.sort.')) TRIAGE_SORT_SUFFIXES.forEach((s) => keys.add(`triage.sort.${s}`));
    else if (tmpl.startsWith('triage.scope.')) TRIAGE_SCOPE_SUFFIXES.forEach((s) => keys.add(`triage.scope.${s}`));
    else if (tmpl.startsWith('severity.')) SEVERITY_SUFFIXES.forEach((s) => keys.add(`severity.${s}`));
    else if (tmpl.startsWith('license.err.')) LICENSE_ERR_SUFFIXES.forEach((s) => keys.add(`license.err.${s}`));
    // fix.lazy. / fix.op. are branched AFTER the more-specific fix.pack.mode./fix.pack.grouping. above; none
    // of these prefix-collide, so order is incidental, but kept specific-first for clarity.
    else if (tmpl.startsWith('fix.lazy.')) LAZY_SUFFIXES.forEach((s) => keys.add(`fix.lazy.${s}`));
    else if (tmpl.startsWith('fix.op.')) FIX_OP_SUFFIXES.forEach((s) => keys.add(`fix.op.${s}`));
    // settings.diagnosis.group. must be branched BEFORE rule. is irrelevant (no prefix overlap), but the
    // group prefix is longer than nothing else here — kept adjacent to its sibling for clarity.
    else if (tmpl.startsWith('settings.diagnosis.group.')) DIAGNOSIS_GROUP_SUFFIXES.forEach((s) => keys.add(`settings.diagnosis.group.${s}`));
    else if (tmpl.startsWith('rule.')) RULE_SUFFIXES.forEach((s) => keys.add(`rule.${s}`));
  }
  return keys;
}

describe('app i18n keys exist in the en catalog', () => {
  it('every t() key referenced in App.tsx + FilmViewer + VerdictBar + TriageLedger is present in CATALOGS.en', () => {
    const referenced = new Set<string>([...staticKeys(appSrc), ...expandedDynamicKeys(appSrc)]);
    // Only assert on app-namespaced keys we control (fix.* / find.* / folder.* / triage.* all live in the catalog).
    const missing = [...referenced].filter((k) => CATALOGS.en[k] === undefined).sort();
    expect(missing, `keys used in the app but missing from en.json: ${missing.join(', ')}`).toEqual([]);
  });

  it('the triage results-view keys are catalogued (regression for VerdictBar/TriageLedger drift)', () => {
    for (const k of [
      'triage.verdict',
      'triage.allClear',
      'triage.filter.crit',
      'triage.filter.warn',
      'triage.filter.info',
      'triage.sort.label',
      'triage.sort.severity',
      'triage.sort.wastedDisk',
      'triage.sort.vram',
      'triage.sort.occupancy',
      'triage.scope.asset',
      'triage.scope.folder',
      'triage.search',
      'triage.group',
      'triage.problemsOnly',
      'triage.showClean',
      'triage.showing',
      'triage.relatedRefs',
      'triage.cabinetIssues',
      'triage.cleanAsset',
      // UX-4: the cause-aware empty-ledger cards replaced the single cause-blind triage.noMatch (removed).
      'triage.empty.clean.title',
      'triage.empty.clean.body',
      'triage.empty.filtered.title',
      'triage.empty.filtered.body',
      'triage.empty.filtered.action',
      'triage.empty.search.title',
      'triage.empty.search.action',
      'report.skippedChip',
      'report.skippedChip.hint',
    ]) {
      expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
    }
  });

  it('the aria-live announcement key is catalogued (its t() call lives in announce.ts, not App.tsx)', () => {
    // a11y.diagnosisReady is emitted by analysisReadyMessage (announce.ts) — pinned explicitly because the
    // literal lives outside App.tsx; the static scan above also covers it now that announce.ts is in appSrc.
    expect(CATALOGS.en['a11y.diagnosisReady'], 'a11y.diagnosisReady must exist in en.json').toBeDefined();
    // The result-count announcement reuses the existing ledger key (no new key) — pinned for parity.
    expect(CATALOGS.en['triage.showing'], 'triage.showing must exist in en.json').toBeDefined();
  });

  it('the Feature 4 pack panel keys are catalogued (regression for the missing-keys bug)', () => {
    for (const k of [
      'fix.pack.enable',
      'fix.pack.mode.label',
      'fix.pack.grouping.label',
      'fix.pack.receipt',
      'fix.pack.verified',
      'fix.packWarn',
    ]) {
      expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
    }
  });

  it('severity.* dynamic keys all exist in en — drift guard for the mirrored type-only union', () => {
    for (const s of SEVERITY_SUFFIXES) {
      expect(CATALOGS.en[`severity.${s}`], `severity.${s} must exist in en.json`).toBeDefined();
    }
  });

  it('license.err.* dynamic keys (LicensePanel KNOWN_CODES + generic) all exist in en', () => {
    for (const s of LICENSE_ERR_SUFFIXES) {
      expect(CATALOGS.en[`license.err.${s}`], `license.err.${s} must exist in en.json`).toBeDefined();
    }
  });

  it('fix.lazy.* + fix.op.* dynamic keys all exist in en (fix.op.* mirrors imported OP_KIND_ORDER)', () => {
    for (const s of LAZY_SUFFIXES) {
      expect(CATALOGS.en[`fix.lazy.${s}`], `fix.lazy.${s} must exist in en.json`).toBeDefined();
    }
    for (const s of FIX_OP_SUFFIXES) {
      expect(CATALOGS.en[`fix.op.${s}`], `fix.op.${s} must exist in en.json`).toBeDefined();
    }
  });

  it('rule.* labels exist in en for EVERY rule (drift guard — mirrors imported ALL_RULES / core Rule union)', () => {
    // A 22nd core Rule ⇒ RULE_GROUP ⇒ ALL_RULES grows ⇒ this fails until the rule.* label is added to en.
    expect(RULE_SUFFIXES).toHaveLength(21);
    for (const r of RULE_SUFFIXES) {
      expect(CATALOGS.en[`rule.${r}`], `rule.${r} must exist in en.json (the DiagnosisCard checkbox label)`).toBeDefined();
    }
  });

  it('settings.diagnosis.* keys (card + group legends) exist in en', () => {
    for (const k of [
      'settings.section.diagnosis',
      'settings.diagnosis.intro',
      'settings.diagnosis.hiddenSummary',
      'settings.diagnosis.showAll',
      'settings.diagnosis.groupToggle',
    ]) {
      expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
    }
    for (const g of DIAGNOSIS_GROUP_SUFFIXES) {
      expect(CATALOGS.en[`settings.diagnosis.group.${g}`], `settings.diagnosis.group.${g} must exist in en.json`).toBeDefined();
    }
  });

  it('the finding-type filter H-line + empty-card keys are catalogued (TriageLedger / ledger-empty drift)', () => {
    for (const k of [
      'triage.typeHidden.summary',
      'triage.typeHidden.clear',
      'triage.empty.typeFiltered.title',
      'triage.empty.typeFiltered.body',
    ]) {
      expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
    }
  });
});
