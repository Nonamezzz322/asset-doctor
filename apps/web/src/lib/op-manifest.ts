// Pure parser/grouper for the worker's free-text FixReceipt.operations[] strings (fix.worker.ts).
// Web-app-local (it parses a web-worker string format → does NOT belong in a shared package). No DOM,
// no I/O, no Date.now/Math.random — same input ⇒ deep-equal output. Presents the EXISTING audit trail;
// generates nothing and synthesizes no numbers (op strings carry dims/format, never per-file bytes).
//
// ALSO hosts the DRY-RUN plan summary (docs/improvements/dry-run-plan-preview.md). summarizePlan tallies
// the STRUCTURED FixOp[] the execute path would run (no rendered op strings exist yet — those are built
// inside the pixel loop), so it cannot route through groupOps; it shares the OpKind vocabulary instead.
// HONESTY (invariant 5): the summary carries op COUNTS only — NO byte/VRAM savings. Plan mode DOES run the
// pre-loop format-sizing encode (to count transcodes) + the aggressive feature pass (to count dedups), but
// nothing is COMPOSED/packed/zipped, so there is no real output footprint to report (disk ≠ VRAM). The
// caller hands in only the dedup drops that execute will actually perform (no-op keep-consumer drops are
// excluded upstream — fix.worker.ts plan block), so the count matches execute. Pure: same input ⇒ deep-equal.

import type { FixOp } from '@asset-doctor/core';
import type { FixPlanSummary, PlanOpCounts } from '../worker/fix-protocol';

/** Op verbs — the closed set emitted by the operations.push sites in fix.worker.ts. `strip` is the lossless
 *  ancillary-metadata strip (drop-in: format/pixels/name unchanged, only DOWNLOAD bytes drop). */
export type OpKind = 'repack' | 'merge' | 'resize' | 'transcode' | 'strip' | 'drop' | 'pack' | 'dedup' | 'tier';

/** Verbs whose op rewrites/changes asset references (NOT a drop-in) → rendered with the warn token. `strip`
 *  is DELIBERATELY absent: it keeps the file's exact name + format (only shrinks it), so it is a pure drop-in. */
export const REFERENCE_CHANGING: ReadonlySet<OpKind> = new Set<OpKind>(['merge', 'dedup', 'pack', 'tier']);

/** Deterministic group display order: drop-in ops first, reference-changing next, tier last. */
export const OP_KIND_ORDER: readonly OpKind[] = ['repack', 'resize', 'transcode', 'strip', 'drop', 'merge', 'pack', 'dedup', 'tier'];

const KNOWN: ReadonlySet<string> = new Set<string>(OP_KIND_ORDER);

export interface OpRow {
  kind: OpKind | null;
  text: string;
}

export interface OpGroup {
  /** null ⇒ unknown/future verb, bucketed into the trailing neutral "other" group (never dropped). */
  kind: OpKind | null;
  refChanging: boolean;
  rows: OpRow[];
}

/** Classify one operations[] string by its leading whitespace-delimited token. Unknown/empty leading
 *  token → null (caller buckets under a neutral "other" group — never mislabeled, never silently
 *  dropped). Pure. No multi-word special case needed: 'drop duplicate …' leads with 'drop'. */
export function classifyOp(op: string): OpKind | null {
  const head = op.trimStart().split(/\s+/, 1)[0] ?? '';
  return KNOWN.has(head) ? (head as OpKind) : null;
}

/** Group operations[] into ordered, verb-bucketed groups. Known verbs emitted in OP_KIND_ORDER; null-verb
 *  rows collected into a single trailing group (kind:null). Within-group order = input order. Empty groups
 *  omitted. Pure: same input ⇒ deep-equal output. */
export function groupOps(operations: readonly string[]): OpGroup[] {
  const rows: OpRow[] = operations.map((text) => ({ kind: classifyOp(text), text }));
  const groups: OpGroup[] = [];
  for (const kind of OP_KIND_ORDER) {
    const r = rows.filter((row) => row.kind === kind);
    if (r.length > 0) groups.push({ kind, refChanging: REFERENCE_CHANGING.has(kind), rows: r });
  }
  const other = rows.filter((row) => row.kind === null);
  if (other.length > 0) groups.push({ kind: null, refChanging: false, rows: other });
  return groups;
}

/* ── DRY-RUN plan summary (docs/improvements/dry-run-plan-preview.md) ─────────────────────────────── */

/** Worker-supplied gate facts for the dry-run summary. The plan's STRUCTURED `FixOp[]` plus the
 *  worker-side decisions that aren't encoded in a FixOp: the scale-tier multiplier count (an UPPER
 *  BOUND — tiering can still be refused at pixel time), the pixel-free would-be-skips, and the
 *  conservative-true reference-changing prediction. Carries NO byte/VRAM number (honesty, invariant 5). */
export interface PlanGateInputs {
  /** The plan the execute path would run (counted by kind; tier is NOT a FixOp — see `tierAssets`). */
  ops: readonly FixOp[];
  /** Upper-bound count of assets the worker's tier loop WOULD tier (eligible + not plan-transformed/
   *  dropped). Counted as `opCounts.tier`. Tiering can still be refused at compose time ⇒ upper bound. */
  tierAssets: number;
  /** Skips DETERMINABLE WITHOUT composing pixels (multi-page Spine, already-tiered, name-collision,
   *  mesh-refusal, dedup×tier disable, folder-already-tiered). Deterministic order, set by the worker. */
  skipped: readonly { assetRef: string; reason: string }[];
  /** Conservative-true PREDICTION: would committing the plan rewrite manifest/loader references? */
  referencesChanged: boolean;
}

/** Classify ONE structured FixOp into the OpKind the plan tally + receipt key on — the SAME split the
 *  worker execute path makes: a `repack` with one atlasRef → repack, with >1 → merge; a `drop` carrying an
 *  `ownerRef` → dedup, else legacy drop; resize/transcode/pack are literal. SINGLE SOURCE OF TRUTH so the
 *  selective-fix worker filter (skip ops whose kind is deselected) and `summarizeOpCounts` can't drift on
 *  the repack/merge + drop/dedup splits. Total (covers every FixOp variant); the worker-side `tier`
 *  multiplier is NOT a FixOp (gated separately). Pure, deterministic. */
export function fixOpKind(op: FixOp): Exclude<OpKind, 'tier'> {
  if (op.kind === 'repack') return op.atlasRefs.length > 1 ? 'merge' : 'repack';
  if (op.kind === 'drop') return op.ownerRef != null ? 'dedup' : 'drop';
  return op.kind; // 'resize' | 'transcode' | 'pack' — literal
}

/** Tally the STRUCTURED plan into per-kind op counts (the receipt's OpKind vocabulary). Splits route
 *  through `fixOpKind` (the single source of truth). The worker-side `tier` multiplier is folded in from
 *  `g.tierAssets`. Zero-count kinds are OMITTED. Pure, deterministic. */
export function summarizeOpCounts(ops: readonly FixOp[], tierAssets: number): PlanOpCounts {
  const counts: Record<OpKind, number> = { repack: 0, merge: 0, resize: 0, transcode: 0, strip: 0, drop: 0, pack: 0, dedup: 0, tier: 0 };
  for (const op of ops) counts[fixOpKind(op)]++;
  counts.tier += Math.max(0, tierAssets);
  const out: PlanOpCounts = {};
  for (const k of OP_KIND_ORDER) if (counts[k] > 0) out[k] = counts[k];
  return out;
}

/** Honest skip notes (selective fix, docs/improvements/selective-fix.md) for the op KINDS the user
 *  DESELECTED in the Plan card that WOULD have run this fix. The worker pushes these into `skipped[]` so a
 *  deselected op is SURFACED (never silently dropped) and the receipt reflects exactly what ran. Emitted in
 *  OP_KIND_ORDER (deterministic), one note per deselected-and-would-run kind. `wouldRunByKind` is the set of
 *  kinds the run actually has work for (incl. the worker-side `tier` multiplier when tiering would run), so
 *  we never surface a skip for a kind that had nothing to do. Pure: same input ⇒ deep-equal output. */
export function deselectedSkips(
  excluded: ReadonlySet<OpKind>,
  wouldRunByKind: ReadonlySet<OpKind>,
): { assetRef: string; reason: string }[] {
  const out: { assetRef: string; reason: string }[] = [];
  for (const k of OP_KIND_ORDER) {
    if (excluded.has(k) && wouldRunByKind.has(k)) out.push({ assetRef: '(deselected)', reason: `${k} skipped: deselected in plan` });
  }
  return out;
}

/** PIXEL-FREE facts about a dedup consumer the keep-consumer predicate needs (mirrors fix.worker.ts's
 *  `spineRefs.has` / `manifestPathOf` / `atlasByRef.get` lookups). All determinable before any compose. */
export interface DedupConsumerFacts {
  /** True iff owner-aware repoint is disabled for this drop (scale tiering renames the owner — keepConsumer). */
  keepConsumer: boolean;
  /** True iff this consumer is an atlas image+manifest pair (the meta.image-repoint branch). */
  repointManifest: boolean;
  /** True iff the consumer ref is a Spine `.atlas` page (no portable cross-page redirect ⇒ kept). */
  isSpine: boolean;
  /** True iff the consumer has an AD-emitted referencing manifest (else its ref may live in game code). */
  hasManifest: boolean;
  /** True iff the consumer ref resolves to a parsed atlas (the manifest is re-emittable). */
  isAtlas: boolean;
}

/** Will the execute path's Phase C (fix.worker.ts:1118-1203) turn this owner-aware dedup drop into a
 *  PIXEL-FREE NO-OP keep (drops nothing, surfaces a skip)? Returns the matching skip reason, or null when
 *  the drop will actually dedup. SINGLE SOURCE OF TRUTH for the plan block's dedup-skip mirror so the plan
 *  cannot count a dedup the execute path will skip. The ONE keep that is pixel-DEPENDENT (owner final name
 *  diverged via a transcode PNG-fallback, line 1137) is intentionally NOT predicted here. Pure. */
export function dedupKeepConsumerSkip(ownerRefBasename: string, f: DedupConsumerFacts): string | null {
  if (f.keepConsumer) return `dedup skipped: owner ${ownerRefBasename} renamed by scale tiering — kept duplicate`;
  if (f.isSpine) return 'dedup skipped: Spine cross-page dedup not drop-in — kept duplicate';
  if (f.repointManifest) {
    if (!f.hasManifest || !f.isAtlas) return 'dedup skipped: atlas consumer manifest unavailable — kept duplicate';
    return null;
  }
  if (!f.hasManifest) return 'dedup skipped: loose duplicate reference may live in game code — kept duplicate';
  if (!f.isAtlas) return 'dedup skipped: referencing manifest unavailable — kept duplicate';
  return null;
}

/** Assemble the dry-run preview the worker posts in 'plan' mode. Op COUNTS only — NO byte/VRAM number
 *  (honesty, invariant 5). `hasDeferredChecks` is always true: pixel-dependent skips, the refs-flag
 *  prediction caveat, and the tier "up to N" upper bound are all resolved only at execute. Pure. */
export function summarizePlan(g: PlanGateInputs): FixPlanSummary {
  const opCounts = summarizeOpCounts(g.ops, g.tierAssets);
  const totalOps = (Object.values(opCounts) as number[]).reduce((s, n) => s + n, 0);
  return {
    opCounts,
    totalOps,
    skipped: g.skipped.map((s) => ({ assetRef: s.assetRef, reason: s.reason })),
    referencesChanged: g.referencesChanged,
    hasDeferredChecks: true,
  };
}
