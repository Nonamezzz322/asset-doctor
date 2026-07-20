// P7 e2e smoke — drives the NEWER surfaces the older verify scripts predate, in ONE headless session:
//   1. the landing DEMO button (P4) → a full real diagnosis renders (worker, triage, film);
//   2. reload + demo again → the local-history strip (P6) shows the measured "since last audit" delta;
//   3. #settings: a user budget survives a reload (localStorage persistence round-trip);
//   4. #compare (V4): two session JSONs load, attestation ticks, the verdict banner + rows render.
// Assertions target the EN catalog strings (headless Chromium reports en-US). Extends the proven
// puppeteer-core + system-Chromium harness (lib.mjs) — deliberately NOT a new Playwright stack: same
// coverage, zero new browser downloads, one automation stack to maintain.
// Usage: CHROME=/path/to/chrome APP_URL=http://localhost:PORT/prefix/ node tools/verify/smoke-run.mjs
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHROME_ARGS, chromePath, forceEnLocale } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
mkdirSync(OUT, { recursive: true });

const appUrl = process.env.APP_URL || 'http://localhost:5173/';
const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
const logs = [];
const fails = [];
const ok = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'} — ${name}`);
  if (!cond) fails.push(name);
};

/** Click the button whose visible text matches `re` (the i18n-rendered label). */
async function clickByText(page, re) {
  const clicked = await page.evaluate((reSrc) => {
    const rx = new RegExp(reSrc, 'i');
    const btn = [...document.querySelectorAll('button')].find((b) => rx.test(b.textContent ?? ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, re.source);
  if (!clicked) throw new Error(`button /${re.source}/i not found`);
}

const waitText = (page, re, timeout = 30000) =>
  page.waitForFunction((reSrc) => new RegExp(reSrc, 'i').test(document.body.innerText), { timeout, polling: 400 }, re.source);

try {
  const page = await browser.newPage();
  await forceEnLocale(page); // deterministic EN asserts on a ru-locale system Chromium
  await page.setViewport({ width: 1360, height: 940 });
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e)));

  // ── 1. demo button → full diagnosis ────────────────────────────────────────────────────────────
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  await clickByText(page, /try a sample project/);
  await waitText(page, /demo-project/i); // the results header carries the demo folder name
  // Wait for the severity tally to actually paint (the demo's stale-manifest sheet is a crit) — reading
  // the body the instant "demo-project" appears races the VerdictBar chip render.
  await waitText(page, /\bcrit\b/i);
  const body1 = await page.evaluate(() => document.body.innerText);
  ok('demo → diagnosis renders (demo-project header)', /demo-project/i.test(body1));
  ok('demo → a crit finding surfaced (stale-manifest sheet)', /\bcrit\b/i.test(body1));
  // biggest-wins panel: renders on a REAL diagnosis (the demo has disk + VRAM estimate-bearing findings) and a
  // row click JUMPS the film to that asset (onSelect sets the same selection state onRowClick does).
  ok('demo → biggest-wins panel renders', /the biggest wins/i.test(body1));
  const winAsset = await page.evaluate(() => {
    const h = document.getElementById('ad-wins-h');
    const panel = h && h.closest('section');
    const btn = panel && panel.querySelector('ul button');
    if (!btn) return null;
    const asset = btn.querySelectorAll('span')[1]?.textContent ?? ''; // [0]=dot, [1]=assetRef
    btn.click();
    return asset;
  });
  ok('demo → a biggest-win row is present + clickable', typeof winAsset === 'string' && winAsset.length > 0);
  await page.waitForFunction(
    (asset) => [...document.querySelectorAll('span.truncate.text-film-soft')].some((e) => e.textContent === asset),
    { timeout: 10000, polling: 200 },
    winAsset,
  );
  ok('demo → clicking a biggest-win jumps the film to that asset', true); // waitForFunction throws on timeout
  await page.screenshot({ path: join(OUT, 'smoke-demo.png'), fullPage: true });
  await new Promise((r) => setTimeout(r, 500)); // let the history snapshot persist before the reload

  // ── 2. reload + demo again → history strip (P6) ────────────────────────────────────────────────
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  await clickByText(page, /try a sample project/);
  await waitText(page, /demo-project/i);
  await waitText(page, /since the last audit/i, 20000);
  const body2 = await page.evaluate(() => document.body.innerText);
  ok('re-audit → history strip appears', /since the last audit/i.test(body2));
  ok('history strip is honest on an identical re-run (no change / counts line)', /no measured change|new .*resolved/i.test(body2));
  await page.screenshot({ path: join(OUT, 'smoke-history.png'), fullPage: true });

  // ── 3. #settings budget persists a reload ──────────────────────────────────────────────────────
  await page.goto(appUrl + '#settings', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('input[type=number]', { timeout: 15000 });
  await page.evaluate(() => {
    const el = document.querySelector('input[type=number]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '123');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400)); // let the persist effect flush
  await page.goto(appUrl + '#settings', { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('input[type=number]', { timeout: 15000 });
  const persisted = await page.evaluate(() => document.querySelector('input[type=number]').value);
  ok(`settings: first numeric setting survives reload (value ${persisted})`, persisted === '123');

  // ── 4. #compare loads two sessions → verdict + rows ────────────────────────────────────────────
  const session = (frames, draws) =>
    JSON.stringify({
      frames, durationMs: 10000,
      drawCalls: { avg: draws, max: draws + 50 }, textureBinds: { avg: 40, max: 80 },
      redundantBinds: 500, uploadsDuringGameplay: 3, shaderCompilesDuringGameplay: 1,
      liveTextures: 60, vramBytes: 128 * 1024 * 1024, compressedBytes: 0,
      hitches: [], timing: { fps: 60, frameTimeMsAvg: 16.6, frameTimeMsP95: 20, deviceDependent: true },
    });
  const beforePath = join(OUT, 'smoke-session-before.json');
  const afterPath = join(OUT, 'smoke-session-after.json');
  writeFileSync(beforePath, session(600, 120));
  writeFileSync(afterPath, session(600, 90));
  await page.goto(appUrl + '#compare', { waitUntil: 'load', timeout: 60000 });
  await waitText(page, /runtime a\/b/i, 15000);
  const fileInputs = await page.$$('input[type=file]');
  ok('compare: two session inputs render', fileInputs.length >= 2);
  await fileInputs[0].uploadFile(beforePath);
  await fileInputs[1].uploadFile(afterPath);
  await waitText(page, /sessions look comparable|differ a lot|too short/i, 15000);
  const body4 = await page.evaluate(() => document.body.innerText);
  ok('compare: verdict banner rendered', /sessions look comparable/i.test(body4));
  ok('compare: the measured draw-call delta row rendered', /draw calls \/ frame/i.test(body4));
  await page.screenshot({ path: join(OUT, 'smoke-compare.png'), fullPage: true });

  console.log(fails.length === 0 ? 'SMOKE_E2E PASS' : `SMOKE_E2E FAIL (${fails.length}): ${fails.join(' | ')}`);
  if (fails.length > 0) process.exitCode = 1;
} catch (e) {
  console.error('SMOKE_E2E FAIL —', e.message);
  console.log('LOGS ' + JSON.stringify(logs.slice(0, 25)));
  process.exitCode = 1;
} finally {
  await browser.close();
}
