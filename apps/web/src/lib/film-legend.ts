// PURE, Node-testable helpers for the FilmViewer overlay legend + the canvas accessible name. apps/web has
// NO React test harness (vitest env=node, no jsdom/testing-library), so the load-bearing UX logic — which
// legend items exist, in what order, with what fill, and which aria-label params — is extracted here and
// fully unit-tested (same discipline as film-selection.ts). The FilmViewer JSX is a thin renderer over this.
//
// The overlay encodes problem meaning by color on the canvas; this legend decodes those colors into words so
// color is no longer the sole signal (a11y). Swatch fills are read from the SHARED ZONE_STYLE so they can
// NEVER drift from what the paint loop draws. Honesty: lists ONLY kinds genuinely present (non-empty rects);
// bleeding and duplicate-frame share the teal swatch but keep DISTINCT honest labels (they are different
// kinds); the alt-text reports MEASURED facts only (name + dims + region count) — no disk/VRAM/savings.

import type { Finding, OverlayZone } from '@asset-doctor/core';
import { ZONE_STYLE } from './film-legend-style';

/** Canonical, fixed reading order (matches §5 / ZONE_STYLE declaration order). We map over THIS array
 *  filtered by a presence Set — never iterate the Set — so the output order is deterministic. */
export const ZONE_KIND_ORDER: OverlayZone['kind'][] = ['empty', 'transparent', 'bleeding', 'duplicate-frame'];

const LABEL_KEY: Record<OverlayZone['kind'], string> = {
  empty: 'legend.empty',
  transparent: 'legend.transparent',
  bleeding: 'legend.bleeding',
  'duplicate-frame': 'legend.duplicateFrame',
};

/** The i18n label key for an overlay kind — the SAME key the legend swatch prints. Exported so the loupe's
 *  inspect readout (film-loupe.ts `formatInspect`) names an anomaly with the identical word the legend uses;
 *  the two can never drift. Thin, total wrapper over the private LABEL_KEY map. */
export function legendLabelKey(kind: OverlayZone['kind']): string {
  return LABEL_KEY[kind];
}

export interface LegendItem {
  kind: OverlayZone['kind'];
  labelKey: string;
  fill: string;
}

/** The DISTINCT overlay kinds genuinely present in `findings` (skip findings with no overlay; skip zones
 *  with empty rects), in the fixed canonical order, each with its i18n label key + fill read from the shared
 *  ZONE_STYLE. Returns [] when no overlay zones exist (before-diff film, format/dimension-only findings) so
 *  the JSX renders nothing — no stray empty strip. */
export function legendItemsFor(findings: Finding[]): LegendItem[] {
  const present = new Set<OverlayZone['kind']>();
  for (const f of findings) for (const z of f.overlay ?? []) if (z.rects.length > 0) present.add(z.kind);
  return ZONE_KIND_ORDER.filter((k) => present.has(k)).map((k) => ({ kind: k, labelKey: LABEL_KEY[k], fill: ZONE_STYLE[k].fill }));
}

/** Total count of highlighted regions = Σ over findings[].overlay[].rects.length. A measured fact. */
export function regionCount(findings: Finding[]): number {
  let n = 0;
  for (const f of findings) for (const z of f.overlay ?? []) n += z.rects.length;
  return n;
}

/** The canvas aria-label, from MEASURED facts only: atlas name, dims (omitted when null), and the measured
 *  count of highlighted regions. `t` is injected so this stays pure + Node-testable (no React useI18n). NO
 *  disk/VRAM/savings — those are a different quantity surfaced elsewhere on the card. */
export function filmAltText(
  t: (key: string, params?: Record<string, string | number>) => string,
  name: string,
  dims: { w: number; h: number } | null,
  findings: Finding[],
): string {
  const regions = regionCount(findings);
  return dims ? t('film.alt', { name, w: dims.w, h: dims.h, regions }) : t('film.altNoDims', { name, regions });
}
