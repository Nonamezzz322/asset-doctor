// Parse AngelCode BMFont `.fnt` glyph sheets into the normalized @asset-doctor/core Atlas model. One Atlas
// per page image (a multi-page font declares several `page` lines). Pure & defensive: the parsers never
// throw. Mirrors the Spine `.atlas` module EXACTLY (FntPage[] from a parse function / ParseResult from
// parseFntPage; per-glyph recovery via `malformedGlyphs`, read by the worker like SpinePage.malformedRegions).
// ALL THREE serializations are supported and produce a BYTE-IDENTICAL FntPage[]: TEXT (parseFntText), XML
// (parseFntXml, leading `<`) and binary (parseFntBinary, `BMF\x03`). They share ONE recovery implementation —
// each is a thin front-end that builds a `RawFnt` then calls buildFntPages, so byte-identity is by construction.
// The caller (ingest) dispatches by magic; a `.fnt` that yields no pages is surfaced as an honest unparsed
// error, never silently dropped.

import type { Atlas, ImageAsset, Size, Sprite } from '@asset-doctor/core';
import type { ParseResult } from './types';
import { readImageInfo, strippableMetadataBytes } from './image-size';
import { iccAssetField } from './icc';

export interface FntPage {
  /** page `file` (surrounding quotes stripped). */
  image: string;
  /** common scaleW/scaleH when both finite & > 0, else undefined (parseFntPage falls back to the image header). */
  size?: Size;
  /** one Sprite per `char` whose `page=` id maps to THIS page (frame from x,y,width,height). */
  sprites: Sprite[];
  /** info `face` (quotes stripped) — font-global, copied onto every page; surfaced in the finding params. */
  face?: string;
  /** common `lineHeight` — a font metric, surfaced in params (NOT used for geometry). */
  lineHeight?: number;
  /** total `kerning` lines in the file (kerning is font-global, has no page id) — the kerning-present flag. */
  kerningCount: number;
  /** Glyphs on THIS page that named a `char` but were unusable (a required field — x/y/width/height — had a
   *  non-finite value, the glyph fell outside the page, or it referenced a missing page id). Per-glyph
   *  recovery: the page keeps its good glyphs; only the bad ones are surfaced. Additive: absent/empty ⇒
   *  byte-identical to today. Read by the worker exactly like SpinePage.malformedRegions. */
  malformedGlyphs?: { id: string; reason: string }[];
}

interface PageHeader {
  id: number;
  page: FntPage;
}

// Tokenize a BMFont TEXT line: the first whitespace-delimited token is the tag; the rest are key=value
// pairs whose value may be quoted (preserving spaces) or a bare/comma-list token. Quote-aware so
// `face="My Font"` keeps its space and a `file="fonts/arial_0.png"` keeps its path.
function tokenize(line: string): { tag: string; pairs: Map<string, string> } | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  // tag = leading run of non-space chars
  const sp = trimmed.search(/\s/);
  const tag = sp < 0 ? trimmed : trimmed.slice(0, sp);
  const rest = sp < 0 ? '' : trimmed.slice(sp);
  const pairs = new Map<string, string>();
  // Walk the rest, splitting on `key=value` while honoring quoted values.
  let i = 0;
  const n = rest.length;
  while (i < n) {
    while (i < n && /\s/.test(rest[i]!)) i++; // skip whitespace
    if (i >= n) break;
    // read key up to '='
    const eq = rest.indexOf('=', i);
    if (eq < 0) break; // malformed trailing token — ignore the remainder (forward-compat)
    const key = rest.slice(i, eq).trim();
    i = eq + 1;
    let value: string;
    if (i < n && rest[i] === '"') {
      // quoted value: consume through the closing quote
      const close = rest.indexOf('"', i + 1);
      if (close < 0) {
        value = rest.slice(i + 1); // unterminated quote — take the rest
        i = n;
      } else {
        value = rest.slice(i + 1, close);
        i = close + 1;
      }
    } else {
      // bare value: up to the next whitespace
      let j = i;
      while (j < n && !/\s/.test(rest[j]!)) j++;
      value = rest.slice(i, j);
      i = j;
    }
    if (key !== '') pairs.set(key, value);
  }
  return { tag, pairs };
}

// NaN-PRESERVING numeric read (matches the spine `numsRaw` discipline): a blank/garbage value reads as
// NaN so a REQUIRED field is flagged malformed instead of silently coerced to 0. Used by the STRING
// front-ends (TEXT/XML); the binary front-end emits already-numeric values (NaN for OOB reads).
const num = (v: string | undefined): number => (v === undefined ? NaN : parseInt(v.trim(), 10));
const fin = (n: number): boolean => Number.isFinite(n);

/** The serialization-agnostic intermediate the three front-ends (TEXT/XML/binary) build before handing off
 *  to buildFntPages — the SINGLE source of truth for the page-assembly + glyph-routing + recovery contract.
 *  Numeric char fields are NaN-PRESERVING (a missing/garbage value is NaN, so buildFntPages flags it
 *  malformed instead of coercing). `chars` preserves source order and `pages` preserves declaration order so
 *  the recovery push order + emit order are byte-identical regardless of which front-end produced the raw. */
export interface RawFnt {
  /** info `face` (already string-unwrapped/entity-decoded by the front-end), or undefined. */
  face?: string;
  /** common `lineHeight` (finite only), or undefined. */
  lineHeight?: number;
  /** common scaleW/scaleH as a Size when both finite and > 0, else undefined. */
  commonSize?: Size;
  /** declared pages in declaration order. `id` may be NaN (skipped by the builder, mirrors the TEXT rule). */
  pages: { id: number; image: string }[];
  /** chars in source order. Numeric fields are NaN-preserving; `idStr` is the surfaced id (recovery refs). */
  chars: { idStr: string; id: number; pageId: number; x: number; y: number; w: number; h: number }[];
  /** total `kerning` records (font-global; kerning has no page id) — the kerning-present flag. */
  kerningCount: number;
}

/** Assemble FntPage[] (one per page id, id-sorted ascending) from a RawFnt. Pure & defensive: never throws.
 *  THE single recovery implementation shared by parseFntText/parseFntXml/parseFntBinary — a malformed glyph
 *  surfaces identically (same page#id ref, same reason strings) regardless of serialization. A whitespace
 *  glyph (width===0 && height===0, e.g. id=32) is a zero-area non-region: silently skipped from `sprites`,
 *  NOT an error. A RawFnt with no usable page ⇒ []. */
export function buildFntPages(raw: RawFnt): FntPage[] {
  // Build the page map keyed by page id (declaration order preserved for header application + first-page).
  const pageById = new Map<number, FntPage>();
  const order: PageHeader[] = [];
  for (const p of raw.pages) {
    if (!fin(p.id)) continue; // a page with no usable id can't be a glyph attachment target — skip it
    const page: FntPage = { image: p.image, sprites: [], kerningCount: 0 };
    pageById.set(p.id, page);
    order.push({ id: p.id, page });
  }

  if (pageById.size === 0) return []; // no usable page lines → not a BMFont we can build pages from

  // Apply font-global headers to every page (face + lineHeight + common scaleW/scaleH are font-wide).
  for (const { page } of order) {
    if (raw.face !== undefined) page.face = raw.face;
    if (raw.lineHeight !== undefined) page.lineHeight = raw.lineHeight;
    if (raw.commonSize) page.size = { ...raw.commonSize };
  }

  // The first page by id (deterministic) — the fallback target for a glyph whose `page=` id is missing.
  const firstPage = [...pageById.entries()].sort((a, b) => a[0] - b[0])[0]![1];

  // Route chars by page= id (source order) + total kerning (font-global count).
  for (const c of raw.chars) {
    const { idStr, pageId, x, y, w, h } = c;
    // Route to the page whose id === char.page; fall back to the first page when the id is missing/unknown
    // (recorded malformed). Single-page fonts (pages=1) make this the common, trivial case (page=0).
    const target = fin(pageId) ? pageById.get(pageId) : firstPage;

    // Whitespace glyph (zero-area, e.g. id=32 space): not a packed region, NOT an error — skip silently.
    if (fin(w) && fin(h) && w === 0 && h === 0) continue;

    const dst = target ?? firstPage;

    if (!fin(pageId)) {
      // a char with no/garbage page id — still recoverable onto the first page, but surfaced.
      (dst.malformedGlyphs ??= []).push({ id: idStr, reason: `glyph id=${idStr}: missing/invalid page id` });
      continue;
    }
    if (!target) {
      (firstPage.malformedGlyphs ??= []).push({
        id: idStr,
        reason: `glyph id=${idStr}: references missing page ${pageId}`,
      });
      continue;
    }

    if (!fin(x) || !fin(y) || !fin(w) || !fin(h)) {
      const bad = !fin(x) ? 'x' : !fin(y) ? 'y' : !fin(w) ? 'width' : 'height';
      (dst.malformedGlyphs ??= []).push({ id: idStr, reason: `glyph id=${idStr}: non-finite ${bad}` });
      continue;
    }
    if (w <= 0 || h <= 0 || x < 0 || y < 0) {
      (dst.malformedGlyphs ??= []).push({ id: idStr, reason: `glyph id=${idStr}: degenerate rect ${x},${y},${w},${h}` });
      continue;
    }
    // OOB check when the page size is known: a glyph past the page edge is a corrupt sheet, not a sprite.
    if (dst.size && (x + w > dst.size.w || y + h > dst.size.h)) {
      (dst.malformedGlyphs ??= []).push({
        id: idStr,
        reason: `glyph id=${idStr} extends past page ${dst.size.w}×${dst.size.h}`,
      });
      continue;
    }

    const sprite: Sprite = {
      name: `glyph_${idStr}`,
      frame: { x, y, w, h },
      rotated: false, // BMFont has no glyph rotation
      trimmed: false, // xoffset/yoffset are layout-placement offsets, NOT in-page trim → occupancy stays honest
      sourceSize: { w, h },
    };
    dst.sprites.push(sprite);
  }

  // kerning is font-global (no page id) — attach the total to every page's count.
  for (const { page } of order) page.kerningCount = raw.kerningCount;

  // Emit pages id-sorted (deterministic).
  return [...pageById.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

/** Parse BMFont TEXT format → FntPage[] (one per `page` id, id-sorted ascending). Pure & defensive: never
 *  throws. Tokenizes lines into a RawFnt then defers to buildFntPages (the shared recovery core). In real
 *  BMFont TEXT every `char` line follows ALL `page` lines, so routing a `char` to the page whose
 *  `id === char.page` (NOT "most-recent page") is essential. A file with no page/char lines ⇒ []. */
export function parseFntText(text: string): FntPage[] {
  const lines = text.split(/\r?\n/);
  const raw: RawFnt = { pages: [], chars: [], kerningCount: 0 };

  for (const line of lines) {
    const t = tokenize(line);
    if (!t) continue;
    if (t.tag === 'info') {
      const f = t.pairs.get('face');
      if (f !== undefined && f !== '') raw.face = f;
    } else if (t.tag === 'common') {
      const lh = num(t.pairs.get('lineHeight'));
      if (fin(lh)) raw.lineHeight = lh;
      const sw = num(t.pairs.get('scaleW'));
      const sh = num(t.pairs.get('scaleH'));
      if (fin(sw) && fin(sh) && sw > 0 && sh > 0) raw.commonSize = { w: sw, h: sh };
    } else if (t.tag === 'page') {
      raw.pages.push({ id: num(t.pairs.get('id')), image: t.pairs.get('file') ?? '' });
    } else if (t.tag === 'kerning') {
      raw.kerningCount++;
    } else if (t.tag === 'char') {
      const id = num(t.pairs.get('id'));
      raw.chars.push({
        idStr: fin(id) ? String(id) : (t.pairs.get('id')?.trim() ?? ''),
        id,
        pageId: num(t.pairs.get('page')),
        x: num(t.pairs.get('x')),
        y: num(t.pairs.get('y')),
        w: num(t.pairs.get('width')),
        h: num(t.pairs.get('height')),
      });
    }
  }

  return buildFntPages(raw);
}

// Minimal XML entity decode for string-valued attrs (face/file) — BMFont emits none of these in practice,
// but a hand-authored / exporter-quirk XML may. The five predefined XML entities only (no numeric/DTD), in
// the same attribute-string spirit as the TEXT tokenizer (no DOM, no full entity expansion).
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Scan a tag body's `key="value"` / `key='value'` attributes into a Map (quote-aware, like the TEXT
// tokenizer's quoted branch; values are NOT comma-split). Bare (unquoted) values are also accepted for
// resilience. No DOM — a dependency-free, worker-safe attribute scanner.
function xmlAttrs(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s/>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = m[1]!;
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    if (key !== '') out.set(key, value);
  }
  return out;
}

/** Parse BMFont XML format → FntPage[] (byte-identical to parseFntText on the same font). Pure & defensive:
 *  never throws. A dependency-free, DOM-free, worker-safe attribute scanner over info/common/page/char/
 *  kerning tags — the SAME NaN-preserving num/fin discipline as TEXT, with a minimal entity decode on the
 *  string-valued attrs (face/file). The char attribute names are IDENTICAL to TEXT (id/x/y/width/height/
 *  page); only the `key="v"` wrapper differs. A document with no page/char tags ⇒ []. */
export function parseFntXml(text: string): FntPage[] {
  const raw: RawFnt = { pages: [], chars: [], kerningCount: 0 };
  // Iterate info/common/page/char/kerning tags in document order (self-closing or open form — attrs only).
  const tagRe = /<(info|common|page|char|kerning)\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const tag = m[1]!;
    const attrs = xmlAttrs(m[2] ?? '');
    if (tag === 'info') {
      const f = attrs.get('face');
      if (f !== undefined && f !== '') raw.face = decodeXmlEntities(f);
    } else if (tag === 'common') {
      const lh = num(attrs.get('lineHeight'));
      if (fin(lh)) raw.lineHeight = lh;
      const sw = num(attrs.get('scaleW'));
      const sh = num(attrs.get('scaleH'));
      if (fin(sw) && fin(sh) && sw > 0 && sh > 0) raw.commonSize = { w: sw, h: sh };
    } else if (tag === 'page') {
      const file = attrs.get('file');
      raw.pages.push({ id: num(attrs.get('id')), image: file !== undefined ? decodeXmlEntities(file) : '' });
    } else if (tag === 'kerning') {
      raw.kerningCount++;
    } else {
      // char
      const id = num(attrs.get('id'));
      raw.chars.push({
        idStr: fin(id) ? String(id) : (attrs.get('id')?.trim() ?? ''),
        id,
        pageId: num(attrs.get('page')),
        x: num(attrs.get('x')),
        y: num(attrs.get('y')),
        w: num(attrs.get('width')),
        h: num(attrs.get('height')),
      });
    }
  }
  return buildFntPages(raw);
}

// Read a NUL-terminated UTF-8 string from `data` over [start, end) (end exclusive, bounded to the block).
// Returns the decoded string (NUL excluded); if no NUL is found the whole window is decoded.
function readCString(data: Uint8Array, start: number, end: number): string {
  let nul = start;
  while (nul < end && data[nul] !== 0) nul++;
  return new TextDecoder('utf-8').decode(data.subarray(start, nul));
}

/** Parse BMFont BINARY format (AngelCode BMF v3) → FntPage[] (byte-identical to parseFntText on the same
 *  font). Pure & defensive: NEVER throws and NEVER reads out of bounds — the block walk stops on any short
 *  or OOB read and buildFntPages runs on whatever was collected. Requires the 4-byte magic `B`,`M`,`F`,3;
 *  anything else (too short / wrong magic / version != 3) ⇒ []. Blocks: 1 info, 2 common, 3 pages,
 *  4 chars, 5 kerning; an unknown type is skipped (forward-compat, mirrors the TEXT unknown-tag ignore). */
export function parseFntBinary(bytes: Uint8Array): FntPage[] {
  // Header: 'BMF' (66,77,70) + version byte 3. Bounds-safe (require >= 4 bytes) — else honestly unsupported.
  if (bytes.length < 4 || bytes[0] !== 66 || bytes[1] !== 77 || bytes[2] !== 70 || bytes[3] !== 3) return [];

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw: RawFnt = { pages: [], chars: [], kerningCount: 0 };
  const len = bytes.length;

  let off = 4; // walk from just past the 4-byte header
  while (off < len) {
    // Each block: 1B type + 4B LE uint size (size = body length, excludes the type+size header).
    if (off + 5 > len) break; // type byte + size field must be present
    const type = bytes[off]!;
    const size = view.getUint32(off + 1, true);
    const body = off + 5;
    if (body + size > len) break; // body must fit — STOP on truncation, build on what's collected
    const bodyEnd = body + size;

    if (type === 1) {
      // info: fontName is a NUL-terminated string at body offset 14 (after the fixed-size header fields).
      if (size > 14) raw.face = readCString(bytes, body + 14, bodyEnd) || undefined;
    } else if (type === 2) {
      // common: lineHeight u16@0, scaleW u16@4, scaleH u16@6 (need >= 8 bytes to read through @7).
      if (size >= 8) {
        raw.lineHeight = view.getUint16(body, true);
        const sw = view.getUint16(body + 4, true);
        const sh = view.getUint16(body + 6, true);
        if (sw > 0 && sh > 0) raw.commonSize = { w: sw, h: sh };
      }
    } else if (type === 3) {
      // pages: uniform-stride NUL-terminated names. stride n = (first NUL index)+1; count = size / n.
      // ids are IMPLICIT indices 0..p-1 (TEXT writes page id=N in index order — same emit ordering).
      let nul = body;
      while (nul < bodyEnd && bytes[nul] !== 0) nul++;
      const n = nul - body + 1; // include the terminating NUL in the stride
      if (n > 0 && nul < bodyEnd) {
        const count = Math.floor(size / n);
        for (let i = 0; i < count; i++) {
          const start = body + i * n;
          if (start + n > bodyEnd) break; // non-dividing tail — stop at body end, never OOB
          raw.pages.push({ id: i, image: readCString(bytes, start, start + n) });
        }
      }
    } else if (type === 4) {
      // chars: 20B records — id u32@0, x u16@4, y u16@6, width u16@8, height u16@10, page u8@18.
      const count = Math.floor(size / 20);
      for (let i = 0; i < count; i++) {
        const rec = body + i * 20;
        if (rec + 20 > bodyEnd) break; // never OOB on a non-dividing tail
        const id = view.getUint32(rec, true);
        raw.chars.push({
          idStr: String(id),
          id,
          pageId: bytes[rec + 18]!,
          x: view.getUint16(rec + 4, true),
          y: view.getUint16(rec + 6, true),
          w: view.getUint16(rec + 8, true),
          h: view.getUint16(rec + 10, true),
        });
      }
    } else if (type === 5) {
      // kerning: 10B records — only the count matters (font-global flag).
      raw.kerningCount += Math.floor(size / 10);
    }
    // unknown type → skip the body (size), continue (forward-compat).

    off = bodyEnd;
  }

  return buildFntPages(raw);
}

/** Build an atlas Asset from one parsed BMFont page + its page-image bytes. Mirror of parseSpinePage:
 *  errors are returned, never thrown. `size` falls back to the image header when the font declared no
 *  common scaleW/scaleH. `malformedGlyphs`/`face`/`kerningCount` are NOT forwarded through ParseResult
 *  (its shape is {ok;asset}|{ok;error}); the worker reads them off the FntPage, like SpinePage. */
export function parseFntPage(
  page: FntPage,
  image: { ref: string; bytes: Uint8Array },
  opts: { name?: string } = {},
): ParseResult {
  const info = readImageInfo(image.bytes);
  if (!info) return { ok: false, error: `bmfont page image unrecognized: ${image.ref}` };
  const atlas: Atlas = {
    name: opts.name ?? image.ref,
    imageRef: image.ref,
    size: page.size ?? info.size,
    sprites: page.sprites,
    source: { kind: 'bmfont' },
  };
  const strippable = strippableMetadataBytes(image.bytes);
  const icc = iccAssetField(image.bytes);
  const imageAsset: ImageAsset = {
    name: atlas.name,
    imageRef: image.ref,
    size: info.size,
    mime: info.mime,
    byteSize: image.bytes.byteLength,
    ...(strippable > 0 ? { strippableBytes: strippable } : {}),
    ...(icc ? { icc } : {}),
  };
  return { ok: true, asset: { kind: 'atlas', atlas, image: imageAsset } };
}
