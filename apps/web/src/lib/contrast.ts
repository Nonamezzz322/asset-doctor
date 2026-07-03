// WCAG contrast proof for the secondary-text ("ink-soft") remap.
//
// Why this exists: readable secondary prose across the Pro/fix/receipt panels was rendered at
// `text-ink-soft/70` (≈2.84:1 over bg) and `text-ink-soft/80` (≈3.44:1 over bg) — BELOW the WCAG 2.1
// §1.4.3 AA minimum of 4.5:1 for normal-size text. Full-strength ink-soft passes on both surfaces
// (bg ≈5.10, panel ≈6.07), so the fix is a pure alpha-suffix drop — no new @theme token, no hex.
//
// This module lifts the load-bearing arithmetic out of un-testable JSX (precedent:
// film-legend-style.ts as token SoT, totals-rows.ts as pure builder) so a regression that
// re-introduces a faded readable class is caught by a deterministic unit test. All functions are
// pure, dependency-free, and O(1).

// Token hexes mirrored from index.css @theme — the single source of truth for the contrast proof.
// bg = --color-bg (index.css:5), panel = --color-panel (index.css:6), film = --color-film (index.css:15).
export const SURFACE = { bg: '#E7ECF1', panel: '#FFFFFF', film: '#0C1116' } as const;
// --color-ink-soft (index.css:9).
export const INK_SOFT = '#566472';
// --color-film-soft (index.css:19) — the secondary-text token for the dark x-ray (bg-film) surface.
export const FILM_SOFT = '#9FB0BD';
// --color-ink (index.css:8) — the AA-safe label token; and the four severity hues (index.css:22-25),
// mirrored as the SoT for the round5 severity-label decolorize proof.
export const INK = '#16202A';
export const SEVERITY_HEX = { crit: '#E5484D', warn: '#D98A00', ok: '#1F9D63', info: '#2B8FC9' } as const;

// The AA threshold for NORMAL-size text (not the 3:1 large-text exception). All flagged notes are
// text-[9px]/text-[10px] mono ⇒ well under 18.66px bold / 24px ⇒ 4.5:1 applies.
export const AA_NORMAL = 4.5;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '').trim();
  const n =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  };
}

function toHex(rgb: Rgb): string {
  const clamp = (v: number): string =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${clamp(rgb.r)}${clamp(rgb.g)}${clamp(rgb.b)}`;
}

// sRGB 8-bit channel → linear-light, per WCAG 2.1 §1.4.3 / sRGB EOTF.
function linearize(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Relative luminance (WCAG): 0.2126·R + 0.7152·G + 0.0722·B over linearized channels.
export function relLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

// WCAG contrast ratio: (Lmax + 0.05) / (Lmin + 0.05).
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relLuminance(fg);
  const l2 = relLuminance(bg);
  const lmax = Math.max(l1, l2);
  const lmin = Math.min(l1, l2);
  return (lmax + 0.05) / (lmin + 0.05);
}

// Straight-alpha composite of `fg` at opacity `a` over opaque `bg` → resulting opaque hex. This is
// what Tailwind's `/NN` opacity suffix effectively produces over a solid surface, so contrast of a
// faded class can be computed exactly.
export function compositeAlpha(fg: string, bg: string, a: number): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  return toHex({
    r: f.r * a + b.r * (1 - a),
    g: f.g * a + b.g * (1 - a),
    b: f.b * a + b.b * (1 - a),
  });
}

// The decision the remap encodes: a readable ink-soft note must use FULL strength (alpha 1).
export function accessibleInkSoftAlpha(): 1 {
  return 1;
}

// Convenience used by the test (and self-documenting): proves a given alpha passes AA on a surface.
export function inkSoftPassesAA(alpha: number, surface: keyof typeof SURFACE): boolean {
  return contrastRatio(compositeAlpha(INK_SOFT, SURFACE[surface], alpha), SURFACE[surface]) >= AA_NORMAL;
}

// The film-surface remap decision (UX-4 rider): secondary text on the dark bg-film stage must be
// film-soft, never ink-soft. ink-soft #566472 on film #0C1116 = 3.13:1 (AA FAIL); film-soft #9FB0BD
// on film = 8.51:1 (pass). Pinned by the contrast test so a regression back to ink-soft-on-film is caught.
export function filmSoftPassesAA(): boolean {
  return contrastRatio(FILM_SOFT, SURFACE.film) >= AA_NORMAL;
}

// round5 severity-label decolorize: a severity HUE as label text FAILS AA on a light surface (the
// defect the recolor removes) — this is why the severity WORD must be text-ink and the hue lives only
// on the adjacent dot (WCAG 1.4.1 preserved). Pinned so a regression back to a hue-colored word is caught.
export function severityHuePassesAA(sev: keyof typeof SEVERITY_HEX, surface: 'bg' | 'panel'): boolean {
  return contrastRatio(SEVERITY_HEX[sev], SURFACE[surface]) >= AA_NORMAL;
}

// ink label text PASSES AA on a light surface (the fix target: 16.48:1 panel / 13.87:1 bg — AAA).
export function inkPassesAA(surface: 'bg' | 'panel'): boolean {
  return contrastRatio(INK, SURFACE[surface]) >= AA_NORMAL;
}

// ── round5 CTA/teal role-split AA proof ──────────────────────────────────────
// Brand hexes mirrored from index.css @theme (SoT). These pin the role-split remap so a regression that
// lightens a role back below AA is caught by a deterministic unit test. All pure/O(1), no new deps.
export const CTA = '#128659'; // button FILL (index.css --color-cta)
export const CTA_HOVER = '#0E7049'; // button hover FILL (index.css --color-cta-hover)
export const CTA_TEXT = '#0C7248'; // green accent TEXT on light (index.css --color-cta-text)
export const TEAL_TEXT = '#0C7676'; // teal link/label TEXT + the one white-on-teal chip bg (--color-teal-text)
export const TEAL_DECOR = '#0E8C8C'; // decorative only (--color-teal): focus ring / borders / scanline / SVG / dots
export const WHITE = '#FFFFFF';

// WCAG large-text (≥24px normal / ≥18.66px bold) minimum — used only to justify KEEPING decorative teal on
// the 30px landing step numeral and as the non-text 1.4.11 floor for the focus ring / borders.
export const AA_LARGE = 3.0;

// A button fill must clear AA for its WHITE label (normal-size button text).
export function ctaWhitePassesAA(): boolean {
  return contrastRatio(WHITE, CTA) >= AA_NORMAL;
}
// Hover fill: still legible in white AND strictly darker than the base (a hover must never read lighter).
export function ctaHoverPassesAA(): boolean {
  return contrastRatio(WHITE, CTA_HOVER) >= AA_NORMAL && relLuminance(CTA_HOVER) < relLuminance(CTA);
}
// Green accent TEXT must clear AA on BOTH light surfaces (it renders on bg AND panel).
export function ctaTextPassesAA(surface: keyof typeof SURFACE): boolean {
  return contrastRatio(CTA_TEXT, SURFACE[surface]) >= AA_NORMAL;
}
// Teal link/label TEXT must clear AA on BOTH light surfaces (the readable-teal migration target).
export function linkTealTextPassesAA(surface: keyof typeof SURFACE): boolean {
  return contrastRatio(TEAL_TEXT, SURFACE[surface]) >= AA_NORMAL;
}
// The teal-text token also backs the one white-on-teal chip (App engine toggle) — white on it must clear AA.
export function tealTextWhiteBgPassesAA(): boolean {
  return contrastRatio(WHITE, TEAL_TEXT) >= AA_NORMAL;
}
// Decorative teal is retained ONLY where large-text / non-text 1.4.11 (≥3:1) applies — proven, not asserted.
export function tealDecorLargePassesAA(surface: keyof typeof SURFACE): boolean {
  return contrastRatio(TEAL_DECOR, SURFACE[surface]) >= AA_LARGE;
}

// ── dark-theme AA proof ──────────────────────────────────────────────────────
// The dark palette OVERRIDES the same @theme --color-* tokens under [data-theme='dark'] /
// @media(prefers-color-scheme:dark) — mirrored here from index.css as the single source of truth so a
// regression that lightens a dark surface (or darkens a dark accent) below AA is caught by a unit test.
// Only the accent-TEXT tokens flip; the CTA FILL and severity DOT hues are theme-independent. All pure/O(1).
export const DARK = { bg: '#141B24', panel: '#1E2A36' } as const;
export const DARK_INK = '#E8EDF2'; // dark --color-ink
export const DARK_INK_SOFT = '#9FB0BD'; // dark --color-ink-soft (= film-soft; already AA on dark)
export const DARK_TEAL_TEXT = '#4CC7C7'; // dark --color-teal-text
export const DARK_CTA_TEXT = '#45C892'; // dark --color-cta-text
export const DARK_CRIT_TEXT = '#FF8A8D'; // dark --color-crit-text

// A dark-theme readable-text token must clear AA on the given dark surface (it renders on bg AND panel).
export function darkTextPassesAA(hex: string, surface: keyof typeof DARK): boolean {
  return contrastRatio(hex, DARK[surface]) >= AA_NORMAL;
}
// The engine-chip label is panel-on-teal-text-fill (both flip together) — it must clear AA in BOTH themes.
export function chipLabelPassesAABothThemes(): boolean {
  return contrastRatio(SURFACE.panel, TEAL_TEXT) >= AA_NORMAL && contrastRatio(DARK.panel, DARK_TEAL_TEXT) >= AA_NORMAL;
}
// A severity DOT (non-text signal) clears the 1.4.11 floor (≥3:1) on a dark surface.
export function severityDotDarkPasses(sev: keyof typeof SEVERITY_HEX, surface: keyof typeof DARK): boolean {
  return contrastRatio(SEVERITY_HEX[sev], DARK[surface]) >= AA_LARGE;
}
// Decorative teal (focus ring / borders / scanline) keeps its non-text 1.4.11 floor on dark surfaces too.
export function tealDecorDarkLargePasses(surface: keyof typeof DARK): boolean {
  return contrastRatio(TEAL_DECOR, DARK[surface]) >= AA_LARGE;
}
