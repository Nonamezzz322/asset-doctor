// Aggregate A/B of two LIVE RuntimeReports (V4 — applied-fix vs live). The user records a session of
// their real game BEFORE applying the Pro fix and another AFTER shipping the fixed assets; this module
// compares the two AGGREGATE reports. It is deliberately NOT the (aborted) per-rule static×runtime
// correlation: no attribution is needed for a whole-app A/B — but WORKLOAD comparability is the honesty
// crux, so every metric carries a sensitivity CLASS and the comparison carries explicit gates:
//   • per-frame  (drawCalls.avg, textureBinds.avg) — frame-normalized, but SCENE-sensitive: honest only
//     under the user's own "same scene" attestation (an input we require, never a conclusion we draw);
//   • state      (liveTextures, vramBytes) — end-of-session snapshots, least workload-sensitive. The
//     raster VRAM is the same w·h·4 basis on BOTH sides, so the DELTA compares like with like;
//   • session-total (redundantBinds, uploads, compiles) — duration-sensitive: gated by duration skew;
//   • device     (timing.*) — RuntimeReport already stamps deviceDependent:true; comparable ONLY on the
//     same device (again: user attestation is an input).
// INVARIANT 3: this module never claims causality ("the fix saved X") — it reports that session B
// MEASURED X less/more than session A under gates the USER controlled. The UI copy owns the hedges;
// this core owns the numbers, classes and comparability verdicts. Pure, total, deterministic.

import type { RuntimeReport } from '@asset-doctor/probe/runtime';

export type CompareMetricClass = 'per-frame' | 'state' | 'session-total' | 'device';

export interface CompareOptions {
  /** Below this frame count on EITHER side the whole comparison is 'too-short' (noise, not signal). */
  minFrames: number;
  /** |durA−durB|/max(durA,durB) above this ⇒ 'duration-skewed': session-total rows become incomparable
   *  (their sums scale with time); per-frame and state rows survive with their own class hedges. */
  maxDurationSkewPct: number;
}

/** Exported defaults (an options object, not ThresholdConfig — this is not an analysis finding). */
export const COMPARE_DEFAULTS: CompareOptions = { minFrames: 120, maxDurationSkewPct: 0.3 };

export type CompareVerdict = 'comparable' | 'duration-skewed' | 'too-short';

export interface CompareRow {
  /** Stable key, e.g. 'drawCalls.avg' — the UI maps it to a localized label. */
  key: string;
  metricClass: CompareMetricClass;
  before: number;
  after: number;
  /** after − before (negative = session B measured less). Never a causal claim. */
  delta: number;
  /** Percent vs before, 1dp; OMITTED when before === 0 (0→n is a new value, not "+∞%"). */
  pct?: number;
  /** False when the comparability gates disqualify THIS row (session-totals under duration skew). The
   *  row still shows both raw values — we hide nothing, we just refuse the delta verdict. */
  comparable: boolean;
}

export interface RuntimeComparison {
  verdict: CompareVerdict;
  /** Measured comparability inputs — surfaced so the UI can show WHY a verdict was reached. */
  frames: { before: number; after: number };
  durationMs: { before: number; after: number };
  durationSkewPct: number;
  rows: CompareRow[];
  /** Side-by-side hitch counts — qualitative only, never a delta verdict (causes differ per session). */
  hitches: { before: number; after: number };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function row(
  key: string,
  metricClass: CompareMetricClass,
  before: number,
  after: number,
  comparable: boolean,
): CompareRow {
  const delta = round1(after - before);
  return {
    key,
    metricClass,
    before,
    after,
    delta,
    ...(before !== 0 ? { pct: round1(((after - before) / before) * 100) } : {}),
    comparable,
  };
}

/** Compare two live session reports, aggregate-to-aggregate. Deterministic row order (the table below).
 *  `device` rows are ALWAYS emitted with comparable:false unless the CALLER re-enables them after the
 *  user's same-device attestation (an explicit input — this core never assumes it). */
export function compareRuntimeReports(
  before: RuntimeReport,
  after: RuntimeReport,
  opts: CompareOptions = COMPARE_DEFAULTS,
  attest: { sameDevice?: boolean } = {},
): RuntimeComparison {
  const durMax = Math.max(before.durationMs, after.durationMs);
  const durationSkewPct = durMax === 0 ? 0 : round1((Math.abs(before.durationMs - after.durationMs) / durMax) * 100) / 100;
  const tooShort = before.frames < opts.minFrames || after.frames < opts.minFrames;
  const skewed = durationSkewPct > opts.maxDurationSkewPct;
  const verdict: CompareVerdict = tooShort ? 'too-short' : skewed ? 'duration-skewed' : 'comparable';
  // Row comparability: too-short kills every delta verdict; duration skew kills only session-totals;
  // device rows need the explicit same-device attestation on top of the base verdict.
  const base = !tooShort;
  const totalsOk = base && !skewed;
  const deviceOk = base && attest.sameDevice === true;
  const rows: CompareRow[] = [
    row('drawCalls.avg', 'per-frame', before.drawCalls.avg, after.drawCalls.avg, base),
    row('drawCalls.max', 'per-frame', before.drawCalls.max, after.drawCalls.max, base),
    row('textureBinds.avg', 'per-frame', before.textureBinds.avg, after.textureBinds.avg, base),
    row('liveTextures', 'state', before.liveTextures, after.liveTextures, base),
    row('vramBytes', 'state', before.vramBytes, after.vramBytes, base),
    row('redundantBinds', 'session-total', before.redundantBinds, after.redundantBinds, totalsOk),
    row('uploadsDuringGameplay', 'session-total', before.uploadsDuringGameplay, after.uploadsDuringGameplay, totalsOk),
    row('shaderCompilesDuringGameplay', 'session-total', before.shaderCompilesDuringGameplay, after.shaderCompilesDuringGameplay, totalsOk),
    row('timing.fps', 'device', before.timing.fps, after.timing.fps, deviceOk),
    row('timing.frameTimeMsAvg', 'device', before.timing.frameTimeMsAvg, after.timing.frameTimeMsAvg, deviceOk),
    row('timing.frameTimeMsP95', 'device', before.timing.frameTimeMsP95, after.timing.frameTimeMsP95, deviceOk),
  ];
  return {
    verdict,
    frames: { before: before.frames, after: after.frames },
    durationMs: { before: before.durationMs, after: after.durationMs },
    durationSkewPct,
    rows,
    hitches: { before: before.hitches.length, after: after.hitches.length },
  };
}

/** Fail-closed shape check for an imported session JSON (the extension's exported report). Verifies the
 *  exact fields compareRuntimeReports reads; anything missing/mistyped ⇒ null (never a NaN table). */
export function parseRuntimeReport(raw: unknown): RuntimeReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const pair = (v: unknown): v is { avg: number; max: number } =>
    typeof v === 'object' && v !== null && num((v as Record<string, unknown>).avg) && num((v as Record<string, unknown>).max);
  const t = r.timing as Record<string, unknown> | undefined;
  if (
    !num(r.frames) || !num(r.durationMs) || !pair(r.drawCalls) || !pair(r.textureBinds) ||
    !num(r.redundantBinds) || !num(r.uploadsDuringGameplay) || !num(r.shaderCompilesDuringGameplay) ||
    !num(r.liveTextures) || !num(r.vramBytes) || !Array.isArray(r.hitches) ||
    typeof t !== 'object' || t === null || !num(t.fps) || !num(t.frameTimeMsAvg) || !num(t.frameTimeMsP95)
  ) {
    return null;
  }
  return raw as RuntimeReport;
}

/** Accept EITHER a bare RuntimeReport JSON or the extension's session envelope
 *  ({ url, locale, runtime, correlation, staticFindings } — the shipped exportBtn/sessionJson shape):
 *  the envelope's `runtime` field is validated with the same fail-closed check. Anything else ⇒ null. */
export function parseSessionRuntime(raw: unknown): RuntimeReport | null {
  const direct = parseRuntimeReport(raw);
  if (direct) return direct;
  if (typeof raw === 'object' && raw !== null && 'runtime' in (raw as Record<string, unknown>)) {
    return parseRuntimeReport((raw as Record<string, unknown>).runtime);
  }
  return null;
}
