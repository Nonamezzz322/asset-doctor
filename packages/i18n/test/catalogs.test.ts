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
      // The aria-live diagnosis-ready plural — both forms carry {n}, no leftover braces (singular n=1, plural n=5).
      expect(translate(loc, 'a11y.diagnosisReady', { n: 1 })).not.toContain('{');
      expect(translate(loc, 'a11y.diagnosisReady', { n: 5 })).not.toContain('{');
      // Texture-bleeding plural — both forms carry {pairs}, no leftover braces in any locale.
      expect(translate(loc, 'find.bleeding.title', { pairs: 1 })).not.toContain('{');
      expect(translate(loc, 'find.bleeding.title', { pairs: 5 })).not.toContain('{');
      // Declared-vs-real dimension mismatch — the three direction messageKeys all carry {dw}{dh}{rw}{rh}
      // (the off-edge detail also {off}); every locale fills them with no leftover braces.
      const dmP = { dw: 1024, dh: 1024, rw: 512, rh: 512, off: 2, dir: 'shrunk' };
      expect(translate(loc, 'find.dimension-mismatch-shrunk-offedge.title', dmP)).not.toContain('{');
      expect(translate(loc, 'find.dimension-mismatch-shrunk-offedge.detail', dmP)).not.toContain('{');
      expect(translate(loc, 'find.dimension-mismatch-shrunk.detail', dmP)).not.toContain('{');
      expect(translate(loc, 'find.dimension-mismatch-grown.detail', dmP)).not.toContain('{');
      // round22 #2: the honest footprint preview — the alsoRuns plural (both forms carry {n}) + the two
      // measured-now :bytes templates render without leftover braces in every locale.
      expect(translate(loc, 'fix.plan.alsoRuns', { n: 1 })).not.toContain('{');
      expect(translate(loc, 'fix.plan.alsoRuns', { n: 3 })).not.toContain('{');
      expect(translate(loc, 'fix.plan.measuredNowDisk', { disk: 4096 })).not.toContain('{');
      expect(translate(loc, 'fix.plan.measuredNowVram', { vram: 16 * 1048576 })).not.toContain('{');
      // FilmViewer canvas accessible name — the {regions} plural (forms 0/1/3) carries {name}{w}{h}{regions}
      // (altNoDims drops {w}{h}); every locale fills them with no leftover braces. 0 → 'other' (Intl en).
      for (const regions of [0, 1, 3]) {
        const p = { name: 'hero.png', w: 512, h: 256, regions };
        expect(translate(loc, 'film.alt', p), `${loc} film.alt regions=${regions}`).not.toContain('{');
        expect(translate(loc, 'film.altNoDims', p), `${loc} film.altNoDims regions=${regions}`).not.toContain('{');
      }
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

  // round24: the OPT-IN libvips lanczos3 resample op keys render with their placeholders filled in every
  // locale — INCLUDING the SEPARATE new tier-only hint key (B2: a new key, NOT a retarget of whyNoKernel).
  it('every locale renders the resample backend keys (round24) without leftover braces', () => {
    for (const loc of LOCALES) {
      expect(translate(loc, 'fix.backend.resample')).not.toContain('{');
      expect(translate(loc, 'fix.backend.resampleHint')).not.toContain('{');
      expect(translate(loc, 'fix.backend.costResample')).not.toContain('{');
      expect(translate(loc, 'fix.backend.receiptResample', { produced: 3, uploaded: 4, host: 'api.test' })).not.toContain('{');
      // The measured HF-energy delta renders as a percentage (:pct), never a leftover brace.
      const q = translate(loc, 'fix.backend.receiptResampleQuality', { pct: 0.12 });
      expect(q).not.toContain('{');
      expect(q).toContain('12%');
      expect(translate(loc, 'fix.backend.resampleTierHint')).not.toContain('{');
    }
  });

  // B2 (load-bearing honesty): the existing `whyNoKernel` note MUST stay UNCHANGED — it still renders at the
  // non-tier downscale sites where resample is NOT routed, so retargeting it would lie there. This pins the en
  // copy so a future "retarget" can't slip through; the resample hint lives in the SEPARATE key asserted above.
  it('whyNoKernel is left untouched (a separate resample key carries the tier hint — B2)', () => {
    expect(translate('en', 'fix.skipped.whyNoKernel')).toBe(
      "Downscale kernel isn't configurable in-browser — the browser's high-quality resampler is used.",
    );
    // The resample tier hint is a DISTINCT key, never the same string as whyNoKernel.
    expect(translate('en', 'fix.backend.resampleTierHint')).not.toBe(translate('en', 'fix.skipped.whyNoKernel'));
  });
});
