// Ingest grouping for AngelCode BMFont .fnt glyph sheets (TEXT format). groupFiles recognizes a `.fnt`,
// parses its page lines, resolves each page image dir-aware (the SAME resolve/keyOf/atlasName helpers the
// .atlas path uses), and routes it as GroupedAtlas.kind === 'bmfont'. XML/binary/empty .fnt are surfaced
// honestly in unparsed[] (never silently dropped). A folder with no .fnt is byte-identical to today.

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

  it('an XML .fnt is surfaced honestly in unparsed[] (never silent-dropped)', () => {
    const xml = `<?xml version="1.0"?>\n<font><pages><page id="0" file="font.png"/></pages></font>\n`;
    const grouped = groupFiles([file('font.fnt', buf(xml)), file('font.png', pngBytes())]);
    expect(grouped.atlases).toHaveLength(0);
    expect(grouped.unparsed).toEqual([
      { ref: 'font.fnt', reason: 'BMFont .fnt not in TEXT format (XML/binary unsupported in v1)' },
    ]);
    // the PNG was never referenced → it remains a loose image
    expect(grouped.images.map((f) => f.name)).toEqual(['font.png']);
  });

  it('a binary BMFont .fnt (BMF\\x03 magic) is surfaced honestly in unparsed[]', () => {
    const bin = new Uint8Array([0x42, 0x4d, 0x46, 0x03, 0x01, 0x00, 0x00, 0x00]); // 'BMF' + version 3
    const ab = new ArrayBuffer(bin.length);
    new Uint8Array(ab).set(bin);
    const grouped = groupFiles([{ name: 'font.fnt', path: 'font.fnt', bytes: ab }]);
    expect(grouped.atlases).toHaveLength(0);
    expect(grouped.unparsed).toEqual([
      { ref: 'font.fnt', reason: 'BMFont .fnt not in TEXT format (XML/binary unsupported in v1)' },
    ]);
  });

  it('an empty / non-BMFont .fnt → unparsed[] with the no-page reason', () => {
    const grouped = groupFiles([file('weird.fnt', buf('not a font at all'))]);
    expect(grouped.atlases).toHaveLength(0);
    expect(grouped.unparsed).toEqual([{ ref: 'weird.fnt', reason: 'BMFont .fnt has no page/char lines' }]);
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
