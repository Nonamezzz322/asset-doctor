import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisReport, ProbeReading, Rect } from '@asset-doctor/core';

// Mock the real WebGL/Pixi probe — this test exercises the host orchestration (feature-detect,
// per-atlas attach, aggregation, abort, swallowed errors), not the GL render itself (that's covered
// headless by packages/probe instrument.test.ts).
const probeAtlas = vi.fn<
  (source: unknown, frames: Rect[], size?: { w: number; h: number }) => Promise<ProbeReading>
>();
vi.mock('@asset-doctor/probe', () => ({ probeAtlas: (...a: Parameters<typeof probeAtlas>) => probeAtlas(...a) }));

const { attachProbeReadings, webglAvailable } = await import('./probe-run');

// --- browser-global stubs (the helper runs in a node test env) -------------------------------------
function stubBrowser(hasWebgl: boolean): void {
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => (hasWebgl ? {} : null) }),
  });
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 256, height: 256, close: () => {} })));
  // Blob is referenced by the decode() helper; jsdom-free node may lack it.
  if (typeof (globalThis as { Blob?: unknown }).Blob === 'undefined') {
    vi.stubGlobal('Blob', class {});
  }
}

const READING: ProbeReading = { drawCalls: 1, vramBytes: 1048576, liveTextures: 1, textureUploads: 1, shaderCompiles: 1 };

function report(withFrames: boolean): AnalysisReport {
  return {
    assets: [
      { assetRef: 'a.png', diskBytes: 10, vramBytes: 100, vramBytesMipmapped: 133 },
      { assetRef: 'b.png', diskBytes: 20, vramBytes: 200, vramBytesMipmapped: 266 },
    ],
    findings: [],
    totals: {
      diskBytes: 30, vramBytes: 300, vramBytesMipmapped: 399,
      loadedVramBytes: 300, loadedVramBytesMipmapped: 399, potentialDiskSaved: 0,
    },
    thresholds: {} as AnalysisReport['thresholds'],
    ...(withFrames
      ? { atlasFrames: { 'a.png': [{ x: 0, y: 0, w: 64, h: 64 }], 'b.png': [{ x: 0, y: 0, w: 64, h: 64 }] } }
      : {}),
  };
}

const bytesOf = (): ArrayBuffer => new ArrayBuffer(8);

afterEach(() => {
  vi.unstubAllGlobals();
  probeAtlas.mockReset();
});

describe('webglAvailable', () => {
  it('false when there is no document (node / headless)', () => {
    expect(webglAvailable()).toBe(false);
  });
  it('true when a context is returned', () => {
    stubBrowser(true);
    expect(webglAvailable()).toBe(true);
  });
});

describe('attachProbeReadings', () => {
  it('no WebGL ⇒ returns the SAME report reference unchanged (byte-identical to today)', async () => {
    // no browser stub ⇒ webglAvailable() is false
    const rep = report(true);
    const out = await attachProbeReadings(rep, bytesOf);
    expect(out).toBe(rep);
    expect(probeAtlas).not.toHaveBeenCalled();
  });

  it('no atlasFrames ⇒ returns the SAME report reference unchanged', async () => {
    stubBrowser(true);
    const rep = report(false);
    expect(await attachProbeReadings(rep, bytesOf)).toBe(rep);
    expect(probeAtlas).not.toHaveBeenCalled();
  });

  it('attaches per-atlas probe + aggregates totals.probe (sums commutative)', async () => {
    stubBrowser(true);
    probeAtlas.mockResolvedValue(READING);
    const rep = report(true);
    const out = await attachProbeReadings(rep, bytesOf);
    expect(out).not.toBe(rep); // new report
    expect(out.assets[0]?.probe).toEqual(READING);
    expect(out.assets[1]?.probe).toEqual(READING);
    expect(out.totals.probe).toEqual({ drawCalls: 2, vramBytes: 2097152, atlasesProbed: 2 });
    // static estimate untouched (declared vs measured — never merged)
    expect(out.totals.vramBytes).toBe(300);
    expect(rep.assets[0]?.probe).toBeUndefined(); // input not mutated
  });

  it('swallows a per-atlas probe error — that atlas has no reading, the rest attach', async () => {
    stubBrowser(true);
    probeAtlas.mockRejectedValueOnce(new Error('gl lost')).mockResolvedValueOnce(READING);
    const out = await attachProbeReadings(report(true), bytesOf);
    expect(out.assets[0]?.probe).toBeUndefined();
    expect(out.assets[1]?.probe).toEqual(READING);
    expect(out.totals.probe).toEqual({ drawCalls: 1, vramBytes: 1048576, atlasesProbed: 1 });
  });

  it('already-aborted signal ⇒ returns the SAME report, never probes', async () => {
    stubBrowser(true);
    const rep = report(true);
    const out = await attachProbeReadings(rep, bytesOf, AbortSignal.abort());
    expect(out).toBe(rep);
    expect(probeAtlas).not.toHaveBeenCalled();
  });

  it('passes the declared atlas size (max frame extent) so frames render on-canvas (BLOCKER2)', async () => {
    stubBrowser(true);
    probeAtlas.mockResolvedValue(READING);
    const rep = report(false);
    rep.atlasFrames = { 'a.png': [{ x: 100, y: 100, w: 50, h: 80 }] };
    await attachProbeReadings(rep, bytesOf);
    expect(probeAtlas).toHaveBeenCalledWith(expect.anything(), rep.atlasFrames['a.png'], { w: 150, h: 180 });
  });
});
