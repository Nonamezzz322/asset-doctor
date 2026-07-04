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
  setTrackAlphaModel,
  addToQueue,
  clearQueue,
  removeFromQueue,
  nextQueueIndex,
  queueEntryLoop,
  clampTrimStart,
  clampTrimEnd,
  trimWrapTrackTime,
  clampScrub,
  classifyEntityType,
  emptyEntityIndex,
  emptyEntitySelection,
  toggleEntity,
  selectAllEntities,
  clearEntities,
  toggleName,
  filterNames,
  DEBUG_ENTITY_TYPES,
  type SlotInfo,
  type TrackModel,
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
    expect(defaultTracks(null)).toEqual([{ index: 0, animation: '', loop: true, alpha: 1 }]);
  });
  it('a name ⇒ track 0 playing it, looping', () => {
    expect(defaultTracks('idle')).toEqual([{ index: 0, animation: 'idle', loop: true, alpha: 1 }]);
  });
});

describe('addTrackModel / removeTrackModel', () => {
  it('adds index 0 to an empty list', () => {
    expect(addTrackModel([])).toEqual([{ index: 0, animation: '', loop: true, alpha: 1 }]);
  });
  it('adds max+1 (never reuses a removed index)', () => {
    const t = addTrackModel([
      { index: 0, animation: 'a', loop: true, alpha: 1 },
      { index: 2, animation: 'b', loop: false, alpha: 1 },
    ]);
    expect(t[t.length - 1]!.index).toBe(3);
  });
  it('removes the track with the given index', () => {
    const t = removeTrackModel(
      [
        { index: 0, animation: 'a', loop: true, alpha: 1 },
        { index: 2, animation: 'b', loop: false, alpha: 1 },
      ],
      2,
    );
    expect(t.map((x) => x.index)).toEqual([0]);
  });
});

describe('isEmptyTrack', () => {
  it('true when the animation is blank, false otherwise', () => {
    expect(isEmptyTrack({ index: 0, animation: '', loop: true, alpha: 1 })).toBe(true);
    expect(isEmptyTrack({ index: 0, animation: 'idle', loop: true, alpha: 1 })).toBe(false);
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

// ── Phase A: playback parity ────────────────────────────────────────────────

describe('setTrackAlphaModel', () => {
  const tracks: TrackModel[] = [
    { index: 0, animation: 'a', loop: true, alpha: 1 },
    { index: 2, animation: 'b', loop: false, alpha: 0.5 },
  ];
  it('sets only the target track, clamped to [0,1]', () => {
    expect(setTrackAlphaModel(tracks, 2, 0.25)[1]!.alpha).toBe(0.25);
    expect(setTrackAlphaModel(tracks, 2, 0.25)[0]!.alpha).toBe(1);
    expect(setTrackAlphaModel(tracks, 0, 5)[0]!.alpha).toBe(1);
    expect(setTrackAlphaModel(tracks, 0, -1)[0]!.alpha).toBe(0);
  });
});

describe('addToQueue / clearQueue', () => {
  it('appends in order, duplicates allowed (a playlist may repeat)', () => {
    expect(addToQueue([], 'run')).toEqual(['run']);
    expect(addToQueue(['run'], 'jump')).toEqual(['run', 'jump']);
    expect(addToQueue(['run'], 'run')).toEqual(['run', 'run']);
  });
  it('clearQueue returns an empty list', () => {
    expect(clearQueue()).toEqual([]);
  });
});

describe('removeFromQueue', () => {
  it('removing BEFORE the cursor shifts it down', () => {
    expect(removeFromQueue(['a', 'b', 'c'], 0, 2)).toEqual({ queue: ['b', 'c'], index: 1 });
  });
  it('removing the CURRENTLY-PLAYING mid-queue entry decrements, so its complete plays the shifted-in successor (never skipped)', () => {
    // b playing (cursor 1); remove b ⇒ cursor 0 ⇒ b's complete advances 0→1 = 'c'.
    expect(removeFromQueue(['a', 'b', 'c'], 1, 1)).toEqual({ queue: ['a', 'c'], index: 0 });
  });
  it('removing the playing FIRST entry drops the cursor to -1, so its complete starts the new first', () => {
    expect(removeFromQueue(['a', 'b', 'c'], 0, 0)).toEqual({ queue: ['b', 'c'], index: -1 });
  });
  it('removing the cursor at the end decrements to the new last', () => {
    expect(removeFromQueue(['a', 'b', 'c'], 2, 2)).toEqual({ queue: ['a', 'b'], index: 1 });
  });
  it('removing AFTER the cursor leaves it alone', () => {
    expect(removeFromQueue(['a', 'b', 'c'], 2, 0)).toEqual({ queue: ['a', 'b'], index: 0 });
  });
  it('a parked cursor (=== length) stays parked after a removal', () => {
    expect(removeFromQueue(['a', 'b'], 0, 2)).toEqual({ queue: ['b'], index: 1 });
  });
  it('emptying the queue parks the cursor at -1', () => {
    expect(removeFromQueue(['a'], 0, 0)).toEqual({ queue: [], index: -1 });
  });
});

describe('nextQueueIndex', () => {
  it('advances sequentially; at the end wraps when queue-loop is on, else parks at length (finished ≠ not-started)', () => {
    expect(nextQueueIndex(-1, 3, false)).toBe(0);
    expect(nextQueueIndex(0, 3, false)).toBe(1);
    expect(nextQueueIndex(2, 3, false)).toBe(3); // parked-finished sentinel — NOT -1 (the looping last entry completes every cycle)
    expect(nextQueueIndex(2, 3, true)).toBe(0);
    expect(nextQueueIndex(5, 0, true)).toBe(-1);
  });
});

describe('queueEntryLoop', () => {
  it('only the LAST entry loops, and only when queue-loop is OFF (upstream parity)', () => {
    expect(queueEntryLoop(2, 3, false)).toBe(true);
    expect(queueEntryLoop(2, 3, true)).toBe(false);
    expect(queueEntryLoop(1, 3, false)).toBe(false);
  });
});

describe('trim clamps + wrap', () => {
  it('clampTrimStart keeps [0, end]', () => {
    expect(clampTrimStart(-1, 2)).toBe(0);
    expect(clampTrimStart(3, 2)).toBe(2);
    expect(clampTrimStart(1, 2)).toBe(1);
  });
  it('clampTrimEnd keeps [start, duration]', () => {
    expect(clampTrimEnd(0, 1, 5)).toBe(1);
    expect(clampTrimEnd(9, 1, 5)).toBe(5);
    expect(clampTrimEnd(3, 1, 5)).toBe(3);
  });
  it('trimWrapTrackTime: null before the end, rewind-to-start at/after it', () => {
    expect(trimWrapTrackTime(1.0, 1.0, 0.5, 2.5)).toBeNull();
    expect(trimWrapTrackTime(3.0, 3.0, 0.5, 2.5)).toBe(0.5);
  });
});

describe('clampScrub', () => {
  it('clamps into [0, duration]', () => {
    expect(clampScrub(-1, 3)).toBe(0);
    expect(clampScrub(5, 3)).toBe(3);
    expect(clampScrub(2, 3)).toBe(2);
  });
});

// ── Phase B: granular entity model ──────────────────────────────────────────

describe('classifyEntityType', () => {
  it('maps each of the five drawable classes to its bucket', () => {
    expect(classifyEntityType(mk(MeshAttachment))).toBe('meshes');
    expect(classifyEntityType(mk(RegionAttachment))).toBe('regionAttachments');
    expect(classifyEntityType(mk(PathAttachment))).toBe('paths');
    expect(classifyEntityType(mk(BoundingBoxAttachment))).toBe('boundingBoxes');
    expect(classifyEntityType(mk(ClippingAttachment))).toBe('clipping');
  });
  it('point / null / unknown ⇒ null (not drawable as a granular entity)', () => {
    expect(classifyEntityType(mk(PointAttachment))).toBeNull();
    expect(classifyEntityType(null)).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(classifyEntityType({} as any)).toBeNull();
  });
});

describe('toggleEntity / selectAllEntities / clearEntities', () => {
  it('toggles in the right bucket; untouched buckets keep identity; returns a new reference', () => {
    const sel = emptyEntitySelection();
    const next = toggleEntity(sel, 'meshes', 'body/skin');
    expect(next).not.toBe(sel);
    expect(next.meshes).toEqual(['body/skin']);
    expect(next.regionAttachments).toBe(sel.regionAttachments);
    expect(next.paths).toBe(sel.paths);
    const off = toggleEntity(next, 'meshes', 'body/skin');
    expect(off.meshes).toEqual([]);
  });
  it('selectAll replaces the bucket; clear empties it', () => {
    const sel = selectAllEntities(emptyEntitySelection(), 'clipping', ['a/x', 'b/y']);
    expect(sel.clipping).toEqual(['a/x', 'b/y']);
    expect(clearEntities(sel, 'clipping').clipping).toEqual([]);
  });
});


describe('emptyEntityIndex', () => {
  it('has an empty list for each of the five buckets', () => {
    const idx = emptyEntityIndex();
    for (const ty of DEBUG_ENTITY_TYPES) expect(idx[ty]).toEqual([]);
  });
});

describe('toggleName', () => {
  it('adds then removes, order-preserving', () => {
    expect(toggleName([], 'hip')).toEqual(['hip']);
    expect(toggleName(['hip'], 'spine')).toEqual(['hip', 'spine']);
    expect(toggleName(['hip', 'spine'], 'hip')).toEqual(['spine']);
  });
});

describe('filterNames', () => {
  it('case-insensitive substring; blank ⇒ all', () => {
    expect(filterNames(['Hip', 'spine', 'arm-L'], 'IP')).toEqual(['Hip']);
    expect(filterNames(['Hip', 'spine', 'arm-L'], '')).toHaveLength(3);
  });
});
