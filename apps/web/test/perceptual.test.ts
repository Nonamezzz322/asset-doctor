import { describe, it, expect } from 'vitest';
import { dHashFromGray, grayStdDev, isFlat, blockUpscaleDepth } from '../src/lib/perceptual';

/** Build a w×h RGBA buffer from a per-pixel color fn. */
function rgba(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, al] = fn(x, y);
      const i = (y * w + x) * 4;
      a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
    }
  return a;
}
/** Nearest-neighbour 2× upscale of a source built by `fn` at (w/2 × h/2). */
const nearest2x = (w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]) =>
  rgba(w, h, (x, y) => fn(x >> 1, y >> 1));

const N = 9 * 8;
const flat = new Array<number>(N).fill(128);
// horizontal gradient per row: 0,28,…,224 — repeated for all 8 rows
const gradient = Array.from({ length: N }, (_, i) => (i % 9) * 28);
const reverse = Array.from({ length: N }, (_, i) => (8 - (i % 9)) * 28);

describe('blockUpscaleDepth — provable nearest-2× upscale (a proof, no threshold)', () => {
  it('a nearest 2× upscale of a detailed 4×4 ⇒ depth 1', () => {
    const detail = (x: number, y: number): [number, number, number, number] => [x * 30, y * 30, (x + y) * 10, 255];
    expect(blockUpscaleDepth(nearest2x(8, 8, detail), 8, 8)).toBe(1);
  });
  it('a 16×16 whose every 4×4 block is constant ⇒ depth 2', () => {
    const b = rgba(16, 16, (x, y) => [(x >> 2) * 40, (y >> 2) * 40, 0, 255]);
    expect(blockUpscaleDepth(b, 16, 16)).toBe(2);
  });
  it('a genuinely detailed image (per-pixel variation) ⇒ depth 0 (no false positive)', () => {
    expect(blockUpscaleDepth(rgba(8, 8, (x, y) => [x * 8, y * 8, 0, 255]), 8, 8)).toBe(0);
  });
  it('ALPHA is part of the constancy test: constant RGB but alpha varying inside a block ⇒ depth 0', () => {
    expect(blockUpscaleDepth(rgba(8, 8, (x, y) => [0, 0, 0, (x + y) & 1 ? 255 : 0]), 8, 8)).toBe(0);
  });
  it('odd dimension ⇒ 0; too small ⇒ 0; short buffer ⇒ 0', () => {
    expect(blockUpscaleDepth(rgba(6, 8, () => [0, 0, 0, 255]), 6, 7)).toBe(0); // h odd
    expect(blockUpscaleDepth(rgba(1, 1, () => [0, 0, 0, 255]), 1, 1)).toBe(0);
    expect(blockUpscaleDepth(new Uint8ClampedArray(4), 8, 8)).toBe(0); // buffer shorter than w·h·4
  });
  it('a solid image descends fully (documents why analyze de-overlaps with solid-fill)', () => {
    expect(blockUpscaleDepth(rgba(8, 8, () => [100, 100, 100, 255]), 8, 8)).toBe(3); // 8→4→2→1
  });
});

describe('perceptual hashing', () => {
  it('treats a uniform image as flat (zero variance)', () => {
    expect(grayStdDev(flat)).toBe(0);
    expect(isFlat(flat)).toBe(true);
  });

  it('does not flag a textured (gradient) image as flat', () => {
    expect(grayStdDev(gradient)).toBeGreaterThan(6);
    expect(isFlat(gradient)).toBe(false);
  });

  it('produces distinct hashes for distinct content', () => {
    expect(dHashFromGray(gradient)).not.toBe(dHashFromGray(flat));
    expect(dHashFromGray(gradient)).not.toBe(dHashFromGray(reverse));
    expect(dHashFromGray(gradient)).toHaveLength(16);
  });
});
