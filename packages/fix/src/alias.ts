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

/** Cross-atlas merge alias map (round22 #1) — the WHOLE-GROUP analogue of AtlasAliasMap. Where AtlasAliasMap
 *  indexes ONE atlas's `sprites`, this indexes a FLAT list spanning EVERY atlas in a merge group, in the order
 *  `buildMergeAliasMap` flattened them (atlases in the given order, sprites in index order). The flat index `f`
 *  identifies one (atlas, sprite) pair; `flat[f]` carries that pair so the repack can resolve the alias's OWN
 *  atlasRef + sprite (its OWN trim/pivot/sourceSize) while sharing the representative's packed rect.
 *  - `repOf[f]` = the FLAT index of the representative `f` shares a packed region with (`repOf[f] === f` ⇒ own rep).
 *  - `representatives` = ascending flat indices that get a real PackItem + Blit (one per cross-sheet cluster rep).
 *  - `aliasedFrames` = Σ(distinctRects − 1) over QUALIFYING clusters (atlas-qualified distinct-rect guard).
 *  - `crossSheetFrames` = the subset of `aliasedFrames` whose alias sat on a DIFFERENT sheet than its rep — the
 *    honest "cross-sheet frames deduped" count (a within-atlas dupe is already frameRedundancy's job, NOT this). */
export interface MergeAliasMap {
  flat: { atlasName: string; sprite: Sprite }[];
  repOf: number[];
  representatives: number[];
  aliasedFrames: number;
  crossSheetFrames: number;
}

/**
 * Build the WHOLE-GROUP aliasing decision for an atlas MERGE (round22 #1). Clusters byte-identical region hashes
 * across EVERY atlas in `group` in ONE flat (atlasName, frameName) key space, so a frame that is byte-identical
 * between sheet A and sheet B is packed ONCE and every duplicate name (across all merged sheets) is aliased onto
 * that one region. `frameHashByRef` is keyed by Atlas.name (the SAME index-aligned hashes the within-atlas path
 * + the cross-atlas DETECTOR use). `minDistinctRects` is the detector's `crossAtlasRedundancy.minDuplicates` gate
 * (counts CROSS-SHEET DUPLICATE COPIES — distinct units beyond the one kept).
 *
 * DISTINCT-RECT GUARD — ATLAS-QUALIFIED (the ONE difference from the within-atlas map, mirrors the cross-atlas
 * detector rules.ts:365): the distinct-rect key is `${atlasName}|${x},${y},${w},${h}`. Two byte-identical frames
 * at coincidentally-equal (x,y,w,h) coords on DIFFERENT sheets are TWO physically distinct copies on two textures
 * ⇒ TWO distinct rects (correct: each pins its own sheet area). Two names at the SAME rect within ONE atlas (a
 * pre-aliased Spine/TP sheet = one GPU region) still collapse to ONE unit (same atlas + same coords ⇒ one key) —
 * so a pre-aliased rect never double-counts. The within-atlas `buildAtlasAliasMap` reuses the bare rectKey because
 * its scope is a single atlas; here the qualification is load-bearing (B1).
 *
 * Returns the IDENTITY map (every flat index its own rep, `aliasedFrames === 0`) when no qualifying cross-sheet
 * cluster exists OR on any defensive bail (a group atlas missing/length-mismatched hashes ⇒ that atlas's frames
 * never cluster, fail-safe identity for it). DROP-IN: only the RECT is shared; the caller copies each alias's OWN
 * geometry, so every original frame name from every merged sheet still resolves; one Blit per representative.
 * Pure integer math — deterministic (cluster + distinct-rect ordering by lowest flat index). NOTE: this is the
 * MERGE-discovered count (the free diagnosis's cross-atlas detector surfaces it separately, round22 #0) — the
 * receipt copy says "across sheets", it does NOT claim the within-atlas frameRedundancy parity.
 */
export function buildMergeAliasMap(
  group: Atlas[],
  frameHashByRef: Map<string, (string | null)[]>,
  minDistinctRects: number,
): MergeAliasMap {
  // Flatten every (atlas, sprite) in group order into one index space. `hashOf[f]` is the region hash (or null
  // ⇒ never clusters) and `sheetOf[f]` the source atlas index (for the cross-sheet test). A group atlas whose
  // hashes are absent / length-mismatched contributes null hashes for all its frames (fail-safe: it never
  // clusters, so its frames pack normally — additive, byte-identical to a no-alias group for that sheet).
  const flat: { atlasName: string; sprite: Sprite }[] = [];
  const hashOf: (string | null)[] = [];
  const sheetOf: number[] = [];
  const rectKeyOf: string[] = [];
  for (let ai = 0; ai < group.length; ai++) {
    const a = group[ai]!;
    const hashes = frameHashByRef.get(a.name);
    const usable = hashes && hashes.length === a.sprites.length ? hashes : undefined;
    for (let i = 0; i < a.sprites.length; i++) {
      const s = a.sprites[i]!;
      flat.push({ atlasName: a.name, sprite: s });
      hashOf.push(usable ? (usable[i] ?? null) : null);
      sheetOf.push(ai);
      rectKeyOf.push(`${a.name}|${rectKey(s.frame)}`); // ATLAS-QUALIFIED (B1)
    }
  }
  const n = flat.length;
  const repOf = flat.map((_, f) => f); // identity by default — every flat index packs itself
  if (minDistinctRects < 1) {
    return { flat, repOf, representatives: repOf.slice(), aliasedFrames: 0, crossSheetFrames: 0 };
  }

  // Cluster flat indices by region hash (skip nulls). Insertion order is ascending ⇒ each cluster's list sorted.
  const clusters = new Map<string, number[]>();
  for (let f = 0; f < n; f++) {
    const h = hashOf[f];
    if (h == null) continue;
    const g = clusters.get(h) ?? [];
    g.push(f);
    clusters.set(h, g);
  }

  let aliasedFrames = 0;
  let crossSheetFrames = 0;
  const ordered = [...clusters.values()].sort((a, b) => a[0]! - b[0]!);
  for (const indices of ordered) {
    // ATLAS-QUALIFIED distinct-rect guard (B1): collapse names that already alias the SAME rect within ONE
    // atlas to one unit; two byte-identical frames on DIFFERENT sheets stay distinct (each pins its own texture).
    const byRect = new Map<string, number[]>();
    for (const f of indices) {
      const key = rectKeyOf[f]!;
      const g = byRect.get(key) ?? [];
      g.push(f);
      byRect.set(key, g);
    }
    const distinctRects = byRect.size;
    if (distinctRects < minDistinctRects) continue; // not enough genuinely-distinct cross-sheet copies

    // Representative = the FIRST distinct rect's lowest flat index. EVERY flat index in this cluster points at
    // it (including names that already alias the rep's OWN rect). Determinism: distinct rects by lowest index.
    const distinctOrdered = [...byRect.values()].sort((a, b) => a[0]! - b[0]!);
    const repIndex = distinctOrdered[0]![0]!;
    const repSheet = sheetOf[repIndex]!;
    for (const f of indices) repOf[f] = repIndex;
    aliasedFrames += distinctRects - 1;
    // Cross-sheet count: among the freed distinct rects (all but the rep), the ones whose sheet ≠ the rep's
    // sheet. A within-atlas freed rect (same sheet as the rep) is frameRedundancy's job, NOT cross-atlas, so it
    // is counted in aliasedFrames (the VRAM win) but NOT in crossSheetFrames (the headline cross-sheet figure).
    for (let r = 1; r < distinctOrdered.length; r++) {
      if (sheetOf[distinctOrdered[r]![0]!]! !== repSheet) crossSheetFrames++;
    }
  }

  const representatives: number[] = [];
  for (let f = 0; f < n; f++) if (repOf[f] === f) representatives.push(f);
  return { flat, repOf, representatives, aliasedFrames, crossSheetFrames };
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
