// Ingest grouping for AngelCode BMFont .fnt glyph sheets (TEXT, XML, and binary). groupFiles dispatches a
// `.fnt` by magic to the right parser (BMF\x03 → binary; leading `<` → XML; else TEXT), parses its page
// lines, resolves each page image dir-aware (the SAME resolve/keyOf/atlasName helpers the .atlas path uses),
// and routes it as GroupedAtlas.kind === 'bmfont'. A .fnt that THREW or parsed empty is surfaced honestly in
// unparsed[] (never silently dropped). A folder with no .fnt is byte-identical to today.

import { describe, it, expect } from 'vitest';
import { groupFiles, type RawFile } from '../src/index';

/** Encode a string into a fresh ArrayBuffer (RawFile.bytes). */
function buf(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}
/** A throwaway PNG-shaped buffer — groupFiles never decodes it, it only resolves + dedups the image. */
function pngBytes(): ArrayBuffer {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ab = new ArrayBuffer(sig.length);
  new Uint8Array(ab).set(sig);
  return ab;
}
const file = (path: string, bytes: ArrayBuffer): RawFile => ({ name: path.split('/').pop()!, path, bytes });

const FNT = (image: string): string => `info face="TestFont" size=32
common lineHeight=38 base=30 scaleW=256 scaleH=256 pages=1
page id=0 file="${image}"
char id=65 x=2 y=2 width=28 height=30 page=0
char id=66 x=40 y=2 width=24 height=30 page=0
kerning first=65 second=66 amount=-2
`;

/** XML BMFont declaring a single page image — dispatched to parseFntXml by the leading `<`. */
const XML = (image: string): string =>
  `<?xml version="1.0"?>\n<font>\n  <info face="TestFont" size="32"/>\n  <common lineHeight="38" base="30" scaleW="256" scaleH="256" pages="1"/>\n  <pages><page id="0" file="${image}"/></pages>\n  <char id="65" x="2" y="2" width="28" height="30" page="0"/>\n  <char id="66" x="40" y="2" width="24" height="30" page="0"/>\n</font>\n`;

/** Minimal AngelCode BMF v3 blob declaring `pages` + two glyphs — dispatched to parseFntBinary by magic.
 *  Same block layout parseFntBinary walks (header BMF+3; 1B type+4B LE size; info fontName@14; common
 *  lineHeight@0/scaleW@4/scaleH@6; pages uniform-stride NUL-terminated; char 20B id@0,x/y/w/h@4-10,page@18). */
function encodeBmfBinary(pages: string[]): ArrayBuffer {
  const enc = new TextEncoder();
  const block = (type: number, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(5 + body.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, body.length, true);
    out.set(body, 5);
    return out;
  };
  const faceBytes = enc.encode('TestFont');
  const infoBody = new Uint8Array(14 + faceBytes.length + 1);
  infoBody.set(faceBytes, 14);
  const commonBody = new Uint8Array(15);
  const cv = new DataView(commonBody.buffer);
  cv.setUint16(0, 38, true); // lineHeight
  cv.setUint16(4, 256, true); // scaleW
  cv.setUint16(6, 256, true); // scaleH
  const maxLen = pages.reduce((m, n) => Math.max(m, enc.encode(n).length), 0);
  const stride = maxLen + 1;
  const pagesBody = new Uint8Array(stride * pages.length);
  pages.forEach((n, i) => pagesBody.set(enc.encode(n), i * stride));
  const glyphs = [
    { id: 65, x: 2, y: 2, w: 28, h: 30 },
    { id: 66, x: 40, y: 2, w: 24, h: 30 },
  ];
  const charsBody = new Uint8Array(20 * glyphs.length);
  const chv = new DataView(charsBody.buffer);
  glyphs.forEach((g, i) => {
    const o = i * 20;
    chv.setUint32(o, g.id, true);
    chv.setUint16(o + 4, g.x, true);
    chv.setUint16(o + 6, g.y, true);
    chv.setUint16(o + 8, g.w, true);
    chv.setUint16(o + 10, g.h, true);
  });
  const blocks = [
    new Uint8Array([0x42, 0x4d, 0x46, 0x03]),
    block(1, infoBody),
    block(2, commonBody),
    block(3, pagesBody),
    block(4, charsBody),
  ];
  const total = blocks.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  const ab = new ArrayBuffer(out.byteLength);
  new Uint8Array(ab).set(out);
  return ab;
}

describe('groupFiles — BMFont .fnt', () => {
  it('groups a .fnt + its page PNG as one bmfont atlas; the PNG is referenced, not loose', () => {
    const grouped = groupFiles([file('font.fnt', buf(FNT('font.png'))), file('font.png', pngBytes())]);
    expect(grouped.atlases).toHaveLength(1);
    const a = grouped.atlases[0]!;
    expect(a.kind).toBe('bmfont');
    expect(a.name).toBe('font.png'); // basename (flat upload)
    expect(a.image.name).toBe('font.png');
    expect(grouped.images).toHaveLength(0); // the page image is referenced, not standalone
    expect(grouped.missing).toHaveLength(0);
    expect(grouped.unparsed).toHaveLength(0);
  });

  it('resolves the page image dir-aware (quoted relative file=)', () => {
    const grouped = groupFiles([
      file('fonts/font.fnt', buf(FNT('arial_0.png'))),
      file('fonts/arial_0.png', pngBytes()),
    ]);
    expect(grouped.atlases).toHaveLength(1);
    expect(grouped.atlases[0]!.kind).toBe('bmfont');
    expect(grouped.atlases[0]!.name).toBe('fonts/arial_0.png'); // dir-aware key (has a path)
    expect(grouped.images).toHaveLength(0);
  });

  it('a missing page image → grouped.missing (symmetric with .atlas)', () => {
    const grouped = groupFiles([file('font.fnt', buf(FNT('gone.png')))]);
    expect(grouped.atlases).toHaveLength(0);
    expect(grouped.missing).toEqual([{ manifest: 'font.fnt', image: 'gone.png' }]);
  });

  it('an XML .fnt + its page PNG groups as one bmfont atlas (dispatched by leading `<`)', () => {
    const grouped = groupFiles([file('font.fnt', buf(XML('font.png'))), file('font.png', pngBytes())]);
    expect(grouped.atlases).toHaveLength(1);
    const a = grouped.atlases[0]!;
    expect(a.kind).toBe('bmfont');
    expect(a.image.name).toBe('font.png');
    expect(grouped.images).toHaveLength(0); // the PNG is referenced, not loose
    expect(grouped.missing).toHaveLength(0);
    expect(grouped.unparsed).toHaveLength(0);
  });

  it('a binary BMFont .fnt (BMF\\x03 magic) + its page PNG groups as one bmfont atlas', () => {
    const grouped = groupFiles([
      { name: 'font.fnt', path: 'font.fnt', bytes: encodeBmfBinary(['font.png']) },
      file('font.png', pngBytes()),
    ]);
    expect(grouped.atlases).toHaveLength(1);
    const a = grouped.atlases[0]!;
    expect(a.kind).toBe('bmfont');
    expect(a.image.name).toBe('font.png'); // the binary page name resolved + the PNG referenced
    expect(grouped.images).toHaveLength(0);
    expect(grouped.missing).toHaveLength(0);
    expect(grouped.unparsed).toHaveLength(0);
  });

  it('a binary .fnt with no resolvable page image → grouped.missing (symmetric with .atlas/TEXT)', () => {
    const grouped = groupFiles([{ name: 'font.fnt', path: 'font.fnt', bytes: encodeBmfBinary(['gone.png']) }]);
    expect(grouped.atlases).toHaveLength(0);
    expect(grouped.missing).toEqual([{ manifest: 'font.fnt', image: 'gone.png' }]);
  });

  it('an empty / non-BMFont .fnt → unparsed[] with the no-page reason (incl. a junk binary BMF\\x03)', () => {
    const grouped = groupFiles([file('weird.fnt', buf('not a font at all'))]);
    expect(grouped.atlases).toHaveLength(0);
    expect(grouped.unparsed).toEqual([{ ref: 'weird.fnt', reason: 'BMFont .fnt has no page/char lines' }]);

    // a BMF\x03 header with no page/char blocks parses empty → honest unparsed (no silent drop).
    const junk = new Uint8Array([0x42, 0x4d, 0x46, 0x03]);
    const ab = new ArrayBuffer(junk.length);
    new Uint8Array(ab).set(junk);
    const g2 = groupFiles([{ name: 'b.fnt', path: 'b.fnt', bytes: ab }]);
    expect(g2.atlases).toHaveLength(0);
    expect(g2.unparsed).toEqual([{ ref: 'b.fnt', reason: 'BMFont .fnt has no page/char lines' }]);
  });

  it('no .fnt in the set ⇒ byte-identical grouping (regression)', () => {
    const files = [file('a.png', pngBytes()), file('b.png', pngBytes())];
    const grouped = groupFiles(files);
    expect(grouped.atlases).toHaveLength(0);
    expect(grouped.images.map((f) => f.name).sort()).toEqual(['a.png', 'b.png']);
    expect(grouped.unparsed).toHaveLength(0);
    expect(grouped.missing).toHaveLength(0);
  });
});
