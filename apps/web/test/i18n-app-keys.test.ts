// Guard: every i18n key REFERENCED by App.tsx must exist in the authoritative en catalog. The catalogs
// drift test (packages/i18n) only proves the 9 locales share the SAME keys + tokens as en — it cannot
// catch a key that is USED in the app but MISSING from every catalog (the Feature 4 pack panel shipped
// `fix.pack.enable` / `mode.label` / `grouping.label` / `receipt` / `verified` referenced but uncatalogued,
// rendering raw dotted keys in all 9 languages). This statically scans App.tsx for t('…') / t(`…`) calls
// and asserts each resolved key is present in CATALOGS.en. Dynamic `fix.pack.{mode,grouping}.${k}` keys are
// expanded against the same suffix maps App.tsx uses so the per-option labels are covered too.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOGS } from '@asset-doctor/i18n';

const here = dirname(fileURLToPath(import.meta.url));
const comp = (name: string): string => readFileSync(join(here, '..', 'src', 'components', name), 'utf8');
const appSrc =
  readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8') +
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
  comp('TriageLedger.tsx');

// Suffix maps mirrored from App.tsx (modeKey / granKey) so dynamic option keys resolve to concrete keys.
const MODE_SUFFIXES = ['auto', 'static', 'spine'];
const GRAN_SUFFIXES = ['folder', 'one', 'bundle'];
// Triage suffix maps mirrored from VerdictBar (CHIP_SEVERITIES → triage.filter.${sev}) and TriageLedger
// (SORT_KEYS → triage.sort.${k}, row.scope → triage.scope.${scope}) so each template t(`triage.x.${k}`)
// resolves to the concrete per-option keys (never leaks a `${...}` literal into the assertion).
const TRIAGE_FILTER_SUFFIXES = ['crit', 'warn', 'info'];
const TRIAGE_SORT_SUFFIXES = ['severity', 'wastedDisk', 'vram', 'occupancy'];
const TRIAGE_SCOPE_SUFFIXES = ['asset', 'folder'];

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
      'triage.noMatch',
      'triage.cleanAsset',
    ]) {
      expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
    }
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
});
