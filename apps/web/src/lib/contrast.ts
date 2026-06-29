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
// bg = --color-bg (index.css:5), panel = --color-panel (index.css:6).
export const SURFACE = { bg: '#E7ECF1', panel: '#FFFFFF' } as const;
// --color-ink-soft (index.css:9).
export const INK_SOFT = '#566472';

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
