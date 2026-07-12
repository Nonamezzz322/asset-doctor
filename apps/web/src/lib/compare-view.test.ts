// Tests for the V4 compare view-model: withholding vs hedging vs delta verdicts, label exhaustiveness.
import { describe, it, expect } from 'vitest';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';
import { compareRuntimeReports, COMPARE_DEFAULTS } from '@asset-doctor/correlate';
import { compareView, COMPARE_METRIC_LABEL } from './compare-view';

const report = (over: Partial<RuntimeReport> = {}): RuntimeReport => ({
  frames: 600, durationMs: 10000,
  drawCalls: { avg: 120, max: 200 }, textureBinds: { avg: 40, max: 80 },
  redundantBinds: 500, uploadsDuringGameplay: 3, shaderCompilesDuringGameplay: 1,
  liveTextures: 60, vramBytes: 128 * 1024 * 1024,
  hitches: [], timing: { fps: 60, frameTimeMsAvg: 16.6, frameTimeMsP95: 20, deviceDependent: true },
  ...over,
});

describe('compareView — withhold / hedge / verdict', () => {
  it('WITHOUT same-device attestation the timing rows are WITHHELD entirely (not merely hedged)', () => {
    const v = compareView(compareRuntimeReports(report(), report()));
    expect(v.timingWithheld).toBe(true);
    expect(v.rows.find((r) => r.key.startsWith('timing.'))).toBeUndefined();
  });

  it('WITH the attestation timing rows render with delta verdicts', () => {
    const v = compareView(
      compareRuntimeReports(report(), report({ timing: { fps: 58, frameTimeMsAvg: 17.2, frameTimeMsP95: 22, deviceDependent: true } }), COMPARE_DEFAULTS, { sameDevice: true }),
      { sameDevice: true },
    );
    expect(v.timingWithheld).toBe(false);
    const fps = v.rows.find((r) => r.key === 'timing.fps')!;
    expect(fps.delta?.value).toBeCloseTo(-2, 5);
    expect(fps.hedgeKey).toBeUndefined();
  });

  it('duration-skewed: session-totals render RAW with the duration hedge (values never hidden)', () => {
    const v = compareView(compareRuntimeReports(report(), report({ durationMs: 20000, redundantBinds: 900 })));
    expect(v.verdictKey).toBe('compare.verdict.duration-skewed');
    const rb = v.rows.find((r) => r.key === 'redundantBinds')!;
    expect(rb.delta).toBeUndefined();
    expect(rb.hedgeKey).toBe('compare.hedge.duration');
    expect(rb.before).toBe(500);
    expect(rb.after).toBe(900); // raw values still shown — we refuse the verdict, not the data
  });

  it('vramBytes is flagged bytes for the JSX formatter; label map covers EVERY core row key', () => {
    const c = compareRuntimeReports(report(), report(), COMPARE_DEFAULTS, { sameDevice: true });
    const v = compareView(c, { sameDevice: true });
    expect(v.rows.find((r) => r.key === 'vramBytes')!.bytes).toBe(true);
    for (const r of c.rows) expect(COMPARE_METRIC_LABEL[r.key], `label for ${r.key}`).toBeDefined();
  });
});
