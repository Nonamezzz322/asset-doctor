import { describe, it, expect } from 'vitest';
import { featureFromDecode, type DecodedImageFeatures } from '../src/decode';

const base: DecodedImageFeatures = {
  dHash: null,
  contentClass: 'unknown',
  solid: false,
  opaque: false,
  meanColor: null,
  scanSkipped: false,
  upscaleDepth: 0,
  premult: null,
  shape: null,
  pixelHash: null,
  w: 0,
  h: 0,
};

describe('featureFromDecode — additive, omit-when-absent (the honesty contract)', () => {
  it('a nothing-measured decode yields only assetRef + contentHash', () => {
    const f = featureFromDecode('a/x.png', 'hash0', base);
    expect(f).toEqual({ assetRef: 'a/x.png', contentHash: 'hash0' });
    // no drift: every optional field stays absent (not a measured 0/false)
    expect('premultipliedEdge' in f).toBe(false);
    expect('alphaShape' in f).toBe(false);
    expect('solid' in f).toBe(false);
    expect('opaque' in f).toBe(false);
    expect('blockUpscaleDepth' in f).toBe(false);
    expect('contentClass' in f).toBe(false);
    expect('dHash' in f).toBe(false);
    expect('meanColor' in f).toBe(false);
    expect('pixelHash' in f).toBe(false);
  });

  it('pixelHash is carried when present (drives loose-in-atlas), absent when null', () => {
    expect('pixelHash' in featureFromDecode('r', 'h', base)).toBe(false);
    expect(featureFromDecode('r', 'h', { ...base, pixelHash: 'abc123' }).pixelHash).toBe('abc123');
  });

  it("contentClass 'unknown' is omitted; a real class is carried", () => {
    expect('contentClass' in featureFromDecode('r', 'h', base)).toBe(false);
    expect(featureFromDecode('r', 'h', { ...base, contentClass: 'photographic' }).contentClass).toBe('photographic');
  });

  it('premultipliedEdge is set ONLY when edgePixels > 0', () => {
    expect('premultipliedEdge' in featureFromDecode('r', 'h', { ...base, premult: { edgePixels: 0, fringeFrac: 0 } })).toBe(false);
    const pe = { edgePixels: 40, fringeFrac: 0.9 };
    expect(featureFromDecode('r', 'h', { ...base, premult: pe }).premultipliedEdge).toBe(pe);
  });

  it('blockUpscaleDepth is set ONLY for a proven upscale (>= 1)', () => {
    expect('blockUpscaleDepth' in featureFromDecode('r', 'h', { ...base, upscaleDepth: 0 })).toBe(false);
    expect(featureFromDecode('r', 'h', { ...base, upscaleDepth: 2 }).blockUpscaleDepth).toBe(2);
  });

  it('alphaShape + meanColor + solid/opaque flags are carried when present', () => {
    const shape = { bboxW: 4, bboxH: 4, interiorTransparent: 3, binaryAlpha: true, opaqueCount: 10 };
    const meanColor = { r: 1, g: 2, b: 3 };
    const f = featureFromDecode('r', 'h', { ...base, solid: true, opaque: true, shape, meanColor, dHash: 'ff00ff00ff00ff00' });
    expect(f.solid).toBe(true);
    expect(f.opaque).toBe(true);
    expect(f.alphaShape).toBe(shape);
    expect(f.meanColor).toBe(meanColor);
    expect(f.dHash).toBe('ff00ff00ff00ff00');
  });
});
