import { useEffect, useId, useRef, useState } from 'react';
import type { AssetMetrics, Finding } from '@asset-doctor/core';
import { fmtBytes, fmtSignedBytes } from '../lib/format';
import { useI18n } from '../lib/i18n';
// ZONE_STYLE lives in film-legend-style.ts (single source of truth) so the paint loop here and the legend
// swatches (film-legend.ts) read the SAME colors with no import cycle — the legend can never drift from paint.
import { ZONE_STYLE } from '../lib/film-legend-style';
import { filmAltText, legendItemsFor } from '../lib/film-legend';
import { explainerRows, baseReadingFlags } from '../lib/readout-explainers';

const MAX_W = 760;

const formatOf = (name: string): string => {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return { jpg: 'JPEG', jpeg: 'JPEG' }[ext] ?? ext.toUpperCase();
};

/** The signature view: the atlas read like an X-ray on the dark film, problems glowing. */
export function FilmViewer({
  bytes,
  findings,
  highlightId,
  name,
  metrics,
  frameCount = 0,
}: {
  bytes: ArrayBuffer;
  findings: Finding[];
  highlightId?: string;
  name: string;
  metrics?: AssetMetrics;
  /** Sprite count for the MEASURED draw-calls readout ("N sprites batched"). 0 ⇒ not shown. */
  frameCount?: number;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Stable, unique id for the legend's accessible group name (aria-labelledby). `name` may carry odd chars,
  // so useId is the safe source — never derived from the asset name. React 18-safe.
  const legendHeadingId = useId();
  // WAI-ARIA disclosure for the invariant-5 readings help (UX-4): one quiet trigger toggles a static
  // definitions panel that re-delivers the three vetted honesty strings keyboard/touch/SR-accessibly
  // (they ship elsewhere ONLY as title= = mouse-only). Open state persists across asset switches.
  const [explainOpen, setExplainOpen] = useState(false);
  const explainPanelId = useId();

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    void createImageBitmap(new Blob([bytes])).then((bmp) => {
      if (cancelled) return;
      setDims({ w: bmp.width, h: bmp.height });
      const scale = Math.min(1, MAX_W / bmp.width);
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();

      for (const f of findings) {
        if (!f.overlay) continue;
        const active = highlightId === undefined || f.id === highlightId;
        f.overlay.forEach((zone, zi) => {
          const style = ZONE_STYLE[zone.kind];
          ctx.save();
          ctx.globalAlpha = active ? 1 : 0.2;
          // Rotate hue per cluster so adjacent duplicate-frame groups read as distinct (each cluster is its
          // own OverlayZone). Other zone kinds keep their fixed §5 color (zi has no effect on them).
          if (zone.kind === 'duplicate-frame' && zi > 0) ctx.filter = `hue-rotate(${(zi * 47) % 360}deg)`;
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = style.stroke;
          ctx.fillStyle = style.fill;
          for (const r of zone.rects) {
            const x = r.x * scale;
            const y = r.y * scale;
            const w = r.w * scale;
            const h = r.h * scale;
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
          }
          ctx.restore();
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [bytes, findings, highlightId]);

  const occ = metrics?.occupancy;
  const occColor = occ === undefined ? 'text-film-soft' : occ < 0.6 ? 'text-crit' : occ < 0.8 ? 'text-warn' : 'text-ok';
  // FRAG: dispersion of empty space (1 = one contiguous hole, →0 = shredded). Higher is better, so
  // the buckets read the opposite way to OCC: low frag = crit. Neutral when absent (no empty map).
  const frag = metrics?.fragmentation;
  const fragColor =
    frag === undefined ? 'text-film-soft' : frag < 0.4 ? 'text-crit' : frag < 0.7 ? 'text-warn' : 'text-ok';
  const sizeStr = dims ? (dims.w === dims.h ? `${dims.w}²` : `${dims.w}×${dims.h}`) : '—';
  // MEASURED render-probe reading (real offscreen-WebGL). Present only after the host probe ran on the
  // main thread with WebGL available; absent for loose assets / no-WebGL ⇒ today's 4-cell readout.
  const probe = metrics?.probe;
  // BREAKDOWN block (additive, below the two strips): surfaces already-measured/already-computed fields.
  // Gate the whole block on a local narrow `m` (avoids non-null `!`) plus per-row guards. When BOTH the
  // probe reading and the mip-ceiling gap are absent the block renders nothing ⇒ byte-identical to today.
  const m = metrics;
  // Mip ceiling is a CONDITIONAL upper bound (+33%), shown only when it exceeds the base (nonzero size).
  const showMip = m !== undefined && m.vramBytesMipmapped > m.vramBytes;
  // Explainer rows for the disclosure — reuse the card's OWN render gates (probe strips, showMip row)
  // plus the always-present base strip (VRAM/DISK/OCC/FRAG), gated to a real fully-measured card by
  // baseReadingFlags (the diff-view partial has no diskBytes ⇒ all-false ⇒ byte-identical there). So
  // even a plain loose asset now gets an accessible disk≠VRAM explanation. `[]` ⇒ no trigger.
  const explainers = explainerRows({ ...baseReadingFlags(m), probe: probe !== undefined, mip: showMip });

  // Accessible name for the canvas (otherwise an inaccessible painted blob) — MEASURED facts only: name,
  // dims (omitted when not yet decoded), and the measured highlighted-region count. No disk/VRAM/savings.
  const altText = filmAltText(t, name, dims, findings);
  // Decode the overlay colors into honest words so color is no longer the sole signal. Empty (before-diff
  // film, format/dimension-only findings) ⇒ render nothing — no stray empty strip.
  const legendItems = legendItemsFor(findings);

  return (
    <div className="relative ad-clip ad-viewer-shadow rounded-2xl border border-film-border bg-film p-3.5">
      {/* top bar */}
      <div className="flex items-center justify-between gap-2 px-1.5 pb-3 pt-1 font-mono">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-film-soft">{name}</span>
          <span className="rounded bg-info px-1.5 py-0.5 text-[10px] font-semibold text-film">{formatOf(name)}</span>
        </div>
        <span className="shrink-0 text-[11px] text-film-soft">{sizeStr}</span>
      </div>

      {/* x-ray stage */}
      <div className="ad-grid relative aspect-square w-full overflow-hidden rounded-[10px]">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={altText}
          className="absolute inset-0 m-auto block max-h-full max-w-full"
        />
        <div key={name} className="ad-scanline" aria-hidden="true" />
      </div>

      {/* readout strip — when a render-probe reading exists, the static VRAM is relabelled "declared"
          (it's the manifest atlas geometry, an estimate). Without a probe it shows exactly today. */}
      <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
        <ReadCell
          label={probe ? t('readout.declared') : 'VRAM'}
          value={fmtBytes(metrics?.vramBytes ?? 0)}
          color="text-info"
        />
        <ReadCell label="DISK" value={fmtBytes(metrics?.diskBytes ?? 0)} color="text-ok" />
        <ReadCell label="OCC" value={occ === undefined ? '—' : `${Math.round(occ * 100)}%`} color={occColor} />
        <ReadCell label="FRAG" value={frag === undefined ? '—' : `${Math.round(frag * 100)}%`} color={fragColor} />
      </div>

      {/* OVERLAY LEGEND — decodes the x-ray colors into words so color is no longer the sole signal (a11y).
          Swatch fills come from ZONE_STYLE (same as paint, zero drift); the localized text carries the
          meaning so each swatch is aria-hidden (the SR never reads "colored box"). Lists ONLY kinds genuinely
          present; bleeding & duplicate-frame share the teal swatch but keep DISTINCT honest labels. Rendered
          ONLY when items exist ⇒ the before/after-diff films (findings=[]) render NOTHING — no empty strip. */}
      {legendItems.length > 0 ? (
        <div className="mt-2.5">
          <div
            id={legendHeadingId}
            className="mb-1.5 px-1 font-mono text-[9px] uppercase tracking-[0.08em] text-film-soft"
          >
            {t('legend.heading')}
          </div>
          <ul role="list" aria-labelledby={legendHeadingId} className="flex list-none flex-wrap gap-x-3 gap-y-1.5 px-1">
            {legendItems.map((item) => (
              <li key={item.kind} role="listitem" className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-film-border"
                  style={{ backgroundColor: item.fill }}
                />
                <span className="font-mono text-[10px] text-film-soft">{t(item.labelKey)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* MEASURED strip — additive, only when the render-probe ran (real offscreen-WebGL). These are
          a DIFFERENT quantity from the declared estimate above (real decoded footprint + issued draws),
          framed as "measured", never a savings delta vs the estimate (BLOCKER1). Absent ⇒ nothing here,
          so a loose / un-probed asset renders exactly today. */}
      {probe ? (
        <div className="mt-px grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
          <ReadCell
            label={t('readout.measured')}
            value={fmtBytes(probe.vramBytes)}
            color="text-info"
            title={t('readout.measuredTooltip')}
          />
          <ReadCell
            label={t('readout.drawCalls')}
            value={`${probe.drawCalls}`}
            sub={frameCount > 0 ? t('readout.batched', { n: frameCount }) : undefined}
            color="text-ok"
          />
        </div>
      ) : null}

      {/* VRAM BREAKDOWN — additive surfacing of fields we already measured/computed. Three independently
          gated rows; renders nothing when both the probe and the mip gap are absent (byte-identical to
          today). (1) mip ceiling: the +33% upper bound IF mipmaps are on — a ceiling, never asserted
          residency. (2) probe internals from the first render. (3) a SINGLE signed declared-vs-measured
          delta — two measurements (manifest geometry vs decoded pixels), never a saving (Invariant 5).
          Declared/measured themselves are already on the card above and are NOT re-printed here. */}
      {m && (showMip || probe) ? (
        <div className="mt-2.5">
          <div className="mb-1.5 px-1 font-mono text-[9px] uppercase tracking-[0.08em] text-film-soft">
            {t('readout.breakdown')}
          </div>

          {showMip ? (
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
              <ReadCell label="VRAM" value={fmtBytes(m.vramBytes)} color="text-info" />
              <ReadCell
                label={t('readout.mipCeiling')}
                value={fmtBytes(m.vramBytesMipmapped)}
                sub="+33%"
                color="text-warn"
                title={t('readout.mipCeilingTooltip')}
              />
            </div>
          ) : null}

          {probe ? (
            <div className="mt-px grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
              {probe.liveTextures !== 0 ? (
                <ReadCell
                  label={t('readout.liveTextures')}
                  value={`${probe.liveTextures}`}
                  sub={t('readout.onFirstRender')}
                  color="text-info"
                />
              ) : null}
              {probe.textureUploads !== 0 ? (
                <ReadCell
                  label={t('readout.uploads')}
                  value={`${probe.textureUploads}`}
                  sub={t('readout.onFirstRender')}
                  color="text-info"
                />
              ) : null}
              {probe.shaderCompiles !== 0 ? (
                <ReadCell
                  label={t('readout.shaders')}
                  value={`${probe.shaderCompiles}`}
                  sub={t('readout.onFirstRender')}
                  color="text-info"
                />
              ) : null}
            </div>
          ) : null}

          {probe ? (
            <div className="mt-px overflow-hidden rounded-lg border border-film-border bg-film-border">
              <ReadCell
                label={t('readout.declaredVsMeasured')}
                value={fmtSignedBytes(probe.vramBytes - m.vramBytes)}
                color="text-film-soft"
                title={t('readout.deltaTooltip')}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* READINGS DISCLOSURE (UX-4, invariant 5) — WAI-ARIA disclosure: a single quiet trigger toggling
          a static <dl> that re-delivers the three vetted honesty strings (measured / mip ceiling / declared-
          vs-measured) keyboard/touch/SR-accessibly. Elsewhere these ship ONLY as title= (mouse-only). LAST
          child so reading order is facts-first, meta-help last. Renders nothing when explainers=[] (diff-view /
          metrics-less card) ⇒ byte-identical there. Terms reuse the on-card cell-label keys ⇒ zero drift; no
          new honesty copy — only readout.explainTrigger is new. */}
      {explainers.length > 0 ? (
        <div className="mt-2.5 px-1">
          <button
            type="button"
            aria-expanded={explainOpen}
            aria-controls={explainPanelId}
            onClick={() => setExplainOpen((v) => !v)}
            className="flex min-h-6 items-center gap-1.5 font-mono text-[10px] text-film-soft underline-offset-2 hover:underline"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-film-soft text-[9px] leading-none"
            >
              i
            </span>
            {t('readout.explainTrigger')}
          </button>
          <dl
            id={explainPanelId}
            hidden={!explainOpen}
            className="mt-1.5 space-y-2 rounded-lg border border-film-border bg-film-2 px-3 py-2.5"
          >
            {explainers.map((row) => (
              <div key={row.key}>
                <dt className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-film-soft">
                  {'i18nKey' in row.term ? t(row.term.i18nKey) : row.term.literal}
                </dt>
                <dd className="mt-0.5 text-[11px] leading-relaxed text-film-soft">{t(row.bodyKey)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function ReadCell({
  label,
  value,
  color,
  sub,
  title,
}: {
  label: string;
  value: string;
  color: string;
  /** Secondary line under the value (e.g. "N sprites batched" beside draw calls). */
  sub?: string;
  /** Hover explainer (e.g. the declared-vs-measured divergence note). */
  title?: string;
}) {
  return (
    <div className="bg-film px-3 py-2.5" title={title}>
      <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-film-soft">{label}</div>
      <div className={`font-mono text-[17px] font-semibold leading-none ${color}`}>{value}</div>
      {sub ? <div className="mt-1 font-mono text-[9px] leading-tight text-film-soft">{sub}</div> : null}
    </div>
  );
}
