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

  await page.waitForFunction(() => /optimized/i.test(document.body.innerText), { timeout: 30000 });
  const receipt = await page.evaluate(() => {
    const card = [...document.querySelectorAll('div')].find((d) => /✓ optimized/.test(d.textContent || ''));
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
  console.log('PNG present', !!Object.keys(entries).find((n) => n.endsWith('symbols.png')));

  const ok = newArea < 512 * 512 && frameNames.length === 5 && inBounds && !!Object.keys(entries).find((n) => n.endsWith('symbols.png'));
  console.log(ok ? 'FIX_E2E PASS' : 'FIX_E2E FAIL');
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
}
