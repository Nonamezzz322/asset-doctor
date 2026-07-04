// Pure-unit lock for the budget-strip readings disclosure (UI/copy honesty round, items 2/3/6).
// apps/web has NO React test harness (vitest env=node), so the load-bearing delivery logic — which
// explainer rows exist, in what order, under which gates — is asserted here over the pure registry.
// Same discipline as readout-explainers.test.ts.

import { describe, it, expect } from 'vitest';
import { CATALOGS } from '@asset-doctor/i18n';
import { budgetExplainerRows, type BudgetExplainerRow } from './budget-explainers';
import type { BudgetModel } from './results-summary';

const ids = (rows: BudgetExplainerRow[]): string[] => rows.map((r) => r.key);

/** Baseline model: no probe, no recoverable saving — only the declared-VRAM row + draw floor. */
const base = (over: Partial<BudgetModel> = {}): BudgetModel => ({
  vram: { loaded: 32 * 1048576, measured: null },
  draw: { calls: null, atlasesProbed: null, estimated: 7 },
  disk: { total: 1000, saved: 0, after: 1000, savedPct: 0 },
  findings: { problems: 0, crit: 0, warn: 0, info: 0, segments: [] },
  ...over,
});

const probed = (): BudgetModel =>
  base({
    vram: { loaded: 32 * 1048576, measured: { vram: 30 * 1048576, declared: 28 * 1048576, atlasesProbed: 3 } },
    draw: { calls: 12, atlasesProbed: 3, estimated: 7 },
  });

describe('budgetExplainerRows — gating truth table (mirrors the BudgetStrip render gates 1:1)', () => {
  it('no probe, no saving ⇒ [vramDeclared, drawEstimated] (declared model always taught; floor shown)', () => {
    expect(ids(budgetExplainerRows(base()))).toEqual(['vramDeclared', 'drawEstimated']);
  });

  it('probe ran ⇒ measured row appears, estimated-floor row disappears (card shows measured draws)', () => {
    expect(ids(budgetExplainerRows(probed()))).toEqual(['vramDeclared', 'vramMeasured']);
  });

  it('recoverable saving ⇒ disk row appended last (card order L→R preserved)', () => {
    const bm = base({ disk: { total: 1000, saved: 300, after: 700, savedPct: 30 } });
    expect(ids(budgetExplainerRows(bm))).toEqual(['vramDeclared', 'drawEstimated', 'diskRecoverable']);
  });

  it('all-flags model ⇒ all four rows in visual order', () => {
    const bm: BudgetModel = {
      ...probed(),
      draw: { calls: null, atlasesProbed: null, estimated: 7 }, // probe VRAM but no measured draws
      disk: { total: 1000, saved: 300, after: 700, savedPct: 30 },
    };
    expect(ids(budgetExplainerRows(bm))).toEqual(['vramDeclared', 'vramMeasured', 'drawEstimated', 'diskRecoverable']);
  });
});

describe('budgetExplainerRows — params carry REAL report values only', () => {
  it('vramMeasured row carries the probed-atlas count + like-for-like declared basis', () => {
    const row = budgetExplainerRows(probed()).find((r) => r.key === 'vramMeasured')!;
    expect(row.params).toEqual({ n: 3, declared: 28 * 1048576 });
  });

  it('drawEstimated row carries the static floor (distinct loaded textures)', () => {
    const row = budgetExplainerRows(base()).find((r) => r.key === 'drawEstimated')!;
    expect(row.params).toEqual({ n: 7 });
  });
});

describe('budgetExplainerRows — determinism', () => {
  it('repeated calls with the same model deep-equal (literal registry, no Set/object iteration)', () => {
    const bm = base({ disk: { total: 1000, saved: 300, after: 700, savedPct: 30 } });
    expect(budgetExplainerRows(bm)).toEqual(budgetExplainerRows(bm));
  });
});

describe('budgetExplainerRows — i18n drift guard (precedent readout-explainers.test.ts)', () => {
  it('every termKey + bodyKey of every registry row exists in CATALOGS.en', () => {
    const all = budgetExplainerRows({
      ...probed(),
      draw: { calls: null, atlasesProbed: null, estimated: 7 },
      disk: { total: 1000, saved: 300, after: 700, savedPct: 30 },
    });
    expect(all).toHaveLength(4); // the registry is fully surfaced in this state
    for (const row of all) {
      expect(CATALOGS.en[row.termKey], `${row.termKey} must exist in en.json`).toBeDefined();
      expect(CATALOGS.en[row.bodyKey], `${row.bodyKey} must exist in en.json`).toBeDefined();
    }
  });
});

describe('budgetExplainerRows — honesty pin (registry cannot be silently repointed at new copy)', () => {
  it('bodyKeys ARE exactly the four vetted estimate-scope strings, in visual order', () => {
    const all = budgetExplainerRows({
      ...probed(),
      draw: { calls: null, atlasesProbed: null, estimated: 7 },
      disk: { total: 1000, saved: 300, after: 700, savedPct: 30 },
    });
    expect(all.map((r) => r.bodyKey)).toEqual([
      'budget.vram.declaredTooltip',
      'readout.measuredAggregateTooltip', // REUSED verbatim — the shipped probe-aggregate scope string
      'budget.draw.estimatedTooltip', // REUSED verbatim — the shipped draw-floor model string
      'budget.disk.savedTooltip',
    ]);
  });
});
