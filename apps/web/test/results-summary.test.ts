// PURE tests for the results-summary model (folder label, asset counts, real-metric budget model). apps/web
// has no React harness (vitest env=node), so the honesty-critical decisions are exercised here: the folder
// label never fabricates a name, and the budget model reads straight from measured totals/tally with
// probe-only metrics degrading to null (never invented).

import { describe, expect, it } from 'vitest';
import type { AnalysisReport } from '@asset-doctor/core';
import type { TriageIndex } from '../src/lib/triage';
import { assetCounts, budgetModel, folderLabel } from '../src/lib/results-summary';

// Minimal report/tally fixtures — only the fields the pure functions read (cast to the real types).
function report(over: Partial<AnalysisReport>): AnalysisReport {
  return { assets: [], atlasFrames: {}, ...over } as unknown as AnalysisReport;
}
function tally(over: Partial<TriageIndex['tally']>): TriageIndex['tally'] {
  return { crit: 0, warn: 0, info: 0, ok: 0, ...over } as TriageIndex['tally'];
}
function totals(over: Partial<NonNullable<AnalysisReport['totals']>>): NonNullable<AnalysisReport['totals']> {
  return { diskBytes: 0, loadedVramBytes: 0, potentialDiskSaved: 0, ...over } as NonNullable<AnalysisReport['totals']>;
}

describe('folderLabel — never fabricates a name', () => {
  it('common single-segment root', () => {
    expect(folderLabel(['a/x.png', 'a/y.png'])).toBe('a');
  });
  it('nested paths share the top segment', () => {
    expect(folderLabel(['a/b/x.png', 'a/z.png'])).toBe('a');
  });
  it('single path with a dir', () => {
    expect(folderLabel(['a/x.png'])).toBe('a');
  });
  it('mixed roots ⇒ null', () => {
    expect(folderLabel(['a/x.png', 'b/y.png'])).toBeNull();
  });
  it('bare root-level filenames (FS-Access) ⇒ null', () => {
    expect(folderLabel(['x.png', 'y.png'])).toBeNull();
  });
  it('empty ⇒ null', () => {
    expect(folderLabel([])).toBeNull();
  });
  it('leading slash (empty first segment) ⇒ null', () => {
    expect(folderLabel(['/a/x.png', '/a/y.png'])).toBeNull();
  });
  it('one bare path among dir paths ⇒ null', () => {
    expect(folderLabel(['a/x.png', 'loose.png'])).toBeNull();
  });
});

describe('assetCounts', () => {
  it('atlases = keys, sprites = Σ frames, loose = assets − atlases', () => {
    const r = report({
      assets: [{}, {}, {}, {}, {}] as unknown as AnalysisReport['assets'],
      atlasFrames: { 'a.png': [{}, {}], 'b.png': [{}] } as unknown as AnalysisReport['atlasFrames'],
    });
    expect(assetCounts(r)).toEqual({ atlases: 2, sprites: 3, looseImages: 3 });
  });
  it('atlasFrames absent ⇒ {0,0,assets.length}', () => {
    const r = report({ assets: [{}, {}] as unknown as AnalysisReport['assets'], atlasFrames: undefined });
    expect(assetCounts(r)).toEqual({ atlases: 0, sprites: 0, looseImages: 2 });
  });
  it('loose clamped ≥ 0 (more atlas keys than assets)', () => {
    const r = report({
      assets: [{}] as unknown as AnalysisReport['assets'],
      atlasFrames: { 'a.png': [{}], 'b.png': [{}] } as unknown as AnalysisReport['atlasFrames'],
    });
    expect(assetCounts(r).looseImages).toBe(0);
  });
});

describe('budgetModel — real metrics, probe-gated, no NaN', () => {
  it('diskBytes 0 ⇒ savedPct 0, after 0 (no divide-by-zero)', () => {
    const bm = budgetModel(totals({ diskBytes: 0, potentialDiskSaved: 0 }), tally({}));
    expect(bm.disk.savedPct).toBe(0);
    expect(bm.disk.after).toBe(0);
    expect(Number.isNaN(bm.disk.savedPct)).toBe(false);
  });
  it('after = total − saved, savedPct is the real ratio', () => {
    const bm = budgetModel(totals({ diskBytes: 100, potentialDiskSaved: 43 }), tally({}));
    expect(bm.disk.after).toBe(57);
    expect(bm.disk.savedPct).toBe(43);
  });
  it('after clamped ≥ 0 when saved exceeds total (defensive)', () => {
    const bm = budgetModel(totals({ diskBytes: 10, potentialDiskSaved: 25 }), tally({}));
    expect(bm.disk.after).toBe(0);
  });
  it('probe absent ⇒ measured VRAM null, draw calls null, but the static estimate (floor) is present', () => {
    const bm = budgetModel(totals({ loadedVramBytes: 999, loadedTextures: 12 }), tally({}));
    expect(bm.vram.loaded).toBe(999);
    expect(bm.vram.measured).toBeNull();
    expect(bm.draw.calls).toBeNull();
    expect(bm.draw.atlasesProbed).toBeNull();
    expect(bm.draw.estimated).toBe(12); // the draw-call floor = distinct loaded textures, always available
  });
  it('estimated draw-call floor is loadedTextures, defaulting to 0 when the field is absent', () => {
    expect(budgetModel(totals({ loadedTextures: 7 }), tally({})).draw.estimated).toBe(7);
    expect(budgetModel(totals({}), tally({})).draw.estimated).toBe(0);
  });
  it('probe present ⇒ measured + draw wired straight from the probe', () => {
    const bm = budgetModel(
      totals({ probe: { vramBytes: 210, declaredVramBytes: 190, atlasesProbed: 7, drawCalls: 128 } } as unknown as NonNullable<AnalysisReport['totals']>),
      tally({}),
    );
    expect(bm.vram.measured).toEqual({ vram: 210, declared: 190, atlasesProbed: 7 });
    expect(bm.draw.calls).toBe(128);
    expect(bm.draw.atlasesProbed).toBe(7);
  });
  it('findings: problems excludes ok; segments drop zeros, keep crit→warn→info order', () => {
    const bm = budgetModel(totals({}), tally({ crit: 3, warn: 0, info: 4, ok: 99 }));
    expect(bm.findings.problems).toBe(7); // 3 + 0 + 4, never + ok
    expect(bm.findings.segments).toEqual([{ sev: 'crit', count: 3 }, { sev: 'info', count: 4 }]);
  });
  it('all-clear ⇒ zero problems, empty segments', () => {
    const bm = budgetModel(totals({}), tally({ ok: 5 }));
    expect(bm.findings.problems).toBe(0);
    expect(bm.findings.segments).toEqual([]);
  });
});
