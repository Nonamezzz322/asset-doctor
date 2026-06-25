// Upload a whole fixture folder into the app and verify the Folder report renders the
// cross-asset findings (exact duplicates via SHA-256, should-atlas, integrity, dHash similar).
// Exercises the worker's crypto.subtle + OffscreenCanvas paths in a real browser.
// Usage: CHROME=/path/to/chrome [APP_URL=...] node tools/verify/folder-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/folder-waste');
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const appUrl = process.env.APP_URL || 'http://localhost:5173/';

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
const logs = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1200 });
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push('ERROR ' + m.text());
  });

  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  const input = await page.$('input[type=file]');
  if (!input) throw new Error('file input not found');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);

  const files = readdirSync(FIX)
    .filter((n) => statSync(join(FIX, n)).isFile() && !n.endsWith('.md') && n !== 'expected.json')
    .map((n) => join(FIX, n));
  await input.uploadFile(...files);
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);

  await page.waitForFunction(() => /Folder report/i.test(document.body.innerText), { timeout: 30000 });
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  await page.screenshot({ path: join(OUT, 'folder.png'), fullPage: true });

  console.log('FOLDER_REPORT ' + /Folder report/i.test(text));
  console.log('DUP_EXACT ' + /identical file/i.test(text));
  console.log('SHOULD_ATLAS ' + /loose sprites/i.test(text));
  console.log('INTEGRITY ' + /Missing atlas image/i.test(text));
  console.log('NEAR_DUP ' + /near-identical/i.test(text));
  console.log('SNIPPET ' + JSON.stringify(text.slice(0, 760)));
} finally {
  console.log('LOGS ' + JSON.stringify(logs.slice(0, 10)));
  await browser.close();
}
