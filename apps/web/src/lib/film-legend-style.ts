// Single source of truth for the FilmViewer overlay colors. Lives here (not in FilmViewer.tsx or
// film-legend.ts) so BOTH the paint loop (FilmViewer.tsx) and the legend swatches (film-legend.ts)
// import the SAME object with no import cycle — the legend can never drift from what the canvas paints.
// §5 reading order: empty = red, transparent = yellow, bleeding = teal, duplicate-frame = teal.
import type { OverlayZone } from '@asset-doctor/core';

export const ZONE_STYLE: Record<OverlayZone['kind'], { stroke: string; fill: string }> = {
  empty: { stroke: '#e5484d', fill: 'rgba(229,72,77,0.18)' },
  transparent: { stroke: '#d98a00', fill: 'rgba(217,138,0,0.14)' },
  bleeding: { stroke: '#0e8c8c', fill: 'rgba(14,140,140,0.14)' },
  'duplicate-frame': { stroke: '#0e8c8c', fill: 'rgba(14,140,140,0.18)' },
};
