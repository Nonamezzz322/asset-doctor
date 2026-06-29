// Parse AngelCode BMFont `.fnt` glyph sheets (TEXT format) into the normalized @asset-doctor/core Atlas
// model. One Atlas per page image (a multi-page font declares several `page` lines). Pure & defensive:
// the text parser never throws. Mirrors the Spine `.atlas` module EXACTLY (FntPage[] from parseFntText /
// ParseResult from parseFntPage; per-glyph recovery via `malformedGlyphs`, read by the worker like
// SpinePage.malformedRegions). TEXT format ONLY — XML (leading `<`) and binary (`BMF\x03`) `.fnt` are a
// DIFFERENT serialization the caller detects + surfaces as an honest unparsed error, never silently dropped.

import type { Atlas, ImageAsset, Size, Sprite } from '@asset-doctor/core';
import type { ParseResult } from './types';
import { readImageInfo } from './image-size';

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
// NaN so a REQUIRED field is flagged malformed instead of silently coerced to 0.
const num = (v: string | undefined): number => (v === undefined ? NaN : parseInt(v.trim(), 10));
const fin = (n: number): boolean => Number.isFinite(n);

/** Parse BMFont TEXT format → FntPage[] (one per `page` id, id-sorted ascending). Pure & defensive: never
 *  throws. Two-pass over lines so a `char` attaches to the page whose `id === char.page` regardless of line
 *  order (in real BMFont TEXT every `char` line follows ALL `page` lines, so a "most-recent page" rule would
 *  dump every glyph on the last page — WRONG). A whitespace glyph (width===0 && height===0, e.g. id=32) is a
 *  zero-area non-region: silently skipped from `sprites`, NOT an error. XML/binary `.fnt` are NOT this format
 *  (the caller detects + surfaces an honest unparsed error); a file with no page/char lines ⇒ []. */
export function parseFntText(text: string): FntPage[] {
  const lines = text.split(/\r?\n/);

  // Pass 1: headers (info / common / page). Build the page map keyed by page id.
  let face: string | undefined;
  let lineHeight: number | undefined;
  let commonSize: Size | undefined;
  const pageById = new Map<number, FntPage>();
  const order: PageHeader[] = [];

  for (const raw of lines) {
    const t = tokenize(raw);
    if (!t) continue;
    if (t.tag === 'info') {
      const f = t.pairs.get('face');
      if (f !== undefined && f !== '') face = f;
    } else if (t.tag === 'common') {
      const lh = num(t.pairs.get('lineHeight'));
      if (fin(lh)) lineHeight = lh;
      const sw = num(t.pairs.get('scaleW'));
      const sh = num(t.pairs.get('scaleH'));
      if (fin(sw) && fin(sh) && sw > 0 && sh > 0) commonSize = { w: sw, h: sh };
    } else if (t.tag === 'page') {
      const id = num(t.pairs.get('id'));
      if (!fin(id)) continue; // a page with no usable id can't be a glyph attachment target — skip it
      const image = t.pairs.get('file') ?? '';
      const page: FntPage = { image, sprites: [], kerningCount: 0 };
      pageById.set(id, page);
      order.push({ id, page });
    }
  }

  if (pageById.size === 0) return []; // no usable page lines → not a BMFont TEXT we can build pages from

  // Apply font-global headers to every page (face + lineHeight + common scaleW/scaleH are font-wide).
  for (const { page } of order) {
    if (face !== undefined) page.face = face;
    if (lineHeight !== undefined) page.lineHeight = lineHeight;
    if (commonSize) page.size = { ...commonSize };
  }

  // The first page by id (deterministic) — the fallback target for a glyph whose `page=` id is missing.
  const firstPage = [...pageById.entries()].sort((a, b) => a[0] - b[0])[0]![1];

  // Pass 2: chars (routed by page= id) + kerning (font-global count).
  let kerningCount = 0;
  for (const raw of lines) {
    const t = tokenize(raw);
    if (!t) continue;
    if (t.tag === 'kerning') {
      kerningCount++;
      continue;
    }
    if (t.tag !== 'char') continue;

    const id = num(t.pairs.get('id'));
    const idStr = fin(id) ? String(id) : (t.pairs.get('id')?.trim() ?? '');
    const pageId = num(t.pairs.get('page'));
    // Route to the page whose id === char.page; fall back to the first page when the id is missing/unknown
    // (recorded malformed). Single-page fonts (pages=1) make this the common, trivial case (page=0).
    const target = fin(pageId) ? pageById.get(pageId) : firstPage;

    const x = num(t.pairs.get('x'));
    const y = num(t.pairs.get('y'));
    const w = num(t.pairs.get('width'));
    const h = num(t.pairs.get('height'));

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
  for (const { page } of order) page.kerningCount = kerningCount;

  // Emit pages id-sorted (deterministic).
  return [...pageById.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
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
  const imageAsset: ImageAsset = {
    name: atlas.name,
    imageRef: image.ref,
    size: info.size,
    mime: info.mime,
    byteSize: image.bytes.byteLength,
  };
  return { ok: true, asset: { kind: 'atlas', atlas, image: imageAsset } };
}
