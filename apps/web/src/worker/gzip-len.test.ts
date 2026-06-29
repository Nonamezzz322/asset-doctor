// Unit test for the gzip file-size helper (round23 #2, includeFileSizes='gzip'). The worker can't run in
// Node, so the primitive is extracted (gzip-len.ts) and asserted here against the REAL CompressionStream
// (a Node-20 global — not mocked). Round 24 reviewer-MINOR: locks the empty⇒0 guard and the previously
// untested gzip byte path. Tests assert raw EXACTLY and gzip only as a BOUND (>0, ≤ raw for compressible
// input) — the gzip length itself is not pinned to a magic number.

import { describe, it, expect } from 'vitest';
import { gzipLen } from './gzip-len';

describe('gzipLen — real CompressionStream byte path + empty guard', () => {
  it('empty input ⇒ 0 (the guard — honest 0, NOT the ~20-byte gzip frame overhead)', async () => {
    expect(await gzipLen(new Uint8Array(0))).toBe(0);
  });

  it('compressible buffer ⇒ gzip KB > 0 and ≤ raw KB', async () => {
    const raw = new TextEncoder().encode('a'.repeat(2000)); // highly compressible
    const len = await gzipLen(raw);
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThanOrEqual(raw.length); // compressible ⇒ gzip never larger than raw
  });

  it('single byte ⇒ > 0 (no false-zero for a real, non-empty file)', async () => {
    expect(await gzipLen(new Uint8Array([0x41]))).toBeGreaterThan(0);
  });

  it('deterministic — identical input ⇒ identical length', async () => {
    const raw = new TextEncoder().encode('asset-doctor '.repeat(64));
    expect(await gzipLen(raw)).toBe(await gzipLen(raw));
  });
});
