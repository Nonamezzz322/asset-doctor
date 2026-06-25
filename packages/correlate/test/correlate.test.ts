import { describe, it, expect } from 'vitest';
import type { AnalysisReport, Finding, ThresholdConfig } from '@asset-doctor/core';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';
import { correlate } from '../src/index';

const TH: ThresholdConfig = {
  occupancy: { warn: 0.8, crit: 0.6 },
  oversizePx: { warn: 2048, crit: 2730 },
  formatSaving: { warn: 0.25 },
  npotPadding: { warn: 0.25 },
  duplicates: { similarHammingMax: 6 },
  shouldAtlas: { minLooseImages: 8, maxSpriteEdgePx: 512 },
  atlasMerge: { occupancyBelow: 0.5, minAtlases: 2 },
};

const stat = (over: Partial<AnalysisReport>): AnalysisReport => ({
  assets: [],
  findings: [],
  totals: { diskBytes: 0, vramBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0 },
  thresholds: TH,
  ...over,
});

const rt = (over: Partial<RuntimeReport>): RuntimeReport => ({
  frames: 100,
  durationMs: 1600,
  drawCalls: { avg: 1, max: 1 },
  textureBinds: { avg: 0, max: 0 },
  redundantBinds: 0,
  uploadsDuringGameplay: 0,
  shaderCompilesDuringGameplay: 0,
  liveTextures: 1,
  vramBytes: 0,
  hitches: [],
  timing: { fps: 60, frameTimeMsAvg: 16, frameTimeMsP95: 18, deviceDependent: true },
  ...over,
});

const finding = (rule: Finding['rule'], over: Partial<Finding> = {}): Finding => ({
  id: rule,
  rule,
  severity: 'warn',
  assetRef: 'x',
  title: '',
  detail: '',
  ...over,
});

const MB = 1048576;

describe('correlate — static × runtime', () => {
  it('R1 batching: should-atlas (static) + high draw calls (runtime) → one crit verdict', () => {
    const s = stat({
      findings: [finding('should-atlas', { scope: 'folder', relatedRefs: Array.from({ length: 60 }, (_, i) => `s${i}.png`) })],
    });
    const r = rt({ drawCalls: { avg: 58, max: 60 }, textureBinds: { avg: 60, max: 60 }, liveTextures: 60 });
    const c = correlate(s, r);
    const f = c.findings.find((x) => x.rule === 'batching');
    expect(f?.severity).toBe('crit');
    expect(f?.staticEvidence).toContain('60');
    expect(f?.runtimeEvidence).toContain('60');
    expect(f?.estimate?.drawCallsAfter).toBeLessThan(60);
  });

  it('no batching finding when draw calls are healthy', () => {
    const s = stat({ findings: [finding('should-atlas', { relatedRefs: ['a', 'b'] })] });
    expect(correlate(s, rt({ drawCalls: { avg: 2, max: 3 } })).findings.some((x) => x.rule === 'batching')).toBe(false);
  });

  it('R2 vram: live residency exceeds the loaded estimate', () => {
    const s = stat({ totals: { diskBytes: 0, vramBytes: 0, loadedVramBytes: 40 * MB, potentialDiskSaved: 0 } });
    const f = correlate(s, rt({ vramBytes: 100 * MB })).findings.find((x) => x.rule === 'vram');
    expect(f?.severity).toBe('warn');
    expect(f?.estimate?.vramBytesSaved).toBe(60 * MB);
  });

  it('R3 upload hitch', () => {
    const r = rt({ uploadsDuringGameplay: 6, hitches: [{ frame: 80, ms: 40, cause: 'texture upload' }] });
    expect(correlate(stat({}), r).findings.find((x) => x.rule === 'upload-hitch')?.estimate?.hitchMsSaved).toBe(40);
  });

  it('R4 shader hitch', () => {
    const r = rt({ shaderCompilesDuringGameplay: 4, hitches: [{ frame: 90, ms: 25, cause: 'shader compile' }] });
    expect(correlate(stat({}), r).findings.some((x) => x.rule === 'shader-hitch')).toBe(true);
  });

  it('R5 redundant state changes', () => {
    expect(correlate(stat({}), rt({ frames: 100, redundantBinds: 1000 })).findings.some((x) => x.rule === 'redundant-state')).toBe(true);
  });

  it('clean static + clean runtime → no correlated issues', () => {
    const c = correlate(stat({}), rt({}));
    expect(c.findings).toHaveLength(0);
    expect(c.summary).toMatch(/consistent/);
  });
});
