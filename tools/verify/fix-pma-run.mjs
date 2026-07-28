// End-to-end proof that the fix REFUSES to recompose a premultiplied-alpha (pma: true) Spine atlas
// (canvas 2D cannot round-trip premultiplied pixels byte-losslessly — measured up to Δ8 on low-alpha
// edges, tools/verify/pma-roundtrip-measure.mjs) and instead surfaces an honest skip, leaving the atlas
// UNTOUCHED with its pma flag intact. Uploads fixtures/sample-projects/spine-pma (an under-filled ~16%
// atlas whose occupancy finding would otherwise trigger a repack), runs the default fix, then asserts
// (1) the receipt lists a "premultiplied ... not supported" skip and (2) the output .atlas still declares
// pma: true (the flag was NOT silently dropped). Usage: CHROME=/path node tools/verify/fix-pma-run.mjs
import puppeteer from 'puppeteer-core';
import { readdirSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath, forceEnLocale } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '../../fixtures/sample-projects/spine-pma');
const DL = '/tmp/ad-dl-pma';
const appUrl = process.env.APP_URL || 'http://localhost:5173/';

function unzip(buf) {
  const files = {};
  let i = 0;
  while (i + 4 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    files[name] = buf.subarray(i + 30 + nameLen + extraLen, i + 30 + nameLen + extraLen + size);
    i = i + 30 + nameLen + extraLen + size;
  }
  return files;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.log('FIX_PMA_E2E FAIL — ' + msg); process.exitCode = 1; };

rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERR ' + m.text()); });
  await forceEnLocale(page);
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  const input = await page.$('input[type=file]');
  await page.evaluate((el) => el.removeAttribute('webkitdirectory'), input);
  const files = readdirSync(FIX).filter((n) => n.endsWith('.atlas') || n.endsWith('.png')).map((n) => join(FIX, n));
  await input.uploadFile(...files);
  await page.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })), input);
  // Kick the Pro fix (its dry-run plan preview → execute → receipt flow). The CTA runs it through to the
  // receipt; poll until the receipt surfaces (the pma skip appears, or the redownload button shows).
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /optimized folder|оптимизир/i.test(b.textContent || '')), { timeout: 30000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /optimized folder|оптимизир/i.test(x.textContent || '')); if (b) b.click(); });
  await page.waitForFunction(
    () => { document.querySelectorAll('details').forEach((d) => (d.open = true)); return /premultiplied/i.test(document.body.innerText) || [...document.querySelectorAll('button')].some((b) => /download \.zip|скачать \.zip/i.test(b.textContent || '')); },
    { timeout: 45000 },
  );

  // Read every skipped <li> reason (details already opened above).
  const skips = await page.evaluate(() => [...document.querySelectorAll('li')].map((li) => (li.textContent || '').trim()).filter(Boolean));
  const pmaSkip = skips.find((s) => /premultiplied/i.test(s) && /not supported/i.test(s));
  console.log('PMA_SKIP', pmaSkip || '(none)');

  // The output folder must still carry the atlas with pma: true intact (refuse ⇒ verbatim passthrough).
  let atlasText = null;
  for (let i = 0; i < 60; i++) {
    const z = readdirSync(DL).filter((n) => n.endsWith('.zip'));
    if (z.length && !readdirSync(DL).some((n) => n.endsWith('.crdownload'))) {
      const entries = unzip(readFileSync(join(DL, z[0])));
      const atlasKey = Object.keys(entries).find((n) => n.endsWith('.atlas'));
      if (atlasKey) atlasText = entries[atlasKey].toString('utf8');
      break;
    }
    await sleep(250);
  }
  const pmaPreserved = atlasText != null && /(^|\n)\s*pma:\s*true/i.test(atlasText);
  const sizeLine = atlasText && atlasText.split('\n').find((l) => /^size:/.test(l));
  const passthrough = !!sizeLine && /256\s*,\s*256/.test(sizeLine); // unchanged sheet ⇒ NOT recomposed
  console.log('OUTPUT_ATLAS size:', sizeLine, '· pma preserved:', pmaPreserved, '· passthrough(256²):', passthrough);

  // Three independent proofs of the refusal: (1) the skip is surfaced, (2) the output sheet is the ORIGINAL
  // 256×256 (never recomposed to a tighter bin), (3) the pma flag survived in the output .atlas.
  if (!pmaSkip) fail('premultiplied-atlas skip was NOT surfaced in the receipt');
  else if (!passthrough) fail('atlas was recomposed (sheet size changed) — the pma refusal did not hold');
  else if (!pmaPreserved) fail('output .atlas dropped pma: true (silent flag loss)');
  else console.log('FIX_PMA_E2E PASS (repack refused + surfaced · sheet 256² untouched · pma: true preserved)');
} finally {
  await browser.close();
}
