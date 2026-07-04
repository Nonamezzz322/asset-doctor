// PURE ledger-row metric badge (app-screen re-skin Phase 3). apps/web has no React harness (vitest
// env=node), so the badge decision — which labelled metric a row surfaces, and whether it is a recoverable
// SAVING or a neutral MEASUREMENT — lives here and is Node-tested; TriageLedger is a thin renderer. HONESTY
// (invariant 5): the label keeps disk vs VRAM explicit (DISK/VRAM/OCC), sparse values degrade to the
// absent-metric placeholder '—', and the `role` lets the renderer color ONLY wasted-disk as a green saving —
// VRAM/OCC are measurements, not savings, so they read neutral (never a fabricated "you save this" claim).

import type { LedgerRow, SortKey } from './triage';
import { fmtBytes } from './format';

/** 'saving' = a recoverable wasted-disk amount (green); 'measure' = a neutral measurement (VRAM/OCC, ink). */
export type BadgeRole = 'saving' | 'measure';

export interface MetricBadge {
  label: string;
  value: string;
  role: BadgeRole;
}

/** The row's scope/metric badge. Under an asset-axis sort surface that asset metric; otherwise prefer the
 *  row's measured wasted-disk. Sparse ⇒ '—'. null ⇒ no badge (e.g. a synthesized clean row). */
export function metricBadge(row: LedgerRow, sort: SortKey): MetricBadge | null {
  if (sort === 'vram') {
    return { label: 'VRAM', value: row.metric.vram === undefined ? '—' : fmtBytes(row.metric.vram), role: 'measure' };
  }
  if (sort === 'occupancy') {
    return {
      label: 'OCC',
      value: row.metric.occupancy === undefined ? '—' : `${Math.round(row.metric.occupancy * 100)}%`,
      role: 'measure',
    };
  }
  if (row.metric.wastedDisk !== undefined) {
    return { label: 'DISK', value: fmtBytes(row.metric.wastedDisk), role: 'saving' };
  }
  return null;
}
