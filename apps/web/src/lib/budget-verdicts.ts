// PURE over-budget comparator for the results strip (user-settable budgets round). apps/web has NO React
// harness (vitest env=node), so ALL the honesty-critical decision logic — which cards get a bar, the 6 verdict
// states, the DRAW-CALL FLOOR ASYMMETRY, the tone/fill mapping, and the clamped bar geometry — lives here and is
// exhaustively Node-unit-tested (precedent: results-summary.ts / budget-explainers.ts). BudgetStrip is a thin
// renderer over budgetVerdicts(); each state maps in JSX to exactly ONE literal t('budget.state.X') key.
//
// HONESTY (the reason this round exists):
//  • Default: budgetVerdicts(bm, {}) ⇒ [] ⇒ ZERO visual change (pinned). A card appears ONLY for a metric the
//    user gave a number — never a suggested/baked default budget (that would be us fabricating a threshold).
//  • Like-for-like, labelled: the VRAM budget's BAR tracks the card's big number, the DECLARED w×h×4 estimate
//    (bm.vram.loaded). When the probe ran, the MEASURED footprint is a SEPARATE secondary verdict (a text line,
//    no bar) — declared and measured are NEVER blended into one verdict.
//  • FLOOR ASYMMETRY (invariant 3): without a probe the draw number is a LOWER BOUND. floor > budget ⇒ genuinely
//    over (floorOver, crit — the lower bound alone already exceeds). floor ≤ budget ⇒ UNKNOWN (floorUnknown,
//    NEUTRAL — the real draws can be higher), NEVER a green "within budget" pass. Measured draws compare normally.
//  • Every value is read VERBATIM from the already-honest BudgetModel — nothing is recomputed from the report.

import type { BudgetModel } from './results-summary';
import type { Budgets } from './budget-prefs';

export type BudgetMetric = 'vram' | 'draw' | 'disk';
/** Which quantity the verdict compared the budget against — surfaced in the copy so declared/measured/floor can
 *  never be silently confused. */
export type BudgetBasis = 'declared' | 'measured' | 'floor';
/** The 6 explicit states. Folding the measurement basis INTO the state name (over vs overDeclared; floorOver /
 *  floorUnknown) lets the JSX map each state to exactly ONE literal t('budget.state.X') key, so the static i18n
 *  scanner covers all copy for free — no dynamic-key branch. */
export type BudgetState = 'over' | 'overDeclared' | 'floorOver' | 'floorUnknown' | 'within' | 'withinDeclared';

export interface BudgetVerdict {
  metric: BudgetMetric;
  basis: BudgetBasis;
  state: BudgetState;
  /** The user's stored budget (bytes for vram/disk, count for draw). */
  budget: number;
  /** The compared value, read VERBATIM from BudgetModel (never recomputed from the report). */
  value: number;
  /** value - budget. Only rendered for the over / floorOver states (negative otherwise, never shown). */
  overBy: number;
  /** value / budget, UNCLAMPED (magnitude lives in the text). budget is always > 0 (validated) — guard anyway. */
  ratio: number;
  /** Bar width %: Math.min(100, Math.round(ratio*100)). Magnitude lives in the text, never in the geometry. */
  clampPct: number;
  /** JSX: crit ⇒ text-crit-text (AA-safe readable error token), neutral ⇒ text-ink-soft. */
  textTone: 'crit' | 'neutral';
  /** JSX: crit ⇒ bg-crit, ok ⇒ bg-cta, neutral ⇒ bg-film-mute. floorUnknown is NEUTRAL, NEVER ok (no green). */
  barFill: 'crit' | 'ok' | 'neutral';
}

export interface CardBudget {
  metric: BudgetMetric;
  /** Gets the bar + the verdict line. */
  primary: BudgetVerdict;
  /** VRAM measured only — rendered as a text line (NO bar); absent unless the probe ran. */
  secondary?: BudgetVerdict;
}

/** Boundary rule (mirrors the CLI "Fail if value > max"): value == budget ⇒ NOT over (strict >). */
function makeVerdict(
  metric: BudgetMetric,
  basis: BudgetBasis,
  state: BudgetState,
  budget: number,
  value: number,
  textTone: 'crit' | 'neutral',
  barFill: 'crit' | 'ok' | 'neutral',
): BudgetVerdict {
  const overBy = value - budget;
  const ratio = budget > 0 ? value / budget : 0;
  const clampPct = Math.min(100, Math.round(ratio * 100));
  return { metric, basis, state, budget, value, overBy, ratio, clampPct, textTone, barFill };
}

/** A normal (measured/declared) over-or-within verdict: strict `>` is over ⇒ crit/crit, else within ⇒ neutral/ok. */
function overWithin(metric: BudgetMetric, basis: BudgetBasis, budget: number, value: number, overState: BudgetState, withinState: BudgetState): BudgetVerdict {
  return value > budget
    ? makeVerdict(metric, basis, overState, budget, value, 'crit', 'crit')
    : makeVerdict(metric, basis, withinState, budget, value, 'neutral', 'ok');
}

/** Per-card over-budget verdicts, read straight from an already-honest BudgetModel. Deterministic literal order
 *  vram → draw → disk; a card appears ONLY for a set budget; {} ⇒ []. Findings is NEVER budgeted (a count of
 *  findings is not a budget metric). */
export function budgetVerdicts(bm: BudgetModel, b: Budgets): CardBudget[] {
  const cards: CardBudget[] = [];

  // VRAM — primary is the DECLARED w×h×4 estimate (the card's big number, the like-for-like). The measured
  // footprint, when the probe ran, is a SEPARATE secondary verdict (its own text line, no bar) — never blended.
  if (b.vramBytes !== undefined) {
    const primary = overWithin('vram', 'declared', b.vramBytes, bm.vram.loaded, 'overDeclared', 'withinDeclared');
    const secondary = bm.vram.measured != null ? overWithin('vram', 'measured', b.vramBytes, bm.vram.measured.vram, 'over', 'within') : undefined;
    cards.push(secondary ? { metric: 'vram', primary, secondary } : { metric: 'vram', primary });
  }

  // DRAW — measured draws (probe ran) compare normally; otherwise the FLOOR ASYMMETRY: floor > budget ⇒ floorOver
  // (crit), floor ≤ budget ⇒ floorUnknown (NEUTRAL text + NEUTRAL bar, never green/ok, never a pass).
  if (b.drawCalls !== undefined) {
    let primary: BudgetVerdict;
    if (bm.draw.calls != null) {
      primary = overWithin('draw', 'measured', b.drawCalls, bm.draw.calls, 'over', 'within');
    } else {
      primary =
        bm.draw.estimated > b.drawCalls
          ? makeVerdict('draw', 'floor', 'floorOver', b.drawCalls, bm.draw.estimated, 'crit', 'crit')
          : makeVerdict('draw', 'floor', 'floorUnknown', b.drawCalls, bm.draw.estimated, 'neutral', 'neutral');
    }
    cards.push({ metric: 'draw', primary });
  }

  // DISK — compared vs the MEASURED total on disk (bm.disk.total), NEVER bm.disk.after (an estimate). Normal.
  if (b.diskBytes !== undefined) {
    const primary = overWithin('disk', 'measured', b.diskBytes, bm.disk.total, 'over', 'within');
    cards.push({ metric: 'disk', primary });
  }

  return cards;
}
