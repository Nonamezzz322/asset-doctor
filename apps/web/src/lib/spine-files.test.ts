// PURE unit lock for the Spine viewer's file-grouping + atlas-munging (spine-files.ts). apps/web is a
// node-env vitest project (no browser), so the load-bearing format logic — which files group together, how a
// skeleton JSON names its page images, and the byte-exact synthesized atlas when no .atlas was dropped — is
// asserted here; the Pixi glue (spine-engine.ts) is build-verified only. Distinct from test/spine.test.ts,
// which exercises the DIAGNOSIS .atlas parser, not the viewer's loader.

import { describe, it, expect } from 'vitest';
import {
  modifyAtlasText,
  expandSequencePath,
  extractImageNames,
  findImageFile,
  getTextureLineKey,
  groupSpineFiles,
  buildAtlasFromImages,
  filterSlots,
  type SkeletonLike,
} from './spine-files';

describe('modifyAtlasText — passthrough seam', () => {
  it('returns the atlas text unchanged', () => {
    expect(modifyAtlasText('a\nb\n')).toBe('a\nb\n');
  });
});

describe('expandSequencePath — zero-padded frame expansion', () => {
  it('digits:3 start:1 count:12 → img001 … img012', () => {
    expect(expandSequencePath('img', { digits: 3, start: 1, count: 12 })).toEqual([
      'img001', 'img002', 'img003', 'img004', 'img005', 'img006',
      'img007', 'img008', 'img009', 'img010', 'img011', 'img012',
    ]);
  });
  it('defaults start to 1 and pads only when the frame is shorter than digits', () => {
    expect(expandSequencePath('f', { digits: 2, count: 3 })).toEqual(['f01', 'f02', 'f03']);
  });
  it('count 0 (or missing) → empty', () => {
    expect(expandSequencePath('f', {})).toEqual([]);
  });
});

describe('extractImageNames — both skin shapes + path fallback + sequences', () => {
  it('Hash skins (object): reads the attachment path, falls back to the placeholder name', () => {
    const json: SkeletonLike = {
      skins: {
        default: {
          head: { headImg: { type: 'region', path: 'images/head' } },
          body: { torso: { type: 'mesh' } }, // no path/name ⇒ falls back to the attachment key 'torso'
        },
      },
    };
    expect(extractImageNames(json)).toEqual(['images/head', 'torso']);
  });

  it('Array skins: same extraction over the array shape', () => {
    const json: SkeletonLike = {
      skins: [
        { name: 'default', attachments: { slotA: { imgA: { type: 'region', name: 'gun' } } } },
      ],
    };
    expect(extractImageNames(json)).toEqual(['gun']);
  });

  it('expands sequence attachments and de-dupes first-seen', () => {
    const json: SkeletonLike = {
      skins: {
        default: {
          fx: { flip: { type: 'region', path: 'frame', sequence: { digits: 2, start: 1, count: 3 } } },
          dup: { again: { type: 'region', path: 'frame01' } }, // already produced by the sequence ⇒ deduped
        },
      },
    };
    expect(extractImageNames(json)).toEqual(['frame01', 'frame02', 'frame03']);
  });

  it('no skins ⇒ empty', () => {
    expect(extractImageNames({})).toEqual([]);
  });
});

describe('findImageFile — the six-rung resolution ladder', () => {
  it('rung 1: exact + extension', () => {
    expect(findImageFile('hero', ['hero.png', 'other.png'])).toBe('hero.png');
  });
  it('rung 2: exact as-is (name already carries the extension)', () => {
    expect(findImageFile('hero.webp', ['hero.webp'])).toBe('hero.webp');
  });
  it('rung 3: case-insensitive full path + ext', () => {
    expect(findImageFile('Hero', ['HERO.PNG'])).toBe('HERO.PNG');
  });
  it('rung 4: case-insensitive basename + ext', () => {
    expect(findImageFile('sub/Hero', ['assets/hero.png'])).toBe('assets/hero.png');
  });
  it('rung 5: basename without extension', () => {
    expect(findImageFile('hero', ['pics/hero.jpeg'])).toBe('pics/hero.jpeg');
  });
  it('rung 6: folder-prefix endsWith', () => {
    // Basename 'name' collides across two keys; the endsWith rung disambiguates by the folder-prefixed ref.
    expect(findImageFile('images/subfolder/name', ['x/images/subfolder/name.png'])).toBe(
      'x/images/subfolder/name.png',
    );
  });
  it('no match ⇒ null', () => {
    expect(findImageFile('missing', ['hero.png'])).toBeNull();
  });
});

describe('getTextureLineKey — atlas page-name resolver', () => {
  it('exact, then ci-full, then ci-basename', () => {
    expect(getTextureLineKey('sheet.png', ['sheet.png'])).toBe('sheet.png');
    expect(getTextureLineKey('SHEET.PNG', ['sheet.png'])).toBe('sheet.png');
    expect(getTextureLineKey('sheet.png', ['spineboy/sheet.png'])).toBe('spineboy/sheet.png');
  });
  it('no match ⇒ null', () => {
    expect(getTextureLineKey('nope.png', ['sheet.png'])).toBeNull();
  });
});

describe('groupSpineFiles — first .json / .atlas wins; images collected', () => {
  it('.json + .atlas + images', () => {
    expect(groupSpineFiles(['skel.json', 'skel.atlas', 'a.png', 'b.webp', 'notes.txt'])).toEqual({
      jsonName: 'skel.json',
      atlasName: 'skel.atlas',
      imageNames: ['a.png', 'b.webp'],
    });
  });
  it('.json + images only (no atlas) ⇒ atlasName null', () => {
    expect(groupSpineFiles(['skel.json', 'a.png'])).toEqual({
      jsonName: 'skel.json',
      atlasName: null,
      imageNames: ['a.png'],
    });
  });
  it('no .json ⇒ jsonName null (caller emits noJson)', () => {
    expect(groupSpineFiles(['a.png']).jsonName).toBeNull();
  });
});

describe('buildAtlasFromImages — byte-exact synthesized atlas', () => {
  it('two-image skeleton: page + region blocks match the source format exactly', () => {
    const json: SkeletonLike = {
      skins: {
        default: {
          head: { head: { type: 'region', path: 'head' } },
          body: { body: { type: 'region', path: 'body' } },
        },
      },
    };
    const dims = new Map([
      ['head.png', { w: 64, h: 32 }],
      ['body.png', { w: 128, h: 128 }],
    ]);
    const atlas = buildAtlasFromImages(json, dims);
    expect(atlas).toBe(
      'head.png\nsize: 64,32\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n' +
        'head\n  rotate: false\n  xy: 0, 0\n  size: 64, 32\n  orig: 64, 32\n  offset: 0, 0\n  index: -1\n' +
        '\nbody.png\nsize: 128,128\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n' +
        'body\n  rotate: false\n  xy: 0, 0\n  size: 128, 128\n  orig: 128, 128\n  offset: 0, 0\n  index: -1\n',
    );
  });

  it('unresolved image ⇒ honest 2×2 placeholder page (region still exists)', () => {
    const json: SkeletonLike = { skins: { default: { s: { a: { type: 'region', path: 'ghost' } } } } };
    const atlas = buildAtlasFromImages(json, new Map());
    expect(atlas).toContain('__placeholder_ghost.png\nsize: 2,2\n');
    expect(atlas).toContain('ghost\n  rotate: false\n  xy: 0, 0\n  size: 2, 2\n');
  });
});

describe('filterSlots — case-insensitive substring', () => {
  it('narrows the list; blank query returns all', () => {
    const slots = ['head', 'left-arm', 'right-arm', 'torso'];
    expect(filterSlots(slots, 'ARM')).toEqual(['left-arm', 'right-arm']);
    expect(filterSlots(slots, '')).toEqual(slots);
  });
});
