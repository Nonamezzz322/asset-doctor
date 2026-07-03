// Presentational specimen for the landing's "How it works" section — a stylised atlas X-ray built ONLY
// from real design tokens + the SHIPPED overlay palette (ZONE_STYLE, imported so it can never drift from
// what the real FilmViewer paints) + the pinned static geometry (landing-specimen). It carries NO t()
// calls: every string arrives already localized from Landing.tsx, so this file needs no i18n-scan
// registration and stays render-pure (no state, no effects, no listeners). Honesty: every metric cell
// shows '—' (the real FilmViewer's absent-metric convention) — zero fabricated numbers (invariant 3).
import type { OverlayZone } from '@asset-doctor/core';
import { ZONE_STYLE } from '../../lib/film-legend-style';
import { SPECIMEN_FRAMES, SPECIMEN_ZONES, SPECIMEN_VIEWBOX } from '../../lib/landing-specimen';

// Matches the CODE's readout cell list (FilmViewer renders VRAM / DISK / OCC / FRAG). Literals, as in code.
const READOUT_CELLS = ['VRAM', 'DISK', 'OCC', 'FRAG'] as const;

export function SpecimenFilm({
  alt,
  caption,
  legend,
}: {
  alt: string;
  caption: string;
  legend: ReadonlyArray<{ kind: OverlayZone['kind']; label: string }>;
}) {
  return (
    <figure className="m-0">
      {/* The film card — the Dropzone's own x-ray styling (ad-grid + clip notch + lift). `relative` so the
          clip notch (::before) and the scanline anchor here. */}
      <div className="ad-grid ad-clip ad-viewer-shadow relative rounded-2xl border border-film-border p-3.5">
        <div className="relative aspect-square overflow-hidden rounded-lg">
          <svg
            viewBox={`0 0 ${SPECIMEN_VIEWBOX.w} ${SPECIMEN_VIEWBOX.h}`}
            role="img"
            aria-label={alt}
            className="h-full w-full"
          >
            {/* faint packed "sprite frames" */}
            {SPECIMEN_FRAMES.map((f, i) => (
              <rect
                key={`f${i}`}
                x={f.x}
                y={f.y}
                width={f.w}
                height={f.h}
                rx={3}
                fill="rgba(255,255,255,0.05)"
                stroke="var(--color-film-border)"
                strokeWidth={1}
              />
            ))}
            {/* overlay zones — stroke/fill from the imported palette; empty also gets the dashed edge
                (mirrors "пустота = заливка + пунктир"). */}
            {SPECIMEN_ZONES.map((z, i) => (
              <rect
                key={`z${i}`}
                x={z.x}
                y={z.y}
                width={z.w}
                height={z.h}
                rx={2}
                fill={ZONE_STYLE[z.kind].fill}
                stroke={ZONE_STYLE[z.kind].stroke}
                strokeWidth={1.5}
                strokeDasharray={z.kind === 'empty' ? '4 3' : undefined}
              />
            ))}
          </svg>
          {/* SHIPPED one-shot scanline (2.1s, runs once; display:none under reduced-motion). aria-hidden. */}
          <div className="ad-scanline" aria-hidden="true" />
        </div>

        {/* readout strip — mirrors the code's 4 cells; every value '—' (illustrative, not a measurement). */}
        <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
          {READOUT_CELLS.map((cell) => (
            <div key={cell} className="bg-film px-2 py-1.5 text-center">
              <div className="font-mono text-[8px] uppercase tracking-[0.08em] text-film-soft">{cell}</div>
              <div className="font-mono text-[11px] font-semibold text-white">—</div>
            </div>
          ))}
        </div>

        {/* mini-legend — text carries the meaning (swatch aria-hidden), same pattern as the real legend. */}
        <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1">
          {legend.map((l) => (
            <span key={l.kind} className="inline-flex items-center gap-1.5 font-mono text-[9px] text-film-soft">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-[2px]"
                style={{ backgroundColor: ZONE_STYLE[l.kind].fill, border: `1px solid ${ZONE_STYLE[l.kind].stroke}` }}
              />
              {l.label}
            </span>
          ))}
        </div>
      </div>
      {/* caption on the LIGHT bg below the card — the honesty label, repeated per specimen. */}
      <figcaption className="mt-2 text-center font-mono text-[10px] text-ink-soft">{caption}</figcaption>
    </figure>
  );
}
