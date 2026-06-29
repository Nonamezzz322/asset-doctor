// HONEST fix-simulation footprint preview (round22 #2, docs/improvements/round22-honest-fix-simulation-
// footprint-pr.md). PURE aggregator: translate a MEASURED AnalysisReport + the SURVIVING FixOp[] the
// committed run would execute into the two-bucket footprint the Plan card surfaces — WITHOUT composing a
// single pixel.
//
// HONESTY (load-bearing, invariants 3 & 5):
//   • "measured now" — the ONLY footprint numbers summed here. Each delta's before→after is computable
//     PRE-COMPOSE from already-known geometry/sizes carried on the finding:
//       – DISK: a `format`/`format-lossless` finding with a SURVIVING transcode op → srcBytes − bestBytes
//         (the lossy q0.9 canvas ESTIMATE the diagnosis already encoded; sets `estimated`). A `wasted-alpha`
//         finding with a SURVIVING opaque transcode → srcBytes − opaqueBytes (a MEASURED channel-drop).
//       – VRAM: a `dimensions-oversize` finding with a SURVIVING resize op → params.vram (the MEASURED
//         pre-resize w·h·4 from rules.ts) − to.w·to.h·4. EXACT.
//   • "computed at execute" — repack/merge/pack/dedup (+ the worker-folded scale-tier multiplier). Their
//     before→after is NOT knowable until the worker actually packs/encodes ⇒ NEVER summed into a number;
//     surfaced ONLY as a count ("+N more computed at download").
//   • disk and VRAM are kept DISTINCT (invariant 5: disk weight ≠ GPU footprint) — never one combined total.
//   • npot/solid are EXCLUDED entirely: planFix emits NO op for them, and a resize achieves neither their
//     POT-padding reclaim nor their 1×1 reclaim (different, non-additive baselines) — folding them would
//     fabricate a win the run never produces (invariant 3/5).
//   • op-GATED: a finding only contributes when its OWN op SURVIVES the selective-fix mask (`excluded`) AND
//     was actually emitted (e.g. a format ref also repacked/packed/tiered/dropped gets no transcode op, so
//     it contributes 0) — so the preview tracks exactly what the committed run will do.
//   • a transcode never feeds VRAM; a resize never feeds disk (invariant-5 separation).
//
// Pure: Set/Map + a numeric sum over the deterministically-ordered report.findings & ops. No Date.now /
// Math.random / DOM. Same input ⇒ deep-equal output. ADDITIVE: nothing measurable ⇒ undefined ⇒ the Plan
// card is byte-identical to today (counts-only).

import type { AnalysisReport, FixOp, Size } from '@asset-doctor/core';
import type { FixPlanFootprint } from '../worker/fix-protocol';
import { fixOpKind, type OpKind } from './op-manifest';

const BYTES_PER_PX = 4;

/** Coerce a finding param to a usable positive finite number (else 0 ⇒ contributes nothing — honest). */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Kinds whose before→after is NOT knowable pre-compose ⇒ counted in `deferredOps`, never summed. */
const DEFERRED_KINDS: ReadonlySet<OpKind> = new Set<OpKind>(['repack', 'merge', 'pack', 'dedup']);

/**
 * Summarize the SURVIVING plan ops + the MEASURED report into the honest two-bucket footprint.
 *
 * @param report  the MEASURED AnalysisReport (its findings carry srcBytes/bestBytes/opaqueBytes/vram).
 * @param ops     the SURVIVING FixOp[] the committed run will execute (already mask-filtered upstream as
 *                `countedOps`; `excluded` is re-applied defensively here so this stays correct standalone).
 * @param excluded the selective-fix mask (deselected OpKinds). A deselected op contributes nothing.
 * @returns the footprint, or `undefined` when nothing is knowable (⇒ the card stays counts-only).
 */
export function summarizeFixPlanFootprint(
  report: AnalysisReport,
  ops: readonly FixOp[],
  excluded: ReadonlySet<OpKind>,
): FixPlanFootprint | undefined {
  // ── Pass A: index the SURVIVING ops by ref (skip deselected) ──────────────────────────────────────
  const transcodeRefs = new Set<string>(); // refs with a surviving transcode op (disk-measurable)
  const opaqueRefs = new Set<string>(); // refs whose surviving transcode drops the dead alpha channel
  const resizeTo = new Map<string, Size>(); // ref → surviving resize target (VRAM-measurable)
  let deferredOps = 0; // repack/merge/pack/dedup — sized at download
  for (const op of ops) {
    if (excluded.has(fixOpKind(op))) continue; // deselected ⇒ does no work ⇒ contributes nothing
    if (op.kind === 'transcode') {
      transcodeRefs.add(op.assetRef);
      if (op.opaque === true) opaqueRefs.add(op.assetRef);
    } else if (op.kind === 'resize') {
      resizeTo.set(op.assetRef, op.to);
    } else if (DEFERRED_KINDS.has(fixOpKind(op))) {
      deferredOps++;
    }
  }

  // ── Pass B: sum the MEASURED, op-gated, pre-compose-knowable deltas off the findings ───────────────
  let diskBytesSaved = 0;
  let vramBytesSaved = 0;
  let estimated = false;
  // A ref handled by a format transcode is counted ONCE for disk; a same-ref wasted-alpha (folded into the
  // SAME opaque transcode by planFix) must not be double-counted.
  const disced = new Set<string>();
  for (const f of report.findings) {
    if (f.scope === 'folder') continue; // folder findings have no single op target
    const ref = f.assetRef;
    const p = f.params;
    // DISK — format/format-lossless: srcBytes − bestBytes (lossy q0.9 ESTIMATE ⇒ estimated=true).
    if (f.rule === 'format' && transcodeRefs.has(ref)) {
      diskBytesSaved += Math.max(0, num(p?.srcBytes) - num(p?.bestBytes));
      estimated = true;
      disced.add(ref);
    } else if (f.rule === 'wasted-alpha' && opaqueRefs.has(ref) && !disced.has(ref)) {
      // DISK — wasted-alpha (MEASURED channel drop): srcBytes − opaqueBytes. Not an estimate.
      diskBytesSaved += Math.max(0, num(p?.srcBytes) - num(p?.opaqueBytes));
    } else if (f.rule === 'dimensions-oversize' && resizeTo.has(ref)) {
      // VRAM — oversize × resize: the MEASURED pre-resize w·h·4 (params.vram, rules.ts) − to.w·to.h·4.
      // `before` uses the finding's measured vram so the two sides never drift from vramBytes(); `after`
      // is base w·h·4 (the canonical footprint of the resize target). If a mipmap-adjusted VRAM is ever
      // introduced (invariant 5 mentions +33%), BOTH sides must adopt it in lockstep — they are base
      // w·h·4 today, internally consistent with the diagnosis.
      const to = resizeTo.get(ref)!;
      const before = num(p?.vram);
      const after = to.w * to.h * BYTES_PER_PX;
      vramBytesSaved += Math.max(0, before - after);
    }
  }

  if (diskBytesSaved === 0 && vramBytesSaved === 0 && deferredOps === 0) return undefined;
  return { diskBytesSaved, vramBytesSaved, estimated, deferredOps };
}
