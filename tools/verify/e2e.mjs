// End-to-end gate: build the web app, serve it under a Pages-like subpath, and drive both the
// single-atlas and whole-folder scenarios in headless Chromium, asserting the real UI renders.
// Requires CHROME=/path/to/chrome in the environment (system Chromium works via SwiftShader).
// Run: CHROME=… pnpm e2e
import { spawn } from 'node:child_process';

const PORT = process.env.E2E_PORT || '4185';
const PREFIX = '/asset-doctor';
const APP_URL = `http://localhost:${PORT}${PREFIX}/`;

if (!process.env.CHROME) {
  console.error('e2e: set CHROME=/path/to/chrome');
  process.exit(2);
}

function sh(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → exit ${code}`))));
    p.on('error', reject);
  });
}

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start: ' + url);
}

console.log('e2e: build');
// Force the FREE-beta config (the deployed GH Pages build) regardless of a local .env.local — a dev
// machine wiring VITE_PRO_GATE=true for the backend would otherwise gate the FixCard behind Activate
// and break the fix/polygon scenarios. These flags mirror .env.example (production defaults).
await sh('pnpm', ['--filter', '@asset-doctor/web', 'build'], {
  VITE_PRO_GATE: 'false',
  VITE_API_BASE: '',
  VITE_LICENSE_PUBKEY: '',
  VITE_CHECKOUT_URL: '',
});

console.log('e2e: serve', APP_URL);
const server = spawn('node', ['tools/verify/serve-sub.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, PORT, PREFIX },
});

let failed = false;
try {
  await waitFor(APP_URL);
  console.log('\ne2e: scenario 1 — single atlas');
  await sh('node', ['tools/verify/ui-run.mjs'], { APP_URL });
  console.log('\ne2e: scenario 2 — whole folder');
  await sh('node', ['tools/verify/folder-run.mjs'], { APP_URL });
  console.log('\ne2e: scenario 3 — polygon packer');
  await sh('node', ['tools/verify/fix-polygon-run.mjs'], { APP_URL });
  console.log('\ne2e: scenario 4 — smoke (demo button · history strip · settings persist · compare)');
  await sh('node', ['tools/verify/smoke-run.mjs'], { APP_URL });
  console.log('\ne2e: PASS');
} catch (e) {
  console.error('\ne2e: FAIL —', e.message);
  failed = true;
} finally {
  server.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
