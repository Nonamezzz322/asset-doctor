import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PNG, type PNGImage } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { ContentClass } from '@asset-doctor/core';
import { frameRedundancyFinding, trimMarginFinding, crossAtlasRedundancyFinding, DEFAULT_THRESHOLDS } from '@asset-doctor/analysis';
import { alphaBBox, emitTexturePackerJson, repackAtlases } from '@asset-doctor/fix';
import { parseAtlas, parseAtlasManifest } from '@asset-doctor/parsers';
import {
  alphaFullyOpaque,
  classifyContent,
  dHashFromGray,
  extractFrameRegions,
  grayStdDev,
  hasHardAlpha,
  hashFrameRegions,
  isFlat,
  isSolidColor,
  isSolidFullRes,
  luma,
  meanColorFromSample,
  FLAT_STD,
  FRAME_HASH_MAX_PX,
  FRAME_HASH_MAX_SPRITES,
  SOLID_FULL_TOL,
  SOLID_STD,
  type FrameRect,
} from './perceptual';

const N = 9 * 8; // 72 samples — the 9×8 dHash grid
const DW = 9;
const DH = 8;

/** Build a 72-px RGBA buffer (interleaved) from per-pixel [r,g,b,a] via a generator. */
function rgba(gen: (i: number) => [number, number, number, number]): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const [r, g, b, a] = gen(i);
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

/** Gray array from an RGBA buffer via the same luma the worker uses. */
function grayOf(buf: Uint8ClampedArray): number[] {
  const g: number[] = [];
  for (let p = 0; p < buf.length / 4; p++) g.push(luma(buf, p * 4));
  return g;
}

describe('grayStdDev / isFlat (unchanged)', () => {
  it('a uniform sample has ~0 std dev and reads flat', () => {
    const g = Array(N).fill(128);
    expect(grayStdDev(g)).toBeCloseTo(0);
    expect(isFlat(g)).toBe(true);
    expect(dHashFromGray(g)).toHaveLength(16);
  });
});

describe('meanColorFromSample (alpha-weighted mean color — duplicate-similar color guard)', () => {
  it('fully-transparent pixels carrying garbage RGB do NOT poison the mean (alpha-weighting)', () => {
    // Half opaque pure red, half fully-transparent with arbitrary decoded RGB (canvas un-premultiply noise).
    const buf = rgba((i) => (i < N / 2 ? [255, 0, 0, 255] : [13, 200, 77, 0]));
    const mc = meanColorFromSample(buf)!;
    expect(mc.r).toBe(255);
    expect(mc.g).toBe(0);
    expect(mc.b).toBe(0);
  });

  it('Σalpha === 0 ⇒ null (fully transparent — nothing to measure, never a fabricated color)', () => {
    expect(meanColorFromSample(rgba(() => [50, 60, 70, 0]))).toBeNull();
    expect(meanColorFromSample(new Uint8ClampedArray(0))).toBeNull(); // empty buffer too
  });

  it('weighted math is exact: (255,255,255,α255) + (0,0,0,α51) ⇒ 65025/306 = 212.5 per channel', () => {
    const buf = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 51]);
    const mc = meanColorFromSample(buf)!;
    expect(mc.r).toBe(212.5);
    expect(mc.g).toBe(212.5);
    expect(mc.b).toBe(212.5);
  });
});

describe('hasHardAlpha (histogram pole occupancy — resample-robust)', () => {
  it('both poles populated ⇒ true (a hard cutout: half opaque, half clear)', () => {
    // Even after a 9×8 bilinear resample smears SOME edge pixels into a mid-alpha ramp, a real icon
    // keeps large opaque AND clear regions — model that: 40% opaque, 40% clear, 20% mid ramp.
    const buf = rgba((i) => {
      if (i < N * 0.4) return [200, 50, 50, 255]; // opaque body
      if (i < N * 0.8) return [0, 0, 0, 0]; // clear background
      return [200, 50, 50, 128]; // smeared edge ramp (mid band)
    });
    expect(hasHardAlpha(buf)).toBe(true);
  });

  it('opaque-only (no transparency) ⇒ false', () => {
    expect(hasHardAlpha(rgba(() => [120, 120, 120, 255]))).toBe(false);
  });

  it('soft vignette (mostly mid-band alpha) ⇒ false', () => {
    // A radial fade: alpha ramps 0..255 across the grid → most samples land in the mid band, neither
    // pole reaches minPole. (A few endpoints touch the poles, but well under the 12% gate.)
    const buf = rgba((i) => {
      const a = Math.round((i / (N - 1)) * 255);
      return [80, 80, 80, a];
    });
    expect(hasHardAlpha(buf)).toBe(false);
  });

  it('empty buffer ⇒ false', () => {
    expect(hasHardAlpha(new Uint8ClampedArray(0))).toBe(false);
  });
});

describe('isSolidColor (single-color / fully transparent detector)', () => {
  it('a uniform opaque sample ⇒ solid (every per-channel stdDev 0 < SOLID_STD)', () => {
    expect(SOLID_STD).toBe(2);
    const buf = rgba(() => [40, 110, 170, 255]);
    expect(isSolidColor(grayOf(buf), buf)).toBe(true);
  });

  it('a fully-transparent sample ⇒ solid (no variance on any channel)', () => {
    const buf = rgba(() => [0, 0, 0, 0]);
    expect(isSolidColor(grayOf(buf), buf)).toBe(true);
  });

  it('a single differing corner pixel ⇒ NOT solid (one channel exceeds SOLID_STD)', () => {
    // 71 of 72 pixels one color, the corner a strongly different color → per-channel stdDev > 2.
    const buf = rgba((i) => (i === 0 ? [255, 0, 0, 255] : [40, 110, 170, 255]));
    expect(isSolidColor(grayOf(buf), buf)).toBe(false);
  });

  it('two chromatic colors at EQUAL luma ⇒ NOT solid (R/G/B catch what gray misses)', () => {
    // Pick two colors with (near) identical luma but different R/G/B so grayStdDev alone would pass.
    // luma = .299R + .587G + .114B. [128,128,128] vs a chroma swing about it at matched luma.
    const a: [number, number, number, number] = [180, 110, 80, 255];
    const b: [number, number, number, number] = [40, 160, 190, 255];
    const la = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
    const lb = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
    expect(Math.abs(la - lb)).toBeLessThan(2); // luma nearly equal — gray would (almost) pass
    const buf = rgba((i) => (i % 2 === 0 ? a : b));
    expect(grayStdDev(grayOf(buf))).toBeLessThan(SOLID_STD); // gray alone wouldn't flag it
    expect(isSolidColor(grayOf(buf), buf)).toBe(false); // but the R/G/B channels do
  });

  it('a same-color alpha ramp ⇒ NOT solid (alpha channel variance)', () => {
    const buf = rgba((i) => [100, 100, 100, Math.round((i / (N - 1)) * 255)]);
    expect(isSolidColor(grayOf(buf), buf)).toBe(false);
  });

  it('a smooth luminance gradient ⇒ NOT solid', () => {
    const buf = rgba((i) => {
      const v = Math.round((i / (N - 1)) * 255);
      return [v, v, v, 255];
    });
    expect(isSolidColor(grayOf(buf), buf)).toBe(false);
  });

  it('an empty / short sample ⇒ NOT solid (below sample resolution)', () => {
    expect(isSolidColor([], new Uint8ClampedArray(0))).toBe(false);
    expect(isSolidColor([1, 2, 3], new Uint8ClampedArray([1, 2]))).toBe(false);
  });
});

describe('alphaFullyOpaque (full-frame opaque scan — wasted-alpha detector)', () => {
  it('every pixel alpha 255 ⇒ true (a dead alpha channel)', () => {
    expect(alphaFullyOpaque(rgba(() => [10, 20, 30, 255]))).toBe(true);
  });

  it('one single non-opaque pixel ⇒ false (short-circuits; transparency is real)', () => {
    expect(alphaFullyOpaque(rgba((i) => (i === N - 1 ? [0, 0, 0, 0] : [10, 20, 30, 255])))).toBe(false);
    // 254 is NOT opaque — a real, used alpha channel, never "dead"
    expect(alphaFullyOpaque(rgba((i) => (i === 0 ? [10, 20, 30, 254] : [10, 20, 30, 255])))).toBe(false);
  });

  it('a fully-transparent buffer ⇒ false (alpha 0 everywhere — channel is in use)', () => {
    expect(alphaFullyOpaque(rgba(() => [0, 0, 0, 0]))).toBe(false);
  });

  it('an empty buffer ⇒ false (nothing to measure — never claim a saving on no data)', () => {
    expect(alphaFullyOpaque(new Uint8ClampedArray(0))).toBe(false);
  });
});

describe('isSolidFullRes (FULL-RESOLUTION solid confirmation — the 9×8 pre-filter cannot fabricate past this)', () => {
  it('a uniform opaque buffer ⇒ solid (every channel spread 0 ≤ SOLID_FULL_TOL)', () => {
    expect(SOLID_FULL_TOL).toBe(8); // drift guard, like SOLID_STD === 2
    expect(isSolidFullRes(rgba(() => [40, 110, 170, 255]))).toBe(true);
  });

  it('a fully-transparent buffer (0,0,0,0) ⇒ solid (no spread on any channel)', () => {
    expect(isSolidFullRes(rgba(() => [0, 0, 0, 0]))).toBe(true);
  });

  it('a constant color at a constant α (128) ⇒ solid (a uniform semi-transparent fill)', () => {
    expect(isSolidFullRes(rgba(() => [90, 90, 90, 128]))).toBe(true);
  });

  it('one single differing pixel among N (a real sub-cell feature) ⇒ NOT solid', () => {
    // The exact shape the 9×8 downsample averages away but full-res must catch: one pixel swings R far.
    expect(isSolidFullRes(rgba((i) => (i === 0 ? [220, 60, 60, 255] : [40, 110, 170, 255])))).toBe(false);
  });

  it('a hard cutout (α 0↔255, constant RGB) ⇒ NOT solid (alpha spread caught)', () => {
    expect(isSolidFullRes(rgba((i) => (i < N / 2 ? [90, 90, 90, 255] : [90, 90, 90, 0])))).toBe(false);
  });

  it('two chromatic colors at EQUAL luma but different RGB ⇒ NOT solid (per-channel min/max catches it)', () => {
    // A gray-only detector would miss this; min/max on R/G/B (spread ≫ tol) does not.
    const a: [number, number, number, number] = [180, 110, 80, 255];
    const b: [number, number, number, number] = [40, 160, 190, 255];
    expect(isSolidFullRes(rgba((i) => (i % 2 === 0 ? a : b)))).toBe(false);
  });

  it('a within-tolerance band ⇒ solid; one level past SOLID_FULL_TOL ⇒ NOT solid (the boundary)', () => {
    // Encoder ringing on a genuinely flat fill stays within ±tol ⇒ still solid.
    expect(isSolidFullRes(rgba((i) => [100 + (i % (SOLID_FULL_TOL + 1)), 100, 100, 255]))).toBe(true); // spread === tol
    // One level more of spread is a real difference ⇒ not solid.
    expect(isSolidFullRes(rgba((i) => [100 + (i % (SOLID_FULL_TOL + 2)), 100, 100, 255]))).toBe(false); // spread === tol+1
  });

  it('an empty buffer ⇒ false (never claim a saving on no data)', () => {
    expect(isSolidFullRes(new Uint8ClampedArray(0))).toBe(false);
  });
});

describe('classifyContent (order: alpha-art → flat → photographic; empty → unknown)', () => {
  it('a hard-alpha icon ⇒ alpha-art (even after a resample smears the edge)', () => {
    // Opaque body that is ALSO low-variance in color — alpha must win over the flat-variance branch.
    const buf = rgba((i) => (i < N / 2 ? [200, 50, 50, 255] : [0, 0, 0, 0]));
    expect(classifyContent(grayOf(buf), buf)).toBe('alpha-art');
  });

  it('a fully-opaque low-variance fill ⇒ flat', () => {
    const buf = rgba(() => [130, 132, 128, 255]); // tiny noise, std well under FLAT_STD
    const g = grayOf(buf);
    expect(grayStdDev(g)).toBeLessThan(FLAT_STD);
    expect(classifyContent(g, buf)).toBe('flat');
  });

  it('a high-variance photographic sample ⇒ photographic', () => {
    // Pseudo-random opaque luminance across the grid → high std dev, no alpha poles.
    const buf = rgba((i) => {
      const v = (i * 73 + 17) % 256;
      return [v, (v * 3) % 256, (v * 7) % 256, 255];
    });
    const g = grayOf(buf);
    expect(grayStdDev(g)).toBeGreaterThan(FLAT_STD);
    expect(classifyContent(g, buf)).toBe('photographic');
  });

  it('a smooth full-range gradient ⇒ photographic, NOT flat (M2: gradients out of the confident set)', () => {
    // 0..255 luminance ramp across the 72 samples → std dev ~74, far above FLAT_STD. Opaque throughout.
    const buf = rgba((i) => {
      const v = Math.round((i / (N - 1)) * 255);
      return [v, v, v, 255];
    });
    const g = grayOf(buf);
    expect(grayStdDev(g)).toBeGreaterThan(FLAT_STD);
    expect(classifyContent(g, buf)).toBe('photographic');
  });

  it('empty / short sample ⇒ unknown', () => {
    expect(classifyContent([], new Uint8ClampedArray(0))).toBe('unknown');
    expect(classifyContent([1, 2, 3], new Uint8ClampedArray([1, 2]))).toBe('unknown');
  });
});

describe('classifyContent over the format-classes fixtures (golden cross-check)', () => {
  // The worker decodes each image to a 9×8 RGBA sample (drawImage(bmp,0,0,9,8) → getImageData) and feeds
  // it to classifyContent. Here we reproduce that 9×8 sample from the on-disk fixture PNGs without a canvas
  // (Node has none) via a deterministic BOX-AVERAGE downsample — the fixtures are drawn on a 9×8-aligned
  // grid (docs/improvements/content-class.md §10) so this matches the worker's resampled class. The golden
  // contentClass in expected.json is authored by hand in the generator, an independent cross-check.
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/sample-projects/format-classes');

  /** Box-average a full-res RGBA PNG down to the 9×8 dHash sample (interleaved RGBA), the shape the
   *  worker's getImageData(0,0,9,8) yields. Deterministic; no canvas. */
  function sample9x8(png: PNGImage): Uint8ClampedArray {
    const { width: W, height: H, data } = png;
    const out = new Uint8ClampedArray(DW * DH * 4);
    for (let gy = 0; gy < DH; gy++) {
      for (let gx = 0; gx < DW; gx++) {
        const x0 = Math.floor((gx * W) / DW);
        const x1 = Math.floor(((gx + 1) * W) / DW);
        const y0 = Math.floor((gy * H) / DH);
        const y1 = Math.floor(((gy + 1) * H) / DH);
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (W * y + x) << 2;
            r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; a += data[i + 3]!; n++;
          }
        }
        const o = (gy * DW + gx) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
      }
    }
    return out;
  }

  function classifyFixture(file: string): ContentClass {
    const png = PNG.sync.read(readFileSync(join(FIXTURES, file)));
    const rgba = sample9x8(png);
    const gray: number[] = [];
    for (let p = 0; p < DW * DH; p++) gray.push(luma(rgba, p * 4));
    return classifyContent(gray, rgba);
  }

  interface ExpectedImage {
    name: string;
    contentClass: ContentClass;
  }
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
    images: ExpectedImage[];
  };

  it('exercises one image per content class (flat / photographic / alpha-art)', () => {
    expect(new Set(expected.images.map((i) => i.contentClass))).toEqual(
      new Set<ContentClass>(['flat', 'photographic', 'alpha-art']),
    );
  });

  for (const img of [
    { name: 'flat-fill.png', contentClass: 'flat' as const },
    { name: 'photographic.png', contentClass: 'photographic' as const },
    { name: 'alpha-art.png', contentClass: 'alpha-art' as const },
  ]) {
    it(`${img.name} ⇒ ${img.contentClass} (matches the authored golden)`, () => {
      // golden in expected.json must agree with the hard-coded class above (no silent drift)
      const golden = expected.images.find((e) => e.name === img.name);
      expect(golden?.contentClass).toBe(img.contentClass);
      expect(classifyFixture(img.name)).toBe(img.contentClass);
    });
  }
});

describe('alphaFullyOpaque over the wasted-alpha fixtures (golden cross-check)', () => {
  // UNLIKE the solid-fill / content-class cross-checks (which box-average to the 9×8 dHash sample), the
  // wasted-alpha detector runs on the FULL-RESOLUTION decode — one transparent pixel must not average
  // away. So we read the full-res fixture PNG directly (the PNG.data IS the interleaved RGBA the worker's
  // full-frame getImageData yields) and feed it straight to alphaFullyOpaque. The golden `opaque` in
  // expected.json is authored by hand in the generator, an independent cross-check.
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/sample-projects/wasted-alpha');

  function opaqueFixture(file: string): boolean {
    const png = PNG.sync.read(readFileSync(join(FIXTURES, file)));
    return alphaFullyOpaque(new Uint8ClampedArray(png.data)); // full-res RGBA, no downsample
  }

  interface ExpectedOpaque {
    name: string;
    opaque: boolean;
  }
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
    images: ExpectedOpaque[];
  };

  for (const img of [
    { name: 'opaque.png', opaque: true },
    { name: 'transparent.png', opaque: false },
  ]) {
    it(`${img.name} ⇒ opaque:${img.opaque} (matches the authored golden)`, () => {
      const golden = expected.images.find((e) => e.name === img.name);
      expect(golden?.opaque).toBe(img.opaque); // golden agrees with the hard-coded expectation (no drift)
      expect(opaqueFixture(img.name)).toBe(img.opaque); // detector agrees with the golden
    });
  }
});

describe('isSolidColor over the solid-fill fixtures (golden cross-check)', () => {
  // Same harness as the content-class cross-check above: reproduce the worker's 9×8 RGBA sample from the
  // on-disk fixture PNGs with a deterministic BOX-AVERAGE downsample (no canvas in Node) and feed it to
  // isSolidColor. The fixtures are drawn on a 9×8-aligned grid (64px cells) so the box-average is exact and
  // the verdict survives the resample; the golden `solid` in expected.json is authored by hand in the
  // generator, an independent cross-check.
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/sample-projects/solid-fill');

  function sample9x8(png: PNGImage): Uint8ClampedArray {
    const { width: W, height: H, data } = png;
    const out = new Uint8ClampedArray(DW * DH * 4);
    for (let gy = 0; gy < DH; gy++) {
      for (let gx = 0; gx < DW; gx++) {
        const x0 = Math.floor((gx * W) / DW);
        const x1 = Math.floor(((gx + 1) * W) / DW);
        const y0 = Math.floor((gy * H) / DH);
        const y1 = Math.floor(((gy + 1) * H) / DH);
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (W * y + x) << 2;
            r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; a += data[i + 3]!; n++;
          }
        }
        const o = (gy * DW + gx) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
      }
    }
    return out;
  }

  function solidFixture(file: string): boolean {
    const png = PNG.sync.read(readFileSync(join(FIXTURES, file)));
    const rgba = sample9x8(png);
    const gray: number[] = [];
    for (let p = 0; p < DW * DH; p++) gray.push(luma(rgba, p * 4));
    return isSolidColor(gray, rgba);
  }

  interface ExpectedSolid {
    name: string;
    solid: boolean;
  }
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
    images: ExpectedSolid[];
  };

  // speck.png pins the BUG the full-res confirmation fixes: the 9×8 pre-filter ALONE reads solid=true
  // (a sub-cell speck box-averages away), so at THIS stage it is a false positive (golden solid:true).
  // The full-res cross-check below is what corrects it to solid=false — the visible before/after.
  for (const img of [
    { name: 'plate.png', solid: true },
    { name: 'framed.png', solid: false },
    { name: 'speck.png', solid: true }, // 9×8 pre-filter FALSE POSITIVE — vetoed by isSolidFullRes below
  ]) {
    it(`${img.name} ⇒ 9×8 solid:${img.solid} (matches the authored golden)`, () => {
      const golden = expected.images.find((e) => e.name === img.name);
      expect(golden?.solid).toBe(img.solid); // golden agrees with the hard-coded expectation (no drift)
      expect(solidFixture(img.name)).toBe(img.solid); // detector agrees with the golden
    });
  }
});

describe('isSolidFullRes over the solid-fill fixtures (FULL-RES golden cross-check — kills the 9×8 false positive)', () => {
  // UNLIKE the 9×8 pre-filter cross-check above (which box-averages to the dHash sample), the confirmation
  // runs on the FULL-RESOLUTION decode — a sub-cell speck must NOT average away. So we read the full-res
  // fixture PNG directly (PNG.data IS the interleaved RGBA the worker's full-frame getImageData yields) and
  // feed it straight to isSolidFullRes, exactly as the alphaFullyOpaque cross-check does for wasted-alpha.
  // The golden `solidFullRes` in expected.json is authored by hand in the generator, an independent check.
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/sample-projects/solid-fill');

  function solidFullResFixture(file: string): boolean {
    const png = PNG.sync.read(readFileSync(join(FIXTURES, file)));
    return isSolidFullRes(new Uint8ClampedArray(png.data)); // full-res RGBA, no downsample
  }

  interface ExpectedSolidFull {
    name: string;
    solidFullRes: boolean;
  }
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
    images: ExpectedSolidFull[];
  };

  for (const img of [
    { name: 'plate.png', solidFullRes: true },
    { name: 'framed.png', solidFullRes: false },
    { name: 'speck.png', solidFullRes: false }, // the 9×8 said solid:true — full res corrects it to false
  ]) {
    it(`${img.name} ⇒ full-res solid:${img.solidFullRes} (matches the authored golden)`, () => {
      const golden = expected.images.find((e) => e.name === img.name);
      expect(golden?.solidFullRes).toBe(img.solidFullRes); // golden agrees with the hard-coded expectation
      expect(solidFullResFixture(img.name)).toBe(img.solidFullRes); // confirmation agrees with the golden
    });
  }

  it('speck.png: the worker verdict = 9×8 candidate AND full-res confirm ⇒ solid=false (no fabricated saving)', () => {
    // This is the load-bearing assertion: the SAME image the 9×8 pre-filter fabricates as solid is vetoed by
    // the full-res confirmation, so the worker's `solid = candidate && confirmed` lands on FALSE. plate.png —
    // genuinely one color — still passes both ⇒ stays flagged.
    const png = PNG.sync.read(readFileSync(join(FIXTURES, 'speck.png')));
    const candidate = true; // proven by the 9×8 cross-check above (solidFixture('speck.png') === true)
    const confirmed = isSolidFullRes(new Uint8ClampedArray(png.data));
    expect(confirmed).toBe(false);
    expect(candidate && confirmed).toBe(false); // worker sets solid=false ⇒ solid-fill never fires for speck
  });
});

// ── extractFrameRegions / hashFrameRegions: the PURE load-bearing half of the worker's hashAtlasFrames
// (the per-region extraction + flat-guard + caps + bounds that decide whether a region is hashed or nulled).
// Previously this lived only inside the worker (canvas drawImage/getImageData) and had ZERO coverage; the
// flat-guard there is exactly what silently neuters a solid-color fixture, so it MUST be tested directly.
describe('extractFrameRegions / hashFrameRegions (pure frame-region hashing core)', () => {
  // A short, deterministic stand-in hash for the tests — the worker plugs SHA-256; here a stable hex digest
  // of the bytes is enough to assert "identical regions ⇒ same hash, distinct ⇒ different".
  const h = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

  // Build a W×H RGBA page; `paint(x,y)` returns the [r,g,b,a] for each pixel.
  function page(W: number, H: number, paint: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
    const buf = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b, a] = paint(x, y);
        const i = (W * y + x) * 4;
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
      }
    }
    return buf;
  }
  // A coarse 2-color checker (textured ⇒ clears the flat-guard) parameterised by its two colors + offset, so
  // two cells can be made byte-identical (same colors) or distinct (different colors).
  const checker =
    (a: [number, number, number], b: [number, number, number], sq = 4) =>
    (lx: number, ly: number): [number, number, number, number] =>
      ((Math.floor(lx / sq) + Math.floor(ly / sq)) & 1 ? a : b).concat(255) as [number, number, number, number];

  it('identical textured regions ⇒ identical hash; a distinct textured region ⇒ different hash', () => {
    const W = 48, H = 16;
    const A: [number, number, number] = [200, 60, 30];
    const B: [number, number, number] = [20, 40, 200];
    const C: [number, number, number] = [30, 200, 60];
    const pa = checker(A, B);
    const pc = checker(A, C);
    // cells 0 and 1 share the (A,B) checker (byte-identical); cell 2 uses (A,C) (distinct).
    const buf = page(W, H, (x, y) => (x < 32 ? pa(x % 16, y) : pc(x % 16, y)));
    const rects: FrameRect[] = [
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
      { x: 32, y: 0, w: 16, h: 16 },
    ];
    const hashes = hashFrameRegions(buf, W, H, rects, h)!;
    expect(hashes[0]).not.toBeNull();
    expect(hashes[0]).toBe(hashes[1]); // identical pixels ⇒ identical hash (position-independent)
    expect(hashes[2]).not.toBe(hashes[0]); // distinct pixels ⇒ distinct hash
  });

  it('a flat / solid-color region ⇒ null (never clustered — the bug the old fixture hid)', () => {
    const W = 32, H = 16;
    const buf = page(W, H, () => [42, 161, 152, 255]); // single solid color everywhere (DUP_COLOR)
    const rects: FrameRect[] = [
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
    ];
    const hashes = hashFrameRegions(buf, W, H, rects, h)!;
    expect(hashes).toEqual([null, null]); // solid ⇒ flat-guard nulls both ⇒ they can never cluster
  });

  it('zero / negative / out-of-bounds rects ⇒ null (can\'t be hashed honestly)', () => {
    const W = 32, H = 16;
    const buf = page(W, H, checker([200, 60, 30], [20, 40, 200]));
    const rects: FrameRect[] = [
      { x: 0, y: 0, w: 0, h: 16 }, // zero width
      { x: 0, y: 0, w: 16, h: -4 }, // negative height
      { x: -1, y: 0, w: 16, h: 16 }, // negative x
      { x: 24, y: 0, w: 16, h: 16 }, // x + w (40) > W (32)
      { x: 0, y: 8, w: 16, h: 16 }, // y + h (24) > H (16)
    ];
    expect(hashFrameRegions(buf, W, H, rects, h)).toEqual([null, null, null, null, null]);
  });

  it('sprite-count cap ⇒ whole page null (skipped honestly, the rule never fires)', () => {
    const buf = page(8, 8, checker([200, 60, 30], [20, 40, 200], 2));
    const rects: FrameRect[] = Array.from({ length: FRAME_HASH_MAX_SPRITES + 1 }, () => ({ x: 0, y: 0, w: 4, h: 4 }));
    expect(extractFrameRegions(buf, 8, 8, rects)).toBeNull();
    expect(hashFrameRegions(buf, 8, 8, rects, h)).toBeNull();
  });

  it('page-size cap (px) ⇒ whole page null (no slow read on an outlier sheet)', () => {
    // A page whose declared dimensions exceed FRAME_HASH_MAX_PX (we don't allocate it — the cap is checked
    // from the passed dimensions before any per-region work).
    const W = 8192, H = Math.ceil(FRAME_HASH_MAX_PX / W) + 1; // W×H just over the cap
    expect(W * H).toBeGreaterThan(FRAME_HASH_MAX_PX);
    const tiny = new Uint8ClampedArray(4); // dimensions, not the buffer, drive the cap
    const rects: FrameRect[] = [{ x: 0, y: 0, w: 4, h: 4 }];
    expect(extractFrameRegions(tiny, W, H, rects)).toBeNull();
  });

  it('zero / negative page dimensions ⇒ null', () => {
    const rects: FrameRect[] = [{ x: 0, y: 0, w: 4, h: 4 }];
    expect(extractFrameRegions(new Uint8ClampedArray(0), 0, 8, rects)).toBeNull();
    expect(extractFrameRegions(new Uint8ClampedArray(0), 8, 0, rects)).toBeNull();
  });

  it('extractFrameRegions: identical regions ⇒ byte-identical buffers, distinct ⇒ not', () => {
    const W = 48, H = 16;
    const pa = checker([200, 60, 30], [20, 40, 200]);
    const pc = checker([200, 60, 30], [30, 200, 60]);
    const buf = page(W, H, (x, y) => (x < 32 ? pa(x % 16, y) : pc(x % 16, y)));
    const regions = extractFrameRegions(buf, W, H, [
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
      { x: 32, y: 0, w: 16, h: 16 },
    ])!;
    expect(Buffer.from(regions[0]!)).toEqual(Buffer.from(regions[1]!)); // identical pixels
    expect(Buffer.from(regions[0]!)).not.toEqual(Buffer.from(regions[2]!)); // distinct
    expect(regions[0]).toHaveLength(16 * 16 * 4); // tightly packed w×h×4
  });
});

// ── END-TO-END: the frame-redundant fixture PNG, fed through the REAL production hashing path (decode →
// pure extractFrameRegions → SHA → frameRedundancyFinding). This is the assertion that was MISSING: the old
// golden hand-supplied non-flat hashes by NAME, so a solid-color fixture (which the flat-guard nulls) passed
// the golden yet produced ZERO findings in the real worker. With the fixture repainted TEXTURED-but-identical,
// the cluster must fire through the same decode+flat-guard+SHA the worker runs. No canvas — pngjs decodes the
// PNG to the same RGBA buffer createImageBitmap+getImageData would, and the SHA stand-in is byte-stable.
describe('frame-redundancy END-TO-END: fixture reproduces the defect through the real decode path', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/sample-projects/frame-redundant');
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

  it('the four textured idle frames cluster (identical hash); the four walk frames are distinct & non-null', () => {
    const png = PNG.sync.read(readFileSync(join(FIXTURES, 'anim.png')));
    const manifest = JSON.parse(readFileSync(join(FIXTURES, 'anim.json'), 'utf8')) as {
      frames: Record<string, { frame: FrameRect }>;
    };
    const names = Object.keys(manifest.frames);
    const rects = names.map((n) => manifest.frames[n]!.frame);
    const hashes = hashFrameRegions(new Uint8ClampedArray(png.data), png.width, png.height, rects, sha)!;
    expect(hashes).not.toBeNull();
    const byName = Object.fromEntries(names.map((n, i) => [n, hashes[i]]));

    const idle = ['idle_0', 'idle_1', 'idle_2', 'idle_3'].map((n) => byName[n]);
    expect(idle.every((x) => x != null)).toBe(true); // NOT nulled by the flat-guard (textured, not solid)
    expect(new Set(idle).size).toBe(1); // all four share ONE region hash ⇒ they cluster
    const walk = ['walk_0', 'walk_1', 'walk_2', 'walk_3'].map((n) => byName[n]);
    expect(walk.every((x) => x != null)).toBe(true); // each walk frame is textured ⇒ hashed, not skipped
    expect(new Set(walk).size).toBe(4); // four distinct hashes
    expect(new Set([...idle, ...walk]).size).toBe(5); // no walk frame collides with the idle cluster
  });

  it('the rule FIRES warn from the real region hashes, matching expected.json', () => {
    const png = PNG.sync.read(readFileSync(join(FIXTURES, 'anim.png')));
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
      recoverableArea: number;
      vramBytesSaved: number;
    };
    const parsed = parseAtlas(JSON.parse(readFileSync(join(FIXTURES, 'anim.json'), 'utf8')), {
      ref: 'anim.png',
      bytes: new Uint8Array(readFileSync(join(FIXTURES, 'anim.png'))),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.asset.kind !== 'atlas') return;
    const atlas = parsed.asset.atlas;

    // Hash index-aligned to the PARSED sprite order (exactly what the worker passes analyze()).
    const rects = atlas.sprites.map((s) => s.frame);
    const frameHashes = hashFrameRegions(new Uint8ClampedArray(png.data), png.width, png.height, rects, sha)!;
    expect(frameHashes.filter((x) => x != null && frameHashes.filter((y) => y === x).length === 4)).toHaveLength(4);

    const finding = frameRedundancyFinding(atlas, DEFAULT_THRESHOLDS, frameHashes, atlas.size.w * atlas.size.h);
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('warn');
    expect(finding!.rule).toBe('frame-redundancy');
    expect(finding!.estimate?.vramBytesSaved).toBe(expected.vramBytesSaved);
    expect(finding!.params?.area).toBe(expected.recoverableArea);
  });
});

// ── END-TO-END: the cross-atlas-redundant fixture — TWO sheets fed through the REAL production hashing path
// (decode each PNG → pure extractFrameRegions → SHA → folder-scope crossAtlasRedundancyFinding). This is the
// folder-scope sibling of the frame-redundancy e2e: the `shared` frame is byte-identical ACROSS the two sheets,
// so its region SHA collides cross-atlas and the cluster spans 2 sheets. The frames are textured-but-identical
// precisely so the production flat-guard does NOT null them. No canvas — pngjs decodes each PNG to the same RGBA
// buffer createImageBitmap+getImageData would; the SHA stand-in is byte-stable (same digest both sheets ⇒ cluster).
describe('cross-atlas-redundancy END-TO-END: fixture reproduces the cross-sheet dup through the real decode path', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/sample-projects/cross-atlas-redundant');
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

  it('the shared frame collides cross-sheet (same SHA) and a_only/b_only stay distinct & non-null', () => {
    const read = (sheet: string) => {
      const png = PNG.sync.read(readFileSync(join(FIXTURES, `${sheet}.png`)));
      const manifest = JSON.parse(readFileSync(join(FIXTURES, `${sheet}.json`), 'utf8')) as {
        frames: Record<string, { frame: FrameRect }>;
      };
      const names = Object.keys(manifest.frames);
      const rects = names.map((n) => manifest.frames[n]!.frame);
      const hashes = hashFrameRegions(new Uint8ClampedArray(png.data), png.width, png.height, rects, sha)!;
      return Object.fromEntries(names.map((n, i) => [n, hashes[i]])) as Record<string, string | null>;
    };
    const a = read('sheetA');
    const b = read('sheetB');
    expect(a['shared']).not.toBeNull(); // textured ⇒ not nulled by the flat-guard
    expect(a['shared']).toBe(b['shared']); // byte-identical region ACROSS sheets ⇒ identical SHA (the cluster)
    expect(a['a_only']).not.toBeNull();
    expect(b['b_only']).not.toBeNull();
    expect(new Set([a['shared'], a['a_only'], b['b_only']]).size).toBe(3); // shared distinct from both per-sheet frames
  });

  it('the rule FIRES warn from the real cross-atlas region hashes, matching expected.json', () => {
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
      recoverableArea: number;
      vramBytesSaved: number;
      dupes: number;
      groups: number;
      sheets: number;
    };

    const atlases = [];
    const frameHashByRef = new Map<string, (string | null)[]>();
    const byteByRef = new Map<string, number>();
    for (const sheet of ['sheetA', 'sheetB']) {
      const pngBytes = readFileSync(join(FIXTURES, `${sheet}.png`));
      const png = PNG.sync.read(pngBytes);
      const parsed = parseAtlas(JSON.parse(readFileSync(join(FIXTURES, `${sheet}.json`), 'utf8')), {
        ref: `${sheet}.png`,
        bytes: new Uint8Array(pngBytes),
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || parsed.asset.kind !== 'atlas') return;
      const atlas = parsed.asset.atlas;
      atlases.push(atlas);
      // Hash index-aligned to the PARSED sprite order — exactly what the worker passes analyze().
      const rects = atlas.sprites.map((s) => s.frame);
      const hashes = hashFrameRegions(new Uint8ClampedArray(png.data), png.width, png.height, rects, sha)!;
      frameHashByRef.set(`${sheet}.png`, hashes);
      byteByRef.set(`${sheet}.png`, pngBytes.length);
    }

    const finding = crossAtlasRedundancyFinding(atlases, frameHashByRef, byteByRef, DEFAULT_THRESHOLDS);
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('warn');
    expect(finding!.rule).toBe('cross-atlas-redundancy');
    expect(finding!.messageKey).toBe('cross-atlas-redundancy'); // BLOCKER 1: distinct key
    expect(finding!.params?.dupes).toBe(expected.dupes);
    expect(finding!.params?.groups).toBe(expected.groups);
    expect(finding!.params?.sheets).toBe(expected.sheets);
    expect(finding!.params?.area).toBe(expected.recoverableArea);
    expect(finding!.estimate?.vramBytesSaved).toBe(expected.vramBytesSaved);
    expect(finding!.relatedRefs).toEqual(['shared', 'shared']); // both sheets' shared frame names (kept, sorted)
  });
});

// ── END-TO-END: the untrimmed-padding fixture PNG, fed through the REAL production trim-bbox path (decode →
// pure alphaBBox → trimMarginFinding). This proves the textured-core-in-a-transparent-margin fixture
// reproduces the trim-margin defect through production code (the SAME alphaBBox the worker calls off the
// already-decoded page), not just through injected bboxes. No canvas — pngjs decodes the PNG to the same RGBA
// buffer createImageBitmap+getImageData would, and alphaBBox is the SAME pure helper @asset-doctor/fix exports.
describe('trim-margin END-TO-END: fixture reproduces the defect through the real decode path', () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/sample-projects/untrimmed-padding');

  it('alphaBBox recovers each untrimmed sprite bbox; the rule FIRES warn matching expected.json', () => {
    const png = PNG.sync.read(readFileSync(join(FIXTURES, 'sheet.png')));
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
      recoverableArea: number;
      vramBytesSaved: number;
      qualifying: string[];
      regions: { name: string; bbox: { x: number; y: number; w: number; h: number } | null; trimmed: boolean }[];
    };
    const parsed = parseAtlas(JSON.parse(readFileSync(join(FIXTURES, 'sheet.json'), 'utf8')), {
      ref: 'sheet.png',
      bytes: new Uint8Array(readFileSync(join(FIXTURES, 'sheet.png'))),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.asset.kind !== 'atlas') return;
    const atlas = parsed.asset.atlas;

    // Compute the opaque bbox off the REAL decoded page via the SAME pure alphaBBox the worker uses — only for
    // UNtrimmed sprites (the worker passes null for trimmed ones). Index-aligned to the parsed sprite order.
    const src = { data: new Uint8ClampedArray(png.data), width: png.width };
    const bboxes = atlas.sprites.map((s) =>
      s.trimmed ? null : alphaBBox(src, { x: s.frame.x, y: s.frame.y, w: s.frame.w, h: s.frame.h }),
    );

    // Cross-check each recovered bbox against the authored golden (frame-relative top-left).
    const bboxByName = new Map(expected.regions.map((r) => [r.name, r.bbox]));
    for (let i = 0; i < atlas.sprites.length; i++) {
      const sp = atlas.sprites[i]!;
      if (sp.trimmed) continue;
      expect(bboxes[i], `${sp.name} bbox`).toEqual(bboxByName.get(sp.name));
    }

    const finding = trimMarginFinding(atlas, DEFAULT_THRESHOLDS, bboxes);
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('warn');
    expect(finding!.rule).toBe('trim-margin');
    expect(finding!.params?.sprites).toBe(expected.qualifying.length); // already-trimmed sprite excluded
    expect(finding!.estimate?.vramBytesSaved).toBe(expected.vramBytesSaved);
    expect(finding!.params?.area).toBe(expected.recoverableArea);
    expect(finding!.relatedRefs).toEqual([...expected.qualifying].sort());
  });

  // Round20 trim-on-repack: the FIX realizes the detector's promise through the REAL decode→bbox→pack→compose
  // path. We decode the fixture PNG, compute each untrimmed sprite's bbox via the SAME alphaBBox, feed it into
  // repackAtlases({trim}), and assert: reclaimed >= detector.recoverableArea (B1: the fix reclaims AT LEAST
  // what was promised) + EXACT per-sprite packedSize===bbox + every name resolves + parser round-trip + a
  // PIXEL round-trip (the inset blit over the decoded buffer recovers the sprite's opaque core).
  it('trim-on-repack REALIZES the defect: reclaimed >= recoverableArea, exact per-sprite, round-trips', () => {
    const png = PNG.sync.read(readFileSync(join(FIXTURES, 'sheet.png')));
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
      recoverableArea: number;
      repack: { trimmedSprites: number; trimmedAreaReclaimed: number; perSprite: { name: string; packedSize: { w: number; h: number }; spriteSourceSize: { x: number; y: number; w: number; h: number } }[] };
    };
    const parsed = parseAtlas(JSON.parse(readFileSync(join(FIXTURES, 'sheet.json'), 'utf8')), {
      ref: 'sheet.png',
      bytes: new Uint8Array(readFileSync(join(FIXTURES, 'sheet.png'))),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.asset.kind !== 'atlas') return;
    const atlas = parsed.asset.atlas;

    // The SAME frame-relative bboxes the worker computes (alphaBBox over the decoded page), null for trimmed.
    const src = { data: new Uint8ClampedArray(png.data), width: png.width };
    const trim = atlas.sprites.map((s) =>
      s.trimmed ? null : alphaBBox(src, { x: s.frame.x, y: s.frame.y, w: s.frame.w, h: s.frame.h }),
    );

    const before = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 4096 });
    const r = repackAtlases([atlas], { allowRotation: false, padding: 0, maxSize: 4096, trim: [trim] });

    // B1: the fix reclaims AT LEAST the detector's promised area (MEASURED, not the detector's number).
    expect(r.trimmedAreaReclaimed!).toBeGreaterThanOrEqual(expected.recoverableArea);
    expect(r.trimmedSprites).toBe(expected.repack.trimmedSprites);
    expect(r.trimmedAreaReclaimed).toBe(expected.repack.trimmedAreaReclaimed);
    // Trimming a sheet to tighter cores can only LOWER (or hold) VRAM.
    expect(r.vramBytesAfter).toBeLessThanOrEqual(before.vramBytesAfter);

    const out = new Map(r.atlases.flatMap((a) => a.sprites).map((s) => [s.name, s]));
    // EXACT per-sprite: packed at the bbox extent + spriteSourceSize === the recovered bbox.
    for (const ps of expected.repack.perSprite) {
      const sp = out.get(ps.name)!;
      const bbox = trim[atlas.sprites.findIndex((s) => s.name === ps.name)]!;
      expect({ w: sp.frame.w, h: sp.frame.h }, `${ps.name} packedSize===bbox`).toEqual({ w: bbox.w, h: bbox.h });
      expect({ w: sp.frame.w, h: sp.frame.h }).toEqual(ps.packedSize);
      expect(sp.spriteSourceSize).toEqual(ps.spriteSourceSize);
      expect(sp.trimmed).toBe(true);
      // sourceSize stays the ORIGINAL full frame (the untrimmed source size the parser recorded).
      expect(sp.sourceSize).toEqual(atlas.sprites.find((s) => s.name === ps.name)!.sourceSize);
    }
    // Drop-in: every original name resolves + parser round-trip.
    expect(out.size).toBe(atlas.sprites.length);
    const repacked = r.atlases[0]!;
    const round = parseAtlasManifest(JSON.parse(emitTexturePackerJson(repacked)), { imageRef: repacked.imageRef, imageSize: repacked.size });
    expect(round.ok).toBe(true);
    if (round.ok) expect(round.atlas).toEqual(repacked);

    // PIXEL round-trip: a trimmed sprite's blit reads the INSET source sub-region; reading that region off the
    // decoded page must be FULLY OPAQUE (the opaque core, no transparent margin) — proves the inset is correct.
    const alphaAt = (px: number, py: number): number => png.data[(py * png.width + px) * 4 + 3]!;
    for (const ps of expected.repack.perSprite) {
      const blit = r.blits.find((b) => b.name === ps.name)!;
      const { x, y, w, h } = blit.from.rect;
      // Every corner of the inset is opaque (the bbox is the opaque extent by construction of alphaBBox).
      for (const [cx, cy] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]] as const) {
        expect(alphaAt(cx, cy), `${ps.name} inset corner (${cx},${cy}) opaque`).toBeGreaterThanOrEqual(1);
      }
      // Just OUTSIDE the inset (one row above the top edge, when inside the frame) is transparent margin.
      const srcSprite = atlas.sprites.find((s) => s.name === ps.name)!;
      if (y - 1 >= srcSprite.frame.y) expect(alphaAt(x, y - 1), `${ps.name} above-inset transparent`).toBe(0);
    }
  });
});
