// Build the MV3 extension into dist/: bundle the MAIN-world inject script (with the profiler SDK)
// into a single IIFE, and copy the manifest + popup. Run: pnpm --filter @asset-doctor/extension build
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const dist = join(HERE, 'dist');
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(HERE, 'src/inject.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome111',
  legalComments: 'none',
  outfile: join(dist, 'inject.js'),
});

copyFileSync(join(HERE, 'manifest.json'), join(dist, 'manifest.json'));
copyFileSync(join(HERE, 'popup.html'), join(dist, 'popup.html'));
console.log('extension built → apps/extension/dist/ (load unpacked in chrome://extensions)');
