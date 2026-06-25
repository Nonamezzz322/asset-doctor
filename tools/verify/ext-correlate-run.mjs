// End-to-end "moat closed in the extension": load the real extension on a fragmented WebGL page, then
// load a static asset folder via the extension's overlay input, and read the correlated verdict.
// Usage: CHROME=/path/to/chrome [URL=...] node tools/verify/ext-correlate-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../../apps/extension/dist');
const FIX = join(HERE, '../../fixtures/sample-projects/folder-waste');
const url = process.env.URL || 'http://localhost:5173/webgl-busy.html';

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: [...CHROME_ARGS, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!document.querySelector('input[type=file]') && !!window.__assetDoctor, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2500)); // let the profiler accumulate draws past warmup

  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  const pngs = readdirSync(FIX).filter((n) => n.endsWith('.png')).map((n) => join(FIX, n));
  await input.uploadFile(...pngs);

  await page.waitForFunction(() => !!window.__assetDoctorCorrelation, { timeout: 20000 });
  const c = await page.evaluate(() => window.__assetDoctorCorrelation);
  console.log('EXT_CORR ' + JSON.stringify(c));
} finally {
  await browser.close();
}
