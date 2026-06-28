// OPT-IN backend native-encode client (docs/improvements/round12-backend-processing.md, Phase 3 T13/T14).
//
// This is the ONLY module that sends asset BYTES over the network, and it does so ONLY on the explicit,
// per-run consent path the worker gates with `FixOptions.backend.consent === true`. SAFETY (load-bearing):
//   - The default fix path never imports/calls this — `FixOptions.backend` absent ⇒ the whole path is dead.
//   - `backendReachable()` is a tiny GET probe (no bytes, no token) used by the UI to decide whether to
//     even OFFER the consent step; it is fired ONLY after Pro unlock + a configured host (App gates it),
//     so a non-paying / pre-consent visitor's browser never pings the encoder host on page load.
//   - `encodeRemote()` POSTs ONE page's PNG bytes (base64) to the gateway `${apiBase}/v1/encode` with the
//     ed25519 entitlement token as `Authorization: Bearer <token>`. The gateway re-verifies the token,
//     applies per-license quota, and reverse-proxies to the apps/encoder sidecar (the distroless billing
//     image does NO native work). On success the response is RAW .ktx2 octet-stream bytes; on any failure
//     a `{error,code}` JSON envelope — the worker maps that to an HONEST skip + a browser raster fallback,
//     NEVER a silent drop.
//
// Runs in BOTH the worker (encodeRemote, has the bytes) and the main thread (backendReachable, the probe).
// Zero dependencies beyond fetch/TextEncoder/btoa — no @asset-doctor imports, so it is safe in the worker.

import type { NativeOpKind } from '../worker/fix-protocol';

/** The pinned KTX2 profile the apps/encoder sidecar allow-lists (UASTC → Zstd supercompression, baked mips).
 *  Sent verbatim in the `profile` field so the encode is deterministic + the sidecar can reject anything else
 *  (no flag injection). Mips baked ⇒ the worker charges the ×4/3 ceiling on the produced .ktx2 (honest VRAM). */
export const KTX2_PROFILE = 'uastc-zstd-mip';

/** The pinned profile bakes a full mip chain — the worker MUST charge MIP_OVERHEAD on the produced page's
 *  VRAM ceiling (vramCeilingOfPage(..., mips=true)). Kept here so the wire profile + the VRAM accounting
 *  can't drift. */
export const KTX2_PROFILE_BAKES_MIPS = true;

/** Result of one remote encode attempt. `ok` ⇒ `bytes` is the .ktx2; otherwise `code`/`message` describe
 *  WHY it failed (unreachable / declined / size cap / encode error) so the worker can surface an honest skip. */
export type EncodeRemoteResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: string; message: string };

/** Liveness probe for the encode gateway. GET `${apiBase}/v1/encode/healthz` (the gateway proxies the
 *  sidecar's /healthz). Returns true only on a 2xx. NO token, NO bytes. Short timeout so a dead host doesn't
 *  hang the UI. The caller (App) must already have gated this behind Pro-unlock + a configured apiBase. */
export async function backendReachable(apiBase: string, timeoutMs = 4000): Promise<boolean> {
  const base = apiBase.replace(/\/+$/, '');
  if (!base) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/encode/healthz`, { method: 'GET', signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** base64 (standard, padded) of raw bytes — the wire envelope the sidecar expects in `png`. Chunked so a
 *  large page never blows the argument limit of String.fromCharCode. Deterministic. */
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Encode ONE page's PNG bytes to `.ktx2` via the OPT-IN gateway. CONTRACT (round12 §6): POST a JSON
 *  envelope `{png: base64, w, h, op, profile}` with `Authorization: Bearer <token>`; on 200 the body is
 *  RAW .ktx2 octet-stream; on any non-2xx a `{error,code}` JSON the gateway/sidecar already speak. The
 *  caller has ALREADY checked consent + reachability — this function performs the upload. It NEVER throws:
 *  every failure becomes `{ok:false,...}` so the worker can fall back to the browser raster page honestly.
 *
 *  @param pngBytes  the page encoded as PNG (lossless) by the worker — the sidecar decodes this, not the
 *                   atlas's original lossy bytes, so the KTX2 source matches what the browser composed.
 */
export async function encodeRemote(
  pngBytes: Uint8Array,
  op: NativeOpKind,
  w: number,
  h: number,
  cfg: { apiBase: string; token: string },
  timeoutMs = 120000,
): Promise<EncodeRemoteResult> {
  const base = cfg.apiBase.replace(/\/+$/, '');
  if (!base) return { ok: false, code: 'no_api', message: 'no backend configured' };
  if (!cfg.token) return { ok: false, code: 'entitlement_required', message: 'no entitlement token' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/encode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ png: toBase64(pngBytes), w, h, op, profile: KTX2_PROFILE }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // The gateway/sidecar speak `{error,code}` on failures; surface the code so the worker's skip note is
      // specific (rate_limited / payload_too_large / entitlement_expired / encode_failed / encoder_unreachable).
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      return { ok: false, code: String(data.code ?? `http_${res.status}`), message: String(data.error ?? 'encode failed') };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) return { ok: false, code: 'empty', message: 'encoder returned no bytes' };
    return { ok: true, bytes: new Uint8Array(buf) };
  } catch (e) {
    // Network failure / timeout / abort → unreachable. The worker keeps the browser raster page.
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    return { ok: false, code: aborted ? 'timeout' : 'unreachable', message: aborted ? 'encode timed out' : 'encoder unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
