// Exhaustive test of stripImageMetadata (packages/fix/src/strip.ts) — the LOSSLESS drop-in metadata strip.
// The load-bearing honesty anchor is the CROSS-CHECK against @asset-doctor/parsers strippableMetadataBytes
// (the SAME allow-set the diagnosis MEASURES): for every input `removed === b.length − out.length` (the real
// delta) AND `removed >= strippableMetadataBytes` (never removes LESS than the measured lower bound), with
// `===` for the pad-free formats. Fixtures are hand-built minimal headers in the exact style of the parser's
// strippableMetadataBytes tests (parsers.test.ts:301+) so the two walks are provably in lockstep. LOSSLESS:
// the pixel-bearing chunks are asserted byte-identical in the output; the stripped output re-scans to 0.

import { describe, expect, it } from 'vitest';
import { strippableMetadataBytes, readImageInfo, iccProfileInfo } from '@asset-doctor/parsers';
import { stripImageMetadata } from '../src/index';

// The worker's exact injected decision: keep an ICC profile we cannot PROVE is sRGB (stripping a non-sRGB
// profile shifts the rendered colours). With this keepIcc, the fix and the detector stay in perfect lock-step
// (removed === strippableMetadataBytes for pad-free formats — BOTH exclude a non-sRGB ICC, BOTH include a
// provable-sRGB one).
const keepIccFor = (b: Uint8Array): boolean => {
  const icc = iccProfileInfo(b);
  return icc.present && !icc.provableSrgb;
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
// A PNG chunk = [len:u32be][type:4][data:len][crc:4]. Fill data with a per-chunk byte so we can assert the
// KEPT chunks survive byte-for-byte and the STRIPPED ones vanish.
const pngChunk = (type: string, dataLen: number, fill = 0x41): number[] => [
  ...u32be(dataLen), ...ascii(type), ...new Array(dataLen).fill(fill), 0, 0, 0, 0,
];
const IHDR = [...u32be(13), ...ascii('IHDR'), ...u32be(64), ...u32be(64), 8, 6, 0, 0, 0, 0, 0, 0, 0];
const IDAT = pngChunk('IDAT', 24, 0xcd); // stand-in for the pixel datastream
const IEND = [...u32be(0), ...ascii('IEND'), 0, 0, 0, 0];
const png = (...chunks: number[][]): Uint8Array => new Uint8Array([...PNG_SIG, ...IHDR, ...chunks.flat(), ...IEND]);

// Assert the honesty contract for one input: removed is the REAL delta and never below the measured count.
function assertHonest(input: Uint8Array): ReturnType<typeof stripImageMetadata> {
  const r = stripImageMetadata(input);
  expect(r.removed).toBe(input.length - r.bytes.length); // removed IS the measured byte delta
  expect(r.removed).toBeGreaterThanOrEqual(strippableMetadataBytes(input)); // never below the lower bound
  return r;
}

// Does `hay` contain `needle` as a contiguous subsequence? Used to prove a kept chunk survived verbatim.
function contains(hay: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('stripImageMetadata — PNG', () => {
  it('removes tEXt + iCCP, keeps IHDR/IDAT/tRNS/IEND verbatim; removed === measured count', () => {
    const text = pngChunk('tEXt', 100, 0x11); // 112
    const icc = pngChunk('iCCP', 5000, 0x22); // 5012
    const trns = pngChunk('tRNS', 6, 0x33); // kept (functional)
    const srgb = pngChunk('sRGB', 1, 0); // PROVES the iCCP is sRGB ⇒ it stays a counted, strippable chunk
    const input = png(text, IDAT, icc, trns, srgb);
    const r = assertHonest(input); // default keepIcc=false: a provably-sRGB ICC is stripped, as before
    expect(r.removed).toBe(112 + 5012);
    expect(r.removed).toBe(strippableMetadataBytes(input)); // exact — PNG has no pad bytes (sRGB proves the ICC)
    // pixel-bearing + functional chunks survive byte-for-byte
    expect(contains(r.bytes, IDAT)).toBe(true);
    expect(contains(r.bytes, trns)).toBe(true);
    expect(contains(r.bytes, IHDR)).toBe(true);
    // the stripped chunks are gone
    expect(contains(r.bytes, text)).toBe(false);
    expect(contains(r.bytes, icc)).toBe(false);
    // a re-scan finds nothing left to strip, and the header still parses to the same dimensions
    expect(strippableMetadataBytes(r.bytes)).toBe(0);
    const info = readImageInfo(r.bytes);
    expect(info?.size).toEqual({ w: 64, h: 64 }); // header still parses to the same dimensions
  });

  it('strips the full allow-set {iCCP,eXIf,tEXt,iTXt,zTXt,tIME} and keeps everything else', () => {
    const strippable = ['iCCP', 'eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].map((t) => pngChunk(t, 10));
    const kept = ['tRNS', 'gAMA', 'sRGB', 'pHYs'].map((t) => pngChunk(t, 10));
    const input = png(...strippable, IDAT, ...kept);
    const r = assertHonest(input);
    expect(r.removed).toBe(6 * (10 + 12));
    for (const k of kept) expect(contains(r.bytes, k)).toBe(true);
    expect(strippableMetadataBytes(r.bytes)).toBe(0);
  });

  it('nothing strippable ⇒ returns the SAME reference, removed 0 (byte-identical)', () => {
    const input = png(IDAT, pngChunk('tRNS', 6));
    const r = stripImageMetadata(input);
    expect(r.removed).toBe(0);
    expect(r.bytes).toBe(input); // same reference — no allocation, provably byte-identical
  });

  it('truncated chunk length ⇒ strips the good chunk, copies the corrupt tail verbatim (bail-to-partial parity)', () => {
    const good = pngChunk('tEXt', 50); // 62
    const truncated = [...u32be(99999), ...ascii('iTXt'), 0x41, 0x41]; // claims 99999, only 2 bytes follow
    const input = new Uint8Array([...PNG_SIG, ...IHDR, ...IDAT, ...good, ...truncated]);
    const r = assertHonest(input);
    expect(r.removed).toBe(62);
    expect(r.removed).toBe(strippableMetadataBytes(input)); // detector also bails to 62
    expect(contains(r.bytes, truncated)).toBe(true); // corrupt tail preserved, never dropped
    expect(contains(r.bytes, IDAT)).toBe(true);
  });

  it('keepIcc: a NON-sRGB iCCP is KEPT, other metadata stripped; removed === count (both exclude the ICC)', () => {
    const icc = pngChunk('iCCP', 5000, 0x22); // non-provable name (all 0x22, no early NUL, not /srgb/i)
    const text = pngChunk('tEXt', 100, 0x11); // 112 — the only strippable metadata
    const input = png(text, IDAT, icc);
    const keepIcc = keepIccFor(input);
    expect(keepIcc).toBe(true); // no sRGB chunk, name not sRGB ⇒ we cannot prove it, so we keep it
    const r = stripImageMetadata(input, { keepIcc });
    expect(r.removed).toBe(112); // only the tEXt — the colour profile survives
    expect(r.removed).toBe(strippableMetadataBytes(input)); // lock-step: BOTH exclude the non-sRGB iCCP
    expect(contains(r.bytes, icc)).toBe(true); // iCCP kept byte-for-byte
    expect(contains(r.bytes, text)).toBe(false);
    expect(readImageInfo(r.bytes)?.size).toEqual({ w: 64, h: 64 });
  });

  it('keepIcc=false (default) still strips a non-sRGB iCCP ⇒ byte-identical to today', () => {
    const icc = pngChunk('iCCP', 3000, 0x22);
    const input = png(icc, IDAT);
    expect([...stripImageMetadata(input).bytes]).toEqual([...stripImageMetadata(input, {}).bytes]);
    expect(stripImageMetadata(input).removed).toBe(3012); // stripped by default (caller opts into keepIcc)
  });
});

describe('stripImageMetadata — JPEG', () => {
  const seg = (marker: number, len: number, fill = 0x00): number[] => [0xff, marker, ...u16be(len), ...new Array(len - 2).fill(fill)];
  it('removes APP1/COM, keeps APP0 (JFIF) + SOI + the scan; stops at SOS (post-scan APP1 kept)', () => {
    const app0 = seg(0xe0, 16, 0x4a); // JFIF — kept
    const app1 = seg(0xe1, 100, 0x55); // EXIF — removed (102)
    const com = seg(0xfe, 20, 0x66); // comment — removed (22)
    const sos = seg(0xda, 12, 0x77); // scan start
    const postApp1 = seg(0xe1, 500, 0x88); // AFTER the scan — must stay
    const input = new Uint8Array([0xff, 0xd8, ...app0, ...app1, ...com, ...sos, ...postApp1]);
    const r = assertHonest(input);
    expect(r.removed).toBe(102 + 22);
    expect(r.removed).toBe(strippableMetadataBytes(input));
    expect(contains(r.bytes, app0)).toBe(true); // JFIF kept
    expect(contains(r.bytes, sos)).toBe(true); // scan kept
    expect(contains(r.bytes, postApp1)).toBe(true); // post-scan segment untouched
    expect(contains(r.bytes, app1)).toBe(false);
    expect(contains(r.bytes, com)).toBe(false);
    expect(r.bytes[0]).toBe(0xff); // SOI intact
    expect(r.bytes[1]).toBe(0xd8);
  });

  it('keepIcc: a non-provable APP2 "ICC_PROFILE" segment is KEPT; a sibling APP1 is still stripped', () => {
    // APP2 ICC: len = 2(self) + 12(id) + 2(seq+count) + 30(icc) = 46. The 30-byte ICC is too short for a desc ⇒
    // NOT provably sRGB ⇒ keepIcc. A NON-ICC APP2 would still be stripped — only the ICC identifier is spared.
    const app2 = [0xff, 0xe2, ...u16be(46), ...ascii('ICC_PROFILE'), 0, 1, 1, ...new Array(30).fill(0x99)];
    const app1 = seg(0xe1, 100, 0x55); // plain APP1 — stripped (102)
    const input = new Uint8Array([0xff, 0xd8, ...app2, ...app1, 0xff, 0xd9]);
    const keepIcc = keepIccFor(input);
    expect(keepIcc).toBe(true);
    const r = stripImageMetadata(input, { keepIcc });
    expect(r.removed).toBe(102); // APP1 only; the APP2 ICC segment survives
    expect(r.removed).toBe(strippableMetadataBytes(input)); // detector also excludes the APP2 ICC
    expect(contains(r.bytes, app2)).toBe(true); // the colour profile segment is kept byte-for-byte
    expect(contains(r.bytes, app1)).toBe(false);
  });
});

describe('stripImageMetadata — WebP (VP8X)', () => {
  // VP8X data byte 0 = flags. Set ICC|EXIF|XMP so we can prove they get cleared. Offset in the file = 20.
  const vp8xData = (flags: number): number[] => [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const chunk = (fourcc: string, size: number, fill = 0x00): number[] => {
    const payload = new Array(size).fill(fill);
    if (size & 1) payload.push(0x00); // even-boundary pad byte
    return [...ascii(fourcc), ...u32le(size), ...payload];
  };
  const webp = (...chunks: number[][]): Uint8Array => {
    const body = chunks.flat();
    return new Uint8Array([...ascii('RIFF'), ...u32le(4 + body.length), ...ascii('WEBP'), ...body]);
  };

  it('removes an EXIF chunk, fixes the RIFF size, clears the ICC/EXIF/XMP flags; removed === count (even)', () => {
    const input = webp(chunk('VP8X', 10, 0), chunk('EXIF', 40, 0xee));
    // sanity: the flags byte we set is at file offset 20
    const withFlags = webp([...ascii('VP8X'), ...u32le(10), ...vp8xData(0x2c)], chunk('EXIF', 40, 0xee));
    expect(withFlags[20]).toBe(0x2c);
    const r = assertHonest(withFlags);
    expect(r.removed).toBe(48); // 40 + 8, even ⇒ exact
    expect(r.removed).toBe(strippableMetadataBytes(withFlags));
    // RIFF size field now equals out.length − 8
    expect(r.bytes[4]! | (r.bytes[5]! << 8) | (r.bytes[6]! << 16) | (r.bytes[7]! << 24)).toBe(r.bytes.length - 8);
    // the ICC/EXIF/XMP flag bits are cleared (Alpha/Anim bits, had they been set, would survive)
    expect(r.bytes[20]! & 0x2c).toBe(0);
    expect(strippableMetadataBytes(r.bytes)).toBe(0);
    expect(input.length).toBeGreaterThan(0); // (input used only to build the flagged variant)
  });

  it('an ODD-sized chunk removes the pad byte too ⇒ removed === count + 1 (still the real delta)', () => {
    // EXIF (not ICC) so there is no provable-sRGB question — the pad-byte handling is format-agnostic.
    const input = webp([...ascii('VP8X'), ...u32le(10), ...vp8xData(0x08)], chunk('EXIF', 41, 0x99));
    const r = assertHonest(input);
    // detector counts size+8 = 49; strip removes the padded chunk 8 + 42 = 50 (one pad byte more)
    expect(strippableMetadataBytes(input)).toBe(49);
    expect(r.removed).toBe(50);
    expect(r.bytes[20]! & 0x08).toBe(0); // EXIF flag cleared (its chunk was removed)
    expect(strippableMetadataBytes(r.bytes)).toBe(0);
  });

  it('keepIcc: a non-provable ICCP is KEPT and the VP8X ICC flag PRESERVED; a sibling EXIF is still stripped', () => {
    // VP8X flags ICC|EXIF = 0x28. ICCP payload (40 bytes of 0x99) is too short to hold a parseable ICC desc ⇒
    // NOT provably sRGB ⇒ keepIcc. The ICC flag (0x20) MUST survive — the chunk is still present (the trap).
    const input = webp([...ascii('VP8X'), ...u32le(10), ...vp8xData(0x28)], chunk('ICCP', 40, 0x99), chunk('EXIF', 40, 0xee));
    const keepIcc = keepIccFor(input);
    expect(keepIcc).toBe(true);
    const r = stripImageMetadata(input, { keepIcc });
    expect(r.removed).toBe(48); // only EXIF (40 + 8); the ICCP is kept
    expect(r.removed).toBe(strippableMetadataBytes(input)); // detector also excludes the non-sRGB ICCP
    expect(r.bytes[20]! & 0x20).toBe(0x20); // ICC flag PRESERVED (the profile chunk is still there)
    expect(r.bytes[20]! & 0x08).toBe(0); // EXIF flag cleared (its chunk was removed)
    // RIFF size fixed, and the kept ICCP re-scans to 0 strippable (it is excluded honestly).
    expect(r.bytes[4]! | (r.bytes[5]! << 8) | (r.bytes[6]! << 16) | (r.bytes[7]! << 24)).toBe(r.bytes.length - 8);
    expect(strippableMetadataBytes(r.bytes)).toBe(0);
  });

  it('a simple VP8 container (no VP8X) ⇒ passthrough, removed 0, same reference', () => {
    const vp8 = webp([...ascii('VP8 '), ...u32le(12), ...new Array(12).fill(0)]);
    const r = stripImageMetadata(vp8);
    expect(r.removed).toBe(0);
    expect(r.bytes).toBe(vp8);
  });
});

describe('stripImageMetadata — passthrough + honesty battery', () => {
  it('AVIF / unrecognized / empty ⇒ unchanged, removed 0', () => {
    const avif = new Uint8Array([0, 0, 0, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    for (const b of [avif, new Uint8Array([1, 2, 3, 4]), new Uint8Array(0)]) {
      const r = stripImageMetadata(b);
      expect(r.removed).toBe(0);
      expect(r.bytes).toBe(b);
    }
  });

  it('removed is ALWAYS the real delta and NEVER below the measured lower bound (cross-format battery)', () => {
    const inputs: Uint8Array[] = [
      png(pngChunk('iCCP', 3000), IDAT),
      png(IDAT), // clean
      new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...u16be(60), ...new Array(58).fill(0), 0xff, 0xda, ...u16be(4), 0, 0]),
    ];
    for (const b of inputs) {
      const r = assertHonest(b);
      // idempotent: stripping an already-stripped file removes nothing more
      const again = stripImageMetadata(r.bytes);
      expect(again.removed).toBe(0);
    }
  });

  it('is deterministic — same input ⇒ byte-identical output', () => {
    const input = png(pngChunk('tEXt', 40), IDAT, pngChunk('eXIf', 80));
    expect([...stripImageMetadata(input).bytes]).toEqual([...stripImageMetadata(input).bytes]);
  });
});
