import { describe, it, expect } from 'vitest';
import { makeZip, ZipOverflowError, type ZipEntry } from '../src/worker/zip';

const FLAG_UTF8 = 0x0800;
const LH_SIG = 0x04034b50;
const CH_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

async function view(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

/** First byte offset of `sig` (little-endian) in the buffer, or -1. */
function findSig(dv: DataView, sig: number): number {
  for (let i = 0; i + 4 <= dv.byteLength; i++) if (dv.getUint32(i, true) === sig) return i;
  return -1;
}

describe('makeZip — UTF-8 filename flag', () => {
  it('sets gp bit 11 in the local header for a non-ASCII (Cyrillic) name', async () => {
    const dv = await view(makeZip([{ name: 'символы/файл.png', bytes: bytes(1, 2, 3) }]));
    const lh = findSig(dv, LH_SIG);
    expect(lh).toBeGreaterThanOrEqual(0);
    expect(dv.getUint16(lh + 6, true)).toBe(FLAG_UTF8);
  });

  it('sets gp bit 11 in the central header for a non-ASCII (Cyrillic) name', async () => {
    const dv = await view(makeZip([{ name: 'символы/файл.png', bytes: bytes(1, 2, 3) }]));
    const ch = findSig(dv, CH_SIG);
    expect(ch).toBeGreaterThanOrEqual(0);
    expect(dv.getUint16(ch + 8, true)).toBe(FLAG_UTF8);
  });

  it('sets gp bit 11 in BOTH headers for an ASCII name too (UTF-8 ⊇ ASCII)', async () => {
    const dv = await view(makeZip([{ name: 'a.png', bytes: bytes(9) }]));
    const lh = findSig(dv, LH_SIG);
    const ch = findSig(dv, CH_SIG);
    expect(dv.getUint16(lh + 6, true)).toBe(FLAG_UTF8);
    expect(dv.getUint16(ch + 8, true)).toBe(FLAG_UTF8);
  });
});

describe('makeZip — byte-stability (only the two flag words changed)', () => {
  it('produces a small zip whose every other field matches the hand-computed layout', async () => {
    // crc32 of [1,2,3] = 0x55BC801D (standard PKZIP CRC).
    const payload = bytes(1, 2, 3);
    const name = 'a.png';
    const dv = await view(makeZip([{ name, bytes: payload }]));
    const nameLen = name.length;

    const lh = findSig(dv, LH_SIG);
    expect(lh).toBe(0); // local header is first
    expect(dv.getUint16(lh + 4, true)).toBe(20); // version needed
    expect(dv.getUint16(lh + 8, true)).toBe(0); // method 0 = store
    const crc = dv.getUint32(lh + 14, true);
    expect(crc).toBe(0x55bc801d);
    expect(dv.getUint32(lh + 18, true)).toBe(payload.length); // compressed size
    expect(dv.getUint32(lh + 22, true)).toBe(payload.length); // uncompressed size
    expect(dv.getUint16(lh + 26, true)).toBe(nameLen); // name length
    expect(dv.getUint16(lh + 28, true)).toBe(0); // extra length

    const ch = findSig(dv, CH_SIG);
    expect(dv.getUint16(ch + 4, true)).toBe(20); // version made by
    expect(dv.getUint16(ch + 6, true)).toBe(20); // version needed
    expect(dv.getUint16(ch + 10, true)).toBe(0); // method
    expect(dv.getUint32(ch + 16, true)).toBe(crc);
    expect(dv.getUint32(ch + 20, true)).toBe(payload.length);
    expect(dv.getUint32(ch + 24, true)).toBe(payload.length);
    expect(dv.getUint16(ch + 28, true)).toBe(nameLen);
    expect(dv.getUint32(ch + 42, true)).toBe(0); // local-header offset of the first entry

    const eocd = findSig(dv, EOCD_SIG);
    expect(dv.getUint16(eocd + 8, true)).toBe(1); // entries on this disk
    expect(dv.getUint16(eocd + 10, true)).toBe(1); // total entries
  });

  it('round-trips three entries: recomputed CRC matches the recorded CRC (no field shift)', async () => {
    const entries: ZipEntry[] = [
      { name: 'one.txt', bytes: bytes(10, 20, 30, 40) },
      { name: 'два.bin', bytes: bytes(0, 255, 128) },
      { name: 'three.dat', bytes: bytes(7) },
    ];
    const blob = makeZip(entries);
    const dv = await view(blob);
    const raw = new Uint8Array(await blob.arrayBuffer());

    // Walk the local headers in order; slice each payload by its recorded size and recompute CRC32.
    let p = 0;
    for (const e of entries) {
      expect(dv.getUint32(p, true)).toBe(LH_SIG);
      const size = dv.getUint32(p + 22, true);
      const nameLen = dv.getUint16(p + 26, true);
      const dataStart = p + 30 + nameLen;
      const payload = raw.subarray(dataStart, dataStart + size);
      expect(Array.from(payload)).toEqual(Array.from(e.bytes));
      expect(dv.getUint32(p + 14, true)).toBe(crc32(payload));
      p = dataStart + size;
    }
  });
});

describe('makeZip — overflow guard (loud refusal, no ZIP64)', () => {
  it('throws ZipOverflowError up front when entry count exceeds 0xFFFF', () => {
    // A stub array-like that reports a length past the 16-bit ceiling — the up-front guard must throw
    // BEFORE iterating, so we never materialize 0x10000 real entries.
    const huge = { length: 0x10000 } as unknown as ZipEntry[];
    expect(() => makeZip(huge)).toThrow(ZipOverflowError);
    expect(() => makeZip(huge)).toThrow(/split/);
  });

  it('does NOT throw at exactly 0xFFFF entries (strict >)', () => {
    const entries: ZipEntry[] = Array.from({ length: 0xffff }, () => ({ name: 'x', bytes: bytes(0) }));
    expect(() => makeZip(entries)).not.toThrow();
  });

  it('throws ZipOverflowError for an entry whose size exceeds 0xFFFFFFFF, before crc32/slice', () => {
    // {length: 0x100000000} stub: the size guard fires before crc32() or e.bytes.slice() would touch
    // any 4 GiB of memory. Reaching either would OOM / hang — so a clean throw proves the ordering.
    const stub = { length: 0x100000000 } as unknown as Uint8Array;
    expect(() => makeZip([{ name: 'big.bin', bytes: stub }])).toThrow(ZipOverflowError);
  });

  it('returns a valid empty zip for [] (EOCD only, entry count 0)', async () => {
    const dv = await view(makeZip([]));
    const eocd = findSig(dv, EOCD_SIG);
    expect(eocd).toBeGreaterThanOrEqual(0);
    expect(dv.getUint16(eocd + 8, true)).toBe(0);
    expect(dv.getUint16(eocd + 10, true)).toBe(0);
  });
});

// Local CRC32 mirror (standard PKZIP polynomial) for the round-trip check — independent of zip.ts.
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
