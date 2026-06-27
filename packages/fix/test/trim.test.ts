// PURE golden coverage for the Feature 4 trim module (design §11.1). trim.ts is the SINGLE place the
// Spine Y-flip lives, so pinning the three exported functions here means the alpha-bbox → trim-metadata
// math (and the static-top-left vs spine-bottom-left asymmetry) can't drift. No canvas: the worker hands
// the pixels in as an RGBASource (the same contract mask/mesh use). All inputs are integer-only.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type { RGBASource } from '../src/index';
import { alphaBBox, spriteSourceSizeFrom, spineOffsetFrom } from '../src/index';

const fixDir = fileURLToPath(new URL('../../../fixtures/sample-projects/', import.meta.url));

/** Decode a fixture PNG to the RGBASource the worker would hand `alphaBBox` (whole image at origin). The
 *  loose fixtures encode a fully-transparent margin (alpha 0) around an opaque inner rect (alpha 255), so
 *  the recovered bbox is EXACTLY the authored {x:mx, y:my, w:bw, h:bh}. */
function decodeSource(relPath: string): { src: RGBASource; w: number; h: number } {
  const png = PNG.sync.read(readFileSync(`${fixDir}${relPath}`));
  return { src: { data: new Uint8ClampedArray(png.data), width: png.width }, w: png.width, h: png.height };
}

describe('alphaBBox — exact opaque bbox from a margined buffer (§11.1)', () => {
  // (mx, my, bw, bh) authored by the generator (fixtures/_generator/generate.mjs Case 10/11).
  it.each([
    ['loose-static/coin.png', 64, 64, { x: 8, y: 8, w: 48, h: 48 }],
    ['loose-static/key.png', 80, 40, { x: 10, y: 4, w: 60, h: 32 }],
    ['loose-static/potion.png', 48, 96, { x: 6, y: 12, w: 36, h: 72 }],
    ['loose-static/ring.png', 40, 40, { x: 4, y: 4, w: 32, h: 32 }],
    ['loose-static/shield.png', 72, 72, { x: 4, y: 8, w: 64, h: 56 }],
    ['loose-static/sword.png', 32, 120, { x: 8, y: 0, w: 16, h: 120 }],
    ['loose-static/icons/star.png', 32, 32, { x: 2, y: 2, w: 28, h: 28 }],
    ['spine-loose/cape.png', 80, 100, { x: 10, y: 20, w: 60, h: 60 }], // asymmetric → exercises the Y-flip
  ])('%s → bbox %o', (rel, _w, _h, expected) => {
    const { src, w, h } = decodeSource(rel as string);
    expect(alphaBBox(src, { x: 0, y: 0, w, h })).toEqual(expected);
  });

  it('a fully-OPAQUE image returns the whole-image rect (never null)', () => {
    const { src, w, h } = decodeSource('loose-static/gem.png'); // 64×64 full opaque
    expect(alphaBBox(src, { x: 0, y: 0, w, h })).toEqual({ x: 0, y: 0, w: 64, h: 64 });
  });

  it('a fully-TRANSPARENT image returns null (caller decides sentinel/skip)', () => {
    const { src, w, h } = decodeSource('loose-static/blank.png'); // 50×50 fully transparent
    expect(alphaBBox(src, { x: 0, y: 0, w, h })).toBeNull();
  });

  it('respects the region rect (sub-window of the source), not the whole buffer', () => {
    // coin: opaque inner rect is [8,8,48,48]. A region that starts at (16,16) clips the bbox to the
    // window-local opaque extent: x/y become 0 (the inner rect already covers the window's top-left),
    // w/h shrink to what remains inside the window.
    const { src } = decodeSource('loose-static/coin.png');
    const sub = alphaBBox(src, { x: 16, y: 16, w: 24, h: 24 });
    expect(sub).toEqual({ x: 0, y: 0, w: 24, h: 24 }); // window fully inside the opaque inner rect
  });

  it('a region landing entirely in the transparent margin returns null', () => {
    const { src } = decodeSource('loose-static/coin.png'); // margin = the outer 8px ring
    expect(alphaBBox(src, { x: 0, y: 0, w: 4, h: 4 })).toBeNull();
  });
});

describe('spriteSourceSizeFrom — TexturePacker TOP-LEFT (no flip) (§11.1)', () => {
  it('is the opaque bbox verbatim (TP convention, no Y-flip)', () => {
    expect(spriteSourceSizeFrom({ w: 64, h: 64 }, { x: 8, y: 8, w: 48, h: 48 })).toEqual({ x: 8, y: 8, w: 48, h: 48 });
  });

  it('is independent of sourceSize (TP needs no flip)', () => {
    const bbox = { x: 10, y: 4, w: 60, h: 32 };
    expect(spriteSourceSizeFrom({ w: 80, h: 40 }, bbox)).toEqual(spriteSourceSizeFrom({ w: 999, h: 999 }, bbox));
  });
});

describe('spineOffsetFrom — libGDX BOTTOM-LEFT (the ONLY Y-flip) (§11.1)', () => {
  it('offsetX = bbox.x; offsetY = sourceSize.h - (bbox.y + bbox.h)', () => {
    // cape: source 80×100, bbox {x:10,y:20,w:60,h:60} → offsetY = 100 - (20+60) = 20.
    expect(spineOffsetFrom({ w: 80, h: 100 }, { x: 10, y: 20, w: 60, h: 60 })).toEqual({ x: 10, y: 20 });
  });

  it('a top-flush bbox flips to a bottom margin (Y-flip is real, not identity)', () => {
    // bbox flush to the TOP (y:0, h:56) of an 80-tall source → bottom-left offsetY = 80 - 56 = 24.
    expect(spineOffsetFrom({ w: 64, h: 80 }, { x: 0, y: 0, w: 64, h: 56 })).toEqual({ x: 0, y: 24 });
  });

  it('a bottom-flush bbox flips to offsetY 0', () => {
    expect(spineOffsetFrom({ w: 64, h: 80 }, { x: 0, y: 24, w: 64, h: 56 })).toEqual({ x: 0, y: 0 });
  });

  it('a vertically-centered bbox: offsetY equals the symmetric bottom margin', () => {
    // head: source 64×64, bbox {x:4,y:4,w:56,h:56} → offsetY = 64 - (4+56) = 4 (== top margin, symmetric).
    expect(spineOffsetFrom({ w: 64, h: 64 }, { x: 4, y: 4, w: 56, h: 56 })).toEqual({ x: 4, y: 4 });
  });
});
