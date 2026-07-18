// Live check: the extension overlay now computes atlas frame-region hashes, so the atlas-relationship
// findings (frame-redundancy / cross-atlas / loose-in-atlas) fire AND display in-page. Loads the
// frame-redundant fixture (an atlas with byte-identical duplicate frames) through the overlay input.
// Usage: CHROME=/path/to/chrome [URL=...] node tools/verify/ext-framehash-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '../../apps/extension/dist');
const FIX = join(HERE, '../../fixtures/sample-projects/frame-redundant');
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

  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  const files = readdirSync(FIX).filter((n) => /\.(json|png)$/.test(n)).map((n) => join(FIX, n));
  await input.uploadFile(...files);

  await page.waitForFunction(() => !!window.__assetDoctorCorrelation, { timeout: 20000 });
  const staticFindings = JSON.parse(await page.evaluate(() => window.__assetDoctor.export())).staticFindings ?? [];
  console.log('STATIC_RULES ' + JSON.stringify(staticFindings.map((f) => f.rule)));
  check('frame-redundancy fired — the extension now hashes atlas frame regions', staticFindings.some((f) => f.rule === 'frame-redundancy'));

  const staticCards = await page.evaluate(() => document.querySelectorAll('#__ad_static [data-sev]').length);
  console.log('STATIC_CARDS ' + staticCards);
  check('the atlas-relationship finding renders in the overlay static section', staticCards >= 1);

  console.log(failed ? 'EXT_FRAMEHASH FAIL' : 'EXT_FRAMEHASH PASS');
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
