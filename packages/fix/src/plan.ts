// Translate a MEASURED AnalysisReport into a FixPlan — a pure, structured-cloneable list of operations
// (never invented, never carrying pixels). The worker executes it.
//
// DROP-IN (default): repack under-filled atlases, downscale oversized atlases AND loose images,
// transcode loose images. AGGRESSIVE (opt-in, reference-changing): merge under-filled atlas groups
// and drop exact + near duplicate copies. Resize takes precedence over transcode for the same image.

import type { AnalysisReport, DedupGroup, FixOp, FixPlan, ImageMime, PackGroup, ScaleTier } from '@asset-doctor/core';

/** The four real image mimes (core's ImageMime). Used to validate a finding's measured `params.bestMime`
 *  before routing a transcode op to it — a malformed/absent value fails the guard and falls back to the
 *  global target (fail-safe ⇒ byte-identical to today). */
const VALID_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/avif']);
const isImageMime = (v: unknown): v is ImageMime => typeof v === 'string' && VALID_MIMES.has(v);

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
  /** Opaque-encode the Pro fix for a `wasted-alpha` finding (a fully-opaque image still carrying a dead
   *  alpha channel): re-encode it WITHOUT the alpha channel for a DISK/download saving (invariant 5 — never
   *  a VRAM claim; the GPU still allocates RGBA8888). When ON, every `wasted-alpha`-flagged loose ref gets a
   *  transcode op with `opaque:true` — either by setting the flag on its existing `format` transcode, or by
   *  emitting a standalone opaque transcode when format didn't fire. DEFAULT OFF ⇒ no op carries `opaque` ⇒
   *  byte-identical to today (the wasted-alpha finding stays a diagnosis-only verdict). */
  opaqueAlpha?: boolean;
  /** Per-image MEASURED best-format pick (round17). formatFinding ALREADY measured every candidate
   *  (FORMAT_TARGETS) and recorded the winner in `params.bestMime`. When ON, the pass-2 LOOSE `format`
   *  transcode op targets that measured winner instead of the single global `opts.targetMime`; absent/
   *  invalid bestMime (atlas / no-encoder report / OFF) ⇒ `opts.targetMime`. The plan does NO encoding — it
   *  only routes the op to the format the diagnosis already proved smallest (invariant 3 — measure, then the
   *  fix generates). PRECEDENCE: this governs ONLY the NON-profile default path; an active export profile
   *  fans out its own formats (worker-gated), and a user per-folder/type override still WINS (it layers on
   *  the per-image pick as the resolve base, worker-side). DEFAULT OFF ⇒ every op carries `opts.targetMime`
   *  ⇒ byte-identical to today. Deterministic: bestMime inherits formatFinding's strict-smaller tie-break. */
  bestFormatPerImage?: boolean;
  /** True iff a ref is an atlas (image+manifest pair). Supplied by the worker (which has atlasByRef).
   *  Pure predicate — used to decide owner-aware drops that repoint a consumer manifest's meta.image.
   *  Absent ⇒ no ref is treated as an atlas (every owner-aware drop is a whole-file drop). */
  isAtlasRef?: (ref: string) => boolean;
  /** Validated scale-tier ladder (design docs/scale-tiers-design.md §7). NON-EMPTY ⇒ scale-tier export
   *  is on: tier-eligible refs are folded into a `tiered` set that EXCLUDES them from the standalone
   *  pass-1 oversize-resize and pass-2 transcode ops (the worker's tier loop OWNS each tier's encode +
   *  oversize clamp, so a tiered asset is never ALSO separately resized/transcoded). The plan only
   *  carries the guard — it emits NO tier op (tiering is a worker-side per-asset multiplier). Pass the
   *  output of validateTiers; an INVALID ladder must arrive as empty/absent so today's path reproduces.
   *  Empty/absent ⇒ byte-identical to today. */
  scaleTiers?: ScaleTier[];
  /** True iff `ref` is ALLOWED to be tiered. Supplied by the worker, which alone holds the data to
   *  REFUSE tiering (and surface a skip): atlases carrying a source mesh (correction 2), multi-page
   *  Spine (correction 4), and already-tiered input (correction 5). Only consulted when `scaleTiers`
   *  is non-empty. Absent ⇒ every ref is eligible (the worker gates separately). A refused ref is NOT
   *  added to `tiered`, so it keeps its normal single-scale resize/transcode op. Pure predicate. */
  tierEligible?: (ref: string) => boolean;
  /** Edge-extrude (bleed) px — replicate each RECTANGLE sprite's outermost rows/cols into the symmetric
   *  packing gutter to kill bilinear/mipmap seams (docs/improvements/edge-extrude.md, OPTION A). When
   *  >0 it is FLOORED to a non-negative integer and STAMPED onto every emitted `repack` and `pack` op
   *  (the only ops whose worker compose blits a rectangle the gutter can wrap); resize/transcode/drop
   *  ops are untouched. The plan does NOT compute the packing gutter — the worker derives it per op
   *  (`gutter = max(op.padding, op.extrude)`, so the existing padding budget is respected) and clamps
   *  the actual bleed to it (`effectiveExtrude = min(extrude, gutter)`). Absent/0/negative ⇒ NO op
   *  carries `extrude` ⇒ the plan is byte-identical to today (default OFF). */
  extrude?: number;
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
 *
 * SCALE TIERS (`opts.scaleTiers` non-empty, design §7): the plan does NOT emit tier ops — tiering is a
 * worker-side per-asset multiplier. The plan's only job is the GUARD: every tier-eligible ref
 * (`opts.tierEligible`) that appears in the findings is folded into a `tiered` set which EXCLUDES it
 * from the standalone pass-1 oversize-resize AND pass-2 transcode ops, because the worker's tier loop
 * owns each tier's encode + oversize clamp (a tiered asset is never ALSO separately resized/transcoded).
 * Refused refs (mesh / multi-page Spine / already-tiered — gated in the worker) are NOT in `tiered` and
 * keep their normal single-scale op. Additionally, because tiering RENAMES owners (correction 8), when
 * `aggressive` AND `scaleTiers` are both set the owner-aware dedup repoint is DISABLED (legacy
 * keep-consumer: drops still occur but no `repointManifest` is emitted, since the worker would no-op
 * the repoint against a renamed owner). Empty/absent scaleTiers ⇒ none of this runs ⇒ byte-identical
 * to today.
 *
 * EDGE-EXTRUDE (`opts.extrude` > 0, design OPTION A): the requested bleed px (floored, non-negative) is
 * STAMPED onto every emitted `repack` and `pack` op — the only ops whose worker compose blits a
 * rectangle the symmetric packing gutter can wrap. resize/transcode/drop ops are untouched. The plan
 * does NOT size the gutter (that's a worker-side per-op decision: `gutter = max(op.padding, op.extrude)`,
 * respecting the padding budget, then `effectiveExtrude = min(extrude, gutter)`). extrude unset/0 ⇒ NO
 * op carries `extrude` ⇒ every op object is byte-identical to today (default OFF).
 *
 * OPAQUE-ALPHA (`opts.opaqueAlpha`, round15): the Pro fix for `wasted-alpha` findings (fully-opaque images
 * that still carry a dead alpha channel). When ON, every `wasted-alpha`-flagged loose ref is guaranteed
 * EXACTLY ONE transcode op carrying `opaque:true` (encode to `opts.targetMime` WITHOUT the alpha channel,
 * a DISK-only saving — invariant 5, never VRAM). Determinism: an `opaqueRefs` Set is built FIRST (order-
 * free), so the `format` transcode branch sets `opaque:true` whenever its ref is opaque-flagged, regardless
 * of finding order; a local `transcoded` Set then lets a standalone wasted-alpha branch emit an opaque
 * transcode ONLY for opaque refs that no format/resize/drop/pack/tier op already claimed — so a ref with
 * BOTH `format` AND `wasted-alpha` yields one op (the format transcode, now opaque), never two. The op
 * targets `opts.targetMime` exactly like the format op (the plan holds no source mime; the finding's
 * `params.srcLabel` is copy-only, not op routing). OFF/no wasted-alpha finding ⇒ no op carries `opaque`
 * ⇒ byte-identical to today (the finding stays a diagnosis-only verdict; CLI/headless unaffected).
 */
export function planFix(report: AnalysisReport, opts: PlanOptions, groups?: DedupGroup[], packGroups?: PackGroup[]): FixPlan {
  const ops: FixOp[] = [];
  // Edge-extrude (bleed), design OPTION A. Floored to a non-negative int and stamped on repack/pack ops
  // only (their worker compose blits a rectangle the symmetric gutter can wrap). 0 ⇒ no op carries
  // `extrude` ⇒ byte-identical to today (default OFF). The worker derives the actual packing gutter +
  // clamps the bleed (effectiveExtrude = min(extrude, gutter)); the plan only carries the requested px.
  const extrude = Math.max(0, Math.floor(opts.extrude ?? 0));
  // Spread onto a repack/pack op only when >0, so an op object stays IDENTICAL to today at extrude=0.
  const extrudeField = extrude > 0 ? { extrude } : {};
  const repacked = new Set<string>();
  const dropped = new Set<string>();
  const resized = new Set<string>();
  // Refs folded into a packed sheet/atlas (Feature 4). Guards pass-2 transcode below (a packed loose
  // image is encoded once, into its sheet — never also transcoded). Empty unless packGroups supplied.
  const packed = new Set<string>();

  // Opaque-alpha (round15): the loose refs a `wasted-alpha` finding flagged (fully opaque, dead alpha
  // channel). Built FIRST so it is order-free — the pass-2 `format` branch consults it to set `opaque:true`
  // on an existing format transcode regardless of finding order, and a standalone branch emits an opaque
  // transcode for opaque refs that no other op claimed. Only when the UI opted in (opts.opaqueAlpha); a
  // folder-scope finding has no single op target so it is excluded. Empty ⇒ no op carries `opaque`.
  const opaqueRefs = new Set<string>();
  if (opts.opaqueAlpha) {
    for (const f of report.findings) {
      if (f.rule === 'wasted-alpha' && f.scope !== 'folder') opaqueRefs.add(f.assetRef);
    }
  }
  // Local guard so a ref flagged by BOTH `format` and `wasted-alpha` yields EXACTLY ONE transcode op
  // (carrying opaque:true). The format branch adds to it when it emits; the standalone opaque branch only
  // fires for an opaque ref NOT already transcoded here. Order-independent by construction (Set membership).
  const transcoded = new Set<string>();

  // Scale-tier export (design §7): ON iff a non-empty (already-validated) ladder is supplied. Tiering
  // RENAMES owners, so when it coincides with aggressive owner-aware dedup we drop the manifest repoint
  // (correction 8 — the worker would no-op a repoint against a renamed owner; fail safe to keep-consumer).
  const tieringOn = (opts.scaleTiers?.length ?? 0) > 0;
  const disableOwnerRepoint = tieringOn && opts.aggressive;
  // Refs the worker's tier loop will own (its encode + oversize clamp). Any such ref is EXCLUDED from
  // the standalone resize (pass 1) + transcode (pass 2) ops below, mirroring the `resized`/`packed`
  // guards. Refs the worker refuses to tier (mesh / multi-page Spine / already-tiered) are gated out by
  // `tierEligible` and stay here, keeping their normal single-scale op. Empty unless tiering is on.
  const tiered = new Set<string>();

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
        // an atlas consumer's sheet is "fully identical" by construction — repoint its manifest. But
        // when scale tiering is ALSO on (correction 8) the owner gets renamed to a tier suffix, so the
        // repoint would target a name that no longer exists ⇒ disable it (legacy keep-consumer drop).
        const repointManifest = !disableOwnerRepoint && (opts.isAtlasRef?.(c.ref) ?? false);
        // When tiering disables owner-aware repoint (correction 8), mark the op keepConsumer so Phase C
        // short-circuits to keep-the-consumer. Without this flag a still-emitted drop op with ownerRef set
        // (but no repointManifest) falls through to the worker's loose/atlas repoint branch — which DOES
        // repoint+drop against the owner's PRE-tier name, then the tier loop renames the owner, dangling
        // the kept consumer at a now-dropped image. keepConsumer keeps the drop op (count/owner intact) but
        // makes Phase C drop NOTHING and surface a skip instead.
        ops.push({
          kind: 'drop',
          assetRef: c.ref,
          reason: 'duplicate-exact',
          ownerRef: c.ownerRef,
          ...(repointManifest ? { repointManifest } : {}),
          ...(disableOwnerRepoint ? { keepConsumer: true } : {}),
        });
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
        ...extrudeField,
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
      ops.push({ kind: 'repack', atlasRefs: fresh, targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize, ...extrudeField });
    }
  }

  // Scale-tier eligibility (design §7): mark every tier-eligible ref the worker's tier loop will own,
  // so the oversize-resize (pass 1) and transcode (pass 2) guards below skip it. A ref is tiered iff
  // tiering is on AND the worker allows it (`tierEligible`, default-allow) AND it is not already a
  // dedup/pack/merge target NOR a pass-1 repack target (those transforms own the ref; the tier loop
  // runs on their emitted output in the worker, never as a duplicate standalone tier of the source).
  // pass-1 repack hasn't run yet, so we pre-exclude occupancy/wasted-regions refs here (the deterministic
  // pass-1 repack targets) — keeping "a repacked ref is never tiered" true regardless of finding order.
  // Deterministic: findings iterate in report order; Set membership is order-free.
  if (tieringOn) {
    const eligible = opts.tierEligible ?? (() => true);
    const willRepack = new Set<string>();
    for (const f of report.findings) {
      if ((f.rule === 'occupancy' || f.rule === 'wasted-regions') && !protectedOwners.has(f.assetRef)) willRepack.add(f.assetRef);
    }
    for (const f of report.findings) {
      if (f.scope === 'folder') continue; // per-asset only — folder findings have no single tier target
      const ref = f.assetRef;
      if (dropped.has(ref) || repacked.has(ref) || packed.has(ref) || protectedOwners.has(ref) || willRepack.has(ref)) continue;
      if (eligible(ref)) tiered.add(ref);
    }
  }

  // pass 1: repack under-filled atlases · resize oversized atlases/images · (aggressive) drop dupes
  for (const f of report.findings) {
    if (f.rule === 'occupancy' || f.rule === 'wasted-regions') {
      // owners are never repack targets (guard before the existing repacked check).
      if (protectedOwners.has(f.assetRef) || repacked.has(f.assetRef)) continue;
      repacked.add(f.assetRef);
      ops.push({ kind: 'repack', atlasRefs: [f.assetRef], targetMime: opts.targetMime, pot: true, allowRotation: false, padding: opts.padding, maxSize: opts.maxSize, ...extrudeField });
    } else if (f.rule === 'dimensions-oversize' && f.scope !== 'folder') {
      const w = Number(f.params?.w ?? 0);
      const h = Number(f.params?.h ?? 0);
      const longest = Math.max(w, h);
      // an atlas that's also being repacked may already shrink; don't double-handle it. owners are
      // never resize targets (guard before the existing resized/repacked checks). a TIERED ref is also
      // skipped — the worker's tier loop owns its oversize clamp (top tier == clamped source), so a
      // standalone resize op would double-resize (design §7 oversize × tiering).
      if (w > 0 && h > 0 && longest > opts.maxEdge && !protectedOwners.has(f.assetRef) && !resized.has(f.assetRef) && !repacked.has(f.assetRef) && !tiered.has(f.assetRef)) {
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

  // pass 2: transcode format-improvable images not already resized, dropped, packed, or tiered. The
  // `packed` guard (Feature 4) ensures a loose image folded into a sheet is encoded once (in the pack
  // step), never also transcoded here. The `tiered` guard (design §7 transcode × tiering) does the same
  // for a tier-eligible ref: the worker's tier loop encodes it once per tier at the target mime, so a
  // standalone transcode op would be an orphan duplicate. Result: format+tiered ⇒ N tier encodes, 0
  // transcode ops; a ref with both should-atlas and format yields one pack, zero transcode.
  for (const f of report.findings) {
    if (f.rule === 'format' && f.scope !== 'folder' && !resized.has(f.assetRef) && !dropped.has(f.assetRef) && !packed.has(f.assetRef) && !tiered.has(f.assetRef)) {
      // Flat / alpha-art findings (messageKey:'format-lossless', rule still 'format') carry
      // params.contentClass — encode THEM lossless even when the global opts.lossless is off, because
      // lossy q0.9 frays hard edges + flat fills. This is where the honest lossless byte delta the
      // analysis path deferred (Inv 4) is actually produced. Photographic/unknown follow opts.lossless.
      const wantsLossless = f.params?.contentClass === 'flat' || f.params?.contentClass === 'alpha-art';
      transcoded.add(f.assetRef);
      // Per-image MEASURED best-format pick (round17). formatFinding ALREADY measured every candidate and
      // recorded the winner in `params.bestMime` (never the source mime: the candidate loop skips
      // target===image.mime + AVIF sources early-return). Honor it instead of the single global
      // `opts.targetMime` when the opt is ON AND the param is a valid ImageMime. Absent (atlas / no-encoder
      // report) or malformed or OFF ⇒ `opts.targetMime` ⇒ byte-identical. NO encoding here — the plan only
      // routes the op to the format the diagnosis already proved smaller. A per-folder/type override (worker-
      // side resolveOptions) still wins, layered on this measured base; an export profile fans out its own
      // formats on a different (worker-gated) path. The standalone opaque transcode (pass 2b) keeps
      // opts.targetMime — that ref has no `format` finding, so no bestMime was measured for it.
      const perImageMime = opts.bestFormatPerImage && isImageMime(f.params?.bestMime) ? f.params.bestMime : opts.targetMime;
      ops.push({
        kind: 'transcode',
        assetRef: f.assetRef,
        targetMime: perImageMime,
        quality: opts.quality,
        lossless: opts.lossless || wantsLossless,
        // Opaque-alpha (round15): this format-improvable image is ALSO fully-opaque-with-dead-alpha — fold
        // the channel-drop into the same encode (one op, no orphan). DISK-only (invariant 5). Order-free:
        // opaqueRefs is pre-built, so this fires whether the wasted-alpha finding sorted before or after.
        ...(opaqueRefs.has(f.assetRef) ? { opaque: true } : {}),
      });
    }
  }

  // pass 2b (opaque-alpha, round15): a `wasted-alpha`-flagged loose ref that NO other op claimed (no
  // format/resize/drop/pack/tier op above) still deserves the channel-drop fix — emit its OWN opaque
  // transcode to opts.targetMime. The `transcoded` guard (built in pass 2) ensures a ref with BOTH
  // format and wasted-alpha is handled exactly once (by the format branch, now carrying opaque:true), so
  // this never double-emits. DISK-only saving (invariant 5 — the GPU still allocates RGBA8888); the worker
  // measures the real byte delta and skips honestly if there is no win. Empty opaqueRefs ⇒ this loop is a
  // no-op ⇒ byte-identical to today.
  for (const ref of opaqueRefs) {
    if (transcoded.has(ref) || resized.has(ref) || dropped.has(ref) || packed.has(ref) || tiered.has(ref)) continue;
    transcoded.add(ref);
    ops.push({ kind: 'transcode', assetRef: ref, targetMime: opts.targetMime, quality: opts.quality, lossless: opts.lossless, opaque: true });
  }
  return { ops, thresholds: report.thresholds };
}
