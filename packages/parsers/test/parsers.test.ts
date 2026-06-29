import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseAtlas,
  parseAtlasManifest,
  parseImage,
  readImageInfo,
  strippableMetadataBytes,
  parseSpineAtlasText,
  parseFntText,
  parseFntXml,
  parseFntBinary,
  parseFntPage,
} from '../src/index';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sample-projects');
const json = (p: string): unknown => JSON.parse(readFileSync(join(FIXTURES, p), 'utf8'));
const bytes = (p: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, p)));

describe('parseAtlas — TexturePacker Hash', () => {
  const res = parseAtlas(json('tp-hash-symbols/symbols.json'), {
    ref: 'symbols.png',
    bytes: bytes('tp-hash-symbols/symbols.png'),
  });

  it('parses into a hash atlas with the right shape', () => {
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    const { atlas, image } = res.asset;
    expect(atlas.source.kind).toBe('texturepacker-hash');
    expect(atlas.size).toEqual({ w: 512, h: 512 });
    expect(atlas.sprites).toHaveLength(5);
    expect(image.mime).toBe('image/png');
    expect(image.size).toEqual({ w: 512, h: 512 });
    expect(image.byteSize).toBeGreaterThan(0);
  });

  it('preserves trim and rotation fidelity', () => {
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    const byName = (n: string) => res.asset.kind === 'atlas' && res.asset.atlas.sprites.find((s) => s.name === n);

    const trimmed = byName('sym_c.png');
    expect(trimmed && trimmed.trimmed).toBe(true);
    expect(trimmed && trimmed.sourceSize).toEqual({ w: 100, h: 140 });
    expect(trimmed && trimmed.spriteSourceSize).toEqual({ x: 10, y: 10, w: 80, h: 120 });

    const rotated = byName('sym_d.png');
    expect(rotated && rotated.rotated).toBe(true);
    expect(rotated && rotated.frame).toEqual({ x: 220, y: 0, w: 60, h: 90 });
    expect(rotated && rotated.sourceSize).toEqual({ w: 90, h: 60 });
  });
});

describe('parseAtlas — TexturePacker Array', () => {
  it('parses the array layout', () => {
    const res = parseAtlas(json('tp-array-oversize/sheet.json'), {
      ref: 'sheet.png',
      bytes: bytes('tp-array-oversize/sheet.png'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(res.asset.atlas.source.kind).toBe('texturepacker-array');
    expect(res.asset.atlas.sprites).toHaveLength(4);
    expect(res.asset.atlas.size).toEqual({ w: 4100, h: 1024 });
    expect(res.asset.atlas.sprites.map((s) => s.name)).toContain('tile_2.png');
  });
});

describe('parseAtlas — Pixi', () => {
  it('tags pixi when the TexturePacker meta.app signature is absent', () => {
    const res = parseAtlas(json('pixi-packed-ok/packed.json'), {
      ref: 'packed.png',
      bytes: bytes('pixi-packed-ok/packed.png'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(res.asset.atlas.source.kind).toBe('pixi');
    expect(res.asset.atlas.sprites).toHaveLength(4);
    expect(res.asset.atlas.size).toEqual({ w: 1024, h: 1024 });
  });
});

describe('parseAtlasManifest — multipack related_multi_packs (R28)', () => {
  const base = (rmp: unknown) => ({
    frames: { 'a.png': { frame: { x: 0, y: 0, w: 10, h: 10 } } },
    meta: { image: 'sheet-0.png', size: { w: 64, h: 64 }, related_multi_packs: rmp },
  });
  const parse = (rmp: unknown) => {
    const res = parseAtlasManifest(base(rmp));
    if (!res.ok) throw new Error(res.error);
    return res.atlas;
  };

  it('parses a single-entry related_multi_packs into relatedMultiPacks', () => {
    expect(parse(['sheet-1.json']).relatedMultiPacks).toEqual(['sheet-1.json']);
  });

  it('preserves multi-entry order (no sort — positional index is load-bearing)', () => {
    expect(parse(['a.json', 'b.json']).relatedMultiPacks).toEqual(['a.json', 'b.json']);
    // reverse-ordered input stays reverse-ordered
    expect(parse(['b.json', 'a.json']).relatedMultiPacks).toEqual(['b.json', 'a.json']);
  });

  it('absent ⇒ undefined (byte-identical)', () => {
    const res = parseAtlasManifest({
      frames: { 'a.png': { frame: { x: 0, y: 0, w: 10, h: 10 } } },
      meta: { image: 'sheet-0.png', size: { w: 64, h: 64 } },
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.atlas.relatedMultiPacks).toBeUndefined();
  });

  it('non-array (a bare string) ⇒ undefined', () => {
    expect(parse('sheet-1.json').relatedMultiPacks).toBeUndefined();
  });

  it('skips garbage entries (non-string / empty), keeps order', () => {
    expect(parse(['a.json', 3, '', 'b.json']).relatedMultiPacks).toEqual(['a.json', 'b.json']);
  });

  it('empty array ⇒ undefined (omit)', () => {
    expect(parse([]).relatedMultiPacks).toBeUndefined();
  });
});

describe('parseImage — single images', () => {
  it('reads PNG dimensions from the header', () => {
    const hero = parseImage('hero.png', bytes('single-images/hero.png'));
    expect(hero.ok).toBe(true);
    if (!hero.ok || hero.asset.kind !== 'image') throw new Error('expected image');
    expect(hero.asset.image.mime).toBe('image/png');
    expect(hero.asset.image.size).toEqual({ w: 2050, h: 2050 });

    const icon = parseImage('icon.png', bytes('single-images/icon.png'));
    if (!icon.ok || icon.asset.kind !== 'image') throw new Error('expected image');
    expect(icon.asset.image.size).toEqual({ w: 256, h: 256 });
  });
});

describe('readImageInfo — header readers', () => {
  it('reads a JPEG SOF0 frame size', () => {
    // FFD8 SOI, FFC0 SOF0, len 0011, precision 08, height 0064 (100), width 00C8 (200)
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(readImageInfo(jpeg)).toEqual({ mime: 'image/jpeg', size: { w: 200, h: 100 } });
  });

  it('reads a WebP VP8X canvas size', () => {
    const b = new Uint8Array(30);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    b.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
    b.set([0x2b, 0x01, 0x00], 24); // width-1 = 299 → 300
    b.set([0xc7, 0x00, 0x00], 27); // height-1 = 199 → 200
    expect(readImageInfo(b)).toEqual({ mime: 'image/webp', size: { w: 300, h: 200 } });
  });

  it('reads an AVIF canvas size from the ispe box', () => {
    // ftyp 'avif', then an ispe box with width 320 / height 240.
    const avif = new Uint8Array([
      0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, // ftyp 'avif'
      0x00, 0x00, 0x00, 0x14, 0x69, 0x73, 0x70, 0x65, 0x00, 0x00, 0x00, 0x00, // ispe + version/flags
      0x00, 0x00, 0x01, 0x40, 0x00, 0x00, 0x00, 0xf0, // width 320, height 240
    ]);
    expect(readImageInfo(avif)).toEqual({ mime: 'image/avif', size: { w: 320, h: 240 } });
  });

  it('returns null for unrecognized bytes', () => {
    expect(readImageInfo(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

// ── Test A: strippableMetadataBytes — pure header walk (no decode). Inline byte arrays in the style of the
// readImageInfo header tests (:88-119): hand-build a minimal valid header + an injected known-length chunk and
// assert the EXACT counted byte total. The counted allow-set is a conservative TRUE LOWER BOUND of what the fix
// strips (see fixtures/sample-projects/strippable-metadata/README.md, Test D).
describe('strippableMetadataBytes — strippable ancillary metadata', () => {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  // A PNG chunk = [len:u32be][type:4][data:len][crc:4] ⇒ on disk = len + 12. The CRC bytes are not validated
  // by the pure walk (it never decodes), so any 4 filler bytes stand in.
  const pngChunk = (type: string, dataLen: number): number[] => [
    ...u32be(dataLen), ...ascii(type), ...new Array(dataLen).fill(0x41), 0, 0, 0, 0,
  ];
  // Minimal valid PNG: SIG + IHDR + the injected chunks + IEND. IHDR data = width:u32be height:u32be then
  // 5 bytes (bitdepth/colortype/compress/filter/interlace) — set 64×64 so readImageInfo accepts the header.
  const IHDR = [...u32be(13), ...ascii('IHDR'), ...u32be(64), ...u32be(64), 8, 6, 0, 0, 0, 0, 0, 0, 0];
  const IEND = [...u32be(0), ...ascii('IEND'), 0, 0, 0, 0];
  const png = (...chunks: number[][]): Uint8Array =>
    new Uint8Array([...PNG_SIG, ...IHDR, ...chunks.flat(), ...IEND]);

  it('counts PNG tEXt + iCCP at len + 12 each, stops at IEND', () => {
    // tEXt data 100 ⇒ 112; iCCP data 5000 ⇒ 5012. Total 5124.
    expect(strippableMetadataBytes(png(pngChunk('tEXt', 100), pngChunk('iCCP', 5000)))).toBe(112 + 5012);
  });

  it('does NOT count PNG tRNS (functional transparency) or pHYs (rendering)', () => {
    // tRNS data 6 + pHYs data 9 — both excluded ⇒ 0 strippable.
    expect(strippableMetadataBytes(png(pngChunk('tRNS', 6), pngChunk('pHYs', 9)))).toBe(0);
  });

  it('counts the full allow-set {iCCP,eXIf,tEXt,iTXt,zTXt,tIME} and nothing else', () => {
    const allow = png(
      pngChunk('iCCP', 10), pngChunk('eXIf', 10), pngChunk('tEXt', 10),
      pngChunk('iTXt', 10), pngChunk('zTXt', 10), pngChunk('tIME', 10),
      pngChunk('tRNS', 10), pngChunk('gAMA', 10), pngChunk('sRGB', 10), // excluded
    );
    expect(strippableMetadataBytes(allow)).toBe(6 * (10 + 12));
  });

  it('PNG truncated chunk length ⇒ bails to the accumulated partial (never throws / OOB)', () => {
    // One countable tEXt (112), then a chunk claiming a huge length that overruns the buffer ⇒ stop, keep 112.
    const good = pngChunk('tEXt', 50); // 50 + 12 = 62
    const truncated = [...u32be(99999), ...ascii('iTXt'), 0x41, 0x41]; // claims 99999 data, only 2 bytes follow
    const buf = new Uint8Array([...PNG_SIG, ...IHDR, ...good, ...truncated]);
    expect(strippableMetadataBytes(buf)).toBe(62);
  });

  it('counts JPEG APP1 (2 + len), EXCLUDES APP0, stops at SOS', () => {
    // FFD8 SOI; FFE0 APP0 len 16 (JFIF, excluded); FFE1 APP1 len 100 (EXIF, counted = 102); FFDA SOS (stop);
    // then an FFE1 AFTER the scan must NOT be counted.
    const u16be = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
    const seg = (marker: number, len: number): number[] => [0xff, marker, ...u16be(len), ...new Array(len - 2).fill(0x00)];
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      ...seg(0xe0, 16), // APP0 JFIF — excluded
      ...seg(0xe1, 100), // APP1 EXIF — counted (2 + 100 = 102)
      ...seg(0xda, 12), // SOS — stop here
      ...seg(0xe1, 500), // post-scan APP1 — must NOT be counted
    ]);
    expect(strippableMetadataBytes(jpeg)).toBe(102);
  });

  it('counts WebP VP8X EXIF chunk at size + 8; a simple VP8 file ⇒ 0', () => {
    const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    // RIFF [size] WEBP VP8X[10] EXIF[40] — the EXIF chunk counts 40 + 8 = 48.
    const vp8xBody = [
      ...ascii('VP8X'), ...u32le(10), ...new Array(10).fill(0x00),
      ...ascii('EXIF'), ...u32le(40), ...new Array(40).fill(0x00),
    ];
    const webp = new Uint8Array([
      ...ascii('RIFF'), ...u32le(4 + vp8xBody.length), ...ascii('WEBP'), ...vp8xBody,
    ]);
    expect(strippableMetadataBytes(webp)).toBe(48);

    // Simple lossy VP8 (not VP8X) carries no ancillary chunks ⇒ 0.
    const vp8 = new Uint8Array([
      ...ascii('RIFF'), ...u32le(20), ...ascii('WEBP'), ...ascii('VP8 '), ...u32le(12), ...new Array(12).fill(0x00),
    ]);
    expect(strippableMetadataBytes(vp8)).toBe(0);
  });

  it('AVIF / unrecognized ⇒ 0', () => {
    const avif = new Uint8Array([
      0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, // ftyp 'avif'
    ]);
    expect(strippableMetadataBytes(avif)).toBe(0);
    expect(strippableMetadataBytes(new Uint8Array([1, 2, 3, 4]))).toBe(0);
    expect(strippableMetadataBytes(new Uint8Array(0))).toBe(0);
  });

  it('parseImage plumbs strippableBytes onto the ImageAsset (omit-when-zero)', () => {
    const withMeta = png(pngChunk('iCCP', 3000)); // 3012 strippable
    const r = parseImage('meta.png', withMeta);
    if (!r.ok || r.asset.kind !== 'image') throw new Error('expected image');
    expect(r.asset.image.strippableBytes).toBe(3012);

    const clean = png(pngChunk('tRNS', 6)); // nothing countable ⇒ field omitted
    const r2 = parseImage('clean.png', clean);
    if (!r2.ok || r2.asset.kind !== 'image') throw new Error('expected image');
    expect(r2.asset.image.strippableBytes).toBeUndefined();
  });

  it('hand-authored on-disk fixture: metadata.png ⇒ strippableBytes === 8347 (matches expected.json)', () => {
    const r = parseImage('metadata.png', bytes('strippable-metadata/metadata.png'));
    if (!r.ok || r.asset.kind !== 'image') throw new Error('expected image');
    const expected = json('strippable-metadata/expected.json') as { images: { strippableBytes: number }[] };
    expect(r.asset.image.strippableBytes).toBe(expected.images[0]!.strippableBytes);
    expect(r.asset.image.strippableBytes).toBe(8347);
    expect(r.asset.image.size).toEqual({ w: 4, h: 4 }); // a real, valid PNG (header decodes)
  });
});

describe('parseSpineAtlasText — Spine .atlas', () => {
  const ATLAS = `sheet.png
size: 256,256
format: RGBA8888
filter: Linear,Linear
repeat: none
regionA
  rotate: 0
  xy: 0, 0
  size: 100, 80
  orig: 100, 80
  offset: 0, 0
  index: -1
regionB
  rotate: 90
  xy: 110, 0
  size: 60, 40
  orig: 80, 50
  offset: 0, 0
  index: -1
`;

  it('parses page header + regions, handling rotation and trim', () => {
    const pages = parseSpineAtlasText(ATLAS);
    expect(pages).toHaveLength(1);
    const p = pages[0]!;
    expect(p.image).toBe('sheet.png');
    expect(p.size).toEqual({ w: 256, h: 256 });
    expect(p.sprites).toHaveLength(2);

    const a = p.sprites.find((s) => s.name === 'regionA')!;
    expect(a.rotated).toBe(false);
    expect(a.frame).toEqual({ x: 0, y: 0, w: 100, h: 80 });
    expect(a.trimmed).toBe(false);

    const b = p.sprites.find((s) => s.name === 'regionB')!;
    expect(b.rotated).toBe(true);
    expect(b.frame).toEqual({ x: 110, y: 0, w: 40, h: 60 }); // size 60×40 placed rotated → 40×60
    expect(b.trimmed).toBe(true);
    expect(b.sourceSize).toEqual({ w: 80, h: 50 });
  });

  it('parses multiple pages', () => {
    const multi =
      ATLAS +
      `\nsheet2.png\nsize: 64,64\nformat: RGBA8888\nrgn\n  rotate: 0\n  xy: 0,0\n  size: 10,10\n  orig: 10,10\n  index: -1\n`;
    const pages = parseSpineAtlasText(multi);
    expect(pages).toHaveLength(2);
    expect(pages[1]!.image).toBe('sheet2.png');
    expect(pages[1]!.size).toEqual({ w: 64, h: 64 });
    expect(pages[1]!.sprites).toHaveLength(1);
  });
});

describe('parseFntText — BMFont TEXT', () => {
  const FNT = `info face="TestFont" size=32 bold=0 padding=2,2,2,2
common lineHeight=38 base=30 scaleW=256 scaleH=256 pages=1
page id=0 file="font.png"
chars count=3
char id=65 x=2 y=2 width=28 height=30 xoffset=0 yoffset=4 xadvance=30 page=0 chnl=15
char id=66 x=40 y=2 width=24 height=30 xoffset=1 yoffset=4 xadvance=26 page=0 chnl=15
char id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=10 page=0 chnl=15
kerning first=65 second=86 amount=-2
kerning first=65 second=87 amount=-1
`;

  it('parses info/common/page/char/kerning into one page', () => {
    const pages = parseFntText(FNT);
    expect(pages).toHaveLength(1);
    const p = pages[0]!;
    expect(p.image).toBe('font.png');
    expect(p.face).toBe('TestFont');
    expect(p.lineHeight).toBe(38);
    expect(p.size).toEqual({ w: 256, h: 256 });
    expect(p.kerningCount).toBe(2);
    // the space glyph (width=0 height=0) is skipped — only A + B are real packed regions
    expect(p.sprites.map((s) => s.name)).toEqual(['glyph_65', 'glyph_66']);
    const a = p.sprites.find((s) => s.name === 'glyph_65')!;
    expect(a.frame).toEqual({ x: 2, y: 2, w: 28, h: 30 });
    expect(a.rotated).toBe(false);
    expect(a.trimmed).toBe(false);
    expect(a.sourceSize).toEqual({ w: 28, h: 30 });
    expect(p.malformedGlyphs).toBeUndefined();
  });

  it('quote-aware face= preserves embedded spaces', () => {
    const p = parseFntText(`info face="My Font"\ncommon scaleW=64 scaleH=64 pages=1\npage id=0 file="f.png"\nchar id=65 x=0 y=0 width=10 height=10 page=0\n`)[0]!;
    expect(p.face).toBe('My Font');
  });

  it('non-finite required field drops the glyph + surfaces the exact reason; page keeps the good ones', () => {
    const fnt = `common scaleW=128 scaleH=128 pages=1
page id=0 file="f.png"
char id=65 x=0 y=0 width=20 height=20 page=0
char id=66 x= y=0 width=20 height=20 page=0
`;
    const p = parseFntText(fnt)[0]!;
    expect(p.sprites.map((s) => s.name)).toEqual(['glyph_65']);
    expect(p.malformedGlyphs).toEqual([{ id: '66', reason: 'glyph id=66: non-finite x' }]);
  });

  it('OOB glyph past scaleW/scaleH is dropped + surfaced; the page keeps good glyphs', () => {
    const fnt = `common scaleW=64 scaleH=64 pages=1
page id=0 file="f.png"
char id=65 x=0 y=0 width=32 height=32 page=0
char id=66 x=40 y=0 width=40 height=10 page=0
`;
    const p = parseFntText(fnt)[0]!;
    expect(p.sprites.map((s) => s.name)).toEqual(['glyph_65']);
    expect(p.malformedGlyphs).toEqual([{ id: '66', reason: 'glyph id=66 extends past page 64×64' }]);
  });

  it('multi-page: each char attaches to the page whose id === char.page (NOT most-recent page)', () => {
    // ALL char lines follow ALL page lines (the real BMFont TEXT order). Interleave page= ids so a
    // "most-recent page" rule would mis-attach: every glyph would land on the LAST page (id=1).
    const fnt = `common lineHeight=20 scaleW=128 scaleH=128 pages=2
page id=0 file="p0.png"
page id=1 file="p1.png"
char id=65 x=0 y=0 width=10 height=10 page=1
char id=66 x=0 y=0 width=10 height=10 page=0
char id=67 x=20 y=0 width=10 height=10 page=1
char id=68 x=20 y=0 width=10 height=10 page=0
`;
    const pages = parseFntText(fnt);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.image).toBe('p0.png'); // id-sorted output
    expect(pages[1]!.image).toBe('p1.png');
    expect(pages[0]!.sprites.map((s) => s.name)).toEqual(['glyph_66', 'glyph_68']); // page=0 glyphs only
    expect(pages[1]!.sprites.map((s) => s.name)).toEqual(['glyph_65', 'glyph_67']); // page=1 glyphs only
  });

  it('a char referencing a missing page id is dropped + surfaced (kept off the first page)', () => {
    const fnt = `common scaleW=64 scaleH=64 pages=1
page id=0 file="p0.png"
char id=65 x=0 y=0 width=10 height=10 page=0
char id=66 x=0 y=0 width=10 height=10 page=9
`;
    const pages = parseFntText(fnt);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.sprites.map((s) => s.name)).toEqual(['glyph_65']);
    expect(pages[0]!.malformedGlyphs).toEqual([{ id: '66', reason: 'glyph id=66: references missing page 9' }]);
  });

  it('returns [] for input with no page/char lines (caller surfaces unparsed)', () => {
    expect(parseFntText('this is not a font')).toEqual([]);
    expect(parseFntText('')).toEqual([]);
  });

  it('parseFntPage builds a bmfont Atlas with size/imageRef/sprites; bad image bytes → {ok:false}', () => {
    const page = parseFntText(FNT)[0]!;
    const good = parseFntPage(page, { ref: 'font.png', bytes: bytes('pixi-packed-ok/packed.png') }, { name: 'fonts/font.png' });
    expect(good.ok).toBe(true);
    if (!good.ok || good.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(good.asset.atlas.source.kind).toBe('bmfont');
    expect(good.asset.atlas.name).toBe('fonts/font.png');
    expect(good.asset.atlas.size).toEqual({ w: 256, h: 256 }); // common scaleW/scaleH wins
    expect(good.asset.atlas.sprites).toHaveLength(2);

    const bad = parseFntPage(page, { ref: 'font.png', bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/bmfont page image unrecognized/);
  });

  it('parseFntPage falls back to the image header size when no common scaleW/scaleH', () => {
    const page = parseFntText(`info face="F"\npage id=0 file="f.png"\nchar id=65 x=0 y=0 width=10 height=10 page=0\n`)[0]!;
    expect(page.size).toBeUndefined();
    const res = parseFntPage(page, { ref: 'f.png', bytes: bytes('pixi-packed-ok/packed.png') });
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(res.asset.atlas.size).toEqual({ w: 1024, h: 1024 }); // from the PNG header
  });
});

// Minimal AngelCode BMF v3 encoder — the SAME block layout parseFntBinary walks (header `BMF`+3; blocks
// 1B type + 4B LE size; info fontName NUL-terminated @14; common lineHeight@0/base@2/scaleW@4/scaleH@6;
// pages uniform-stride NUL-terminated; char 20B id u32@0,x/y/w/h u16@4-10,page u8@18; kerning 10B). Used to
// prove binary parity (encode the SAME font the TEXT const declares → parseFntBinary === parseFntText).
function encodeBmfBinary(opts: {
  face: string;
  lineHeight: number;
  base: number;
  scaleW: number;
  scaleH: number;
  pages: string[];
  chars: { id: number; x: number; y: number; w: number; h: number; page: number }[];
  kerningCount: number;
}): Uint8Array {
  const enc = new TextEncoder();
  const block = (type: number, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(5 + body.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, body.length, true);
    out.set(body, 5);
    return out;
  };
  // info: 14 fixed bytes + fontName + NUL (only fontName@14 is read back).
  const faceBytes = enc.encode(opts.face);
  const infoBody = new Uint8Array(14 + faceBytes.length + 1);
  infoBody.set(faceBytes, 14);
  // common: 15-byte block (lineHeight/base/scaleW/scaleH).
  const commonBody = new Uint8Array(15);
  const cv = new DataView(commonBody.buffer);
  cv.setUint16(0, opts.lineHeight, true);
  cv.setUint16(2, opts.base, true);
  cv.setUint16(4, opts.scaleW, true);
  cv.setUint16(6, opts.scaleH, true);
  // pages: uniform-stride NUL-terminated names.
  const maxLen = opts.pages.reduce((m, n) => Math.max(m, enc.encode(n).length), 0);
  const stride = maxLen + 1;
  const pagesBody = new Uint8Array(stride * opts.pages.length);
  opts.pages.forEach((n, i) => pagesBody.set(enc.encode(n), i * stride));
  // chars: 20-byte records.
  const charsBody = new Uint8Array(20 * opts.chars.length);
  const chv = new DataView(charsBody.buffer);
  opts.chars.forEach((c, i) => {
    const o = i * 20;
    chv.setUint32(o, c.id, true);
    chv.setUint16(o + 4, c.x, true);
    chv.setUint16(o + 6, c.y, true);
    chv.setUint16(o + 8, c.w, true);
    chv.setUint16(o + 10, c.h, true);
    charsBody[o + 18] = c.page & 0xff;
  });
  const kerningBody = new Uint8Array(10 * opts.kerningCount);
  const blocks = [
    new Uint8Array([0x42, 0x4d, 0x46, 0x03]),
    block(1, infoBody),
    block(2, commonBody),
    block(3, pagesBody),
    block(4, charsBody),
    block(5, kerningBody),
  ];
  const total = blocks.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

describe('parseFntXml / parseFntBinary — XML + binary parity with TEXT', () => {
  // The reference TEXT font: info/common/page then real glyphs + a whitespace glyph (id=32, 0×0, skipped)
  // + 2 kerning lines. Parity is asserted byte-for-byte on the full FntPage[] (cheap + exact).
  const FNT = `info face="TestFont" size=32 bold=0 padding=2,2,2,2
common lineHeight=38 base=30 scaleW=256 scaleH=256 pages=1
page id=0 file="font.png"
chars count=3
char id=65 x=2 y=2 width=28 height=30 xoffset=0 yoffset=4 xadvance=30 page=0 chnl=15
char id=66 x=40 y=2 width=24 height=30 xoffset=1 yoffset=4 xadvance=26 page=0 chnl=15
char id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=10 page=0 chnl=15
kerning first=65 second=86 amount=-2
kerning first=65 second=87 amount=-1
`;

  it('XML parity — the XML form parses byte-identical to the TEXT form', () => {
    const XML = `<?xml version="1.0"?>
<font>
  <info face="TestFont" size="32" bold="0" padding="2,2,2,2"/>
  <common lineHeight="38" base="30" scaleW="256" scaleH="256" pages="1"/>
  <pages><page id="0" file="font.png"/></pages>
  <chars count="3">
    <char id="65" x="2" y="2" width="28" height="30" xoffset="0" yoffset="4" xadvance="30" page="0" chnl="15"/>
    <char id="66" x="40" y="2" width="24" height="30" xoffset="1" yoffset="4" xadvance="26" page="0" chnl="15"/>
    <char id="32" x="0" y="0" width="0" height="0" xoffset="0" yoffset="0" xadvance="10" page="0" chnl="15"/>
  </chars>
  <kerning first="65" second="86" amount="-2"/>
  <kerning first="65" second="87" amount="-1"/>
</font>
`;
    expect(parseFntXml(XML)).toEqual(parseFntText(FNT));
  });

  it('binary parity — encodeBmfBinary of the same font parses byte-identical to TEXT (whitespace skip, kerning)', () => {
    const bin = encodeBmfBinary({
      face: 'TestFont',
      lineHeight: 38,
      base: 30,
      scaleW: 256,
      scaleH: 256,
      pages: ['font.png'],
      chars: [
        { id: 65, x: 2, y: 2, w: 28, h: 30, page: 0 },
        { id: 66, x: 40, y: 2, w: 24, h: 30, page: 0 },
        { id: 32, x: 0, y: 0, w: 0, h: 0, page: 0 }, // whitespace → skipped
      ],
      kerningCount: 2,
    });
    const pages = parseFntBinary(bin);
    expect(pages).toEqual(parseFntText(FNT));
    expect(pages[0]!.sprites.map((s) => s.name)).toEqual(['glyph_65', 'glyph_66']); // space skipped
    expect(pages[0]!.kerningCount).toBe(2);
  });

  it('binary recovery fires — an OOB glyph lands in malformedGlyphs with the SAME reason TEXT produces', () => {
    const bin = encodeBmfBinary({
      face: 'F',
      lineHeight: 10,
      base: 8,
      scaleW: 64,
      scaleH: 64,
      pages: ['p.png'],
      chars: [
        { id: 65, x: 0, y: 0, w: 32, h: 32, page: 0 },
        { id: 66, x: 40, y: 0, w: 40, h: 10, page: 0 }, // x+w=80 > 64 → OOB
      ],
      kerningCount: 0,
    });
    const p = parseFntBinary(bin)[0]!;
    expect(p.sprites.map((s) => s.name)).toEqual(['glyph_65']);
    expect(p.malformedGlyphs).toEqual([{ id: '66', reason: 'glyph id=66 extends past page 64×64' }]);
  });

  it('XML quote/entity — single-quoted face with an &amp; entity decodes to the literal &', () => {
    const xml = `<font><info face='My &amp; Co'/><common scaleW="64" scaleH="64" pages="1"/><page id="0" file="f.png"/><char id="65" x="0" y="0" width="10" height="10" page="0"/></font>`;
    expect(parseFntXml(xml)[0]!.face).toBe('My & Co');
  });

  it('binary defensive — non-/20 chars body + a truncated tail: glyphs read so far, never throws; BMF\\x02 ⇒ []', () => {
    // Hand-build: header + a pages block + a chars block whose declared size is NOT a multiple of 20 (one
    // whole record + a 10-byte tail) AND the file is then cut so the declared chars size runs past EOF on a
    // SECOND block — the walk must read the first whole char, then STOP on the short read, never OOB-throw.
    const le32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
    const pagesBody = [...new TextEncoder().encode('p.png'), 0]; // stride 6, one page
    const char = (id: number, x: number, y: number, w: number, h: number, page: number): number[] => {
      const b = new Uint8Array(20);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, id, true);
      dv.setUint16(4, x, true);
      dv.setUint16(6, y, true);
      dv.setUint16(8, w, true);
      dv.setUint16(10, h, true);
      b[18] = page;
      return [...b];
    };
    // common block so the page size (64×64) is known.
    const commonBody = new Uint8Array(15);
    new DataView(commonBody.buffer).setUint16(0, 10, true); // lineHeight
    new DataView(commonBody.buffer).setUint16(4, 64, true); // scaleW
    new DataView(commonBody.buffer).setUint16(6, 64, true); // scaleH
    const charsBody = [...char(65, 0, 0, 10, 10, 0), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // 30 bytes → floor=1
    const bytes = new Uint8Array([
      0x42, 0x4d, 0x46, 0x03, // BMF v3
      2, ...le32(15), ...commonBody, // common
      3, ...le32(pagesBody.length), ...pagesBody, // pages
      4, ...le32(charsBody.length), ...charsBody, // chars (30B → 1 whole record + 10B tail)
      5, ...le32(40), // kerning header CLAIMS 40 bytes of body that aren't there → short read → STOP
    ]);
    expect(() => parseFntBinary(bytes)).not.toThrow();
    const p = parseFntBinary(bytes)[0]!;
    expect(p.sprites.map((s) => s.name)).toEqual(['glyph_65']); // the one whole char survived; tail ignored
    expect(p.kerningCount).toBe(0); // the truncated kerning block was never counted

    // Wrong version byte (v2) is honestly unsupported; too short for the magic ⇒ [].
    expect(parseFntBinary(new Uint8Array([0x42, 0x4d, 0x46, 0x02, 0, 0, 0, 0]))).toEqual([]);
    expect(parseFntBinary(new Uint8Array([0x42, 0x4d]))).toEqual([]);
  });

  it('XML defensive — a font with no page/char tags ⇒ []', () => {
    expect(parseFntXml('<font><info face="x"/></font>')).toEqual([]);
    expect(parseFntXml('not xml at all')).toEqual([]);
  });
});

describe('parser hardening — corrupt input is rejected, not coerced (F3)', () => {
  // A 1024×1024 fixture image to anchor the atlas/page size for OOB tests.
  const img1024 = () => ({ ref: 'packed.png', bytes: bytes('pixi-packed-ok/packed.png') });

  it('readRect: a 0×0 / negative frame is rejected (invalid frame error)', () => {
    const manifest = {
      frames: { 'bad.png': { frame: { x: 0, y: 0, w: 0, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 0, h: 32 } } },
      meta: { image: 'packed.png', size: { w: 1024, h: 1024 } },
    };
    const res = parseAtlas(manifest, img1024());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid frame "bad.png"/);
  });

  it('atlas OOB: a frame past the page edge is rejected; flush at the edge is allowed', () => {
    const oob = {
      frames: { 'over.png': { frame: { x: 1000, y: 0, w: 100, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 100, h: 32 } } },
      meta: { image: 'packed.png', size: { w: 1024, h: 1024 } },
    };
    const r1 = parseAtlas(oob, img1024());
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/extends past atlas 1024×1024/);

    // x+w === size.w is allowed (`>`, not `>=`).
    const edge = {
      frames: { 'edge.png': { frame: { x: 1024 - 64, y: 0, w: 64, h: 32 }, rotated: false, trimmed: false, sourceSize: { w: 64, h: 32 } } },
      meta: { image: 'packed.png', size: { w: 1024, h: 1024 } },
    };
    const r2 = parseAtlas(edge, img1024());
    expect(r2.ok).toBe(true);
  });

  it('readImageInfo: a 0×0 / absurd PNG header reads as null (validDims)', () => {
    // PNG sig + IHDR with width 0 → invalid.
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    // width@16 = 0, height@20 = 100
    png[20] = 0x00; png[21] = 0x00; png[22] = 0x00; png[23] = 0x64;
    expect(readImageInfo(png)).toBeNull();

    // width > MAX_DIM (32768) → invalid.
    const huge = new Uint8Array(24);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    huge[16] = 0x00; huge[17] = 0x01; huge[18] = 0x00; huge[19] = 0x00; // width 65536
    huge[20] = 0x00; huge[21] = 0x00; huge[22] = 0x00; huge[23] = 0x64; // height 100
    expect(readImageInfo(huge)).toBeNull();
  });

  it('spine fixed-arity NaN parse: a blank coord token flags the region malformed (no coord shift)', () => {
    // Old `.filter(Number.isFinite)` turned `xy: , 100` into [100] → {x:100,y:0} (silent misplacement).
    const atlas = `sheet.png
size: 256,256
good
  rotate: 0
  xy: 0, 0
  size: 50, 50
  orig: 50, 50
bad
  rotate: 0
  xy: , 100
  size: 50, 50
  orig: 50, 50
`;
    const pages = parseSpineAtlasText(atlas);
    const p = pages[0]!;
    expect(p.sprites.map((s) => s.name)).toEqual(['good']); // bad region NOT silently placed at x:100
    expect(p.malformedRegions).toEqual([{ name: 'bad', reason: 'region "bad": non-finite xy ", 100"' }]);
  });

  it('spine per-region OOB recovery: an out-of-page region is dropped + surfaced; the page keeps good ones', () => {
    const atlas = `sheet.png
size: 128,128
inside
  rotate: 0
  xy: 0, 0
  size: 64, 64
  orig: 64, 64
outside
  rotate: 0
  xy: 100, 0
  size: 64, 64
  orig: 64, 64
`;
    const p = parseSpineAtlasText(atlas)[0]!;
    expect(p.sprites.map((s) => s.name)).toEqual(['inside']);
    expect(p.malformedRegions).toEqual([
      { name: 'outside', reason: 'region "outside" extends past page 128×128' },
    ]);
  });

  it('spine offset stays tolerant: a malformed optional offset defaults to 0 (region survives)', () => {
    const atlas = `sheet.png
size: 256,256
rgn
  rotate: 0
  xy: 0, 0
  size: 40, 30
  orig: 50, 50
  offset: , 5
`;
    const p = parseSpineAtlasText(atlas)[0]!;
    expect(p.sprites).toHaveLength(1);
    expect(p.malformedRegions).toBeUndefined(); // offset is tolerant, not a required field
  });

  it('spine modern multi-page: an INDENTED page size: header on page 2+ is NOT swallowed (no lost page)', () => {
    // Bug (R27): the page-boundary lookahead tested the RAW un-trimmed next line against /^size\s*:/,
    // while every other classification used the trimmed line. So on page 2+ a modern Spine 4.x INDENTED
    // page header ("\tsize:" / "  size:") was unrecognized → page 2 was silently dropped, its image line
    // became a phantom full-page sprite on page 1, and regionB was misattributed to page 1.
    // Two variants below — tab-indented AND space-indented page headers — both must yield 2 clean pages.
    for (const [label, indent] of [['tab', '\t'], ['space', '  ']] as const) {
      const atlas = `page1.png
${indent}size: 64, 64
${indent}format: RGBA8888
regionA
${indent}rotate: 0
${indent}xy: 0, 0
${indent}size: 32, 32
${indent}orig: 32, 32
page2.png
${indent}size: 64, 64
${indent}format: RGBA8888
regionB
${indent}rotate: 0
${indent}xy: 0, 0
${indent}size: 16, 16
${indent}orig: 16, 16
`;
      const pages = parseSpineAtlasText(atlas);
      expect(pages.length, label).toBe(2);
      expect(pages.map((p) => p.image)).toEqual(['page1.png', 'page2.png']);
      expect(pages[0]!.size).toEqual({ w: 64, h: 64 });
      expect(pages[1]!.size).toEqual({ w: 64, h: 64 });
      // correct per-page sprite attribution — no phantom "page2.png" full-page region poisoning page 1
      expect(pages[0]!.sprites.map((s) => s.name)).toEqual(['regionA']);
      expect(pages[1]!.sprites.map((s) => s.name)).toEqual(['regionB']);
      // no fabricated/malformed region surfaced on either page
      expect(pages[0]!.malformedRegions).toBeUndefined();
      expect(pages[1]!.malformedRegions).toBeUndefined();
    }
    // NOTE: this only covers the size:-first page-header ordering (the common case). A modern variant that
    // emits a non-size page key (e.g. format:) BEFORE size: is a separate, currently-also-broken case and
    // is explicitly out of scope for this fix.
  });

  it('spine legacy column-0 multi-page regression guard: still 2 pages with correct attribution', () => {
    // Locks the legacy (non-indented) path so the lookahead-trim fix is a no-op for column-0 headers.
    const atlas = `page1.png
size: 64, 64
format: RGBA8888
regionA
rotate: 0
xy: 0, 0
size: 32, 32
orig: 32, 32
page2.png
size: 64, 64
format: RGBA8888
regionB
rotate: 0
xy: 0, 0
size: 16, 16
orig: 16, 16
`;
    const pages = parseSpineAtlasText(atlas);
    expect(pages.length).toBe(2);
    expect(pages.map((p) => p.image)).toEqual(['page1.png', 'page2.png']);
    expect(pages[0]!.sprites.map((s) => s.name)).toEqual(['regionA']);
    expect(pages[1]!.sprites.map((s) => s.name)).toEqual(['regionB']);
    expect(pages[0]!.malformedRegions).toBeUndefined();
    expect(pages[1]!.malformedRegions).toBeUndefined();
  });
});

describe('per-frame recovery — one bad frame no longer nukes the sheet (R21 #1)', () => {
  const sheet = () => ({ ref: 'sheet.png', bytes: bytes('atlas-frame-recovery/sheet.png') });

  it('Hash: keeps the good sprites + surfaces the 1 degenerate frame', () => {
    const res = parseAtlas(json('atlas-frame-recovery/hash.json'), sheet());
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(res.asset.atlas.sprites.map((s) => s.name)).toEqual(['a.png', 'b.png']); // source order preserved
    expect(res.malformedFrames).toEqual([{ name: 'bad.png', reason: 'invalid frame "bad.png"' }]);
  });

  it('Array: keeps the good sprites + surfaces the 1 out-of-bounds frame', () => {
    const res = parseAtlas(json('atlas-frame-recovery/array.json'), sheet());
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(res.asset.atlas.sprites.map((s) => s.name)).toEqual(['c.png', 'd.png']);
    expect(res.malformedFrames).toEqual([
      { name: 'over.png', reason: 'frame "over.png" extends past atlas 128×128' },
    ]);
  });

  it('zero survivors still returns {ok:false} with the first failure reason (preserves F3)', () => {
    const manifest = {
      frames: { 'bad.png': { frame: { x: 0, y: 0, w: 0, h: 32 }, sourceSize: { w: 0, h: 32 } } },
      meta: { image: 'sheet.png', size: { w: 128, h: 128 } },
    };
    const res = parseAtlas(manifest, sheet());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid frame "bad.png"');
  });

  it('empty frames stays {ok:true} with zero sprites and no malformedFrames (E6 byte-identity)', () => {
    const res = parseAtlas(
      { frames: {}, meta: { image: 'sheet.png', size: { w: 128, h: 128 } } },
      sheet(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.asset.kind !== 'atlas') throw new Error('expected atlas');
    expect(res.asset.atlas.sprites).toHaveLength(0);
    expect(res.malformedFrames).toBeUndefined();
  });

  it('a fully-valid atlas carries no malformedFrames field (byte-identical to before)', () => {
    const res = parseAtlas(json('tp-hash-symbols/symbols.json'), {
      ref: 'symbols.png',
      bytes: bytes('tp-hash-symbols/symbols.png'),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected atlas');
    expect(res.malformedFrames).toBeUndefined();
  });
});
