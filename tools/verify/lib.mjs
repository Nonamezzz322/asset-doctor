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

