// Geometry-only repack: re-place every sprite across the given atlases into tighter POT sheet(s).
// NO pixels — emits new Atlas(es) + a Blit list (the pure→impure compose contract for the worker).
// v1 preserves source orientation (rotate90 always false); trim/source/pivot copied VERBATIM so the
// repack is non-destructive (a sprite renders identically in-engine, just from a smaller sheet).

import type { Atlas, Blit, Rect, RepackResult, Sprite, SpriteMesh, TrimRect } from '@asset-doctor/core';
import { pack, type PackItem } from './pack';
import type { MaskItem } from './mask';
import type { RawMesh } from './mesh';
import { nestMasks } from './polygon-pack';
import type { AtlasAliasMap, MergeAliasMap } from './alias';
import { spineOffsetFrom, spriteSourceSizeFrom } from './trim';

const vram = (w: number, h: number): number => w * h * 4;

export interface RepackOptions {
  allowRotation: boolean;
  padding: number;
  maxSize: number;
  /** SYMMETRIC packing gutter (px) reserved on all four sides of every re-placed sprite so the worker's
   *  edge-extrude (bleed) has its own room. Forwarded verbatim to `pack` (PackOptions.gutter). Absent/0
   *  ⇒ placements byte-identical to today. `PolygonRepackOptions` inherits this but the polygon nester
   *  IGNORES it — meshed sprites are never extruded (design: rectangle blits only). */
  gutter?: number;
  /** Trim-on-repack (round20): per-atlas, index-aligned to `atlas.sprites`, the FRAME-RELATIVE opaque bbox
   *  (top-left origin, the value `alphaBBox` returns) for each UNtrimmed sprite the caller measured — `null`
   *  for already-trimmed / non-shrinkable / un-measured sprites. The OUTER index matches `atlases[i]`. When a
   *  sprite has a strictly-smaller bbox AND is currently untrimmed (no `spriteSourceSize`), the repack packs
   *  the TIGHTER {bbox.w,bbox.h}, blits the inset sub-region, and emits `trimmed:true` + `sourceSize` (full)
   *  + `spriteSourceSize`/offset — a correct NON-destructive shrink (the sprite renders identically in-engine
   *  from a smaller sheet). Aliases sharing a trimmed rep's rect INHERIT the rep's trim (byte-identical pixels
   *  ⇒ same bbox). Absent ⇒ every sprite packs at its frame extent ⇒ byte-identical to today. */
  trim?: ((TrimRect | null)[])[];
  /** Trim-on-repack (round20): when TRUE, the trimmed sprite's `spriteSourceSize.x/y` is the libGDX
   *  BOTTOM-LEFT Spine `offset` (`spineOffsetFrom`) so `emitSpineAtlasText` writes it verbatim; FALSE/absent
   *  ⇒ the TexturePacker TOP-LEFT inset (`spriteSourceSizeFrom`). The ONLY axis that differs between the two
   *  emit paths — geometry/packing are identical. Ignored when `trim` is absent. */
  trimAsSpineOffset?: boolean;
}

/** Polygon-mode repack tuning. `emitMesh` controls whether meshed sprites carry their `Sprite.mesh`
 *  (with recomputed per-bin `verticesUV`) and the matching `Blit.clip`; nesting via `nestMasks` runs
 *  regardless (that is where the packing win comes from). */
export interface PolygonRepackOptions extends RepackOptions {
  emitMesh: boolean;
}

/** Uniformly downscale an atlas (image + every frame/source rect) by `scale` (0..1). Drop-in: same
 *  region names + the top-level `animations` map (both carried verbatim via the `{ ...atlas }` spread —
 *  resize renames nothing, frame keys are stable), the manifest just describes a smaller sheet. The caller
 *  scales the pixels to match. */
export function scaleAtlas(atlas: Atlas, scale: number): Atlas {
  const px = (n: number): number => Math.max(1, Math.round(n * scale));
  const W = px(atlas.size.w);
  const H = px(atlas.size.h);
  const sprites: Sprite[] = atlas.sprites.map((s) => {
    // clamp each frame inside the scaled sheet — independent rounding of x and w can otherwise push
    // the right/bottom edge 1px past the sheet (an invalid manifest).
    const x = Math.min(Math.round(s.frame.x * scale), Math.max(0, W - 1));
    const y = Math.min(Math.round(s.frame.y * scale), Math.max(0, H - 1));
    const out: Sprite = {
      name: s.name,
      frame: { x, y, w: Math.min(px(s.frame.w), W - x), h: Math.min(px(s.frame.h), H - y) },
      rotated: s.rotated,
      trimmed: s.trimmed,
      sourceSize: { w: px(s.sourceSize.w), h: px(s.sourceSize.h) },
    };
    if (s.spriteSourceSize) out.spriteSourceSize = { x: Math.round(s.spriteSourceSize.x * scale), y: Math.round(s.spriteSourceSize.y * scale), w: px(s.spriteSourceSize.w), h: px(s.spriteSourceSize.h) };
    if (s.pivot) out.pivot = s.pivot;
    return out;
  });
  return { ...atlas, size: { w: W, h: H }, sprites };
}

/** The resolved trim for ONE sprite: the inset sub-region of its SOURCE frame to blit (atlas px), the tight
 *  packed size, the emitted `sourceSize` (the sprite's ORIGINAL full size) + `spriteSourceSize` (TP top-left
 *  inset OR Spine bottom-left offset per `trimAsSpineOffset`), and the MEASURED reclaimed px (frame − bbox).
 *  `reclaimed` is accounted ONCE per representative; aliases inherit `sourceSize`/`spriteSourceSize` but add 0. */
interface ResolvedTrim {
  /** Inset source sub-region in ATLAS px (frame.xy + frame-relative bbox.xy). */
  fromRect: Rect;
  /** Tight packed extent (= bbox.w × bbox.h). */
  packW: number;
  packH: number;
  sourceSize: { w: number; h: number };
  spriteSourceSize: Rect;
  reclaimed: number;
}

/**
 * Resolve the trim metadata for sprite `s` (frame `s.frame`) given its FRAME-RELATIVE opaque `bbox` (or null).
 * Returns null (⇒ pack/emit verbatim, byte-identical to today) UNLESS the sprite is currently UNtrimmed
 * (`trimmed===false && spriteSourceSize===undefined`), NOT rotated, the bbox is non-null with positive extent,
 * AND the bbox is strictly tighter than the frame (smaller OR offset). NO `minMarginPx` gate (B1): trimming any
 * shrinkable untrimmed sprite is a correct non-destructive shrink — the receipt reports the MEASURED reclaim,
 * not the detector's "up to" promise. `spriteSourceSize.x/y` is the Spine bottom-left offset when `asSpineOffset`,
 * else the TP top-left inset (the ONLY axis that differs). Pure, integer-only, deterministic.
 *
 * ROTATED GUARD (finding [0]): a `rotated:true` sprite stores its pixels on-page in ROTATED orientation (its
 * `frame.w/h` are swapped relative to `sourceSize.w/h`), while `sourceSize` stays in UNrotated source space. The
 * caller's `bbox` is measured over the rotated on-page frame, so it is in ROTATED coords — but `spriteSourceSizeFrom`
 * /`spineOffsetFrom` treat it as UNrotated source coords (the Spine offset = `sourceSize.h − (bbox.y+bbox.h)`
 * mixes rotated bbox.y/h with the unrotated source height). The emitted inset/offset would be wrong ⇒ a BROKEN
 * manifest (the sprite renders at the wrong size/position). v1 keeps source orientation (rotate90 always false),
 * so a rotated sprite already packs verbatim; trimming it is out of scope. Bail ⇒ pack verbatim, the receipt
 * honestly reports the smaller reclaim. (The detector mirrors this carve-out; see rules.ts trim-margin gate.)
 */
function resolveTrim(s: Sprite, bbox: TrimRect | null, asSpineOffset: boolean): ResolvedTrim | null {
  if (s.trimmed !== false || s.spriteSourceSize !== undefined) return null; // already trimmed ⇒ verbatim
  if (s.rotated) return null; // rotated on-page bbox ≠ unrotated source coords ⇒ verbatim (finding [0])
  // bbox===null ⇒ a fully-transparent UNtrimmed frame: pack VERBATIM at the full frame (the repack must keep
  // every region resolvable — collapsing to a 1×1 sentinel here would change geometry / break drop-in). The
  // detector counts such a frame as recoverableArea += FULL frameArea (the per-side gate is bypassed,
  // rules.ts), so this fix's MEASURED reclaim is BELOW the detector's number for that frame — an explicit
  // documented carve-out from the ">= recoverableArea" claim (finding [1]). It is still HONEST: the receipt
  // reports only the measured reclaim, never the detector's "up to" promise, and a fully-transparent frame is
  // a degenerate case (zero visible art). bbox.w/h<=0 cannot occur (alphaBBox returns ≥1 extent or null) but
  // is gated defensively for hand-built callers. Either ⇒ verbatim.
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) return null; // no opaque core / un-measured ⇒ verbatim
  const frame = s.frame;
  // Strictly tighter than the frame in SOME dimension (offset counts: a top-left-flush smaller bbox still
  // reclaims). bbox is frame-relative, so its max extent is frame.w/h at offset 0.
  if (bbox.x <= 0 && bbox.y <= 0 && bbox.w >= frame.w && bbox.h >= frame.h) return null;
  const sourceSize = { w: s.sourceSize.w, h: s.sourceSize.h }; // ORIGINAL full size (untrimmed: == frame)
  const sss = asSpineOffset
    ? { ...spineOffsetFrom(sourceSize, bbox), w: bbox.w, h: bbox.h }
    : spriteSourceSizeFrom(sourceSize, bbox);
  return {
    fromRect: { x: frame.x + bbox.x, y: frame.y + bbox.y, w: bbox.w, h: bbox.h },
    packW: bbox.w,
    packH: bbox.h,
    sourceSize,
    spriteSourceSize: sss,
    reclaimed: frame.w * frame.h - bbox.w * bbox.h,
  };
}

/**
 * `aliasMaps` (round19 frame-redundancy): an OPTIONAL per-atlas decision (keyed by Atlas.name) that
 * byte-identical frames should SHARE one packed region. When supplied for an atlas, only ONE representative
 * PackItem is packed per byte-identical cluster (the duplicates are NOT packed), and after packing we emit a
 * Sprite for EVERY alias name pointing at the representative's FINAL {x,y,w,h} but copying that alias's OWN
 * trim/pivot/sourceSize/spriteSourceSize/rotated (per-name geometry correct; only the RECT shared). The Blit
 * list stays one-per-representative — pixels are written ONCE. Every original frame name still resolves in the
 * emitted manifest. Absent/empty: every sprite packs itself => byte-identical to today.
 *
 * DUAL OCCUPANCY (honesty, invariant 5): occupancyBefore uses the area of ALL source sprites (duplicates and
 * all - the source sheet genuinely held them), occupancyAfter uses only the PACKED representatives' area over
 * the new sheet area. vramBytesBefore/After are exact w*h*4 of the POT bins (aliasing simply yields a smaller
 * sheet => fewer/smaller bins) - no estimate.
 *
 * `mergeAliasMap` (round22 #1, cross-atlas frame dedup during MERGE): when supplied (the multi-atlas merge
 * path only), it SUPERSEDES `aliasMaps` and clusters byte-identical frames across the WHOLE group in ONE flat
 * (atlasName, frameName) key space — a frame byte-identical between sheet A and sheet B is packed ONCE and every
 * duplicate name (across ALL merged sheets) is aliased onto that one region (its OWN trim/pivot/sourceSize
 * copied; one Blit per representative). Its flat index space MUST be the SAME order this function iterates
 * `atlases` (group order, sprite index order) — they advance in lockstep below. With it supplied we ALSO run a
 * no-alias BASELINE pack of the SAME group's full item set and report the EXACT VRAM delta as
 * `vramReclaimedBytes` (baseline POT bin VRAM − the aliased `vramBytesAfter`) + `potTierDropped` — a REAL
 * measured delta (the merge actually produces the deduped bin), never an area floor. Absent ⇒ unchanged.
 */
export function repackAtlases(
  atlases: Atlas[],
  opts: RepackOptions,
  aliasMaps?: Map<string, AtlasAliasMap>,
  mergeAliasMap?: MergeAliasMap,
): RepackResult {
  const items: PackItem[] = [];
  const srcOf = new Map<string, { sprite: Sprite; atlasRef: string }>();
  // For a representative id: the alias source sprites whose names must be emitted at the representative's final
  // rect (NOT including the representative itself - it is emitted from srcOf). Keyed by the representative's id.
  const aliasesOf = new Map<string, { sprite: Sprite; atlasRef: string }[]>();
  let vramBefore = 0;
  let areaBefore = 0;
  // DUAL occupancy accumulators (round19): source = every sprite (truthful before), packed = representatives
  // only (truthful after). When no aliasMaps are supplied these are equal (today's single-accumulator value).
  let coveredAreaSource = 0;
  let coveredAreaPacked = 0;
  let aliasedFrames = 0;
  // Trim-on-repack (round20): the resolved trim per representative id (only for sprites being tightened). The
  // alias emit branch reads `trimOf.get(repId)` to INHERIT the rep's trim (B2). `trimmedSprites`/`trimmedArea`
  // are accounted ONCE per representative; aliases inherit metadata but add 0 to either tally.
  const trimOf = new Map<string, ResolvedTrim>();
  let trimmedSprites = 0;
  let trimmedAreaReclaimed = 0;
  // Cross-atlas merge dedup (round22 #1): when a mergeAliasMap is supplied it SUPERSEDES the per-atlas aliasMaps
  // for this whole group. `flatCursor` walks the SAME flat index space the map was built over (group order,
  // sprite index order); its repOf entries point at FLAT indices, which we resolve to `${repAtlasName} repName`.
  // aliasedFrames is the map's already-honest Σ(distinctRects−1); counted ONCE here (never per-sprite).
  let flatCursor = 0;
  if (mergeAliasMap) aliasedFrames += mergeAliasMap.aliasedFrames;
  for (let ai = 0; ai < atlases.length; ai++) {
    const a = atlases[ai]!;
    const atlasTrim = opts.trim?.[ai];
    vramBefore += vram(a.size.w, a.size.h);
    areaBefore += a.size.w * a.size.h;
    // mergeAliasMap (if present) governs aliasing for the whole group; otherwise the per-atlas map for THIS sheet.
    const am = mergeAliasMap ? undefined : aliasMaps?.get(a.name);
    // HONESTY (finding [0]): accumulate the alias map's ALREADY-HONEST count once per atlas — Σ(distinctRects−1)
    // over qualifying clusters, which EQUALS the detector's `dupes` (the value surfaced in receipt.framesAliased,
    // the operations string, and the i18n `fix.framesAliased` line). We must NOT recount per non-representative
    // sprite (cluster-size−1): a byte-identical cluster with ≥2 names pointing at the SAME packed rect (a
    // pre-aliased Spine/TP sheet) collapses to ONE recoverable unit in the detector's distinct-rect guard, so a
    // per-sprite tally would over-report. Counting am.aliasedFrames here makes repackAtlases.aliasedFrames ===
    // buildAtlasAliasMap(...).aliasedFrames === the finding's dupes BY CONSTRUCTION. VRAM/blits/drop-in are
    // unaffected — those are driven by repOf (which rect each sprite shares), not by this surfaced count.
    if (am) aliasedFrames += am.aliasedFrames;
    a.sprites.forEach((s, idx) => {
      const id = `${a.name} ${s.name}`;
      srcOf.set(id, { sprite: s, atlasRef: a.name });
      coveredAreaSource += s.frame.w * s.frame.h;
      // Resolve the representative. mergeAliasMap: repOf is FLAT, so map the flat rep index back to its (atlas,
      // sprite) and decide self-vs-alias by comparing the flat index, NOT idx (idx is per-atlas). Per-atlas am:
      // repOf is local to this sheet. No map: the sprite is its own rep.
      const flatIndex = flatCursor++;
      let isSelf: boolean;
      let repId: string;
      if (mergeAliasMap) {
        const repFlat = mergeAliasMap.repOf[flatIndex]!;
        isSelf = repFlat === flatIndex;
        const repEntry = mergeAliasMap.flat[repFlat]!;
        repId = `${repEntry.atlasName} ${repEntry.sprite.name}`;
      } else {
        const rep = am ? am.repOf[idx]! : idx;
        isSelf = rep === idx;
        repId = `${a.name} ${a.sprites[rep]!.name}`;
      }
      if (isSelf) {
        // Representative (or no aliasing for this atlas): pack a real item, count its area as packed. When this
        // sprite carries reclaimable padding (resolveTrim ⇒ non-null), pack the TIGHTER bbox extent + record
        // the resolved trim so the emit branch can tighten this rep AND every alias sharing its rect (B2).
        const tr = atlasTrim ? resolveTrim(s, atlasTrim[idx] ?? null, !!opts.trimAsSpineOffset) : null;
        if (tr) {
          trimOf.set(id, tr);
          trimmedSprites++;
          trimmedAreaReclaimed += tr.reclaimed;
          items.push({ id, w: tr.packW, h: tr.packH });
          coveredAreaPacked += tr.packW * tr.packH;
        } else {
          items.push({ id, w: s.frame.w, h: s.frame.h });
          coveredAreaPacked += s.frame.w * s.frame.h;
        }
      } else {
        // Aliased duplicate: do NOT pack - record it under its representative's id for post-pack emit. `repId`
        // is the (cross-atlas, for mergeAliasMap) representative resolved above — its OWN trim/pivot/sourceSize
        // come from THIS source sprite, only the packed RECT is shared.
        const g = aliasesOf.get(repId) ?? [];
        g.push({ sprite: s, atlasRef: a.name });
        aliasesOf.set(repId, g);
      }
    });
  }
  const occupancyBefore = areaBefore > 0 ? coveredAreaSource / areaBefore : 0;

  const bins = pack(items, { allowRotation: opts.allowRotation, padding: opts.padding, maxSize: opts.maxSize, ...(opts.gutter ? { gutter: opts.gutter } : {}) });

  const baseRef = atlases[0]?.imageRef ?? 'atlas.png';
  const format = atlases[0]?.format;
  const atlasesOut: Atlas[] = [];
  const blits: Blit[] = [];
  let vramAfter = 0;
  let areaAfter = 0;

  bins.forEach((bin, i) => {
    vramAfter += vram(bin.w, bin.h);
    areaAfter += bin.w * bin.h;
    const imageRef = bins.length === 1 ? baseRef : baseRef.replace(/(\.[a-z0-9]+)$|$/i, `_${i}$&`);
    const sprites: Sprite[] = [];
    bin.placements.forEach((p) => {
      const { sprite: s, atlasRef } = srcOf.get(p.id)!;
      // Trim-on-repack (round20): when this rep was tightened, blit the INSET source sub-region (its opaque
      // core) into the tight placement `p` (= bbox extent), and emit `trimmed:true` + `sourceSize` (full) +
      // `spriteSourceSize`/offset. `tr.fromRect` is the source-frame inset; absent ⇒ today's full-frame blit.
      const tr = trimOf.get(p.id);
      // ONE Blit per representative - the pixels of an aliased cluster are written exactly once.
      blits.push({
        name: s.name,
        from: { atlasRef, rect: tr ? tr.fromRect : s.frame, rotated: s.rotated },
        to: { x: p.x, y: p.y, w: p.w, h: p.h },
        rotate90: false,
      });
      const out: Sprite = { name: s.name, frame: { x: p.x, y: p.y, w: p.w, h: p.h }, rotated: s.rotated, trimmed: tr ? true : s.trimmed, sourceSize: tr ? tr.sourceSize : s.sourceSize };
      if (tr) out.spriteSourceSize = { ...tr.spriteSourceSize };
      else if (s.spriteSourceSize) out.spriteSourceSize = s.spriteSourceSize;
      if (s.pivot) out.pivot = s.pivot;
      sprites.push(out);
      // Alias sprites: every byte-identical duplicate name lands at the representative's FINAL rect. When the
      // rep was TRIMMED, each alias MUST INHERIT the rep's trim (B2): the pixels are byte-identical, so the
      // rep's bbox IS the alias's correct trim — emitting a trimmed rect with an alias still marked untrimmed
      // (no spriteSourceSize, sourceSize=full frame) is a BROKEN manifest (engine renders the wrong size). When
      // the rep was NOT trimmed the alias keeps its OWN trim/source/pivot/rotated (per-name geometry correct;
      // only the RECT shared). No Blit either way — the pixels are already written by the representative above.
      for (const { sprite: alias } of aliasesOf.get(p.id) ?? []) {
        const aout: Sprite = { name: alias.name, frame: { x: p.x, y: p.y, w: p.w, h: p.h }, rotated: alias.rotated, trimmed: tr ? true : alias.trimmed, sourceSize: tr ? tr.sourceSize : alias.sourceSize };
        if (tr) aout.spriteSourceSize = { ...tr.spriteSourceSize };
        else if (alias.spriteSourceSize) aout.spriteSourceSize = alias.spriteSourceSize;
        if (alias.pivot) aout.pivot = alias.pivot;
        sprites.push(aout);
      }
    });
    sprites.sort((a, b) => a.name.localeCompare(b.name)); // deterministic, matches the emitted manifest order
    atlasesOut.push({ name: imageRef, imageRef, size: { w: bin.w, h: bin.h }, sprites, source: { kind: 'texturepacker-hash' }, ...(format ? { format } : {}) });
  });

  const occupancyAfter = areaAfter > 0 ? coveredAreaPacked / areaAfter : 0;

  // Cross-atlas merge dedup (round22 #1): EXACT VRAM delta vs the no-alias counterfactual. Re-pack the SAME
  // group's FULL item set with NO aliasing — every sprite (representatives AND the duplicates we aliased) at the
  // EXACT extent this aliased pass would have used for it (trim-resolved identically: a tightened rep packs its
  // bbox, an alias inheriting a rep's trim packs the rep's bbox extent — byte-identical pixels ⇒ same bbox).
  // The delta `baseline POT-bin VRAM − vramAfter` is a REAL measured saving (the merge actually emits the
  // deduped bin), never an area floor. potTierDropped iff the smaller alias pack dropped a POT VRAM tier.
  // Only computed when a mergeAliasMap actually aliased ≥1 frame (else 0/false ⇒ omitted, byte-identical).
  let vramReclaimedBytes = 0;
  let potTierDropped = false;
  if (mergeAliasMap && mergeAliasMap.aliasedFrames > 0) {
    const baseItems: PackItem[] = [];
    let fc = 0;
    for (let ai = 0; ai < atlases.length; ai++) {
      const a = atlases[ai]!;
      const atlasTrim = opts.trim?.[ai];
      a.sprites.forEach((s, idx) => {
        const fi = fc++;
        // The extent this sprite occupies in the ALIASED pass: a representative uses its own resolveTrim; an
        // alias inherits the REP's resolved trim (its pixels are byte-identical ⇒ same bbox). Recompute the same.
        const repFlat = mergeAliasMap.repOf[fi]!;
        const repEntry = mergeAliasMap.flat[repFlat]!;
        const repId = `${repEntry.atlasName} ${repEntry.sprite.name}`;
        const repTr = trimOf.get(repId);
        if (repTr) {
          baseItems.push({ id: `b${fi}`, w: repTr.packW, h: repTr.packH });
        } else {
          const ownTr = atlasTrim ? resolveTrim(s, atlasTrim[idx] ?? null, !!opts.trimAsSpineOffset) : null;
          if (ownTr) baseItems.push({ id: `b${fi}`, w: ownTr.packW, h: ownTr.packH });
          else baseItems.push({ id: `b${fi}`, w: s.frame.w, h: s.frame.h });
        }
      });
    }
    const baseBins = pack(baseItems, { allowRotation: opts.allowRotation, padding: opts.padding, maxSize: opts.maxSize, ...(opts.gutter ? { gutter: opts.gutter } : {}) });
    const baseVram = baseBins.reduce((sum, b) => sum + vram(b.w, b.h), 0);
    vramReclaimedBytes = Math.max(0, baseVram - vramAfter);
    potTierDropped = vramAfter < baseVram;
  }

  return {
    atlases: atlasesOut,
    blits,
    occupancyBefore,
    occupancyAfter,
    vramBytesBefore: vramBefore,
    vramBytesAfter: vramAfter,
    ...(aliasedFrames > 0 ? { aliasedFrames } : {}),
    ...(trimmedSprites > 0 ? { trimmedSprites, trimmedAreaReclaimed } : {}),
    ...(mergeAliasMap && mergeAliasMap.aliasedFrames > 0 ? { vramReclaimedBytes, potTierDropped } : {}),
  };
}

/**
 * Polygon-mode repack — a near-copy of `repackAtlases` that places via `nestMasks` (bitmap-mask
 * interlocking) instead of the rectangle packer, and optionally attaches a tight `Sprite.mesh` +
 * matching `Blit.clip` so the worker can compose interlocked sprites safely.
 *
 * The mask id and `meshById` key MUST be the SAME dir-aware id `repackAtlases` uses
 * (`${atlas.name} ${sprite.name}`), NOT the bare sprite name — this prevents cross-atlas
 * mis-attribution in merge mode. `verticesUV` (and the `Blit.clip` copied from it) are RECOMPUTED
 * from the FINAL per-bin `frame.x/y` of each placement, so they stay correct under spill/merge and
 * are never carried over from the source. Still non-destructive: trim/source/pivot copied verbatim,
 * `rotate90` always false. When `emitMesh` is false (or no mesh exists for an id) the result is a
 * pure rectangle repack, byte-identical in shape to `repackAtlases`. Occupancy/VRAM are computed
 * exactly as in `repackAtlases`.
 */
export function repackAtlasesPolygon(
  atlases: Atlas[],
  masks: MaskItem[],
  meshById: Map<string, RawMesh>,
  opts: PolygonRepackOptions,
): RepackResult {
  const srcOf = new Map<string, { sprite: Sprite; atlasRef: string }>();
  let vramBefore = 0;
  let areaBefore = 0;
  let coveredArea = 0;
  for (const a of atlases) {
    vramBefore += vram(a.size.w, a.size.h);
    areaBefore += a.size.w * a.size.h;
    for (const s of a.sprites) {
      const id = `${a.name} ${s.name}`;
      srcOf.set(id, { sprite: s, atlasRef: a.name });
      coveredArea += s.frame.w * s.frame.h;
    }
  }
  const occupancyBefore = areaBefore > 0 ? coveredArea / areaBefore : 0;

  const bins = nestMasks(masks, { allowRotation: opts.allowRotation, padding: opts.padding, maxSize: opts.maxSize });

  const baseRef = atlases[0]?.imageRef ?? 'atlas.png';
  const format = atlases[0]?.format;
  const atlasesOut: Atlas[] = [];
  const blits: Blit[] = [];
  let vramAfter = 0;
  let areaAfter = 0;

  bins.forEach((bin, i) => {
    vramAfter += vram(bin.w, bin.h);
    areaAfter += bin.w * bin.h;
    const imageRef = bins.length === 1 ? baseRef : baseRef.replace(/(\.[a-z0-9]+)$|$/i, `_${i}$&`);
    const sprites: Sprite[] = bin.placements.map((p) => {
      const { sprite: s, atlasRef } = srcOf.get(p.id)!;
      const out: Sprite = { name: s.name, frame: { x: p.x, y: p.y, w: p.w, h: p.h }, rotated: s.rotated, trimmed: s.trimmed, sourceSize: s.sourceSize };
      if (s.spriteSourceSize) out.spriteSourceSize = s.spriteSourceSize;
      if (s.pivot) out.pivot = s.pivot;
      // Attach the mesh + clip ONLY when asked AND a mesh exists for this dir-aware id. verticesUV
      // (and Blit.clip) are recomputed from the FINAL per-bin frame.xy so they stay correct under
      // spill/merge — never carried from the source.
      const raw = opts.emitMesh ? meshById.get(p.id) : undefined;
      let clip: Blit['clip'];
      if (raw) {
        const verticesUV = raw.vertices.map((v) => ({ x: v.x + p.x, y: v.y + p.y }));
        const mesh: SpriteMesh = {
          vertices: raw.vertices.map((v) => ({ x: v.x, y: v.y })),
          verticesUV,
          triangles: raw.triangles,
        };
        out.mesh = mesh;
        clip = verticesUV;
      }
      blits.push({
        name: s.name,
        from: { atlasRef, rect: s.frame, rotated: s.rotated },
        to: { x: p.x, y: p.y, w: p.w, h: p.h },
        rotate90: false,
        ...(clip ? { clip } : {}),
      });
      return out;
    });
    sprites.sort((a, b) => a.name.localeCompare(b.name)); // deterministic, matches the emitted manifest order
    atlasesOut.push({ name: imageRef, imageRef, size: { w: bin.w, h: bin.h }, sprites, source: { kind: 'texturepacker-hash' }, ...(format ? { format } : {}) });
  });

  const occupancyAfter = areaAfter > 0 ? coveredArea / areaAfter : 0;
  return { atlases: atlasesOut, blits, occupancyBefore, occupancyAfter, vramBytesBefore: vramBefore, vramBytesAfter: vramAfter };
}

/** Honest win gate. TRUE iff the polygon result is a MEASURABLE VRAM improvement over the rectangle
 *  result: `poly.vramBytesAfter < rect.vramBytesAfter` (fewer/smaller POT bins). Intra-bin area is
 *  NEVER the signal — equal VRAM ⇒ false ⇒ caller falls back to rectangle packing, emits no mesh,
 *  and claims no saving. */
export function polygonWins(poly: RepackResult, rect: RepackResult): boolean {
  return poly.vramBytesAfter < rect.vramBytesAfter;
}
