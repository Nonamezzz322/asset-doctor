// Verify the web app localizes end-to-end: locale from storage on load, the language switcher, and
// localized FINDINGS (renderFinding) after a real analysis. Usage: CHROME=... [APP_URL=...] node tools/verify/i18n-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/folder-waste');
const appUrl = process.env.APP_URL || 'http://localhost:5173/';

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  await page.evaluateOnNewDocument(() => localStorage.setItem('ad.locale', 'ru'));
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });

  const heading = async () => (await page.$eval('h1', (el) => el.textContent))?.trim();
  console.log('RU dropzone:', JSON.stringify(await heading()));

  // switch language via the picker and confirm the heading re-renders in each script
  const setLang = async (code) => {
    await page.select('select', code);
    await new Promise((r) => setTimeout(r, 120));
    return heading();
  };
  console.log('EN dropzone:', JSON.stringify(await setLang('en')));
  console.log('ZH dropzone:', JSON.stringify(await setLang('zh')));
  console.log('HI dropzone:', JSON.stringify(await setLang('hi')));

  // back to RU, then run a real analysis and read localized findings
  await setLang('ru');
  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  const files = readdirSync(FIX).filter((n) => statSync(join(FIX, n)).isFile() && !n.endsWith('.md') && n !== 'expected.json').map((n) => join(FIX, n));
  await input.uploadFile(...files);
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);
  await page.waitForFunction(() => /Отчёт по папке/.test(document.body.innerText), { timeout: 30000 });
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  console.log('RU folder.title present:', /Отчёт по папке/.test(text));
  console.log('RU integrity finding present:', /Отсутствует изображение атласа/.test(text));
  console.log('RU should-atlas finding present:', /отдельных sprite/.test(text));
  console.log('No leftover placeholders:', !/\{[a-z]+(?::[a-z]+)?\}/.test(text));

  const ok = /Отчёт по папке/.test(text) && /Отсутствует изображение атласа/.test(text) && !/\{[a-z]+(?::[a-z]+)?\}/.test(text);
  console.log(ok ? 'I18N_E2E PASS' : 'I18N_E2E FAIL');
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
}
