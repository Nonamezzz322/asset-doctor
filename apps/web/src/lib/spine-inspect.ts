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

/** A React-owned track row. `animation === ''` means the track is Empty (mixed out via setEmptyAnimation). */
export interface TrackModel {
  index: number;
  animation: string;
  loop: boolean;
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
  return [{ index: 0, animation: firstAnimation ?? '', loop: true }];
}

/** Append a fresh Empty track with a never-reused index (max existing index + 1) so React keys stay stable
 *  even after removals. */
export function addTrackModel(tracks: TrackModel[]): TrackModel[] {
  const next = tracks.length === 0 ? 0 : Math.max(...tracks.map((t) => t.index)) + 1;
  return [...tracks, { index: next, animation: '', loop: true }];
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
