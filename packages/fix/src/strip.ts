// Lossless ancillary-metadata strip (Phase-2 fix — the drop-in sibling of the `strippable-metadata`
// detector). Produces a NEW image byte buffer with EXACTLY the strippable ancillary chunks removed that
// @asset-doctor/parsers' `strippableMetadataBytes` COUNTS — embedded ICC profiles, EXIF/XMP, PNG text
// chunks + timestamps the GPU never uses. It NEVER decodes and NEVER re-encodes: the pixel-bearing chunks
// (PNG IHDR/IDAT/PLTE/tRNS/…, JPEG scan, WebP VP8/VP8L) are copied byte-for-byte, so the decoded pixels are
// IDENTICAL (lossless, unlike a canvas re-encode). The removal set is the SAME allow-set the detector's walk
// classifies (packages/parsers/src/image-size.ts) — strip.test.ts pins `removed >= strippableMetadataBytes`
// for every input and `removed === strippableMetadataBytes` for the pad-free formats, so the Pro fix removes
// exactly (or, for odd-sized RIFF chunks, a pad byte MORE than) what the diagnosis MEASURED. HONESTY
// (invariant 5): a DISK/DOWNLOAD saving ONLY — the GPU still decodes to RGBA8888, so VRAM is UNCHANGED; the
// worker carries the MEASURED byte delta (b.length − out.length), never a VRAM claim. Pure, no IO, no
// network (invariant 1); never throws (bounds-checked; corrupt tails are copied verbatim, matching the
// detector's bail-to-partial). AVIF / unrecognized ⇒ the input is returned UNCHANGED (removed 0).

export interface StripResult {
  /** The stripped image bytes. Byte-identical REFERENCE to the input when nothing was removed. */
  bytes: Uint8Array;
  /** EXACT bytes removed = input.length − bytes.length. DISK only — never a VRAM saving (invariant 5). */
  removed: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// The PNG allow-set MUST match packages/parsers/src/image-size.ts PNG_STRIPPABLE (pinned by strip.test.ts):
// ancillary chunks that carry NO pixel/rendering data. tRNS (functional transparency) + pHYs/gAMA/cHRM/sRGB/
// bKGD/sBIT are DELIBERATELY excluded (they can alter rendering / a re-encoder keeps pHYs).
const PNG_STRIPPABLE = new Set(['iCCP', 'eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const type4 = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** Splice the [start,end) byte ranges out of `b`, copying everything else verbatim. Ranges MUST be sorted,
 *  non-overlapping and in-bounds (the walkers guarantee this). Returns the new buffer + the removed count. */
function spliceOut(b: Uint8Array, ranges: [number, number][]): { out: Uint8Array; removed: number } {
  if (ranges.length === 0) return { out: b, removed: 0 };
  const removed = ranges.reduce((s, [a, z]) => s + (z - a), 0);
  const out = new Uint8Array(b.length - removed);
  let w = 0;
  let cursor = 0;
  for (const [a, z] of ranges) {
    out.set(b.subarray(cursor, a), w);
    w += a - cursor;
    cursor = z;
  }
  out.set(b.subarray(cursor), w);
  return { out, removed };
}

/** PNG: the on-disk ranges of every strippable ancillary chunk. Mirrors pngStrippable's walk — stops at
 *  IEND, bails to the accumulated ranges on a chunk length that overruns the buffer (the corrupt tail is
 *  copied verbatim by the splicer). A chunk spans len+12 (length 4 + type 4 + data + crc 4). */
function pngRanges(b: Uint8Array): [number, number][] {
  const ranges: [number, number][] = [];
  let o = 8; // just past the signature
  while (o + 8 <= b.length) {
    const len = u32be(b, o);
    const span = len + 12;
    if (o + span > b.length) break; // corrupt — leave the tail intact
    const t = type4(b, o + 4);
    if (t === 'IEND') break;
    if (PNG_STRIPPABLE.has(t)) ranges.push([o, o + span]);
    o += span;
  }
  return ranges;
}

/** JPEG: the ranges of every strippable APP1..APP15 / COM segment. Mirrors jpegStrippable — excludes APP0
 *  (JFIF), stops at SOS (the entropy-coded scan + any trailing markers are copied verbatim). */
function jpegRanges(b: Uint8Array): [number, number][] {
  const ranges: [number, number][] = [];
  let o = 2; // past SOI (already validated by the caller)
  while (o + 1 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1]!;
    if (marker === 0xff || marker === 0x00) {
      o++;
      continue;
    }
    // Standalone markers carry no length segment.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      if (marker === 0xd9) break; // EOI
      o += 2;
      continue;
    }
    if (marker === 0xda) break; // SOS — scan begins, no more metadata segments
    if (o + 4 > b.length) break;
    const len = u16be(b, o + 2);
    const segSize = 2 + len;
    if (o + segSize > b.length) break; // corrupt — leave the tail intact
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) ranges.push([o, o + segSize]);
    o += segSize;
  }
  return ranges;
}

const isWebp = (b: Uint8Array): boolean =>
  startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);

/** WebP (VP8X only): the ranges of every strippable EXIF / XMP / ICCP chunk INCLUDING its even-boundary pad
 *  byte (removing the chunk but leaving a dangling pad byte would misalign the RIFF stream). Mirrors
 *  webpStrippable's walk; simple VP8/VP8L containers carry no ancillary chunks. */
function webpRanges(b: Uint8Array): [number, number][] {
  if (b.length < 16 || type4(b, 12) !== 'VP8X') return [];
  const ranges: [number, number][] = [];
  let o = 12; // the VP8X header is the first RIFF chunk
  while (o + 8 <= b.length) {
    const fourcc = type4(b, o);
    // RIFF chunk sizes are LITTLE-endian.
    const size = (b[o + 4]! | (b[o + 5]! << 8) | (b[o + 6]! << 16) | (b[o + 7]! << 24)) >>> 0;
    const padded = size + (size & 1); // padded to an even byte boundary
    const chunkSpan = 8 + padded;
    if (o + 8 + size > b.length) break; // corrupt — leave the tail intact
    if (fourcc === 'EXIF' || fourcc === 'XMP ' || fourcc === 'ICCP') {
      // Remove the WHOLE on-disk chunk (fourcc + size hdr + payload + pad) so the stream stays aligned.
      ranges.push([o, o + Math.min(chunkSpan, b.length - o)]);
    }
    o += chunkSpan;
  }
  return ranges;
}

// VP8X flag bits (byte at file offset 20): ICC 0x20, EXIF 0x08, XMP 0x04. Alpha (0x10) + Animation (0x02)
// are NEVER touched. After removing the ICC/EXIF/XMP chunks the container MUST clear these flags or a strict
// demuxer will look for chunks that no longer exist.
const VP8X_META_FLAGS = 0x20 | 0x08 | 0x04;

/** Strip strippable ancillary metadata from a PNG / JPEG / WebP image, LOSSLESSLY (pixels untouched). AVIF /
 *  unrecognized ⇒ the input is returned unchanged (removed 0). Never throws. */
export function stripImageMetadata(bytes: Uint8Array): StripResult {
  if (startsWith(bytes, PNG_SIG)) {
    const { out, removed } = spliceOut(bytes, pngRanges(bytes));
    return { bytes: out, removed };
  }
  if (isWebp(bytes)) {
    const ranges = webpRanges(bytes);
    if (ranges.length === 0) return { bytes, removed: 0 };
    const { out, removed } = spliceOut(bytes, ranges);
    // Fix the RIFF container size (offset 4, LE = out.length − 8) and clear the ICC/EXIF/XMP VP8X flags so
    // the shrunk file is a VALID drop-in WebP.
    const riff = out.length - 8;
    out[4] = riff & 0xff;
    out[5] = (riff >>> 8) & 0xff;
    out[6] = (riff >>> 16) & 0xff;
    out[7] = (riff >>> 24) & 0xff;
    if (out.length > 20) out[20] = out[20]! & ~VP8X_META_FLAGS;
    return { bytes: out, removed };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const { out, removed } = spliceOut(bytes, jpegRanges(bytes));
    return { bytes: out, removed };
  }
  return { bytes, removed: 0 }; // AVIF / unrecognized — nothing to strip
}
