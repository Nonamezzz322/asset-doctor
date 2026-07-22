// End-to-end proof of the binary polygon (mesh) packer in the REAL browser worker. Loads the
// poly-concave fixture (concave silhouettes whose bboxes waste space), runs the in-browser fix twice:
//  (a) polygon OFF → baseline rectangle repack → record the output sheet area (AREA_RECT);
//  (b) polygon ON  → mesh-aware nesting → capture the zip, parse the polygon manifest, and assert the
//      mesh ships (integer vertices/verticesUV/triangles, all UV in-bounds) IFF the packer measures a
//      real VRAM win (polygonWins); every sprite is kept and the referenced sheet is present. When both
//      modes pack into the same POT bin there is NO win → NO mesh → honest rectangle fall-back (asserted).
// Nothing leaves the browser. Usage: CHROME=/path/to/chrome [APP_URL=...] node tools/verify/fix-polygon-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, statSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath, forceEnLocale, setBuildSetting } from './lib.mjs';

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

/** Upload the fixture, optionally enable polygon mode, click the fix button, wait for the receipt, and
 *  return { zip files, receipt text } for one run. Each run uses a fresh page. Polygon is a persisted
 *  BuildSetting (the Settings-page Switch), NOT a FixCard control — since the settings refactor the
 *  FixCard has no polygon checkbox, so it must be flipped in localStorage + full reload (setBuildSetting).
 *  Clicking a stray checkbox would silently leave polygon OFF and quietly run the rectangle path. */
async function runFix(polygon) {
  rmSync(DL, { recursive: true, force: true });
  mkdirSync(DL, { recursive: true });
  const page = await browser.newPage();
  await forceEnLocale(page); // deterministic EN asserts on a ru-locale system Chromium
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERR ' + m.text()); });
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  if (polygon) {
    const raw = await setBuildSetting(page, appUrl, [['"polygon":\\s*false', '"polygon": true']]);
    if (!/"polygon":\s*true/.test(raw)) throw new Error('failed to enable the polygon build setting');
    console.log('POLYGON_SETTING on');
  } else {
    await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  }
  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  await input.uploadFile(...fixFiles);
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);

  // wait for the FixCard run button (pro.cta) to appear
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => /optimized folder|оптимизир/i.test(b.textContent || '')),
    { timeout: 30000 },
  );

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
  const sheetEntry = Object.keys(poly.files).find((n) => n.endsWith(sheetRef));
  const sheetInZip = !!sheetEntry;
  console.log('SHEET', sheetRef, '· in zip', sheetInZip);

  // ── (c2) MESH-CLIP COMPOSE PIXEL-IDENTITY ───────────────────────────────────────────────────────────
  // The geometry checks above prove the mesh SHIPS; this proves the mesh-clip compose DREW correctly — the
  // most corruption-prone fix path (Blit.clip regions must be ⊆ footprint + mutually disjoint, else opaque
  // pixels are lost, misplaced, or overwritten by an interlocked neighbour, and the manifest looks perfect).
  // The polygon compose repositions without scaling (to.w == from.rect.w), so each source pixel (sx,sy) lands
  // at (packedFrame.x + (sx - srcFrame.x), packedFrame.y + (sy - srcFrame.y)), clipped to the mesh. Because
  // the conservative mesh ⊇ every opaque pixel (dilated outward), opaque source pixels are INTERIOR to the
  // clip ⇒ drawn fully (no edge antialiasing) ⇒ each must equal its source pixel in the (lossless) sheet.
  if (meshedFrames > 0 && sheetInZip) {
    const srcManifest = JSON.parse(readFileSync(join(FIX, 'atlas.json'), 'utf8'));
    const sheetMime = sheetRef.endsWith('.webp') ? 'image/webp' : sheetRef.endsWith('.png') ? 'image/png' : sheetRef.endsWith('.avif') ? 'image/avif' : 'image/webp';
    if (sheetMime === 'image/avif') {
      console.log('FAIL: packed sheet is lossy AVIF — pixel-identity is not decidable (expected lossless WebP/PNG for a repack sheet)');
      ok = false;
    } else {
      const meshedNames = frameNames.filter((n) => frames[n].vertices);
      const payload = {
        sheetB64: Buffer.from(poly.files[sheetEntry]).toString('base64'),
        sheetMime,
        srcB64: readFileSync(join(FIX, 'atlas.png')).toString('base64'),
        sprites: meshedNames.map((n) => ({ name: n, src: srcManifest.frames[n].frame, dst: frames[n].frame, rot: !!frames[n].rotated })),
      };
      const vpage = await browser.newPage();
      const res = await vpage.evaluate(async (p) => {
        const toImg = async (b64, type) => {
          const bin = atob(b64);
          const a = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
          const bmp = await createImageBitmap(new Blob([a], { type }));
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const x = c.getContext('2d');
          x.drawImage(bmp, 0, 0);
          return { d: x.getImageData(0, 0, bmp.width, bmp.height), w: bmp.width, h: bmp.height };
        };
        const src = await toImg(p.srcB64, 'image/png');
        const sheet = await toImg(p.sheetB64, p.sheetMime);
        let compared = 0, mismatch = 0, spritesChecked = 0, firstBad = null, dimBad = null;
        for (const s of p.sprites) {
          if (s.rot) { dimBad = dimBad || { name: s.name, why: 'unexpected rotated meshed frame' }; continue; }
          if (s.dst.w !== s.src.w || s.dst.h !== s.src.h) { dimBad = dimBad || { name: s.name, why: 'scaled (dst != src dims)', src: s.src, dst: s.dst }; continue; }
          spritesChecked++;
          for (let j = 0; j < s.src.h; j++) {
            for (let i = 0; i < s.src.w; i++) {
              const si = ((s.src.y + j) * src.w + (s.src.x + i)) * 4;
              if (src.d.data[si + 3] === 0) continue; // transparent source pixel — the mesh need not cover it
              const di = ((s.dst.y + j) * sheet.w + (s.dst.x + i)) * 4;
              let bad = false;
              for (let k = 0; k < 4; k++) if (Math.abs(src.d.data[si + k] - sheet.d.data[di + k]) > 1) { bad = true; break; }
              compared++;
              if (bad) { mismatch++; if (!firstBad) firstBad = { name: s.name, i, j, src: [...src.d.data.slice(si, si + 4)], dst: [...sheet.d.data.slice(di, di + 4)] }; }
            }
          }
        }
        return { compared, mismatch, spritesChecked, firstBad, dimBad };
      }, payload);
      await vpage.close();
      console.log('MESH_PIXEL sprites', res.spritesChecked, '/', meshedNames.length, '· opaque px compared', res.compared, '· mismatches', res.mismatch, res.dimBad ? '· DIMBAD ' + JSON.stringify(res.dimBad) : '', res.firstBad ? '· firstBad ' + JSON.stringify(res.firstBad) : '');
      if (res.dimBad) { console.log('FAIL: a meshed frame is rotated/scaled — the pure-translation pixel map does not hold'); ok = false; }
      if (res.spritesChecked !== meshedNames.length) { console.log('FAIL: not every meshed sprite was pixel-checked'); ok = false; }
      if (res.compared === 0) { console.log('FAIL: no opaque pixels compared — the check is vacuous'); ok = false; }
      if (res.mismatch > 0) { console.log('FAIL: mesh-clip compose corrupted opaque pixels (lost/misplaced/overwritten)'); ok = false; }
    }
  }

  // HONEST polygon gate (polygonWins = poly VRAM < rect VRAM). Two valid outcomes, both asserted:
  //  • a real win → mesh frames are emitted AND AREA_POLY < AREA_RECT;
  //  • no win (this fixture packs both into the same POT bin) → NO mesh, rectangle fall-back, and
  //    polygon output is never WORSE than rectangle. Forcing a mesh where the packer measures no VRAM
  //    win would violate invariant 3/5 — so 'no mesh here' is the CORRECT behavior, not a failure.
  if (meshedFrames > 0 && !(AREA_POLY < AREA_RECT)) { console.log('FAIL: mesh emitted without a measured VRAM win'); ok = false; }
  if (meshedFrames === 0 && AREA_POLY < AREA_RECT) { console.log('FAIL: an area win with no mesh — inconsistent'); ok = false; }
  if (AREA_POLY > AREA_RECT) { console.log('FAIL: polygon mode produced a WORSE sheet than rectangle', AREA_POLY, '>', AREA_RECT); ok = false; }
  if (!uvInBounds) { console.log('FAIL: a verticesUV point is outside meta.size'); ok = false; }
  if (frameNames.length !== FRAME_COUNT) { console.log('FAIL: frame count', frameNames.length, '!=', FRAME_COUNT); ok = false; }
  if (!sheetInZip) { console.log('FAIL: referenced sheet not in zip'); ok = false; }
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
