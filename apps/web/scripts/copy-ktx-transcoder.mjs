// Self-host the Pixi KTX2 transcoder (round15 T4a / CORRECTION-1). Pixi v8's KTX2 loader DEFAULTS to a
// jsdelivr CDN fetch for libktx.js/libktx.wasm — a silent third-party network call + an offline break +
// a privacy/honesty regression. Pixi ships those two files INSIDE the package, so we copy them into the
// web app's served assets (public/transcoders/ktx/) and call setKTXTranscoderPath({jsUrl,wasmUrl}) to
// these same-origin URLs before the first KTX2 probe (see apps/web/src/lib/ktx2-probe-run.ts).
//
// Idempotent: re-copies only when the source is newer or the dest is missing. Runs on predev/prebuild so
// a fresh checkout (and a pixi.js version bump) always ships the matching transcoder. NEVER hits jsdelivr.

import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const destDir = resolve(here, '..', 'public', 'transcoders', 'ktx');

// Resolve the installed pixi.js package ROOT. Its package.json `exports` blocks `require.resolve(
// 'pixi.js/package.json')`, so resolve the main entry and walk up until `transcoders/ktx` is found
// (works under pnpm's symlinked store and a flat node_modules alike).
function pixiTranscoderDir() {
  let dir = dirname(require.resolve('pixi.js'));
  const root = parse(dir).root;
  while (dir !== root) {
    const candidate = join(dir, 'transcoders', 'ktx');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate pixi.js/transcoders/ktx from the resolved pixi.js entry');
}
const srcDir = pixiTranscoderDir();

const files = ['libktx.js', 'libktx.wasm'];

mkdirSync(destDir, { recursive: true });
for (const f of files) {
  const src = join(srcDir, f);
  const dest = join(destDir, f);
  if (!existsSync(src)) {
    console.error(`[copy-ktx-transcoder] missing source: ${src} — the KTX2 probe would fall back to CDN. Aborting.`);
    process.exit(1);
  }
  const needs = !existsSync(dest) || statSync(src).mtimeMs > statSync(dest).mtimeMs;
  if (needs) {
    copyFileSync(src, dest);
    console.log(`[copy-ktx-transcoder] ${f} -> public/transcoders/ktx/`);
  }
}
