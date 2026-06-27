// Translate a MEASURED AnalysisReport into a FixPlan — a pure, structured-cloneable list of operations
// (never invented, never carrying pixels). The worker executes it.
//
// DROP-IN (default): repack under-filled atlases, downscale oversized atlases AND loose images,
// transcode loose images. AGGRESSIVE (opt-in, reference-changing): merge under-filled atlas groups
// and drop exact + near duplicate copies. Resize takes precedence over transcode for the same image.

import type { AnalysisReport, DedupGroup, FixOp, FixPlan, ImageMime, PackGroup } from '@asset-doctor/core';

export interface PlanOptions {
  /** Target format for transcode + the repacked sheet image. */
  targetMime: ImageMime;
  quality: number;
  lossless: boolean;
  padding: number;
  maxSize: number;
  /** Downscale any image/atlas whose longest edge exceeds this (px). */
  maxEdge: number;
  /** Aggressive, NON-drop-in: merge under-filled atlas groups + drop exact & near duplicates. */
  aggressive: boolean;
  /** True iff a ref is an atlas (image+manifest pair). Supplied by the worker (which has atlasByRef).
   *  Pure predicate — used to decide owner-aware drops that repoint a consumer manifest's meta.image.
   *  Absent ⇒ no ref is treated as an atlas (every owner-aware drop is a whole-file drop). */
  isAtlasRef?: (ref: string) => boolean;
}

/**
 * Translate findings → FixPlan.
 *
 * `groups` (optional): the owner/consumer dedup plan computed by the worker (buildDedupGroups). When
 * supplied in aggressive mode, exact-duplicate drops become OWNER-AWARE: one `drop` per consumer
 * carries `ownerRef` (the retained copy its references repoint to) and, for atlas consumers whose sheet
 * is byte-identical to the owner's, `repointManifest:true` (the worker keeps the manifest and rewrites
 * meta.image → owner image, dropping only the redundant image). Owners are added to a protectedOwners
 * set and are NEVER drop/merge/resize targets. When `groups` is omitted, the legacy bare-drop path is
 * used (today's behavior — drop every copy after the first, no owner info).
 *
 * `packGroups` (optional, Feature 4): deterministic groupings of OWNED loose images → one sheet
 * (static TexturePacker JSON) or one multi-page Spine `.atlas` each. When supplied, a pack pass runs
 * IMMEDIATELY AFTER dedup pass 0a (so `dropped`/`protectedOwners` are populated) and BEFORE pass 1,
 * emitting one `pack` op per non-empty group. Only OWNED refs are packed: any region.ref already in
 * `dropped` (a dedup consumer scheduled for drop) is excluded from its group — pack owners only. Every
 * packed ref is recorded in a `packed` set that guards pass-2 transcode (`!packed.has`), so a ref
 * flagged by BOTH should-atlas and format yields exactly one pack op and zero transcode ops. Building
 * a sheet is reference-changing (FixReceipt.referencesChanged + fix.packWarn). When omitted, no pack
 * ops are emitted — the legacy/today path is byte-identical.
 */
export function planFix(report: AnalysisReport, opts: PlanOptions, groups?: DedupGroup[], packGroups?: PackGroup[]): FixPlan {
  const ops: FixOp[] = [];
  const repacked = new Set<string>();
  const dropped = new Set<string>();
  const resized = new Set<string>();
  // Refs folded into a packed sheet/atlas (Feature 4). Guards pass-2 transcode below (a packed loose
  // image is encoded once, into its sheet — never also transcoded). Empty unless packGroups supplied.
  const packed = new Set<string>();

  // Owners are retained copies — never drop/merge/resize targets. Guarded before every existing
  // dropped/repacked/resized check below so an owner-aware run can't accidentally consume an owner.
  const protectedOwners = new Set<string>();
  if (opts.aggressive && groups) {
    for (const g of groups) for (const ownerRef of g.owners) protectedOwners.add(ownerRef);
  }

  // Owner-aware dedup drops (Feature 1): one drop per consumer, bound to its owner. Determinism: groups
  // already iterate by contentHash and consumers by ref (buildDedupGroups), so this preserves order.
  const dropDedupGroups = (gs: DedupGroup[]): void => {
    for (const g of gs) {
      for (const c of g.consumers) {
        if (protectedOwners.has(c.ref) || dropped.has(c.ref) || repacked.has(c.ref) || resized.has(c.ref)) continue;
        dropped.add(c.ref);
        // A content-hash group means the consumer's image bytes are byte-identical to the owner's, so
        // an atlas consumer's sheet is "fully identical" by construction — repoint its manifest.
        const repointManifest = opts.isAtlasRef?.(c.ref) ?? false;
        ops.push({ kind: 'drop', assetRef: c.ref, reason: 'duplicate-exact', ownerRef: c.ownerRef, ...(repointManifest ? { repointManifest } : {}) });
      }
    }
  };

  // Legacy bare-drop path (no DedupGroup[] supplied): drop every copy after the first, no owner info.
  const dropGroup = (refs: string[], reason: 'duplicate-exact' | 'duplicate-similar'): void => {
    for (const ref of refs.slice(1)) {
      if (protectedOwners.has(ref) || dropped.has(ref) || repacked.has(ref)) continue;
      dropped.add(ref);
      ops.push({ kind: 'drop', assetRef: ref, reason });
    }
  };

  // pass 0a (aggressive, owner-aware): emit dedup drops FIRST so owners are protected and consumers are
  // recorded before any repack/resize could claim them. Only when DedupGroup[] is supplied.
  if (opts.aggressive && groups) dropDedupGroups(groups);

  // pass 0b (Feature 4, pack): build new sheets/atlases from OWNED loose images. Runs AFTER dedup 0a
  // (so `dropped` is populated) and BEFORE every repack/resize/transcode pass. One `pack` op per
  // non-empty group; refs scheduled for drop are excluded (pack owners only — never a dedup consumer).
  // Determinism: groups iterated by PackGroup.id; every consumed ref recorded in `packed` to guard
  // pass-2 transcode. No packGroups ⇒ no pack ops (legacy path unchanged).
  if (packGroups && packGroups.length > 0) {
    for (const g of [...packGroups].sort((a, b) => a.id.localeCompare(b.id))) {
      // pack OWNERS only: drop a region whose ref is already being dropped by dedup. An owner is freely
      // packable (protectedOwners are kept copies, not loose-image owners, so they aren't filtered here).
      const ownedRegions = g.regions.filter((r) => !dropped.has(r.ref));
      if (ownedRegions.length === 0) continue;
      ownedRegions.forEach((r) => packed.add(r.ref));
      ops.push({
        kind: 'pack',
        group: { ...g, regions: ownedRegions },
        targetMime: opts.targetMime,
        trim: true,
        padding: opts.padding,
        maxSize: opts.maxSize,
        allowRotation: false,
      });
    }
  }

  // pass 0 (aggressive): collapse each atlas-merge group into one multi-ref repack op (the merge),
  // before per-atlas repack so merged atlases aren't also individually repacked.
  if (opts.aggressive) {
    for (const f of report.findings) {
      if (f.rule !== 'atlas-merge') continue;
      // an owner is never a merge target; a consumer slated for drop is never re-packed.
      const fresh = (f.relatedRefs ?? []).filter((r) => !repacked.has(r) && !protectedOwners.has(r) && !dropped.has(r));
      if (fresh.length < 2) continue;
      fresh.forEach((r) => repacked.add(r));
      ops.push({ kind: 'repack', atlasRefs: fresh, targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize });
    }
  }

  // pass 1: repack under-filled atlases · resize oversized atlases/images · (aggressive) drop dupes
  for (const f of report.findings) {
    if (f.rule === 'occupancy' || f.rule === 'wasted-regions') {
      // owners are never repack targets (guard before the existing repacked check).
      if (protectedOwners.has(f.assetRef) || repacked.has(f.assetRef)) continue;
      repacked.add(f.assetRef);
      ops.push({ kind: 'repack', atlasRefs: [f.assetRef], targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize });
    } else if (f.rule === 'dimensions-oversize' && f.scope !== 'folder') {
      const w = Number(f.params?.w ?? 0);
      const h = Number(f.params?.h ?? 0);
      const longest = Math.max(w, h);
      // an atlas that's also being repacked may already shrink; don't double-handle it. owners are
      // never resize targets (guard before the existing resized/repacked checks).
      if (w > 0 && h > 0 && longest > opts.maxEdge && !protectedOwners.has(f.assetRef) && !resized.has(f.assetRef) && !repacked.has(f.assetRef)) {
        const s = opts.maxEdge / longest;
        resized.add(f.assetRef);
        ops.push({ kind: 'resize', assetRef: f.assetRef, to: { w: Math.round(w * s), h: Math.round(h * s) }, targetMime: opts.targetMime, quality: opts.quality });
      }
    } else if (opts.aggressive && (f.rule === 'duplicate-exact' || f.rule === 'duplicate-similar')) {
      // Owner-aware drops already emitted in pass 0a when groups supplied; only exact dupes are
      // owner-modelled, so near-duplicates still use the legacy bare-drop path either way.
      if (!groups) dropGroup(f.relatedRefs ?? [], f.rule);
      else if (f.rule === 'duplicate-similar') dropGroup(f.relatedRefs ?? [], f.rule);
    }
  }

  // pass 2: transcode format-improvable images not already resized, dropped, or packed. The `packed`
  // guard (Feature 4) ensures a loose image folded into a sheet is encoded once (in the pack step),
  // never also transcoded here — a ref with both should-atlas and format yields one pack, zero transcode.
  for (const f of report.findings) {
    if (f.rule === 'format' && f.scope !== 'folder' && !resized.has(f.assetRef) && !dropped.has(f.assetRef) && !packed.has(f.assetRef)) {
      ops.push({ kind: 'transcode', assetRef: f.assetRef, targetMime: opts.targetMime, quality: opts.quality, lossless: opts.lossless });
    }
  }
  return { ops, thresholds: report.thresholds };
}
