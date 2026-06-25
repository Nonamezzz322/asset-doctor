// Bundle the CLI into a single self-contained Node ESM file with a shebang + exec bit, so it runs as
// `asset-doctor` (bin) and the GitHub Action invokes the same artifact devs run. Node builtins stay
// external (platform: node); the workspace packages are bundled in. Run: pnpm --filter @asset-doctor/cli build
import { build } from 'esbuild';
import { chmodSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const dist = join(HERE, 'dist');
mkdirSync(dist, { recursive: true });
const outfile = join(dist, 'cli.js');

await build({
  entryPoints: [join(HERE, 'src/cli.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  outfile,
});

chmodSync(outfile, 0o755);
console.log('cli built → apps/cli/dist/cli.js');
