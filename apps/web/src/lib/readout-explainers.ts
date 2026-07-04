// PURE, Node-testable registry for the film-card readings disclosure. apps/web has NO React test
// harness, so which explainer rows exist, in what order, under which gates — the load-bearing
// invariant-5 delivery logic — lives here (precedent: film-legend.ts, totals-rows.ts). The
// FilmViewer JSX is a thin renderer over this.
//
// HONESTY: bodyKey values are the EXISTING vetted invariant-5 strings (never re-worded here); term
// values MIRROR the on-card cell labels — either the EXISTING i18n key the ReadCell prints (vram is
// always 'readout.declared' — the value is the declared w×h×4 estimate, probe or not), or, for the
// base-strip acronyms (DISK/OCC/FRAG), the same locale-independent literal the cell prints.
// So the panel's terms can never drift from the cells. Nothing in this module states a saving.

import type { AssetMetrics } from '@asset-doctor/core'; // type-only; core is zero-dep / worker-safe

/** On-card term for a `<dt>`. `i18nKey` ⇒ render via t() (the cell prints t(key)); `literal` ⇒ render
 *  verbatim (a base cell prints a bare acronym). A discriminated union so the two cases can't be
 *  confused and the render site needs no non-null `!`. */
export type ExplainerTerm = { i18nKey: string } | { literal: string };

export interface ExplainerRow {
  /** Stable row id (React key + extension point). */
  key: 'vram' | 'disk' | 'occ' | 'frag' | 'measured' | 'mipCeiling' | 'delta';
  /** On-card term mirror — the i18n key the ReadCell label uses, or the literal acronym it prints. */
  term: ExplainerTerm;
  /** i18n key of the explainer body — an existing tooltip string or the reused landing definition. */
  bodyKey: string;
}

/** Gates mirror the card's own render gates 1:1. `probe`/`mip` = the measured strip + mip-ceiling row
 *  (FilmViewer `probe` strips, `showMip` row). The base-strip flags are ALWAYS on the card, but the
 *  disclosure teaches them only for a real, fully-measured card — see baseReadingFlags. They are
 *  OPTIONAL so `explainerRows({ probe, mip })` (the pre-existing shape) keeps compiling: absent ⇒
 *  falsy ⇒ today's probe/mip-only behavior, byte-identical. */
export interface ExplainerFlags {
  probe: boolean;
  mip: boolean;
  vram?: boolean;
  disk?: boolean;
  occ?: boolean;
  frag?: boolean;
}

/** Canonical fixed order = the visual order of the readings on the card: base strip (VRAM · DISK ·
 *  OCC · FRAG, the grid-cols-4 cells L→R) then the measured strip → breakdown mip row → breakdown
 *  delta row. We filter THIS literal array — never build from a Set/object iteration — so output
 *  order is deterministic. `row` stays a factory for uniformity; every row ignores `f` now that the
 *  vram term is unconditional (honesty round item 2: the cell is ALWAYS "vram (declared)"). */
const REGISTRY: { when: (f: ExplainerFlags) => boolean; row: (f: ExplainerFlags) => ExplainerRow }[] = [
  // BASE STRIP — terms MIRROR the cells; bodies are definitions (no fabricated per-asset number).
  {
    when: (f) => !!f.vram,
    row: () => ({
      key: 'vram',
      // Unconditional (matches the always-"vram (declared)" cell label in FilmViewer): the value is
      // the declared w×h×4 estimate with or without a probe, so the term never reads as measured.
      term: { i18nKey: 'readout.declared' },
      bodyKey: 'landing.vram.body', // reused verbatim (the canonical disk≠VRAM teaching string)
    }),
  },
  { when: (f) => !!f.disk, row: () => ({ key: 'disk', term: { literal: 'DISK' }, bodyKey: 'readout.diskBody' }) },
  { when: (f) => !!f.occ, row: () => ({ key: 'occ', term: { literal: 'OCC' }, bodyKey: 'readout.occBody' }) },
  { when: (f) => !!f.frag, row: () => ({ key: 'frag', term: { literal: 'FRAG' }, bodyKey: 'readout.fragBody' }) },
  // MEASURED strip + VRAM BREAKDOWN (probe / mip) — unchanged copy/keys, now term-union-shaped.
  {
    when: (f) => f.probe,
    row: () => ({ key: 'measured', term: { i18nKey: 'readout.measured' }, bodyKey: 'readout.measuredTooltip' }),
  },
  {
    when: (f) => f.mip,
    row: () => ({ key: 'mipCeiling', term: { i18nKey: 'readout.mipCeiling' }, bodyKey: 'readout.mipCeilingTooltip' }),
  },
  {
    when: (f) => f.probe,
    row: () => ({ key: 'delta', term: { i18nKey: 'readout.declaredVsMeasured' }, bodyKey: 'readout.deltaTooltip' }),
  },
];

/** Rows for the current card state. `[]` ⇒ the trigger itself must not render (diff-view films,
 *  metrics-less cards) — the card stays byte-identical to today there. */
export function explainerRows(flags: ExplainerFlags): ExplainerRow[] {
  return REGISTRY.filter((e) => e.when(flags)).map((e) => e.row(flags));
}

/** Base-strip flags the disclosure may teach for THIS card. A card is "fully measured" only when it
 *  carries a real on-disk size + declared VRAM — both REQUIRED on a real AssetMetrics but ABSENT on
 *  the synthetic diff-view partial (`{ occupancy, vramBytes } as AssetMetrics`, App.tsx:1681), which
 *  therefore yields all-false ⇒ its card stays byte-identical (shipped diff-view doctrine). occ/frag
 *  are optional even on a real card, so they additionally gate on their own presence — mirroring the
 *  cell's `— / value` render. */
export function baseReadingFlags(
  m: AssetMetrics | undefined,
): { vram: boolean; disk: boolean; occ: boolean; frag: boolean } {
  if (m === undefined || m.diskBytes === undefined || m.vramBytes === undefined) {
    return { vram: false, disk: false, occ: false, frag: false };
  }
  return {
    vram: true,
    disk: true,
    occ: m.occupancy !== undefined,
    frag: m.fragmentation !== undefined,
  };
}
