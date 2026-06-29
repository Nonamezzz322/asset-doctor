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
      expect(translate(loc, 'report.unparsed.title', { n: 3 })).not.toContain('{');
      expect(translate(loc, 'report.unparsed.title', { n: 1 })).not.toContain('{');
      expect(translate(loc, 'find.occupancy.title', { occ: 0.4, wasted: 0.6 })).toMatch(/40%/);
      // Render the measured-probe sprite-batch plural — both forms carry {n}, no leftover braces.
      expect(translate(loc, 'readout.batched', { n: 12 })).not.toContain('{');
      expect(translate(loc, 'readout.batched', { n: 1 })).not.toContain('{');
      // round22 #2: the honest footprint preview — the alsoRuns plural (both forms carry {n}) + the two
      // measured-now :bytes templates render without leftover braces in every locale.
      expect(translate(loc, 'fix.plan.alsoRuns', { n: 1 })).not.toContain('{');
      expect(translate(loc, 'fix.plan.alsoRuns', { n: 3 })).not.toContain('{');
      expect(translate(loc, 'fix.plan.measuredNowDisk', { disk: 4096 })).not.toContain('{');
      expect(translate(loc, 'fix.plan.measuredNowVram', { vram: 16 * 1048576 })).not.toContain('{');
    }
  });

  it('every locale renders the measured-fix correlate keys (round18) without leftover braces', () => {
    const draws = { drawCalls: 120, drawCallsAfter: 30 };
    const decoded = { decodedBefore: 40 * 1048576, decodedAfter: 25 * 1048576 };
    for (const loc of LOCALES) {
      expect(translate(loc, 'corr.batching.title_measured', draws)).not.toContain('{');
      expect(translate(loc, 'corr.batching.runtime_measured', draws)).not.toContain('{');
      expect(translate(loc, 'corr.vram.title_measured', decoded)).not.toContain('{');
      expect(translate(loc, 'corr.vram.runtime_measured', decoded)).not.toContain('{');
    }
  });

  it('every locale renders the receipt change-manifest keys without leftover braces', () => {
    for (const loc of LOCALES) {
      expect(translate(loc, 'fix.changes.title', { n: 2 })).not.toContain('{');
      expect(translate(loc, 'fix.skipped.title', { n: 2 })).not.toContain('{');
      expect(translate(loc, 'fix.op.merge')).not.toContain('{');
    }
  });

  it('every locale renders the loader-migration chrome keys without leftover braces', () => {
    for (const loc of LOCALES) {
      expect(translate(loc, 'fix.migrate.title')).not.toContain('{');
      expect(translate(loc, 'fix.migrate.note')).not.toContain('{');
      expect(translate(loc, 'fix.migrate.removed')).not.toContain('{');
      expect(translate(loc, 'fix.migrate.copy')).not.toContain('{');
    }
  });

  it('every locale renders the loader-migration chrome keys without leftover braces', () => {
    // Chrome only — the Pixi/Phaser engine labels + the load-call snippet bodies are generated as CODE
    // (loader-migration.ts), never translated, so they are deliberately NOT catalog keys here.
    for (const loc of LOCALES) {
      expect(translate(loc, 'fix.migrate.title')).not.toContain('{');
      expect(translate(loc, 'fix.migrate.note')).not.toContain('{');
      expect(translate(loc, 'fix.migrate.removed')).not.toContain('{');
      expect(translate(loc, 'fix.migrate.copy')).not.toContain('{');
    }
  });
});
