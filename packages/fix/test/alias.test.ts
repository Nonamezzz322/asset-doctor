import { describe, expect, it } from 'vitest';
import type { Atlas, Sprite } from '@asset-doctor/core';
import { buildAtlasAliasMap, buildAtlasAliasMaps, buildMergeAliasMap } from '../src/index';

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

describe('buildMergeAliasMap (round22 #1 — cross-atlas frame dedup during merge)', () => {
  const atl = (name: string, sprites: Sprite[]): Atlas => ({
    name, imageRef: name, size: { w: 256, h: 256 }, sprites, source: { kind: 'pixi' },
  });

  it('T1: clusters byte-identical frames ACROSS sheets in one flat keyspace ⇒ one rep, the rest aliased', () => {
    // Sheet A holds idle_0/idle_1 (byte-identical), sheet B holds idle_b (same pixels). gate=2 (cross-atlas).
    // The WHOLE group is one cluster of 3 DISTINCT rects (A@0, A@32, B@0) ⇒ rep = flat 0, aliasedFrames = 2,
    // crossSheetFrames = 1 (only B@0 sits on a different sheet than the rep on A).
    const a = atl('a.png', [sp('idle_0', 0), sp('idle_1', 32)]);
    const b = atl('b.png', [sp('idle_b', 0)]);
    const hashes = new Map<string, (string | null)[]>([
      ['a.png', ['h', 'h']],
      ['b.png', ['h']],
    ]);
    const m = buildMergeAliasMap([a, b], hashes, 2);
    expect(m.flat.map((f) => `${f.atlasName} ${f.sprite.name}`)).toEqual(['a.png idle_0', 'a.png idle_1', 'b.png idle_b']);
    expect(m.repOf).toEqual([0, 0, 0]); // every flat index points at flat 0 (a.png idle_0)
    expect(m.representatives).toEqual([0]);
    expect(m.aliasedFrames).toBe(2); // distinctRects(3) − 1
    expect(m.crossSheetFrames).toBe(1); // only b.png idle_b crossed a sheet boundary from the rep
  });

  it('T1: a per-atlas map UNDER-aliases vs the group map (the literal defect this fixes)', () => {
    // The SAME frame on two sheets: per-atlas clustering sees 1 frame per sheet ⇒ NO within-atlas dupe at all
    // (each sheet has a single distinct rect). Only the GROUP keyspace clusters them across sheets.
    const a = atl('a.png', [sp('shared', 0)]);
    const b = atl('b.png', [sp('shared', 0)]);
    const hashes = new Map<string, (string | null)[]>([['a.png', ['h']], ['b.png', ['h']]]);
    // per-atlas: each atlas alone has 1 sprite ⇒ no cluster ⇒ 0 aliased.
    expect(buildAtlasAliasMap(a.sprites, ['h'], 2).aliasedFrames).toBe(0);
    expect(buildAtlasAliasMap(b.sprites, ['h'], 2).aliasedFrames).toBe(0);
    // group: 2 distinct rects across sheets ⇒ gate(2) met ⇒ 1 aliased, 1 cross-sheet.
    const m = buildMergeAliasMap([a, b], hashes, 2);
    expect(m.aliasedFrames).toBe(1);
    expect(m.crossSheetFrames).toBe(1);
    expect(m.repOf).toEqual([0, 0]);
  });

  it('T1b (B1): two byte-identical frames at IDENTICAL (x,y,w,h) on DIFFERENT sheets count as 2 distinct rects', () => {
    // Both frames at (0,0,32,32) but on different textures — physically distinct copies. The ATLAS-QUALIFIED
    // key keeps them distinct ⇒ aliasedFrames === 1 (a BARE rectKey would wrongly collapse to 0).
    const a = atl('a.png', [sp('f', 0)]);
    const b = atl('b.png', [sp('f', 0)]); // same coords, different sheet
    const hashes = new Map<string, (string | null)[]>([['a.png', ['h']], ['b.png', ['h']]]);
    const m = buildMergeAliasMap([a, b], hashes, 2);
    expect(m.aliasedFrames).toBe(1);
    expect(m.crossSheetFrames).toBe(1);
  });

  it('within-atlas pre-aliased rect still collapses (same atlas + same coords ⇒ one unit, no double-count)', () => {
    // Sheet A has two names at the SAME rect (x=0) — a pre-aliased rect = ONE GPU region ⇒ one distinct unit.
    // Sheet B has one copy at x=0 (different sheet). Group distinct rects = {A@0, B@0} = 2 ⇒ gate(2) ⇒ 1 aliased.
    const a = atl('a.png', [sp('a0', 0), sp('a0_alias', 0)]); // same rect within A
    const b = atl('b.png', [sp('b0', 0)]);
    const hashes = new Map<string, (string | null)[]>([['a.png', ['h', 'h']], ['b.png', ['h']]]);
    const m = buildMergeAliasMap([a, b], hashes, 2);
    expect(m.aliasedFrames).toBe(1); // NOT 2 — the within-A pre-aliased pair collapses to one unit
    expect(m.crossSheetFrames).toBe(1);
    expect(m.repOf).toEqual([0, 0, 0]); // all three point at flat 0 (the lowest index of the rep rect)
  });

  it('T5 (carve-out): a sub-gate group (only 1 distinct cross-sheet rect) is NOT aliased', () => {
    // A single distinct rect across the group cannot meet gate=2 ⇒ identity.
    const a = atl('a.png', [sp('only', 0)]);
    const b = atl('b.png', [sp('other', 0)]);
    const hashes = new Map<string, (string | null)[]>([['a.png', ['x']], ['b.png', ['y']]]);
    const m = buildMergeAliasMap([a, b], hashes, 2);
    expect(m.aliasedFrames).toBe(0);
    expect(m.crossSheetFrames).toBe(0);
    expect(m.repOf).toEqual([0, 1]);
  });

  it('a missing/length-mismatched group sheet contributes null hashes (fail-safe, never clusters)', () => {
    const a = atl('a.png', [sp('idle_0', 0), sp('idle_1', 32)]);
    const b = atl('b.png', [sp('idle_b', 0)]);
    // b.png absent from hashes ⇒ its frame never clusters. a.png alone has 2 distinct rects same hash ⇒ gate(2).
    const hashes = new Map<string, (string | null)[]>([['a.png', ['h', 'h']]]);
    const m = buildMergeAliasMap([a, b], hashes, 2);
    expect(m.aliasedFrames).toBe(1); // only A's two frames cluster
    expect(m.crossSheetFrames).toBe(0); // both freed rects are on the SAME sheet as the rep (within A)
    expect(m.repOf).toEqual([0, 0, 2]); // b.png idle_b (flat 2) is its own rep
  });

  it('null hashes never cluster across sheets', () => {
    const a = atl('a.png', [sp('x', 0)]);
    const b = atl('b.png', [sp('y', 0)]);
    const hashes = new Map<string, (string | null)[]>([['a.png', [null]], ['b.png', [null]]]);
    const m = buildMergeAliasMap([a, b], hashes, 2);
    expect(m.aliasedFrames).toBe(0);
    expect(m.repOf).toEqual([0, 1]);
  });
});
