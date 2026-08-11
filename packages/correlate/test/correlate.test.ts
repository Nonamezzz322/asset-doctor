import { describe, it, expect } from 'vitest';
import type { AnalysisReport, Finding, ThresholdConfig } from '@asset-doctor/core';
import type { RuntimeReport } from '@asset-doctor/probe/runtime';
import { correlate, correlateFix, type MeasuredSheetDiff } from '../src/index';

const TH: ThresholdConfig = {
  occupancy: { warn: 0.8, crit: 0.6 },
  oversizePx: { warn: 2048, crit: 2730 },
  formatSaving: { warn: 0.25 },
  npotPadding: { warn: 0.25 },
  duplicates: { similarHammingMax: 6 },
  shouldAtlas: { minLooseImages: 8, maxSpriteEdgePx: 512 },
  atlasMerge: { occupancyBelow: 0.5, minAtlases: 2, packEfficiency: 0.8 },
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

  it('R3 static evidence is honest: "—" with no size finding (never fabricates "large textures"), cites oversize when present', () => {
    const r = rt({ uploadsDuringGameplay: 6, hitches: [{ frame: 80, ms: 40, cause: 'texture upload' }] });
    // No dimensions-oversize finding ⇒ the static side is a runtime-only "—" (like R4/R5), NOT an
    // unmeasured "large textures in the build" claim.
    const bare = correlate(stat({}), r).findings.find((x) => x.rule === 'upload-hitch')!;
    expect(bare.staticEvidence).toBe('—');
    expect(bare.params?.staticVariant).toBeUndefined();
    // With a real oversize finding the correlation cites it (evidence-backed).
    const withSize = correlate(stat({ findings: [finding('dimensions-oversize')] }), r).findings.find((x) => x.rule === 'upload-hitch')!;
    expect(withSize.staticEvidence).toMatch(/oversized/);
    expect(withSize.params?.staticVariant).toBe('oversize');
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

const sheet = (over: Partial<MeasuredSheetDiff> = {}): MeasuredSheetDiff => ({ name: 's', ...over });

describe('correlateFix — MEASURED before→after fix probe → CorrelatedFinding verdicts', () => {
  it('120→30 measured draws → one crit batching verdict (variant:measured)', () => {
    const out = correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 80, drawCallsAfter: 20 }), sheet({ drawCallsBefore: 40, drawCallsAfter: 10 })] });
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.rule).toBe('batching');
    expect(f.id).toBe('corrfix:batching');
    expect(f.severity).toBe('crit'); // ratio 0.25 ≤ 0.34
    expect(f.estimate?.drawCallsAfter).toBe(30);
    expect(f.params?.drawCalls).toBe(120);
    expect(f.params?.drawCallsAfter).toBe(30);
    expect(f.params?.variant).toBe('measured');
  });

  it('100→60 measured draws → warn; 100→90 → info', () => {
    expect(correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 100, drawCallsAfter: 60 })] })[0]!.severity).toBe('warn'); // ratio 0.60
    expect(correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 100, drawCallsAfter: 90 })] })[0]!.severity).toBe('info'); // ratio 0.90
  });

  it('decoded VRAM 40MB→25MB → vram verdict with measured saving + distinct params', () => {
    const out = correlateFix({ sheetDiffs: [sheet({ decodedVramBefore: 40 * MB, decodedVramAfter: 25 * MB })] });
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.rule).toBe('vram');
    expect(f.id).toBe('corrfix:vram');
    expect(f.severity).toBe('warn'); // decoded-VRAM win is device-local, never crit
    expect(f.estimate?.vramBytesSaved).toBe(15 * MB);
    expect(f.params?.decodedBefore).toBe(40 * MB);
    expect(f.params?.decodedAfter).toBe(25 * MB);
    expect(f.params?.variant).toBe('measured');
    // invariant 5: decoded VRAM stays in its own params keys, never folded into a static vramBytes
    expect(f.params?.vramBytes).toBeUndefined();
  });

  it('both metrics win → two findings, batching first (stable order)', () => {
    const out = correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 100, drawCallsAfter: 30, decodedVramBefore: 40 * MB, decodedVramAfter: 20 * MB })] });
    expect(out.map((f) => f.rule)).toEqual(['batching', 'vram']);
  });

  it('only one metric wins → only that finding', () => {
    const out = correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 100, drawCallsAfter: 30, decodedVramBefore: 20 * MB, decodedVramAfter: 20 * MB })] });
    expect(out.map((f) => f.rule)).toEqual(['batching']);
  });

  it('Σafter >= Σbefore (no measured win / POT padding raised it) → no fabricated verdict', () => {
    expect(correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 30, drawCallsAfter: 30 })] })).toEqual([]);
    expect(correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 30, drawCallsAfter: 40 })] })).toEqual([]);
    expect(correlateFix({ sheetDiffs: [sheet({ decodedVramBefore: 10 * MB, decodedVramAfter: 12 * MB })] })).toEqual([]);
  });

  it('additivity — absent / empty sheetDiffs ⇒ [] (receipt byte-identical to today)', () => {
    expect(correlateFix({})).toEqual([]);
    expect(correlateFix({ sheetDiffs: [] })).toEqual([]);
  });

  it('one-sided probe (only *Before or only *After) ⇒ excluded (both-required)', () => {
    expect(correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 100 })] })).toEqual([]);
    // pure-pack fix: pack pages carry only *After (no source atlas ⇒ no honest before) ⇒ no verdict
    expect(correlateFix({ sheetDiffs: [sheet({ drawCallsAfter: 10 }), sheet({ decodedVramAfter: 5 * MB })] })).toEqual([]);
  });

  it('non-finite / NaN fields are excluded; Σbefore===0 guarded (no NaN verdict)', () => {
    expect(correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: Number.NaN, drawCallsAfter: 10 })] })).toEqual([]);
    expect(correlateFix({ sheetDiffs: [sheet({ drawCallsBefore: 0, drawCallsAfter: 0 })] })).toEqual([]);
  });
});

describe('correlate R6 — premultiplied × measured blend (P8)', () => {
  const pma = () =>
    finding('premultiplied-alpha', {
      scope: 'folder',
      severity: 'info',
      params: { n: 3 },
      relatedRefs: ['a.png', 'b.png', 'c.png'],
    });
  const r6 = (c: ReturnType<typeof correlate>) => c.findings.find((f) => f.rule === 'premultiplied-blend');

  it('straight-alpha blend → halo verdict (warn), n from params, static keeps the shape hedge', () => {
    const f = r6(correlate(stat({ findings: [pma()] }), rt({ blend: { premultiplied: false, straight: true, unpackPremultiply: false } })));
    expect(f?.severity).toBe('warn');
    expect(f?.params?.variant).toBe('halo');
    expect(f?.title).toContain('3');
    expect(f?.title).toContain('will fringe');
    expect(f?.staticEvidence).toContain('edge shape, not blend mode'); // irreducible hedge preserved
    expect(f?.runtimeEvidence).toContain('straight');
  });

  it('premultiplied blend → safe verdict (info reassurance)', () => {
    const f = r6(correlate(stat({ findings: [pma()] }), rt({ blend: { premultiplied: true, straight: false, unpackPremultiply: false } })));
    expect(f?.severity).toBe('info');
    expect(f?.params?.variant).toBe('safe');
    expect(f?.runtimeEvidence).toContain('premultiplied');
  });

  it('BOTH blends observed → inconclusive (info), cites the measured mode token', () => {
    const f = r6(correlate(stat({ findings: [pma()] }), rt({ blend: { premultiplied: true, straight: true, unpackPremultiply: false } })));
    expect(f?.severity).toBe('info');
    expect(f?.params?.variant).toBe('inconclusive');
    expect(f?.runtimeEvidence).toContain('mixed');
  });

  it('only unpack-premultiply observed → inconclusive, mode token upload-premultiplied', () => {
    const f = r6(correlate(stat({ findings: [pma()] }), rt({ blend: { premultiplied: false, straight: false, unpackPremultiply: true } })));
    expect(f?.params?.variant).toBe('inconclusive');
    expect(f?.runtimeEvidence).toContain('upload-premultiplied');
  });

  it('no blend signal at all (all false) → NO verdict (honesty: nothing measured)', () => {
    expect(r6(correlate(stat({ findings: [pma()] }), rt({ blend: { premultiplied: false, straight: false, unpackPremultiply: false } })))).toBeUndefined();
  });

  it('blend absent (old exported session) → NO verdict', () => {
    expect(r6(correlate(stat({ findings: [pma()] }), rt({})))).toBeUndefined();
  });

  it('no premultiplied finding → NO verdict even with a clear blend signal', () => {
    expect(r6(correlate(stat({ findings: [] }), rt({ blend: { premultiplied: false, straight: true, unpackPremultiply: false } })))).toBeUndefined();
  });

  it('n falls back to relatedRefs.length when params.n is absent', () => {
    const f = r6(
      correlate(
        stat({ findings: [finding('premultiplied-alpha', { scope: 'folder', severity: 'info', relatedRefs: ['a.png', 'b.png'] })] }),
        rt({ blend: { premultiplied: false, straight: true, unpackPremultiply: false } }),
      ),
    );
    expect(f?.params?.n).toBe(2);
    expect(f?.title).toContain('2');
  });
});
