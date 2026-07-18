// Live end-to-end proof of the R6 premultiplied x measured-blend verdict (the P8 reopen precondition):
// load the real extension on a page that renders with an OBSERVABLE straight-alpha blend, then load a
// folder of premultiplied-SHAPED sprites via the overlay. The overlay computes pixel features in-page
// (@asset-doctor/pixel), so analyze fires the static premultiplied-alpha finding, and correlate pairs it
// with the measured blend into an R6 "halo" verdict — shown live in the overlay.
// Usage: CHROME=/path/to/chrome [URL=...] node tools/verify/ext-premult-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../../apps/extension/dist');
const FIX = join(HERE, '../../fixtures/sample-projects/premult-halo');
const url = process.env.URL || 'http://localhost:5173/webgl-blend.html';

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  args: [...CHROME_ARGS, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok) failed = true;
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!document.querySelector('input[type=file]') && !!window.__assetDoctor, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2500)); // let the profiler observe the blendFunc + accumulate frames

  const rtBlend = await page.evaluate(() => window.__assetDoctor.runtime().blend);
  console.log('RT_BLEND ' + JSON.stringify(rtBlend));
  check('renderer straight-alpha blend was measured', !!rtBlend && rtBlend.straight === true);

  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  const pngs = readdirSync(FIX).filter((n) => n.endsWith('.png')).map((n) => join(FIX, n));
  await input.uploadFile(...pngs);

  await page.waitForFunction(() => !!window.__assetDoctorCorrelation, { timeout: 20000 });
  const c = await page.evaluate(() => window.__assetDoctorCorrelation);
  const staticFindings = JSON.parse(await page.evaluate(() => window.__assetDoctor.export())).staticFindings ?? [];
  console.log('STATIC_RULES ' + JSON.stringify(staticFindings.map((f) => f.rule)));
  check('static premultiplied-alpha finding fired from real pixels', staticFindings.some((f) => f.rule === 'premultiplied-alpha'));

  const r6 = (c.findings || []).find((f) => f.rule === 'premultiplied-blend');
  console.log('R6 ' + JSON.stringify(r6 ? { severity: r6.severity, variant: r6.params?.variant, title: r6.title } : null));
  check('R6 premultiplied-blend verdict present', !!r6);
  check('R6 variant is halo (straight-alpha measured)', r6?.params?.variant === 'halo');
  check('R6 severity is warn', r6?.severity === 'warn');

  // The verdict must render localized in the overlay (a card is painted).
  const cardText = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#__asset_doctor_hud div')].map((d) => d.textContent || '');
    return cards.find((t) => /fringe|halo|premultiplied/i.test(t)) || null;
  });
  console.log('R6_CARD ' + JSON.stringify(cardText));
  check('R6 verdict rendered in the overlay', !!cardText);

  console.log(failed ? 'EXT_PREMULT_R6 FAIL' : 'EXT_PREMULT_R6 PASS');
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
