// Unit test for the EXTRACTED GPU-VRAM probe collection (round15 #0 — previously a T6 gap: the worker's
// `if (ktx2Probe.length < KTX2_PROBE_MAX)` gate + fresh-slice push had no coverage). The pure helper the
// worker now imports is exercised here directly in Node, so the cap + the copy-not-alias guarantee cannot
// silently regress. Mirrors the discipline of ktx2-worker.test.ts (a faithful node-side check of the same
// control flow the worker runs) but against the real shared code instead of a re-implementation.

import { describe, it, expect } from 'vitest';
import type { Ktx2ProbeInput } from '../worker/fix-protocol';
import { KTX2_PROBE_MAX, ktx2ProbeHasRoom, buildKtx2ProbeInput, collectKtx2Probe } from './ktx2-probe-collect';

const bytes = (...vals: number[]): Uint8Array => new Uint8Array(vals);

describe('ktx2ProbeHasRoom — the cap gate', () => {
  it('is true below the cap and false at/over it', () => {
    expect(ktx2ProbeHasRoom(0)).toBe(true);
    expect(ktx2ProbeHasRoom(KTX2_PROBE_MAX - 1)).toBe(true);
    expect(ktx2ProbeHasRoom(KTX2_PROBE_MAX)).toBe(false);
    expect(ktx2ProbeHasRoom(KTX2_PROBE_MAX + 1)).toBe(false);
  });

  it('honors an explicit cap override', () => {
    expect(ktx2ProbeHasRoom(2, 2)).toBe(false);
    expect(ktx2ProbeHasRoom(1, 2)).toBe(true);
  });
});

describe('buildKtx2ProbeInput — FRESH slices (copy, never alias)', () => {
  it('returns detached COPIES so the worker\'s out/zip buffers stay intact', () => {
    const ktx2 = bytes(0xab, 0x4b, 0x54, 0x58, 9, 9);
    const raster = bytes(1, 2, 3, 4, 5, 6);
    const p = buildKtx2ProbeInput(ktx2, raster, 'image/webp');
    // Same payload, byte-for-byte.
    expect(new Uint8Array(p.ktx2Bytes)).toEqual(ktx2);
    expect(new Uint8Array(p.rasterBytes)).toEqual(raster);
    expect(p.rasterMime).toBe('image/webp');
    // CRITICAL: a COPY, not a view onto the source buffer — mutating the probe must not touch the source
    // (and the worker transferring the probe buffer must not detach the page bytes it ships in the zip).
    expect(p.ktx2Bytes).not.toBe(ktx2.buffer);
    expect(p.rasterBytes).not.toBe(raster.buffer);
    new Uint8Array(p.ktx2Bytes)[0] = 0xff;
    expect(ktx2[0]).toBe(0xab); // source unchanged
  });

  it('copies only the byte range (not a larger backing buffer)', () => {
    // A Uint8Array that is a sub-view of a larger buffer — .slice() must copy ONLY the view's bytes.
    const backing = new Uint8Array([0, 0, 7, 8, 9, 0, 0]);
    const view = backing.subarray(2, 5); // [7,8,9]
    const p = buildKtx2ProbeInput(view, bytes(1), 'image/png');
    expect(new Uint8Array(p.ktx2Bytes)).toEqual(bytes(7, 8, 9));
    expect(p.ktx2Bytes.byteLength).toBe(3);
  });
});

describe('collectKtx2Probe — gate + collect (the worker control flow)', () => {
  it('appends while under the cap and returns true', () => {
    const collected: Ktx2ProbeInput[] = [];
    expect(collectKtx2Probe(collected, bytes(1), bytes(2), 'image/webp')).toBe(true);
    expect(collected).toHaveLength(1);
  });

  it('stops at KTX2_PROBE_MAX: extra pages are NO-OP (return false, array unchanged)', () => {
    const collected: Ktx2ProbeInput[] = [];
    for (let i = 0; i < KTX2_PROBE_MAX; i++) {
      expect(collectKtx2Probe(collected, bytes(i), bytes(i), 'image/webp')).toBe(true);
    }
    expect(collected).toHaveLength(KTX2_PROBE_MAX);
    // The (MAX+1)-th candidate is declined — capped, no push.
    expect(collectKtx2Probe(collected, bytes(99), bytes(99), 'image/webp')).toBe(false);
    expect(collected).toHaveLength(KTX2_PROBE_MAX);
    // First entry still intact (the cap declined the new one, didn't evict).
    expect(new Uint8Array(collected[0]!.ktx2Bytes)).toEqual(bytes(0));
  });

  it('respects an explicit cap (e.g. 2)', () => {
    const collected: Ktx2ProbeInput[] = [];
    expect(collectKtx2Probe(collected, bytes(1), bytes(1), 'image/png', 2)).toBe(true);
    expect(collectKtx2Probe(collected, bytes(2), bytes(2), 'image/png', 2)).toBe(true);
    expect(collectKtx2Probe(collected, bytes(3), bytes(3), 'image/png', 2)).toBe(false);
    expect(collected).toHaveLength(2);
  });

  it('collected pairs are independent copies (collecting twice from the same source aliases nothing)', () => {
    const src = bytes(5, 6, 7);
    const collected: Ktx2ProbeInput[] = [];
    collectKtx2Probe(collected, src, src, 'image/webp');
    new Uint8Array(collected[0]!.ktx2Bytes)[0] = 0;
    expect(src[0]).toBe(5); // source untouched
  });
});
