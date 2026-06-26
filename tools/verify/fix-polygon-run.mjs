// End-to-end proof of the binary polygon (mesh) packer in the REAL browser worker. Loads the
// poly-concave fixture (concave silhouettes whose bboxes waste space), runs the in-browser fix twice:
//  (a) polygon OFF → baseline rectangle repack → record the output sheet area (AREA_RECT);
//  (b) polygon ON  → mesh-aware nesting → capture the zip, parse the polygon manifest, and assert the
//      mesh ships (integer vertices/verticesUV/triangles, all UV in-bounds), every sprite is kept, the
//      referenced sheet is present, and AREA_POLY < AREA_RECT (the real-browser packing win).
// Nothing leaves the browser. Usage: CHROME=/path/to/chrome [APP_URL=...] node tools/verify/fix-polygon-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, statSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/poly-concave');
const DL = '/tmp/ad-dl-poly';
const appUrl = process.env.APP_URL || 'http://localhost:5173/';

// store-only zip reader (same layout the worker's zip.ts writes — local-file-header walk, no compression)
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

const fixFiles = readdirSync(FIX)
  .filter((n) => statSync(join(FIX, n)).isFile() && !n.endsWith('.md') && n !== 'expected.json')
  .map((n) => join(FIX, n));
const FRAME_COUNT = Object.keys(JSON.parse(readFileSync(join(FIX, 'atlas.json'), 'utf8')).frames).length;

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });

/** Upload the fixture, optionally toggle the polygon checkbox, click the fix button, wait for the
 *  receipt, and return { zip files, receipt text } for one run. Each run uses a fresh page. */
async function runFix(togglePolygon) {
  rmSync(DL, { recursive: true, force: true });
  mkdirSync(DL, { recursive: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERR ' + m.text()); });
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  await input.uploadFile(...fixFiles);
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);

  // wait for the FixCard run button (pro.cta) to appear
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => /optimized folder|оптимизир/i.test(b.textContent || '')),
    { timeout: 30000 },
  );

  if (togglePolygon) {
    // Toggle the polygon checkbox: find the <input type=checkbox> whose label text is the EN value of
    // fix.polygon ("Polygon pack…"); fall back to the 2nd checkbox in the FixCard (aggressive is 1st).
    const toggled = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('input[type=checkbox]')];
      const byLabel = boxes.find((b) => /polygon|mesh-aware|полигон/i.test(b.closest('label')?.textContent || ''));
      const target = byLabel || boxes[1];
      if (!target) return false;
      if (!target.checked) target.click();
      return target.checked;
    });
    console.log('POLYGON_CHECKBOX', toggled);
    if (!toggled) throw new Error('could not toggle the polygon checkbox');
  }

  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /optimized folder|оптимизир/i.test(x.textContent || ''));
    if (b) { b.click(); return b.textContent; }
    return null;
  });
  console.log('FIX_BUTTON', JSON.stringify(clicked));

  await page.waitForFunction(() => /✓ (optimized|оптимизир)/i.test(document.body.innerText), { timeout: 60000 });
  const receipt = await page.evaluate(() => {
    const card = [...document.querySelectorAll('div')].find((d) => /✓ (optimized|оптимизир)/i.test(d.textContent || ''));
    return card ? card.innerText.replace(/\s+/g, ' ').trim() : '';
  });

  let zipPath = null;
  for (let i = 0; i < 80; i++) {
    const z = readdirSync(DL).filter((n) => n.endsWith('.zip'));
    if (z.length && !readdirSync(DL).some((n) => n.endsWith('.crdownload'))) { zipPath = join(DL, z[0]); break; }
    await sleep(250);
  }
  if (!zipPath) throw new Error('no zip downloaded');
  const files = unzip(readFileSync(zipPath));
  await page.close();
  return { files, receipt };
}

/** Find the repacked atlas manifest in the zip (the fixture's atlas.json, possibly rewritten). */
function pickManifest(files) {
  const name = Object.keys(files).find((n) => n.endsWith('atlas.json'));
  if (!name) throw new Error('atlas.json not found in zip — entries: ' + Object.keys(files).join(', '));
  return JSON.parse(files[name].toString('utf8'));
}

let ok = true;
try {
  // ── (a) baseline: polygon OFF ──
  console.log('\n[run a] polygon OFF (baseline rectangle repack)');
  const base = await runFix(false);
  console.log('ZIP_ENTRIES', Object.keys(base.files).join(', '));
  const baseManifest = pickManifest(base.files);
  const AREA_RECT = baseManifest.meta.size.w * baseManifest.meta.size.h;
  console.log('AREA_RECT', baseManifest.meta.size.w + '×' + baseManifest.meta.size.h, '=', AREA_RECT);

  // ── (b) polygon ON ──
  console.log('\n[run b] polygon ON (mesh-aware nesting)');
  const poly = await runFix(true);
  console.log('ZIP_ENTRIES', Object.keys(poly.files).join(', '));
  console.log('RECEIPT', JSON.stringify(poly.receipt));
  const m = pickManifest(poly.files);
  const AREA_POLY = m.meta.size.w * m.meta.size.h;
  console.log('AREA_POLY', m.meta.size.w + '×' + m.meta.size.h, '=', AREA_POLY);

  // ── (c) assertions on the polygon manifest ──
  const frames = m.frames;
  const frameNames = Object.keys(frames).sort();
  const W = m.meta.size.w, H = m.meta.size.h;
  const isIntPairs = (a) => Array.isArray(a) && a.length >= 3 && a.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && Number.isInteger(p[1]));
  const isIntTris = (a) => Array.isArray(a) && a.length >= 1 && a.every((t) => Array.isArray(t) && t.length === 3 && t.every(Number.isInteger));

  let meshedFrames = 0;
  let uvInBounds = true;
  for (const n of frameNames) {
    const f = frames[n];
    const hasMesh = f.vertices && f.verticesUV && f.triangles;
    if (!hasMesh) continue;
    meshedFrames++;
    if (!isIntPairs(f.vertices) || !isIntPairs(f.verticesUV) || !isIntTris(f.triangles)) {
      console.log('BAD_MESH', n, '— non-integer vertices/verticesUV/triangles');
      ok = false;
    }
    for (const [ux, uy] of f.verticesUV) {
      if (ux < 0 || uy < 0 || ux > W || uy > H) { console.log('UV_OOB', n, ux, uy, 'bounds', W, H); uvInBounds = false; }
    }
  }
  console.log('MESHED_FRAMES', meshedFrames, '/', frameNames.length, '· frames kept', frameNames.length, '/', FRAME_COUNT);
  console.log('UV in-bounds', uvInBounds);

  // referenced sheet present in the zip
  const sheetRef = m.meta.image;
  const sheetInZip = Object.keys(poly.files).some((n) => n.endsWith(sheetRef));
  console.log('SHEET', sheetRef, '· in zip', sheetInZip);

  if (meshedFrames < 1) { console.log('FAIL: no frame carries vertices/verticesUV/triangles'); ok = false; }
  if (!uvInBounds) { console.log('FAIL: a verticesUV point is outside meta.size'); ok = false; }
  if (frameNames.length !== FRAME_COUNT) { console.log('FAIL: frame count', frameNames.length, '!=', FRAME_COUNT); ok = false; }
  if (!sheetInZip) { console.log('FAIL: referenced sheet not in zip'); ok = false; }
  if (!(AREA_POLY < AREA_RECT)) { console.log('FAIL: AREA_POLY', AREA_POLY, 'not <', 'AREA_RECT', AREA_RECT); ok = false; }
  // The on-screen receipt reports the meshed count (locale-dependent: EN "N sprites meshed" / RU "N
  // спрайтов с мешем"). Print it for the record; non-fatal (the manifest assertions above are the proof).
  const meshLine = (poly.receipt.match(/(\d+)\s+(?:sprites?\s+meshed|спрайт\S*\s+с\s+меш\S*)/i) || [])[0];
  console.log('RECEIPT_MESHED', meshLine ? JSON.stringify(meshLine) : '(not found — receipt may be in another locale)');

  console.log('\nAREA_RECT', AREA_RECT, '· AREA_POLY', AREA_POLY, '· win', AREA_POLY < AREA_RECT);
  console.log(ok ? 'FIX_POLYGON_E2E PASS' : 'FIX_POLYGON_E2E FAIL');
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.log('FIX_POLYGON_E2E FAIL —', e && e.message ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await browser.close();
}
