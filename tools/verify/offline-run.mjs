// P5 PWA proof — the offline shell in a real headless Chromium. Load online (the service worker installs
// + precaches the shell), run a demo diagnosis (caches the demo-data lazy chunk cache-first), then flip
// the browser OFFLINE, reload, and assert the app still boots AND still runs a full diagnosis from cache.
// This is the strongest privacy claim made executable: with the network physically off, the diagnosis
// still works — nothing ever needed the network (invariant 1). Usage:
//   CHROME=/path/to/chrome APP_URL=http://localhost:PORT/prefix/ node tools/verify/offline-run.mjs
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath, forceEnLocale } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });
const appUrl = process.env.APP_URL || 'http://localhost:5173/';

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
const fails = [];
const ok = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'} — ${name}`);
  if (!cond) fails.push(name);
};
const clickDemo = (page) =>
  page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /try a sample project/i.test(b.textContent || ''))?.click());
const waitText = (page, re, t = 25000) =>
  page.waitForFunction((s) => new RegExp(s, 'i').test(document.body.innerText), { timeout: t, polling: 400 }, re);

try {
  const page = await browser.newPage();
  await forceEnLocale(page);

  // ── online: register + install the SW, cache the demo path ──
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  const swActive = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready; // resolves after install (precache addAll) + activate
    return !!reg.active;
  });
  ok('service worker registers + activates (precache complete)', swActive);
  await clickDemo(page);
  await waitText(page, /demo-project/i); // demo-data lazy chunk fetched online → runtime-cached
  await new Promise((r) => setTimeout(r, 800));

  // ── go OFFLINE and reload: the shell must boot from cache ──
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await waitText(page, /asset doctor/i, 15000);
  const bootedOffline = await page.evaluate(() => /drag|drop|folder|try a sample/i.test(document.body.innerText));
  ok('offline reload → app shell boots from cache', bootedOffline);

  // ── full diagnosis with the network physically off ──
  await clickDemo(page);
  await waitText(page, /demo-project/i, 25000);
  await waitText(page, /problems? found/i, 25000);
  await new Promise((r) => setTimeout(r, 1500)); // let the severity tally paint before reading
  const body = await page.evaluate(() => document.body.innerText);
  ok(
    'offline → a full demo diagnosis still runs (worker precached, no network)',
    /demo-project/i.test(body) && /problems? found/i.test(body) && /\bcrit\b/i.test(body),
  );
  await page.screenshot({ path: join(OUT, 'offline.png'), fullPage: true });
  await page.setOfflineMode(false);

  console.log(fails.length === 0 ? 'OFFLINE_E2E PASS' : `OFFLINE_E2E FAIL (${fails.length}): ${fails.join(' | ')}`);
  if (fails.length > 0) process.exitCode = 1;
} catch (e) {
  console.error('OFFLINE_E2E FAIL —', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
