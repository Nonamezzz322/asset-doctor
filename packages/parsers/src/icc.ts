// Embedded ICC colour-profile probe — a PURE, header-only byte-walk (invariant 1: no decode, no network).
// Answers ONE honesty question about a PNG / JPEG / WebP image: it carries an ICC profile — can we PROVE that
// profile is sRGB? Removing an ICC profile is only a FREE disk saving when the profile is sRGB (sRGB is the
// web/GPU default, so dropping it does not change the rendered colours). A Display-P3 / Adobe-RGB / any
// non-sRGB profile is load-bearing: stripping it silently shifts colours, so those bytes are NOT a free
// saving and the Pro fix must KEEP the chunk. Absence of proof ⇒ conservatively NOT provable ⇒ keep it (a
// TRUE LOWER BOUND on the claimed saving; under-claiming is correct, over-claiming is the bug this fixes).
//
// The byte counts mirror the strippable-metadata walkers (image-size.ts) EXACTLY so the two can never drift:
//   PNG  iCCP  = len + 12   ·   WebP ICCP = size + 8   ·   JPEG = Σ (2 + len) over the APP2 ICC segments.
// Every read is bounds-checked; the walks bail-to-partial on an overrunning length exactly like the
// strippable walkers. NEVER throws, NEVER decodes pixels. AVIF / unrecognised / no ICC ⇒ absent.

export interface IccInfo {
  /** An ICC profile chunk (PNG iCCP / WebP ICCP / JPEG APP2 ICC) is present. */
  present: boolean;
  /** On-disk cost of the ICC chunk(s), counted the SAME way strippableMetadataBytes counts them (so the
   *  detector can subtract this verbatim without drift). 0 when absent. */
  bytes: number;
  /** We can PROVE the profile is sRGB (⇒ its bytes ARE a free strip). Absence of proof ⇒ false ⇒ keep it. */
  provableSrgb: boolean;
  /** Human-readable profile identity: the PNG iCCP name, or the parsed ICC `desc` text (trimmed, ≤80). null
   *  when absent / unreadable. Used only for disclosure copy — never for the provable decision on PNG (the
   *  compressed profile is never inflated; the sRGB proof there is the name or a sibling sRGB chunk). */
  label: string | null;
}

const ABSENT: IccInfo = { present: false, bytes: 0, provableSrgb: false, label: null };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u32be = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const type4 = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (offset + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}

const SRGB_RE = /srgb/i;
const CAP = 80; // profile-label display cap

/** Trim + cap a decoded profile string; empty ⇒ null. */
function label(s: string): string | null {
  const t = s.replace(/\0+$/, '').trim().slice(0, CAP);
  return t.length > 0 ? t : null;
}

/** Parse the ICC `desc` tag from a raw ICC profile buffer (starting at the 128-byte header). Pure, bounded,
 *  defensive: returns null on ANY inconsistency (bad tag table, missing/short tag, out-of-bounds string).
 *  Supports ICC v2 `desc` (textDescriptionType) and ICC v4 `mluc` (multiLocalizedUnicode). NEVER throws. */
function parseIccDesc(icc: Uint8Array): string | null {
  // ICC header is 128 bytes; the tag table count is a uint32be at offset 128.
  if (icc.length < 132) return null;
  const tagCount = u32be(icc, 128);
  const tableStart = 132;
  // Bound the table: tagCount entries of 12 bytes must fit. (Also rejects an absurd count that overruns.)
  if (tagCount <= 0 || tableStart + tagCount * 12 > icc.length) return null;
  for (let i = 0; i < tagCount; i++) {
    const e = tableStart + i * 12;
    if (type4(icc, e) !== 'desc') continue;
    const off = u32be(icc, e + 4); // tag data offset, relative to profile start (offset 0 = header)
    if (off + 8 > icc.length) return null; // need at least the type signature + first field
    const typeSig = type4(icc, off);
    if (typeSig === 'desc') {
      // ICC v2 textDescriptionType: 'desc'(4) reserved(4) asciiCount:uint32be@+8 then the ASCII string@+12
      // (asciiCount INCLUDES the trailing NUL).
      if (off + 12 > icc.length) return null;
      const asciiCount = u32be(icc, off + 8);
      if (asciiCount <= 0) return null;
      const start = off + 12;
      const end = start + asciiCount;
      if (end > icc.length) return null;
      let s = '';
      for (let j = start; j < end; j++) s += String.fromCharCode(icc[j]!);
      return label(s);
    }
    if (typeSig === 'mluc') {
      // ICC v4 multiLocalizedUnicode: 'mluc'(4) reserved(4) numRecords:uint32be(4) recordSize:uint32be(4)
      // then records {lang(2) country(2) length:uint32be(4) offset:uint32be(4)}; the string is UTF-16BE at
      // (tagOffset + offset). We only need the FIRST record to test for "srgb".
      if (off + 16 > icc.length) return null;
      const numRecords = u32be(icc, off + 8);
      if (numRecords <= 0) return null;
      const rec = off + 16; // first record
      if (rec + 12 > icc.length) return null;
      const strLen = u32be(icc, rec + 4); // bytes (UTF-16 ⇒ 2 per char)
      const strOff = u32be(icc, rec + 8); // relative to the tag offset
      const start = off + strOff;
      const end = start + strLen;
      if (end > icc.length) return null;
      // Decode ASCII-ishly: UTF-16BE stores the ASCII byte as the SECOND of each pair — enough to test "srgb".
      let s = '';
      for (let j = start + 1; j < end; j += 2) s += String.fromCharCode(icc[j]!);
      return label(s);
    }
    return null; // an unknown desc type signature — cannot read it, so unproven
  }
  return null; // no desc tag
}

// 12-byte JPEG APP2 ICC identifier "ICC_PROFILE\0" as raw bytes.
const ICC_ID_BYTES = [...'ICC_PROFILE\0'].map((c) => c.charCodeAt(0));

/** PNG: sum the iCCP chunk cost (len + 12) and prove sRGB via a sibling `sRGB` chunk OR an iCCP profile NAME
 *  matching /srgb/i. The compressed profile is NEVER inflated (invariant 1) — the name / sibling chunk is the
 *  only header-only proof. Mirrors pngStrippable's walk (stop at IEND, bail-to-partial on an overrunning
 *  chunk) so the counted bytes match the detector exactly. */
function pngIcc(b: Uint8Array): IccInfo {
  let bytes = 0;
  let present = false;
  let name: string | null = null;
  let srgbChunk = false;
  let o = 8; // just past the signature
  while (o + 8 <= b.length) {
    const len = u32be(b, o);
    const span = len + 12; // length(4) + type(4) + data(len) + crc(4)
    if (o + span > b.length) break; // corrupt — bail to the accumulated partial (parity with pngStrippable)
    const t = type4(b, o + 4);
    if (t === 'IEND') break;
    if (t === 'sRGB') srgbChunk = true;
    if (t === 'iCCP') {
      present = true;
      bytes += span;
      // Profile name: latin-1, NUL-terminated, ≤79 bytes, at the START of the chunk data (o + 8).
      const dataStart = o + 8;
      const scanEnd = Math.min(dataStart + 80, o + span);
      let e = dataStart;
      while (e < scanEnd && b[e] !== 0) e++;
      let s = '';
      for (let j = dataStart; j < e; j++) s += String.fromCharCode(b[j]!);
      name = label(s);
    }
    o += span;
  }
  if (!present) return ABSENT;
  const provableSrgb = srgbChunk || (name !== null && SRGB_RE.test(name));
  return { present: true, bytes, provableSrgb, label: name };
}

/** JPEG: sum the APP2 ICC-segment cost (Σ 2 + len) and prove sRGB by parsing the ICC `desc` tag from the
 *  FIRST chunk (seq 1). Mirrors jpegStrippable's walk (stop at SOS/EOI, bail-to-partial). */
function jpegIcc(b: Uint8Array): IccInfo {
  let bytes = 0;
  let present = false;
  let firstChunk: Uint8Array | null = null; // raw ICC bytes of the seq-1 chunk (starts at the ICC header)
  let o = 2; // past SOI
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
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      if (marker === 0xd9) break; // EOI
      o += 2;
      continue;
    }
    if (marker === 0xda) break; // SOS — entropy-coded scan begins
    if (o + 4 > b.length) break;
    const len = u16be(b, o + 2);
    const segSize = 2 + len;
    if (o + segSize > b.length) break; // overruns — bail to partial
    // APP2 (0xE2) carries the ICC profile, identified by the "ICC_PROFILE\0" tag at the payload start.
    if (marker === 0xe2 && startsWith(b, ICC_ID_BYTES, o + 4)) {
      present = true;
      bytes += segSize;
      // payload = ICC_PROFILE\0(12) + seq(1) + count(1) + ICC data. seq/count live at o+16 / o+17.
      const seq = b[o + 16]!;
      if (seq === 1) firstChunk = b.subarray(o + 18, o + segSize);
    }
    o += segSize;
  }
  if (!present) return ABSENT;
  const text = firstChunk ? parseIccDesc(firstChunk) : null;
  return { present: true, bytes, provableSrgb: text !== null && SRGB_RE.test(text), label: text };
}

/** WebP (VP8X only): the ICCP chunk payload IS the raw ICC profile. Cost = size + 8 (parity with
 *  webpStrippable). Prove sRGB via the parsed `desc` tag. Simple VP8/VP8L carry no ICC. */
function webpIcc(b: Uint8Array): IccInfo {
  if (b.length < 16 || type4(b, 12) !== 'VP8X') return ABSENT;
  let o = 12; // the VP8X header is the first RIFF chunk
  while (o + 8 <= b.length) {
    const fourcc = type4(b, o);
    const size = (b[o + 4]! | (b[o + 5]! << 8) | (b[o + 6]! << 16) | (b[o + 7]! << 24)) >>> 0;
    const padded = size + (size & 1);
    if (o + 8 + size > b.length) break; // overruns — bail
    if (fourcc === 'ICCP') {
      const icc = b.subarray(o + 8, o + 8 + size);
      const text = parseIccDesc(icc);
      return { present: true, bytes: size + 8, provableSrgb: text !== null && SRGB_RE.test(text), label: text };
    }
    o += 8 + padded;
  }
  return ABSENT;
}

/** Probe an image header for an embedded ICC profile and decide whether we can PROVE it is sRGB. Pure,
 *  bounded, never throws, never decodes (invariant 1). AVIF / unrecognised / no ICC ⇒ absent. */
export function iccProfileInfo(bytes: Uint8Array): IccInfo {
  if (startsWith(bytes, PNG_SIG)) return pngIcc(bytes);
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return webpIcc(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegIcc(bytes);
  return ABSENT; // AVIF / unrecognised — an ISOBMFF box-tree walk is out of scope (invariant 4)
}

/** The `ImageAsset.icc` field for a header — the IccInfo minus `present`, or undefined when absent.
 *  Omit-when-absent keeps no-ICC assets byte-identical to before. One helper so the four parser sites
 *  (atlas / loose image / bmfont page / spine page) can never drift. */
export function iccAssetField(bytes: Uint8Array): { bytes: number; provableSrgb: boolean; label: string | null } | undefined {
  const icc = iccProfileInfo(bytes);
  return icc.present ? { bytes: icc.bytes, provableSrgb: icc.provableSrgb, label: icc.label } : undefined;
}
