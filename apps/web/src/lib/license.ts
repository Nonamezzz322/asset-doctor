// Client-side licensing for the paid "fix". The ONLY network calls in the whole app live here
// (activate/refresh/deactivate) — assets never go anywhere. Entitlement tokens are verified OFFLINE
// with an embedded ed25519 public key, so once activated the gate works with no backend round-trip.
//
// The gate is OFF by default (VITE_PRO_GATE !== 'true') → the fix is free. Flip the flag + ship a
// public key + point VITE_API_BASE at the deployed apps/api to start gating. See apps/api/README.md.

import type { Entitlement } from '@asset-doctor/core';
import { ENTITLEMENT_VERSION } from '@asset-doctor/core';

const env = import.meta.env as Record<string, string | undefined>;

/** Master switch. Until this is "true", isProUnlocked() always resolves true (free beta). */
export const PRO_GATE_ENABLED = env.VITE_PRO_GATE === 'true';
/** Base64 ed25519 public key matching the server's LICENSE_SIGNING_SEED (from `go run ./tools/keygen`). */
export const LICENSE_PUBKEY = (env.VITE_LICENSE_PUBKEY ?? '').trim();
/** Thin-backend origin, e.g. https://asset-doctor-api.fly.dev (no trailing slash). */
export const API_BASE = (env.VITE_API_BASE ?? '').replace(/\/+$/, '');

const DEVICE_KEY = 'ad.device';
const ENT_KEY = 'ad.entitlement';

export class LicenseError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'LicenseError';
  }
}

/* ── encoding helpers ─────────────────────────────────────────────────────────── */

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

// WebCrypto wants a BufferSource backed by a plain ArrayBuffer; TS 5.7 types Uint8Array generically
// over ArrayBufferLike (which includes SharedArrayBuffer), so we narrow explicitly here.
function buf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/* ── offline verification (WebCrypto Ed25519) ─────────────────────────────────── */

async function importPublicKey(pubKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(b64ToBytes(pubKeyB64)), { name: 'Ed25519' }, false, ['verify']);
}

/**
 * Verify a token's signature + version OFFLINE and return its claims, or null if anything is off.
 * Does NOT check expiry — callers decide (entitlementValid). The signed message is the literal first
 * segment, byte-for-byte what the Go server signed.
 */
export async function verifyEntitlementToken(token: string, pubKeyB64: string = LICENSE_PUBKEY): Promise<Entitlement | null> {
  if (!pubKeyB64) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) return null;
  const msg = token.slice(0, dot);
  try {
    const sig = b64urlToBytes(token.slice(dot + 1));
    if (sig.length !== 64) return null;
    const key = await importPublicKey(pubKeyB64);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, buf(sig), buf(new TextEncoder().encode(msg)));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(msg))) as Entitlement;
    if (claims.v !== ENTITLEMENT_VERSION) return null;
    return claims;
  } catch {
    return null;
  }
}

/** exp is in the future (small negative skew tolerated). */
export function entitlementValid(ent: Entitlement, nowSec: number = Date.now() / 1000, skewSec = 60): boolean {
  return ent.exp > nowSec - skewSec;
}

/* ── device id (random, NOT a fingerprint) ────────────────────────────────────── */

export function getDeviceId(): string {
  let id = safeGet(DEVICE_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? fallbackId());
    safeSet(DEVICE_KEY, id);
  }
  return id;
}

function fallbackId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/* ── stored entitlement ───────────────────────────────────────────────────────── */

interface StoredEntitlement {
  token: string;
  key: string;
}

export function storeEntitlement(token: string, key: string): void {
  safeSet(ENT_KEY, JSON.stringify({ token, key } satisfies StoredEntitlement));
}
export function clearEntitlement(): void {
  safeRemove(ENT_KEY);
}
export function loadStoredEntitlement(): StoredEntitlement | null {
  const raw = safeGet(ENT_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredEntitlement;
    return v.token && v.key ? v : null;
  } catch {
    return null;
  }
}

/** Verify the stored token offline and return live claims (sig ok, version ok, bound to THIS device,
 *  not expired), else null. The device binding makes the signed `dev` claim load-bearing: copying just
 *  the entitlement blob to another browser (which mints a fresh device id) no longer unlocks Pro. */
export async function currentEntitlement(): Promise<Entitlement | null> {
  const stored = loadStoredEntitlement();
  if (!stored) return null;
  const ent = await verifyEntitlementToken(stored.token);
  if (!ent || ent.dev !== getDeviceId() || !entitlementValid(ent)) return null;
  return ent;
}

/**
 * The gate predicate the UI consults. Gate disabled → always unlocked (free). Gate enabled → a
 * valid, unexpired stored entitlement is required. Fail-soft: this never hits the network; renewal is
 * handled separately (maybeRefresh), so a brief backend outage doesn't lock an already-activated user.
 */
export async function isProUnlocked(): Promise<boolean> {
  if (!PRO_GATE_ENABLED) return true;
  return (await currentEntitlement()) !== null;
}

/* ── backend calls (the only network in the app) ──────────────────────────────── */

async function postLicense(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  if (!API_BASE) throw new LicenseError('no_api', 'licensing backend is not configured');
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new LicenseError('network', 'could not reach the licensing server');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new LicenseError(String(data.code ?? `http_${res.status}`), String(data.error ?? 'request failed'));
  }
  return data;
}

export interface ActivateResult {
  token: string;
  exp: number;
  plan: string;
  seats: number;
  activeDevices: number;
}

/** Activate a license key on this device, persist + return the entitlement. */
export async function activate(rawKey: string): Promise<ActivateResult> {
  const key = rawKey.trim().toUpperCase();
  const data = await postLicense('/v1/activate', { key, device: getDeviceId(), label: deviceLabel() });
  const token = String(data.token ?? '');
  if (!(await verifyEntitlementToken(token))) {
    throw new LicenseError('bad_token', 'server returned an unverifiable entitlement');
  }
  storeEntitlement(token, key);
  return {
    token,
    exp: Number(data.exp ?? 0),
    plan: String(data.plan ?? 'pro'),
    seats: Number(data.seats ?? 0),
    activeDevices: Number(data.activeDevices ?? 0),
  };
}

/** Renew the stored entitlement; on success re-persists. Caller decides how to treat failures. */
export async function refresh(): Promise<Entitlement | null> {
  const stored = loadStoredEntitlement();
  if (!stored) return null;
  const data = await postLicense('/v1/refresh', { key: stored.key, device: getDeviceId() });
  const token = String(data.token ?? '');
  const ent = await verifyEntitlementToken(token);
  if (!ent) throw new LicenseError('bad_token', 'server returned an unverifiable entitlement');
  storeEntitlement(token, stored.key);
  return ent;
}

/** Release this device's seat and forget the local entitlement. */
export async function deactivate(): Promise<void> {
  const stored = loadStoredEntitlement();
  if (stored) {
    try {
      await postLicense('/v1/deactivate', { key: stored.key, device: getDeviceId() });
    } finally {
      clearEntitlement();
    }
  }
}

/**
 * Opportunistic renewal: if a valid entitlement is within `withinSec` of expiry, try to refresh.
 * Fail-soft — network/transient errors are swallowed (the token is still valid until exp). A hard
 * "inactive"/"reactivate" from the server clears the local entitlement (the kill-switch landing).
 */
export async function maybeRefresh(withinSec = 2 * 24 * 3600): Promise<void> {
  if (!PRO_GATE_ENABLED) return;
  const stored = loadStoredEntitlement();
  if (!stored) return;
  // Verify signature+version but IGNORE expiry here: a token that already expired is exactly the case we
  // most need to renew. (currentEntitlement would have returned null and we'd never self-heal.)
  const ent = await verifyEntitlementToken(stored.token);
  if (!ent || ent.dev !== getDeviceId()) return; // not ours / different device → don't renew here
  if (ent.exp - Date.now() / 1000 > withinSec) return; // still comfortably valid
  // expired OR within the renewal window → ask the server to re-sign (self-heals an active license)
  try {
    await refresh();
  } catch (e) {
    if (e instanceof LicenseError && (e.code === 'inactive' || e.code === 'reactivate')) {
      clearEntitlement();
    }
    // transient/network error: keep whatever token we have (fail-soft)
  }
}

function deviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  return 'browser';
}

/* ── storage guards (private mode / SSR safety) ───────────────────────────────── */

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
function safeRemove(k: string): void {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
