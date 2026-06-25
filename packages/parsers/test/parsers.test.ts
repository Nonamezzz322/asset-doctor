import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAtlas, parseImage, readImageInfo } from '../src/index';

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
