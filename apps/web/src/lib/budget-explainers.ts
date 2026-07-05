// PURE, Node-testable registry for the budget-strip readings disclosure (UI/copy honesty round,
// items 2/3/6). apps/web has NO React test harness, so which explainer rows exist, in what order,
// under which gates — the load-bearing invariant-3/5 delivery logic — lives here (precedent:
// readout-explainers.ts). The BudgetStrip JSX is a thin renderer over budgetExplainerRows().
//
// HONESTY: bodyKey values are the vetted estimate-scope strings (the declared-VRAM model, the
// probe-aggregate scope, the draw-call floor, the de-overlapped disk-saving model); termKey values
// MIRROR the on-card labels so the panel's terms can never drift from the cards. This disclosure is
// the KEYBOARD-REACHABLE delivery of scope strings that otherwise ship only as title= (mouse-only);
// nothing in this module states a saving as measured.

import type { BudgetModel } from './results-summary';
import type { Budgets } from './budget-prefs';

export interface BudgetExplainerRow {
  /** Stable row id (React key + extension point). */
  key: 'vramDeclared' | 'vramMeasured' | 'drawEstimated' | 'diskRecoverable' | 'budgetVram' | 'budgetDraw' | 'budgetDisk';
  /** i18n key of the on-card term the row explains (card label / subline label). */
  termKey: string;
  /** i18n key of the explainer body — an estimate-scope/model string. */
  bodyKey: string;
  /** Interpolation params for bodyKey (real report values only — nothing fabricated). */
  params?: Record<string, number>;
}

/** Rows for the current budget model. Fixed literal order = the strip's card order L→R (VRAM
 *  declared → VRAM measured subline → draw-call floor → disk recoverable); gates MIRROR the strip's
 *  own render gates 1:1 (measured subline probe-gated, estimated floor shown iff no probe draws,
 *  disk row iff a recoverable saving renders). Deterministic: filtered from a literal array. */
const REGISTRY: {
  when: (bm: BudgetModel) => boolean;
  row: (bm: BudgetModel) => BudgetExplainerRow;
}[] = [
  {
    // The declared big number is ALWAYS on the card ⇒ its model row is always taught.
    when: () => true,
    row: () => ({ key: 'vramDeclared', termKey: 'budget.vram.label', bodyKey: 'budget.vram.declaredTooltip' }),
  },
  {
    // Measured subline (probe ran): re-delivers the title=-only aggregate-scope string accessibly.
    when: (bm) => bm.vram.measured != null,
    row: (bm) => ({
      key: 'vramMeasured',
      termKey: 'metric.vramMeasured',
      bodyKey: 'readout.measuredAggregateTooltip',
      params: { n: bm.vram.measured!.atlasesProbed, declared: bm.vram.measured!.declared },
    }),
  },
  {
    // No measured draws ⇒ the card shows the STATIC floor labelled "estimated" — teach its model.
    when: (bm) => bm.draw.calls == null,
    row: (bm) => ({
      key: 'drawEstimated',
      termKey: 'budget.draw.estimated',
      bodyKey: 'budget.draw.estimatedTooltip',
      params: { n: bm.draw.estimated },
    }),
  },
  {
    // Disk row renders the recoverable saving ⇒ teach the de-overlap model behind it.
    when: (bm) => bm.disk.saved > 0,
    row: () => ({ key: 'diskRecoverable', termKey: 'budget.disk.label', bodyKey: 'budget.disk.savedTooltip' }),
  },
];

// User-set BUDGET semantics rows (user-settable budgets round): APPENDED after the existing 4-row estimate
// registry, in card order (vram → draw → disk), ONE per metric the user gave a budget for. This makes the new
// comparison semantics — ESPECIALLY the draw-call floor asymmetry — keyboard/SR-reachable through the same
// estimates-disclosure that already delivers the estimate-scope strings (mirrors HEAD's pattern; the bodyKeys
// resolve via t(r.bodyKey), a VARIABLE invisible to the static scanner, so they are pinned by the drift-guard
// test). termKeys REUSE the existing on-card labels (all present in en.json) so the panel can never drift from
// the cards; only the 3 bodyKeys are new. Default budgets={} ⇒ nothing appended ⇒ byte-identical to today.
const BUDGET_ROWS: { field: keyof Budgets; row: BudgetExplainerRow }[] = [
  { field: 'vramBytes', row: { key: 'budgetVram', termKey: 'budget.vram.label', bodyKey: 'budget.explain.vram' } },
  { field: 'drawCalls', row: { key: 'budgetDraw', termKey: 'budget.draw.label', bodyKey: 'budget.explain.draw' } },
  { field: 'diskBytes', row: { key: 'budgetDisk', termKey: 'budget.disk.label', bodyKey: 'budget.explain.disk' } },
];

export function budgetExplainerRows(bm: BudgetModel, budgets: Budgets = {}): BudgetExplainerRow[] {
  const rows = REGISTRY.filter((e) => e.when(bm)).map((e) => e.row(bm));
  for (const { field, row } of BUDGET_ROWS) if (budgets[field] !== undefined) rows.push(row);
  return rows;
}
