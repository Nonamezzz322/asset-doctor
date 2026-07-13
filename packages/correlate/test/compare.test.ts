// Tests for the V4 aggregate A/B core. The honesty surface under test: metric classes, comparability
// gates (too-short / duration-skew / device attestation), pct omission at before===0, fail-closed parse.
import { describe, it, expect } from 'vitest';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';
import { compareRuntimeReports, parseRuntimeReport, parseSessionRuntime, COMPARE_DEFAULTS } from '../src/index';

const report = (over: Partial<RuntimeReport> = {}): RuntimeReport => ({
  frames: 600,
  durationMs: 10000,
  drawCalls: { avg: 120, max: 200 },
  textureBinds: { avg: 40, max: 80 },
  redundantBinds: 500,
  uploadsDuringGameplay: 3,
  shaderCompilesDuringGameplay: 1,
  liveTextures: 60,
  vramBytes: 128 * 1024 * 1024,
  hitches: [{ frame: 10, ms: 40, cause: 'texture upload' }],
  timing: { fps: 60, frameTimeMsAvg: 16.6, frameTimeMsP95: 20, deviceDependent: true },
  ...over,
});

describe('compareRuntimeReports — classes, gates, deltas', () => {
  it('comparable sessions: deltas per class; device rows stay incomparable WITHOUT attestation', () => {
    const c = compareRuntimeReports(report(), report({ drawCalls: { avg: 100, max: 180 }, vramBytes: 96 * 1024 * 1024 }));
    expect(c.verdict).toBe('comparable');
    const draw = c.rows.find((r) => r.key === 'drawCalls.avg')!;
    expect(draw).toMatchObject({ metricClass: 'per-frame', before: 120, after: 100, delta: -20, comparable: true });
    expect(draw.pct).toBeCloseTo(-16.7, 1);
    const vram = c.rows.find((r) => r.key === 'vramBytes')!;
    expect(vram.metricClass).toBe('state');
    expect(vram.delta).toBe(-32 * 1024 * 1024);
    for (const r of c.rows.filter((x) => x.metricClass === 'device')) expect(r.comparable).toBe(false);
  });

  it('same-device attestation is an explicit INPUT that enables device rows (never assumed)', () => {
    const c = compareRuntimeReports(report(), report(), COMPARE_DEFAULTS, { sameDevice: true });
    for (const r of c.rows.filter((x) => x.metricClass === 'device')) expect(r.comparable).toBe(true);
  });

  it('duration skew beyond the gate: verdict duration-skewed, ONLY session-totals lose comparability', () => {
    const c = compareRuntimeReports(report(), report({ durationMs: 20000 })); // skew 0.5 > 0.3
    expect(c.verdict).toBe('duration-skewed');
    expect(c.durationSkewPct).toBe(0.5);
    for (const r of c.rows) {
      if (r.metricClass === 'session-total') expect(r.comparable).toBe(false);
      else if (r.metricClass === 'per-frame' || r.metricClass === 'state') expect(r.comparable).toBe(true);
    }
  });

  it('too-short session kills every delta verdict (raw values still reported)', () => {
    const c = compareRuntimeReports(report({ frames: 30 }), report());
    expect(c.verdict).toBe('too-short');
    for (const r of c.rows) expect(r.comparable).toBe(false);
    expect(c.rows.find((r) => r.key === 'drawCalls.avg')!.before).toBe(120); // nothing hidden
  });

  it('pct omitted when before === 0 (0 -> n is a new value, never +Inf%); hitches are counts only', () => {
    const c = compareRuntimeReports(report({ uploadsDuringGameplay: 0 }), report({ uploadsDuringGameplay: 5 }));
    const up = c.rows.find((r) => r.key === 'uploadsDuringGameplay')!;
    expect(up.delta).toBe(5);
    expect(up.pct).toBeUndefined();
    expect(c.hitches).toEqual({ before: 1, after: 1 });
  });

  it('deterministic row order and full row set (no compressedBytes ⇒ the optional row is absent)', () => {
    const keys = compareRuntimeReports(report(), report()).rows.map((r) => r.key);
    expect(keys).toEqual([
      'drawCalls.avg', 'drawCalls.max', 'textureBinds.avg', 'liveTextures', 'vramBytes',
      'redundantBinds', 'uploadsDuringGameplay', 'shaderCompilesDuringGameplay',
      'timing.fps', 'timing.frameTimeMsAvg', 'timing.frameTimeMsP95',
    ]);
  });
});

describe('compressedBytes — measured block-compressed VRAM breakdown (optional, honesty-gated)', () => {
  it('BOTH sessions recorded it ⇒ a state-class row right after vramBytes with the measured delta', () => {
    const c = compareRuntimeReports(report({ compressedBytes: 0 }), report({ compressedBytes: 8 * 1024 * 1024 }));
    const keys = c.rows.map((r) => r.key);
    expect(keys).toEqual([
      'drawCalls.avg', 'drawCalls.max', 'textureBinds.avg', 'liveTextures', 'vramBytes', 'compressedBytes',
      'redundantBinds', 'uploadsDuringGameplay', 'shaderCompilesDuringGameplay',
      'timing.fps', 'timing.frameTimeMsAvg', 'timing.frameTimeMsP95',
    ]);
    const comp = c.rows.find((r) => r.key === 'compressedBytes')!;
    expect(comp).toMatchObject({ metricClass: 'state', before: 0, after: 8 * 1024 * 1024, delta: 8 * 1024 * 1024, comparable: true });
    expect(comp.pct).toBeUndefined(); // 0 -> n is a new value, never +Inf%
  });

  it('EITHER side lacks it (older export) ⇒ row OMITTED (never compares recorded-vs-unrecorded, never fabricates 0)', () => {
    expect(compareRuntimeReports(report({ compressedBytes: 4096 }), report()).rows.find((r) => r.key === 'compressedBytes')).toBeUndefined();
    expect(compareRuntimeReports(report(), report({ compressedBytes: 4096 })).rows.find((r) => r.key === 'compressedBytes')).toBeUndefined();
  });

  it('BOTH measured 0 ⇒ row IS present (0→0 honestly reveals a KTX2 build that fell back to raster)', () => {
    const comp = compareRuntimeReports(report({ compressedBytes: 0 }), report({ compressedBytes: 0 })).rows.find((r) => r.key === 'compressedBytes')!;
    expect(comp).toMatchObject({ before: 0, after: 0, delta: 0, comparable: true });
  });

  it('parse: absent compressedBytes still parses (old export); present-and-garbage fails closed; present-and-valid parses', () => {
    const old = JSON.parse(JSON.stringify(report())); // factory omits it
    expect(parseRuntimeReport(old)).not.toBeNull();
    const bad = JSON.parse(JSON.stringify(report({ compressedBytes: 1 })));
    bad.compressedBytes = 'lots';
    expect(parseRuntimeReport(bad)).toBeNull();
    expect(parseRuntimeReport(JSON.parse(JSON.stringify(report({ compressedBytes: 2048 }))))).not.toBeNull();
  });
});

describe('parseRuntimeReport — fail-closed import of an exported session JSON', () => {
  it('round-trips a real report', () => {
    expect(parseRuntimeReport(JSON.parse(JSON.stringify(report())))).not.toBeNull();
  });
  it('rejects garbage, missing fields, and mistyped fields (never a NaN table)', () => {
    expect(parseRuntimeReport(null)).toBeNull();
    expect(parseRuntimeReport('{}')).toBeNull();
    expect(parseRuntimeReport({})).toBeNull();
    const bad = JSON.parse(JSON.stringify(report()));
    bad.drawCalls = { avg: 'x', max: 1 };
    expect(parseRuntimeReport(bad)).toBeNull();
    const noTiming = JSON.parse(JSON.stringify(report()));
    delete noTiming.timing;
    expect(parseRuntimeReport(noTiming)).toBeNull();
  });
});

describe('parseSessionRuntime — accepts a bare report OR the shipped extension session envelope', () => {
  it('unwraps the envelope runtime field; rejects an envelope with a garbled runtime', () => {
    const envelope = { url: 'https://game.example', locale: 'en', runtime: JSON.parse(JSON.stringify(report())), correlation: null, staticFindings: [] };
    expect(parseSessionRuntime(envelope)).not.toBeNull();
    expect(parseSessionRuntime(JSON.parse(JSON.stringify(report())))).not.toBeNull(); // bare still works
    expect(parseSessionRuntime({ url: 'x', runtime: { frames: 'no' } })).toBeNull();
    expect(parseSessionRuntime('nonsense')).toBeNull();
  });
});
