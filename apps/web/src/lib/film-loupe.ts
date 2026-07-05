// PURE, Node-testable core for the FilmViewer LOUPE (zoom + pan + click/keyboard inspect). apps/web has NO
// React test harness (vitest env=node, no jsdom/testing-library), so ALL decision logic — zoom clamping, pan
// clamping to image bounds, the screen→image→frame hit-test coordinate mapping, and the keyboard step math —
// lives here and is exhaustively unit-tested (same discipline as film-selection.ts / film-legend.ts). The
// FilmViewer JSX stays a THIN renderer that calls these total functions; it invents NOTHING.
//
// HONESTY (invariant 3): the loupe surfaces only REAL parsed facts. `frameAt` maps a point to a real packed
// rect index (or null — never snaps to a false nearest); `kindsAtPoint` reports only the real overlay-rect
// kinds genuinely under the point, in the fixed legend order; `formatInspect` composes those with honest
// fallbacks ("No frame here…" / "No sprite here · <kind>"). No fabricated measurements ever enter here.
//
// Every producer (`clampView`, `zoomAround`, `zoomIn/Out`, `panBy`) returns an ALREADY-CLAMPED LoupeView, so
// the component can trust the state is always in-bounds. All functions are total + finite-guarded.

import type { Finding, OverlayZone, Rect } from '@asset-doctor/core';
import { ZONE_KIND_ORDER, legendLabelKey } from './film-legend';

/** Native atlas dimensions (the decoded bitmap's width/height, in image pixels). */
export interface ImgDims {
  w: number;
  h: number;
}

/** The loupe view: `zoom` ≥ 1 is the magnification (1 = fit); `sx`,`sy` are the source viewport's TOP-LEFT
 *  corner in IMAGE pixels. The visible source rect is { sx, sy, w/zoom, h/zoom }. Always kept clamped. */
export interface LoupeView {
  zoom: number;
  sx: number;
  sy: number;
}

/** A point in IMAGE pixel space. */
export interface Pt {
  x: number;
  y: number;
}

/** The result of an inspect: the real frame index under the point (null ⇒ no sprite there — honest), plus the
 *  distinct overlay kinds genuinely under the point, in the fixed legend order. */
export interface InspectResult {
  frame: number | null;
  kinds: OverlayZone['kind'][];
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8; // matches the spec's suggested 1..8
export const ZOOM_FACTOR = 2; // button/key step ladder: 1→2→4→8
export const PAN_FRACTION = 0.2; // keyboard arrow = 20% of the visible extent
export const INITIAL_VIEW: LoupeView = { zoom: ZOOM_MIN, sx: 0, sy: 0 };

/** Clamp an arbitrary number into [0,1], mapping non-finite → 0. Used for normalized anchors / click coords. */
function clamp01(u: number): number {
  if (!Number.isFinite(u)) return 0;
  if (u < 0) return 0;
  if (u > 1) return 1;
  return u;
}

/** Clamp a value into [lo, hi]; non-finite → lo (the safe floor, always 0 here). */
function clampTo(val: number, lo: number, hi: number): number {
  if (!Number.isFinite(val)) return lo;
  if (val < lo) return lo;
  if (val > hi) return hi;
  return val;
}

/** Zoom clamp: NaN → 1; +Inf → 8; -Inf / 0 / negatives → 1; in-range identity. */
export function clampZoom(z: number): number {
  if (Number.isNaN(z)) return ZOOM_MIN;
  if (z >= ZOOM_MAX) return ZOOM_MAX; // +Inf lands here too
  if (z <= ZOOM_MIN) return ZOOM_MIN; // -Inf / 0 / negatives land here
  return z;
}

/** The visible source-viewport size in image pixels at `zoom` (assumed already clamped by the caller). */
export function viewportSize(zoom: number, img: ImgDims): { sw: number; sh: number } {
  return { sw: img.w / zoom, sh: img.h / zoom };
}

/** THE normalizer: clamp zoom, then clamp sx∈[0,W-sw], sy∈[0,H-sh]; non-finite sx/sy → 0; zoom==1 ⇒ sx=sy=0
 *  (fit view is always top-left-anchored, nothing off-screen). Every producer routes through this. */
export function clampView(v: LoupeView, img: ImgDims): LoupeView {
  const zoom = clampZoom(v.zoom);
  if (zoom === ZOOM_MIN) return { zoom: ZOOM_MIN, sx: 0, sy: 0 };
  const { sw, sh } = viewportSize(zoom, img);
  const maxSx = Math.max(0, img.w - sw);
  const maxSy = Math.max(0, img.h - sh);
  return { zoom, sx: clampTo(v.sx, 0, maxSx), sy: clampTo(v.sy, 0, maxSy) };
}

/** The source rect for ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, cw, ch): {sx,sy} verbatim + viewportSize. */
export function sourceRect(v: LoupeView, img: ImgDims): { sx: number; sy: number; sw: number; sh: number } {
  const { sw, sh } = viewportSize(v.zoom, img);
  return { sx: v.sx, sy: v.sy, sw, sh };
}

/** Zoom to `targetZoom` while keeping the IMAGE point currently under the normalized anchor (anchorU,anchorV)
 *  fixed under that same anchor. Returns a clampView'd result (re-anchors to stay in-bounds near an edge). */
export function zoomAround(
  v: LoupeView,
  targetZoom: number,
  anchorU: number,
  anchorV: number,
  img: ImgDims,
): LoupeView {
  const z = clampZoom(targetZoom);
  const au = clamp01(anchorU);
  const av = clamp01(anchorV);
  const { sw: swOld, sh: shOld } = viewportSize(clampZoom(v.zoom), img);
  // The image point currently under the anchor.
  const imgX = v.sx + au * swOld;
  const imgY = v.sy + av * shOld;
  const { sw: swNew, sh: shNew } = viewportSize(z, img);
  // Solve for the new top-left so the same image point stays under the same anchor.
  return clampView({ zoom: z, sx: imgX - au * swNew, sy: imgY - av * shNew }, img);
}

/** Zoom-in one step (×FACTOR), anchored at the viewport center. */
export function zoomIn(v: LoupeView, img: ImgDims): LoupeView {
  return zoomAround(v, v.zoom * ZOOM_FACTOR, 0.5, 0.5, img);
}

/** Zoom-out one step (÷FACTOR), anchored at the viewport center. */
export function zoomOut(v: LoupeView, img: ImgDims): LoupeView {
  return zoomAround(v, v.zoom / ZOOM_FACTOR, 0.5, 0.5, img);
}

/** Pan by (dxImg, dyImg) IMAGE pixels, then re-clamp to bounds. */
export function panBy(v: LoupeView, dxImg: number, dyImg: number, img: ImgDims): LoupeView {
  return clampView({ zoom: v.zoom, sx: v.sx + dxImg, sy: v.sy + dyImg }, img);
}

/** The keyboard-arrow pan step in image pixels = viewportSize × fraction. Smaller step at higher zoom (finer
 *  control), which is the honest behavior for inspecting a tiny sprite. */
export function panStep(v: LoupeView, img: ImgDims, fraction: number = PAN_FRACTION): { dx: number; dy: number } {
  const { sw, sh } = viewportSize(clampZoom(v.zoom), img);
  return { dx: sw * fraction, dy: sh * fraction };
}

/** Map a normalized viewport coord (u,v)∈[0,1] (clamped) to an IMAGE-pixel point: x = sx + u·sw. */
export function screenToImage(u: number, v: number, view: LoupeView, img: ImgDims): Pt {
  const { sw, sh } = viewportSize(clampZoom(view.zoom), img);
  return { x: view.sx + clamp01(u) * sw, y: view.sy + clamp01(v) * sh };
}

/** True iff a normalized click (u,v) actually landed ON the image (both in [0,1]); non-finite ⇒ false. A click
 *  in the LETTERBOX around a non-square atlas gives u or v outside [0,1] — the caller reports an honest
 *  "no frame here" instead of letting screenToImage's clamp snap the miss to an edge sprite (invariant 3). */
export function insideUnit(u: number, v: number): boolean {
  return Number.isFinite(u) && Number.isFinite(v) && u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

/** Drag-pan by a SCREEN-space delta expressed as a fraction of the displayed canvas (fracX = dx/rectWidth).
 *  The screen→image-pixel scale (× the visible source extent) + the drag→view sign inversion + the clamp all
 *  live HERE (the last bit of pan math that used to sit inline in the pointer handler); the component only
 *  supplies the two DOM fractions. Non-finite fraction ⇒ that axis does not move. */
export function panByDragFraction(v: LoupeView, fracX: number, fracY: number, img: ImgDims): LoupeView {
  const { sw, sh } = viewportSize(clampZoom(v.zoom), img);
  const dx = Number.isFinite(fracX) ? fracX : 0;
  const dy = Number.isFinite(fracY) ? fracY : 0;
  return panBy(v, -dx * sw, -dy * sh, img);
}

/** Map an IMAGE-space rect to CANVAS coords for the overlay paint loop. The visible source rect maps onto the
 *  full canvas (cw×ch), so kx = cw/sw, ky = ch/sh. At zoom=1 (sx=sy=0, sw=W, sh=H) this reduces to the legacy
 *  r.x·(cw/W) mapping — the non-interactive path stays visually identical. Rects outside the viewport map to
 *  negative / overflow coords, which the canvas clips — correct, we never move a rect to keep it on-screen. */
export function imageToCanvasRect(
  r: Rect,
  view: LoupeView,
  img: ImgDims,
  cw: number,
  ch: number,
): { x: number; y: number; w: number; h: number } {
  const { sx, sy, sw, sh } = sourceRect(view, img);
  const kx = cw / sw;
  const ky = ch / sh;
  return { x: (r.x - sx) * kx, y: (r.y - sy) * ky, w: r.w * kx, h: r.h * ky };
}

/** The FIRST frame whose packed rect contains `pt`, using HALF-OPEN bounds x∈[fx,fx+fw), y∈[fy,fy+fh) so a
 *  point on a shared right/bottom edge belongs to exactly one frame. The packer guarantees non-overlapping
 *  frames ⇒ "first" is unambiguous in practice. Empty array or a gutter point ⇒ null (honest — no snapping). */
export function frameAt(pt: Pt, frames: Rect[]): number | null {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (pt.x >= f.x && pt.x < f.x + f.w && pt.y >= f.y && pt.y < f.y + f.h) return i;
  }
  return null;
}

/** The DISTINCT overlay kinds whose rect genuinely contains `pt`, in the fixed canonical legend order
 *  (ZONE_KIND_ORDER). Findings with no overlay are ignored; duplicate kinds are collapsed; a point outside all
 *  overlay rects yields []. This is a real containment test over the measured overlay rects — never invented. */
export function kindsAtPoint(pt: Pt, findings: Finding[]): OverlayZone['kind'][] {
  const present = new Set<OverlayZone['kind']>();
  for (const f of findings) {
    for (const z of f.overlay ?? []) {
      for (const r of z.rects) {
        if (pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h) {
          present.add(z.kind);
          break; // one hit is enough to mark the kind present
        }
      }
    }
  }
  return ZONE_KIND_ORDER.filter((k) => present.has(k));
}

/** THE single inspect entry the component calls — for a mouse click pass the normalized click (u,v); for a
 *  keyboard inspect pass the viewport center (0.5, 0.5). Returns the real frame index (or null) + the real
 *  kinds at that image point. Pure composition of screenToImage + frameAt + kindsAtPoint. */
export function inspectAt(
  u: number,
  v: number,
  view: LoupeView,
  img: ImgDims,
  frames: Rect[],
  findings: Finding[],
): InspectResult {
  const pt = screenToImage(u, v, view, img);
  return { frame: frameAt(pt, frames), kinds: kindsAtPoint(pt, findings) };
}

/** The center of a packed frame rect, in IMAGE pixels — the point the sprite-cycle inspect/centre uses. */
export function frameCenter(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Re-anchor the view so IMAGE point `pt` sits at the viewport centre (keeping the current zoom), clamped to
 *  bounds. At zoom 1 clampView forces the fit view ⇒ centring is a no-op (the whole atlas is already visible). */
export function centerOn(pt: Pt, view: LoupeView, img: ImgDims): LoupeView {
  const { sw, sh } = viewportSize(clampZoom(view.zoom), img);
  return clampView({ zoom: view.zoom, sx: pt.x - sw / 2, sy: pt.y - sh / 2 }, img);
}

/** The next frame index when cycling the sprite inspector by keyboard/button (dir +1 next, −1 prev), wrapping
 *  at the ends. `null`/out-of-range current ⇒ enter at the first (next) or last (prev) frame. Empty ⇒ null.
 *  This is the mouse-free path to EVERY sprite regardless of zoom/pan (fixes the edge-sprite keyboard gap). */
export function stepFrameIndex(current: number | null, len: number, dir: 1 | -1): number | null {
  if (len <= 0) return null;
  if (current === null || !Number.isInteger(current) || current < 0 || current >= len) {
    return dir === 1 ? 0 : len - 1;
  }
  return (current + dir + len) % len;
}

/** Inspect a specific frame by index (the sprite-cycle path): the real frame + the real overlay kinds at its
 *  centre. Out-of-range ⇒ honest no-frame. Same InspectResult shape a click produces — never fabricated. */
export function inspectFrame(i: number, frames: Rect[], findings: Finding[]): InspectResult {
  const f = frames[i];
  if (!f) return { frame: null, kinds: [] };
  return { frame: i, kinds: kindsAtPoint(frameCenter(f), findings) };
}

/** True when the view is the untouched fit view (Reset button is disabled in this state). */
export function isDefaultView(v: LoupeView): boolean {
  return v.zoom === ZOOM_MIN && v.sx === 0 && v.sy === 0;
}

/** Compose the human-readable inspect readout from REAL facts only, with honest fallbacks. `t` is injected so
 *  this stays pure + Node-testable (the filmAltText precedent). Kind labels reuse the SAME legend keys the
 *  overlay legend paints (via legendLabelKey), so the loupe can never drift from the legend.
 *
 *  - frame present + name → "<name> · W×H"; else the ordinal "Frame N · W×H". If kinds are present, append
 *    " — <kind> · <kind>".
 *  - frame absent + kinds present → "No sprite here · <kind>" (e.g. a click in a measured empty region: there
 *    is no sprite, but "empty" IS real there — we report it honestly).
 *  - both absent → "No frame here — padding or gutter." NEVER snaps to a nearest frame. */
export function formatInspect(
  res: InspectResult,
  rect: Rect | null,
  name: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const kindsSuffix = res.kinds.length > 0 ? res.kinds.map((k) => t(legendLabelKey(k))).join(' · ') : '';
  if (res.frame !== null && rect) {
    const base =
      name !== undefined && name !== ''
        ? t('loupe.frameNamed', { name, w: rect.w, h: rect.h })
        : t('loupe.frame', { n: res.frame + 1, w: rect.w, h: rect.h });
    return kindsSuffix ? `${base} — ${kindsSuffix}` : base;
  }
  if (kindsSuffix) return `${t('loupe.noSpriteHere')} · ${kindsSuffix}`;
  return t('loupe.noFrame');
}
