// Verify the extension overlay localizes: load the real extension, switch to Russian, and confirm the
// live HUD + the correlation cards render in Russian (via the shared @asset-doctor/i18n runtime).
// Usage: CHROME=/path/to/chrome [URL=...] node tools/verify/ext-i18n-run.mjs
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
  await page.waitForFunction(() => !!window.__assetDoctor, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2500)); // profiler warmup + draws

  await page.evaluate(() => window.__assetDoctor.setLocale('ru'));
  await new Promise((r) => setTimeout(r, 1200)); // next HUD tick
  const hud = await page.evaluate(() => document.getElementById('__asset_doctor_hud')?.innerText ?? '');
  console.log('HUD has Cyrillic:', /[А-Яа-я]/.test(hud));

  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  await input.uploadFile(...readdirSync(FIX).filter((n) => n.endsWith('.png')).map((n) => join(FIX, n)));
  await page.waitForFunction(() => !!window.__assetDoctorCorrelation, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 300));
  const overlay = await page.evaluate(() => document.getElementById('__asset_doctor_hud')?.innerText ?? '');
  const cyr = /[А-Яа-я]/.test(overlay);
  const noBraces = !/\{[a-z]+(?::[a-z]+)?\}/.test(overlay);
  console.log('Overlay correlation Cyrillic:', cyr, '· no leftover placeholders:', noBraces);
  console.log('SNIPPET', JSON.stringify(overlay.replace(/\s+/g, ' ').slice(0, 320)));
  const ok = /[А-Яа-я]/.test(hud) && cyr && noBraces;
  console.log(ok ? 'EXT_I18N PASS' : 'EXT_I18N FAIL');
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
}
