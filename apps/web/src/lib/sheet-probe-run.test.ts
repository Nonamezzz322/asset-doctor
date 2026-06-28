import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeReading, Rect } from '@asset-doctor/core';
import type { FixReceipt, SheetDiff } from '../worker/fix-protocol';

// Mock the real WebGL/Pixi probe — this test exercises the host orchestration (feature-detect, per-sheet
// before+after probe, per-side swallow, abort, same-reference no-ops, extent sizing, no-mutate / never-folded
// honesty), NOT the live GL render (that is the documented browser/GPU run, covered headless by
// packages/probe instrument.test.ts). webglAvailable is re-used from probe-run; we drive it via the document
// stub exactly as probe-run.test.ts / ktx2-probe-run.test.ts do.
const probeAtlas = vi.fn<(source: unknown, frames: Rect[], size?: { w: number; h: number }) => Promise<ProbeReading>>();
vi.mock('@asset-doctor/probe', () => ({ probeAtlas: (...a: Parameters<typeof probeAtlas>) => probeAtlas(...a) }));

const { attachSheetProbes } = await import('./sheet-probe-run');

// --- browser-global stubs (the helper runs in a node test env) -------------------------------------
function stubBrowser(hasWebgl: boolean): void {
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => (hasWebgl ? {} : null) }),
  });
  // createImageBitmap has COPY semantics here (it returns a fresh handle, never touches the buffer) — the
  // helper relies on Blob copying the bytes so the FilmViewer's later reads of diff.before/afterBytes are safe.
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 256, height: 256, close: () => {} })));
  if (typeof (globalThis as { Blob?: unknown }).Blob === 'undefined') vi.stubGlobal('Blob', class {});
}

const reading = (over: Partial<ProbeReading> = {}): ProbeReading => ({
  drawCalls: 1,
  vramBytes: 1_048_576,
  liveTextures: 1,
  textureUploads: 1,
  shaderCompiles: 0,
  ...over,
});

const baseReceipt = (sheetDiffs?: SheetDiff[]): FixReceipt => ({
  diskBytesBefore: 100,
  diskBytesAfter: 80,
  vramBytesBefore: 1000,
  vramBytesAfter: 1000,
  fileCount: 2,
  changedCount: 1,
  operations: ['repack'],
  skipped: [],
  referencesChanged: false,
  ...(sheetDiffs ? { sheetDiffs, sheetDiffsTotal: sheetDiffs.length } : {}),
});

const sheetDiff = (over: Partial<SheetDiff> = {}): SheetDiff => ({
  name: 'sheet.png',
  beforeBytes: new ArrayBuffer(8),
  afterBytes: new ArrayBuffer(8),
  beforeWxH: { w: 200, h: 100 },
  afterWxH: { w: 150, h: 100 },
  occBefore: 0.4,
  occAfter: 0.9,
  vramBefore: 80_000,
  vramAfter: 60_000,
  afterZones: [],
  beforeFrames: [{ x: 0, y: 0, w: 64, h: 64 }],
  afterFrames: [{ x: 0, y: 0, w: 64, h: 64 }],
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  probeAtlas.mockReset();
});

describe('attachSheetProbes — additivity (off ⇒ same receipt reference)', () => {
  it('no sheetDiffs ⇒ returns the SAME receipt, never probes', async () => {
    stubBrowser(true);
    const rec = baseReceipt();
    const out = await attachSheetProbes(rec);
    expect(out).toBe(rec);
    expect(probeAtlas).not.toHaveBeenCalled();
  });

  it('no WebGL ⇒ returns the SAME receipt, never probes', async () => {
    // no browser stub ⇒ webglAvailable() is false (no document)
    const rec = baseReceipt([sheetDiff()]);
    const out = await attachSheetProbes(rec);
    expect(out).toBe(rec);
    expect(probeAtlas).not.toHaveBeenCalled();
  });

  it('already-aborted signal ⇒ returns the SAME receipt, never probes', async () => {
    stubBrowser(true);
    const rec = baseReceipt([sheetDiff()]);
    const out = await attachSheetProbes(rec, AbortSignal.abort());
    expect(out).toBe(rec);
    expect(probeAtlas).not.toHaveBeenCalled();
  });

  it('zero successful probes ⇒ returns the SAME receipt reference', async () => {
    stubBrowser(true);
    probeAtlas.mockRejectedValue(new Error('gl lost'));
    const rec = baseReceipt([sheetDiff()]);
    expect(await attachSheetProbes(rec)).toBe(rec);
  });
});

describe('attachSheetProbes — measured (device-local) fields', () => {
  it('both-sides sheet: all four measured fields set; static strip untouched; input not mutated', async () => {
    stubBrowser(true);
    probeAtlas
      .mockResolvedValueOnce(reading({ drawCalls: 3, vramBytes: 16_000_000 })) // before
      .mockResolvedValueOnce(reading({ drawCalls: 1, vramBytes: 9_000_000 })); // after
    const rec = baseReceipt([sheetDiff()]);
    const out = await attachSheetProbes(rec);
    expect(out).not.toBe(rec);
    const d = out.sheetDiffs![0]!;
    expect(d.drawCallsBefore).toBe(3);
    expect(d.decodedVramBefore).toBe(16_000_000);
    expect(d.drawCallsAfter).toBe(1);
    expect(d.decodedVramAfter).toBe(9_000_000);
    // device-local: the static VRAM strip is NEVER merged with the measured decoded VRAM (invariant 5)
    expect(d.vramBefore).toBe(80_000);
    expect(d.vramAfter).toBe(60_000);
    // input not mutated
    expect(rec.sheetDiffs![0]!.drawCallsAfter).toBeUndefined();
    expect(rec.sheetDiffs![0]!.decodedVramAfter).toBeUndefined();
  });

  it('pack page (only afterFrames): before fields stay absent; after fields set; probes once', async () => {
    stubBrowser(true);
    probeAtlas.mockResolvedValue(reading({ drawCalls: 2, vramBytes: 5_000_000 }));
    const rec = baseReceipt([sheetDiff({ beforeFrames: undefined, occBefore: 0 })]);
    const out = await attachSheetProbes(rec);
    const d = out.sheetDiffs![0]!;
    expect(d.drawCallsBefore).toBeUndefined();
    expect(d.decodedVramBefore).toBeUndefined();
    expect(d.drawCallsAfter).toBe(2);
    expect(d.decodedVramAfter).toBe(5_000_000);
    expect(probeAtlas).toHaveBeenCalledTimes(1); // after-only
  });

  it('per-sheet swallow: a failing side leaves no field; the other side + other sheets still attach', async () => {
    stubBrowser(true);
    probeAtlas
      .mockRejectedValueOnce(new Error('gl lost')) // sheet 0 before fails
      .mockResolvedValueOnce(reading({ drawCalls: 1, vramBytes: 7_000_000 })) // sheet 0 after ok
      .mockResolvedValueOnce(reading({ drawCalls: 4, vramBytes: 8_000_000 })) // sheet 1 before ok
      .mockResolvedValueOnce(reading({ drawCalls: 2, vramBytes: 6_000_000 })); // sheet 1 after ok
    const rec = baseReceipt([sheetDiff({ name: 's0.png' }), sheetDiff({ name: 's1.png' })]);
    const out = await attachSheetProbes(rec);
    const d0 = out.sheetDiffs![0]!;
    const d1 = out.sheetDiffs![1]!;
    expect(d0.drawCallsBefore).toBeUndefined(); // swallowed
    expect(d0.decodedVramBefore).toBeUndefined();
    expect(d0.drawCallsAfter).toBe(1); // other side still attached
    expect(d1.drawCallsBefore).toBe(4); // unaffected sheet fully attached
    expect(d1.drawCallsAfter).toBe(2);
  });

  it('passes the max-frame-extent size to probeAtlas (mirrors probe-run BLOCKER2)', async () => {
    stubBrowser(true);
    probeAtlas.mockResolvedValue(reading());
    const rec = baseReceipt([
      sheetDiff({
        beforeFrames: [{ x: 100, y: 100, w: 50, h: 80 }],
        afterFrames: [{ x: 10, y: 20, w: 30, h: 40 }],
      }),
    ]);
    await attachSheetProbes(rec);
    // before: extent {150,180}; after: extent {40,60}
    expect(probeAtlas).toHaveBeenNthCalledWith(1, expect.anything(), [{ x: 100, y: 100, w: 50, h: 80 }], { w: 150, h: 180 });
    expect(probeAtlas).toHaveBeenNthCalledWith(2, expect.anything(), [{ x: 10, y: 20, w: 30, h: 40 }], { w: 40, h: 60 });
  });
});
