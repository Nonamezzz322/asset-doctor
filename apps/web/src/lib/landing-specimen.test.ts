// Pin the illustrative specimen geometry's invariants (apps/web has no React/CSS harness). The film is
// presentational, but these guarantees protect its honesty: overlays never claim the same pixels twice
// (pairwise disjoint), nothing draws outside the viewBox, and every overlay kind is a real palette key
// (imported ZONE_STYLE — the specimen can never drift from what the real FilmViewer paints). The data is
// plain/frozen ⇒ deterministic across renders.

import { describe, it, expect } from 'vitest';
import { ZONE_STYLE } from './film-legend-style';
import { SPECIMEN_FRAMES, SPECIMEN_ZONES, SPECIMEN_VIEWBOX, type SpecimenRect } from './landing-specimen';

const inside = (r: SpecimenRect): boolean =>
  r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= SPECIMEN_VIEWBOX.w && r.y + r.h <= SPECIMEN_VIEWBOX.h;

// AABB overlap with POSITIVE area (touching edges is not an overlap).
const overlap = (a: SpecimenRect, b: SpecimenRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('landing-specimen — geometry invariants', () => {
  it('every frame and zone lies fully inside the viewBox with positive size', () => {
    for (const f of SPECIMEN_FRAMES) expect(inside(f), JSON.stringify(f)).toBe(true);
    for (const z of SPECIMEN_ZONES) expect(inside(z), JSON.stringify(z)).toBe(true);
  });

  it('overlay zones are pairwise disjoint (no pixel claimed twice)', () => {
    for (let i = 0; i < SPECIMEN_ZONES.length; i++) {
      for (let j = i + 1; j < SPECIMEN_ZONES.length; j++) {
        expect(
          overlap(SPECIMEN_ZONES[i]!, SPECIMEN_ZONES[j]!),
          `zones ${i} and ${j} overlap`,
        ).toBe(false);
      }
    }
  });

  it('every zone kind is a real overlay-palette key (imported ZONE_STYLE — cannot drift)', () => {
    const kinds = Object.keys(ZONE_STYLE);
    for (const z of SPECIMEN_ZONES) expect(kinds).toContain(z.kind);
  });

  it('the specimen exercises all four overlay meanings', () => {
    expect(new Set(SPECIMEN_ZONES.map((z) => z.kind))).toEqual(new Set(Object.keys(ZONE_STYLE)));
  });

  it('data is plain JSON (deterministic — JSON round-trip is stable)', () => {
    const frames = JSON.parse(JSON.stringify(SPECIMEN_FRAMES));
    const zones = JSON.parse(JSON.stringify(SPECIMEN_ZONES));
    expect(frames).toEqual([...SPECIMEN_FRAMES]);
    expect(zones).toEqual([...SPECIMEN_ZONES]);
  });
});
