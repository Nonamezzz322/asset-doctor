import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PNG, type PNGImage } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { ContentClass } from '@asset-doctor/core';
import {
  alphaFullyOpaque,
  classifyContent,
  dHashFromGray,
  grayStdDev,
  hasHardAlpha,
  isFlat,
  isSolidColor,
  luma,
  FLAT_STD,
  SOLID_STD,
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

  for (const img of [
    { name: 'plate.png', solid: true },
    { name: 'framed.png', solid: false },
  ]) {
    it(`${img.name} ⇒ solid:${img.solid} (matches the authored golden)`, () => {
      const golden = expected.images.find((e) => e.name === img.name);
      expect(golden?.solid).toBe(img.solid); // golden agrees with the hard-coded expectation (no drift)
      expect(solidFixture(img.name)).toBe(img.solid); // detector agrees with the golden
    });
  }
});
