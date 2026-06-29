// The analyzing-state progress bar's ONE design decision — determinate vs. indeterminate, and the
// exact pct/value attrs the renderer feeds to role=progressbar — extracted as a pure, Node-testable
// spec (apps/web has no React/CSS harness; same discipline as focus-ring.ts / film-selection.ts).
// HONESTY: the bar reflects the worker's REAL done/total only. When total is unknown/invalid we go
// INDETERMINATE (no valueNow/valueMax — the canonical AT busy signal) rather than fabricate a crawl/ETA.
// The component is then a thin, obvious map of this output to className/style/ARIA attrs.

export interface ProgressView {
  /** true ⇒ real done/total known; false ⇒ indeterminate (AT busy signal, no valueNow/valueMax). */
  determinate: boolean;
  /** Always a finite integer 0..100 (0 in the indeterminate case) so the renderer can blindly set width. */
  pct: number;
  /** Present ONLY when determinate. Clamped done in [0, total]. */
  valueNow?: number;
  /** Present ONLY when determinate. Equals total. */
  valueMax?: number;
}

/** Map the worker's progress (or its absence) to the determinate/indeterminate progressbar spec.
 *  Pure, deterministic, no DOM. undefined / total<=0 / non-finite ⇒ indeterminate {determinate:false,pct:0}.
 *  Valid ⇒ {determinate:true, pct, valueNow: clampedDone, valueMax: total}; pct is always int 0..100. */
export function progressView(p?: { done: number; total: number }): ProgressView {
  if (!p || !Number.isFinite(p.done) || !Number.isFinite(p.total) || p.total <= 0) {
    return { determinate: false, pct: 0 };
  }
  const valueNow = clamp(p.done, 0, p.total);
  const pct = clampInt(Math.round((valueNow / p.total) * 100), 0, 100);
  return { determinate: true, pct, valueNow, valueMax: p.total };
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function clampInt(n: number, lo: number, hi: number): number {
  return clamp(n, lo, hi) | 0;
}
