// Read image dimensions + mime straight from the file header — no decoding, no DOM.
// Pure and worker-safe. Covers PNG, WebP (VP8 / VP8L / VP8X) and JPEG.

import type { ImageMime, Size } from '@asset-doctor/core';

export interface ImageInfo {
  mime: ImageMime;
  size: Size;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
  return { w: u32be(b, 16), h: u32be(b, 20) };
}

function readWebp(b: Uint8Array): Size | null {
  if (!startsWith(b, [0x52, 0x49, 0x46, 0x46]) || !startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) {
    return null; // 'RIFF' .... 'WEBP'
  }
  if (b.length < 30) return null;
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (fourcc === 'VP8 ') {
    // lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit w / 14-bit h @26.
    return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    // lossless: signature 0x2f @20, then (w-1):14, (h-1):14 packed little-endian.
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    // extended: 24-bit (w-1) @24, 24-bit (h-1) @27, little-endian.
    return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
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
      return { h: u16be(b, o + 5), w: u16be(b, o + 7) };
    }
    o += 2 + len;
  }
  return null;
}

function indexOfFourcc(b: Uint8Array, cc: string, from = 0): number {
  const a = cc.charCodeAt(0);
  const c = cc.charCodeAt(1);
  const d = cc.charCodeAt(2);
  const e = cc.charCodeAt(3);
  for (let i = from; i + 4 <= b.length; i++) {
    if (b[i] === a && b[i + 1] === c && b[i + 2] === d && b[i + 3] === e) return i;
  }
  return -1;
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
  // Image size lives in the 'ispe' (ImageSpatialExtents) box: ['ispe'][version+flags:4][w:4][h:4].
  const idx = indexOfFourcc(b, 'ispe');
  if (idx < 0 || idx + 16 > b.length) return null;
  return { w: u32be(b, idx + 8), h: u32be(b, idx + 12) };
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
