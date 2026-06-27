// Pure edge-extrude (bleed) geometry. For each RECTANGLE blit, replicating the sprite's outermost
// source rows/cols into the symmetric packing gutter (pack.ts T1) kills the bilinear/mipmap seams that
// a bare drawImage leaves in the transparent gutter. This module is the PURE half: it computes the
// drawImage source/dest rectangles ONLY — no canvas, no pixels. The worker turns each descriptor into
// one `drawImage(bmp, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h)` call AFTER the main blit.
//
// Geometry is correct ONLY because each sprite owns a `gutter`-wide band on all four sides (OPTION A,
// pack.ts). The effective extrude is clamped to that band (`effectiveExtrude = min(extrude, gutter)`),
// so a strip never crosses into a neighbor's reservation. Rectangle blits only: meshed (`blit.clip`)
// and rotated blits are NOT extruded (gated by `canExtrude`) and surfaced honestly by the worker.
// Deterministic, integer-only.

import type { Blit, Rect } from '@asset-doctor/core';

/** One drawImage in the worker: copy the `src` slice of the blit's source bitmap onto the `dst` gutter
 *  rect. `kind` is descriptive (for receipts / honest skip notes), never load-bearing. */
export interface ExtrudeRect {
  src: Rect;
  dst: Rect;
  kind: 'top' | 'bottom' | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br';
}

/** The extrude px that actually fits the available symmetric gutter. The gutter is the only room a
 *  sprite owns on each side, so the bleed can never exceed it (no neighbor overwrite). Integer-only;
 *  negatives floored to 0. NOTE: the `2*` factor from the (rejected) asymmetric draft is GONE. */
export function effectiveExtrude(extrude: number, gutter: number): number {
  return Math.max(0, Math.min(Math.floor(extrude), Math.floor(gutter)));
}

/** A blit is extrudable iff it is a plain unrotated rectangle blit. Meshed (`clip`) blits have no
 *  rectangular edge to replicate; rotated blits (`from.rotated` source orientation OR packer
 *  `rotate90`) would need a transformed strip we don't emit in v1. Either ⇒ skip + surface honestly. */
export function canExtrude(blit: Blit): boolean {
  return !(blit.clip && blit.clip.length > 0) && !blit.from.rotated && !blit.rotate90;
}

/**
 * Edge-extrude descriptors for one rectangle blit, given an already-effective `extrude` (px, == the
 * value `effectiveExtrude` returned for this op's gutter) and the bin bounds for clamping.
 *
 * Source slices come from the blit's SOURCE frame (`from.rect`, source-atlas space): the outermost 1px
 * row/col on each side, and the 1×1 corner pixels. Dest rects surround the blit's DESTINATION rect
 * (`to`, dest-atlas space) by `extrude` px, matching `to`'s width/height on the edges so a scaled blit
 * bleeds the same stretch as its body. Every dest rect is clamped to `[0,binW]×[0,binH]` (a gutter band
 * that runs off the sheet — possible at a bin edge — is trimmed; its matching source slice is trimmed
 * proportionally so the copy stays 1:1 at the edge). Zero-area rects are dropped.
 *
 * Order is FIXED (top, bottom, left, right, tl, tr, bl, br) for determinism. `extrude<=0`, meshed, or
 * rotated ⇒ `[]` (the worker still draws the main blit; only the bleed is skipped).
 */
export function extrudePlan(blit: Blit, extrude: number, binW: number, binH: number): ExtrudeRect[] {
  const e = Math.floor(extrude);
  if (e <= 0 || !canExtrude(blit)) return [];

  const sr = blit.from.rect; // source slice geometry (1px edges, 1px corners)
  const to = blit.to; // destination body the gutter wraps

  // Clamp a dest rect to the bin AND trim its source slice by the SAME fraction it was trimmed on each
  // axis, so an edge-of-sheet band still samples the matching part of the source edge (copy stays 1:1).
  const clamp = (kind: ExtrudeRect['kind'], src: Rect, dst: Rect): ExtrudeRect | null => {
    const x0 = Math.max(0, dst.x);
    const y0 = Math.max(0, dst.y);
    const x1 = Math.min(binW, dst.x + dst.w);
    const y1 = Math.min(binH, dst.y + dst.h);
    const dw = x1 - x0;
    const dh = y1 - y0;
    if (dw <= 0 || dh <= 0) return null;
    // proportional source trim (integer); dst.w/h are >0 here (callers pass positive rects).
    const fxL = (x0 - dst.x) / dst.w;
    const fxR = (dst.x + dst.w - x1) / dst.w;
    const fyT = (y0 - dst.y) / dst.h;
    const fyB = (dst.y + dst.h - y1) / dst.h;
    const sx = src.x + Math.round(src.w * fxL);
    const sy = src.y + Math.round(src.h * fyT);
    const sw = Math.max(1, src.w - Math.round(src.w * (fxL + fxR)));
    const sh = Math.max(1, src.h - Math.round(src.h * (fyT + fyB)));
    return { kind, src: { x: sx, y: sy, w: sw, h: sh }, dst: { x: x0, y: y0, w: dw, h: dh } };
  };

  // Source edge slices (1px) and corner pixels, in source-atlas space.
  const topRow: Rect = { x: sr.x, y: sr.y, w: sr.w, h: 1 };
  const botRow: Rect = { x: sr.x, y: sr.y + sr.h - 1, w: sr.w, h: 1 };
  const leftCol: Rect = { x: sr.x, y: sr.y, w: 1, h: sr.h };
  const rightCol: Rect = { x: sr.x + sr.w - 1, y: sr.y, w: 1, h: sr.h };
  const tlPx: Rect = { x: sr.x, y: sr.y, w: 1, h: 1 };
  const trPx: Rect = { x: sr.x + sr.w - 1, y: sr.y, w: 1, h: 1 };
  const blPx: Rect = { x: sr.x, y: sr.y + sr.h - 1, w: 1, h: 1 };
  const brPx: Rect = { x: sr.x + sr.w - 1, y: sr.y + sr.h - 1, w: 1, h: 1 };

  // Dest gutter bands around `to` (dest-atlas space): edges span to.w/to.h, corners are e×e.
  const candidates: { kind: ExtrudeRect['kind']; src: Rect; dst: Rect }[] = [
    { kind: 'top', src: topRow, dst: { x: to.x, y: to.y - e, w: to.w, h: e } },
    { kind: 'bottom', src: botRow, dst: { x: to.x, y: to.y + to.h, w: to.w, h: e } },
    { kind: 'left', src: leftCol, dst: { x: to.x - e, y: to.y, w: e, h: to.h } },
    { kind: 'right', src: rightCol, dst: { x: to.x + to.w, y: to.y, w: e, h: to.h } },
    { kind: 'tl', src: tlPx, dst: { x: to.x - e, y: to.y - e, w: e, h: e } },
    { kind: 'tr', src: trPx, dst: { x: to.x + to.w, y: to.y - e, w: e, h: e } },
    { kind: 'bl', src: blPx, dst: { x: to.x - e, y: to.y + to.h, w: e, h: e } },
    { kind: 'br', src: brPx, dst: { x: to.x + to.w, y: to.y + to.h, w: e, h: e } },
  ];

  const out: ExtrudeRect[] = [];
  for (const c of candidates) {
    const r = clamp(c.kind, c.src, c.dst);
    if (r) out.push(r);
  }
  return out;
}
