// Shared launch flags for driving the system Chromium headless with SwiftShader WebGL.
import { realpathSync, existsSync } from 'node:fs';

export const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

// snap's `/snap/bin/chromium` is a symlink to `/usr/bin/snap`; launching it makes snap re-exec a
// confined process puppeteer can't pipe to or signal (WS-endpoint timeout / `kill EACCES`), and snap
// confinement blocks writes to /tmp and ~/.cache. Resolve such a wrapper to the real ELF binary inside
// the snap mount so puppeteer drives it directly (no confinement). Non-snap CHROME paths pass through.
const SNAP_CHROME_CANDIDATES = [
  '/snap/chromium/current/usr/lib/chromium-browser/chrome',
  '/snap/chromium/current/usr/lib/chromium/chrome',
];

export function chromePath() {
  const p = process.env.CHROME;
  if (!p) throw new Error('set CHROME=/path/to/chrome');
  let resolved = p;
  try {
    resolved = realpathSync(p);
  } catch {
    /* keep the literal path */
  }
  // `/snap/bin/chromium` → `/usr/bin/snap` (or anything under snap's bin): use the real chrome binary.
  if (resolved.endsWith('/snap') || resolved.includes('/snap/core')) {
    const real = SNAP_CHROME_CANDIDATES.find((c) => existsSync(c));
    if (real) return real;
  }
  return p;
}

/** Pin the app to the EN locale BEFORE any app script runs (the app reads localStorage 'ad.locale' at
 *  boot). The system Chromium reports the OS locale (ru on this machine), which made every English text
 *  assertion locale-fragile — the diagnosis worked, the assert read the wrong language. Deterministic
 *  via the app's own persisted switch, not --lang (snap Chromium ignores it). */
export function forceEnLocale(page) {
  return page.evaluateOnNewDocument(() => localStorage.setItem('ad.locale', 'en'));
}

/** Enable/change a persisted BuildSetting in an e2e: regex-edit the app's `ad.buildSettings` config JSON, then
 *  FULL-reload so the settings provider re-mounts and loads the change. This full reload is load-bearing — a
 *  HASH navigation (goto `${appUrl}#settings`) does NOT re-mount the provider ⇒ the app keeps its stale
 *  settings and the flip appears to do nothing (a real pitfall found the hard way). The app must have been
 *  loaded at least once so the provider has persisted the default config. `replacements` is an array of
 *  [patternSource, replacement] applied in order to the raw config string (patternSource is a RegExp source,
 *  no slashes, e.g. ['"packLoose":\\s*false', '"packLoose": true']). Silent no-op if a pattern misses — assert
 *  the resulting toggle state (aria-checked) when correctness matters. Returns the flipped raw JSON. */
export async function setBuildSetting(page, appUrl, replacements) {
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => !!localStorage.getItem('ad.buildSettings'), { timeout: 20000 });
  const raw = await page.evaluate((reps) => {
    let cfg = localStorage.getItem('ad.buildSettings');
    for (const [from, to] of reps) cfg = cfg.replace(new RegExp(from), to);
    localStorage.setItem('ad.buildSettings', cfg);
    return cfg;
  }, replacements);
  await page.goto(appUrl, { waitUntil: 'load', timeout: 60000 }); // FULL reload re-mounts the provider ⇒ change applies
  return raw;
}

