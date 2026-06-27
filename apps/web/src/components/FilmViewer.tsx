import { useEffect, useRef, useState } from 'react';
import type { AssetMetrics, Finding, OverlayZone } from '@asset-doctor/core';
import { fmtBytes } from '../lib/format';

// Overlay styles (§5): empty = red, transparent = yellow, bleeding = teal.
const ZONE_STYLE: Record<OverlayZone['kind'], { stroke: string; fill: string }> = {
  empty: { stroke: '#e5484d', fill: 'rgba(229,72,77,0.18)' },
  transparent: { stroke: '#d98a00', fill: 'rgba(217,138,0,0.14)' },
  bleeding: { stroke: '#0e8c8c', fill: 'rgba(14,140,140,0.14)' },
};

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
}: {
  bytes: ArrayBuffer;
  findings: Finding[];
  highlightId?: string;
  name: string;
  metrics?: AssetMetrics;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

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
        for (const zone of f.overlay) {
          const style = ZONE_STYLE[zone.kind];
          ctx.save();
          ctx.globalAlpha = active ? 1 : 0.2;
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
        }
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

  return (
    <div className="relative ad-clip ad-viewer-shadow rounded-2xl border border-film-border bg-film p-3.5">
      {/* top bar */}
      <div className="flex items-center justify-between gap-2 px-1.5 pb-3 pt-1 font-mono">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-film-soft">{name}</span>
          <span className="rounded bg-info px-1.5 py-0.5 text-[10px] font-semibold text-film">{formatOf(name)}</span>
        </div>
        <span className="shrink-0 text-[11px] text-ink-soft">{sizeStr}</span>
      </div>

      {/* x-ray stage */}
      <div className="ad-grid relative aspect-square w-full overflow-hidden rounded-[10px]">
        <canvas ref={canvasRef} className="absolute inset-0 m-auto block max-h-full max-w-full" />
        <div key={name} className="ad-scanline" />
      </div>

      {/* readout strip */}
      <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
        <ReadCell label="VRAM" value={fmtBytes(metrics?.vramBytes ?? 0)} color="text-info" />
        <ReadCell label="DISK" value={fmtBytes(metrics?.diskBytes ?? 0)} color="text-ok" />
        <ReadCell label="OCC" value={occ === undefined ? '—' : `${Math.round(occ * 100)}%`} color={occColor} />
        <ReadCell label="FRAG" value={frag === undefined ? '—' : `${Math.round(frag * 100)}%`} color={fragColor} />
      </div>
    </div>
  );
}

function ReadCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-film px-3 py-2.5">
      <div className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-soft">{label}</div>
      <div className={`font-mono text-[17px] font-semibold leading-none ${color}`}>{value}</div>
    </div>
  );
}
