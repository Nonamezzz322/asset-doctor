// Ingest collection of Spine skeleton .json files (V2, spine-unreferenced-regions): a .json that fails
// looksLikeManifest but LOOKS like a skeleton is collected into Grouped.skeletons (its JSON.parse was
// already paid at the manifest check — zero extra cost) instead of being silently dropped; every
// GroupedAtlas now also carries manifestRef (the dir-aware key of its SOURCE manifest) so the host can
// pair skeletons with .atlas files BY THE MANIFEST'S DIRECTORY (a page image may live elsewhere via ../).
// All additive: a folder with no skeleton is byte-identical (skeletons field absent).

import { describe, it, expect } from 'vitest';
import { groupFiles, type RawFile } from '../src/index';

function buf(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

const ATLAS_TEXT = `
sheet.png
size: 64,64
format: RGBA8888
filter: Linear,Linear
repeat: none
head
  rotate: false
  xy: 0, 0
  size: 32, 32
  orig: 32, 32
  offset: 0, 0
  index: -1
`.trimStart();

const SKELETON = JSON.stringify({
  skeleton: { spine: '4.1.17' },
  bones: [{ name: 'root' }],
  slots: [{ name: 's', bone: 'root' }],
  skins: [{ name: 'default', attachments: { s: { head: {} } } }],
});

const files = (): RawFile[] => [
  { name: 'hero.atlas', path: 'spine/hero.atlas', bytes: buf(ATLAS_TEXT) },
  { name: 'sheet.png', path: 'spine/sheet.png', bytes: buf('\x89PNG-not-really') },
  { name: 'hero.json', path: 'spine/hero.json', bytes: buf(SKELETON) },
  { name: 'config.json', path: 'spine/config.json', bytes: buf('{"volume":1}') }, // neither manifest nor skeleton
];

describe('groupFiles — skeleton collection + manifestRef', () => {
  it('collects the skeleton (ref + parsed json), skips plain configs silently, sets manifestRef', () => {
    const g = groupFiles(files());
    expect(g.skeletons).toEqual([{ ref: 'spine/hero.json', json: JSON.parse(SKELETON) }]);
    expect(g.atlases).toHaveLength(1);
    expect(g.atlases[0]!.kind).toBe('spine');
    expect(g.atlases[0]!.manifestRef).toBe('spine/hero.atlas');
    // the plain config neither becomes a skeleton nor lands in unparsed (silent, as before)
    expect(g.unparsed).toEqual([]);
  });

  it('no skeleton in the folder ⇒ the field is ABSENT (byte-identical shape to before)', () => {
    const g = groupFiles(files().filter((f) => f.name !== 'hero.json'));
    expect(g.skeletons).toBeUndefined();
  });
});
