// Single source of truth for the FilmViewer overlay colors. Lives here (not in FilmViewer.tsx or
// film-legend.ts) so BOTH the paint loop (FilmViewer.tsx) and the legend swatches (film-legend.ts)
// import the SAME object with no import cycle — the legend can never drift from what the canvas paints.
// §5 reading order: empty = red, transparent = yellow, bleeding = teal, duplicate-frame = teal,
// gutter = info-blue (5.31:1 on film #0C1116 — a distinct family from teal/red/yellow AND the severity
// token of the info-only finding), interior-hole = the warn-yellow family with a DISTINCT label (the
// bleeding/duplicate-frame shared-hue precedent; the two yellow kinds can never co-occur on one film —
// transparent is atlas-only trim margins, interior-hole is loose-only interior holes).
import type { OverlayZone } from '@asset-doctor/core';

export const ZONE_STYLE: Record<OverlayZone['kind'], { stroke: string; fill: string }> = {
  empty: { stroke: '#e5484d', fill: 'rgba(229,72,77,0.18)' },
  transparent: { stroke: '#d98a00', fill: 'rgba(217,138,0,0.14)' },
  bleeding: { stroke: '#0e8c8c', fill: 'rgba(14,140,140,0.14)' },
  'duplicate-frame': { stroke: '#0e8c8c', fill: 'rgba(14,140,140,0.18)' },
  gutter: { stroke: '#2b8fc9', fill: 'rgba(43,143,201,0.14)' },
  // dead-region shares the info-blue hue with gutter at a heavier fill (0.18) — the bleeding/duplicate-
  // frame shared-hue/distinct-label precedent; both CAN co-occur, the legend + loupe text disambiguate.
  'dead-region': { stroke: '#2b8fc9', fill: 'rgba(43,143,201,0.18)' },
  'interior-hole': { stroke: '#d98a00', fill: 'rgba(217,138,0,0.18)' },
};
