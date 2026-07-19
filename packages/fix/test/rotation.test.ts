// Rotation-packing v2 — slice 1 (PURE emit geometry). The packer may place an eligible sprite rotated 90°;
// repackAtlases must emit the on-page frame AS PLACED (w/h swapped), rotated:true, a rotate90 Blit, and a
// manifest that round-trips. Trim × rotation are mutually exclusive; a pre-rotated source blocks rotation.
// NB: production plans pass allowRotation:false, so this exercises the not-yet-enabled path (compose lands next).
import { describe, it, expect } from 'vitest';
import type { Atlas } from '@asset-doctor/core';
import { parseAtlasManifest } from '@asset-doctor/parsers';
import { repackAtlases } from '../src/repack';
import { emitTexturePackerJson } from '../src/manifest';

const sprite = (name: string, w: number, h: number, x = 0, y = 0) => ({
  name,
  frame: { x, y, w, h },
  rotated: false,
  trimmed: false,
  sourceSize: { w, h },
});

// A (64×20) fills a top strip ⇒ leaves a 64×44 free-rect; B (40×30) fits that TIGHTER rotated (short-side
// leftover 4 vs 14), so best-short-side-fit rotates B.
const twoSpriteAtlas: Atlas = {
  name: 'sheet.png',
  imageRef: 'sheet.png',
  size: { w: 128, h: 128 },
  sprites: [sprite('a', 64, 20), sprite('b', 40, 30, 0, 20)],
  source: { kind: 'texturepacker-hash' },
};

describe('rotation-packing v2 — repack emit geometry (slice 1)', () => {
  it('rotates B to fit tighter and emits swapped frame + rotate90 + rotated (round-trips)', () => {
    const res = repackAtlases([twoSpriteAtlas], { allowRotation: true, padding: 0, maxSize: 4096 });
    const b = res.atlases.flatMap((a) => a.sprites).find((s) => s.name === 'b')!;
    const bBlit = res.blits.find((bl) => bl.name === 'b')!;

    expect(b.rotated).toBe(true); // the packer rotated it
    expect(res.rotatedFrames).toBeGreaterThanOrEqual(1);
    // on-page frame stored AS PLACED (swapped vs source): frame.w == sourceSize.h, frame.h == sourceSize.w
    expect(b.sourceSize).toEqual({ w: 40, h: 30 });
    expect(b.frame.w).toBe(30);
    expect(b.frame.h).toBe(40);
    // the Blit rotates the source region into the destination box
    expect(bBlit.rotate90).toBe(true);
    expect(bBlit.from.rotated).toBe(false); // source region read UN-rotated (packer applies the 90°)
    expect(bBlit.from.rect.w).toBe(40); // the un-rotated source frame
    expect(bBlit.from.rect.h).toBe(30);
    expect(bBlit.to.w).toBe(b.frame.w); // destination box == the emitted on-page frame
    expect(bBlit.to.h).toBe(b.frame.h);

    // Manifest round-trip: emit → parse → the placed frame recovers (w/h swapped), sourceSize un-rotated.
    const json = JSON.parse(emitTexturePackerJson(res.atlases[0]!)) as { frames: Record<string, { frame: { w: number; h: number }; rotated: boolean }> };
    expect(json.frames.b!.rotated).toBe(true);
    expect(json.frames.b!.frame.w).toBe(40); // emitted UN-rotated (source dims); loader swaps to on-page
    expect(json.frames.b!.frame.h).toBe(30);
    const back = parseAtlasManifest(json, {});
    expect(back.ok).toBe(true);
    if (back.ok) {
      const bp = back.atlas.sprites.find((s) => s.name === 'b')!;
      expect(bp.rotated).toBe(true);
      expect(bp.frame.w).toBe(30); // back to placed (swapped)
      expect(bp.frame.h).toBe(40);
      expect(bp.sourceSize).toEqual({ w: 40, h: 30 });
    }
  });

  it('allowRotation:false never rotates (byte-identical to today)', () => {
    const res = repackAtlases([twoSpriteAtlas], { allowRotation: false, padding: 0, maxSize: 4096 });
    expect(res.rotatedFrames).toBeUndefined();
    expect(res.atlases.flatMap((a) => a.sprites).every((s) => s.rotated === false)).toBe(true);
    expect(res.blits.every((bl) => bl.rotate90 === false)).toBe(true);
  });

  it('a pre-rotated source sprite blocks rotation for the whole group (single-rotation scope)', () => {
    const withRotatedSource: Atlas = {
      ...twoSpriteAtlas,
      sprites: [sprite('a', 64, 20), { ...sprite('b', 40, 30), rotated: true, frame: { x: 0, y: 20, w: 30, h: 40 }, sourceSize: { w: 40, h: 30 } }],
    };
    const res = repackAtlases([withRotatedSource], { allowRotation: true, padding: 0, maxSize: 4096 });
    expect(res.rotatedFrames).toBeUndefined(); // no NEW packer rotation — group blocked by the pre-rotated source
    expect(res.blits.every((bl) => bl.rotate90 === false)).toBe(true);
  });
});
