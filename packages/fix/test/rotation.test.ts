// Rotation-packing v2 (PURE emit geometry). The packer may place an eligible sprite rotated 90°; repackAtlases
// must emit the on-page frame AS PLACED (w/h swapped), rotated:true, a rotate90 Blit, and a manifest that
// round-trips. Trim × rotation are mutually exclusive; a pre-rotated source blocks rotation; byte-identical
// aliases inherit a rotated representative's rect. NB: rotation is LIVE on production repack plans (the compose
// is pixel-verified by tools/verify/rotate-compose-check.mjs, e2e scenario 6); the measured VRAM gate keeps it
// emitting only on a real shrink.
import { describe, it, expect } from 'vitest';
import type { Atlas } from '@asset-doctor/core';
import { parseAtlasManifest } from '@asset-doctor/parsers';
import { repackAtlases } from '../src/repack';
import { buildAtlasAliasMap } from '../src/alias';
import { emitTexturePackerJson } from '../src/manifest';

const sprite = (name: string, w: number, h: number, x = 0, y = 0) => ({
  name,
  frame: { x, y, w, h },
  rotated: false,
  trimmed: false,
  sourceSize: { w, h },
});

// A (100×60) + B (60×100): unrotated they only fit a 128×256 bin (B can't fit beside/below A in 128²), but
// rotating B to 100×60 stacks both into a 128×128 bin (HALF the VRAM). So the measured gate uses the rotated
// pack and B is emitted rotated.
const twoSpriteAtlas: Atlas = {
  name: 'sheet.png',
  imageRef: 'sheet.png',
  size: { w: 256, h: 256 },
  sprites: [sprite('a', 100, 60), sprite('b', 60, 100, 100, 0)],
  source: { kind: 'texturepacker-hash' },
};

const totalVram = (r: ReturnType<typeof repackAtlases>): number => r.atlases.reduce((s, at) => s + at.size.w * at.size.h * 4, 0);

describe('rotation-packing v2 — repack emit geometry (slice 1)', () => {
  it('rotates a sprite into a smaller bin (measured VRAM win) and emits swapped frame + rotate90 (round-trips)', () => {
    const res = repackAtlases([twoSpriteAtlas], { allowRotation: true, padding: 0, maxSize: 4096 });
    const unrot = repackAtlases([twoSpriteAtlas], { allowRotation: false, padding: 0, maxSize: 4096 });

    expect(res.rotatedFrames).toBeGreaterThanOrEqual(1); // rotation happened AND won the measured gate
    expect(totalVram(res)).toBeLessThan(totalVram(unrot)); // the honesty gate: strictly smaller VRAM only

    // Whichever sprite the packer rotated: its on-page frame is stored AS PLACED (swapped vs sourceSize), and
    // its Blit rotates the un-rotated source region into the destination box.
    const rot = res.atlases.flatMap((a) => a.sprites).find((s) => s.rotated)!;
    expect(rot).toBeDefined();
    expect(rot.frame.w).toBe(rot.sourceSize.h); // frame.w == sourceSize.h
    expect(rot.frame.h).toBe(rot.sourceSize.w); // frame.h == sourceSize.w
    const blit = res.blits.find((bl) => bl.name === rot.name)!;
    expect(blit.rotate90).toBe(true);
    expect(blit.from.rotated).toBe(false); // source region read UN-rotated (the compose applies the 90°)
    expect(blit.from.rect.w).toBe(rot.sourceSize.w); // the un-rotated source frame
    expect(blit.from.rect.h).toBe(rot.sourceSize.h);
    expect(blit.to.w).toBe(rot.frame.w); // destination box == the emitted on-page frame
    expect(blit.to.h).toBe(rot.frame.h);

    // Manifest round-trip: emit → parse → the placed frame recovers (w/h swapped), sourceSize un-rotated.
    const json = JSON.parse(emitTexturePackerJson(res.atlases[0]!)) as { frames: Record<string, { frame: { w: number; h: number }; rotated: boolean }> };
    const jf = json.frames[rot.name]!;
    expect(jf.rotated).toBe(true);
    expect(jf.frame.w).toBe(rot.sourceSize.w); // emitted UN-rotated (source dims); loader swaps to on-page
    expect(jf.frame.h).toBe(rot.sourceSize.h);
    const back = parseAtlasManifest(json, {});
    expect(back.ok).toBe(true);
    if (back.ok) {
      const bp = back.atlas.sprites.find((s) => s.name === rot.name)!;
      expect(bp.rotated).toBe(true);
      expect(bp.frame.w).toBe(rot.frame.w); // back to placed (swapped)
      expect(bp.frame.h).toBe(rot.frame.h);
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

  it('a byte-identical ALIAS inherits its representative rect exactly, including a packer-rotation', () => {
    // The proven rotation pair (a 100×60 + b 60×100 ⇒ one rotates to stack into 128²), but each is now a
    // 2-frame byte-identical cluster ⇒ a0 rep + a1 alias, b0 rep + b1 alias (only the reps pack; aliases land
    // on the rep's FINAL rect). Whichever rep the packer rotates, its alias must inherit the swapped rect +
    // rotated:true, and each cluster writes ONE shared blit. This is the alias × packer-rotation path (repack.ts).
    const atlas: Atlas = {
      name: 'sheet.png',
      imageRef: 'sheet.png',
      size: { w: 256, h: 256 },
      sprites: [
        sprite('a0', 100, 60, 0, 0),
        sprite('a1', 100, 60, 0, 60), // byte-identical to a0, distinct rect
        sprite('b0', 60, 100, 0, 120),
        sprite('b1', 60, 100, 60, 120), // byte-identical to b0, distinct rect
      ],
      source: { kind: 'texturepacker-hash' },
    };
    const aliasMap = buildAtlasAliasMap(atlas.sprites, ['ha', 'ha', 'hb', 'hb'], 2);
    expect(aliasMap.aliasedFrames).toBe(2); // a1 onto a0, b1 onto b0
    const res = repackAtlases([atlas], { allowRotation: true, padding: 0, maxSize: 4096 }, new Map([['sheet.png', aliasMap]]));
    expect(res.rotatedFrames).toBeGreaterThanOrEqual(1); // the gate won ⇒ a representative was rotated

    const out = res.atlases.flatMap((at) => at.sprites);
    const byName = (n: string) => out.find((s) => s.name === n)!;
    // Each alias mirrors its representative EXACTLY — same placed rect, same rotation flag (never a broken
    // half-rotated frame where the alias kept the rep's rect but not its rotation, or vice versa).
    for (const [rep, alias] of [['a0', 'a1'], ['b0', 'b1']] as const) {
      expect(byName(alias).frame).toEqual(byName(rep).frame);
      expect(byName(alias).rotated).toBe(byName(rep).rotated);
      expect(byName(alias).sourceSize).toEqual(byName(rep).sourceSize);
    }
    // The rotated pair specifically: the rep's frame is its sourceSize swapped, and its alias rides along.
    const rotatedRep = [byName('a0'), byName('b0')].find((s) => s.rotated)!;
    expect(rotatedRep).toBeDefined();
    expect(rotatedRep.frame.w).toBe(rotatedRep.sourceSize.h);
    expect(rotatedRep.frame.h).toBe(rotatedRep.sourceSize.w);
    const rotatedAlias = byName(rotatedRep.name === 'a0' ? 'a1' : 'b1');
    expect(rotatedAlias.rotated).toBe(true);
    expect(rotatedAlias.frame).toEqual(rotatedRep.frame);
    // Pixels written ONCE per cluster — the rep's blit; neither alias carries its own blit.
    expect(res.blits.filter((bl) => bl.name === 'a0' || bl.name === 'a1')).toHaveLength(1);
    expect(res.blits.filter((bl) => bl.name === 'b0' || bl.name === 'b1')).toHaveLength(1);
  });
});
