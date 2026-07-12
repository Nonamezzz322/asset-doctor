// Pure-unit lock for the FilmViewer overlay legend + canvas accessible name. apps/web has NO React test
// harness (vitest env=node), so the load-bearing UX logic is extracted to film-legend.ts and asserted here
// — same discipline as film-selection.test.ts. The JSX is a thin renderer over these pure functions.

import { describe, it, expect } from 'vitest';
import type { Finding, OverlayZone } from '@asset-doctor/core';
import { CATALOGS } from '@asset-doctor/i18n';
import { ZONE_STYLE } from './film-legend-style';
import { ZONE_KIND_ORDER, legendItemsFor, regionCount, filmAltText } from './film-legend';

const R = { x: 0, y: 0, w: 4, h: 4 };

// Minimal Finding factory: only the fields legendItemsFor / regionCount read (overlay) matter; the rest
// are filled with inert values to satisfy the type.
const finding = (overlay?: OverlayZone[]): Finding => ({
  id: 'f',
  rule: 'occupancy' as Finding['rule'],
  severity: 'warn',
  assetRef: 'a.png',
  title: 't',
  detail: 'd',
  ...(overlay ? { overlay } : {}),
});

describe('legendItemsFor — decode the x-ray colors into honest, deterministic items', () => {
  it('1. [] findings ⇒ [] (before-diff empty state)', () => {
    expect(legendItemsFor([])).toEqual([]);
  });

  it('2. findings with NO overlay ⇒ [] (format/dimension findings)', () => {
    expect(legendItemsFor([finding(), finding()])).toEqual([]);
  });

  it('3. overlay present but rects:[] ⇒ [] (empty zone ignored, defensive)', () => {
    expect(legendItemsFor([finding([{ kind: 'empty', rects: [] }])])).toEqual([]);
  });

  it('4. one empty zone ⇒ single empty item with fill from ZONE_STYLE', () => {
    expect(legendItemsFor([finding([{ kind: 'empty', rects: [R] }])])).toEqual([
      { kind: 'empty', labelKey: 'legend.empty', fill: ZONE_STYLE.empty.fill },
    ]);
  });

  it('5. ORDER: input transparent THEN empty ⇒ output [empty, transparent] (canonical order, not input order)', () => {
    const items = legendItemsFor([finding([{ kind: 'transparent', rects: [R] }, { kind: 'empty', rects: [R] }])]);
    expect(items.map((i) => i.kind)).toEqual(['empty', 'transparent']);
  });

  it('6. DISTINCT: two findings each with empty ⇒ ONE empty item (dedup)', () => {
    const items = legendItemsFor([finding([{ kind: 'empty', rects: [R] }]), finding([{ kind: 'empty', rects: [R] }])]);
    expect(items.map((i) => i.kind)).toEqual(['empty']);
  });

  it('7. all six kinds ⇒ 6 items in canonical order; bleeding & duplicate-frame are SEPARATE items sharing the teal fill', () => {
    // Deliberately updated (V1 round): 'gutter' + 'interior-hole' joined the overlay vocabulary.
    const items = legendItemsFor([
      finding([
        { kind: 'interior-hole', rects: [R] },
        { kind: 'gutter', rects: [R] },
        { kind: 'duplicate-frame', rects: [R] },
        { kind: 'bleeding', rects: [R] },
        { kind: 'transparent', rects: [R] },
        { kind: 'empty', rects: [R] },
      ]),
    ]);
    expect(items.map((i) => i.kind)).toEqual(ZONE_KIND_ORDER);
    expect(items.map((i) => i.labelKey)).toEqual(['legend.empty', 'legend.transparent', 'legend.bleeding', 'legend.duplicateFrame', 'legend.gutter', 'legend.interiorHole']);
    // bleeding and duplicate-frame are honestly DISTINCT items (distinct labels) — the legend never lumps
    // them. Both paint the SAME teal hue (rgb 14,140,140); they differ only in fill ALPHA in ZONE_STYLE
    // (0.14 vs 0.18), and each item's fill is read verbatim from ZONE_STYLE so the swatch matches paint.
    const bleeding = items.find((i) => i.kind === 'bleeding')!;
    const dup = items.find((i) => i.kind === 'duplicate-frame')!;
    expect(bleeding.labelKey).not.toBe(dup.labelKey);
    expect(bleeding.fill).toBe(ZONE_STYLE.bleeding.fill);
    expect(dup.fill).toBe(ZONE_STYLE['duplicate-frame'].fill);
    // same teal hue (the RGB triple before the alpha), the colorblind-relevant "they look teal" property.
    const hue = (s: string): string => s.replace(/rgba\((\d+,\d+,\d+),[^)]+\)/, '$1');
    expect(hue(bleeding.fill)).toBe(hue(dup.fill));
    expect(hue(bleeding.fill)).toBe('14,140,140');
  });

  it('8. fill provenance: every item.fill === ZONE_STYLE[kind].fill (single source of truth, zero drift)', () => {
    const items = legendItemsFor([
      finding([
        { kind: 'empty', rects: [R] },
        { kind: 'transparent', rects: [R] },
        { kind: 'bleeding', rects: [R] },
        { kind: 'duplicate-frame', rects: [R] },
      ]),
    ]);
    for (const i of items) expect(i.fill).toBe(ZONE_STYLE[i.kind].fill);
  });
});

describe('regionCount — measured sum of highlighted rects', () => {
  it('9. sums rects across zones/findings; 0 for []', () => {
    expect(regionCount([])).toBe(0);
    expect(regionCount([finding()])).toBe(0);
    expect(
      regionCount([
        finding([{ kind: 'empty', rects: [R, R] }, { kind: 'transparent', rects: [R] }]),
        finding([{ kind: 'bleeding', rects: [R] }]),
      ]),
    ).toBe(4);
  });
});

describe('filmAltText — measured facts only, correct branch + params', () => {
  const t = (k: string, p?: Record<string, string | number>): string => `${k}:${JSON.stringify(p ?? {})}`;

  it('10a. dims present ⇒ calls film.alt with {name,w,h,regions}', () => {
    const s = filmAltText(t, 'hero.png', { w: 512, h: 256 }, [finding([{ kind: 'empty', rects: [R, R] }])]);
    expect(s).toBe(`film.alt:${JSON.stringify({ name: 'hero.png', w: 512, h: 256, regions: 2 })}`);
  });

  it('10b. dims null ⇒ calls film.altNoDims with {name,regions}', () => {
    const s = filmAltText(t, 'hero.png', null, []);
    expect(s).toBe(`film.altNoDims:${JSON.stringify({ name: 'hero.png', regions: 0 })}`);
  });
});

// DRIFT GUARD (Round-style): FilmViewer calls t(item.labelKey) — a DYNAMIC key the static i18n-app-keys
// scan (regex only catches t('literal')) will NOT catch. So assert every LABEL_KEY value + film.alt /
// film.altNoDims / legend.heading exist in CATALOGS.en here. If a key is renamed/removed, this fails.
describe('i18n drift guard — dynamic legend label keys + alt/heading exist in en (static scan cannot catch t(item.labelKey))', () => {
  it('every legend.* label key the legend can emit exists in CATALOGS.en', () => {
    // Mirror LABEL_KEY (one per ZONE_KIND_ORDER kind) without exporting the private const.
    // Deliberately extended (V1 round): gutter + interiorHole joined the overlay vocabulary.
    const labelKeys = ['legend.empty', 'legend.transparent', 'legend.bleeding', 'legend.duplicateFrame', 'legend.gutter', 'legend.interiorHole'];
    expect(labelKeys.length).toBe(ZONE_KIND_ORDER.length);
    for (const k of labelKeys) expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
  });

  it('film.alt / film.altNoDims / legend.heading exist in CATALOGS.en', () => {
    for (const k of ['film.alt', 'film.altNoDims', 'legend.heading']) {
      expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
    }
  });
});
