import { describe, expect, it } from 'vitest';
import { CATALOGS, LOCALES, translate, type CatalogEntry } from '../src/index';

const enKeys = Object.keys(CATALOGS.en).sort();

const tokens = (v: CatalogEntry | undefined): string[] => {
  const grab = (s: string): string[] => [...s.matchAll(/\{[^}]+\}/g)].map((m) => m[0]);
  if (v && typeof v === 'object') {
    const set = new Set<string>();
    for (const [k, s] of Object.entries(v)) if (k !== '$count') grab(String(s)).forEach((t) => set.add(t));
    return [...set].sort();
  }
  return [...new Set(grab(String(v ?? '')))].sort();
};

describe('catalog completeness (all 9 locales)', () => {
  for (const loc of LOCALES) {
    it(`${loc}: same keys as en, plural structure intact, placeholders preserved`, () => {
      const c = CATALOGS[loc];
      expect(Object.keys(c).sort()).toEqual(enKeys);
      for (const k of enKeys) {
        const ev = CATALOGS.en[k];
        const lv = c[k];
        if (ev && typeof ev === 'object') {
          expect(typeof lv === 'object' && typeof lv.other === 'string', `${loc} "${k}" must be a plural object with "other"`).toBe(true);
        }
        expect(tokens(lv), `${loc} "${k}" placeholders`).toEqual(tokens(ev));
      }
    });
  }

  it('every locale renders a plural + a hinted template without leftover braces', () => {
    for (const loc of LOCALES) {
      expect(translate(loc, 'folder.issues', { n: 5 })).not.toContain('{');
      expect(translate(loc, 'find.occupancy.title', { occ: 0.4, wasted: 0.6 })).toMatch(/40%/);
    }
  });

  it('every locale renders the receipt change-manifest keys without leftover braces', () => {
    for (const loc of LOCALES) {
      expect(translate(loc, 'fix.changes.title', { n: 2 })).not.toContain('{');
      expect(translate(loc, 'fix.skipped.title', { n: 2 })).not.toContain('{');
      expect(translate(loc, 'fix.op.merge')).not.toContain('{');
    }
  });
});
