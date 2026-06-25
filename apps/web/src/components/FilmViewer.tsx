import { useEffect, useRef } from 'react';
import type { Finding, OverlayZone } from '@asset-doctor/core';

// Overlay styles (§5): empty = red, transparent = yellow, bleeding = teal.
const ZONE_STYLE: Record<OverlayZone['kind'], { stroke: string; fill: string }> = {
  empty: { stroke: '#e5484d', fill: 'rgba(229,72,77,0.18)' },
  transparent: { stroke: '#d98a00', fill: 'rgba(217,138,0,0.14)' },
  bleeding: { stroke: '#0e8c8c', fill: 'rgba(14,140,140,0.14)' },
};

const MAX_W = 760;

/** The signature view: the atlas read like an X-ray on the dark film, problems glowing. */
export function FilmViewer({
  bytes,
  findings,
  highlightId,
}: {
  bytes: ArrayBuffer;
  findings: Finding[];
  highlightId?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    void createImageBitmap(new Blob([bytes])).then((bmp) => {
      if (cancelled) return;
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

  return (
    <div className="overflow-auto rounded-lg border border-dashed border-line bg-film p-3">
      <canvas ref={canvasRef} className="mx-auto block max-w-full" />
    </div>
  );
}
