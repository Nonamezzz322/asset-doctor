// End-to-end Phase-2 fix proof: load a sparse atlas, run the in-browser fix, capture the downloaded
// optimized .zip, unzip it (store-only), and verify the repacked atlas is genuinely tighter with every
// sprite preserved — plus read the on-screen savings receipt. Nothing leaves the browser.
// Usage: CHROME=/path/to/chrome [APP_URL=...] node tools/verify/fix-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, statSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/tp-hash-symbols');
const DL = '/tmp/ad-dl';
const appUrl = process.env.APP_URL || 'http://localhost:5173/';

// store-only zip reader
function unzip(buf) {
  const files = {};
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const start = i + 30 + nameLen + extraLen;
    files[name] = buf.subarray(start, start + size);
    i = start + size;
  }
  return files;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERR ' + m.text()); });
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  const files = readdirSync(FIX).filter((n) => statSync(join(FIX, n)).isFile() && !n.endsWith('.md') && n !== 'expected.json').map((n) => join(FIX, n));
  await input.uploadFile(...files);
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => /optimized folder|оптимизир/i.test(b.textContent || '')),
    { timeout: 30000 },
  );

  // click the fix button (pro.cta)
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /optimized folder|оптимизир/i.test(x.textContent || ''));
    if (b) { b.click(); return b.textContent; }
    return null;
  });
  console.log('FIX_BUTTON', JSON.stringify(clicked));

  await page.waitForFunction(() => /optimized|оптимизир/i.test(document.body.innerText), { timeout: 40000 });
  const receipt = await page.evaluate(() => {
    const card = [...document.querySelectorAll('div')].find((d) => /✓ (optimized|оптимизир)/i.test(d.textContent || ''));
    return card ? card.innerText.replace(/\s+/g, ' ').trim() : '';
  });
  console.log('RECEIPT', JSON.stringify(receipt));

  // wait for the downloaded zip
  let zipPath = null;
  for (let i = 0; i < 60; i++) {
    const z = readdirSync(DL).filter((n) => n.endsWith('.zip'));
    if (z.length && !readdirSync(DL).some((n) => n.endsWith('.crdownload'))) { zipPath = join(DL, z[0]); break; }
    await sleep(250);
  }
  if (!zipPath) throw new Error('no zip downloaded');
  const entries = unzip(readFileSync(zipPath));
  console.log('ZIP_ENTRIES', Object.keys(entries).join(', '));

  const manifestName = Object.keys(entries).find((n) => n.endsWith('symbols.json'));
  const manifest = JSON.parse(entries[manifestName].toString('utf8'));
  const newArea = manifest.meta.size.w * manifest.meta.size.h;
  const frameNames = Object.keys(manifest.frames).sort();
  const inBounds = frameNames.every((n) => {
    const f = manifest.frames[n].frame;
    return f.x + f.w <= manifest.meta.size.w && f.y + f.h <= manifest.meta.size.h;
  });
  console.log('REPACKED size', manifest.meta.size.w + '×' + manifest.meta.size.h, '(was 512×512)', '· area', newArea, '<', 512 * 512, '?', newArea < 512 * 512);
  console.log('SPRITES kept', frameNames.length, '/ 5 ·', frameNames.join(','), '· in-bounds', inBounds);
  // the repacked sheet is referenced by meta.image (now lossless WebP) and present in the zip
  const sheetRef = manifest.meta.image;
  const sheetInZip = Object.keys(entries).some((n) => n.endsWith(sheetRef));
  console.log('SHEET', sheetRef, '· in zip', sheetInZip);

  // ── PIXEL-IDENTITY of the composed output vs the source (end-to-end compose correctness) ──
  // For every sprite that is untrimmed + unrotated in BOTH the source and the output manifest, the output
  // sheet region [outFrame] must equal the source sheet region [srcFrame] pixel-for-pixel — the verbatim
  // drawImage copy carried through the WHOLE fix (crop → compose → lossless-WebP encode). This is the first
  // end-to-end proof that the paid fix does not corrupt pixels. The transform paths (rotation, trim inset)
  // are covered by rotate-compose-check.mjs + the fix unit tests, so this deliberately compares only the
  // verbatim-copy sprites (no fragile un-rotate / un-trim math in the harness itself).
  const srcPng = readFileSync(join(FIX, 'symbols.png'));
  const srcManifest = JSON.parse(readFileSync(join(FIX, 'symbols.json'), 'utf8'));
  const outSheetName = Object.keys(entries).find((n) => n.endsWith(sheetRef));
  const pixel = await page.evaluate(
    async (srcB64, srcMani, outB64, outMani) => {
      const toBmp = async (b64, type) => {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return createImageBitmap(new Blob([arr], { type }));
      };
      const imgData = (bmp) => {
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext('2d');
        x.drawImage(bmp, 0, 0);
        return x.getImageData(0, 0, bmp.width, bmp.height);
      };
      const region = (img, f) => {
        const out = new Uint8ClampedArray(f.w * f.h * 4);
        for (let y = 0; y < f.h; y++)
          for (let x = 0; x < f.w; x++) {
            const si = ((f.y + y) * img.width + (f.x + x)) * 4;
            const di = (y * f.w + x) * 4;
            for (let k = 0; k < 4; k++) out[di + k] = img.data[si + k];
          }
        return out;
      };
      const s = imgData(await toBmp(srcB64, 'image/png'));
      const o = imgData(await toBmp(outB64, 'image/webp'));
      let compared = 0;
      let mismatchSprites = 0;
      let firstBad = null;
      for (const name of Object.keys(outMani.frames)) {
        const of = outMani.frames[name];
        const sf = srcMani.frames[name];
        if (!sf) continue;
        if (of.rotated || sf.rotated || of.trimmed || sf.trimmed) continue; // verbatim-copy sprites only
        if (of.frame.w !== sf.frame.w || of.frame.h !== sf.frame.h) continue;
        const op = region(o, of.frame);
        const sp = region(s, sf.frame);
        compared++;
        for (let i = 0; i < op.length; i++) {
          if (Math.abs(op[i] - sp[i]) > 1) {
            mismatchSprites++;
            if (!firstBad) firstBad = { name, i, got: op[i], exp: sp[i] };
            break;
          }
        }
      }
      return { compared, mismatchSprites, firstBad };
    },
    srcPng.toString('base64'),
    srcManifest,
    entries[outSheetName].toString('base64'),
    manifest,
  );
  console.log('PIXEL_IDENTITY compared', pixel.compared, 'verbatim sprites · mismatches', pixel.mismatchSprites, pixel.firstBad ? JSON.stringify(pixel.firstBad) : '');
  const pixelOk = pixel.compared >= 1 && pixel.mismatchSprites === 0;

  const ok = newArea < 512 * 512 && frameNames.length === 5 && inBounds && sheetInZip && pixelOk;
  console.log(ok ? 'FIX_E2E PASS' : 'FIX_E2E FAIL');
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
}
