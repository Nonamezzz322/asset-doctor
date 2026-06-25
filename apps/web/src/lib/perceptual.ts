// Pure perceptual-hash helpers (testable headless). The worker decodes an image to a 9×8
// grayscale and calls these; keeping the math here means it can be unit-tested without a canvas.

const DW = 9; // sample width
const DH = 8; // sample height

/** Grayscale luma from RGBA pixel data at byte index i. */
export function luma(data: Uint8ClampedArray | number[], i: number): number {
  return 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
}

/** 9×8 grayscale samples → 64-bit difference hash (dHash) as 16 hex chars. */
export function dHashFromGray(gray: number[]): string {
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < DH; y++) {
    for (let x = 0; x < DW - 1; x++) {
      const a = gray[y * DW + x] ?? 0;
      const b = gray[y * DW + x + 1] ?? 0;
      nibble = (nibble << 1) | (a < b ? 1 : 0);
      if (++bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex.padStart(16, '0');
}

/** Standard deviation of the grayscale samples. A featureless image is ~0. */
export function grayStdDev(gray: number[]): number {
  if (gray.length === 0) return 0;
  const mean = gray.reduce((s, v) => s + v, 0) / gray.length;
  const variance = gray.reduce((s, v) => s + (v - mean) ** 2, 0) / gray.length;
  return Math.sqrt(variance);
}

/** Flat / near-uniform images collapse to the same dHash and would produce false
 *  "near-duplicate" matches — exclude them from perceptual matching. */
export function isFlat(gray: number[], minStdDev = 6): boolean {
  return grayStdDev(gray) < minStdDev;
}
