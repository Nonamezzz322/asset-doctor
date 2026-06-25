// Drive the end-to-end correlation demo in headless Chromium and print the doctor's verdict.
// Usage: CHROME=/path/to/chrome [URL=...] node tools/verify/correlate-run.mjs
import puppeteer from 'puppeteer-core';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const url = process.env.URL || 'http://localhost:5173/correlate.html';
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__correlation || window.__correlationError, { timeout: 40000 });
  const r = await page.evaluate(() => ({ correlation: window.__correlation, error: window.__correlationError }));
  console.log('CORRELATION_RESULT ' + JSON.stringify(r));
  if (errors.length) console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 6)));
} finally {
  await browser.close();
}
