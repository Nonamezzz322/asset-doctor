import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AssetMetrics, Finding, Rect } from '@asset-doctor/core';
import { fmtBytes, fmtSignedBytes } from '../lib/format';
import { useI18n } from '../lib/i18n';
// ZONE_STYLE lives in film-legend-style.ts (single source of truth) so the paint loop here and the legend
// swatches (film-legend.ts) read the SAME colors with no import cycle — the legend can never drift from paint.
import { ZONE_STYLE } from '../lib/film-legend-style';
import { filmAltText, legendItemsFor } from '../lib/film-legend';
import { explainerRows, baseReadingFlags } from '../lib/readout-explainers';
// The LOUPE decision core (zoom/pan/hit-test/keyboard math) is PURE + Node-tested (film-loupe.test.ts). This
// component is a THIN renderer over it: it never computes a clamp, a mapping, or a hit-test itself — it calls
// these total functions and paints their results. That is how the interactive path earns real test coverage.
import {
  INITIAL_VIEW,
  ZOOM_MIN,
  ZOOM_MAX,
  centerOn,
  clampView,
  frameCenter,
  formatInspect,
  imageToCanvasRect,
  insideUnit,
  inspectAt,
  inspectFrame,
  isDefaultView,
  panBy,
  panByDragFraction,
  panStep,
  sourceRect,
  stepFrameIndex,
  zoomIn,
  zoomOut,
  type InspectResult,
  type LoupeView,
} from '../lib/film-loupe';

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
  interactive = false,
  frames,
  frameNames,
}: {
  bytes: ArrayBuffer;
  findings: Finding[];
  highlightId?: string;
  name: string;
  metrics?: AssetMetrics;
  /** Sprite count for the MEASURED draw-calls readout ("N sprites batched"). 0 ⇒ not shown. */
  frameCount?: number;
  /** Turn on the loupe (zoom + pan + click/keyboard inspect). Default false ⇒ the legacy decode/draw path runs
   *  byte-identically (the diff-view + landing demo pass nothing ⇒ untouched). */
  interactive?: boolean;
  /** Per-atlas packed frame rects (report.atlasFrames[name]) — the hit-test source. Undefined (loose image /
   *  no atlas) ⇒ inspect honestly returns frame:null. Read verbatim; never mutated. */
  frames?: Rect[];
  /** OPTIONAL index-aligned sprite names (from the flagged additive core field). Absent ⇒ the inspect readout
   *  uses the real array ordinal ("Frame N · W×H") — fully honest. Present ⇒ the sprite name is surfaced. */
  frameNames?: string[];
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  // ── LOUPE state (interactive path only) ─────────────────────────────────────────────────────────────────
  // The current zoom/pan view (always clamped by the pure producers), the last inspect result (persistent
  // visible text, NOT a live region), keyboard focus (drives the crosshair), and a polite SR announcer whose
  // `nudge` flips an invisible char so a repeat announcement (e.g. re-inspecting the same frame) still speaks
  // (the App aria-live nudge precedent). `bmpRef` RETAINS the decoded bitmap so zoom/pan is a cheap re-draw,
  // never a re-decode (invariant 4); `bmpBytesRef` pins which bytes that bitmap belongs to so a redraw during
  // an asset switch never paints the OLD atlas under the NEW overlays. `drawNonce` re-fires the draw effect
  // once a fresh bitmap is ready.
  const [view, setView] = useState<LoupeView>(INITIAL_VIEW);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [focused, setFocused] = useState(false);
  const [status, setStatus] = useState<{ text: string; nudge: boolean }>({ text: '', nudge: false });
  const bmpRef = useRef<ImageBitmap | null>(null);
  const bmpBytesRef = useRef<ArrayBuffer | null>(null);
  const [drawNonce, setDrawNonce] = useState(0);
  const dragRef = useRef<{ id: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const instructionsId = useId();

  const announce = (text: string): void => setStatus((p) => ({ text, nudge: !p.nudge }));
  // Stable, unique id for the legend's accessible group name (aria-labelledby). `name` may carry odd chars,
  // so useId is the safe source — never derived from the asset name. React 18-safe.
  const legendHeadingId = useId();
  // WAI-ARIA disclosure for the invariant-5 readings help (UX-4): one quiet trigger toggles a static
  // definitions panel that re-delivers the three vetted honesty strings keyboard/touch/SR-accessibly
  // (they ship elsewhere ONLY as title= = mouse-only). Open state persists across asset switches.
  const [explainOpen, setExplainOpen] = useState(false);
  const explainPanelId = useId();

  // LEGACY (non-interactive) decode+draw — VERBATIM. Guarded off in interactive mode (the two effects below own
  // that path) so the diff-view + landing demo stay byte-identical: same createImageBitmap→fit-draw→bmp.close().
  useEffect(() => {
    if (interactive) return;
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
  }, [bytes, findings, highlightId, interactive]);

  // INTERACTIVE asset-switch RESET — run SYNCHRONOUSLY before the browser paints (useLayoutEffect), so a new
  // atlas can never show the previous atlas's stale inspect readout (the ordinal would otherwise re-map through
  // the NEW frames array for the render(s) before the async decode resolves). Clears the view, the inspect
  // result and any in-flight drag the instant bytes/name change.
  useLayoutEffect(() => {
    if (!interactive) return;
    dragRef.current = null;
    setView(INITIAL_VIEW);
    setInspect(null);
  }, [bytes, name, interactive]);

  // INTERACTIVE decode — decode ONCE per bytes and RETAIN the bitmap (invariant 4: zoom/pan never re-decodes).
  // Sizes the backing store to the same fit as the legacy path (≤ MAX_W), so the initial paint === today's.
  // Cleanup only flags cancellation; the retained bitmap is freed on the previous-bitmap swap here and on
  // unmount below. (The view/inspect/drag reset is the layout effect above — synchronous, no stale paint.)
  useEffect(() => {
    if (!interactive) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas || !canvas.getContext('2d')) return;
    void createImageBitmap(new Blob([bytes])).then((bmp) => {
      if (cancelled) {
        bmp.close();
        return;
      }
      bmpRef.current?.close();
      bmpRef.current = bmp;
      bmpBytesRef.current = bytes;
      setDims({ w: bmp.width, h: bmp.height });
      const scale = Math.min(1, MAX_W / bmp.width);
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      setDrawNonce((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [bytes, name, interactive]);

  // Free the retained bitmap on final unmount (the decode effect frees the PREVIOUS one on each swap).
  useEffect(
    () => () => {
      bmpRef.current?.close();
      bmpRef.current = null;
    },
    [],
  );

  // INTERACTIVE draw — cheap re-paint of the RETAINED bitmap for the current view + overlays. Reuses the exact
  // ZONE_STYLE / dash / alpha / per-cluster-hue logic; only the rect→canvas mapping swaps to the pure
  // imageToCanvasRect (at zoom=1 it reduces to the legacy scale, so the fit view is visually identical). The
  // bmpBytesRef guard drops a redraw that would paint a stale atlas under fresh overlays mid-switch.
  useEffect(() => {
    if (!interactive) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const bmp = bmpRef.current;
    if (!canvas || !ctx || !bmp || bmpBytesRef.current !== bytes) return;
    const img = { w: bmp.width, h: bmp.height };
    const cw = canvas.width;
    const ch = canvas.height;
    const { sx, sy, sw, sh } = sourceRect(view, img);
    // Crisp NEAREST texels when magnified (sprite inspection); smooth downscale at fit (== today).
    ctx.imageSmoothingEnabled = view.zoom <= 1;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, cw, ch);

    for (const f of findings) {
      if (!f.overlay) continue;
      const active = highlightId === undefined || f.id === highlightId;
      f.overlay.forEach((zone, zi) => {
        const style = ZONE_STYLE[zone.kind];
        ctx.save();
        ctx.globalAlpha = active ? 1 : 0.2;
        if (zone.kind === 'duplicate-frame' && zi > 0) ctx.filter = `hue-rotate(${(zi * 47) % 360}deg)`;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = style.stroke;
        ctx.fillStyle = style.fill;
        for (const r of zone.rects) {
          const q = imageToCanvasRect(r, view, img, cw, ch);
          ctx.fillRect(q.x, q.y, q.w, q.h);
          ctx.strokeRect(q.x + 0.5, q.y + 0.5, Math.max(0, q.w - 1), Math.max(0, q.h - 1));
        }
        ctx.restore();
      });
    }
  }, [view, findings, highlightId, drawNonce, bytes, interactive]);

  // ── LOUPE handlers (all math delegated to film-loupe.ts; these only wire DOM events → pure functions) ─────
  const doInspect = (u: number, v: number): void => {
    if (!dims) return;
    const res = inspectAt(u, v, view, dims, frames ?? [], findings);
    setInspect(res);
    announce(formatInspect(res, frames?.[res.frame ?? -1] ?? null, frameNames?.[res.frame ?? -1], t));
  };

  const applyZoom = (next: LoupeView): void => {
    setView(next);
    announce(t('loupe.zoomLevel', { z: next.zoom }));
  };
  // Bound-guarded so a click/keypress AT the clamp is a true no-op (no spurious re-announce). The buttons stay
  // FOCUSABLE (aria-disabled, not the native `disabled`) so reaching a bound never drops keyboard focus to body.
  const doZoomIn = (): void => {
    if (dims && view.zoom < ZOOM_MAX) applyZoom(zoomIn(view, dims));
  };
  const doZoomOut = (): void => {
    if (dims && view.zoom > ZOOM_MIN) applyZoom(zoomOut(view, dims));
  };
  const doReset = (): void => {
    if (dims && !isDefaultView(view)) applyZoom(clampView(INITIAL_VIEW, dims));
  };

  // Sprite-cycle inspect (prev/next buttons) — the mouse-FREE, screen-reader-safe path to inspect EVERY frame,
  // regardless of zoom/pan (the crosshair-centre keyboard inspect below cannot reach an edge/corner sprite at
  // high zoom). Steps the inspected frame with wrap, surfaces its REAL facts, and centres the view on it.
  const doStepFrame = (dir: 1 | -1): void => {
    if (!dims || !frames || frames.length === 0) return;
    const next = stepFrameIndex(inspect?.frame ?? null, frames.length, dir);
    if (next === null) return;
    const res = inspectFrame(next, frames, findings);
    setInspect(res);
    setView((v) => centerOn(frameCenter(frames[next]!), v, dims));
    announce(formatInspect(res, frames[next] ?? null, frameNames?.[next], t));
  };

  const onStageKey = (e: React.KeyboardEvent): void => {
    if (!dims) return;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        setView((v) => panBy(v, -panStep(v, dims).dx, 0, dims));
        break;
      case 'ArrowRight':
        e.preventDefault();
        setView((v) => panBy(v, panStep(v, dims).dx, 0, dims));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setView((v) => panBy(v, 0, -panStep(v, dims).dy, dims));
        break;
      case 'ArrowDown':
        e.preventDefault();
        setView((v) => panBy(v, 0, panStep(v, dims).dy, dims));
        break;
      case '+':
      case '=':
        e.preventDefault();
        doZoomIn();
        break;
      case '-':
      case '_':
        e.preventDefault();
        doZoomOut();
        break;
      case '0':
        e.preventDefault();
        doReset();
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        doInspect(0.5, 0.5); // keyboard inspect = the fixed viewport-center crosshair
        break;
      default:
        break;
    }
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!dims) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId || !dims) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.moved && (Math.abs(e.clientX - d.startX) > 4 || Math.abs(e.clientY - d.startY) > 4)) d.moved = true;
    if (!d.moved) return;
    setView((v) => panByDragFraction(v, dx / rect.width, dy / rect.height, dims));
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.moved) return; // a drag-pan, not a click → do not inspect
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;
    // A non-square atlas is letterboxed inside the square stage; a click in that margin lands OUTSIDE the
    // canvas box (u or v ∉ [0,1]). Report an honest "no frame here" rather than let the clamp snap the miss to
    // an edge sprite (invariant 3 — never a false location).
    if (!insideUnit(u, v)) {
      const miss: InspectResult = { frame: null, kinds: [] };
      setInspect(miss);
      announce(formatInspect(miss, null, undefined, t));
      return;
    }
    doInspect(u, v);
  };

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

  // The persistent visible inspect readout (interactive only). Before the first inspect it shows the hint; a
  // click/keyboard-select replaces it with REAL facts (frame ordinal/name + w×h + honest anomaly kinds) or the
  // honest "No frame here…". This same string is also announced to SRs via the status live region.
  const inspectText = inspect
    ? formatInspect(inspect, frames?.[inspect.frame ?? -1] ?? null, frameNames?.[inspect.frame ?? -1], t)
    : t('loupe.hint');

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

      {/* LOUPE CONTROLS (interactive only) — a labelled button group. Each button is aria-labelled; the visible
          glyph is decorative (aria-hidden). SPRITE NAV (prev/next) is the mouse-free, SR-safe path to inspect
          EVERY frame (real buttons work in a screen-reader's forms mode; shown only when the atlas has frames).
          The zoom/reset buttons use aria-disabled (NOT native disabled) at their clamp bounds so reaching a
          bound never drops keyboard focus; keyboard +/-/0 on the focused stage mirror them. Rendered ONLY when
          interactive ⇒ the diff-view / landing demo emit nothing here (byte-identical). */}
      {interactive ? (
        <div role="group" aria-label={t('loupe.controls')} className="mb-2 flex items-center gap-1.5 px-1">
          {frames && frames.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => doStepFrame(-1)}
                aria-label={t('loupe.prevSprite')}
                className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-film-border bg-film-2 px-2 font-mono text-sm text-film-soft hover:border-film-soft"
              >
                <span aria-hidden="true">◄</span>
              </button>
              <button
                type="button"
                onClick={() => doStepFrame(1)}
                aria-label={t('loupe.nextSprite')}
                className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-film-border bg-film-2 px-2 font-mono text-sm text-film-soft hover:border-film-soft"
              >
                <span aria-hidden="true">►</span>
              </button>
              <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-film-border" />
            </>
          ) : null}
          <button
            type="button"
            onClick={doZoomOut}
            aria-disabled={view.zoom <= ZOOM_MIN}
            aria-label={t('loupe.zoomOut')}
            className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-film-border bg-film-2 px-2 font-mono text-sm text-film-soft hover:border-film-soft${view.zoom <= ZOOM_MIN ? ' cursor-not-allowed opacity-40' : ''}`}
          >
            <span aria-hidden="true">−</span>
          </button>
          <span aria-hidden="true" className="min-w-[2.5rem] text-center font-mono text-[11px] tabular-nums text-film-soft">
            {view.zoom}×
          </span>
          <button
            type="button"
            onClick={doZoomIn}
            aria-disabled={view.zoom >= ZOOM_MAX}
            aria-label={t('loupe.zoomIn')}
            className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-film-border bg-film-2 px-2 font-mono text-sm text-film-soft hover:border-film-soft${view.zoom >= ZOOM_MAX ? ' cursor-not-allowed opacity-40' : ''}`}
          >
            <span aria-hidden="true">+</span>
          </button>
          <button
            type="button"
            onClick={doReset}
            aria-disabled={isDefaultView(view)}
            aria-label={t('loupe.reset')}
            className={`ml-auto inline-flex h-7 items-center justify-center rounded-md border border-film-border bg-film-2 px-2.5 font-mono text-[11px] text-film-soft hover:border-film-soft${isDefaultView(view) ? ' cursor-not-allowed opacity-40' : ''}`}
          >
            <span aria-hidden="true">⤢</span>
          </button>
        </div>
      ) : null}

      {/* x-ray stage. Interactive: the container becomes a focusable pan/inspect region (keyboard: arrows pan,
          +/- zoom, 0 resets, Enter/Space inspects the crosshair) with a focus-visible ring; the canvas keeps
          role="img"+alt (its picture semantics are never overloaded — the loupe controls are SEPARATE labelled
          controls). Non-interactive: the class string + attributes are byte-identical to today (no handlers,
          no tabindex). image-rendering:pixelated (ad-pixelated) kicks in only when magnified, for crisp texels. */}
      <div
        className={`ad-grid relative aspect-square w-full overflow-hidden rounded-[10px]${interactive ? ' cursor-grab touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-film-soft' : ''}`}
        {...(interactive
          ? {
              role: 'group' as const,
              tabIndex: 0,
              'aria-label': t('loupe.stage'),
              'aria-describedby': instructionsId,
              'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowLeft ArrowRight Plus Minus Enter',
              onKeyDown: onStageKey,
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel: onPointerUp,
              onFocus: () => setFocused(true),
              onBlur: () => setFocused(false),
            }
          : {})}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={altText}
          className={`absolute inset-0 m-auto block max-h-full max-w-full${interactive && view.zoom > 1 ? ' ad-pixelated' : ''}`}
        />
        <div key={name} className="ad-scanline" aria-hidden="true" />
        {/* Crosshair: the fixed keyboard-inspect target + pan reference. Shown while focused or magnified so it
            never clutters the calm fit view. Decorative (aria-hidden) — the inspect RESULT is text below. */}
        {interactive && (focused || view.zoom > 1) ? <span aria-hidden="true" className="ad-loupe-crosshair" /> : null}
      </div>

      {/* LOUPE INSPECT READOUT + a11y plumbing (interactive only). (1) sr-only instructions the stage points to
          via aria-describedby. (2) the persistent VISIBLE inspect line — real facts or the honest "no frame
          here"; NOT a live region (it's steady text sighted keyboard users read). (3) ONE polite status region
          that SPEAKS zoom changes + inspect results (the nudge flips an invisible char so a repeat still
          announces). Color is never the sole signal — the result is TEXT. Nothing here in non-interactive mode. */}
      {interactive ? (
        <>
          <p id={instructionsId} className="ad-sr-only">
            {t('loupe.instructions')}
          </p>
          <p className="mt-2 min-h-[1.25rem] px-1 font-mono text-xs leading-relaxed text-film-soft">{inspectText}</p>
          <span role="status" aria-live="polite" aria-atomic="true" className="ad-sr-only">
            {status.text}
            {status.nudge ? ' ' : ''}
          </span>
        </>
      ) : null}

      {/* readout strip — the static VRAM cell is ALWAYS labelled "vram (declared)" (honesty round,
          item 2): probe or no probe, the value IS the declared w×h×4 estimate from manifest/image
          geometry, never a GPU measurement — the probe-absent bare-"VRAM" label read as measured. */}
      <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
        <ReadCell
          label={t('readout.declared')}
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
            className="mb-1.5 px-1 ad-label-sm text-film-soft"
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
          <div className="mb-1.5 px-1 ad-label-sm text-film-soft">
            {t('readout.breakdown')}
          </div>

          {showMip ? (
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-film-border bg-film-border">
              {/* Same declared quantity as the base cell — same honest label (item 2). */}
              <ReadCell label={t('readout.declared')} value={fmtBytes(m.vramBytes)} color="text-info" />
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
                <dt className="ad-label-sm text-film-soft">
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
    <div className="min-w-0 bg-film px-3 py-2.5" title={title}>
      <div className="ad-label-sm mb-1 break-words leading-tight text-film-soft">{label}</div>
      <div className={`font-mono text-[17px] font-semibold leading-none ${color}`}>{value}</div>
      {sub ? <div className="mt-1 font-mono text-[9px] leading-tight text-film-soft">{sub}</div> : null}
    </div>
  );
}
