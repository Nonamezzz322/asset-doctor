// Drive the render-probe harness in headless Chromium and print the real reading.
// Usage: CHROME=/path/to/chrome URL=http://localhost:5173/probe.html node tools/verify/probe-run.mjs
import puppeteer from 'puppeteer-core';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const url = process.env.URL || 'http://localhost:5173/probe.html';
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__probe || window.__probeError, { timeout: 60000 });
  const result = await page.evaluate(() => ({ probe: window.__probe, error: window.__probeError }));
  console.log('PROBE_RESULT ' + JSON.stringify(result));
  if (errors.length) console.log('CONSOLE_ERRORS ' + JSON.stringify(errors.slice(0, 6)));
} finally {
  await browser.close();
}
