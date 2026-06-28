// Unit tests for the OPT-IN backend native-encode client (apps/web/src/lib/backend-client.ts) — the ONLY
// module that sends asset BYTES over the network (round12-backend-processing.md, Phase 3 T13/T14). This is
// the privacy-sensitive seam, so its CONTRACT is proven directly here with a mocked fetch:
//   - encodeRemote SHORT-CIRCUITS (no fetch) when apiBase is empty OR the entitlement token is missing.
//   - on 200 it returns the RAW .ktx2 bytes; an EMPTY 200 body ⇒ honest {ok:false, code:'empty'}.
//   - on a non-2xx {error,code} envelope it surfaces that code verbatim; a non-JSON / empty error body
//     falls back to `http_<status>`.
//   - timeout/abort ⇒ {ok:false, code:'timeout'}; a thrown network error ⇒ {ok:false, code:'unreachable'}.
//   - it NEVER throws — every failure path returns an {ok:false,...} envelope (the worker falls back honestly).
//   - the request carries `Authorization: Bearer <token>` + the pinned profile + base64 png + w/h/op.
//   - backendReachable is a tiny token-less, byte-less GET probe: true only on 2xx; false on non-2xx / throw /
//     empty apiBase; and it never sends a body or an Authorization header.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backendReachable,
  encodeRemote,
  KTX2_PROFILE,
  PNGQUANT_PROFILE,
} from '../src/lib/backend-client';

const CFG = { apiBase: 'https://api.example.dev', token: 'tok-abc' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** Install a fetch mock; returns the mock so a test can inspect the call. */
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl as unknown as typeof fetch);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('encodeRemote — short-circuits before any network', () => {
  it('returns no_api WITHOUT calling fetch when apiBase is empty', async () => {
    const fetchMock = mockFetch(() => {
      throw new Error('fetch must not be called');
    });
    const res = await encodeRemote(PNG, 'ktx2', 64, 64, { apiBase: '', token: 'tok' });
    expect(res).toEqual({ ok: false, code: 'no_api', message: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns entitlement_required WITHOUT calling fetch when the token is missing', async () => {
    const fetchMock = mockFetch(() => {
      throw new Error('fetch must not be called');
    });
    const res = await encodeRemote(PNG, 'ktx2', 64, 64, { apiBase: CFG.apiBase, token: '' });
    expect(res).toEqual({ ok: false, code: 'entitlement_required', message: expect.any(String) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('encodeRemote — success', () => {
  it('returns the RAW .ktx2 bytes on a 200 and sends the Bearer token + pinned profile + base64 png', async () => {
    const ktx2 = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 9, 9, 9]); // pretend KTX2 magic-ish
    let captured: { url: string; init?: RequestInit } | undefined;
    mockFetch((url, init) => {
      captured = { url, init };
      return new Response(ktx2, { status: 200 });
    });

    const res = await encodeRemote(PNG, 'ktx2', 128, 256, CFG);
    expect(res.ok).toBe(true);
    if (res.ok) expect(Array.from(res.bytes)).toEqual(Array.from(ktx2));

    // URL has no double slash + is the /v1/encode gateway route.
    expect(captured!.url).toBe('https://api.example.dev/v1/encode');
    const init = captured!.init!;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-abc');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.profile).toBe(KTX2_PROFILE); // pinned, no flag injection
    expect(body.op).toBe('ktx2');
    expect(body.w).toBe(128);
    expect(body.h).toBe(256);
    // png is base64 of the bytes (decodes back to the PNG).
    expect(typeof body.png).toBe('string');
    expect(Array.from(Buffer.from(body.png as string, 'base64'))).toEqual(Array.from(PNG));
  });

  it('round13: op:pngquant sends the pinned PNGQUANT_PROFILE (op-keyed, not the ktx2 profile) + returns the PNG bytes', async () => {
    const pngOut = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 7]); // a (pretend) re-compressed PNG
    let captured: { init?: RequestInit } | undefined;
    mockFetch((_url, init) => {
      captured = { init };
      return new Response(pngOut, { status: 200, headers: { 'Content-Type': 'image/png' } });
    });
    const res = await encodeRemote(PNG, 'pngquant', 64, 64, CFG);
    expect(res.ok).toBe(true);
    if (res.ok) expect(Array.from(res.bytes)).toEqual(Array.from(pngOut));
    const body = JSON.parse(captured!.init!.body as string) as Record<string, unknown>;
    expect(body.op).toBe('pngquant');
    expect(body.profile).toBe(PNGQUANT_PROFILE); // op-keyed: pngquant-256-fs, NOT uastc-zstd-mip
    expect(body.profile).not.toBe(KTX2_PROFILE);
  });

  it('strips a trailing slash from apiBase (no double slash in the URL)', async () => {
    let url = '';
    mockFetch((u) => {
      url = u;
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    await encodeRemote(PNG, 'ktx2', 1, 1, { apiBase: 'https://api.example.dev///', token: 'tok' });
    expect(url).toBe('https://api.example.dev/v1/encode');
  });
});

describe('encodeRemote — honest failures (never throws)', () => {
  it('maps a non-2xx {error,code} envelope to {ok:false} with the code verbatim', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: 'over quota', code: 'rate_limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await encodeRemote(PNG, 'ktx2', 64, 64, CFG);
    expect(res).toEqual({ ok: false, code: 'rate_limited', message: 'over quota' });
  });

  it('falls back to http_<status> when the error body is non-JSON / empty', async () => {
    mockFetch(() => new Response('', { status: 503 }));
    const res = await encodeRemote(PNG, 'ktx2', 64, 64, CFG);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('http_503');
  });

  it('round13 M1: relays the pngquant quality_floor 422 code verbatim (the worker treats it as kept-original)', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: 'quality floor not met; original kept', code: 'quality_floor' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await encodeRemote(PNG, 'pngquant', 64, 64, CFG);
    expect(res).toEqual({ ok: false, code: 'quality_floor', message: 'quality floor not met; original kept' });
  });

  it('returns code:empty when a 200 has a ZERO-length body (no .ktx2 produced)', async () => {
    mockFetch(() => new Response(new Uint8Array(0), { status: 200 }));
    const res = await encodeRemote(PNG, 'ktx2', 64, 64, CFG);
    expect(res).toEqual({ ok: false, code: 'empty', message: expect.any(String) });
  });

  it('maps an aborted/timed-out request to {ok:false, code:timeout}', async () => {
    mockFetch((_url, init) => {
      // Reject with an AbortError exactly like fetch does when the signal aborts.
      return new Promise<Response>((_resolve, reject) => {
        const sig = (init?.signal ?? null) as AbortSignal | null;
        const fail = () => reject(new DOMException('aborted', 'AbortError'));
        if (sig?.aborted) fail();
        else sig?.addEventListener('abort', fail);
      });
    });
    const res = await encodeRemote(PNG, 'ktx2', 64, 64, CFG, 5); // 5ms timeout ⇒ abort fires
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('timeout');
  });

  it('maps a thrown network error to {ok:false, code:unreachable} (never throws out)', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const res = await encodeRemote(PNG, 'ktx2', 64, 64, CFG);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('unreachable');
  });
});

describe('backendReachable — token-less, byte-less liveness probe', () => {
  it('GETs ${apiBase}/v1/encode/healthz with NO body and NO Authorization, returns true on 2xx', async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    mockFetch((url, init) => {
      captured = { url, init };
      return new Response('ok', { status: 200 });
    });
    const ok = await backendReachable(CFG.apiBase);
    expect(ok).toBe(true);
    expect(captured!.url).toBe('https://api.example.dev/v1/encode/healthz');
    expect(captured!.init?.method).toBe('GET');
    expect(captured!.init?.body).toBeUndefined();
    const headers = (captured!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('returns false on a non-2xx', async () => {
    mockFetch(() => new Response('nope', { status: 502 }));
    expect(await backendReachable(CFG.apiBase)).toBe(false);
  });

  it('returns false (no throw) on a network error', async () => {
    mockFetch(() => {
      throw new TypeError('boom');
    });
    expect(await backendReachable(CFG.apiBase)).toBe(false);
  });

  it('returns false WITHOUT calling fetch when apiBase is empty', async () => {
    const fetchMock = mockFetch(() => new Response('ok', { status: 200 }));
    expect(await backendReachable('')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
