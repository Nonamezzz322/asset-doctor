// Read image dimensions + mime straight from the file header — no decoding, no DOM.
// Pure and worker-safe. Covers PNG, WebP (VP8 / VP8L / VP8X) and JPEG.

import type { ImageMime, Size } from '@asset-doctor/core';
import { iccProfileInfo } from './icc';

export interface ImageInfo {
  mime: ImageMime;
  size: Size;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Largest dimension any GL implementation supports (and well past any sane sprite). A header that
 *  decodes to 0, negative, or an absurd size is corrupt/garbage — reject it rather than fabricate a
 *  texture that would pin terabytes of "VRAM". */
const MAX_DIM = 32768;
const validDims = (s: Size | null): Size | null =>
  s && s.w > 0 && s.h > 0 && s.w <= MAX_DIM && s.h <= MAX_DIM ? s : null;

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (offset + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}

const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

function readPng(b: Uint8Array): Size | null {
  if (!startsWith(b, PNG_SIG) || b.length < 24) return null;
  // 8 sig, 4 IHDR length, 4 'IHDR', then width@16, height@20 (big-endian u32).
  return validDims({ w: u32be(b, 16), h: u32be(b, 20) });
}

function readWebp(b: Uint8Array): Size | null {
  if (!startsWith(b, [0x52, 0x49, 0x46, 0x46]) || !startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return null; // 'RIFF' .... 'WEBP'
  }
  if (b.length < 30) return null;
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (fourcc === 'VP8 ') {
    // lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit w / 14-bit h @26.
    return validDims({ w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff });
  }
  if (fourcc === 'VP8L') {
    // lossless: signature 0x2f @20, then (w-1):14, (h-1):14 packed little-endian.
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return validDims({ w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 });
  }
  if (fourcc === 'VP8X') {
    // extended: 24-bit (w-1) @24, 24-bit (h-1) @27, little-endian.
    return validDims({ w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 });
  }
  return null;
}

function readJpeg(b: Uint8Array): Size | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1]!;
    if (marker === 0xff || marker === 0x00) {
      o++; // fill / padding
      continue;
    }
    // Standalone markers carry no length segment.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    const len = u16be(b, o + 2);
    // SOF0..SOF15 hold the frame size — but not DHT(C4) / JPG(C8) / DAC(CC).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return validDims({ h: u16be(b, o + 5), w: u16be(b, o + 7) });
    }
    o += 2 + len;
  }
  return null;
}

/** Fourcc at box offset o+4 (ISOBMFF: [size:4][type:4]). */
const boxType = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);

/** Walk the child boxes of [start, end) invoking cb(offset, type, size). Bounds-safe: a zero/short/
 *  overflowing size ends the walk (bail to what was found — never a throw, never a read past end).
 *  size===1 (64-bit largesize) is not walked into (rare in AVIF stills; bail keeps us honest). */
function walkBoxes(b: Uint8Array, start: number, end: number, cb: (o: number, type: string, size: number) => void): void {
  let o = start;
  while (o + 8 <= end) {
    const size = u32be(b, o);
    if (size < 8 || o + size > end) return; // 0=to-EOF and 1=largesize both bail (never guess)
    cb(o, boxType(b, o), size);
    o += size;
  }
}

function readAvif(b: Uint8Array): Size | null {
  // ISOBMFF: [size:4]['ftyp'] then brands. Must declare an avif/avis brand.
  if (b.length < 16 || !startsWith(b, [0x66, 0x74, 0x79, 0x70], 4)) return null; // 'ftyp' @4
  const ftypSize = u32be(b, 0);
  const brandEnd = Math.min(b.length, ftypSize >= 12 ? ftypSize : b.length);
  let isAvif = false;
  for (let i = 8; i + 4 <= brandEnd; i += 4) {
    const brand = String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);
    if (brand === 'avif' || brand === 'avis') {
      isAvif = true;
      break;
    }
  }
  if (!isAvif) return null;
  // Image size lives in the 'ispe' (ImageSpatialExtents) property: ['ispe'][version+flags:4][w:4][h:4],
  // inside meta → iprp → ipco. A REAL box walk (P3 parsers audit #5): the old naive first-'ispe'
  // byte-scan matched those 4 ASCII bytes ANYWHERE — Exif/XMP/mdat payloads or a free box before the
  // real property produced garbage dimensions. Among the ipco entries we take the LARGEST area: the
  // primary image's extent is the largest in practice (an alpha-aux ispe duplicates it; thumbnails are
  // smaller). Resolving the primary item via pitm+ipma associations would be exact but is far heavier;
  // taking the max never under-reports the primary. Malformed structure ⇒ null (honest unknown, never a
  // scan fallback).
  let best: Size | null = null;
  walkBoxes(b, 0, b.length, (o, type, size) => {
    if (type !== 'meta') return;
    // meta is a FullBox: 4 bytes version/flags before its children.
    walkBoxes(b, o + 12, o + size, (o2, t2, s2) => {
      if (t2 !== 'iprp') return;
      walkBoxes(b, o2 + 8, o2 + s2, (o3, t3, s3) => {
        if (t3 !== 'ipco') return;
        walkBoxes(b, o3 + 8, o3 + s3, (o4, t4, s4) => {
          if (t4 !== 'ispe' || s4 < 20) return; // 8 header + 4 version/flags + 4 w + 4 h
          const dims = validDims({ w: u32be(b, o4 + 12), h: u32be(b, o4 + 16) });
          if (dims && (!best || dims.w * dims.h > best.w * best.h)) best = dims;
        });
      });
    });
  });
  return best;
}

/** Detect format from magic bytes and return its mime + pixel size, or null. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const png = readPng(bytes);
  if (png) return { mime: 'image/png', size: png };
  const webp = readWebp(bytes);
  if (webp) return { mime: 'image/webp', size: webp };
  const avif = readAvif(bytes);
  if (avif) return { mime: 'image/avif', size: avif };
  const jpeg = readJpeg(bytes);
  if (jpeg) return { mime: 'image/jpeg', size: jpeg };
  return null;
}

/* ── Strippable ancillary-metadata measurement (pure header walk — no decode) ─────────────────────
 * Sum the EXACT bytes a re-encode / oxipng strip would remove from an image: embedded ICC profiles,
 * EXIF/XMP, text chunks and timestamps the GPU never uses. A PURE, header-only byte-walk (invariant 1 —
 * no decode, no network); never throws; every read is bounds-checked and any out-of-bounds length bails
 * to the accumulated partial. The counted set is a CONSERVATIVE TRUE LOWER BOUND of what the existing fix
 * (canvas re-encode → IHDR/IDAT/IEND/pHYs only; oxipng -strip → all ancillary) actually drops — see
 * fixtures/sample-projects/strippable-metadata/README.md (Test D). */

const PNG_TYPE = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

// PNG allow-set: ancillary chunks safe to strip (carry NO pixel/rendering data). DELIBERATELY EXCLUDES
// tRNS (functional transparency) and pHYs/gAMA/cHRM/sRGB/bKGD/sBIT (may alter rendering / a re-encoder
// keeps pHYs). Each counted chunk costs len + 12 on disk (4 length + 4 type + len data + 4 CRC).
// iCCP (embedded ICC profile) is COLOUR-MANAGEMENT, not dead weight: stripping a NON-sRGB profile (Display
// P3 / Adobe RGB / …) silently shifts the rendered colours, so it is NOT a free saving. iCCP therefore
// stays in the walk's raw sum but strippableMetadataBytes SUBTRACTS it back out unless we can PROVE the
// profile is sRGB (iccProfileInfo — a header-only sRGB-chunk / profile-name / desc-tag proof). Counting a
// non-provable ICC as a saving would be an invariant-3 lie; keeping it is a conservative TRUE LOWER BOUND.
const PNG_STRIPPABLE = new Set(['iCCP', 'eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function pngStrippable(b: Uint8Array): number {
  if (!startsWith(b, PNG_SIG)) return 0;
  let total = 0;
  let o = 8; // walk chunks from just past the 8-byte signature
  while (o + 8 <= b.length) {
    const len = u32be(b, o); // chunk data length
    const type = PNG_TYPE(b, o + 4);
    const chunkSize = len + 12; // length(4) + type(4) + data(len) + crc(4)
    // Defensive bounds: a length that runs past the buffer is corrupt — bail to the accumulated partial.
    if (o + chunkSize > b.length) break;
    if (type === 'IEND') break; // end of the datastream
    if (PNG_STRIPPABLE.has(type)) total += chunkSize;
    o += chunkSize;
  }
  return total;
}

function jpegStrippable(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 0; // SOI
  let total = 0;
  let o = 2;
  while (o + 1 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1]!;
    if (marker === 0xff || marker === 0x00) {
      o++; // fill / padding byte
      continue;
    }
    // Standalone markers carry no length segment.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      if (marker === 0xd9) break; // EOI — done
      o += 2;
      continue;
    }
    if (marker === 0xda) break; // SOS — entropy-coded scan begins, no more metadata segments
    if (o + 4 > b.length) break; // length field must be present
    const len = u16be(b, o + 2);
    const segSize = 2 + len; // marker(2) + length-includes-itself(len)
    if (o + segSize > b.length) break; // segment runs past the buffer — bail to partial
    // APP1..APP15 (0xE1..0xEF) carry EXIF/XMP/ICC; COM (0xFE) carries a comment. EXCLUDE APP0 (0xE0, JFIF —
    // an encoder keeps it). Each costs 2 + len on disk (the 0xFFxx marker + the length-prefixed payload).
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) total += segSize;
    o += segSize;
  }
  return total;
}

function webpStrippable(b: Uint8Array): number {
  if (!startsWith(b, [0x52, 0x49, 0x46, 0x46]) || !startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 0; // not RIFF .... WEBP
  }
  // Only the extended (VP8X) container carries ancillary chunks; simple VP8/VP8L cannot.
  if (b.length < 16 || PNG_TYPE(b, 12) !== 'VP8X') return 0;
  let total = 0;
  let o = 12; // first RIFF chunk (the VP8X header) starts at offset 12
  while (o + 8 <= b.length) {
    const fourcc = PNG_TYPE(b, o);
    // RIFF chunk sizes are LITTLE-endian (4 bytes after the fourcc).
    const size = (b[o + 4]! | (b[o + 5]! << 8) | (b[o + 6]! << 16) | (b[o + 7]! << 24)) >>> 0;
    const padded = size + (size & 1); // chunks are padded to an even byte boundary
    const chunkSpan = 8 + padded; // fourcc(4) + size(4) + payload(+pad)
    if (o + 8 + size > b.length) break; // payload runs past the buffer — bail to partial
    // EXIF / XMP (trailing space, "XMP ") / ICCP carry strippable metadata; cost size + 8 (fourcc + size hdr).
    if (fourcc === 'EXIF' || fourcc === 'XMP ' || fourcc === 'ICCP') total += size + 8;
    o += chunkSpan;
  }
  return total;
}

/** Sum the EXACT strippable ancillary-metadata bytes in an image header (PNG / JPEG / WebP). AVIF /
 *  unrecognized ⇒ 0 (an ISOBMFF box-tree walk is too risky header-only, and AVIF is already the format
 *  target). Pure & defensive: never throws, never decodes (invariant 1). A conservative TRUE LOWER BOUND
 *  of what the existing canvas-re-encode / oxipng fix removes.
 *
 *  ICC honesty (invariant 3): an embedded ICC profile is only a FREE strip when it is sRGB (sRGB is the
 *  web/GPU default ⇒ dropping it changes nothing). When the profile is present but NOT provably sRGB, its
 *  bytes are EXCLUDED from the count — removing it would shift the rendered colours, so it is not a saving
 *  and the Pro fix keeps it. iccProfileInfo counts those ICC bytes the SAME way the walkers above do, so the
 *  subtraction can never drift. A provably-sRGB profile is left in the count (byte-identical to before). */
export function strippableMetadataBytes(bytes: Uint8Array): number {
  let total: number;
  if (startsWith(bytes, PNG_SIG)) total = pngStrippable(bytes);
  else if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    total = webpStrippable(bytes);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) total = jpegStrippable(bytes);
  else return 0; // AVIF / unrecognized
  const icc = iccProfileInfo(bytes);
  return icc.present && !icc.provableSrgb ? total - icc.bytes : total;
}
