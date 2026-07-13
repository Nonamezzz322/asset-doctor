// Tests for the V4 compare view-model: withholding vs hedging vs delta verdicts, label exhaustiveness.
import { describe, it, expect } from 'vitest';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';
import { compareRuntimeReports, COMPARE_DEFAULTS } from '@asset-doctor/correlate';
import { CATALOGS } from '@asset-doctor/i18n';
import { compareView, COMPARE_METRIC_LABEL, CLASS_HEDGE } from './compare-view';

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

// i18n drift guard (film-legend.test.ts precedent). ComparePage renders these three key classes via BARE
// VARIABLES — t(view.verdictKey), t(r.labelKey), t(r.hedgeKey) — which the static App-keys scanner
// (apps/web/test/i18n-app-keys.test.ts, literal + template only) cannot see. Without this a renamed or
// un-catalogued verdict/metric/hedge key would render a raw dotted string in every locale. We assert the
// keys the PURE model actually PRODUCES exist in en, so a new core verdict/metric/class can't slip through.
describe('compare-view dynamic i18n keys are all catalogued in en', () => {
  it('every verdict banner key (compare.verdict.*) the model can emit exists in en', () => {
    // All three CompareVerdict members, driven through the real core so the union can't drift silently.
    const short = compareView(compareRuntimeReports(report({ frames: 10 }), report({ frames: 10 })));
    const skewed = compareView(compareRuntimeReports(report(), report({ durationMs: 30000 })));
    const ok = compareView(compareRuntimeReports(report(), report(), COMPARE_DEFAULTS, { sameDevice: true }), { sameDevice: true });
    const seen = new Set([short.verdictKey, skewed.verdictKey, ok.verdictKey]);
    expect(seen).toEqual(new Set(['compare.verdict.too-short', 'compare.verdict.duration-skewed', 'compare.verdict.comparable']));
    for (const k of seen) expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
  });

  it('every metric label (compare.metric.*) and hedge (compare.hedge.*) key exists in en', () => {
    for (const k of Object.values(COMPARE_METRIC_LABEL)) expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
    // CLASS_HEDGE is Record<CompareMetricClass, …> so the type forces all four classes present; assert their
    // values are catalogued (compare.hedge.scene/gate/duration/device — one per row-comparability class).
    for (const k of Object.values(CLASS_HEDGE)) expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
  });

  it('the ComparePage static keys (nav + shell) exist in en', () => {
    for (const k of [
      'nav.compare',
      'compare.title',
      'compare.subtitle',
      'compare.load.before',
      'compare.load.after',
      'compare.error',
      'compare.session.summary',
      'compare.attest.legend',
      'compare.attest.hint',
      'compare.attest.scene',
      'compare.attest.device',
      'compare.sessions.line',
      'compare.hitches',
      'compare.col.metric',
      'compare.col.before',
      'compare.col.after',
      'compare.col.delta',
      'compare.timingWithheld',
      'compare.empty',
    ]) {
      expect(CATALOGS.en[k], `${k} must exist in en.json`).toBeDefined();
    }
  });
});
