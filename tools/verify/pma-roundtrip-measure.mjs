// MEASUREMENT (not a permanent scenario): does the fix's compose path preserve PREMULTIPLIED pixel
// VALUES? A Spine `pma: true` atlas stores premultiplied RGBA; the repack recomposes via
// createImageBitmap → straight drawImage(source-over onto transparent) → encode. Canvas 2D stores
// premultiplied internally and un-premultiplies on read, so a premultiplied-VALUE source (which canvas
// treats as straight) round-trips through premultiply→unpremultiply — exact for high alpha, lossy for
// low alpha. This quantifies the error so the pma decision (preserve vs skip) rests on data, not reasoning.
// Usage: CHROME=/path/to/chrome node tools/verify/pma-roundtrip-measure.mjs
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { CHROME_ARGS, chromePath } from './lib.mjs';

// Valid premultiplied pixels (each channel <= alpha). Straight-white at descending alphas is the worst
// case for the premultiply→unpremultiply round-trip (max channel == alpha at every level).
const CASES = [
  [255, 128, 0, 255], [200, 200, 200, 255],
  [200, 100, 50, 200], [180, 0, 0, 200],
  [128, 64, 32, 128], [128, 128, 128, 128],
  [64, 32, 16, 64], [64, 0, 0, 64],
  [32, 16, 8, 32], [32, 32, 32, 32],
  [16, 8, 4, 16], [16, 16, 16, 16],
  [8, 4, 2, 8], [8, 8, 8, 8],
  [4, 2, 1, 4], [4, 4, 4, 4],
  [2, 1, 0, 2], [2, 2, 2, 2],
  [1, 0, 0, 1], [1, 1, 1, 1],
];

// Build a WIDE 1px-tall PNG, one column per case, raw premultiplied bytes.
const W = CASES.length, H = 1;
const png = new PNG({ width: W, height: H });
CASES.forEach(([r, g, b, a], x) => {
  const i = x * 4;
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
});
const pngBytes = PNG.sync.write(png);
const b64 = Buffer.from(pngBytes).toString('base64');

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  const out = await page.evaluate(async (payload) => {
    const bin = atob(payload.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // EXACT worker primitives: createImageBitmap(no opts) → transparent OffscreenCanvas → straight
    // drawImage source-over → encode. Measure with PNG (always lossless) to isolate the CANVAS
    // premultiplication round-trip, then again with lossless WebP (the real sheet format) to confirm.
    const decode = async (blob) => {
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0);
      return x.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const roundTrip = async (type, quality) => {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, bmp.width, bmp.height); // transparent, like a fresh sheet
      ctx.drawImage(bmp, 0, 0);
      const blob = await c.convertToBlob(quality === undefined ? { type } : { type, quality });
      return decode(blob);
    };
    const src = await decode(new Blob([bytes], { type: 'image/png' }));
    const viaPng = await roundTrip('image/png');
    const viaWebp = await roundTrip('image/webp', 1);
    return { src: [...src], viaPng: [...viaPng], viaWebp: [...viaWebp] };
  }, { b64 });

  // Compare recompose output against the ORIGINAL premultiplied bytes (what the game's GPU sees for the
  // UNtouched atlas — a pma-aware loader uploads the raw premultiplied bytes verbatim). `src` (decode) is
  // shown for reference: it ALSO round-trips, so it already crushes low alpha — proving the loss is in the
  // canvas premultiply→unpremultiply, not the encode.
  let maxOrig = 0, maxOrigHiA = 0, worstOrig = '';
  console.log('alpha  ORIGINAL(GPU)     decode(src)       recomposed(PNG)   err-vs-ORIGINAL');
  CASES.forEach((orig, idx) => {
    const i = idx * 4, a = orig[3];
    const s = [out.src[i], out.src[i + 1], out.src[i + 2], out.src[i + 3]];
    const p = [out.viaPng[i], out.viaPng[i + 1], out.viaPng[i + 2], out.viaPng[i + 3]];
    const eo = Math.max(...orig.map((v, k) => Math.abs(v - p[k])));
    maxOrig = Math.max(maxOrig, eo);
    if (a > 16) maxOrigHiA = Math.max(maxOrigHiA, eo);
    if (eo === maxOrig) worstOrig = `${orig.join(',')} → ${p.join(',')} (Δ${eo})`;
    console.log(`${String(a).padStart(4)}   ${orig.join(',').padEnd(16)}  ${s.join(',').padEnd(16)}  ${p.join(',').padEnd(16)}    ${eo}`);
  });
  console.log(`\nMAX recompose error vs ORIGINAL premultiplied bytes: ${maxOrig}  (worst: ${worstOrig})`);
  console.log(`  error for alpha>16 (perceptible pixels): ${maxOrigHiA}`);
  console.log(maxOrig <= 1
    ? 'VERDICT: canvas recompose preserves premultiplied bytes exactly ⇒ pma:true PRESERVE is lossless-safe.'
    : `VERDICT: canvas recompose LOSES up to ${maxOrig} on premultiplied bytes (low-alpha crush) ⇒ NOT byte-lossless for pma atlases ⇒ the honest choice is to SKIP repacking pma:true atlases (preserve the lossless promise), not silently degrade.`);
} finally {
  await browser.close();
}
