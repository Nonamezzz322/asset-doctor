// PURE, Node-testable guard for the fix worker's transcode path (round15 #2). The worker can't run in Node
// (it references `self`/OffscreenCanvas), so the load-bearing "never ship a LARGER file from an optimization"
// decision is factored OUT here and imported verbatim by fix.worker.ts — the same discipline as sheet-diff.ts.
//
// HONESTY: an opaque (drop-the-dead-alpha) re-encode that does NOT shrink the file is no optimization. Some
// PNGs already store a constant alpha plane near-free, and a same-format opaque re-encode can come out equal
// or even larger (re-compression noise). In that case we must KEEP the original rather than ship a bigger
// page under a "fix" banner. Scoped to the OPAQUE path: a general transcode CHANGES format (PNG→WebP/AVIF),
// where a same-or-larger byte count is a legitimate format choice handled by the downstream dedup/Phase-C
// accounting — guarding it here would risk regressing those flows. This is the alpha-drop size-loss case only.
//
// round17: this predicate now backs BOTH worker opaque-transcode emit paths — the single-emit standalone
// transcode AND the export-profile fan-out (emitLooseProfileFanout), the latter additionally gated on
// `enc.mime === srcMime` so only the same-format alpha-drop variant is checked (format changes ship freely).

/** True ⇒ the worker KEEPS the original page (no emit, honest skip). An opaque re-encode is only worth
 *  shipping when it is STRICTLY smaller than the source; equal-or-larger is a size loss we decline. A
 *  non-opaque transcode is never gated here (returns false). */
export function transcodeIsSizeLoss(opaque: boolean | undefined, reencodedBytes: number, sourceBytes: number): boolean {
  return opaque === true && reencodedBytes >= sourceBytes;
}
