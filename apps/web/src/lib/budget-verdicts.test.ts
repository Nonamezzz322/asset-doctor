// PURE exhaustive tests for the over-budget comparator (budget-verdicts.ts). apps/web has NO React harness
// (vitest env=node), so the honesty-critical decision logic — the 6 verdict states, the DRAW-CALL FLOOR
// ASYMMETRY, the strict `>` boundary, the tone/fill mapping, the clamped bar geometry, the deterministic order,
// and the byte-identical default ({} ⇒ []) — is asserted here over the pure comparator.

import { describe, expect, it } from 'vitest';
import { budgetVerdicts, type CardBudget } from './budget-verdicts';
import type { BudgetModel } from './results-summary';

/** Baseline model: no probe. Override any slice. */
const base = (over: Partial<BudgetModel> = {}): BudgetModel => ({
  vram: { loaded: 100, measured: null },
  draw: { calls: null, atlasesProbed: null, estimated: 10 },
  disk: { total: 1000, saved: 0, after: 1000, savedPct: 0 },
  findings: { problems: 0, crit: 0, warn: 0, info: 0, segments: [] },
  ...over,
});

const probed = (over: Partial<BudgetModel> = {}): BudgetModel =>
  base({
    vram: { loaded: 100, measured: { vram: 90, declared: 88, atlasesProbed: 3 } },
    draw: { calls: 12, atlasesProbed: 3, estimated: 10 },
    ...over,
  });

const metric = (cards: CardBudget[], m: 'vram' | 'draw' | 'disk'): CardBudget | undefined => cards.find((c) => c.metric === m);

describe('budgetVerdicts — default byte-identical (the honesty guarantee)', () => {
  it('no budgets ⇒ [] (proves the strip is byte-identical for an untouched user)', () => {
    expect(budgetVerdicts(base(), {})).toEqual([]);
    expect(budgetVerdicts(probed(), {})).toEqual([]);
  });
  it('findings is NEVER budgeted (no findings field exists on Budgets — nothing to assert but the shape)', () => {
    // A budget only ever produces vram/draw/disk cards; there is no findings card by construction.
    const cards = budgetVerdicts(base(), { vramBytes: 1, drawCalls: 1, diskBytes: 1 });
    expect(cards.map((c) => c.metric)).toEqual(['vram', 'draw', 'disk']);
  });
});

describe('budgetVerdicts — a card appears ONLY for a set budget', () => {
  it('each field set individually ⇒ exactly its card', () => {
    expect(budgetVerdicts(base(), { vramBytes: 50 }).map((c) => c.metric)).toEqual(['vram']);
    expect(budgetVerdicts(base(), { drawCalls: 5 }).map((c) => c.metric)).toEqual(['draw']);
    expect(budgetVerdicts(base(), { diskBytes: 500 }).map((c) => c.metric)).toEqual(['disk']);
  });
});

describe('budgetVerdicts — VRAM (declared primary + measured secondary, never blended)', () => {
  it('no probe ⇒ primary declared only, no secondary', () => {
    const card = metric(budgetVerdicts(base(), { vramBytes: 200 }), 'vram')!;
    expect(card.primary.basis).toBe('declared');
    expect(card.primary.value).toBe(100); // read verbatim from bm.vram.loaded
    expect(card.secondary).toBeUndefined();
  });
  it('probe ran ⇒ primary declared (bm.vram.loaded) + secondary measured (bm.vram.measured.vram)', () => {
    const card = metric(budgetVerdicts(probed(), { vramBytes: 95 }), 'vram')!;
    expect(card.primary.basis).toBe('declared');
    expect(card.primary.value).toBe(100); // declared 100 > 95 ⇒ overDeclared
    expect(card.primary.state).toBe('overDeclared');
    expect(card.secondary!.basis).toBe('measured');
    expect(card.secondary!.value).toBe(90); // measured 90 <= 95 ⇒ within
    expect(card.secondary!.state).toBe('within');
  });
  it('declared boundary: declared == budget ⇒ withinDeclared (strict >), declared == budget+1 ⇒ overDeclared', () => {
    expect(metric(budgetVerdicts(base({ vram: { loaded: 100, measured: null } }), { vramBytes: 100 }), 'vram')!.primary.state).toBe('withinDeclared');
    expect(metric(budgetVerdicts(base({ vram: { loaded: 101, measured: null } }), { vramBytes: 100 }), 'vram')!.primary.state).toBe('overDeclared');
  });
});

describe('budgetVerdicts — DRAW FLOOR ASYMMETRY (the reason the round exists)', () => {
  it('no probe, floor > budget ⇒ floorOver (crit)', () => {
    const v = metric(budgetVerdicts(base({ draw: { calls: null, atlasesProbed: null, estimated: 10 } }), { drawCalls: 8 }), 'draw')!.primary;
    expect(v.basis).toBe('floor');
    expect(v.state).toBe('floorOver');
    expect(v.textTone).toBe('crit');
    expect(v.barFill).toBe('crit');
    expect(v.overBy).toBe(2);
  });
  it('no probe, floor == budget ⇒ floorUnknown (NEVER within — floor is a lower bound)', () => {
    const v = metric(budgetVerdicts(base({ draw: { calls: null, atlasesProbed: null, estimated: 10 } }), { drawCalls: 10 }), 'draw')!.primary;
    expect(v.state).toBe('floorUnknown');
  });
  it('no probe, floor < budget ⇒ floorUnknown (NEUTRAL text + NEUTRAL bar, never green/ok, never a pass)', () => {
    const v = metric(budgetVerdicts(base({ draw: { calls: null, atlasesProbed: null, estimated: 3 } }), { drawCalls: 10 }), 'draw')!.primary;
    expect(v.state).toBe('floorUnknown');
    expect(v.textTone).toBe('neutral');
    expect(v.barFill).toBe('neutral'); // NOT 'ok' — a floor under budget is inconclusive, never a within/pass
  });
  it('the floor branch NEVER emits within/withinDeclared/ok for ANY budget', () => {
    for (const budget of [1, 3, 5, 10, 20]) {
      const v = metric(budgetVerdicts(base({ draw: { calls: null, atlasesProbed: null, estimated: 10 } }), { drawCalls: budget }), 'draw')!.primary;
      expect(['floorOver', 'floorUnknown']).toContain(v.state);
      expect(v.barFill).not.toBe('ok');
    }
  });
});

describe('budgetVerdicts — DRAW measured (probe ran) compares normally', () => {
  it('measured value == budget ⇒ within (overBy 0, clampPct 100)', () => {
    const v = metric(budgetVerdicts(probed({ draw: { calls: 12, atlasesProbed: 3, estimated: 10 } }), { drawCalls: 12 }), 'draw')!.primary;
    expect(v.basis).toBe('measured');
    expect(v.state).toBe('within');
    expect(v.overBy).toBe(0);
    expect(v.clampPct).toBe(100);
  });
  it('measured value == budget+1 ⇒ over', () => {
    const v = metric(budgetVerdicts(probed({ draw: { calls: 13, atlasesProbed: 3, estimated: 10 } }), { drawCalls: 12 }), 'draw')!.primary;
    expect(v.state).toBe('over');
    expect(v.overBy).toBe(1);
  });
});

describe('budgetVerdicts — DISK compares vs the measured total, boundary strict >', () => {
  it('total <= budget ⇒ within; total > budget ⇒ over; compared vs bm.disk.total not bm.disk.after', () => {
    const bm = base({ disk: { total: 1000, saved: 400, after: 600, savedPct: 40 } });
    expect(metric(budgetVerdicts(bm, { diskBytes: 1000 }), 'disk')!.primary.state).toBe('within'); // == boundary
    expect(metric(budgetVerdicts(bm, { diskBytes: 999 }), 'disk')!.primary.state).toBe('over');
    // value is the TOTAL (1000), never the after-fix estimate (600)
    expect(metric(budgetVerdicts(bm, { diskBytes: 999 }), 'disk')!.primary.value).toBe(1000);
  });
});

describe('budgetVerdicts — overBy / ratio / clampPct arithmetic (magnitude in text, bar clamped)', () => {
  it('value = 2·budget ⇒ ratio 2, clampPct capped at 100, over', () => {
    const v = metric(budgetVerdicts(base({ disk: { total: 200, saved: 0, after: 200, savedPct: 0 } }), { diskBytes: 100 }), 'disk')!.primary;
    expect(v.overBy).toBe(100);
    expect(v.ratio).toBe(2);
    expect(v.clampPct).toBe(100);
    expect(v.state).toBe('over');
  });
  it('value = budget/2 ⇒ ratio 0.5, clampPct 50, within', () => {
    const v = metric(budgetVerdicts(base({ disk: { total: 50, saved: 0, after: 50, savedPct: 0 } }), { diskBytes: 100 }), 'disk')!.primary;
    expect(v.ratio).toBe(0.5);
    expect(v.clampPct).toBe(50);
    expect(v.state).toBe('within');
  });
});

describe('budgetVerdicts — tone/fill mapping per state', () => {
  it('over* ⇒ crit/crit, within* ⇒ neutral/ok, floorUnknown ⇒ neutral/neutral', () => {
    // over (measured disk)
    const over = metric(budgetVerdicts(base({ disk: { total: 200, saved: 0, after: 200, savedPct: 0 } }), { diskBytes: 100 }), 'disk')!.primary;
    expect([over.textTone, over.barFill]).toEqual(['crit', 'crit']);
    // overDeclared (vram)
    const overDecl = metric(budgetVerdicts(base({ vram: { loaded: 200, measured: null } }), { vramBytes: 100 }), 'vram')!.primary;
    expect([overDecl.textTone, overDecl.barFill]).toEqual(['crit', 'crit']);
    // within (measured disk)
    const within = metric(budgetVerdicts(base({ disk: { total: 50, saved: 0, after: 50, savedPct: 0 } }), { diskBytes: 100 }), 'disk')!.primary;
    expect([within.textTone, within.barFill]).toEqual(['neutral', 'ok']);
    // withinDeclared (vram)
    const withinDecl = metric(budgetVerdicts(base({ vram: { loaded: 50, measured: null } }), { vramBytes: 100 }), 'vram')!.primary;
    expect([withinDecl.textTone, withinDecl.barFill]).toEqual(['neutral', 'ok']);
    // floorOver
    const floorOver = metric(budgetVerdicts(base({ draw: { calls: null, atlasesProbed: null, estimated: 20 } }), { drawCalls: 10 }), 'draw')!.primary;
    expect([floorOver.textTone, floorOver.barFill]).toEqual(['crit', 'crit']);
    // floorUnknown — the ONE state that is neutral/neutral (never ok, never a green pass)
    const floorUnknown = metric(budgetVerdicts(base({ draw: { calls: null, atlasesProbed: null, estimated: 3 } }), { drawCalls: 10 }), 'draw')!.primary;
    expect([floorUnknown.textTone, floorUnknown.barFill]).toEqual(['neutral', 'neutral']);
  });
});

describe('budgetVerdicts — determinism + order', () => {
  it('deterministic order vram, draw, disk when all set (+ probe adds vram secondary)', () => {
    const cards = budgetVerdicts(probed(), { diskBytes: 1, drawCalls: 1, vramBytes: 1 });
    expect(cards.map((c) => c.metric)).toEqual(['vram', 'draw', 'disk']);
    expect(cards[0]!.secondary).toBeDefined(); // probe ran ⇒ vram measured secondary present
  });
  it('repeated calls with the same inputs deep-equal', () => {
    const bm = probed();
    const b = { vramBytes: 95, drawCalls: 12, diskBytes: 900 };
    expect(budgetVerdicts(bm, b)).toEqual(budgetVerdicts(bm, b));
  });
});
