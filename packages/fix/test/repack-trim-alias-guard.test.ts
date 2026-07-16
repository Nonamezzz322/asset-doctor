// P3 ingest/fix audit #1 regression — the cluster trim-safety gate. An aliased duplicate used to inherit
// its representative's trim WHOLESALE: byte-identical FRAME pixels do not imply identical SOURCE geometry,
// so a trimmed sprite from a 100×100 canvas clustering with an untrimmed 20×20 copy had its logical canvas
// collapsed to 20×20 and its in-game anchor shifted by the lost offset. The fix: such clusters pack
// VERBATIM (no trim — the rotated-guard precedent); clusters whose every member is trim-inheritable keep
// the win. Also pins the audit #7 fix: Spine `index:` round-trips through repack + emitSpineAtlasText.

import { describe, expect, it } from 'vitest';
import type { Atlas, Sprite, TrimRect } from '@asset-doctor/core';
import { buildAtlasAliasMap, repackAtlases, emitSpineAtlasText } from '../src/index';

const OPTS = { allowRotation: false, padding: 2, maxSize: 4096 };

function atlasOf(sprites: Sprite[]): Atlas {
  return { name: 'sheet.png', imageRef: 'sheet.png', size: { w: 256, h: 256 }, sprites, source: { kind: 'spine' } };
}

describe('cluster trim-safety gate (audit #1)', () => {
  // plain: untrimmed 20×20 with a tighter opaque bbox {2,2,16,16}; padded: byte-identical FRAME pixels but
  // its OWN source geometry — trimmed from a 100×100 canvas at offset (30,40).
  const plain: Sprite = { name: 'plain', frame: { x: 0, y: 0, w: 20, h: 20 }, rotated: false, trimmed: false, sourceSize: { w: 20, h: 20 } };
  const padded: Sprite = { name: 'padded', frame: { x: 40, y: 0, w: 20, h: 20 }, rotated: false, trimmed: true, sourceSize: { w: 100, h: 100 }, spriteSourceSize: { x: 30, y: 40, w: 20, h: 20 } };
  const bboxes: (TrimRect | null)[] = [{ x: 2, y: 2, w: 16, h: 16 }, null];

  it('a geometry-divergent alias BLOCKS the cluster trim: both emit with their ORIGINAL geometry', () => {
    const a = atlasOf([plain, padded]);
    const am = buildAtlasAliasMap(a.sprites, ['h', 'h'], 2);
    expect(am.aliasedFrames).toBe(1); // sanity: they really do cluster
    const r = repackAtlases([a], { ...OPTS, trim: [bboxes] }, new Map([[a.name, am]]));
    const out = new Map(r.atlases[0]!.sprites.map((s) => [s.name, s]));
    const outPadded = out.get('padded')!;
    // the alias keeps ITS OWN canvas + offset — never the rep's 20×20/{2,2,…} (the audit corruption)
    expect(outPadded.sourceSize).toEqual({ w: 100, h: 100 });
    expect(outPadded.spriteSourceSize).toEqual({ x: 30, y: 40, w: 20, h: 20 });
    expect(outPadded.trimmed).toBe(true);
    const outPlain = out.get('plain')!;
    expect(outPlain.trimmed).toBe(false); // the whole cluster packed verbatim — no half-trimmed state
    expect(outPlain.frame.w).toBe(20); // frame extent, not the tightened 16
    expect(r.trimmedSprites).toBeUndefined(); // no trim happened ⇒ no trim claim (honest receipt)
  });

  it('a SAFE cluster (every member untrimmed) still gets the trim win (rep + alias inherit)', () => {
    const clone: Sprite = { ...plain, name: 'clone', frame: { x: 40, y: 0, w: 20, h: 20 } };
    const a = atlasOf([plain, clone]);
    const am = buildAtlasAliasMap(a.sprites, ['h', 'h'], 2);
    const r = repackAtlases([a], { ...OPTS, trim: [[{ x: 2, y: 2, w: 16, h: 16 }, null]] }, new Map([[a.name, am]]));
    const out = new Map(r.atlases[0]!.sprites.map((s) => [s.name, s]));
    expect(out.get('plain')!.trimmed).toBe(true);
    expect(out.get('clone')!.trimmed).toBe(true); // inherits the rep trim — still correct when geometry matches
    expect(out.get('plain')!.frame.w).toBe(16);
    expect(r.trimmedSprites).toBe(1);
  });
});

describe('Spine index: round-trip (audit #7)', () => {
  it('a carried Sprite.index survives repack and is emitted verbatim (absent ⇒ -1)', () => {
    const seq: Sprite = { name: 'run_3', frame: { x: 0, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, sourceSize: { w: 16, h: 16 }, index: 3 };
    const plainS: Sprite = { name: 'still', frame: { x: 20, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false, sourceSize: { w: 16, h: 16 } };
    const r = repackAtlases([atlasOf([seq, plainS])], OPTS);
    const text = emitSpineAtlasText(r.atlases[0]!);
    expect(text).toContain('index: 3');
    expect(text).toContain('index: -1'); // the index-less sprite keeps the conventional none
  });
});
