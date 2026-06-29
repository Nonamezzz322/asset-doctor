// Bitmap-font (BMFont .fnt) glyph-page readout. A parsed `.fnt` page is structurally an Atlas, so it
// already trips the generic per-atlas findings (occupancy / oversize / wasted-regions). THIS rule adds a
// font-specific informational readout BESIDE them: the glyph-page occupancy + glyph count + font metadata
// (face name, kerning-present). MEASURE only (invariant 3) — nothing is generated. The estimate carries
// ONLY occupancyPct: the generic occupancy/oversize findings own the VRAM (w·h·4) on the SAME page, so
// this rule NEVER double-counts and fabricates NO disk/VRAM-saved (invariant 5).

import type { Atlas, Finding, Severity, ThresholdConfig } from '@asset-doctor/core';
import { fmtBytes, occupancyValue, vramBytes } from './rules';

const pct1 = (frac: number): number => Math.round(frac * 1000) / 10;

/** Per-bmfont-page glyph-sheet readout. Fires ONLY for `source.kind === 'bmfont'` (positive guard) with a
 *  `fontGlyphPage` config present and ≥ `minChars` glyphs. `font.faceName`/`font.kerningCount` are read off
 *  the parsed FntPage by the host (worker). Pure over (atlas, cfg, font); null below the gate / no config /
 *  non-bmfont. The baked EN strings MUST equal the en catalog templates byte-for-byte (the render drift
 *  guard). */
export function fontGlyphPageFinding(
  atlas: Atlas,
  cfg: ThresholdConfig,
  font: { faceName?: string; kerningCount: number },
): Finding | null {
  if (!cfg.fontGlyphPage || atlas.source.kind !== 'bmfont') return null;
  const glyphs = atlas.sprites.length;
  if (glyphs < cfg.fontGlyphPage.minChars) return null;
  const occ = occupancyValue(atlas);
  const severity: Severity = occ <= cfg.fontGlyphPage.occupancyWarn ? 'warn' : 'info';
  const face = font.faceName ?? '';
  const kerning = font.kerningCount;
  const vram = vramBytes(atlas.size);

  // kerning clause folds the no-kerning wording into the EN `other` plural (EN PluralRules has no `zero`
  // category — select(0) === 'other'), so kerning===0 reads "0 kerning pairs". The baked string mirrors the
  // EN-selected catalog form: `one` for kerning===1, `other` otherwise.
  const kerningWord = kerning === 1 ? 'kerning pair' : 'kerning pairs';

  return {
    id: `${atlas.name}:font-glyph-page`,
    rule: 'font-glyph-page',
    severity,
    scope: 'asset',
    assetRef: atlas.name,
    // The readout only fires at glyphs >= minChars (>= 16), so the glyph noun is always plural — the title's
    // plural form ('glyph'/'glyphs') is carried for catalog correctness, but `other` is what EN selects here.
    title: `${glyphs} glyph${glyphs === 1 ? '' : 's'} on a BMFont page — ${pct1(occ)}% packed`,
    // `{face}: ` prefix is baked unconditionally so it equals the catalog `detail` template byte-for-byte
    // (a real BMFont always carries a `face`; the en drift guard renders with one).
    detail:
      `${face}: ${glyphs} glyphs cover ${pct1(occ)}% of the ${atlas.size.w}×${atlas.size.h} ` +
      `glyph page (${fmtBytes(vram)} of VRAM, w×h×4), with ${kerning} ${kerningWord}. ` +
      `A sparse glyph sheet pins that VRAM for mostly-empty space.`,
    fix: 'Repack the glyphs tighter, drop unused characters, or generate a smaller page for the used charset.',
    messageKey: 'font-glyph-page',
    params: { face, glyphs, occ, kerning, w: atlas.size.w, h: atlas.size.h, vram },
    estimate: { occupancyPct: occ },
  };
}
