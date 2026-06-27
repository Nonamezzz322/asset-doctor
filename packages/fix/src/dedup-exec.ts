// PURE owner-aware dedup EXECUTION helpers (design §3d / §10.8). The worker's owner-aware drops repoint a
// consumer's references at the OWNER's FINAL emitted name — but an owner can itself be transcoded (renamed
// by extension) in the same run, so the consumer would otherwise dangle against a pre-rename filename.
//
// The TWO-PHASE contract solves this: BEFORE executing anything, predict every retained owner's FINAL
// name from the PLAN (Phase A, this module — pure: the rename rule is a deterministic function of op kind
// + the per-owner target mime); execute transforms and record each owner's ACTUAL emitted name (Phase B,
// impure worker); then repoint consumers against the actual map, KEEPING the consumer (never dangling) if
// an owner's actual name diverged from the prediction (Phase C, impure worker).
//
// These helpers are browser-API-free (no canvas, no createImageBitmap, no network) and are the SINGLE
// source of truth for the rename rule + the Phase-A prediction, so the worker and its Node round-trip test
// can't drift. Vitest-covered (packages/fix/test) + driven through the worker's Node harness.

import type { DedupGroup, FixOp, ImageMime } from '@asset-doctor/core';

/** Target-mime → file extension (the only rename a transcode produces). Single source of truth for the
 *  worker's loose-image / owner rename; mirrors the worker's emitted-name mechanics exactly. */
export const EXT: Readonly<Record<ImageMime, string>> = {
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

/** Swap a POSIX path's final-segment extension for the target mime's, preserving the directory. Pure
 *  string math — the exact rename the worker applies to a transcoded image (and an owner). Unknown mime
 *  ⇒ '.webp' (matches the worker's `EXT[mime] ?? '.webp'` fallback). */
export const renamedTo = (path: string, mime: ImageMime): string => {
  const ext = EXT[mime] ?? '.webp';
  return path.replace(/[^/]+$/, (seg) => seg.replace(/\.[a-z0-9]+$/i, ext));
};

/** A retained owner's FINAL emitted name(s): the image always, the manifest when the owner is an atlas. */
export interface OwnerFinalName {
  image: string;
  manifest?: string;
}

/** What the plan predicts will happen to one owner ref. The worker supplies these by looking the owner up
 *  in `plan.ops` / its path+manifest maps — kept as plain data so this stays browser-API-free. */
export interface OwnerPlanInput {
  /** The owner's current (pre-transform) emitted image path. Absent ⇒ owner has no known path (skipped). */
  imagePath?: string;
  /** The owner's manifest path, when it is an atlas (image+manifest pair). */
  manifestPath?: string;
  /** True iff the plan emits a `transcode` op for this owner (the ONLY rename-producing op that can hit a
   *  retained owner — owners are protected from repack/resize/merge in plan.ts). */
  transcoded: boolean;
  /** The EFFECTIVE target mime for that transcode (per-folder/type overrides may redirect it), so the
   *  prediction matches the actual encode. Only consulted when `transcoded` is true. */
  targetMime: ImageMime;
}

/**
 * PHASE A — predict every retained owner's FINAL emitted name from the plan (pure, deterministic).
 *
 * Collects the owner refs from the dedup groups, then maps each to its predicted final name: a transcoded
 * owner's image follows its target-mime extension (renamedTo); every other owner keeps its original path.
 * Owners without a known image path are omitted (the worker keeps the consumer if its owner is missing).
 *
 * `lookup(ref)` returns the per-owner plan facts (path/manifest/transcode-target) the worker already has;
 * keeping it a callback lets the worker pass its maps without this module touching them.
 */
export function predictOwnerFinalNames(
  groups: readonly DedupGroup[] | undefined,
  lookup: (ref: string) => OwnerPlanInput,
): Map<string, OwnerFinalName> {
  const ownerRefs = new Set<string>();
  for (const g of groups ?? []) for (const o of g.owners) ownerRefs.add(o);

  const out = new Map<string, OwnerFinalName>();
  for (const ref of ownerRefs) {
    const info = lookup(ref);
    if (!info.imagePath) continue;
    const image = info.transcoded ? renamedTo(info.imagePath, info.targetMime) : info.imagePath;
    out.set(ref, info.manifestPath ? { image, manifest: info.manifestPath } : { image });
  }
  return out;
}

/** True iff a FixOp is an owner-aware dedup drop (carries `ownerRef`) — the ops Phase C executes. Narrows
 *  to the drop variant so callers get `assetRef`/`ownerRef`/`repointManifest` without a manual cast. */
export const isOwnerAwareDrop = (op: FixOp): op is Extract<FixOp, { kind: 'drop' }> =>
  op.kind === 'drop' && op.ownerRef != null;
