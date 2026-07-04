// Node-unit tests for the PURE Spine inspector model (spine-inspect.ts). spine-core is zero-dependency pure
// TS (no DOM), so the `instanceof` classifier runs under vitest/node. We build attachments via
// `Object.create(Cls.prototype)` — this makes `x instanceof Cls` true WITHOUT invoking the real constructor
// (the ctors need a name + a VertexAttachment sequence and have side effects we do not want in a unit test).

import { describe, expect, it } from 'vitest';
import {
  MeshAttachment,
  RegionAttachment,
  ClippingAttachment,
  BoundingBoxAttachment,
  PathAttachment,
  PointAttachment,
} from '@esotericsoftware/spine-core';
import {
  classifyAttachment,
  filterSlotInfos,
  defaultTracks,
  addTrackModel,
  removeTrackModel,
  isEmptyTrack,
  toggleSkin,
  type SlotInfo,
} from './spine-inspect';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mk = (C: any) => Object.create(C.prototype);

describe('classifyAttachment', () => {
  it('maps each concrete attachment class to its kind', () => {
    expect(classifyAttachment(mk(MeshAttachment))).toBe('mesh');
    expect(classifyAttachment(mk(RegionAttachment))).toBe('region');
    expect(classifyAttachment(mk(ClippingAttachment))).toBe('clip');
    expect(classifyAttachment(mk(BoundingBoxAttachment))).toBe('bbox');
    expect(classifyAttachment(mk(PathAttachment))).toBe('path');
    expect(classifyAttachment(mk(PointAttachment))).toBe('point');
  });
  it('null ⇒ none', () => {
    expect(classifyAttachment(null)).toBe('none');
  });
  it('an unknown object ⇒ other', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(classifyAttachment({} as any)).toBe('other');
  });
});

describe('filterSlotInfos', () => {
  const all: SlotInfo[] = [
    { name: 'left-arm', kind: 'mesh' },
    { name: 'right-arm', kind: 'region' },
    { name: 'head', kind: 'none' },
  ];
  it('narrows by case-insensitive substring', () => {
    expect(filterSlotInfos(all, 'arm').map((s) => s.name)).toEqual(['left-arm', 'right-arm']);
    expect(filterSlotInfos(all, 'ARM').map((s) => s.name)).toEqual(['left-arm', 'right-arm']);
    expect(filterSlotInfos(all, 'head').map((s) => s.name)).toEqual(['head']);
  });
  it('a blank query returns all', () => {
    expect(filterSlotInfos(all, '')).toHaveLength(3);
  });
});

describe('defaultTracks', () => {
  it('null ⇒ a single Empty track 0', () => {
    expect(defaultTracks(null)).toEqual([{ index: 0, animation: '', loop: true }]);
  });
  it('a name ⇒ track 0 playing it, looping', () => {
    expect(defaultTracks('idle')).toEqual([{ index: 0, animation: 'idle', loop: true }]);
  });
});

describe('addTrackModel / removeTrackModel', () => {
  it('adds index 0 to an empty list', () => {
    expect(addTrackModel([])).toEqual([{ index: 0, animation: '', loop: true }]);
  });
  it('adds max+1 (never reuses a removed index)', () => {
    const t = addTrackModel([
      { index: 0, animation: 'a', loop: true },
      { index: 2, animation: 'b', loop: false },
    ]);
    expect(t[t.length - 1]!.index).toBe(3);
  });
  it('removes the track with the given index', () => {
    const t = removeTrackModel(
      [
        { index: 0, animation: 'a', loop: true },
        { index: 2, animation: 'b', loop: false },
      ],
      2,
    );
    expect(t.map((x) => x.index)).toEqual([0]);
  });
});

describe('isEmptyTrack', () => {
  it('true when the animation is blank, false otherwise', () => {
    expect(isEmptyTrack({ index: 0, animation: '', loop: true })).toBe(true);
    expect(isEmptyTrack({ index: 0, animation: 'idle', loop: true })).toBe(false);
  });
});

describe('toggleSkin', () => {
  it('adds a skin, in skeleton order', () => {
    expect(toggleSkin([], 'b', ['a', 'b', 'c'])).toEqual(['b']);
    expect(toggleSkin(['a', 'c'], 'b', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('removes an already-selected skin', () => {
    expect(toggleSkin(['a', 'b'], 'b', ['a', 'b', 'c'])).toEqual(['a']);
  });
});
