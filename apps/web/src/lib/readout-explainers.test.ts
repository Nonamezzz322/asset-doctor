// Pure-unit lock for the FilmViewer readings disclosure. apps/web has NO React test harness
// (vitest env=node), so the load-bearing invariant-5 delivery logic — which explainer rows exist,
// in what order, under which gates — is extracted to readout-explainers.ts and asserted here. The
// JSX is a thin renderer over explainerRows(); same discipline as film-legend.test.ts.

import { describe, it, expect } from 'vitest';
import { CATALOGS } from '@asset-doctor/i18n';
import { explainerRows, type ExplainerRow } from './readout-explainers';

const ids = (rows: ExplainerRow[]): string[] => rows.map((r) => r.key);

describe('explainerRows — gating truth table (mirrors FilmViewer render gates 1:1)', () => {
  it('{probe:true, mip:true} ⇒ all three in visual order: measured, mipCeiling, delta', () => {
    expect(ids(explainerRows({ probe: true, mip: true }))).toEqual(['measured', 'mipCeiling', 'delta']);
  });

  it('{probe:true, mip:false} ⇒ [measured, delta] (breakdown mip row absent)', () => {
    expect(ids(explainerRows({ probe: true, mip: false }))).toEqual(['measured', 'delta']);
  });

  it('{probe:false, mip:true} ⇒ [mipCeiling] only (un-probed loose asset with a mip ceiling)', () => {
    expect(ids(explainerRows({ probe: false, mip: true }))).toEqual(['mipCeiling']);
  });

  it('{probe:false, mip:false} ⇒ [] ⇒ trigger must not render (diff-view / metrics-less card)', () => {
    expect(explainerRows({ probe: false, mip: false })).toEqual([]);
  });
});

describe('explainerRows — determinism', () => {
  it('repeated calls with the same flags deep-equal (fixed-order literal registry, no Set/object iteration)', () => {
    const a = explainerRows({ probe: true, mip: true });
    const b = explainerRows({ probe: true, mip: true });
    expect(a).toEqual(b);
    // Order is derived from the literal registry, not insertion into a map/Set — pin it explicitly.
    expect(ids(a)).toEqual(['measured', 'mipCeiling', 'delta']);
  });
});

describe('explainerRows — i18n drift guard (precedent film-legend.test.ts:127)', () => {
  it('every termKey + bodyKey of every registry row exists in CATALOGS.en', () => {
    const all = explainerRows({ probe: true, mip: true });
    // The registry is fully surfaced only in the all-flags state — assert we saw all three keys.
    expect(all).toHaveLength(3);
    for (const row of all) {
      expect(CATALOGS.en[row.termKey], `${row.termKey} must exist in en.json`).toBeDefined();
      expect(CATALOGS.en[row.bodyKey], `${row.bodyKey} must exist in en.json`).toBeDefined();
    }
  });

  it('the new trigger label key readout.explainTrigger exists in CATALOGS.en', () => {
    expect(CATALOGS.en['readout.explainTrigger'], 'readout.explainTrigger must exist in en.json').toBeDefined();
  });
});

describe('explainerRows — honesty pin (invariant 5: registry cannot be silently repointed at new copy)', () => {
  it('bodyKeys ARE exactly the three existing vetted readout.*Tooltip keys, in visual order', () => {
    const bodies = explainerRows({ probe: true, mip: true }).map((r) => r.bodyKey);
    expect(bodies).toEqual(['readout.measuredTooltip', 'readout.mipCeilingTooltip', 'readout.deltaTooltip']);
  });

  it('termKeys ARE exactly the existing on-card cell-label keys (panel can never drift from the cells)', () => {
    const terms = explainerRows({ probe: true, mip: true }).map((r) => r.termKey);
    expect(terms).toEqual(['readout.measured', 'readout.mipCeiling', 'readout.declaredVsMeasured']);
  });
});
