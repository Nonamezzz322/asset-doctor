// Exhaustive Node (vitest env=node) tests for the FilmViewer loupe core. apps/web has NO React harness, so
// EVERY load-bearing decision — zoom/pan clamping to image bounds, the screen→image→frame hit-test mapping,
// the keyboard step math, and the honest inspect-readout composition — is proven here. FilmViewer.tsx is a
// thin renderer over these; if this file is green the feature's logic is green.

import { describe, it, expect } from 'vitest';
import type { Finding, Rect } from '@asset-doctor/core';
import {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_FACTOR,
  PAN_FRACTION,
  INITIAL_VIEW,
  clampZoom,
  viewportSize,
  clampView,
  sourceRect,
  zoomAround,
  zoomIn,
  zoomOut,
  panBy,
  panStep,
  screenToImage,
  imageToCanvasRect,
  frameAt,
  kindsAtPoint,
  inspectAt,
  isDefaultView,
  formatInspect,
  insideUnit,
  panByDragFraction,
  frameCenter,
  centerOn,
  stepFrameIndex,
  inspectFrame,
  type LoupeView,
} from './film-loupe';

const IMG = { w: 1024, h: 1024 };
const TOL = 1e-9;

describe('constants', () => {
  it('match the spec', () => {
    expect(ZOOM_MIN).toBe(1);
    expect(ZOOM_MAX).toBe(8);
    expect(ZOOM_FACTOR).toBe(2);
    expect(PAN_FRACTION).toBe(0.2);
    expect(INITIAL_VIEW).toEqual({ zoom: 1, sx: 0, sy: 0 });
  });
});

describe('clampZoom', () => {
  it('below 1 → 1', () => expect(clampZoom(0.5)).toBe(1));
  it('above 8 → 8', () => expect(clampZoom(99)).toBe(8));
  it('in-range identity', () => expect(clampZoom(3)).toBe(3));
  it('exactly 1 / 8 held', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(8)).toBe(8);
  });
  it('NaN → 1', () => expect(clampZoom(Number.NaN)).toBe(1));
  it('+Infinity → 8', () => expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(8));
  it('-Infinity → 1', () => expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(1));
  it('0 → 1', () => expect(clampZoom(0)).toBe(1));
  it('negative → 1', () => expect(clampZoom(-4)).toBe(1));
});

describe('viewportSize', () => {
  it('zoom 1 → full', () => expect(viewportSize(1, IMG)).toEqual({ sw: 1024, sh: 1024 }));
  it('zoom 2 → half', () => expect(viewportSize(2, IMG)).toEqual({ sw: 512, sh: 512 }));
  it('zoom 8 → eighth', () => expect(viewportSize(8, IMG)).toEqual({ sw: 128, sh: 128 }));
  it('non-square', () => expect(viewportSize(2, { w: 800, h: 400 })).toEqual({ sw: 400, sh: 200 }));
});

describe('clampView', () => {
  it('in-bounds unchanged', () => expect(clampView({ zoom: 2, sx: 100, sy: 100 }, IMG)).toEqual({ zoom: 2, sx: 100, sy: 100 }));
  it('sx < 0 → 0', () => expect(clampView({ zoom: 2, sx: -50, sy: 0 }, IMG).sx).toBe(0));
  it('sx > W-sw → W-sw', () => expect(clampView({ zoom: 2, sx: 9999, sy: 0 }, IMG).sx).toBe(512));
  it('sy > H-sh → H-sh', () => expect(clampView({ zoom: 2, sx: 0, sy: 9999 }, IMG).sy).toBe(512));
  it('zoom 1 forces sx=sy=0 (even if given nonzero)', () => expect(clampView({ zoom: 1, sx: 300, sy: 300 }, IMG)).toEqual({ zoom: 1, sx: 0, sy: 0 }));
  it('non-finite sx → 0', () => expect(clampView({ zoom: 2, sx: Number.NaN, sy: 0 }, IMG).sx).toBe(0));
  it('non-finite sy → 0', () => expect(clampView({ zoom: 2, sx: 0, sy: Number.POSITIVE_INFINITY }, IMG).sy).toBe(0));
  it('clamps zoom too', () => expect(clampView({ zoom: 99, sx: 0, sy: 0 }, IMG).zoom).toBe(8));
  it('max at zoom 8 is W-128', () => expect(clampView({ zoom: 8, sx: 5000, sy: 5000 }, IMG)).toEqual({ zoom: 8, sx: 896, sy: 896 }));
});

describe('sourceRect', () => {
  it('is {sx,sy} + viewportSize', () => expect(sourceRect({ zoom: 2, sx: 100, sy: 200 }, IMG)).toEqual({ sx: 100, sy: 200, sw: 512, sh: 512 }));
  it('zoom 1 fit', () => expect(sourceRect(INITIAL_VIEW, IMG)).toEqual({ sx: 0, sy: 0, sw: 1024, sh: 1024 }));
});

describe('zoomAround', () => {
  it('center anchor keeps the mid-image point fixed', () => {
    const before = { zoom: 1, sx: 0, sy: 0 };
    const midX = before.sx + 0.5 * viewportSize(before.zoom, IMG).sw;
    const after = zoomAround(before, 2, 0.5, 0.5, IMG);
    const midXafter = after.sx + 0.5 * viewportSize(after.zoom, IMG).sw;
    expect(Math.abs(midXafter - midX)).toBeLessThan(TOL);
    expect(after).toEqual({ zoom: 2, sx: 256, sy: 256 });
  });
  it('corner anchor (0,0) keeps the top-left ~fixed', () => {
    const after = zoomAround({ zoom: 1, sx: 0, sy: 0 }, 2, 0, 0, IMG);
    expect(after).toEqual({ zoom: 2, sx: 0, sy: 0 });
  });
  it('interior point under an off-center anchor stays fixed (before re-clamp)', () => {
    const before: LoupeView = { zoom: 2, sx: 200, sy: 200 };
    const au = 0.4;
    const av = 0.6;
    const imgX = before.sx + au * viewportSize(before.zoom, IMG).sw;
    const imgY = before.sy + av * viewportSize(before.zoom, IMG).sh;
    const after = zoomAround(before, 4, au, av, IMG);
    const imgXafter = after.sx + au * viewportSize(after.zoom, IMG).sw;
    const imgYafter = after.sy + av * viewportSize(after.zoom, IMG).sh;
    expect(Math.abs(imgXafter - imgX)).toBeLessThan(TOL);
    expect(Math.abs(imgYafter - imgY)).toBeLessThan(TOL);
  });
  it('targetZoom > 8 clamps to 8 and stays in-bounds', () => {
    const after = zoomAround({ zoom: 4, sx: 700, sy: 700 }, 99, 0.5, 0.5, IMG);
    expect(after.zoom).toBe(8);
    expect(after.sx).toBeGreaterThanOrEqual(0);
    expect(after.sx).toBeLessThanOrEqual(1024 - 128);
    expect(after.sy).toBeLessThanOrEqual(1024 - 128);
  });
  it('zoom-out below 1 → fit {1,0,0}', () => expect(zoomAround({ zoom: 2, sx: 300, sy: 300 }, 0.5, 0.5, 0.5, IMG)).toEqual({ zoom: 1, sx: 0, sy: 0 }));
  it('near an edge, the result is re-clamped in-bounds', () => {
    const after = zoomAround({ zoom: 2, sx: 512, sy: 512 }, 4, 1, 1, IMG); // anchor bottom-right at the far corner
    expect(after.sx).toBeLessThanOrEqual(1024 - 256);
    expect(after.sy).toBeLessThanOrEqual(1024 - 256);
    expect(after.sx).toBeGreaterThanOrEqual(0);
  });
});

describe('zoomIn / zoomOut ladders', () => {
  it('zoom-in ladder 1→2→4→8→8', () => {
    let v = INITIAL_VIEW;
    v = zoomIn(v, IMG);
    expect(v.zoom).toBe(2);
    v = zoomIn(v, IMG);
    expect(v.zoom).toBe(4);
    v = zoomIn(v, IMG);
    expect(v.zoom).toBe(8);
    v = zoomIn(v, IMG);
    expect(v.zoom).toBe(8); // clamped ceiling
  });
  it('zoom-out ladder 8→4→2→1→1', () => {
    let v: LoupeView = { zoom: 8, sx: 448, sy: 448 };
    v = zoomOut(v, IMG);
    expect(v.zoom).toBe(4);
    v = zoomOut(v, IMG);
    expect(v.zoom).toBe(2);
    v = zoomOut(v, IMG);
    expect(v.zoom).toBe(1);
    expect(v).toEqual({ zoom: 1, sx: 0, sy: 0 });
    v = zoomOut(v, IMG);
    expect(v.zoom).toBe(1); // clamped floor
  });
  it('every ladder step stays in-bounds', () => {
    let v = INITIAL_VIEW;
    for (let i = 0; i < 5; i++) {
      v = zoomIn(v, IMG);
      const { sw, sh } = viewportSize(v.zoom, IMG);
      expect(v.sx).toBeGreaterThanOrEqual(0);
      expect(v.sx).toBeLessThanOrEqual(IMG.w - sw);
      expect(v.sy).toBeLessThanOrEqual(IMG.h - sh);
    }
  });
});

describe('panBy', () => {
  it('shifts sx by dx then clamps', () => expect(panBy({ zoom: 2, sx: 100, sy: 100 }, 50, -30, IMG)).toEqual({ zoom: 2, sx: 150, sy: 70 }));
  it('zoom 1 stays at 0,0 (nothing off-screen to pan to)', () => expect(panBy({ zoom: 1, sx: 0, sy: 0 }, 200, 200, IMG)).toEqual({ zoom: 1, sx: 0, sy: 0 }));
  it('-dx clamps to 0', () => expect(panBy({ zoom: 2, sx: 10, sy: 10 }, -999, 0, IMG).sx).toBe(0));
  it('+dx past the edge clamps to W-sw', () => expect(panBy({ zoom: 2, sx: 400, sy: 0 }, 999, 0, IMG).sx).toBe(512));
  it('result is always in-bounds', () => {
    const v = panBy({ zoom: 4, sx: 700, sy: 20 }, 999, -999, IMG);
    const { sw, sh } = viewportSize(v.zoom, IMG);
    expect(v.sx).toBeGreaterThanOrEqual(0);
    expect(v.sx).toBeLessThanOrEqual(IMG.w - sw);
    expect(v.sy).toBeGreaterThanOrEqual(0);
    expect(v.sy).toBeLessThanOrEqual(IMG.h - sh);
  });
});

describe('panStep', () => {
  it('dx = (W/zoom) * 0.2 by default', () => expect(panStep({ zoom: 2, sx: 0, sy: 0 }, IMG)).toEqual({ dx: 512 * 0.2, dy: 512 * 0.2 }));
  it('scales with zoom (finer at higher zoom)', () => {
    const s2 = panStep({ zoom: 2, sx: 0, sy: 0 }, IMG).dx;
    const s4 = panStep({ zoom: 4, sx: 0, sy: 0 }, IMG).dx;
    expect(s4).toBeLessThan(s2);
    expect(s4).toBe(256 * 0.2);
  });
  it('custom fraction honored', () => expect(panStep({ zoom: 2, sx: 0, sy: 0 }, IMG, 0.5)).toEqual({ dx: 256, dy: 256 }));
});

describe('screenToImage', () => {
  const V: LoupeView = { zoom: 2, sx: 100, sy: 200 };
  it('(0,0) → top-left of the viewport', () => expect(screenToImage(0, 0, V, IMG)).toEqual({ x: 100, y: 200 }));
  it('(1,1) → bottom-right of the viewport', () => expect(screenToImage(1, 1, V, IMG)).toEqual({ x: 100 + 512, y: 200 + 512 }));
  it('(.5,.5) → center', () => expect(screenToImage(0.5, 0.5, V, IMG)).toEqual({ x: 100 + 256, y: 200 + 256 }));
  it('u<0 clamps to the left edge', () => expect(screenToImage(-1, 0, V, IMG).x).toBe(100));
  it('u>1 clamps to the right edge', () => expect(screenToImage(2, 0, V, IMG).x).toBe(100 + 512));
});

describe('imageToCanvasRect', () => {
  const CW = 380;
  const CH = 380;
  it('zoom 1 reduces to r.x*(cw/W) etc.', () => {
    const r: Rect = { x: 100, y: 200, w: 40, h: 30 };
    const k = CW / IMG.w;
    expect(imageToCanvasRect(r, INITIAL_VIEW, IMG, CW, CH)).toEqual({ x: 100 * k, y: 200 * (CH / IMG.h), w: 40 * k, h: 30 * (CH / IMG.h) });
  });
  it('zoom 2 panned maps correctly', () => {
    const view: LoupeView = { zoom: 2, sx: 100, sy: 100 };
    const r: Rect = { x: 100, y: 100, w: 512, h: 512 }; // exactly the viewport
    // sw=512 → kx = 380/512; the rect starts at the viewport origin → x=0, and spans the full canvas → w=CW.
    const q = imageToCanvasRect(r, view, IMG, CW, CH);
    expect(q.x).toBeCloseTo(0, 9);
    expect(q.y).toBeCloseTo(0, 9);
    expect(q.w).toBeCloseTo(CW, 9);
    expect(q.h).toBeCloseTo(CH, 9);
  });
  it('a rect fully left of the viewport maps to negative x (canvas clips it)', () => {
    const view: LoupeView = { zoom: 2, sx: 512, sy: 0 };
    const r: Rect = { x: 0, y: 0, w: 40, h: 40 };
    expect(imageToCanvasRect(r, view, IMG, CW, CH).x).toBeLessThan(0);
  });
});

describe('frameAt', () => {
  const frames: Rect[] = [
    { x: 0, y: 0, w: 100, h: 100 },
    { x: 200, y: 0, w: 50, h: 50 },
  ];
  it('point inside a frame → its index', () => expect(frameAt({ x: 50, y: 50 }, frames)).toBe(0));
  it('point in the second frame → 1', () => expect(frameAt({ x: 210, y: 10 }, frames)).toBe(1));
  it('gutter between frames → null', () => expect(frameAt({ x: 150, y: 10 }, frames)).toBeNull());
  it('exact top-left edge is included (half-open lower bound)', () => expect(frameAt({ x: 0, y: 0 }, frames)).toBe(0));
  it('exact right edge is excluded (half-open upper bound)', () => expect(frameAt({ x: 100, y: 50 }, frames)).toBeNull());
  it('exact bottom edge is excluded', () => expect(frameAt({ x: 50, y: 100 }, frames)).toBeNull());
  it('synthetic overlap → the FIRST containing frame in order', () => {
    const overlap: Rect[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
    ];
    expect(frameAt({ x: 60, y: 60 }, overlap)).toBe(0);
  });
  it('empty array → null', () => expect(frameAt({ x: 5, y: 5 }, [])).toBeNull());
});

describe('kindsAtPoint', () => {
  const mk = (id: string, kind: 'empty' | 'transparent' | 'bleeding' | 'duplicate-frame', rects: Rect[]): Finding =>
    ({ id, rule: 'occupancy', severity: 'warn', assetRef: 'a', title: '', detail: '', overlay: [{ kind, rects }] }) as Finding;

  it('point inside an empty rect → ["empty"]', () => expect(kindsAtPoint({ x: 10, y: 10 }, [mk('e', 'empty', [{ x: 0, y: 0, w: 50, h: 50 }])])).toEqual(['empty']));
  it('overlapping empty + bleeding → canonical order ["empty","bleeding"]', () => {
    const findings = [
      mk('b', 'bleeding', [{ x: 0, y: 0, w: 100, h: 100 }]),
      mk('e', 'empty', [{ x: 0, y: 0, w: 100, h: 100 }]),
    ];
    expect(kindsAtPoint({ x: 10, y: 10 }, findings)).toEqual(['empty', 'bleeding']); // ZONE_KIND_ORDER, not finding order
  });
  it('a finding with NO overlay is ignored', () => {
    const noOverlay = { id: 'n', rule: 'format', severity: 'info', assetRef: 'a', title: '', detail: '' } as Finding;
    expect(kindsAtPoint({ x: 10, y: 10 }, [noOverlay])).toEqual([]);
  });
  it('the same kind hit by two rects is deduped', () => {
    const f = mk('e', 'empty', [
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 0, y: 0, w: 50, h: 50 },
    ]);
    expect(kindsAtPoint({ x: 5, y: 5 }, [f])).toEqual(['empty']);
  });
  it('point outside all overlay rects → []', () => expect(kindsAtPoint({ x: 999, y: 999 }, [mk('e', 'empty', [{ x: 0, y: 0, w: 50, h: 50 }])])).toEqual([]));
});

describe('inspectAt', () => {
  const frames: Rect[] = [{ x: 0, y: 0, w: 100, h: 100 }];
  const bleeding = { id: 'b', rule: 'bleeding', severity: 'warn', assetRef: 'a', title: '', detail: '', overlay: [{ kind: 'bleeding', rects: [{ x: 0, y: 0, w: 100, h: 100 }] }] } as Finding;
  const emptyZone = { id: 'e', rule: 'occupancy', severity: 'warn', assetRef: 'a', title: '', detail: '', overlay: [{ kind: 'empty', rects: [{ x: 200, y: 200, w: 100, h: 100 }] }] } as Finding;

  it('click on a frame carrying bleeding → {frame:0, kinds:["bleeding"]}', () => {
    const view: LoupeView = { zoom: 1, sx: 0, sy: 0 };
    expect(inspectAt(0.05, 0.05, view, { w: 1000, h: 1000 }, frames, [bleeding])).toEqual({ frame: 0, kinds: ['bleeding'] });
  });
  it('keyboard center (0.5,0.5) at a zoom resolves the center frame', () => {
    const img = { w: 200, h: 200 };
    const centred: Rect[] = [{ x: 80, y: 80, w: 40, h: 40 }]; // straddles the image center (100,100)
    const view = clampView({ zoom: 2, sx: 50, sy: 50 }, img); // viewport 100×100 at (50,50) → center = (100,100)
    expect(inspectAt(0.5, 0.5, view, img, centred, [])).toEqual({ frame: 0, kinds: [] });
  });
  it('a gutter point that sits over an empty zone → {frame:null, kinds:["empty"]}', () => {
    const view: LoupeView = { zoom: 1, sx: 0, sy: 0 };
    // normalized (0.25,0.25) on a 1000² image → (250,250) → inside the empty rect, outside every frame
    expect(inspectAt(0.25, 0.25, view, { w: 1000, h: 1000 }, frames, [emptyZone])).toEqual({ frame: null, kinds: ['empty'] });
  });
  it('a true gutter (no frame, no zone) → {frame:null, kinds:[]}', () => {
    const view: LoupeView = { zoom: 1, sx: 0, sy: 0 };
    expect(inspectAt(0.9, 0.9, view, { w: 1000, h: 1000 }, frames, [emptyZone])).toEqual({ frame: null, kinds: [] });
  });
});

describe('isDefaultView', () => {
  it('{1,0,0} → true', () => expect(isDefaultView({ zoom: 1, sx: 0, sy: 0 })).toBe(true));
  it('zoomed → false', () => expect(isDefaultView({ zoom: 2, sx: 0, sy: 0 })).toBe(false));
  it('panned → false', () => expect(isDefaultView({ zoom: 1, sx: 10, sy: 0 })).toBe(false));
});

describe('formatInspect', () => {
  // Stub t: echoes the key, appending a compact param dump so the composition is observable + assertable.
  const t = (k: string, p?: Record<string, string | number>): string =>
    p ? `${k}|${Object.entries(p).map(([kk, vv]) => `${kk}=${vv}`).join(',')}` : k;
  const rect: Rect = { x: 0, y: 0, w: 64, h: 32 };

  it('frame + no kinds → ordinal "loupe.frame"', () => {
    expect(formatInspect({ frame: 2, kinds: [] }, rect, undefined, t)).toBe('loupe.frame|n=3,w=64,h=32');
  });
  it('frame + name → "loupe.frameNamed" (no ordinal)', () => {
    expect(formatInspect({ frame: 2, kinds: [] }, rect, 'hero.png', t)).toBe('loupe.frameNamed|name=hero.png,w=64,h=32');
  });
  it('empty name falls back to the ordinal', () => {
    expect(formatInspect({ frame: 0, kinds: [] }, rect, '', t)).toBe('loupe.frame|n=1,w=64,h=32');
  });
  it('frame + kinds → base — kind labels joined', () => {
    expect(formatInspect({ frame: 0, kinds: ['empty', 'bleeding'] }, rect, undefined, t)).toBe('loupe.frame|n=1,w=64,h=32 — legend.empty · legend.bleeding');
  });
  it('no frame + kinds → "No sprite here · <kinds>"', () => {
    expect(formatInspect({ frame: null, kinds: ['empty'] }, null, undefined, t)).toBe('loupe.noSpriteHere · legend.empty');
  });
  it('nothing → "loupe.noFrame" (never snaps to a nearest)', () => {
    expect(formatInspect({ frame: null, kinds: [] }, null, undefined, t)).toBe('loupe.noFrame');
  });
  it('frame index present but rect missing → honest no-frame (never claims a size it lacks)', () => {
    expect(formatInspect({ frame: 5, kinds: [] }, null, undefined, t)).toBe('loupe.noFrame');
  });
});

describe('insideUnit — a click must have landed ON the image (letterbox honesty)', () => {
  it('true for interior + all four edges', () => {
    const pts: [number, number][] = [[0.5, 0.5], [0, 0], [1, 1], [0, 1], [1, 0]];
    for (const [u, v] of pts) expect(insideUnit(u, v)).toBe(true);
  });
  it('false when either axis is outside [0,1] (a letterbox click)', () => {
    const pts: [number, number][] = [[-0.01, 0.5], [1.01, 0.5], [0.5, -0.1], [0.5, 1.2]];
    for (const [u, v] of pts) expect(insideUnit(u, v)).toBe(false);
  });
  it('false for non-finite', () => {
    expect(insideUnit(NaN, 0.5)).toBe(false);
    expect(insideUnit(0.5, Infinity)).toBe(false);
  });
});

describe('panByDragFraction — drag delta (fraction of the canvas) → clamped view', () => {
  it('dragging right (+fracX) moves the view LEFT (sx decreases), grab semantics', () => {
    const r = panByDragFraction({ zoom: 2, sx: 200, sy: 200 }, 0.1, 0, IMG); // sw=512 → dx=-51.2
    expect(r.sx).toBeCloseTo(148.8, 6);
    expect(r.sy).toBe(200);
  });
  it('clamps to bounds at the extremes', () => {
    expect(panByDragFraction({ zoom: 2, sx: 200, sy: 200 }, 5, 0, IMG).sx).toBe(0); // huge right-drag → sx floor
    expect(panByDragFraction({ zoom: 2, sx: 200, sy: 200 }, -5, 0, IMG).sx).toBe(512); // maxSx = 1024-512
  });
  it('non-finite fraction ⇒ that axis does not move', () => {
    const r = panByDragFraction({ zoom: 2, sx: 100, sy: 100 }, NaN, 0.1, IMG);
    expect(r.sx).toBe(100);
    expect(r.sy).toBeCloseTo(100 - 0.1 * 512, 6);
  });
});

describe('frameCenter', () => {
  it('is the rect midpoint', () => {
    expect(frameCenter({ x: 10, y: 20, w: 40, h: 60 })).toEqual({ x: 30, y: 50 });
  });
});

describe('centerOn — re-anchor so a point sits at the viewport centre', () => {
  it('centres an interior point at zoom 2', () => {
    const r = centerOn({ x: 512, y: 512 }, { zoom: 2, sx: 0, sy: 0 }, IMG); // sw=512 → sx=512-256
    expect(r).toEqual({ zoom: 2, sx: 256, sy: 256 });
  });
  it('clamps when the point is near an edge', () => {
    expect(centerOn({ x: 0, y: 0 }, { zoom: 2, sx: 300, sy: 300 }, IMG)).toEqual({ zoom: 2, sx: 0, sy: 0 });
    expect(centerOn({ x: 1024, y: 1024 }, { zoom: 2, sx: 0, sy: 0 }, IMG)).toEqual({ zoom: 2, sx: 512, sy: 512 });
  });
  it('at zoom 1 the fit view is forced (centring is a no-op — whole atlas visible)', () => {
    expect(centerOn({ x: 700, y: 700 }, { zoom: 1, sx: 0, sy: 0 }, IMG)).toEqual(INITIAL_VIEW);
  });
});

describe('stepFrameIndex — sprite-cycle wrap (mouse-free path to every frame)', () => {
  it('enters at the first (next) or last (prev) from null/out-of-range', () => {
    expect(stepFrameIndex(null, 3, 1)).toBe(0);
    expect(stepFrameIndex(null, 3, -1)).toBe(2);
    expect(stepFrameIndex(5, 3, 1)).toBe(0);
    expect(stepFrameIndex(-1, 3, -1)).toBe(2);
    expect(stepFrameIndex(1.5, 3, 1)).toBe(0);
  });
  it('advances and wraps', () => {
    expect(stepFrameIndex(0, 3, 1)).toBe(1);
    expect(stepFrameIndex(2, 3, 1)).toBe(0);
    expect(stepFrameIndex(0, 3, -1)).toBe(2);
    expect(stepFrameIndex(1, 3, -1)).toBe(0);
  });
  it('empty ⇒ null', () => {
    expect(stepFrameIndex(null, 0, 1)).toBeNull();
    expect(stepFrameIndex(0, 0, -1)).toBeNull();
  });
});

describe('inspectFrame — inspect a specific frame by index (real facts, honest out-of-range)', () => {
  const frames: Rect[] = [
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 100, y: 100, w: 10, h: 10 },
  ];
  it('returns the frame + the real kinds at its centre', () => {
    const findings = [
      { overlay: [{ kind: 'empty', rects: [{ x: 100, y: 100, w: 10, h: 10 }] }] },
    ] as unknown as Finding[];
    expect(inspectFrame(1, frames, findings)).toEqual({ frame: 1, kinds: ['empty'] });
    expect(inspectFrame(0, frames, findings)).toEqual({ frame: 0, kinds: [] });
  });
  it('out-of-range ⇒ honest no-frame', () => {
    expect(inspectFrame(9, frames, [])).toEqual({ frame: null, kinds: [] });
    expect(inspectFrame(-1, frames, [])).toEqual({ frame: null, kinds: [] });
  });
});
