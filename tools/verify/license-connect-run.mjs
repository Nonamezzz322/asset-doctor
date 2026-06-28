// Proves the FRONTEND ↔ BACKEND license connection against the LIVE backend, over the exact HTTP
// contract apps/web/src/lib/license.ts uses. Reads apps/web/.env.local for VITE_API_BASE +
// VITE_LICENSE_PUBKEY. Pass a dev license key (from `apps/api: go run ./tools/devmint`) as argv[2] or
// env DEV_KEY to exercise the positive activate→sign→offline-verify loop; without one it still proves
// reachability + the pubkey + the JSON error contract (negative activate).
//
//   node tools/verify/license-connect-run.mjs <DEV_KEY>
import { readFileSync } from 'node:fs';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = Object.fromEntries(
  readFileSync(resolve(root, 'apps/web/.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const API = (env.VITE_API_BASE || '').replace(/\/+$/, '');
const PUB = (env.VITE_LICENSE_PUBKEY || '').trim();
const DEV_KEY = process.argv[2] || process.env.DEV_KEY || '';
const DEVICE = 'license-connect-verify';

let failed = 0;
const ok = (m) => console.log('  PASS', m);
const bad = (m) => {
  console.log('  FAIL', m);
  failed++;
};

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
// Mirror license.ts verifyEntitlementToken: msg = first segment, sig = ed25519 over utf8(msg).
function verifyToken(token) {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const msg = token.slice(0, dot);
  const sig = b64urlToBuf(token.slice(dot + 1));
  if (sig.length !== 64) return null;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(PUB, 'base64')]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (!edVerify(null, Buffer.from(msg, 'utf8'), key, sig)) return null;
  return JSON.parse(b64urlToBuf(msg).toString('utf8'));
}

async function main() {
  console.log(`license connect → API=${API} pubkey=${PUB.slice(0, 12)}…`);
  if (!API || !PUB) {
    bad('VITE_API_BASE / VITE_LICENSE_PUBKEY missing from apps/web/.env.local');
    return done();
  }

  // 1) healthz
  try {
    const h = await (await fetch(`${API}/healthz`)).json();
    if (h.status === 'ok') ok('healthz ok');
    else bad(`healthz: ${JSON.stringify(h)}`);
  } catch (e) {
    bad(`healthz unreachable: ${e.message}`);
  }

  // 2) pubkey matches what the frontend has embedded (the offline-verify anchor)
  try {
    const p = await (await fetch(`${API}/v1/pubkey`)).json();
    if (p.publicKey === PUB) ok('backend pubkey matches VITE_LICENSE_PUBKEY');
    else bad(`pubkey mismatch: ${p.publicKey} != ${PUB}`);
  } catch (e) {
    bad(`pubkey unreachable: ${e.message}`);
  }

  // 3) negative activate — unknown key → 404 {code:'unknown_key'} (proves the JSON contract + path)
  try {
    const res = await fetch(`${API}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'AD-ZZZZ-ZZZZ-ZZZZ-ZZZZ', device: DEVICE, label: 'Linux' }),
    });
    const d = await res.json();
    if (res.status === 404 && d.code === 'unknown_key') ok('unknown key → 404 unknown_key (error contract)');
    else bad(`unexpected activate(bogus): ${res.status} ${JSON.stringify(d)}`);
  } catch (e) {
    bad(`activate unreachable: ${e.message}`);
  }

  // 4) positive activate → offline-verify the signed entitlement (the full loop)
  if (!DEV_KEY) {
    console.log('  SKIP positive activate (no DEV_KEY; run apps/api: go run ./tools/devmint -db <db>)');
    return done();
  }
  try {
    const res = await fetch(`${API}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: DEV_KEY, device: DEVICE, label: 'Linux' }),
    });
    const d = await res.json();
    if (!res.ok) {
      bad(`activate(${DEV_KEY}) failed: ${res.status} ${JSON.stringify(d)}`);
      return done();
    }
    const ent = verifyToken(String(d.token || ''));
    if (!ent) bad('entitlement token did NOT verify offline against the pubkey');
    else if (ent.dev !== DEVICE) bad(`token dev claim ${ent.dev} != ${DEVICE}`);
    else if (!(ent.exp > Date.now() / 1000)) bad(`token already expired (exp=${ent.exp})`);
    else ok(`activate → entitlement verified offline (plan=${ent.plan} exp in ${Math.round((ent.exp - Date.now() / 1000) / 3600)}h, ${d.activeDevices} device(s))`);

    // release the seat so re-runs stay clean
    await fetch(`${API}/v1/deactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: DEV_KEY, device: DEVICE }),
    });
  } catch (e) {
    bad(`positive activate error: ${e.message}`);
  }
  done();
}

function done() {
  console.log(failed === 0 ? '\nLICENSE_CONNECT PASS' : `\nLICENSE_CONNECT FAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
