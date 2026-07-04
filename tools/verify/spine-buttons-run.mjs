// Diagnose the #spine "Open files / Open folder" dead-button report with REAL hit-testing in headless
// Chromium: serve the built app, open #spine, elementFromPoint at each button's center, then mouse-click
// (true hit-test path) with a click-spy on the hidden inputs. Dumps the stage stacking (children, z-index,
// pointer-events) so a stacking-context bug is visible in the output rather than theorized about.
// Usage: CHROME=/snap/bin/chromium node tools/verify/spine-buttons-run.mjs
//        APP_URL=http://localhost:5173/#spine CHROME=... node tools/verify/spine-buttons-run.mjs  (dev server)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 4183;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}/asset-doctor/#spine`;
const server = process.env.APP_URL
  ? null
  : spawn(process.execPath, [join(HERE, 'serve-sub.mjs')], {
      env: { ...process.env, PREFIX: '/asset-doctor', PORT: String(PORT) },
      stdio: 'ignore',
    });
await new Promise((r) => setTimeout(r, 600));

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e)));
  await page.goto(APP_URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('div[role=group][tabindex="0"]', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1200)); // let the engine async-init append the canvas

  const report = await page.evaluate(() => {
    const host = document.querySelector('div[role=group][tabindex="0"]');
    const info = { children: [], buttons: [], canvases: document.querySelectorAll('canvas').length };
    for (const el of host.children) {
      const cs = getComputedStyle(el);
      info.children.push({
        tag: el.tagName,
        cls: (el.className && String(el.className).slice(0, 90)) || '',
        position: cs.position,
        zIndex: cs.zIndex,
        pointerEvents: cs.pointerEvents,
      });
    }
    for (const b of host.querySelectorAll('button')) {
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      info.buttons.push({
        text: b.textContent.trim().slice(0, 30),
        cx: Math.round(cx),
        cy: Math.round(cy),
        topEl: top ? `${top.tagName}.${String(top.className).slice(0, 60)}` : 'null',
        hits: top === b || (top && b.contains(top)),
      });
    }
    // click spies on the two hidden inputs
    window.__spy = { files: false, folder: false };
    const inputs = document.querySelectorAll('input[type=file]');
    inputs.forEach((inp) => {
      inp.addEventListener('click', (e) => {
        e.preventDefault(); // don't open a real dialog in headless
        if (inp.hasAttribute('webkitdirectory')) window.__spy.folder = true;
        else window.__spy.files = true;
      });
    });
    info.inputs = inputs.length;
    return info;
  });
  console.log('STACKING', JSON.stringify(report, null, 1));

  // Real mouse clicks at the measured centers (goes through actual hit-testing).
  for (const b of report.buttons) {
    await page.mouse.click(b.cx, b.cy);
  }
  await new Promise((r) => setTimeout(r, 300));
  const spy = await page.evaluate(() => window.__spy);
  console.log('CLICK-SPY', JSON.stringify(spy));
  console.log('ERRORS', JSON.stringify(errors));
  const pass = spy.files === true;
  console.log(pass ? 'SPINE_BUTTONS PASS' : 'SPINE_BUTTONS FAIL');
} finally {
  await browser.close();
  server?.kill();
}
