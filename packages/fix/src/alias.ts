// Frame-redundancy aliasing (round19) — the PURE half of the fix. Given a merged atlas's sprite list and
// the host-computed per-sprite region hashes (index-aligned, `null` = host-skipped flat region / read
// failure, NEVER clustered), decide which sprites are byte-identical DUPLICATES that can share ONE packed
// region. We pack ONE representative per cluster and ALIAS every other name onto its final rect — every
// original frame name still resolves in the emitted manifest, but the pixels are written ONCE.
//
// This MIRRORS the detector's clustering byte-for-byte (packages/analysis frameRedundancyFinding,
// rules.ts:182-228): cluster sprite INDICES by region hash; within a cluster collapse names that already
// alias the IDENTICAL packed rect (x,y,w,h) — a pre-aliased Spine/TP sheet is already ONE region on the GPU,
// so it contributes ONE distinct unit, never an inflated count; gate on `distinctRects >= minDistinctRects`;
// representative = the lowest sprite index of the cluster's FIRST distinct rect (= the detector's "kept"
// frame). The result `aliasedFrames` therefore EQUALS the finding's `dupes` for the same inputs (the honesty
// pin). Pure integer math — deterministic, no time/RNG.

import type { Atlas, Rect, Sprite } from '@asset-doctor/core';

/** Per-atlas aliasing decision, keyed to a single Atlas (the merged-atlas name the hashes were computed on).
 *  - `repOf[i]` = the REPRESENTATIVE sprite index that sprite i shares a packed region with. For a sprite that
 *    is its own representative (kept), `repOf[i] === i`. For an aliased duplicate it is the representative's
 *    index. For a sprite that is NOT in any qualifying cluster (a distinct frame, a null hash, a sub-gate
 *    cluster) it is its OWN index (`repOf[i] === i`) — it packs normally.
 *  - `representatives` = the ascending list of indices that get a real PackItem + Blit (one per representative).
 *  - `aliasedFrames` = the number of sprites that were aliased (Σ distinctRects − 1 over qualifying clusters) =
 *    the detector's `dupes`. */
export interface AtlasAliasMap {
  repOf: number[];
  representatives: number[];
  aliasedFrames: number;
}

const rectKey = (r: Rect): string => `${r.x},${r.y},${r.w},${r.h}`;

/**
 * Build the aliasing decision for one atlas. `sprites` is the atlas's sprite list (the SAME list, in the SAME
 * order, the hashes were computed against); `frameHashes` is index-aligned (or shorter/longer ⇒ no aliasing,
 * fail-safe identity). `minDistinctRects` is the detector's `frameRedundancy.minDuplicates` gate. Returns the
 * IDENTITY map (every sprite its own representative, `aliasedFrames === 0`) when there is no qualifying cluster
 * or on any defensive bail — so an absent/mismatched/sub-gate input is byte-identical to packing every sprite.
 *
 * DROP-IN: only the RECT is shared. The caller copies trim/pivot/sourceSize/spriteSourceSize/rotated from each
 * alias's OWN source sprite, so per-name geometry stays correct; only the pixels (one Blit per representative)
 * are de-duplicated.
 */
export function buildAtlasAliasMap(
  sprites: Sprite[],
  frameHashes: (string | null)[] | undefined,
  minDistinctRects: number,
): AtlasAliasMap {
  const n = sprites.length;
  const repOf = sprites.map((_, i) => i); // identity by default — every sprite packs itself
  // Defensive: a mismatched/absent hash list means the dep is stale/desynced — bail to identity (additive,
  // byte-identical). Same guard the detector uses (rules.ts:180).
  if (!frameHashes || frameHashes.length !== n || minDistinctRects < 1) {
    return { repOf, representatives: repOf.slice(), aliasedFrames: 0 };
  }

  // Cluster sprite INDICES by region hash (skip nulls — a host-skipped flat region never clusters). Insertion
  // order is ascending (we iterate in order), so each cluster's index list is sorted (matches the detector).
  const clusters = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const h = frameHashes[i];
    if (h == null) continue;
    const g = clusters.get(h) ?? [];
    g.push(i);
    clusters.set(h, g);
  }

  let aliasedFrames = 0;
  // Deterministic cluster ordering: by the first (lowest) sprite index — matches the detector's `ordered`.
  const ordered = [...clusters.values()].sort((a, b) => a[0]! - b[0]!);
  for (const indices of ordered) {
    // DISTINCT-RECT GUARD: collapse names that already alias the SAME packed rect — one distinct unit. A
    // pre-aliased source rect must NEVER double-count (mirrors rules.ts:204-211 exactly).
    const byRect = new Map<string, number[]>();
    for (const i of indices) {
      const key = rectKey(sprites[i]!.frame);
      const g = byRect.get(key) ?? [];
      g.push(i);
      byRect.set(key, g);
    }
    const distinctRects = byRect.size;
    if (distinctRects < minDistinctRects) continue; // not enough genuinely-distinct dupes — pack normally

    // Distinct rects ordered by their lowest index. The representative is the FIRST distinct rect's lowest
    // index (= the detector's "kept" frame). EVERY sprite in this cluster — including names that alias the
    // representative's OWN rect — points at that one representative index, so its pixels are written once.
    const distinctOrdered = [...byRect.values()].sort((a, b) => a[0]! - b[0]!);
    const repIndex = distinctOrdered[0]![0]!;
    for (const i of indices) repOf[i] = repIndex;
    aliasedFrames += distinctRects - 1;
  }

  // Representatives = indices that are their own rep, in ascending order (deterministic pack/emit order).
  const representatives: number[] = [];
  for (let i = 0; i < n; i++) if (repOf[i] === i) representatives.push(i);
  return { repOf, representatives, aliasedFrames };
}

/** Convenience for the worker: build a per-atlas alias map keyed by Atlas.name from a frame-hash lookup.
 *  Skips atlases with no hash entry (identity ⇒ no aliasing). The returned map only contains atlases that
 *  ACTUALLY alias ≥1 frame, so an atlas with no duplicates is absent ⇒ repackAtlases falls through to today's
 *  byte-identical path for it. */
export function buildAtlasAliasMaps(
  atlases: Atlas[],
  frameHashByRef: Map<string, (string | null)[]>,
  minDistinctRects: number,
): Map<string, AtlasAliasMap> {
  const out = new Map<string, AtlasAliasMap>();
  for (const a of atlases) {
    const hashes = frameHashByRef.get(a.name);
    if (!hashes) continue;
    const m = buildAtlasAliasMap(a.sprites, hashes, minDistinctRects);
    if (m.aliasedFrames > 0) out.set(a.name, m);
  }
  return out;
}
