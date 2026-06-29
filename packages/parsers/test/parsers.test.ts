import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAtlas, parseImage, readImageInfo, parseSpineAtlasText, parseFntText, parseFntPage } from '../src/index';

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
