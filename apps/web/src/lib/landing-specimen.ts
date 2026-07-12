// STATIC illustrative specimen geometry for the landing's SpecimenFilm (invariant 3: ZERO fabricated
// measurements — this is GEOMETRY only; every metric cell in the film renders '—', the real FilmViewer's
// absent-metric convention). Node tests pin the contract: zones are pairwise disjoint, every rect lies
// inside the viewBox, and every kind ∈ keys of ZONE_STYLE (the imported overlay palette, so the specimen
// can never drift from what the real canvas paints). Plain frozen data ⇒ deterministic across renders.
import type { OverlayZone } from '@asset-doctor/core';

export const SPECIMEN_VIEWBOX = { w: 320, h: 320 } as const;

export interface SpecimenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface SpecimenZone extends SpecimenRect {
  kind: OverlayZone['kind'];
}

/** Faint "sprite frames" — outlined rects suggesting packed art. May overlap each other / the zones
 *  (they are the underlying grid the overlays annotate); only zones carry the disjointness contract. */
export const SPECIMEN_FRAMES: ReadonlyArray<SpecimenRect> = [
  { x: 12, y: 12, w: 60, h: 60 },
  { x: 84, y: 12, w: 60, h: 44 },
  { x: 156, y: 12, w: 80, h: 60 },
  { x: 248, y: 12, w: 60, h: 60 },
  { x: 12, y: 84, w: 44, h: 44 },
  { x: 68, y: 84, w: 80, h: 52 },
  { x: 12, y: 140, w: 120, h: 70 },
  { x: 156, y: 96, w: 90, h: 60 },
];

/** Overlay zones — one of each decoded meaning (empty = red+dashed, transparent margin = yellow,
 *  bleeding = teal, duplicate-frame = teal two matching rects, gutter = info-blue inter-frame strip,
 *  interior-hole = warn-yellow hole INSIDE a frame). Pairwise DISJOINT (mirrors the real
 *  non-double-counting: no byte is claimed by two overlays). */
export const SPECIMEN_ZONES: ReadonlyArray<SpecimenZone> = [
  { kind: 'empty', x: 200, y: 180, w: 108, h: 124 },
  { kind: 'transparent', x: 84, y: 64, w: 60, h: 10 },
  { kind: 'bleeding', x: 150, y: 90, w: 4, h: 60 },
  { kind: 'duplicate-frame', x: 24, y: 232, w: 48, h: 48 },
  { kind: 'duplicate-frame', x: 88, y: 232, w: 48, h: 48 },
  { kind: 'gutter', x: 240, y: 12, w: 8, h: 60 },
  { kind: 'interior-hole', x: 32, y: 156, w: 36, h: 30 },
];
