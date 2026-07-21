// End-to-end proof of the atlas-MERGE compose (aggressive mode: two under-filled DISTINCT atlases → ONE sheet,
// each sprite composed from its OWN source atlas, originals dropped + references rewritten). Enables aggressive
// via setBuildSetting (flip + full reload), confirms the toggle, merges tp-merge (atlas_a: a_red/a_blue ·
// atlas_b: b_green/b_gold — DISTINCT palettes so they merge instead of dedup), and asserts each merged sprite's
// region == its SOURCE atlas region pixel-for-pixel (the merged sheet is lossless WebP, so the compare is exact).
// Usage: CHROME=/path/to/chrome [APP_URL=...] node tools/verify/fix-merge-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath, forceEnLocale, setBuildSetting } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/tp-merge');
const DL = '/tmp/ad-dl-merge';
const appUrl = process.env.APP_URL || 'http://localhost:5173/';

function unzip(buf) {
  const files = {};
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    files[name] = buf.subarray(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + size);
    i = i + 30 + nameLen + extraLen + size;
  }
  return files;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.log('FIX_MERGE_E2E FAIL — ' + msg); process.exitCode = 1; };

rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERR ' + m.text()); });
  await forceEnLocale(page);
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  await setBuildSetting(page, appUrl, [['"aggressive":\\s*false', '"aggressive": true']]);
  await page.goto(appUrl + '#settings', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll('button[role=switch]')].length > 0, { timeout: 20000 }).catch(() => {});
  const aggOn = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[role=switch]')].find((b) => ((b.closest('label,div,li,tr,section') || b.parentElement)?.textContent || '').includes('Aggressive'));
    return btn ? btn.getAttribute('aria-checked') : 'not-found';
  });
  console.log('AGGRESSIVE_ON', aggOn);

  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  const files = readdirSync(FIX).filter((n) => (n.endsWith('.png') || n.endsWith('.json')) && n !== 'expected.json').map((n) => join(FIX, n));
  await input.uploadFile(...files);
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /optimized folder|оптимизир/i.test(b.textContent || '')), { timeout: 30000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /optimized folder|оптимизир/i.test(x.textContent || '')); if (b) b.click(); });
  await page.waitForFunction(() => /optimized|оптимизир/i.test(document.body.innerText), { timeout: 40000 });

  let zipPath = null;
  for (let i = 0; i < 60; i++) {
    const z = readdirSync(DL).filter((n) => n.endsWith('.zip'));
    if (z.length && !readdirSync(DL).some((n) => n.endsWith('.crdownload'))) { zipPath = join(DL, z[0]); break; }
    await sleep(250);
  }
  if (!zipPath) throw new Error('no zip downloaded');
  const entries = unzip(readFileSync(zipPath));
  console.log('ZIP_ENTRIES', Object.keys(entries).join(', '));

  const wanted = ['a_red.png', 'a_blue.png', 'b_green.png', 'b_gold.png'];
  let merged = null;
  for (const mn of Object.keys(entries).filter((n) => n.endsWith('.json'))) {
    const m = JSON.parse(entries[mn].toString('utf8'));
    if (m.frames && wanted.every((n) => m.frames[n])) { merged = m; break; }
  }
  if (!merged) { fail(`no single merged sheet carries all 4 sprites (aggressive=${aggOn})`); }
  else {
    const srcMani = { atlas_a: JSON.parse(readFileSync(join(FIX, 'atlas_a.json'), 'utf8')), atlas_b: JSON.parse(readFileSync(join(FIX, 'atlas_b.json'), 'utf8')) };
    const srcOf = (name) => (name.startsWith('a_') ? 'atlas_a' : 'atlas_b');
    const mergedSheet = merged.meta.image;
    const mergedEntry = Object.keys(entries).find((n) => n.endsWith(mergedSheet));
    const mime = (n) => (n.endsWith('.webp') ? 'image/webp' : n.endsWith('.png') ? 'image/png' : n.endsWith('.avif') ? 'image/avif' : 'image/webp');
    const payload = {
      mergedB64: entries[mergedEntry].toString('base64'), mergedType: mime(mergedSheet),
      atlasA: readFileSync(join(FIX, 'atlas_a.png')).toString('base64'), atlasB: readFileSync(join(FIX, 'atlas_b.png')).toString('base64'),
      sprites: wanted.map((n) => ({ name: n, src: srcOf(n), srcFrame: srcMani[srcOf(n)].frames[n].frame, mergedFrame: merged.frames[n].frame, rotated: !!merged.frames[n].rotated, trimmed: !!merged.frames[n].trimmed })),
    };
    const result = await page.evaluate(async (p) => {
      const toBmp = async (b64, type) => { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return createImageBitmap(new Blob([a], { type })); };
      const imgData = (bmp) => { const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); return x.getImageData(0, 0, bmp.width, bmp.height); };
      const mrg = imgData(await toBmp(p.mergedB64, p.mergedType));
      const src = { atlas_a: imgData(await toBmp(p.atlasA, 'image/png')), atlas_b: imgData(await toBmp(p.atlasB, 'image/png')) };
      let compared = 0, mismatch = 0, firstBad = null;
      for (const s of p.sprites) {
        if (s.rotated || s.trimmed) continue;
        if (s.mergedFrame.w !== s.srcFrame.w || s.mergedFrame.h !== s.srcFrame.h) { mismatch++; if (!firstBad) firstBad = { name: s.name, why: 'dim' }; continue; }
        const si = src[s.src]; compared++; let bad = false;
        for (let y = 0; y < s.mergedFrame.h && !bad; y++) for (let x = 0; x < s.mergedFrame.w; x++) {
          const mi = ((s.mergedFrame.y + y) * mrg.width + (s.mergedFrame.x + x)) * 4, sidx = ((s.srcFrame.y + y) * si.width + (s.srcFrame.x + x)) * 4;
          for (let k = 0; k < 4; k++) if (Math.abs(mrg.data[mi + k] - si.data[sidx + k]) > 1) { bad = true; if (!firstBad) firstBad = { name: s.name, x, y, k, got: mrg.data[mi + k], exp: si.data[sidx + k] }; break; }
          if (bad) break;
        }
        if (bad) mismatch++;
      }
      return { compared, mismatch, firstBad };
    }, payload);
    const originalsDropped = !Object.keys(entries).some((n) => n.endsWith('atlas_a.png') || n.endsWith('atlas_b.png'));
    console.log('MERGED', mergedSheet, '· originals dropped', originalsDropped, '· compared', result.compared, '· mismatches', result.mismatch, result.firstBad ? JSON.stringify(result.firstBad) : '');
    if (result.compared === 4 && result.mismatch === 0 && originalsDropped) console.log('FIX_MERGE_E2E PASS (every merged sprite == its source atlas region · originals dropped)');
    else fail(`compared=${result.compared} mismatch=${result.mismatch} dropped=${originalsDropped}`);
  }
} finally {
  await browser.close();
}
