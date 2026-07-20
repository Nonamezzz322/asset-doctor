// End-to-end proof of the fix's ACTIVE rotation compose — the highest-corruption-risk transform, with NO
// prior e2e coverage (rotate-compose-check.mjs verifies the transform in ISOLATION; no scenario made the fix
// actually rotate a real sprite). Loads tp-rotate-win (two opaque sprites the rect repack can only shrink by
// rotating one), runs the in-browser fix, and asserts the composed on-page region of the rotated sprite equals
// the SOURCE region put through the fix's EXACT forward rotate90 transform — the one rotate-compose-check
// already proved is a true 90-CW rotation. So we reuse the verified forward transform instead of writing a
// bug-prone inverse. If they match, the whole pipeline (repack emit geometry + compose + manifest) is correct.
// Usage: CHROME=/path/to/chrome [APP_URL=...] node tools/verify/fix-rotate-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, statSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/tp-rotate-win');
const DL = '/tmp/ad-dl-rot';
const appUrl = process.env.APP_URL || 'http://localhost:5173/';

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
  const files = readdirSync(FIX).filter((n) => statSync(join(FIX, n)).isFile() && !n.endsWith('.md') && !n.endsWith('.mjs')).map((n) => join(FIX, n));
  await input.uploadFile(...files);
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => /optimized folder|оптимизир/i.test(b.textContent || '')),
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /optimized folder|оптимизир/i.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForFunction(() => /optimized|оптимизир/i.test(document.body.innerText), { timeout: 40000 });

  let zipPath = null;
  for (let i = 0; i < 60; i++) {
    const z = readdirSync(DL).filter((n) => n.endsWith('.zip'));
    if (z.length && !readdirSync(DL).some((n) => n.endsWith('.crdownload'))) { zipPath = join(DL, z[0]); break; }
    await sleep(250);
  }
  if (!zipPath) throw new Error('no zip downloaded');
  const entries = unzip(readFileSync(zipPath));
  const manifestName = Object.keys(entries).find((n) => n.endsWith('.json'));
  const manifest = JSON.parse(entries[manifestName].toString('utf8'));
  const sheetRef = manifest.meta.image;
  const outSheetName = Object.keys(entries).find((n) => n.endsWith(sheetRef));
  const rotatedNames = Object.keys(manifest.frames).filter((n) => manifest.frames[n].rotated);
  console.log('ZIP_ENTRIES', Object.keys(entries).join(', '), '· rotated sprites:', rotatedNames.join(',') || '(none)');

  const srcPng = readFileSync(join(FIX, 'symbols-rot.png'));
  const srcManifest = JSON.parse(readFileSync(join(FIX, 'symbols-rot.json'), 'utf8'));
  const check = await page.evaluate(
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
      const s = imgData(await toBmp(srcB64, 'image/png'));
      const o = imgData(await toBmp(outB64, 'image/webp'));
      const rotName = Object.keys(outMani.frames).find((n) => outMani.frames[n].rotated);
      if (!rotName) return { rotated: false };
      // TexturePacker convention: the JSON `frame` of a rotated sprite is emitted UN-rotated (== source dims);
      // the ON-PAGE region a loader reads is SWAPPED — `frame.h` wide × `frame.w` tall — at (frame.x, frame.y).
      const of = outMani.frames[rotName].frame; // un-rotated dims: of.w == sw, of.h == sh
      const sf = srcMani.frames[rotName].frame; // source, unrotated: sw x sh
      const sw = sf.w;
      const sh = sf.h;
      // Extract the source region into a bitmap.
      const sc = new OffscreenCanvas(sw, sh);
      const sx = sc.getContext('2d');
      const sreg = sx.createImageData(sw, sh);
      for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++) {
          const si = ((sf.y + y) * s.width + (sf.x + x)) * 4;
          const di = (y * sw + x) * 4;
          for (let k = 0; k < 4; k++) sreg.data[di + k] = s.data[si + k];
        }
      sx.putImageData(sreg, 0, 0);
      const sbmp = sc.transferToImageBitmap();
      // Apply the fix's EXACT forward rotate90 (rotate-compose-check-verified) ⇒ expected on-page E (sh x sw).
      const ec = new OffscreenCanvas(sh, sw);
      const ex = ec.getContext('2d');
      ex.save();
      ex.translate(sh, 0);
      ex.rotate(Math.PI / 2);
      ex.drawImage(sbmp, 0, 0, sw, sh, 0, 0, sw, sh);
      ex.restore();
      const E = ex.getImageData(0, 0, sh, sw).data; // E is sh wide × sw tall
      // Compare the OUTPUT on-page region (SWAPPED: sh wide × sw tall, at of.x/of.y) against E.
      let compared = 0;
      let mismatches = 0;
      let firstBad = null;
      for (let y = 0; y < sw; y++) // on-page height = sw
        for (let x = 0; x < sh; x++) {
          // on-page width = sh
          const oi = ((of.y + y) * o.width + (of.x + x)) * 4;
          const ei = (y * sh + x) * 4; // E width = sh
          for (let k = 0; k < 4; k++) {
            compared++;
            if (Math.abs(o.data[oi + k] - E[ei + k]) > 1) {
              mismatches++;
              if (!firstBad) firstBad = { x, y, k, got: o.data[oi + k], exp: E[ei + k] };
            }
          }
        }
      return { rotated: true, rotName, sw, sh, onW: sh, onH: sw, compared, mismatches, firstBad };
    },
    srcPng.toString('base64'),
    srcManifest,
    entries[outSheetName].toString('base64'),
    manifest,
  );

  if (!check.rotated) {
    console.log('FIX_ROTATE_E2E FAIL — the fix did not rotate any sprite (fixture no longer triggers the gate)');
    process.exitCode = 1;
  } else {
    console.log('ROTATED', check.rotName, '· source', check.sw + '×' + check.sh, '→ on-page', check.onW + '×' + check.onH, '· compared', check.compared, 'channels · mismatches', check.mismatches, check.firstBad ? JSON.stringify(check.firstBad) : '');
    const ok = check.compared > 0 && check.mismatches === 0;
    console.log(ok ? 'FIX_ROTATE_E2E PASS (composed rotated sprite == forward-rotated source)' : 'FIX_ROTATE_E2E FAIL');
    if (!ok) process.exitCode = 1;
  }
} finally {
  await browser.close();
}
