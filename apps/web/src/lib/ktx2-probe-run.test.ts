import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeKtx2Reading } from '@asset-doctor/core';
import type { FixReceipt, Ktx2ProbeInput } from '../worker/fix-protocol';

// Mock the real WebGL/Pixi KTX2 probe — this test exercises the host orchestration (feature-detect,
// per-page probe + summed aggregation, abort, fallback-OR, swallowed errors, same-reference no-ops), NOT
// the live GL transcode (that is the documented browser/GPU run, like probeKtx2 itself). webglAvailable is
// re-used from probe-run; we drive it via the document stub exactly as probe-run.test.ts does.
const probeKtx2 = vi.fn<
  (ktx2: ArrayBuffer, raster: unknown, transcoder: unknown, signal?: AbortSignal) => Promise<ProbeKtx2Reading>
>();
vi.mock('@asset-doctor/probe', () => ({ probeKtx2: (...a: Parameters<typeof probeKtx2>) => probeKtx2(...a) }));

const { attachKtx2Probe } = await import('./ktx2-probe-run');

// --- browser-global stubs (the helper runs in a node test env) -------------------------------------
function stubBrowser(hasWebgl: boolean): void {
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => (hasWebgl ? {} : null) }),
    baseURI: 'https://example.test/app/',
  });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 256, height: 256, close: () => {} })));
  if (typeof (globalThis as { Blob?: unknown }).Blob === 'undefined') vi.stubGlobal('Blob', class {});
  // import.meta.env.BASE_URL is provided by Vite; the helper reads it defensively (?? '/').
  vi.stubGlobal('URL', URL);
}

const baseReceipt: FixReceipt = {
  diskBytesBefore: 100,
  diskBytesAfter: 80,
  vramBytesBefore: 1000,
  vramBytesAfter: 1000,
  fileCount: 2,
  changedCount: 1,
  operations: ['ktx2'],
  skipped: [],
  referencesChanged: true,
  ktx2VramBytesWorstCase: 4_000_000,
};

const input = (): Ktx2ProbeInput => ({ ktx2Bytes: new ArrayBuffer(8), rasterBytes: new ArrayBuffer(8), rasterMime: 'image/png' });
const reading = (over: Partial<ProbeKtx2Reading> = {}): ProbeKtx2Reading => ({
  compressedBytes: 1_000_000,
  rasterBaselineBytes: 16_000_000,
  fallback: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  probeKtx2.mockReset();
});

describe('attachKtx2Probe — additivity (off ⇒ same receipt reference)', () => {
  it('empty inputs ⇒ returns the SAME receipt, never probes', async () => {
    stubBrowser(true);
    const out = await attachKtx2Probe(baseReceipt, []);
    expect(out).toBe(baseReceipt);
    expect(probeKtx2).not.toHaveBeenCalled();
  });

  it('no WebGL ⇒ returns the SAME receipt, never probes', async () => {
    // no browser stub ⇒ webglAvailable() is false (no document)
    const out = await attachKtx2Probe(baseReceipt, [input()]);
    expect(out).toBe(baseReceipt);
    expect(probeKtx2).not.toHaveBeenCalled();
  });

  it('already-aborted signal ⇒ returns the SAME receipt, never probes', async () => {
    stubBrowser(true);
    const out = await attachKtx2Probe(baseReceipt, [input()], AbortSignal.abort());
    expect(out).toBe(baseReceipt);
    expect(probeKtx2).not.toHaveBeenCalled();
  });
});

describe('attachKtx2Probe — measured (device-local) fields', () => {
  it('sums compressed + raster baseline over pages into a NEW receipt; input not mutated', async () => {
    stubBrowser(true);
    probeKtx2.mockResolvedValueOnce(reading()).mockResolvedValueOnce(reading({ compressedBytes: 2_000_000, rasterBaselineBytes: 4_000_000 }));
    const out = await attachKtx2Probe(baseReceipt, [input(), input()]);
    expect(out).not.toBe(baseReceipt);
    expect(out.probedKtx2VramBytes).toBe(3_000_000);
    expect(out.probedKtx2RasterBaselineBytes).toBe(20_000_000);
    expect(out.probedKtx2Fallback).toBe(false);
    // device-local: NEVER folded into the hard VRAM total or the worst-case ceiling
    expect(out.vramBytesAfter).toBe(baseReceipt.vramBytesAfter);
    expect(out.ktx2VramBytesWorstCase).toBe(baseReceipt.ktx2VramBytesWorstCase);
    expect(baseReceipt.probedKtx2VramBytes).toBeUndefined(); // input untouched
  });

  it('ORs fallback across pages (any raster fallback ⇒ disclosed)', async () => {
    stubBrowser(true);
    probeKtx2
      .mockResolvedValueOnce(reading())
      .mockResolvedValueOnce(reading({ fallback: true, compressedBytes: 16_000_000 }));
    const out = await attachKtx2Probe(baseReceipt, [input(), input()]);
    expect(out.probedKtx2Fallback).toBe(true);
  });

  it('swallows a per-page failure; remaining pages still contribute', async () => {
    stubBrowser(true);
    probeKtx2.mockRejectedValueOnce(new Error('gl lost')).mockResolvedValueOnce(reading());
    const out = await attachKtx2Probe(baseReceipt, [input(), input()]);
    expect(out.probedKtx2VramBytes).toBe(1_000_000);
    expect(out.probedKtx2RasterBaselineBytes).toBe(16_000_000);
  });

  it('zero successful probes ⇒ returns the SAME receipt reference', async () => {
    stubBrowser(true);
    probeKtx2.mockRejectedValue(new Error('gl lost'));
    const out = await attachKtx2Probe(baseReceipt, [input()]);
    expect(out).toBe(baseReceipt);
  });
});
