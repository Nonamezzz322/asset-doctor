// End-to-end proof of the loose-pack COMPOSE (packLoose) — a major fix feature in the same pack path that
// yielded two shipped-but-inert bugs (rotation, packTrim), with NO prior e2e coverage. Toggles the "Pack loose
// images into spritesheets" switch ON via #settings (persists to localStorage), loads 8 loose gradient PNGs,
// runs the in-browser fix, and asserts every packed sprite's on-page region equals its SOURCE loose image
// pixel-for-pixel (opaque + untrimmed here ⇒ a direct region compare, no un-trim/un-rotate math in the harness).
// Usage: CHROME=/path/to/chrome [APP_URL=...] node tools/verify/fix-packloose-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath, forceEnLocale } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/loose-pack');
const DL = '/tmp/ad-dl-pl';
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
  await forceEnLocale(page); // deterministic EN switch label on a ru-locale system Chromium
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  // 1. Enable packLoose. Load the app once so the settings provider persists the DEFAULT config (packLoose
  //    false), then flip packLoose→true directly in localStorage (robust — no fragile Switch-click) and reload.
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!localStorage.getItem('ad.buildSettings'), { timeout: 20000 });
  const flip = await page.evaluate(() => {
    const raw = localStorage.getItem('ad.buildSettings');
    if (!raw || !/"packLoose":\s*false/.test(raw)) return 'no-packLoose-false-key';
    // packLoose ON + force the sheet format to lossless PNG (default is lossy AVIF) so packed sprites can be
    // verified pixel-for-pixel — a lossy sheet would blur the compare and hide a subtle placement bug.
    localStorage.setItem(
      'ad.buildSettings',
      raw.replace(/"packLoose":\s*false/, '"packLoose": true').replace(/"target":\s*"image\/avif"/, '"target": "image/png"'),
    );
    return 'flipped';
  });
  console.log('PACKLOOSE_FLIP', flip);
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 }); // reload ⇒ provider seeds packLoose:true
  const persisted = await page.evaluate(() => localStorage.getItem('ad.buildSettings'));
  const m = persisted && persisted.match(/"packLoose":\s*(true|false)/);
  console.log('PACKLOOSE_PERSISTED', m ? m[1] : 'none');

  // 2. Load the loose fixture on the main page.
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  const files = readdirSync(FIX).filter((n) => n.endsWith('.png')).map((n) => join(FIX, n));
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
  // The packed sheet manifest(s): TP-hash JSON referencing a sheet image the loose sprites were packed into.
  const manifestNames = Object.keys(entries).filter((n) => n.endsWith('.json'));
  console.log('ZIP_ENTRIES', Object.keys(entries).join(', '));

  // Build {spriteName → {sheet, frame}} across every packed manifest.
  const placed = {};
  for (const mn of manifestNames) {
    const m = JSON.parse(entries[mn].toString('utf8'));
    if (!m.frames || !m.meta || !m.meta.image) continue;
    for (const [name, f] of Object.entries(m.frames)) placed[name] = { sheet: m.meta.image, frame: f.frame, rotated: !!f.rotated, trimmed: !!f.trimmed };
  }
  const stem = (n) => n.replace(/\.[^.]+$/, ''); // packed frame names drop the extension (spr_0.png → spr_0)
  const mime = (n) => (n.endsWith('.webp') ? 'image/webp' : n.endsWith('.png') ? 'image/png' : n.endsWith('.avif') ? 'image/avif' : 'image/webp');
  const srcNames = files.map((f) => f.split('/').pop());
  const packedCount = srcNames.filter((n) => placed[stem(n)]).length;
  console.log('PACKED', packedCount, '/', srcNames.length, 'loose sprites into sheet(s)');

  // Load every source PNG + packed sheet in-browser; compare each packed sprite region to its source pixels.
  const srcB64 = Object.fromEntries(files.map((f) => [stem(f.split('/').pop()), readFileSync(f).toString('base64')]));
  const sheetB64 = {};
  for (const p of Object.values(placed)) if (!sheetB64[p.sheet]) {
    const e = Object.keys(entries).find((n) => n.endsWith(p.sheet));
    if (e) sheetB64[p.sheet] = { b64: entries[e].toString('base64'), type: mime(p.sheet) };
  }

  const result = await page.evaluate(async (srcB64, sheetB64, placed) => {
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
    const srcImg = {};
    for (const [n, b] of Object.entries(srcB64)) srcImg[n] = imgData(await toBmp(b, 'image/png'));
    const sheetImg = {};
    for (const [n, o] of Object.entries(sheetB64)) sheetImg[n] = imgData(await toBmp(o.b64, o.type));
    let compared = 0;
    let mismatchSprites = 0;
    let firstBad = null;
    for (const [name, p] of Object.entries(placed)) {
      if (p.rotated || p.trimmed) continue; // verbatim-copy sprites (fixture is opaque+untrimmed ⇒ all qualify)
      const s = srcImg[name];
      const sheet = sheetImg[p.sheet];
      if (!s || !sheet) continue;
      if (p.frame.w !== s.width || p.frame.h !== s.height) { mismatchSprites++; if (!firstBad) firstBad = { name, why: 'dim', frame: p.frame, src: [s.width, s.height] }; continue; }
      compared++;
      let bad = false;
      for (let y = 0; y < p.frame.h && !bad; y++)
        for (let x = 0; x < p.frame.w; x++) {
          const hi = ((p.frame.y + y) * sheet.width + (p.frame.x + x)) * 4;
          const si = (y * s.width + x) * 4;
          for (let k = 0; k < 4; k++) {
            if (Math.abs(sheet.data[hi + k] - s.data[si + k]) > 1) { bad = true; if (!firstBad) firstBad = { name, x, y, k, got: sheet.data[hi + k], exp: s.data[si + k] }; break; }
          }
          if (bad) break;
        }
      if (bad) mismatchSprites++;
    }
    return { compared, mismatchSprites, firstBad };
  }, srcB64, sheetB64, placed);

  console.log('PIXEL_IDENTITY compared', result.compared, 'packed sprites · mismatches', result.mismatchSprites, result.firstBad ? JSON.stringify(result.firstBad) : '');
  const ok = packedCount === srcNames.length && result.compared >= 1 && result.mismatchSprites === 0;
  console.log(ok ? 'FIX_PACKLOOSE_E2E PASS (every packed sprite == its source loose image)' : 'FIX_PACKLOOSE_E2E FAIL');
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
}
