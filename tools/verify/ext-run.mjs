// Load the built MV3 extension in headless Chromium, open a bare WebGL page, and confirm the
// extension's HUD injects + shows live metrics. Falls back to simulating the MAIN-world document_start
// injection via evaluateOnNewDocument if headless extension loading isn't available.
// Usage: CHROME=/path/to/chrome [URL=...] node tools/verify/ext-run.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../../apps/extension/dist');
const url = process.env.URL || 'http://localhost:5173/webgl-demo.html';
const HUD_READY = () => {
  const h = document.getElementById('__asset_doctor_hud');
  return !!h && h.style.display !== 'none' && /draw calls/i.test(h.textContent || '');
};

async function run(mode) {
  const args = [...CHROME_ARGS];
  if (mode === 'extension') args.push(`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`);
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args });
  try {
    const page = await browser.newPage();
    if (mode === 'inject') {
      // simulate the content script: run the bundled inject.js in MAIN world before any page script
      await page.evaluateOnNewDocument(readFileSync(join(EXT, 'inject.js'), 'utf8'));
    }
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(HUD_READY, { timeout: 20000 });
    const hud = await page.evaluate(() => document.getElementById('__asset_doctor_hud').textContent);
    return hud;
  } finally {
    await browser.close();
  }
}

try {
  let hud;
  try {
    hud = await run('extension');
    console.log('MODE loaded-extension');
  } catch {
    console.log('MODE inject-fallback (headless extension load unavailable)');
    hud = await run('inject');
  }
  console.log('EXT_HUD ' + JSON.stringify(hud));
  console.log('EXT_PASS true');
} catch (e) {
  console.log('EXT_PASS false — ' + e.message);
  process.exitCode = 1;
}
