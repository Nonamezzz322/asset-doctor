// Minimal store-only (no compression) ZIP writer — zero-dep, worker-safe. Store-only is correct here:
// the payload is PNG/WebP/AVIF (already compressed) + small JSON, so DEFLATE buys ~0% and just burns CPU.
//
// Filenames carry the UTF-8 general-purpose bit 11 (0x0800) in BOTH headers so non-ASCII names
// (Cyrillic/CJK/Hindi) decode correctly instead of mojibake-ing through a CP437 extractor.
// No ZIP64 in v1: an export that would overflow a 32-bit size/offset (>4 GiB) or the 16-bit entry
// count (>65535 files) throws ZipOverflowError — a LOUD honest refusal (caught by runFix → posted as
// fix-error), never a silently wrapped/corrupt archive.

/** Thrown when an export would overflow the 32-bit size/offset or 16-bit entry-count ZIP fields
 *  (no ZIP64 in v1). Caught by runFix → posted as fix-error (honest refusal, never silent corruption). */
export class ZipOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipOverflowError';
  }
}

const FLAG_UTF8 = 0x0800; // gp bit 11: filename is UTF-8
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const MSG = 'export exceeds ZIP limits (>4GB or >65535 files) — split the folder and export in parts';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** Assemble a store-only ZIP. May throw {@link ZipOverflowError} when the export would overflow a
 *  32-bit size/offset (>4 GiB) or the 16-bit entry count (>65535 files) — no ZIP64 in v1, so an
 *  oversized export is refused loudly rather than emitted corrupt (runFix catches → fix-error). */
export function makeZip(entries: ZipEntry[]): Blob {
  if (entries.length > U16_MAX) throw new ZipOverflowError(MSG);
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    // Guard size BEFORE crc32 + the .slice() copy below, so an oversized entry is refused without a
    // 4 GiB iteration/copy. offset guards the local-header position recorded into the central record.
    const size = e.bytes.length;
    if (size > U32_MAX) throw new ZipOverflowError(MSG);
    if (offset > U32_MAX) throw new ZipOverflowError(MSG);
    const crc = crc32(e.bytes);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, FLAG_UTF8, true); // gp bit 11: filename is UTF-8
    lh.setUint16(8, 0, true); // method 0 = store
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    parts.push(lh.buffer.slice(0), nameBytes.slice(), e.bytes.slice());

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, FLAG_UTF8, true); // gp bit 11: filename is UTF-8
    ch.setUint16(10, 0, true); // method
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer.slice(0), nameBytes.slice());
    offset += 30 + nameBytes.length + size;
  }

  if (offset > U32_MAX) throw new ZipOverflowError(MSG); // CD-start offset (catches an exact-4GiB last entry)
  const cdSize = central.reduce((s, p) => s + (p as ArrayBuffer | Uint8Array).byteLength, 0);
  if (cdSize > U32_MAX) throw new ZipOverflowError(MSG); // central-directory size
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd.buffer], { type: 'application/zip' });
}
