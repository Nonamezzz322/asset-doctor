// PURE, Node-testable registry for the film-card readings disclosure. apps/web has NO React test
// harness, so which explainer rows exist, in what order, under which gates — the load-bearing
// invariant-5 delivery logic — lives here (precedent: film-legend.ts, totals-rows.ts). The
// FilmViewer JSX is a thin renderer over this.
//
// HONESTY: bodyKey values are the three EXISTING vetted invariant-5 strings (never re-worded here);
// termKey values are the EXISTING on-card cell labels, so the panel's terms can never drift from
// what the cells print. Nothing in this module states a saving.

export interface ExplainerRow {
  /** Stable row id (React key + future extension point). */
  key: 'measured' | 'mipCeiling' | 'delta';
  /** i18n key of the on-card term — IDENTICAL key the ReadCell label uses. */
  termKey: string;
  /** i18n key of the explainer body — the existing tooltip string. */
  bodyKey: string;
}

/** Gates mirror the card's own render gates 1:1 (FilmViewer: `probe` strips, `showMip` row). */
export interface ExplainerFlags {
  probe: boolean;
  mip: boolean;
}

/** Canonical fixed order = the visual order of the readings on the card (measured strip →
 *  breakdown mip row → breakdown delta row). We filter THIS literal array — never build from a
 *  Set/object iteration — so output order is deterministic. Future OCC/FRAG rows (killed
 *  candidate 11) are added HERE with their own gate flag; the panel, trigger and tests pick them
 *  up with zero structural rework. */
const REGISTRY: { row: ExplainerRow; when: (f: ExplainerFlags) => boolean }[] = [
  { row: { key: 'measured', termKey: 'readout.measured', bodyKey: 'readout.measuredTooltip' }, when: (f) => f.probe },
  {
    row: { key: 'mipCeiling', termKey: 'readout.mipCeiling', bodyKey: 'readout.mipCeilingTooltip' },
    when: (f) => f.mip,
  },
  {
    row: { key: 'delta', termKey: 'readout.declaredVsMeasured', bodyKey: 'readout.deltaTooltip' },
    when: (f) => f.probe,
  },
];

/** Rows for the current card state. `[]` ⇒ the trigger itself must not render (diff-view films,
 *  metrics-less cards) — the card stays byte-identical to today there. */
export function explainerRows(flags: ExplainerFlags): ExplainerRow[] {
  return REGISTRY.filter((e) => e.when(flags)).map((e) => e.row);
}
