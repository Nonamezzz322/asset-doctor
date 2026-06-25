import { describe, it, expect } from 'vitest';
import { groupFiles, type RawFile } from '../src/lib/group';
import { fmtBytes } from '../src/lib/format';

const enc = (o: unknown): ArrayBuffer => new TextEncoder().encode(JSON.stringify(o)).buffer as ArrayBuffer;
const empty: ArrayBuffer = new ArrayBuffer(0);
const file = (name: string, bytes: ArrayBuffer): RawFile => ({ name, bytes });

describe('groupFiles', () => {
  it('pairs a manifest with its image and keeps standalone images', () => {
    const manifest = {
      frames: { 'a.png': { frame: { x: 0, y: 0, w: 1, h: 1 } } },
      meta: { image: 'atlas.png', size: { w: 2, h: 2 } },
    };
    const g = groupFiles([
      file('sprites/atlas.json', enc(manifest)),
      file('sprites/atlas.png', empty),
      file('loose.png', empty),
      file('notes.txt', empty),
    ]);
    expect(g.atlases).toHaveLength(1);
    expect(g.atlases[0]?.name).toBe('atlas.png');
    expect(g.images.map((i) => i.name)).toEqual(['loose.png']);
  });

  it('resolves a manifest image within its own directory, not by global basename', () => {
    const manifest = (image: string) => ({
      frames: { a: { frame: { x: 0, y: 0, w: 1, h: 1 } } },
      meta: { image, size: { w: 2, h: 2 } },
    });
    const g = groupFiles([
      { name: 'sheet.json', path: 'a/sheet.json', bytes: enc(manifest('sheet.png')) },
      { name: 'sheet.png', path: 'a/sheet.png', bytes: empty },
      { name: 'sheet.json', path: 'b/sheet.json', bytes: enc(manifest('sheet.png')) },
      { name: 'sheet.png', path: 'b/sheet.png', bytes: empty },
    ]);
    expect(g.atlases).toHaveLength(2);
    // each manifest paired with its OWN directory's image (global-basename would pair both to b/)
    expect(g.atlases.map((a) => a.image.path).sort()).toEqual(['a/sheet.png', 'b/sheet.png']);
  });

  it('ignores json without frames and never throws on bad json', () => {
    const g = groupFiles([
      file('config.json', enc({ hello: 1 })),
      file('broken.json', new TextEncoder().encode('{ not json').buffer as ArrayBuffer),
      file('x.png', empty),
    ]);
    expect(g.atlases).toHaveLength(0);
    expect(g.images.map((i) => i.name)).toEqual(['x.png']);
  });
});

describe('fmtBytes', () => {
  it('formats byte scales', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(16_810_000)).toBe('16.0 MB');
  });
});
