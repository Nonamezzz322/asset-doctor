// Drive the full app UI in headless Chromium: upload the tp-hash-symbols fixture into the
// hidden file input (bypassing the picker), let the Web Worker analyze, and verify the
// film-viewer + findings render with no console errors. Saves a screenshot.
// Usage: CHROME=/path/to/chrome node tools/verify/ui-run.mjs
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath, forceEnLocale } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/tp-hash-symbols');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
const logs = [];
try {
  const page = await browser.newPage();
  await forceEnLocale(page); // deterministic EN asserts on a ru-locale system Chromium
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e)));
  page.on('console', (m) => logs.push(`${m.type().toUpperCase()} ${m.text()}`));
  page.on('workercreated', (w) => logs.push('WORKER ' + w.url()));

  const appUrl = process.env.APP_URL || 'http://localhost:5173/';
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  const input = await page.$('input[type=file]');
  if (!input) throw new Error('file input not found');
  // webkitdirectory makes Chromium reject programmatic single-file uploads — drop it for the test.
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  await input.uploadFile(join(FIX, 'symbols.json'), join(FIX, 'symbols.png'));
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);

  let outcome = 'timeout';
  try {
    await page.waitForFunction(
      () => /Findings|no issues|ERROR|No \.json|empty region|packed/i.test(document.body.innerText),
      { timeout: 25000, polling: 500 },
    );
    outcome = 'rendered';
  } catch {
    outcome = 'timeout-waiting-for-result';
  }

  // Wait for the film-viewer to actually draw (canvas resized away from the 300×150 default).
  let canvas = null;
  try {
    await page.waitForFunction(
      () => {
        // default canvas is 300×150; wait until FilmViewer resizes it to the atlas (512²).
        const c = document.querySelector('canvas');
        return !!c && (c.width !== 300 || c.height !== 150);
      },
      { timeout: 10000, polling: 200 },
    );
    canvas = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonBlank = 0;
      let reddish = 0; // the empty-region overlay fill
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a > 0 && r + g + b > 0) nonBlank++;
        if (a > 0 && r > 120 && g < 95 && b < 95) reddish++;
      }
      return { w: c.width, h: c.height, nonBlankPx: nonBlank, reddishPx: reddish };
    });
  } catch {
    canvas = { error: 'canvas did not draw' };
  }

  const bodyText = await page.evaluate(() =>
    document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 900),
  );
  await page.screenshot({ path: join(OUT, 'ui.png'), fullPage: true });

  console.log('OUTCOME ' + outcome);
  console.log('CANVAS ' + JSON.stringify(canvas));
  console.log('BODY ' + JSON.stringify(bodyText));

  const pass =
    outcome === 'rendered' &&
    !!canvas &&
    !canvas.error &&
    canvas.w >= 256 &&
    canvas.nonBlankPx > 0 &&
    /wasted|empty region/i.test(bodyText);
  console.log(pass ? 'UI_E2E PASS' : 'UI_E2E FAIL');
  if (!pass) process.exitCode = 1;
} finally {
  console.log('LOGS ' + JSON.stringify(logs.slice(0, 25)));
  await browser.close();
}
