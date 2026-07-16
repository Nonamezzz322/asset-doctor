// Ingest grouping for a modern Spine 4.x multi-page .atlas whose page `size:` headers are INDENTED.
// Locks the R27 honesty fix end-to-end: parseSpineAtlasText now recognizes an indented page header on
// page 2+, so groupFiles resolves BOTH page images, marks both `referenced`, routes both as
// GroupedAtlas.kind === 'spine', and neither page image is mis-flagged as an unreferenced/orphan asset
// (it would land in `images` if dropped). Pre-fix: page 2 was silently lost → page2.png appeared in
// `images` as a false orphan and a phantom full-page sprite poisoned page 1 (invariant-3 break).

import { describe, it, expect } from 'vitest';
import { groupFiles, type RawFile } from '../src/index';

/** Encode a string into a fresh ArrayBuffer (RawFile.bytes). */
function buf(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}
/** A throwaway PNG-shaped buffer — groupFiles never decodes a spine page image, it only resolves + dedups. */
function pngBytes(): ArrayBuffer {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ab = new ArrayBuffer(sig.length);
  new Uint8Array(ab).set(sig);
  return ab;
}
const file = (path: string, bytes: ArrayBuffer): RawFile => ({ name: path.split('/').pop()!, path, bytes });

/** Modern Spine 4.x multi-page atlas: page headers INDENTED, pages separated by the CANONICAL blank
 *  line (P3 parser fixes: page detection now follows the libGDX/spine-ts blank-line contract — real
 *  exporters emit the separator; DELIBERATELY updated with that change). */
const INDENTED_MULTIPAGE = `skel.png
\tsize: 64, 64
\tformat: RGBA8888
regionA
\trotate: 0
\txy: 0, 0
\tsize: 32, 32
\torig: 32, 32

skel2.png
\tsize: 64, 64
\tformat: RGBA8888
regionB
\trotate: 0
\txy: 0, 0
\tsize: 16, 16
\torig: 16, 16
`;

describe('ingest: modern indented multi-page spine .atlas — both pages referenced, no false orphan (R27)', () => {
  it('resolves both page images, routes both as spine pages, and flags neither as unreferenced', () => {
    const files: RawFile[] = [
      file('hero/skel.atlas', buf(INDENTED_MULTIPAGE)),
      file('hero/skel.png', pngBytes()),
      file('hero/skel2.png', pngBytes()),
    ];
    const g = groupFiles(files);

    // BOTH pages are grouped (page 2 is not silently dropped) ...
    expect(g.atlases.filter((a) => a.kind === 'spine')).toHaveLength(2);
    expect(g.atlases.map((a) => a.image.name).sort()).toEqual(['skel.png', 'skel2.png']);

    // ... and NEITHER page image leaks into `images` (the unreferenced/orphan surface).
    expect(g.images.map((f) => f.name)).not.toContain('skel.png');
    expect(g.images.map((f) => f.name)).not.toContain('skel2.png');
    expect(g.images).toHaveLength(0);

    // honest channels stay clean — nothing missing, nothing unparsed.
    expect(g.missing).toHaveLength(0);
    expect(g.unparsed).toHaveLength(0);
  });
});
