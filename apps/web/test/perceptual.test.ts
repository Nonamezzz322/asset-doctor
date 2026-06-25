import { describe, it, expect } from 'vitest';
import { dHashFromGray, grayStdDev, isFlat } from '../src/lib/perceptual';

const N = 9 * 8;
const flat = new Array<number>(N).fill(128);
// horizontal gradient per row: 0,28,…,224 — repeated for all 8 rows
const gradient = Array.from({ length: N }, (_, i) => (i % 9) * 28);
const reverse = Array.from({ length: N }, (_, i) => (8 - (i % 9)) * 28);

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
