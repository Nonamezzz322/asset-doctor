// PURE, Node-testable Spine INSPECTOR model — ZERO Pixi / DOM. It imports the attachment CLASSES from
// spine-core (the same zero-dependency singletons that spine-pixi-v8 re-exports; pnpm dedupes spine-core@4.3.9)
// only to `instanceof`-classify a slot's live attachment, and otherwise is plain data transforms over the
// React-owned track/skin/slot models. The imperative Pixi glue (spine-engine.ts) calls `classifyAttachment`
// verbatim; SpineViewer.tsx uses the filter/track/skin helpers. Keeping the classification + model logic here
// (not in the engine) satisfies the repo rule "PURE ⇒ Node-tested" — spine-inspect.test.ts exercises every
// export without a browser (spine-core is DOM-free, so the `instanceof` ladder runs under vitest/node).

import {
  MeshAttachment,
  RegionAttachment,
  ClippingAttachment,
  BoundingBoxAttachment,
  PathAttachment,
  PointAttachment,
  type Attachment,
} from '@esotericsoftware/spine-core';

/** The attachment kinds we surface as slot badges. `none` ⇒ the slot has no attachment in the current pose;
 *  `other` is an honest fallback for any future attachment type we do not (yet) name. */
export type AttachmentKind = 'mesh' | 'region' | 'clip' | 'bbox' | 'path' | 'point' | 'none' | 'other';

/** One row of the Slots index: the slot's name (data-derived, rendered verbatim) + its classified kind. */
export interface SlotInfo {
  name: string;
  kind: AttachmentKind;
}

/** A React-owned track row. `animation === ''` means the track is Empty (mixed out via setEmptyAnimation).
 *  `alpha` mirrors TrackEntry.alpha (1 = fully applied; lower values blend the track's pose in partially). */
export interface TrackModel {
  index: number;
  animation: string;
  loop: boolean;
  alpha: number;
}

/** Classify a live attachment by its runtime class. The six concrete attachment classes are leaf siblings, so
 *  the `instanceof` order is unambiguous; mesh is checked before region only for readability (they are not in
 *  a subclass relation). Attachment identity is constraint-invariant, so this is deterministic once the
 *  skeleton's world transform has been applied (the engine forces a sync updateWorldTransform before calling). */
export function classifyAttachment(att: Attachment | null): AttachmentKind {
  if (att == null) return 'none';
  if (att instanceof MeshAttachment) return 'mesh';
  if (att instanceof RegionAttachment) return 'region';
  if (att instanceof ClippingAttachment) return 'clip';
  if (att instanceof BoundingBoxAttachment) return 'bbox';
  if (att instanceof PathAttachment) return 'path';
  if (att instanceof PointAttachment) return 'point';
  return 'other';
}

/** Case-insensitive substring filter over the slot index (parity with spine-files' filterSlots, but over the
 *  richer SlotInfo rows). A blank query returns all. */
export function filterSlotInfos(all: SlotInfo[], q: string): SlotInfo[] {
  const s = q.toLowerCase();
  return all.filter((x) => x.name.toLowerCase().includes(s));
}

/** The initial track model on load: one track (0) playing the first animation, looping (or Empty if the
 *  skeleton has no animations). */
export function defaultTracks(firstAnimation: string | null): TrackModel[] {
  return [{ index: 0, animation: firstAnimation ?? '', loop: true, alpha: 1 }];
}

/** Append a fresh Empty track with a never-reused index (max existing index + 1) so React keys stay stable
 *  even after removals. */
export function addTrackModel(tracks: TrackModel[]): TrackModel[] {
  const next = tracks.length === 0 ? 0 : Math.max(...tracks.map((t) => t.index)) + 1;
  return [...tracks, { index: next, animation: '', loop: true, alpha: 1 }];
}

/** Drop the track with the given index. */
export function removeTrackModel(tracks: TrackModel[], index: number): TrackModel[] {
  return tracks.filter((t) => t.index !== index);
}

/** A track is "empty" (mixed out) when it has no animation selected. */
export function isEmptyTrack(t: TrackModel): boolean {
  return t.animation === '';
}

/** Toggle a skin in/out of the combined selection, returning the result in SKELETON skin order (so the
 *  combined Skin is assembled deterministically regardless of click order). */
export function toggleSkin(selected: string[], name: string, allInOrder: string[]): string[] {
  const set = new Set(selected);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  return allInOrder.filter((n) => set.has(n));
}

// ── Phase A: playback parity (queue · trim · scrub · track alpha) — all PURE list/number transforms. ──

/** Set one track's alpha (clamped to [0,1]); every other row keeps its identity (map-replace). */
export function setTrackAlphaModel(tracks: TrackModel[], index: number, alpha: number): TrackModel[] {
  const a = Math.max(0, Math.min(1, alpha));
  return tracks.map((t) => (t.index === index ? { ...t, alpha: a } : t));
}

/** Append an animation to the playlist. Duplicates are allowed — a playlist may repeat an entry. */
export function addToQueue(queue: string[], name: string): string[] {
  return [...queue, name];
}

/** An emptied playlist. */
export function clearQueue(): string[] {
  return [];
}

/** Remove the entry at `removeAt`, reconciling the cursor so the NEXT `complete` advances correctly:
 *  removing at-or-before the cursor shifts it down by one — including removing the CURRENTLY-PLAYING entry
 *  (the removed animation keeps playing to completion, and `cursor-1 + 1` then lands exactly on the entry
 *  that shifted into its place — nothing is skipped, nothing freezes). A parked cursor (=== length, see
 *  nextQueueIndex) stays parked (length-1 === the new length). Emptying the queue parks at -1. */
export function removeFromQueue(queue: string[], removeAt: number, current: number): { queue: string[]; index: number } {
  const next = queue.filter((_, i) => i !== removeAt);
  let index = current;
  if (index >= 0 && removeAt <= index) index--;
  if (next.length === 0) index = -1;
  return { queue: next, index };
}

/** The queue cursor after a track-0 `complete`: advance sequentially; at the end wrap to 0 iff queue-loop is
 *  on, else park at `length` — a FINISHED sentinel deliberately distinct from the not-yet-started -1. The
 *  distinction is load-bearing: the last entry is left LOOPING (upstream parity) and spine-core fires
 *  `complete` on EVERY loop cycle, so an ambiguous -1 would restart the whole queue each cycle. */
export function nextQueueIndex(current: number, length: number, loop: boolean): number {
  if (length === 0) return -1;
  const next = current + 1;
  if (next < length) return next;
  return loop ? 0 : length;
}

/** Whether the queue entry at `index` should be set LOOPING when started: only the last entry, and only when
 *  queue-loop is OFF (`isLast && !queueLoop` — upstream verbatim; a looping queue never loops one entry). */
export function queueEntryLoop(index: number, length: number, queueLoop: boolean): boolean {
  return index === length - 1 && !queueLoop;
}

/** Clamp a trim-start slider value into [0, end] (start can never pass end). */
export function clampTrimStart(val: number, end: number): number {
  return Math.max(0, Math.min(val, end));
}

/** Clamp a trim-end slider value into [start, duration] (end can never pass the animation duration). */
export function clampTrimEnd(val: number, start: number, duration: number): number {
  return Math.max(start, Math.min(val, duration));
}

/** The trim ticker wrap: when the animation time reaches `end`, rewind trackTime so the animation time lands
 *  back on `start` (upstream: `trackTime -= (t - trimStart)`); null ⇒ no wrap needed this frame. */
export function trimWrapTrackTime(animTime: number, trackTime: number, start: number, end: number): number | null {
  if (animTime < end) return null;
  return trackTime - (animTime - start);
}

/** Clamp a scrub target into [0, duration]. */
export function clampScrub(time: number, duration: number): number {
  return Math.max(0, Math.min(time, duration));
}

// ── Phase B: granular per-entity debug model (classification · selection · filters). ──

/** The five per-entity debug buckets. Key names double as i18n suffixes (`spine.debug.gran.<type>`). */
export type DebugEntityType = 'regionAttachments' | 'meshes' | 'paths' | 'boundingBoxes' | 'clipping';
export const DEBUG_ENTITY_TYPES: DebugEntityType[] = ['regionAttachments', 'meshes', 'paths', 'boundingBoxes', 'clipping'];

/** All `slot/attachment` keys present in the skeleton, per bucket — built once at load (engine-side). */
export type EntityIndex = Record<DebugEntityType, string[]>;
/** The React-owned selection: which keys of each bucket are highlighted. */
export type EntitySelection = Record<DebugEntityType, string[]>;

export function emptyEntityIndex(): EntityIndex {
  return { regionAttachments: [], meshes: [], paths: [], boundingBoxes: [], clipping: [] };
}

export function emptyEntitySelection(): EntitySelection {
  return { regionAttachments: [], meshes: [], paths: [], boundingBoxes: [], clipping: [] };
}

/** Classify an attachment into its granular debug bucket (or null for point/unknown/none). KEEP ADJACENT to
 *  classifyAttachment above — same `instanceof` discipline over the same spine-core leaf classes, no drift. */
export function classifyEntityType(att: Attachment | null): DebugEntityType | null {
  if (att == null) return null;
  if (att instanceof MeshAttachment) return 'meshes';
  if (att instanceof RegionAttachment) return 'regionAttachments';
  if (att instanceof PathAttachment) return 'paths';
  if (att instanceof BoundingBoxAttachment) return 'boundingBoxes';
  if (att instanceof ClippingAttachment) return 'clipping';
  return null;
}

/** Toggle one key in one bucket; untouched buckets keep their identity (cheap React diffing). */
export function toggleEntity(sel: EntitySelection, type: DebugEntityType, key: string): EntitySelection {
  return { ...sel, [type]: toggleName(sel[type], key) };
}

/** Select every key of one bucket (the All button). */
export function selectAllEntities(sel: EntitySelection, type: DebugEntityType, keys: string[]): EntitySelection {
  return { ...sel, [type]: [...keys] };
}

/** Clear one bucket (the None button). */
export function clearEntities(sel: EntitySelection, type: DebugEntityType): EntitySelection {
  return { ...sel, [type]: [] };
}

/** Toggle a name in a plain list (bones AND entity keys), order-preserving on add. */
export function toggleName(list: string[], name: string): string[] {
  return list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
}

/** Case-insensitive substring filter over data-derived names; a blank query returns all. */
export function filterNames(names: string[], q: string): string[] {
  const s = q.toLowerCase();
  return names.filter((n) => n.toLowerCase().includes(s));
}
