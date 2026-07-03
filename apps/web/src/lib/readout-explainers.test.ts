// Pure-unit lock for the FilmViewer readings disclosure. apps/web has NO React test harness
// (vitest env=node), so the load-bearing invariant-5 delivery logic — which explainer rows exist,
// in what order, under which gates — is extracted to readout-explainers.ts and asserted here. The
// JSX is a thin renderer over explainerRows(); same discipline as film-legend.test.ts.

import { describe, it, expect } from 'vitest';
import type { AssetMetrics } from '@asset-doctor/core';
import { CATALOGS } from '@asset-doctor/i18n';
import {
  explainerRows,
  baseReadingFlags,
  type ExplainerRow,
  type ExplainerTerm,
} from './readout-explainers';

const ids = (rows: ExplainerRow[]): string[] => rows.map((r) => r.key);
// The all-flags render — every registry row surfaces, in visual order.
const FULL = { probe: true, mip: true, vram: true, disk: true, occ: true, frag: true } as const;

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

describe('explainerRows — base-strip gating truth table (VRAM · DISK · OCC · FRAG, visual order)', () => {
  it('{vram, disk} only ⇒ [vram, disk] (plain loose asset: no probe, no mip, no occ/frag)', () => {
    expect(ids(explainerRows({ probe: false, mip: false, vram: true, disk: true }))).toEqual(['vram', 'disk']);
  });

  it('+occ ⇒ [vram, disk, occ]; +frag then adds frag (order preserved)', () => {
    expect(ids(explainerRows({ probe: false, mip: false, vram: true, disk: true, occ: true }))).toEqual([
      'vram',
      'disk',
      'occ',
    ]);
    expect(
      ids(explainerRows({ probe: false, mip: false, vram: true, disk: true, occ: true, frag: true })),
    ).toEqual(['vram', 'disk', 'occ', 'frag']);
  });

  it('full card ⇒ base strip THEN measured/breakdown, top-to-bottom in visual order', () => {
    expect(ids(explainerRows(FULL))).toEqual(['vram', 'disk', 'occ', 'frag', 'measured', 'mipCeiling', 'delta']);
  });

  it('base flags absent (the pre-existing {probe,mip} shape) ⇒ base rows excluded, byte-identical output', () => {
    // The four base flags are optional; leaving them undefined must reproduce today's probe/mip-only rows.
    expect(ids(explainerRows({ probe: true, mip: true }))).toEqual(['measured', 'mipCeiling', 'delta']);
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

describe('explainerRows — VRAM term flips declared↔literal with the probe (mirrors the on-card relabel)', () => {
  const vramTerm = (flags: Parameters<typeof explainerRows>[0]): ExplainerTerm | undefined =>
    explainerRows(flags).find((r) => r.key === 'vram')?.term;

  it('no probe ⇒ the vram term is the bare literal "VRAM" (matches ReadCell label FilmViewer:150)', () => {
    expect(vramTerm({ probe: false, mip: false, vram: true, disk: true })).toEqual({ literal: 'VRAM' });
  });

  it('probe ⇒ the vram term is the existing i18n key readout.declared (matches the relabelled cell)', () => {
    expect(vramTerm({ ...FULL })).toEqual({ i18nKey: 'readout.declared' });
  });
});

describe('explainerRows — i18n drift guard (precedent film-legend.test.ts:127)', () => {
  it('every term source + bodyKey of every registry row exists in CATALOGS.en', () => {
    const all = explainerRows(FULL);
    // The registry is fully surfaced only in the all-flags state — assert we saw all seven rows.
    expect(all).toHaveLength(7);
    for (const row of all) {
      expect(CATALOGS.en[row.bodyKey], `${row.bodyKey} must exist in en.json`).toBeDefined();
      // Literal terms (base-strip acronyms) are locale-independent passthroughs — not catalog keys.
      if ('i18nKey' in row.term) {
        expect(CATALOGS.en[row.term.i18nKey], `${row.term.i18nKey} must exist in en.json`).toBeDefined();
      }
    }
  });

  it('the trigger label key readout.explainTrigger exists in CATALOGS.en', () => {
    expect(CATALOGS.en['readout.explainTrigger'], 'readout.explainTrigger must exist in en.json').toBeDefined();
  });
});

describe('explainerRows — term-source invariant (the union is not a closed enum, so pin its shape)', () => {
  it('every row carries exactly one of { i18nKey } | { literal } (never both, never neither)', () => {
    for (const row of explainerRows(FULL)) {
      const hasKey = 'i18nKey' in row.term;
      const hasLiteral = 'literal' in row.term;
      expect(hasKey !== hasLiteral, `${row.key} term must be exactly one of i18nKey/literal`).toBe(true);
    }
  });
});

describe('explainerRows — honesty pin (invariant 5: registry cannot be silently repointed at new copy)', () => {
  it('base bodyKeys ARE exactly [landing.vram.body, readout.diskBody, readout.occBody, readout.fragBody]', () => {
    const base = explainerRows({ probe: false, mip: false, vram: true, disk: true, occ: true, frag: true });
    expect(base.map((r) => r.bodyKey)).toEqual([
      'landing.vram.body', // VRAM body REUSES the shipped landing string, verbatim (no new key)
      'readout.diskBody',
      'readout.occBody',
      'readout.fragBody',
    ]);
  });

  it('base terms ARE exactly the locale-independent acronym literals (no probe)', () => {
    const base = explainerRows({ probe: false, mip: false, vram: true, disk: true, occ: true, frag: true });
    expect(base.map((r) => r.term)).toEqual([
      { literal: 'VRAM' },
      { literal: 'DISK' },
      { literal: 'OCC' },
      { literal: 'FRAG' },
    ]);
  });

  it('probe/mip bodyKeys ARE exactly the three existing vetted readout.*Tooltip keys, in visual order', () => {
    const bodies = explainerRows({ probe: true, mip: true }).map((r) => r.bodyKey);
    expect(bodies).toEqual(['readout.measuredTooltip', 'readout.mipCeilingTooltip', 'readout.deltaTooltip']);
  });

  it('probe/mip terms ARE exactly the existing on-card cell-label keys (panel can never drift from the cells)', () => {
    const terms = explainerRows({ probe: true, mip: true }).map((r) => r.term);
    expect(terms).toEqual([
      { i18nKey: 'readout.measured' },
      { i18nKey: 'readout.mipCeiling' },
      { i18nKey: 'readout.declaredVsMeasured' },
    ]);
  });
});

describe('baseReadingFlags — locks the diff-view / metrics-less byte-identity claim', () => {
  const fullMetrics: AssetMetrics = {
    assetRef: 'atlas.png',
    diskBytes: 4096,
    vramBytes: 16 * 1048576,
    vramBytesMipmapped: Math.ceil(16 * 1048576 * (4 / 3)),
    occupancy: 0.72,
    fragmentation: 0.5,
  };

  it('metrics === undefined ⇒ all false (metrics-less card stays byte-identical: no trigger)', () => {
    expect(baseReadingFlags(undefined)).toEqual({ vram: false, disk: false, occ: false, frag: false });
  });

  it('diff-view partial { occupancy, vramBytes } (no diskBytes) ⇒ all false (THE diff-view lock)', () => {
    // App.tsx:1681 builds `{ occupancy, vramBytes } as AssetMetrics` — a synthetic partial missing the
    // REQUIRED diskBytes. This is the discriminator that keeps the paid repack trust-proof byte-identical.
    const partial = { occupancy: 0.3, vramBytes: 1000 } as AssetMetrics;
    expect(baseReadingFlags(partial)).toEqual({ vram: false, disk: false, occ: false, frag: false });
  });

  it('full metrics (all fields) ⇒ all true', () => {
    expect(baseReadingFlags(fullMetrics)).toEqual({ vram: true, disk: true, occ: true, frag: true });
  });

  it('real card without occupancy/fragmentation (loose sprite) ⇒ vram+disk only, occ/frag suppressed', () => {
    const loose: AssetMetrics = {
      assetRef: 'hero.png',
      diskBytes: 2048,
      vramBytes: 4 * 1048576,
      vramBytesMipmapped: Math.ceil(4 * 1048576 * (4 / 3)),
    };
    expect(baseReadingFlags(loose)).toEqual({ vram: true, disk: true, occ: false, frag: false });
  });

  it('real card with occupancy but no fragmentation ⇒ occ:true, frag:false (each gates on its own presence)', () => {
    const noFrag: AssetMetrics = { ...fullMetrics, fragmentation: undefined };
    expect(baseReadingFlags(noFrag)).toEqual({ vram: true, disk: true, occ: true, frag: false });
  });
});
