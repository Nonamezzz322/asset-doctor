import { describe, expect, it } from 'vitest';
import type { Sprite } from '@asset-doctor/core';
import { buildAtlasAliasMap, buildAtlasAliasMaps } from '../src/index';

// A 32×32 frame at a given x — distinct rects per sprite unless `x` collides (the pre-aliased case).
const sp = (name: string, x: number): Sprite => ({
  name,
  frame: { x, y: 0, w: 32, h: 32 },
  rotated: false,
  trimmed: false,
  sourceSize: { w: 32, h: 32 },
});

describe('buildAtlasAliasMap (round19 — mirrors the detector distinct-rect logic)', () => {
  it('clusters byte-identical frames at DISTINCT rects ⇒ one representative, the rest aliased', () => {
    // 4 idle frames share a hash (distinct rects) + 1 distinct walk. gate minDistinctRects=3.
    const sprites = [sp('idle_0', 0), sp('idle_1', 32), sp('idle_2', 64), sp('idle_3', 96), sp('walk', 128)];
    const m = buildAtlasAliasMap(sprites, ['h', 'h', 'h', 'h', 'w'], 3);
    expect(m.aliasedFrames).toBe(3); // distinctRects(4) − 1 kept
    expect(m.representatives).toEqual([0, 4]); // idle rep (lowest index) + walk
    expect(m.repOf).toEqual([0, 0, 0, 0, 4]); // every idle points at idle_0; walk is its own
  });

  it('a sub-gate cluster (distinctRects < minDistinctRects) is NOT aliased (packs normally)', () => {
    const sprites = [sp('a', 0), sp('b', 32), sp('c', 64)];
    const m = buildAtlasAliasMap(sprites, ['h', 'h', 'x'], 3); // only 2 in the cluster, gate is 3
    expect(m.aliasedFrames).toBe(0);
    expect(m.representatives).toEqual([0, 1, 2]); // identity — nothing aliased
    expect(m.repOf).toEqual([0, 1, 2]);
  });

  it('DISTINCT-RECT GUARD: pre-aliased names at the SAME rect collapse to ONE unit, never double-count', () => {
    // 5 names hash-identical, but two PAIRS already alias one rect each (x=0 ×2, x=32 ×2) + one at x=64.
    // Distinct rects = 3 (x=0, x=32, x=64) ⇒ gate(3) met ⇒ aliasedFrames = 3 − 1 = 2 (NOT 5 − 1 = 4).
    const sprites = [sp('a', 0), sp('b', 0), sp('c', 32), sp('d', 32), sp('e', 64)];
    const m = buildAtlasAliasMap(sprites, ['h', 'h', 'h', 'h', 'h'], 3);
    expect(m.aliasedFrames).toBe(2);
    // Representative = first distinct rect's lowest index (a@x=0, index 0). EVERY cluster member points at it.
    expect(m.repOf).toEqual([0, 0, 0, 0, 0]);
    expect(m.representatives).toEqual([0]);
  });

  it('null hashes never cluster (host-skipped flat region)', () => {
    const sprites = [sp('a', 0), sp('b', 32), sp('c', 64), sp('d', 96)];
    const m = buildAtlasAliasMap(sprites, [null, null, null, null], 3);
    expect(m.aliasedFrames).toBe(0);
    expect(m.representatives).toEqual([0, 1, 2, 3]);
  });

  it('length mismatch / missing hashes ⇒ identity (fail-safe, byte-identical to packing every sprite)', () => {
    const sprites = [sp('a', 0), sp('b', 32), sp('c', 64)];
    expect(buildAtlasAliasMap(sprites, ['h', 'h'], 3).aliasedFrames).toBe(0); // too short
    expect(buildAtlasAliasMap(sprites, undefined, 3).aliasedFrames).toBe(0); // absent
    expect(buildAtlasAliasMap(sprites, ['h', 'h', 'h'], 0).aliasedFrames).toBe(0); // degenerate gate
    expect(buildAtlasAliasMap(sprites, undefined, 3).repOf).toEqual([0, 1, 2]);
  });

  it('representative is the LOWEST sprite index — deterministic regardless of hash order', () => {
    const sprites = [sp('z', 0), sp('a', 32), sp('m', 64)];
    const m = buildAtlasAliasMap(sprites, ['h', 'h', 'h'], 3);
    expect(m.representatives).toEqual([0]); // first distinct rect's lowest index, not the alphabetical name
    expect(m.repOf).toEqual([0, 0, 0]);
  });

  it('two independent clusters each keep their own representative', () => {
    const sprites = [sp('a0', 0), sp('a1', 32), sp('a2', 64), sp('b0', 96), sp('b1', 128), sp('b2', 160)];
    const m = buildAtlasAliasMap(sprites, ['a', 'a', 'a', 'b', 'b', 'b'], 3);
    expect(m.aliasedFrames).toBe(4); // (3−1) + (3−1)
    expect(m.representatives).toEqual([0, 3]);
    expect(m.repOf).toEqual([0, 0, 0, 3, 3, 3]);
  });
});

describe('buildAtlasAliasMaps (keyed by Atlas.name)', () => {
  const atlas = (name: string, sprites: Sprite[]): { name: string; imageRef: string; size: { w: number; h: number }; sprites: Sprite[]; source: { kind: 'pixi' } } => ({
    name,
    imageRef: `${name}`,
    size: { w: 256, h: 32 },
    sprites,
    source: { kind: 'pixi' },
  });

  it('only includes atlases that actually alias ≥1 frame', () => {
    const a = atlas('anim.png', [sp('i0', 0), sp('i1', 32), sp('i2', 64), sp('i3', 96)]);
    const b = atlas('clean.png', [sp('x', 0), sp('y', 32), sp('z', 64)]);
    const hashes = new Map<string, (string | null)[]>([
      ['anim.png', ['h', 'h', 'h', 'h']],
      ['clean.png', ['x', 'y', 'z']],
    ]);
    const maps = buildAtlasAliasMaps([a, b], hashes, 3);
    expect([...maps.keys()]).toEqual(['anim.png']); // clean.png has no duplicates ⇒ absent
    expect(maps.get('anim.png')!.aliasedFrames).toBe(3);
  });
});
